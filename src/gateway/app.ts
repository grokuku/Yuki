/**
 * Application HTTP — `node:http` natif, zéro framework.
 *
 * Sert les routes de santé/version, l'API de configuration (`/api/config`,
 * Lot 11), l'UI statique de `public/ui`, et rien d'autre. Le transport temps
 * réel (WebSocket) n'est PAS géré ici : il est branché via le hook `upgrade` du
 * serveur HTTP.
 */

import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { resolve } from "node:path";

import type { Env } from "../config/env.js";
import type { MountStatus } from "../config/paths.js";
import type { GpuReport } from "../types/gpu.js";
import {
  handleConfigRequest,
  isConfigPath,
  MAX_CONFIG_BODY_BYTES,
  type ConfigApiDeps,
} from "./routes/config.js";
import {
  handleAdminRequest,
  isAdminPath,
  type AdminApiDeps,
} from "./routes/admin.js";
import {
  handleVoicesRequest,
  isVoicesPath,
  MAX_VOICE_BODY_BYTES,
  type VoiceApiDeps,
} from "./routes/voices.js";
import {
  handleTtsRequest,
  isTtsPath,
  type TtsApiDeps,
} from "./routes/tts.js";
import {
  healthFull,
  healthLive,
  healthReady,
  type SubsystemsSnapshot,
} from "./routes/health.js";
import { resolveStaticRequest } from "./routes/static.js";
import { versionInfo } from "./routes/version.js";

export interface AppContext {
  env: Env;
  report: GpuReport;
  gatePassed: boolean;
  startedAt: number;
  volumes: MountStatus[];
  /** Répertoire des assets de l'UI (`public/ui`). */
  publicDir?: string;
  /** Fournisseur de l'état des sous-systèmes (Pi, transport). */
  getSubsystems?: () => SubsystemsSnapshot;
  /** API de configuration (Lot 11). Absente ⇒ `/api/config` → 404. */
  config?: ConfigApiDeps;
  /** API d'administration (redémarrage). Absente ⇒ `/api/admin/**` → 404. */
  admin?: AdminApiDeps;
  /** API de gestion des voix TTS (Lot 7). Absente ⇒ `/api/voices*` → 404. */
  voices?: VoiceApiDeps;
  /** Diagnostic TTS (Lot 8). Absent ⇒ `/api/tts/**` → 404. */
  tts?: TtsApiDeps;
}

interface RouteResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const JSON_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function normalizePath(rawUrl: string | undefined): string {
  const url = new URL(rawUrl ?? "/", "http://localhost");
  const path = url.pathname.replace(/\/+$/, "");
  return path === "" ? "/" : path;
}

function writeResponse(
  res: ServerResponse,
  response: RouteResponse,
  headOnly: boolean,
): void {
  if (Buffer.isBuffer(response.body) || typeof response.body === "string") {
    const body = response.body;
    res.writeHead(response.status, {
      ...(response.headers ?? JSON_HEADERS),
    });
    if (headOnly) {
      res.end();
    } else {
      res.end(body);
    }
    return;
  }
  const payload = JSON.stringify(response.body);
  res.writeHead(response.status, {
    ...JSON_HEADERS,
    ...(response.headers ?? {}),
    "content-length": Buffer.byteLength(payload).toString(),
  });
  if (headOnly) {
    res.end();
  } else {
    res.end(payload);
  }
}

/** Message d'erreur interne signalant un corps de requête au-delà de la limite. */
const BODY_TOO_LARGE = "body_too_large";

/** Lit le corps d'une requête en `Buffer` (borné). Rejette au-delà de la limite. */
function readBodyBinary(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        // On cesse d'accumuler mais on DRAINE la suite : la socket reste
        // vivante, ce qui permet de renvoyer un 413 explicite (un
        // `req.destroy()` immédiat empêcherait toute réponse).
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) reject(new Error(BODY_TOO_LARGE));
      else resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

/** Lit le corps d'une requête (borné à `MAX_CONFIG_BODY_BYTES`), en UTF-8. */
function readBody(req: IncomingMessage): Promise<string> {
  return readBodyBinary(req, MAX_CONFIG_BODY_BYTES).then((buffer) =>
    buffer.toString("utf8"),
  );
}

/** Traite une requête de configuration (asynchrone : lecture du corps). */
async function handleConfigHttp(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  headOnly: boolean,
  deps: ConfigApiDeps,
): Promise<void> {
  let body = "";
  if (method === "PUT" || method === "POST") {
    body = await readBody(req).catch(() => "");
  }
  const response = await handleConfigRequest({
    method,
    path,
    headers: req.headers,
    body,
    deps,
  });
  writeResponse(
    res,
    { status: response.status, body: response.body, headers: response.headers },
    headOnly,
  );
}

