/**
 * Routes de l'AVATAR de Yuki.
 *
 *  - `GET    /avatar`            sert l'image (`?v=<sha court>` sert à invalider
 *                                le cache ; le contenu ne change pas selon `v`) ;
 *  - `GET    /api/avatar`        métadonnées `{ existe, sha256, updatedAt, taille }` ;
 *  - `POST   /api/avatar`        téléversement (en-tête `X-Yuki-Config: 1`),
 *                                corps = octets BRUTS de l'image ;
 *  - `DELETE /api/avatar`        retire l'avatar (retour au flocon) ;
 *  - `GET    /favicon.ico`       l'avatar s'il existe, sinon l'icône PWA.
 *
 * ⚠️ Aucune CSP n'est élargie : `img-src 'self'` couvre déjà `/avatar`,
 * `/favicon.ico` et `/ui/icons/icon-192.png`. Aucun `blob:` n'est utilisé.
 *
 * ⚠️ Le type de l'image est déduit des OCTETS (signature), jamais du
 * `Content-Type` : un `.txt` renommé `.png` est refusé (`unsupported_format`).
 */

import type { IncomingHttpHeaders } from "node:http";

import {
  AvatarRefusal,
  AVATAR_MAX_BYTES,
  type AvatarStorePort,
  type AvatarStatus,
} from "../../identity/avatar.js";
import type { Logger } from "../../observability/logger.js";
import { requireWriteGuards, type ConfigHttpResponse } from "./config.js";
import { STATIC_SECURITY_HEADERS } from "./static.js";

/** Chemin du service de l'image d'avatar. */
export const AVATAR_SERVE_PATH = "/avatar";
/** Chemin de l'API de l'avatar. */
export const AVATAR_API_PATH = "/api/avatar";
/** Chemin que beaucoup de navigateurs demandent d'eux-mêmes. */
export const FAVICON_PATH = "/favicon.ico";

/** Repli du favicon quand aucun avatar n'est défini (icône PWA livrée). */
export const FAVICON_FALLBACK_PATH = "/ui/icons/icon-192.png";

export interface AvatarApiDeps {
  store: AvatarStorePort;
  logger?: Logger;
}

/** Réponse binaire (service same-origin). */
export interface AvatarServeResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer | string;
}

/** Vrai si le chemin relève du SERVICE de l'image. */
export function isAvatarServePath(path: string): boolean {
  return path === AVATAR_SERVE_PATH;
}

/** Vrai si le chemin relève de l'API. */
export function isAvatarApiPath(path: string): boolean {
  return path === AVATAR_API_PATH;
}

/** Vrai si le chemin est le favicon. */
export function isFaviconPath(path: string): boolean {
  return path === FAVICON_PATH;
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

function notFound(message: string): AvatarServeResponse {
  return {
    status: 404,
    headers: {
      ...STATIC_SECURITY_HEADERS,
      "content-type": "text/plain; charset=utf-8",
      // Un 404 ne doit jamais être mis en cache « immuable » : dès qu'un
      // avatar est déposé, l'URL doit redevenir servable.
      "cache-control": "no-store",
    },
    body: message,
  };
}

/**
 * Sert l'image de l'avatar. `?v=` est ignoré côté contenu (il n'est là que
 * pour changer l'URL et donc forcer le navigateur à revalider) : la même
 * requête, avec ou sans `v`, rend les MÊMES octets.
 */
export function handleAvatarServeRequest(input: {
  method: string;
  deps: AvatarApiDeps;
}): AvatarServeResponse {
  if (input.method !== "GET" && input.method !== "HEAD") {
    return {
      status: 405,
      headers: {
        ...STATIC_SECURITY_HEADERS,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ error: "method_not_allowed", method: input.method }),
    };
  }
  const meta = input.deps.store.lire();
  const bytes = meta ? input.deps.store.octets() : null;
  if (!meta || !bytes) {
    return notFound("Not Found\n");
  }
  return {
    status: 200,
    headers: {
      ...STATIC_SECURITY_HEADERS,
      "content-type": meta.mime,
      "content-length": String(bytes.byteLength),
      // L'URL change avec `?v=<sha>` à chaque nouvel avatar : le contenu d'une
      // URL donnée est donc immuable.
      "cache-control": "public, max-age=31536000, immutable",
    },
    body: bytes,
  };
}

/** Refus métier → réponse HTTP explicite (jamais un code nu). */
function refus(reason: AvatarRefusal): ConfigHttpResponse {
  const status = reason.code === "too_large" ? 413 : 400;
  return json(status, {
    error: reason.code,
    code: reason.code,
    message: reason.message,
    maxBytes: AVATAR_MAX_BYTES,
  });
}

/** Traite `GET/POST/DELETE /api/avatar`. */
export function handleAvatarApiRequest(input: {
  method: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
  deps: AvatarApiDeps;
}): ConfigHttpResponse {
  const { method, deps } = input;

  if (method === "GET" || method === "HEAD") {
    const statut: AvatarStatus = deps.store.statut();
    return json(200, statut);
  }

  if (method === "POST") {
    const guard = requireWriteGuards(input.headers);
    if (guard) return guard;
    try {
      const meta = deps.store.ecrire(input.body);
      deps.logger?.info("avatar.enregistre", {
        sha256: meta.sha256.slice(0, 12),
        bytes: meta.bytes,
        largeur: meta.largeur,
        hauteur: meta.hauteur,
        mime: meta.mime,
      });
      return json(200, { ok: true, ...deps.store.statut() });
    } catch (error) {
      if (error instanceof AvatarRefusal) {
        deps.logger?.warn("avatar.refuse", { code: error.code });
        return refus(error);
      }
      throw error;
    }
  }

  if (method === "DELETE") {
    const guard = requireWriteGuards(input.headers);
    if (guard) return guard;
    const retire = deps.store.supprimer();
    if (retire) deps.logger?.info("avatar.retire", {});
    return json(200, { ok: true, existe: false, retire });
  }

  return json(405, { error: "method_not_allowed", method });
}

/**
 * Sert `/favicon.ico` : l'avatar s'il existe, sinon l'icône PWA livrée.
 *
 * Le repli est fourni par l'appelant (`resolveStaticRequest`), qui garantit le
 * garde-fou anti-traversée ; `null` ⇒ 404 (aucun avatar ET aucune icône).
 */
export function handleFaviconRequest(input: {
  method: string;
  deps: AvatarApiDeps;
  fallback: { body: Buffer | string; headers: Record<string, string> } | null;
}): AvatarServeResponse {
  if (input.method !== "GET" && input.method !== "HEAD") {
    return {
      status: 405,
      headers: {
        ...STATIC_SECURITY_HEADERS,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ error: "method_not_allowed", method: input.method }),
    };
  }
  const meta = input.deps.store.lire();
  const bytes = meta ? input.deps.store.octets() : null;
  if (meta && bytes) {
    return {
      status: 200,
      headers: {
        ...STATIC_SECURITY_HEADERS,
        "content-type": meta.mime,
        "content-length": String(bytes.byteLength),
        // Le favicon change quand l'avatar change : on laisse le navigateur
        // revalider (l'UI pose `?v=<sha>` pour forcer la mise à jour).
        "cache-control": "no-cache",
      },
      body: bytes,
    };
  }
  if (!input.fallback) return notFound("Not Found\n");
  return {
    status: 200,
    headers: {
      ...STATIC_SECURITY_HEADERS,
      ...input.fallback.headers,
      "cache-control": "no-cache",
    },
    body: input.fallback.body,
  };
}
