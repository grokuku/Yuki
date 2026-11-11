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

/** Champs COMMUNS aux trois portées (aucun ne dépend de la portée). */
interface DescripteurCommun {
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
  /**
   * Message de refus SPÉCIFIQUE quand `""` est envoyé (type `string` sans
   * `allowEmpty`). Sert à dire l'ACTION à faire plutôt qu'un refus sec : un
   * prompt système vide prive le modèle de toute consigne, et l'utilisateur qui
   * a cliqué « Réinitialiser au défaut » doit comprendre que le défaut existe.
   */
  readonly emptyMessage?: string;
  /** Champ secret : jamais sérialisé en clair, masqué dans l'API. */
  readonly secret?: true;
  /**
   * Le texte doit être un fuseau IANA accepté par `Intl` (`Europe/Paris`,
   * `UTC`…). Refusé sinon (`invalid_timezone`) : un fuseau inventé ferait
   * silencieusement retomber tous les horodatages sur UTC, donc afficher une
   * heure FAUSSE sans le dire.
   */
  readonly ianaTimeZone?: true;
}

/** Portée d'un réglage (lot 35b) : OBLIGATOIRE sur chaque clé. */
export type FieldScope = "instance" | "bot" | "mixte";

/** Mode de fusion d'une clé `mixte`. */
export type MixteMerge = "surcharge" | "et";

/**
 * Clé d'INSTANCE : réglage de l'installation (LLM, GPU, délégation, libraire,
 * fichiers, agents, audit…) ⇒ store COMMUN `config.json`. Seule portée qui
 * accepte une variable d'environnement.
 */
export interface InstanceFieldDescriptor extends DescripteurCommun {
  readonly scope: "instance";
  /** Variable d'environnement qui surcharge ce champ (si définie et non vide). */
  readonly env?: string;
  readonly mixteMerge?: never;
}

/**
 * Clé de BOT : réglage d'UN bot (mode de conversation, voix, mémoire du bot,
 * capacités distantes…) ⇒ **overlay du bot actif**
 * (`<state>/bots/<id>/config.overlay.json`). Le store commun ne sert que de
 * valeur de repli (héritage d'avant le lot 35b).
 *
 * ⚠️ `env` est INTERDIT ici, et c'est le COMPILATEUR qui le dit : une variable
 * d'environnement est une valeur d'INSTALLATION, elle ne peut pas désigner
 * « le bot actif » (un déploiement à deux bots n'aurait aucun moyen de
 * distinguer les deux valeurs).
 */
export interface BotFieldDescriptor extends DescripteurCommun {
  readonly scope: "bot";
  readonly env?: never;
  readonly mixteMerge?: never;
}

/**
 * Clé MIXTE : la valeur dépend des DEUX côtés, et la fusion est déclarée
 * (`mixteMerge`, obligatoire) — jamais devinée :
 *  - `surcharge` : l'overlay du bot REMPLACE la valeur commune ;
 *  - `et` : conjonction (restriction) ; réservé aux enums `off|on`.
 * ⚠️ `env` INTERDIT (même raison que pour une clé de bot).
 */
export interface MixteFieldDescriptor extends DescripteurCommun {
  readonly scope: "mixte";
  readonly mixteMerge: MixteMerge;
  readonly env?: never;
}

/** Descripteur d'un champ, discriminé par sa PORTÉE. */
export type FieldDescriptor =
  | InstanceFieldDescriptor
  | BotFieldDescriptor
  | MixteFieldDescriptor;

/** Profils GPU acceptés (chaîne vide = résolution automatique). */
export const GPU_PROFILES = ["", "confort", "compact", "repli", "texte-seul"] as const;

/**
 * Table unique. Les chemins sont en notation pointée (`domaine.champ`).
 * Un champ possédant `env` peut être verrouillé par l'environnement.
 */
