/**
 * Contrat de transport WebSocket : types des messages client ↔ serveur.
 *
 * Aucun type du SDK ici : uniquement du JSON sérialisable. Chaque trame
 * serveur → client porte l'enveloppe `{ seq, ts, sessionId }`.
 */

import type {
  DeltaChannel,
  PiJobTerminalStatus,
  PiSessionStateName,
  PiUsage,
  RunFinishReason,
  SessionJobInfo,
  TranscriptEntry,
} from "../../pi/types.js";
import type { ComfyFinalPromptText, ComfyImageView } from "../../comfy/types.js";
import type { WireFile } from "../../files/types.js";
import { isAgentLevel, type AgentLevel } from "../../agents/types.js";
import type {
  CapturedScreenshotView,
  ExecutionStatus,
  PendingApprovalView,
  PendingSecretView,
} from "../../agents/execution.js";

/** Trame client → serveur. */
export type ClientMessage =
  | { type: "hello"; clientVersion?: string; sessionId?: string }
  | { type: "resume"; sessionId: string; fromSeq: number }
  | {
      /**
       * Message de l'utilisateur. `files` porte les identifiants des fichiers
       * DÉJÀ déposés (`POST /api/files`) : le serveur les rattache à la
       * conversation, insère leurs marqueurs dans le message et ajoute le bloc
       * `<fichiers>` (DONNÉE bornée) destiné au modèle.
       *
       * ⚠️ `text` peut être VIDE quand au moins un fichier est joint (un fichier
       * sans légende est un envoi parfaitement légitime).
       */
      type: "message";
      clientMsgId: string;
      text: string;
      tz?: string;
      files?: string[];
    }
  | { type: "abort"; runId?: string }
  | { type: "playback"; runId: string; event: "started" | "aborted" }
  | { type: "switch"; sessionId: string }
  | { type: "new" }
  | {
      /**
       * « Continuer dans une conversation dédiée » — ÉTAPE 1 : l'utilisateur
       * donne un SUJET (texte court) et l'on produit un RÉCAPITULATIF exhaustif
       * axé sur ce sujet, tiré de TOUTE la conversation. La réponse arrive en
       * trame de CONTRÔLE `recap_ready` (elle n'est PAS encore une conversation :
       * c'est un APERÇU, que l'humain peut relire et corriger).
       */
      type: "recap_preview";
      /** Conversation d'origine (jamais modifiée). */
      sessionId: string;
      /** Sujet visé ; vide ⇒ récapitulatif de toute la conversation. */
      subject: string;
      /** Identifiant de corrélation client (réponses `recap_ready`/`error`). */
      requestId: string;
    }
  | {
      /**
       * ÉTAPE 2 : l'humain VALIDE l'aperçu (titre/texte éventuellement
       * corrigés) et l'on crée la conversation dédiée. Le récapitulatif
       * provient de l'aperçu serveur (jamais d'un texte arbitraire).
       */
      type: "recap_create";
      requestId: string;
      title: string;
      /** Texte éventuellement corrigé par l'humain (défaut : l'aperçu). */
      recap?: string;
    }
  | { type: "rename"; sessionId: string; title: string }
  | { type: "setAside"; sessionId: string }
  | {
      /**
       * SUPPRESSION DÉFINITIVE d'une conversation de la LISTE (aucune corbeille,
       * aucune annulation). La mémoire durable n'est pas concernée.
       */
      type: "delete";
      sessionId: string;
    }
  | {
      /**
       * COMPACTION FORCÉE : passe de remplissage de mémoire PUIS compression du
       * fil. Longue opération : la réponse arrive en trames de CONTRÔLE
       * `compact_progress` (attente visible) puis `compact_done`.
       */
      type: "compact";
      sessionId: string;
      /** Identifiant de corrélation client (réponses `compact_done`/`error`). */
      requestId: string;
    }
  | { type: "pin"; sessionId: string; pinned: boolean }
  | {
      /**
       * RÉACTION sur un message de Yuki (`reaction: null` = la retirer).
       *
       * ⚠️ Ce n'est PAS un message : le serveur la persiste à part et rediffuse
       * une trame de CONTRÔLE. Il n'ouvre AUCUN tour (aucun `send` vers le
       * modèle) et n'alimente JAMAIS la synthèse vocale.
       *
       * `entryId` est l'identifiant STABLE de l'entrée de session du message visé
       * (le même que `yuki.run_metrics` utilise comme `parentId`) : aucun second
       * identifiant n'est inventé.
       */
      type: "reaction";
      sessionId: string;
      entryId: string;
      reaction: string | null;
    }
  | {
      /**
       * Présence déclarée par le client : onglet VISIBLE et fenêtre FOCALISÉE.
       * Sert uniquement à la décision anti-spam des notifications (jamais un
       * accusé de réception de message). La conversation « regardée » est celle
       * que le serveur connaît déjà (`client.sessionId`).
       */
      type: "presence";
      visible: boolean;
      focused: boolean;
    }
  | { type: "agent_enabled"; agentId: string; enabled: boolean }
  | { type: "agent_level"; agentId: string; level: AgentLevel }
  | { type: "approval_decision"; id: string; decision: "approve" | "deny" }
  | {
      /**
       * FOURNITURE d'un secret demandé (`awaiting_secret`) : l'humain a saisi les
       * valeurs des NOMS listés dans la demande. ⚠️ La valeur transite ici
       * (navigateur → serveur) puis est CHIFFRÉE dans le coffre ; elle n'est jamais
       * renvoyée. Voir la limite HTTP/LAN documentée.
       */
      type: "secret_submit";
      id: string;
      values: Record<string, string>;
    }
  | { type: "ping"; t: number };

