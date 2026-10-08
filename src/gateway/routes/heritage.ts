/**
 * API d'administration de l'archive « vie antérieure » — `node:http`, aucun
 * framework.
 *
 * Routes :
 *   GET    /api/self/heritage              → synthèse + LISTE des entrées
 *   GET    /api/self/heritage/entry/<cle>  → contenu d'UNE entrée
 *   POST   /api/self/heritage/entry        → CRÉE une entrée
 *   PUT    /api/self/heritage/entry/<cle>  → MODIFIE une entrée
 *   DELETE /api/self/heritage/entry/<cle>  → MET DE CÔTÉ une entrée (récupérable)
 *
 * ⚠️ C'est une administration RÉSERVÉE à l'INTERFACE : aucun outil du modèle n'y
 * mène. L'outil `archive_vie_anterieure` reste en LECTURE SEULE (Lot 13).
 *
 * ⚠️ Les écritures réutilisent les MÊMES garde-fous que `/api/config`
 * (`requireWriteGuards` : en-tête `X-Yuki-Config: 1` + contrôle `Origin`/`Host`).
 *
 * ⚠️ « Supprimer » = METTRE DE CÔTÉ (`deleted/`), jamais détruire : même esprit
 * que l'archivage de la mémoire (Lot 12).
 */

import type { IncomingHttpHeaders } from "node:http";

import {
  HeritageAdminError,
  type HeritageAdminPort,
  type HeritageWriteInput,
} from "../../memory/index.js";
import type { Logger } from "../../observability/logger.js";
import { configWriteFlow, requireWriteGuards } from "./config.js";

export interface HeritageApiDeps {
  /** Port d'administration de l'archive (jamais exposé au modèle). */
  admin: HeritageAdminPort;
  logger: Logger;
  now?: () => number;
}

export interface HeritageHttpResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface HeritageRequestInput {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
  deps: HeritageApiDeps;
}

const JSON_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

const ENTRY_PREFIX = "/api/self/heritage/entry/";

function json(status: number, body: unknown): HeritageHttpResponse {
  return { status, body, headers: JSON_HEADERS };
}

/** Décode la clé d'entrée portée par le segment final (peut contenir « / »). */
function parseCle(path: string): string | null {
  if (!path.startsWith(ENTRY_PREFIX)) return null;
  const raw = path.slice(ENTRY_PREFIX.length);
  if (raw.length === 0) return null;
  try {
    const cle = decodeURIComponent(raw);
    return cle.length > 0 ? cle : null;
  } catch {
    return null;
  }
}

