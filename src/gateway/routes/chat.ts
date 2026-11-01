/**
 * API des DISCUSSIONS (lot 18) — `node:http`, aucun framework.
 *
 * Routes (TOUTES gardées par l'en-tête maison `X-Yuki-Config: 1`, comme `/api/config` :
 * `requireWriteGuards`, qui contrôle aussi `Origin`/`Host` quand ils sont présents) :
 *   GET   /api/chat/status                  → mode, état, capacités, état Mattermost
 *   PUT   /api/chat/mattermost             → { baseUrl } : URL du serveur
 *   POST  /api/chat/mattermost/jeton       → { jeton } : écrit le jeton dans le coffre,
 *                                            ⚠️ affiché UNE SEULE FOIS, jamais relu
 *   POST  /api/chat/mattermost/connexion   → démarre la synchronisation
 *   PATCH /api/chat/conversations/<id>     → { replyMode } par canal (`tout`/`auto`/`mention`)
 *
 * ⚠️ POURQUOI LA LECTURE EST GARDÉE AUSSI : la réponse dit QUEL mode est actif, QUELLES
 * URL et canaux sont suivis, et POURQUOI une plateforme est éteinte. Ce n'est pas un
 * secret, mais c'est un état d'installation — une page tierce n'a aucune raison de
 * pouvoir le sonder, et l'interface same-origin pose l'en-tête sans effort.
 *
 * ⚠️ AUCUNE réponse ne porte un jeton : `jetonEnregistre` est un BOOLÉEN, jamais la
 * valeur, jamais un préfixe. Le jeton n'est accepté qu'en écriture, une fois.
 */

import type { IncomingHttpHeaders } from "node:http";

import type {
  ChatAdapterStatus,
  ChatReplyMode,
  ChatService,
  ChatStatusView,
  ChatSyncStatus,
} from "../../chat/index.js";
import { requireWriteGuards } from "./config.js";

/** Canal suivi, tel que la page `/config` doit le montrer. */
export interface ChatMattermostChannelView {
  /** Identifiant Yuki (`mm-…`). */
  id: string;
  /** Nom du canal. */
  titre: string;
  messageCount: number;
  replyMode?: ChatReplyMode;
  /** `true` quand le backfill initial a été effectué. */
  backfillFait: boolean;
  /** `true` quand la borne a été atteinte : historique antérieur non importé. */
  historiqueAnterieur: boolean;
}

/** État Mattermost exposé à la page `/config` (jamais un jeton). */
export interface ChatMattermostView {
  /** URL du serveur enregistrée (chaîne vide si rien n'est configuré). */
  url: string;
  /** `true` si un jeton est au coffre. ⚠️ Jamais la valeur, jamais un préfixe. */
  jetonEnregistre: boolean;
  /** État de la plateforme (badge ●/◐/○ et raison lisible). */
  plateforme: ChatAdapterStatus;
  /** Avancement de la synchronisation (canaux, backfill, dernière erreur). */
  synchronisation: ChatSyncStatus;
  /** Canaux suivis. */
  canaux: ChatMattermostChannelView[];
}

/**
 * Port Mattermost consommé par les routes.
 *
 * ⚠️ Le transport HTTP ne connaît ni client REST, ni WebSocket, ni coffre : il demande,
 * et le câblage (`src/index.ts`) exécute. C'est ce qui garde ce fichier testable sans
 * réseau.
 */
export interface ChatMattermostPort {
  /** URL enregistrée. */
  baseUrl(): string;
  /** Un jeton est-il au coffre ? (jamais la valeur) */
  tokenConfigured(): boolean;
  /** Enregistre l'URL (déjà validée par l'appelant). */
  saveBaseUrl(url: string): void;
  /** Enregistre le jeton dans le coffre (chiffré). */
  saveToken(token: string): void;
  /** Démarre la synchronisation (identité, canaux, backfill, temps réel, rattrapage). */
  connect(): Promise<void>;
  /** État Mattermost complet (voir `view`). */
  view(): ChatMattermostView;
  /** Mode de réponse d'un canal, ou `undefined`. */
  replyMode(conversationId: string): ChatReplyMode | undefined;
  /** Fixe le mode de réponse d'un canal (persisté). */
  setReplyMode(conversationId: string, mode: ChatReplyMode | undefined): boolean;
}

