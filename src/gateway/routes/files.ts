/**
 * Routes des FICHIERS échangés.
 *
 *  - `POST /api/files`               dépôt d'un fichier (corps = octets bruts).
 *  - `GET  /api/files?session=<id>`  liste des fichiers d'une conversation.
 *  - `DELETE /api/files/<id>`        suppression immédiate (fichier + analyse).
 *  - `GET  /fichiers/<id>.<ext>`      SERVICE same-origin (téléchargement/affichage).
 *
 * ⚠️ Le corps est reçu en OCTETS BRUTS (pas de `multipart/form-data`) : aucune
 * dépendance, aucune analyse de formulaire à écrire. Le nom vient de l'en-tête
 * `x-yuki-filename` (pourcent-encodé en UTF-8) et il est ASSAINI par le stockage.
 *
 * ⚠️ Le service `/fichiers/…` n'élargit AUCUNE directive CSP : une image est
 * servie en `image/png|jpeg|gif|webp|bmp` (autorisé par `img-src 'self'`), tout le
 * reste est servi en `application/octet-stream` avec
 * `Content-Disposition: attachment` — donc TÉLÉCHARGÉ, jamais interprété. Un SVG
 * n'est jamais servi inline (script embarqué).
 */

import type { IncomingHttpHeaders } from "node:http";

import { INLINE_IMAGE_MIME_TYPES } from "../../files/analyze.js";
import type { FilesService } from "../../files/service.js";
import { contentDispositionName } from "../../files/name.js";
import type { FileRejectionCode } from "../../files/types.js";
import type { Logger } from "../../observability/logger.js";
import type { ConfigHttpResponse } from "./config.js";
import { STATIC_SECURITY_HEADERS } from "./static.js";

/** Préfixe de service same-origin des fichiers. */
export const FILES_SERVE_PREFIX = "/fichiers/";

/** Préfixe de l'API HTTP des fichiers. */
export const FILES_API_PREFIX = "/api/files";

export interface FilesApiDeps {
  service: FilesService;
  logger?: Logger;
}

/** Vrai si le chemin relève du SERVICE same-origin (`/fichiers/<id>.<ext>`). */
export function isFilesServePath(path: string): boolean {
  return path.startsWith(FILES_SERVE_PREFIX);
}

/** Vrai si le chemin relève de l'API (`/api/files`…). */
export function isFilesApiPath(path: string): boolean {
  return path === FILES_API_PREFIX || path.startsWith(`${FILES_API_PREFIX}/`);
}

function json(status: number, body: unknown): ConfigHttpResponse {
  return {
    status,
    body,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  };
}

/** Réponse du service same-origin (en-têtes TOUJOURS présents). */
export interface FilesServeResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer | string;
}

function notFound(): FilesServeResponse {
  return {
    status: 404,
    body: "Not Found\n",
    headers: { ...STATIC_SECURITY_HEADERS, "content-type": "text/plain; charset=utf-8" },
  };
}

/** Lit un en-tête quel que soit son casse. */
function headerString(
  headers: IncomingHttpHeaders,
  name: string,
): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value : undefined;
}

