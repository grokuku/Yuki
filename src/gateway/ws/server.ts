/**
 * Transport WebSocket du gateway.
 *
 * - hook `upgrade` sur le serveur HTTP, chemin `/ws` uniquement ;
 * - cycle de vie des clients (`hello`, `resume`, `message`, `abort`, `ping`) ;
 * - fermeture propre (trame `bye` puis `close`) AVANT `server.close()`.
 *
 * Le buffer de rejeu et le compteur `seq` vivent dans `./session-stream.ts`,
 * au-dessus de l'abonnement au PiHost : les événements émis sans client
 * connecté sont déjà bufferisés.
 */

import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocket, WebSocketServer } from "ws";

import { toPiHostError } from "../../pi/errors.js";
import { DEFAULT_TIME_ZONE } from "../../pi/timestamp.js";
import { PHASE, type PiEvent, type PiHost } from "../../pi/index.js";
import type { SessionPinStore } from "../../pi/session-pins.js";
import { ORIGIN_RECAP } from "../../pi/synthetic.js";
import { isReactionId, type ReactionsGatewayPort } from "../../reactions/types.js";
import type { SessionState, TranscriptEntry } from "../../pi/index.js";
import {
  frameRecapPrompt,
  normalizeSubject,
  RecapError,
  type RecapGenerator,
  type RecapSourceMessage,
} from "../../recap/index.js";
import type {
  ApprovalGatewayPort,
  ExecutionOutcome,
  PendingApprovalView,
  ScreenshotGatewayPort,
  ScreenshotViewEvent,
  SecretRequestGatewayPort,
} from "../../agents/execution.js";
import type { ComfyImageView, ImagesGatewayPort } from "../../comfy/types.js";
import type { FilesGatewayPort, FileImageContent } from "../../files/types.js";
import type { FileReceivedView } from "../../agents/transfer.js";
import type { Logger } from "../../observability/logger.js";
import { TtsPipeline, type TtsPipelineDeps } from "../../tts/index.js";
import {
  parseClientMessage,
  type ApprovalResultFrame,
  type ClientMessage,
  type ServerEnvelope,
  type ServerFrame,
  type ServerMessage,
  type WireAgent,
  type WireSession,
} from "./protocol.js";
import type { RemoteConversation, RemoteMessage } from "../../chat/types.js";
import { isMirrorConversationId, remoteMessageToTranscript } from "../../chat/mirror.js";
import type { AgentLevel } from "../../agents/types.js";
import {
  SessionStreamStore,
  type SnapshotPayload,
  type StreamStateProvider,
} from "./session-stream.js";
import type { PresenceView, Transport, TransportStats } from "./transport.js";

export const WS_PATH = "/ws";

/**
 * Port du registre d'agents exposé au transport (encart de la barre latérale).
 * Découplé du domaine `agents` : le transport ne connaît que ce contrat.
 */
export interface AgentsGatewayPort {
  /**
   * Résumé des agents appairés (actifs ET révoqués), VISIBLES par `botId`.
   *
   * ⚠️ LOT 40 — le bot est celui de la CONNEXION (`client.botId`, résolu par
   * `rattacherBot`, jamais une valeur brute du client) : une page ouverte sur
   * `/?b=kohai` ne doit voir QUE les agents de `kohai`. Absent ⇒ bot par défaut
   * du port (`botActif`), comportement d'avant (mono-bot).
   */
  list(botId?: string): WireAgent[];
  /**
   * Bot par DÉFAUT du port (lot 35g), utilisé quand la connexion n'a déclaré
   * aucun `botId` (client d'avant L4, mono-bot). Absent ⇒ la trame `agents` ne
   * porte pas de bot et l'interface n'applique aucun filtre local (le serveur a
   * déjà filtré). Ce n'est JAMAIS une valeur fournie par le client.
   */
  botActif?(): string;
  /**
   * Applique on/off : `false` ⇒ niveau `disabled`, `true` ⇒ niveau précédent
   * mémorisé (ou défaut). Lève si l'agent est inconnu.
   */
  setEnabled(agentId: string, enabled: boolean): void;
  /**
   * Règle DIRECTEMENT le niveau de confirmation (menu contextuel de l'agent).
   * ⚠️ MÊME état que le on/off : `disabled` = off ; un autre niveau = on (le
   * niveau mémorisé pour la bascule on/off est mis à jour par le store).
   */
  setLevel(agentId: string, level: AgentLevel): void;
  /** S'abonne aux changements du registre. Renvoie le désabonnement. */
  subscribe(listener: () => void): () => void;
}

/**
 * Ordre d'affichage de la barre latérale : les conversations ÉPINGLÉES d'abord,
 * puis les autres par date décroissante. Les fiches sans date finissent en bas.
 * Fonction PURE (testable) ; `Array.sort` est stable, l'ordre d'entrée départage.
 */
export function orderSessions(sessions: WireSession[]): WireSession[] {
  return [...sessions].sort((a, b) => {
    const pinnedA = a.pinned ? 1 : 0;
    const pinnedB = b.pinned ? 1 : 0;
    if (pinnedA !== pinnedB) return pinnedB - pinnedA;
    const ta = a.updatedAt ?? "";
    const tb = b.updatedAt ?? "";
    if (ta === tb) return 0;
    return ta < tb ? 1 : -1; // décroissant
  });
}

export interface WsTransportOptions {
  host: PiHost;
  logger: Logger;
  serverVersion: string;
  replayBufferSize: number;
  replayBufferBytes: number;
  now?: () => number;
  /**
   * Lot 7 : dépendances du pipeline TTS. Absent ⇒ aucune trame audio (comportement
   * strictement identique aux lots précédents).
   */
  tts?: TtsPipelineDeps;
  /**
   * Demandes de validation humaine (D118) affichées DANS la conversation.
   * Absent ⇒ aucun bloc de validation (comportement inchangé).
   */
  approvals?: ApprovalGatewayPort;
  /**
   * Captures d'écran affichées DANS la conversation (image ÉPHÉMÈRE). Absent ⇒
   * aucune trame `screenshot` (comportement inchangé).
   */
  screenshots?: ScreenshotGatewayPort;
  /**
   * Images GÉNÉRÉES (ComfyUI) affichées DANS la conversation. Absent ⇒ aucune
   * trame `image` (comportement inchangé). ⚠️ Servies en same-origin
   * (`/images/<id>.<ext>`) : la CSP n'est jamais élargie.
   */
  images?: ImagesGatewayPort;
  /**
   * Épinglage des conversations. Absent ⇒ aucune conversation épinglable (la
   * trame `sessions` n'embarque alors aucun état `pinned`).
   */
  pins?: SessionPinStore;
  /**
   * Registre d'agents (encart de la barre latérale). Absent ⇒ aucune trame
   * `agents` (comportement inchangé).
   */
  agents?: AgentsGatewayPort;
  /**
   * Flux de fourniture de SECRETS (`awaiting_secret`). Absent ⇒ aucune trame
   * `secret_request` (comportement inchangé).
   */
  secrets?: SecretRequestGatewayPort;
  /**
   * « Continuer dans une conversation dédiée » : générateur de récapitulatif
   * (appel LLM isolé, injecté). Absent ⇒ l'action est indisponible (trame
   * d'erreur `recap_unavailable`, comportement inchangé pour le reste).
   */
  recap?: RecapGenerator;
  /**
   * RÉACTIONS de l'utilisateur aux messages de Yuki. Absent ⇒ l'action est
   * indisponible (trame d'erreur `reactions_unavailable`, comportement inchangé
   * pour le reste).
   */
  reactions?: ReactionsGatewayPort;
  /**
   * FICHIERS échangés : rattachement des fichiers joints à un message et envoi
   * par Yuki (trame de contrôle `file_sent`). Absent ⇒ aucune pièce jointe n'est
   * acceptée (comportement inchangé pour le reste).
   */
  files?: FilesGatewayPort;
  /**
   * CAPACITÉ VISION du modèle de conversation (réglage `/config`
   * `llm.light.vision`, qui produit `input` dans `models.json`).
   *
   * Absent ⇒ comportement historique (les images jointes partent). `false` ⇒ un
   * message porteur d'une IMAGE est REFUSÉ avec un motif explicite : sans
   * `"image"` dans `input`, le SDK remplace la pièce jointe par
   * « (tool image omitted: model does not support images) », et l'utilisateur
   * croirait que le modèle a vu son image. Jamais de silence.
   */
  vision?: { conversationReceivesImages: () => boolean };
  /**
   * TRANSFERT de fichiers depuis une machine appairée : la trame de CONTRÔLE
   * `file_received` signale à l'utilisateur qu'un fichier est désormais sur le
   * disque de Yuki (carte cliquable « Inclure dans la discussion »). Absent ⇒
   * aucune trame `file_received` (comportement inchangé).
   */
  agentTransfers?: FileTransferGatewayPort;
  /**
   * SOURCES : programmes extérieurs qui postent dans une conversation.
   *
   *  - la trame `sessions` dit, pour chaque fil, QUELLES sources y postent — c'est
   *    ce qui permet à la modale de suppression de LISTER les sources concernées ;
   *  - `detachSession` réaffecte ces sources (« nouvelle conversation à chaque
   *    fois ») quand le fil est supprimé, et l'écrit dans la boîte.
   *
   * Absent ⇒ aucun marquage, aucune réaffectation (comportement inchangé).
   */
  sources?: SourcesGatewayPort;
  /**
   * DISCUSSIONS (lot 18) : conversations MIROIR d'un canal distant. Absent ⇒
   * aucune trame `sessions` distante et aucun refus de création (comportement
   * strictement inchangé).
   */
  chat?: ChatGatewayPort;
  /**
   * FUSEAU des horodatages (réglage `/config` `ui.timeZone`, défaut `UTC`).
   *
   * ⚠️ Il remplace le fuseau du NAVIGATEUR que la trame `message` transportait
   * (`tz`) : c'était lui qui datait les prompts dans l'heure locale de la
   * machine, alors que Mattermost est en UTC — deux heures pour un même
   * événement. Le champ `tz` reste ACCEPTÉ (client déjà chargé) mais IGNORÉ.
   *
   * Absent ⇒ `UTC` : aucun chemin ne retombe sur le fuseau du process.
   */
  timeZone?: { current: () => string };
  /**
   * LOT 36 (L4) — les hosts des AUTRES bots (Map `botId → PiHost` de L3-d).
   *
   * ⚠️ Absent ⇒ le transport ne sert QUE le principal et toute trame portant un
   * `botId` est REFUSÉE en le nommant (jamais un repli silencieux). Présent ⇒ une
   * trame sans `botId` désigne toujours le principal (`host`, inchangé).
   */
  hosts?: BotHostsPort;
}

/**
 * Ce que le transport a besoin de savoir des hosts PAR BOT (lot 36, L4).
 *
 * ⚠️ Contrat VOLONTAIREMENT étroit : `pourDemarre` est le SEUL chemin autorisé
 * vers un host secondaire, et il refuse un bot inconnu comme un bot arrêté. Un
 * host construit mais dont `start()` a échoué ne peut donc jamais répondre.
 */
export interface BotHostsPort {
  /** Le host du bot PRINCIPAL (celui que l'option `host` porte déjà). */
  readonly principal: PiHost;
  /**
   * Host d'un bot SEULEMENT s'il est démarré (principal inclus), ou `undefined`.
   *
   * ⚠️ `undefined` n'est JAMAIS remplacé par le principal : l'appelant doit
   * refuser la demande en nommant le bot.
   */
  pourDemarre(botId: string): PiHost | undefined;
  /** Identifiants des bots connus (diagnostic/journal), si le port les connaît. */
  ids?(): string[];
  /**
   * ⚠️ LOT 36 (L11) — BOT PROPRIÉTAIRE d'un host.
   *
   * C'est ce qui permet au transport de choisir la CONFIGURATION du run qui
   * parle (donc la voix, `tts.voice` étant une clé `bot`) : la source de
   * l'événement est le host émetteur, jamais un bot deviné.
   *
   * Absent ⇒ aucun bot n'est nommé et le pipeline TTS garde la configuration
   * d'instance (comportement d'avant L11).
   */
  botDe?(host: PiHost): string | undefined;
}

/**
 * Port des TRANSFERTS de fichiers exposé au transport. Découplé du domaine
 * `agents` : le transport ne connaît que ce contrat (aucun import du service).
 */
export interface FileTransferGatewayPort {
  /** S'abonne aux fichiers RÉCUPÉRÉS depuis une machine. Renvoie le désabonnement. */
  subscribeReceived(listener: (view: FileReceivedView) => void): () => void;
}

/**
 * Port des DISCUSSIONS (lot 18) — ce que le transport a besoin de savoir pour
 * traiter une conversation MIROIR (canal distant).
 *
 * ⚠️ Le transport ne parle JAMAIS à une plateforme : il ne connaît ni jeton, ni
 * URL, ni transport distant. Il demande au service de discussion le mode, le
 * motif de refus de création et les conversations miroir.
 */
export interface ChatGatewayPort {
  /**
   * Conversations miroir disponibles, TOUTES plateformes activées confondues.
   *
   * ⚠️ Plus de filtre par mode (2026-11-10) : un bot peut être joignable sur
   * Mattermost ET Discord en MÊME TEMPS, donc les canaux des deux doivent être
   * listés ensemble. Le LOCAL, lui, n'est pas ici : il est toujours listé, et
   * c'est exactement la régression que ce découplage corrige.
   */
  conversations(): readonly RemoteConversation[];
  /**
   * Motif LISIBLE du refus de créer une conversation locale, ou `null`.
   *
   * ⚠️ Toujours `null` depuis que le local n'est plus un mode qu'on peut
   * quitter (`ChatService.creationRefusal`), mais le transport garde ce point
   * d'autorité : c'est ici, pas dans le CSS, que `new` serait refusé.
   */
  creationRefusal(): string | null;
  /** Conversation miroir par identifiant Yuki (`mm-…`), ou `null` si inconnue. */
  conversation(conversationId: string): RemoteConversation | null;
  /** Messages d'une conversation miroir (ordre chronologique). */
  messages(conversationId: string): readonly RemoteMessage[];
  /**
   * Abonnement aux CHANGEMENTS du miroir (message reçu, canal découvert). Facultatif :
   * sans lui, la liste et le fil ne se rafraîchissent qu'à la demande du client.
   *
   * ⚠️ Aucun contenu ne circule ici : la notification dit SEULEMENT quelle conversation
   * a changé ; le transport relit le miroir et renvoie ce qu'il faut.
   */
  subscribe?(listener: (conversationId?: string) => void): (() => void) | undefined;
}

