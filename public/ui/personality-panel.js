/**
 * Panneau « Personnalité » de la page `/config`.
 *
 * Composant autonome monté par id (comme `agents-panel.js`). Il permet de :
 *   - LIRE et ÉDITER la personnalité de Yuki (textarea), avec la taille et une
 *     alerte quand on approche de la borne ;
 *   - ENREGISTRER (`PUT /api/self/personality`, en-tête X-Yuki-Config) ;
 *   - REVENIR À LA VERSION PRÉCÉDENTE (`POST /api/self/personality/revert`) ;
 *   - CONSULTER l'historique des versions (aperçus).
 *
 * CSP stricte (`style-src 'self'`) : aucun `<style>` injecté, aucun `style=` —
 * tout le CSS vit dans `config.css`.
 *
 * ⚠️ La personnalité vit dans un fichier SÉPARÉ du prompt système de sûreté
 * (`personality.md`, volume `state`) : elle est relue à CHAQUE tour, donc une
 * modification s'applique à chaud, sans redémarrage.
 */

const JSON_HEADERS = { accept: "application/json" };
const WRITE_HEADERS = { "content-type": "application/json", "x-yuki-config": "1" };

/** Seuil d'alerte « proche de la borne » (90 % de la taille maximale). */
const NEAR_LIMIT_RATIO = 0.9;
/** Longueur maximale du textarea affiché (le serveur reste l'autorité). */
const TEXTAREA_MAXLENGTH = 20000;