/** Session exposée au client (liste des conversations de la barre latérale). */
export interface WireSession {
  id: string;
  /** Titre PRÊT À L'EMPLOI (jamais vide : repli géré côté serveur). */
  title: string;
  /** Date de dernière activité (ISO), si connue. */
  updatedAt?: string;
  messageCount: number;
  /** Extrait (premiers mots du premier message), si connu. */
  excerpt?: string;
  /** `true` si la conversation est ÉPINGLÉE (elle est alors triée en tête). */
  pinned?: boolean;
}

/** Agent exposé au client (encart de la barre latérale du chat). */
export interface WireAgent {
  agentId: string;
  /** Nom affichable — JAMAIS vide (repli serveur : l'`agentId`). */
  name: string;
  /** Niveau de garde-fou courant (D118). */
  level: AgentLevel;
  /** `true` si l'agent est révoqué (dé-appairé, restaurable). */
  revoked: boolean;
  /** `true` si un canal vivant est ouvert pour cet agent. */
  online: boolean;
  /**
   * Dernière activité connue de l'agent (ISO), `null` s'il ne s'est JAMAIS
   * connecté. Optionnel : un transport qui ne la connaît pas n'a rien à
   * inventer (l'interface affiche alors « jamais connecté »).
   */
  lastSeen?: string | null;
  /**
   * `true` si la machine est déclarée « MATÉRIEL SENSIBLE » (réglage persisté).
   * Optionnel : absent = machine ordinaire.
   */
  sensitive?: boolean;
  /**
   * `true` si l'agent sensible est VERROUILLÉ (état EN MÉMOIRE, jamais persisté) :
   * son niveau de garde-fou est INCHANGÉ, mais toute commande est refusée tant
   * que l'utilisateur ne l'a pas déverrouillée avec le mot de passe d'instance.
   * C'est ce que l'interface montre (cadenas) sur BUREAU et sur TÉLÉPHONE.
   */
  locked?: boolean;
  /** Temps restant (ms) avant le reverrouillage automatique, si déverrouillé. */
  unlockRemainingMs?: number;
}

