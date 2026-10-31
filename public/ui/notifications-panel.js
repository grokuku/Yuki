/**
 * Section « NOTIFICATIONS » de la page de discussion (`/`).
 *
 * ⚠️ DÉCISION UTILISATEUR : les messages envoyés par une SOURCE (agrégateur de
 * news, client de messagerie, n'importe quel programme branché) ne sont PAS des
 * bulles dans un fil. Ils s'empilent ICI :
 *   - compteur de NON-LUS dans l'en-tête ;
 *   - une entrée = source + heure + titre + ÉTAT (reçu / traité / en échec) ;
 *   - contenu REPLIÉ par défaut (jamais déversé à l'écran) ;
 *   - la RÉPONSE de Yuki est affichée dans la MÊME entrée ;
 *   - bouton « Continuer dans une conversation » — ⚠️ SEUL chemin qui crée/ouvre
 *     un fil ; sans ce clic, aucune conversation n'existe.
 *
 * Routes utilisées (aucune dépendance nouvelle) :
 *   GET    /api/sources/inbox               → entrées + nonLus + limite
 *        ⚠️ LECTURE GARDÉE elle aussi : en-tête `X-Yuki-Config: 1` (même garde que
 *        les mutations — la boîte porte le CONTENU des messages de sources).
 *   POST   /api/sources/inbox/<id>/lu       → marque lue
 *   POST   /api/sources/inbox/lu            → tout marquer lu
 *   POST   /api/sources/inbox/<id>/ouvrir   → crée/ouvre la conversation et y
 *                                             porte l'entrée (renvoie sessionId)
 *   DELETE /api/sources/inbox/<id>          → supprime l'entrée
 *
 * ⚠️ CSP stricte (`style-src 'self'`) : aucun `innerHTML`, aucun attribut `style`
 * — le DOM est bâti avec `createElement` / `textContent`, le CSS vit dans
 * `styles.css`.
 */

/** Rythme de relecture de la boîte (le serveur reste la source de vérité). */
export const POLL_INTERVAL_MS = 15_000;

/**
 * En-tête exigé par TOUTE la section (lecture ET mutations) : même contrat que
 * `/api/config`. ⚠️ La boîte de notifications est aussi protégée en LECTURE.
 */
const WRITE_HEADERS = { accept: "application/json", "x-yuki-config": "1" };

const STATE_LABELS = {
  recu: "reçu",
  traite: "traité",
  echec: "en échec",
  // AVIS DE YUKI (jamais un message reçu) : ex. « ce fil a été supprimé, la source
  // qui y postait passe en nouvelle conversation ».
  alerte: "alerte",
};

function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = value;
    else if (key === "on" && typeof value === "function") el.addEventListener("click", value);
    else if (value === true) el.setAttribute(key, "");
    else if (value !== false && value !== undefined && value !== null) {
      el.setAttribute(key, String(value));
    }
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

function formatDate(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return "taille inconnue";
  if (value < 1024) return `${Math.round(value)} octets`;
  return `~${Math.round(value / 1024)} Ko`;
}

function apiMessage(error, fallback) {
  const data = error?.data ?? {};
  return data.message ?? data.error ?? error?.message ?? fallback;
}

/**
 * Monte la section. `options` fournit les nœuds du markup (aucune sélection
 * interne : le panneau est injectable dans un test de rendu).
 */
