/**
 * Service de RÉCAPITULATIF « conversation dédiée ».
 *
 * Le service est PUR vis-à-vis du SDK : il ne connaît qu'un `RecapWriter`
 * (`prompt → texte`), injecté. Le câblage réel (session éphémère en mémoire) vit
 * dans `src/pi/sdk/recap-writer.ts`, exactement comme l'extracteur de mémoire.
 *
 * Responsabilités :
 *   1. DÉCOUPER une portion trop longue en TRANCHES par messages (jamais au
 *      milieu d'un message ni d'un échange), chacune sous un budget sûr, et
 *      CONCATÉNER leurs récapitulatifs dans l'ordre — jamais les re-synthétiser
 *      (une re-synthèse perdrait à chaque étage) ;
 *   2. REFUSER honnêtement les seuls cas réellement intestables (un message
 *      isolé plus long qu'un appel, ou un nombre de tranches au-delà du
 *      plafond) plutôt que de tronquer en silence ;
 *   3. construire l'instruction EXHAUSTIVE (`buildGeneratorPrompt`) ;
 *   4. parser la sortie (titre proposé + corps verbatim) ;
 *   5. garantir le TOUT OU RIEN : l'échec d'UNE seule tranche n'écrit RIEN.
 */

import {
  buildGeneratorPrompt,
  fallbackTitle,
  joinRecapParts,
  measureMessages,
  normalizeSubject,
  parseGeneratorOutput,
  splitMessagesForRecap,
  RECAP_INPUT_MAX_CHARS,
  RECAP_MAX_PARTS,
  type RecapSourceMessage,
} from "./prompt.js";
import { RecapError } from "./errors.js";

/** Écrivain bas niveau : envoie un prompt à un modèle et renvoie sa réponse. */
export type RecapWriter = (prompt: string) => Promise<string>;

/** Progression d'un récapitulatif découpé (pour une attente VISIBLE). */
export interface RecapProgress {
  /** Numéro (1-based) de la tranche en cours de traitement. */
  part: number;
  /** Nombre total de tranches (donc d'appels modèle). */
  parts: number;
}

/** Entrée du générateur (portion choisie dans la conversation d'origine). */
export interface RecapInput {
  originSessionId: string;
  originTitle: string;
  /**
   * SUJET visé par l'utilisateur (texte court). Vide/absent ⇒ on récapitule
   * TOUTE la conversation, sans axe particulier.
   */
  subject?: string;
  /** Index du premier message retenu (0 = début). */
  fromIndex: number;
  /** `true` si la portion couvre tout le fil. */
  wholeThread: boolean;
  messages: readonly RecapSourceMessage[];
  /**
   * Rappel de progression (facultatif), invoqué AVANT chaque tranche quand le
   * fil est découpé : le nombre d'appels modèle peut rendre l'attente longue et
   * l'interface doit la rendre VISIBLE.
   */
  onProgress?: (progress: RecapProgress) => void;
}

/** Récapitulatif prêt à devenir le point de départ d'une conversation dédiée. */
export interface RecapResult {
  title: string;
  recap: string;
  messageCount: number;
  /** Nombre de tranches (1 = appel unique ; > 1 = fil découpé). */
  parts: number;
}

/** Port consommé par le transport WebSocket. */
export type RecapGenerator = (input: RecapInput) => Promise<RecapResult>;

/** Message HONNÊTE pour un refus qui ne peut pas être résolu par le découpage. */
function refusalMessage(reason: "single_message" | "too_many_parts", parts: number): string {
  const alternative =
    "Alternative RÉELLE et disponible : ouvre une NOUVELLE conversation (bouton « + ») — " +
    "ta mémoire durable est partagée entre les conversations et t'y suivra.";
  if (reason === "single_message") {
    return (
      "Un SEUL message de cette conversation dépasse à lui seul la taille maximale " +
      "traitable, et il ne peut pas être découpé sans rompre son sens. Aucune troncature " +
      "n'a été faite et aucune conversation n'a été créée. " +
      alternative
    );
  }
  return (
    `Cette conversation est trop volumineuse : il faudrait ${parts} parties pour la ` +
    `récapituler sans rien perdre, au-delà du plafond de ${RECAP_MAX_PARTS}. Aucune ` +
    "troncature n'a été faite et aucune conversation n'a été créée. " +
    alternative
  );
}

