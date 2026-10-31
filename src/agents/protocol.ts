/**
 * Protocole d'exécution CÔTÉ YUKI (Lot 4, B6) — miroir des trames Go
 * (`agent/internal/proto/types.go`).
 *
 * ⚠️ **Aucun code n'est exécuté ici** : ce module ne fait que DÉFINIR et
 * (dé)sérialiser les trames du canal WebSocket authentifié. C'est Yuki qui
 * décide (D118) ; l'agent est un exécutant bête (D109).
 *
 * Règles filaires (identiques au Go) :
 *   - chaque trame porte `type` + `proto_version` (`AGENT_PROTO_VERSION`) ;
 *   - une version différente est refusée (`unsupported_version`) ;
 *   - les champs inconnus sont tolérés (compatibilité ascendante).
 *
 * ⚠️ La sortie des commandes (`result.stdout`/`result.stderr`) est BRUTE. Elle
 * ne doit JAMAIS être journalisée (D127) ni livrée telle quelle au modèle :
 * elle est encadrée par `output.ts`.
 */

/** Version courante du protocole filaire (alignée sur `proto.Version`). */
export const AGENT_PROTO_VERSION = 1;

/** Discriminants de trame reconnus par Yuki (sens agent → Yuki). */
export type AgentFrameType =
  | "hello"
  | "ack"
  | "result"
  | "screenshot_data"
  | "error"
  | "pong"
  | "ping"
  | "state"
  | "file_chunk"
  | "file_result";

export interface HelloFrame {
  type: "hello";
  protoVersion: number;
  agentId?: string;
  agentVersion?: string;
  host?: string;
  os?: string;
  arch?: string;
  /** Identifiant d'utilisateur effectif (`-1` si non pertinent, ex. Windows). */
  euid: number;
  caps: string[];
}

export interface AckFrame {
  type: "ack";
  cmdId: string;
}

export interface ResultFrame {
  type: "result";
  cmdId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  stdoutTrunc: boolean;
  stderrTrunc: boolean;
  durationMs: number;
  timedOut: boolean;
  startedAt?: string;
  endedAt?: string;
}

export interface ScreenshotDataFrame {
  type: "screenshot_data";
  cmdId: string;
  format: string;
  width: number;
  height: number;
  bytes: number;
  /** Image encodée en base64 standard (sans préfixe `data:`). */
  data: string;
  durationMs?: number;
}

export interface ErrorFrame {
  type: "error";
  error: string;
  code: string;
  message: string;
  ref?: string;
}

export interface PongFrame {
  type: "pong";
  t: number;
  ts?: string;
}

export interface PingFrame {
  type: "ping";
  t: number;
}

export interface StateFrame {
  type: "state";
  state: string;
  detail?: string;
}

/**
 * Morceau d'un fichier lu sur la machine (`file_chunk`, agent → Yuki).
 *
 * ⚠️ `data` est du base64 STANDARD (sans préfixe `data:`). `sha256` (hexadécimal
 * minuscule) n'est renseigné que sur le DERNIER morceau : c'est l'empreinte du
 * fichier COMPLET, que Yuki vérifie avant d'accepter le transfert.
 */
export interface FileChunkFrame {
  type: "file_chunk";
  cmdId: string;
  seq: number;
  /** Position du PREMIER octet du morceau dans le fichier. */
  offset: number;
  /** Contenu du morceau, en base64 standard. */
  data: string;
  /** `true` sur le dernier morceau. */
  dernier: boolean;
  /** Taille TOTALE du fichier (dernier morceau). */
  total?: number;
  /** Empreinte SHA-256 du fichier COMPLET, hexadécimale (dernier morceau). */
  sha256?: string;
}

/** Codes de refus d'un transfert (miroir de `proto.ErrorCode`). */
export type AgentFileErrorCode =
  | "unsupported"
  | "too_large"
  | "digest_mismatch"
  | "io_error"
  | "not_found"
  | "conflict"
  | "interrupted";

