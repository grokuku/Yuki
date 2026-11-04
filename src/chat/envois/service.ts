/**
 * SERVICE des ENVOIS PROGRAMMÉS — programmation, annulation, exécution des dus.
 *
 * ⚠️ L'HISTOIRE (production, 2026-11-04) : « j'aimerais que tu fasses une image… et
 * que tu la postes à 16h10 dans l'Imagerie ». Yuki a répondu qu'elle n'avait « pas de
 * minuteur ». C'était vrai POUR ELLE et faux pour le système : le planificateur existe
 * depuis le lot 2 (`src/sources/scheduler.ts`). Ce service lui donne l'outil qui
 * manquait — sans écrire un second ordonnanceur : c'est le BALAYEUR EXISTANT qui
 * appelle `executerDus` (`src/index.ts`).
 *
 * ⚠️ CE QUI N'ARRIVE JAMAIS ICI, ET POURQUOI :
 *  - **aucun modèle n'est appelé** : le texte est FIGÉ à la programmation. À l'heure
 *    dite, rien n'est rédigé — sinon un envoi « programmé » coûterait un tour complet
 *    et pourrait dire autre chose que ce qui a été montré en confirmation ;
 *  - **aucune machine n'est touchée** : c'est un message, pas une action. Il est donc
 *    dans le groupe `toujours` (`src/llm/tool-policy.ts`) et ne demande aucune
 *    approbation ;
 *  - **le worker lourd ne peut pas programmer** : il n'a pas l'outil (invariant
 *    « un seul rédacteur », `docs/lot18-chat.md`).
 *
 * ⚠️ LA PUBLICATION PASSE PAR LE MÊME CHEMIN que `envoyer_message` /
 * `publier_dans_canal` : le port `publier` fourni par le câblage (`src/index.ts`)
 * appelle `envoyerDansCanal`, donc `adapter.send` et sa file PAR CONVERSATION
 * (`ConversationSendQueue`, `src/chat/reply/send-queue.ts:22`) — le même point
 * d'étranglement que la `ReplyProgress` d'un tour, donc aucun `send` simultané et
 * l'ordre conservé. Une cible LOCALE passe par `PiHost.publierMessage`, le chemin exact
 * de `envoyer_message` en local (`src/pi/sdk-host.ts:2489`).
 *
 * ⚠️ AUCUNE PERTE SILENCIEUSE : une cible disparue (canal quitté, fil supprimé) est un
 * ÉCHEC EXPLICITE, persisté avec sa raison ET journalisé. Une annulation aussi.
 */

import type { ChannelPostChannel } from "../../pi/index.js";
import { couperPourPlateforme, resoudreCanal, validerFichiers } from "../reply/channel-post.js";
import type { RemotePlatform } from "../types.js";
import { analyserQuand, formaterInstantEnvoi } from "./quand.js";
import type { EnvoisProgrammesStore } from "./store.js";
import {
  DELAI_MIN_MS,
  HORIZON_MAX_MS,
  MAX_ENVOIS_EN_ATTENTE,
  RATTRAPAGE_MAX_ENVOI_MS,
  type CibleEnvoi,
  type EnvoiProgramme,
} from "./types.js";

/** Événements journalisés par le lot 28 (ajoutés à `DeclencheurEvent`). */
export type EnvoiJournalEvent = "envoi_programme" | "envoi_publie" | "envoi_annule" | "envoi_echec";

/** Journal minimal (le `DeclencheurJournal` le satisfait). */
export interface EnvoisJournalPort {
  append(input: {
    event: EnvoiJournalEvent;
    source: string;
    texte?: string;
    raison?: string;
    envoi?: string;
    ts?: string;
  }): unknown;
}

export interface EnvoisLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

