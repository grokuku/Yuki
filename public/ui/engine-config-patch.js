/**
 * Logique PURE de la configuration STRUCTURÉE du moteur `audio.cpp` (Lot 9).
 *
 * Aucun DOM, aucun réseau : ce module est testable en Node (même patron que
 * `public/ui/config-patch.js`). Il porte :
 *   - les LISTES FERMÉES (`task`/`mode`/`family`/`id`) et la validation de
 *     brouillon, qui empêche les erreurs connues (`clone`, `mode` invalide,
 *     `offline` imposé à `chatterbox`/`cosyvoice3`) ;
 *   - la construction du PATCH STRUCTURÉ envoyé à `PUT /api/tts/engine-config`
 *     (jamais de `server.json` complet) ;
 *   - les messages d'erreur lisibles (champ par champ) ;
 *   - l'état « redémarrage nécessaire » (badge d'application honnête).
 */

/** Jetons canoniques de `task` (`clon`, jamais `clone`). */
export const ENGINE_TASK_TOKENS = [
  "vad",
  "asr",
  "diar",
  "sep",
  "gen",
  "tts",
  "clon",
  "vc",
  "s2s",
  "align",
  "vdes",
  "spk",
  "svc",
  "midi",
];

/** Modes d'exécution acceptés. */
export const ENGINE_MODES = ["offline", "streaming"];

/**
 * Familles du catalogue GGUF amont (liste fermée, MIROIR de
 * `src/tts/engine-config.ts`). ⚠️ Noms reconnus par le MOTEUR, distincts des
 * ids de `tts.engine` : `qwen3_tts` et `kokoro_tts` (underscore).
 */
export const ENGINE_FAMILIES = [
  "chatterbox",
  "qwen3_tts",
  "cosyvoice3",
  "kokoro_tts",
  "sanotts",
];

/** Ids connus de Yuki (`tts.engine`). */
export const ENGINE_IDS = [
  "chatterbox",
  "qwen3-tts",
  "cosyvoice3",
  "kokoro",
  "sanotts",
];

/** Familles dont le mode est IMPÉRATIVEMENT `offline`. */
export const ENGINE_FORCE_OFFLINE_FAMILIES = ["chatterbox", "cosyvoice3"];

/**
 * Globales ÉDITABLES (miroir de `ENGINE_GLOBAL_SCHEMA` côté gateway). Les
 * autres clés de premier niveau sont préservées côté serveur, jamais exposées.
 */
export const ENGINE_GLOBAL_FIELDS = [
  { path: "host", kind: "text", label: "Hôte d'écoute" },
  { path: "port", kind: "number", label: "Port" },
  {
    path: "backend",
    kind: "select",
    label: "Backend",
    options: ["cpu", "cuda", "vulkan", "metal", "hip"],
  },
  { path: "device", kind: "number", label: "Index de carte" },
  { path: "threads", kind: "number", label: "Threads" },
  { path: "lazy_load", kind: "checkbox", label: "Chargement paresseux (lazy_load)" },
  { path: "ui_enabled", kind: "checkbox", label: "WebUI du moteur (ui_enabled)" },
  { path: "voice_dir", kind: "text", label: "Dossier des voix (voice_dir)" },
  { path: "max_loaded_models", kind: "number", label: "Modèles résidents maximum" },
  { path: "idle_unload_ms", kind: "number", label: "Déchargement après inactivité (ms)" },
  { path: "min_free_memory_mb", kind: "number", label: "Mémoire libre minimale (Mo)" },
];

/** Identifiant de modèle sûr (jamais un chemin). */
const ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

