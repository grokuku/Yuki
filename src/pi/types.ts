/**
 * Types PUBLICS de la façade `PiHost`.
 *
 * RÈGLE : aucun type du SDK Pi n'apparaît dans ce fichier. Tout ce qui sort de
 * la façade est du JSON simple, sérialisable, agnostique du SDK et du
 * fournisseur de modèle. La seule exception au principe d'encapsulation est
 * `src/pi/sdk-host.ts`, qui est le seul module autorisé à importer le SDK.
 */

import type { AgentDirectoryPort } from "../agents/directory.js";
import type {
  ExecutionServicePort,
  ScreenshotServicePort,
  SecretRequestToolPort,
} from "../agents/execution.js";
import type { SecretDirectoryPort } from "../secrets/directory.js";
import type { DelegateServicePort } from "../delegation/ports.js";
import type {
  LibrarianArchivePort,
  LibrarianPort,
  LibrarianScreenshotPort,
} from "../librarian/types.js";
import type { LibrarianShotView, LibrarianShotsPort } from "../librarian/shots.js";
import type { HeritagePort } from "../memory/heritage.js";
import type { ConversationArchivePort } from "../memory/conversation-archive.js";
import type { MemoryPort } from "../memory/types.js";
import type { PersonalityPort } from "../personality/types.js";
import type { ReactionsPort } from "../reactions/types.js";
import type { RulesPort } from "../rules/types.js";
import type { ModelsConfig } from "../llm/models.js";

/** Niveaux de raisonnement acceptés par le SDK (repris tels quels). */
export type PiThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export const PI_THINKING_LEVELS: readonly PiThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Sous-ensemble du logger d'observabilité utilisé par le domaine Pi. */
export interface PiLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/**
 * Options du rechargement À CHAUD de la configuration des modèles
 * (`PiHost.applyLlmConfig`).
 */
export interface ApplyLlmConfigOptions {
  /**
   * Nouveau contenu GÉNÉRÉ de `models.json` (reconstruit depuis la config
   * effective). Absent ⇒ le fichier n'est pas réécrit (seul le runtime de
   * modèles est rafraîchi).
   */
  modelsConfig?: ModelsConfig;
  /** Référence `provider/modelId` du modèle CONVERSATIONNEL (léger). */
  conversationModel: string;
  /** Niveau de raisonnement du léger (sinon celui déduit de la référence). */
  conversationThinking?: PiThinkingLevel;
}

