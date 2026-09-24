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
 *   - l'activation de la voix (`tts.enabled`) NE passe PAS par un `PUT`
 *     propre : le bouton du bandeau est un **raccourci** vers
 *     l'**enregistrement global** de `config.js` (chemin d'écriture unique).
 *     L'assistant ne redémarre RIEN en silence ; il guide vers l'onglet
 *     Maintenance.
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
  applyCatalogPrefill,
  applicationState,
  buildEnginePatch,
  describeCapabilities,
  describeEngineConfig,
  describeEngineConfigError,
  restartProcedure,
  setModelField,
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

/** Intervalle de sondage de `GET /api/tts/downloads` **tant qu'un transfert est actif**. */
export const TTS_DOWNLOAD_POLL_MS = 1_000;

/**
 * Statuts TERMINAUX d'une tâche de téléchargement — miroir de
 * `src/tts/downloads.ts` (`DOWNLOAD_TERMINAL_STATUSES`). `done` est le SEUL
 * succès ; `interrupted` n'est **jamais** un succès.
 */
export const DOWNLOAD_TERMINAL_STATUSES = ["done", "failed", "cancelled", "interrupted"];

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

/* ─── Téléchargement des modèles (Lot 9, étape 3 — UI) ───────────────────
 * Mapping PUR de l'état du catalogue et des tâches vers l'affichage. Aucun
 * DOM, aucun réseau : testable en Node (comme le reste du module).
 */

/** Vrai si un statut de tâche est terminal (plus aucune évolution possible). */
export function isDownloadTerminal(status) {
  return DOWNLOAD_TERMINAL_STATUSES.includes(status);
}

/**
 * Statut d'une tâche → libellé français + tonalité (`ok`/`warn`/`error`/`muted`).
 * `interrupted` (gateway tué pendant le transfert) est présenté en **erreur**,
 * jamais comme un succès : seul `done` est « Téléchargé ».
 */
export function describeDownloadStatus(status) {
  switch (status) {
    case "queued":
      return { key: "queued", label: "En attente", tone: "muted", terminal: false };
    case "downloading":
      return { key: "downloading", label: "Téléchargement…", tone: "warn", terminal: false };
    case "verifying":
      return { key: "verifying", label: "Vérification…", tone: "warn", terminal: false };
    case "done":
      return { key: "done", label: "Téléchargé", tone: "ok", terminal: true };
    case "failed":
      return { key: "failed", label: "Échec", tone: "error", terminal: true };
    case "cancelled":
      return { key: "cancelled", label: "Annulé", tone: "muted", terminal: true };
    case "interrupted":
      return { key: "interrupted", label: "Interrompu", tone: "error", terminal: true };
    default:
      return { key: "unknown", label: "État inconnu", tone: "muted", terminal: true };
  }
}

/**
 * Progression d'une tâche : `{ determinate, percent, percentText, bytesText }`.
 * Sans total connu, la barre est **indéterminée** (aucun pourcentage inventé).
 */
export function downloadProgress(task) {
  const bytesRaw = Number(task?.bytesDownloaded);
  const totalRaw = Number(task?.totalBytes);
  const bytes = Number.isFinite(bytesRaw) && bytesRaw > 0 ? bytesRaw : 0;
  if (Number.isFinite(totalRaw) && totalRaw > 0) {
    const percent = Math.max(0, Math.min(100, Math.floor((bytes / totalRaw) * 100)));
    return {
      determinate: true,
      percent,
      percentText: `${percent} %`,
      bytesText: `${formatBytes(bytes)} / ${formatBytes(totalRaw)}`,
    };
  }
  return {
    determinate: false,
    percent: null,
    percentText: null,
    bytesText: formatBytes(bytes),
  };
}

/**
 * Vue d'une entrée du catalogue (`GET /api/tts/catalog`) : taille, licence,
 * badge d'état (`à télécharger` / `téléchargé` / `déclaré`) et tâche locale.
 */