/**
 * Port des SOURCES exposé au transport. Découplé du domaine `sources` : le
 * transport ne connaît que ce contrat (aucun import du service).
 */
export interface SourcesGatewayPort {
  /** Noms des sources dont la destination effective est cette conversation. */
  sourcesForSession(sessionId: string): readonly string[];
  /**
   * ⚠️ Le fil est SUPPRIMÉ : les sources qui y postaient ne sont JAMAIS supprimées,
   * elles passent en « nouvelle conversation à chaque fois » — et une entrée
   * d'alerte le dit. Renvoie les noms réaffectés.
   */
  detachSession(sessionId: string): readonly string[];
}

interface ClientState {
  ws: WebSocket;
  /**
   * BOT auquel cette connexion est rattachée (lot 36, L4).
   *
   * ⚠️ `undefined` = bot PRINCIPAL : c'est l'état de toute connexion d'avant L4
   * (aucune trame ne portait de `botId`), donc le comportement historique est
   * conservé à l'identique.
   */
  botId?: string;
  /** Host résolu pour `botId` (jamais le principal par repli). */
  host?: PiHost;
  /** Session FOCALISÉE (cible des envois, de l'abort et des validations). */
  sessionId?: string;
  /**
   * Conversation MIROIR actuellement AFFICHÉE par ce client (`mm-…` / `dc-…`),
   * quand l'utilisateur regarde un canal distant.
   *
   * ⚠️ Le focus Pi (`sessionId`) n'est PAS touché : un miroir n'a pas de fichier
   * de session, donc aucune bascule d'hôte n'a lieu — c'est justement pour cela
   * que `handleSwitch` ne peut pas le servir. `undefined` = conversation locale.
   */
  focusedId?: string;
  /** Curseur de rejeu de la session FOCALISÉE (reconnexion). */
  lastSeq: number;
  greeted: boolean;
  /**
   * E2 — abonnements aux flux, PAR SESSION (multiplexage). Le client suit
   * TOUTES les conversations listées EN PLUS de la focalisée : chaque trame
   * arrive avec son `sessionId`, l'UI route vers le store du bon fil —
   * l'activité d'un fil d'arrière-plan reste ainsi VISIBLE sans changer de
   * conversation. `sessionId → désabonnement`.
   */
  subscriptions: Map<string, () => void>;
  /**
   * Présence DÉCLARÉE par le client (onglet visible / fenêtre focalisée).
   * ⚠️ Valeur initiale CONSERVATRICE (`false`/`false`) : tant que le client n'a
   * rien déclaré, on ne peut PAS affirmer qu'il regarde ⇒ une notification
   * reste possible. Le client envoie sa présence dès la connexion.
   */
  presence: { visible: boolean; focused: boolean };
  /**
   * Chaîne des messages EN COURS de traitement (préparation d'image comprise) :
   * garantit que deux messages d'un même onglet restent DANS L'ORDRE.
   */
  pendingMessage?: Promise<void>;
}

/** Aperçu de récapitulatif en attente de validation humaine. */
interface RecapPreview {
  recap: string;
  title: string;
  originSessionId: string;
  originTitle: string;
  subject?: string;
  fromAt?: string;
  messageCount: number;
  createdAt: number;
}

/** Convertit un transcript en messages de récapitulation (contenu seul). */
function recapSourceMessages(
  transcript: readonly TranscriptEntry[],
): RecapSourceMessage[] {
  const messages: RecapSourceMessage[] = [];
  for (const entry of transcript) {
    const text = entry.text ?? "";
    if (text.trim().length === 0) continue;
    messages.push({
      role: entry.role,
      text,
      ...(entry.timestamp !== undefined ? { timestamp: entry.timestamp } : {}),
    });
  }
  return messages;
}

/** Instant ISO du premier message horodaté, ou `undefined`. */
function firstTimestampIso(transcript: readonly TranscriptEntry[]): string | undefined {
  for (const entry of transcript) {
    if (entry.timestamp !== undefined && Number.isFinite(entry.timestamp)) {
      return new Date(entry.timestamp).toISOString();
    }
  }
  return undefined;
}

/** Traduit une erreur du domaine `recap` en couple (code, message honnête). */
function toRecapError(error: unknown): { code: string; message: string } {
  if (error instanceof RecapError) return { code: error.code, message: error.message };
  return {
    code: "recap_failed",
    message:
      "La génération du récapitulatif a échoué ; aucune conversation n'a été créée.",
  };
}

/** Traduit un événement de façade en trame serveur. */
export function toServerMessage(event: PiEvent): ServerMessage {
  switch (event.type) {
    case "run_started":
      return {
        type: "run_started",
        runId: event.runId,
        ...(event.userText !== undefined ? { userText: event.userText } : {}),
        ...(event.origin !== undefined ? { origin: event.origin } : {}),
        ...(event.jobId !== undefined ? { jobId: event.jobId } : {}),
      };
    case "delta":
      return {
        type: "delta",
        runId: event.runId,
        channel: event.channel,
        text: event.text,
      };
    case "run_finished":
      return {
        type: "run_finished",
        runId: event.runId,
        reason: event.reason,
        ...(event.usage ? { usage: event.usage } : {}),
        ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
        // Corrélation STABLE des réactions (identifiant d'entrée de session).
        ...(event.entryId !== undefined ? { entryId: event.entryId } : {}),
      };
    case "phase":
      return {
        type: "phase",
        runId: event.runId,
        stage: event.stage,
        at: event.at,
        sinceT0Ms: event.sinceT0Ms,
        ...(event.jobId !== undefined ? { jobId: event.jobId } : {}),
      };
    case "job_started":
      return {
        type: "job_started",
        jobId: event.jobId,
        ...(event.task !== undefined ? { task: event.task } : {}),
      };
    case "job_finished":
      return {
        type: "job_finished",
        jobId: event.jobId,
        status: event.status,
      };
    case "job_report":
      return {
        type: "job_report",
        jobId: event.jobId,
        ...(event.runId !== undefined ? { runId: event.runId } : {}),
      };
    case "job_activity":
      // E3 — activité d'un sous-agent : trame de CONTRÔLE dédiée (jamais
      // bufferisée, jamais envoyée à `routeTtsEvent`).
      return {
        type: "job_activity",
        jobId: event.jobId,
        stage: event.stage,
        ...(event.task !== undefined ? { task: event.task } : {}),
        ...(event.detail !== undefined ? { detail: event.detail } : {}),
        ...(event.status !== undefined ? { status: event.status } : {}),
        at: event.at,
      };
    case "ack":
      // ACCUSÉ DE RÉCEPTION : trame de CONTRÔLE (aucun `seq` consommé, jamais
      // bufferisée) ⇒ jamais dans le rejeu, le snapshot, le transcript ou la
      // mémoire, et JAMAIS prononcée (le TTS ne reçoit que les `delta` de contenu ;
      // le texte de l'accusé n'est jamais émis comme un delta).
      return {
        type: "ack",
        runId: event.runId,
        tool: event.tool,
        text: event.text,
        source: event.source,
      };
    case "run_summary":
      return {
        type: "run_summary",
        runId: event.runId,
        ...(event.ttftMs !== undefined ? { ttftMs: event.ttftMs } : {}),
        totalMs: event.totalMs,
        ...(event.tokensIn !== undefined ? { tokensIn: event.tokensIn } : {}),
        ...(event.tokensOut !== undefined ? { tokensOut: event.tokensOut } : {}),
        ...(event.ttfaMs !== undefined ? { ttfaMs: event.ttfaMs } : {}),
        ...(event.ttsSynthMs !== undefined ? { ttsSynthMs: event.ttsSynthMs } : {}),
        ...(event.ttsSegments !== undefined ? { ttsSegments: event.ttsSegments } : {}),
      };
    case "state":
      return {
        type: "state",
        state: event.state,
        ...(event.activeRunId ? { activeRunId: event.activeRunId } : {}),
      };
    default: {
      const exhaustive: never = event;
      throw new Error(`Événement Pi inconnu : ${String(exhaustive)}`);
    }
  }
}

/** Résultat d'exécution converti en trame éphémère pour la conversation. */
export function toApprovalResultFrame(
  approval: PendingApprovalView,
  outcome: ExecutionOutcome,
): ApprovalResultFrame {
  return {
    id: approval.id,
    agentId: outcome.agentId,
    ...(outcome.agentName ? { agentName: outcome.agentName } : {}),
    command: outcome.command,
    status: outcome.status,
    // « ok » = la commande a réellement été exécutée (statut terminal normal).
    ok: outcome.status === "completed",
    exitCode: outcome.exitCode,
    message: outcome.message,
    ...(outcome.framed ? { output: outcome.framed } : {}),
    ...(outcome.durationMs !== undefined ? { durationMs: outcome.durationMs } : {}),
    ...(outcome.truncated !== undefined ? { truncated: outcome.truncated } : {}),
    ...(outcome.timedOut !== undefined ? { timedOut: outcome.timedOut } : {}),
  };
}

