/**
 * Assistant de mise en route du TTS (Lot 8) — vanilla, sans build.
 *
 * Composant **autonome** monté par `id` : `initTtsAssistant(root, deps)`. Son
 * emplacement dans la page ne tient qu'à UNE ligne (le conteneur d'appel dans
 * `config.js`) ; il n'est **jamais dupliqué**. Il est **utilisable quand le TTS
 * est désactivé** : il guide alors au lieu d'échouer.
 *
 * Il s'appuie EXCLUSIVEMENT sur les routes du gateway (aucun accès direct au
 * moteur) :
 *   - `GET  /api/tts/status` → carte d'état honnête + diagnostic du volume des
 *     modèles (`modelsDir`, monté `ro`) ;
 *   - `GET  /api/tts/models` → liste des modèles du moteur (repliable) ;
 *   - `POST /api/tts/test`   → synthèse d'un TEXTE LIBRE (≤ 500 caractères),
 *     WAV lu **par Web Audio** (`tts-player.js`, `<audio src>` interdit) ;
 *   - `PUT  /api/config`     → `tts.enabled = "on"` (garde-fou
 *     `X-Yuki-Config: 1`) puis redémarrage (`POST /api/admin/restart`) délégué
 *     au code existant de `config.js`.
 *
 * CSP stricte (`style-src 'self'`) : AUCUN `<style>` injecté, AUCUN `style=` —
 * tout le CSS vit dans `tts-assistant.css` (servi par `<link>`).
 *
 * Testabilité : les fonctions de **mapping pur** (état → libellé, erreur →
 * message, bornes du texte) sont exportées et testées sans DOM ni navigateur
 * (même patron que `tests/tts/ui-audio.test.ts`).
 */

import {
  ENGINE_FAMILIES,
  ENGINE_FORCE_OFFLINE_FAMILIES,
  ENGINE_GLOBAL_FIELDS,
  ENGINE_MODES,
  ENGINE_TASK_TOKENS,
  applicationState,
  buildEnginePatch,
  describeCapabilities,
  describeEngineConfig,
  describeEngineConfigError,
  restartProcedure,
  validateModelDraft,
} from "./engine-config-patch.js";

/** Longueur maximale du texte de test (alignée sur le serveur). */
export const TTS_TEST_MAX_CHARS = 500;
/** Phrase par défaut (aussi le placeholder du champ de test). */
export const DEFAULT_TTS_TEST_TEXT = "Bonjour, voici un aperçu de la voix.";

const WRITE_HEADERS = { "content-type": "application/json", "x-yuki-config": "1" };

/** Délai d'une relance discrète quand l'état est « démarrage en cours ». */
export const TTS_STARTING_RETRY_MS = 3_000;
/** Nombre maximal de relances automatiques tant que l'état reste `starting`. */
export const TTS_STARTING_MAX_RETRIES = 5;

/* ─── Helpers purs (testés sans DOM) ────────────────────────────────────── */

/**
 * Normalise un texte de test : chaîne vide si absent, `trim` puis borné à
 * `TTS_TEST_MAX_CHARS`.
 */
export function clampTestText(value) {
  const text = typeof value === "string" ? value : "";
  const trimmed = text.trim();
  return trimmed.length > TTS_TEST_MAX_CHARS
    ? trimmed.slice(0, TTS_TEST_MAX_CHARS)
    : trimmed;
}

/**
 * Valide le texte de test. Renvoie `{ ok, text, error }` : `ok:false` si le
 * texte DÉPASSE la borne (on ne tronque pas un texte utilisateur en silence).
 */
export function validateTestText(value) {
  const text = typeof value === "string" ? value : "";
  if (text.trim().length > TTS_TEST_MAX_CHARS) {
    return {
      ok: false,
      text: clampTestText(text),
      error: `Texte trop long : ${TTS_TEST_MAX_CHARS} caractères maximum.`,
    };
  }
  return { ok: true, text: clampTestText(text), error: null };
}

/** Formate une taille en octets (français). */
export function formatBytes(size) {
  const n = Number(size);
  if (!Number.isFinite(n) || n <= 0) return "0 o";
  if (n < 1024) return `${Math.round(n)} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} Ko`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} Mo`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} Go`;
}

function plural(count, singular, pluralForm) {
  return count > 1 ? pluralForm : singular;
}

/**
 * Mappe un rapport `GET /api/tts/status` vers la vue de la carte d'état.
 * **Aucune affirmation** : `ready` n'est renvoyé que sur preuve positive de la
 * sonde. Les valeurs inconnues retombent sur un état « inconnu » honnête.
 */
export function describeTtsState(status) {
  if (!status || typeof status !== "object") {
    return {
      key: "unknown",
      label: "État inconnu",
      badgeClass: "tts-badge--muted",
      message:
        "La sonde n'a pas renvoyé de résultat. Cliquez sur « Vérifier le moteur ».",
      tone: "muted",
      showEnable: false,
      showRetry: true,
      showDetails: false,
      retrySoon: false,
    };
  }
  const baseUrl = typeof status.baseUrl === "string" && status.baseUrl ? status.baseUrl : "…";
  switch (status.state) {
    case "off":
      return {
        key: "off",
        label: "Désactivé",
        badgeClass: "tts-badge--muted",
        message:
          "La synthèse vocale est désactivée (tts.enabled = off). Activez-la pour que Yuki puisse parler.",
        tone: "muted",
        showEnable: true,
        showRetry: false,
        showDetails: false,
        retrySoon: false,
      };
    case "unreachable":
      return {
        key: "unreachable",
        label: "Non démarré",
        badgeClass: "tts-badge--warn",
        message:
          `Yuki ne joint pas le moteur à l'adresse ${baseUrl}. Le conteneur « tts » n'est ` +
          "probablement pas démarré : le gateway n'a AUCUN accès à Docker, ce démarrage se fait " +
          "à la main sur l'hôte (voir « Ce qui reste à faire à la main »). S'il démarre mais " +
          "échoue (commande invalide, fichier de configuration introuvable, modèle absent), ses " +
          "logs le disent (docker compose logs tts). Autre cause possible : aucun GPU réservé.",
        tone: "warn",
        showEnable: false,
        showRetry: true,
        showDetails: true,
        retrySoon: false,
      };
    case "starting":
      return {
        key: "starting",
        label: "Démarrage en cours",
        badgeClass: "tts-badge--warn",
        message:
          "Le moteur répond mais n'est pas encore prêt (modèle en cours de chargement). " +
          "Vérification discrète automatique en cours…",
        tone: "warn",
        showEnable: false,
        showRetry: true,
        showDetails: false,
        retrySoon: true,
      };
    case "ready": {
      const count = typeof status.modelCount === "number" ? status.modelCount : null;
      const inferred = status.readinessInferred === true;
      return {
        key: "ready",
        label: "Prêt",
        badgeClass: "tts-badge--ok",
        message:
          count === null
            ? "Moteur prêt."
            : `Moteur prêt (${count} ${plural(count, "modèle", "modèles")}).`,
        tone: "ok",
        showEnable: false,
        showRetry: false,
        // Quand « prêt » a été DÉDUIT (modèles listés sans préparation explicite
        // dans /health), on expose les détails pour rester honnête sur la preuve.
        showDetails: inferred,
        retrySoon: false,
      };
    }
    case "error":
    default:
      return {
        key: "error",
        label: "Erreur",
        badgeClass: "tts-badge--error",
        message:
          "Le moteur a répondu, mais sa réponse signale une erreur. Détails techniques ci-dessous.",
        tone: "error",
        showEnable: false,
        showRetry: true,
        showDetails: true,
        retrySoon: false,
      };
  }
}