/**
 * Issue d'une ÉCRITURE sur la machine (`file_result`, agent → Yuki).
 *
 * ⚠️ Ne porte JAMAIS le contenu : seulement la taille et l'empreinte du fichier
 * réellement écrit (ou le code et le message du refus).
 */
export interface FileResultFrame {
  type: "file_result";
  cmdId: string;
  status: "ok" | "refused";
  bytes?: number;
  sha256?: string;
  code?: AgentFileErrorCode;
  message?: string;
}

export type AgentFrame =
  | HelloFrame
  | AckFrame
  | ResultFrame
  | ScreenshotDataFrame
  | ErrorFrame
  | PongFrame
  | PingFrame
  | StateFrame
  | FileChunkFrame
  | FileResultFrame;

/** Codes d'erreur de CADRAGE (alignés sur `proto.ErrorCode`). */
export type FrameErrorCode =
  | "invalid_json"
  | "malformed_message"
  | "unknown_type"
  | "unsupported_version"
  | "invalid_frame";

export type AgentFrameParse =
  | { ok: true; frame: AgentFrame }
  | { ok: false; code: FrameErrorCode; message: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * Analyse une trame JSON reçue de l'agent. Ne lève jamais : renvoie un résultat
 * discriminant. Un `type` inconnu ou une version différente est refusé (comme
 * le Go).
 */
export function parseAgentFrame(raw: Buffer | string): AgentFrameParse {
  const text = typeof raw === "string" ? raw : raw.toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, code: "invalid_json", message: "Trame JSON invalide." };
  }
  const record = asRecord(parsed);
  if (!record) {
    return { ok: false, code: "malformed_message", message: "Objet JSON attendu." };
  }
  const type = asString(record["type"]);
  if (!type) {
    return { ok: false, code: "malformed_message", message: "Champ `type` absent." };
  }
  const version = asNumber(record["proto_version"]);
  if (version !== AGENT_PROTO_VERSION) {
    return {
      ok: false,
      code: "unsupported_version",
      message: `proto_version ${String(version ?? "absent")} non supportée (attendue ${AGENT_PROTO_VERSION}).`,
    };
  }

  switch (type as AgentFrameType) {
    case "hello": {
      const agentId = asString(record["agent_id"]);
      return {
        ok: true,
        frame: {
          type: "hello",
          protoVersion: version,
          ...(agentId !== undefined ? { agentId } : {}),
          ...(asString(record["agent_version"]) !== undefined
            ? { agentVersion: asString(record["agent_version"]) as string }
            : {}),
          ...(asString(record["host"]) !== undefined
            ? { host: asString(record["host"]) as string }
            : {}),
          ...(asString(record["os"]) !== undefined
            ? { os: asString(record["os"]) as string }
            : {}),
          ...(asString(record["arch"]) !== undefined
            ? { arch: asString(record["arch"]) as string }
            : {}),
          euid: asNumber(record["euid"]) ?? -1,
          caps: asStringArray(record["caps"]),
        },
      };
    }
    case "ack": {
      const cmdId = asString(record["cmd_id"]);
      if (!cmdId) {
        return { ok: false, code: "invalid_frame", message: "`ack` sans `cmd_id`." };
      }
      return { ok: true, frame: { type: "ack", cmdId } };
    }
    case "result": {
      const cmdId = asString(record["cmd_id"]);
      if (!cmdId) {
        return { ok: false, code: "invalid_frame", message: "`result` sans `cmd_id`." };
      }
      return {
        ok: true,
        frame: {
          type: "result",
          cmdId,
          exitCode: asNumber(record["exit_code"]) ?? -1,
          stdout: asString(record["stdout"]) ?? "",
          stderr: asString(record["stderr"]) ?? "",
          truncated: asBoolean(record["truncated"]) ?? false,
          stdoutTrunc: asBoolean(record["stdout_trunc"]) ?? false,
          stderrTrunc: asBoolean(record["stderr_trunc"]) ?? false,
          durationMs: asNumber(record["duration_ms"]) ?? 0,
          timedOut: asBoolean(record["timed_out"]) ?? false,
          ...(asString(record["started_at"]) !== undefined
            ? { startedAt: asString(record["started_at"]) as string }
            : {}),
          ...(asString(record["ended_at"]) !== undefined
            ? { endedAt: asString(record["ended_at"]) as string }
            : {}),
        },
      };
    }
    case "screenshot_data": {
      const cmdId = asString(record["cmd_id"]);
      if (!cmdId) {
        return { ok: false, code: "invalid_frame", message: "`screenshot_data` sans `cmd_id`." };
      }
      return {
        ok: true,
        frame: {
          type: "screenshot_data",
          cmdId,
          format: asString(record["format"]) ?? "jpeg",
          width: asNumber(record["width"]) ?? 0,
          height: asNumber(record["height"]) ?? 0,
          bytes: asNumber(record["bytes"]) ?? 0,
          data: asString(record["data"]) ?? "",
          ...(asNumber(record["duration_ms"]) !== undefined
            ? { durationMs: asNumber(record["duration_ms"]) as number }
            : {}),
        },
      };
    }
    case "error": {
      return {
        ok: true,
        frame: {
          type: "error",
          error: asString(record["error"]) ?? "internal_error",
          code: asString(record["code"]) ?? "internal_error",
          message: asString(record["message"]) ?? "Erreur de l'agent.",
          ...(asString(record["ref"]) !== undefined
            ? { ref: asString(record["ref"]) as string }
            : {}),
        },
      };
    }
    case "pong": {
      return {
        ok: true,
        frame: {
          type: "pong",
          t: asNumber(record["t"]) ?? 0,
          ...(asString(record["ts"]) !== undefined
            ? { ts: asString(record["ts"]) as string }
            : {}),
        },
      };
    }
    case "ping": {
      return { ok: true, frame: { type: "ping", t: asNumber(record["t"]) ?? 0 } };
    }
    case "state": {
      return {
        ok: true,
        frame: {
          type: "state",
          state: asString(record["state"]) ?? "unknown",
          ...(asString(record["detail"]) !== undefined
            ? { detail: asString(record["detail"]) as string }
            : {}),
        },
      };
    }
    case "file_chunk": {
      const cmdId = asString(record["cmd_id"]);
      if (!cmdId) {
        return { ok: false, code: "invalid_frame", message: "`file_chunk` sans `cmd_id`." };
      }
      const data = asString(record["data"]);
      if (data === undefined) {
        return { ok: false, code: "invalid_frame", message: "`file_chunk` sans `data`." };
      }
      return {
        ok: true,
        frame: {
          type: "file_chunk",
          cmdId,
          seq: asNumber(record["seq"]) ?? 0,
          offset: asNumber(record["offset"]) ?? 0,
          data,
          dernier: asBoolean(record["dernier"]) ?? false,
          ...(asNumber(record["total"]) !== undefined
            ? { total: asNumber(record["total"]) as number }
            : {}),
          ...(asString(record["sha256"]) !== undefined
            ? { sha256: asString(record["sha256"]) as string }
            : {}),
        },
      };
    }
    case "file_result": {
      const cmdId = asString(record["cmd_id"]);
      if (!cmdId) {
        return { ok: false, code: "invalid_frame", message: "`file_result` sans `cmd_id`." };
      }
      const status = asString(record["status"]);
      const code = asString(record["code"]);
      return {
        ok: true,
        frame: {
          type: "file_result",
          cmdId,
          status: status === "ok" ? "ok" : "refused",
          ...(asNumber(record["bytes"]) !== undefined
            ? { bytes: asNumber(record["bytes"]) as number }
            : {}),
          ...(asString(record["sha256"]) !== undefined
            ? { sha256: asString(record["sha256"]) as string }
            : {}),
          ...(code !== undefined ? { code: code as AgentFileErrorCode } : {}),
          ...(asString(record["message"]) !== undefined
            ? { message: asString(record["message"]) as string }
            : {}),
        },
      };
    }
    default:
      return { ok: false, code: "unknown_type", message: `type inconnu : ${type}` };
  }
}

