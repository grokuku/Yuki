/**
 * Panneau « Voix » de la page `/config` (Lot 7, §10.5) — vanilla, sans build.
 *
 * Fonctions :
 *   - lister les voix du registre (`GET /api/voices`) ;
 *   - choisir la voix active (`PUT /api/config` → `tts.voice`, `hot`) ;
 *   - écouter un échantillon (`GET /api/voices/{id}/sample`) et un aperçu de
 *     synthèse (`POST /api/voices/{id}/preview`) — **par Web Audio**
 *     (`fetch` + `decodeAudioData`) ; `<audio src>` est interdit par la CSP ;
 *   - **cloner** une voix par **upload de fichier** (`POST /api/voices/clone`,
 *     corps binaire + métadonnées en en-têtes) dans une modale `HolafModal` ;
 *   - renommer (`PATCH`) et supprimer (`DELETE`, clones uniquement, avec
 *     confirmation `HolafModal`).
 *
 * CSP (`style-src 'self'`) : aucun `<style>` injecté, aucun `style=` — tout le
 * CSS vit dans `config.css` / `holaf-modal.css` (servis par `<link>`).
 */

const JSON_HEADERS = { accept: "application/json" };
const WRITE_HEADERS = { "x-yuki-config": "1" };
/** Limite serveur de l'échantillon (D20, §10.4) : 3 Mo. */
export const MAX_VOICE_BODY_BYTES = 3_000_000;

/** Petit helper DOM (aucun `style=` : uniquement des attributs). */
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

function field(labelText, control, helperText) {
  const label = h("label", { class: "voices-field-label" }, [labelText]);
  const wrap = h("div", { class: "voices-field" }, [label, control]);
  if (helperText) wrap.append(h("p", { class: "config-helper", text: helperText }));
  return wrap;
}

/** Message d'erreur lisible à partir d'une `HolafFetchError`. */
function apiErrorMessage(error) {
  const status = error?.status;
  const data = error?.data ?? {};
  const serverMessage = data.message ?? data.error;
  switch (status) {
    case 413:
      return "Fichier trop volumineux (maximum 3 Mo).";
    case 422:
      return serverMessage || "Format invalide : WAV PCM de 10 s maximum requis.";
    case 429:
      return serverMessage || "Quota de voix clonées atteint.";
    case 409:
      return serverMessage || "Cette voix ne peut pas être supprimée.";
    case 404:
      return serverMessage || "Voix introuvable.";
    case 400:
      return serverMessage || "Requête invalide.";
    default:
      return serverMessage || (error instanceof Error ? error.message : String(error));
  }
}

/**
 * Initialise le panneau des voix dans `deps.root`.
 *
 * @param {object} deps
 * @param {HTMLElement} deps.root
 * @param {object} deps.HolafFetch
 * @param {object} deps.HolafModal
 * @param {object} deps.player Lecteur Web Audio (`createTtsPlayer()`).
 * @param {() => string} [deps.getActiveVoice] Valeur courante de `tts.voice`.
 * @param {(id: string) => void} [deps.onVoiceSelected] Notifie config.js.
 * @returns {{ refresh: () => Promise<void> }}
 */