function str(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Valide un brouillon de modèle. Renvoie `{ ok, errors }` où `errors` associe
 * chaque champ fautif à un message FRANÇAIS. Empêche précisément les erreurs
 * connues : `clone` (au lieu de `clon`), `mode` invalide, `offline` imposé.
 */
export function validateModelDraft(model) {
  const errors = {};
  const m = isRecord(model) ? model : {};
  const id = str(m.id);
  if (id.length === 0) {
    errors.id = "Identifiant requis.";
  } else if (!ID_PATTERN.test(id)) {
    errors.id = "Identifiant invalide (lettres, chiffres, « . », « _ », « - » ; 64 max).";
  }
  const family = str(m.family);
  if (!ENGINE_FAMILIES.includes(family)) {
    errors.family = `Famille autorisée : ${ENGINE_FAMILIES.join(" | ")}.`;
  }
  const task = str(m.task);
  if (!ENGINE_TASK_TOKENS.includes(task)) {
    errors.task =
      task === "clone"
        ? "Jeton « clone » refusé : le moteur n'accepte que « clon »."
        : `Tâche autorisée : ${ENGINE_TASK_TOKENS.join(" | ")}.`;
  }
  const mode = str(m.mode);
  if (!ENGINE_MODES.includes(mode)) {
    errors.mode = `Mode autorisé : ${ENGINE_MODES.join(" | ")}.`;
  } else if (ENGINE_FORCE_OFFLINE_FAMILIES.includes(family) && mode !== "offline") {
    errors.mode = `La famille « ${family} » n'accepte que le mode « offline ».`;
  }
  const path = str(m.path);
  if (path.length === 0) {
    errors.path = "Chemin requis (choisissez un fichier présent sur le disque).";
  } else if (!path.endsWith(".gguf")) {
    errors.path = "Le fichier de modèle doit être un « .gguf ».";
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

/** Normalise la valeur d'une globale pour le patch (null = retirer la clé). */
function normalizeGlobal(field, value) {
  if (field.kind === "checkbox") return Boolean(value);
  if (field.kind === "number") {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "number") return value;
    const raw = String(value).trim();
    if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
    return raw; // le serveur renverra une erreur précise
  }
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.trim().length === 0 ? null : text;
}

function sameValue(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Construit le PATCH STRUCTURÉ `{ models?, globals? }`.
 *
 * - `models` : liste COMPLÈTE désirée (remplacement de `models[]`), normalisée
 *   en chaînes ; fournie seulement si `input.models` est un tableau.
 * - `globals` : uniquement les globales MODIFIÉES par rapport à
 *   `originalGlobals` (une valeur vidée devient `null` = retirer la clé).
 *
 * Le navigateur n'envoie jamais le JSON complet : le serveur relit le fichier,
 * préserve les clés inconnues et fusionne.
 */
export function buildEnginePatch(input = {}) {
  const patch = {};
  if (Array.isArray(input.models)) {
    patch.models = input.models.map((model) => {
      const m = isRecord(model) ? model : {};
      return {
        id: str(m.id),
        family: str(m.family),
        task: str(m.task),
        mode: str(m.mode),
        path: str(m.path),
      };
    });
  }
  const current = isRecord(input.globals) ? input.globals : {};
  const original = isRecord(input.originalGlobals) ? input.originalGlobals : {};
  const globals = {};
  for (const field of ENGINE_GLOBAL_FIELDS) {
    if (!(field.path in current)) continue;
    const normalized = normalizeGlobal(field, current[field.path]);
    const before = field.path in original ? original[field.path] : undefined;
    if (sameValue(normalized, before)) continue;
    globals[field.path] = normalized;
  }
  if (Object.keys(globals).length > 0) patch.globals = globals;
  return patch;
}

/** Y a-t-il quelque chose à enregistrer ? */
export function hasEngineChanges(input = {}) {
  const patch = buildEnginePatch(input);
  return Object.keys(patch).length > 0;
}

/**
 * État d'application honnête pour le moteur configuré (`engine` = `tts.engine`).
 * Le gateway ne sait que ce qui est DÉCLARÉ dans `server.json` — on ne prétend
 * jamais que le moteur l'a déjà chargé.
 */
export function applicationState(declaredIds, engine) {
  const ids = Array.isArray(declaredIds) ? declaredIds : [];
  const target = typeof engine === "string" ? engine : "";
  if (target.length === 0) {
    return {
      declared: false,
      restartNeeded: true,
      label: "Moteur inconnu",
      message: "Aucun moteur configuré (tts.engine est vide).",
    };
  }
  if (ids.includes(target)) {
    return {
      declared: true,
      restartNeeded: false,
      label: "Déclaré — activable sans redémarrage",
      message:
        `Le moteur « ${target} » est déjà déclaré dans server.json : le sélectionner ` +
        "dans tts.engine n'exige pas de redémarrer le conteneur `tts`.",
    };
  }
  return {
    declared: false,
    restartNeeded: true,
    label: "Non déclaré — redémarrage requis",
    message:
      `Le moteur « ${target} » n'est PAS déclaré dans server.json. Ajoutez-le ici, ` +
      "enregistrez, puis redémarrez le conteneur `tts` pour qu'il le charge.",
  };
}

/**
 * Procédure EXACTE pour appliquer un changement de `server.json` : le moteur ne
 * relit le fichier qu'à son démarrage. Le gateway n'a aucun accès à Docker.
 */
export function restartProcedure(containerName = "tts") {
  const name = containerName || "tts";
  return (
    `Le moteur relit server.json uniquement à son démarrage : ouvrez votre UI Docker, ` +
    `sélectionnez le conteneur « ${name} » puis cliquez sur « Redémarrer ». ` +
    `(Équivalent en ligne de commande : docker compose restart tts.) ` +
    "Le conteneur `gateway` n'a PAS besoin d'être redémarré."
  );
}

/**
 * Mappe une erreur de `PUT/POST /api/tts/engine-config` vers un message lisible
 * + le détail champ par champ. Accepte l'objet déjà extrait (`error.data`) ou
 * une erreur HolafFetch.
 */
export function describeEngineConfigError(error) {
  const raw = error && typeof error === "object" ? error : {};
  const data = isRecord(raw.data) ? raw.data : raw;
  const fields = Array.isArray(data.fields) ? data.fields : [];
  const code = typeof data.code === "string" ? data.code : typeof data.error === "string" ? data.error : null;
  const serverMessage = typeof data.message === "string" ? data.message : null;
  const status = Number(data.status ?? raw.status) || 0;

  const withFields = (message) => ({ message, fields, retry: true });

  switch (code) {
    case "config_dir_not_mounted":
      return withFields(
        serverMessage ||
          "Le dossier de configuration du moteur n'est pas monté dans le gateway.",
      );
    case "config_dir_unwritable":
      return withFields(
        serverMessage ||
          "Le dossier de configuration n'est pas inscriptible par le gateway (voir le détail " +
            "et la cause exacte renvoyés par le serveur).",
      );
    case "invalid_engine_config":
      return withFields(
        serverMessage || "Configuration refusée : corrigez les champs signalés ci-dessous.",
      );
    case "config_invalid":
      return withFields(
        serverMessage ||
          "Le server.json existant est invalide : corrigez-le sur l'hôte avant d'utiliser l'éditeur.",
      );
    case "no_backup":
      return withFields("Aucune sauvegarde server.json.bak : il n'y a rien à restaurer.");
    case "unknown_patch_field":
      return withFields(serverMessage || "Le patch contient un champ inattendu.");
    default:
      break;
  }
  if (status === 403) {
    return withFields(serverMessage || "Requête refusée (en-tête ou origine).");
  }
  if (status === 503) {
    return withFields(serverMessage || "Configuration du moteur indisponible.");
  }
  if (status === 0) {
    return withFields(serverMessage || "Le gateway est injoignable.");
  }
  return withFields(serverMessage || "L'opération a échoué.");
}

/**
 * Vue honnête de `GET /api/tts/engine-config`. `kind` distingue les cas :
 * `ready`, `no-file`, `invalid`, `not-mounted`, `read-only`, `unknown`.
 */
export function describeEngineConfig(report) {
  const base = {
    kind: "unknown",
    mounted: false,
    writable: false,
    fileExists: false,
    valid: false,
    backupExists: false,
    parseError: null,
    models: [],
    globals: {},
    diskModels: [],
    diskTruncated: false,
    unknownTopLevelKeys: [],
    diagnostics: [],
    warnings: [],
    configDir: null,
    engineConfigPath: null,
    message: "État de la configuration du moteur indisponible.",
  };
  if (!isRecord(report)) return base;

  const view = {
    ...base,
    mounted: Boolean(report.mounted),
    writable: Boolean(report.writable),
    fileExists: Boolean(report.fileExists),
    valid: Boolean(report.valid),
    backupExists: Boolean(report.backupExists),
    parseError: typeof report.parseError === "string" ? report.parseError : null,
    models: Array.isArray(report.models) ? report.models : [],
    globals: isRecord(report.globals) ? report.globals : {},
    diskModels: Array.isArray(report.diskModels) ? report.diskModels : [],
    diskTruncated: Boolean(report.diskTruncated),
    unknownTopLevelKeys: Array.isArray(report.unknownTopLevelKeys)
      ? report.unknownTopLevelKeys
      : [],
    diagnostics: Array.isArray(report.diagnostics) ? report.diagnostics : [],
    warnings: Array.isArray(report.warnings) ? report.warnings : [],
    configDir: typeof report.configDir === "string" ? report.configDir : null,
    engineConfigPath:
      typeof report.engineConfigPath === "string" ? report.engineConfigPath : null,
    writeError: typeof report.writeError === "string" ? report.writeError : null,
    writeCode: typeof report.writeCode === "string" ? report.writeCode : null,
    writeHint: typeof report.writeHint === "string" ? report.writeHint : null,
    note: typeof report.note === "string" ? report.note : null,
  };

  if (!view.mounted) {
    return {
      ...view,
      kind: "not-mounted",
      message:
        `Le dossier de configuration du moteur n'est pas monté dans le gateway` +
        (view.configDir ? ` (attendu : ${view.configDir})` : "") +
        ". Appliquez les montages M1/M2/M3 du Lot 9 (voir le README de déploiement) " +
        "puis rechargez cette page. L'édition depuis l'interface est désactivée tant que " +
        "ce montage n'est pas en place.",
    };
  }
  if (!view.writable) {
    return {
      ...view,
      kind: "read-only",
      // Le conseil vient du SERVEUR (`writeHint`, calculé à partir du code
      // système) : l'UI n'invente JAMAIS de cause. Sans lui, message honnête.
      message:
        "Le dossier de configuration est monté mais n'est PAS inscriptible par le gateway" +
        (view.writeCode ? ` (code : ${view.writeCode})` : "") +
        ". " +
        (view.writeHint ||
          "La cause exacte n'est pas fournie par le gateway : vérifiez le montage et " +
            "les permissions du service « gateway » du compose.") +
        (view.writeError ? ` Détail brut : ${view.writeError}.` : ""),
    };
  }
  if (!view.fileExists) {
    return {
      ...view,
      kind: "no-file",
      message:
        "Le dossier de configuration est monté et inscriptible, mais server.json n'existe " +
        "pas encore. Ajoutez au moins un modèle puis enregistrez : le fichier sera créé.",
    };
  }
  if (!view.valid) {
    return {
      ...view,
      kind: "invalid",
      message:
        "Le server.json présent est illisible" +
        (view.parseError ? ` : ${view.parseError}` : "") +
        ". Corrigez-le sur l'hôte avant d'utiliser l'éditeur (il ne sera jamais écrasé en silence).",
    };
  }
  return { ...view, kind: "ready", message: null };
}

/** Vue de la sonde de capacités : la fonction n'est montrée que si CONFIRMÉE. */
export function describeCapabilities(report) {
  if (!isRecord(report) || report.unloadModels !== true) {
    return { show: false, message: null };
  }
  return {
    show: true,
    message:
      "Déchargement à chaud (`POST /v1/tasks/unload_models`) disponible : le moteur " +
      "accepte de libérer la mémoire des modèles sans redémarrage.",
  };
}