/** Demande d'exécution envoyée à l'agent (`cmd`). */
export interface OutboundCommand {
  cmdId: string;
  command: string;
  shell?: string;
  cwd?: string;
  timeoutMs?: number;
  origin?: string;
  /** Décision de Yuki (D118/D126) ; l'agent la journalise sans la contester. */
  destructive?: boolean;
  /**
   * Variables d'environnement SUPPLÉMENTAIRES (SUR-ENSEMBLE) : c'est par ce
   * champ que Yuki injecte les SECRETS du coffre, SANS jamais réécrire la
   * commande (le shell développe `$NOM`). ⚠️ Jamais journalisé, jamais audité.
   */
  env?: Record<string, string>;
}

/**
 * Trames sortantes (Yuki → agent). Elles respectent STRICTEMENT le décodage Go
 * (`proto.Decode`) : `type` + `proto_version` exacts, champs optionnels omis
 * plutôt que nuls (le Go distingue `nil` de `false` pour `destructive`).
 */
export function encodeCommandFrame(cmd: OutboundCommand): Record<string, unknown> {
  return {
    type: "cmd",
    proto_version: AGENT_PROTO_VERSION,
    cmd_id: cmd.cmdId,
    command: cmd.command,
    ...(cmd.shell ? { shell: cmd.shell } : {}),
    ...(cmd.cwd ? { cwd: cmd.cwd } : {}),
    ...(cmd.timeoutMs !== undefined ? { timeout_ms: cmd.timeoutMs } : {}),
    ...(cmd.origin ? { origin: cmd.origin } : {}),
    ...(cmd.destructive !== undefined ? { destructive: cmd.destructive } : {}),
    // ⚠️ Les secrets passent par `env` (sur-ensemble d'environnement), jamais
    // concaténés à `command`. Champ omis si vide (compatibilité filaire).
    ...(cmd.env && Object.keys(cmd.env).length > 0 ? { env: cmd.env } : {}),
  };
}

