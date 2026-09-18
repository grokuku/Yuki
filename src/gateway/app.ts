/**
 * Application HTTP — `node:http` natif, zéro framework.
 *
 * Sert les routes de santé/version, l'UI statique de `public/ui`, et rien
 * d'autre. Le transport temps réel (WebSocket) n'est PAS géré ici : il est
 * branché via le hook `upgrade` du serveur HTTP.
 */

import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { resolve } from "node:path";

import type { Env } from "../config/env.js";
import type { MountStatus } from "../config/paths.js";
import type { GpuReport } from "../types/gpu.js";
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
  } = context;

  return (req: IncomingMessage, res: ServerResponse): void => {
    const path = normalizePath(req.url);
    const method = (req.method ?? "GET").toUpperCase();
    const headOnly = method === "HEAD";

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