/** Options de construction du host embarqué. */
export interface PiHostOptions {
  /** Répertoire d'état du SDK (settings.json, auth.json, models.json…). */
  agentDir: string;
  /** Répertoire de travail effectif (nomme le dossier de sessions). */
  cwd: string;
  /** Contenu du prompt système généraliste (remplace celui du SDK). */
  systemPrompt: string;
  /** Répertoire de stockage des sessions (JSONL). */
  sessionsDir?: string;
  /** Répertoire HOME inscriptible (replis du SDK via `os.homedir()`). */
  home?: string;
  /** Modèle par défaut, au format `provider/modelId` (ex. `llm-light/gemma4:31b`). */
  model?: string;
  /** Niveau de raisonnement initial. */
  thinking?: PiThinkingLevel;
  /** Fichier de réglages à seeder sur le volume au premier démarrage. */
  settingsSeedPath?: string;
  /**
   * Contenu GÉNÉRÉ de `models.json`, écrit sur le volume au démarrage (Lot 11).
   * Absent ⇒ le host n'écrit pas le fichier (tests, host nu).
   */
  modelsConfig?: ModelsConfig;
  /**
   * Allowlist d'outils (builtins + noms d'outils custom) imposée au SDK.
   * Remplace l'ancienne valeur `noTools: "all"` : le léger garde une liste
   * EXPLICITE (lecture seule + délégation), jamais d'écriture/exécution.
   */
  tools?: readonly string[];
  /** Outils custom opaques fournis par le câblage (SDK, hors façade). */
  customTools?: readonly unknown[];
  /** Source d'événements additionnels (délégation) relayée sur le bus. */
  eventSource?: PiEventSource;
  /**
   * Port de délégation. Présent ⇒ la façade construit et expose les outils
   * `delegate`/`job_status`/`cancel_job`. Absent ⇒ aucun outil de délégation.
   */
  delegation?: DelegateServicePort;
  /**
   * Port d'exécution déléguée (Lot 4). Présent ⇒ la façade construit l'outil
   * `run_command` (garde-fou par agent appliqué côté Yuki). ⚠️ INVERSION DES
   * RÔLES : l'outil n'est réellement exposé que si l'allowlist du rôle le
   * contient — c'est le cas du worker LOURD (session éphémère), jamais du léger.
   * La session légère ne reçoit donc plus ce port.
   */
  execution?: ExecutionServicePort;
  /**
   * Port de CAPTURE D'ÉCRAN par l'agent (Lot 4, extension). Présent ⇒ la façade
   * construit l'outil `capturer_ecran` (même garde-fou que `run_command`).
   * ⚠️ INVERSION DES RÔLES : exposé uniquement au worker LOURD (allowlist) ; la
   * session légère ne reçoit plus ce port.
   */
  screenshots?: ScreenshotServicePort;
  /**
   * Port de CONSULTATION des agents appairés (Lot 4, extension). Présent ⇒ la
   * façade expose les outils `lister_agents` et `etat_agent` (LECTURE SEULE).
   * Indépendant de `execution` : consulter n'est pas exécuter.
   */
  directory?: AgentDirectoryPort;
  /**
   * Port de CONSULTATION des secrets du coffre. Présent ⇒ la façade expose
   * l'outil `lister_secrets` (LECTURE SEULE, NOMS seulement — jamais une valeur).
   * Indépendant de l'exécution : savoir quels secrets existent n'est pas agir.
   */
  secrets?: SecretDirectoryPort;
  /**
   * Port de DEMANDE de secret par le modèle (`demander_secret`). Présent ⇒ la
   * façade expose l'outil qui ouvre une fenêtre de saisie DANS la conversation.
   * ⚠️ RÉSERVÉ AU LÉGER (celui qui converse) : le worker lourd n'a pas cet outil.
   */
  secretRequests?: SecretRequestToolPort;
  /**
   * Lot 13 : archive « vie antérieure ». Présent ⇒ la façade expose l'outil de
   * consultation `archive_vie_anterieure` (LECTURE SEULE) et enregistre
   * l'extension qui signale son EXISTENCE (une ligne, jamais son contenu).
   * Absent ⇒ ni outil ni signal (host nu, tests).
   */
  heritage?: HeritagePort;
  /**
   * Archive des conversations MISES DE CÔTÉ (fichiers du volume `state`, index
   * plein texte FTS5). Présente ⇒ (a) la conversation est ARCHIVÉE EN ENTIER à
   * la mise de côté et (b) la façade expose l'outil de recherche
   * `chercher_conversations_archivees` (LECTURE SEULE, sur demande explicite).
   * ⚠️ L'archive n'est JAMAIS injectée dans le prompt : seul l'outil la lit.
   */
  conversationArchive?: ConversationArchivePort;
  /**
   * Libraire de Pi-Web (recherche documentaire + web). Présent ⇒ la façade expose
   * les quatre outils (`recherche_libraire`, `liste_libraire`, `lire_libraire`,
   * `archive_libraire`). `client` sert la lecture, `archive` la soumission en
   * tâche de fond. Absent ⇒ aucun outil (URL de base non renseignée, tests).
   * ⚠️ `screenshot` + `shots` (optionnels) exposent en plus `capture_libraire`.
   */
  librarian?: {
    client: LibrarianPort;
    archive: LibrarianArchivePort;
    screenshot?: LibrarianScreenshotPort;
    shots?: LibrarianShotsPort;
    onShot?: (view: LibrarianShotView) => void;
    captureEnabled?: () => boolean;
  };
  /**
   * Faux ⇒ `send` échoue explicitement en `LLM_UNAVAILABLE` (clé légère
   * manquante). Une FONCTION est lue en direct (bascule à chaud des clés).
   */
  llmAvailable?: boolean | (() => boolean);
  /**
   * RÈGLES STRICTES de Yuki (première base du prompt de chaque tour). Présent ⇒
   * une extension SDK est enregistrée AVANT la personnalité : le bloc de règles
   * est concaténé au prompt AVANT la personnalité, la mémoire, l'annuaire des
   * agents et le signal d'archive. Absent ⇒ aucune règle (host nu, tests).
   */
  rules?: RulesPort;
  /**
   * Personnalité de Yuki (base du prompt de chaque tour). Présent ⇒ une
   * extension SDK est enregistrée EN PREMIER sur la session légère : le bloc de
   * personnalité est concaténé au prompt AVANT la mémoire, l'annuaire des agents
   * et le signal d'archive. Absent ⇒ aucune personnalité (host nu, tests).
   */
  personality?: PersonalityPort;
  /**
   * Lot 12 : mémoire durable. Présent ⇒ une extension SDK est enregistrée sur la
   * session légère (rappel borné avant tour, écriture automatique en fin de tour
   * et à la compaction). Absent ⇒ aucune mémoire (host nu, tests).
   */
  memory?: MemoryPort;
  /**
   * RÉACTIONS de l'utilisateur aux messages de Yuki. Présent ⇒ une extension SDK
   * est enregistrée sur la session légère : les N dernières réactions sont
   * injectées dans le PROMPT SYSTÈME du tour suivant (donnée encadrée). Absent ⇒
   * aucune injection (host nu, tests).
   *
   * ⚠️ Une réaction ne déclenche JAMAIS de tour : l'extension ne fait que lire.
   */
  reactions?: ReactionsPort;
  logger: PiLogger;
}

