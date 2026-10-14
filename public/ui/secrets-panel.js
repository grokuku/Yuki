/**
 * Panneau « Secrets » de la page `/config` — gestion du COFFRE CHIFFRÉ.
 *
 * Liste les NOMS des secrets enregistrés (⚠️ jamais leur valeur : l'API ne la
 * renvoie jamais), permet d'en AJOUTER / MODIFIER / SUPPRIMER à chaud.
 *
 * - `GET    /api/secrets`        → `{ configured, entries: [{ name, label?, updatedAt }] }`
 * - `POST   /api/secrets`        → `{ name, value, label? }` (ajout/remplacement)
 * - `DELETE /api/secrets/<nom>`  → suppression
 *
 * ⚠️ Le coffre REFUSE tant que la clé maître (`YUKI_VAULT_KEY`) est absente : le
 * panneau affiche alors un message honnête (aucun repli en clair).
 * ⚠️ La valeur saisie transite navigateur → serveur en HTTP (voir la limite
 * réseau documentée) puis est CHIFFRÉE ; elle n'est jamais réaffichée.
 *
 * CSP stricte (`style-src 'self'`) : aucun `<style>` injecté, aucun `style=`
 * — tout le CSS vit dans `config.css`. DOM construit avec `createElement`.
 */

const JSON_HEADERS = { accept: "application/json" };
/** En-tête d'écriture exigé par les routes protégées (même que `/api/config`). */
const WRITE_HEADERS = { "content-type": "application/json", "x-yuki-config": "1" };
/** Préfixe réservé des noms de secret (contrat du prompt / des commandes). */
const NAME_PREFIX = "YUKI_SECRET_";

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

function apiMessage(error, fallback) {
  const data = error?.data ?? {};
  return data.message ?? data.error ?? error?.message ?? fallback;
}

