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
  | "error"
  | "pong"
  | "ping"
  | "state";

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

export type AgentFrame =
  | HelloFrame
  | AckFrame
  | ResultFrame
  | ErrorFrame
  | PongFrame
  | PingFrame
  | StateFrame;

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