/** Cible d'ouverture/remplacement de session. */
export interface EnsureSessionOptions {
  /** Reprend un fichier de session précis. */
  sessionFile?: string;
  /** Force la création d'une nouvelle session. */
  new?: boolean;
}

/** Options d'envoi d'un message (extensible — Lot 2 : origine et corrélation de job). */
export interface SendOptions {
  /** Modèle à utiliser pour ce tour (`provider/modelId`). Réservé. */
  model?: string;
  /** Niveau de raisonnement pour ce tour. Réservé. */
  thinking?: PiThinkingLevel;
  /**
   * Origine du message. `job_report` marque un prompt SYNTHÉTIQUE (report d'un
   * job d'arrière-plan) : l'UI ne doit pas afficher de bulle utilisateur.
   */
  origin?: string;
  /** Job d'arrière-plan à l'origine du message (corrélation). */
  jobId?: string;
  /**
   * Fuseau horaire IANA du CLIENT (ex. `Europe/Paris`). Sert à horodater le
   * message dans l'heure LOCALE de l'utilisateur quand le conteneur tourne en
   * UTC. Absent/invalide ⇒ fuseau du process Node.
   */
  timezone?: string;
}

/** Poignée renvoyée immédiatement par `send`. */
export interface RunHandle {
  runId: string;
  sessionId: string;
  /** `true` si le message a été mis en file derrière un run en vol. */
  queued: boolean;
}

/** États observables d'une session. */
export type PiSessionStateName = "idle" | "streaming" | "waiting" | "error";

/**
 * Statistiques d'exécution d'un message assistant, PERSISTÉES dans la session.
 * Nombres UNIQUEMENT (jamais de texte : le prompt est éphémère et ne doit pas
 * entrer dans l'historique). Absentes d'un ancien message : l'UI n'affiche
 * alors AUCUN pied (pas de ligne vide fantôme).
 */
export interface RunMetrics {
  /** TTFT en ms (t0 → premier token). Absent si aucun token n'a été streamé. */
  ttftMs?: number;
  /** Durée totale du run en ms. */
  totalMs: number;
  /** Tokens de sortie consommés par le run. Absent si inconnu. */
  tokensOut?: number;
}

/**
 * Entrée de transcript : CONTENU SEUL (jamais de réflexion).
 * `timestamp` = instant du message en ms Unix, quand il est connu (message
 * restauré depuis une session, ou message live). Absent pour un ancien message
 * SANS horodatage : l'UI n'affiche alors AUCUNE heure (jamais d'erreur).
 * `metrics` = statistiques d'exécution restaurées depuis la session (TTFT,
 * total, tokens), ou posées en direct. Absent pour un message SANS statistiques
 * ⇒ l'UI n'affiche alors AUCUN pied.
 *
 * ⚠️ `role: "recap"` = bloc de RÉCAPITULATIF GÉNÉRÉ (jamais une parole de
 * l'utilisateur ni de l'assistant). `origin` porte le titre de la conversation
 * d'origine et `subject` le sujet visé : l'UI les affiche en en-tête du bloc.
 */