function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = value;
    else if (key === "onclick") el.addEventListener("click", value);
    else if (value === true) el.setAttribute(key, "");
    else if (value !== false && value !== undefined && value !== null) {
      el.setAttribute(key, String(value));
    }
  }
  for (const child of [].concat(children)) {
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

function apiMessage(error, fallback) {
  const data = error?.data ?? {};
  return data.message ?? data.error ?? error?.message ?? fallback;
}

/** Nombre de POINTS DE CODE (`[...text].length`), comme le serveur. */
function codePointLength(text) {
  return [...String(text)].length;
}

const BOOTSTRAP_HELP = [
  "La personnalité est un texte Markdown qui décrit QUI est Yuki et COMMENT elle s'exprime.",
  "Elle est relue à CHAQUE tour : une modification s'applique tout de suite, sans redémarrage.",
  "Pour l'amorcer depuis une ancienne « âme » : déposez le fichier personality.md dans le volume state " +
    "(à côté de memory.jsonl), ou collez ici le contenu d'un ancien SOUL.md puis Enregistrez. " +
    "Il sera relu au tour suivant.",
  "Chaque version enregistrée est conservée (20 dernières) : le bouton « Revenir à la version " +
    "précédente » restaure l'état d'avant le dernier enregistrement.",
];

export function initPersonalityPanel({ root, HolafFetch, HolafModal }) {
  const state = {
    text: "",
    chars: 0,
    maxChars: 8000,
    truncated: false,
    history: [],
    error: "",
    status: "",
    loaded: false,
  };

  async function load() {
    state.error = "";
    try {
      const body = await HolafFetch.get("/api/self/personality", { headers: JSON_HEADERS });
      state.text = typeof body?.text === "string" ? body.text : "";
      state.chars = typeof body?.chars === "number" ? body.chars : codePointLength(state.text);
      state.maxChars = typeof body?.maxChars === "number" ? body.maxChars : state.maxChars;
      state.truncated = Boolean(body?.truncated);
      state.history = Array.isArray(body?.history) ? body.history : [];
      state.loaded = true;
    } catch (error) {
      state.error = apiMessage(error, "Impossible de charger la personnalité.");
    }
    render();
  }

  function updateCounter() {
    const length = codePointLength(state.editValue);
    state.counter.textContent = `${length} / ${state.maxChars} caractères`;
    const near = length >= state.maxChars * NEAR_LIMIT_RATIO;
    const over = length > state.maxChars;
    state.counter.classList.toggle("personality-counter--warn", near && !over);
    state.counter.classList.toggle("personality-counter--over", over);
    state.saveButton.disabled = !state.loaded;
  }

  async function save() {
    state.status = "Enregistrement…";
    state.statusEl.textContent = state.status;
    try {
      const body = await HolafFetch.put("/api/self/personality", {
        headers: { ...WRITE_HEADERS, "x-yuki-config-flow": "personality-save" },
        body: { text: state.editValue },
      });
      state.truncated = Boolean(body?.truncated);
      state.status = body?.truncated
        ? `Enregistré, mais TRONQUÉ à ${body.maxChars ?? state.maxChars} caractères (borne atteinte).`
        : "Enregistré. La personnalité sera relue au prochain tour.";
      await load();
      state.statusEl.textContent = state.status;
    } catch (error) {
      state.status = apiMessage(error, "Échec de l'enregistrement.");
      state.statusEl.textContent = state.status;
    }
  }

  async function revert() {
    const confirmed = await HolafModal.confirm(
      "Revenir à la version précédente ?",
      "Le contenu actuel sera remplacé par la version enregistrée juste avant.",
      { confirmText: "Restaurer" },
    );
    if (!confirmed) return;
    state.status = "Restauration…";
    state.statusEl.textContent = state.status;
    try {
      await HolafFetch.post("/api/self/personality/revert", {
        headers: { ...WRITE_HEADERS, "x-yuki-config-flow": "personality-revert" },
      });
      state.status = "Version précédente restaurée.";
      await load();
      state.statusEl.textContent = state.status;
    } catch (error) {
      state.status = apiMessage(error, "Restauration impossible.");
      state.statusEl.textContent = state.status;
    }
  }

  function renderHistory() {
    const details = h("details", { class: "personality-history" }, [
      h("summary", { text: `Historique des versions (${state.history.length})` }),
    ]);
    if (state.history.length === 0) {
      details.append(h("p", { class: "config-helper", text: "Aucune version enregistrée pour l'instant." }));
      return details;
    }
    const list = h("ul", { class: "personality-history__list" });
    for (const version of state.history) {
      list.append(
        h("li", { class: "personality-history__item" }, [
          h("span", { class: "personality-history__date", text: String(version.at ?? "") }),
          h("span", { class: "personality-history__chars", text: `${version.chars ?? "?"} car.` }),
          h("pre", { class: "personality-history__preview", text: String(version.preview ?? "") }),
        ]),
      );
    }
    details.append(list);
    return details;
  }

  function render() {
    root.textContent = "";

    const wrap = h("section", { class: "config-group personality-panel" });
    wrap.append(
      h("div", { class: "config-group__head" }, [
        h("h2", { class: "config-group__title", text: "Personnalité de Yuki" }),
      ]),
    );

    const help = h("ul", { class: "personality-help" });
    for (const line of BOOTSTRAP_HELP) help.append(h("li", { text: line }));
    wrap.append(help);

    if (state.error) {
      wrap.append(h("p", { class: "config-banner config-banner--warn", text: state.error }));
    }

    const textarea = h("textarea", {
      class: "config-textarea personality-editor",
      spellcheck: "false",
      rows: "16",
      maxlength: String(TEXTAREA_MAXLENGTH),
      "aria-label": "Personnalité de Yuki",
    });
    textarea.value = state.text;
    state.editValue = state.text;
    textarea.addEventListener("input", () => {
      state.editValue = textarea.value;
      updateCounter();
    });

    state.counter = h("span", { class: "personality-counter" });
    state.statusEl = h("span", { class: "config-save-status", role: "status" });
    state.statusEl.textContent = state.status;

    state.saveButton = h("button", {
      class: "button",
      type: "button",
      text: "Enregistrer",
    });
    state.saveButton.addEventListener("click", () => void save());
    const revertButton = h("button", {
      class: "button button--ghost",
      type: "button",
      text: "Revenir à la version précédente",
    });
    revertButton.addEventListener("click", () => void revert());

    const actions = h("div", { class: "config-actions" }, [state.saveButton, revertButton]);
    actions.append(state.counter);
    actions.append(state.statusEl);

    wrap.append(textarea, actions, renderHistory());

    if (state.truncated) {
      wrap.append(
        h("p", {
          class: "config-banner config-banner--warn",
          text:
            "Le contenu enregistré dépasse la taille maximale : il est tronqué à la lecture. " +
            "Réduisez-le puis enregistrez à nouveau.",
        }),
      );
    }

    root.append(wrap);
    updateCounter();
    state.statusEl.textContent = state.status;
  }

  render();
  void load();
  return { refresh: load };
}