/** Demande de capture d'écran envoyée à l'agent (`screenshot`). */
export interface OutboundScreenshot {
  cmdId: string;
  timeoutMs?: number;
  /** Côté long maximal de l'image (px) ; 0/absent ⇒ défaut de l'agent. */
  maxEdge?: number;
  /** Qualité JPEG (1..100) ; 0/absent ⇒ défaut de l'agent. */
  quality?: number;
}

/** Encode une demande de capture (`screenshot`), conforme au décodage Go. */
export function encodeScreenshotFrame(shot: OutboundScreenshot): Record<string, unknown> {
  return {
    type: "screenshot",
    proto_version: AGENT_PROTO_VERSION,
    cmd_id: shot.cmdId,
    ...(shot.timeoutMs !== undefined ? { timeout_ms: shot.timeoutMs } : {}),
    ...(shot.maxEdge !== undefined ? { max_edge: shot.maxEdge } : {}),
    ...(shot.quality !== undefined ? { quality: shot.quality } : {}),
  };
}

export function encodeCancelFrame(cmdId: string, reason?: string): Record<string, unknown> {
  return {
    type: "cancel",
    proto_version: AGENT_PROTO_VERSION,
    cmd_id: cmdId,
    ...(reason ? { reason } : {}),
  };
}

export function encodePingFrame(t: number): Record<string, unknown> {
  return { type: "ping", proto_version: AGENT_PROTO_VERSION, t };
}

export function encodePongFrame(t: number, ts?: string): Record<string, unknown> {
  return {
    type: "pong",
    proto_version: AGENT_PROTO_VERSION,
    t,
    ...(ts ? { ts } : {}),
  };
}