/** Demande de programmation (déjà résumée par l'outil). */
export interface ProgrammationInput {
  /** Délai relatif (`dans 30 min`) ou instant (ISO, `16:10`). */
  quand: string;
  /** Texte FIGÉ du message. */
  texte: string;
  /** Identifiants du store (0 à 3), validés comme pour `publier_dans_canal`. */
  fichierIds?: readonly string[];
  /** Canal cible ; omis ⇒ la conversation COURANTE du run. */
  canal?: string;
  /** Conversation où l'outil est appelé (`canal` = run de canal, `session` = local). */
  conversation: { canal?: string; session?: string };
}

/** Issue d'une programmation : toujours DITE. */
export type ProgrammationOutcome =
  | {
      ok: true;
      envoi: EnvoiProgramme;
      /** Instant effectif, déjà formaté en français avec son fuseau. */
      quandLisible: string;
      /** Libellé de la cible (« L'Imagerie », « cette conversation »…). */
      cibleLisible: string;
      /** `true` quand le texte a été coupé aux bornes de la plateforme. */
      tronque: boolean;
      /** Envois encore en attente APRÈS celui-ci (plafond lisible par le modèle). */
      enAttente: number;
    }
  | { ok: false; raison: string };

export interface EnvoisProgrammesServiceOptions {
  store: EnvoisProgrammesStore;
  /** Journal des déclencheurs (le même fichier : une seule trace à consulter). */
  journal?: EnvoisJournalPort;
  /** Canaux SUIVIS (miroir), relus à chaque programmation (`apply: hot`). */
  canaux: () => readonly ChannelPostChannel[];
  /**
   * Résolution SERVEUR d'un fichier du store (métadonnées seulement). Absent ⇒ aucun
   * fichier ne peut être joint (refus explicite).
   */
  fichier?: (fichierId: string) => { sessionId?: string; name: string; bytes: number } | null;
  /** Borne de taille par fichier (octets), relue à chaque appel. */
  maxFichierBytes?: () => number;
  /** Borne de caractères par plateforme (Mattermost réglable, Discord fixe). */
  maxChars?: (plateforme: RemotePlatform) => number;
  /**
   * Publication EFFECTIVE d'un envoi dû. ⚠️ Fournie par le câblage : c'est elle qui
   * décide du chemin (canal ou session locale). Elle LÈVE en cas d'échec.
   */
  publier: (input: {
    cible: CibleEnvoi;
    texte: string;
    fichierIds?: readonly string[];
  }) => Promise<void>;
  logger: EnvoisLogger;
  /** Horloge injectable (tests : l'heure due est décidée sans attendre). */
  now?: () => number;
}

/** Plafond atteint (refus explicite, jamais un envoi de plus). */
export const RAISON_PLAFOND = (attente: number): string =>
  `Rien n'a été programmé : ${attente} envois sont déjà en attente, c'est le maximum ` +
  `(${MAX_ENVOIS_EN_ATTENTE}). Attends qu'un envoi parte, ou annule-en un dans ` +
  "Configuration → Déclencheurs → « Envois programmés ».";

/** Délai minimal non respecté (30 s) : message actionnable, avec la bonne alternative. */
export const RAISON_DELAI_MIN = (secondes: number): string =>
  `Rien n'a été programmé : il faut au moins ${Math.round(DELAI_MIN_MS / 1000)} secondes ` +
  `d'avance (demandé : ${secondes} s). Pour publier TOUT DE SUITE, n'utilise pas cet ` +
  "outil : `envoyer_message` (cette conversation) ou `publier_dans_canal`.";

/** Horizon dépassé (30 jours). */
export const RAISON_HORIZON = (jours: number): string =>
  `Rien n'a été programmé : l'horizon maximal est de ${Math.round(HORIZON_MAX_MS / 86_400_000)} ` +
  `jours (demandé : ${jours} jours).`;

/** Date déjà passée. */
export const RAISON_PASSEE = (lisible: string): string =>
  `Rien n'a été programmé : cette heure est déjà passée (${lisible}). Indique une heure ` +
  "future — « dans 10 min », une heure de demain, ou une date complète.";

