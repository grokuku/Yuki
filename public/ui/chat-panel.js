/**
 * Panneau « Discussions » de la page `/config` (lot 18, lot 2).
 *
 * Il branche Yuki sur un serveur MATTERMOST : URL du serveur, JETON du bot (saisi UNE
 * SEULE FOIS, jamais réaffiché), état de la connexion, avancement du backfill (deux
 * semaines) et liste des canaux suivis.
 *
 * Routes utilisées (aucune dépendance nouvelle, toutes same-origin et gardées par
 * l'en-tête `X-Yuki-Config: 1`) :
 *   GET   /api/chat/status                 → état complet (mode, plateforme, Mattermost)
 *   PUT   /api/chat/mattermost             → { baseUrl }
 *   POST  /api/chat/mattermost/jeton       → { jeton }  ⚠️ jamais relu
 *   POST  /api/chat/mattermost/connexion   → démarrage de la synchronisation
 *
 * ⚠️ CSP STRICTE (`default-src 'none'`, `style-src 'self'`) : aucun `innerHTML`, aucun
 * attribut `style`, aucun appel du NAVIGATEUR vers Mattermost. Tout passe par le
 * gateway : le jeton ne quitte donc jamais le serveur (il n'est même pas relu par cette
 * page, qui n'apprend que « jeton enregistré : oui / non »).
 *
 * ⚠️ LIMITES AFFICHÉES, pas cachées : les demandes d'APPROBATION ne sont pas relayées
 * dans un canal (lot suivant) et la MÉMOIRE durable n'est pas branchée en mode distant.
 */

import { badgeFor } from "./chat-mode.js";

/** En-tête exigé par les routes de discussion (lecture ET écriture). */
const READ_HEADERS = { accept: "application/json", "x-yuki-config": "1" };
const WRITE_HEADERS = { "content-type": "application/json", "x-yuki-config": "1" };

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
  return date.toLocaleString("fr-FR");
}

/** Message d'erreur rendu par le serveur (français), sinon le code HTTP. */
function apiMessage(error, fallback) {
  const data = error?.data ?? {};
  return data.message ?? data.error ?? error?.message ?? fallback;
}

/** Libellés des modes de réponse (mêmes mots que le menu contextuel du canal). */
export const REPLY_MODE_TEXT = {
  tout: "Répondre à tous les messages",
  auto: "Répondre quand on s'adresse à elle (jugé par le modèle)",
  mention: "Répondre seulement si elle est citée",
};

/** Texte du bandeau « historique antérieur non importé ». */
export const BACKFILL_BANNER =
  "Historique antérieur non importé : le backfill est borné à 2 semaines ET à 1 000 " +
  "messages par canal. Ce qui précède reste sur Mattermost, Yuki ne l'a pas lu.";

/**
 * Monte le panneau.
 *
 * @param {object} deps
 * @param {HTMLElement} deps.root conteneur (`#chat-root`).
 * @param {object} [deps.HolafModal] modale de la brique (`alert`).
 * @param {typeof fetch} [deps.fetchImpl] `fetch` injectable (tests).
 */
