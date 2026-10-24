// Yuki — « CONTINUER DANS UNE CONVERSATION DÉDIÉE ».
//
// Depuis la conversation ouverte, l'utilisateur DONNE UN SUJET (« le coffre de
// secrets ») ; le serveur produit un RÉCAPITULATIF EXHAUSTIF axé sur ce sujet
// (jamais un résumé), puis — après APERÇU — crée une NOUVELLE conversation
// dédiée dont ce récapitulatif est le POINT DE DÉPART. Le fil d'origine n'est
// JAMAIS modifié.
//
// ⚠️ Deux temps, par TRAMES de contrôle :
//   1. `recap_preview` → `recap_ready` (APERÇU relisible et corrigeable : c'est
//      le garde-fou contre la perte d'information) ;
//   2. `recap_create`  → la conversation est créée côté serveur (tout ou rien).
//
// ⚠️ CSP stricte : aucun `innerHTML`, aucun style en ligne, DOM construit par
// `createElement`, fenêtres via `HolafModal` (jamais `window.confirm`).

/** Libellé accessible du déclencheur (porté par `aria-label` ET `title`). */
export const RECAP_TRIGGER_LABEL = "Continuer un sujet dans une conversation dédiée";

/** Titre de la saisie du sujet. */
export const RECAP_SUBJECT_TITLE = "Conversation dédiée";

/** Consigne de la saisie du sujet (le sujet peut être vide). */
export const RECAP_SUBJECT_HINT =
  "Quel SUJET veux-tu isoler dans une conversation dédiée ? " +
  "Laisse vide pour récapituler toute la conversation.";

/** Titre de la fenêtre d'aperçu. */
export const RECAP_PREVIEW_TITLE = "Aperçu du récapitulatif";

/** Texte d'attente pendant la génération. */
export const RECAP_BUSY_LABEL = "Récapitulatif en cours… (cela peut prendre un moment)";

/**
 * Libellé d'attente d'un récapitulatif DÉCOUPÉ (plusieurs appels modèle). Rend
 * l'attente VISIBLE sans laisser croire que c'est planté.
 */
export function recapProgressLabel(part, total) {
  const p = Number.isFinite(part) ? part : 0;
  const t = Number.isFinite(total) ? total : 0;
  return (
    `Récapitulatif en cours… partie ${p}/${t} — conversation volumineuse : ` +
    "plusieurs appels au modèle sont nécessaires, cela peut prendre plusieurs minutes."
  );
}

/** Libellé du bouton qui crée la conversation. */
export const RECAP_CREATE_LABEL = "Créer la conversation";

/**
 * Décision PURE : la trame concerne-t-elle la requête en attente ?
 * `pending` est `{ requestId, phase }` (`phase` ∈ `preview`|`create`).
 */
export function isRecapFrame(frame, pending) {
  if (!frame || typeof frame !== "object" || !pending) return false;
  if (typeof frame.requestId !== "string") return false;
  return frame.requestId === pending.requestId;
}

/** Réglages de l'aperçu (bornes de saisie) — testables. */
export const RECAP_TITLE_INPUT_MAX = 80;

/**
 * Valide l'aperçu saisi par l'humain. Renvoie `{ ok: true, title, recap }` ou
 * `{ ok: false, message }`.
 */
export function validatePreview(title, recap) {
  const cleanTitle = String(title ?? "").replace(/\s+/g, " ").trim();
  if (cleanTitle.length === 0) {
    return { ok: false, message: "Le titre ne peut pas être vide." };
  }
  const cleanRecap = String(recap ?? "").trim();
  if (cleanRecap.length === 0) {
    return { ok: false, message: "Le récapitulatif ne peut pas être vide." };
  }
  return { ok: true, title: cleanTitle, recap: cleanRecap };
}

