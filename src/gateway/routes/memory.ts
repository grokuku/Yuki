/**
 * API d'administration de la mémoire durable de Yuki — `node:http`, aucun
 * framework.
 *
 * Routes :
 *   GET  /api/memory        → état lisible (entrées courantes, dossier d'archive)
 *   POST /api/memory/reset  → ARCHIVE (récupérable) puis remet la mémoire à zéro
 *
 * ⚠️ C'est une action DÉCLENCHÉE PAR L'INTERFACE, jamais exposée au modèle :
 * aucune politique de tool, aucun `run_command`-like. « Réinitialiser » = METTRE
 * DE CÔTÉ (fichier renommé horodaté), pas effacer.
 *
 * ⚠️ Les écritures réutilisent les MÊMES garde-fous que `/api/config`
 * (`requireWriteGuards` : en-tête `X-Yuki-Config: 1` + contrôle `Origin`/`Host`).
 */

import type { IncomingHttpHeaders } from "node:http";

import { configWriteFlow, requireWriteGuards } from "./config.js";
import type { MemoryAdminPort } from "../../memory/index.js";
import type { Logger } from "../../observability/logger.js";

export interface MemoryApiDeps {
  /** Port d'administration de la mémoire (archivage récupérable + état). */
  admin: MemoryAdminPort;
  logger: Logger;
  now?: () => number;
}

export interface MemoryHttpResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface MemoryRequestInput {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
  deps: MemoryApiDeps;
}

const JSON_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function json(status: number, body: unknown): MemoryHttpResponse {
  return { status, body, headers: JSON_HEADERS };
}

/** Vue publique : nombre d'entrées courantes + dossier d'archive (chemin). */
function memoryView(deps: MemoryApiDeps): Record<string, unknown> {
  const info = deps.admin.info();
  return {
    entries: info.entries,
    archiveDir: info.archiveDir,
  };
}

function handleGet(deps: MemoryApiDeps): MemoryHttpResponse {
  return json(200, memoryView(deps));
}

/**
 * Archive la mémoire puis repart d'une mémoire vide. Journalise l'opération
 * (horodatage, taille, destination) SANS jamais écrire de contenu de souvenir.
 */
function handleReset(input: MemoryRequestInput): MemoryHttpResponse {
  const guard = requireWriteGuards(input.headers);
  if (guard) return { status: guard.status, body: guard.body, headers: guard.headers };

  const result = input.deps.admin.resetMemory();
  input.deps.logger.info("memory.reset", {
    at: result.at,
    archived: result.archived,
    entries: result.entries,
    bytes: result.bytes,
    // Chemin de l'archive (jamais son contenu) : permet de retrouver/restaurer.
    archive: result.archivePath,
    dir: result.archivePath === null ? input.deps.admin.info().archiveDir : undefined,
    flow: configWriteFlow(input.headers),
  });

  if (!result.archived) {
    return json(200, {
      reset: false,
      archived: false,
      entries: 0,
      bytes: 0,
      archivePath: null,
      at: result.at,
      message: "Aucune mémoire à réinitialiser : il n'y a aucun souvenir enregistré.",
    });
  }

  return json(200, {
    reset: true,
    archived: true,
    entries: result.entries,
    bytes: result.bytes,
    archivePath: result.archivePath,
    at: result.at,
    message:
      `Mémoire archivée (${result.entries} souvenir(s)) dans ${result.archivePath}. ` +
      "La mémoire est maintenant vide ; les prochaines conversations produiront de " +
      "nouveaux souvenirs.",
  });
}

/** Vrai si le chemin relève de l'API d'administration de la mémoire. */
export function isMemoryPath(path: string): boolean {
  return path === "/api/memory" || path.startsWith("/api/memory/");
}

/** Traite une requête d'administration de la mémoire et renvoie la réponse HTTP. */
export function handleMemoryRequest(input: MemoryRequestInput): MemoryHttpResponse {
  const { method, path } = input;
  if (path === "/api/memory") {
    if (method === "GET" || method === "HEAD") return handleGet(input.deps);
    return json(405, { error: "method_not_allowed", method });
  }
  if (path === "/api/memory/reset") {
    if (method === "POST") return handleReset(input);
    return json(405, { error: "method_not_allowed", method });
  }
  return json(404, { error: "not_found", path });
}