export function initVoicesPanel(deps) {
  const { root, HolafFetch, HolafModal, player } = deps;
  const getActiveVoice =
    typeof deps.getActiveVoice === "function" ? deps.getActiveVoice : () => "";

  let voices = [];
  let busy = false;

  const status = h("p", {
    class: "config-helper voices-status",
    role: "status",
    "aria-live": "polite",
  });

  const select = h("select", {
    class: "config-select",
    id: "voices-select",
    "aria-label": "Voix active",
  });

  const list = h("div", { class: "voices-list" });

  const cloneButton = h("button", {
    class: "button",
    type: "button",
    text: "Cloner une voix",
  });
  cloneButton.addEventListener("click", () => openCloneModal());

  select.addEventListener("change", () => {
    void setActiveVoice(select.value);
  });

  const head = h("div", { class: "config-group__head" }, [
    h("h2", { class: "config-group__title", text: "Ma voix" }),
    h("div", { class: "config-secret" }, [cloneButton]),
  ]);

  const section = h("section", { class: "config-group", id: "voices" }, [
    head,
    h("p", {
      class: "config-intro",
      text:
        "Les voix prédéfinies viennent avec Yuki ; les voix clonées sont créées " +
        "par upload d'un échantillon. Le sélecteur ci-dessous est l'UNIQUE " +
        "contrôle de la voix active : il l'enregistre immédiatement côté serveur " +
        "(champ tts.voice). La lecture nécessite que la voix soit activée " +
        "(réglage « Activer la voix », zone « Réglages de la voix » ci-dessous).",
    }),
    field("Voix active", select),
    list,
    status,
  ]);
  root.append(section);

  function setStatus(text, isError = false) {
    status.textContent = text ?? "";
    status.classList.toggle("config-status--error", isError);
  }

  function activeVoice() {
    return voices.find((voice) => voice.id === getActiveVoice()) ?? null;
  }

  function syncSelect() {
    const current = getActiveVoice();
    select.textContent = "";
    select.append(
      h("option", { value: "", text: "Voix par défaut (preset du moteur)" }),
    );
    for (const voice of voices) {
      select.append(
        h("option", {
          value: voice.id,
          text: `${voice.label} — ${voice.kind === "preset" ? "prédéfinie" : "clonée"}`,
        }),
      );
    }
    select.value = voices.some((voice) => voice.id === current) ? current : "";
  }

  function kindBadge(kind) {
    return h("span", {
      class: `badge badge--${kind === "preset" ? "restart" : "hot"}`,
      text: kind === "preset" ? "prédéfinie" : "clonée",
    });
  }

  function renderList() {
    list.textContent = "";
    if (voices.length === 0) {
      list.append(
        h("p", { class: "config-helper", text: "Aucune voix dans le registre." }),
      );
      return;
    }
    const current = getActiveVoice();
    for (const voice of voices) {
      const row = h("div", { class: "voices-row" });
      const title = h("div", { class: "voices-row__title" }, [
        h("span", { class: "voices-row__label", text: voice.label }),
        kindBadge(voice.kind),
        ...(voice.id === current
          ? [h("span", { class: "badge badge--hot", text: "voix active" })]
          : []),
      ]);

      const actions = h("div", { class: "voices-row__actions" });
      const listen = h("button", {
        class: "button button--ghost button--small",
        type: "button",
        text: "Écouter",
      });
      listen.addEventListener("click", () => void playSample(voice, listen));
      actions.append(listen);

      if (voice.demoAvailable) {
        const preview = h("button", {
          class: "button button--ghost button--small",
          type: "button",
          text: "Aperçu de synthèse",
        });
        preview.addEventListener("click", () => void playPreview(voice, preview));
        actions.append(preview);
      }

      const rename = h("button", {
        class: "button button--ghost button--small",
        type: "button",
        text: "Renommer",
      });
      rename.addEventListener("click", () => void renameVoice(voice));

      actions.append(rename);

      if (voice.kind === "cloned") {
        const remove = h("button", {
          class: "button button--danger button--small",
          type: "button",
          text: "Supprimer",
        });
        remove.addEventListener("click", () => void removeVoice(voice));
        actions.append(remove);
      }

      if (voice.id !== current) {
        const use = h("button", {
          class: "button button--ghost button--small",
          type: "button",
          text: "Utiliser",
        });
        use.addEventListener("click", () => void setActiveVoice(voice.id));
        actions.append(use);
      }

      row.append(title, actions);
      list.append(row);
    }
  }

  async function load() {
    setStatus("Chargement des voix…");
    try {
      const body = await HolafFetch.get("/api/voices", { headers: JSON_HEADERS });
      voices = Array.isArray(body?.voices) ? body.voices : [];
      setStatus("");
    } catch (error) {
      voices = [];
      setStatus(
        `Impossible de charger les voix : ${apiErrorMessage(error)}`,
        true,
      );
    }
    syncSelect();
    renderList();
  }

  async function setActiveVoice(id) {
    if (busy) return;
    busy = true;
    setStatus("Enregistrement de la voix active…");
    try {
      await HolafFetch.put("/api/config", {
        headers: WRITE_HEADERS,
        body: { "tts.voice": id ?? "" },
      });
      setStatus(id ? "Voix active mise à jour." : "Voix par défaut réactivée.");
      deps.onVoiceSelected?.(id ?? "");
    } catch (error) {
      setStatus(`Échec : ${apiErrorMessage(error)}`, true);
    } finally {
      busy = false;
      await refresh();
    }
  }

  async function fetchWav(url, method = "GET") {
    const response = await HolafFetch.request(url, {
      method,
      headers: WRITE_HEADERS,
      raw: true,
    });
    if (!response.ok) {
      let data = {};
      try {
        data = await response.json();
      } catch {
        /* corps non JSON */
      }
      const error = new Error(data.message ?? `HTTP ${response.status}`);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return response.arrayBuffer();
  }

  async function playSample(voice, button) {
    button.disabled = true;
    setStatus(`Écoute de « ${voice.label} »…`);
    try {
      const buffer = await fetchWav(`/api/voices/${encodeURIComponent(voice.id)}/sample`);
      const ok = await player.playWav(buffer);
      setStatus(ok ? "" : "Échantillon illisible.", !ok);
    } catch (error) {
      setStatus(`Écoute impossible : ${apiErrorMessage(error)}`, true);
    } finally {
      button.disabled = false;
    }
  }

  async function playPreview(voice, button) {
    button.disabled = true;
    setStatus("Synthèse de démonstration en cours…");
    try {
      const buffer = await fetchWav(
        `/api/voices/${encodeURIComponent(voice.id)}/preview`,
        "POST",
      );
      const ok = await player.playWav(buffer);
      setStatus(ok ? "" : "Aperçu illisible.", !ok);
    } catch (error) {
      setStatus(`Aperçu indisponible : ${apiErrorMessage(error)}`, true);
    } finally {
      button.disabled = false;
    }
  }

  async function renameVoice(voice) {
    const label = await HolafModal.prompt(
      "Renommer la voix",
      `Nouveau libellé pour « ${voice.label} » :`,
      { initial: voice.label, okText: "Renommer", cancelText: "Annuler" },
    );
    if (label === null) return;
    const trimmed = label.trim();
    if (trimmed.length === 0) {
      setStatus("Le libellé ne peut pas être vide.", true);
      return;
    }
    try {
      await HolafFetch.patch(`/api/voices/${encodeURIComponent(voice.id)}`, {
        headers: WRITE_HEADERS,
        body: { label: trimmed },
      });
      setStatus("Voix renommée.");
    } catch (error) {
      setStatus(`Échec du renommage : ${apiErrorMessage(error)}`, true);
    }
    await refresh();
  }

  async function removeVoice(voice) {
    const confirmed = await HolafModal.confirm(
      "Supprimer cette voix ?",
      `« ${voice.label} » et son échantillon seront supprimés définitivement.`,
      { danger: true, confirmText: "Supprimer", cancelText: "Annuler" },
    );
    if (!confirmed) return;
    try {
      await HolafFetch.delete(`/api/voices/${encodeURIComponent(voice.id)}`, {
        headers: WRITE_HEADERS,
      });
      setStatus("Voix supprimée.");
    } catch (error) {
      setStatus(`Échec de la suppression : ${apiErrorMessage(error)}`, true);
    }
    await refresh();
  }

  function openCloneModal() {
    const fileInput = h("input", {
      class: "config-input",
      type: "file",
      accept: "audio/wav,audio/x-wav,.wav",
      "aria-label": "Fichier WAV de l'échantillon",
    });
    const labelInput = h("input", {
      class: "config-input",
      type: "text",
      maxlength: "80",
      placeholder: "ex. Camille (FR)",
      "aria-label": "Libellé de la voix",
    });
    const langSelect = h(
      "select",
      { class: "config-select", "aria-label": "Langue" },
      [h("option", { value: "fr", text: "français (fr)" })],
    );
    const refText = h("textarea", {
      class: "config-textarea",
      rows: "3",
      placeholder: "Transcription de l'échantillon (optionnel)",
      "aria-label": "Transcription de l'échantillon",
    });
    const modalStatus = h("p", {
      class: "config-helper",
      role: "status",
      "aria-live": "polite",
    });
    const localPreview = h("button", {
      class: "button button--ghost button--small",
      type: "button",
      text: "Écouter l'échantillon local",
    });

    const content = h("div", { class: "voices-form" }, [
      field("Fichier WAV", fileInput),
      field("Libellé de la voix", labelInput),
      field("Langue", langSelect),
      field("Transcription (optionnel)", refText),
      h("p", {
        class: "config-helper",
        text:
          "Upload de fichier uniquement (pas d'enregistrement micro). " +
          "WAV PCM, durée ≤ 10 s, taille ≤ 3 Mo.",
      }),
      h("div", { class: "voices-form__actions" }, [localPreview]),
      modalStatus,
    ]);

    const ctrl = HolafModal.open({
      title: "Cloner une voix",
      size: "md",
      content,
      closeOnOverlay: false,
      buttons: [
        { text: "Annuler", type: "cancel", guard: false },
        { text: "Créer la voix", type: "primary", value: true },
      ],
      guard: async (result) => {
        if (result !== true) return true;
        const ok = await submitClone({
          fileInput,
          labelInput,
          refText,
          modalStatus,
        });
        if (ok) setStatus("Voix clonée.");
        return ok;
      },
      onClose: (value) => {
        if (value === true) void refresh();
      },
    });

    localPreview.addEventListener("click", async () => {
      const file = fileInput.files?.[0];
      if (!file) {
        modalStatus.textContent = "Choisissez d'abord un fichier WAV.";
        return;
      }
      const buffer = await file.arrayBuffer();
      const ok = await player.playWav(buffer);
      modalStatus.textContent = ok
        ? "Lecture de l'échantillon local…"
        : "Échantillon illisible (WAV attendu).";
    });

    // Entrée dans le champ libellé = créer (comme un formulaire).
    labelInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      // Passe par le bouton primaire → déclenche le `guard` (upload).
      ctrl.footer?.querySelector(".holaf-modal-btn-primary")?.click();
    });
  }

  async function submitClone({ fileInput, labelInput, refText, modalStatus }) {
    const file = fileInput.files?.[0];
    if (!file) {
      modalStatus.textContent = "Fichier WAV requis.";
      return false;
    }
    const label = labelInput.value.trim();
    if (label.length === 0) {
      modalStatus.textContent = "Libellé requis (1 à 80 caractères).";
      return false;
    }
    if (file.size > MAX_VOICE_BODY_BYTES) {
      modalStatus.textContent = "Fichier trop volumineux (maximum 3 Mo).";
      return false;
    }
    modalStatus.textContent = "Clonage en cours…";
    let bytes;
    try {
      bytes = await file.arrayBuffer();
    } catch {
      modalStatus.textContent = "Lecture du fichier impossible.";
      return false;
    }
    const headers = {
      ...WRITE_HEADERS,
      "content-type": file.type || "audio/wav",
      "x-voice-label": label,
      "x-voice-lang": "fr",
    };
    const ref = refText.value.trim();
    if (ref.length > 0) headers["x-voice-ref-text"] = ref;
    try {
      await HolafFetch.post("/api/voices/clone", { headers, body: bytes });
      return true;
    } catch (error) {
      modalStatus.textContent = `Échec du clonage : ${apiErrorMessage(error)}`;
      return false;
    }
  }

  async function refresh() {
    await load();
  }

  void load();
  return { refresh };
}
