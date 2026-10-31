/**
 * TRANSFERT DE FICHIERS vers/depuis une MACHINE appairée (`src/agents/transfer.ts`).
 *
 * Deux sens, une seule mécanique :
 *   - **récupérer** (machine → Yuki) : `file_get` puis une suite de `file_chunk`
 *     que l'on réassemble en vérifiant l'empreinte SHA-256 du fichier COMPLET ;
 *   - **déposer** (Yuki → machine) : `file_put` puis une suite de
 *     `file_put_chunk`, l'agent écrivant atomiquement (`<path>.part` + `fsync` +
 *     `rename`) et renvoyant un `file_result`.
 *
 * ⚠️ RÈGLES NON NÉGOCIABLES
 *
 *  1. **Capacité `files` avant toute émission.** Un agent antérieur IGNORE une
 *     trame inconnue sans jamais répondre (`agent/internal/transport/client.go`) :
 *     émettre d'abord, c'est attendre à l'infini. L'agent est donc REFUSÉ AVANT
 *     le premier octet, avec un message actionnable (« ton agent est TROP
 *     ANCIEN »).
 *  2. **Aucun succès partiel.** Une empreinte fausse est un échec
 *     (`digest_mismatch`) et ce qui a été écrit est SUPPRIMÉ. Une coupure est une
 *     interruption (`interrupted`) — reprise UNE SEULE fois à la reconnexion,
 *     jamais un fichier tronqué présenté comme complet.
 *  3. **Chemin ABSOLU obligatoire** des deux côtés : un chemin relatif dépendrait
 *     du répertoire de travail du processus (non maîtrisé).
 *  4. **Jamais d'écrasement** sans demande explicite (`ecraser: true`) : la
 *     destination existante fait l'objet d'un `conflict` explicite.
 *  5. **Plafond par transfert** (`files.agentMaxBytes`, défaut 256 Mio) : au-delà,
 *     refus AVANT écriture, avec le conseil d'utiliser `run_command`. Le
 *     transfert ne doit jamais bloquer le tour du modèle des minutes durant.
 *  6. **Aucune donnée journalisée.** Audit et journaux ne portent que des
 *     métadonnées (agent, chemin, taille, empreinte) — JAMAIS un contenu.
 *
 * Les trois bornes (`files.agentMaxBytes`, `files.agentChunkBytes`,
 * `files.agentTimeoutMs`) sont relues à CHAQUE transfert : un changement dans
 * `/config` s'applique sans redémarrage.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";

import type { AuditLog } from "./audit.js";
import type { AgentHub } from "./connection.js";
import { AgentChannelError, isChannelError } from "./errors.js";
import type { AgentStore } from "./store.js";
import type { FileSaveInput, FilesPort, WireFile } from "../files/types.js";
import { DEFAULT_FILE_CHUNK_BYTES, type OutboundFilePutChunk } from "./protocol.js";

/** Capacité qu'un agent doit déclarer pour que le transfert soit possible. */
export const FILES_CAPABILITY = "files";

/**
 * Commande SYNTHÉTIQUE sous laquelle un transfert est enregistré dans le
 * registre de validation (même mécanisme que la capture d'écran : aucun second
 * système de validation).
 */
export const FILE_GET_COMMAND = "récupérer un fichier";
export const FILE_PUT_COMMAND = "déposer un fichier";

/** Origines marquant une validation de transfert (dans `PendingApproval.origin`). */
export const FILES_GET_ORIGIN = "recuperer_fichier";
export const FILES_PUT_ORIGIN = "deposer_fichier";

/** Plafond par défaut d'un transfert (256 Mio). */
export const DEFAULT_AGENT_MAX_BYTES = 256 * 1024 * 1024;

/** Délai par défaut d'un transfert (ms). */
export const DEFAULT_AGENT_TIMEOUT_MS = 120_000;

/** Journal minimal (compatible avec le logger de Yuki). */
export interface TransferLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** Statut terminal d'un transfert. */
export type TransferStatus =
  | "completed"
  | "refused"
  | "offline"
  | "unsupported"
  | "too_large"
  | "digest_mismatch"
  | "interrupted"
  | "not_found"
  | "conflict"
  | "io_error"
  | "timeout"
  | "awaiting_validation";

/** Demande de RÉCUPÉRATION d'un fichier distant (machine → Yuki). */
export interface FileGetRequest {
  agentId: string;
  /** Chemin ABSOLU du fichier sur la machine. */
  path: string;
  sessionId?: string;
  origin?: string;
}

/** Demande de DÉPÔT d'un fichier local (Yuki → machine). */
export interface FilePutRequest {
  agentId: string;
  /**
   * Source : identifiant d'un fichier DÉJÀ stocké par Yuki (`/fichiers/<id>`).
   * Un chemin local sur le disque de Yuki n'est PAS accepté (le modèle n'a aucun
   * accès disque) — seul un fichier de la conversation est déposable.
   */
  fileId: string;
  /** Chemin ABSOLU de destination sur la machine. */
  path: string;
  /** `true` autorise le remplacement d'un fichier existant à destination. */
  ecraser?: boolean;
  sessionId?: string;
  origin?: string;
}