/** Crée le transport WebSocket et l'abonne au PiHost. */
export function createWsTransport(options: WsTransportOptions): Transport {
  const { host, logger, serverVersion } = options;
  const bots = options.hosts;
  const streams = new SessionStreamStore({
    bufferSize: options.replayBufferSize,
    bufferBytes: options.replayBufferBytes,
    ...(options.now ? { now: options.now } : {}),
    // SNAPSHOT AUTORITATIF. Les RÉACTIONS sont fusionnées ICI (et nulle part
    // ailleurs) : le store est la source de vérité, le transcript n'en garde
    // aucune trace. Une réaction survit ainsi au RECHARGEMENT et à la
    // RECONNEXION, rattachée à l'`entryId` du message qu'elle vise.
    snapshotSource: (sessionId) => withReactions(sessionId, host.getState(sessionId)),
  });
  /**
   * LOT 36 (L4) — UN REGISTRE DE FLUX PAR BOT.
   *
   * ⚠️ `streams` (ci-dessus) reste celui du PRINCIPAL, avec exactement les mêmes
   * options qu'avant L4 : le flux du principal est le MÊME objet qu'avant
   * (identité `===`). Un bot supplémentaire a le sien, créé à sa première
   * demande. Deux bots qui porteraient le MÊME identifiant de session ne
   * partagent donc ni compteur `seq`, ni tampon de rejeu, ni snapshot : une
   * session de `kohai` n'est JAMAIS lisible depuis `yuki`.
   */
  const streamsParHost = new Map<PiHost, SessionStreamStore>();
  const clients = new Set<ClientState>();
  const approvals = options.approvals;
  const pins = options.pins;
  const agentPort = options.agents;
  const screenshots = options.screenshots;
  const imagesPort = options.images;
  const secretPort = options.secrets;
  const recap = options.recap;
  const reactions = options.reactions;
  const filesPort = options.files;
  const agentTransfers = options.agentTransfers;
  const sourcesPort = options.sources;
  const chatPort = options.chat;
  const timeZonePort = options.timeZone;

  /**
   * Fuseau EFFECTIF des horodatages, relu à CHAQUE usage (`apply: hot`).
   *
   * ⚠️ `UTC` par défaut : le fuseau du PROCESS n'est jamais consulté (un
   * conteneur peut être en UTC ou non), et le fuseau du NAVIGATEUR ne l'est plus
   * non plus (il rendait Yuki incohérente avec Mattermost).
   */
  function currentTimeZone(): string {
    const zone = timeZonePort?.current();
    return zone !== undefined && zone !== "" ? zone : DEFAULT_TIME_ZONE;
  }

  /**
   * État de session ENRICHI des réactions courantes (aucune copie inutile quand
   * il n'y en a pas). Utilisé UNIQUEMENT pour le snapshot : les trames de flux
   * (deltas, états) ne portent jamais de réaction.
   */
  function withReactions(
    sessionId: string,
    state: StreamStateProvider | undefined,
  ): StreamStateProvider | undefined {
    if (!state || !reactions) return state;
    const byEntry = reactions.forSession(sessionId);
    if (byEntry.size === 0) return state;
    return {
      ...state,
      transcript: state.transcript.map((entry) => {
        const reaction = entry.id ? byEntry.get(entry.id) : undefined;
        return reaction ? { ...entry, reaction } : entry;
      }),
    };
  }

  /**
   * Host qui répond aux trames de CE client.
   *
   * ⚠️ Aucun repli : `client.host` n'est posé QUE si le bot a été résolu avec
   * succès (`pourDemarre`), sinon la connexion a déjà reçu son erreur. Une
   * connexion sans `botId` rend le host du principal — objet IDENTIQUE à celui
   * d'avant L4.
   */
  function hostFor(client: ClientState): PiHost {
    return client.host ?? host;
  }

  /**
   * Host d'un bot DÉCLARÉ par un client, ou `undefined` s'il est inconnu/arrêté.
   *
   * ⚠️ C'est le SEUL chemin vers un host secondaire (`pourDemarre`), et il ne
   * rend jamais le principal en repli.
   */
  function hostPourBot(botId: string): PiHost | undefined {
    return bots?.pourDemarre(botId);
  }

  /**
   * Registre de flux du host donné (principal : celui d'avant L4, `===`).
   *
   * Le premier accès à un bot secondaire crée son registre (buffer, `seq`,
   * snapshots) et l'abonne à SON bus : sans cet abonnement, ses événements ne
   * seraient jamais bufferisés, donc jamais rejoués.
   */
  function storeForHost(target: PiHost): SessionStreamStore {
    if (target === host) return streams;
    const existing = streamsParHost.get(target);
    if (existing) return existing;
    const store = new SessionStreamStore({
      bufferSize: options.replayBufferSize,
      bufferBytes: options.replayBufferBytes,
      ...(options.now ? { now: options.now } : {}),
      snapshotSource: (sessionId) => withReactions(sessionId, target.getState(sessionId)),
    });
    streamsParHost.set(target, store);
    subscribeHost(target);
    return store;
  }

  /** Registre de flux du host qui sert ce client. */
  function storeFor(client: ClientState): SessionStreamStore {
    return storeForHost(hostFor(client));
  }

  /**
   * Host qui POSSÈDE une session (traces d'instrumentation du TTS).
   *
   * Un identifiant de session est unique dans une instance : on cherche le
   * registre qui le connaît, et on retombe sur le principal quand aucun ne le
   * connaît encore (session d'un bot jamais demandé).
   */
  function hostForSession(sessionId: string): PiHost {
    for (const [candidat, store] of streamsParHost) {
      if (store.has(sessionId)) return candidat;
    }
    return host;
  }

  /**
   * APERÇUS de récapitulatif en attente de validation humaine, indexés par
   * `requestId`. C'est la SOURCE DE VÉRITÉ du texte : `recap_create` ne
   * réutilise pas un texte arbitraire arrivé du client, il reprend l'aperçu
   * généré par le serveur (avec un éventuel texte corrigé fourni par l'humain).
   * Purge paresseuse (TTL) : un aperçu jamais validé disparaît.
   */
  const recapPreviews = new Map<string, RecapPreview>();
  const RECAP_PREVIEW_TTL_MS = 30 * 60_000;
  const RECAP_PREVIEW_MAX = 32;

  function pruneRecapPreviews(): void {
    const now = options.now?.() ?? Date.now();
    for (const [id, pending] of recapPreviews) {
      if (now - pending.createdAt > RECAP_PREVIEW_TTL_MS) recapPreviews.delete(id);
    }
    while (recapPreviews.size >= RECAP_PREVIEW_MAX) {
      const oldest = recapPreviews.keys().next().value;
      if (oldest === undefined) break;
      recapPreviews.delete(oldest);
    }
  }

  const runT0 = new Map<string, number>();
  /**
   * Abonnements aux bus des hosts, PAR HOST (lot 36, L4). Le principal y entre
   * dès la construction ; un bot secondaire à son premier usage. Un host
   * secondaire JAMAIS demandé ne consomme rien (aucun flux, aucun abonnement).
   */
  const unsubscribeParHost = new Map<PiHost, () => void>();

  /** Abonne (une seule fois) le bus d'un host au bufferissement des flux. */
  function subscribeHost(source: PiHost): void {
    if (unsubscribeParHost.has(source)) return;
    unsubscribeParHost.set(
      source,
      source.subscribeAll((event) => onHostEvent(source, event)),
    );
  }

  /**
   * UN événement d'un host : direction du flux (registre du BON bot) et TTS.
   *
   * ⚠️ `source` est le host ÉMETTEUR, jamais un host deviné : un delta de
   * `kohai` entre dans le registre de `kohai` (donc avec SON `seq`, SON rejeu
   * et SON snapshot) et ne peut pas atterrir dans celui de `yuki`.
   */
  function onHostEvent(source: PiHost, event: PiEvent): void {
    // ⚠️ E3 — L'ACTIVITÉ D'UN SOUS-AGENT est ÉPHÉMÈRE et MUETTE. Elle ne doit
    // NI entrer dans le flux bufferisé (rejeu/snapshot/transcript) NI atteindre
    // le moteur TTS. On la déroute AVANT `streams.append` et AVANT
    // `routeTtsEvent`, vers une trame de CONTRÔLE rattachée à la conversation
    // qui l'a lancée : c'est CE mécanisme (et lui seul) qui garantit le silence.
    if (event.type === "job_activity") {
      broadcastControl(event.sessionId, toServerMessage(event));
      return;
    }
    // ⚠️ RÉFLEXION du modèle (canal `thinking`) : ÉPHÉMÈRE et MUETTE, exactement
    // comme l'activité d'un sous-agent. On la déroute AVANT `streams.append`
    // (donc JAMAIS dans le rejeu ni dans un snapshot) et AVANT `routeTtsEvent`
    // (jamais prononcée), vers une trame de CONTRÔLE rattachée au fil concerné.
    if (event.type === "delta" && event.channel === "thinking") {
      broadcastControl(event.sessionId, toServerMessage(event));
      return;
    }
    // ⚠️ ACCUSÉ DE RÉCEPTION : ÉPHÉMÈRE et MUET, exactement comme la réflexion et
    // l'activité d'un sous-agent. On le déroute AVANT `streams.append` (donc jamais
    // dans le rejeu ni dans un snapshot) et AVANT `routeTtsEvent` (jamais
    // prononcé) : c'est une ligne de STATUT, pas une phrase de la réponse.
    if (event.type === "ack") {
      broadcastControl(event.sessionId, toServerMessage(event));
      return;
    }
    storeForHost(source).get(event.sessionId).append(toServerMessage(event));
    routeTtsEvent(source, event);
  }

  // Le principal est abonné dès la construction, comme avant L4.
  subscribeHost(host);

  let wss: WebSocketServer | undefined;
  let httpServer: Server | undefined;
  let closed = false;

  function sessionIdFor(client: ClientState): string | undefined {
    return client.sessionId ?? hostFor(client).currentSessionId();
  }

  /** Abonne le client au flux d'UNE session (idempotent). */
  function subscribeTo(client: ClientState, sessionId: string): void {
    if (client.subscriptions.has(sessionId)) return;
    const stream = storeFor(client).get(sessionId);
    client.subscriptions.set(
      sessionId,
      stream.subscribe((frame) => sendFrame(client, frame)),
    );
  }

  /** (Re)branche le client sur le flux de sa session FOCALISÉE (au moins elle). */
  function subscribeFocused(client: ClientState): void {
    const sessionId = sessionIdFor(client);
    if (sessionId) subscribeTo(client, sessionId);
  }

  /**
   * E2 — aligne les abonnements du client sur l'ensemble
   * « {sessions listées} ∪ {session focalisée} ». Chaque conversation de la
   * barre latérale devient un flux SUIVI : ses trames (état, jobs, deltas)
   * arrivent avec leur `sessionId` et sont routées vers le store du bon fil.
   * Les abonnements aux sessions disparues (mises de côté) sont retirés.
   */
  function syncSubscriptions(
    client: ClientState,
    listedSessionIds: string[],
  ): void {
    const wanted = new Set(listedSessionIds);
    if (client.sessionId) wanted.add(client.sessionId);
    for (const [sessionId, unsubscribe] of [...client.subscriptions]) {
      if (wanted.has(sessionId)) continue;
      unsubscribe();
      client.subscriptions.delete(sessionId);
    }
    for (const sessionId of wanted) subscribeTo(client, sessionId);
  }

  /**
   * E2 — resynchronise les abonnements depuis la liste des conversations SANS
   * envoyer de trame `sessions` (reconnexion `resume` : la trame de liste ne
   * doit pas perturber le curseur `seq` du rejeu).
   */
  async function syncSubscriptionsFromHost(client: ClientState): Promise<void> {
    let ids: string[] = [];
    try {
      ids = (await hostFor(client).listSessions()).map((info) => info.sessionId);
    } catch (error) {
      logger.warn("ws.subscriptions.list_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      subscribeFocused(client);
      return;
    }
    syncSubscriptions(client, ids);
  }

  function envelopeFor(client: ClientState, sessionId: string | undefined): ServerEnvelope {
    if (!sessionId) {
      return {
        seq: 0,
        ts: new Date().toISOString(),
        sessionId: "",
      };
    }
    return storeFor(client).get(sessionId).envelope();
  }

  function sendFrame(client: ClientState, frame: ServerFrame): void {
    if (client.ws.readyState !== WebSocket.OPEN) return;
    try {
      client.ws.send(JSON.stringify(frame));
    } catch (error) {
      logger.warn("ws.send.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Diffuse une trame binaire `YTA1` aux clients ABONNÉS à la session (§4.5). */
  function broadcastBinary(sessionId: string, frame: Buffer): void {
    for (const client of clients) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;
      // E2 : on identifie les destinataires par leur ABONNEMENT (multiplexage)
      // et non par la session focalisée. La SOURCE reste la seule session
      // FOCALISÉE du host (`routeTtsEvent`) : un fil d'arrière-plan ne produit
      // donc AUCUNE trame audio (pas de double voix).
      if (!client.subscriptions.has(sessionId)) continue;
      try {
        client.ws.send(frame, { binary: true });
      } catch (error) {
        logger.warn("ws.send.binary.failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const tts = options.tts
    ? new TtsPipeline(options.tts, {
        emitAudio: (sessionId, frame) => broadcastBinary(sessionId, frame),
        emitControl: (sessionId, frame) => broadcastBinary(sessionId, frame),
        onStage: (sessionId, runId, stage) => {
          // ⚠️ La trace d'instrumentation suit le host QUI POSSÈDE la session
          // (lot 36, L4) : `recordRunStage` d'un bot sur le run d'un autre ne
          // trouverait rien et laisserait le run sans état de phase.
          hostForSession(sessionId).recordRunStage?.(sessionId, runId, stage);
        },
        onMetrics: (sessionId, runId, metrics) => {
          hostForSession(sessionId).recordRunTtsMetrics?.(sessionId, runId, metrics);
        },
      })
    : undefined;

  /**
   * Achemine un événement Pi vers le pipeline TTS (hors chemin critique).
   * `t0` est reconstruit depuis le premier `phase` corrélé du run.
   *
   * ⚠️ `source` (lot 36, L4) est le host ÉMETTEUR : la conversation focalisée
   * qui « parle » est la SIENNE (celle de `kohai` n'est jamais comparée à celle
   * de `yuki`).
   */
  function routeTtsEvent(source: PiHost, event: PiEvent): void {
    if (!tts) return;
    // ⚠️ E0 : plusieurs conversations peuvent avoir un run EN VOL simultanément
    // (registre de sessions). La VOIX ne suit QUE la conversation FOCALISÉE :
    // les runs d'arrière-plan continuent d'émettre pour LEUR flux (rejeu au
    // retour) mais restent MUETS. Sans ce garde, deux runs simultanés
    // alimenteraient la TTS d'un fil avec la sortie d'un autre (double voix).
    if (event.sessionId !== source.currentSessionId()) return;
    switch (event.type) {
      case "phase":
        if (!runT0.has(event.runId)) {
          runT0.set(
            event.runId,
            (options.now?.() ?? Date.now()) - event.sinceT0Ms,
          );
        }
        return;
      case "run_started":
        // ⚠️ LOT 36 (L11) : le run parle avec la VOIX de SON bot. Le principal
        // reste `undefined` (donc configuration d'instance, à l'identique).
        tts.onRunStarted(
          event.sessionId,
          event.runId,
          runT0.get(event.runId),
          source === host ? undefined : bots?.botDe?.(source),
        );
        return;
      case "delta":
        if (event.channel === "content") {
          tts.onContent(event.sessionId, event.runId, event.text);
        }
        return;
      case "run_finished":
        tts.onRunFinished(event.sessionId, event.runId, event.reason);
        runT0.delete(event.runId);
        return;
      default:
        return;
    }
  }

  /**
   * E2 — le FOCUS change de conversation : la voix du fil quitté s'arrête.
   * Indispensable avec l'abonnement multiple : sinon les segments du fil
   * quitté, encore en file, seraient livrés (via `broadcastBinary` par
   * abonnement) alors que l'utilisateur regarde un AUTRE fil — double voix.
   */
  function cancelTtsOnFocusChange(
    client: ClientState,
    previousSessionId: string | undefined,
  ): void {
    if (!tts || !previousSessionId) return;
    if (previousSessionId === hostFor(client).currentSessionId()) return;
    tts.cancel(previousSessionId);
  }

  // ── Validations humaines dans la conversation (D118) ────────────────────
  // Le registre diffuse `requested`/`decided` ; on route vers les clients de
  // la SEULE conversation concernée. Les décisions prises AILLEURS (page
  // /config, route HTTP) font aussi disparaître le bloc ici, via `decided`.
  const unsubscribeApprovals = approvals?.subscribeApprovals((event) => {
    const sessionId = event.approval.sessionId;
    if (!sessionId) return;
    if (event.kind === "requested") {
      broadcastControl(sessionId, { type: "approval", approval: event.approval });
    } else {
      broadcastControl(sessionId, { type: "approval_cleared", id: event.approval.id });
    }
  });

  // ── Captures d'écran dans la conversation (image ÉPHÉMÈRE) ──────────────
  // L'image voyage par une trame de CONTRÔLE vers les clients de la SEULE
  // conversation demanderesse : aucun `seq` consommé, jamais bufferisée, donc
  // jamais dans le rejeu, le snapshot, le transcript ou la mémoire.
  const unsubscribeScreenshots = screenshots?.subscribeScreenshots((event) => {
    const sessionId = event.screenshot.sessionId;
    if (!sessionId) return;
    broadcastControl(sessionId, { type: "screenshot", screenshot: event.screenshot });
  });

  // ── Images GÉNÉRÉES par ComfyUI (trame de CONTRÔLE) ──────────────────────
  // Même régime que les captures : la trame va aux clients de la SEULE
  // conversation demandeuse, aucun `seq` consommé, donc jamais dans le rejeu, le
  // snapshot, le transcript ou la mémoire. ⚠️ Seul un chemin SAME-ORIGIN voyage
  // (`/images/<id>.<ext>`) : la CSP reste `img-src 'self'`.
  const unsubscribeImages = imagesPort?.subscribeImages((view) => {
    if (!view.sessionId) return;
    broadcastControl(view.sessionId, { type: "image", image: view });
  });

  // ── FICHE d'une image déjà affichée (prompt final du workflow) ──────────
  // ⚠️ Elle arrive APRÈS l'image : le client l'affiche SOUS l'image, sans la
  // déplacer. Trame de CONTRÔLE (aucun `seq`), jamais bufferisée, jamais
  // prononcée. Une fiche isolée est ignorée si la session n'est pas connue.
  const unsubscribeImageFinalPrompts = imagesPort?.subscribeImageFinalPrompts?.((view) => {
    if (!view.sessionId) return;
    broadcastControl(view.sessionId, {
      type: "image_final_prompt",
      id: view.id,
      finalPrompt: view.finalPrompt,
    });
  });

  // ── Fichiers ENVOYÉS par Yuki (trame de CONTRÔLE) ────────────────────────
  // La carte apparaît DANS LE FIL (cliquable, téléchargeable) chez les clients de
  // la SEULE conversation concernée : aucun `seq` consommé, jamais bufferisée.
  // ⚠️ Seules des métadonnées voyagent ; le contenu est servi par
  // `/fichiers/<id>.<ext>` (same-origin, `Content-Disposition` correct).
  const unsubscribeFiles = filesPort?.subscribeSent((view) => {
    const { sessionId, ...file } = view;
    if (!sessionId) return;
    broadcastControl(sessionId, { type: "file_sent", sessionId, file, from: "yuki" });
  });

  // ── Fichiers RÉCUPÉRÉS depuis une machine (trame de CONTRÔLE) ───────────
  // ⚠️ SIGNALEMENT indispensable : le fichier est sur le disque de Yuki, mais
  // l'utilisateur ne le sait pas sans cette carte. Aucun `seq` consommé, jamais
  // bufferisée. Aucun contenu : uniquement des métadonnées et le chemin
  // same-origin `/fichiers/<id>.<ext>` (CSP inchangée).
  const unsubscribeReceived = agentTransfers?.subscribeReceived((view) => {
    if (!view.sessionId) return;
    broadcastControl(view.sessionId, {
      type: "file_received",
      sessionId: view.sessionId,
      file: view.file,
      ...(view.agentName ? { agentName: view.agentName } : {}),
    });
  });

  // ── Demandes de SECRET dans la conversation (`awaiting_secret`) ─────────
  // Le registre diffuse `requested`/`cleared` ; on route vers les clients de la
  // SEULE conversation concernée. Trame de CONTRÔLE (aucun `seq`), jamais
  // bufferisée, donc jamais dans le rejeu, le snapshot, le transcript ou la
  // mémoire. ⚠️ Ne porte JAMAIS une valeur : seulement les NOMS à fournir.
  const unsubscribeSecrets = secretPort?.subscribeSecrets((event) => {
    const sessionId = event.request.sessionId;
    if (!sessionId) return;
    if (event.kind === "requested") {
      broadcastControl(sessionId, { type: "secret_request", request: event.request });
    } else {
      broadcastControl(sessionId, { type: "secret_cleared", id: event.request.id });
    }
  });

  // ── Encart agents de la barre latérale ─────────────────────────────────
  // Diffusion ÉVÉNEMENTIELLE : le registre change (aussi bien depuis /config que
  // depuis l'encart lui-même) et on pousse l'état à TOUS les clients. Aucun
  // polling : la page apprend les changements au fil de l'eau.
  const unsubscribeAgents = agentPort?.subscribe(() => {
    broadcastAgents();
  });

  /**
   * Diffuse l'état des agents (trame de CONTRÔLE, aucun `seq` consommé).
   *
   * ⚠️ LOT 40 — UNE TRAME PAR CLIENT : la visibilité dépend du bot DE LA
   * CONNEXION (une page = un bot), pas du bot du processus. Diffuser une trame
   * unique ferait voir à la page de `kohai` les agents de `yuki`.
   */
  function broadcastAgents(): void {
    if (!agentPort) return;
    for (const client of clients) sendDirect(client, agentsFrame(client));
  }

  /**
   * Contenu d'une trame `agents` pour UN client : la liste est filtrée par le
   * port sur le bot de ce client (validé au rattachement) ; le bot est joint
   * pour que l'interface applique la même règle. Une seule fabrique ⇒ jamais
   * une trame qui divergerait de l'autre.
   */
  function agentsFrame(client?: ClientState): {
    type: "agents";
    agents: WireAgent[];
    botActif?: string;
  } {
    // ⚠️ `client.botId` n'est renseigné QUE par `rattacherBot` (bot existant ET
    // démarré) : aucune valeur forgée par le navigateur n'arrive ici.
    const bot = client?.botId ?? agentPort?.botActif?.();
    return {
      type: "agents",
      agents: agentPort ? agentPort.list(bot) : [],
      ...(bot !== undefined ? { botActif: bot } : {}),
    };
  }

  /** Envoie l'état des agents au seul client (connexion / reprise). */
  function sendAgents(client: ClientState): void {
    if (!agentPort) return;
    sendDirect(client, agentsFrame(client));
  }

  /** Décision humaine (Valider / Refuser) reçue depuis la conversation. */
  async function handleApprovalDecision(
    client: ClientState,
    message: ClientMessage,
  ): Promise<void> {
    if (message.type !== "approval_decision") return;
    if (!approvals) {
      sendDirect(client, {
        type: "error",
        code: "approval_unavailable",
        message: "Les validations ne sont pas disponibles.",
      });
      return;
    }
    let result;
    try {
      result = await approvals.decideApproval(message.id, message.decision);
    } catch (error) {
      sendDirect(client, {
        type: "error",
        code: "approval_failed",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (!result.ok) {
      // Clic tardif (déjà décidée/expirée) : on retire le bloc devenu obsolète
      // puis on renvoie un message HONNÊTE, aucun mensonge.
      sendDirect(client, { type: "approval_cleared", id: message.id });
      sendDirect(client, {
        type: "error",
        code: result.code,
        message: result.message,
      });
      return;
    }
    const sessionId = result.approval.sessionId ?? sessionIdFor(client);
    if (!sessionId) return;
    // Idempotent : `decided` a pu déjà diffuser le retrait. On le refait pour le
    // chemin local (et pour un port sans diffusion d'événement).
    broadcastControl(sessionId, { type: "approval_cleared", id: result.approval.id });
    if (result.decision === "approve") {
      broadcastControl(sessionId, {
        type: "approval_result",
        result: toApprovalResultFrame(result.approval, result.outcome),
      });
    }
  }

  /** Fourniture d'un secret (fenêtre `awaiting_secret`) reçue depuis la conversation. */
  async function handleSecretSubmit(
    client: ClientState,
    message: ClientMessage,
  ): Promise<void> {
    if (message.type !== "secret_submit") return;
    // ⚠️ `message.values` porte les VALEURS : on ne les journalise JAMAIS.
    if (!secretPort) {
      sendDirect(client, {
        type: "error",
        code: "secret_unavailable",
        message: "La fourniture de secrets n'est pas disponible.",
      });
      return;
    }
    let result;
    try {
      result = await secretPort.submitSecret(message.id, message.values);
    } catch (error) {
      sendDirect(client, {
        type: "error",
        code: "secret_failed",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (!result.ok) {
      // Demande inconnue/expirée ou valeur refusée : on retire la fenêtre devenue
      // obsolète puis on renvoie un message HONNÊTE (jamais un mensonge).
      sendDirect(client, { type: "secret_cleared", id: message.id });
      sendDirect(client, { type: "error", code: result.code, message: result.message });
      return;
    }
    const sessionId = result.request.sessionId ?? sessionIdFor(client);
    if (!sessionId) return;
    broadcastControl(sessionId, { type: "secret_cleared", id: result.request.id });
    // Une demande DIRECTE (outil `demander_secret`) n'a AUCUNE commande à rejouer :
    // pas de résultat d'exécution à afficher — le modèle est réveillé à part.
    const outcome = result.outcome;
    if (!outcome) return;
    // Résultat de la commande REJOUÉE : affiché à l'humain via la MÊME trame de
    // résultat éphémère que les validations (déjà masquée à la source).
    broadcastControl(sessionId, {
      type: "approval_result",
      result: {
        id: result.request.id,
        agentId: outcome.agentId,
        ...(outcome.agentName ? { agentName: outcome.agentName } : {}),
        command: outcome.command,
        status: outcome.status,
        ok: outcome.status === "completed",
        exitCode: outcome.exitCode,
        message: outcome.message,
        ...(outcome.framed ? { output: outcome.framed } : {}),
        ...(outcome.durationMs !== undefined ? { durationMs: outcome.durationMs } : {}),
        ...(outcome.truncated !== undefined ? { truncated: outcome.truncated } : {}),
        ...(outcome.timedOut !== undefined ? { timedOut: outcome.timedOut } : {}),
      },
    });
  }

  /** Trame de contrôle : réutilise le `seq` courant sans le consommer. */
  function sendDirect(client: ClientState, message: ServerMessage): ServerFrame {
    const frame = {
      ...envelopeFor(client, sessionIdFor(client)),
      ...message,
    } as ServerFrame;
    sendFrame(client, frame);
    return frame;
  }

  /**
   * Trame de CONTRÔLE portant l'enveloppe d'UNE session donnée (et non celle de
   * la session focalisée du client). Ne consomme aucun `seq`.
   */
  function sendControl(
    client: ClientState,
    sessionId: string,
    message: ServerMessage,
  ): void {
    sendFrame(client, { ...envelopeFor(client, sessionId), ...message } as ServerFrame);
  }

  /**
   * Diffuse une trame de CONTRÔLE aux clients ABONNÉS à UNE session (jamais aux
   * autres). Sert aux états éphémères (validation humaine, capture d'écran) :
   * l'enveloppe porte l'identifiant de la session CONCERNÉE (l'UI sait de quel
   * fil vient la demande), ils ne consomment aucun `seq`, ne sont jamais
   * bufferisés et donc n'entrent NI dans le rejeu NI dans un snapshot.
   */
  function broadcastControl(sessionId: string, message: ServerMessage): void {
    for (const client of clients) {
      if (!client.subscriptions.has(sessionId)) continue;
      sendControl(client, sessionId, message);
    }
  }

  /**
   * Ré-affiche les demandes de validation EN ATTENTE de la conversation du
   * client (état VIVANT : reconnexion, bascule, création). Une demande décidée
   * ou expirée n'est plus dans le registre ⇒ elle ne réapparaît pas.
   */
  function sendPendingApprovals(client: ClientState): void {
    if (!approvals) return;
    // E2 : les demandes EN ATTENTE de TOUTES les conversations suivies sont
    // ré-affichées (chacune portant son `sessionId`) — l'UI indique de quel fil
    // vient chaque demande.
    const sessionIds = new Set(client.subscriptions.keys());
    if (client.sessionId) sessionIds.add(client.sessionId);
    for (const sessionId of sessionIds) {
      for (const approval of approvals.pendingApprovals(sessionId)) {
        sendControl(client, sessionId, { type: "approval", approval });
      }
    }
  }

  /**
   * Ré-affiche les demandes de SECRET en attente de la conversation du client
   * (état VIVANT : reconnexion, bascule, création). Une demande fournie ou
   * expirée n'est plus dans le registre ⇒ elle ne réapparaît pas. ⚠️ Les NOMS
   * seulement : jamais une valeur.
   */
  function sendPendingSecrets(client: ClientState): void {
    if (!secretPort) return;
    const sessionIds = new Set(client.subscriptions.keys());
    if (client.sessionId) sessionIds.add(client.sessionId);
    for (const sessionId of sessionIds) {
      for (const request of secretPort.pendingSecrets(sessionId)) {
        sendControl(client, sessionId, { type: "secret_request", request });
      }
    }
  }

  /**
   * Conversations MIROIR du mode courant (`sessions` distantes).
   *
   * ⚠️ Aucune n'existe au lot 1 (pas de synchronisation) : la liste est VIDE et
   * l'interface affiche son état vide explicite. La mécanique est là pour que le
   * lot 2 n'ait qu'à remplir le miroir.
   */
  /**
   * Conversations MIROIR (canaux distants) — TOUTES plateformes activées.
   *
   * ⚠️ Aucun filtre par plateforme ni par mode : la liste locale et les canaux
   * distants COEXISTENT (un bot joignable en local ET sur deux plateformes).
   */
  function mirrorSessions(): WireSession[] {
    if (!chatPort) return [];
    return chatPort
      .conversations()
      .map((conversation) => ({
        id: conversation.id,
        kind: "remote",
        platform: conversation.platform,
        // ⚠️ Lecture seule CÔTÉ INTERFACE WEB (on n'y crée rien, on n'y écrit
        // rien) — PAS « inerte » : `canRun` dit qu'elle répond.
        readOnly: conversation.readOnly,
        canRun: conversation.canRun,
        ...(conversation.replyMode ? { replyMode: conversation.replyMode } : {}),
        ...(conversation.replyStyle ? { replyStyle: conversation.replyStyle } : {}),
        ...(conversation.quoteAuthor ? { quoteAuthor: conversation.quoteAuthor } : {}),
        title: conversation.title,
        ...(conversation.updatedAt ? { updatedAt: conversation.updatedAt } : {}),
        messageCount: conversation.messageCount,
      }));
  }

  /** Liste des conversations + conversation active, envoyée au client. */
  async function sendSessions(client: ClientState): Promise<void> {
    // ⚠️ LOT 36 (L4) : la liste est celle du BOT DE CE CLIENT (principal quand
    // la connexion n'a déclaré aucun `botId`). Aucune conversation d'un autre bot
    // ne peut donc apparaître dans la barre latérale.
    const host = hostFor(client);
    let sessions: WireSession[] = [];
    let listed = false;
    // ⚠️ PLUS de « mode distant » : la liste contient TOUJOURS les conversations
    // locales, PLUS les canaux des plateformes activées. C'est le comportement
    // d'avant la régression (un bot joignable en local ET à distance).
    // Identifiants des sessions Pi : SEULES elles peuvent être « abonnées » (un
    // miroir n'a pas de flux). On les tient à part pour ne jamais créer un flux
    // sur un identifiant `mm-…`.
    let localIds: string[] = [];
    try {
      const list = await host.listSessions();
      sessions = list.map((info) => {
        // Sources qui postent dans CE fil : la modale de suppression les LISTE
        // (⚠️ aucune suppression silencieuse d'un fil qui reçoit des sources).
        const feeding = sourcesPort?.sourcesForSession(info.sessionId) ?? [];
        return {
          id: info.sessionId,
          kind: "local" as const,
          platform: "local" as const,
          // Une conversation locale : l'interface web y crée et y écrit, et elle
          // produit des runs. Aucun changement de comportement, seulement dit.
          readOnly: false,
          canRun: true,
          title: info.title ?? info.name ?? "Conversation sans titre",
          ...(info.updatedAt ? { updatedAt: info.updatedAt } : {}),
          messageCount: info.messageCount ?? 0,
          ...(info.firstMessage && info.firstMessage !== "(no messages)"
            ? { excerpt: info.firstMessage }
            : {}),
          ...(pins?.isPinned(info.sessionId) ? { pinned: true } : {}),
          ...(feeding.length > 0 ? { sources: [...feeding] } : {}),
        };
      });
      localIds = sessions.map((session) => session.id);
      // Épinglées d'abord, puis date décroissante (ordre autoritatif, poussé au
      // client : la barre latérale se contente de refléter cette liste). Les
      // canaux miroir suivent la même règle (ils n'ont pas d'épingle).
      sessions = orderSessions([...sessions, ...mirrorSessions()]);
      listed = true;
    } catch (error) {
      logger.warn("ws.sessions.list_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // E2 : la liste EST la source de vérité des conversations suivies ⇒ on y
    // aligne les abonnements (SESSIONS PI seulement). En cas d'échec de lecture,
    // on garde au moins la session focalisée (jamais zéro abonnement).
    if (listed) syncSubscriptions(client, localIds);
    else subscribeFocused(client);
    // Focus AFFICHÉ : le miroir sélectionné prime (il n'existe pas côté Pi).
    if (client.focusedId !== undefined && !sessions.some((s) => s.id === client.focusedId)) {
      // Le canal a disparu (ou le mode a changé) : on ne laisse pas un focus mort.
      client.focusedId = undefined;
    }
    sendDirect(client, {
      type: "sessions",
      sessions,
      // Le focus affiché : un canal sélectionné, sinon la conversation locale
      // courante (toujours disponible).
      activeId: client.focusedId ?? host.currentSessionId() ?? null,
    });
  }

  /**
   * Message `snapshot` sortant construit depuis le payload du flux.
   *
   * ⚠️ Les champs d'ÉTAT VIVANT (`awaitingFirstToken`, `jobs`) sont transmis
   * tels quels : le snapshot est la SEULE voie par laquelle l'interface peut
   * restaurer l'activité d'une conversation qu'elle rouvre (le transcript ne
   * porte ni l'attente d'un run, ni les jobs encore ouverts).
   */
  function snapshotMessage(snapshot: SnapshotPayload): ServerMessage {
    return {
      type: "snapshot",
      state: snapshot.state,
      ...(snapshot.activeRunId ? { activeRunId: snapshot.activeRunId } : {}),
      ...(snapshot.awaitingFirstToken === true ? { awaitingFirstToken: true } : {}),
      ...(snapshot.jobs && snapshot.jobs.length > 0 ? { jobs: snapshot.jobs } : {}),
      transcript: snapshot.transcript,
    };
  }

  /**
   * Snapshot autoritatif de la session courante du client. Sans session
   * courante (état « aucune conversation ouverte »), envoie un snapshot VIDE :
   * le client réinitialise son rendu, aucun message ne part dans le vide.
   */
  function sendSnapshotForCurrent(client: ClientState): void {
    const sessionId = sessionIdFor(client);
    // ⚠️ Plus de « snapshot vide en mode distant » : la conversation locale est
    // TOUJOURS servie. Un canal sélectionné, lui, a son snapshot synthétique par
    // `handleSelectRemote` (`sendMirrorSnapshot`).
    if (!sessionId) {
      sendDirect(client, { type: "snapshot", state: "idle", transcript: [] });
      return;
    }
    const snapshot = storeFor(client).get(sessionId).snapshot();
    const frame = sendDirect(client, snapshotMessage(snapshot));
    client.lastSeq = frame.seq;
    restoreMedia(client, sessionId);
  }

  /**
   * RESTAURE dans le fil les MÉDIAS CONSERVÉS de la conversation : images
   * générées par ComfyUI et captures de pages web du libraire.
   *
   * ⚠️ POURQUOI ICI : ces médias sont CONSERVÉS sur le disque de Yuki (même
   * rétention que les pièces jointes, même purge) mais leur place dans le fil est
   * un état VIVANT, comme l'attente d'un run ou les jobs encore ouverts — le
   * transcript n'en garde aucune trace. Le snapshot est donc la seule voie par
   * laquelle l'interface peut les retrouver après un RECHARGEMENT ou une bascule.
   *
   * Ce sont des trames de CONTRÔLE (aucun `seq` consommé, jamais bufferisées) :
   * elles suivent immédiatement le snapshot, dans l'ordre chronologique, et le
   * client les rend avec ses blocs habituels. Aucun élargissement de CSP : les
   * chemins sont same-origin (`/images/…`, `/captures/…`).
   */
  function restoreMedia(client: ClientState, sessionId: string): void {
    const items: Array<{ at: string; message: ServerMessage }> = [];
    let images: ComfyImageView[] = [];
    let captures: ScreenshotViewEvent[] = [];
    try {
      images = imagesPort?.imagesForSession?.(sessionId) ?? [];
    } catch (error) {
      logger.warn("ws.media.restore.failed", {
        session_id: sessionId,
        kind: "image",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      captures = screenshots?.capturesForSession?.(sessionId) ?? [];
    } catch (error) {
      logger.warn("ws.media.restore.failed", {
        session_id: sessionId,
        kind: "screenshot",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    for (const view of images) {
      items.push({ at: view.createdAt, message: { type: "image", image: view } });
    }
    for (const event of captures) {
      items.push({
        at: event.screenshot.capturedAt,
        message: { type: "screenshot", screenshot: event.screenshot },
      });
    }
    // Ordre CHRONOLOGIQUE toutes natures confondues : l'image d'il y a deux jours
    // ne doit pas passer après la capture d'aujourd'hui.
    items.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    for (const item of items) sendControl(client, sessionId, item.message);
  }

  /**
   * RÉSOUT le bot d'une trame de connexion (`hello`/`resume`) et le FIXE sur le
   * client.
   *
   * Trois règles, et il n'y en a pas d'autre :
   *  1. **`botId` absent** ⇒ principal : rien ne change par rapport à avant L4
   *     (`client.host` reste `undefined`, donc `hostFor(client) === host`).
   *  2. **`botId` connu ET démarré** ⇒ c'est SON host, et le registre de flux de
   *     ce bot est créé (son bus est abonné) à cet instant.
   *  3. **`botId` inconnu ou arrêté** ⇒ trame `error` qui NOMME le bot, et aucun
   *     service rendu : jamais de repli silencieux sur le principal (on parlerait
   *     à Yuki en croyant parler à kohai).
   *
   * @returns `false` quand la trame a été REFUSÉE (l'appelant s'arrête).
   */
  function rattacherBot(client: ClientState, botId: string | undefined): boolean {
    if (botId === undefined) return true;
    if (client.botId !== undefined && client.botId !== botId) {
      sendDirect(client, {
        type: "error",
        code: "bot_change_refuse",
        message:
          `Cette connexion suit déjà le bot « ${client.botId} » : ouvrez une ` +
          `nouvelle connexion pour parler à « ${botId} ».`,
      });
      return false;
    }
    const target = hostPourBot(botId);
    if (!target) {
      /**
       * ⚠️ LOT 37 — LE MESSAGE DIT LA VÉRITÉ UTILE : *arrêté* ou *inexistant*,
       * la LISTE réelle des bots connus, et LE GESTE qui répare (le sélecteur
       * de la barre du haut). Avant, « inconnu ou arrêté » laissait croire que
       * l'instance n'avait qu'un bot et aucun moyen d'en démarrer un autre.
       */
      const connus = bots?.ids?.();
      const liste = Array.isArray(connus) ? [...connus].sort() : [];
      const existe = liste.includes(botId);
      const noms = liste.length > 0 ? liste.join(", ") : "aucun bot lisible";
      sendDirect(client, {
        type: "error",
        code: "bot_inconnu",
        botId,
        existe,
        bots: liste,
        message: existe
          ? `Le bot « ${botId} » est ARRÊTÉ : aucun host ne peut lui répondre. ` +
            "Démarrez-le depuis la barre du haut (avatar → « Démarrer »), puis " +
            `rouvrez cette conversation. Bots connus : ${noms}.`
          : `Le bot « ${botId} » n'existe pas sur cette instance. Bots connus : ` +
            `${noms} — choisissez-en un dans la barre du haut (avatar).`,
      });
      logger.warn("ws.bot.refuse", { bot: botId, existe });
      return false;
    }
    client.botId = botId;
    client.host = target;
    // Le registre de flux du bot (et l'abonnement à SON bus) naît ici, à la
    // première connexion qui le demande.
    storeForHost(target);
    return true;
  }

  /**
   * Réponse de `welcome` : le bot qui répond, UNIQUEMENT quand le client en a
   * demandé un. Absent ⇒ trame strictement identique à celle d'avant L4.
   */
  function botDuWelcome(client: ClientState): { bot?: string } {
    return client.botId !== undefined ? { bot: client.botId } : {};
  }

  async function handleHello(client: ClientState, message: ClientMessage): Promise<void> {
    // ⚠️ `botId` est RÉSOLU avant tout le reste (`handleClientMessage`) : ici, le
    // host est celui du bot demandé, ou celui du principal si aucun ne l'a été.
    const host = hostFor(client);
    if (message.type !== "hello") return;
    const current = host.currentSessionId();
    const resumed = Boolean(
      message.sessionId && current && message.sessionId === current,
    );
    // ⚠️ TROU #1 CORRIGÉ : on n'impose plus un fil choisi par le client à la
    // connexion. `hello` renvoie l'ÉTAT AUTORITATIF (liste + active), et le
    // client adopte un autre fil par la trame dédiée `switch`.
    client.sessionId = current;
    client.greeted = true;
    // Connexion neuve : le focus affiché est celui de l'hôte (aucun miroir).
    client.focusedId = undefined;
    subscribeFocused(client);
    sendDirect(client, {
      type: "welcome",
      serverVersion,
      resumed,
      timeZone: currentTimeZone(),
      ...botDuWelcome(client),
    });
    await sendSessions(client);
    // État initial des agents (encart de la barre latérale), à la connexion.
    sendAgents(client);
    // État initial autoritatif : le client initialise son rendu depuis le snapshot.
    sendSnapshotForCurrent(client);
    // État VIVANT : les validations en attente de ce fil sont ré-affichées.
    sendPendingApprovals(client);
    sendPendingSecrets(client);
  }

  async function handleResume(client: ClientState, message: ClientMessage): Promise<void> {
    const host = hostFor(client);
    if (message.type !== "resume") return;
    const previousFocus = host.currentSessionId();
    const target = message.sessionId || host.currentSessionId();
    if (!target) {
      sendDirect(client, {
        type: "error",
        code: "session_inconnue",
        message: "Aucune conversation à reprendre.",
      });
      return;
    }
    // ⚠️ Rechargement pendant qu'on regardait un canal distant : `resume` vise un
    // miroir, qui n'a pas de session Pi. Sans cette branche, l'utilisateur
    // recevrait « Conversation introuvable » à chaque reconnexion.
    if (isMirrorConversationId(target)) {
      sendDirect(client, {
        type: "welcome",
        serverVersion,
        resumed: false,
        timeZone: currentTimeZone(),
        ...botDuWelcome(client),
      });
      await handleSelectRemote(client, target);
      sendAgents(client);
      return;
    }
    client.focusedId = undefined;
    // ⚠️ TROU #2 CORRIGÉ : la bascule doit RÉELLEMENT changer la session HÔTE
    // (`host.resume`), pas seulement l'abonnement au flux — sinon le 1er
    // message échouerait « Session inconnue ». On ne le fait que si la session
    // demandée n'est pas déjà la courante (reconnexion = no-op).
    let switched = false;
    if (host.currentSessionId() !== target) {
      const file = await host.sessionFileFor(target);
      if (!file) {
        sendDirect(client, {
          type: "error",
          code: "session_inconnue",
          message: "Conversation introuvable.",
        });
        return;
      }
      try {
        await host.resume(file);
        switched = true;
      } catch (error) {
        const piError = toPiHostError(error, { sessionId: target, logger });
        sendDirect(client, {
          type: "error",
          code: piError.code,
          message: piError.message,
        });
        return;
      }
    }
    client.sessionId = host.currentSessionId() ?? target;
    subscribeFocused(client);
    // La voix du fil quitté s'arrête (E2) : un seul fil parle.
    cancelTtsOnFocusChange(client, previousFocus);
    const stream = storeFor(client).get(client.sessionId);
    const result = stream.replay(message.fromSeq);
    sendDirect(client, {
      type: "welcome",
      serverVersion,
      resumed: true,
      replayFrom: message.fromSeq,
      timeZone: currentTimeZone(),
      ...botDuWelcome(client),
    });
    if (result.mode === "snapshot") {
      const frame = sendDirect(client, snapshotMessage(result.snapshot));
      client.lastSeq = frame.seq;
      restoreMedia(client, client.sessionId);
    } else {
      for (const frame of result.frames) {
        sendFrame(client, frame);
        client.lastSeq = frame.seq;
      }
    }
    // Uniquement si la session hôte a CHANGÉ : rafraîchit la barre latérale.
    if (switched) {
      await sendSessions(client);
    } else {
      // Reconnexion sur la même session : on resynchronise SILENCIEUSEMENT les
      // abonnements (toutes les conversations listées) sans envoyer de trame
      // `sessions` (elle ne doit pas troubler le curseur `seq` du rejeu).
      await syncSubscriptionsFromHost(client);
    }
    // Reconnexion : on RE-pousse l'état des agents (il a pu changer pendant la coupure).
    sendAgents(client);
    // Ré-affichage des validations en attente (état vivant, jamais l'historique).
    sendPendingApprovals(client);
    sendPendingSecrets(client);
  }

  /**
   * Sélection d'une conversation MIROIR (canal distant).
   *
   * ⚠️ Chemin SÉPARÉ de `handleSwitch` : un miroir n'a pas de fichier de session
   * Pi, donc `host.sessionFileFor` / `host.resume` ne s'appliquent pas. On ne
   * touche PAS au focus Pi (la conversation locale reste celle de l'hôte) ; on
   * ne fait que poser `client.focusedId` et servir un snapshot SYNTHÉTIQUE :
   * transcript du miroir, `state: "idle"`, `readOnly: true` (l'interface web n'y
   * compose pas — même si la conversation, elle, peut produire des runs).
   */
  async function handleSelectRemote(
    client: ClientState,
    conversationId: string,
  ): Promise<void> {
    const conversation = chatPort?.conversation(conversationId) ?? null;
    if (!conversation) {
      sendDirect(client, {
        type: "error",
        code: "session_inconnue",
        message:
          "Ce canal distant n'est pas (encore) synchronisé : aucun message à afficher.",
      });
      return;
    }
    client.focusedId = conversation.id;
    await sendSessions(client);
    sendMirrorSnapshot(client, conversation.id);
  }

  /**
   * Snapshot SYNTHÉTIQUE d'un canal miroir.
   *
   * ⚠️ Enveloppe construite à la main, portant l'identifiant du CANAL : la trame ne doit
   * surtout pas partir avec l'enveloppe d'une session Pi (le client routerait le
   * transcript du canal vers le store du mauvais fil). `readOnly: true` dit que
   * l'interface web n'y compose pas — un canal distant SE LIT, il ne s'écrit pas depuis
   * le navigateur (c'est la plateforme qui reçoit les messages).
   */
  function sendMirrorSnapshot(client: ClientState, conversationId: string): void {
    sendFrame(client, {
      seq: 0,
      ts: new Date().toISOString(),
      sessionId: conversationId,
      type: "snapshot",
      state: "idle",
      readOnly: true,
      transcript: chatPort?.messages(conversationId).map(remoteMessageToTranscript) ?? [],
    });
  }

  /**
   * Changement du MIROIR (message reçu, canal découvert, backfill terminé).
   *
   * ⚠️ On rafraîchit la LISTE de tous les clients (compteurs et canaux nouveaux) et le
   * FIL de ceux qui regardent précisément ce canal. Aucune notification hors sujet : un
   * client qui lit une conversation locale ne reçoit pas de trame de canal.
   */
  function onMirrorChange(conversationId?: string): void {
    for (const client of clients) {
      void sendSessions(client);
      if (conversationId !== undefined && client.focusedId === conversationId) {
        sendMirrorSnapshot(client, conversationId);
      }
    }
  }

  // Abonnement aux changements du miroir (facultatif : absent ⇒ comportement inchangé).
  const unsubscribeChat = chatPort?.subscribe?.((conversationId) =>
    onMirrorChange(conversationId),
  );

  /**
   * Refus EXPLICITE d'une écriture visant une conversation miroir.
   *
   * ⚠️ Ce n'est pas une règle d'interface : le serveur refuse, quoi que fasse le
   * client. Un miroir ne s'écrit pas depuis l'interface web (création,
   * renommage, épingle, mise de côté, suppression, compaction, réaction, envoi
   * de message).
   *
   * @returns `true` quand la trame d'erreur a été envoyée (l'appelant s'arrête).
   */
  function refuseMirrorWrite(client: ClientState, conversationId: string | undefined): boolean {
    if (!isMirrorConversationId(conversationId)) return false;
    sendDirect(client, {
      type: "error",
      code: "conversation_lecture_seule",
      message:
        "Cette conversation est un canal distant en lecture seule : elle ne " +
        "s'écrit pas depuis l'interface web.",
    });
    return true;
  }

  /** Bascule vers une autre conversation (abort du run en cours par construction). */
  async function handleSwitch(client: ClientState, message: ClientMessage): Promise<void> {
    const host = hostFor(client);
    if (message.type !== "switch") return;
    // Miroir (canal distant) : chemin dédié, focus Pi INTACT.
    if (isMirrorConversationId(message.sessionId)) {
      await handleSelectRemote(client, message.sessionId);
      return;
    }
    // Retour à une conversation locale : le focus affiché redevient celui de Pi.
    client.focusedId = undefined;
    const previousFocus = host.currentSessionId();
    const file = await host.sessionFileFor(message.sessionId);
    if (!file) {
      sendDirect(client, {
        type: "error",
        code: "session_inconnue",
        message: "Conversation introuvable.",
      });
      return;
    }
    try {
      await host.resume(file);
    } catch (error) {
      const piError = toPiHostError(error, {
        sessionId: message.sessionId,
        logger,
      });
      sendDirect(client, {
        type: "error",
        code: piError.code,
        message: piError.message,
      });
      return;
    }
    client.sessionId = host.currentSessionId() ?? message.sessionId;
    subscribeFocused(client);
    // E2 : la voix du fil quitté s'arrête net (jamais de double voix).
    cancelTtsOnFocusChange(client, previousFocus);
    await sendSessions(client);
    // ⚠️ Un `snapshot` à CHAQUE bascule : le client reconstruit TOUT son rendu
    // depuis le transcript du nouveau fil → aucun doublon possible.
    sendSnapshotForCurrent(client);
    sendPendingApprovals(client);
    sendPendingSecrets(client);
  }

  /**
   * Crée une nouvelle conversation et la rend active.
   *
   * ⚠️ En mode DISTANT, la création est REFUSÉE ici aussi (pas seulement
   * désactivée en CSS) : la liste des conversations vient de la plateforme.
   */
  async function handleNew(client: ClientState): Promise<void> {
    const host = hostFor(client);
    const refusal = chatPort?.creationRefusal() ?? null;
    if (refusal !== null) {
      sendDirect(client, {
        type: "error",
        code: "creation_desactivee",
        message: refusal,
      });
      return;
    }
    client.focusedId = undefined;
    const previousFocus = host.currentSessionId();
    try {
      await host.newSession();
    } catch (error) {
      const piError = toPiHostError(error, { logger });
      sendDirect(client, {
        type: "error",
        code: piError.code,
        message: piError.message,
      });
      return;
    }
    client.sessionId = host.currentSessionId();
    subscribeFocused(client);
    cancelTtsOnFocusChange(client, previousFocus);
    await sendSessions(client);
    sendSnapshotForCurrent(client);
    sendPendingApprovals(client);
    sendPendingSecrets(client);
  }

  /** Renomme une conversation (doublons refusés côté hôte). */
  async function handleRename(client: ClientState, message: ClientMessage): Promise<void> {
    const host = hostFor(client);
    if (message.type !== "rename") return;
    if (refuseMirrorWrite(client, message.sessionId)) return;
    try {
      await host.renameSession(message.sessionId, message.title);
    } catch (error) {
      const piError = toPiHostError(error, {
        sessionId: message.sessionId,
        logger,
      });
      sendDirect(client, {
        type: "error",
        code: piError.code,
        message: piError.message,
      });
      return;
    }
    await sendSessions(client);
  }

  /** Met une conversation de côté (déplacement horodaté, récupérable). */
  async function handleSetAside(client: ClientState, message: ClientMessage): Promise<void> {
    const host = hostFor(client);
    if (message.type !== "setAside") return;
    if (refuseMirrorWrite(client, message.sessionId)) return;
    const wasCurrent = host.currentSessionId() === message.sessionId;
    try {
      await host.setAsideSession(message.sessionId);
    } catch (error) {
      const piError = toPiHostError(error, {
        sessionId: message.sessionId,
        logger,
      });
      sendDirect(client, {
        type: "error",
        code: piError.code,
        message: piError.message,
      });
      return;
    }
    // Mono-utilisateur : on suit la suppression côté client. Si la conversation
    // supprimée était la conversation OUVERTE, le client retombe sur l'état vide.
    if (wasCurrent) {
      client.sessionId = undefined;
      // La voix du fil supprimé s'arrête (E2).
      cancelTtsOnFocusChange(client, message.sessionId);
    }
    // Nettoyage de l'épingle orpheline : la conversation mise de côté disparaît
    // de la liste, son éventuel épinglage n'a plus de sens.
    pins?.remove(message.sessionId);
    // E2 : `sendSessions` resynchronise les abonnements ⇒ le flux de la
    // conversation retirée est désabonné automatiquement.
    await sendSessions(client);
    if (wasCurrent) {
      // Snapshot VIDE : le rendu du fil est réinitialisé, plus rien à l'écran.
      sendDirect(client, { type: "snapshot", state: "idle", transcript: [] });
    }
  }

  /**
   * SUPPRESSION DÉFINITIVE d'une conversation de la liste (menu du titre).
   *
   * ⚠️ La MÉMOIRE DURABLE n'est PAS touchée : aucune écriture, aucun souvenir
   * supprimé. Le serveur n'appelle rien d'autre que la suppression du fil.
   * ⚠️ Épingle orpheline retirée, abonnements resynchronisés, voix arrêtée :
   * mêmes nettoyages que la mise de côté (aucun state fantôme).
   */
  async function handleDelete(client: ClientState, message: ClientMessage): Promise<void> {
    const host = hostFor(client);
    if (message.type !== "delete") return;
    if (refuseMirrorWrite(client, message.sessionId)) return;
    const wasCurrent = host.currentSessionId() === message.sessionId;
    try {
      await host.deleteSession(message.sessionId);
    } catch (error) {
      const piError = toPiHostError(error, {
        sessionId: message.sessionId,
        logger,
      });
      sendDirect(client, {
        type: "error",
        code: piError.code,
        message: piError.message,
      });
      return;
    }
    if (wasCurrent) {
      client.sessionId = undefined;
      cancelTtsOnFocusChange(client, message.sessionId);
    }
    pins?.remove(message.sessionId);
    // ⚠️ ③ AUCUNE SUPPRESSION SILENCIEUSE : si des sources postaient dans ce fil,
    // elles ne sont PAS supprimées — elles passent en « nouvelle conversation à
    // chaque fois », et une entrée d'alerte le dit dans la boîte.
    const detached = sourcesPort?.detachSession(message.sessionId) ?? [];
    if (detached.length > 0) {
      logger.info("ws.session.delete.sources_detached", {
        session_id: message.sessionId,
        sources: detached.length,
      });
    }
    await sendSessions(client);
    if (wasCurrent) {
      // Conversation supprimée = plus rien à l'écran (état vide, pas une erreur).
      sendDirect(client, { type: "snapshot", state: "idle", transcript: [] });
    }
  }

  /**
   * COMPACTION FORCÉE d'une conversation : PASSE DE MÉMOIRE **puis** compaction.
   *
   * ⚠️ L'ordre et la réalité du résultat viennent du host (`compactSession`),
   * pas d'une reconstitution côté interface. On ne fait que RELAYER :
   *  - des trames de CONTRÔLE `compact_progress` pour que l'attente soit visible
   *    (aucun `seq` consommé, jamais bufferisées) ;
   *  - une trame `compact_done` qui DIT ce qui s'est passé ;
   *  - une trame `error` corrélée (`requestId`) en cas d'échec — jamais un
   *    succès fabriqué.
   */
  async function handleCompact(client: ClientState, message: ClientMessage): Promise<void> {
    const host = hostFor(client);
    if (message.type !== "compact") return;
    if (refuseMirrorWrite(client, message.sessionId)) return;
    const title = await titleFor(client, message.sessionId);
    try {
      const outcome = await host.compactSession(message.sessionId, {
        onProgress: (progress) => {
          sendDirect(client, {
            type: "compact_progress",
            requestId: message.requestId,
            phase: progress.phase,
            ...(progress.part !== undefined ? { part: progress.part } : {}),
            ...(progress.parts !== undefined ? { parts: progress.parts } : {}),
          });
        },
      });
      // MessageCount / updatedAt peuvent avoir bougé (arrêt d'un run, entrée de
      // compaction écrite) : on resynchronise la liste avant de conclure.
      await sendSessions(client);
      sendDirect(client, {
        type: "compact_done",
        requestId: message.requestId,
        memory: outcome.memory,
        tokensBefore: outcome.tokensBefore,
        ...(outcome.tokensAfter !== undefined ? { tokensAfter: outcome.tokensAfter } : {}),
        title,
      });
    } catch (error) {
      const piError = toPiHostError(error, {
        sessionId: message.sessionId,
        logger,
      });
      logger.warn("ws.compact.failed", {
        session_id: message.sessionId,
        code: piError.code,
      });
      sendDirect(client, {
        type: "error",
        code: piError.code,
        message: piError.message,
        requestId: message.requestId,
      });
      // Un run a pu être arrêté : l'interface doit refléter l'état RÉEL.
      await sendSessions(client);
    }
  }

  /**
   * Épingle / désépingle une conversation (action du menu contextuel). L'état
   * n'est PAS écrit dans le JSONL de session (propriété du SDK) : il vit dans le
   * store d'épingles, puis la liste est renvoyée avec son nouvel état.
   */
  async function handlePin(client: ClientState, message: ClientMessage): Promise<void> {
    if (message.type !== "pin") return;
    if (refuseMirrorWrite(client, message.sessionId)) return;
    pins?.setPinned(message.sessionId, message.pinned);
    await sendSessions(client);
  }

  /**
   * « Continuer dans une conversation dédiée » — ÉTAPE 1 : produit un APERÇU de
   * récapitulatif EXHAUSTIF axé sur le SUJET donné, sans RIEN créer ni modifier.
   *
   * ⚠️ MÉCANIQUE CHOISIE : appel LLM ISOLÉ (session éphémère en mémoire) nourri
   * avec le transcript de la conversation. On n'exécute AUCUN tour dans la
   * session d'origine ⇒ son transcript, son historique et son éventuel run EN
   * COURS ne sont jamais touchés. C'est pourquoi un run en cours n'empêche PAS
   * l'action : l'aperçu porte sur ce qui est DÉJÀ écrit (le tour en cours peut
   * n'être que partiel — c'est un instantané honnête, jamais une invention).
   */
  async function handleRecapPreview(
    client: ClientState,
    message: ClientMessage,
  ): Promise<void> {
    const host = hostFor(client);
    if (message.type !== "recap_preview") return;
    const fail = (code: string, text: string): void => {
      sendDirect(client, { type: "error", code, message: text, requestId: message.requestId });
    };
    if (!recap) {
      fail(
        "recap_unavailable",
        "Le récapitulatif n'est pas disponible (aucun modèle de récapitulation configuré).",
      );
      return;
    }
    const state = host.getState(message.sessionId);
    if (!state) {
      fail("recap_not_found", "Conversation introuvable.");
      return;
    }
    const messages = recapSourceMessages(state.transcript);
    if (messages.length === 0) {
      fail("recap_empty", "Cette conversation est vide : il n'y a rien à récapituler.");
      return;
    }
    const originTitle = await titleFor(client, message.sessionId);
    const subject = normalizeSubject(message.subject);
    const fromAt = firstTimestampIso(state.transcript);
    try {
      const result = await recap({
        originSessionId: message.sessionId,
        originTitle,
        ...(subject.length > 0 ? { subject } : {}),
        fromIndex: 0,
        wholeThread: true,
        messages,
        // Progression VISIBLE : un fil découpé = plusieurs appels modèle, donc
        // plusieurs minutes d'attente. On signale la partie en cours par une
        // trame de CONTRÔLE (jamais bufferisée), sans créer un 2ᵉ système.
        onProgress: (progress) => {
          if (progress.parts <= 1) return;
          sendDirect(client, {
            type: "recap_progress",
            requestId: message.requestId,
            part: progress.part,
            parts: progress.parts,
          });
        },
      });
      pruneRecapPreviews();
      recapPreviews.set(message.requestId, {
        recap: result.recap,
        title: result.title,
        originSessionId: message.sessionId,
        originTitle,
        ...(subject.length > 0 ? { subject } : {}),
        ...(fromAt !== undefined ? { fromAt } : {}),
        messageCount: result.messageCount,
        createdAt: options.now?.() ?? Date.now(),
      });
      sendDirect(client, {
        type: "recap_ready",
        requestId: message.requestId,
        title: result.title,
        recap: result.recap,
        originTitle,
        originSessionId: message.sessionId,
        ...(subject.length > 0 ? { subject } : {}),
        messageCount: result.messageCount,
        parts: result.parts,
      });
    } catch (error) {
      const recapError = toRecapError(error);
      logger.warn("ws.recap.preview_failed", {
        session_id: message.sessionId,
        code: recapError.code,
        has_subject: subject.length > 0,
      });
      fail(recapError.code, recapError.message);
    }
  }

  /**
   * ÉTAPE 2 : l'humain a VALIDÉ l'aperçu (titre/texte éventuellement corrigés) ⇒
   * on crée la conversation dédiée et on y injecte le récapitulatif comme PROMPT
   * SYNTHÉTIQUE (origine `recap`) : le modèle le VOIT, il n'est ni attribué à
   * l'utilisateur, ni prononcé par la TTS, ni mémorisé, et il est bien visible
   * dans le fil (bloc `recap`).
   *
   * ⚠️ TOUT OU RIEN : si la création ou l'injection échoue, la conversation
   * ébauchée est RETIRÉE (mise de côté) et le focus est rendu à l'origine.
   */
  async function handleRecapCreate(
    client: ClientState,
    message: ClientMessage,
  ): Promise<void> {
    const host = hostFor(client);
    if (message.type !== "recap_create") return;
    const fail = (code: string, text: string): void => {
      sendDirect(client, { type: "error", code, message: text, requestId: message.requestId });
    };
    pruneRecapPreviews();
    const pending = recapPreviews.get(message.requestId);
    if (!pending) {
      fail(
        "recap_not_found",
        "Cet aperçu de récapitulatif a expiré ou n'existe plus. Relancez l'opération.",
      );
      return;
    }
    const title = message.title.replace(/\s+/g, " ").trim();
    if (title.length === 0) {
      fail("recap_invalid_title", "Le titre de la nouvelle conversation ne peut pas être vide.");
      return;
    }
    // Le texte repris est celui de l'APERÇU serveur, éventuellement corrigé par
    // l'humain : jamais un texte arbitraire venu d'ailleurs.
    const recapText = (message.recap ?? pending.recap).trim();
    if (recapText.length === 0) {
      fail("recap_empty", "Le récapitulatif est vide : aucune conversation n'a été créée.");
      return;
    }
    const previousFocus = host.currentSessionId();
    let created: SessionState;
    try {
      created = await host.newSession();
    } catch (error) {
      const piError = toPiHostError(error, { logger });
      fail(piError.code, piError.message);
      return;
    }
    const newSessionId = created.sessionId;
    client.sessionId = newSessionId;
    subscribeFocused(client);
    cancelTtsOnFocusChange(client, previousFocus);
    try {
      await host.renameSession(newSessionId, title);
      host.send(
        newSessionId,
        frameRecapPrompt({
          originTitle: pending.originTitle,
          originSessionId: pending.originSessionId,
          ...(pending.subject ? { subject: pending.subject } : {}),
          ...(pending.fromAt ? { fromAt: pending.fromAt } : {}),
          wholeThread: true,
          recap: recapText,
        }),
        { origin: ORIGIN_RECAP },
      );
    } catch (error) {
      // ⚠️ ÉCHEC APRÈS CRÉATION : on ne laisse JAMAIS une conversation à moitié
      // faite. On la retire (mise de côté), on rend le focus à l'origine.
      logger.warn("ws.recap.create_failed", {
        session_id: newSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      await host.setAsideSession(newSessionId).catch(() => undefined);
      pins?.remove(newSessionId);
      // ⚠️ La session courante du host vient d'être retirée : on RÉTABLIT le
      // focus sur la conversation d'origine (sinon la TTS et les envois
      // seraient rattachés à une session disparue).
      if (previousFocus) {
        const file = await host
          .sessionFileFor(previousFocus)
          .catch(() => undefined);
        if (file) {
          await host.resume(file).catch(() => undefined);
        }
      }
      client.sessionId = host.currentSessionId() ?? previousFocus;
      subscribeFocused(client);
      const piError = toPiHostError(error, { logger });
      fail(
        piError.code,
        "La conversation dédiée n'a pas pu être créée (échec de l'injection du " +
          "récapitulatif) : rien n'a été conservé.",
      );
      return;
    }
    recapPreviews.delete(message.requestId);
    await sendSessions(client);
    // Le récapitulatif est déjà dans le transcript (`role: "recap"`) : le
    // snapshot le restitue, donc le modèle le voit et l'humain le relit.
    sendSnapshotForCurrent(client);
    sendPendingApprovals(client);
    sendPendingSecrets(client);
    // Clôture le cycle côté client : le déclencheur redevient disponible.
    sendDirect(client, { type: "recap_created", requestId: message.requestId });
  }

  /** Titre PRÊT À L'EMPLOI d'une conversation (jamais vide). */
  async function titleFor(client: ClientState, sessionId: string): Promise<string> {
    try {
      const list = await hostFor(client).listSessions();
      const found = list.find((info) => info.sessionId === sessionId);
      return found?.title ?? found?.name ?? "conversation d'origine";
    } catch {
      return "conversation d'origine";
    }
  }

  /**
   * Bascule on/off d'un agent depuis l'encart de la barre latérale. Le NIVEAU
   * existant est réutilisé (`disabled` ⇄ précédent) : aucun second drapeau.
   */
  function handleAgentEnabled(client: ClientState, message: ClientMessage): void {
    if (message.type !== "agent_enabled") return;
    if (!agentPort) {
      sendDirect(client, {
        type: "error",
        code: "agents_unavailable",
        message: "Les agents ne sont pas disponibles.",
      });
      return;
    }
    try {
      agentPort.setEnabled(message.agentId, message.enabled);
      // Le store notifie ses abonnés → diffusion de la trame `agents` à tous.
    } catch (error) {
      sendDirect(client, {
        type: "error",
        code: "agent_unknown",
        message: error instanceof Error ? error.message : "Agent inconnu.",
      });
    }
  }

  /**
   * Règle le niveau de confirmation d'un agent depuis le menu contextuel de
   * l'encart de la barre latérale. ⚠️ Pas un second état : `disabled` = off.
   */
  function handleAgentLevel(client: ClientState, message: ClientMessage): void {
    if (message.type !== "agent_level") return;
    if (!agentPort) {
      sendDirect(client, {
        type: "error",
        code: "agents_unavailable",
        message: "Les agents ne sont pas disponibles.",
      });
      return;
    }
    try {
      agentPort.setLevel(message.agentId, message.level);
      // Le store notifie ses abonnés → diffusion de la trame `agents` à tous.
    } catch (error) {
      sendDirect(client, {
        type: "error",
        code: "agent_unknown",
        message: error instanceof Error ? error.message : "Agent inconnu.",
      });
    }
  }

  /**
   * RÉACTION sur un message de Yuki — CE N'EST PAS UN MESSAGE.
   *
   * Ce qu'on fait : persister la réaction (store À PART), puis la rediffuser en
   * trame de CONTRÔLE aux clients abonnés à CE fil (aucun `seq` consommé, rien
   * dans le rejeu : le snapshot la restitue).
   *
   * ⚠️ Ce qu'on ne fait JAMAIS : aucun `host.send` (donc AUCUN tour, aucun
   * `run_started`), aucun passage à `routeTtsEvent` (donc JAMAIS prononcée), et
   * aucune écriture dans le JSONL de session ni dans la mémoire (une réaction
   * isolée n'est pas un souvenir — voir `src/reactions/store.ts`).
   */
  function handleReaction(client: ClientState, message: ClientMessage): void {
    if (message.type !== "reaction") return;
    if (refuseMirrorWrite(client, message.sessionId)) return;
    if (!reactions) {
      sendDirect(client, {
        type: "error",
        code: "reactions_unavailable",
        message: "Les réactions ne sont pas disponibles.",
      });
      return;
    }
    // ⚠️ La conversation vient du MESSAGE (jamais d'un repli silencieux sur le fil
    // focalisé) : une réaction reste attachée à la conversation du message visé.
    const sessionId = message.sessionId;
    if (message.reaction === null) {
      // Retrait idempotent : retirer une réaction absente n'est pas une erreur
      // (double clic, ouverture dans deux onglets).
      reactions.clear(sessionId, message.entryId);
    } else {
      if (!isReactionId(message.reaction)) {
        sendDirect(client, {
          type: "error",
          code: "reaction_unknown",
          message: "Cette réaction n'existe pas.",
        });
        return;
      }
      reactions.set(sessionId, message.entryId, message.reaction);
    }
    // Diffusion à TOUS les onglets de cette conversation (le geste est fait une
    // fois, l'affichage suit partout).
    broadcastControl(sessionId, {
      type: "reaction",
      sessionId,
      entryId: message.entryId,
      reaction: message.reaction,
    });
  }

  async function handleMessage(client: ClientState, message: ClientMessage): Promise<void> {
    const host = hostFor(client);
    if (message.type !== "message") return;
    // ⚠️ L'interface affiche un CANAL DISTANT : on n'écrit pas dedans (le focus Pi
    // pointerait sur une autre conversation, la réponse partirait au mauvais
    // endroit — d'où un refus explicite, jamais un envoi silencieux).
    if (refuseMirrorWrite(client, client.focusedId)) return;
    const sessionId = sessionIdFor(client);
    if (!sessionId) {
      sendDirect(client, {
        type: "error",
        code: "PI_NOT_READY",
        message: "Aucune session Pi disponible.",
      });
      return;
    }
    subscribeFocused(client);
    // ── Fichiers joints ────────────────────────────────────────────────
    // Le serveur est AUTORITAIRE : il rattache les fichiers à CETTE conversation,
    // insère leurs marqueurs (cartes cliquables) dans le message et ajoute le
    // bloc `<fichiers>` — DONNÉE bornée — destiné au modèle. Le client ne peut
    // donc pas faire passer un fichier d'une autre conversation ni composer
    // lui-même le bloc transmis au modèle.
    let text = message.text;
    /**
     * IMAGES du message, prêtes pour le modèle (`ImageContent` : base64 + type
     * MIME). ⚠️ Construites ICI, côté serveur, à partir des seuls IDENTIFIANTS
     * reçus : le client ne transmet jamais d'octets d'image (il ne peut donc pas
     * faire passer le contenu d'une autre conversation).
     */
    let images: FileImageContent[] | undefined;
    if (message.files !== undefined && message.files.length > 0) {
      if (!filesPort) {
        sendDirect(client, {
          type: "error",
          code: "files_unavailable",
          message: "Les fichiers ne sont pas disponibles : le message n'a pas été envoyé.",
        });
        return;
      }
      const outcome = filesPort.attach(sessionId, message.files);
      if (outcome.files.length === 0) {
        sendDirect(client, {
          type: "error",
          code: "files_unavailable",
          message:
            "Aucun des fichiers joints n'est disponible (inconnu, expiré ou " +
            "trop nombreux) : le message n'a pas été envoyé.",
        });
        return;
      }
      if (outcome.missing.length > 0) {
        // ⚠️ Jamais silencieux : le message part, mais l'utilisateur APPREND que
        // des fichiers n'ont pas suivi.
        sendDirect(client, {
          type: "error",
          code: "files_partially_attached",
          message:
            `${outcome.missing.length} fichier(s) joint(s) n'ont pas pu être ajoutés ` +
            "(inconnu, expiré, ou nombre maximal atteint). Les autres ont bien été transmis.",
        });
      }
      // ⚠️ IMAGES : un fichier de genre `image` part en pièce jointe du message
      // (« le modèle voit l'image »), réduite À LA VOLÉE si elle dépasse les
      // bornes de vision (côté max 2 000 px, poids `files.imageMaxBytes`).
      // La version réduite est ÉPHÉMÈRE : l'original stocké n'est pas touché.
      // Si la réduction échoue (ou rendrait le texte illisible), le message est
      // REFUSÉ et RIEN n'est envoyé : jamais de troncature silencieuse.
      //
      // ⚠️ CAPACITÉ VISION : si le modèle de conversation est DÉCLARÉ sans vision
      // (`llm.light.vision` = « non »), l'image ne serait pas vue (le SDK la
      // remplacerait par « (tool image omitted…) ») : on REFUSE le message et on
      // dit quoi activer — jamais une image « envoyée » qui n'arrive nulle part.
      const attachedImages = outcome.files.filter((file) => file.kind === "image");
      if (attachedImages.length > 0 && options.vision !== undefined) {
        if (!options.vision.conversationReceivesImages()) {
          sendDirect(client, {
            type: "error",
            code: "file_image_vision_disabled",
            message:
              "Le modèle de conversation est déclaré SANS vision : l'image n'est " +
              "pas envoyée et le message n'a pas été expédié. Activez « Reçoit les " +
              "images (vision) » pour ce modèle dans /config (onglet « Modèles »), " +
              "ou retirez l'image du message.",
          });
          return;
        }
      }
      const preparedImages = await filesPort.prepareImages(outcome.files);
      if (!preparedImages.ok) {
        sendDirect(client, {
          type: "error",
          code: preparedImages.code,
          message: preparedImages.message,
        });
        return;
      }
      if (preparedImages.images.length > 0) images = preparedImages.images;
      const parts = [text.trim(), ...outcome.markers].filter((part) => part.length > 0);
      text = parts.join("\n\n");
      if (outcome.block !== undefined) text = `${text}\n\n${outcome.block}`;
    }
    let handle;
    try {
      // ⚠️ FUSEAU DU PRÉFIXE STOCKÉ (réglage `ui.timeZone`, défaut `UTC`) : plus
      // jamais celui du navigateur (`message.tz`, toléré et ignoré). Mattermost
      // est en UTC ; trois fuseaux pour un même message rendaient la corrélation
      // impossible.
      handle = host.send(
        sessionId,
        text,
        {
          timezone: currentTimeZone(),
          ...(images !== undefined ? { images } : {}),
        },
      );
    } catch (error) {
      const piError = toPiHostError(error, { sessionId, logger });
      sendDirect(client, {
        type: "error",
        code: piError.code,
        message: piError.message,
      });
      return;
    }
    storeFor(client).get(handle.sessionId).append({
      type: "accepted",
      clientMsgId: message.clientMsgId,
      runId: handle.runId,
      queued: handle.queued,
    });
  }

  async function handleClientMessage(client: ClientState, text: string): Promise<void> {
    const parsed = parseClientMessage(text);
    if (!parsed.ok) {
      sendDirect(client, {
        type: "error",
        code: "bad_request",
        message: parsed.error,
      });
      return;
    }
    const message = parsed.message;
    // ⚠️ LOT 36 (L4) — LE BOT SE RÉSOUT AVANT TOUT TRAITEMENT : les trames de
    // connexion (`hello`, `resume`) sont les seules à porter `botId`. Une trame
    // sans `botId` (tout client d'avant L4) reste servie par le principal, à
    // l'identique.
    if (message.type === "hello" || message.type === "resume") {
      if (!rattacherBot(client, message.botId)) return;
    }
    switch (message.type) {
      case "hello":
        await handleHello(client, message);
        return;
      case "resume":
        await handleResume(client, message);
        return;
      case "switch":
        await handleSwitch(client, message);
        return;
      case "new":
        await handleNew(client);
        return;
      case "rename":
        await handleRename(client, message);
        return;
      case "setAside":
        await handleSetAside(client, message);
        return;
      case "delete":
        await handleDelete(client, message);
        return;
      case "compact":
        await handleCompact(client, message);
        return;
      case "pin":
        await handlePin(client, message);
        return;
      case "reaction":
        handleReaction(client, message);
        return;
      case "recap_preview":
        await handleRecapPreview(client, message);
        return;
      case "recap_create":
        await handleRecapCreate(client, message);
        return;
      case "agent_enabled":
        handleAgentEnabled(client, message);
        return;
      case "agent_level":
        handleAgentLevel(client, message);
        return;
      case "presence":
        // Présence déclarée : alimente la décision anti-spam des notifications.
        // Aucune trame de réponse (silencieux, idempotent).
        client.presence.visible = message.visible;
        client.presence.focused = message.focused;
        return;
      case "approval_decision":
        await handleApprovalDecision(client, message);
        return;
      case "secret_submit":
        await handleSecretSubmit(client, message);
        return;
      case "message": {
        // ⚠️ SÉRIALISATION PAR CLIENT : préparer une image peut demander une
        // RÉDUCTION à la volée (quelques centaines de ms à quelques secondes).
        // Sans cette chaîne, un message suivant SANS image doublerait le
        // précédent et le modèle verrait les deux messages dans le désordre.
        const previous = client.pendingMessage ?? Promise.resolve();
        const next = previous.then(() => handleMessage(client, message));
        client.pendingMessage = next.catch((error: unknown) => {
          logger.warn("ws.message.failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
        return;
      }
      case "abort": {
        // ⚠️ L'abort s'adresse au host DU BOT DE CE CLIENT : arrêter le run d'un
        // bot sur l'host d'un autre ne trouverait rien (et ne dirait rien).
        const host = hostFor(client);
        if (!client.greeted) client.sessionId = host.currentSessionId();
        tts?.cancel(
          client.sessionId ?? host.currentSessionId() ?? "",
          message.runId,
        );
        void host
          .abort(client.sessionId ?? host.currentSessionId() ?? "", message.runId)
          .catch((error: unknown) => {
            logger.warn("ws.abort.failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          });
        return;
      }
      case "playback": {
        const host = hostFor(client);
        const sessionId = client.sessionId ?? host.currentSessionId();
        if (sessionId) {
          host.recordRunStage?.(
            sessionId,
            message.runId,
            message.event === "started"
              ? PHASE.playbackStarted
              : PHASE.playbackAborted,
          );
        }
        return;
      }
      case "chat_refresh":
        // Rafraîchissement de la LISTE après un changement de mode (le mode est
        // écrit par `PUT /api/config`, hors de ce canal) : le serveur reste
        // autoritaire sur ce que chaque mode contient.
        await sendSessions(client);
        return;
      case "ping":
        sendDirect(client, { type: "pong", t: message.t });
        return;
      default: {
        const exhaustive: never = message;
        logger.warn("ws.message.unhandled", { type: String(exhaustive) });
      }
    }
  }

  /**
   * Bot visé par l'URL d'upgrade (`/ws?bot=<id>`), et son host.
   *
   * ⚠️ Champ ABSENT ⇒ principal (comportement d'avant L4). Présent ⇒ `pourDemarre`
   * décide : un bot inconnu ou arrêté n'obtient AUCUNE connexion, et l'upgrade est
   * refusé en le nommant (jamais une session muette qui tombe sur le principal).
   */
  function resoudreBotDeRequete(request: IncomingMessage): {
    botId?: string;
    host?: PiHost;
    refuse?: boolean;
  } {
    const brut = new URL(request.url ?? "/", "http://localhost").searchParams.get("bot");
    if (brut === null) return {};
    const botId = brut.trim();
    if (botId.length === 0) return { refuse: true };
    const target = hostPourBot(botId);
    if (!target) {
      logger.warn("ws.bot.refuse", { bot: botId, source: "upgrade" });
      return { botId, refuse: true };
    }
    return { botId, host: target };
  }

  function onConnection(ws: WebSocket, request?: IncomingMessage): void {
    // ⚠️ Le bot vient de l'URL quand elle le nomme (`?bot=`) : la connexion est
    // rattachée AVANT la première trame, donc même un client qui n'enverrait
    // jamais `botId` ne parle pas au principal par surprise.
    const vise = request ? resoudreBotDeRequete(request) : {};
    const client: ClientState = {
      ws,
      lastSeq: 0,
      greeted: false,
      subscriptions: new Map(),
      presence: { visible: false, focused: false },
      ...(vise.botId !== undefined ? { botId: vise.botId } : {}),
      ...(vise.host !== undefined ? { host: vise.host } : {}),
    };
    if (vise.host !== undefined) storeForHost(vise.host);
    clients.add(client);
    logger.debug("ws.client.connected", {
      clients: clients.size,
      ...(client.botId !== undefined ? { bot: client.botId } : {}),
    });

    ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (isBinary) {
        // Trames binaires réservées à l'audio (lots 6/7) : ignorées proprement.
        logger.warn("ws.binary.ignored", { clients: clients.size });
        return;
      }
      const text = Array.isArray(data) ? Buffer.concat(data).toString("utf8") : data.toString();
      void handleClientMessage(client, text).catch((error: unknown) => {
        logger.warn("ws.message.handler_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
    ws.on("close", () => {
      // E2 : on retire TOUS les abonnements du client (multiplexage).
      for (const unsubscribe of client.subscriptions.values()) unsubscribe();
      client.subscriptions.clear();
      clients.delete(client);
      logger.debug("ws.client.closed", { clients: clients.size });
    });
    ws.on("error", (error: Error) => {
      logger.warn("ws.client.error", { error: error.message });
    });
  }

  function onUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname !== WS_PATH) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    // ⚠️ LOT 36 (L4) — `?bot=<id>` : le bot visé, décidé AVANT la poignée de main.
    // Un bot inconnu ou arrêté REFUSE la connexion (404) : le client apprend
    // immédiatement qu'il n'y a personne, plutôt que de parler au principal.
    const vise = resoudreBotDeRequete(request);
    if (vise.refuse === true) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss?.handleUpgrade(request, socket, head, (ws) => {
      wss?.emit("connection", ws, request);
    });
  }

  return {
    protocol: "ws",

    attach(server: Server): void {
      if (wss) return;
      httpServer = server;
      wss = new WebSocketServer({ noServer: true });
      wss.on("connection", (ws: WebSocket, request: IncomingMessage) =>
        onConnection(ws, request),
      );
      server.on("upgrade", onUpgrade);
    },

    clientCount(): number {
      return clients.size;
    },

    /**
     * Diffuse le nouveau FUSEAU des horodatages à TOUS les clients connectés.
     *
     * ⚠️ Trame de CONTRÔLE (`time_zone`) : aucun `seq` consommé, jamais
     * bufferisée, donc absente du rejeu et des snapshots. L'interface réaffiche
     * immédiatement heures et séparateurs de jour avec le nouveau fuseau.
     */
    notifyTimeZone(timeZone: string): void {
      for (const client of clients) {
        if (client.ws.readyState !== WebSocket.OPEN) continue;
        sendDirect(client, { type: "time_zone", timeZone });
      }
    },

    presenceView(): PresenceView[] {
      const views: PresenceView[] = [];
      for (const client of clients) {
        if (client.ws.readyState !== WebSocket.OPEN) continue;
        views.push({
          sessionId: client.sessionId ?? null,
          visible: client.presence.visible,
          focused: client.presence.focused,
        });
      }
      return views;
    },

    stats(): TransportStats {
      return {
        clients: clients.size,
        replayBufferSize: streams.bufferSize,
        replayBufferBytes: streams.bufferBytes,
      };
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      // ⚠️ TOUS les bus abonnés (principal ET bots servis) sont rendus : un host
      // secondaire laissé abonné retiendrait le transport après l'arrêt.
      for (const unsubscribe of unsubscribeParHost.values()) unsubscribe();
      unsubscribeParHost.clear();
      unsubscribeApprovals?.();
      unsubscribeSecrets?.();
      unsubscribeAgents?.();
      unsubscribeChat?.();
      unsubscribeScreenshots?.();
      unsubscribeImages?.();
      unsubscribeImageFinalPrompts?.();
      unsubscribeFiles?.();
      unsubscribeReceived?.();
      tts?.cancelAll();
      if (httpServer) {
        httpServer.off("upgrade", onUpgrade);
        httpServer = undefined;
      }
      for (const client of clients) {
        for (const unsubscribe of client.subscriptions.values()) unsubscribe();
        client.subscriptions.clear();
        sendDirect(client, { type: "bye", reason: "server_shutdown" });
        try {
          client.ws.close(1001, "server_shutdown");
        } catch {
          client.ws.terminate();
        }
      }
      const server = wss;
      wss = undefined;
      if (server) {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }
      clients.clear();
    },
  };
}