/**
 * Détail technique repliable d'un rapport d'état : code HTTP et corps brut du
 * moteur, tels que remontés par la sonde (aucune interprétation).
 */
export function statusTechnicalDetails(status) {
  if (!status || typeof status !== "object") return "Aucune mesure disponible.";
  const lines = [];
  lines.push(`état : ${status.state ?? "?"}`);
  lines.push(`activé : ${status.enabled ? "oui" : "non"}`);
  lines.push(`adresse : ${status.baseUrl ?? "?"}`);
  lines.push(`moteur : ${status.engine ?? "?"}`);
  lines.push(`joignable : ${status.reachable ? "oui" : "non"}`);
  lines.push(`prêt : ${status.ready === null || status.ready === undefined ? "?" : status.ready}`);
  lines.push(
    `modèles (moteur) : ${typeof status.modelCount === "number" ? status.modelCount : "?"}`,
  );
  if (status.modelCountSource) lines.push(`source des modèles : ${status.modelCountSource}`);
  lines.push(
    `latence : ${typeof status.latencyMs === "number" ? `${status.latencyMs} ms` : "?"}`,
  );
  lines.push(`mesuré à : ${status.measuredAt ?? "jamais"}`);
  if (status.readinessNote) lines.push(`note : ${status.readinessNote}`);
  if (status.error) lines.push(`erreur : ${status.error}`);
  if (status.payload) {
    // Forme réelle de /health : conservée brute et bornée pour la figer plus tard.
    lines.push("corps /health (brut, borné) :");
    lines.push(String(status.payload));
  }
  return lines.join("\n");
}

/**
 * Le test de synthèse est-il utilisable ? **Oui dès que le moteur est joignable
 * et le TTS activé**, MÊME si la préparation est indéterminée : le test est la
 * PREUVE RÉELLE du bon fonctionnement, une sonde imparfaite ne doit pas le
 * verrouiller. On ne le désactive que sur un constat sûr d'inutilisabilité
 * (`off` ou `unreachable`). Un rapport absent (`null`) ne bloque rien : on laisse
 * l'utilisateur cliquer et obtenir un message réel du gateway.
 */
export function isTestAvailable(status) {
  if (!status || typeof status !== "object") return true;
  if (status.enabled === false) return false;
  if (status.reachable === false) return false;
  return true;
}

/**
 * Mappe un état d'erreur de test (`POST /api/tts/test`) vers un message lisible
 * + une action. `error` accepte `{ status, code, message, engineStatus,
 * engineBody }`. Honnête sur le 503 ambigu (« occupé **ou** mémoire
 * insuffisante »).
 */
export function describeTestError(error) {
  const input = error && typeof error === "object" ? error : {};
  const status = Number(input.status) || 0;
  const code = typeof input.code === "string" ? input.code : null;
  const serverMessage = typeof input.message === "string" ? input.message : null;
  const detail = typeof input.engineBody === "string" ? input.engineBody : null;

  const withRetry = (message, hint) => ({ message, hint: hint ?? null, detail, retry: true });

  switch (code) {
    case "tts_unavailable":
      return withRetry(
        "Le moteur TTS n'est pas disponible côté gateway.",
        "Le service « tts » est peut-être absent du déploiement. Voir « Ce qui reste à faire à la main ».",
      );
    case "tts_disabled":
      return withRetry(
        "La synthèse vocale est désactivée (tts.enabled = off).",
        "Activez la voix, puis redémarrez Yuki pour appliquer le changement.",
      );
    case "server_busy":
      return withRetry(
        "Le moteur est occupé OU manque de mémoire.",
        "La documentation d'audio.cpp ne permet pas de distinguer un 503 « BusyGuard » d'un refus " +
          "« Insufficient Memory » (le corps brut est ci-dessous). Réessayez dans quelques secondes ; " +
          "si le message persiste, vérifiez la mémoire GPU libre et la taille du modèle.",
      );
    case "timeout":
      return withRetry(
        "Le moteur n'a pas répondu dans le délai imparti (tts.timeoutMs).",
        "Vérifiez que le moteur est démarré et non bloqué (chargement du modèle), puis réessayez.",
      );
    case "text_too_long":
      return withRetry(
        `Texte trop long : ${TTS_TEST_MAX_CHARS} caractères maximum.`,
        "Raccourcissez le texte du test.",
      );
    case "invalid_json":
    case "invalid_body":
    case "invalid_text":
      return withRetry(
        "Requête de test invalide.",
        "Corrigez le texte (objet { text } attendu) puis réessayez.",
      );
    case "synthesis_failed":
      return withRetry(
        "La synthèse a échoué (502).",
        "Le moteur a renvoyé une erreur inattendue. Voir le détail ci-dessous.",
      );
    default:
      break;
  }

  if (status === 502 || code === "http_error") {
    return withRetry(
      `Le moteur a renvoyé une erreur (${input.engineStatus ?? 502}).`,
      "Voir le corps brut du moteur ci-dessous.",
    );
  }
  if (status === 503) {
    return withRetry(
      "Le moteur a répondu 503 (occupé, mémoire insuffisante, ou service indisponible).",
      "Voir le corps brut du moteur ci-dessous.",
    );
  }
  if (status === 504) {
    return withRetry(
      "Délai dépassé en attendant le moteur (504).",
      "Vérifiez que le moteur est démarré et non bloqué, puis réessayez.",
    );
  }
  if (status === 0) {
    return withRetry(
      "La requête n'a pas abouti (réseau ou gateway injoignable).",
      serverMessage,
    );
  }
  return withRetry(
    serverMessage || "La synthèse a échoué.",
    "Vérifiez l'état du moteur ci-dessus, puis réessayez.",
  );
}

/**
 * Mappe `status.modelsDir` (diagnostic du volume `yuki-models`, monté `rw` côté
 * gateway, `ro` côté moteur) vers un affichage honnête. Le répertoire
 * absent/illisible est un cas normal, pas une exception.
 */
