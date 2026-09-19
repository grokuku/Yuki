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

/** Lit le corps d'une requête (borné). Rejette au-delà de la limite. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_CONFIG_BODY_BYTES) {
        reject(new Error("body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
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