/**
 * Fabrique le générateur. Le `writer` reste la SEULE dépendance externe : sa
 * résolution de modèle (léger/lourd) est décidée au câblage, pas ici.
 */
export function createRecapService(writer: RecapWriter): RecapGenerator {
  return async (input: RecapInput): Promise<RecapResult> => {
    if (input.messages.length === 0) {
      throw new RecapError(
        "recap_empty",
        "Aucun message à récapituler à partir de ce point.",
      );
    }
    const subject = normalizeSubject(input.subject);
    // Un seul appel tant que la portion tient sous le plafond ; sinon on DÉCOUPE
    // par messages (jamais de troncature silencieuse).
    const chunks =
      measureMessages(input.messages) <= RECAP_INPUT_MAX_CHARS
        ? [input.messages]
        : splitMessagesForRecap(input.messages);
    // Garde-fou : une tranche insécable (message unique trop long) ne peut pas
    // être traitée ⇒ refus honnête, aucune conversation créée.
    if (chunks.some((chunk) => measureMessages(chunk) > RECAP_INPUT_MAX_CHARS)) {
      throw new RecapError(
        "recap_too_long",
        refusalMessage("single_message", 1),
      );
    }
    if (chunks.length > RECAP_MAX_PARTS) {
      throw new RecapError(
        "recap_too_long",
        refusalMessage("too_many_parts", chunks.length),
      );
    }
    const bodies: string[] = [];
    let modelTitle: string | null = null;
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index] ?? [];
      input.onProgress?.({ part: index + 1, parts: chunks.length });
      const prompt = buildGeneratorPrompt({
        originTitle: input.originTitle,
        ...(subject.length > 0 ? { subject } : {}),
        wholeThread: input.wholeThread,
        fromIndex: input.fromIndex,
        messages: chunk,
        ...(chunks.length > 1
          ? { part: { index: index + 1, total: chunks.length } }
          : {}),
      });
      let raw: string;
      try {
        raw = await writer(prompt);
      } catch (error) {
        // ⚠️ TOUT OU RIEN : l'échec d'UNE tranche annule tout le récapitulatif.
        throw new RecapError(
          "recap_failed",
          "La génération du récapitulatif a échoué ; aucune conversation n'a été créée.",
          { cause: error },
        );
      }
      const parsed = parseGeneratorOutput(raw ?? "");
      if (parsed.recap.trim().length === 0) {
        throw new RecapError(
          "recap_failed",
          "Le récapitulatif généré est vide ; aucune conversation n'a été créée. " +
            "Réessayez.",
        );
      }
      bodies.push(parsed.recap);
      if (modelTitle === null && parsed.title && parsed.title.trim().length > 0) {
        modelTitle = parsed.title.trim();
      }
    }
    // ⚠️ CONCATÉNATION (jamais une re-synthèse) : les parties sont assemblées
    // DANS L'ORDRE, chacune signalée. Rien n'est perdu aux joints.
    const recap = joinRecapParts(bodies);
    // Le TITRE proposé vient du SUJET quand l'utilisateur en a donné un (c'est
    // ce qu'il veut retrouver plus tard) ; sinon du titre de la 1re partie ;
    // sinon d'un repli honnête. Il reste MODIFIABLE dans l'aperçu avant création.
    const title =
      subject.length > 0
        ? subject
        : modelTitle ?? fallbackTitle(input.originTitle, input.messages);
    return {
      title,
      recap,
      messageCount: input.messages.length,
      parts: chunks.length,
    };
  };
}