/** Corps d'une trame serveur → client. */
export type ServerMessage =
  | { type: "welcome"; serverVersion: string; resumed: boolean; replayFrom?: number }
  | { type: "accepted"; clientMsgId: string; runId: string; queued: boolean }
  | { type: "state"; state: PiSessionStateName; activeRunId?: string }
  | { type: "run_started"; runId: string; userText?: string; origin?: string; jobId?: string }
  | { type: "delta"; runId: string; channel: DeltaChannel; text: string }
  | {
      type: "run_finished";
      runId: string;
      reason: RunFinishReason;
      usage?: PiUsage;
      errorMessage?: string;
      /**
       * Identifiant STABLE de l'entrée de session du message assistant persisté
       * par ce run : c'est la clé de corrélation des RÉACTIONS (le même que le
       * `parentId` de `yuki.run_metrics`). Absent ⇒ aucun bouton de réaction.
       */
      entryId?: string;
    }
  | {
      type: "phase";
      runId: string;
      stage: string;
      at: string;
      sinceT0Ms: number;
      jobId?: string;
    }
  | {
      type: "job_started";
      jobId: string;
      task?: string;
    }
  | {
      type: "job_finished";
      jobId: string;
      status: PiJobTerminalStatus;
    }
  | {
      type: "job_report";
      jobId: string;
      runId?: string;
    }
  | {
      /**
       * E3 — ACTIVITÉ d'un sous-agent (progression/étapes), affichée dans le fil
       * de la conversation qui l'a lancé. C'est un ÉTAT TEMPORAIRE : trame de
       * CONTRÔLE (aucun `seq` consommé), JAMAIS bufferisée, donc jamais dans le
       * rejeu, le snapshot, le transcript ou la mémoire.
       *
       * ⚠️ MUETTE PAR CONSTRUCTION : le transport ne la passe JAMAIS à
       * `routeTtsEvent` (seul alimentateur du moteur TTS).
       */
      type: "job_activity";
      jobId: string;
      /** Étape normalisée (`job_started`/`job_first_token`/`job_progress`/`job_finished`). */
      stage: string;
      /** Intitulé de la tâche (étape `job_started`). */
      task?: string;
      /** Extrait de progression du sous-agent (donnée d'affichage, jamais TTS). */
      detail?: string;
      /** Statut terminal (étape `job_finished`). */
      status?: PiJobTerminalStatus;
      /** Instant ISO de l'étape. */
      at: string;
    }
  | {
      type: "run_summary";
      runId: string;
      ttftMs?: number;
      totalMs: number;
      tokensIn?: number;
      tokensOut?: number;
      /** Lot 7 : t0 → premier octet PCM du 1er segment. */
      ttfaMs?: number;
      /** Lot 7 : cumul synthèse TTS du run. */
      ttsSynthMs?: number;
      /** Lot 7 : nombre de segments TTS synthétisés. */
      ttsSegments?: number;
    }
  | {
      type: "snapshot";
      state: PiSessionStateName;
      activeRunId?: string;
      /**
       * ÉTAT VIVANT du run en cours : `true` s'il n'a pas encore produit de
       * contenu. Permet à l'interface de réafficher l'indicateur d'attente en
       * ROUVRANT une conversation qui tournait en arrière-plan.
       */
      awaitingFirstToken?: boolean;
      /**
       * Jobs d'arrière-plan NON terminaux de la conversation (lus dans le
       * `JobStore`). Absent quand il n'y en a aucun : un job fini pendant qu'on
       * regardait un autre fil n'est donc JAMAIS présenté comme « en cours ».
       */
      jobs?: SessionJobInfo[];
      transcript: TranscriptEntry[];
    }
  | { type: "error"; code: string; message: string; runId?: string; requestId?: string }
  | {
      /**
       * PROGRESSION d'une COMPACTION FORCÉE (trame de CONTRÔLE : aucun `seq`
       * consommé, jamais bufferisée). Deux phases longues : la passe de mémoire
       * (morceau par morceau) puis la summarisation du fil. Sans elles,
       * l'utilisateur croirait que c'est planté.
       */
      type: "compact_progress";
      requestId: string;
      /** `memory` = passe de remplissage de mémoire ; `compact` = compression. */
      phase: "memory" | "compact";
      /** Morceau en cours de la passe de mémoire (1-based). */
      part?: number;
      /** Nombre total de morceaux de la passe de mémoire. */
      parts?: number;
    }
  | {
      /**
       * COMPACTION TERMINÉE — compte rendu RÉEL (trame de CONTRÔLE). Il dit ce
       * qui s'est passé pour la mémoire ET pour le fil : jamais un succès muet,
       * jamais une affirmation sans mesure.
       */
      type: "compact_done";
      requestId: string;
      /** Passe de mémoire qui a PRÉCÉDÉ la compaction (ordre garanti). */
      memory: {
        ran: boolean;
        reason?: string;
        error?: string;
        added: number;
        updated: number;
        removed: number;
        skipped: number;
        chunks: number;
      };
      /** Contexte AVANT compaction, en tokens (mesuré par le moteur). */
      tokensBefore: number;
      /** Estimation APRÈS compaction (heuristique du moteur), si fournie. */
      tokensAfter?: number;
      /** Titre de la conversation compactée (compte rendu lisible). */
      title: string;
    }
  | {
      /**
       * APERÇU de récapitulatif (trame de CONTRÔLE, aucun `seq` consommé :
       * jamais bufferisée, jamais dans le rejeu ni un snapshot). Ce n'est PAS
       * encore une conversation : c'est le garde-fou contre la perte
       * d'information, affiché à l'humain AVANT toute création.
       */
      type: "recap_ready";
      requestId: string;
      /** Titre proposé (modifiable). */
      title: string;
      /** Récapitulatif EXHAUSTIF (relisible, corrigeable). */
      recap: string;
      /** Titre de la conversation d'origine (référence). */
      originTitle: string;
      /** Identifiant de la conversation d'origine. */
      originSessionId: string;
      /** Sujet visé, si l'utilisateur en a donné un. */
      subject?: string;
      /** Nombre de messages pris en compte. */
      messageCount: number;
      /** Nombre de parties (1 = appel unique ; > 1 = conversation découpée). */
      parts: number;
    }
  | {
      /**
       * PROGRESSION d'un récapitulatif DÉCOUPÉ (trame de CONTRÔLE, aucun `seq`
       * consommé, jamais bufferisée) : signale la partie EN COURS pour que
       * l'attente reste VISIBLE (plusieurs appels modèle = plusieurs minutes).
       */
      type: "recap_progress";
      requestId: string;
      /** Numéro (1-based) de la partie en cours. */
      part: number;
      /** Nombre total de parties. */
      parts: number;
    }
  | {
      /**
       * La conversation dédiée a été CRÉÉE et le récapitulatif injecté. Trame de
       * CONTRÔLE (aucun `seq` consommé) : elle clôt le cycle côté client (le
       * déclencheur redevient disponible).
       */
      type: "recap_created";
      requestId: string;
    }
  | {
      /** Liste des conversations + conversation active (null = aucune). */
      type: "sessions";
      sessions: WireSession[];
      activeId: string | null;
    }
  | {
      /**
       * État des agents appairés (encart de la barre latérale du chat). Trame de
       * CONTRÔLE : envoyée à la connexion (`hello`/`resume`) puis DIFFUSÉE à
       * chaque changement du registre — jamais bufferisée, aucun `seq` consommé.
       */
      type: "agents";
      agents: WireAgent[];
    }
  | {
      /**
       * Demande de VALIDATION HUMAINE à afficher DANS la conversation. C'est un
       * ÉTAT TEMPORAIRE de l'interface : trame de contrôle (aucun `seq`
       * consommé), JAMAIS bufferisée, JAMAIS dans le transcript ni le snapshot.
       */
      type: "approval";
      approval: PendingApprovalView;
    }
  | {
      /**
       * Retire le bloc de validation (décidée/expirée) — idempotent.
       */
      type: "approval_cleared";
      id: string;
    }
  | {
      /**
       * Demande de SECRET à afficher DANS la conversation (fenêtre flottante).
       * ÉTAT TEMPORAIRE (trame de CONTRÔLE, aucun `seq` consommé) : JAMAIS
       * bufferisée, donc jamais dans le rejeu, le snapshot, le transcript ou la
       * mémoire. ⚠️ Ne porte JAMAIS une valeur : seulement les NOMS à fournir, la
       * machine et la commande EXACTE (avec ses références).
       */
      type: "secret_request";
      request: PendingSecretView;
    }
  | {
      /** Retire la fenêtre de secret (fournie/annulée/expirée) — idempotent. */
      type: "secret_cleared";
      id: string;
    }
  | {
      /**
       * Résultat d'une commande exécutée IMMÉDIATEMENT après approbation. ÉTAT
       * TEMPORAIRE (même épisémérité que le bloc) : jamais dans l'historique.
       */
      type: "approval_result";
      result: ApprovalResultFrame;
    }
  | {
      /**
       * CAPTURE D'ÉCRAN affichée DANS la conversation. Trame de CONTRÔLE (aucun
       * `seq` consommé) : JAMAIS bufferisée, JAMAIS dans le transcript ni le
       * snapshot ni la mémoire. L'image n'est affichée qu'à l'HUMAIN — elle
       * n'est JAMAIS renvoyée au modèle.
       */
      type: "screenshot";
      screenshot: CapturedScreenshotView;
    }
  | {
      /**
       * RÉACTION posée sur un message de Yuki — trame de CONTRÔLE (aucun `seq`
       * consommé, jamais bufferisée). État VIVANT : le rechargement et la
       * reconnexion le retrouvent dans le `snapshot` (les entrées assistant y
       * portent leur `reaction`). `reaction: null` = retirée.
       *
       * ⚠️ MUETTE PAR CONSTRUCTION : elle n'est jamais passée à `routeTtsEvent`
       * (seul alimentateur du moteur TTS) et ne déclenche aucun tour.
       */
      type: "reaction";
      /** Conversation concernée (l'enveloppe la porte déjà : on la redit). */
      sessionId: string;
      entryId: string;
      reaction: string | null;
    }
  | {
      /**
       * Yuki a ENVOYÉ un fichier dans cette conversation. Trame de CONTRÔLE
       * (aucun `seq` consommé, jamais bufferisée) : elle affiche dans le fil une
       * carte CLIQUABLE et TÉLÉCHARGEABLE (`/fichiers/<id>.<ext>`).
       *
       * ⚠️ Aucun contenu ne voyage ici : seulement des métadonnées et le chemin
       * same-origin (aucun élargissement de CSP : un fichier se télécharge, il ne
       * s'affiche pas — sauf une image, servie en `image/*`).
       */
      type: "file_sent";
      sessionId: string;
      file: WireFile;
      /** `yuki` = envoyé par Yuki ; `user` = fichier joint par l'utilisateur. */
      from: "yuki" | "user";
    }
  | {
      /**
       * IMAGE GÉNÉRÉE par ComfyUI, affichée DANS la conversation. Trame de
       * CONTRÔLE (aucun `seq` consommé, jamais bufferisée) : elle n'entre donc
       * ni dans le rejeu, ni dans le snapshot, ni dans le transcript, ni dans la
       * mémoire.
       *
       * ⚠️ Elle porte un chemin SAME-ORIGIN (`/images/<id>.<ext>`) : `img-src
       * 'self'` suffit, la CSP n'est PAS élargie. Aucun octet d'image ne voyage
       * ici, et le nom de fichier renvoyé par ComfyUI n'est jamais exposé
       * (l'identifiant est aléatoire).
       *
       * ⚠️ Contrairement aux captures d'écran d'agents, l'image a AUSSI été
       * transmise au modèle : Yuki l'a vue et peut juger ou régénérer.
       *
       * ⚠️ `image.finalPrompt` (facultatif) porte le PROMPT FINAL publié par le
       * nœud étiqueté `YUKI_FINAL_PROMPT` : il est affiché SOUS l'image, en
       * LECTURE seule, replié. C'est une SORTIE du workflow — elle n'est jamais
       * réinjectée dans un graphe — et elle est déjà bornée côté serveur.
       */
      type: "image";
      image: ComfyImageView;
    }
  | {
      /**
       * ACCUSÉ DE RÉCEPTION : une ACTION vient de démarrer (délégation, génération
       * d'image, commande envoyée à un agent) et rien n'a encore été dit dans ce
       * run. C'est une ligne de STATUT courte (« Je m'en occupe. »), pas une
       * réponse : le fond suit. Elle ne promet AUCUN résultat.
       *
       * ⚠️ Le TEXTE vient du MODÈLE (c'est le premier texte du tour) ; le repli
       * en dur ne parle que s'il n'a rien écrit (`source: "fallback"`).
       *
       * Trame de CONTRÔLE (aucun `seq` consommé, jamais bufferisée) ⇒ jamais dans
       * le rejeu, le snapshot, le transcript ou la mémoire, et JAMAIS prononcée par
       * la synthèse vocale (le moteur TTS ne reçoit que les `delta` de contenu —
       * le texte de l'accusé n'en est jamais un).
       */
      type: "ack";
      runId: string;
      /** Outil dont l'action démarre (`delegate`, `generer_image`, `run_command`). */
      tool: string;
      /** Texte COURT et HUMAIN, en français, écrit par le modèle (ou le repli). */
      text: string;
      /** Origine de la phrase : le modèle l'a écrite, ou c'est le repli en dur. */
      source: "model" | "fallback";
    }
  | {
      /**
       * FICHE d'une image DÉJÀ affichée : le PROMPT FINAL publié par le workflow.
       *
       * ⚠️ Elle arrive APRÈS la trame `image` (le texte est lu après les octets) et
       * l'interface l'affiche SOUS l'image, sans jamais déplacer l'image (PIÈGE ⑤).
       * C'est une SORTIE du workflow, en LECTURE seule : elle n'est jamais
       * réinjectée dans un graphe.
       *
       * Trame de CONTRÔLE (aucun `seq` consommé, jamais bufferisée) : ce n'est pas
       * un message, et elle n'est jamais prononcée par la synthèse vocale.
       */
      type: "image_final_prompt";
      /** Image à compléter (`/images/<id>.<ext>`). */
      id: string;
      finalPrompt: ComfyFinalPromptText;
    }
  | { type: "pong"; t: number }
  | { type: "bye"; reason: string };

