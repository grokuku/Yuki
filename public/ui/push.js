// Yuki — Notifications (PWA + Web Push côté NAVIGATEUR).
//
// Ce module ne fait que trois choses, toutes à la demande de l'utilisateur :
//   1. enregistrer le service worker (`/sw.js`, MÊME ORIGINE) ;
//   2. demander la permission et S'ABONNER/désabonner (`pushManager`) ;
//   3. déclarer la PRÉSENCE (onglet visible / fenêtre focalisée) au serveur, qui
//      décide ainsi de NE PAS notifier quand l'utilisateur regarde déjà.
//
// Aucune donnée technique (endpoint/clés) n'est écrite dans le fil : elle part
// uniquement vers `/api/push/subscribe` (données de service).
//
// ⚠️ La clé VAPID PUBLIQUE est récupérée du serveur ; la clé privée ne quitte
// jamais le serveur.

const DEVICE_STORAGE_KEY = "yuki-push-device";
const WRITE_HEADERS = { "x-yuki-config": "1" };

/** `true` si le navigateur expose tout ce qu'il faut pour le Web Push. */
export function isPushSupported() {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** Enregistre le service worker (idempotent). Renvoie l'inscription ou `null`. */
export async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  } catch (error) {
    console.warn("[push] enregistrement du service worker impossible", error);
    return null;
  }
}

/** Identifiant d'appareil STABLE (généré une fois, conservé localement). */
export function deviceId() {
  let id = null;
  try {
    id = window.localStorage.getItem(DEVICE_STORAGE_KEY);
  } catch {
    id = null;
  }
  if (!id || !/^[A-Za-z0-9._:-]{6,128}$/.test(id)) {
    id = `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    try {
      window.localStorage.setItem(DEVICE_STORAGE_KEY, id);
    } catch {
      // Stockage indisponible : l'identifiant reste valable pour la session.
    }
  }
  return id;
}

/** Convertit une clé VAPID base64url en octets (format `applicationServerKey`). */
export function urlBase64ToUint8Array(base64Url) {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/** État de service côté serveur (clé publique, activation, appareils). */
export async function fetchStatus() {
  const response = await fetch("/api/push/status", {
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/** Écrit un réglage de configuration (`push.enabled`…). */
async function putConfig(patch) {
  const response = await fetch("/api/config", {
    method: "PUT",
    headers: { "content-type": "application/json", ...WRITE_HEADERS },
    body: JSON.stringify(patch),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.message || `HTTP ${response.status}`);
  }
  return response.json();
}

/** Abonnement navigateur courant (ou `null`). */
export async function currentSubscription() {
  if (!isPushSupported()) return null;
  try {
    const registration = await navigator.serviceWorker.ready;
    return await registration.pushManager.getSubscription();
  } catch {
    return null;
  }
}

/**
 * Demande la permission, s'abonne au service de push et enregistre l'abonnement
 * côté serveur. Active `push.enabled` (l'intention de l'utilisateur).
 * Lève une erreur explicite (français) en cas d'échec.
 */
export async function subscribe() {
  if (!isPushSupported()) throw new Error("Ce navigateur ne gère pas les notifications.");
  const registration = await navigator.serviceWorker.ready;
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error(
      "Notifications refusées par le navigateur. Autorisez-les dans les réglages du site, puis réessayez.",
    );
  }
  const status = await fetchStatus();
  if (!status || typeof status.publicKey !== "string" || status.publicKey.length === 0) {
    throw new Error("Clé publique de notification indisponible côté serveur.");
  }
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(status.publicKey),
    });
  }
  const json = subscription.toJSON();
  const response = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json", ...WRITE_HEADERS },
    body: JSON.stringify({
      deviceId: deviceId(),
      subscription: { endpoint: json.endpoint, keys: json.keys },
      label: (navigator.userAgent || "").slice(0, 120),
    }),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.message || `Enregistrement refusé (HTTP ${response.status}).`);
  }
  // L'intention est explicite : le service doit être actif.
  await putConfig({ "push.enabled": "on" });
  return true;
}

/**
 * Désabonne CET appareil : retire l'abonnement serveur puis celui du navigateur.
 * Le réglage global (`push.enabled`) n'est PAS touché : les autres appareils
 * continuent de recevoir leurs notifications.
 */
export async function unsubscribe() {
  const id = deviceId();
  try {
    await fetch("/api/push/unsubscribe", {
      method: "POST",
      headers: { "content-type": "application/json", ...WRITE_HEADERS },
      body: JSON.stringify({ deviceId: id }),
    });
  } catch {
    // Le retrait serveur peut échouer (hors ligne) : on retire quand même
    // l'abonnement navigateur — sinon l'utilisateur croirait ne plus recevoir.
  }
  const subscription = await currentSubscription();
  if (subscription) {
    try {
      await subscription.unsubscribe();
    } catch {
      // Idem : meilleur effort.
    }
  }
  return true;
}

/**
 * Déclare la présence au serveur. À appeler à la connexion ET à chaque
 * changement (onglet/ fenêtre). Renvoie la fonction `send` (utile après `hello`).
 */
export function initPresenceTracking(sendRaw) {
  const send = () => {
    const payload = {
      type: "presence",
      visible: !document.hidden,
      focused: document.hasFocus(),
    };
    if (typeof sendRaw === "function") sendRaw(payload);
  };
  document.addEventListener("visibilitychange", send);
  window.addEventListener("focus", send);
  window.addEventListener("blur", send);
  return send;
}

/**
 * Contrôle de topbar : un bouton qui active/désactive les notifications de CET
 * appareil. Ne fait rien sans geste utilisateur (la permission est demandée au
 * clic). L'état affiché reflète la RÉALITÉ (abonnement navigateur), jamais une
 * supposition.
 */
export function createNotificationsControl({ button, onError }) {
  if (!button) return { refresh: async () => {} };
  let busy = false;

  async function refresh() {
    if (!isPushSupported()) {
      button.hidden = true;
      return;
    }
    button.hidden = false;
    const subscription = await currentSubscription();
    const on = Boolean(subscription) && Notification.permission === "granted";
    button.setAttribute("aria-pressed", String(on));
    button.classList.toggle("notif-toggle--on", on);
    button.classList.toggle("notif-toggle--off", !on);
    button.textContent = on ? "Notifications activées" : "Activer les notifications";
    button.setAttribute(
      "aria-label",
      on ? "Désactiver les notifications sur cet appareil" : "Activer les notifications sur cet appareil",
    );
  }

  button.addEventListener("click", () => {
    if (busy) return;
    busy = true;
    button.disabled = true;
    const action = button.getAttribute("aria-pressed") === "true" ? unsubscribe : subscribe;
    action()
      .catch((error) => {
        if (typeof onError === "function") onError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        busy = false;
        button.disabled = false;
        void refresh();
      });
  });

  return { refresh };
}