/** Traite une requête de l'API des voix (corps binaire borné). */
async function handleVoicesHttp(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  headOnly: boolean,
  deps: VoiceApiDeps,
): Promise<void> {
  const needsBody = method === "POST" || method === "PATCH" || method === "PUT";
  let body: Buffer = Buffer.alloc(0);
  if (needsBody) {
    // L'upload de clonage reçoit un WAV binaire jusqu'à `MAX_VOICE_BODY_BYTES`
    // (D20) ; les autres corps (PATCH JSON) restent bornés à la limite config.
    const limit =
      path === "/api/voices/clone" ? MAX_VOICE_BODY_BYTES : MAX_CONFIG_BODY_BYTES;
    try {
      body = await readBodyBinary(req, limit);
    } catch (error) {
      const tooLarge = error instanceof Error && error.message === BODY_TOO_LARGE;
      writeResponse(
        res,
        {
          status: tooLarge ? 413 : 400,
          body: {
            error: tooLarge ? "body_too_large" : "invalid_body",
            code: tooLarge ? "body_too_large" : "invalid_body",
            message: tooLarge
              ? `Corps trop volumineux (maximum ${limit} octets).`
              : "Corps de requête illisible.",
          },
        },
        headOnly,
      );
      return;
    }
  }
  const response = await handleVoicesRequest({
    method,
    path,
    headers: req.headers,
    body,
    deps,
  });
  writeResponse(
    res,
    { status: response.status, body: response.body, headers: response.headers },
    headOnly,
  );
}

/** Traite une requête de diagnostic TTS (GET sans corps, POST texte borné). */
async function handleTtsHttp(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  headOnly: boolean,
  deps: TtsApiDeps,
): Promise<void> {
  let body: Buffer = Buffer.alloc(0);
  if (method === "POST") {
    try {
      body = await readBodyBinary(req, MAX_CONFIG_BODY_BYTES);
    } catch (error) {
      const tooLarge = error instanceof Error && error.message === BODY_TOO_LARGE;
      writeResponse(
        res,
        {
          status: tooLarge ? 413 : 400,
          body: {
            error: tooLarge ? "body_too_large" : "invalid_body",
            code: tooLarge ? "body_too_large" : "invalid_body",
            message: tooLarge
              ? `Corps trop volumineux (maximum ${MAX_CONFIG_BODY_BYTES} octets).`
              : "Corps de requête illisible.",
          },
        },
        headOnly,
      );
      return;
    }
  }
  const response = await handleTtsRequest({
    method,
    path,
    headers: req.headers,
    body,
    deps,
  });
  writeResponse(
    res,
    { status: response.status, body: response.body, headers: response.headers },
    headOnly,
  );
}

/** Construit l'écouteur HTTP de l'application. */
export function createApp(context: AppContext): RequestListener {
  const {
    env,
    report,
    gatePassed,
    startedAt,
    volumes,
    publicDir = resolve(process.cwd(), "public", "ui"),
    getSubsystems,
    config,
    admin,
    voices,
    tts,
  } = context;

  return (req: IncomingMessage, res: ServerResponse): void => {
    const path = normalizePath(req.url);
    const method = (req.method ?? "GET").toUpperCase();
    const headOnly = method === "HEAD";

    if (config && isConfigPath(path)) {
      void handleConfigHttp(req, res, path, method, headOnly, config).catch(
        (error: unknown) => {
          config.logger.error("config.request.failed", {
            error: error instanceof Error ? error.message : String(error),
            path,
          });
          if (!res.headersSent) {
            writeResponse(
              res,
              { status: 500, body: { error: "internal_error" } },
              headOnly,
            );
          } else {
            res.end();
          }
        },
      );
      return;
    }

    if (voices && isVoicesPath(path)) {
      void handleVoicesHttp(req, res, path, method, headOnly, voices).catch(
        (error: unknown) => {
          voices.logger.error("voices.request.failed", {
            error: error instanceof Error ? error.message : String(error),
            path,
          });
          if (!res.headersSent) {
            writeResponse(
              res,
              { status: 500, body: { error: "internal_error" } },
              headOnly,
            );
          } else {
            res.end();
          }
        },
      );
      return;
    }

    if (tts && isTtsPath(path)) {
      void handleTtsHttp(req, res, path, method, headOnly, tts).catch(
        (error: unknown) => {
          tts.logger.error("tts.request.failed", {
            error: error instanceof Error ? error.message : String(error),
            path,
          });
          if (!res.headersSent) {
            writeResponse(
              res,
              { status: 500, body: { error: "internal_error" } },
              headOnly,
            );
          } else {
            res.end();
          }
        },
      );
      return;
    }

    if (admin && isAdminPath(path)) {
      writeResponse(
        res,
        handleAdminRequest({ method, path, headers: req.headers, deps: admin }),
        headOnly,
      );
      return;
    }

    if (method !== "GET" && method !== "HEAD") {
      writeResponse(
        res,
        { status: 405, body: { error: "method_not_allowed", method } },
        headOnly,
      );
      return;
    }

    let response: RouteResponse;

    if (path === "/health/live") {
      response = healthLive();
    } else if (path === "/health/ready") {
      response = healthReady({
        version: env.version,
        startedAt,
        report,
        gatePassed,
        volumes,
        ...(getSubsystems ? { subsystems: getSubsystems() } : {}),
      });
    } else if (path === "/health") {
      response = healthFull({
        version: env.version,
        startedAt,
        report,
        gatePassed,
        volumes,
        ...(getSubsystems ? { subsystems: getSubsystems() } : {}),
      });
    } else if (path === "/version") {
      response = versionInfo({ version: env.version, profile: report.resolvedProfile });
    } else {
      const staticResult = resolveStaticRequest({ publicDir }, path);
      if (staticResult) {
        response = {
          status: staticResult.status,
          body: staticResult.body,
          headers: staticResult.headers,
        };
      } else {
        response = { status: 404, body: { error: "not_found", path } };
      }
    }

    writeResponse(res, response, headOnly);
  };
}