export const CONFIG_SCHEMA: Readonly<Record<string, FieldDescriptor>> = {
  // --- LLM léger -----------------------------------------------------------
  // ⚠️ `baseUrl` + `api` = changement de FOURNISSEUR : `apply: hot`, avec la
  // MÊME mécanique que le modèle (pas un second chemin). Ces deux champs vivent
  // dans `models.json` (généré par `buildModelsConfigFrom`) : un changement
  // réécrit le fichier puis `refreshSharedModelRuntime` reconstruit les
  // providers EN PLACE (même instance partagée) — voir `PiHost.applyLlmConfig`
  // + l'abonnement `config.subscribe` de `src/index.ts`. La bascule a lieu
  // ENTRE deux runs : un run EN VOL garde son fournisseur d'origine.
  "llm.light.api": {
    scope: "instance",
    type: "enum",
    enum: ["openai-completions"],
    default: "openai-completions",
    apply: "hot",
    env: "YUKI_LLM_LIGHT_API",
  },
  "llm.light.baseUrl": {
    scope: "instance",
    type: "string",
    default: "https://ollama.com/v1",
    apply: "hot",
    env: "YUKI_LLM_LIGHT_BASE_URL",
  },
  // Modèle / réflexion du léger : `apply: hot`. Un changement de modèle est
  // re-évalué et appliqué au PROCHAIN run de chaque conversation, sans
  // redémarrage (voir `PiHost.applyLlmConfig` + l'abonnement `config.subscribe`
  // dans `src/index.ts`). Les runs EN COURS gardent leur modèle d'origine
  // (la bascule n'a lieu qu'entre deux runs).
  "llm.light.model": {
    scope: "instance",
    type: "string",
    default: "gemma4:31b",
    apply: "hot",
    env: "YUKI_LLM_LIGHT_MODEL",
  },
  "llm.light.thinking": {
    scope: "instance",
    type: "enum",
    enum: THINKING_LEVELS,
    default: "off",
    apply: "hot",
    env: "YUKI_LLM_LIGHT_THINKING",
  },
  // ⚠️ CAPACITÉ VISION — déclaration, JAMAIS une mesure.
  // Aucune API de fournisseur ne publie « ce modèle voit les images » : c'est
  // donc à l'utilisateur de le DIRE, et le réglage produit `input` dans
  // `models.json` (`resolveModelsFrom`). `non` ⇒ `input: ["text"]` : le SDK
  // remplace alors toute pièce jointe image par « (tool image omitted: model
  // does not support images) » — l'image est JETÉE en silence. `apply: hot` :
  // un changement réécrit `models.json` et rafraîchit le runtime partagé, sans
  // redémarrage (même mécanique que `llm.<role>.model`).
  "llm.light.vision": {
    scope: "instance",
    type: "enum",
    enum: ["oui", "non"],
    default: "oui",
    apply: "hot",
  },
  "llm.light.apiKey": {
    scope: "instance",
    type: "string",
    default: "",
    apply: "hot",
    secret: true,
    env: "YUKI_LLM_LIGHT_API_KEY",
  },

  // --- LLM lourd -----------------------------------------------------------
  // ⚠️ `baseUrl` + `api` du lourd : `apply: hot` (même mécanique que le modèle).
  // Les jobs de fond sont des sessions ÉPHÉMÈRES qui re-résolvent le provider
  // partagé (rafraîchi en place) au démarrage de chaque job ; un job EN VOL
  // garde son fournisseur d'origine.
  "llm.heavy.api": {
    scope: "instance",
    type: "enum",
    enum: ["openai-completions"],
    default: "openai-completions",
    apply: "hot",
    env: "YUKI_LLM_HEAVY_API",
  },
  "llm.heavy.baseUrl": {
    scope: "instance",
    type: "string",
    default: "https://ollama.com/v1",
    apply: "hot",
    env: "YUKI_LLM_HEAVY_BASE_URL",
  },
  // Modèle / réflexion du lourd : `apply: hot`. Les jobs de fond sont des
  // sessions ÉPHÉMÈRES créées à chaque tâche : elles relisent la référence
  // courante au démarrage du job (voir `SdkHeavyWorkerConfig.modelReference`),
  // donc un changement s'applique aux NOUVEAUX jobs sans redémarrage.
  "llm.heavy.model": {
    scope: "instance",
    type: "string",
    default: "deepseek-v4.1-flash",
    apply: "hot",
    env: "YUKI_LLM_HEAVY_MODEL",
  },
  "llm.heavy.thinking": {
    scope: "instance",
    type: "enum",
    enum: THINKING_LEVELS,
    default: "high",
    apply: "hot",
    env: "YUKI_LLM_HEAVY_THINKING",
  },
  // ⚠️ MÊME DÉCLARATION que le léger, pour le worker lourd : c'est elle qui
  // autorise `recuperer_fichier` à joindre l'image d'un fichier récupéré. Faux
  // ⇒ l'outil REFUSE d'envoyer l'image et le DIT (aucun `(tool image omitted…)`
  // silencieux). Défaut « oui » : l'utilisateur a déclaré son modèle lourd
  // multimodal ; si le fournisseur le refuse, la réponse est une ERREUR de
  // modèle visible, pas un silence.
  "llm.heavy.vision": {
    scope: "instance",
    type: "enum",
    enum: ["oui", "non"],
    default: "oui",
    apply: "hot",
  },
  "llm.heavy.apiKey": {
    scope: "instance",
    type: "string",
    default: "",
    apply: "hot",
    secret: true,
    env: "YUKI_LLM_HEAVY_API_KEY",
  },
  "llm.missingKeyMode": {
    scope: "instance",
    type: "enum",
    enum: ["degrade", "refuse"],
    default: "degrade",
    apply: "restart",
    env: "YUKI_LLM_MISSING_KEY_MODE",
  },

  // --- Délégation ----------------------------------------------------------
  "delegation.defaultDeadlineMs": {
    scope: "instance",
    type: "int",
    default: 1_500,
    min: 200,
    max: 60_000,
    apply: "hot",
  },
  "delegation.maxConcurrent": {
    scope: "instance",
    type: "int",
    default: 3,
    min: 1,
    apply: "restart",
    env: "YUKI_HEAVY_MAX_CONCURRENT",
  },
  "delegation.maxQueue": {
    scope: "instance",
    type: "int",
    default: 10,
    min: 0,
    apply: "restart",
    env: "YUKI_HEAVY_MAX_QUEUE",
  },
  "delegation.idleTimeoutMs": {
    scope: "instance",
    type: "int",
    default: 120_000,
    min: 1,
    apply: "restart",
    env: "YUKI_HEAVY_IDLE_TIMEOUT_MS",
  },
  // Plafond de SÉCURITÉ d'un job lourd (génération + rédaction + publication).
  // ⚠️ Il doit RESTER AU-DESSUS du plafond de la génération d'image
  // (`images.timeoutMs`, 3 600 000 ms = 1 h) + la rédaction du rapport et sa
  // publication : 75 min laissent 15 min au-delà de la génération. Un job coupé
  // ici est coupé par une limite PLUS LARGE que celle de la génération, sans
  // explication possible (le rapport ne pourrait plus dire ce qui s'est passé).
  // ⚠️ Il doit AUSSI rester au-dessus de la borne du TOUR de canal
  // (`CHAT_REPLY_TIMEOUT_MS` + `images.timeoutMs` = 61 min 30 s) et du chien de
  // garde d'outil dérivé (plafond + 60 s).
  // ⚠️ La chaîne complète est vérifiée par `tests/config/bornes-generation.test.ts`.
  "delegation.totalTimeoutMs": {
    scope: "instance",
    type: "int",
    default: 4_500_000,
    min: 1,
    apply: "restart",
    env: "YUKI_HEAVY_TOTAL_TIMEOUT_MS",
  },

  // --- GPU -----------------------------------------------------------------
  "gpu.compatMode": {
    scope: "instance",
    type: "enum",
    enum: ["strict", "auto-degrade"],
    default: "strict",
    apply: "restart",
    env: "YUKI_COMPAT_MODE",
  },
  "gpu.profile": {
    scope: "instance",
    type: "enum",
    enum: GPU_PROFILES,
    default: "",
    apply: "restart",
    env: "YUKI_PROFILE",
  },
  "gpu.minDriver": {
    scope: "instance",
    type: "int",
    default: 580,
    min: 1,
    apply: "restart",
    env: "YUKI_MIN_DRIVER",
  },

  // --- Prompts système (défaut affiné depuis les fichiers livrés) ----------
  // ⚠️ Ces deux champs n'ont PAS `allowEmpty` : un prompt VIDE est refusé. Un
  // prompt vide = aucune consigne pour le modèle, donc un comportement qui se
  // dégrade silencieusement alors que l'utilisateur croit avoir « remis le
  // défaut ». `null` (bouton « Réinitialiser au défaut ») efface la surcharge
  // enregistrée et le fichier livré redevient effectif (`src/config/runtime.ts`).
  "prompts.light": {
    scope: "mixte",
    mixteMerge: "surcharge",
    type: "string",
    default: "",
    apply: "restart",
    emptyMessage:
      "Le prompt système ne peut pas être vide. Cliquez sur « Réinitialiser au défaut » pour revenir au prompt livré (config/pi/system-prompt.md).",
  },
  "prompts.heavy": {
    scope: "mixte",
    mixteMerge: "surcharge",
    type: "string",
    default: "",
    apply: "restart",
    emptyMessage:
      "Le prompt système ne peut pas être vide. Cliquez sur « Réinitialiser au défaut » pour revenir au prompt livré (config/pi/system-prompt-heavy.md).",
  },

  // --- TTS / voix (Lot 7) --------------------------------------------------
  // ⚠️ `FieldType` = `string | int | enum` : AUCUN booléen. L'activation est
  // donc un enum `off|on` (spec §9.1). Les grandeurs réelles (`exaggeration`,
  // `cfg`, défauts 0.5) sont des ENTIERS EN POUR-MILLE (0–1500).
  "tts.enabled": {
    scope: "mixte",
    mixteMerge: "et",
    type: "enum",
    enum: ["off", "on"],
    default: "off",
    apply: "restart",
  },
  "tts.engine": {
    scope: "instance",
    type: "enum",
    enum: ["chatterbox", "qwen3-tts", "cosyvoice3", "kokoro", "sanotts"],
    default: "chatterbox",
    apply: "restart",
    env: "YUKI_TTS_ENGINE",
  },
  "tts.baseUrl": {
    scope: "instance",
    type: "string",
    default: "http://tts:8081",
    apply: "restart",
    env: "YUKI_TTS_BASE_URL",
  },
  "tts.language": {
    scope: "instance",
    type: "enum",
    enum: ["fr"],
    default: "fr",
    apply: "restart",
    env: "YUKI_TTS_LANGUAGE",
  },
  // Id de voix du registre (§10.1). Liste DYNAMIQUE ⇒ `string` (jamais un enum
  // statique). La chaîne vide = voix par défaut (preset « factory »).
  "tts.voice": {
    scope: "bot",
    type: "string",
    default: "",
    allowEmpty: true,
    apply: "hot",
  },
  "tts.emotion": {
    scope: "bot",
    type: "enum",
    enum: ["neutre", "expressive", "dramatique", "personnalisee"],
    default: "neutre",
    apply: "hot",
  },
  "tts.speed": {
    scope: "bot",
    type: "int",
    default: 100,
    min: 50,
    max: 200,
    apply: "hot",
  },
  "tts.exaggeration": {
    scope: "bot",
    type: "int",
    default: 500,
    min: 0,
    max: 1500,
    apply: "hot",
  },
  "tts.cfg": {
    scope: "bot",
    type: "int",
    default: 500,
    min: 0,
    max: 1500,
    apply: "hot",
  },
  "tts.prefetchDepth": {
    // ⚠️ Portée SANS DOMICILE ÉVIDENT : classée `instance` (voir
    // `docs/lot35b-multibot-overlay.md`, §« les 8 cas douteux »).
    scope: "instance",
    type: "int",
    default: 2,
    min: 0,
    max: 2,
    apply: "hot",
    env: "YUKI_TTS_PREFETCH",
  },
  "tts.minSentenceChars": {
    // ⚠️ Portée SANS DOMICILE ÉVIDENT : classée `instance` (voir
    // `docs/lot35b-multibot-overlay.md`, §« les 8 cas douteux »).
    scope: "instance",
    type: "int",
    default: 24,
    min: 8,
    max: 500,
    apply: "hot",
    env: "YUKI_TTS_MIN_SENTENCE",
  },
  "tts.maxSentenceChars": {
    // ⚠️ Portée SANS DOMICILE ÉVIDENT : classée `instance` (voir
    // `docs/lot35b-multibot-overlay.md`, §« les 8 cas douteux »).
    scope: "instance",
    type: "int",
    default: 240,
    min: 40,
    max: 2000,
    apply: "hot",
    env: "YUKI_TTS_MAX_SENTENCE",
  },
  "tts.timeoutMs": {
    scope: "instance",
    type: "int",
    default: 15_000,
    min: 1_000,
    max: 120_000,
    apply: "hot",
    env: "YUKI_TTS_TIMEOUT_MS",
  },
  "tts.volume": {
    // ⚠️ Portée SANS DOMICILE ÉVIDENT : classée `instance` (voir
    // `docs/lot35b-multibot-overlay.md`, §« les 8 cas douteux »).
    scope: "instance",
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
    scope: "bot",
    type: "enum",
    enum: ["off", "on"],
    default: "on",
    apply: "hot",
  },
  "memory.recall.topK": {
    scope: "bot",
    type: "int",
    default: 5,
    min: 0,
    max: 20,
    apply: "hot",
  },
  "memory.recall.budgetChars": {
    scope: "bot",
    type: "int",
    default: 8_000,
    min: 0,
    max: 40_000,
    apply: "hot",
  },
  "memory.recall.timeoutMs": {
    scope: "bot",
    type: "int",
    default: 400,
    min: 20,
    max: 5_000,
    apply: "hot",
  },
  "memory.extract.maxItems": {
    scope: "bot",
    type: "int",
    default: 3,
    min: 0,
    max: 10,
    apply: "hot",
  },
  "memory.extract.timeoutMs": {
    scope: "bot",
    type: "int",
    default: 30_000,
    min: 1_000,
    max: 300_000,
    apply: "hot",
  },
  // Passe de SOLIDIFICATION déclenchée par la mise de côté d'une conversation :
  // la conversation est relue ENTIÈRE, mais BORNÉE (taille d'un appel + nombre
  // d'appels) — relire tout ne doit pas coûter un nombre illimité d'appels.
  "memory.setAside.maxChars": {
    scope: "bot",
    type: "int",
    default: 24_000,
    min: 1_000,
    max: 120_000,
    apply: "hot",
  },
  "memory.setAside.maxChunks": {
    scope: "bot",
    type: "int",
    default: 2,
    min: 1,
    max: 6,
    apply: "hot",
  },

  // --- Consolidation HEBDOMADAIRE de la mémoire (lot 29) -------------------
  // ⚠️ Le fuseau est un réglage À PART de `ui.timeZone` (qui reste UTC) : la
  // planification hebdomadaire vise une heure de PARIS (« 3 h du matin »),
  // l'affichage des horodatages reste corrélable à Mattermost.
  "memory.consolidation.enabled": {
    scope: "mixte",
    mixteMerge: "et",
    type: "enum",
    enum: ["off", "on"],
    default: "on",
    apply: "hot",
  },
  "memory.consolidation.cron": {
    // ⚠️ Portée SANS DOMICILE ÉVIDENT : classée `instance` (voir
    // `docs/lot35b-multibot-overlay.md`, §« les 8 cas douteux »).
    scope: "instance",
    type: "string",
    default: "0 3 * * 0",
    apply: "hot",
    env: "YUKI_MEMORY_CONSOLIDATION_CRON",
  },
  "memory.consolidation.timeZone": {
    // ⚠️ Portée SANS DOMICILE ÉVIDENT : classée `instance` (voir
    // `docs/lot35b-multibot-overlay.md`, §« les 8 cas douteux »).
    scope: "instance",
    type: "string",
    default: "Europe/Paris",
    apply: "hot",
    ianaTimeZone: true,
    env: "YUKI_MEMORY_CONSOLIDATION_TIME_ZONE",
  },
  // Budget de tokens d'UNE passe : plafonné par le contexte du modèle lourd lu
  // à l'exécution. Volontairement modeste par défaut (un appel géant est lent,
  // cher, et la qualité se dégrade sur de très longs contextes).
  "memory.consolidation.budgetTokens": {
    scope: "instance",
    type: "int",
    default: 200_000,
    min: 1_000,
    max: 2_000_000,
    apply: "hot",
    env: "YUKI_MEMORY_CONSOLIDATION_BUDGET_TOKENS",
  },
  // Nombre de versions d'archive conservées (12 ≈ 3 mois à une passe/semaine).
  "memory.consolidation.retention": {
    scope: "instance",
    type: "int",
    default: 12,
    min: 1,
    max: 100,
    apply: "hot",
    env: "YUKI_MEMORY_CONSOLIDATION_RETENTION",
  },

  // --- Récapitulatif « conversation dédiée » -------------------------------
  // Appel LLM LONG (récapitulatif exhaustif d'une conversation) : délai
  // GÉNÉREUX à dessein. Au-delà, on interrompt et on l'annonce honnêtement
  // (aucune conversation n'est créée).
  "recap.timeoutMs": {
    // ⚠️ Portée SANS DOMICILE ÉVIDENT : classée `instance` (voir
    // `docs/lot35b-multibot-overlay.md`, §« les 8 cas douteux »).
    scope: "instance",
    type: "int",
    default: 180_000,
    min: 5_000,
    max: 600_000,
    apply: "hot",
    env: "YUKI_RECAP_TIMEOUT_MS",
  },

  // --- Discussions (lot 18) ------------------------------------------------
  // ⚠️ `FieldType` = `string | int | enum` : tout ce qui est une LISTE ou un
  // OBJET (canaux, mapping auteur→rôle, mode de réponse par canal) vit dans un
  // fichier JSON du volume `state`, jamais ici. Seul le MODE est un réglage.
  //
  // `apply: hot` : le mode est relu à CHAQUE appel (`ChatService.mode()`), donc
  // `GET /api/chat/status` et le sélecteur de la barre latérale suivent
  // immédiatement un changement — sans redémarrage, sans reconnexion.
  "chat.mode": {
    scope: "bot",
    type: "enum",
    enum: ["local", "mattermost", "discord"],
    default: "local",
    apply: "hot",
  },
  // ⚠️ SÉCURITÉ (exigence utilisateur du 2026-11-01) : en mode DISTANT, l'accès aux
  // AGENTS est DÉSACTIVÉ PAR DÉFAUT. Depuis le 2026-11-02 il y a DEUX réglages
  // INDÉPENDANTS, parce qu'un seul ne permettait pas de répondre à « est-ce que je
  // peux différencier l'accès aux agents de l'accès aux outils ? » :
  //  - `chat.remoteAgents` (ci-dessous) : délégation, annuaire, coffre — tout ce qui
  //    ATTEINT une machine appairée ;
  //  - `chat.remoteTools` (juste après) : image, libraire, archives — les capacités
  //    de Yuki qui ne touchent à aucune machine.
  // Le classement outil par outil vit dans `REMOTE_TOOL_GROUP_OF`
  // (`src/llm/tool-policy.ts`) : un outil = un groupe, sans exception (garde de
  // compilation + test de garde).
  // La politique correspondante est `toolAllowlistForChat`
  // (`src/llm/tool-policy.ts`) : elle est BRANCHÉE sur le run distant depuis le
  // lot 20 (`src/chat/reply/generate.ts`). Elle est relue à CHAQUE réponse
  // (`apply: hot`) : changer un des deux réglages s'applique à la réponse suivante.
  // ⚠️ `actives` n'ouvre JAMAIS un outil qui exige une approbation : une
  // approbation s'affiche dans l'interface WEB et ne peut pas être donnée
  // depuis un canal — ces outils sont retirés de la politique distante.
  // ⚠️ RISQUE, EN CLAIR : `actives` vaut pour TOUS les canaux suivis (réglage
  // GLOBAL) et n'importe quel membre d'un canal peut écrire à Yuki. Il peut donc
  // DÉLÉGUER une tâche, c'est-à-dire faire exécuter du travail sur les machines
  // appairées (le garde-fou par AGENT s'applique : niveau, agent désactivé/hors
  // ligne, verrou matériel, audit — mais il n'existe AUCUNE autorisation par
  // PERSONNE). Détail et proposition de restriction par canal :
  // `docs/lot20-chat-outils-distants.md` §4. Défaut `desactive` = le seul réglage sûr.
  //
  // ⚠️ CE QUI DEVIENT IMPOSSIBLE SANS `actives` (lot 23, à dire clairement) : la
  // DÉLÉGATION. `delegate` n'existe pas dans la politique distante sous
  // `desactive` (groupe `agents`, `src/llm/tool-policy.ts`), et la RÈGLE
  // « faire ou déléguer ? » n'est injectée que sous `actives`
  // (`createRemoteRunTools`, `src/pi/chat-run.ts`).
  //
  // ⚠️ MAIS ON NE REFUSE JAMAIS SANS ALTERNATIVE (correctif 2026-11-02, régression
  // de production) : un outil LONG appelé INLINE (`LONG_RUNNING_TOOLS`) n'est PAS
  // refusé tant que `delegate` est absent — il s'exécute, et c'est la BORNE DU
  // TOUR qui est relevée jusqu'à sa borne déclarée (`channelTurnTimeoutMs`,
  // `src/llm/tool-policy.ts`, appliquée par `src/index.ts`). Ce correctif ne
  // dépend QUE de l'absence de `delegate` : « agents non + outils oui » laisse
  // donc `generer_image` s'exécuter inline, avec la borne relevée à 1 h
  // (`images.timeoutMs`, 3 600 000 ms).
  "chat.remoteAgents": {
    scope: "bot",
    type: "enum",
    enum: ["desactive", "actives"],
    default: "desactive",
    apply: "hot",
  },
  // ⚠️ SECOND RÉGLAGE, INDÉPENDANT (demande utilisateur du 2026-11-02 : « images oui,
  // agents non » était impossible avec un seul interrupteur).
  // `desactive` (défaut) : aucun outil du groupe `outils` — ni `generer_image`, ni
  // `consulter_workflow`, ni libraire, ni archives. `actives` : ces outils sont
  // offerts au run distant, SANS ouvrir la délégation ni quoi que ce soit qui
  // atteigne une machine.
  // ⚠️ CE QUI RESTE OUVERT DANS TOUS LES CAS (aucun réglage) : `lister_fichiers`,
  // `lire_fichier`, `publier_dans_canal`, `envoyer_fichier` — ils ne sortent pas de
  // la conversation (`REMOTE_TOOL_GROUP_OF`, groupe `toujours`).
  // ⚠️ CE QUI RESTE FERMÉ DANS TOUS LES CAS : `run_command`, `capturer_ecran`,
  // `recuperer_fichier`, `deposer_fichier`, `demander_secret` — ils exigent une
  // approbation humaine, impossible à donner depuis un canal.
  // ⚠️ RISQUE : `actives` permet à N'IMPORTE QUEL membre d'un canal suivi de faire
  // générer des images, d'interroger le libraire et de lire les archives. Aucune
  // machine n'est atteinte, mais cela consomme du GPU et du temps de Yuki.
  "chat.remoteTools": {
    scope: "bot",
    type: "enum",
    enum: ["desactive", "actives"],
    default: "desactive",
    apply: "hot",
  },
  // ⚠️ MÉMOIRE DURABLE : elle n'est PAS branchée sur les conversations
  // distantes, et il n'y a donc AUCUN réglage. `chat.remoteMemory` a existé au
  // lot 18 : il n'était lu que pour l'AFFICHAGE, aucun consommateur ne s'en
  // servait — un interrupteur qui ne fait rien est un mensonge d'interface, il
  // a été RETIRÉ. Le jour où la mémoire distante sera branchée, le réglage
  // reviendra EN MÊME TEMPS que son consommateur.
  // --- Discord (lot 21) ----------------------------------------------------
  // ⚠️ Champs SCALAIRES seulement (`FieldType` = `string | int | enum`) : la liste des
  // salons suivis n'est pas un réglage, c'est le MIROIR (`chat-mirror.json`).
  //
  // Serveur à suivre. `allowEmpty` : la chaîne vide a un SENS ("tous les serveurs où le
  // bot est présent") et c'est le défaut — un identifiant obligatoire rendrait le bot
  // muet tant que l'utilisateur n'aurait pas trouvé son identifiant de serveur.
  "chat.discord.guildId": {
    scope: "bot",
    type: "string",
    default: "",
    allowEmpty: true,
    apply: "hot",
  },
  // ⚠️ Borne d'ENVOI par fichier, appliquée AVANT tout appel réseau. Discord accepte
  // 20 Mio par défaut (davantage avec le boost du serveur) et une requête de 25 Mio au
  // maximum : on reste SOUS (8 Mio par défaut) parce qu'un envoi raté coûte une réponse
  // perdue, et on plafonne à 25 Mio (`DISCORD_MAX_UPLOAD_CEILING`).
  "chat.discord.maxUploadBytes": {
    scope: "bot",
    type: "int",
    default: 8 * 1024 * 1024,
    min: 1,
    max: 25 * 1024 * 1024,
    apply: "hot",
  },

  // --- Transport temps réel ------------------------------------------------
  "transport.replayBuffer": {
    scope: "instance",
    type: "int",
    default: 1_000,
    min: 1,
    apply: "restart",
    env: "YUKI_WS_REPLAY_BUFFER",
  },
  "transport.replayBytes": {
    scope: "instance",
    type: "int",
    default: 5_000_000,
    min: 1,
    apply: "restart",
    env: "YUKI_WS_REPLAY_BYTES",
  },

  // --- Notifications (PWA + Web Push) --------------------------------------
  // ⚠️ `FieldType` = `string | int | enum` : l'activation est un ENUM `off|on`
  // (aucun booléen). Défaut `on` : le service n'ENVOIE rien tant qu'aucun
  // appareil n'est abonné (l'abonnement navigateur EST l'opt-in explicite).
  // `apply: hot` : le service relit ce réglage à chaque événement.
  "push.enabled": {
    scope: "mixte",
    mixteMerge: "et",
    type: "enum",
    enum: ["off", "on"],
    default: "on",
    apply: "hot",
  },
  // Sujet VAPID (`sub` du JWT, RFC 8292) : un `mailto:` ou une URL de contact.
  // Certains services de push refusent une valeur vide ; on fournit un défaut
  // neutre, sans prétendre à une adresse existante.
  "push.contact": {
    scope: "instance",
    type: "string",
    default: "mailto:yuki@localhost",
    apply: "hot",
    env: "YUKI_PUSH_CONTACT",
  },

  // --- Bots : combien TOURNENT en même temps (lot 36, L1) -------------------
  // ⚠️ Nombre MAXIMAL de bots dont la pile est construite au démarrage
  // (approche B : UN processus, N `PiHost`). Un bot `actif` au-delà de ce
  // plafond ne démarre PAS ; le refus est EXPLICITE (journal + `GET /api/bots`),
  // jamais un bot silencieusement absent.
  //
  // ⚠️ `6` est la borne du REGISTRE (`MAX_BOTS`, `src/bots/registry.ts`) ; la
  // table de configuration ne l'importe pas (données pures, aucun import).
  // `apply: "restart"` : la résolution des bots a lieu UNE fois au démarrage.
  "bots.maxActifs": {
    scope: "instance",
    type: "int",
    default: 3,
    min: 1,
    max: 6,
    apply: "restart",
    env: "YUKI_BOTS_MAX_ACTIFS",
  },

  // --- Agents d'exécution (Lot 4) -----------------------------------------
  // ⚠️ `FieldType` = `string | int | enum` : AUCUN booléen, aucun tableau. Le
  // niveau de garde-fou est donc un ENUM (D118) et le privilège un ENUM (D120).
  // Le canal « machines » est LAN uniquement (D116) ; le port et l'hôte sont
  // des valeurs de DÉPLOIEMENT, sans fait d'infra fiable (docs/lot4.md §13).
  "agents.bindHost": {
    scope: "instance",
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
    scope: "instance",
    type: "string",
    default: "",
    allowEmpty: true,
    apply: "hot",
    env: "YUKI_AGENTS_SERVER_NAME",
  },
  "agents.port": {
    scope: "instance",
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
    scope: "instance",
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
    scope: "instance",
    type: "int",
    default: 30,
    min: 1,
    max: 3_650,
    apply: "hot",
    env: "YUKI_AUDIT_RETENTION_DAYS",
  },
  "audit.maxSizeMb": {
    scope: "instance",
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
    scope: "instance",
    type: "string",
    default: "",
    allowEmpty: true,
    apply: "hot",
    env: "YUKI_LIBRARIAN_BASE_URL",
  },
  "librarian.agentToken": {
    scope: "instance",
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
    scope: "instance",
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
    scope: "instance",
    type: "enum",
    enum: ["off", "on"],
    default: "on",
    apply: "hot",
    env: "YUKI_LIBRARIAN_SCREENSHOT",
  },
  "librarian.archiveTimeoutMs": {
    scope: "instance",
    type: "int",
    default: 30_000,
    min: 1_000,
    max: 300_000,
    apply: "hot",
    env: "YUKI_LIBRARIAN_ARCHIVE_TIMEOUT_MS",
  },

  // --- Fichiers échangés (envoi ET réception) -------------------------------
  // ⚠️ Un fichier peut remplir le disque : le plafond est TRÈS HAUT mais il
  // existe, et il est RÉGLABLE. `apply: hot` : le stockage relit ces bornes à
  // chaque dépôt (aucun redémarrage nécessaire pour un changement).
  // `maxFileBytes` : 2 Gio par défaut (8 Gio maximum autorisé).
  "files.maxFileBytes": {
    scope: "instance",
    type: "int",
    default: 2_147_483_648,
    min: 1_048_576,
    max: 8_589_934_592,
    apply: "hot",
    env: "YUKI_FILES_MAX_BYTES",
  },
  // ⚠️ GARDE-FOU de LECTURE/RÉDUCTION des images (`files.imageMaxBytes`).
  // Une image jointe part en base64 dans le message, et le base64 pèse ×1,33 :
  // ce plafond borne les octets du FICHIER, PAS la charge réseau. La borne qui
  // compte sur le fil est `files.imageMaxWireBytes` (ci-dessous) — les deux sont
  // combinées dans `src/files/vision.ts` (budget = le plus petit des deux).
  //
  // ⚠️ AU-DELÀ, ON RÉDUIT D'ABORD (`src/files/vision.ts` : côté max 2 000 px,
  // côté min lisible 700 px) et on ne REFUSE que si la réduction n'aboutit pas
  // ou rendrait l'image illisible : jamais de troncature, jamais d'envoi muet
  // d'une image démesurée. L'original stocké, lui, n'est jamais transformé.
  "files.imageMaxBytes": {
    scope: "instance",
    type: "int",
    default: 3_500_000,
    min: 1,
    max: 20_000_000,
    apply: "hot",
    env: "YUKI_FILES_IMAGE_MAX_BYTES",
  },
  // ⚠️ PLAFOND EN OCTETS TRANSMIS (base64) — LA borne qui compte sur le fil.
  //
  // Incident mesuré (2026-11-01) : une image de 2 876 Ko / 2231×961 était bien
  // réduite (côté 2 000 px) mais partait à ~3,1 Mio de base64, et le fournisseur
  // répondait `500 « request entity too large »` après 17 s et 0 jeton. La
  // politique ne raisonnait que sur les octets d'ORIGINE : traduits en budget
  // base64 (×4/3) par `files.imageMaxBytes`, ils laissaient passer 4 666 668
  // octets sur le fil.
  //
  // ⚠️ La CIBLE n'est pas « sous les 5 Mo du fournisseur » mais « quelques
  // centaines de Ko » : le chemin qui FONCTIONNE (la même image, le même modèle,
  // le même fournisseur, envoyée par un client qui ré-encode) part à 479,5 Ko sur
  // 2000×861. Mesuré ici : à budget 4 666 668 le SDK garde le PNG et émet
  // 3 208 Ko ; à 700 000 il ré-encode en JPEG et émet 208 Ko — mêmes dimensions.
  // 1 000 est le plancher : en dessous, aucune capture n'est lisible et TOUT
  // serait refusé — c'est légal (comme `files.imageMaxBytes: 1`) mais absurde.
  "files.imageMaxWireBytes": {
    scope: "instance",
    type: "int",
    default: 700_000,
    min: 1_000,
    max: 20_000_000,
    apply: "hot",
    env: "YUKI_FILES_IMAGE_MAX_WIRE_BYTES",
  },
  // ⚠️ PLAFOND DES IMAGES D'UNE **REQUÊTE ENTIÈRE** (et non d'une seule image).
  //
  // Incident mesuré (2026-11-01, 2 h de blocage) : `files.imageMaxWireBytes` borne
  // UNE image, mais le SDK renvoie à CHAQUE tour TOUT l'historique — une image
  // rendue par `lire_fichier` repartait donc dans chaque requête suivante. Après
  // trois lectures, le corps HTTP dépassait la limite du fournisseur alors que le
  // contexte TEXTE était devenu minuscule (« redescendu à 23 k ») : la compaction
  // ne voit une image que comme ~1 200 jetons et CONSERVE les messages récents
  // tels quels, blocs image compris.
  //
  // Corrigé par `src/pi/sdk/context-images.ts` (événement `context` du SDK, qui ne
  // modifie QUE la copie envoyée) : du plus RÉCENT au plus ANCIEN, les images sont
  // gardées tant que le total TRANSMIS (base64) reste sous ce plafond ; au-delà,
  // le bloc image devient un texte qui dit la vérité et comment la revoir.
  // ⚠️ La VISION reste ACTIVE : l'image fraîche (outil ou pièce jointe du tour)
  // est toujours vue ; seule sa RÉPÉTITION dans les tours suivants est retirée.
  // 1 500 000 ≈ deux images pleines (une pièce jointe + un résultat d'outil) ;
  // au-delà, une image supplémentaire est retirée AVANT l'appel, jamais après
  // l'échec. 0 (ou moins) ⇒ pas de borne (comportement antérieur, déconseillé).
  "files.imageRequestBudgetBytes": {
    scope: "instance",
    type: "int",
    default: 1_500_000,
    min: 1_000,
    max: 60_000_000,
    apply: "hot",
    env: "YUKI_FILES_IMAGE_REQUEST_BUDGET_BYTES",
  },
  // Rétention : au-delà, le FICHIER et son ANALYSE sont supprimés (purge réelle).
  "files.retentionDays": {
    scope: "instance",
    type: "int",
    default: 30,
    min: 1,
    max: 3_650,
    apply: "hot",
    env: "YUKI_FILES_RETENTION_DAYS",
  },
  // Nombre maximal de fichiers joints à UN message (au-delà : refus explicite).
  "files.maxAttachments": {
    scope: "instance",
    type: "int",
    default: 5,
    min: 1,
    max: 20,
    apply: "hot",
    env: "YUKI_FILES_MAX_ATTACHMENTS",
  },
  // BORNE d'injection au modèle, PAR fichier (un fichier énorme ne part jamais
  // entier : la troncature est dite dans le bloc `<fichiers>`).
  "files.promptChars": {
    scope: "instance",
    type: "int",
    default: 12_000,
    min: 1_000,
    max: 100_000,
    apply: "hot",
    env: "YUKI_FILES_PROMPT_CHARS",
  },
  // BORNE d'injection au modèle pour TOUS les fichiers d'un même message.
  "files.promptTotalChars": {
    scope: "instance",
    type: "int",
    default: 24_000,
    min: 1_000,
    max: 400_000,
    apply: "hot",
    env: "YUKI_FILES_PROMPT_TOTAL_CHARS",
  },

  // --- Transfert de fichiers vers/depuis une machine (capacité `files`) ------
  // ⚠️ Ces trois bornes sont RELUES à chaque transfert (`src/agents/transfer.ts`),
  // donc un changement dans `/config` s'applique sans redémarrage.
  //
  // `agentMaxBytes` : plafond PAR TRANSFERT (256 Mio). Au-delà, le transfert est
  // REFUSÉ avec un message qui dit d'utiliser `run_command` (un transfert de
  // plusieurs Gio bloquerait le tour du modèle).
  "files.agentMaxBytes": {
    scope: "instance",
    type: "int",
    default: 268_435_456,
    min: 1_048_576,
    max: 8_589_934_592,
    apply: "hot",
    env: "YUKI_FILES_AGENT_MAX_BYTES",
  },
  // `agentChunkBytes` : taille BINAIRE d'un morceau (192 Kio ⇒ ~256 Kio en
  // base64, très en dessous de la trame max 8 Mio).
  "files.agentChunkBytes": {
    scope: "instance",
    type: "int",
    default: 196_608,
    min: 16_384,
    max: 4_194_304,
    apply: "hot",
    env: "YUKI_FILES_AGENT_CHUNK_BYTES",
  },
  // `agentTimeoutMs` : délai INACTIF maximal d'un transfert (sans trame reçue).
  "files.agentTimeoutMs": {
    scope: "instance",
    type: "int",
    default: 120_000,
    min: 5_000,
    max: 3_600_000,
    apply: "hot",
    env: "YUKI_FILES_AGENT_TIMEOUT_MS",
  },

  // --- Sources (programmes extérieurs qui réveillent Yuki) -------------------
  // ⚠️ Les SOURCES elles-mêmes (nom, consigne, réglages) ne sont PAS ici : elles
  // vivent dans un fichier séparé du volume `state` (`sources.json`), car
  // `PUT /api/config` n'accepte qu'un patch PLAT de scalaires. Seule cette BORNE
  // d'injection est un scalaire — elle borne le bloc `<sources>` transmis au
  // modèle au début d'un tour (drain groupé).
  "sources.promptTotalChars": {
    // ⚠️ Portée SANS DOMICILE ÉVIDENT : classée `instance` (voir
    // `docs/lot35b-multibot-overlay.md`, §« les 8 cas douteux »).
    scope: "instance",
    type: "int",
    default: 4_000,
    min: 500,
    max: 40_000,
    apply: "hot",
    env: "YUKI_SOURCES_PROMPT_TOTAL_CHARS",
  },

  // --- Images générées (serveur ComfyUI) -------------------------------------
  // ⚠️ `images.baseUrl` vide = serveur NON configuré : l'outil `generer_image`
  // existe quand même (il est câblé) mais REFUSE explicitement, avec la marche à
  // suivre. `apply: hot` : le client relit l'URL à CHAQUE appel, donc la
  // première configuration ne demande AUCUN redémarrage.
  // ⚠️ Les WORKFLOWS, eux, ne sont PAS ici : ils vivent dans un fichier séparé du
  // volume `state` (`${state}/comfy/workflows.json`) — un graphe pèse des dizaines
  // de Ko et `PUT /api/config` n'accepte qu'un patch PLAT de scalaires.
  "images.baseUrl": {
    scope: "instance",
    type: "string",
    default: "",
    allowEmpty: true,
    apply: "hot",
    env: "YUKI_IMAGES_BASE_URL",
  },
  // Jeton facultatif (serveur ComfyUI derrière un reverse-proxy authentifié).
  // ⚠️ Envoyé en `Authorization: Bearer …`, JAMAIS journalisé, JAMAIS renvoyé
  // par l'API (masqué comme les autres champs `secret`).
  "images.apiKey": {
    scope: "instance",
    type: "string",
    default: "",
    apply: "hot",
    secret: true,
    env: "YUKI_IMAGES_API_KEY",
  },
  // Dimensions injectées dans les nœuds `YUKI_WIDTH` / `YUKI_HEIGHT` (relues à
  // chaque génération). Les workflows qui ne portent pas ces étiquettes les
  // ignorent : ces valeurs ne sont jamais imposées à un graphe qui ne les demande pas.
  "images.width": {
    scope: "instance",
    type: "int",
    default: 1_024,
    min: 64,
    max: 4_096,
    apply: "hot",
    env: "YUKI_IMAGES_WIDTH",
  },
  "images.height": {
    scope: "instance",
    type: "int",
    default: 1_024,
    min: 64,
    max: 4_096,
    apply: "hot",
    env: "YUKI_IMAGES_HEIGHT",
  },
  // PLAFOND DE SÉCURITÉ d'une génération (ms) — 1 HEURE par défaut.
  //
  // ⚠️ Ce n'est PLUS le mécanisme d'arrêt : c'est la SURVEILLANCE D'ÉTAT qui
  // décide (`GET /queue`, `src/comfy/client.ts`) — tant que ComfyUI déclare le
  // travail dans sa file (`queue_running`/`queue_pending`), l'attente continue ;
  // dès qu'il en disparaît sans résultat, l'échec est constaté en 30 s. Ce
  // plafond n'est qu'un FILET pour le cas RARISSIME d'un travail orphelin
  // (serveur figé) : s'il coupe, c'est un BLOCAGE, pas une lenteur.
  // ⚠️ Il doit rester SOUS le chien de garde dérivé (`resolveToolWatchdogMs` :
  // plafond + 60 s), SOUS la borne du tour de canal (`CHAT_REPLY_TIMEOUT_MS` +
  // plafond) et SOUS `delegation.totalTimeoutMs` (75 min) : une borne plus
  // courte en amont ferait échouer la génération « sans raison visible ».
  // ⚠️ `max` à 2 h : il doit DÉPASSER le défaut (un défaut au maximum
  // interdirait de régler plus haut, et un défaut au plafond est incohérent),
  // et 2 h laissent la place à un workflow VIDÉO lourd (~10 min de calcul par
  // vidéo, plusieurs passes) sans autoriser une attente déraisonnable.
  // ⚠️ Au-delà de 61 min, la CHAÎNE doit suivre : `delegation.totalTimeoutMs`
  // (75 min par défaut, appliqué au REDÉMARRAGE) et le chien de garde (dérivé, à
  // chaud). Un plafond réglé à 2 h sans relever la borne du job ferait couper le
  // job par sa propre limite totale — plus courte que le plafond.
  "images.timeoutMs": {
    scope: "instance",
    type: "int",
    default: 3_600_000,
    min: 10_000,
    max: 7_200_000,
    apply: "hot",
    env: "YUKI_IMAGES_TIMEOUT_MS",
  },

  // --- Interface : fuseau des HORODATAGES ----------------------------------
  // ⚠️ Demande utilisateur du 2026-11-04 : « passer tous les horodatages en UTC
  // (Mattermost est en UTC, pas le reste) ». Un même événement s'affichait dans
  // TROIS fuseaux (canal distant, prompt, navigateur) : impossible à corréler.
  // Ce champ est le SEUL fuseau des horodatages `src/pi/timestamp.ts` :
  // prompts (`[horodatage] … (UTC)`), fils de canal, interface, journal.
  // ⚠️ Il ne touche PAS la PLANIFICATION : un déclencheur `0 9 * * *` continue
  // de tirer à 9 h dans SON fuseau (`src/sources/cron.ts`), et l'interprétation
  // d'un envoi programmé garde le sien (`src/chat/envois/quand.ts`).
  // ⚠️ `apply: hot` : la valeur est relue à chaque formatage (aucun
  // redémarrage) ; l'interface est prévenue par la trame `time_zone`.
  "ui.timeZone": {
    scope: "instance",
    type: "string",
    default: "UTC",
    apply: "hot",
    ianaTimeZone: true,
    env: "YUKI_UI_TIME_ZONE",
  },
};

