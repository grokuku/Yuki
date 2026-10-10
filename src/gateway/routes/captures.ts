/**
 * Route SAME-ORIGIN de service des CAPTURES de pages web (`/captures/<id>.<ext>`).
 *
 * ⚠️ Manque historique du projet : `routes/static.ts` ne sert que `/`, `/config`
 * et `/ui/*`. La capture Libry, elle, est stockée sur un volume et doit être
 * affichée par l'interface : cette route la sert, MÊME ORIGINE, donc sans
 * élargir la CSP (`img-src 'self'` suffit).
 *
 * Lecture seule, refus de toute traversée de répertoire (l'identifiant est un
 * hexadécimal de 32 caractères ; l'extension est sur allowlist), en-têtes sûrs.
 */

import type { Logger } from "../../observability/logger.js";
import type { LibrarianShotsPort } from "../../librarian/shots.js";
import { STATIC_SECURITY_HEADERS } from "./static.js";

export interface CapturesApiDeps {
  store: LibrarianShotsPort;
  logger?: Logger;
}

export interface CapturesResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer | string;
}

/** Préfixe de l'espace des captures servies. */
export const CAPTURES_PREFIX = "/captures/";

/** Vrai si le chemin relève des captures servies. */
export function isCapturesPath(path: string): boolean {
  return path.startsWith(CAPTURES_PREFIX);
}

function notFound(): CapturesResponse {
  return {
    status: 404,
    headers: { ...STATIC_SECURITY_HEADERS, "content-type": "text/plain; charset=utf-8" },
    body: "Not Found\n",
  };
}

/** Sert une capture (`GET/HEAD /captures/<id>.<ext>`). */
export function handleCapturesRequest(input: {
  method: string;
  path: string;
  deps: CapturesApiDeps;
}): CapturesResponse {
  const { method, path, deps } = input;
  if (method !== "GET" && method !== "HEAD") {
    return {
      status: 405,
      headers: { ...STATIC_SECURITY_HEADERS, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: "method_not_allowed", method }),
    };
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(path.slice(CAPTURES_PREFIX.length));
  } catch {
    return notFound();
  }
  if (decoded.includes("/") || decoded.includes("\\") || decoded.includes("..")) {
    return notFound();
  }
  const dot = decoded.lastIndexOf(".");
  if (dot <= 0) return notFound();
  const id = decoded.slice(0, dot);
  const ext = decoded.slice(dot + 1);

  const image = deps.store.read(id, ext);
  if (!image) {
    deps.logger?.warn("librarian.capture.missing", { id });
    return notFound();
  }
  return {
    status: 200,
    headers: {
      ...STATIC_SECURITY_HEADERS,
      "content-type": image.mimeType,
      "content-length": String(image.bytes.byteLength),
    },
    body: image.bytes,
  };
}
