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

/** Nombre maximal de souvenirs récents renvoyés à l'interface. */
export const MEMORY_RECENT_LIMIT = 50;

/** Préfixe de la route de mise de côté d'un souvenir. */
const ENTRY_PREFIX = "/api/memory/entry/";

function json(status: number, body: unknown): MemoryHttpResponse {
  return { status, body, headers: JSON_HEADERS };
}

/**
 * Vue publique : nombre d'entrées courantes, dossier d'archive, et APERÇU des
 * souvenirs récents (contenu inclus : c'est une vue pour l'UTILISATEUR, jamais
 * exposée au modèle).
 */
function memoryView(deps: MemoryApiDeps): Record<string, unknown> {
  const info = deps.admin.info();
  return {
    entries: info.entries,
    archiveDir: info.archiveDir,
    recent: deps.admin.list(MEMORY_RECENT_LIMIT),
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

/**
 * Met un souvenir DE CÔTÉ (copie récupérable puis retrait). ⚠️ Jamais un
 * effacement définitif : le souvenir est d'abord copié dans le fichier de mise
 * de côté, puis retiré du store (ligne `delete`). Le journal d'audit ne contient
 * JAMAIS le contenu du souvenir.
 */
function handleSetAside(input: MemoryRequestInput, id: string): MemoryHttpResponse {
  const guard = requireWriteGuards(input.headers);
  if (guard) return { status: guard.status, body: guard.body, headers: guard.headers };

  const result = input.deps.admin.setAside(id);
  input.deps.logger.info("memory.set_aside", {
    at: result.at,
    id,
    setAside: result.setAside,
    archive: result.archivePath,
    flow: configWriteFlow(input.headers),
  });

  if (!result.setAside) {
    return json(404, {
      setAside: false,
      id,
      message: "Souvenir introuvable : il a peut-être déjà été mis de côté.",
    });
  }

  return json(200, {
    setAside: true,
    id,
    archivePath: result.archivePath,
    at: result.at,
    message:
      `Souvenir mis de côté (récupérable dans ${result.archivePath}). ` +
      "Il ne sera plus rappelé ; ce n'est PAS une suppression définitive.",
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
  if (path.startsWith(ENTRY_PREFIX)) {
    const rawId = path.slice(ENTRY_PREFIX.length);
    let id: string;
    try {
      id = decodeURIComponent(rawId).trim();
    } catch {
      return json(400, { error: "bad_id" });
    }
    if (id.length === 0) return json(400, { error: "bad_id" });
    if (method === "DELETE") return handleSetAside(input, id);
    return json(405, { error: "method_not_allowed", method });
  }
  return json(404, { error: "not_found", path });
}
