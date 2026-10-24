/**
 * Section « MOT DE PASSE D'INSTANCE » de la page `/config` (onglet Agents).
 *
 * Un SEUL mot de passe pour l'instance (décision utilisateur) : il déverrouille
 * les agents déclarés « matériel sensible ». Il est stocké HACHÉ (scrypt + sel)
 * sur le volume `state` (fichier `0600`, écriture atomique) : il n'est JAMAIS
 * réaffiché, JAMAIS renvoyé par l'API, JAMAIS journalisé et JAMAIS transmis au
 * modèle. Cette interface ne connaît que « défini / pas défini » + la date.
 *
 * Routes :
 *   GET    /api/config/password → { configured, updatedAt?, minLength, idleTimeoutMs, sensitiveAgents }
 *   POST   /api/config/password → { password, currentPassword? } (définir / changer)
 *   DELETE /api/config/password → retirer (REFUSÉ tant qu'un agent sensible existe)
 *
 * ⚠️ CHANGER le mot de passe exige l'ANCIEN : sans cela, une page ouverte
 * suffirait à remplacer le secret et à rouvrir tous les agents sensibles.
 *
 * CSP stricte (`style-src 'self'`) : aucun `<style>`, aucun `style=`, aucun
 * `innerHTML` — tout le CSS vit dans `config.css`.
 */

const JSON_HEADERS = { accept: "application/json" };
/** En-tête d'écriture exigé par les routes de configuration. */
const WRITE_HEADERS = { "content-type": "application/json", "x-yuki-config": "1" };

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

/**
 * Monte la section. Le mot de passe saisi n'est jamais conservé : les champs
 * sont vidés dès l'envoi (succès comme échec).
 */
