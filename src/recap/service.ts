/**
 * Service de RÉCAPITULATIF « conversation dédiée ».
 *
 * Le service est PUR vis-à-vis du SDK : il ne connaît qu'un `RecapWriter`
 * (`prompt → texte`), injecté. Le câblage réel (session éphémère en mémoire) vit
 * dans `src/pi/sdk/recap-writer.ts`, exactement comme l'extracteur de mémoire.
 *
 * Responsabilités :
 *   1. REFUSER honnêtement une portion trop longue (`RECAP_INPUT_MAX_CHARS`)
 *      plutôt que de la tronquer en silence (exigence « rien de perdu ») ;
 *   2. construire l'instruction EXHAUSTIVE (`buildGeneratorPrompt`) ;
 *   3. parser la sortie (titre proposé + corps verbatim) ;
 *   4. refuser une sortie VIDE (jamais de conversation créée « à moitié »).
 */

import {
  buildGeneratorPrompt,
  fallbackTitle,
  measureMessages,
  normalizeSubject,
  parseGeneratorOutput,
  RECAP_INPUT_MAX_CHARS,
  type RecapSourceMessage,
} from "./prompt.js";
import { RecapError } from "./errors.js";

/** Écrivain bas niveau : envoie un prompt à un modèle et renvoie sa réponse. */
export type RecapWriter = (prompt: string) => Promise<string>;

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
}

/** Récapitulatif prêt à devenir le point de départ d'une conversation dédiée. */
export interface RecapResult {
  title: string;
  recap: string;
  messageCount: number;
}

/** Port consommé par le transport WebSocket. */
export type RecapGenerator = (input: RecapInput) => Promise<RecapResult>;

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
    if (measureMessages(input.messages) > RECAP_INPUT_MAX_CHARS) {
      // ⚠️ AUCUNE TRONCATURE SILENCIEUSE : on refuse, on l'explique, et aucune
      // conversation n'est créée. L'utilisateur peut repartir d'un message plus
      // récent pour réduire la portion.
      throw new RecapError(
        "recap_too_long",
        "La portion à récapituler est trop volumineuse pour être traitée en un " +
          "seul appel sans risquer de perdre de l'information. Reprenez à partir " +
          "d'un message plus récent (ou d'un sujet plus ciblé).",
      );
    }
    const subject = normalizeSubject(input.subject);
    const prompt = buildGeneratorPrompt({
      originTitle: input.originTitle,
      ...(subject.length > 0 ? { subject } : {}),
      wholeThread: input.wholeThread,
      fromIndex: input.fromIndex,
      messages: input.messages,
    });
    let raw: string;
    try {
      raw = await writer(prompt);
    } catch (error) {
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
    // Le TITRE proposé vient du SUJET quand l'utilisateur en a donné un (c'est
    // ce qu'il veut retrouver plus tard) ; sinon du titre du modèle ; sinon d'un
    // repli honnête. Il reste MODIFIABLE dans l'aperçu avant création.
    const title =
      subject.length > 0
        ? subject
        : parsed.title && parsed.title.trim().length > 0
          ? parsed.title.trim()
          : fallbackTitle(input.originTitle, input.messages);
    return { title, recap: parsed.recap, messageCount: input.messages.length };
  };
}