/** Résultat éphémère d'une commande approuvée, rendu à l'interface. */
export interface ApprovalResultFrame {
  id: string;
  agentId: string;
  agentName?: string;
  command: string;
  status: ExecutionStatus;
  /** `true` si la commande a réellement été exécutée (statut terminal de succès/échec). */
  ok: boolean;
  exitCode: number | null;
  message: string;
  /** Sortie encadrée (`<sortie …>`, DONNÉE) si la commande a été exécutée. */
  output?: string;
  durationMs?: number;
  truncated?: boolean;
  timedOut?: boolean;
}

/** Enveloppe commune à toute trame serveur → client. */
export interface ServerEnvelope {
  /** Entier monotone PAR SESSION, démarrant à 1. */
  seq: number;
  ts: string;
  sessionId: string;
}

export type ServerFrame = ServerEnvelope & ServerMessage;

export type ParseResult =
  | { ok: true; message: ClientMessage }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

/** Nombre maximal d'identifiants de fichiers acceptés dans UNE trame `message`. */
export const MAX_MESSAGE_FILE_IDS = 20;

/**
 * Analyse la liste d'identifiants de fichiers d'une trame `message`.
 *
 * Renvoie `[]` si le champ est absent, `null` si la forme est invalide (trame
 * refusée : mieux vaut un refus explicite qu'un fichier joint au hasard).
 * Un identifiant valide est EXACTEMENT 32 caractères hexadécimaux — la même
 * forme que celle produite par le stockage.
 */
