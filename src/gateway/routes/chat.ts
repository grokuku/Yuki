/**
 * API des DISCUSSIONS (lot 18) — `node:http`, aucun framework.
 *
 * Route unique (lot 1) :
 *   GET /api/chat/status → { mode, plateforme: { etat, raison?, dernierContact? },
 *                            creation: { autorisee, raison? } }
 *
 * ⚠️ Lecture GARDÉE, comme `/api/config` et `/api/sources` : en-tête maison
 * `X-Yuki-Config: 1` (`requireWriteGuards`, qui contrôle aussi `Origin`/`Host`
 * quand ils sont présents). JUSTIFICATION : la réponse dit QUEL mode est actif
 * et POURQUOI une plateforme est éteinte. Ce n'est certes pas un secret, mais
 * c'est un état d'installation — une page tierce n'a aucune raison de pouvoir
 * le sonder, et l'interface same-origin, elle, pose l'en-tête sans effort.
 *
 * ⚠️ La réponse ne porte JAMAIS un jeton, une URL d'API ni un secret : seulement
 * un mode, un état et des phrases.
 */

import type { IncomingHttpHeaders } from "node:http";

import type { ChatService, ChatStatusView } from "../../chat/index.js";
import { requireWriteGuards } from "./config.js";

export interface ChatApiDeps {
  service: ChatService;
}

export interface ChatHttpResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface ChatRequestInput {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  deps: ChatApiDeps;
}

/** Réponses JSON systématiquement non mises en cache (état vivant). */
const JSON_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function json(status: number, body: unknown): ChatHttpResponse {
  return { status, body, headers: JSON_HEADERS };
}

/** Toute l'API de discussion vit sous ce préfixe. */
export function isChatApiPath(path: string): boolean {
  return path === "/api/chat" || path.startsWith("/api/chat/");
}

/**
 * Traite une requête de l'API des discussions.
 *
 * @returns la réponse à écrire ; `404` pour tout chemin inconnu.
 */
export function handleChatRequest(input: ChatRequestInput): ChatHttpResponse {
  const { method, path, headers, deps } = input;
  const verb = method.toUpperCase();

  // Garde de LECTURE : même en-tête que les écritures de configuration.
  const refused = requireWriteGuards(headers);
  if (refused) return { status: refused.status, body: refused.body, headers: JSON_HEADERS };

  if (path === "/api/chat/status") {
    if (verb !== "GET" && verb !== "HEAD") {
      return json(405, {
        error: "method_not_allowed",
        message: "Seule la lecture est disponible sur cette route.",
      });
    }
    const view: ChatStatusView = deps.service.status();
    return json(200, view);
  }

  return json(404, {
    error: "not_found",
    message: "Route de discussion inconnue.",
  });
}