/**
 * Câble l'action « conversation dédiée ».
 *
 * @param {object} deps
 * @param {HTMLElement} [deps.trigger] bouton déclencheur HISTORIQUE. Il n'y en a
 *   plus dans le composeur : le déclencheur est l'entrée « Conversation dédiée… »
 *   du MENU DU TITRE (`sessions-panel.js`), qui appelle `open()` ci-dessous.
 *   Le paramètre reste accepté (aucun autre appelant à casser).
 * @param {(payload: object) => boolean} deps.send envoi d'une trame au gateway.
 * @param {() => (string|null)} deps.getSessionId conversation FOCALISÉE courante.
 * @param {object} deps.modal brique `HolafModal`.
 * @param {Document} [deps.doc]
 * @param {(() => void)} [deps.onSent] appelé après un envoi réussi (ex. focus).
 * @returns {{ handleFrame: (frame: object) => boolean, isBusy: () => boolean,
 *   destroy: () => void }}
 */
export function createRecapDedicated({
  trigger,
  send,
  getSessionId,
  modal,
  onSent,
  doc = typeof document !== "undefined" ? document : undefined,
} = {}) {
  if (!doc) throw new Error("createRecapDedicated : document requis");
  let counter = 0;
  /** @type {{requestId: string, phase: "preview"|"create"}|null} */
  let pending = null;
  /** @type {{close: () => void}|null} */
  let busy = null;

  function closeBusy() {
    if (busy) {
      busy.close();
      busy = null;
    }
  }

  function reset() {
    closeBusy();
    pending = null;
  }

  function nextRequestId() {
    counter += 1;
    return `recap-${Date.now()}-${counter}`;
  }

  async function onTrigger() {
    if (pending) return; // une opération est déjà en cours
    const sessionId = typeof getSessionId === "function" ? getSessionId() : null;
    if (!sessionId) {
      await modal.alert(
        RECAP_SUBJECT_TITLE,
        "Aucune conversation n'est ouverte : ouvrez-en une d'abord.",
        { okText: "Compris" },
      );
      return;
    }
    const subject = await modal.prompt(RECAP_SUBJECT_TITLE, RECAP_SUBJECT_HINT, {
      placeholder: "ex. le coffre de secrets",
      okText: "Générer le récapitulatif",
      cancelText: "Annuler",
    });
    if (subject === null) return; // annulé
    const requestId = nextRequestId();
    pending = { requestId, phase: "preview" };
    busy = modal.busy(RECAP_BUSY_LABEL);
    const sent = send({
      type: "recap_preview",
      sessionId,
      subject,
      requestId,
    });
    if (!sent) {
      reset();
      await modal.alert(
        RECAP_SUBJECT_TITLE,
        "Non connecté au gateway : impossible de générer le récapitulatif.",
        { okText: "Compris" },
      );
      return;
    }
    if (typeof onSent === "function") onSent();
  }

  /** Construit le contenu de l'aperçu (titre + corps éditables). */
  function previewContent(frame) {
    const wrap = doc.createElement("div");
    wrap.className = "recap-modal";

    const info = doc.createElement("p");
    info.className = "recap-modal__info";
    const source = frame.originTitle ? `depuis « ${frame.originTitle} »` : "depuis cette conversation";
    const count = Number.isFinite(frame.messageCount) ? ` (${frame.messageCount} messages)` : "";
    const parts = Number.isFinite(frame.parts) && frame.parts > 1 ? ` en ${frame.parts} parties assemblées` : "";
    info.textContent =
      `Récapitulatif généré ${source}${count}${parts}. ` +
      "Relis-le et corrige-le si nécessaire AVANT de créer la conversation : " +
      "c'est lui qui servira de point de départ.";
    wrap.append(info);

    const titleLabel = doc.createElement("label");
    titleLabel.className = "recap-modal__label";
    titleLabel.textContent = "Titre de la nouvelle conversation";
    const titleInput = doc.createElement("input");
    titleInput.type = "text";
    titleInput.className = "holaf-modal-input";
    titleInput.maxLength = RECAP_TITLE_INPUT_MAX;
    titleInput.value = typeof frame.title === "string" ? frame.title : "";
    titleLabel.htmlFor = "recap-title-input";
    titleInput.id = "recap-title-input";
    wrap.append(titleLabel, titleInput);

    const bodyLabel = doc.createElement("label");
    bodyLabel.className = "recap-modal__label";
    bodyLabel.textContent = "Récapitulatif (exhaustif)";
    const body = doc.createElement("textarea");
    body.className = "recap-modal__body";
    body.id = "recap-body-input";
    body.rows = 16;
    body.value = typeof frame.recap === "string" ? frame.recap : "";
    bodyLabel.htmlFor = "recap-body-input";
    wrap.append(bodyLabel, body);

    const status = doc.createElement("p");
    status.className = "recap-modal__status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    wrap.append(status);

    return { wrap, titleInput, body, status };
  }

  function openPreview(frame) {
    const { wrap, titleInput, body, status } = previewContent(frame);
    modal.open({
      title: RECAP_PREVIEW_TITLE,
      size: "lg",
      content: wrap,
      closeOnOverlay: false,
      buttons: [
        { text: "Annuler", type: "cancel", value: false },
        { text: RECAP_CREATE_LABEL, type: "primary", value: true },
      ],
      guard: (result) => {
        if (result !== true) return true;
        const check = validatePreview(titleInput.value, body.value);
        if (!check.ok) {
          status.textContent = check.message;
          return false;
        }
        const ok = send({
          type: "recap_create",
          requestId: frame.requestId,
          title: check.title,
          recap: check.recap,
        });
        if (!ok) {
          status.textContent = "Non connecté au gateway : la conversation n'a pas été créée.";
          return false;
        }
        if (pending) pending.phase = "create";
        return true;
      },
      onClose: (value) => {
        if (value !== true) {
          // Annulé à l'aperçu : rien n'est créé, on libère l'état.
          reset();
        }
      },
    });
  }

  /**
   * Traite une trame serveur. Renvoie `true` si la trame appartenait à cette
   * fonctionnalité (elle ne doit alors pas être traitée ailleurs).
   */
  function handleFrame(frame) {
    if (!isRecapFrame(frame, pending)) return false;
    if (frame.type === "recap_created") {
      // Cycle terminé : le déclencheur redevient disponible.
      reset();
      return true;
    }
    if (frame.type === "recap_ready") {
      if (!pending || pending.phase !== "preview") return true;
      closeBusy();
      if (typeof frame.title !== "string" || typeof frame.recap !== "string") {
        reset();
        return true;
      }
      openPreview(frame);
      return true;
    }
    if (frame.type === "recap_progress") {
      // Fil découpé : on met à jour l'écran d'attente (le busy reste ouvert).
      if (pending && pending.phase === "preview" && busy && typeof busy.set === "function") {
        busy.set(recapProgressLabel(frame.part, frame.parts));
      }
      return true;
    }
    if (frame.type === "error") {
      const phase = pending ? pending.phase : "preview";
      reset();
      const message =
        typeof frame.message === "string" && frame.message.length > 0
          ? frame.message
          : "L'opération a échoué ; aucune conversation n'a été créée.";
      const title = phase === "create" ? "Création impossible" : RECAP_SUBJECT_TITLE;
      void modal.alert(title, message, { okText: "Compris" });
      return true;
    }
    return false;
  }

  if (trigger) {
    trigger.addEventListener("click", () => {
      void onTrigger();
    });
    if (trigger.hasAttribute && !trigger.hasAttribute("aria-label")) {
      trigger.setAttribute("aria-label", RECAP_TRIGGER_LABEL);
    }
    if (trigger.title !== undefined && !trigger.title) {
      trigger.title = RECAP_TRIGGER_LABEL;
    }
  }

  return {
    handleFrame,
    /**
     * Déclenche le parcours (saisie du sujet → récapitulatif → aperçu). C'est
     * CE point d'entrée qu'utilise le menu du titre ; le parcours lui-même
     * (trames `recap_*`, aperçu, création) est inchangé.
     */
    open() {
      void onTrigger();
    },
    isBusy: () => pending !== null,
    destroy() {
      reset();
    },
  };
}