/**
 * Résultat d'un transfert rendu au MODÈLE.
 *
 * ⚠️ Il PÈSE et le DIT : taille et empreinte sont toujours présentes en cas de
 * succès — le modèle ne peut pas ignorer qu'il vient de manipuler 200 Mo.
 */
export interface TransferOutcome {
  status: TransferStatus;
  agentId: string;
  agentName?: string;
  direction: "get" | "put";
  /** Chemin distant concerné. */
  path: string;
  /** Métadonnées du fichier STOCKÉ par Yuki (récupération réussie). */
  file?: WireFile;
  bytes?: number;
  sha256?: string;
  message: string;
  approvalId?: string;
}

/** Événement diffusé à l'interface quand UN fichier a été RÉCUPÉRÉ sur disque. */
export interface FileReceivedView {
  agentId: string;
  agentName?: string;
  sessionId?: string;
  file: WireFile;
}

/** Port consommé par les outils du modèle (`recuperer_fichier`, `deposer_fichier`). */
export interface TransferServicePort {
  get(request: FileGetRequest): Promise<TransferOutcome>;
  put(request: FilePutRequest): Promise<TransferOutcome>;
}

/** État d'un transfert dans le registre persistant (`transfers.json`). */
interface TransferRecord {
  id: string;
  direction: "get" | "put";
  agentId: string;
  path: string;
  /** Octets reçus (récupération) ou déjà envoyés (dépôt). */
  bytes: number;
  /** Empreinte partielle (préfixe reçu) en hexadécimal. */
  partialSha256?: string;
  state: "in_progress" | "interrupted" | "completed";
  /** Identifiant du fichier de Yuki concerné (récupération). */
  storeId?: string;
  /** Tentatives de reprise déjà consommées (⚠️ UNE seule reprise). */
  resumes: number;
  createdAt: string;
  updatedAt: string;
}

/** Bornes relues à chaque transfert. */
export interface TransferLimits {
  maxBytes: () => number;
  chunkBytes: () => number;
  timeoutMs: () => number;
}

export interface TransferServiceOptions {
  store: AgentStore;
  hub: AgentHub;
  audit: AuditLog;
  logger: TransferLogger;
  /** Stockage des fichiers de Yuki (destination d'une récupération). */
  files: FilesPort;
  limits: TransferLimits;
  /**
   * Chemin du registre persistant (`transfers.json`). Absent ⇒ registre en
   * mémoire seulement (tests) : la reprise après REDÉMARRAGE n'est alors pas
   * couverte, mais la reprise après COUPURE de connexion l'est.
   */
  registryPath?: string;
  idFactory?: () => string;
  now?: () => number;
  /**
   * Garde-fou par agent (D118) — le MÊME que pour toute action. Absent ⇒ aucune
   * validation n'est demandée (tests).
   */
  authorize?: (request: {
    agentId: string;
    command: string;
    origin: string;
    sessionId?: string;
  }) => { kind: "proceed" } | { kind: "refuse"; message: string } | { kind: "awaiting"; approvalId: string };
}

let transferSeq = 0;

function defaultTransferId(): string {
  transferSeq += 1;
  return `trf-${Date.now().toString(36)}-${transferSeq.toString(36)}`;
}

/** Empreinte SHA-256 hexadécimale (minuscule) d'octets. */
export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** `true` si `value` est un chemin ABSOLU (aucune ambiguïté de plateforme). */
export function isAbsolutePath(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "") return false;
  // ⚠️ `isAbsolute` (node:path) ne reconnaît que le style de la PLATEFORME. On
  // accepte en plus les chemins Windows (`C:\…` ou `\\serveur\…`), car l'agent
  // peut tourner sous Windows alors que Yuki tourne sous Linux.
  return isAbsolute(trimmed) || /^[a-zA-Z]:[\\/]/.test(trimmed) || /^\\\\/.test(trimmed);
}

/** Taille lisible (français) — le message du modèle ne dit jamais « 209715200 ». */
export function humanSize(bytes: number): string {
  const n = Number.isFinite(bytes) ? Math.max(0, Math.trunc(bytes)) : 0;
  if (n < 1024) return `${n} octets`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} Ko`;
  if (n < 1024 * 1024 * 1024) return `${Math.round(n / (1024 * 1024))} Mo`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} Go`;
}

/** Message ACTIONNABLE pour un agent sans la capacité `files`. */
export function filesUnsupportedMessage(agentName: string | undefined): string {
  const machine = agentName ? `« ${agentName} »` : "cet agent";
  return (
    `Transfert refusé : ${machine} n'a pas déclaré la capacité « files ». ` +
    "Ton agent est TROP ANCIEN : mets-le à jour sur la machine " +
    "(`yuki-agent version` puis mise à jour du binaire, cf. docs/runbook.md §12.4), " +
    "puis réessaie. ⚠️ AUCUNE trame n'a été émise : sans cette capacité, l'agent " +
    "ignorerait silencieusement la demande et le transfert resterait bloqué."
  );
}