export function encodeConfigFrame(level: string, privilege: string): Record<string, unknown> {
  return { type: "config", proto_version: AGENT_PROTO_VERSION, level, privilege };
}

// ── Transfert de fichiers (négocié par la capacité `files`) ────────────────
//
// ⚠️ Aucune de ces trames n'est émise sans que l'agent ait DÉCLARÉ `files` dans
// son `hello` : un agent antérieur les ignorerait (`client.go` côté Go) et Yuki
// attendrait une réponse qui n'arrive jamais. Le contrôle est fait dans
// `AgentExecutionService` AVANT tout envoi.

/** Taille BINAIRE par défaut d'un morceau (192 Kio ⇒ ~256 Kio en base64). */
export const DEFAULT_FILE_CHUNK_BYTES = 192 * 1024;

/** Demande de lecture d'un fichier DISTANT (`file_get`). */
export interface OutboundFileGet {
  cmdId: string;
  /** Chemin ABSOLU sur la machine. Un chemin relatif est refusé par l'agent. */
  path: string;
  /** Premier octet demandé (reprise après coupure). */
  offset?: number;
  /** Nombre total d'octets acceptés ; au-delà l'agent refuse AVANT émission. */
  maxTotal?: number;
  /** Taille BINAIRE maximale d'un morceau. */
  chunk?: number;
}

/** Encode une demande de lecture, conforme au décodage Go. */
export function encodeFileGetFrame(get: OutboundFileGet): Record<string, unknown> {
  return {
    type: "file_get",
    proto_version: AGENT_PROTO_VERSION,
    cmd_id: get.cmdId,
    path: get.path,
    ...(get.offset !== undefined ? { offset: get.offset } : {}),
    ...(get.maxTotal !== undefined ? { max_total: get.maxTotal } : {}),
    ...(get.chunk !== undefined ? { chunk: get.chunk } : {}),
  };
}

/** Annonce d'écriture d'un fichier DISTANT (`file_put`). */
export interface OutboundFilePut {
  cmdId: string;
  /** Chemin ABSOLU de destination. */
  path: string;
  /** Taille attendue, en octets. */
  bytes: number;
  /** Empreinte SHA-256 attendue du fichier COMPLET (hexadécimal minuscule). */
  sha256: string;
  /** Permissions POSIX (0 ⇒ 0o600 côté agent). */
  mode?: number;
  /** `true` autorise le remplacement d'un fichier existant. */
  ecraser?: boolean;
}

/** Encode une annonce d'écriture, conforme au décodage Go. */
export function encodeFilePutFrame(put: OutboundFilePut): Record<string, unknown> {
  return {
    type: "file_put",
    proto_version: AGENT_PROTO_VERSION,
    cmd_id: put.cmdId,
    path: put.path,
    bytes: put.bytes,
    sha256: put.sha256,
    ...(put.mode !== undefined ? { mode: put.mode } : {}),
    ...(put.ecraser !== undefined ? { ecraser: put.ecraser } : {}),
  };
}

/** Morceau d'un fichier à écrire (`file_put_chunk`). */
export interface OutboundFilePutChunk {
  cmdId: string;
  seq: number;
  /** Contenu binaire en base64 standard. */
  data: string;
  dernier: boolean;
  /** Empreinte du fichier COMPLET (dernier morceau). */
  sha256?: string;
}

/** Encode un morceau d'écriture, conforme au décodage Go. */
export function encodeFilePutChunkFrame(
  chunk: OutboundFilePutChunk,
): Record<string, unknown> {
  return {
    type: "file_put_chunk",
    proto_version: AGENT_PROTO_VERSION,
    cmd_id: chunk.cmdId,
    seq: chunk.seq,
    data: chunk.data,
    ...(chunk.dernier ? { dernier: true } : {}),
    ...(chunk.sha256 ? { sha256: chunk.sha256 } : {}),
  };
}