/** Fichiers impossibles dans une conversation LOCALE (aucun envoi de fichier local). */
export const RAISON_FICHIERS_LOCAL =
  "Rien n'a été programmé : les pièces jointes ne partent que dans un CANAL. Précise " +
  "`canal` (un canal suivi) pour joindre des fichiers, ou programme le texte seul ici.";

/** Libellé lisible d'une cible (journal et page de gestion). */
export function libelleCible(cible: CibleEnvoi, conversationCourante?: string): string {
  if (cible.type === "canal") return cible.titre ?? cible.conversationId;
  if (conversationCourante !== undefined && conversationCourante === cible.sessionId) {
    return "cette conversation";
  }
  return cible.titre ?? `conversation ${cible.sessionId.slice(0, 8)}…`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Programmation + exécution des envois dus.
 *
 * ⚠️ Une SEULE instance dans le processus (`src/index.ts`) : le fichier d'état a un
 * seul écrivain, comme `sources.json` (`SourcesStore`).
 */
export class EnvoisProgrammesService {
  private readonly options: EnvoisProgrammesServiceOptions;
  private readonly now: () => number;

  constructor(options: EnvoisProgrammesServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  /** Envois connus, du plus proche au plus lointain (page de gestion, API). */
  lister(): EnvoiProgramme[] {
    return this.options.store.list();
  }

  /** Nombre d'envois en attente (borne et affichage). */
  get enAttente(): number {
    return this.options.store.enAttente;
  }

  /**
   * Programme un envoi — ou REFUSE en expliquant.
   *
   * Ordre des contrôles : texte → heure → bornes d'heure → cible → fichiers →
   * plafond. C'est l'ordre du DROIT : le premier refus est le plus utile à lire.
   */
  programmer(input: ProgrammationInput): ProgrammationOutcome {
    const maintenant = this.now();

    // ① TEXTE VIDE : un envoi programmé sans texte serait une ligne invisible dans la
    //    page de gestion, et une bulle vide à l'heure dite.
    const texte = typeof input.texte === "string" ? input.texte : "";
    if (texte.trim() === "") {
      return {
        ok: false,
        raison:
          "Rien n'a été programmé : le message est vide. Donne le texte exact à publier " +
          "dans l'argument `texte`.",
      };
    }

    // ② HEURE : formes acceptées (délai relatif, ISO, `16:10`) et refus explicite sinon.
    const heure = analyserQuand(input.quand, maintenant);
    if (!heure.ok) return { ok: false, raison: heure.raison };

    // ③ BORNES D'HEURE, dans l'ordre où elles se comprennent.
    const delai = heure.at - maintenant;
    if (delai < 0) {
      return { ok: false, raison: RAISON_PASSEE(formaterInstantEnvoi(heure.at)) };
    }
    if (delai < DELAI_MIN_MS) {
      return { ok: false, raison: RAISON_DELAI_MIN(Math.floor(delai / 1000)) };
    }
    if (delai > HORIZON_MAX_MS) {
      return { ok: false, raison: RAISON_HORIZON(Math.ceil(delai / 86_400_000)) };
    }

    // ④ CIBLE : un canal SUIVI (comme `publier_dans_canal`), ou la conversation
    //    COURANTE. ⚠️ La résolution passe par `resoudreCanal` — la MÊME fonction que
    //    l'outil de publication, donc les mêmes refus (inconnu, ambigu, non suivi).
    const cible = this.resoudreCible(input);
    if (!cible.ok) return { ok: false, raison: cible.raison };

    // ⑤ FICHIERS : validés MAINTENANT (appartenance à la conversation source, même
    //    plateforme, taille, nombre). À l'heure dite, il n'y a plus de run pour le
    //    faire — la validation doit donc être posée ici, une fois pour toutes.
    const demandes = (input.fichierIds ?? [])
      .map((id) => (typeof id === "string" ? id.trim() : ""))
      .filter((id) => id !== "");
    let fichierIds: string[] = [];
    if (demandes.length > 0) {
      if (cible.cible.type !== "canal") {
        return { ok: false, raison: RAISON_FICHIERS_LOCAL };
      }
      const validation = validerFichiers(demandes, {
        plateforme: cible.cible.plateforme,
        ...(input.conversation.canal !== undefined
          ? { conversationSource: input.conversation.canal }
          : {}),
        ...(this.options.fichier !== undefined ? { fichier: this.options.fichier } : {}),
        ...(this.options.maxFichierBytes !== undefined
          ? { maxFichierBytes: this.options.maxFichierBytes }
          : {}),
      });
      if (!validation.ok) return { ok: false, raison: validation.raison };
      fichierIds = validation.ids;
    }

    // ⑥ PLAFOND d'envois en attente.
    const attente = this.options.store.enAttente;
    if (attente >= MAX_ENVOIS_EN_ATTENTE) {
      return { ok: false, raison: RAISON_PLAFOND(attente) };
    }

    // ⑦ BORNE DE LA PLATEFORME appliquée MAINTENANT : la même fonction que
    //    `envoyer_message` et `publier_dans_canal` (`couperPourPlateforme`). Ce qui est
    //    stocké est donc exactement ce qui partira — la confirmation donnée à la
    //    personne ne peut pas mentir sur la longueur du message.
    const coupe =
      cible.cible.type === "canal"
        ? couperPourPlateforme(
            cible.cible.plateforme,
            texte,
            this.options.maxChars?.(cible.cible.plateforme),
          )
        : { texte, tronque: false, limite: 0 };

    // ⑧ PERSISTANCE (atomique 0600) : l'envoi est écrit AVANT d'être confirmé au
    //    modèle — un redémarrage juste après ne le perd pas.
    let envoi: EnvoiProgramme;
    try {
      envoi = this.options.store.ajouter({
        quand: new Date(heure.at).toISOString(),
        texte: coupe.texte,
        ...(fichierIds.length > 0 ? { fichierIds } : {}),
        cible: cible.cible,
        ...(input.conversation.canal !== undefined
          ? { source: input.conversation.canal }
          : input.conversation.session !== undefined
            ? { source: input.conversation.session }
            : {}),
      });
    } catch (error) {
      this.options.logger.warn("envois.programmer.persist_failed", { error: messageOf(error) });
      return {
        ok: false,
        raison:
          "Rien n'a été programmé : l'envoi n'a pas pu être enregistré " +
          `(${messageOf(error)}). Réessaie, et signale-le si cela se reproduit.`,
      };
    }

    // ⚠️ La conversation COURANTE est celle du run : un CANAL pour un run de canal, une
    // SESSION pour le mode local (fil web, « Déclencheurs »). Sans la session, une
    // programmation faite depuis le fil local s'annonçait « conversation 1a2b3c4d… »
    // au lieu de « cette conversation » — le modèle ne pouvait pas confirmer la cible.
    const cibleLisible = libelleCible(
      cible.cible,
      input.conversation.canal ?? input.conversation.session,
    );
    this.journaliser({
      event: "envoi_programme",
      source: cibleLisible,
      envoi: envoi.id,
      texte: envoi.texte,
      raison: `Programmé pour ${new Date(heure.at).toISOString()}`,
    });
    this.options.logger.info("envois.programme", {
      envoi: envoi.id,
      quand: envoi.quand,
      cible: cible.cible.type === "canal" ? cible.cible.conversationId : cible.cible.sessionId,
      fichiers: fichierIds.length,
      tronque: coupe.tronque,
    });

    return {
      ok: true,
      envoi,
      quandLisible: formaterInstantEnvoi(heure.at),
      cibleLisible,
      tronque: coupe.tronque,
      enAttente: this.options.store.enAttente,
    };
  }

  /**
   * ANNULE un envoi encore en attente.
   *
   * ⚠️ Un envoi DÉJÀ PARTI ne peut pas être annulé (il est publié, pas reproductible) :
   * le refus le dit, avec l'heure d'envoi. L'annulation est persistée ET journalisée —
   * une disparition silencieuse de la liste serait indistinguable d'une purge.
   */
  annuler(id: string): { ok: true; envoi: EnvoiProgramme } | { ok: false; raison: string } {
    const envoi = this.options.store.get(id);
    if (!envoi) {
      return {
        ok: false,
        raison:
          "Aucun envoi programmé ne porte cet identifiant : il a peut-être déjà été " +
          "publié, annulé, ou purgé (l'historique est conservé 7 jours).",
      };
    }
    if (envoi.etat === "annule") {
      return { ok: false, raison: "Cet envoi est déjà annulé." };
    }
    if (envoi.etat !== "en_attente") {
      const quand =
        envoi.envoyeLe !== undefined ? ` (parti le ${formaterInstantEnvoi(Date.parse(envoi.envoyeLe))})` : "";
      return {
        ok: false,
        raison: `Cet envoi n'est plus en attente : il est « ${envoi.etat} »${quand}.`,
      };
    }
    const raison = "Annulé depuis la page de gestion.";
    const marque = this.options.store.marquer(id, "annule", { raison });
    this.journaliser({
      event: "envoi_annule",
      source: libelleCible(envoi.cible),
      envoi: envoi.id,
      texte: envoi.texte,
      raison,
    });
    this.options.logger.info("envois.annule", { envoi: envoi.id });
    return { ok: true, envoi: marque ?? envoi };
  }

  /**
   * EXÉCUTE les envois DUS — appelé par le BALAYEUR EXISTANT (`tick` du
   * `DeclencheurBalayeur`), jamais par un second `setInterval`.
   *
   * ⚠️ Un échec n'arrête pas les autres : chaque envoi est indépendant, et chacun
   * laisse une trace (état persisté + journal). Rien n'est perdu en silence.
   *
   * ⚠️ RATTRAPAGE : un envoi dû depuis plus de `RATTRAPAGE_MAX_ENVOI_MS` (1 h) n'est PAS
   * publié — il est marqué `echoue` avec sa raison (voir `types.ts`).
   */
  async executerDus(maintenant: number = this.now()): Promise<number> {
    const dus = this.options.store.dus(maintenant);
    let publies = 0;
    for (const envoi of dus) {
      const retard = maintenant - Date.parse(envoi.quand);
      if (retard > RATTRAPAGE_MAX_ENVOI_MS) {
        this.echouer(
          envoi,
          `Envoi manqué de ${Math.round(retard / 60_000)} min (rattrapage maximal ` +
            `${Math.round(RATTRAPAGE_MAX_ENVOI_MS / 60_000)} min) : il n'a PAS été publié ` +
            "en retard. Reprogramme-le si le message est toujours d'actualité.",
        );
        continue;
      }
      // ⚠️ `en_cours` est PERSISTÉ AVANT l'envoi : si le processus meurt pendant la
      // publication, le rechargement le verra et ne le rejouera pas (pas de doublon).
      this.options.store.marquer(envoi.id, "en_cours");
      try {
        await this.options.publier({
          cible: envoi.cible,
          texte: envoi.texte,
          ...(envoi.fichierIds !== undefined ? { fichierIds: envoi.fichierIds } : {}),
        });
      } catch (error) {
        this.echouer(envoi, messageOf(error));
        continue;
      }
      const marque = this.options.store.marquer(envoi.id, "envoye", {
        envoyeLe: new Date(this.now()).toISOString(),
      });
      publies += 1;
      this.journaliser({
        event: "envoi_publie",
        source: libelleCible(envoi.cible),
        envoi: envoi.id,
        texte: envoi.texte,
        ...(retard > 60_000
          ? { raison: `Publié avec ${Math.round(retard / 60_000)} min de retard (rattrapage).` }
          : {}),
      });
      this.options.logger.info("envois.publie", {
        envoi: envoi.id,
        retard_ms: retard,
        etat: marque?.etat,
      });
    }
    // Purge opportuniste des terminés (aucun minuteur dédié, donc).
    const purges = this.options.store.purger(this.now());
    if (purges > 0) this.options.logger.info("envois.purges", { envois: purges });
    return publies;
  }

  /** Marque un envoi ÉCHOUÉ avec sa raison, et le journalise (jamais un silence). */
  private echouer(envoi: EnvoiProgramme, raison: string): void {
    this.options.store.marquer(envoi.id, "echoue", { raison });
    this.journaliser({
      event: "envoi_echec",
      source: libelleCible(envoi.cible),
      envoi: envoi.id,
      texte: envoi.texte,
      raison,
    });
    this.options.logger.warn("envois.echec", { envoi: envoi.id, raison });
  }

  /**
   * Cible d'une programmation.
   *
   * ⚠️ Deux voies, une seule règle : un CANAL doit être SUIVI (sinon la personne
   * croirait avoir programmé quelque chose que Yuki n'a pas le droit d'écrire), et une
   * conversation LOCALE est acceptée telle quelle (c'est le fil d'où l'outil est appelé).
   */
  private resoudreCible(
    input: ProgrammationInput,
  ): { ok: true; cible: CibleEnvoi } | { ok: false; raison: string } {
    const canalDemande = (input.canal ?? "").trim();
    if (canalDemande === "") {
      const courante = (input.conversation.canal ?? "").trim();
      if (courante !== "") {
        // Le run EST dans un canal : c'est la cible par défaut, et c'est un canal suivi.
        return this.resoudreCanalSuivi(courante);
      }
      const session = (input.conversation.session ?? "").trim();
      if (session === "") {
        return {
          ok: false,
          raison:
            "Rien n'a été programmé : aucune conversation courante n'est identifiée. " +
            "Précise `canal` (un canal suivi) pour choisir la destination.",
        };
      }
      return { ok: true, cible: { type: "local", sessionId: session } };
    }
    return this.resoudreCanalSuivi(canalDemande);
  }

  private resoudreCanalSuivi(
    demande: string,
  ): { ok: true; cible: CibleEnvoi } | { ok: false; raison: string } {
    const canaux = this.options.canaux();
    const resolution = resoudreCanal(canaux, demande);
    if (!resolution.ok) {
      const liste =
        canaux.length === 0
          ? " Aucun canal n'est suivi pour l'instant."
          : "\nCanaux réellement disponibles :\n" +
            canaux.map((canal) => `- « ${canal.titre} » (${canal.conversationId})`).join("\n");
      return { ok: false, raison: `Rien n'a été programmé : ${resolution.raison}${liste}` };
    }
    const plateforme = resolution.canal.plateforme;
    if (plateforme !== "mattermost" && plateforme !== "discord") {
      return {
        ok: false,
        raison:
          `Rien n'a été programmé : la plateforme « ${plateforme} » de ce canal est ` +
          "inconnue, donc aucun envoi n'est possible.",
      };
    }
    return {
      ok: true,
      cible: {
        type: "canal",
        conversationId: resolution.canal.conversationId,
        plateforme,
        titre: resolution.canal.titre,
      },
    };
  }

  private journaliser(input: {
    event: EnvoiJournalEvent;
    source: string;
    envoi: string;
    texte?: string;
    raison?: string;
  }): void {
    try {
      this.options.journal?.append(input);
    } catch (error) {
      // ⚠️ Un journal indisponible ne doit pas empêcher un envoi de fonctionner.
      this.options.logger.warn("envois.journal.failed", { error: messageOf(error) });
    }
  }
}