/** Message disant d'utiliser `run_command` au-delà du plafond. */
export function tooLargeMessage(bytes: number, limit: number): string {
  return (
    `Transfert refusé : le fichier pèse ${humanSize(bytes)}, au-delà du plafond ` +
    `de ${humanSize(limit)} par transfert. Un transfert de cette taille bloquerait ` +
    "le tour du modèle plusieurs minutes. Pour un fichier plus gros, utilise " +
    "`run_command` sur la machine (`scp`, `rsync`, `tar`…) : le transfert de " +
    "fichiers est prévu pour les fichiers raisonnables, pas pour les gros volumes."
  );
}

/** Transfert refusé avant toute émission (chemin, capacité, plafond, garde-fou). */
class TransferRefusal extends Error {
  readonly status: TransferStatus;
  readonly code?: string;
  constructor(status: TransferStatus, message: string, code?: string) {
    super(message);
    this.status = status;
    if (code !== undefined) this.code = code;
  }
}

export class AgentFileTransferService implements TransferServicePort {
  private readonly store: AgentStore;
  private readonly hub: AgentHub;
  private readonly audit: AuditLog;
  private readonly logger: TransferLogger;
  private readonly files: FilesPort;
  private readonly limits: TransferLimits;
  private readonly registryPath?: string;
  private readonly idFactory: () => string;
  private readonly now: () => number;
  private readonly authorizeFn?: TransferServiceOptions["authorize"];
  /** Registre persistant en mémoire (miroir de `transfers.json`). */
  private registry: Map<string, TransferRecord>;
  /** Abonnés aux fichiers RÉCUPÉRÉS (trame de contrôle `file_received`). */
  private readonly receivedListeners = new Set<(view: FileReceivedView) => void>();

  constructor(options: TransferServiceOptions) {
    this.store = options.store;
    this.hub = options.hub;
    this.audit = options.audit;
    this.logger = options.logger;
    this.files = options.files;
    this.limits = options.limits;
    this.registryPath = options.registryPath;
    this.idFactory = options.idFactory ?? defaultTransferId;
    this.now = options.now ?? Date.now;
    this.authorizeFn = options.authorize;
    this.registry = this.loadRegistry();
    // ⚠️ Au DÉMARRAGE, tout transfert resté `in_progress` est marqué
    // `interrupted` : un redémarrage du gateway au milieu d'un transfert ne doit
    // jamais laisser croire qu'il continue (piège ⑤).
    for (const record of this.registry.values()) {
      if (record.state === "in_progress") {
        record.state = "interrupted";
        record.updatedAt = new Date(this.now()).toISOString();
      }
    }
    this.persist();
  }

  /** S'abonne aux fichiers récupérés (interface). Renvoie le désabonnement. */
  subscribeReceived(listener: (view: FileReceivedView) => void): () => void {
    this.receivedListeners.add(listener);
    return () => {
      this.receivedListeners.delete(listener);
    };
  }

