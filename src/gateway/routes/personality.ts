/**
 * API de la personnalité de Yuki — `node:http`, aucun framework.
 *
 * Routes :
 *   GET  /api/self/personality         → contenu effectif + borne + historique
 *   PUT  /api/self/personality         → remplace le contenu (source « user »)
 *   POST /api/self/personality/revert  → restaure la version précédente
 *
 * Les écritures réutilisent les MÊMES garde-fous que `/api/config`
 * (`requireWriteGuards` : en-tête `X-Yuki-Config: 1` + contrôle `Origin`/`Host`).
 */

import type { IncomingHttpHeaders } from "node:http";

import type { PersonalityAdminPort } from "../../personality/index.js";
import type { Logger } from "../../observability/logger.js";
import { requireWriteGuards } from "./config.js";

export interface PersonalityApiDeps {
  store: PersonalityAdminPort;
  logger: Logger;
  now?: () => number;
}

export interface PersonalityHttpResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface PersonalityRequestInput {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
  deps: PersonalityApiDeps;
}

const JSON_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

/** Longueur de l'aperçu d'une version d'historique renvoyé à l'UI. */
const HISTORY_PREVIEW_CHARS = 160;
/** Nombre de versions d'historique renvoyées (aligné sur la borne de rétention). */
const HISTORY_LIMIT = 20;

function json(status: number, body: unknown): PersonalityHttpResponse {
  return { status, body, headers: JSON_HEADERS };
}

/** Vue publique : contenu effectif + borne + historique (aperçus). */
function personalityView(deps: PersonalityApiDeps): Record<string, unknown> {
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

function handleGet(deps: PersonalityApiDeps): PersonalityHttpResponse {
  return json(200, personalityView(deps));
}

function handlePut(input: PersonalityRequestInput): PersonalityHttpResponse {
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
  input.deps.logger.info("personality.saved", {
    changed: result.changed,
    before_chars: result.beforeChars,
    after_chars: result.chars,
    truncated: result.truncated,
  });
  return json(200, {
    ...personalityView(input.deps),
    changed: result.changed,
    truncated: result.truncated,
  });
}

function handleRevert(input: PersonalityRequestInput): PersonalityHttpResponse {
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
  input.deps.logger.info("personality.reverted", {
    before_chars: result.beforeChars,
    after_chars: result.chars,
  });
  return json(200, {
    ...personalityView(input.deps),
    changed: result.changed,
    truncated: result.truncated,
  });
}

/** Vrai si le chemin relève de l'API de personnalité. */
export function isPersonalityPath(path: string): boolean {
  return (
    path === "/api/self/personality" ||
    path.startsWith("/api/self/personality/")
  );
}

/** Traite une requête de personnalité et renvoie la réponse HTTP. */
export function handlePersonalityRequest(
  input: PersonalityRequestInput,
): PersonalityHttpResponse {
  const { method, path } = input;
  if (path === "/api/self/personality") {
    if (method === "GET" || method === "HEAD") return handleGet(input.deps);
    if (method === "PUT") return handlePut(input);
    return json(405, { error: "method_not_allowed", method });
  }
  if (path === "/api/self/personality/revert") {
    if (method === "POST") return handleRevert(input);
    return json(405, { error: "method_not_allowed", method });
  }
  return json(404, { error: "not_found", path });
}
