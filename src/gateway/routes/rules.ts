/**
 * API des RÈGLES STRICTES de Yuki — `node:http`, aucun framework.
 *
 * Routes :
 *   GET  /api/self/rules         → contenu effectif + borne + historique
 *   PUT  /api/self/rules         → remplace le contenu (source « user »)
 *   POST /api/self/rules/revert  → restaure la version précédente
 *
 * ⚠️ RÉSERVÉE À L'UTILISATEUR : ces routes réutilisent les MÊMES garde-fous que
 * `/api/config` (`requireWriteGuards` : en-tête `X-Yuki-Config: 1` + contrôle
 * `Origin`/`Host`). AUCUN outil du modèle n'écrit `rules.md` — l'extension SDK
 * ne consomme que le port de LECTURE (`RulesPort`). Cette API n'est atteignable
 * que depuis l'interface `/config` du navigateur, jamais depuis la conversation.
 */

import type { IncomingHttpHeaders } from "node:http";

import type { RulesAdminPort } from "../../rules/index.js";
import type { Logger } from "../../observability/logger.js";
import { requireWriteGuards } from "./config.js";

export interface RulesApiDeps {
  store: RulesAdminPort;
  logger: Logger;
  now?: () => number;
}

export interface RulesHttpResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface RulesRequestInput {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
  deps: RulesApiDeps;
}

const JSON_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

/** Longueur de l'aperçu d'une version d'historique renvoyé à l'UI. */
const HISTORY_PREVIEW_CHARS = 160;
/** Nombre de versions d'historique renvoyées (aligné sur la borne de rétention). */
const HISTORY_LIMIT = 20;

function json(status: number, body: unknown): RulesHttpResponse {
  return { status, body, headers: JSON_HEADERS };
}

/** Vue publique : contenu effectif + borne + historique (aperçus). */
function rulesView(deps: RulesApiDeps): Record<string, unknown> {
  const doc = deps.store.read();
  const history = deps.store.history(HISTORY_LIMIT).map((entry) => ({
    at: entry.at,
    chars: entry.chars,
    preview: entry.text.slice(0, HISTORY_PREVIEW_CHARS),
  }));
  return {
    text: doc.text,
    chars: doc.chars,
    maxChars: deps.store.maxChars,
    truncated: doc.truncated,
    exists: doc.exists,
    history,
  };
}

function handleGet(deps: RulesApiDeps): RulesHttpResponse {
  return json(200, rulesView(deps));
}

function handlePut(input: RulesRequestInput): RulesHttpResponse {
  const guard = requireWriteGuards(input.headers);
  if (guard) return { status: guard.status, body: guard.body, headers: guard.headers };

  let parsed: unknown;
  try {
    parsed = input.body.trim() === "" ? {} : JSON.parse(input.body);
  } catch {
    return json(400, {
      error: "invalid_json",
      code: "invalid_json",
      message: "Corps JSON invalide.",
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return json(400, {
      error: "invalid_body",
      code: "invalid_body",
      message: "Objet JSON attendu ({ text: string }).",
    });
  }
  const text = (parsed as { text?: unknown }).text;
  if (typeof text !== "string") {
    return json(400, {
      error: "invalid_text",
      code: "invalid_text",
      message: "Champ « text » (chaîne) attendu.",
    });
  }

  const result = input.deps.store.write(text, "user");
  input.deps.logger.info("rules.saved", {
    changed: result.changed,
    before_chars: result.beforeChars,
    after_chars: result.chars,
    truncated: result.truncated,
  });
  return json(200, {
    ...rulesView(input.deps),
    changed: result.changed,
    truncated: result.truncated,
  });
}

function handleRevert(input: RulesRequestInput): RulesHttpResponse {
  const guard = requireWriteGuards(input.headers);
  if (guard) return { status: guard.status, body: guard.body, headers: guard.headers };

  const result = input.deps.store.revert("user");
  if (!result) {
    return json(404, {
      error: "no_previous_version",
      code: "no_previous_version",
      message: "Aucune version précédente à restaurer.",
    });
  }
  input.deps.logger.info("rules.reverted", {
    before_chars: result.beforeChars,
    after_chars: result.chars,
  });
  return json(200, {
    ...rulesView(input.deps),
    changed: result.changed,
    truncated: result.truncated,
  });
}

/** Vrai si le chemin relève de l'API des règles. */
export function isRulesPath(path: string): boolean {
  return path === "/api/self/rules" || path.startsWith("/api/self/rules/");
}

/** Traite une requête de règles et renvoie la réponse HTTP. */
export function handleRulesRequest(input: RulesRequestInput): RulesHttpResponse {
  const { method, path } = input;
  if (path === "/api/self/rules") {
    if (method === "GET" || method === "HEAD") return handleGet(input.deps);
    if (method === "PUT") return handlePut(input);
    return json(405, { error: "method_not_allowed", method });
  }
  if (path === "/api/self/rules/revert") {
    if (method === "POST") return handleRevert(input);
    return json(405, { error: "method_not_allowed", method });
  }
  return json(404, { error: "not_found", path });
}