  private emitReceived(view: FileReceivedView): void {
    for (const listener of this.receivedListeners) {
      try {
        listener(view);
      } catch (error) {
        this.logger.warn("agents.transfer.listener_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // ── Registre persistant ──────────────────────────────────────────────────

  private loadRegistry(): Map<string, TransferRecord> {
    const map = new Map<string, TransferRecord>();
    if (!this.registryPath || !existsSync(this.registryPath)) return map;
    try {
      const parsed = JSON.parse(readFileSync(this.registryPath, "utf8")) as unknown;
      if (!Array.isArray(parsed)) return map;
      for (const entry of parsed) {
        if (!entry || typeof entry !== "object") continue;
        const record = entry as Partial<TransferRecord>;
        if (
          typeof record.id !== "string" ||
          (record.direction !== "get" && record.direction !== "put") ||
          typeof record.agentId !== "string" ||
          typeof record.path !== "string"
        ) {
          continue;
        }
        map.set(record.id, {
          id: record.id,
          direction: record.direction,
          agentId: record.agentId,
          path: record.path,
          bytes: typeof record.bytes === "number" ? record.bytes : 0,
          ...(typeof record.partialSha256 === "string"
            ? { partialSha256: record.partialSha256 }
            : {}),
          state:
            record.state === "completed"
              ? "completed"
              : record.state === "in_progress"
                ? "interrupted"
                : "interrupted",
          ...(typeof record.storeId === "string" ? { storeId: record.storeId } : {}),
          resumes: typeof record.resumes === "number" ? record.resumes : 0,
          createdAt:
            typeof record.createdAt === "string"
              ? record.createdAt
              : new Date(this.now()).toISOString(),
          updatedAt:
            typeof record.updatedAt === "string"
              ? record.updatedAt
              : new Date(this.now()).toISOString(),
        });
      }
    } catch (error) {
      this.logger.warn("agents.transfer.registry_read_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return map;
  }

  private persist(): void {
    if (!this.registryPath) return;
    try {
      mkdirSync(dirname(this.registryPath), { recursive: true });
      const tmp = `${this.registryPath}.part`;
      writeFileSync(tmp, JSON.stringify([...this.registry.values()]), { mode: 0o600 });
      renameSync(tmp, this.registryPath);
    } catch (error) {
      this.logger.warn("agents.transfer.registry_write_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ── Résolution et garde-fous ─────────────────────────────────────────────

  private resolveAgent(
    requested: string,
  ): { agentId: string; agentName: string } | TransferRefusal {
    const record = this.store.resolve(requested);
    if (!record) {
      return new TransferRefusal(
        "refused",
        `Agent inconnu : « ${requested} ». Désignez la machine par son nom ou son identifiant.`,
      );
    }
    // ⚠️ Repli sur l'IDENTIFIANT quand l'humain n'a pas encore nommé la machine :
    // la carte de fichier doit TOUJOURS dire d'où vient le fichier.
    return {
      agentId: record.agentId,
      agentName: record.name !== "" ? record.name : record.agentId,
    };
  }

  /**
   * Contrôles AVANT toute émission, dans l'ordre : agent vivant, capacité
   * `files`, chemin absolu, garde-fou D118. ⚠️ Aucun octet n'est émis avant
   * d'avoir franchi ces quatre étapes.
   */
  private preflight(
    agentId: string,
    agentName: string,
    path: string,
    command: string,
    origin: string,
    sessionId: string | undefined,
  ): void {
    if (!this.hub.isOnline(agentId)) {
      throw new TransferRefusal("offline", "Agent hors ligne : transfert refusé (aucune mise en file).");
    }
    // ⚠️ CAPACITÉ : sans elle, l'agent IGNORE la trame et le transfert
    // resterait bloqué jusqu'au délai. On refuse AVANT d'émettre.
    if (!this.hub.hasCapability(agentId, FILES_CAPABILITY)) {
      throw new TransferRefusal("unsupported", filesUnsupportedMessage(agentName), "files_unsupported");
    }
    if (!isAbsolutePath(path)) {
      throw new TransferRefusal(
        "refused",
        `Chemin refusé : « ${path} » n'est pas un chemin ABSOLU. Un chemin relatif ` +
          "dépendrait du répertoire de travail du processus sur la machine (non maîtrisé). " +
          "Donne un chemin complet, par exemple /home/utilisateur/fichier.txt.",
        "relative_path",
      );
    }
    const decision = this.authorizeFn?.({
      agentId,
      command,
      origin,
      ...(sessionId !== undefined ? { sessionId } : {}),
    });
    if (decision?.kind === "refuse") {
      throw new TransferRefusal("refused", decision.message, "guard_refused");
    }
    if (decision?.kind === "awaiting") {
      throw new TransferRefusal(
        "awaiting_validation",
        "Validation humaine requise : le transfert n'a PAS démarré. Une demande " +
          "d'approbation s'affiche dans la conversation.",
      );
    }
  }

  // ── RÉCUPÉRATION (machine → Yuki) ────────────────────────────────────────

  async get(request: FileGetRequest): Promise<TransferOutcome> {
    const resolved = this.resolveAgent(request.agentId);
    if (resolved instanceof TransferRefusal) {
      return this.refusedOutcome(request.agentId, undefined, "get", request.path, resolved);
    }
    const { agentId, agentName } = resolved;
    const origin = request.origin ?? "recuperer_fichier";
    try {
      this.preflight(
        agentId,
        agentName,
        request.path,
        FILE_GET_COMMAND,
        FILES_GET_ORIGIN,
        request.sessionId,
      );
    } catch (error) {
      return this.refusedOutcome(agentId, agentName, "get", request.path, error);
    }

    const limit = Math.max(1, Math.trunc(this.limits.maxBytes()));
    const chunk = this.chunkBytes();
    const timeoutMs = Math.max(1_000, Math.trunc(this.limits.timeoutMs()));

    const transferId = this.idFactory();
    const record: TransferRecord = {
      id: transferId,
      direction: "get",
      agentId,
      path: request.path,
      bytes: 0,
      state: "in_progress",
      resumes: 0,
      createdAt: new Date(this.now()).toISOString(),
      updatedAt: new Date(this.now()).toISOString(),
    };
    this.registry.set(transferId, record);
    this.persist();

    const outcome = await this.runGet({
      agentId,
      agentName,
      path: request.path,
      record,
      limit,
      chunk,
      timeoutMs,
      origin,
      ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
    });
    return outcome;
  }

  private async runGet(args: {
    agentId: string;
    agentName: string;
    path: string;
    record: TransferRecord;
    limit: number;
    chunk: number;
    timeoutMs: number;
    origin: string;
    sessionId?: string;
  }): Promise<TransferOutcome> {
    const { agentId, agentName, path, record, limit, chunk, timeoutMs, origin } = args;
    const sink = this.files.createSink({
      name: basenameOf(path),
      mimeType: "application/octet-stream",
      origin: "externe",
      ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
    });
    let digest = createHash("sha256");
    let received = 0;
    let tooLarge = false;
    let badOrder = false;

    this.audit.append({
      event: "file_transfer",
      agentId,
      command: FILE_GET_COMMAND,
      exitCode: null,
      meta: { status: "started", direction: "get", agent_name: agentName || null, path, origin },
    });

    /**
     * Un essai : `file_get` à `offset` puis réassemblage jusqu'au dernier
     * morceau. ⚠️ Le `sink` et le digest SONT PARTAGÉS d'un essai à l'autre :
     * une reprise CONTINUE le fichier au lieu de le recréer.
     */
    const attempt = (offset: number): Promise<void> => {
      const cmdId = this.idFactory();
      this.hub.armFileTimer(agentId, cmdId, timeoutMs);
      return this.hub.sendFileGet(agentId, { cmdId, path, offset, maxTotal: limit, chunk }, (frame) => {
        // ⚠️ ORDRE STRICT : un morceau hors séquence (rejeu, doublon) romprait
        // le réassemblage. On refuse plutôt que produire un fichier corrompu.
        if (frame.offset !== received) {
          badOrder = true;
          return;
        }
        const data = Buffer.from(frame.data, "base64");
        const written = sink.write(data);
        if (!written.ok) {
          tooLarge = written.code === "too_large";
          return;
        }
        digest.update(data);
        received += data.byteLength;
        record.bytes = received;
        record.partialSha256 = digest.copy().digest("hex");
        record.updatedAt = new Date(this.now()).toISOString();
        if (frame.dernier && frame.sha256 !== undefined) {
          record.partialSha256 = frame.sha256;
        }
      });
    };

    try {
      await attempt(0);
    } catch (error) {
      // ⚠️ REPRISE AUTOMATIQUE, UNE SEULE FOIS : uniquement sur une COUPURE
      // (`interrupted`), et seulement si des octets ont déjà été reçus et que la
      // connexion est revenue. ⚠️ Le fichier CONTINUE à `received` : l'empreinte
      // finale porte donc sur le fichier COMPLET (préfixe + suite).
      const interrupted =
        isChannelError(error) && (error.code === "interrupted" || error.code === "agent_offline");
      if (interrupted && received > 0 && record.resumes < 1 && !badOrder && !tooLarge) {
        record.resumes += 1;
        record.state = "interrupted";
        this.persist();
        this.logger.info("agents.transfer.resume", {
          agent_id: agentId,
          offset: received,
          attempt: record.resumes,
        });
        // Le digest du préfixe déjà reçu doit être REJOUÉ dans un nouveau
        // `createHash` si le canal repart à zéro — mais ici `digest` a conservé
        // son état : on continue dessus. La reprise exige donc la même instance.
        try {
          await attempt(received);
          record.state = "in_progress";
          this.persist();
        } catch (retryError) {
          sink.abort();
          return this.onFailure(agentId, agentName, "get", path, record, retryError, {
            tooLarge,
            origin,
          });
        }
      } else {
        sink.abort();
        return this.onFailure(agentId, agentName, "get", path, record, error, { tooLarge, origin });
      }
    }

    if (tooLarge) {
      sink.abort();
      this.removeRecord(record.id);
      const outcome: TransferOutcome = {
        status: "too_large",
        agentId,
        ...(agentName ? { agentName } : {}),
        direction: "get",
        path,
        message: tooLargeMessage(received, limit),
      };
      this.auditTransfer(agentId, agentName, "get", path, "too_large", origin, {
        bytes: received,
      });
      return outcome;
    }
    if (badOrder) {
      sink.abort();
      this.removeRecord(record.id);
      return this.simpleOutcome(
        agentId,
        agentName,
        "get",
        path,
        "interrupted",
        "Transfert interrompu : des morceaux sont arrivés dans le désordre. " +
          "Aucun fichier n'a été conservé (jamais un fichier corrompu).",
        origin,
      );
    }

    // ⚠️ VÉRIFICATION FINALE : la taille ET l'empreinte du fichier COMPLET. Une
    // divergence supprime ce qui a été écrit (`digest_mismatch`) — jamais un
    // fichier altéré publié.
    const expectedSha = record.partialSha256;
    const computed = digest.digest("hex");
    if (expectedSha !== undefined && expectedSha.toLowerCase() !== computed) {
      sink.abort();
      this.removeRecord(record.id);
      return this.simpleOutcome(
        agentId,
        agentName,
        "get",
        path,
        "digest_mismatch",
        `Transfert refusé : l'empreinte SHA-256 du fichier reçu ne correspond pas à ` +
          `celle annoncée par la machine. Aucun fichier n'a été conservé.`,
        origin,
      );
    }

    const committed = sink.commit();
    if (!committed.ok) {
      this.removeRecord(record.id);
      return this.simpleOutcome(
        agentId,
        agentName,
        "get",
        path,
        committed.code === "too_large" ? "too_large" : "io_error",
        committed.code === "too_large"
          ? tooLargeMessage(committed.receivedBytes, committed.limitBytes)
          : `Transfert refusé : le fichier reçu n'a pas pu être enregistré (${committed.code}).`,
        origin,
      );
    }

    record.state = "completed";
    record.storeId = committed.record.id;
    record.bytes = committed.record.bytes;
    record.updatedAt = new Date(this.now()).toISOString();
    this.persist();

    const wire = this.files.toWire(committed.record);
    this.auditTransfer(agentId, agentName, "get", path, "completed", origin, {
      bytes: wire.bytes,
      sha256: computed,
      file_id: wire.id,
      name: wire.name,
    });
    // ⚠️ Le fichier est SUR LE DISQUE de Yuki : l'interface doit le SIGNALER
    // (carte cliquable « Inclure dans la discussion »), sinon l'utilisateur
    // ignore qu'il existe.
    this.emitReceived({
      agentId,
      ...(agentName ? { agentName } : {}),
      ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
      file: wire,
    });
    this.logger.info("agents.transfer.get_completed", {
      agent_id: agentId,
      bytes: wire.bytes,
      file_id: wire.id,
    });

    return {
      status: "completed",
      agentId,
      ...(agentName ? { agentName } : {}),
      direction: "get",
      path,
      file: wire,
      bytes: wire.bytes,
      sha256: computed,
      message:
        `Fichier récupéré depuis la machine et enregistré : « ${wire.name} » ` +
        `(${humanSize(wire.bytes)}, empreinte SHA-256 ${computed.slice(0, 16)}…). ` +
        "Il est maintenant SUR LE DISQUE de Yuki et une carte cliquable s'affiche " +
        "dans la conversation : l'utilisateur peut l'inclure dans la discussion.",
    };
  }

  // ── DÉPÔT (Yuki → machine) ───────────────────────────────────────────────

  async put(request: FilePutRequest): Promise<TransferOutcome> {
    const resolved = this.resolveAgent(request.agentId);
    if (resolved instanceof TransferRefusal) {
      return this.refusedOutcome(request.agentId, undefined, "put", request.path, resolved);
    }
    const { agentId, agentName } = resolved;
    const origin = request.origin ?? "deposer_fichier";
    try {
      this.preflight(
        agentId,
        agentName,
        request.path,
        FILE_PUT_COMMAND,
        FILES_PUT_ORIGIN,
        request.sessionId,
      );
    } catch (error) {
      return this.refusedOutcome(agentId, agentName, "put", request.path, error);
    }

    // ⚠️ La source est un fichier DÉJÀ stocké par Yuki (le modèle n'a aucun accès
    // disque). Un identifiant inconnu/expiré est refusé explicitement.
    const stored = this.files.get(request.fileId);
    if (!stored) {
      return this.simpleOutcome(
        agentId,
        agentName,
        "put",
        request.path,
        "not_found",
        `Fichier à déposer introuvable dans Yuki (« ${request.fileId} »). Il a peut-être expiré : ` +
          "redemande-le à l'utilisateur, ou récupère-le d'abord depuis la conversation.",
        origin,
      );
    }
    const data = this.files.readBytes(request.fileId);
    if (!data) {
      return this.simpleOutcome(
        agentId,
        agentName,
        "put",
        request.path,
        "not_found",
        "Contenu du fichier à déposer illisible : il a peut-être expiré.",
        origin,
      );
    }

    const limit = Math.max(1, Math.trunc(this.limits.maxBytes()));
    if (data.byteLength > limit) {
      return this.simpleOutcome(
        agentId,
        agentName,
        "put",
        request.path,
        "too_large",
        tooLargeMessage(data.byteLength, limit),
        origin,
      );
    }

    const chunkSize = this.chunkBytes();
    const timeoutMs = Math.max(1_000, Math.trunc(this.limits.timeoutMs()));
    const sha256 = sha256Hex(data);
    const cmdId = this.idFactory();
    const transferId = this.idFactory();
    const record: TransferRecord = {
      id: transferId,
      direction: "put",
      agentId,
      path: request.path,
      bytes: 0,
      state: "in_progress",
      storeId: stored.id,
      resumes: 0,
      createdAt: new Date(this.now()).toISOString(),
      updatedAt: new Date(this.now()).toISOString(),
    };
    this.registry.set(transferId, record);
    this.persist();

    // ⚠️ Les morceaux sont pré-encodés en base64 : aucun contenu ne circule par
    // un autre canal, et le DERNIER porte l'empreinte du fichier COMPLET.
    const chunks: Array<OutboundFilePutChunk> = [];
    let seq = 0;
    for (let offset = 0; offset < data.byteLength; offset += chunkSize) {
      const slice = data.subarray(offset, Math.min(offset + chunkSize, data.byteLength));
      const last = offset + slice.byteLength >= data.byteLength;
      chunks.push({
        cmdId,
        seq,
        data: slice.toString("base64"),
        dernier: last,
        ...(last ? { sha256 } : {}),
      });
      seq += 1;
    }
    if (chunks.length === 0) {
      // Fichier vide : une seule trame finale (aucune donnée).
      chunks.push({ cmdId, seq: 0, data: "", dernier: true, sha256 });
    }

    try {
      this.audit.append({
        event: "file_transfer",
        agentId,
        command: FILE_PUT_COMMAND,
        exitCode: null,
        meta: {
          status: "started",
          direction: "put",
          agent_name: agentName || null,
          path: request.path,
          bytes: data.byteLength,
          origin,
        },
      });
      this.hub.armFileTimer(agentId, cmdId, timeoutMs * Math.max(1, chunks.length));
      const result = await this.hub.sendFilePut(
        agentId,
        {
          cmdId,
          path: request.path,
          bytes: data.byteLength,
          sha256,
          ...(request.ecraser ? { ecraser: true } : {}),
        },
        chunks,
      );
      const writtenSha = result.sha256 ?? sha256;
      if (result.bytes !== undefined && result.bytes !== data.byteLength) {
        this.removeRecord(record.id);
        return this.simpleOutcome(
          agentId,
          agentName,
          "put",
          request.path,
          "io_error",
          `Transfert incohérent : la machine dit avoir écrit ${result.bytes} octets ` +
            `pour ${data.byteLength} envoyés. Le fichier distant est suspect.`,
          origin,
        );
      }
      record.state = "completed";
      record.bytes = result.bytes ?? data.byteLength;
      record.updatedAt = new Date(this.now()).toISOString();
      this.persist();
      this.auditTransfer(agentId, agentName, "put", request.path, "completed", origin, {
        bytes: record.bytes,
        sha256: writtenSha,
        name: stored.name,
      });
      this.logger.info("agents.transfer.put_completed", {
        agent_id: agentId,
        bytes: record.bytes,
      });
      return {
        status: "completed",
        agentId,
        ...(agentName ? { agentName } : {}),
        direction: "put",
        path: request.path,
        bytes: record.bytes,
        sha256: writtenSha,
        message:
          `Fichier déposé sur la machine : « ${request.path} » ` +
          `(${humanSize(record.bytes)}, empreinte SHA-256 ${writtenSha.slice(0, 16)}…). ` +
          "La machine a confirmé l'écriture et l'empreinte.",
      };
    } catch (error) {
      return this.onFailure(agentId, agentName, "put", request.path, record, error, {
        tooLarge: false,
        origin,
      });
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private chunkBytes(): number {
    const raw = Math.trunc(this.limits.chunkBytes());
    if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_FILE_CHUNK_BYTES;
    return Math.min(raw, 4 * 1024 * 1024);
  }

  /** Traduit un échec de canal en résultat terminal, audité. */
  private onFailure(
    agentId: string,
    agentName: string,
    direction: "get" | "put",
    path: string,
    record: TransferRecord,
    error: unknown,
    extra: { tooLarge: boolean; origin: string },
  ): TransferOutcome {
    const agentCode = isChannelError(error) ? error.agentCode : undefined;
    const code = isChannelError(error) ? error.code : "send_failed";
    let status: TransferStatus;
    switch (agentCode) {
      case "too_large":
        status = "too_large";
        break;
      case "digest_mismatch":
        status = "digest_mismatch";
        break;
      case "not_found":
        status = "not_found";
        break;
      case "conflict":
        status = "conflict";
        break;
      case "unsupported":
        status = "unsupported";
        break;
      case "interrupted":
        status = "interrupted";
        break;
      case "io_error":
        status = "io_error";
        break;
      default:
        status =
          code === "command_timeout"
            ? "timeout"
            : code === "interrupted"
              ? "interrupted"
              : code === "agent_offline"
                ? "offline"
                : "io_error";
    }
    // ⚠️ Un TRANSFERT INTERROMPU (octets déjà reçus) qui se solde par un agent
    // hors ligne APRÈS la reprise n'est PAS « hors ligne » du point de vue du
    // fichier : ce qui compte, c'est qu'il est INCOMPLET. On le DIT (`interrupted`),
    // jamais un succès partiel ni un message trompeur.
    if (record.bytes > 0 && status === "offline") {
      status = "interrupted";
    }
    // ⚠️ Un échec ne laisse JAMAIS un succès partiel : le registre est marqué
    // comme INTERROMPU (reprise possible une fois) ou retiré si le refus est
    // définitif.
    if (status === "interrupted" || status === "timeout") {
      record.state = "interrupted";
      record.updatedAt = new Date(this.now()).toISOString();
      this.persist();
    } else {
      this.removeRecord(record.id);
    }
    const message = this.messageForStatus(status, error, extra.tooLarge, record.bytes);
    this.auditTransfer(agentId, agentName, direction, path, status, extra.origin, {
      bytes: record.bytes,
      code,
      agent_code: agentCode ?? null,
    });
    this.logger.warn("agents.transfer.failed", {
      agent_id: agentId,
      direction,
      status,
      code,
    });
    return this.simpleOutcome(agentId, agentName, direction, path, status, message, extra.origin, {
      ...(status === "interrupted" ? { bytes: record.bytes } : {}),
    });
  }

  private messageForStatus(
    status: TransferStatus,
    error: unknown,
    tooLarge: boolean,
    bytes = 0,
  ): string {
    if (tooLarge) {
      return tooLargeMessage(bytes, this.limits.maxBytes());
    }
    switch (status) {
      case "too_large":
        return (
          "Transfert refusé : le fichier dépasse le plafond par transfert. " +
          "Utilise `run_command` sur la machine pour un fichier plus gros."
        );
      case "digest_mismatch":
        return (
          "Transfert refusé : l'empreinte SHA-256 ne correspond pas. Aucun fichier " +
          "n'a été conservé (ni sur la machine, ni chez Yuki)."
        );
      case "not_found":
        return "Transfert impossible : le fichier demandé est introuvable ou illisible sur la machine.";
      case "conflict":
        return (
          "Transfert refusé : un fichier existe déjà à cette destination sur la machine. " +
          "Demande explicitement l'écrasement (`ecraser: true`) si c'est voulu."
        );
      case "unsupported":
        return filesUnsupportedMessage(undefined);
      case "offline":
        return "Agent hors ligne : transfert refusé (aucune mise en file).";
      case "interrupted":
        return (
          "Transfert INTERROMPU : la connexion s'est fermée avant la fin. Aucun " +
          "fichier partiel n'a été conservé. Une seule reprise est tentée à la " +
          "reconnexion ; au-delà, il faut relancer le transfert."
        );
      case "timeout":
        return "Transfert interrompu : le délai de transfert a été déclassé sans aucune trame reçue.";
      case "io_error":
        return error instanceof Error
          ? `Transfert refusé par la machine : ${error.message}`
          : "Transfert refusé : erreur d'entrée/sortie.";
      default:
        return error instanceof Error ? error.message : "Transfert impossible.";
    }
  }

  private refusedOutcome(
    agentId: string,
    agentName: string | undefined,
    direction: "get" | "put",
    path: string,
    error: unknown,
  ): TransferOutcome {
    const refusal =
      error instanceof TransferRefusal
        ? error
        : new TransferRefusal("refused", error instanceof Error ? error.message : String(error));
    return this.simpleOutcome(
      agentId,
      agentName,
      direction,
      path,
      refusal.status,
      refusal.message,
      direction === "get" ? FILES_GET_ORIGIN : FILES_PUT_ORIGIN,
    );
  }

  private simpleOutcome(
    agentId: string,
    agentName: string | undefined,
    direction: "get" | "put",
    path: string,
    status: TransferStatus,
    message: string,
    origin: string,
    extra: { bytes?: number } = {},
  ): TransferOutcome {
    this.auditTransfer(agentId, agentName, direction, path, status, origin, {
      ...(extra.bytes !== undefined ? { bytes: extra.bytes } : {}),
    });
    return {
      status,
      agentId,
      ...(agentName ? { agentName } : {}),
      direction,
      path,
      message,
      ...(extra.bytes !== undefined ? { bytes: extra.bytes } : {}),
    };
  }

  private auditTransfer(
    agentId: string,
    agentName: string | undefined,
    direction: "get" | "put",
    path: string,
    status: string,
    origin: string,
    extra: Record<string, unknown>,
  ): void {
    // ⚠️ AUDIT SANS CONTENU : chemin, taille, empreinte et statut seulement.
    this.audit.append({
      event: "file_transfer",
      agentId,
      command: direction === "get" ? FILE_GET_COMMAND : FILE_PUT_COMMAND,
      exitCode: null,
      meta: {
        status,
        direction,
        agent_name: agentName || null,
        path,
        origin,
        ...extra,
      },
    });
  }

  private removeRecord(id: string): void {
    this.registry.delete(id);
    this.persist();
  }
}

/** Nom de fichier (dernier segment) d'un chemin distant — assaini plus tard. */
function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
  const last = parts[parts.length - 1];
  return last && last.length > 0 ? last : "fichier";
}

/** Vérifie qu'une erreur est un transfert interrompu (utilitaire des tests). */
export function isInterrupted(error: unknown): boolean {
  return isChannelError(error) && error.code === "interrupted" && error instanceof AgentChannelError;
}

// Réexport pratique pour le câblage (le type d'entrée d'un dépôt).
export type { FileSaveInput };
