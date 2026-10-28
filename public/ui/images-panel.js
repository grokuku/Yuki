/**
 * Panneau « Images générées » de la page `/config` — serveur ComfyUI.
 *
 * Trois zones :
 *   ① ÉTAT du serveur (URL + clé + bouton « Tester la connexion ») : rendues par
 *     la mécanique de configuration commune (`#group-images`) ;
 *   ② WORKFLOWS importés : nom d'usage, description courte, « par défaut »,
 *     CONSIGNES D'ÉCRITURE (documentation), étiquettes trouvées / manquantes,
 *     suppression ;
 *   ③ IMPORT d'un workflow au FORMAT API (collage ou fichier `.json`).
 *
 * Routes utilisées (aucune dépendance nouvelle, `HolafFetch` de la brique) :
 *   GET    /api/images/workflows            → { workflows: [...] }
 *   POST   /api/images/workflows            → import (refus explicite sinon)
 *   PUT    /api/images/workflows/<nom>      → consignes d'écriture (documentation)
 *   DELETE /api/images/workflows/<nom>      → suppression
 *   POST   /api/images/workflows/<nom>/defaut → « par défaut »
 *
 * ⚠️ La DOCUMENTATION est un texte POUR YUKI (comment écrire la scène pour que
 * ce workflow rende ce qu'elle veut). Elle n'est JAMAIS envoyée à ComfyUI, ni
 * injectée dans le prompt système : Yuki la reçoit uniquement quand elle appelle
 * l'outil `consulter_workflow`. Elle est BORNÉE (`MAX_DOCUMENTATION_CHARS`) et
 * un texte trop long est REFUSÉ par le serveur (message explicite, aucune
 * troncature silencieuse).
 *
 * ⚠️ L'import est VALIDÉ CÔTÉ SERVEUR : un JSON invalide ou sans étiquette
 * `YUKI_PROMPT` est REFUSÉ, et le panneau affiche les étiquettes TROUVÉES et
 * MANQUANTES. Aucun graphe n'est renvoyé par l'API : le panneau ne montre que
 * des résumés.
 *
 * ⚠️ SEPT étiquettes sont reconnues. `YUKI_OUTPUT` (facultative) désigne le nœud
 * qui produit l'IMAGE FINALE : quand elle est présente, seule SON image est
 * retenue (un aperçu intermédiaire du graphe ne peut plus être servi par
 * erreur). Sans elle, la première image produite est retenue — et le panneau le
 * dit sur la fiche du workflow comme le résultat de l'outil.
 *
 * ⚠️ `YUKI_FINAL_PROMPT` (facultative) désigne le nœud qui AFFICHE le prompt
 * final (la sortie de l'enhancer du workflow) : son TEXTE est lu dans
 * `outputs[<nœud>].text` de l'historique, puis affiché sous l'image et transmis
 * à Yuki. Aucun champ n'est écrit dans ce nœud.
 *
 * ⚠️ La CLÉ du serveur n'est JAMAIS réaffichée (elle passe par le champ secret
 * de la configuration commune) et n'apparaît nulle part ici.
 *
 * CSP stricte (`style-src 'self'`) : aucun `<style>` injecté, aucun attribut de
 * style en ligne, aucune injection de balisage — le DOM est construit
 * exclusivement avec `createElement`/`textContent`.
 */

const WRITE_HEADERS = { "content-type": "application/json", "x-yuki-config": "1" };
const JSON_HEADERS = { accept: "application/json" };

/**
 * Longueur maximale des CONSIGNES D'ÉCRITURE d'un workflow (caractères).
 * ⚠️ MÊME borne que le serveur (`MAX_COMFY_DOCUMENTATION_CHARS`) : au-delà,
 * l'enregistrement est REFUSÉ avec la longueur réelle — jamais tronqué.
 */
const MAX_DOCUMENTATION_CHARS = 8_000;

/** Les sept étiquettes reconnues, dans l'ordre d'affichage (contrat serveur). */
const LABELS = [
  "YUKI_PROMPT",
  "YUKI_NEGATIVE",
  "YUKI_SEED",
  "YUKI_WIDTH",
  "YUKI_HEIGHT",
  "YUKI_OUTPUT",
  "YUKI_FINAL_PROMPT",
];