export function describeModelsDir(modelsDir) {
  if (!modelsDir || typeof modelsDir !== "object") {
    return {
      kind: "unknown",
      dir: null,
      count: 0,
      files: [],
      truncated: false,
      message: "Le diagnostic du répertoire des modèles n'est pas disponible.",
    };
  }
  const dir = typeof modelsDir.dir === "string" ? modelsDir.dir : null;
  const files = Array.isArray(modelsDir.files) ? modelsDir.files : [];
  if (!modelsDir.present) {
    return {
      kind: "absent",
      dir,
      count: 0,
      files: [],
      truncated: false,
      message:
        "Le répertoire des modèles n'est pas visible depuis le conteneur du gateway.",
    };
  }
  if (!modelsDir.readable) {
    return {
      kind: "unreadable",
      dir,
      count: 0,
      files: [],
      truncated: false,
      message:
        "Le répertoire des modèles existe mais n'est pas lisible" +
        (modelsDir.error ? ` : ${modelsDir.error}.` : "."),
    };
  }
  if ((Number(modelsDir.fileCount) || 0) === 0) {
    return {
      kind: "empty",
      dir,
      count: 0,
      files: [],
      truncated: false,
      message:
        "Aucun modèle de voix n'est installé. Déposez le fichier du modèle dans le dossier " +
        "des modèles monté sur ce conteneur (c'est une action HORS Yuki : le téléchargement " +
        "depuis l'interface arrivera à l'étape suivante ; d'ici là, le gateway n'écrit rien " +
        "dans ce dossier, monté en lecture seule pour lui comme pour le service tts).",
    };
  }
  return {
    kind: "files",
    dir,
    count: Number(modelsDir.fileCount) || files.length,
    files,
    truncated: Boolean(modelsDir.truncated),
    message: null,
  };
}

/**
 * Mappe `GET /api/tts/models` vers un affichage repliable, avec un
 * avertissement si le moteur configuré n'apparaît pas dans la liste.
 */
export function describeEngineModels(report) {
  if (!report || typeof report !== "object") {
    return { kind: "unknown", message: "Liste des modèles indisponible.", models: [], warning: null };
  }
  if (!report.reachable) {
    return {
      kind: "unreachable",
      message: "Moteur injoignable : impossible de lister ses modèles.",
      models: [],
      warning: null,
    };
  }
  const models = Array.isArray(report.models) ? report.models : [];
  if (report.error && models.length === 0) {
    return { kind: "error", message: report.error, models, warning: null };
  }
  return {
    kind: "list",
    count: typeof report.count === "number" ? report.count : models.length,
    models,
    engine: report.engine ?? null,
    enginePresent: report.enginePresent,
    warning:
      report.enginePresent === false
        ? `Le moteur configuré « ${report.engine} » n'apparaît pas dans cette liste : la synthèse ` +
          "peut retomber sur un autre modèle ou échouer."
        : null,
  };
}

/* ─── DOM ───────────────────────────────────────────────────────────────── */