export function initSecretsPanel({ root, HolafFetch, HolafModal }) {
  const state = { configured: true, entries: [], error: "", status: "" };

  // Champs du formulaire (un seul formulaire, réutilisé pour ajout ET édition).
  const nameInput = h("input", {
    class: "config-secret__input",
    type: "text",
    autocomplete: "off",
    spellcheck: "false",
    placeholder: `${NAME_PREFIX}MON_SECRET`,
    "aria-label": "Nom du secret (préfixe YUKI_SECRET_ requis)",
  });
  const labelInput = h("input", {
    class: "config-secret__input",
    type: "text",
    autocomplete: "off",
    placeholder: "Usage (ex. accès NAS) — facultatif",
    "aria-label": "Libellé d'usage (facultatif)",
  });
  const valueInput = h("input", {
    class: "config-secret__input",
    type: "password",
    autocomplete: "new-password",
    spellcheck: "false",
    placeholder: "Valeur (≥ 6 caractères) — jamais réaffichée",
    "aria-label": "Valeur du secret",
  });
  const saveButton = h("button", { class: "button", type: "button", text: "Enregistrer" });
  const cancelButton = h("button", {
    class: "button button--ghost",
    type: "button",
    text: "Annuler",
    hidden: true,
  });
  const formStatus = h("span", { class: "config-save-status", role: "status" });

  function resetForm() {
    nameInput.value = "";
    labelInput.value = "";
    valueInput.value = "";
    nameInput.readOnly = false;
    cancelButton.hidden = true;
    saveButton.textContent = "Enregistrer";
    formStatus.textContent = "";
  }

  async function save() {
    const name = nameInput.value.trim();
    const value = valueInput.value;
    const label = labelInput.value.trim();
    if (name === "") {
      formStatus.textContent = "Nom requis.";
      return;
    }
    if (value.length === 0) {
      formStatus.textContent = "Valeur requise.";
      return;
    }
    saveButton.disabled = true;
    formStatus.textContent = "Enregistrement…";
    try {
      await HolafFetch.post("/api/secrets", {
        headers: WRITE_HEADERS,
        body: { name, value, ...(label !== "" ? { label } : {}) },
      });
      resetForm();
      formStatus.textContent = "Secret enregistré.";
      await load();
    } catch (error) {
      formStatus.textContent = apiMessage(error, "Échec de l'enregistrement.");
    } finally {
      saveButton.disabled = false;
    }
  }

  async function remove(name) {
    const confirmed = await HolafModal.confirm(
      "Supprimer le secret",
      `Supprimer définitivement « ${name} » ? Les commandes qui le référencent ` +
        "échoueront jusqu'à ce qu'il soit recréé.",
      { confirmText: "Supprimer", danger: true },
    );
    if (!confirmed) return;
    try {
      await HolafFetch.delete(`/api/secrets/${encodeURIComponent(name)}`, {
        headers: WRITE_HEADERS,
      });
      state.status = `Secret « ${name} » supprimé.`;
      await load();
    } catch (error) {
      state.error = apiMessage(error, "Échec de la suppression.");
      render();
    }
  }

  function edit(name, label) {
    nameInput.value = name;
    nameInput.readOnly = true; // le nom ne se renomme pas : on supprime/recrée
    labelInput.value = label ?? "";
    valueInput.value = "";
    cancelButton.hidden = false;
    saveButton.textContent = "Remplacer la valeur";
    nameInput.focus?.();
  }

  function entryRow(entry) {
    const name = String(entry?.name ?? "");
    const label = typeof entry?.label === "string" ? entry.label.trim() : "";
    return h("li", { class: "config-secret__row" }, [
      h("div", { class: "config-secret__meta" }, [
        h("span", { class: "config-secret__name", text: name }),
        ...(label !== "" ? [h("span", { class: "config-secret__label", text: label })] : []),
        h("span", { class: "config-secret__date", text: `modifié ${formatDate(entry?.updatedAt)}` }),
      ]),
      h("div", { class: "config-secret__row-actions" }, [
        h("button", {
          class: "button button--ghost button--small",
          type: "button",
          text: "Modifier",
          on: () => edit(name, label),
        }),
        h("button", {
          class: "button button--stop button--small",
          type: "button",
          text: "Supprimer",
          on: () => void remove(name),
        }),
      ]),
    ]);
  }

  function render() {
    root.textContent = "";
    root.append(
      h("section", { class: "config-secret" }, [
        h("h2", { text: "Secrets" }),
        h("p", {
          class: "config-secret__hint",
          text:
            "Les secrets sont CHIFFRÉS dans le volume d'état et ne sont JAMAIS " +
            "renvoyés par l'interface ni journalisés. Dans une commande, référence " +
            "un secret par son nom : ${YUKI_SECRET_NOM} (la valeur passe par " +
            "variable d'environnement, jamais dans la commande).",
        }),
        ...(state.error ? [h("p", { class: "config-error", text: state.error })] : []),
        ...(state.status ? [h("p", { class: "config-save-status", text: state.status })] : []),
        state.configured
          ? h("div", { class: "config-secret__body" }, [
              h("div", { class: "config-secret__form" }, [
                h("label", { class: "config-secret__field" }, [
                  h("span", { class: "config-secret__field-label", text: "Nom" }),
                  nameInput,
                ]),
                h("label", { class: "config-secret__field" }, [
                  h("span", { class: "config-secret__field-label", text: "Libellé d'usage" }),
                  labelInput,
                ]),
                h("label", { class: "config-secret__field" }, [
                  h("span", { class: "config-secret__field-label", text: "Valeur" }),
                  valueInput,
                ]),
                h("div", { class: "config-secret__form-actions" }, [
                  saveButton,
                  cancelButton,
                  formStatus,
                ]),
              ]),
              h("ul", { class: "config-secret__list" },
                state.entries.length > 0
                  ? state.entries.map(entryRow)
                  : [h("li", { class: "config-secret__empty", text: "(aucun secret enregistré)" })],
              ),
            ])
          : h("p", {
              class: "config-secret__locked",
              text:
                "Coffre verrouillé : la clé maître YUKI_VAULT_KEY n'est pas définie. " +
                "Aucun secret n'est disponible (jamais de repli en clair). Définissez " +
                "la clé hors bande puis redémarrez Yuki.",
            }),
      ]),
    );
  }

  async function load() {
    state.error = "";
    try {
      const data = await HolafFetch.get("/api/secrets", { headers: JSON_HEADERS });
      state.configured = data?.configured !== false;
      state.entries = Array.isArray(data?.entries) ? data.entries : [];
    } catch (error) {
      state.configured = false;
      state.error = apiMessage(error, "Impossible de charger les secrets.");
      state.entries = [];
    }
    render();
  }

  saveButton.addEventListener("click", () => void save());
  cancelButton.addEventListener("click", resetForm);
  valueInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void save();
  });

  render();
  void load();
  return { load, render };
}