/** Ordre stable des chemins (déterminisme des réponses / journaux). */
export const CONFIG_PATHS: readonly string[] = Object.keys(CONFIG_SCHEMA);

/**
 * Variables d'environnement RETIRÉES au lot 35b : `variable` → chemin du champ.
 *
 * ⚠️ RUPTURE DE DÉPLOIEMENT ASSUMÉE : ces 21 variables portaient des clés
 * `bot`/`mixte`. Une variable d'environnement est une valeur d'INSTALLATION —
 * elle ne peut pas désigner « le bot actif » : la garde de compilation interdit
 * désormais `env` sur ces portées (`schema.ts:BotFieldDescriptor`). Un
 * déploiement qui les définit encore ne doit pas croire qu'elles agissent :
 * elles sont ANNONCÉES au démarrage (`ConfigRuntime.warnings`), jamais
 * supprimées en silence.
 *
 * Le remplacement est le réglage lui-même (page `/config` pour les clés
 * d'instance et de bot à ce stade), ou `config.overlay.json` du bot.
 */
export const VARIABLES_ENV_RETIREES: Readonly<Record<string, string>> = {
  YUKI_TTS_ENABLED: "tts.enabled",
  YUKI_TTS_VOICE: "tts.voice",
  YUKI_TTS_EMOTION: "tts.emotion",
  YUKI_TTS_SPEED: "tts.speed",
  YUKI_TTS_EXAGGERATION: "tts.exaggeration",
  YUKI_TTS_CFG: "tts.cfg",
  YUKI_MEMORY_ENABLED: "memory.enabled",
  YUKI_MEMORY_TOP_K: "memory.recall.topK",
  YUKI_MEMORY_BUDGET_CHARS: "memory.recall.budgetChars",
  YUKI_MEMORY_TIMEOUT_MS: "memory.recall.timeoutMs",
  YUKI_MEMORY_MAX_ITEMS: "memory.extract.maxItems",
  YUKI_MEMORY_EXTRACT_TIMEOUT_MS: "memory.extract.timeoutMs",
  YUKI_MEMORY_SET_ASIDE_MAX_CHARS: "memory.setAside.maxChars",
  YUKI_MEMORY_SET_ASIDE_MAX_CHUNKS: "memory.setAside.maxChunks",
  YUKI_MEMORY_CONSOLIDATION_ENABLED: "memory.consolidation.enabled",
  YUKI_CHAT_MODE: "chat.mode",
  YUKI_CHAT_REMOTE_AGENTS: "chat.remoteAgents",
  YUKI_CHAT_REMOTE_TOOLS: "chat.remoteTools",
  YUKI_CHAT_DISCORD_GUILD_ID: "chat.discord.guildId",
  YUKI_CHAT_DISCORD_MAX_UPLOAD_BYTES: "chat.discord.maxUploadBytes",
  YUKI_PUSH_ENABLED: "push.enabled",
};

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
        descriptor.emptyMessage ??
        "Ce champ ne peut pas être vide. Utilisez null pour rétablir la valeur par défaut.",
    };
  }
  if (descriptor.ianaTimeZone === true && !isKnownTimeZone(trimmed)) {
    return {
      ok: false,
      code: "invalid_timezone",
      message:
        `Fuseau horaire inconnu : « ${trimmed} ». Attendu un nom IANA, ` +
        "par exemple UTC, Europe/Paris, America/New_York.",
    };
  }
  return { ok: true, value: trimmed };
}

/**
 * `true` si `Intl` accepte ce fuseau. Aucune dépendance à `node:fs` ni au SDK :
 * `Intl` fait partie de la plateforme, et `new Intl.DateTimeFormat` LÈVE sur un
 * nom inconnu — c'est ce comportement qui sert de test de validité.
 */
function isKnownTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Valide une valeur brute par chemin ; `unknown_field` si le chemin est inconnu. */
export function validateField(path: string, raw: unknown): FieldValidation {
  const descriptor = CONFIG_SCHEMA[path];
  if (!descriptor) {
    return { ok: false, code: "unknown_field", message: `Champ inconnu : ${path}.` };
  }
  return validateDescriptor(descriptor, raw);
}