export function initInstancePasswordPanel({ root, HolafFetch, HolafModal }) {
  const state = {
    configured: false,
    updatedAt: "",
    minLength: 8,
    idleTimeoutMs: 15 * 60_000,
    sensitiveAgents: 0,
    error: "",
    status: "",
    unavailable: false,
  };

  const currentInput = h("input", {
    class: "config-secret__input",
    type: "password",
    autocomplete: "current-password",
    spellcheck: "false",
    placeholder: "Ancien mot de passe",
    "aria-label": "Ancien mot de passe d'instance",
  });
  const nextInput = h("input", {
    class: "config-secret__input",
    type: "password",
    autocomplete: "new-password",
    spellcheck: "false",
    placeholder: "Nouveau mot de passe",
    "aria-label": "Nouveau mot de passe d'instance",
  });
  const confirmInput = h("input", {
    class: "config-secret__input",
    type: "password",
    autocomplete: "new-password",
    spellcheck: "false",
    placeholder: "Confirmation",
    "aria-label": "Confirmation du nouveau mot de passe d'instance",
  });
  const statusEl = h("span", { class: "config-save-status", role: "status" });
  const saveButton = h("button", {
    class: "button",
    type: "button",
    text: "Enregistrer le mot de passe",
  });
  const removeButton = h("button", {
    class: "button button--danger button--small",
    type: "button",
    text: "Retirer le mot de passe",
  });

  function clearFields() {
    currentInput.value = "";
    nextInput.value = "";
    confirmInput.value = "";
  }

  async function save() {
    const next = nextInput.value;
    const confirm = confirmInput.value;
    if (next.length < state.minLength) {
      statusEl.textContent = `Le mot de passe doit compter au moins ${state.minLength} caractères.`;
      return;
    }
    if (next !== confirm) {
      statusEl.textContent = "La confirmation ne correspond pas au mot de passe saisi.";
      return;
    }
    if (state.configured && currentInput.value === "") {
      statusEl.textContent =
        "Saisissez l'ancien mot de passe : il est exigé pour le remplacer.";
      return;
    }
    saveButton.disabled = true;
    statusEl.textContent = "Enregistrement…";
    try {
      await HolafFetch.post("/api/config/password", {
        headers: WRITE_HEADERS,
        body: {
          password: next,
          ...(state.configured && currentInput.value !== ""
            ? { currentPassword: currentInput.value }
            : {}),
        },
      });
      clearFields();
      state.status = "Mot de passe d'instance enregistré.";
      await load();
      statusEl.textContent = "Enregistré.";
    } catch (error) {
      // Message du serveur tel quel (mauvais ancien mot de passe, trop court…).
      statusEl.textContent = apiMessage(error, "Échec de l'enregistrement.");
    } finally {
      clearFields();
      saveButton.disabled = false;
    }
  }

  async function remove() {
    const confirmed = await HolafModal.confirm(
      "Retirer le mot de passe d'instance ?",
      "Sans mot de passe d'instance, plus aucun agent « matériel sensible » ne " +
        "pourra être déverrouillé — et il sera impossible d'en déclarer un nouveau " +
        "sans en définir un d'abord. Le retrait est refusé tant qu'un agent " +
        "sensible existe.",
      { confirmText: "Retirer", danger: true },
    );
    if (!confirmed) return;
    try {
      await HolafFetch.delete("/api/config/password", { headers: WRITE_HEADERS });
      state.status = "Mot de passe d'instance retiré.";
      await load();
    } catch (error) {
      state.error = apiMessage(error, "Retrait impossible.");
      render();
    }
  }

  function render() {
    root.textContent = "";
    const section = h("section", { class: "config-password" });
    section.append(
      h("h2", { text: "Mot de passe d'instance" }),
      h("p", {
        class: "config-helper",
        text:
          "UN SEUL mot de passe pour toute l'instance : il déverrouille les agents " +
          "déclarés « matériel sensible » (onglet ci-dessous). Il est stocké HACHÉ " +
          "(scrypt + sel) sur le volume d'état et n'est jamais réaffiché, ni renvoyé " +
          "par l'API, ni journalisé, ni transmis au modèle.",
      }),
    );
    if (state.unavailable) {
      section.append(
        h("p", {
          class: "config-error",
          text:
            "Mot de passe d'instance indisponible sur cette instance : la fonction " +
            "n'est pas câblée côté serveur. Aucun agent sensible ne peut être " +
            "déverrouillé (déclarer un agent sensible est refusé).",
        }),
      );
      root.append(section);
      return;
    }
    section.append(
      h("p", {
        class: "config-helper",
        text: state.configured
          ? `Mot de passe défini le ${formatDate(state.updatedAt)}.`
          : "Aucun mot de passe d'instance n'est défini : il est IMPOSSIBLE de " +
            "déverrouiller un agent sensible (et donc impossible d'en déclarer un).",
      }),
    );
    if (state.error) section.append(h("p", { class: "config-error", text: state.error }));
    if (state.status) {
      section.append(h("p", { class: "config-save-status", text: state.status }));
    }

    const body = h("div", { class: "config-password__body" });
    const form = h("div", { class: "config-secret__form" });
    if (state.configured) {
      form.append(
        h("label", { class: "config-secret__field" }, [
          h("span", { class: "config-secret__field-label", text: "Ancien mot de passe" }),
          currentInput,
        ]),
      );
    }
    form.append(
      h("label", { class: "config-secret__field" }, [
        h("span", {
          class: "config-secret__field-label",
          text: state.configured ? "Nouveau mot de passe" : "Mot de passe",
        }),
        nextInput,
      ]),
      h("label", { class: "config-secret__field" }, [
        h("span", { class: "config-secret__field-label", text: "Confirmation" }),
        confirmInput,
      ]),
      h("div", { class: "config-secret__form-actions" }, [
        saveButton,
        ...(state.configured ? [removeButton] : []),
        statusEl,
      ]),
    );
    body.append(form);
    body.append(
      h("p", {
        class: "config-helper",
        text:
          `Un agent sensible se reverrouille tout seul après ` +
          `${Math.round(state.idleTimeoutMs / 60000)} min d'INACTIVITÉ (le compte ` +
          "repart à zéro à chaque commande réellement transmise). Son niveau de " +
          "validation n'est jamais modifié.",
      }),
    );
    if (state.sensitiveAgents > 0) {
      body.append(
        h("p", {
          class: "config-helper",
          text:
            `${state.sensitiveAgents} agent(s) déclaré(s) « matériel sensible » : ` +
            "le mot de passe ne peut pas être retiré tant qu'il en existe un (ils " +
            "seraient impossible à déverrouiller).",
        }),
      );
    }
    section.append(body);
    root.append(section);
  }

  async function load() {
    state.error = "";
    try {
      const data = await HolafFetch.get("/api/config/password", { headers: JSON_HEADERS });
      state.unavailable = false;
      state.configured = data?.configured === true;
      state.updatedAt = typeof data?.updatedAt === "string" ? data.updatedAt : "";
      const min = Number(data?.minLength);
      if (Number.isFinite(min) && min > 0) state.minLength = Math.trunc(min);
      const idle = Number(data?.idleTimeoutMs);
      if (Number.isFinite(idle) && idle > 0) state.idleTimeoutMs = idle;
      const sensitive = Number(data?.sensitiveAgents);
      state.sensitiveAgents = Number.isFinite(sensitive) ? Math.trunc(sensitive) : 0;
    } catch (error) {
      const code = error?.data?.code ?? error?.data?.error;
      if (code === "password_unavailable") {
        state.unavailable = true;
      } else {
        state.error = apiMessage(error, "Impossible de lire l'état du mot de passe d'instance.");
      }
    }
    render();
  }

  saveButton.addEventListener("click", () => void save());
  removeButton.addEventListener("click", () => void remove());
  for (const input of [currentInput, nextInput, confirmInput]) {
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void save();
      }
    });
  }

  render();
  void load();
  return { load, render };
}
