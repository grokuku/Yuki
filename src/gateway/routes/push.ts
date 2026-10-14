/**
 * API des notifications (PWA + Web Push) — `node:http`, aucun framework.
 *
 * Routes :
 *   GET  /api/push/status       → état (activation, clé PUBLIQUE VAPID, appareils)
 *   POST /api/push/subscribe    → enregistre/remplace l'abonnement d'un appareil
 *   POST /api/push/unsubscribe  → retire l'abonnement d'un appareil
 *
 * ⚠️ La clé PRIVÉE VAPID n'apparaît dans AUCUNE réponse : seule la clé publique
 * (par nature publique, `applicationServerKey`) est exposée, et jamais le
 * `p256dh`/`auth` d'un abonnement (capacités d'envoi vers un appareil).
 *
 * Garde-fous d'écriture : mêmes que `/api/config` (en-tête `X-Yuki-Config: 1`
 * + contrôle d'origine), appliqués par `requireWriteGuards`.
 */

import type { IncomingHttpHeaders } from "node:http";

import type { Logger } from "../../observability/logger.js";
import {
  isValidDeviceId,
  PushSubscriptionStore,
  type PushSubscribeInput,
} from "../../push/index.js";
import { requireWriteGuards } from "./config.js";

export interface PushApiDeps {
  store: PushSubscriptionStore;
  logger: Logger;
  /** Activation courante (`push.enabled === "on"`), relue à chaque appel. */
  enabled: () => boolean;
  /** Clé publique VAPID (base64url) — jamais la privée. */
  publicKey: string;
}

export interface PushHttpResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface PushRequestInput {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
  deps: PushApiDeps;
}

const JSON_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function json(status: number, body: unknown): PushHttpResponse {
  return { status, body, headers: JSON_HEADERS };
}

/** Chemin de l'API push (normalisé, sans barre finale). */
export function isPushPath(path: string): boolean {
  return (
    path === "/api/push/status" ||
    path === "/api/push/subscribe" ||
    path === "/api/push/unsubscribe"
  );
}

const MAX_ENDPOINT_CHARS = 2048;
const MAX_KEY_CHARS = 512;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Extrait l'hôte d'un endpoint (affichage) sans révéler son chemin. */
function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "?";
  }
}

/** Valide et normalise le corps d'un abonnement. */
function parseSubscribeBody(body: string): { ok: true; input: PushSubscribeInput } | { ok: false; message: string } {
  let parsed: unknown;
  try {
    parsed = body.trim() === "" ? null : JSON.parse(body);
  } catch {
    return { ok: false, message: "Corps JSON invalide." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, message: "Objet JSON attendu." };
  }
  const record = parsed as Record<string, unknown>;
  if (!isValidDeviceId(record.deviceId)) {
    return { ok: false, message: "Identifiant d'appareil invalide." };
  }
  const subscription = record.subscription;
  if (!subscription || typeof subscription !== "object" || Array.isArray(subscription)) {
    return { ok: false, message: "Abonnement manquant." };
  }
  const sub = subscription as Record<string, unknown>;
  const endpoint = sub.endpoint;
  if (typeof endpoint !== "string" || endpoint.length === 0 || endpoint.length > MAX_ENDPOINT_CHARS) {
    return { ok: false, message: "Endpoint invalide." };
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { ok: false, message: "Endpoint illisible." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, message: "Endpoint : schéma http(s) attendu." };
  }
  const keys = sub.keys;
  if (!keys || typeof keys !== "object" || Array.isArray(keys)) {
    return { ok: false, message: "Clés d'abonnement manquantes." };
  }
  const keyRecord = keys as Record<string, unknown>;
  const p256dh = keyRecord.p256dh;
  const auth = keyRecord.auth;
  if (
    typeof p256dh !== "string" ||
    p256dh.length === 0 ||
    p256dh.length > MAX_KEY_CHARS ||
    !BASE64URL.test(p256dh)
  ) {
    return { ok: false, message: "Clé p256dh invalide." };
  }
  if (
    typeof auth !== "string" ||
    auth.length === 0 ||
    auth.length > MAX_KEY_CHARS ||
    !BASE64URL.test(auth)
  ) {
    return { ok: false, message: "Secret auth invalide." };
  }
  const label = typeof record.label === "string" && record.label.length <= 120 ? record.label : undefined;
  return {
    ok: true,
    input: { deviceId: record.deviceId, endpoint, p256dh, auth, ...(label ? { label } : {}) },
  };
}

function handleStatus(deps: PushApiDeps): PushHttpResponse {
  return json(200, {
    enabled: deps.enabled(),
    publicKey: deps.publicKey,
    deviceCount: deps.store.size,
    // Vue d'EXPLOITATION : l'hôte du service de push et l'horodatage, JAMAIS
    // l'endpoint complet ni les clés de chiffrement.
    devices: deps.store.list().map((record) => ({
      deviceId: record.deviceId,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      host: endpointHost(record.endpoint),
      ...(record.label ? { label: record.label } : {}),
    })),
  });
}

function handleSubscribe(input: PushRequestInput, deps: PushApiDeps): PushHttpResponse {
  const parsed = parseSubscribeBody(input.body);
  if (!parsed.ok) return json(400, { error: "invalid_subscription", message: parsed.message });
  const record = deps.store.upsert(parsed.input);
  deps.logger.info("push.subscription.registered", {
    device: record.deviceId,
    host: endpointHost(record.endpoint),
    deviceCount: deps.store.size,
  });
  return json(200, { ok: true, deviceId: record.deviceId, deviceCount: deps.store.size });
}

function handleUnsubscribe(input: PushRequestInput, deps: PushApiDeps): PushHttpResponse {
  const parsed = parseSubscribeBody(input.body);
  if (!parsed.ok) {
    // Pour le désabonnement, seule l'identité d'appareil est nécessaire : on
    // tolère un corps réduit `{ deviceId }`.
    let deviceId: unknown;
    try {
      deviceId = (JSON.parse(input.body) as { deviceId?: unknown }).deviceId;
    } catch {
      deviceId = undefined;
    }
    if (isValidDeviceId(deviceId)) {
      const removed = deps.store.remove(deviceId);
      deps.logger.info("push.subscription.unregistered", { device: deviceId, removed });
      return json(200, { ok: true, removed, deviceCount: deps.store.size });
    }
    return json(400, { error: "invalid_subscription", message: parsed.message });
  }
  const removed = deps.store.remove(parsed.input.deviceId);
  deps.logger.info("push.subscription.unregistered", {
    device: parsed.input.deviceId,
    removed,
  });
  return json(200, { ok: true, removed, deviceCount: deps.store.size });
}

/** Traite une requête de l'API push. Fonction PURE vis-à-vis des E/S HTTP. */
export function handlePushRequest(input: PushRequestInput): PushHttpResponse {
  const { method, path, deps } = input;

  if (path === "/api/push/status") {
    if (method !== "GET" && method !== "HEAD") {
      return json(405, { error: "method_not_allowed", method });
    }
    return handleStatus(deps);
  }

  const guard = requireWriteGuards(input.headers);
  if (guard) return { status: guard.status, body: guard.body, ...(guard.headers ? { headers: guard.headers } : {}) };

  if (path === "/api/push/subscribe") {
    if (method !== "POST") return json(405, { error: "method_not_allowed", method });
    return handleSubscribe(input, deps);
  }
  if (path === "/api/push/unsubscribe") {
    if (method !== "POST") return json(405, { error: "method_not_allowed", method });
    return handleUnsubscribe(input, deps);
  }
  return json(404, { error: "not_found", path });
}