/** Journal minimal de la route (le logger d'observabilité le satisfait). */
export interface ChatApiLogger {
  error(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface ChatApiDeps {
  service: ChatService;
  /** Absent ⇒ Mattermost n'est pas câblé dans ce processus (routes dédiées : 503). */
  mattermost?: ChatMattermostPort;
  /** Journal des échecs d'écriture HTTP (jamais un jeton, jamais une URL complète). */
  logger?: ChatApiLogger;
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
  /** Corps BRUT (chaîne UTF-8) — déjà borné par l'appelant. */
  body?: string;
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

/** Corps JSON validé (un corps illisible rend `null`, jamais une exception). */
function parseBody(body: string | undefined): Record<string, unknown> | null {
  if (typeof body !== "string" || body.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Vue complète servie par `GET /api/chat/status`. */
export interface ChatStatusResponse extends ChatStatusView {
  /** État Mattermost (absent quand la plateforme n'est pas câblée). */
  mattermost?: ChatMattermostView;
}

/**
 * Traite une requête de l'API des discussions.
 *
 * @returns la réponse à écrire ; `404` pour tout chemin inconnu.
 */
export async function handleChatRequest(input: ChatRequestInput): Promise<ChatHttpResponse> {
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
    const view: ChatStatusResponse = deps.service.status();
    if (deps.mattermost) view.mattermost = deps.mattermost.view();
    return json(200, view);
  }

  if (path === "/api/chat/mattermost") {
    if (verb !== "PUT") {
      return json(405, {
        error: "method_not_allowed",
        message: "Utilisez PUT pour enregistrer l'URL du serveur Mattermost.",
      });
    }
    const port = deps.mattermost;
    if (!port) return notWired();
    const body = parseBody(input.body);
    if (!body || typeof body.baseUrl !== "string") {
      return json(400, {
        error: "bad_request",
        message: "Indiquez l'URL du serveur Mattermost (`{\"baseUrl\": \"https://…\"}`).",
      });
    }
    const raw = body.baseUrl.trim();
    if (raw !== "") {
      let parsed: URL;
      try {
        parsed = new URL(raw);
      } catch {
        return json(400, {
          error: "bad_base_url",
          message:
            "Cette adresse n'est pas une URL valide. Exemple attendu : https://mattermost.exemple.fr",
        });
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return json(400, {
          error: "bad_base_url",
          message: "L'URL du serveur Mattermost doit commencer par http:// ou https://.",
        });
      }
    }
    port.saveBaseUrl(raw);
    return json(200, { ok: true, mattermost: port.view() });
  }

  if (path === "/api/chat/mattermost/jeton") {
    if (verb !== "POST") {
      return json(405, {
        error: "method_not_allowed",
        message: "Utilisez POST pour enregistrer le jeton du bot Mattermost.",
      });
    }
    const port = deps.mattermost;
    if (!port) return notWired();
    const body = parseBody(input.body);
    const token = body && typeof body.jeton === "string" ? body.jeton.trim() : "";
    if (token === "") {
      return json(400, {
        error: "bad_request",
        message: "Le jeton du bot est vide : copiez-le depuis Mattermost.",
      });
    }
    port.saveToken(token);
    // ⚠️ La réponse ne renvoie JAMAIS le jeton : il est enregistré, c'est tout. La page
    // affiche « jeton enregistré » et n'a plus aucun moyen de le relire.
    return json(200, { ok: true, jetonEnregistre: true });
  }

  if (path === "/api/chat/mattermost/connexion") {
    if (verb !== "POST") {
      return json(405, {
        error: "method_not_allowed",
        message: "Utilisez POST pour lancer la connexion à Mattermost.",
      });
    }
    const port = deps.mattermost;
    if (!port) return notWired();
    const body = parseBody(input.body);
    // L'URL peut être fournie dans le même geste (bouton « Se connecter » du formulaire).
    if (body && typeof body.baseUrl === "string" && body.baseUrl.trim() !== "") {
      port.saveBaseUrl(body.baseUrl.trim());
    }
    if (body && typeof body.jeton === "string" && body.jeton.trim() !== "") {
      port.saveToken(body.jeton.trim());
    }
    if (!port.tokenConfigured()) {
      return json(400, {
        error: "jeton_absent",
        message:
          "Aucun jeton Mattermost n'est enregistré : saisissez-le une fois (il n'est " +
          "plus jamais réaffiché) avant de vous connecter.",
      });
    }
    if (port.baseUrl() === "") {
      return json(400, {
        error: "url_absente",
        message: "L'URL du serveur Mattermost n'est pas renseignée.",
      });
    }
    try {
      await port.connect();
    } catch (error) {
      return json(502, {
        error: "connexion_impossible",
        message:
          "La connexion à Mattermost a échoué : " +
          (error instanceof Error ? error.message : String(error)),
      });
    }
    return json(200, { ok: true, mattermost: port.view() });
  }

  const conversationMatch = /^\/api\/chat\/conversations\/([^/]+)$/.exec(path);
  if (conversationMatch) {
    if (verb !== "PATCH") {
      return json(405, {
        error: "method_not_allowed",
        message: "Utilisez PATCH pour changer le mode de réponse d'un canal.",
      });
    }
    const port = deps.mattermost;
    if (!port) return notWired();
    const conversationId = decodeURIComponent(conversationMatch[1] ?? "");
    const body = parseBody(input.body);
    const mode = body ? normalizeMode(body.replyMode) : undefined;
    if (body === null || (body.replyMode !== undefined && mode === undefined)) {
      return json(400, {
        error: "bad_request",
        message:
          "Mode de réponse inconnu : utilisez « tout », « auto » ou « mention » " +
          "(ou `null` pour revenir au défaut).",
      });
    }
    const applied = port.setReplyMode(conversationId, mode);
    if (!applied) {
      return json(404, {
        error: "conversation_inconnue",
        message: "Ce canal n'est pas (encore) synchronisé : son mode de réponse est sans objet.",
      });
    }
    return json(200, {
      ok: true,
      conversationId,
      ...(mode !== undefined ? { replyMode: mode } : {}),
      mattermost: port.view(),
    });
  }

  return json(404, {
    error: "not_found",
    message: "Route de discussion inconnue.",
  });
}

/** Mode de réponse validé (`tout` | `auto` | `mention`), ou `undefined`. */
function normalizeMode(value: unknown): ChatReplyMode | undefined {
  return value === "tout" || value === "auto" || value === "mention" ? value : undefined;
}

/** Réponse quand Mattermost n'est pas câblé dans ce processus. */
function notWired(): ChatHttpResponse {
  return json(503, {
    error: "chat_unavailable",
    message:
      "La connexion Mattermost n'est pas câblée dans ce processus : redémarrez Yuki.",
  });
}