export function initSourcesNotifications({
  button,
  count,
  layer,
  panel,
  list,
  summary,
  readAllButton,
  closeButton,
  HolafModal,
  /** Bascule vers la conversation renvoyée par `/ouvrir` (câblé par app.js). */
  onOpenConversation,
  fetchImpl,
}) {
  const state = { entries: [], nonLus: 0, limite: 200, open: false, busy: false };
  const doFetch = fetchImpl ?? ((url, init) => fetch(url, init));

  function updateCounter() {
    if (count) {
      count.textContent = String(state.nonLus);
      count.hidden = state.nonLus === 0;
    }
    if (button) {
      button.setAttribute(
        "aria-label",
        state.nonLus === 0
          ? "Notifications (aucune non lue)"
          : `Notifications (${state.nonLus} non lue${state.nonLus > 1 ? "s" : ""})`,
      );
      button.classList.toggle("has-unread", state.nonLus > 0);
    }
    if (summary) {
      summary.textContent =
        state.nonLus === 0
          ? `${state.entries.length} entrée${state.entries.length > 1 ? "s" : ""} · à jour`
          : `${state.nonLus} non lue${state.nonLus > 1 ? "s" : ""} sur ${state.entries.length}`;
    }
  }

  function buildEntry(entry) {
    const head = h("div", { class: "notif__head" }, [
      h("span", { class: `notif__state notif__state--${entry.etat}`, text: STATE_LABELS[entry.etat] ?? entry.etat }),
      h("span", { class: "notif__source", text: entry.source }),
      h("span", { class: "notif__date", text: formatDate(entry.recu) }),
      entry.titre ? h("span", { class: "notif__title", text: entry.titre }) : null,
      entry.lu ? null : h("span", { class: "notif__unread", text: "non lue" }),
    ]);

    // Contenu REPLIÉ par défaut : <details> natif (aucun style inline).
    // ⚠️ Une ALERTE (avis de Yuki) n'est pas un message reçu : son texte est un
    // AVIS à lire tout de suite, il n'est donc pas replié.
    const alerte = entry.etat === "alerte";
    const content = alerte
      ? h("p", { class: "notif__note", text: entry.texte })
      : h("details", { class: "notif__details" }, [
          h("summary", {
            class: "notif__summary",
            text: `Contenu reçu (${formatBytes(entry.octets)})`,
          }),
          h("pre", { class: "notif__content", text: entry.texte }),
        ]);

    const parts = [head, content];

    // Ce qui s'est passé MALGRÉ TOUT (fil visé disparu, bascule de destination) :
    // affiché AVANT la réponse, et conservé même quand le tour a réussi.
    if (entry.note && entry.note !== "") {
      parts.push(h("p", { class: "notif__note", text: entry.note }));
    }

    // La RÉPONSE de Yuki vit dans la MÊME entrée (jamais une bulle dans un fil).
    if (entry.reponse && entry.reponse !== "") {
      parts.push(
        h("div", { class: "notif__reply" }, [
          h("span", { class: "notif__reply-label", text: "Réponse de Yuki" }),
          h("div", { class: "notif__reply-text", text: entry.reponse }),
        ]),
      );
    } else if (entry.etat === "traite") {
      parts.push(
        h("p", {
          class: "notif__reply-empty",
          text: "Traité par Yuki (aucun texte de réponse).",
        }),
      );
    }

    // Raison EXACTE d'un stockage ou d'un échec (jamais un succès inventé).
    if (entry.raison && entry.raison !== "") {
      parts.push(h("p", { class: "notif__reason", text: entry.raison }));
    }

    const actions = h("div", { class: "notif__actions" });
    // ⚠️ Un AVIS n'a pas de conversation à ouvrir : seul « Supprimer » a un sens.
    if (!alerte && !entry.lu) {
      actions.append(
        h("button", {
          class: "button button--ghost button--small",
          type: "button",
          text: "Marquer comme lue",
          on: () => void markRead(entry.id),
        }),
      );
    }
    if (!alerte) {
      actions.append(
        h("button", {
          class: "button button--ghost button--small",
          type: "button",
          text: entry.conversationOuverte
            ? "Rouvrir la conversation"
            : "Continuer dans une conversation",
          on: () => void openConversation(entry),
        }),
      );
    }
    actions.append(
      h("button", {
        class: "button button--danger button--small",
        type: "button",
        text: "Supprimer",
        on: () => void remove(entry),
      }),
    );
    parts.push(actions);

    return h("article", { class: `notif${entry.lu ? "" : " notif--unread"}`, "data-id": entry.id }, parts);
  }

  function render() {
    if (!list) return;
    list.textContent = "";
    if (state.entries.length === 0) {
      list.append(
        h("p", {
          class: "notifs__empty",
          text:
            "Aucune notification. Les messages envoyés par vos sources (veille, " +
            "messagerie…) s'empileront ici — jamais dans une conversation.",
        }),
      );
    } else {
      for (const entry of state.entries) list.append(buildEntry(entry));
    }
    updateCounter();
  }

  async function refresh() {
    try {
      // ⚠️ La LECTURE exige le même en-tête que les mutations.
      const response = await doFetch("/api/sources/inbox", { headers: WRITE_HEADERS });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      state.entries = Array.isArray(data?.entries) ? data.entries : [];
      state.nonLus = Number.isFinite(data?.nonLus) ? data.nonLus : 0;
      state.limite = Number.isFinite(data?.limite) ? data.limite : 200;
    } catch {
      // La boîte est un CONFORT : une erreur réseau ne casse pas la discussion.
      // On garde l'affichage précédent (aucun écran vide trompeur).
    }
    if (state.open) render();
    else updateCounter();
  }

  async function markRead(id) {
    await doFetch(`/api/sources/inbox/${encodeURIComponent(id)}/lu`, {
      method: "POST",
      headers: WRITE_HEADERS,
    });
    await refresh();
  }

  async function markAllRead() {
    await doFetch("/api/sources/inbox/lu", { method: "POST", headers: WRITE_HEADERS });
    await refresh();
  }

  async function remove(entry) {
    if (HolafModal) {
      const confirmed = await HolafModal.confirm(
        "Supprimer cette notification ?",
        `Le message de « ${entry.source} » sera retiré de la boîte. Cette suppression ` +
          "est définitive et ne touche aucune conversation.",
        { danger: true, confirmText: "Supprimer" },
      );
      if (!confirmed) return;
    }
    await doFetch(`/api/sources/inbox/${encodeURIComponent(entry.id)}`, {
      method: "DELETE",
      headers: WRITE_HEADERS,
    });
    await refresh();
  }

  /**
   * « Continuer dans une conversation » — ⚠️ SEUL endroit qui crée un fil.
   * Le serveur ne le fait QUE sur ce clic ; nous basculons ensuite l'interface
   * vers la conversation renvoyée.
   */
  async function openConversation(entry) {
    if (state.busy) return;
    state.busy = true;
    try {
      const response = await doFetch(
        `/api/sources/inbox/${encodeURIComponent(entry.id)}/ouvrir`,
        { method: "POST", headers: WRITE_HEADERS },
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = data?.message ?? "La conversation n'a pas pu être ouverte.";
        if (HolafModal) await HolafModal.alert("Conversation", message, { okText: "Compris" });
        return;
      }
      if (typeof data?.sessionId === "string" && typeof onOpenConversation === "function") {
        onOpenConversation(data.sessionId);
      }
      await refresh();
    } catch (error) {
      if (HolafModal) {
        await HolafModal.alert("Conversation", apiMessage(error, "Échec de l'ouverture."), {
          okText: "Compris",
        });
      }
    } finally {
      state.busy = false;
    }
  }

  function setOpen(open) {
    state.open = open;
    if (layer) layer.hidden = !open;
    if (button) button.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      render();
      panel?.focus?.();
      void refresh();
    }
  }

  if (button) {
    button.hidden = false;
    button.addEventListener("click", () => setOpen(!state.open));
  }
  if (closeButton) closeButton.addEventListener("click", () => setOpen(false));
  if (readAllButton) readAllButton.addEventListener("click", () => void markAllRead());
  // Toucher/Cliquer le fond assombri ferme le panneau (jamais un clic dedans).
  if (layer) {
    layer.addEventListener("click", (event) => {
      if (event.target === layer) setOpen(false);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.open) setOpen(false);
    });
  }

  void refresh();
  const timer = setInterval(() => {
    // Onglet en arrière-plan : on ne sonde pas (aucune dépense inutile) ; le
    // retour au premier plan relit immédiatement.
    if (document.hidden) return;
    void refresh();
  }, POLL_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void refresh();
  });

  return {
    refresh,
    open: () => setOpen(true),
    close: () => setOpen(false),
    /** Arrêt propre (tests, démontage). */
    stop: () => clearInterval(timer),
    get unread() {
      return state.nonLus;
    },
  };
}
