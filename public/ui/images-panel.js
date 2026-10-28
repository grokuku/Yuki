/**
 * Panneau « Images générées » de la page `/config` — serveur ComfyUI.
 *
 * ⚠️ MONTÉ DANS L'ONGLET « IMAGES » (onglet PROPRE, `#panel-images`), et non plus
 * en bas de l'onglet « Système » où il était introuvable.
 *
 * Deux zones (dans cet onglet) :
 *   ① ÉTAT du serveur et RÉGLAGES (URL + clé + « Tester la connexion » + largeur
 *     + hauteur + délai) : rendus par la mécanique de configuration commune
 *     (`#group-images`, voir `config.js`) ;
 *   ② WORKFLOWS importés : nom d'usage, description courte, « par défaut »,
 *     consignes d'écriture (documentation), étiquettes trouvées / manquantes,
 *     bouton « Éditer » TOUJOURS VISIBLE, suppression ; puis l'IMPORT d'un
 *     workflow au FORMAT API (collage ou fichier `.json`).
 *
 * Routes utilisées (aucune dépendance nouvelle, `HolafFetch` de la brique) :
 *   GET    /api/images/workflows            → { workflows: [...] }
 *   POST   /api/images/workflows            → import (refus explicite sinon)
 *   PUT    /api/images/workflows/<nom>      → description + consignes d'écriture
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
 * ⚠️ Le NOM d'usage n'est PAS modifiable : il est la CLÉ du workflow
 * (`PUT /api/images/workflows/<nom>`, désigné par `consulter_workflow` et
 * `generer_image`). L'éditeur le DIT et donne la marche à suivre.
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

/**
 * Longueur maximale de la DESCRIPTION COURTE d'un workflow (caractères).
 * ⚠️ MÊME borne que le serveur (`MAX_COMFY_DESCRIPTION_CHARS`) : elle est
 * OBLIGATOIRE (c'est elle qui permet de choisir le workflow par proximité).
 */