export interface TranscriptEntry {
  role: "user" | "assistant" | "recap";
  text: string;
  timestamp?: number;
  metrics?: RunMetrics;
  /**
   * IDENTIFIANT STABLE de l'entrée de session qui porte ce message (le même que
   * celui dont les statistiques sont l'enfant via `parentId`).
   *
   * ⚠️ C'est l'unique corrélation admise pour rattacher une RÉACTION à un
   * message : aucun second identifiant n'est inventé (une réaction attachée au
   * mauvais message ferait apprendre au modèle le contraire). Absent pour une
   * entrée qui n'a pas encore été persistée par le SDK (message en cours de
   * flux) : l'interface n'affiche alors aucune action de réaction.
   */
  id?: string;
  /**
   * Réaction que l'utilisateur a posée sur CE message (identifiant de réaction),
   * telle que le transport l'ajoute depuis le store des réactions. DONNÉE
   * d'affichage : jamais dans le JSONL de session, jamais un message.
   */
  reaction?: string;
  /** Titre de la conversation d'origine (entrée `recap` uniquement). */
  origin?: string;
  /** Sujet visé par le récapitulatif (entrée `recap` uniquement). */
  subject?: string;
}

/** État d'une session, sérialisable tel quel. */
export interface SessionState {
  sessionId: string;
  state: PiSessionStateName;
  activeRunId?: string;
  transcript: TranscriptEntry[];
}

/** Informations sur une session persistée. */
export interface SessionInfo {
  sessionId: string;
  sessionFile?: string;
  name?: string;
  /** Titre d'affichage PRÊT À L'EMPLOI : nom natif, sinon les premiers mots du
   * premier message, sinon un repli honnête (« Conversation sans titre »).
   * Jamais vide, jamais « (no messages) ». */
  title?: string;
  cwd?: string;
  createdAt?: string;
  updatedAt?: string;
  messageCount?: number;
  firstMessage?: string;
}

/**
 * Étape annoncée pendant une COMPACTION FORCÉE (pour une attente VISIBLE : la
 * passe de mémoire puis la compaction peuvent prendre plusieurs minutes).
 */
export interface CompactProgress {
  /** `memory` = passe de remplissage ; `compact` = summarisation du fil. */
  phase: "memory" | "compact";
  /** Morceau en cours (1-based) de la passe de mémoire. */
  part?: number;
  /** Nombre total de morceaux de la passe de mémoire. */
  parts?: number;
}

/** Options d'une compaction forcée. */
export interface CompactOptions {
  /** Progression observée (trame de contrôle côté transport, jamais persistée). */
  onProgress?: (progress: CompactProgress) => void;
}

/**
 * Résultat RÉEL d'une compaction forcée — ce que l'interface peut affirmer sans
 * mentir : ce qui s'est passé pour la mémoire ET pour le fil.
 */
export interface CompactOutcome {
  /** Résultat de la PASSE DE MÉMOIRE qui a précédé la compaction. */
  memory: {
    /** `true` si la passe a réellement tourné. */
    ran: boolean;
    /** Raison de l'absence de passe (`disabled`, `no_extractor`, `empty`, `failed`). */
    reason?: string;
    /** Détail d'un échec, si `reason === "failed"`. */
    error?: string;
    added: number;
    updated: number;
    removed: number;
    skipped: number;
    /** Nombre d'appels modèle réellement effectués par la passe. */
    chunks: number;
  };
  /** Contexte AVANT compaction, en tokens (mesuré par le SDK). */
  tokensBefore: number;
  /** Estimation du contexte APRÈS compaction (heuristique du SDK). */
  tokensAfter?: number;
}

/** Consommation de tokens d'un tour (agnostique du fournisseur). */
export interface PiUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
}

/** Raison de fin de run. */
export type RunFinishReason = "done" | "abort" | "error";