function parseFileIds(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  if (raw.length > MAX_MESSAGE_FILE_IDS) return null;
  const ids: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string" || !/^[a-f0-9]{32}$/.test(value)) return null;
    ids.push(value);
  }
  return ids;
}

/**
 * Analyse et valide une trame client. Tolérant sur les champs optionnels,
 * strict sur les champs requis. Ne lève jamais.
 */
export function parseClientMessage(raw: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "invalid_json" };
  }
  if (!isRecord(parsed)) {
    return { ok: false, error: "not_an_object" };
  }
  const type = parsed.type;
  switch (type) {
    case "hello": {
      const sessionId = optionalString(parsed, "sessionId");
      const clientVersion = optionalString(parsed, "clientVersion");
      return {
        ok: true,
        message: {
          type: "hello",
          ...(clientVersion !== undefined ? { clientVersion } : {}),
          ...(sessionId !== undefined ? { sessionId } : {}),
        },
      };
    }
    case "resume": {
      const sessionId = optionalString(parsed, "sessionId");
      const fromSeq = parsed.fromSeq;
      if (sessionId === undefined) {
        return { ok: false, error: "resume_missing_session_id" };
      }
      if (typeof fromSeq !== "number" || !Number.isInteger(fromSeq) || fromSeq < 0) {
        return { ok: false, error: "resume_invalid_from_seq" };
      }
      return { ok: true, message: { type: "resume", sessionId, fromSeq } };
    }
    case "message": {
      const clientMsgId = optionalString(parsed, "clientMsgId");
      if (clientMsgId === undefined) {
        return { ok: false, error: "message_missing_client_msg_id" };
      }
      // Fichiers joints : identifiants OPAQUES (hexadécimaux 32). La liste est
      // bornée ICI (défense en profondeur : le service applique aussi sa borne).
      const files = parseFileIds(parsed.files);
      if (files === null) {
        return { ok: false, error: "message_invalid_files" };
      }
      const text = optionalString(parsed, "text");
      // ⚠️ Un texte VIDE est refusé SAUF s'il porte au moins un fichier.
      if (text === undefined) {
        return { ok: false, error: "message_empty_text" };
      }
      if (text.trim().length === 0 && files.length === 0) {
        return { ok: false, error: "message_empty_text" };
      }
      // Fuseau IANA du navigateur (facultatif) : permet d'horodater le message
      // dans l'heure LOCALE de l'utilisateur, même si le conteneur est en UTC.
      const tz = optionalString(parsed, "tz");
      return {
        ok: true,
        message: {
          type: "message",
          clientMsgId,
          text,
          ...(tz !== undefined && tz.trim().length > 0 ? { tz } : {}),
          ...(files.length > 0 ? { files } : {}),
        },
      };
    }
    case "abort": {
      const runId = optionalString(parsed, "runId");
      return {
        ok: true,
        message: { type: "abort", ...(runId !== undefined ? { runId } : {}) },
      };
    }
    case "playback": {
      const runId = optionalString(parsed, "runId");
      const event = parsed.event;
      if (runId === undefined) {
        return { ok: false, error: "playback_missing_run_id" };
      }
      if (event !== "started" && event !== "aborted") {
        return { ok: false, error: "playback_invalid_event" };
      }
      return { ok: true, message: { type: "playback", runId, event } };
    }
    case "switch": {
      const sessionId = optionalString(parsed, "sessionId");
      if (sessionId === undefined) {
        return { ok: false, error: "switch_missing_session_id" };
      }
      return { ok: true, message: { type: "switch", sessionId } };
    }
    case "new": {
      return { ok: true, message: { type: "new" } };
    }
    case "recap_preview": {
      const sessionId = optionalString(parsed, "sessionId");
      const requestId = optionalString(parsed, "requestId");
      if (sessionId === undefined) {
        return { ok: false, error: "recap_missing_session_id" };
      }
      if (requestId === undefined || requestId.trim().length === 0) {
        return { ok: false, error: "recap_missing_request_id" };
      }
      // Le sujet peut être VIDE (récapitulatif de toute la conversation).
      const subject = optionalString(parsed, "subject") ?? "";
      return {
        ok: true,
        message: { type: "recap_preview", sessionId, requestId, subject },
      };
    }
    case "recap_create": {
      const requestId = optionalString(parsed, "requestId");
      if (requestId === undefined || requestId.trim().length === 0) {
        return { ok: false, error: "recap_missing_request_id" };
      }
      const title = optionalString(parsed, "title");
      if (title === undefined) {
        return { ok: false, error: "recap_invalid_title" };
      }
      const recap = optionalString(parsed, "recap");
      return {
        ok: true,
        message: {
          type: "recap_create",
          requestId,
          title,
          ...(recap !== undefined ? { recap } : {}),
        },
      };
    }
    case "rename": {
      const sessionId = optionalString(parsed, "sessionId");
      if (sessionId === undefined) {
        return { ok: false, error: "rename_missing_session_id" };
      }
      // Le titre peut être VIDE (effacer le nom natif → repli automatique).
      const title = parsed.title;
      if (typeof title !== "string") {
        return { ok: false, error: "rename_invalid_title" };
      }
      return { ok: true, message: { type: "rename", sessionId, title } };
    }
    case "setAside": {
      const sessionId = optionalString(parsed, "sessionId");
      if (sessionId === undefined) {
        return { ok: false, error: "set_aside_missing_session_id" };
      }
      return { ok: true, message: { type: "setAside", sessionId } };
    }
    case "delete": {
      const sessionId = optionalString(parsed, "sessionId");
      if (sessionId === undefined) {
        return { ok: false, error: "delete_missing_session_id" };
      }
      return { ok: true, message: { type: "delete", sessionId } };
    }
    case "compact": {
      const sessionId = optionalString(parsed, "sessionId");
      if (sessionId === undefined) {
        return { ok: false, error: "compact_missing_session_id" };
      }
      const requestId = optionalString(parsed, "requestId");
      if (requestId === undefined) {
        return { ok: false, error: "compact_missing_request_id" };
      }
      return { ok: true, message: { type: "compact", sessionId, requestId } };
    }
    case "pin": {
      const sessionId = optionalString(parsed, "sessionId");
      if (sessionId === undefined) {
        return { ok: false, error: "pin_missing_session_id" };
      }
      if (typeof parsed.pinned !== "boolean") {
        return { ok: false, error: "pin_invalid_pinned" };
      }
      return { ok: true, message: { type: "pin", sessionId, pinned: parsed.pinned } };
    }
    case "reaction": {
      const sessionId = optionalString(parsed, "sessionId");
      if (sessionId === undefined || sessionId.length === 0) {
        return { ok: false, error: "reaction_missing_session_id" };
      }
      // L'identifiant du MESSAGE (entrée de session) est obligatoire : sans lui
      // la réaction ne pourrait pas être rattachée, et on refuse plutôt que de
      // la poser au hasard (une réaction sur le mauvais message est pire que
      // pas de réaction du tout).
      const entryId = optionalString(parsed, "entryId");
      if (entryId === undefined || entryId.length === 0) {
        return { ok: false, error: "reaction_missing_entry_id" };
      }
      // `null` = retrait ; une chaîne = identifiant de réaction du catalogue.
      const reaction = parsed.reaction;
      if (reaction !== null && typeof reaction !== "string") {
        return { ok: false, error: "reaction_invalid_reaction" };
      }
      return {
        ok: true,
        message: { type: "reaction", sessionId, entryId, reaction },
      };
    }
    case "presence": {
      if (typeof parsed.visible !== "boolean" || typeof parsed.focused !== "boolean") {
        return { ok: false, error: "presence_invalid_flags" };
      }
      return {
        ok: true,
        message: { type: "presence", visible: parsed.visible, focused: parsed.focused },
      };
    }
    case "agent_enabled": {
      const agentId = optionalString(parsed, "agentId");
      if (agentId === undefined || agentId.length === 0) {
        return { ok: false, error: "agent_enabled_missing_agent_id" };
      }
      if (typeof parsed.enabled !== "boolean") {
        return { ok: false, error: "agent_enabled_invalid_enabled" };
      }
      return {
        ok: true,
        message: { type: "agent_enabled", agentId, enabled: parsed.enabled },
      };
    }
    case "agent_level": {
      // Menu contextuel de l'agent : réglage DIRECT du niveau (D118). ⚠️ C'est
      // le MÊME état que le on/off : `disabled` = off, tout autre niveau = on
      // (le serveur mémorise le niveau précédent pour la bascule on/off).
      const agentId = optionalString(parsed, "agentId");
      if (agentId === undefined || agentId.length === 0) {
        return { ok: false, error: "agent_level_missing_agent_id" };
      }
      const level = parsed.level;
      if (!isAgentLevel(level)) {
        return { ok: false, error: "agent_level_invalid_level" };
      }
      return { ok: true, message: { type: "agent_level", agentId, level } };
    }
    case "approval_decision": {
      const id = optionalString(parsed, "id");
      if (id === undefined || id.length === 0) {
        return { ok: false, error: "approval_decision_missing_id" };
      }
      const decision = parsed.decision;
      if (decision !== "approve" && decision !== "deny") {
        return { ok: false, error: "approval_decision_invalid" };
      }
      return { ok: true, message: { type: "approval_decision", id, decision } };
    }
    case "secret_submit": {
      const id = optionalString(parsed, "id");
      if (id === undefined || id.length === 0) {
        return { ok: false, error: "secret_submit_missing_id" };
      }
      const values = parsed.values;
      if (!isRecord(values)) {
        return { ok: false, error: "secret_submit_invalid_values" };
      }
      const clean: Record<string, string> = {};
      for (const [name, value] of Object.entries(values)) {
        if (typeof value !== "string") {
          return { ok: false, error: "secret_submit_invalid_values" };
        }
        clean[name] = value;
      }
      return { ok: true, message: { type: "secret_submit", id, values: clean } };
    }
    case "ping": {
      const t = parsed.t;
      if (typeof t !== "number" || !Number.isFinite(t)) {
        return { ok: false, error: "ping_invalid_t" };
      }
      return { ok: true, message: { type: "ping", t } };
    }
    default:
      return { ok: false, error: "unknown_type" };
  }
}