/** Petit helper DOM — aucun `style=` (CSP). */
function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = value;
    else if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2), value);
    } else if (value === true) el.setAttribute(key, "");
    else if (value !== false && value !== undefined && value !== null) {
      el.setAttribute(key, String(value));
    }
  }
  for (const child of [].concat(children)) {
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

function code(text) {
  return h("code", { class: "tts-assistant__code", text });
}

/** Message d'erreur lisible à partir d'une `HolafFetchError` (API config). */
function apiErrorMessage(error) {
  const data = error?.data ?? {};
  return (
    data.message ??
    data.error ??
    (error instanceof Error ? error.message : String(error))
  );
}

/**
 * Initialise l'assistant dans `root` (élément ou id) — **jamais dupliqué**.
 *
 * @param {HTMLElement|string} root
 * @param {object} deps
 * @param {object} deps.HolafFetch Brique HTTP (`GET`/`POST`/`PUT`, `raw:true`).
 * @param {object} deps.HolafModal Brique modale (`confirm`).
 * @param {object} [deps.player] Lecteur Web Audio (`createTtsPlayer()`).
 * @param {() => string} [deps.getActiveVoice] Valeur courante de `tts.voice`.
 * @param {() => void} [deps.onConfigChanged] Notifie `config.js` (relecture).
 * @param {() => Promise<boolean>} [deps.requestRestart] Redémarrage + attente.
 * @param {() => void} [deps.openMaintenance] Bascule vers l'onglet Maintenance.
 * @param {string} [deps.ttsContainerName] Nom du conteneur moteur (procédure).
 * @returns {{ refresh: () => Promise<void>, destroy: () => void }}
 */
export function initTtsAssistant(root, deps = {}) {
  const el = typeof root === "string" ? document.getElementById(root) : root;
  if (!el) return { refresh: async () => {}, destroy() {} };

  const fetchApi = deps.HolafFetch;
  const modal = deps.HolafModal;
  const player = deps.player ?? null;
  const onConfigChanged =
    typeof deps.onConfigChanged === "function" ? deps.onConfigChanged : null;
  const requestRestart =
    typeof deps.requestRestart === "function" ? deps.requestRestart : null;
  const openMaintenance =
    typeof deps.openMaintenance === "function" ? deps.openMaintenance : null;
  const ttsContainerName =
    typeof deps.ttsContainerName === "string" && deps.ttsContainerName.length > 0
      ? deps.ttsContainerName
      : "tts";

  let busy = false;
  let lastStatus = null;
  let startingRetries = 0;
  let startingTimer = null;
  // Configuration structurée du moteur (Lot 9).
  let engineReport = null;
  let capabilitiesReport = null;
  let engineView = describeEngineConfig(null);
  let engineDraft = { models: [], globals: {} };
  let engineConfigBusy = false;
  let engineFieldErrors = [];
  let engineConfigStatusEl = null;
  let modelRowRefs = [];
  let globalRefs = new Map();

  /* — Structure statique (construite une fois) — */
  const badge = h("span", { class: "tts-badge tts-badge--muted", text: "…" });
  const cardMessage = h("p", { class: "tts-card__message", text: "Mesure de l'état du moteur…" });
  const cardStatus = h("p", {
    class: "config-helper tts-card__action-status",
    role: "status",
    "aria-live": "polite",
  });
  const cardActions = h("div", { class: "tts-card__actions" });
  const detailsBody = h("pre", { class: "tts-details__body", text: "" });
  const details = h("details", { class: "tts-details" }, [
    h("summary", { class: "tts-details__summary", text: "Détails techniques" }),
    detailsBody,
  ]);
  details.hidden = true;
  const card = h("div", { class: "tts-card" }, [
    h("div", { class: "tts-card__head" }, [badge]),
    cardMessage,
    cardActions,
    cardStatus,
    details,
  ]);

  const modelsDirBody = h("div", { class: "tts-models-dir" });

  const engineSummary = h("summary", { class: "tts-details__summary", text: "Modèles du moteur" });
  const engineBody = h("div", { class: "tts-engine-models" });
  const engineDetails = h("details", { class: "tts-details tts-details--engine" }, [
    engineSummary,
    engineBody,
  ]);
  engineDetails.addEventListener("toggle", () => {
    if (engineDetails.open) void loadModels();
  });

  // --- Configuration STRUCTURÉE du moteur (Lot 9) -------------------------
  const engineConfigBody = h("div", { class: "tts-engine-config" });
  const engineConfigSection = h(
    "section",
    { class: "tts-assistant__block", "aria-labelledby": "tts-engine-config-title" },
    [
      h("h3", {
        class: "tts-assistant__title",
        id: "tts-engine-config-title",
        text: "Configuration du moteur",
      }),
      h("p", {
        class: "config-helper",
        text:
          "Édition STRUCTURÉE de server.json (listes fermées : familles, tâches, modes, " +
          "chemins choisis sur le disque). Le navigateur n'envoie jamais le fichier complet : " +
          "le serveur relit le fichier, préserve vos clés personnalisées, valide, puis écrit " +
          "une sauvegarde et le fichier de façon atomique.",
      }),
      engineConfigBody,
    ],
  );

  const testInput = h("textarea", {
    class: "config-textarea tts-assistant__textarea",
    rows: "2",
    maxlength: String(TTS_TEST_MAX_CHARS),
    placeholder: DEFAULT_TTS_TEST_TEXT,
    "aria-label": "Texte à synthétiser (optionnel, 500 caractères maximum)",
  });
  const testButton = h("button", {
    class: "button",
    type: "button",
    text: "Tester la voix",
    "aria-label": "Tester la synthèse vocale avec le texte saisi",
  });
  testButton.addEventListener("click", () => void runTest());
  const testFeedback = h("div", { class: "tts-test__feedback" });

  const refreshButton = h("button", {
    class: "button button--ghost button--small",
    type: "button",
    text: "Vérifier le moteur",
    "aria-label": "Vérifier l'état du moteur TTS maintenant",
  });
  refreshButton.addEventListener("click", () => void refresh());

  const manualSection = buildManualSection();

  const section = h("section", { class: "config-group tts-assistant", id: "tts-assistant" }, [
    h("div", { class: "config-group__head" }, [
      h("h2", { class: "config-group__title", text: "Assistant de mise en route de la voix" }),
      h("div", { class: "config-secret" }, [refreshButton]),
    ]),
    h("p", {
      class: "config-intro tts-assistant__intro",
      text:
        "Cet assistant vérifie que la synthèse vocale fonctionne, pas à pas. Il interroge " +
        "uniquement le gateway : il n'a jamais accès au moteur ni à Docker. Aucun état « prêt » " +
        "n'est affiché sans preuve positive de la sonde.",
    }),
    card,
    h("section", { class: "tts-assistant__block", "aria-labelledby": "tts-models-dir-title" }, [
      h("h3", { class: "tts-assistant__title", id: "tts-models-dir-title", text: "Modèle de voix sur le disque" }),
      modelsDirBody,
    ]),
    engineDetails,
    engineConfigSection,
    h("section", { class: "tts-assistant__block", "aria-labelledby": "tts-test-title" }, [
      h("h3", { class: "tts-assistant__title", id: "tts-test-title", text: "Tester la voix" }),
      h("label", { class: "tts-assistant__label", for: "tts-test-text", text: "Texte (optionnel, 500 caractères maximum)" }),
      testInput,
      h("p", {
        class: "config-helper",
        text: `Laissez vide pour utiliser la phrase par défaut : « ${DEFAULT_TTS_TEST_TEXT} »`,
      }),
      h("div", { class: "tts-card__actions" }, [testButton]),
      testFeedback,
    ]),
    manualSection,
  ]);
  testInput.id = "tts-test-text";

  el.textContent = "";
  el.append(section);

  /* — Rendu de la carte d'état — */
  function renderCard() {
    const view = describeTtsState(lastStatus);
    badge.textContent = view.label;
    badge.className = `tts-badge ${view.badgeClass}`;
    cardMessage.textContent = view.message;
    details.hidden = !view.showDetails;
    if (view.showDetails) detailsBody.textContent = statusTechnicalDetails(lastStatus);
    cardActions.textContent = "";
    if (view.showEnable) {
      const enable = h("button", {
        class: "button",
        type: "button",
        text: "Activer la voix",
        "aria-label": "Activer la synthèse vocale et proposer un redémarrage",
      });
      enable.addEventListener("click", () => void enableVoice());
      cardActions.append(enable);
    }
    if (view.showRetry) {
      const retry = h("button", {
        class: "button button--ghost button--small",
        type: "button",
        text: "Réessayer",
        "aria-label": "Relancer la vérification du moteur TTS",
      });
      retry.addEventListener("click", () => void refresh());
      cardActions.append(retry);
    }
    if (view.tone !== "ready" && openMaintenance) {
      const maintenance = h("button", {
        class: "button button--ghost button--small",
        type: "button",
        text: "Onglet Maintenance",
        "aria-label": "Aller à l'onglet Maintenance pour redémarrer Yuki",
      });
      maintenance.addEventListener("click", () => openMaintenance());
      cardActions.append(maintenance);
    }
    // Le test reste possible dès que le moteur est joignable (et le TTS activé),
    // même si la préparation est indéterminée : c'est la preuve réelle.
    testButton.disabled = busy || !isTestAvailable(lastStatus);
  }

  function setCardStatus(text, isError = false) {
    cardStatus.textContent = text ?? "";
    cardStatus.classList.toggle("config-status--error", Boolean(isError));
  }

  /* — Rendu du répertoire des modèles — */
  function renderModelsDir() {
    const modelsDir = lastStatus?.modelsDir;
    const view = describeModelsDir(modelsDir);
    modelsDirBody.textContent = "";
    if (view.kind === "files") {
      modelsDirBody.append(
        h("p", {
          class: "config-helper",
          text: `${view.count} ${plural(view.count, "fichier", "fichiers")} dans le volume${
            view.dir ? ` (${view.dir})` : ""
          } :`,
        }),
      );
      const list = h("ul", { class: "tts-models-list" });
      for (const file of view.files) {
        list.append(
          h("li", { class: "tts-models-list__item" }, [
            h("span", { class: "tts-models-list__name", text: file.name }),
            h("span", { class: "tts-models-list__meta", text: formatBytes(file.size) }),
          ]),
        );
      }
      modelsDirBody.append(list);
      if (view.truncated) {
        modelsDirBody.append(
          h("p", { class: "config-helper", text: "Liste tronquée (50 fichiers maximum)." }),
        );
      }
      return;
    }
    const warn = view.kind === "empty" || view.kind === "absent" || view.kind === "unreadable";
    modelsDirBody.append(
      h("p", {
        class: warn ? "tts-assistant__note tts-assistant__note--warn" : "tts-assistant__note",
        text: view.message,
      }),
    );
    if (view.dir) {
      modelsDirBody.append(
        h("p", { class: "config-helper" }, ["Chemin dans le conteneur : ", code(view.dir)]),
      );
    }
    if (view.kind === "empty") {
      modelsDirBody.append(
        h("p", {
          class: "config-helper",
          text:
            "Le fichier du modèle doit être présent sur le disque (déposez-le sur l'hôte pour " +
            "l'instant) ; déclarez-le ensuite dans « Configuration du moteur » ci-dessus. Le " +
            "service tts lit `/models` en lecture seule ; le gateway y a accès en écriture (Lot 9).",
        }),
      );
    }
    if (warn) {
      const retry = h("button", {
        class: "button button--ghost button--small",
        type: "button",
        text: "Réessayer",
        "aria-label": "Relancer la vérification du répertoire des modèles",
      });
      retry.addEventListener("click", () => void refresh());
      modelsDirBody.append(h("div", { class: "tts-card__actions" }, [retry]));
    }
  }

  /* — Rendu de la liste des modèles du moteur — */
  function renderEngineModels(report) {
    const view = describeEngineModels(report);
    engineBody.textContent = "";
    if (view.kind === "list") {
      engineSummary.textContent = `Modèles du moteur (${view.count ?? view.models.length})`;
      if (view.warning) {
        engineBody.append(
          h("p", { class: "tts-assistant__note tts-assistant__note--warn", text: view.warning }),
        );
      }
      if (view.models.length === 0) {
        engineBody.append(
          h("p", { class: "config-helper", text: "Le moteur ne liste aucun modèle." }),
        );
        return;
      }
      const list = h("ul", { class: "tts-models-list" });
      for (const model of view.models) {
        const name = `${model.id ?? "?"}`;
        const task = model.task ? ` — ${model.task}` : "";
        list.append(
          h("li", { class: "tts-models-list__item" }, [
            h("span", { class: "tts-models-list__name", text: `${name}${task}` }),
          ]),
        );
      }
      engineBody.append(list);
      return;
    }
    engineSummary.textContent = "Modèles du moteur";
    engineBody.append(
      h("p", { class: "tts-assistant__note", text: view.message }),
    );
  }

  async function loadModels() {
    if (!fetchApi) return;
    try {
      const report = await fetchApi.get("/api/tts/models", {
        headers: { accept: "application/json" },
      });
      renderEngineModels(report);
    } catch (error) {
      renderEngineModels({
        reachable: false,
        error: apiErrorMessage(error),
        models: [],
        count: null,
        enginePresent: null,
      });
    }
  }

  /* — Configuration STRUCTURÉE du moteur (Lot 9) — */

  function optionList(values) {
    return values.map((value) => ({ value, label: value }));
  }

  function selectInput(value, options) {
    const select = h("select", { class: "tts-engine-config__select" });
    for (const option of options) {
      select.append(
        h("option", {
          value: option.value,
          text: option.label,
        }),
      );
    }
    if (value !== undefined && value !== null) select.value = String(value);
    select.addEventListener("change", captureEngineDraft);
    return select;
  }

  function draftFromReport(view) {
    return {
      models: view.models.map((model) => ({
        id: model.id,
        family: model.family,
        task: model.task,
        mode: model.mode,
        path: model.path,
      })),
      globals: { ...view.globals },
    };
  }

  function captureEngineDraft() {
    engineDraft.models = modelRowRefs.map((refs) => ({
      id: refs.id.value,
      family: refs.family.value,
      task: refs.task.value,
      mode: refs.mode.value,
      path: refs.path.value,
    }));
    for (const [path, el] of globalRefs.entries()) {
      engineDraft.globals[path] = el.type === "checkbox" ? el.checked : el.value;
    }
  }

  function diskPathOptions(currentPath) {
    const options = [];
    const seen = new Set();
    for (const model of engineView.diskModels) {
      if (seen.has(model.enginePath)) continue;
      seen.add(model.enginePath);
      options.push({
        value: model.enginePath,
        label: `${model.enginePath} (${formatBytes(model.size)})`,
      });
    }
    if (currentPath && !seen.has(currentPath)) {
      options.push({
        value: currentPath,
        label: `${currentPath} (déclaré — fichier introuvable ?)`,
      });
    }
    if (options.length === 0) {
      options.push({ value: currentPath || "", label: currentPath || "(aucun modèle sur le disque)" });
    }
    return options;
  }

  function errorFor(fieldPath) {
    const entry = engineFieldErrors.find((item) => item.path === fieldPath);
    return entry ? entry.message : null;
  }

  function field(labelText, inputEl, fieldPath) {
    const wrapper = h("label", { class: "tts-engine-config__field" }, [
      h("span", { class: "tts-engine-config__field-label", text: labelText }),
      inputEl,
    ]);
    const message = errorFor(fieldPath);
    if (message) {
      wrapper.append(
        h("span", { class: "config-error tts-engine-config__field-error", text: message }),
      );
    }
    return wrapper;
  }

  function renderEngineGlobals() {
    globalRefs = new Map();
    const grid = h("div", { class: "tts-engine-config__globals" });
    for (const descriptor of ENGINE_GLOBAL_FIELDS) {
      const inputId = `tts-engine-global-${descriptor.path}`;
      const value = engineDraft.globals[descriptor.path];
      let el;
      if (descriptor.kind === "checkbox") {
        el = h("input", { class: "tts-engine-config__checkbox", type: "checkbox", id: inputId });
        el.checked = Boolean(value);
      } else if (descriptor.kind === "select") {
        el = selectInput(value, optionList(descriptor.options));
        el.id = inputId;
      } else if (descriptor.kind === "number") {
        el = h("input", {
          class: "tts-engine-config__input",
          type: "number",
          id: inputId,
          value: value === undefined || value === null ? "" : String(value),
        });
        el.addEventListener("change", captureEngineDraft);
      } else {
        el = h("input", {
          class: "tts-engine-config__input",
          type: "text",
          id: inputId,
          value: value === undefined || value === null ? "" : String(value),
        });
        el.addEventListener("change", captureEngineDraft);
      }
      globalRefs.set(descriptor.path, el);
      const wrapper = h("label", { class: "tts-engine-config__field", for: inputId }, [
        h("span", { class: "tts-engine-config__field-label", text: descriptor.label }),
        el,
      ]);
      const message = errorFor(`globals.${descriptor.path}`);
      if (message) {
        wrapper.append(
          h("span", { class: "config-error tts-engine-config__field-error", text: message }),
        );
      }
      grid.append(wrapper);
    }
    engineConfigBody.append(
      h("details", { class: "tts-details" }, [
        h("summary", { class: "tts-details__summary", text: "Réglages globaux du serveur (clés connues)" }),
        h("p", {
          class: "config-helper",
          text:
            "Vos autres clés de premier niveau (cors_origins, live_ingest, load_options…) " +
            "sont préservées telles quelles et jamais affichées ici.",
        }),
        grid,
      ]),
    );
  }

  function renderModelRows(view) {
    modelRowRefs = [];
    const engine = lastStatus?.engine ?? null;
    engineConfigBody.append(
      h("h4", { class: "tts-assistant__subtitle", text: "Modèles déclarés (models[])" }),
    );
    if (engineDraft.models.length === 0) {
      engineConfigBody.append(
        h("p", {
          class: "tts-assistant__note tts-assistant__note--warn",
          text:
            "Aucun modèle déclaré. Le moteur n'a rien à charger : ajoutez une entrée " +
            "(choisissez un fichier .gguf présent sur le disque).",
        }),
      );
    }
    engineDraft.models.forEach((model, index) => {
      const card = h("div", { class: "tts-engine-config__model" });
      if (model.id && model.id === engine) {
        card.append(
          h("span", { class: "tts-badge tts-badge--ok", text: "Moteur actif (tts.engine)" }),
        );
      }
      const idInput = h("input", {
        class: "tts-engine-config__input",
        type: "text",
        value: model.id,
        "aria-label": `Identifiant du modèle ${index + 1}`,
      });
      idInput.addEventListener("change", captureEngineDraft);
      const familySelect = selectInput(model.family, optionList(ENGINE_FAMILIES));
      familySelect.addEventListener("change", () => {
        captureEngineDraft();
        const current = engineDraft.models[index];
        if (current && ENGINE_MODES.includes(current.mode)) {
          if (ENGINE_FORCE_OFFLINE_FAMILIES.includes(current.family)) current.mode = "offline";
        }
        renderEngineConfig();
      });
      const taskSelect = selectInput(model.task, optionList(ENGINE_TASK_TOKENS));
      const modeSelect = selectInput(model.mode, optionList(ENGINE_MODES));
      const pathSelect = selectInput(model.path, diskPathOptions(model.path));
      modelRowRefs.push({
        id: idInput,
        family: familySelect,
        task: taskSelect,
        mode: modeSelect,
        path: pathSelect,
      });
      card.append(
        field(`Identifiant ${index + 1} (id)`, idInput, `models[${index}].id`),
        field("Famille", familySelect, `models[${index}].family`),
        field("Tâche", taskSelect, `models[${index}].task`),
        field("Mode", modeSelect, `models[${index}].mode`),
        field("Chemin (vu moteur)", pathSelect, `models[${index}].path`),
      );
      const remove = h("button", {
        class: "button button--ghost button--small",
        type: "button",
        text: "Retirer",
        "aria-label": `Retirer le modèle ${index + 1}`,
      });
      remove.addEventListener("click", () => {
        captureEngineDraft();
        engineDraft.models.splice(index, 1);
        engineFieldErrors = [];
        renderEngineConfig();
      });
      card.append(h("div", { class: "tts-card__actions" }, [remove]));
      engineConfigBody.append(card);
    });
  }

  function renderEngineConfigErrors() {
    engineConfigBody.append(
      h("h4", { class: "tts-assistant__subtitle", text: "Erreurs de validation" }),
    );
    const list = h("ul", { class: "tts-assistant__error-list" });
    for (const item of engineFieldErrors) {
      list.append(h("li", { class: "config-error", text: `${item.path} : ${item.message}` }));
    }
    engineConfigBody.append(list);
  }

  function procedureBox() {
    return h("div", { class: "tts-assistant__note tts-assistant__note--warn" }, [
      h("p", { class: "tts-manual__lead" }, [
        h("strong", { text: "Marche à suivre pour activer ces montages" }),
        " : les montages M1/M2/M3 du Lot 9 ne sont pas encore appliqués. Préparation hôte puis application :",
      ]),
      h("pre", {
        class: "tts-assistant__command",
        text:
          "# sur l'hôte (bind) : créer et donner le dossier de config au conteneur\n" +
          "mkdir -p tts-config\nchown -R 1000:1000 tts-config\n\n" +
          "# appliquer le nouveau compose (UI Docker ou CLI)\n" +
          "docker compose up -d\n" +
          "# puis, si besoin, relancer le moteur :\ndocker compose restart tts",
      }),
      h("p", {
        class: "config-helper",
        text:
          "Le gateway n'a aucun accès au démon Docker : l'application d'un montage ou le " +
          "redémarrage du moteur se font depuis VOTRE UI Docker (ou la CLI ci-dessus).",
      }),
    ]);
  }

  function appendDiskModels(view) {
    if (view.diskModels.length === 0) {
      engineConfigBody.append(
        h("p", {
          class: "tts-assistant__note tts-assistant__note--warn",
          text:
            "Aucun fichier .gguf détecté sous les dossiers de modèles. Déposez le fichier " +
            "du modèle avant de le déclarer (le téléchargement depuis l'interface arrivera à " +
            "l'étape suivante).",
        }),
      );
      return;
    }
    const list = h("ul", { class: "tts-models-list" });
    for (const model of view.diskModels) {
      list.append(
        h("li", { class: "tts-models-list__item" }, [
          h("span", { class: "tts-models-list__name", text: model.enginePath }),
          h("span", { class: "tts-models-list__meta", text: formatBytes(model.size) }),
        ]),
      );
    }
    engineConfigBody.append(
      h("details", { class: "tts-details" }, [
        h("summary", {
          class: "tts-details__summary",
          text: `Modèles .gguf sur le disque (${view.diskModels.length}${view.diskTruncated ? "+" : ""})`,
        }),
        list,
      ]),
    );
  }

  function setEngineConfigStatus(text, isError = false) {
    if (!engineConfigStatusEl) return;
    engineConfigStatusEl.textContent = text ?? "";
    engineConfigStatusEl.classList.toggle("config-status--error", Boolean(isError));
  }

  function renderEngineConfig() {
    const view = describeEngineConfig(engineReport);
    engineView = view;
    engineConfigBody.textContent = "";
    engineConfigStatusEl = h("p", {
      class: "config-helper",
      role: "status",
      "aria-live": "polite",
    });
    if (view.message) {
      engineConfigBody.append(
        h("p", {
          class:
            view.kind === "ready"
              ? "tts-assistant__note"
              : "tts-assistant__note tts-assistant__note--warn",
          text: view.message,
        }),
      );
    }
    if (view.parseError) {
      engineConfigBody.append(h("pre", { class: "tts-details__body", text: view.parseError }));
    }
    appendDiskModels(view);
    for (const warning of view.warnings) {
      engineConfigBody.append(
        h("p", { class: "tts-assistant__note tts-assistant__note--warn", text: warning }),
      );
    }
    const caps = describeCapabilities(capabilitiesReport);
    if (caps.show) {
      engineConfigBody.append(h("p", { class: "tts-assistant__note", text: caps.message }));
    }

    if (view.kind !== "ready" && view.kind !== "no-file") {
      if (engineFieldErrors.length > 0) renderEngineConfigErrors();
      engineConfigBody.append(procedureBox());
      return;
    }

    renderEngineGlobals();
    renderModelRows(view);

    const added = h("button", {
      class: "button button--ghost button--small",
      type: "button",
      text: "Ajouter un modèle",
      "aria-label": "Ajouter un modèle à déclarer",
    });
    added.addEventListener("click", () => {
      captureEngineDraft();
      const first = diskPathOptions("")[0];
      engineDraft.models.push({
        id: "",
        family: ENGINE_FAMILIES[0],
        task: "clon",
        mode: "offline",
        path: first ? first.value : "",
      });
      engineFieldErrors = [];
      renderEngineConfig();
    });
    engineConfigBody.append(h("div", { class: "tts-card__actions" }, [added]));

    const declaredIds = view.models.map((model) => model.id);
    const app = applicationState(declaredIds, lastStatus?.engine ?? null);
    engineConfigBody.append(
      h(
        "div",
        {
          class: `tts-engine-config__badge tts-engine-config__badge--${app.declared ? "ok" : "warn"}`,
        },
        [
          h("strong", { text: app.label }),
          h("p", { class: "config-helper", text: app.message }),
        ],
      ),
    );

    if (engineFieldErrors.length > 0) renderEngineConfigErrors();

    const save = h("button", {
      class: "button",
      type: "button",
      text: "Enregistrer la configuration du moteur",
      "aria-label": "Enregistrer la configuration du moteur",
    });
    save.addEventListener("click", () => void saveEngineConfig());
    const revert = h("button", {
      class: "button button--ghost button--small",
      type: "button",
      text: "Annuler la dernière modification",
      "aria-label": "Restaurer server.json.bak",
    });
    revert.addEventListener("click", () => void revertEngineConfig());
    revert.disabled = view.backupExists !== true;
    engineConfigBody.append(h("div", { class: "tts-card__actions" }, [save, revert]));
    engineConfigBody.append(engineConfigStatusEl);
    engineConfigBody.append(
      h("p", { class: "config-helper", text: restartProcedure(ttsContainerName) }),
    );
  }

  async function loadEngineConfig() {
    if (!fetchApi) return;
    try {
      const [report, caps] = await Promise.all([
        fetchApi.get("/api/tts/engine-config", {
          headers: { accept: "application/json" },
        }),
        fetchApi
          .get("/api/tts/capabilities", { headers: { accept: "application/json" } })
          .catch(() => null),
      ]);
      engineReport = report;
      capabilitiesReport = caps;
    } catch {
      engineReport = null;
      capabilitiesReport = null;
    }
    engineFieldErrors = [];
    engineDraft = draftFromReport(describeEngineConfig(engineReport));
    renderEngineConfig();
  }

  async function saveEngineConfig() {
    if (engineConfigBusy || !fetchApi) return;
    captureEngineDraft();
    const errors = [];
    engineDraft.models.forEach((model, index) => {
      const check = validateModelDraft(model);
      for (const [name, message] of Object.entries(check.errors)) {
        errors.push({ path: `models[${index}].${name}`, message });
      }
    });
    engineFieldErrors = errors;
    if (errors.length > 0) {
      renderEngineConfig();
      setEngineConfigStatus("Correction requise : voir les erreurs ci-dessous.", true);
      return;
    }
    const patch = buildEnginePatch({
      models: engineDraft.models,
      globals: engineDraft.globals,
      originalGlobals: engineView.globals,
    });
    if (Object.keys(patch).length === 0) {
      renderEngineConfig();
      setEngineConfigStatus("Aucune modification à enregistrer.");
      return;
    }
    const confirmed = modal
      ? await modal.confirm(
          "Enregistrer la configuration du moteur ?",
          "server.json sera mis à jour (sauvegarde server.json.bak conservée) puis devra " +
            "être relu par le moteur.\n\n" +
            restartProcedure(ttsContainerName),
        )
      : true;
    if (!confirmed) return;
    engineConfigBusy = true;
    setEngineConfigStatus("Enregistrement…");
    try {
      const report = await fetchApi.put("/api/tts/engine-config", {
        headers: WRITE_HEADERS,
        body: patch,
      });
      engineReport = report;
      engineFieldErrors = [];
      engineDraft = draftFromReport(describeEngineConfig(report));
      renderEngineConfig();
      setEngineConfigStatus(`Enregistré. ${restartProcedure(ttsContainerName)}`);
      onConfigChanged?.();
    } catch (error) {
      const described = describeEngineConfigError(error);
      engineFieldErrors = described.fields.map((entry) => ({
        path: entry.path || "(",
        message: entry.message,
      }));
      renderEngineConfig();
      setEngineConfigStatus(`Échec : ${described.message}`, true);
    } finally {
      engineConfigBusy = false;
    }
  }

  async function revertEngineConfig() {
    if (engineConfigBusy || !fetchApi) return;
    const confirmed = modal
      ? await modal.confirm(
          "Restaurer la dernière sauvegarde ?",
          "server.json sera remplacé par le contenu de server.json.bak. " +
            restartProcedure(ttsContainerName),
        )
      : true;
    if (!confirmed) return;
    engineConfigBusy = true;
    setEngineConfigStatus("Restauration…");
    try {
      const report = await fetchApi.post("/api/tts/engine-config/revert", {
        headers: WRITE_HEADERS,
      });
      engineReport = report;
      engineFieldErrors = [];
      engineDraft = draftFromReport(describeEngineConfig(report));
      renderEngineConfig();
      setEngineConfigStatus(`Sauvegarde restaurée. ${restartProcedure(ttsContainerName)}`);
      onConfigChanged?.();
    } catch (error) {
      const described = describeEngineConfigError(error);
      setEngineConfigStatus(`Échec : ${described.message}`, true);
    } finally {
      engineConfigBusy = false;
    }
  }

  /* — Rafraîchissement de l'état — */
  function clearStartingTimer() {
    if (startingTimer !== null) {
      clearTimeout(startingTimer);
      startingTimer = null;
    }
  }

  function scheduleStartingRetry(view) {
    clearStartingTimer();
    if (!view.retrySoon) {
      startingRetries = 0;
      return;
    }
    if (startingRetries >= TTS_STARTING_MAX_RETRIES) return;
    startingRetries += 1;
    startingTimer = setTimeout(() => {
      startingTimer = null;
      void refresh();
    }, TTS_STARTING_RETRY_MS);
  }

  async function refresh() {
    if (!fetchApi) {
      cardMessage.textContent = "La brique HTTP est indisponible : impossible d'interroger le gateway.";
      return;
    }
    refreshButton.disabled = true;
    cardStatus.textContent = "";
    try {
      const status = await fetchApi.get("/api/tts/status", {
        headers: { accept: "application/json" },
      });
      lastStatus = status;
    } catch (error) {
      lastStatus = null;
      setCardStatus(`Impossible d'interroger le gateway : ${apiErrorMessage(error)}`, true);
    }
    renderCard();
    renderModelsDir();
    scheduleStartingRetry(describeTtsState(lastStatus));
    await loadModels();
    await loadEngineConfig();
    refreshButton.disabled = false;
  }

  /* — Test de synthèse — */
  function renderTestError(described) {
    testFeedback.textContent = "";
    testFeedback.append(
      h("p", { class: "config-error tts-test__error", role: "status", "aria-live": "polite", text: described.message }),
    );
    if (described.hint) {
      testFeedback.append(h("p", { class: "config-helper", text: described.hint }));
    }
    if (described.detail) {
      testFeedback.append(
        h("details", { class: "tts-details" }, [
          h("summary", { class: "tts-details__summary", text: "Réponse brute du moteur" }),
          h("pre", { class: "tts-details__body", text: described.detail }),
        ]),
      );
    }
    const retry = h("button", {
      class: "button button--ghost button--small",
      type: "button",
      text: "Réessayer",
      "aria-label": "Relancer le test de synthèse",
    });
    retry.addEventListener("click", () => void runTest());
    testFeedback.append(h("div", { class: "tts-card__actions" }, [retry]));
  }

  async function runTest() {
    if (busy || !fetchApi) return;
    const check = validateTestText(testInput.value);
    if (!check.ok) {
      renderTestError({ message: check.error, hint: "Raccourcissez le texte.", detail: null });
      return;
    }
    busy = true;
    testButton.disabled = true;
    testFeedback.textContent = "";
    testFeedback.append(
      h("p", { class: "config-helper", role: "status", "aria-live": "polite", text: "Synthèse en cours…" }),
    );
    try {
      // Geste utilisateur : on `resume()` le contexte audio pour respecter la
      // politique d'autoplay. On NE l'attend PAS (un contexte non « débloqué »
      // peut voir sa promesse rester en suspens sans geste de confiance) : la
      // requête HTTP continue, la lecture se fera si le contexte est utilisable.
      if (player && typeof player.unlock === "function") {
        try {
          const resumed = player.unlock();
          if (resumed && typeof resumed.catch === "function") resumed.catch(() => {});
        } catch {
          /* sans audio, on continue : le test HTTP reste valide */
        }
      }
      const body = check.text.length > 0 ? { text: check.text } : {};
      const response = await fetchApi.post("/api/tts/test", {
        raw: true,
        headers: WRITE_HEADERS,
        body,
      });
      if (!response.ok) {
        let data = {};
        try {
          data = await response.json();
        } catch {
          /* corps non JSON */
        }
        renderTestError(describeTestError({ status: response.status, ...data }));
        return;
      }
      const voice = response.headers.get("x-yuki-tts-voice") || "default";
      const engine =
        response.headers.get("x-yuki-tts-engine") || lastStatus?.engine || "?";
      // Chemin du WAV de référence RÉELLEMENT envoyé au moteur (`voice_ref`) :
      // c'est l'information qui manque pour diagnostiquer une voix non prise.
      const voiceRef = response.headers.get("x-yuki-tts-voice-ref");
      let played = false;
      if (player && typeof player.playWav === "function") {
        const buffer = await response.arrayBuffer();
        played = await player.playWav(buffer);
      }
      testFeedback.textContent = "";
      testFeedback.append(
        h("p", {
          class: "tts-assistant__note tts-assistant__note--ok",
          role: "status",
          "aria-live": "polite",
        }, [
          "Échantillon reçu — voix réellement utilisée : ",
          h("strong", { text: voice }),
          ", moteur : ",
          h("strong", { text: engine }),
          played
            ? " (lecture lancée)."
            : " (lecture indisponible : la synthèse a réussi, mais le navigateur n'a pas pu jouer le son).",
        ]),
      );
      if (voiceRef) {
        testFeedback.append(
          h("p", { class: "config-helper" }, [
            "Fichier de référence envoyé au moteur : ",
            code(voiceRef),
            ".",
          ]),
        );
      }
      testFeedback.append(
        h("p", {
          class: "config-helper",
          text:
            "Rappel honnête : ce test prouve que la chaîne fonctionne, PAS que la voix ou la " +
            "langue est correcte. Écoutez le résultat.",
        }),
      );
    } catch (error) {
      renderTestError(
        describeTestError({
          status: 0,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      busy = false;
      testButton.disabled = !isTestAvailable(lastStatus);
    }
  }

  /* — Activation de la voix — */
  async function enableVoice() {
    if (busy || !fetchApi) return;
    const confirmed = modal
      ? await modal.confirm(
          "Activer la voix et redémarrer ?",
          "Le champ tts.enabled est en « apply: restart » : Yuki doit redémarrer pour que la " +
            "synthèse vocale s'active.\n\n" +
            "Yuki redémarre en interne (le conteneur reste en place). Cela interrompt la " +
            "conversation et les jobs en cours.",
        )
      : true;
    if (!confirmed) return;

    busy = true;
    cardActions.querySelectorAll("button").forEach((button) => {
      button.disabled = true;
    });
    setCardStatus("Enregistrement de tts.enabled = on…");
    try {
      await fetchApi.put("/api/config", {
        headers: WRITE_HEADERS,
        body: { "tts.enabled": "on" },
      });
    } catch (error) {
      setCardStatus(`Échec de l'activation : ${apiErrorMessage(error)}`, true);
      busy = false;
      renderCard();
      return;
    }
    onConfigChanged?.();
    if (requestRestart) {
      setCardStatus("Voix activée. Redémarrage de Yuki…");
      await requestRestart();
      busy = false;
      return;
    }
    setCardStatus(
      "Voix activée. Redémarrez Yuki depuis l'onglet Maintenance pour l'appliquer.",
    );
    busy = false;
    await refresh();
  }

  /* — Bloc « à la main » (les actions hors UI) — */
  function buildManualSection() {
    return h("section", { class: "tts-assistant__block tts-assistant__manual", "aria-labelledby": "tts-manual-title" }, [
      h("h3", { class: "tts-assistant__title", id: "tts-manual-title", text: "Ce qui reste à faire à la main" }),
      h("p", {
        class: "config-helper",
        text:
          "Aujourd'hui (Lot 9, étape 1), deux actions restent à la main : (1) démarrer ou " +
          "redémarrer le conteneur `tts` — le gateway n'a aucun accès au démon Docker (pas de " +
          "socket monté) ; (2) déposer le FICHIER du modèle, car le téléchargement depuis " +
          "l'interface n'est PAS encore livré (c'est l'étape suivante). Quand il le sera, " +
          "l'action (2) disparaîtra. Les RÉGLAGES du moteur se font ci-dessus (section " +
          "« Configuration du moteur ») ; les montages M1/M2/M3 à appliquer une fois sur " +
          "l'hôte y sont décrits.",
      }),
      h("ol", { class: "tts-manual__list" }, [
        h("li", { class: "tts-manual__item" }, [
          h("p", { class: "tts-manual__lead" }, [
            h("strong", { text: "Vérifier que le service « tts » est démarré" }),
            " : il fait partie de la pile (il doit apparaître dans « ",
            h("code", { text: "docker compose ps" }),
            " »). S'il manque, ses journaux l'expliquent :",
          ]),
          h("pre", { class: "tts-assistant__command", text: "docker compose logs tts" }),
          h("p", {
            class: "config-helper",
            text:
              "À exécuter sur l'hôte, à la racine de votre déploiement Compose, et seulement si « tts » " +
              "n'est pas déjà dans la pile (il doit être déclaré dans le même fichier Compose que le " +
              "gateway et démarré avec lui). Un GPU NVIDIA doit être disponible.",
          }),
        ]),
        h("li", { class: "tts-manual__item" }, [
          h("p", { class: "tts-manual__lead" }, [
            h("strong", { text: "Déposer le fichier du modèle" }),
            " dans le dossier partagé monté sur ",
            code("/models"),
            " (lu par le moteur ; le gateway y a aussi accès en écriture, pour ses " +
              "futurs téléchargements rangés dans le sous-dossier ",
            code("/models/downloads"),
            ") :",
          ]),
          h("p", { class: "config-helper" }, [
            "Le chemin du dossier dépend de VOTRE déploiement (variable d'environnement ou " +
              "fichier Compose — vérifiez la section `volumes:` des services). Déposez-y le " +
              "fichier .gguf attendu par le moteur, puis déclarez-le dans « Configuration du " +
              "moteur » ci-dessus (le sélecteur de chemin ne propose que les .gguf présents). " +
              "Le gateway réserve déjà le sous-dossier ",
            code("/models/downloads"),
            " pour les futurs téléchargements depuis l'interface, mais ne télécharge encore rien. " +
              "Ne déposez PAS les voix ici : elles vivent dans le dossier monté sur ",
            code("/voices"),
            " (gérable depuis cette page).",
          ]),
        ]),
      ]),
    ]);
  }

  /* — Démarrage : un seul refresh à l'ouverture (pas de polling agressif) — */
  void refresh();

  return {
    refresh,
    destroy() {
      clearStartingTimer();
      el.textContent = "";
    },
  };
}
