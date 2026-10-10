/**
 * Domaine de configuration — TABLE UNIQUE de descripteurs (Lot 11).
 *
 * Une seule source de vérité pour les bornes, énumérations, valeurs par défaut
 * et le mode d'application (`hot` = à chaud, `restart` = au prochain
 * redémarrage). Cette table est réutilisée par :
 *  - `env.ts` (surcharges d'environnement des champs du store) ;
 *  - `runtime.ts` (chargement du store et application des patchs) ;
 *  - l'API `PUT /api/config` (validation autoritaire).
 *
 * AUCUN import du SDK Pi ni de `typebox` : données pures + ~40 lignes de
 * validation. Aucune dépendance à `node:fs`.
 *
 * Précédence : `défauts (code) < store (page web) < environnement`.
 */

export type ApplyKind = "hot" | "restart";
export type Origin = "default" | "store" | "env";
export type FieldType = "string" | "int" | "enum";

/** Niveaux de raisonnement acceptés (alignés sur le SDK Pi). */
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Mode de la porte de compatibilité GPU. */
export type CompatMode = "strict" | "auto-degrade";

/** Politique en cas de clé LLM manquante (aligné sur `src/llm/availability`). */
export type LlmMissingKeyMode = "degrade" | "refuse";

export interface FieldDescriptor {
  readonly type: FieldType;
  /** Valeur par défaut (code). Les prompts sont affinés depuis les fichiers. */
  readonly default: string | number;
  /** Valeurs autorisées (type `enum` uniquement). `""` = valeur vide admise. */
  readonly enum?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly apply: ApplyKind;
  /**
   * Autorise la chaîne vide (`""`) comme valeur VALIDE (type `string`).
   * Sans ce drapeau, `""` est refusé (`empty_value`) et seul `null` restaure le
   * défaut. Utilisé par `tts.voice`, dont la valeur par défaut est précisément
   * la chaîne vide (« voix par défaut », spec Lot 7 §9.1).
   */
  readonly allowEmpty?: true;
  /** Champ secret : jamais sérialisé en clair, masqué dans l'API. */
  readonly secret?: true;
  /** Variable d'environnement qui surcharge ce champ (si définie et non vide). */
  readonly env?: string;
}

/** Profils GPU acceptés (chaîne vide = résolution automatique). */
export const GPU_PROFILES = ["", "confort", "compact", "repli", "texte-seul"] as const;

/**
 * Table unique. Les chemins sont en notation pointée (`domaine.champ`).
 * Un champ possédant `env` peut être verrouillé par l'environnement.
 */
