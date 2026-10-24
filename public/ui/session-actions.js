// Yuki — ACTIONS LONGUES DU MENU DU TITRE : « Compacter… ».
//
// La compaction forcée n'est pas instantanée : le serveur lance d'abord une
// PASSE DE MÉMOIRE sur la conversation entière (0–N appels modèle), puis
// compresse le fil (1 appel modèle). Sans retour visible, l'utilisateur croirait
// que c'est planté.
//
// ⚠️ AUCUN second système d'attente : on réutilise `HolafModal.busy()` (le même
// écran d'attente que « Conversation dédiée »), piloté par des trames de
// CONTRÔLE (`compact_progress`), et le compte rendu final vient du SERVEUR
// (`compact_done`) — jamais d'une reconstitution côté navigateur.
//
// ⚠️ CSP stricte : aucune injection de balisage, aucun style en ligne, DOM
// programmatique,
// fenêtres via `HolafModal` (jamais `window.confirm`).

/** Titre des fenêtres de cette action. */
export const COMPACT_TITLE = "Compacter la conversation";

/** Texte d'attente initial (avant la première trame de progression). */
export const COMPACT_BUSY_LABEL = "Compaction en cours… (cela peut prendre un moment)";

/** Libellé d'attente détaillé, selon la PHASE annoncée par le serveur. */
export function compactProgressLabel(phase, part, parts) {
  if (phase === "compact") {
    return (
      "Passe de mémoire terminée. Compaction du fil en cours… " +
      "(le modèle résume les échanges ; cela peut prendre une minute ou deux)"
    );
  }
  const p = Number.isFinite(part) ? Math.max(0, Math.floor(part)) : 0;
  const t = Number.isFinite(parts) ? Math.max(0, Math.floor(parts)) : 0;
  if (p > 0 && t > 0) {
    return (
      `Passe de mémoire en cours… partie ${p}/${t} — la conversation entière est ` +
      "relue avant la compaction, cela peut prendre plusieurs minutes."
    );
  }
  return (
    "Passe de mémoire en cours… (la conversation entière est relue AVANT la " +
    "compaction ; cela peut prendre un moment)"
  );
}

/** Formate un nombre de tokens lisible (« 4 000 »). */
export function formatTokens(value) {
  const n = Number.isFinite(value) ? Math.max(0, Math.round(value)) : null;
  if (n === null) return null;
  try {
    return new Intl.NumberFormat("fr-FR").format(n);
  } catch {
    return String(n);
  }
}

/**
 * Ce que la passe de mémoire a RÉELLEMENT fait — une phrase, jamais un succès
 * muet. Elle distingue : passe exécutée / inactive / sans extracteur / vide /
 * échouée.
 */
export function describeMemoryPass(memory) {
  if (!memory || typeof memory !== "object") {
    return "Passe de mémoire : aucun compte rendu reçu.";
  }
  if (memory.ran) {
    const written = (memory.added ?? 0) + (memory.updated ?? 0);
    const details = [
      `${memory.added ?? 0} souvenir(s) ajouté(s)`,
      `${memory.updated ?? 0} mis à jour`,
    ];
    if ((memory.removed ?? 0) > 0) details.push(`${memory.removed} retiré(s)`);
    if ((memory.skipped ?? 0) > 0) details.push(`${memory.skipped} doublon(s) écarté(s)`);
    const calls = Number.isFinite(memory.chunks) && memory.chunks > 0
      ? ` en ${memory.chunks} appel(s) au modèle`
      : "";
    return written === 0
      ? `Passe de mémoire effectuée${calls} : aucun souvenir nouveau (rien de durable à retenir).`
      : `Passe de mémoire effectuée${calls} : ${details.join(", ")}.`;
  }
  switch (memory.reason) {
    case "disabled":
      return "Passe de mémoire non exécutée : la mémoire durable est désactivée.";
    case "no_extractor":
      return "Passe de mémoire non exécutée : aucun modèle d'extraction n'est configuré.";
    case "unsupported":
      return "Passe de mémoire non exécutée : la mémoire durable n'est pas branchée sur cet hôte.";
    case "unreadable":
      return "Passe de mémoire non exécutée : la conversation n'a pas pu être relue.";
    case "empty":
      return "Passe de mémoire non exécutée : aucun contenu exploitable à relire.";
    case "failed":
      return (
        "Passe de mémoire ÉCHOUÉE" +
        (typeof memory.error === "string" && memory.error.length > 0
          ? ` (${memory.error})`
          : "") +
        " : la compaction a quand même eu lieu."
      );
    default:
      return "Passe de mémoire non exécutée (raison non précisée par le serveur).";
  }
}