/** Corps d'écriture attendu (`{ titre, categorie?, texte }`). */
function parseWriteBody(raw: string): HeritageWriteInput | null {
  let parsed: unknown;
  try {
    parsed = raw.trim() === "" ? {} : JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const titre = typeof record["titre"] === "string" ? record["titre"] : "";
  if (titre.trim().length === 0) return null;
  const texte = typeof record["texte"] === "string" ? record["texte"] : "";
  const categorie = typeof record["categorie"] === "string" ? record["categorie"] : undefined;
  return { titre, texte, ...(categorie !== undefined ? { categorie } : {}) };
}

function handleGetList(deps: HeritageApiDeps): HeritageHttpResponse {
  return json(200, {
    info: deps.admin.info(),
    entries: deps.admin.list(),
  });
}

function handleGetEntry(cle: string, deps: HeritageApiDeps): HeritageHttpResponse {
  const entry = deps.admin.read(cle);
  if (!entry) {
    return json(404, {
      error: "not_found",
      code: "not_found",
      message: "Entrée d'archive introuvable.",
    });
  }
  return json(200, { entry });
}

function handleCreate(input: HeritageRequestInput): HeritageHttpResponse {
  const guard = requireWriteGuards(input.headers);
  if (guard) return { status: guard.status, body: guard.body, headers: guard.headers };

  const parsed = parseWriteBody(input.body);
  if (!parsed) {
    return json(400, {
      error: "invalid_body",
      code: "invalid_body",
      message: "Objet JSON attendu ({ titre: string, categorie?: string, texte: string }).",
    });
  }
  try {
    const result = input.deps.admin.create(parsed);
    input.deps.logger.info("heritage.created", {
      id: result.entry.id,
      cle: result.entry.cle,
      bytes: result.bytes,
      truncated: result.truncated,
      flow: configWriteFlow(input.headers),
    });
    return json(201, {
      entry: result.entry,
      bytes: result.bytes,
      truncated: result.truncated,
      changed: result.changed,
    });
  } catch (error) {
    if (error instanceof HeritageAdminError) {
      return json(400, { error: error.code, code: error.code, message: error.message });
    }
    throw error;
  }
}

function handleUpdate(cle: string, input: HeritageRequestInput): HeritageHttpResponse {
  const guard = requireWriteGuards(input.headers);
  if (guard) return { status: guard.status, body: guard.body, headers: guard.headers };

  const parsed = parseWriteBody(input.body);
  if (!parsed) {
    return json(400, {
      error: "invalid_body",
      code: "invalid_body",
      message: "Objet JSON attendu ({ titre: string, categorie?: string, texte: string }).",
    });
  }
  const result = input.deps.admin.update(cle, parsed);
  if (!result) {
    return json(404, {
      error: "not_found",
      code: "not_found",
      message: "Entrée d'archive introuvable.",
    });
  }
  input.deps.logger.info("heritage.updated", {
    id: result.entry.id,
    cle: result.entry.cle,
    bytes: result.bytes,
    truncated: result.truncated,
    changed: result.changed,
    flow: configWriteFlow(input.headers),
  });
  return json(200, {
    entry: result.entry,
    bytes: result.bytes,
    truncated: result.truncated,
    changed: result.changed,
  });
}

function handleDelete(cle: string, input: HeritageRequestInput): HeritageHttpResponse {
  const guard = requireWriteGuards(input.headers);
  if (guard) return { status: guard.status, body: guard.body, headers: guard.headers };

  const result = input.deps.admin.remove(cle);
  if (!result) {
    return json(404, {
      error: "not_found",
      code: "not_found",
      message: "Entrée d'archive introuvable.",
    });
  }
  input.deps.logger.info("heritage.deleted", {
    id: result.id,
    cle: result.cle,
    movedTo: result.deletedPath,
    at: result.at,
    flow: configWriteFlow(input.headers),
  });
  return json(200, {
    deleted: { id: result.id, cle: result.cle },
    moved: result.moved,
    deletedPath: result.deletedPath,
    at: result.at,
    message:
      `Entrée « ${result.id} » mise de côté (récupérable) dans ${result.deletedPath}. ` +
      "Elle ne fait plus partie de l'archive active.",
  });
}

/** Vrai si le chemin relève de l'API d'administration de l'archive. */
export function isHeritagePath(path: string): boolean {
  return path === "/api/self/heritage" || path.startsWith("/api/self/heritage/");
}

/** Traite une requête d'administration de l'archive et renvoie la réponse HTTP. */
export function handleHeritageRequest(input: HeritageRequestInput): HeritageHttpResponse {
  const { method, path } = input;
  if (path === "/api/self/heritage") {
    if (method === "GET" || method === "HEAD") return handleGetList(input.deps);
    return json(405, { error: "method_not_allowed", method });
  }
  if (path === "/api/self/heritage/entry") {
    if (method === "POST") return handleCreate(input);
    return json(405, { error: "method_not_allowed", method });
  }
  const cle = parseCle(path);
  if (cle !== null) {
    if (method === "GET" || method === "HEAD") return handleGetEntry(cle, input.deps);
    if (method === "PUT") return handleUpdate(cle, input);
    if (method === "DELETE") return handleDelete(cle, input);
    return json(405, { error: "method_not_allowed", method });
  }
  return json(404, { error: "not_found", path });
}