export function describeCatalogEntry(entry) {
  const e = entry && typeof entry === "object" ? entry : {};
  const declared = e.declared === true;
  const installed = e.installed === true;
  const licenseAllowed = e.licenseAllowed !== false;
  const task = e.download && typeof e.download === "object" ? e.download : null;
  let stateKey = "missing";
  let badgeLabel = "À télécharger";
  let tone = "muted";
  if (declared) {
    stateKey = "declared";
    badgeLabel = "Déclaré";
    tone = "ok";
  } else if (installed) {
    stateKey = "installed";
    badgeLabel = "Téléchargé";
    tone = "warn";
  }
  return {
    id: typeof e.id === "string" ? e.id : "",
    label: typeof e.label === "string" && e.label.length > 0 ? e.label : String(e.id ?? "?"),
    variant: typeof e.variant === "string" ? e.variant : null,
    installed,
    declared,
    licenseAllowed,
    license: typeof e.license === "string" && e.license.length > 0 ? e.license : "?",
    sizeText: formatBytes(e.expectedBytes),
    stateKey,
    badgeLabel,
    tone,
    task,
    active: Boolean(task && !isDownloadTerminal(task.status)),
  };
}

/**
 * Décision d'action PURE pour une entrée : télécharger → déclarer → activer
 * (ou annuler pendant un transfert actif). Tient compte d'un téléchargement
 * DÉJÀ en cours (`activeId`) et de la disponibilité de l'éditeur de config.
 */
export function catalogAction(view, options = {}) {
  const activeId = typeof options.activeId === "string" ? options.activeId : null;
  const engineConfigAvailable = options.engineConfigAvailable !== false;
  const busy = activeId !== null;
  if (view.active) {
    return { kind: "cancel", label: "Annuler", disabled: false, reason: null };
  }
  if (view.installed && !view.declared) {
    return engineConfigAvailable
      ? { kind: "declare", label: "Déclarer ce modèle", disabled: false, reason: null }
      : {
          kind: "declare",
          label: "Déclarer ce modèle",
          disabled: true,
          reason: "La configuration du moteur n'est pas disponible dans ce gateway.",
        };
  }
  if (view.declared) {
    return engineConfigAvailable
      ? { kind: "activate", label: "Choisir comme moteur", disabled: false, reason: null }
      : {
          kind: "activate",
          label: "Choisir comme moteur",
          disabled: true,
          reason: "La configuration du moteur n'est pas disponible dans ce gateway.",
        };
  }
  const failedTask = view.task && !view.installed
    ? ["failed", "interrupted", "cancelled"].includes(view.task.status)
    : false;
  if (!view.licenseAllowed) {
    return { kind: "download", label: "Télécharger", disabled: true, reason: "Licence hors politique." };
  }
  return {
    kind: "download",
    label: failedTask ? "Réessayer" : "Télécharger",
    disabled: busy,
    reason: busy ? "Un téléchargement est déjà en cours." : null,
  };
}

/**
 * Vue d'une entrée ÉCARTÉE (`notIncluded`, ex. `sanotts` GPL-3.0) : affichée
 * avec sa raison, **sans bouton** (transparence, jamais retirée en silence).
 */
export function describeNotIncluded(rejection) {
  const r = rejection && typeof rejection === "object" ? rejection : {};
  return {
    id: typeof r.id === "string" ? r.id : "",
    label: typeof r.label === "string" && r.label.length > 0 ? r.label : String(r.id ?? "?"),
    license: typeof r.license === "string" && r.license.length > 0 ? r.license : "?",
    reason: typeof r.reason === "string" ? r.reason : null,
    detail:
      typeof r.detail === "string" && r.detail.length > 0
        ? r.detail
        : "Moteur écarté du catalogue fermé.",
  };
}

/**
 * Faut-il sonder `GET /api/tts/downloads` ? **Oui uniquement** tant qu'une
 * tâche est non terminale (y compris `queued`) : sinon, aucune requête.
 */
export function shouldPollDownloads(report) {
  if (!report || typeof report !== "object") return false;
  if (typeof report.active === "string" && report.active.length > 0) return true;
  const tasks = Array.isArray(report.tasks) ? report.tasks : [];
  return tasks.some((task) => task && !isDownloadTerminal(task.status));
}

/**
 * Erreur d'une action de téléchargement → message affiché. **Le message EXACT
 * du serveur est la source de vérité** (lecture seule, permissions, espace
 * disque…) : on n'invente aucune cause. Un repli n'existe que si le serveur
 * n'a rien fourni.
 */