/**
 * Compte rendu COMPLET de la compaction, en texte prêt à afficher : ce qui a été
 * fait pour la mémoire ET pour le fil, avec les mesures du moteur.
 *
 * ⚠️ HONNÊTETÉ DES CHIFFRES : `tokensBefore` et `tokensAfter` viennent de DEUX
 * estimations différentes du moteur (contexte avant / contexte reconstruit). On
 * ne prétend donc une « réduction » que si elle est réellement constatée ;
 * sinon on donne les deux mesures sans conclure à une économie.
 */
export function describeCompactOutcome(frame) {
  const title = typeof frame?.title === "string" && frame.title.trim().length > 0
    ? frame.title.trim()
    : "cette conversation";
  const before = formatTokens(frame?.tokensBefore);
  const after = formatTokens(frame?.tokensAfter);
  const afterRaw = Number(frame?.tokensAfter);
  const beforeRaw = Number(frame?.tokensBefore);
  let context;
  if (before === null) {
    context = "Le fil a été compacté.";
  } else if (after === null) {
    context = `Contexte avant compaction : ${before} tokens (estimation après non fournie par le moteur).`;
  } else if (Number.isFinite(afterRaw) && Number.isFinite(beforeRaw) && afterRaw < beforeRaw) {
    context = `Contexte : ${before} tokens avant → ${after} tokens après (estimation du moteur).`;
  } else {
    // Le moteur ne constate pas de réduction : on le DIT tel quel, sans inventer.
    context =
      `Contexte estimé avant compaction : ${before} tokens ; ` +
      `contexte reconstruit estimé après : ${after} tokens ` +
      "(deux estimations du moteur, aucune économie constatée).";
  }
  return [
    `« ${title} » a été compactée.`,
    describeMemoryPass(frame?.memory),
    context,
    "L'historique affiché reste complet : seule la mémoire de travail du modèle a été résumée.",
  ].join("\n\n");
}

/**
 * Câble l'action « Compacter… » (menu du titre, bureau ET téléphone).
 *
 * @param {object} deps
 * @param {(payload: object) => boolean} deps.send envoi d'une trame au gateway.
 * @param {object} deps.modal brique `HolafModal` (busy + alert).
 * @param {() => number} [deps.now] horloge injectable (tests).
 * @returns {{ request: (id: string) => void, handleFrame: (frame: object) => boolean,
 *   isBusy: () => boolean, reset: () => void }}
 */
export function createSessionActions({ send, modal, now = Date.now } = {}) {
  if (typeof send !== "function") throw new Error("createSessionActions : send requis");
  if (!modal) throw new Error("createSessionActions : modal requis");
  let counter = 0;
  /** @type {{requestId: string, sessionId: string}|null} */
  let pending = null;
  /** @type {{close: () => void, set: (msg: string) => void}|null} */
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

  function nextRequestId(sessionId) {
    counter += 1;
    return `compact-${sessionId}-${now()}-${counter}`;
  }

  /** Démarre une compaction ; une seule à la fois (jamais deux écrans d'attente). */
  function request(sessionId) {
    if (pending) return;
    if (typeof sessionId !== "string" || sessionId.length === 0) return;
    const requestId = nextRequestId(sessionId);
    pending = { requestId, sessionId };
    busy = modal.busy(compactProgressLabel("memory"), {});
    const sent = send({ type: "compact", sessionId, requestId });
    if (!sent) {
      reset();
      void modal.alert(
        COMPACT_TITLE,
        "Non connecté au gateway : la compaction n'a pas été lancée.",
        { okText: "Compris" },
      );
    }
  }

  /**
   * Traite une trame serveur. Renvoie `true` si elle appartenait à cette action
   * (elle ne doit alors pas être traitée ailleurs — notamment pas comme une
   * réponse de modèle).
   */
  function handleFrame(frame) {
    if (!frame || typeof frame !== "object" || !pending) return false;
    if (typeof frame.requestId !== "string") return false;
    if (frame.requestId !== pending.requestId) return false;
    if (frame.type === "compact_progress") {
      if (busy && typeof busy.set === "function") {
        busy.set(compactProgressLabel(frame.phase, frame.part, frame.parts));
      }
      return true;
    }
    if (frame.type === "compact_done") {
      reset();
      void modal.alert(COMPACT_TITLE, describeCompactOutcome(frame), { okText: "Compris" });
      return true;
    }
    if (frame.type === "error") {
      reset();
      const message =
        typeof frame.message === "string" && frame.message.length > 0
          ? frame.message
          : "La compaction a échoué ; le serveur n'a fourni aucun détail.";
      void modal.alert(`${COMPACT_TITLE} — échec`, message, { okText: "Compris" });
      return true;
    }
    // Trame corrélée mais inconnue : on la consomme (elle nous appartient).
    return true;
  }

  return { request, handleFrame, isBusy: () => pending !== null, reset };
}