export function initChatPanel(deps) {
  const root = deps.root;
  if (!root) throw new Error("initChatPanel : racine absente");
  const modal = deps.HolafModal ?? null;
  const doFetch = deps.fetchImpl ?? ((url, init) => fetch(url, init));
  /** Dernier état reçu (aucune donnée secrète : URL, booléens, compteurs). */
  let state = null;

  // ─── Squelette ───────────────────────────────────────────────────────────
  const section = h("section", { class: "config-group" });
  const title = h("h2", { class: "config-group__title", text: "Discussions — Mattermost" });
  const intro = h("p", {
    class: "config-helper",
    text:
      "Yuki lit les canaux Mattermost dont son bot est membre (deux semaines d'historique, " +
      "1 000 messages par canal au plus) et y répond selon le mode choisi par canal " +
      "(clic droit sur le canal, dans la barre latérale).",
  });

  const statusLine = h("p", { class: "config-helper chat-panel__status" });
  // ⚠️ La RAISON est un texte NEUTRE (elle peut être bonne : « temps réel authentifié ») ;
  // le rouge est réservé au BANDEAU d'avertissement (historique non importé).
  const reasonLine = h("p", { class: "config-helper chat-panel__reason" });
  reasonLine.hidden = true;

  // URL du serveur
  const urlInput = h("input", {
    class: "config-input",
    type: "url",
    id: "chat-mattermost-url",
    autocomplete: "off",
    spellcheck: "false",
    placeholder: "https://mattermost.exemple.fr",
    "aria-label": "URL du serveur Mattermost",
  });
  const saveUrlButton = h("button", {
    class: "button button--small",
    type: "button",
    text: "Enregistrer l'URL",
  });
  const urlRow = h("div", { class: "chat-panel__field" }, [
    h("label", { class: "config-label", for: "chat-mattermost-url", text: "URL du serveur" }),
    h("div", { class: "config-actions" }, [urlInput, saveUrlButton]),
  ]);

  // Jeton du bot
  const tokenInput = h("input", {
    class: "config-input",
    type: "password",
    id: "chat-mattermost-token",
    autocomplete: "off",
    spellcheck: "false",
    placeholder: "jeton du bot (affiché une seule fois)",
    "aria-label": "Jeton du bot Mattermost",
  });
  const saveTokenButton = h("button", {
    class: "button button--small",
    type: "button",
    text: "Enregistrer le jeton",
  });
  const tokenState = h("p", { class: "config-helper" });
  const tokenRow = h("div", { class: "chat-panel__field" }, [
    h("label", { class: "config-label", for: "chat-mattermost-token", text: "Jeton du bot" }),
    h("div", { class: "config-actions" }, [tokenInput, saveTokenButton]),
    tokenState,
    h("p", {
      class: "config-helper",
      text:
        "Le jeton est chiffré dans le coffre de Yuki et n'est PLUS JAMAIS réaffiché : " +
        "s'il est perdu, remplacez-le par un nouveau jeton Mattermost.",
    }),
  ]);

  const connectButton = h("button", {
    class: "button button--small",
    type: "button",
    text: "Se connecter",
  });
  const connectRow = h("div", { class: "config-actions" }, [connectButton]);

  const backfillLine = h("p", { class: "config-helper chat-panel__backfill" });
  const bannerLine = h("p", { class: "config-error" });
  bannerLine.hidden = true;

  const channelsList = h("ul", { class: "chat-panel__channels" });

  const limits = h("p", {
    class: "config-helper",
    text:
      "Limites assumées : les demandes d'APPROBATION ne sont pas encore relayées dans un " +
      "canal (lot suivant), et la MÉMOIRE durable n'est pas branchée en mode distant " +
      "(réglages `chat.remoteAgents` / `chat.remoteMemory` dans l'onglet Conversation).",
  });

  section.append(
    title,
    intro,
    statusLine,
    reasonLine,
    urlRow,
    tokenRow,
    connectRow,
    backfillLine,
    bannerLine,
    h("h3", { class: "config-group__title", text: "Canaux suivis" }),
    channelsList,
    limits,
  );
  root.replaceChildren(section);

  // ─── Rendu de l'état ─────────────────────────────────────────────────────
  function render() {
    const mattermost = state?.mattermost;
    if (!mattermost) {
      statusLine.textContent = "État Mattermost indisponible : redémarrez Yuki.";
      return;
    }
    const badge = badgeFor({ plateforme: mattermost.plateforme });
    // Le badge dit l'ÉTAT (glyphe + mot) ; le survol (`title`) porte la raison complète,
    // affichée en dessous pour ne pas la dupliquer sur la même ligne.
    statusLine.textContent = `${badge.glyph} ${badge.label}`;
    statusLine.title = badge.title;
    const raison = mattermost.plateforme.raison;
    reasonLine.hidden = typeof raison !== "string" || raison === "";
    reasonLine.textContent = raison ?? "";

    if (document.activeElement !== urlInput) urlInput.value = mattermost.url ?? "";
    tokenState.textContent = mattermost.jetonEnregistre
      ? "Un jeton est enregistré (il n'est jamais réaffiché)."
      : "Aucun jeton enregistré : la connexion est impossible tant qu'il manque.";
    // ⚠️ Une fois enregistré, le champ reste VIDE : on ne pré-remplit jamais un secret,
    // et le saisir à nouveau le REMPLACE.
    tokenInput.value = "";

    const sync = mattermost.synchronisation ?? {};
    const backfill = sync.backfill ?? {};
    const parts = [];
    parts.push(sync.canauxSuivis !== undefined ? `${sync.canauxSuivis} canal(aux) suivi(s)` : "aucun canal suivi");
    if (backfill.fait) {
      parts.push(`backfill effectué depuis le ${formatDate(backfill.depuis)}`);
    } else {
      parts.push("backfill non terminé");
    }
    parts.push(`${backfill.imports ?? 0} message(s) importé(s)`);
    if (sync.rattrapageActif) parts.push("rattrapage périodique actif (60 s)");
    backfillLine.textContent = parts.join(" · ");
    bannerLine.hidden = backfill.borneAtteinte !== true;
    bannerLine.textContent = BACKFILL_BANNER;

    channelsList.replaceChildren();
    const canaux = Array.isArray(mattermost.canaux) ? mattermost.canaux : [];
    if (canaux.length === 0) {
      channelsList.append(
        h("li", { class: "config-helper", text: "Aucun canal pour l'instant." }),
      );
      return;
    }
    for (const canal of canaux) {
      const mode = canal.replyMode ?? "mention";
      const ligne = h("li", { class: "chat-panel__channel" }, [
        h("span", { class: "chat-panel__channel-name", text: canal.titre ?? canal.id }),
        h("span", {
          class: "config-helper",
          text: ` — ${canal.messageCount ?? 0} message(s) · ${REPLY_MODE_TEXT[mode] ?? mode}`,
        }),
        canal.historiqueAnterieur
          ? h("span", { class: "config-error", text: " · historique antérieur non importé" })
          : null,
      ]);
      channelsList.append(ligne);
    }
  }

  // ─── Appels ─────────────────────────────────────────────────────────────
  async function request(url, init) {
    const response = await doFetch(url, init);
    let data = {};
    try {
      data = await response.json();
    } catch {
      data = {};
    }
    if (!response.ok) {
      const error = new Error(data?.message ?? `HTTP ${response.status}`);
      error.data = data;
      throw error;
    }
    return data;
  }

  async function refresh() {
    try {
      state = await request("/api/chat/status", { headers: READ_HEADERS, cache: "no-store" });
      render();
    } catch (error) {
      statusLine.textContent = `Impossible de lire l'état des discussions : ${apiMessage(error, "erreur inconnue")}`;
    }
  }

  async function report(title, error) {
    const message = apiMessage(error, "erreur inconnue");
    if (modal?.alert) await modal.alert(title, message, { okText: "Compris" });
    else statusLine.textContent = `${title} — ${message}`;
  }

  saveUrlButton.addEventListener("click", () => {
    void (async () => {
      try {
        const data = await request("/api/chat/mattermost", {
          method: "PUT",
          headers: WRITE_HEADERS,
          body: JSON.stringify({ baseUrl: urlInput.value.trim() }),
        });
        state = { ...(state ?? {}), mattermost: data.mattermost ?? state?.mattermost };
        render();
      } catch (error) {
        await report("URL non enregistrée", error);
      }
    })();
  });

  saveTokenButton.addEventListener("click", () => {
    void (async () => {
      const jeton = tokenInput.value.trim();
      if (jeton === "") {
        await report(
          "Jeton vide",
          new Error("Copiez le jeton du bot depuis Mattermost avant de l'enregistrer."),
        );
        return;
      }
      try {
        await request("/api/chat/mattermost/jeton", {
          method: "POST",
          headers: WRITE_HEADERS,
          body: JSON.stringify({ jeton }),
        });
        // ⚠️ On VIDE le champ immédiatement : le jeton ne reste pas dans le DOM après
        // l'enregistrement (et il n'est jamais relu depuis le serveur).
        tokenInput.value = "";
        await refresh();
      } catch (error) {
        await report("Jeton non enregistré", error);
      }
    })();
  });

  connectButton.addEventListener("click", () => {
    void (async () => {
      connectButton.disabled = true;
      try {
        const data = await request("/api/chat/mattermost/connexion", {
          method: "POST",
          headers: WRITE_HEADERS,
          body: JSON.stringify({
            baseUrl: urlInput.value.trim(),
            ...(tokenInput.value.trim() !== "" ? { jeton: tokenInput.value.trim() } : {}),
          }),
        });
        tokenInput.value = "";
        state = { ...(state ?? {}), mattermost: data.mattermost ?? state?.mattermost };
        render();
      } catch (error) {
        await report("Connexion impossible", error);
      } finally {
        connectButton.disabled = false;
      }
    })();
  });

  void refresh();
  return { element: section, refresh };
}