export function describeDownloadError(error) {
  const input = error && typeof error === "object" ? error : {};
  const data = input.data && typeof input.data === "object" ? input.data : input;
  const code =
    typeof data.code === "string" && data.code.length > 0
      ? data.code
      : typeof data.error === "string" && data.error.length > 0
        ? data.error
        : null;
  const status = Number(data.status ?? input.status) || 0;
  const serverMessage =
    typeof data.message === "string" && data.message.length > 0 ? data.message : null;
  const fallback = (() => {
    switch (code) {
      case "download_in_progress":
        return "Un téléchargement est déjà en cours pour ce modèle.";
      case "models_dir_unwritable":
        return "Le dossier des modèles n'est pas inscriptible par le gateway.";
      case "insufficient_disk_space":
        return "Espace disque insuffisant pour ce modèle.";
      case "catalog_resolve_failed":
        return "Résolution du paquet impossible (dépôt Hugging Face).";
      case "unknown_catalog_id":
      case "invalid_json":
      case "invalid_body":
      case "invalid_catalog_id":
        return "Modèle inconnu du catalogue fermé.";
      case "downloads_unavailable":
        return "Le téléchargement des modèles n'est pas disponible dans ce gateway.";
      default:
        return status === 0
          ? "La requête n'a pas abouti (gateway injoignable)."
          : "Le téléchargement a échoué.";
    }
  })();
  return {
    code,
    status,
    message: serverMessage ?? fallback,
    retry: status === 0 || status >= 500,
  };
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
        "Aucun modèle de voix n'est installé. Téléchargez-en un depuis « Télécharger " +
        "un modèle » ci-dessous, ou déposez un fichier .gguf dans le dossier des modèles " +
        "monté sur ce conteneur (action HORS Yuki, réservée aux moteurs hors catalogue).",
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
 * @param {HTMLElement|string} [deps.engineRoot] Conteneur de la zone ⑤
 *   (« Moteur TTS et modèles »). Absent ⇒ la zone reste dans `root`.
 * @param {() => string} [deps.getActiveVoice] Valeur courante de `tts.voice`.
 * @param {() => void} [deps.onConfigChanged] Notifie `config.js` (relecture).
 * @param {() => Promise<boolean>} [deps.requestEnableVoice] Raccourci vers le
 *   chemin d'écriture UNIQUE : règle `tts.enabled` puis enregistre (config.js).
 * @param {(id: string) => Promise<boolean>} [deps.requestActivateEngine]
 *   Raccourci vers le même chemin d'écriture : règle `tts.engine` puis
 *   enregistre (config.js). Utilisé par « Choisir comme moteur ».
 * @param {() => void} [deps.openMaintenance] Bascule vers l'onglet Maintenance.
 * @param {string} [deps.ttsContainerName] Nom du conteneur moteur (procédure).
 * @returns {{ refresh: () => Promise<void>, destroy: () => void }}
 */
export function initTtsAssistant(root, deps = {}) {
  const el = typeof root === "string" ? document.getElementById(root) : root;
  if (!el) return { refresh: async () => {}, destroy() {} };

  // Zone ⑤ : second point de montage du MÊME composant (jamais dupliqué).
  const engineEl =
    typeof deps.engineRoot === "string"
      ? document.getElementById(deps.engineRoot)
      : deps.engineRoot ?? null;

  const fetchApi = deps.HolafFetch;
  const modal = deps.HolafModal;
  const player = deps.player ?? null;
  const onConfigChanged =
    typeof deps.onConfigChanged === "function" ? deps.onConfigChanged : null;
  const requestEnableVoice =
    typeof deps.requestEnableVoice === "function" ? deps.requestEnableVoice : null;
  const requestActivateEngine =
    typeof deps.requestActivateEngine === "function" ? deps.requestActivateEngine : null;
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
  // Téléchargement des modèles (Lot 9, étape 3).
  let catalogReport = null;
  let downloadsReport = null;
  let downloadsBusy = false;
  let downloadsPollTimer = null;
  // Un transfert a-t-il été actif lors du dernier sondage ? Sert à recharger le
  // catalogue (installé/déclaré) UNE fois à l'arrêt du transfert.
  let downloadsHadActive = false;

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

  // Zone ⑤ — UI de téléchargement des modèles (Lot 9, étape 3) : catalogue
  // fermé, progression, annulation puis déclaration. Le conteneur `#tts-downloads-root`
  // reçoit la liste, l'état du transfert actif et les modèles écartés.
  const downloadsIntro = h("p", {
    class: "config-helper",
    text:
      "Catalogue fermé (l'URL des paquets est construite par le serveur, jamais par le " +
      "navigateur). Téléchargez un modèle, puis déclarez-le : le gateway y accède en " +
      "écriture dans `/models/downloads`.",
  });
  const downloadsStatus = h("p", {
    class: "config-helper tts-dl__status",
    role: "status",
    "aria-live": "polite",
  });
  const downloadsError = h("div", { class: "tts-dl__error" });
  const downloadsCatalog = h("ul", { class: "tts-dl__catalog" });
  const downloadsExcluded = h("div", { class: "tts-dl__excluded" });
  const downloadsRoot = h("div", { class: "tts-downloads", id: "tts-downloads-root" }, [
    downloadsIntro,
    downloadsStatus,
    downloadsError,
    downloadsCatalog,
    downloadsExcluded,
  ]);
  const downloadsBlock = h(
    "section",
    { class: "tts-assistant__block tts-assistant__downloads", "aria-labelledby": "tts-downloads-title" },
    [
      h("h3", { class: "tts-assistant__title", id: "tts-downloads-title", text: "Télécharger un modèle" }),
      downloadsRoot,
    ],
  );

  // Zone ① — bandeau d'état COMPACT : badge + une phrase + boutons contextuels.
  // La logique de la carte (`describeTtsState`, `statusTechnicalDetails`) est
  // INCHANGÉE ; seul l'emballage change.
  const stateSection = h(
    "section",
    { class: "config-group tts-assistant tts-assistant--state", id: "tts-assistant" },
    [
      h("div", { class: "config-group__head" }, [
        h("h2", { class: "config-group__title", text: "État de la voix" }),
        h("div", { class: "config-secret" }, [refreshButton]),
      ]),
      card,
    ],
  );

  // Zone ⑤ — « Moteur TTS et modèles » : tout le technique/diagnostic REPLIÉ.
  // Rendu EAGER conservé : chaque bloc reste dans le DOM, le `<details>` masque
  // sans retirer (classe DISTINCTE `config-advanced`, jamais `tts-details`).
  const engineSection = h(
    "details",
    { class: "config-advanced tts-assistant__engine-zone" },
    [
      h("summary", { class: "config-advanced__summary", text: "Moteur TTS et modèles" }),
      h("div", { class: "config-advanced__body tts-assistant" }, [
        h("p", {
          class: "config-intro tts-assistant__intro",
          text:
            "Diagnostic et réglages techniques de la voix. Cet assistant interroge " +
            "uniquement le gateway : il n'a jamais accès au moteur ni à Docker. " +
            "Aucun état « prêt » n'est affiché sans preuve positive de la sonde.",
        }),
        h("section", { class: "tts-assistant__block", "aria-labelledby": "tts-models-dir-title" }, [
          h("h3", { class: "tts-assistant__title", id: "tts-models-dir-title", text: "Modèle de voix sur le disque" }),
          modelsDirBody,
        ]),
        engineDetails,
        downloadsBlock,
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
      ]),
    ],
  );
  testInput.id = "tts-test-text";

  el.textContent = "";
  el.append(stateSection);
  if (engineEl) {
    engineEl.textContent = "";
    engineEl.append(engineSection);
  } else {
    // Sans conteneur dédié : la zone ⑤ reste dans le même root (compatibilité).
    el.append(engineSection);
  }

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
        "aria-label": "Activer la synthèse vocale (enregistre la configuration)",
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
            "Le fichier du modèle doit être présent sur le disque ; téléchargez-le depuis " +
            "« Télécharger un modèle » ci-dessus, puis déclarez-le dans « Configuration du " +
            "moteur ». Le service tts lit `/models` en lecture seule ; le gateway y a accès " +
            "en écriture dans le sous-dossier `downloads`.",
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
        if (
          current &&
          ENGINE_MODES.includes(current.mode) &&
          ENGINE_FORCE_OFFLINE_FAMILIES.includes(current.family)
        ) {
          // Édition PAR ENTRÉE (nouveau tableau, aucune référence partagée).
          engineDraft.models = setModelField(engineDraft.models, index, "mode", "offline");
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
            "Aucun fichier .gguf détecté sous les dossiers de modèles. Téléchargez un modèle " +
            "dans « Télécharger un modèle » ci-dessus, puis déclarez-le ici.",
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

  async function saveEngineConfig(options = {}) {
    if (engineConfigBusy || !fetchApi) return;
    // `capture` vaut `true` par défaut (bouton « Enregistrer » : on relit
    // l'éditeur). « Déclarer ce modèle » passe `capture: false` pour écrire le
    // brouillon ciblé SANS relecture DOM.
    if (options.capture !== false) captureEngineDraft();
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

  /* — Téléchargement des modèles (Lot 9, étape 3) —
   * Consomme UNIQUEMENT les routes du gateway : `GET /api/tts/catalog`,
   * `GET /api/tts/downloads`, `POST /api/tts/downloads` et
   * `POST /api/tts/downloads/{id}/cancel`. La progression vient du poll de
   * `GET /api/tts/downloads` — jamais d'une requête longue.
   */

  function setDownloadsStatus(text, tone = null) {
    downloadsStatus.textContent = text ?? "";
    downloadsStatus.className =
      "config-helper tts-dl__status" + (tone ? ` tts-dl__status--${tone}` : "");
  }

  function renderDownloadError(error, retryFn) {
    const described = describeDownloadError(error);
    downloadsError.textContent = "";
    downloadsError.append(
      h("p", {
        class: "config-error tts-dl__error-message",
        role: "status",
        "aria-live": "polite",
        text: described.message,
      }),
    );
    if (described.retry && typeof retryFn === "function") {
      const retry = h("button", {
        class: "button button--ghost button--small",
        type: "button",
        text: "Réessayer",
        "aria-label": `Réessayer : ${described.message}`,
      });
      retry.addEventListener("click", () => {
        downloadsError.textContent = "";
        retryFn();
      });
      downloadsError.append(h("div", { class: "tts-card__actions" }, [retry]));
    }
  }

  function clearDownloadsError() {
    downloadsError.textContent = "";
  }

  function buildProgress(task) {
    const progress = downloadProgress(task);
    const statusView = describeDownloadStatus(task.status);
    const label = task.label ?? task.catalogId ?? "modèle";
    const wrap = h("div", { class: "tts-dl__progress" }, [
      h("p", { class: "tts-dl__task-note", text: `${statusView.label} ${label}`.trim() }),
    ]);
    const bar = h("progress", {
      class: "tts-dl__progress-bar",
      max: "100",
      "aria-label": `Progression du téléchargement de ${label}`,
    });
    if (progress.determinate) {
      bar.value = progress.percent;
      bar.setAttribute("aria-valuetext", `${progress.percentText}, ${progress.bytesText}`);
    } else {
      // Barre indéterminée : aucun pourcentage inventé. On retire l'attribut
      // `value` (présence ⇒ barre déterminée) plutôt que de poser un `style`.
      bar.removeAttribute("value");
      bar.setAttribute("aria-valuetext", progress.bytesText);
    }
    wrap.append(
      bar,
      h("p", {
        class: "tts-dl__progress-meta",
        text: progress.determinate
          ? `${progress.bytesText} — ${progress.percentText}`
          : progress.bytesText,
      }),
    );
    return wrap;
  }

  function buildCatalogRow(entry, view, action) {
    const row = h("li", {
      class: "tts-dl__item" + (view.active ? " tts-dl__item--active" : ""),
    });
    row.append(
      h("div", { class: "tts-dl__head" }, [
        h("span", { class: "tts-dl__label", text: view.label }),
        h("span", {
          class: `tts-dl__state tts-dl__state--${view.tone}`,
          text: view.badgeLabel,
        }),
      ]),
      h("p", {
        class: "tts-dl__meta",
        text: `${view.sizeText} · licence ${view.license}${
          view.variant ? ` · ${view.variant}` : ""
        }`,
      }),
    );
    if (view.active && view.task) {
      row.append(buildProgress(view.task));
    } else if (view.task) {
      const statusView = describeDownloadStatus(view.task.status);
      const note =
        view.task.status === "failed"
          ? view.task.error ?? "Le téléchargement a échoué."
          : view.task.status === "interrupted"
            ? view.task.error ??
              "Téléchargement interrompu par un redémarrage du gateway : relancez-le."
            : view.task.status === "cancelled"
              ? "Téléchargement annulé."
              : null;
      if (note) {
        row.append(
          h("p", {
            class: `tts-dl__task-note${
              statusView.tone === "error" ? " tts-dl__task-note--error" : ""
            }`,
            text: note,
          }),
        );
      }
    }

    const actions = h("div", { class: "tts-dl__actions" });
    const button = h("button", {
      class: "button button--small",
      type: "button",
      text: action.label,
      "aria-label": `${action.label} — ${view.label}`,
    });
    button.disabled = action.disabled;
    button.addEventListener("click", () => void runCatalogAction(action.kind, entry));
    actions.append(button);
    if (action.disabled && action.reason) {
      actions.append(h("span", { class: "tts-dl__hint", text: action.reason }));
    }
    row.append(actions);
    return row;
  }

  function renderExcluded(notIncluded) {
    downloadsExcluded.textContent = "";
    if (!Array.isArray(notIncluded) || notIncluded.length === 0) return;
    const list = h("ul", { class: "tts-dl__excluded-list" });
    for (const raw of notIncluded) {
      const view = describeNotIncluded(raw);
      list.append(
        h("li", { class: "tts-dl__excluded-item" }, [
          h("span", { class: "tts-dl__label", text: `${view.label} — licence ${view.license}` }),
          h("p", { class: "tts-dl__meta", text: view.detail }),
        ]),
      );
    }
    downloadsExcluded.append(
      h("details", { class: "tts-dl__excluded-details" }, [
        h("summary", {
          class: "tts-details__summary",
          text: `Moteurs écartés (${notIncluded.length})`,
        }),
        h("p", {
          class: "config-helper",
          text:
            "Ces moteurs ne sont pas téléchargeables depuis Yuki (licence hors politique " +
            "MIT/Apache-2.0). Ils restent déclarables à la main dans « Configuration du moteur ».",
        }),
        list,
      ]),
    );
  }

  function renderCatalog() {
    const entries = Array.isArray(catalogReport?.entries) ? catalogReport.entries : [];
    const notIncluded = Array.isArray(catalogReport?.notIncluded) ? catalogReport.notIncluded : [];
    const engineConfigAvailable = catalogReport?.engineConfigAvailable !== false;
    const activeId =
      typeof downloadsReport?.active === "string" && downloadsReport.active.length > 0
        ? downloadsReport.active
        : null;
    // La tâche la plus FRAÎCHE vient de `GET /api/tts/downloads` (le catalogue
    // n'est rechargé qu'à l'arrêt du transfert) : on la préfère à `entry.download`.
    const taskById = new Map(
      (Array.isArray(downloadsReport?.tasks) ? downloadsReport.tasks : [])
        .filter((task) => task && typeof task.catalogId === "string")
        .map((task) => [task.catalogId, task]),
    );
    downloadsCatalog.textContent = "";
    if (!catalogReport) {
      downloadsCatalog.append(
        h("li", { class: "tts-dl__empty", text: "Catalogue indisponible." }),
      );
      return;
    }
    if (entries.length === 0) {
      downloadsCatalog.append(
        h("li", { class: "tts-dl__empty", text: "Aucun modèle téléchargeable." }),
      );
    }
    for (const entry of entries) {
      const task = taskById.get(entry.id) ?? entry.download ?? null;
      const merged = { ...entry, download: task };
      const view = describeCatalogEntry(merged);
      const action = catalogAction(view, { activeId, engineConfigAvailable });
      downloadsCatalog.append(buildCatalogRow(merged, view, action));
    }
    renderExcluded(notIncluded);
  }

  async function loadCatalog() {
    if (!fetchApi) return;
    try {
      catalogReport = await fetchApi.get("/api/tts/catalog", {
        headers: { accept: "application/json" },
      });
    } catch (error) {
      catalogReport = null;
      renderDownloadError(error);
    }
    renderCatalog();
  }

  function scheduleDownloadsPoll() {
    if (downloadsPollTimer !== null) return;
    downloadsPollTimer = setTimeout(() => {
      downloadsPollTimer = null;
      void loadDownloads();
    }, TTS_DOWNLOAD_POLL_MS);
  }

  function clearDownloadsPoll() {
    if (downloadsPollTimer !== null) {
      clearTimeout(downloadsPollTimer);
      downloadsPollTimer = null;
    }
  }

  async function loadDownloads() {
    if (!fetchApi) return;
    try {
      downloadsReport = await fetchApi.get("/api/tts/downloads", {
        headers: { accept: "application/json" },
      });
    } catch {
      // Échec transient : on conserve le dernier état connu et on continue à
      // sonder tant qu'un transfert était actif (aucun message trompeur).
    }
    renderCatalog();
    if (shouldPollDownloads(downloadsReport)) {
      downloadsHadActive = true;
      scheduleDownloadsPoll();
    } else {
      clearDownloadsPoll();
      if (downloadsHadActive) {
        downloadsHadActive = false;
        await loadCatalog();
      }
    }
  }

  async function runCatalogAction(kind, entry) {
    if (kind === "download") return startDownload(entry);
    if (kind === "cancel") return cancelDownload(entry);
    if (kind === "declare") return declareCatalogEntry(entry);
    if (kind === "activate") return activateCatalogEntry(entry);
  }

  async function startDownload(entry) {
    if (!fetchApi || downloadsBusy) return;
    const catalogId = entry?.id;
    const label = entry?.label ?? catalogId ?? "modèle";
    if (typeof catalogId !== "string" || catalogId.length === 0) return;
    downloadsBusy = true;
    clearDownloadsError();
    setDownloadsStatus(`Démarrage du téléchargement de « ${label} »…`);
    try {
      await fetchApi.post("/api/tts/downloads", {
        headers: WRITE_HEADERS,
        body: { catalogId },
      });
      await loadDownloads();
    } catch (error) {
      renderDownloadError(error, () => void startDownload(entry));
    } finally {
      downloadsBusy = false;
      renderCatalog();
    }
  }

  async function cancelDownload(entry) {
    if (!fetchApi || downloadsBusy) return;
    const catalogId = entry?.id;
    const label = entry?.label ?? catalogId ?? "modèle";
    if (typeof catalogId !== "string" || catalogId.length === 0) return;
    const confirmed = modal
      ? await modal.confirm(
          "Annuler ce téléchargement ?",
          `Le téléchargement de « ${label} » sera arrêté. Le fichier partiel est conservé : ` +
            "vous pourrez le reprendre plus tard.",
        )
      : true;
    if (!confirmed) return;
    downloadsBusy = true;
    clearDownloadsError();
    try {
      await fetchApi.post(
        `/api/tts/downloads/${encodeURIComponent(catalogId)}/cancel`,
        { headers: WRITE_HEADERS },
      );
      await loadDownloads();
    } catch (error) {
      renderDownloadError(error, () => void cancelDownload(entry));
    } finally {
      downloadsBusy = false;
      renderCatalog();
    }
  }

  /** Ajoute le `prefill` à l'éditeur EXISTANT puis passe par son enregistrement. */
  async function declareCatalogEntry(entry) {
    const prefill =
      entry && entry.prefill && typeof entry.prefill === "object" ? entry.prefill : null;
    const label = entry?.label ?? entry?.id ?? "modèle";
    if (!prefill) {
      renderDownloadError({
        code: "invalid_catalog_id",
        message: `Aucun pré-remplissage fourni pour « ${label} » : déclarez-le dans « Configuration du moteur ».`,
      });
      return;
    }
    const view = describeEngineConfig(engineReport);
    if (view.kind !== "ready" && view.kind !== "no-file") {
      renderDownloadError({
        status: 503,
        code: "engine_config_unavailable",
        message:
          "La configuration du moteur n'est pas modifiable depuis cette page " +
          "(voir « Configuration du moteur »).",
      });
      return;
    }
    clearDownloadsError();
    // Déclaration CIBLÉE, base AUTORITAIRE côté serveur : le `prefill` est
    // appliqué par `id` sur les entrées RÉELLEMENT persistées. On ne repart
    // jamais d'une capture DOM (qui pourrait propager la valeur d'une autre
    // ligne) ; les autres entrées restent telles qu'enregistrées.
    engineDraft.models = applyCatalogPrefill(draftFromReport(view).models, prefill);
    engineFieldErrors = [];
    renderEngineConfig();
    setDownloadsStatus(`Déclaration de « ${label} » dans la configuration du moteur…`);
    // `capture: false` : l'enregistrement écrit EXACTEMENT le brouillon ciblé
    // ci-dessus (aucune relecture DOM susceptible de le corrompre).
    await saveEngineConfig({ capture: false });
    await loadCatalog();
  }

  async function activateCatalogEntry(entry) {
    const label = entry?.label ?? entry?.id ?? "modèle";
    const catalogId = entry?.id;
    if (typeof requestActivateEngine !== "function") {
      setDownloadsStatus(
        "Activez ce moteur dans « Réglages de la voix » (champ « Moteur de synthèse »).",
        "warn",
      );
      return;
    }
    if (downloadsBusy || typeof catalogId !== "string" || catalogId.length === 0) return;
    downloadsBusy = true;
    setDownloadsStatus(`Activation du moteur « ${label} »…`);
    try {
      const ok = await requestActivateEngine(catalogId);
      setDownloadsStatus(
        ok
          ? `Moteur « ${label} » enregistré — redémarrez le conteneur « tts » s'il ne l'a pas encore chargé.`
          : "L'activation n'a pas pu être enregistrée : voir le message de la page.",
        ok ? null : "error",
      );
      await loadCatalog();
    } finally {
      downloadsBusy = false;
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
    await loadCatalog();
    await loadDownloads();
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

  /* — Activation de la voix : chemin d'écriture UNIQUE —
   * Le bouton est un RACCOURCI : il règle `tts.enabled` puis passe par
   * l'enregistrement GLOBAL de `config.js` (barre sticky) — plus aucun `PUT`
   * propre à l'assistant, plus aucun redémarrage silencieux. Il guide ensuite
   * vers l'onglet Maintenance (le champ reste en `apply: restart`). */
  async function enableVoice() {
    if (busy || !fetchApi) return;
    busy = true;
    cardActions.querySelectorAll("button").forEach((button) => {
      button.disabled = true;
    });
    if (typeof requestEnableVoice !== "function") {
      setCardStatus(
        "Activez la voix avec le champ « Activer la voix », puis « Enregistrer ».",
        true,
      );
      busy = false;
      renderCard();
      return;
    }
    setCardStatus("Activation de la voix — enregistrement global…");
    const ok = await requestEnableVoice();
    busy = false;
    if (!ok) {
      setCardStatus(
        "L'activation n'a pas pu être enregistrée : voir le message de la page.",
        true,
      );
      return;
    }
    // Rafraîchit la carte (badge/boutons) PUIS repose le guide de redémarrage
    // (le rafraîchissement vide le statut par conception).
    await refresh();
    setCardStatus(
      "Voix activée et enregistrée. Redémarrez Yuki (onglet Maintenance) pour l'appliquer.",
    );
  }

  /* — Bloc « à la main » (les actions hors UI) — */
  function buildManualSection() {
    return h("section", { class: "tts-assistant__block tts-assistant__manual", "aria-labelledby": "tts-manual-title" }, [
      h("h3", { class: "tts-assistant__title", id: "tts-manual-title", text: "Ce qui reste à faire à la main" }),
      h("p", {
        class: "config-helper",
        text:
          "Le téléchargement depuis l'interface est livré : pour les quatre variantes du " +
          "catalogue (Chatterbox, CosyVoice 3, Qwen3-TTS, Kokoro), il n'y a plus de fichier à " +
          "déposer à la main (voir « Télécharger un modèle » ci-dessus). Il reste une action " +
          "hors Yuki : démarrer ou redémarrer le conteneur `tts` — le gateway n'a aucun accès " +
          "au démon Docker. Les RÉGLAGES du moteur se font ci-dessus (section « Configuration " +
          "du moteur ») ; les montages M1/M2/M3 à appliquer une fois sur l'hôte y sont décrits.",
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
              "gateway et démarré avec lui). Un GPU NVIDIA doit être disponible. Le moteur relit " +
              "server.json uniquement à son démarrage : redémarrez-le après un changement de modèle.",
          }),
        ]),
        h("li", { class: "tts-manual__item" }, [
          h("p", { class: "tts-manual__lead" }, [
            h("strong", { text: "Seulement pour un moteur HORS catalogue" }),
            " : déposer un fichier .gguf dans le dossier partagé monté sur ",
            code("/models"),
            " (lu par le moteur ; le gateway y a aussi accès en écriture, pour ses " +
              "téléchargements rangés dans le sous-dossier ",
            code("/models/downloads"),
            "), puis le déclarer dans « Configuration du moteur » :",
          ]),
          h("p", { class: "config-helper" }, [
            "Cette action n'est PLUS nécessaire pour les variantes du catalogue (elles se " +
              "téléchargent depuis l'interface). Elle reste vraie uniquement pour un moteur " +
              "écarté du catalogue (p. ex. ",
            code("sanotts"),
            ", licence GPL-3.0 hors politique) ou un GGUF personnel. Le chemin du dossier " +
              "dépend de VOTRE déploiement (variable d'environnement ou fichier Compose — " +
              "vérifiez la section `volumes:` des services). Le sélecteur de chemin de l'éditeur " +
              "ne propose que les .gguf présents sur le disque. Ne déposez PAS les voix ici : " +
              "elles vivent dans le dossier monté sur ",
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
      clearDownloadsPoll();
      el.textContent = "";
      if (engineEl) engineEl.textContent = "";
    },
  };
}