export const CONFIG_SCHEMA: Readonly<Record<string, FieldDescriptor>> = {
  // --- LLM léger -----------------------------------------------------------
  "llm.light.api": {
    type: "enum",
    enum: ["openai-completions"],
    default: "openai-completions",
    apply: "restart",
    env: "YUKI_LLM_LIGHT_API",
  },
  "llm.light.baseUrl": {
    type: "string",
    default: "https://ollama.com/v1",
    apply: "restart",
    env: "YUKI_LLM_LIGHT_BASE_URL",
  },
  "llm.light.model": {
    type: "string",
    default: "gemma4:31b",
    apply: "restart",
    env: "YUKI_LLM_LIGHT_MODEL",
  },
  "llm.light.thinking": {
    type: "enum",
    enum: THINKING_LEVELS,
    default: "off",
    apply: "restart",
    env: "YUKI_LLM_LIGHT_THINKING",
  },
  "llm.light.apiKey": {
    type: "string",
    default: "",
    apply: "hot",
    secret: true,
    env: "YUKI_LLM_LIGHT_API_KEY",
  },

  // --- LLM lourd -----------------------------------------------------------
  "llm.heavy.api": {
    type: "enum",
    enum: ["openai-completions"],
    default: "openai-completions",
    apply: "restart",
    env: "YUKI_LLM_HEAVY_API",
  },
  "llm.heavy.baseUrl": {
    type: "string",
    default: "https://ollama.com/v1",
    apply: "restart",
    env: "YUKI_LLM_HEAVY_BASE_URL",
  },
  "llm.heavy.model": {
    type: "string",
    default: "deepseek-v4.1-flash",
    apply: "restart",
    env: "YUKI_LLM_HEAVY_MODEL",
  },
  "llm.heavy.thinking": {
    type: "enum",
    enum: THINKING_LEVELS,
    default: "high",
    apply: "restart",
    env: "YUKI_LLM_HEAVY_THINKING",
  },
  "llm.heavy.apiKey": {
    type: "string",
    default: "",
    apply: "hot",
    secret: true,
    env: "YUKI_LLM_HEAVY_API_KEY",
  },
  "llm.missingKeyMode": {
    type: "enum",
    enum: ["degrade", "refuse"],
    default: "degrade",
    apply: "restart",
    env: "YUKI_LLM_MISSING_KEY_MODE",
  },

  // --- Délégation ----------------------------------------------------------
  "delegation.defaultDeadlineMs": {
    type: "int",
    default: 1_500,
    min: 200,
    max: 60_000,
    apply: "hot",
  },
  "delegation.maxConcurrent": {
    type: "int",
    default: 3,
    min: 1,
    apply: "restart",
    env: "YUKI_HEAVY_MAX_CONCURRENT",
  },
  "delegation.maxQueue": {
    type: "int",
    default: 10,
    min: 0,
    apply: "restart",
    env: "YUKI_HEAVY_MAX_QUEUE",
  },
  "delegation.idleTimeoutMs": {
    type: "int",
    default: 120_000,
    min: 1,
    apply: "restart",
    env: "YUKI_HEAVY_IDLE_TIMEOUT_MS",
  },
  "delegation.totalTimeoutMs": {
    type: "int",
    default: 1_200_000,
    min: 1,
    apply: "restart",
    env: "YUKI_HEAVY_TOTAL_TIMEOUT_MS",
  },

  // --- GPU -----------------------------------------------------------------
  "gpu.compatMode": {
    type: "enum",
    enum: ["strict", "auto-degrade"],
    default: "strict",
    apply: "restart",
    env: "YUKI_COMPAT_MODE",
  },
  "gpu.profile": {
    type: "enum",
    enum: GPU_PROFILES,
    default: "",
    apply: "restart",
    env: "YUKI_PROFILE",
  },
  "gpu.minDriver": {
    type: "int",
    default: 580,
    min: 1,
    apply: "restart",
    env: "YUKI_MIN_DRIVER",
  },

  // --- Prompts système (défaut affiné depuis les fichiers livrés) ----------
  "prompts.light": { type: "string", default: "", apply: "restart" },
  "prompts.heavy": { type: "string", default: "", apply: "restart" },

  // --- TTS / voix (Lot 7) --------------------------------------------------
  // ⚠️ `FieldType` = `string | int | enum` : AUCUN booléen. L'activation est
  // donc un enum `off|on` (spec §9.1). Les grandeurs réelles (`exaggeration`,
  // `cfg`, défauts 0.5) sont des ENTIERS EN POUR-MILLE (0–1500).
  "tts.enabled": {
    type: "enum",
    enum: ["off", "on"],
    default: "off",
    apply: "restart",
    env: "YUKI_TTS_ENABLED",
  },
  "tts.engine": {
    type: "enum",
    enum: ["chatterbox", "qwen3-tts", "cosyvoice3", "kokoro", "sanotts"],
    default: "chatterbox",
    apply: "restart",
    env: "YUKI_TTS_ENGINE",
  },
  "tts.baseUrl": {
    type: "string",
    default: "http://tts:8081",
    apply: "restart",
    env: "YUKI_TTS_BASE_URL",
  },
  "tts.language": {
    type: "enum",
    enum: ["fr"],
    default: "fr",
    apply: "restart",
    env: "YUKI_TTS_LANGUAGE",
  },
  // Id de voix du registre (§10.1). Liste DYNAMIQUE ⇒ `string` (jamais un enum
  // statique). La chaîne vide = voix par défaut (preset « factory »).
  "tts.voice": {
    type: "string",
    default: "",
    allowEmpty: true,
    apply: "hot",
    env: "YUKI_TTS_VOICE",
  },
  "tts.emotion": {
    type: "enum",
    enum: ["neutre", "expressive", "dramatique", "personnalisee"],
    default: "neutre",
    apply: "hot",
    env: "YUKI_TTS_EMOTION",
  },
  "tts.speed": {
    type: "int",
    default: 100,
    min: 50,
    max: 200,
    apply: "hot",
    env: "YUKI_TTS_SPEED",
  },
  "tts.exaggeration": {
    type: "int",
    default: 500,
    min: 0,
    max: 1500,
    apply: "hot",
    env: "YUKI_TTS_EXAGGERATION",
  },
  "tts.cfg": {
    type: "int",
    default: 500,
    min: 0,
    max: 1500,
    apply: "hot",
    env: "YUKI_TTS_CFG",
  },
  "tts.prefetchDepth": {
    type: "int",
    default: 2,
    min: 0,
    max: 2,
    apply: "hot",
    env: "YUKI_TTS_PREFETCH",
  },
  "tts.minSentenceChars": {
    type: "int",
    default: 24,
    min: 8,
    max: 500,
    apply: "hot",
    env: "YUKI_TTS_MIN_SENTENCE",
  },
  "tts.maxSentenceChars": {
    type: "int",
    default: 240,
    min: 40,
    max: 2000,
    apply: "hot",
    env: "YUKI_TTS_MAX_SENTENCE",
  },
  "tts.timeoutMs": {
    type: "int",
    default: 15_000,
    min: 1_000,
    max: 120_000,
    apply: "hot",
    env: "YUKI_TTS_TIMEOUT_MS",
  },
  "tts.volume": {
    type: "int",
    default: 100,
    min: 0,
    max: 100,
    apply: "hot",
    env: "YUKI_TTS_VOLUME",
  },

  // --- Mémoire durable (Lot 12) ---------------------------------------------
  // ⚠️ `FieldType` = `string | int | enum` : l'activation est un enum `off|on`.
  // Les bornes du rappel sont des entiers ; le budget en caractères et le
  // timeout bornent le coût SUR LE CHEMIN CRITIQUE (TTFT).
  "memory.enabled": {
    type: "enum",
    enum: ["off", "on"],
    default: "on",
    apply: "hot",
    env: "YUKI_MEMORY_ENABLED",
  },
  "memory.recall.topK": {
    type: "int",
    default: 5,
    min: 0,
    max: 20,
    apply: "hot",
    env: "YUKI_MEMORY_TOP_K",
  },
  "memory.recall.budgetChars": {
    type: "int",
    default: 8_000,
    min: 0,
    max: 40_000,
    apply: "hot",
    env: "YUKI_MEMORY_BUDGET_CHARS",
  },
  "memory.recall.timeoutMs": {
    type: "int",
    default: 400,
    min: 20,
    max: 5_000,
    apply: "hot",
    env: "YUKI_MEMORY_TIMEOUT_MS",
  },
  "memory.extract.maxItems": {
    type: "int",
    default: 3,
    min: 0,
    max: 10,
    apply: "hot",
    env: "YUKI_MEMORY_MAX_ITEMS",
  },
  "memory.extract.timeoutMs": {
    type: "int",
    default: 30_000,
    min: 1_000,
    max: 300_000,
    apply: "hot",
    env: "YUKI_MEMORY_EXTRACT_TIMEOUT_MS",
  },

  // --- Transport temps réel ------------------------------------------------
  "transport.replayBuffer": {
    type: "int",
    default: 1_000,
    min: 1,
    apply: "restart",
    env: "YUKI_WS_REPLAY_BUFFER",
  },
  "transport.replayBytes": {
    type: "int",
    default: 5_000_000,
    min: 1,
    apply: "restart",
    env: "YUKI_WS_REPLAY_BYTES",
  },

  // --- Agents d'exécution (Lot 4) -----------------------------------------
  // ⚠️ `FieldType` = `string | int | enum` : AUCUN booléen, aucun tableau. Le
  // niveau de garde-fou est donc un ENUM (D118) et le privilège un ENUM (D120).
  // Le canal « machines » est LAN uniquement (D116) ; le port et l'hôte sont
  // des valeurs de DÉPLOIEMENT, sans fait d'infra fiable (docs/lot4.md §13).
  "agents.bindHost": {
    type: "string",
    default: "0.0.0.0",
    apply: "restart",
    env: "YUKI_AGENTS_BIND_HOST",
  },
  // Adresse(s) ou nom(s) que les AGENTS utilisent pour joindre Yuki — inscrits
  // dans le SAN du certificat serveur (en plus de la boucle locale). `FieldType`
  // ne connaît pas les tableaux : plusieurs valeurs se déclarent donc séparées
  // par des VIRGULES dans cette chaîne unique (compromis assumé, voir
  // `src/agents/server-names.ts`). Une IP littérale va dans `IPAddress`, un nom
  // dans `DNSName`. Vide = le certificat ne couvre que la boucle locale (et
  // `agents.bindHost` s'il est concret). `apply: hot` : la modification
  // régénère le certificat serveur et recharge le contexte TLS du port machines
  // à chaud (`server.setSecureContext`), sans redémarrer le gateway.
  "agents.serverName": {
    type: "string",
    default: "",
    allowEmpty: true,
    apply: "hot",
    env: "YUKI_AGENTS_SERVER_NAME",
  },
  "agents.port": {
    type: "int",
    default: 9443,
    min: 1,
    max: 65535,
    apply: "restart",
    env: "YUKI_AGENTS_PORT",
  },
  // Niveau de confirmation PAR AGENT (D118). Défaut = validation des
  // commandes destructrices (niveau 3), le plus raisonnable en LAN.
  "agents.defaultLevel": {
    type: "enum",
    enum: ["disabled", "always", "destructive", "never"],
    default: "destructive",
    apply: "hot",
    env: "YUKI_AGENTS_DEFAULT_LEVEL",
  },

  // --- Journal d'audit des exécutions (Lot 4, D127) ------------------------
  // Commande + machine + horodatage + code de sortie ; JAMAIS la sortie
  // complète. Rétention en jours, rotation par taille (Mo).
  "audit.retentionDays": {
    type: "int",
    default: 30,
    min: 1,
    max: 3_650,
    apply: "hot",
    env: "YUKI_AUDIT_RETENTION_DAYS",
  },
  "audit.maxSizeMb": {
    type: "int",
    default: 16,
    min: 1,
    max: 4_096,
    apply: "hot",
    env: "YUKI_AUDIT_MAX_SIZE_MB",
  },

  // --- Libraire (Libry : recherche documentaire + web) ---------------------
  // ⚠️ `FieldType` = `string | int | enum`. L'URL de base est une chaîne : vide =
  // libraire NON configuré (les outils ne sont alors pas exposés au modèle).
  // ⚠️ `librarian.apiKey` est LE champ de référence : Libry n'a qu'UNE couche
  // d'authentification (clé acceptée en `Authorization: Bearer` OU en
  // `X-API-Key`). `librarian.agentToken` est FACULTATIF : renseigné, il est
  // toujours envoyé (compatibilité) ; vide, il n'est plus exigé ni envoyé.
  // Les deux restent masqués par l'API et jamais journalisés.
  // `apply: hot` : le client relit la configuration à chaque appel. ⚠️ L'exposition
  // des OUTILS est fixée à la création du host : renseigner l'URL pour la première
  // fois nécessite un redémarrage du gateway.
  "librarian.baseUrl": {
    type: "string",
    default: "",
    allowEmpty: true,
    apply: "hot",
    env: "YUKI_LIBRARIAN_BASE_URL",
  },
  "librarian.agentToken": {
    type: "string",
    default: "",
    // ⚠️ FACULTATIF : `allowEmpty` autorise la chaîne vide (sinon « clé non
    // vide » exigée). Utile pour les configurations mono-clé (Libry).
    allowEmpty: true,
    apply: "hot",
    secret: true,
    env: "YUKI_LIBRARIAN_AGENT_TOKEN",
  },
  "librarian.apiKey": {
    type: "string",
    default: "",
    apply: "hot",
    secret: true,
    env: "YUKI_LIBRARIAN_API_KEY",
  },
  // Activation de l'outil de CAPTURE de page web via Libry. ⚠️ Enum `off|on`
  // (pas de booléen : `FieldType` = `string | int | enum`). `hot` : l'outil
  // relit ce réglage à chaque appel (le refus est explicite si désactivé).
  "librarian.screenshot": {
    type: "enum",
    enum: ["off", "on"],
    default: "on",
    apply: "hot",
    env: "YUKI_LIBRARIAN_SCREENSHOT",
  },
  "librarian.archiveTimeoutMs": {
    type: "int",
    default: 30_000,
    min: 1_000,
    max: 300_000,
    apply: "hot",
    env: "YUKI_LIBRARIAN_ARCHIVE_TIMEOUT_MS",
  },
};

