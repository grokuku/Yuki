/**
 * Service des fichiers statiques de l'UI.
 *
 * Lecture seule, refus de toute traversée de répertoire, en-têtes sûrs.
 * Aucun framework, aucune chaîne de build front.
 */

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

export interface StaticDeps {
  /** Répertoire de base des assets de l'UI (résolu au démarrage). */
  publicDir: string;
}

export interface StaticResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer | string;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/** En-têtes de sécurité appliqués à toute réponse statique. */
export const STATIC_SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "cache-control": "no-cache",
};

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot >= 0 ? path.slice(dot).toLowerCase() : "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

function notFound(): StaticResult {
  return {
    status: 404,
    headers: { ...STATIC_SECURITY_HEADERS, "content-type": "text/plain; charset=utf-8" },
    body: "Not Found\n",
  };
}

/**
 * Résout une requête statique. Renvoie `null` si le chemin n'appartient pas à
 * l'espace statique (l'appelant décide alors du 404 applicatif).
 */
export function resolveStaticRequest(
  deps: StaticDeps,
  pathname: string,
): StaticResult | null {
  let relative: string;
  if (pathname === "/" || pathname === "/index.html") {
    relative = "index.html";
  } else if (pathname === "/config" || pathname === "/config.html") {
    relative = "config.html";
  } else if (pathname.startsWith("/ui/")) {
    relative = pathname.slice("/ui/".length);
  } else {
    return null;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(relative);
  } catch {
    return notFound();
  }
  if (decoded.includes("\0") || decoded.includes("..") || isAbsolute(decoded)) {
    return notFound();
  }

  const baseDir = resolve(deps.publicDir);
  const resolved = resolve(baseDir, decoded);
  // Garde-fou anti-traversal : le chemin résolu doit rester sous publicDir.
  if (resolved !== baseDir && !resolved.startsWith(baseDir + sep)) {
    return notFound();
  }

  let info;
  try {
    info = statSync(resolved);
  } catch {
    return notFound();
  }
  if (!info.isFile()) {
    return notFound();
  }

  let body: Buffer;
  try {
    body = readFileSync(resolved);
  } catch {
    return notFound();
  }
  return {
    status: 200,
    headers: {
      ...STATIC_SECURITY_HEADERS,
      "content-type": contentTypeFor(resolved),
      "content-length": String(body.byteLength),
    },
    body,
  };
}