const MAX_DESCRIPTION_CHARS = 200;

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
   * ÉDITEUR D'UN WORKFLOW (modale `HolafModal`).
   *
   * ⚠️ POURQUOI UNE MODALE (et pas un formulaire en place dans la carte) : la
   * zone des consignes vivait DANS chaque carte, tout en bas du dernier onglet —
   * c'est ce qui la rendait introuvable. La modale met les quatre champs au même
   * endroit, VISIBLES sans dépliage, avec le compteur `x / 8000`, et elle est
   * utilisable au doigt (HolafModal occupe l'écran sur téléphone). La carte reste
   * compacte : la liste des workflows se lit d'un coup d'œil.
   *
   * ⚠️ Le NOM d'usage est affiché mais NON modifiable : il est la CLÉ du
   * workflow (`PUT /api/images/workflows/<nom>`, désigné par `consulter_workflow`
   * et `generer_image`). Le renommer casserait ces références.
   */
  function openEditor(summary) {
    const name = summary.name;
    const current = typeof summary.documentation === "string" ? summary.documentation : "";

    const descriptionInput = h("input", {
      class: "config-input",
      type: "text",
      maxlength: String(MAX_DESCRIPTION_CHARS),
      "aria-label": `Description courte du workflow ${name}`,
    });
    descriptionInput.id = "image-edit-description";
    descriptionInput.value =
      typeof summary.description === "string" ? summary.description : "";

    const defaultInput = h("input", { type: "checkbox" });
    defaultInput.id = "image-edit-default";
    defaultInput.checked = summary.isDefault === true;
    // ⚠️ On ne peut pas RETIRER le défaut à un workflow : un défaut existe
    // toujours (c'est le repli du choix par proximité). On le DIT au lieu de
    // laisser une case qui ne ferait rien.
    defaultInput.disabled = summary.isDefault === true;

    const counter = h("span", {
      class: "config-helper",
      text: `${current.length} / ${MAX_DOCUMENTATION_CHARS}`,
    });
    const textarea = h("textarea", {
      class: "config-textarea",
      rows: "12",
      maxlength: String(MAX_DOCUMENTATION_CHARS),
      spellcheck: "true",
      placeholder:
        "Comment écrire la scène pour CE workflow (ex. « commence par le sujet et le " +
        "cadrage, puis le décor ; deux phrases suffisent ; évite les listes »).",
      "aria-label": `Consignes d'écriture du workflow ${name}`,
    });
    textarea.id = "image-edit-documentation";
    textarea.value = current;
    textarea.addEventListener("input", () => {
      counter.textContent = `${textarea.value.length} / ${MAX_DOCUMENTATION_CHARS}`;
    });

    const statusEl = h("span", { class: "config-save-status", role: "status" });

    const form = h("form", { class: "image-edit" }, [
      h("p", { class: "config-label", text: `Nom d'usage : ${name}` }),
      h("p", {
        class: "config-helper",
        text:
          "Le nom d'usage est la CLÉ du workflow : il n'est pas modifiable ici " +
          "(il désigne le workflow pour Yuki et dans les routes). Pour le changer : " +
          "réimportez le workflow sous le nouveau nom, puis supprimez l'ancien.",
      }),
      h("label", {
        class: "config-label",
        for: "image-edit-description",
        text: "Description courte (sert au choix par proximité)",
      }),
      descriptionInput,
      h("label", { class: "config-label image-import__default" }, [
        defaultInput,
        " Utiliser ce workflow par défaut quand rien ne correspond",
      ]),
      summary.isDefault
        ? h("p", {
            class: "config-helper",
            text:
              "Ce workflow EST le par défaut (case verrouillée) : pour en changer, " +
              "cliquez sur « Définir par défaut » sur un autre workflow.",
          })
        : null,
      h("p", {
        class: "config-label",
        text: "Consignes d'écriture pour Yuki (facultatives)",
      }),
      h("p", {
        class: "config-helper",
        text:
          "Ces consignes décrivent COMMENT ÉCRIRE la scène pour ce workflow. Yuki " +
          "les consulte avec l'outil « consulter_workflow » avant de générer : elles " +
          "ne sont jamais envoyées au serveur ComfyUI, et jamais ajoutées au prompt " +
          `de chaque tour. Maximum ${MAX_DOCUMENTATION_CHARS} caractères (au-delà, ` +
          "l'enregistrement est refusé : rien n'est tronqué en silence).",
      }),
      textarea,
      h("div", { class: "config-actions" }, [counter, statusEl]),
    ]);

    let ctrl = null;
    let saving = false;

    /**
     * Enregistre les MÉTADONNÉES ÉDITABLES en UNE intention : description courte
     * (obligatoire), consignes d'écriture, et « par défaut ».
     *
     * ⚠️ Un texte trop long est REFUSÉ par le serveur : on affiche la longueur
     * réelle reçue en retour, jamais une troncature silencieuse.
     * ⚠️ Le store VALIDE les deux valeurs avant d'écrire (aucun enregistrement
     * partiel) : un refus ne modifie NI la description NI les consignes.
     */
    async function save() {
      if (saving) return;
      const description = descriptionInput.value.trim();
      const documentation = textarea.value.trim();
      if (description === "") {
        statusEl.textContent =
          "La description courte est OBLIGATOIRE : c'est elle qui permet de " +
          "choisir ce workflow par proximité.";
        descriptionInput.focus();
        return;
      }
      if (documentation.length > MAX_DOCUMENTATION_CHARS) {
        statusEl.textContent =
          `Trop long : ${documentation.length} caractères, maximum ` +
          `${MAX_DOCUMENTATION_CHARS}. Raccourcis les consignes puis réessaie.`;
        textarea.focus();
        return;
      }
      saving = true;
      if (ctrl) ctrl.setBusy(true, "Enregistrement…");
      statusEl.textContent = "Enregistrement…";
      try {
        await HolafFetch.put(`/api/images/workflows/${encodeURIComponent(name)}`, {
          headers: WRITE_HEADERS,
          body: { description, documentation },
        });
        // ⚠️ « par défaut » passe par SA route (une seule autorité : le store) ;
        // on ne la déclenche que si la case vient d'être cochée.
        if (defaultInput.checked && summary.isDefault !== true) {
          await HolafFetch.post(`/api/images/workflows/${encodeURIComponent(name)}/defaut`, {
            headers: WRITE_HEADERS,
          });
        }
        statusEl.textContent =
          documentation === ""
            ? `« ${name} » enregistré (aucune consigne particulière).`
            : `« ${name} » enregistré (${documentation.length} caractères de consignes).`;
        await load();
        if (ctrl) {
          ctrl.setBusy(false);
          ctrl.close("saved");
        }
      } catch (error) {
        statusEl.textContent = apiMessage(error, "L'enregistrement a échoué.");
      } finally {
        saving = false;
        if (ctrl) ctrl.setBusy(false);
      }
    }

    // Entrée dans un champ soumet le formulaire (comportement natif ATTENDU)
    // sans jamais recharger la page.
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void save();
    });

    ctrl = HolafModal.open({
      id: "image-workflow-edit",
      title: `Éditer le workflow « ${name} »`,
      size: "lg",
      content: form,
      closeOnOverlay: false,
      buttons: [
        { text: "Annuler", type: "cancel", value: null },
        {
          text: "Enregistrer",
          type: "primary",
          close: false,
          onClick: () => {
            void save();
          },
        },
      ],
    });
    textarea.focus();
  }

  function buildCard(summary) {
    // ⚠️ « Éditer » est un bouton PLEIN (pas `button--small`, pas d'apparition au
    // survol) : il est TOUJOURS visible et utilisable au doigt.
    const edit = h("button", {
      class: "button image-workflow__edit",
      type: "button",
      text: "Éditer",
    });
    edit.setAttribute("aria-label", `Éditer le workflow ${summary.name}`);
    edit.addEventListener("click", () => openEditor(summary));
    const head = h("div", { class: "image-workflow__head" }, [
      h("span", { class: "image-workflow__name", text: summary.name }),
      summary.isDefault
        ? h("span", { class: "badge badge--hot", text: "par défaut" })
        : h("span", { class: "badge", text: "secondaire" }),
      edit,
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
    // ⚠️ Les CONSIGNES D'ÉCRITURE sont résumées ICI et éditées dans la modale
    // « Éditer » : la carte reste lisible et les consignes restent trouvables.
    const docChars =
      typeof summary.documentation === "string" ? summary.documentation.length : 0;
    const docNote = h("p", {
      class: "config-helper image-workflow__doc-summary",
      text:
        docChars === 0
          ? "Consignes d'écriture : AUCUNE — cliquez sur « Éditer » pour en ajouter."
          : `Consignes d'écriture : ${docChars} caractère(s) — cliquez sur « Éditer » ` +
            "pour les lire ou les modifier.",
    });
    const actions = h("div", { class: "image-workflow__actions" });
    if (!summary.isDefault) {
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
      docNote,
      actions,
    ]);
  }

  /**
   * ÉTAT VIDE explicite : on DIT qu'il n'y a aucun workflow et on donne le
   * bouton qui mène directement au formulaire d'import (qui est plus bas dans
   * l'onglet).
   */
  function emptyState() {
    const importButton = h("button", {
      class: "button",
      type: "button",
      text: "Importer un workflow",
    });
    importButton.addEventListener("click", () => {
      // Le formulaire d'import est plus bas dans le même onglet : on y va et on
      // place le curseur sur le premier champ (aucun style en ligne).
      nameInput.scrollIntoView({ block: "center" });
      nameInput.focus();
    });
    return h("div", { class: "image-empty" }, [
      h("p", {
        class: "image-empty__title",
        text: "Aucun workflow importé — importez-en un pour commencer.",
      }),
      h("p", {
        class: "config-helper",
        text:
          "Tant qu'il n'y en a pas, l'outil de génération d'image refuse " +
          "explicitement de générer.",
      }),
      importButton,
    ]);
  }

  function renderList() {
    listEl.textContent = "";
    if (state.workflows.length === 0) {
      listEl.append(emptyState());
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
      h("p", {
        class: "config-helper",
        text:
          "« Éditer » ouvre la description courte, le « par défaut » et les " +
          "CONSIGNES D'ÉCRITURE (comment écrire la scène pour ce workflow) : " +
          "c'est là que se règlent les consignes que Yuki lit avec l'outil " +
          "« consulter_workflow ».",
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