/** Décode un nom pourcent-encodé (jamais fatal). */
function decodeName(raw: string | undefined): string {
  if (raw === undefined) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Identifiant de conversation accepté dans les en-têtes/query (jamais un chemin). */
const SESSION_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

function sessionIdFrom(headers: IncomingHttpHeaders, query: URLSearchParams): string | undefined {
  const raw = headerString(headers, "x-yuki-session") ?? query.get("session") ?? undefined;
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return SESSION_ID_RE.test(trimmed) ? trimmed : undefined;
}

/** Message d'erreur d'un refus de dépôt (jamais muet, jamais un code seul). */
function rejectionMessage(
  code: FileRejectionCode,
  receivedBytes: number,
  limitBytes: number,
): string {
  switch (code) {
    case "too_large":
      return (
        `Fichier refusé : ${receivedBytes} octets reçus, plafond de ${limitBytes} octets ` +
        "par fichier. Rien n'a été conservé (le fichier partiel est supprimé). Ce plafond " +
        "est réglable dans /config (Fichiers → taille maximale par fichier)."
      );
    case "empty":
      return "Fichier refusé : le corps de la requête est vide (0 octet).";
    case "empty_name":
      return "Fichier refusé : aucun nom exploitable n'a été fourni.";
    default:
      return "Fichier refusé : l'écriture sur le disque a échoué (état du volume à vérifier).";
  }
}

/** Traite une requête de l'API des fichiers (hors dépôt, qui est asynchrone). */
export function handleFilesApiRequest(input: {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  deps: FilesApiDeps;
}): ConfigHttpResponse {
  const { method, path, headers, deps } = input;
  const url = new URL(`http://local${path}`);
  // ⚠️ On travaille sur le CHEMIN (sans query) : `?session=…` ne doit pas être
  // pris pour un identifiant de fichier à supprimer.
  const pathname = url.pathname;
  const rest = pathname.startsWith(FILES_API_PREFIX)
    ? pathname.slice(FILES_API_PREFIX.length)
    : pathname;

  // Dépôt : traité par `handleFilesUpload` (corps en flux).
  if (rest === "" || rest === "/") {
    if (method === "POST") {
      return json(400, {
        error: "invalid_body",
        code: "invalid_body",
        message: "Corps de requête attendu (octets du fichier).",
      });
    }
    if (method !== "GET" && method !== "HEAD") {
      return json(405, { error: "method_not_allowed", method });
    }
    const sessionId = sessionIdFrom(headers, url.searchParams);
    if (sessionId === undefined) {
      return json(400, {
        error: "missing_session",
        code: "missing_session",
        message:
          "Paramètre `session` (ou en-tête `x-yuki-session`) requis pour lister les " +
          "fichiers d'une conversation.",
      });
    }
    const files = deps.service.listForSession(sessionId);
    return json(200, {
      files,
      count: files.length,
      limits: {
        // La borne d'injection est exposée POUR ÊTRE DITE : l'utilisateur sait ce
        // que le modèle reçoit réellement.
        note:
          "Seules des métadonnées sont exposées ici ; le contenu est servi par " +
          "`/fichiers/<id>.<ext>` et n'est jamais renvoyé dans cette réponse.",
      },
    });
  }

  const rawId = rest.replace(/^\/+/, "");
  const id = rawId.includes(".") ? rawId.slice(0, rawId.lastIndexOf(".")) : rawId;
  if (method !== "DELETE") {
    return json(405, { error: "method_not_allowed", method });
  }
  if (deps.service.remove(id)) {
    deps.logger?.info("files.deleted", { id });
    return json(200, { deleted: true, id });
  }
  return json(404, {
    error: "file_unknown",
    code: "file_unknown",
    message: "Ce fichier n'existe pas (ou a expiré) : rien n'a été supprimé.",
  });
}

/** Dépôt d'un fichier : le corps est consommé EN FLUX (aucune copie mémoire). */
export async function handleFilesUpload(input: {
  headers: IncomingHttpHeaders;
  stream: AsyncIterable<Uint8Array>;
  deps: FilesApiDeps;
}): Promise<ConfigHttpResponse> {
  const name = decodeName(headerString(input.headers, "x-yuki-filename")).trim();
  if (name === "") {
    return json(400, {
      error: "missing_filename",
      code: "missing_filename",
      message:
        "En-tête `x-yuki-filename` requis (nom du fichier, pourcent-encodé en UTF-8).",
    });
  }
  const mimeType = headerString(input.headers, "content-type") ?? "application/octet-stream";
  const sessionId = sessionIdFrom(input.headers, new URLSearchParams());

  const outcome = await input.deps.service.saveUpload(input.stream, {
    name,
    mimeType,
    origin: "user",
    ...(sessionId !== undefined ? { sessionId } : {}),
  });
  if (!outcome.ok) {
    return json(outcome.code === "too_large" ? 413 : 400, {
      error: outcome.code,
      code: outcome.code,
      message: rejectionMessage(outcome.code, outcome.receivedBytes, outcome.limitBytes),
      receivedBytes: outcome.receivedBytes,
      limitBytes: outcome.limitBytes,
    });
  }
  return json(201, { file: outcome.file });
}

/**
 * Sert un fichier (`GET/HEAD /fichiers/<id>.<ext>`).
 *
 * Refus : identifiant non hexadécimal, extension qui ne correspond PAS à la
 * fiche, traversée de chemin, fichier inconnu ou expiré.
 */
export function handleFilesServeRequest(input: {
  method: string;
  path: string;
  deps: FilesApiDeps;
}): FilesServeResponse {
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
    decoded = decodeURIComponent(path.slice(FILES_SERVE_PREFIX.length));
  } catch {
    return notFound();
  }
  if (decoded.includes("/") || decoded.includes("\\") || decoded.includes("..")) {
    return notFound();
  }
  const dot = decoded.lastIndexOf(".");
  if (dot <= 0) return notFound();
  const id = decoded.slice(0, dot);
  const ext = decoded.slice(dot + 1).toLowerCase();

  const record = deps.service.get(id);
  if (!record || record.ext !== ext) {
    deps.logger?.warn("files.serve.missing", { id });
    return notFound();
  }
  const bytes = deps.service.readBytes(id);
  if (!bytes) return notFound();

  const inline = INLINE_IMAGE_MIME_TYPES.has(record.mimeType);
  const disposition = contentDispositionName(record.name);
  return {
    status: 200,
    headers: {
      ...STATIC_SECURITY_HEADERS,
      // ⚠️ Un type NON image reste `application/octet-stream` : même si le
      // fichier contient du HTML, il n'est jamais interprété par le navigateur.
      "content-type": inline ? record.mimeType : "application/octet-stream",
      "content-length": String(bytes.byteLength),
      "content-disposition": inline
        ? `inline; filename="${disposition.ascii}"; filename*=UTF-8''${disposition.encoded}`
        : `attachment; filename="${disposition.ascii}"; filename*=UTF-8''${disposition.encoded}`,
      // Un fichier privé ne doit pas rester dans un cache partagé.
      "cache-control": "private, no-store",
    },
    body: bytes,
  };
}