/** Canal d'un delta : `thinking` transite mais n'est jamais une réponse. */
export type DeltaChannel = "content" | "thinking";

/** Statut terminal d'un job (sous-ensemble de `JobStatus`). */
export type PiJobTerminalStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

/**
 * Événements de vie d'un job relayés sur le bus de la façade. Ils sont produits
 * par la couche délégation et rattachés à la session LÉGÈRE propriétaire.
 */
export type PiJobEvent =
  | { type: "job_started"; sessionId: string; jobId: string; task?: string }
  | {
      type: "job_finished";
      sessionId: string;
      jobId: string;
      status: PiJobTerminalStatus;
    }
  | { type: "job_report"; sessionId: string; jobId: string; runId?: string }
  /**
   * E3 — ACTIVITÉ d'un sous-agent (job d'arrière-plan) : progression et étapes,
   * pour le bloc REPLIÉ affiché DANS le fil de la conversation qui l'a lancé.
   *
   * ⚠️ ÉPHÉMÈRE : ce n'est NI un message, NI une entrée d'historique ⇒ jamais
   * dans le transcript, le snapshot, le rejeu ni la mémoire. Le transport le
   * route en trame de CONTRÔLE (jamais bufferisée) et ne l'achemine JAMAIS vers
   * `routeTtsEvent` ⇒ MUET par construction.
   */
  | {
      type: "job_activity";
      sessionId: string;
      jobId: string;
      /** Étape normalisée (chaîne ouverte, voir `PHASE`). */
      stage: string;
      /** Intitulé de la tâche (renseigné à l'étape `job_started`). */
      task?: string;
      /** Extrait de progression du sous-agent (DONNÉE d'affichage, jamais TTS). */
      detail?: string;
      /** Statut terminal (renseigné à l'étape `job_finished`). */
      status?: PiJobTerminalStatus;
      /** Instant ISO de l'étape. */
      at: string;
    };

/** Événements normalisés émis par la façade. */
export type PiEvent =
  | {
      type: "run_started";
      sessionId: string;
      runId: string;
      userText?: string;
      /** Origine du run (`job_report` = prompt synthétique). */
      origin?: string;
      /** Job d'arrière-plan corrélé. */
      jobId?: string;
    }
  | {
      type: "delta";
      sessionId: string;
      runId: string;
      channel: DeltaChannel;
      text: string;
    }
  | {
      type: "run_finished";
      sessionId: string;
      runId: string;
      reason: RunFinishReason;
      usage?: PiUsage;
      errorMessage?: string;
      /**
       * Identifiant d'entrée de session du message assistant PERSISTÉ par ce run
       * (celui que `run_finished` vient de clore). C'est l'identifiant de
       * corrélation des réactions : l'interface l'attache à la bulle qu'elle
       * vient d'afficher, et s'en sert pour poser une réaction sur CE message.
       * Absent si le SDK n'a persisté aucun message correspondant (réponse vide,
       * échec) : aucune action de réaction n'est alors proposée.
       */
      entryId?: string;
    }
  | {
      type: "phase";
      sessionId: string;
      runId: string;
      stage: string;
      at: string;
      sinceT0Ms: number;
      /** Job corrélé à cet étage (instrumentation de la délégation). */
      jobId?: string;
    }
  | {
      type: "run_summary";
      sessionId: string;
      runId: string;
      ttftMs?: number;
      totalMs: number;
      tokensIn?: number;
      tokensOut?: number;
      /** Lot 7 (optionnel) : t0 → premier octet PCM du 1er segment. */
      ttfaMs?: number;
      /** Lot 7 (optionnel) : cumul synthèse TTS du run. */
      ttsSynthMs?: number;
      /** Lot 7 (optionnel) : nombre de segments TTS synthétisés. */
      ttsSegments?: number;
    }
  | {
      type: "state";
      sessionId: string;
      state: PiSessionStateName;
      activeRunId?: string;
    }
  | PiJobEvent;

/** Source d'événements additionnels relayés sur le bus (couche délégation). */
export interface PiEventSource {
  subscribe(listener: (event: PiEvent) => void): () => void;
}

export type PiEventListener = (event: PiEvent) => void;
