/* Yuki — Service Worker (PWA + Web Push).
 *
 * Il ne met RIEN en cache : la PWA est « installable » et reçoit des
 * notifications, mais l'interface reste servie par le gateway (toujours fraîche,
 * jamais une version périmée). Aucun `fetch` intercepté — donc aucun risque de
 * servir une coquille obsolète.
 *
 * Reçoit les notifications PUSH (charge utile chiffrée aes128gcm, RFC 8291) et
 * les affiche. Un clic RAMÈNE à la conversation concernée (même onglet si un
 * client same-origin est déjà ouvert, sinon nouvel onglet).
 *
 * Servi à la RACINE (`/sw.js`) : sa portée couvre donc `/` et `/config`.
 */

const DEFAULT_TITLE = "Yuki";
const DEFAULT_BODY = "Nouvel événement.";

self.addEventListener("install", (event) => {
  // Active immédiatement le nouveau worker (pas d'attente d'un rechargement).
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  // Prend la main sur les onglets déjà ouverts.
  event.waitUntil(self.clients.claim());
});

/** Extrait le contenu utile d'une charge utile push (défensif). */
function readPayload(event) {
  if (!event.data) return { title: DEFAULT_TITLE, body: DEFAULT_BODY, tag: "yuki", data: { url: "/" } };
  try {
    const parsed = event.data.json();
    if (parsed && typeof parsed === "object") {
      return {
        title: typeof parsed.title === "string" && parsed.title ? parsed.title : DEFAULT_TITLE,
        body: typeof parsed.body === "string" && parsed.body ? parsed.body : DEFAULT_BODY,
        tag: typeof parsed.tag === "string" && parsed.tag ? parsed.tag : "yuki",
        data: parsed.data && typeof parsed.data === "object" ? parsed.data : { url: "/" },
      };
    }
  } catch {
    // Charge utile non JSON : on affiche le texte brut s'il existe.
    try {
      const text = event.data.text();
      if (text) return { title: DEFAULT_TITLE, body: text, tag: "yuki", data: { url: "/" } };
    } catch {
      // ignore : repli générique ci-dessous
    }
  }
  return { title: DEFAULT_TITLE, body: DEFAULT_BODY, tag: "yuki", data: { url: "/" } };
}

self.addEventListener("push", (event) => {
  const payload = readPayload(event);
  const url = typeof payload.data.url === "string" ? payload.data.url : "/";
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag,
      data: { url },
      icon: "/ui/icons/icon-192.png",
      badge: "/ui/icons/icon-192.png",
      lang: "fr",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const rawUrl = event.notification.data && event.notification.data.url;
  const target = new URL(typeof rawUrl === "string" ? rawUrl : "/", self.location.origin);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        let sameOrigin = false;
        try {
          sameOrigin = new URL(client.url).origin === target.origin;
        } catch {
          sameOrigin = false;
        }
        if (!sameOrigin) continue;
        await client.focus();
        if (client.url !== target.href && typeof client.navigate === "function") {
          try {
            await client.navigate(target.href);
          } catch {
            // Navigation refusée (rare) : l'onglet est déjà au premier plan.
          }
        }
        return;
      }
      await self.clients.openWindow(target.href);
    })(),
  );
});
