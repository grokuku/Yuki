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

/**
 * Avertissement FRANC du bloc « Mémoire durable » : ce qui va se passer ET ce
 * qui ne sera PAS touché. Aucun style inline (CSP stricte).
 */
const MEMORY_WARNING = [
  "Réinitialiser la mémoire met DE CÔTÉ tous les souvenirs durables de Yuki (ce qu'elle a retenu de " +
    "vos échanges). Le fichier de mémoire est ARCHIVÉ (renommé, horodaté) : rien n'est perdu et vous " +
    "pouvez le restaurer à la main.",
  "La mémoire repart ensuite VIDE (l'index de recherche est vidé et se reconstruit tout seul) ; les " +
    "prochaines conversations produiront de nouveaux souvenirs.",
  "Ne sont PAS touchés : la personnalité de Yuki (personality.md et son historique) ni l'archive " +
    "« vie antérieure ».",
];

/**
 * Rappel VISIBLE de ce qu'est l'archive « vie antérieure » — pour ne pas la
 * confondre avec la mémoire courante. Aucun style inline (CSP stricte).
 */
const HERITAGE_HELP = [
  "C'est l'archive d'une VIE ANTÉRIEURE de Yuki (machine Yuki-old, ère OpenClaw) : des souvenirs " +
    "d'AVANT la bascule vers le chatbot maison.",
  "Elle est DÉLIBÉRÉMENT SÉPARÉE de la mémoire courante et n'est JAMAIS fusionnée : ce que vous " +
    "déposez ici ne sera jamais mémorisé comme un souvenir du présent.",
  "Le modèle ne peut que la CONSULTER (lecture seule) ; ce que vous éditez ici s'écrit DIRECTEMENT " +
    "dans le fichier de l'archive, sans passer par la conversation.",
  "⚠️ N'y déposez aucun secret (clé, mot de passe, identifiant) : l'archive est consultable par le " +
    "modèle à la demande.",
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
    // Mémoire durable (archivage récupérable) — chargé séparément.
    memoryEntries: 0,
    memoryArchiveDir: "",
    memoryStatus: "",
    memoryLoaded: false,
    // Archive « vie antérieure » (édition/ajout/suppression) — chargée séparément.
    heritage: {
      loaded: false,
      available: false,
      present: false,
      count: 0,
      entries: [],
      maxChars: 20000,
      titreMaxChars: 200,
      dir: "",
      manifest: null,
      /** Clé de l'entrée en cours de modification (`null` = aucune). */
      editingCle: null,
      /** Éditeur d'ajout ouvert. */
      creating: false,
      draft: { titre: "", categorie: "", texte: "" },
      status: "",
    },
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

  /** Charge l'état de la mémoire durable (nombre d'entrées + dossier d'archive). */
  async function loadMemory() {
    try {
      const body = await HolafFetch.get("/api/memory", { headers: JSON_HEADERS });
      state.memoryEntries = typeof body?.entries === "number" ? body.entries : 0;
      state.memoryArchiveDir = typeof body?.archiveDir === "string" ? body.archiveDir : "";
      state.memoryLoaded = true;
    } catch {
      // La mémoire n'est pas disponible (porte non passée) : le bloc reste discret.
      state.memoryArchiveDir = "";
      state.memoryLoaded = false;
    }
    render();
  }

  /** Charge l'archive « vie antérieure » (synthèse + liste). */
  async function loadHeritage() {
    try {
      const body = await HolafFetch.get("/api/self/heritage", { headers: JSON_HEADERS });
      const info = body?.info ?? {};
      state.heritage.loaded = true;
      state.heritage.available = true;
      state.heritage.present = Boolean(info.present);
      state.heritage.count = typeof info.entries === "number" ? info.entries : 0;
      state.heritage.maxChars =
        typeof info.maxChars === "number" ? info.maxChars : state.heritage.maxChars;
      state.heritage.titreMaxChars =
        typeof info.titreMaxChars === "number" ? info.titreMaxChars : state.heritage.titreMaxChars;
      state.heritage.dir = typeof info.dir === "string" ? info.dir : "";
      state.heritage.manifest = info.manifest ?? null;
      state.heritage.entries = Array.isArray(body?.entries) ? body.entries : [];
    } catch {
      // API absente (porte non passée) ou illisible : la section reste discrète.
      state.heritage.loaded = true;
      state.heritage.available = false;
    }
    render();
  }

  /** Ouvre l'éditeur sur une entrée existante (lecture fraîche de son contenu). */
  async function openHeritageEditor(cle) {
    state.heritage.status = "Chargement…";
    render();
    try {
      const body = await HolafFetch.get(
        "/api/self/heritage/entry/" + encodeURIComponent(cle),
        { headers: JSON_HEADERS },
      );
      const entry = body?.entry;
      if (!entry) throw new Error("Entrée illisible.");
      state.heritage.editingCle = cle;
      state.heritage.creating = false;
      state.heritage.draft = {
        titre: typeof entry.titre === "string" ? entry.titre : "",
        categorie: typeof entry.categorie === "string" ? entry.categorie : "",
        texte: typeof entry.texte === "string" ? entry.texte : "",
      };
      state.heritage.status = "";
    } catch (error) {
      state.heritage.status = apiMessage(error, "Impossible de lire l'entrée.");
    }
    render();
  }

  /** Ouvre l'éditeur d'AJOUT (entrée vierge). */
  function openHeritageCreator() {
    state.heritage.editingCle = null;
    state.heritage.creating = true;
    state.heritage.draft = { titre: "", categorie: "", texte: "" };
    state.heritage.status = "";
    render();
  }

  /** Ferme l'éditeur sans rien enregistrer. */
  function closeHeritageEditor() {
    state.heritage.editingCle = null;
    state.heritage.creating = false;
    state.heritage.draft = { titre: "", categorie: "", texte: "" };
    state.heritage.status = "";
    render();
  }

  /**
   * Enregistre le brouillon (création ou modification). L'étiquette et la
   * provenance sont RÉAPPLIQUÉES côté serveur : l'UI ne les envoie jamais.
   */
  async function saveHeritage() {
    const draft = state.heritage.draft;
    if (String(draft.titre ?? "").trim().length === 0) {
      state.heritage.status = "Un titre est requis pour enregistrer l'entrée.";
      render();
      return;
    }
    const isNew = state.heritage.creating;
    state.heritage.status = "Enregistrement…";
    render();
    try {
      const url = isNew
        ? "/api/self/heritage/entry"
        : "/api/self/heritage/entry/" + encodeURIComponent(state.heritage.editingCle);
      const opts = {
        headers: {
          ...WRITE_HEADERS,
          "x-yuki-config-flow": isNew ? "heritage-create" : "heritage-save",
        },
        body: { titre: draft.titre, categorie: draft.categorie, texte: draft.texte },
      };
      const body = isNew
        ? await HolafFetch.post(url, opts)
        : await HolafFetch.put(url, opts);
      state.heritage.editingCle = null;
      state.heritage.creating = false;
      state.heritage.draft = { titre: "", categorie: "", texte: "" };
      state.heritage.status = body?.truncated
        ? `Enregistré, mais TRONQUÉ à ${state.heritage.maxChars ?? "?"} caractères (borne atteinte).`
        : isNew
          ? "Entrée ajoutée à l'archive."
          : "Entrée enregistrée.";
      await loadHeritage();
    } catch (error) {
      state.heritage.status = apiMessage(error, "Échec de l'enregistrement.");
      render();
    }
  }

  /**
   * Met de côté une entrée (JAMAIS de suppression définitive). Confirmation
   * explicite via HolafModal (jamais window.confirm) : le libellé dit CE QUI
   * sera retiré et OÙ il part, pas un simple « Êtes-vous sûr ? ».
   */
  async function deleteHeritage(entry) {
    const confirmed = await HolafModal.confirm(
      "Retirer cette entrée de la vie antérieure ?",
      `« ${entry.titre} » (${entry.categorie}) sera RETIRÉE de l'archive active et ` +
        "déplacée dans le sous-dossier « deleted/ » de l'archive : elle reste " +
        "RÉCUPÉRABLE à la main. Ce n'est PAS une suppression définitive.",
      { danger: true, confirmText: "Mettre de côté", cancelText: "Annuler" },
    );
    if (!confirmed) return;
    state.heritage.status = "Mise de côté…";
    render();
    try {
      const body = await HolafFetch.delete(
        "/api/self/heritage/entry/" + encodeURIComponent(entry.cle),
        { headers: { ...WRITE_HEADERS, "x-yuki-config-flow": "heritage-delete" } },
      );
      state.heritage.status = body?.message ?? "Entrée mise de côté.";
      await loadHeritage();
    } catch (error) {
      state.heritage.status = apiMessage(error, "Mise de côté impossible.");
      render();
    }
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

  /**
   * Archive la mémoire durable et repart d'une mémoire vide.
   * ⚠️ Confirmation explicite via HolafModal (jamais window.confirm) : libellé
   * qui dit CE QUI sera archivé et OÙ, pas un simple « Êtes-vous sûr ? ».
   */
  async function resetMemory() {
    const entries = state.memoryEntries;
    const target = state.memoryArchiveDir || "le dossier d'archive de la mémoire (volume state)";
    const confirmed = await HolafModal.confirm(
      "Archiver puis réinitialiser la mémoire ?",
      `${entries} souvenir(s) enregistré(s) seront déplacés (archivés) dans : ${target}. ` +
        "La mémoire repartira ensuite VIDE. Ne sont PAS touchés : la personnalité de Yuki ni " +
        "l'archive « vie antérieure ».",
      { danger: true, confirmText: "Archiver et réinitialiser", cancelText: "Annuler" },
    );
    if (!confirmed) return;
    state.memoryStatus = "Archivage…";
    if (state.memoryStatusEl) state.memoryStatusEl.textContent = state.memoryStatus;
    try {
      const body = await HolafFetch.post("/api/memory/reset", {
        headers: { ...WRITE_HEADERS, "x-yuki-config-flow": "memory-reset" },
      });
      if (body?.archived) {
        state.memoryStatus =
          `Mémoire archivée (${body.entries} souvenir(s)) dans ${body.archivePath}. ` +
          "La mémoire est maintenant vide ; les prochains échanges produiront de nouveaux souvenirs.";
      } else {
        state.memoryStatus = apiMessage(null, body?.message ?? "Aucune mémoire à réinitialiser.");
      }
      await loadMemory();
    } catch (error) {
      state.memoryStatus = apiMessage(error, "Réinitialisation impossible.");
    }
    if (state.memoryStatusEl) state.memoryStatusEl.textContent = state.memoryStatus;
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

  /**
   * Bloc « Mémoire durable », VISUELLEMENT DISTINCT du formulaire de personnalité
   * (encadré dédié, bouton de danger) : on ne veut pas cliquer dessus par erreur.
   * Aucun style inline (CSP stricte).
   */
  function renderMemoryBlock() {
    const block = h("section", { class: "personality-memory" });
    block.append(
      h("h3", { class: "personality-memory__title", text: "Mémoire durable" }),
    );
    const warning = h("ul", { class: "personality-help personality-memory__warning" });
    for (const line of MEMORY_WARNING) warning.append(h("li", { text: line }));
    block.append(warning);

    if (state.memoryLoaded) {
      block.append(
        h("p", {
          class: "config-helper",
          text:
            state.memoryEntries === 0
              ? "Aucune mémoire à réinitialiser pour l'instant."
              : `${state.memoryEntries} souvenir(s) actuellement en mémoire.`,
        }),
      );
      if (state.memoryArchiveDir) {
        block.append(
          h("p", { class: "config-helper personality-memory__path" }, [
            h("span", { text: "Dossier d'archive : " }),
            h("code", { text: state.memoryArchiveDir }),
          ]),
        );
      }
    }

    const button = h("button", {
      class: "button button--danger",
      type: "button",
      text: "Réinitialiser la mémoire",
    });
    button.addEventListener("click", () => void resetMemory());
    // Mémoire déjà vide ⇒ aucune archive vide créée : le bouton est désactivé.
    if (state.memoryLoaded && state.memoryEntries === 0) {
      button.disabled = true;
    }

    const actions = h("div", { class: "config-actions" }, [button]);
    state.memoryStatusEl = h("span", { class: "config-save-status", role: "status" });
    state.memoryStatusEl.textContent = state.memoryStatus;
    actions.append(state.memoryStatusEl);
    block.append(actions);
    return block;
  }

  /** Ligne d'une entrée d'archive : titre, catégorie, date + actions. */
  function renderHeritageRow(entry) {
    const row = h("li", { class: "personality-heritage__item" });
    const meta = h("div", { class: "personality-heritage__meta" }, [
      h("span", { class: "personality-heritage__titre", text: String(entry.titre ?? entry.id ?? "") }),
      h("span", { class: "badge personality-heritage__cat", text: String(entry.categorie ?? "autre") }),
    ]);
    if (entry.importe_le) {
      meta.append(
        h("span", { class: "personality-heritage__date", text: String(entry.importe_le) }),
      );
    }
    row.append(meta);

    const edit = h("button", { class: "button button--ghost button--small", type: "button", text: "Éditer" });
    edit.addEventListener("click", () => void openHeritageEditor(entry.cle));
    const remove = h("button", { class: "button button--danger button--small", type: "button", text: "Mettre de côté" });
    remove.addEventListener("click", () => void deleteHeritage(entry));
    row.append(h("div", { class: "personality-heritage__actions" }, [edit, remove]));
    return row;
  }

  /** Éditeur d'ajout ou de modification d'une entrée (titre, catégorie, texte). */
  function renderHeritageEditor() {
    const isNew = state.heritage.creating;
    const wrap = h("div", { class: "personality-heritage__editor" });
    wrap.append(
      h("h4", {
        class: "personality-heritage__editor-title",
        text: isNew ? "Nouvelle entrée" : "Modifier l'entrée",
      }),
    );

    wrap.append(h("label", { class: "config-label", text: "Titre" }));
    const titre = h("input", {
      class: "config-input",
      type: "text",
      maxlength: String(state.heritage.titreMaxChars),
      "aria-label": "Titre de l'entrée",
    });
    titre.value = state.heritage.draft.titre;
    titre.addEventListener("input", () => {
      state.heritage.draft.titre = titre.value;
    });
    wrap.append(titre);

    wrap.append(
      h("label", {
        class: "config-label",
        text: "Catégorie (facultatif — ex. identite, profil, relations, reves)",
      }),
    );
    const categorie = h("input", {
      class: "config-input",
      type: "text",
      maxlength: "64",
      "aria-label": "Catégorie de l'entrée",
    });
    categorie.value = state.heritage.draft.categorie;
    categorie.addEventListener("input", () => {
      state.heritage.draft.categorie = categorie.value;
    });
    wrap.append(categorie);

    wrap.append(h("label", { class: "config-label", text: "Contenu" }));
    const textarea = h("textarea", {
      class: "config-textarea personality-heritage__textarea",
      spellcheck: "false",
      rows: "12",
      "aria-label": "Contenu de l'entrée",
    });
    textarea.value = state.heritage.draft.texte;
    textarea.addEventListener("input", () => {
      state.heritage.draft.texte = textarea.value;
    });
    wrap.append(textarea);

    const save = h("button", {
      class: "button",
      type: "button",
      text: isNew ? "Ajouter à l'archive" : "Enregistrer",
    });
    save.addEventListener("click", () => void saveHeritage());
    const cancel = h("button", { class: "button button--ghost", type: "button", text: "Annuler" });
    cancel.addEventListener("click", closeHeritageEditor);
    wrap.append(h("div", { class: "config-actions" }, [save, cancel]));
    wrap.append(
      h("p", {
        class: "config-helper",
        text:
          "L'étiquette « vie antérieure — ne pas fusionner » et la provenance (Yuki-old, OpenClaw) " +
          "sont appliquées AUTOMATIQUEMENT à l'enregistrement : vous ne pouvez pas les oublier.",
      }),
    );
    return wrap;
  }

  /**
   * Bloc « Vie antérieure » : édition, ajout et mise de côté des entrées de
   * l'archive — VISUELLEMENT DISTINCT du formulaire de personnalité et du bloc
   * « Mémoire durable ». Aucun style inline (CSP stricte).
   */
  function renderHeritageSection() {
    const block = h("section", { class: "personality-heritage" });
    block.append(h("h3", { class: "personality-heritage__title", text: "Vie antérieure" }));

    const help = h("ul", { class: "personality-help personality-heritage__help" });
    for (const line of HERITAGE_HELP) help.append(h("li", { text: line }));
    block.append(help);

    if (!state.heritage.available) {
      block.append(
        h("p", {
          class: "config-helper",
          text:
            "L'archive « vie antérieure » n'est pas disponible pour l'instant. Elle est mise en " +
            "place au démarrage de Yuki ; rechargez cette page une fois Yuki prête.",
        }),
      );
      return block;
    }

    if (state.heritage.count === 0) {
      block.append(
        h("p", {
          class: "config-helper personality-heritage__empty",
          text:
            "Archive VIDE pour l'instant : elle ne contiendra rien tant que vous n'y déposerez " +
            "pas d'entrée. C'est normal — ce n'est PAS une erreur.",
        }),
      );
    } else {
      block.append(
        h("p", {
          class: "config-helper",
          text: `${state.heritage.count} entrée(s) dans l'archive « vie antérieure ».`,
        }),
      );
      const list = h("ul", { class: "personality-heritage__list" });
      for (const entry of state.heritage.entries) list.append(renderHeritageRow(entry));
      block.append(list);
    }

    if (state.heritage.creating || state.heritage.editingCle !== null) {
      block.append(renderHeritageEditor());
    }

    const add = h("button", { class: "button button--ghost", type: "button", text: "Ajouter une entrée" });
    add.addEventListener("click", openHeritageCreator);
    const actions = h("div", { class: "config-actions" }, [add]);
    if (state.heritage.dir) {
      actions.append(
        h("span", { class: "config-helper personality-heritage__path" }, [
          h("span", { text: "Dossier : " }),
          h("code", { text: state.heritage.dir }),
        ]),
      );
    }
    block.append(actions);

    state.heritage.statusEl = h("span", { class: "config-save-status", role: "status" });
    state.heritage.statusEl.textContent = state.heritage.status;
    block.append(state.heritage.statusEl);
    return block;
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
    wrap.append(renderMemoryBlock());
    wrap.append(renderHeritageSection());

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
  void loadMemory();
  void loadHeritage();
  return { refresh: load };
}
