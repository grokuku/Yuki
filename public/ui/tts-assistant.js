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
 * Mappe `status.modelsDir` (diagnostic du volume `yuki-models`, monté `ro`) vers
 * un affichage honnête. Le répertoire absent/illisible est un cas normal, pas
 * une exception.
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
        "Aucun modèle de voix n'est installé. Déposez le fichier du modèle dans le volume " +
        "« yuki-models » (c'est une action HORS Yuki : le gateway n'écrit jamais dans ce volume, " +
        "monté en lecture seule).",
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

  let busy = false;
  let lastStatus = null;
  let startingRetries = 0;
  let startingTimer = null;

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
            "Le fichier du modèle doit être déposé à la main sur l'hôte (le volume est monté en " +
            "lecture seule pour le gateway comme pour le service tts).",
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

  /* — Bloc « à la main » (les 2 actions hors UI) — */
  function buildManualSection() {
    const startCommand = "docker compose --profile tts up -d";
    const depositCommand =
      "docker run --rm -v yuki-models:/models -v \"$PWD\":/src alpine \\\n" +
      "  cp /src/mon-modele.gguf /models/";
    return h("section", { class: "tts-assistant__block tts-assistant__manual", "aria-labelledby": "tts-manual-title" }, [
      h("h3", { class: "tts-assistant__title", id: "tts-manual-title", text: "Ce qui reste à faire à la main" }),
      h("p", {
        class: "config-helper",
        text:
          "Deux actions ne peuvent PAS être faites depuis l'interface. Le gateway n'a aucun " +
          "accès à Docker (pas de socket monté) et le volume des modèles est en lecture seule. " +
          "C'est le seul moment où vous devez quitter l'interface.",
      }),
      h("ol", { class: "tts-manual__list" }, [
        h("li", { class: "tts-manual__item" }, [
          h("p", { class: "tts-manual__lead" }, [
            h("strong", { text: "Démarrer le conteneur « tts »" }),
            " (s'il n'est pas déjà démarré par la stack ; le `--profile` couvre la " +
              "variante du dépôt racine, où le service est opt-in) :",
          ]),
          h("pre", { class: "tts-assistant__command", text: startCommand }),
          h("p", {
            class: "config-helper",
            text: "À exécuter sur l'hôte, à la racine du dépôt Yuki. Un GPU NVIDIA doit être disponible.",
          }),
        ]),
        h("li", { class: "tts-manual__item" }, [
          h("p", { class: "tts-manual__lead" }, [
            h("strong", { text: "Déposer le fichier du modèle" }),
            " dans le volume ",
            code("yuki-models"),
            " (monté en lecture seule sur ",
            code("/models"),
            ", chemin visible ci-dessus) :",
          ]),
          h("pre", { class: "tts-assistant__command", text: depositCommand }),
          h("p", {
            class: "config-helper",
            text:
              "Remplacez « mon-modele.gguf » par le fichier du modèle attendu par le moteur. " +
              "Ne déposez PAS les voix ici : elles vivent dans le volume yuki-voices (gérable depuis cette page).",
          }),
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
