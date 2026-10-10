// Yuki — CANAL d'approbations pour la page `/config`.
//
// La page de discussion (`/`) possède déjà sa connexion WebSocket et route les
// trames de validation vers la fenêtre flottante. La page `/config` est une
// AUTRE page : elle n'avait aucune connexion temps réel. Ce module ouvre la
// MÊME connexion `/ws` avec le MÊME protocole (aucun second protocole) :
//   - envoie `hello` à l'ouverture ⇒ le serveur renvoie, à la connexion, l'ÉTAT
//     des validations EN ATTENTE (`handleHello` → `sendPendingApprovals`) ;
//   - route les trames de CONTRÔLE `approval` / `approval_cleared` /
//     `approval_result` vers la fenêtre flottante ;
//   - envoie `approval_decision` (Valider / Refuser).
//
// La connexion est RECONNECTÉE automatiquement (redémarrage du gateway), avec
// un délai borné : à chaque reconnexion le serveur ré-émet l'état vivant.

/** Délai minimal / maximal entre deux tentatives de reconnexion (ms). */
const MIN_DELAY_MS = 500;
const MAX_DELAY_MS = 8000;

/** Convertit un message reçu (chaîne, Buffer, ArrayBuffer) en texte UTF-8. */
function rawToString(value) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  if (ArrayBuffer.isView(value)) return new TextDecoder().decode(value);
  return String(value);
}

/**
 * Ouvre un canal d'approbations vers le gateway.
 *
 * @param {object} [options]
 * @param {(approval: object) => void} [options.onApproval]
 * @param {(id: string) => void} [options.onCleared]
 * @param {(result: object) => void} [options.onResult]
 * @param {(code: string, message: string) => void} [options.onError]
 * @param {(status: "online" | "offline") => void} [options.onStatus]
 * @param {string} [options.url] URL explicite (sinon `/ws` sur l'hôte courant).
 * @param {typeof WebSocket} [options.WebSocketImpl]
 * @param {Location} [options.location]
 * @returns {{ connect(): void, decide(id: string, decision: "approve" | "deny"): boolean, isOpen(): boolean, close(): void }}
 */
export function createApprovalChannel(options = {}) {
  const onApproval = options.onApproval ?? (() => undefined);
  const onCleared = options.onCleared ?? (() => undefined);
  const onResult = options.onResult ?? (() => undefined);
  const onError = options.onError ?? (() => undefined);
  const onStatus = options.onStatus ?? (() => undefined);
  const WebSocketImpl =
    options.WebSocketImpl ??
    (typeof globalThis.WebSocket !== "undefined" ? globalThis.WebSocket : undefined);
  const loc =
    options.location ??
    (typeof globalThis.location !== "undefined" ? globalThis.location : undefined);
  const OPEN = WebSocketImpl?.OPEN ?? 1;

  let socket = null;
  let closed = false;
  let attempt = 0;
  let timer = null;

  function resolveUrl() {
    if (options.url) return options.url;
    const proto = loc && loc.protocol === "https:" ? "wss:" : "ws:";
    const host = loc ? loc.host : "";
    return `${proto}//${host}/ws`;
  }

  function bind(target, type, handler) {
    if (typeof target.addEventListener === "function") target.addEventListener(type, handler);
    else if (typeof target.on === "function") target.on(type, handler);
  }

  function handleFrame(text) {
    let frame;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    if (!frame || typeof frame !== "object") return;
    switch (frame.type) {
      case "approval":
        onApproval(frame.approval);
        return;
      case "approval_cleared":
        onCleared(String(frame.id));
        return;
      case "approval_result":
        onResult(frame.result);
        return;
      case "error":
        if (typeof frame.code === "string" && frame.code.startsWith("approval")) {
          onError(frame.code, frame.message ?? "");
        }
        return;
      default:
        return;
    }
  }

  function send(payload) {
    if (!socket || socket.readyState !== OPEN) return false;
    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  function scheduleReconnect() {
    if (closed || timer !== null) return;
    const delay = Math.min(MAX_DELAY_MS, MIN_DELAY_MS * 2 ** attempt);
    attempt += 1;
    timer = setTimeout(() => {
      timer = null;
      connect();
    }, delay);
  }

  function connect() {
    if (closed) return;
    if (!WebSocketImpl) return;
    if (socket && socket.readyState !== 3 /* CLOSED */) return;
    let next;
    try {
      next = new WebSocketImpl(resolveUrl());
    } catch {
      scheduleReconnect();
      return;
    }
    socket = next;
    bind(next, "open", () => {
      attempt = 0;
      onStatus("online");
      send({ type: "hello", clientVersion: "1" });
    });
    bind(next, "message", (event) => {
      const data = event && typeof event === "object" && "data" in event ? event.data : event;
      handleFrame(rawToString(data));
    });
    bind(next, "close", () => {
      if (socket === next) socket = null;
      onStatus("offline");
      scheduleReconnect();
    });
    bind(next, "error", () => {
      /* la fermeture suit : la reconnexion est gérée par `close`. */
    });
  }

  return {
    connect,
    decide(id, decision) {
      return send({ type: "approval_decision", id, decision });
    },
    isOpen() {
      return Boolean(socket && socket.readyState === OPEN);
    },
    close() {
      closed = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      const current = socket;
      socket = null;
      try {
        current?.close();
      } catch {
        /* déjà fermé. */
      }
    },
  };
}