/** Ordre stable des chemins (déterminisme des réponses / journaux). */
export const CONFIG_PATHS: readonly string[] = Object.keys(CONFIG_SCHEMA);

export function descriptorOf(path: string): FieldDescriptor | undefined {
  return CONFIG_SCHEMA[path];
}

export function isSecretPath(path: string): boolean {
  return CONFIG_SCHEMA[path]?.secret === true;
}

export function envNameOf(path: string): string | undefined {
  return CONFIG_SCHEMA[path]?.env;
}

export interface FieldError {
  path: string;
  code: string;
  message: string;
}

export type FieldValidation =
  | { ok: true; value: string | number }
  | { ok: false; code: string; message: string };

/** Valide et normalise une valeur brute (env, store ou patch API). */
export function validateDescriptor(
  descriptor: FieldDescriptor,
  raw: unknown,
): FieldValidation {
  if (descriptor.type === "int") {
    let value: number;
    if (typeof raw === "number") {
      value = raw;
    } else if (typeof raw === "string" && /^-?\d+$/.test(raw.trim())) {
      value = Number.parseInt(raw.trim(), 10);
    } else {
      return { ok: false, code: "invalid_int", message: "Valeur entière attendue." };
    }
    if (!Number.isInteger(value)) {
      return { ok: false, code: "invalid_int", message: "Valeur entière attendue." };
    }
    if (descriptor.min !== undefined && value < descriptor.min) {
      return {
        ok: false,
        code: "below_min",
        message: `Valeur trop petite (minimum ${descriptor.min}).`,
      };
    }
    if (descriptor.max !== undefined && value > descriptor.max) {
      return {
        ok: false,
        code: "above_max",
        message: `Valeur trop grande (maximum ${descriptor.max}).`,
      };
    }
    return { ok: true, value };
  }

  if (typeof raw !== "string") {
    return { ok: false, code: "invalid_string", message: "Texte attendu." };
  }
  const trimmed = raw.trim();

  if (descriptor.type === "enum") {
    if (!descriptor.enum || !descriptor.enum.includes(trimmed)) {
      const allowed = (descriptor.enum ?? []).map((v) => (v === "" ? "∅" : v));
      return {
        ok: false,
        code: "invalid_enum",
        message: `Valeur autorisée : ${allowed.join(" | ")}.`,
      };
    }
    return { ok: true, value: trimmed };
  }

  // type "string"
  if (trimmed === "") {
    if (descriptor.allowEmpty) {
      return { ok: true, value: "" };
    }
    if (descriptor.secret) {
      return {
        ok: false,
        code: "empty_api_key",
        message:
          "La clé ne peut pas être vide. Utilisez « Effacer » (null) pour la supprimer.",
      };
    }
    return {
      ok: false,
      code: "empty_value",
      message:
        "Ce champ ne peut pas être vide. Utilisez null pour rétablir la valeur par défaut.",
    };
  }
  return { ok: true, value: trimmed };
}

/** Valide une valeur brute par chemin ; `unknown_field` si le chemin est inconnu. */
export function validateField(path: string, raw: unknown): FieldValidation {
  const descriptor = CONFIG_SCHEMA[path];
  if (!descriptor) {
    return { ok: false, code: "unknown_field", message: `Champ inconnu : ${path}.` };
  }
  return validateDescriptor(descriptor, raw);
}