function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = value;
    else if (key === "on") el.addEventListener("click", value);
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

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return "taille inconnue";
  if (value < 1024) return `${Math.round(value)} octets`;
  if (value < 1024 * 1024) return `~${Math.round(value / 1024)} Ko`;
  return `~${(value / (1024 * 1024)).toFixed(1)} Mio`;
}

function apiMessage(error, fallback) {
  const data = error?.data ?? {};
  return data.message ?? data.error ?? error?.message ?? fallback;
}

/** Badge d'étiquette : verte (trouvée) ou neutre (manquante, facultative). */
function labelBadge(label, found) {
  return h("span", {
    class: `image-workflow__label ${found ? "image-workflow__label--found" : "image-workflow__label--missing"}`,
    text: found ? label : `${label} (absente)`,
  });
}

/** Liste des étiquettes : trouvées d'abord, manquantes ensuite. */
function labelList(summary) {
  const found = Array.isArray(summary?.found) ? summary.found : [];
  return h(
    "div",
    { class: "image-workflow__labels" },
    LABELS.map((label) => labelBadge(label, found.includes(label))),
  );
}

export function initImagesPanel({ root, HolafFetch, HolafModal }) {
  const state = { workflows: [], error: "", status: "", busy: false };

  const listEl = h("div", { class: "image-workflows" });
  const errorEl = h("p", { class: "config-error", hidden: true });
  const statusEl = h("p", { class: "config-helper" });

  // --- Formulaire d'import -------------------------------------------------
  const nameInput = h("input", {
    class: "config-input",
    type: "text",
    maxlength: "40",
    placeholder: "manga",
    "aria-label": "Nom d'usage du workflow",
  });
  const descriptionInput = h("input", {
    class: "config-input",
    type: "text",
    maxlength: "200",
    placeholder: "Manga / anime — traits marqués, trames",
    "aria-label": "Description courte du workflow",
  });
  const defaultInput = h("input", { type: "checkbox", id: "image-workflow-default" });
  const fileInput = h("input", {
    class: "config-input",
    type: "file",
    accept: ".json,application/json",
    "aria-label": "Fichier de workflow au format API",
  });
  const jsonInput = h("textarea", {
    class: "config-textarea",
    rows: "6",
    spellcheck: "false",
    placeholder:
      '{"9": {"class_type": "PreviewImage", "inputs": {…}, "_meta": {"title": "YUKI_OUTPUT"}}}',
    "aria-label": "Workflow au format API (JSON)",
  });
  const importStatus = h("span", { class: "config-save-status", role: "status" });
  const importButton = h("button", {
    class: "button",
    type: "button",
    text: "Importer le workflow",
  });
  const refusalEl = h("div", { class: "image-import__refusal", hidden: true });

  fileInput.addEventListener("change", () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      jsonInput.value = typeof reader.result === "string" ? reader.result : "";
      importStatus.textContent = `Fichier « ${file.name} » chargé : vérifiez puis importez.`;
    });
    reader.addEventListener("error", () => {
      importStatus.textContent = "Impossible de lire ce fichier.";
    });
    reader.readAsText(file);
  });

  importButton.addEventListener("click", () => void importWorkflow());

  async function importWorkflow() {
    if (state.busy) return;
    refusalEl.hidden = true;
    const name = nameInput.value.trim();
    const description = descriptionInput.value.trim();
    const raw = jsonInput.value.trim();
    const fail = (message) => {
      importStatus.textContent = message;
    };
    if (name === "") return fail("Renseignez le nom d'usage (ex. « manga »).");
    if (description === "") {
      return fail(
        "Renseignez la description courte : c'est elle qui permet de choisir ce " +
          "workflow par proximité.",
      );
    }
    if (raw === "") return fail("Collez le workflow au format API, ou choisissez un fichier.");
    let workflow;
    try {
      workflow = JSON.parse(raw);
    } catch (error) {
      return fail(
        `Ce texte n'est pas du JSON valide : ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    state.busy = true;
    importButton.disabled = true;
    importStatus.textContent = "Import en cours…";
    try {
      await HolafFetch.post("/api/images/workflows", {
        headers: WRITE_HEADERS,
        body: {
          name,
          description,
          workflow,
          ...(defaultInput.checked ? { isDefault: true } : {}),
        },
      });
      importStatus.textContent = `Workflow « ${name} » importé.`;
      jsonInput.value = "";
      fileInput.value = "";
      nameInput.value = "";
      descriptionInput.value = "";
      defaultInput.checked = false;
      await load();
    } catch (error) {
      const data = error?.data ?? {};
      const missing = Array.isArray(data.missing) ? data.missing : [];
      const found = Array.isArray(data.found) ? data.found : [];
      importStatus.textContent = apiMessage(error, "L'import a échoué.");
      // ⚠️ Refus EXPLICITE : on montre les étiquettes trouvées et manquantes.
      refusalEl.textContent = "";
      refusalEl.append(
        h("p", { class: "image-import__title", text: "Import REFUSÉ" }),
        h("p", { text: apiMessage(error, "Le workflow n'est pas utilisable.") }),
      );
      if (found.length > 0 || missing.length > 0) {
        refusalEl.append(
          h("p", {
            class: "image-import__labels",
            text:
              `Étiquettes trouvées : ${found.length > 0 ? found.join(", ") : "aucune"}. ` +
              `Étiquettes manquantes : ${missing.length > 0 ? missing.join(", ") : "aucune"}.`,
          }),
        );
      }
      refusalEl.append(labelList({ found }));
      refusalEl.hidden = false;
    } finally {
      state.busy = false;
      importButton.disabled = false;
    }
  }

  // --- Liste --------------------------------------------------------------
  async function act(description, run) {
    try {
      await run();
      statusEl.textContent = description;
      await load();
    } catch (error) {
      statusEl.textContent = apiMessage(error, "L'action a échoué.");
    }
  }

  async function removeWorkflow(name) {
    const confirmed = await HolafModal.confirm(
      `Supprimer le workflow « ${name} » ?`,
      "Les images déjà générées ne sont pas touchées. Cette suppression est définitive.",
    );
    if (!confirmed) return;
    await act(`Workflow « ${name} » supprimé.`, () =>
      HolafFetch.delete(`/api/images/workflows/${encodeURIComponent(name)}`, {
        headers: WRITE_HEADERS,
      }),
    );
  }

  async function setDefault(name) {
    await act(`« ${name} » est désormais le workflow par défaut.`, () =>
      HolafFetch.post(`/api/images/workflows/${encodeURIComponent(name)}/defaut`, {
        headers: WRITE_HEADERS,
      }),
    );
  }

  /**
   * Enregistre les CONSIGNES D'ÉCRITURE d'un workflow (texte pour Yuki).
   * ⚠️ Un texte trop long est REFUSÉ par le serveur : on affiche la longueur
   * réelle reçue en retour, jamais une troncature silencieuse.
   */
  async function saveDocumentation(name, value, statusEl, button) {
    const documentation = value.trim();
    if (documentation.length > MAX_DOCUMENTATION_CHARS) {
      statusEl.textContent =
        `Trop long : ${documentation.length} caractères, maximum ` +
        `${MAX_DOCUMENTATION_CHARS}. Raccourcis les consignes puis réessaie.`;
      return;
    }
    button.disabled = true;
    statusEl.textContent = "Enregistrement…";
    try {
      await HolafFetch.put(`/api/images/workflows/${encodeURIComponent(name)}`, {
        headers: WRITE_HEADERS,
        body: { documentation },
      });
      statusEl.textContent =
        documentation === ""
          ? `« ${name} » n'a plus de consignes particulières.`
          : `Consignes de « ${name} » enregistrées (${documentation.length} caractères).`;
      await load();
    } catch (error) {
      statusEl.textContent = apiMessage(error, "L'enregistrement a échoué.");
    } finally {
      button.disabled = false;
    }
  }

  /**
   * ÉDITEUR des consignes d'écriture d'un workflow : zone de texte + compteur
   * de caractères + borne DITE + bouton d'enregistrement.
   *
   * ⚠️ Le serveur est la seule autorité (refus au-delà de la borne) : ce
   * compteur ne fait qu'éviter l'aller-retour inutile.
   */
  function documentationEditor(summary) {
    const current = typeof summary.documentation === "string" ? summary.documentation : "";
    const statusEl = h("span", { class: "config-save-status", role: "status" });
    const counter = h("span", {
      class: "config-helper",
      text: `${current.length}/${MAX_DOCUMENTATION_CHARS}`,
    });
    const textarea = h("textarea", {
      class: "config-textarea",
      rows: "10",
      maxlength: String(MAX_DOCUMENTATION_CHARS),
      spellcheck: "true",
      placeholder:
        "Comment écrire la scène pour CE workflow (ex. « commence par le sujet et le " +
        "cadrage, puis le décor ; deux phrases suffisent ; évite les listes »).",
      "aria-label": `Consignes d'écriture du workflow ${summary.name}`,
    });
    textarea.value = current;
    textarea.addEventListener("input", () => {
      counter.textContent = `${textarea.value.length}/${MAX_DOCUMENTATION_CHARS}`;
    });
    const save = h("button", {
      class: "button button--ghost button--small",
      type: "button",
      text: "Enregistrer les consignes",
    });
    save.addEventListener("click", () =>
      void saveDocumentation(summary.name, textarea.value, statusEl, save),
    );
    return h("div", { class: "image-workflow__doc" }, [
      h("p", {
        class: "config-label",
        text: "Consignes d'écriture pour Yuki (facultatives)",
      }),
      h("p", {
        class: "config-helper",
        text:
          "Yuki les reçoit quand elle consulte ce workflow (outil « consulter_workflow ») : " +
          "elles décrivent COMMENT écrire la scène pour que ce workflow rende ce qu'elle " +
          "veut. Jamais envoyées au serveur d'images, jamais ajoutées au prompt de chaque " +
          `tour. Maximum ${MAX_DOCUMENTATION_CHARS} caractères (au-delà, l'enregistrement ` +
          "est refusé).",
      }),
      textarea,
      h("div", { class: "config-actions" }, [save, counter, statusEl]),
    ]);
  }

  function buildCard(summary) {
    const head = h("div", { class: "image-workflow__head" }, [
      h("span", { class: "image-workflow__name", text: summary.name }),
      summary.isDefault
        ? h("span", { class: "badge badge--hot", text: "par défaut" })
        : h("span", { class: "badge", text: "secondaire" }),
    ]);
    const found = Array.isArray(summary.found) ? summary.found : [];
    // ⚠️ Sans `YUKI_OUTPUT`, on le DIT ici : l'image retenue peut être un aperçu.
    const outputNote = found.includes("YUKI_OUTPUT")
      ? h("p", {
          class: "config-helper",
          text:
            "Image finale : celle du nœud étiqueté YUKI_OUTPUT (aucun autre nœud " +
            "n'est lu).",
        })
      : h("p", {
          class: "config-helper",
          text:
            "Pas d'étiquette YUKI_OUTPUT : la PREMIÈRE image produite par le " +
            "graphe est retenue, ce qui peut être un aperçu intermédiaire. " +
            "Étiquette le nœud de sortie (ex. « Preview Image ») YUKI_OUTPUT.",
        });
    // ⚠️ `YUKI_FINAL_PROMPT` : la fiche DIT que le texte du nœud est affiché et
    // transmis (et rappelle qu'il s'agit d'un nœud d'AFFICHAGE de texte).
    const finalPromptNote = found.includes("YUKI_FINAL_PROMPT")
      ? h("p", {
          class: "config-helper",
          text:
            "Prompt final : le TEXTE publié par le nœud étiqueté YUKI_FINAL_PROMPT " +
            "est affiché sous l'image et transmis à Yuki. Ce nœud doit AFFICHER du " +
            "texte (« Preview as Text », « Show Text », AIHToText…).",
        })
      : null;
    const actions = h("div", { class: "image-workflow__actions" });    if (!summary.isDefault) {
      const primary = h("button", {
        class: "button button--ghost button--small",
        type: "button",
        text: "Définir par défaut",
      });
      primary.addEventListener("click", () => void setDefault(summary.name));
      actions.append(primary);
    }
    const remove = h("button", {
      class: "button button--ghost button--small",
      type: "button",
      text: "Supprimer",
    });
    remove.addEventListener("click", () => void removeWorkflow(summary.name));
    actions.append(remove);

    return h("section", { class: "image-workflow" }, [
      head,
      h("p", { class: "image-workflow__description", text: summary.description }),
      h("p", {
        class: "config-helper",
        text: `${summary.nodes} nœud(s) · ${formatBytes(summary.bytes)}`,
      }),
      labelList(summary),
      outputNote,
      finalPromptNote,
      documentationEditor(summary),
      actions,
    ]);
  }

  function renderList() {
    listEl.textContent = "";
    if (state.workflows.length === 0) {
      listEl.append(
        h("p", {
          class: "config-helper",
          text:
            "Aucun workflow importé. Tant qu'il n'y en a pas, l'outil de " +
            "génération d'image refuse explicitement de générer.",
        }),
      );
      return;
    }
    for (const summary of state.workflows) listEl.append(buildCard(summary));
  }

  async function load() {
    try {
      const data = await HolafFetch.get("/api/images/workflows", { headers: JSON_HEADERS });
      state.workflows = Array.isArray(data?.workflows) ? data.workflows : [];
      state.error = "";
    } catch (error) {
      state.workflows = [];
      state.error = apiMessage(error, "Impossible de lire les workflows.");
    }
    errorEl.textContent = state.error;
    errorEl.hidden = state.error === "";
    renderList();
  }

  // --- Montage ------------------------------------------------------------
  root.append(
    h("section", { class: "config-group" }, [
      h("div", { class: "config-group__head" }, [
        h("h2", { class: "config-group__title", text: "Workflows d'images importés" }),
      ]),
      h("p", {
        class: "config-helper",
        text:
          "Un workflow par type d'image (manga, réaliste, infographie…). Yuki " +
          "choisit le PLUS PROCHE de la demande à partir du nom d'usage et de la " +
          "description courte ; le style n'est jamais recopié dans le prompt.",
      }),
      errorEl,
      listEl,
      statusEl,
      h("h3", { class: "config-group__title", text: "Importer un workflow" }),
      h("p", {
        class: "config-helper",
        text:
          "Dans ComfyUI, enregistrez votre workflow au FORMAT API (« Save (API " +
          "Format) »), puis importez le fichier ici. Un workflow d'INTERFACE " +
          "(« nodes » / « links ») est refusé.",
      }),
      h("p", {
        class: "config-helper",
        text:
          "Étiquettes reconnues, à mettre dans le TITRE du nœud (dans ComfyUI : " +
          "clic droit → Title) : YUKI_PROMPT (obligatoire, reçoit la scène), " +
          "YUKI_NEGATIVE, YUKI_SEED, YUKI_WIDTH, YUKI_HEIGHT, et YUKI_OUTPUT " +
          "(facultative : le nœud qui produit l'IMAGE FINALE — « Save Image » ou " +
          "« Preview Image »). Sans YUKI_OUTPUT, la première image produite est " +
          "retenue, ce qui peut être un aperçu intermédiaire. " +
          "YUKI_FINAL_PROMPT (facultative) : un nœud qui AFFICHE du texte " +
          "(« Preview as Text », « Show Text »…) placé APRÈS l'enhancer — son " +
          "texte est affiché sous l'image et transmis à Yuki.",
      }),
      h("div", { class: "image-import" }, [
        h("label", { class: "config-label", for: "image-workflow-name", text: "Nom d'usage" }),
        nameInput,
        h("p", {
          class: "config-helper",
          text:
            "Lettres non accentuées, chiffres, « - » et « _ » (ex. « manga », " +
            "« realiste », « infographie »). Sert de clé : il ne peut pas être dupliqué.",
        }),
        h("label", {
          class: "config-label",
          for: "image-workflow-description",
          text: "Description courte (sert au choix par proximité)",
        }),
        descriptionInput,
        h("label", { class: "config-label image-import__default" }, [
          defaultInput,
          " Utiliser ce workflow par défaut quand rien ne correspond",
        ]),
        h("label", { class: "config-label", for: "image-workflow-file", text: "Fichier du workflow (.json)" }),
        fileInput,
        h("label", { class: "config-label", for: "image-workflow-json", text: "…ou collez le JSON ici" }),
        jsonInput,
        h("div", { class: "config-actions" }, [importButton, importStatus]),
        refusalEl,
      ]),
    ]),
  );
  nameInput.id = "image-workflow-name";
  descriptionInput.id = "image-workflow-description";
  fileInput.id = "image-workflow-file";
  jsonInput.id = "image-workflow-json";

  void load();

  return { refresh: () => load() };
}
