/**
 * Point d'entrée du gateway Yuki.
 *
 * La porte de compatibilité GPU est franchie AVANT l'ouverture du port. En mode
 * strict, un refus laisse la porte fermée MAIS le serveur HTTP démarre quand
 * même : la page `/config` reste accessible pour corriger le profil (invariant
 * Lot 11 : « le paramétrage ne dépend jamais du fonctionnement applicatif »).
 *
 * Lot 11 — ORDRE D'INITIALISATION CRITIQUE :
 *   1. charger la configuration (store + env + défauts) ;
 *   2. PONT des clés du store vers `process.env` ;
 *   3. créer le logger (sa redaction capte alors les clés du store) ;
 *   4. passer en plus explicitement les clés du store au logger.
 * Sans cet ordre, une clé issue du store fuiterait dans les logs.
 *
 * Lot 2 : composition root. On câble les ports (`src/delegation`) sur leurs
 * implémentations SDK (`src/pi/sdk/**`, exposées via la façade `src/pi`) :
 * `JobStore` + `JobQueue` + worker lourd + service de délégation injectés dans
 * le `PiHost`. ⚠️ Aucun import direct de `src/pi/sdk/**` ici.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  AgentDirectoryService,
  AgentExecutionService,
  AgentFileTransferService,
  AgentHub,
  AgentLockService,
  AgentStore,
  ApprovalRegistry,
  AuditLog,
  caDirectoryIn,
  CertificateAuthority,
  closeAgentsServer,
  createAgentsServer,
  installServerCertificateReload,
  localIpAddresses,
  maxSizeBytesFromMb,
  PairingManager,
  PreAutorisationStore,
  serverCertificateNames,
  startAgentsServer,
  uncoveredLocalAddresses,
  type AgentLevel,
} from "./agents/index.js";
import type { AgentsApiDeps } from "./gateway/routes/agents.js";
import { InstancePasswordStore } from "./security/instance-password.js";
import { SecretRequestRegistry } from "./secrets/requests.js";
import { SecretStore } from "./secrets/store.js";

import { loadEnv, type CompatMode, type LlmMissingKeyMode } from "./config/env.js";
import {
  BOT_YUKI,
  construireWorkerLourdSiAutorise,
  preparerMultiBot,
  purgerArchivesBots,
  workerLourdAutorise,
} from "./bots/index.js";
import type { ProfilBot } from "./bots/registry.js";
import {
  ComfyClient,
  ComfyWorkflowStore,
  GeneratedImagesStore,
  createComfyGenerator,
  type ComfyImageFinalPromptView,
  type ComfyImageView,
  type ImagesGatewayPort,
} from "./comfy/index.js";
import { createFilesService, createGeneratedImageFiles, FilesStore } from "./files/index.js";
import { AvatarStore } from "./identity/avatar.js";
import {
  CHAT_JUDGE_SYSTEM_PROMPT,
  CHAT_JUDGE_TIMEOUT_MS,
  CHAT_REPLY_SYSTEM_PROMPT,
  CHAT_REPLY_TIMEOUT_MS,
  ChatMirrorStore,
  ChatService,
  MattermostAttachmentCache,
  MattermostChatAdapter,
  type ChatReplyJudge,
  type CibleEnvoi,
  type ProgrammationInput,
  type RemoteMessage,
  type RemotePlatform,
  buildJudgePrompt,
  createChannelAwareWaker,
  createChannelPostPort,
  createRemoteReplyGenerator,
  createReplyMessagePort,
  EnvoisProgrammesService,
  EnvoisProgrammesStore,
  effectiveQuoteAuthor,
  effectiveReplyStyle,
  parseJudgeAnswer,
  mirrorPlatformOf,
  getAdapter,
  runPlatformOf,
  registerAdapterProvider,
} from "./chat/index.js";
import { MM_MAX_DOWNLOAD_BYTES } from "./chat/mattermost/types.js";
import { DiscordChatAdapter, discordAttachmentPort } from "./chat/discord/adapter.js";
import { ChatAttachmentCache } from "./chat/attachments.js";
import { DISCORD_MAX_DOWNLOAD_BYTES } from "./chat/discord/types.js";
import { prepareMessageImages } from "./chat/mattermost/attachments.js";
import { DISCORD_TOKEN_SECRET_NAME, MATTERMOST_TOKEN_SECRET_NAME } from "./secrets/references.js";
import type { ChatDiscordPort, ChatMattermostPort } from "./gateway/routes/chat.js";
import { describeWriteFailure, inspectMountPoints, mountPoints, probeWritable } from "./config/paths.js";
import { createConfigRuntime, type ConfigRuntime } from "./config/runtime.js";
import { createDelegationService, type DelegationService } from "./delegation/index.js";
import {
  createServer,
  installGracefulShutdown,
  RESTART_REASON,
  startServer,
} from "./gateway/server.js";
import { createWsTransport, type AgentsGatewayPort } from "./gateway/ws/server.js";
import { effectiveTimeZone } from "./pi/timestamp.js";
import type {
  CapturedScreenshotView,
  ScreenshotGatewayPort,
  ScreenshotViewEvent,
} from "./agents/execution.js";
import type { Transport } from "./gateway/ws/transport.js";
import type { SubsystemsSnapshot } from "./gateway/routes/health.js";
import type { VoiceApiDeps } from "./gateway/routes/voices.js";
import {
  DEFAULT_TTS_TEST_TEXT,
  TtsDiagnostics,
  TTS_PROBE_CACHE_TTL_MS,
  TTS_PROBE_TIMEOUT_MS,
  type EngineConfigPort,
  type TtsApiDeps,
} from "./gateway/routes/tts.js";
import { detectGpus } from "./gpu/detect.js";
import { runGate, type GateCompatConfig } from "./gpu/gate.js";
import { loadCompatManifest, loadProfiles } from "./gpu/profiles.js";
import { formatReportConsole } from "./gpu/report.js";
import { JobQueue, JobStore } from "./jobs/index.js";
import {
  HEAVY_SYSTEM_PROMPT_FALLBACK,
  appendVoiceInstruction,
  avertirSiPromptLegerIncomplet,
  buildModelsConfigFrom,
  evaluateMissingKeyPolicy,
  resolveAvailability,
  resolveModelsFrom,
  resolveProvidersFrom,
  toolAllowlist,
  toolAllowlistForChat,
  type ChatOriginMode,
  type EffectiveLlmConfig,
  type LlmConfig,
  type ThinkingLevelName,
  type ToolAllowlistOptions,
} from "./llm/index.js";
import {
  createLibrarianArchiveService,
  createLibrarianClient,
  LibrarianShotsStore,
  LIBRARIAN_SYNTHESIZER_SYSTEM_PROMPT,
  type LibrarianShotView,
} from "./librarian/index.js";
import { collectSecretValues, createLogger } from "./observability/logger.js";
import {
  ConsolidationArchiveStore,
  ConsolidationHebdo,
  ConversationArchiveStore,
  HeritageAdminService,
  HeritageStore,
  MemoryIndex,
  MemoryService,
  MemoryStore,
  REACTIONS_SOURCE,
  contexteModeleDepuisFichier,
  memoryWriteModelReference,
} from "./memory/index.js";
import { PersonalityStore } from "./personality/index.js";
import {
  createPushSender,
  createPushService,
  loadOrCreateVapidKeys,
  PushSubscriptionStore,
  type PushService,
} from "./push/index.js";
import type { PushApiDeps } from "./gateway/routes/push.js";
import {
  ReactionStore,
  regularityMemory,
  type ReactionRegularity,
} from "./reactions/index.js";
import { RulesStore } from "./rules/index.js";
import {
  DeclencheurBalayeur,
  DeclencheurJournal,
  ORIGINE_HORLOGE,
  SourcesInbox,
  SourcesService,
  SourcesStore,
  type PlanificationTacheInput,
} from "./sources/index.js";
import { createPiHost, createRemoteRunTools, resolveToolWatchdogMs, createSdkConsolidationHebdoExtractor, createSdkHeavyWorker, createSdkLibrarianSynthesizer, createSdkMemoryExtractor, createSdkPromptWriter, createSdkRecapWriter, sdkVisionImageResizer, SessionPinStore, type PiHost, type PiThinkingLevel, type RemoteRunLibrarianPorts, type SdkToolEvent } from "./pi/index.js";
import { createRecapService } from "./recap/index.js";
import {
  AudioCppClient,
  EngineCapabilitiesProbe,
  EngineConfigStore,
  TtsDownloadManager,
  VoiceStore,
  createAudioCppSynthesizer,
  isTtsEnabled,
  readTtsOptions,
  voiceRefOf,
  type SegmentSynthesizer,
  type Voice,
} from "./tts/index.js";
import type { ModelAvailability } from "./delegation/index.js";

const FALLBACK_SYSTEM_PROMPT =
  "Tu es Yuki, un assistant conversationnel généraliste. Réponds de manière claire et concise.";

/**
 * Période du balayage de RÉTENTION du volume `state` (10 min) : pièces jointes,
 * IMAGES GÉNÉRÉES et CAPTURES du libraire. Court assez pour qu'un expiré ne
 * survive pas longtemps, long assez pour ne rien coûter (lecture des seules
 * métadonnées des répertoires concernés). ⚠️ Un SEUL balayage pour les trois :
 * c'est ce qui garantit qu'un même réglage (`files.retentionDays`) produit la
 * même purge partout.
 */
const FILES_PURGE_INTERVAL_MS = 10 * 60_000;

function loadTextFile(path: string, fallback: string): string {
  try {
    const content = readFileSync(path, "utf8").trim();
    return content.length > 0 ? content : fallback;
  } catch {
    return fallback;
  }
}

/** Extrait le message d'une erreur inconnue (jamais un `[object Object]`). */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Lit la config effective des deux rôles LLM (store + env + défauts). */
function effectiveLlmConfig(config: ConfigRuntime): EffectiveLlmConfig {
  return {
    light: {
      api: config.getString("llm.light.api"),
      baseUrl: config.getString("llm.light.baseUrl"),
      model: config.getString("llm.light.model"),
      thinking: config.getString("llm.light.thinking") as ThinkingLevelName,
      // ⚠️ Déclaration VISION : produit `input` dans `models.json`.
      vision: config.getString("llm.light.vision") === "oui",
    },
    heavy: {
      api: config.getString("llm.heavy.api"),
      baseUrl: config.getString("llm.heavy.baseUrl"),
      model: config.getString("llm.heavy.model"),
      thinking: config.getString("llm.heavy.thinking") as ThinkingLevelName,
      vision: config.getString("llm.heavy.vision") === "oui",
    },
  };
}

async function main(): Promise<void> {
  // --- (1) Configuration : store + env + défauts ----------------------------
  const envBrut = loadEnv();
  // MULTI-BOT (lot 35a) — lit `state/bots.json`, migre la disposition mono-bot
  // si nécessaire, puis renvoie l'`Env` EFFECTIF (chemins du bot actif).
  // ⚠️ Peut REFUSER le démarrage (`DemarrageRefuseError` : MIGRATION_PARTIELLE,
  // MIGRATION_ECHOUEE, REGISTRE_INVALIDE) : jamais de fonctionnement à moitié
  // migré. Rien de VISIBLE ne change : seuls les chemins changent.
  const bots = preparerMultiBot(envBrut);
  const env = bots.env;
  const config = createConfigRuntime({
    env,
    // MULTI-BOT (lot 35b) : la configuration du BOT ACTIF vit dans son overlay
    // (`<state>/bots/<id>/config.overlay.json`) ; le store commun reste la
    // configuration d'INSTANCE. En mode mono-bot historique (`bots.bot` nul), le
    // bot actif est `yuki` — même chemin, donc aucun changement de comportement.
    botId: bots.bot?.id ?? BOT_YUKI,
    promptDefaults: {
      light: loadTextFile(env.piSystemPromptPath, FALLBACK_SYSTEM_PROMPT),
      heavy: loadTextFile(env.piHeavySystemPromptPath, HEAVY_SYSTEM_PROMPT_FALLBACK),
    },
  });

  // --- (2) Pont des clés du store vers `process.env` ------------------------
  // `models.json` référence `$YUKI_LLM_<ROLE>_API_KEY` : le SDK les résout dans
  // l'environnement au moment de la requête.
  config.bridgeSecrets();

  // --- (3) Logger (redaction des clés d'env ET du store) --------------------
  // ⚠️ Liste MUTABLE EN PLACE : le logger en garde la RÉFÉRENCE. Une clé saisie
  // APRÈS le démarrage (via /config) doit être masquée elle aussi ; on la
  // rafraîchit donc à chaque changement de configuration (voir `config.subscribe`
  // plus bas). Un instantané figé laisserait fuir la NOUVELLE clé dans les logs.
  const secretValues: string[] = [
    ...collectSecretValues(),
    ...config.secretValues(),
  ];
  const logger = createLogger({
    level: env.logLevel,
    secretValues,
  });

  // --- MULTI-BOT (lot 35a) : ce que le démarrage doit DIRE -------------------
  // Aucune fonction visible : uniquement du journal (migration effectuée,
  // surcharges de déploiement ignorées, bot actif).
  for (const avertissement of bots.avertissements) {
    logger.warn("bots.avertissement", { detail: avertissement });
  }
  if (bots.mode === "multi" && bots.bot !== null) {
    logger.info("bots.actif", {
      bot: bots.bot.id,
      ordre: bots.bot.ordre,
      migration: bots.migration,
      racine: bots.chemins?.racine ?? null,
      sessions: bots.chemins?.sessions ?? null,
    });
  } else {
    logger.info("bots.mono", { migration: bots.migration });
  }

  // --- PROFIL DE CAPACITÉS DU BOT ACTIF (lot 35f) ---------------------------
  // ⚠️ Le profil qui RESTREINT les outils est celui du BOT ACTIF, lu UNE fois ici
  // dans le registre `state/bots.json` — JAMAIS une valeur reçue d'un client (corps
  // de requête ou message) : sinon un appelant choisirait ses propres pouvoirs.
  // Mono-bot historique (`bots.bot` nul) ⇒ `complet` : comportement inchangé.
  const profilBot: ProfilBot = bots.bot?.profil ?? "complet";
  logger.info("bots.profil", {
    profil: profilBot,
    // ⚠️ Un profil restreint n'a AUCUN worker lourd (voir plus bas) : c'est ce qui
    // rend le retrait de `run_command` structurel et non déclaratif.
    worker_lourd: workerLourdAutorise(profilBot),
  });

  // --- Détection précoce des volumes `rw` non inscriptibles ------------------
  // Une cause système (montage `ro`, permissions, volume absent) ne se
  // manifesterait sinon qu'à la première écriture — et le store de config n'est
  // écrit qu'au premier « Enregistrer » de /config. On prévient donc TÔT, en
  // traduisant le CODE d'erreur réel en conseil EXACT (jamais une cause inventée).
  // On NE sort PAS : la page /config doit rester joignable (invariant Lot 11).
  for (const mount of mountPoints(env)) {
    if (mount.mode !== "rw") continue;
    const probe = probeWritable(mount.containerPath);
    if (probe.writable) continue;
    logger.error("volume.unwritable", {
      volume: mount.id,
      path: mount.containerPath,
      ...(probe.code ? { code: probe.code } : {}),
      ...(probe.error ? { error: probe.error } : {}),
      hint: describeWriteFailure({
        volume: mount.id,
        path: mount.containerPath,
        code: probe.code,
        service: "gateway",
      }),
    });
  }

  // --- (4) Replis du store + import unique de `models.json` -----------------
  for (const warning of config.warnings) {
    logger.warn("config.store.fallback", { detail: warning });
  }
  const modelsPath = join(env.piAgentDir, "models.json");
  if (config.isStoreEmpty() && existsSync(modelsPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(modelsPath, "utf8"));
      const imported = config.importLegacyModels(parsed);
      if (imported.length > 0) {
        logger.info("config.models.imported", { fields: imported, from: modelsPath });
      }
    } catch (error) {
      logger.warn("config.models.import_failed", {
        from: modelsPath,
        error: messageOf(error),
      });
    }
  }

  const profiles = loadProfiles(env.configDir);
  const manifest = loadCompatManifest(env.configDir);

  const detection = detectGpus({
    command: env.gpuCmd,
    fixture: env.gpuFixture,
    commandFromEnv: env.gpuCmdFromEnv,
  });

  const gateConfig: GateCompatConfig = {
    compatMode: config.getString("gpu.compatMode") as CompatMode,
    profile: config.getString("gpu.profile") || null,
    minDriver: config.getNumber("gpu.minDriver"),
  };
  const gate = runGate({ config: gateConfig, profiles, manifest, detection }, logger);

  if (!gate.passed) {
    // On NE sort PAS : la page `/config` doit rester joignable pour corriger le
    // profil. `gatePassed: false` ⇒ `/health/ready` reste 503.
    process.stdout.write(`${formatReportConsole(gate.report)}\n`);
    logger.error("gateway.startup refused (configuration à corriger via /config)", {
      resolvedProfile: gate.report.resolvedProfile,
      resolution: gate.report.resolution,
      missingCapabilities: gate.report.missingCapabilities,
    });
  }

  // --- LLM : config effective + disponibilité (aucun appel réseau) ----------
  const effective = effectiveLlmConfig(config);
  const llmConfig: LlmConfig = {
    providers: resolveProvidersFrom(effective),
    models: resolveModelsFrom(effective),
  };
  const resolveAvail = () => resolveAvailability(process.env, llmConfig);
  const availabilityPort: ModelAvailability = {
    isAvailable: (role) => resolveAvail().isAvailable(role),
  };

  const missingKeyMode = config.getString("llm.missingKeyMode") as LlmMissingKeyMode;
  const availabilityAtStart = resolveAvail();
  const missingKey = evaluateMissingKeyPolicy(availabilityAtStart, missingKeyMode);
  logger.info("llm.availability", {
    mode: missingKeyMode,
    light: availabilityAtStart.light.status,
    light_key: availabilityAtStart.light.keyPresent,
    heavy: availabilityAtStart.heavy.status,
    heavy_key: availabilityAtStart.heavy.keyPresent,
  });

  if (missingKey.refuse) {
    logger.error("gateway.startup refused (clé LLM manquante)", {
      missing: missingKey.missing,
      mode: missingKeyMode,
    });
    process.exitCode = 1;
    return;
  }

  const lightRef = llmConfig.models.light.reference;
  const lightThinking = llmConfig.models.light.defaultThinking;
  // Références « vivantes » (relues à chaque appel) : un changement de modèle
  // (`apply: hot`) profite aux NOUVELLES utilisations (jobs de fond, prochain
  // run de conversation) sans redémarrage. Les valeurs ci-dessus ne servent
  // qu'à l'initialisation (création du host, libellés de démarrage).
  const liveLightReference = (): string =>
    resolveModelsFrom(effectiveLlmConfig(config)).light.reference;
  const liveHeavyReference = (): string =>
    resolveModelsFrom(effectiveLlmConfig(config)).heavy.reference;
  const liveHeavyThinking = (): PiThinkingLevel =>
    effectiveLlmConfig(config).heavy.thinking;
  const liveLightThinking = (): PiThinkingLevel =>
    effectiveLlmConfig(config).light.thinking;
  const heavyAvailableAtStart = availabilityAtStart.isAvailable("heavy");

  const volumes = inspectMountPoints(mountPoints(env));
  const startedAt = Date.now();

  // --- Agents d'exécution (Lot 4) : store, audit, autorité interne, port machines --
  // Ces briques sont INDÉPENDANTES de la porte GPU et du PiHost : elles
  // démarrent même en mode dégradé. ⚠️ Comme le reste du câblage, leur
  // initialisation est BEST-EFFORT : une panne du volume `state` (CA
  // inscriptible) ou du port machines ne doit PAS empêcher le gateway humain
  // de fonctionner.
  const agentsBindHost = config.getString("agents.bindHost");
  const agentsPort = config.getNumber("agents.port");
  // CA + serveur machines déclarés HORS du `try` : le rechargement À CHAUD du
  // certificat serveur (voir `config.subscribe` plus bas) doit pouvoir les voir.
  let agentCa: CertificateAuthority | undefined;
  let agentsServer: ReturnType<typeof createAgentsServer> | undefined;
  let stopAgentsCertReload: (() => void) | undefined;
  let agentsDeps: AgentsApiDeps | undefined;
  let agentExecution: AgentExecutionService | undefined;
  let agentDirectory: AgentDirectoryService | undefined;
  /**
   * TRANSFERT de fichiers vers/depuis une machine (capacité `files`).
   * ⚠️ Créé APRÈS le stockage des fichiers (`filesStore`) : il en a besoin pour
   * déposer sur le disque de Yuki les octets récupérés.
   */
  let agentTransfers: AgentFileTransferService | undefined;
  /**
   * Références du bloc `try` agents, nécessaires au TRANSFERT de fichiers créé
   * APRÈS le stockage (`filesStore`). ⚠️ `undefined` si l'init agents a échoué :
   * dans ce cas, aucun transfert n'existe (l'outil n'est pas exposé non plus).
   */
  let agentStoreRef: AgentStore | undefined;
  let agentHubRef: AgentHub | undefined;
  let auditLogRef: AuditLog | undefined;
  /**
   * Mot de passe d'INSTANCE (haché scrypt, volume `state`) : sert au
   * déverrouillage des agents « matériel sensible ». `undefined` si le fichier
   * est illisible (on échoue FERMÉ : les agents sensibles restent verrouillés).
   */
  let instancePassword: InstancePasswordStore | undefined;
  /** Verrou des agents sensibles (état EN MÉMOIRE, jamais persisté). */
  let agentLock: AgentLockService | undefined;
  /** Arrêt des tâches périodiques du verrou (balayage). */
  let stopLockSweep: (() => void) | undefined;
  /**
   * Valeurs secrètes REÇUES À CHAUD (mot de passe d'instance, déverrouillage) :
   * elles doivent SURVIVRE à un rafraîchissement de la liste (changement de
   * config, mutation du coffre), sinon une fuite accidentelle ultérieure ne
   * serait plus masquée.
   */
  const typedSecretValues: string[] = [];
  /**
   * Mémorise une valeur secrète TRANSMISE par l'utilisateur (mot de passe
   * d'instance reçu par l'API) dans la liste PARTAGÉE des valeurs à masquer :
   * une fuite accidentelle ultérieure (log, audit) est ainsi masquée elle aussi.
   * La valeur n'est écrite NULLE PART ailleurs.
   */
  const rememberSecretValue = (value: string): void => {
    if (typeof value !== "string" || value.length < 6) return;
    if (!typedSecretValues.includes(value)) typedSecretValues.push(value);
    if (!secretValues.includes(value)) secretValues.push(value);
  };
  /** Coffre de secrets (façade). `undefined` tant que l'init agents n'a pas réussi. */
  let secretStore: SecretStore | undefined;
  /**
   * Rafraîchit la liste MUTABLE PARTAGÉE des valeurs à masquer (logger + audit) :
   * clés d'environnement, clés saisies dans /config, secrets du coffre, valeurs
   * reçues à chaud. Appelée au démarrage, à chaque changement de config ET à
   * chaque mutation du coffre.
   */
  const refreshSecretValues = (): void => {
    secretValues.splice(
      0,
      secretValues.length,
      ...collectSecretValues(),
      ...config.secretValues(),
      ...(secretStore?.values() ?? []),
      ...typedSecretValues,
    );
  };
  /** Port du registre d'agents vers le transport WS (encart de la barre latérale). */
  let agentsGateway: AgentsGatewayPort | undefined;
  try {
    // Mot de passe d'instance : SÉPARÉ des agents (nom neutre, réutilisable plus
    // tard pour un déverrouillage applicatif global). Illisible ⇒ on continue
    // sans lui mais on le DIT : aucun agent sensible ne serait déverrouillable.
    try {
      instancePassword = InstancePasswordStore.open({
        path: env.instancePasswordPath,
        logger,
      });
    } catch (error) {
      logger.error("agents.instance_password.unreadable", {
        path: env.instancePasswordPath,
        error: messageOf(error),
        hint: "Les agents « matériel sensible » resteront verrouillés : définissez un " +
          "nouveau mot de passe d'instance dans /config (ou corrigez le fichier).",
      });
    }
    const agentStore = AgentStore.open({
      path: env.agentsStorePath,
      defaults: {
        level: config.getString("agents.defaultLevel") as AgentLevel,
        // Privilège par défaut : compte normal (limite le mouvement latéral, D120).
        privilege: "normal",
      },
      logger,
      // ⚠️ PIÈGE : cocher « matériel sensible » SANS mot de passe d'instance
      // rendrait l'agent inutilisable POUR TOUJOURS ⇒ la coche est REFUSÉE.
      canMarkSensitive: () => instancePassword?.isConfigured() === true,
    });
    const auditLog = AuditLog.open({
      path: env.auditLogPath,
      maxSizeBytes: maxSizeBytesFromMb(config.getNumber("audit.maxSizeMb")),
      retentionDays: config.getNumber("audit.retentionDays"),
      // ⚠️ TROU COMBLÉ : l'audit partage la liste MUTABLE des secrets du logger
      // (clés d'env, clés saisies dans /config, secrets du coffre). Sans cela,
      // une valeur secrète présente dans une commande ou une méta d'audit serait
      // journalisée EN CLAIR (l'audit ne retombait que sur `process.env`).
      secretValues,
      logger,
    });
    agentCa = CertificateAuthority.open({
      dir: caDirectoryIn(dirname(env.agentsStorePath)),
      logger,
    });
    const pairingManager = new PairingManager({
      ca: agentCa,
      store: agentStore,
      audit: auditLog,
      logger,
    });
    // Canal d'exécution (B6) : registre des connexions vivantes + validations
    // humaines (B6bis) + service d'exécution (garde-fous D118).
    const agentHub = new AgentHub({ logger });
    // ⚠️ Références HISSÉES pour le service de TRANSFERT de fichiers, créé plus
    // bas (il a besoin du stockage des fichiers, lui-même créé après ce bloc).
    agentStoreRef = agentStore;
    agentHubRef = agentHub;
    auditLogRef = auditLog;
    const approvals = new ApprovalRegistry({ logger });
    // VERROU des agents « matériel sensible » (état EN MÉMOIRE, jamais persisté).
    // ⚠️ Il lit le store mais n'y ÉCRIT JAMAIS : un reverrouillage ne touche ni
    // le niveau ni aucune donnée de `agents.jsonl`.
    agentLock = new AgentLockService({
      store: agentStore,
      ...(instancePassword ? { password: instancePassword } : {}),
      logger,
    });
    // Un agent sensible est VERROUILLÉ au démarrage (table vide) et à chaque
    // RECONNEXION (redémarrage côté machine ⇒ nouveau cycle).
    agentLock.attachHub(agentHub);
    stopLockSweep = agentLock.startSweep();
    // Coffre de secrets CHIFFRÉ (AES-256-GCM). ⚠️ Clé maître HORS BANDE
    // (`YUKI_VAULT_KEY`) : sans elle, toute opération REFUSE (jamais de repli en
    // clair). À chaque mutation, on rafraîchit la liste partagée de redaction.
    secretStore = new SecretStore({
      path: env.secretsVaultPath,
      logger,
      onChange: () => refreshSecretValues(),
    });
    // Flux DÉDIÉ de fourniture de secret (couvre les agents SANS validation).
    const secretRequests = new SecretRequestRegistry({ logger });
    refreshSecretValues();
    // Encart agents de la barre latérale du chat : port LECTURE + bascule on/off
    // (`disabled` ⇄ niveau précédent) + abonnement aux changements. On ne
    // diffuse JAMAIS le secret : ici, un simple résumé.
    agentsGateway = {
      list: () =>
        agentStore.list().map((record) => {
          const lockStatus = agentLock?.status(record.agentId);
          return {
            agentId: record.agentId,
            name: record.name !== "" ? record.name : record.agentId,
            level: record.level,
            revoked: record.revoked,
            online: agentHub.isOnline(record.agentId),
            lastSeen: record.lastSeen,
            // État SÉPARÉ du niveau : `sensitive` = réglage, `locked` = éphémère.
            sensitive: record.sensitive === true,
            locked: lockStatus ? lockStatus.locked : false,
            ...(lockStatus?.remainingMs !== undefined
              ? { unlockRemainingMs: lockStatus.remainingMs }
              : {}),
          };
        }),
      setEnabled: (agentId, enabled) => {
        agentStore.setEnabled(agentId, enabled);
      },
      // Menu contextuel de l'agent : règle DIRECTEMENT le niveau (D118).
      // ⚠️ MÊME état que le on/off : `disabled` = off ; tout autre niveau = on
      // (le store mémorise le niveau pour la bascule on/off).
      setLevel: (agentId, level) => {
        agentStore.setLevel(agentId, level);
      },
      subscribe: (listener) => {
        // TROIS sources de changement : le registre (nom, niveau, révocation…),
        // le HUB (connexion / déconnexion) et le VERROU (déverrouillage et
        // reverrouillage automatique, qui ne touchent NI le store NI le hub).
        const offStore = agentStore.subscribe(listener);
        const offHub = agentHub.subscribe(listener);
        const offLock = agentLock ? agentLock.subscribe(listener) : () => undefined;
        return () => {
          offStore();
          offHub();
          offLock();
        };
      },
    };
    agentExecution = new AgentExecutionService({
      store: agentStore,
      hub: agentHub,
      audit: auditLog,
      approvals,
      logger,
      ...(secretStore ? { secrets: secretStore } : {}),
      secretRequests,
      ...(agentLock ? { lock: agentLock } : {}),
    });
    // Consultation des agents (extension) : LECTURE SEULE. Réutilise le même
    // store/hub/audit ; les outils sont exposés même quand l'exécution est
    // désactivée (consulter n'est pas exécuter). Le VERROU est lu ici aussi :
    // c'est ce qui fait apparaître `locked` dans `lister_agents`/`etat_agent` et
    // dans l'annuaire injecté au modèle à chaque tour.
    agentDirectory = new AgentDirectoryService({
      store: agentStore,
      hub: agentHub,
      audit: auditLog,
      ...(agentLock ? { lock: agentLock } : {}),
      logger,
    });
    if (agentsBindHost === "0.0.0.0") {
      // ⚠️ `0.0.0.0` écoute sur TOUTES les interfaces (y compris une interface
      // publique éventuelle). Le port machines n'étant protégé que par mTLS, il
      // est préférable de le restreindre à l'interface LAN (`agents.bindHost`).
      logger.warn("agents.bind.broad", {
        bindHost: agentsBindHost,
        hint: "Restreindre `agents.bindHost` à l'adresse de l'interface LAN (ex. 10.10.1.10).",
      });
    }
    // Certificat SERVEUR : le SAN doit couvrir TOUTES les adresses par
    // lesquelles un agent peut joindre Yuki (boucle locale + `agents.bindHost`
    // concret + chaque `agents.serverName` déclaré), sinon la vérification du
    // nom d'hôte côté agent refuse la poignée de main (« certificate is valid
    // for 127.0.0.1, not 10.10.0.5 »). ⚠️ AUCUNE détection automatique : Yuki
    // tourne en conteneur, `os.networkInterfaces()` ne voit pas l'IP de l'hôte
    // — l'adresse vient de `agents.serverName`. Le certificat est régénéré si
    // le SAN en place ne couvre pas l'ensemble attendu, ⚠️ sans jamais changer
    // la clé du CA (les agents déjà appairés restent valables).
    const currentServerNames = (): ReturnType<typeof serverCertificateNames> =>
      serverCertificateNames({
        bindHost: agentsBindHost,
        serverName: config.getString("agents.serverName"),
      });
    const agentsServerNames = currentServerNames();
    const agentsServerCert = agentCa.ensureServerCertificate(agentsServerNames);
    // Diagnostic : SAN effectif + adresses d'écoute locales. ⚠️ Aucune
    // inscription automatique ; on AVERTIT si une interface locale n'est pas
    // couverte — c'est exactement le piège « certificate is valid for …,
    // not <ip> » où un agent d'un autre sous-réseau vient d'échouer.
    const localAddresses = localIpAddresses();
    logger.info("agents.server_cert", {
      dns_names: agentsServerNames.dnsNames.join(","),
      ip_addresses: agentsServerNames.ipAddresses.join(","),
      local_addresses: localAddresses.join(","),
    });
    const uncovered = uncoveredLocalAddresses(agentsServerNames, localAddresses);
    if (uncovered.length > 0) {
      logger.warn("agents.server_cert.local_addresses_uncovered", {
        addresses: uncovered.join(","),
        server_name: config.getString("agents.serverName"),
        hint:
          "Une adresse d'interface locale de la machine n'est PAS couverte par le SAN " +
          "du certificat serveur : un agent qui joint Yuki par l'une d'elles échouera " +
          "la poignée de main TLS (« x509: certificate is valid for …, not <ip> »). " +
          "Ajoutez ces adresses, séparées par des virgules, à « agents.serverName » " +
          "(onglet Agents de /config) : le certificat serveur est rechargé À CHAUD, " +
          "sans ré-appairage. ⚠️ Si Yuki tourne dans un conteneur, ces adresses " +
          "peuvent être celles du conteneur et non de l'hôte : ne les déclarez que si " +
          "vos agents joignent réellement Yuki par elles.",
      });
    }
    if (
      agentsBindHost === "0.0.0.0" &&
      config.getString("agents.serverName").trim() === ""
    ) {
      // Message HONNÊTE : sans `serverName`, le SAN ne couvre que la boucle
      // locale. Un agent qui joint Yuki par une autre adresse (IP LAN, nom DNS)
      // échouera la vérification TLS — la cause est l'absence de déclaration,
      // aucune détection automatique n'est possible depuis le conteneur.
      logger.warn("agents.server_cert.loopback_only", {
        bindHost: agentsBindHost,
        hint:
          "`agents.serverName` est vide : le certificat serveur ne couvre que la " +
          "boucle locale (localhost, 127.0.0.1, ::1). Renseignez « agents.serverName » " +
          "(onglet Agents de /config) avec l'adresse ou le nom que vos agents utilisent " +
          "pour joindre Yuki (ex. 10.10.0.5 ou yuki.lan) ; sinon ils ne pourront " +
          "valider le certificat qu'en boucle locale.",
      });
    }
    agentsServer = createAgentsServer({
      certPem: agentsServerCert.certPem,
      keyPem: agentsServerCert.keyPem,
      caCertPem: agentCa.certificatePem,
      pairing: pairingManager,
      store: agentStore,
      audit: auditLog,
      ca: agentCa,
      hub: agentHub,
      logger,
    });

    // Rechargement À CHAUD du certificat serveur : modifier `agents.serverName`
    // depuis /config régénère le SAN si nécessaire puis recharge le contexte TLS
    // du port machines (`server.setSecureContext`) SANS redémarrer le gateway.
    // ⚠️ La clé du CA n'est jamais touchée ⇒ aucun ré-appairage nécessaire.
    stopAgentsCertReload = installServerCertificateReload({
      server: agentsServer,
      bindHost: agentsBindHost,
      ca: agentCa,
      config,
      logger,
    });
    agentsDeps = {
      pairing: pairingManager,
      store: agentStore,
      logger,
      hub: agentHub,
      audit: auditLog,
      approvals,
      // Verrou « matériel sensible » : déverrouillage/reverrouillage par l'API.
      ...(agentLock ? { lock: agentLock } : {}),
      // Toute valeur reçue (mot de passe) rejoint la liste des valeurs masquées.
      onSecretSeen: rememberSecretValue,
    };
    // Taille RÉELLE de l'annuaire au démarrage (observabilité d'exploitation) :
    // permet de retrouver dans les logs combien d'agents Yuki connaît — utile
    // pour diagnostiquer PLUS TARD un écart éventuel store ↔ runtime.
    logger.info("agents.ready", {
      ca_fingerprint: agentCa.fingerprint,
      store: env.agentsStorePath,
      audit: env.auditLogPath,
      store_agents: agentStore.size,
      store_agents_active: agentStore.list().filter((record) => !record.revoked).length,
    });
  } catch (error) {
    logger.error("agents.init.failed", { error: messageOf(error) });
  }

  // --- Voix TTS (Lot 7) : registre + client du moteur `audio.cpp` -----------
  // Le registre vit sur le volume dédié `yuki-voices` ; il ne dépend PAS du
  // service `tts` (la liste reste disponible même si le moteur est absent).
  // Le client n'est PAS câblé dans le flux de conversation (lot suivant).
  const voiceStore = new VoiceStore({ dir: env.voicesDir });
  const audioCpp = new AudioCppClient({
    baseUrl: config.getString("tts.baseUrl"),
    timeoutMs: config.getNumber("tts.timeoutMs"),
    logger,
  });

  // Chemin du volume des voix TEL QUE VU PAR LE CONTENEUR DU MOTEUR.
  // Le moteur `audio.cpp` est un processus SÉPARÉ qui monte `yuki-voices` en
  // lecture seule : le `refAudio` du registre est RELATIF (`presets/<id>.wav`,
  // `cloned/<id>.wav`) et n'a donc aucun sens pour lui. On construit un chemin
  // ABSOLU à partir du montage configuré (`YUKI_MOUNT_VOICES`, défaut
  // `/voices`) — chemin explicite, et non la constante implicite de l'adaptateur.
  // ⚠️ Les variantes Compose livrées montent le volume sur `/voices` côté
  // gateway COMME côté moteur ; si ces deux points de montage divergent, il faut
  // un champ de config dédié (voir `docs/lot8.md`, décision à confirmer).
  const voiceBaseDir = env.mountPoints.voices;

  /**
   * Sonde d'état du moteur (Lot 8). Cache court + rafraîchissement en tâche de
   * fond : `/health` n'attend JAMAIS la sonde (voir `TtsDiagnostics`).
   */
  const ttsDiagnostics = new TtsDiagnostics(
    {
      enabled: () => isTtsEnabled(config),
      engine: () => config.getString("tts.engine"),
      baseUrl: () => config.getString("tts.baseUrl"),
    },
    {
      timeoutMs: TTS_PROBE_TIMEOUT_MS,
      ttlMs: TTS_PROBE_CACHE_TTL_MS,
      logger,
    },
  );

  /** Point UNIQUE d'appel du moteur pour la synthèse (aperçu + test). */
  const synthesize = async (
    text: string,
    voice: Voice | null,
  ): Promise<{ contentType: string; bytes: Buffer; voiceRef: string | null }> => {
    // Garde-fou AVANT l'appel : un `refAudio` absent du volume produirait côté
    // moteur une erreur opaque (« requires speaker reference audio ») ; on
    // échoue ici, avec un message qui nomme le fichier manquant.
    voiceStore.assertSample(voice);
    const result = await audioCpp.synthesizeBuffer({
      voice,
      text,
      options: readTtsOptions(config),
      engine: config.getString("tts.engine"),
      // `voice_ref` = `<montage moteur>/<refAudio>` (absolu, cf. ci-dessus).
      voiceBaseDir,
    });
    return {
      contentType: result.contentType ?? "audio/wav",
      bytes: result.bytes,
      // Lu dans le corps RÉELLEMENT envoyé : le diagnostic ne peut pas mentir.
      voiceRef: voiceRefOf(result.request.body),
    };
  };

  /**
   * Synthétiseur du pipeline : même garde-fou de référence que `synthesize`
   * (aperçu + test), appliqué une fois par segment, avant tout appel moteur.
   */
  const segmentSynthesizerRaw = createAudioCppSynthesizer(audioCpp, { voiceBaseDir });
  const segmentSynthesizer: SegmentSynthesizer = async (request) => {
    voiceStore.assertSample(request.voice);
    return segmentSynthesizerRaw(request);
  };

  const voicesDeps: VoiceApiDeps = {
    store: voiceStore,
    logger,
    config: {
      getString: (path) => config.getString(path),
      update: (patch) => config.update(patch),
    },
    tts: {
      synthesizePreview: (voice) => synthesize(DEFAULT_TTS_TEST_TEXT, voice),
    },
  };

  // --- Configuration STRUCTURÉE du moteur `audio.cpp` (Lot 9, étape 1) -------
  // Le gateway monte le dossier de configuration du moteur en `rw`
  // (`YUKI_TTS_CONFIG_DIR`, défaut `/data/tts-config`) et le dossier des modèles
  // en `rw` (`/models`, lecture + écriture des futurs téléchargements, rangés par
  // convention dans `<models>/downloads`). Le moteur, lui, lit `/config/server.json`
  // et les modèles sous `/models` (monté `ro`).
  const engineConfigStore = new EngineConfigStore({
    configDir: env.ttsEngineConfigDir,
    engineConfigDir: env.ttsEngineConfigMountDir,
    modelsDir: env.mountPoints.models,
    engineModelsDir: env.ttsEngineModelsDir,
  });
  const engineCapabilities = new EngineCapabilitiesProbe(() =>
    config.getString("tts.baseUrl"),
  );
  const engineConfigPort: EngineConfigPort = {
    report: () => engineConfigStore.report(),
    applyPatch: (patch) => engineConfigStore.applyPatch(patch),
    revert: () => engineConfigStore.revert(),
    capabilities: () => engineCapabilities.probe(),
  };

  // --- Téléchargement des modèles (Lot 9, étape 2) ---------------------------
  // Registre DURABLE (volume `state`) : survit au redémarrage du gateway ; au
  // démarrage, une tâche non terminale devient `interrupted`. Le catalogue est
  // FERMÉ côté serveur (`src/tts/catalog-data.ts`) : aucune URL du client.
  const ttsDownloads = new TtsDownloadManager({
    registryPath: join(env.mountPoints.state, "tts-downloads.json"),
    modelsDir: env.mountPoints.models,
    engineModelsDir: env.ttsEngineModelsDir,
    logger,
  });

  const ttsDeps: TtsApiDeps = {
    config: {
      getString: (path) => config.getString(path),
      getNumber: (path) => config.getNumber(path),
    },
    logger,
    voices: { get: (id) => voiceStore.resolveVoice(id).voice },
    diagnostics: ttsDiagnostics,
    modelsDir: env.mountPoints.models,
    synth: { synthesize: ({ text, voice }) => synthesize(text, voice) },
    engineConfig: engineConfigPort,
    downloads: ttsDownloads,
  };

  logger.info("tts.voices.ready", {
    enabled: isTtsEnabled(config),
    engine: config.getString("tts.engine"),
    baseUrl: config.getString("tts.baseUrl"),
    voicesDir: env.voicesDir,
    voices: voiceStore.list().length,
  });

  // --- Notifications : clés VAPID + abonnements + service (PWA + Web Push) ---
  // ⚠️ La clé PRIVÉE VAPID est générée une seule fois, stockée en 0600 sur le
  // volume `state`, jamais exposée ; on l'ajoute à la liste MUTABLE des secrets
  // du logger pour qu'elle ne puisse pas fuiter dans un journal. L'initialisation
  // est BEST-EFFORT : une panne du volume `state` ne doit pas empêcher le gateway
  // humain de démarrer (les routes `/api/push/**` retombent alors en 404).
  let pushService: PushService | undefined;
  let pushDeps: PushApiDeps | undefined;
  try {
    const vapid = loadOrCreateVapidKeys(env.pushVapidPath, logger);
    if (vapid.created) {
      logger.info("push.vapid.created", { path: vapid.path });
    }
    // La clé privée est un SECRET : masquée partout dans les journaux.
    secretValues.push(vapid.keys.privateKey);
    const pushStore = new PushSubscriptionStore({
      path: env.pushSubscriptionsPath,
      logger,
    });
    const sender = createPushSender({
      keys: vapid.keys,
      subject: () => config.getString("push.contact"),
      logger,
    });
    pushService = createPushService({
      store: pushStore,
      publicKey: vapid.keys.publicKey,
      logger,
      enabled: () => config.getString("push.enabled") === "on",
      // Présence des clients connectés : le transport la déclare, le service
      // décide (jamais l'inverse). Absent ⇒ aucune présence connue ⇒ on notifie.
      presence: () => transport?.presenceView?.() ?? [],
      send: (subscription, payload) => sender.send(subscription, payload),
    });
    pushDeps = {
      store: pushStore,
      logger,
      enabled: () => config.getString("push.enabled") === "on",
      publicKey: vapid.keys.publicKey,
    };
    logger.info("push.ready", {
      enabled: config.getString("push.enabled") === "on",
      devices: pushStore.size,
      vapid: env.pushVapidPath,
      subscriptions: env.pushSubscriptionsPath,
    });
  } catch (error) {
    logger.error("push.init.failed", { error: messageOf(error) });
  }

  // --- Personnalité de Yuki (base du prompt, éditable/versionnée) -----------
  // Fichier SÉPARÉ du prompt système de sûreté, sur le volume `state`. Le store
  // est créé AVANT la porte GPU : l'API `GET/PUT /api/self/personality` reste
  // disponible en mode dégradé, comme la configuration.
  const personalityStore = new PersonalityStore({
    path: env.personalityPath,
    logger,
  });
  logger.info("personality.ready", {
    path: personalityStore.filePath,
    history: personalityStore.historyPath,
    journal: personalityStore.journalFilePath,
    chars: personalityStore.read().chars,
  });

  // --- Règles strictes de Yuki (consignes posées par l'utilisateur) ---------
  // Fichier SÉPARÉ (voisin de personality.md), édité UNIQUEMENT par
  // l'utilisateur ; Yuki ne peut pas les modifier. Comme la personnalité, le
  // store est créé AVANT la porte GPU : l'API `/api/self/rules` reste
  // disponible en mode dégradé.
  const rulesStore = new RulesStore({
    path: env.rulesPath,
    logger,
  });
  logger.info("rules.ready", {
    path: rulesStore.filePath,
    history: rulesStore.historyPath,
    journal: rulesStore.journalFilePath,
    chars: rulesStore.read().chars,
  });

  // --- SOURCES : programmes extérieurs qui réveillent Yuki -------------------
  // ⚠️ Deux fichiers JSON DÉDIÉS du volume `state`, JAMAIS dans `config.json`
  // (la configuration n'accepte qu'un patch PLAT de scalaires) :
  //   - `sources.json`       : les déclencheurs, modèle **v2** (`visibilite`,
  //     `declencheur`, `destination`…). Un fichier v1 est migré en `visible`
  //     après sauvegarde `sources.json.v1.bak` (voir `src/sources/store.ts`) ;
  //   - `sources-inbox.json` : la boîte « Notifications » (≤ 200 entrées, refus
  //     explicite au-delà) + la mémoire d'idempotence `(source, id)` de 7 jours.
  // Plus un JOURNAL append-only (`declencheurs-journal.jsonl`) : la seule trace
  // des contenus reçus par un déclencheur SILENCIEUX (jamais dans l'UI).
  // Le service est créé AVANT la porte GPU : gérer une source et lire la boîte ne
  // demandent aucun modèle (le host est branché plus bas par `setWaker`).
  const sourcesStore = new SourcesStore({ path: env.sourcesStorePath, logger });
  const sourcesInbox = new SourcesInbox({ path: env.sourcesInboxPath, logger });
  const declencheursJournal = DeclencheurJournal.open({
    path: env.declencheursJournalPath,
    logger,
  });
  // --- PRÉ-AUTORISATIONS (lot 26, lot 4/4) ------------------------------------
  // ⚠️ Fichier DÉDIÉ du volume `state` (`preautorisations.json`) : ce qu'un
  // DÉCLENCHEUR peut exécuter SANS validation humaine. Il écrit ses
  // consommations dans le JOURNAL des déclencheurs (créé juste au-dessus), ce qui
  // explique qu'il soit construit APRÈS le service d'exécution et branché par
  // `setPreAutorisations` (comme `setWaker`).
  const preAutorisationsStore = new PreAutorisationStore({
    path: env.preAutorisationsPath,
    logger,
    journal: declencheursJournal,
  });
  agentExecution?.setPreAutorisations(preAutorisationsStore);
  logger.info("agents.preautorisations.ready", {
    path: env.preAutorisationsPath,
    preautorisations: preAutorisationsStore.size,
  });

  const sourcesService = new SourcesService({
    store: sourcesStore,
    inbox: sourcesInbox,
    journal: declencheursJournal,
    logger,
    // Le coffre porte les JETONS (`YUKI_SOURCE_<NOM>`), jamais le fichier JSON.
    ...(secretStore ? { tokens: secretStore } : {}),
    // Borne d'injection du bloc `<sources>` : relue à chaud (`apply: hot`).
    promptTotalChars: () => config.getNumber("sources.promptTotalChars"),
    // « notifier » : Web Push à l'appareil. Le CONTENU n'est jamais recopié dans
    // la notification (on annonce du nouveau, on ne diffuse pas la donnée).
    notify: (event) => {
      if (!pushService) return;
      void pushService
        .notify({ kind: "source", ...(event.titre ? { detail: event.titre } : {}) })
        .catch((error: unknown) => {
          logger.warn("sources.notify.failed", { source: event.source, error: messageOf(error) });
        });
    },
  });
  logger.info("sources.ready", {
    store: env.sourcesStorePath,
    inbox: env.sourcesInboxPath,
    journal: env.declencheursJournalPath,
    sources: sourcesStore.size,
    entries: sourcesInbox.size,
  });

  /** Balayage périodique de la RÉTENTION du volume `state` (voir plus bas). */
  let filesPurgeTimer: ReturnType<typeof setInterval> | undefined;

  /**
   * ⚠️ MOTEUR HORLOGE (lot 2) : le balayeur des déclencheurs `planning`.
   * Créé quand le host est prêt (voir plus bas), arrêté à l'arrêt gracieux.
   */
  let declencheursBalayeur: DeclencheurBalayeur | undefined;
  /**
   * Consolidation HEBDOMADAIRE de la mémoire (lot 29) : déclenchée par le
   * balayeur existant, jamais par un second `setInterval`.
   */
  let consolidationHebdo: ConsolidationHebdo | undefined;

  // --- Fichiers échangés (l'utilisateur → Yuki, Yuki → l'utilisateur) -------
  // ⚠️ Créé AVANT la porte GPU : le dépôt et le téléchargement restent
  // disponibles même en mode dégradé (aucun modèle requis pour stocker un
  // fichier). Les BORNES (plafond par fichier, rétention, borne d'injection) sont
  // relues dans la configuration À CHAQUE opération : un changement dans `/config`
  // s'applique sans redémarrage.
  const filesStore = new FilesStore({
    dir: env.filesDir,
    logger,
    maxBytes: () => config.getNumber("files.maxFileBytes"),
    retentionDays: () => config.getNumber("files.retentionDays"),
  });
  filesStore.ensureLayout();
  // --- AVATAR de Yuki ---------------------------------------------------------
  // ⚠️ PERSISTANT et HORS du magasin de fichiers : `filesStore` purge réellement
  // (rétention de 30 jours par défaut), une image de marque ne doit pas subir
  // cette règle. `state/avatar/` ne connaît donc AUCUNE expiration.
  const avatarStore = new AvatarStore({ dir: env.avatarDir });
  // Purge RÉELLE au démarrage : un fichier expiré pendant l'arrêt est supprimé
  // avec son analyse (le plafond ne sert à rien si l'expiré reste).
  const purgedFilesAtStart = filesStore.purgeExpired();
  const filesService = createFilesService({
    store: filesStore,
    logger,
    maxAttachments: () => config.getNumber("files.maxAttachments"),
    promptChars: () => config.getNumber("files.promptChars"),
    promptTotalChars: () => config.getNumber("files.promptTotalChars"),
    // ⚠️ Plafond des images TRANSMISES AU MODÈLE : lu À CHAQUE message (apply:
    // hot). Sans ce branchement, le réglage serait mort — et une image de 40 Mo
    // partirait en base64 sur le fil.
    imageMaxBytes: () => config.getNumber("files.imageMaxBytes"),
    // ⚠️ PLAFOND EN OCTETS TRANSMIS (base64 ×1,33) : c'est LUI que le fournisseur
    // compte, et c'est lui qui manquait (`500 « request entity too large »`).
    imageMaxWireBytes: () => config.getNumber("files.imageMaxWireBytes"),
    // ⚠️ RÉDUCTION À LA VOLÉE (`resizeImage` du SDK, Photon/WASM) : l'original
    // stocké n'est jamais touché, la version réduite est éphémère. Sans ce
    // branchement, aucune image hors bornes ne pourrait être réduite (elle serait
    // refusée) : le chemin de vision ne serait pas complet.
    imageResizer: sdkVisionImageResizer,
  });
  // Balayage périodique : la rétention est une BORNE DE DISQUE, pas une promesse.
  // ⚠️ Le MÊME balayage purge les pièces jointes, les images générées et les
  // captures du libraire (voir `purgeStateVolume`) : un seul réglage, une seule
  // passe ⇒ impossible qu'un type survive au réglage d'un autre.
  filesPurgeTimer = setInterval(purgeStateVolume, FILES_PURGE_INTERVAL_MS);
  filesPurgeTimer.unref?.();
  // --- TRANSFERT de fichiers vers/depuis une machine appairée (capacité `files`)
  // ⚠️ Négocié par CAPACITÉ, jamais par un bump de `proto.Version` (un incrément
  // ferait refuser TOUS les agents déployés, `proto/codec.go`). Les trois bornes
  // sont RELUES à chaque transfert (`apply: hot`). Registre persistant sur le
  // volume `state` : il survit à un redémarrage du gateway, qui marque alors
  // toute entrée `in_progress` comme `interrupted` (jamais un succès partiel).
  if (agentExecution && agentStoreRef && agentHubRef && auditLogRef) {
    try {
      agentTransfers = new AgentFileTransferService({
        store: agentStoreRef!,
        hub: agentHubRef!,
        audit: auditLogRef!,
        logger,
        files: filesStore,
        // ⚠️ VISION : l'image d'un fichier récupéré est préparée par le MÊME
        // service que les pièces jointes d'un message (bornes de vision, refus
        // explicite, réduction éphémère). C'est ce qui permet à
        // `recuperer_fichier` de MONTRER l'image au modèle au lieu de la
        // seulement déposer sur disque.
        prepareImages: (files) => filesService.prepareImages(files),
        registryPath: env.agentTransfersPath,
        limits: {
          maxBytes: () => config.getNumber("files.agentMaxBytes"),
          chunkBytes: () => config.getNumber("files.agentChunkBytes"),
          timeoutMs: () => config.getNumber("files.agentTimeoutMs"),
        },
        // ⚠️ MÊME garde-fou PAR AGENT (D118) que toute action : aucun second
        // mécanisme de validation.
        authorize: (request) =>
          agentExecution!.authorizeTransfer(request.agentId, request.command, {
            origin: request.origin,
            ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
          }),
      });
      logger.info("agents.transfers.ready", {
        registry: env.agentTransfersPath,
        maxBytes: config.getNumber("files.agentMaxBytes"),
        chunkBytes: config.getNumber("files.agentChunkBytes"),
        timeoutMs: config.getNumber("files.agentTimeoutMs"),
      });
    } catch (error) {
      logger.warn("agents.transfers.init_failed", { error: messageOf(error) });
      agentTransfers = undefined;
    }
  }
  logger.info("files.ready", {
    dir: env.filesDir,
    purged: purgedFilesAtStart,
    retentionDays: config.getNumber("files.retentionDays"),
    maxFileBytes: config.getNumber("files.maxFileBytes"),
    imageMaxBytes: config.getNumber("files.imageMaxBytes"),
    imageMaxWireBytes: config.getNumber("files.imageMaxWireBytes"),
    promptChars: config.getNumber("files.promptChars"),
    promptTotalChars: config.getNumber("files.promptTotalChars"),
  });

  // --- Images générées (serveur ComfyUI) ------------------------------------
  // ⚠️ Ces briques ne dépendent NI de la porte GPU NI du PiHost : le stockage,
  // le client HTTP et le générateur existent même en mode dégradé, ce qui permet
  // d'importer des workflows et de tester la connexion depuis `/config` avant que
  // la conversation ne fonctionne.
  //
  // - les WORKFLOWS vivent dans un fichier SÉPARÉ du volume `state` (un graphe
  //   pèse des dizaines de Ko : jamais dans `config.json`) ;
  // - les IMAGES vivent dans `${state}/comfy/images` et sont servies en
  //   SAME-ORIGIN (`/images/<id>.<ext>`) : la CSP n'est pas élargie ;
  // - l'URL et la CLÉ du serveur sont relues À CHAQUE appel (aucun redémarrage).
  const comfyWorkflows = new ComfyWorkflowStore({
    path: env.comfyWorkflowsPath,
    logger,
  });
  const comfyImages = new GeneratedImagesStore({
    dir: env.comfyImagesDir,
    logger,
    // ⚠️ MÊME réglage que les pièces jointes (`files.retentionDays`) : pas de 2ᵉ
    // réglage de rétention pour les images. Relu à chaque dépôt ⇒ un changement
    // dans `/config` s'applique à la génération suivante, sans redémarrage.
    retentionDays: () => config.getNumber("files.retentionDays"),
  });
  comfyImages.ensureLayout();
  // Purge RÉELLE au démarrage : une image expirée pendant l'arrêt est supprimée
  // (une rétention sans purge au démarrage laisserait le disque se remplir).
  const purgedImagesAtStart = comfyImages.purgeExpired();
  const comfyClient = new ComfyClient({
    config: () => ({
      baseUrl: config.getString("images.baseUrl"),
      apiKey: config.getString("images.apiKey"),
    }),
    logger,
    // ⚠️ PLAFOND DE SÉCURITÉ de la génération, réglable à chaud (10 s à 2 h,
    // 1 h par défaut) : ce n'est PAS le mécanisme d'arrêt — le client demande
    // à ComfyUI l'état de sa file (`GET /queue`) et attend tant que le serveur
    // dit qu'il travaille (une vidéo de 10 min passe donc). Un travail qui
    // DISPARAÎT de la file sans résultat est constaté en 30 s, pas au plafond.
    generationTimeoutMs: () => config.getNumber("images.timeoutMs"),
  });
  const comfyGenerator = createComfyGenerator({
    client: comfyClient,
    workflows: comfyWorkflows,
    images: comfyImages,
    sizes: () => ({
      width: config.getNumber("images.width"),
      height: config.getNumber("images.height"),
    }),
    logger,
  });
  logger.info("comfy.ready", {
    workflows: comfyWorkflows.size,
    imagesDir: env.comfyImagesDir,
    purged: purgedImagesAtStart,
    retentionDays: config.getNumber("files.retentionDays"),
    configured: config.getString("images.baseUrl").trim() !== "",
  });

  /**
   * COPIE d'une image générée dans le store des FICHIERS de la conversation.
   *
   * ⚠️ POURQUOI : sans elle, une image générée n'existe que dans le store des
   * images (`/images/<id>.<ext>`) — que `lister_fichiers`, `lire_fichier` et
   * `deposer_fichier` ne résolvent PAS (ils n'acceptent que les identifiants du
   * store des fichiers). Le parcours « générer → lister → lire → déposer »
   * restait donc cassé.
   *
   * ⚠️ DEUX COPIES, DEUX PURGES ? Les deux fiches suivent le MÊME réglage
   * (`files.retentionDays`) et la MÊME règle (`files/retention.ts`), mais elles
   * expirent SÉPARÉMENT : la copie de la conversation fait foi pour l'usage
   * « fichier de la conversation » (lister/lire/déposer), l'image du store Comfy
   * fait foi pour l'affichage dans le fil. Une copie expirée est refaite si
   * l'image est régénérée/copiée à nouveau (la déduplication ne s'applique qu'à
   * une copie encore valable).
   */
  const generatedImageFiles = createGeneratedImageFiles({
    files: filesStore,
    images: comfyImages,
    logger,
  });

  /**
   * Balayage UNIQUE de la rétention du volume `state` : pièces jointes, images
   * générées par ComfyUI et captures du libraire.
   *
   * ⚠️ PIÈGE ④ : une rétention sans balayage ne purge rien — un fichier que
   * personne ne relit resterait indéfiniment. Les trois stores partagent le MÊME
   * réglage (`files.retentionDays`), la MÊME règle de calcul
   * (`src/files/retention.ts`) et la MÊME passe périodique.
   *
   * Déclaré en FONCTION (hissée) : le balayage est posé AVANT la création des
   * stores d'images et de captures, mais ne les lit qu'à l'exécution.
   */
  function purgeStateVolume(): void {
    try {
      filesStore.purgeExpired();
    } catch (error) {
      logger.warn("files.purge.failed", { error: messageOf(error) });
    }
    try {
      comfyImages.purgeExpired();
    } catch (error) {
      logger.warn("comfy.image.purge.failed", { error: messageOf(error) });
    }
    try {
      librarianShots?.purgeExpired();
    } catch (error) {
      logger.warn("librarian.shot.purge.failed", { error: messageOf(error) });
    }
  }

  // --- Jobs, délégation, PiHost (uniquement si la porte est passée) ---------
  let piStatus: "starting" | "ready" | "error" = "starting";
  let sessionsCount = 0;
  let activeRuns = 0;
  let host: PiHost | undefined;
  let memoryService: MemoryService | undefined;
  let heritageStore: HeritageStore | undefined;
  let conversationArchive: ConversationArchiveStore | undefined;
  let librarianShots: LibrarianShotsStore | undefined;
  /**
   * Ports du LIBRAIRE pour un run DISTANT (posés quand la porte GPU est passée).
   *
   * ⚠️ Pourquoi un porteur MUTABLE plutôt que la valeur au démarrage : le run
   * distant construit ses outils à CHAQUE réponse, et le client d'archivage est
   * créé DANS le bloc de la porte GPU (const local). Le run lit donc ce porteur
   * au moment de la réponse, jamais à la construction du générateur.
   */
  let remoteLibrarian: RemoteRunLibrarianPorts | undefined;
  /** Bus de diffusion des images générées (posé quand le transport démarre). */
  let imagesGateway: ImagesGatewayPort | undefined;
  let transport: Transport | undefined;
  let delegation: DelegationService | undefined;
  /** Désabonnement du rechargement À CHAUD des modèles LLM (voir plus bas). */
  let stopLlmHotReload: (() => void) | undefined;
  /** Désabonnement de l'annonce du FUSEAU des horodatages (voir plus bas). */
  let stopTimeZoneReload: (() => void) | undefined;

  /**
   * FUSEAU des horodatages — POINT UNIQUE côté serveur (réglage `ui.timeZone`,
   * défaut `UTC`).
   *
   * ⚠️ Relu À CHAQUE appel (`apply: hot`) : prompts locaux, fils de canal,
   * préfixes stockés, trames `welcome`/`time_zone`. Jamais le fuseau du PROCESS
   * (le conteneur peut être en UTC ou non) : `src/pi/timestamp.ts` reçoit
   * toujours ce fuseau explicitement.
   */
  const fuseauHorodatage = (): string =>
    effectiveTimeZone(config.getString("ui.timeZone"));
  /** Désabonnement des DÉCLENCHEURS de notification (voir plus bas). */
  let stopPushTriggers: (() => void) | undefined;

  /**
   * RÉACTIONS de l'utilisateur aux messages de Yuki (volume `state`, fichier
   * SÉPARÉ). Créé AVANT la porte GPU : la couche transport le reçoit plus bas.
   * ⚠️ Une réaction n'est NI un message NI un souvenir : elle ne déclenche aucun
   * tour et ne va jamais dans le JSONL de session.
   */
  const reactionStore = ReactionStore.open({
    path: env.reactionsStorePath,
    logger,
  });
  logger.info("reactions.ready", {
    path: reactionStore.filePath,
    count: reactionStore.size,
  });

  /**
   * Une RÉGULARITÉ de réactions devient (ou non) un SOUVENIR — avec les gardes
   * EXISTANTS de la mémoire durable :
   *  - le texte est écrit par le CODE (`regularityMemory`, déterministe) ;
   *  - `MemoryService.onReactionRegularity` applique le filtre déterministe, exige
   *    la justification (`why`), puis la déduplication (texte identique et
   *    quasi-doublon) avant d'écrire ;
   *  - une réaction ISOLÉE n'arrive jamais ici (seuil dans `ReactionStore`).
   */
  function rememberReactionRegularity(regularity: ReactionRegularity): void {
    const candidate = regularityMemory(regularity);
    if (!candidate || !memoryService) return;
    memoryService.onReactionRegularity?.({
      ...candidate,
      source: REACTIONS_SOURCE,
    });
  }

  // DISCUSSIONS (lot 18) : MIROIR PERSISTANT des canaux distants (index JSON +
  // un JSONL append-only par canal), ouvert AVANT le service pour que l'interface
  // puisse lister les canaux dès le démarrage. Aucun modèle n'est requis : un
  // miroir se lit même en mode dégradé.
  const chatMirror = ChatMirrorStore.open({
    indexPath: env.chatMirrorPath,
    messagesDir: env.chatMirrorDir,
    logger,
  });

  /**
   * Libraire CONFIGURÉ (URL de base renseignée) et CAPTURES de pages web activées.
   *
   * ⚠️ Lus À CHAUD ici : `lightToolOptions` est partagée par le host local (créé au
   * démarrage, porte GPU) et par un run distant (calculé à chaque réponse). Au
   * démarrage, ces deux lectures donnent EXACTEMENT les valeurs figées utilisées par
   * le host : la politique locale ne change pas d'un élément.
   */
  const librarianConfiguredNow = (): boolean =>
    config.getString("librarian.baseUrl").trim() !== "";
  const librarianCaptureEnabledNow = (): boolean =>
    librarianConfiguredNow() && config.getString("librarian.screenshot") === "on";

  /**
   * Options de POLITIQUE d'outils du rôle LÉGER — UNE SEULE source.
   *
   * ⚠️ Utilisée à l'IDENTIQUE par le host de la conversation locale (`createPiHost`,
   * plus bas) et par un run DISTANT (réponse publiée dans un canal). Ajouter un outil
   * ici l'ajoute aux deux ; oublier de le retirer là-bas n'est pas possible, il n'y a
   * pas de seconde liste. Le calcul final reste `toolAllowlistForChat`
   * (`src/llm/tool-policy.ts`), qui RETIRE de tout run distant les outils exigeant une
   * approbation humaine (impossible à donner depuis un canal).
   */
  const lightToolOptions = (): ToolAllowlistOptions => ({
    // ⚠️ PROFIL DU BOT ACTIF (lot 35f) : il INTERSECTE l'allowlist ci-dessous dans
    // `toolAllowlist`/`toolAllowlistForChat` (`filtrerSelonProfil`). Placé ICI, il
    // vaut pour le host LOCAL **et** pour chaque run de CANAL : il n'y a pas de
    // seconde liste à filtrer. `complet` n'enlève rien.
    profil: profilBot,
    // ⚠️ Délégation : il faut un worker lourd (donc le profil `complet`) ET le
    // modèle lourd disponible. Sans worker, rien ne peut être délégué.
    delegationEnabled: heavyAvailableAtStart && workerLourdAutorise(profilBot),
    // ⚠️ INVERSION DES RÔLES : le LÉGER n'a AUCUN outil d'action. Il garde
    // la lecture, la conversation, la délégation, l'annuaire des agents,
    // l'archive et le libraire (consultation). `run_command` et
    // `capturer_ecran` sont portés par le worker lourd (voir plus haut).
    // ⚠️ Indépendant de l'exécution : consulter les agents n'est pas
    // exécuter. Actif dès que le registre d'agents existe.
    directoryEnabled: agentDirectory !== undefined,
    // Secrets : consulter les NOMS (jamais les valeurs) pour savoir quoi
    // référencer en délégation. Actif dès que le coffre est initialisé.
    secretsEnabled: secretStore !== undefined,
    // DEMANDE de secret (`demander_secret`) : ouvre une fenêtre de saisie
    // DANS la conversation. Actif dès que le service d'exécution expose le
    // port de demande (le coffre doit être utilisable).
    secretRequestsEnabled: agentExecution !== undefined,
    // Lot 13 : l'archive « vie antérieure » est consultable à la demande.
    heritageEnabled: true,
    // Archive des conversations mises de côté : recherche PLEIN TEXTE en
    // LECTURE SEULE, sur demande EXPLICITE de l'utilisateur.
    conversationArchiveEnabled: conversationArchive !== undefined,
    // Libraire : quatre outils + capture (selon l'URL et le réglage au
    // démarrage ; décision prise à la création du host).
    librarianEnabled: librarianConfiguredNow(),
    librarianCaptureEnabled: librarianCaptureEnabledNow(),
    // FICHIERS : `envoyer_fichier` (Yuki RENVOIE un fichier de la
    // conversation). Toujours actif : le stockage existe dès le démarrage.
    filesEnabled: true,
    // IMAGES générées : l'outil `generer_image` est TOUJOURS proposé (il
    // refuse explicitement tant qu'aucune URL de serveur n'est configurée,
    // avec la marche à suivre) — configurer ComfyUI ne demande donc aucun
    // redémarrage.
    imagesEnabled: true,
    // ⚠️ ENVOI DE MESSAGE (`envoyer_message`, 2026-11-04) : TOUJOURS actif. Il publie
    // dans la conversation où Yuki répond, par le chemin de publication ordinaire
    // (`ReplyProgress` en canal, `publierMessage` en local) — il n'ouvre rien et ne
    // touche à aucune machine. C'est lui qui permet une réponse étalée sur plusieurs
    // messages successifs (« une décimale par message »), y compris dans le fil
    // « Déclencheurs », qui est une session LOCALE.
    messagesEnabled: true,
    // ⚠️ ENVOI PROGRAMMÉ (`programmer_envoi`, lot 28) : TOUJOURS actif, pour la même
    // raison que `envoyer_message` — c'est un message, pas une action. C'est l'outil
    // qui manquait quand Yuki a répondu « je n'ai pas de minuteur » (2026-11-04) : le
    // planificateur existait déjà (lot 2), il n'avait pas de porte d'entrée.
    envoisProgrammesEnabled: true,
    // ⚠️ TÂCHE PLANIFIÉE (`planifier_tache`, lot 31) : TOUJOURS actif — « à 8 h, résume-moi
    // le journal » n'était jusqu'ici qu'un envoi de texte figé. L'outil ne fait rien
    // maintenant : il programme une DEMANDE que le worker lourd exécutera à l'heure dite.
    // ⚠️ Le worker lourd ne l'obtient pas (`TOOL_POLICY.heavy.planifierTaches: []`) : une
    // tâche de fond ne programme pas de tâche de fond.
    planifierTacheEnabled: true,
  });

  /**
   * Écrivain d'un canal distant (JUGE du mode `auto`, RÉDACTEUR de la réponse).
   *
   * ⚠️ Modèle LÉGER et réflexion `off` : juger un message ou rédiger trois phrases
   * n'est pas une tâche de raisonnement long. `timeoutMs` est BORNÉ par usage (un juge
   * lent retarderait la réponse au message). Modèle introuvable ⇒ l'écrivain LÈVE, et
   * l'appelant le traduit en refus explicite (jamais une réponse vide publiée).
   *
   * ⚠️ `run` (facultatif) porte la POLITIQUE et les OUTILS du run : seul le
   * RÉDACTEUR d'une réponse en reçoit — le juge n'exécute rien.
   */
  const chatWriter = (
    systemPrompt: string,
    /**
     * Délai de l'appel (ms) — FIXE ou RELU à chaque tour.
     *
     * ⚠️ La réponse d'un CANAL le passe en FONCTION : la borne dépend des outils
     * longs réellement autorisés INLINE, donc de la politique du run, recalculée à
     * chaque réponse (`apply: hot`). Une valeur figée à la construction ignorerait
     * un changement de `chat.remoteAgents` sans redémarrage.
     */
    timeoutMs: number | (() => number),
    label: string,
    run?: {
      tools: () => readonly string[];
      customTools: () => readonly unknown[];
      /**
       * EXTENSIONS du run : la CONSIGNE D'ACCUSÉ (`ackRuleFor(tools)`) et, sous
       * `actives` seulement, la RÈGLE DE DÉLÉGATION + la liste des jobs du canal
       * (`createRemoteRunTools`, `src/pi/chat-run.ts`).
       */
      extensionFactories?: () => readonly unknown[];
      onTool?: (event: SdkToolEvent) => void;
    },
  ) =>
    createSdkPromptWriter({
      cwd: env.piCwd,
      agentDir: env.piAgentDir,
      authPath: join(env.piAgentDir, "auth.json"),
      modelsPath,
      systemPrompt,
      modelReference: liveLightReference,
      thinking: "off",
      timeoutMs: typeof timeoutMs === "function" ? timeoutMs : () => timeoutMs,
      logger,
      label,
      ...(run
        ? {
            tools: run.tools,
            customTools: run.customTools,
            ...(run.extensionFactories ? { extensionFactories: run.extensionFactories } : {}),
            ...(run.onTool ? { onTool: run.onTool } : {}),
          }
        : {}),
    });

  /**
   * PUBLICATION d'un texte (et, facultativement, d'un fichier du store) dans un
   * CANAL distant — Mattermost ou Discord, selon l'identifiant de conversation.
   *
   * ⚠️ Deux usages seulement, et aucun n'est le chemin NORMAL d'une réponse :
   *  - le FICHIER envoyé par `envoyer_fichier` (Yuki, dans son tour) ;
   *  - le REPLI du réveil de job, quand le tour de Yuki n'a pas pu avoir lieu
   *    (`createChannelAwareWaker`, plus bas) — c'est le SEUL cas où le serveur
   *    écrit de lui-même, et il le dit.
   * La plateforme est déduite de l'identifiant miroir (`mm-…`/`dc-…`) : un run né
   * dans un salon Discord poste sur Discord même si l'interface affiche Mattermost
   * (lot 21).
   *
   * ⚠️ Lève quand l'envoi est impossible (plateforme inconnue, adaptateur sans
   * `send`, canal absent du miroir) : l'appelant journalise — jamais un échec
   * silencieux qui laisserait quelqu'un attendre.
   */
  const envoyerDansCanal = async (
    conversationId: string,
    text: string,
    fichiers?: readonly string[],
    filDe?: string,
  ): Promise<void> => {
    const plateforme = mirrorPlatformOf(conversationId);
    if (!plateforme) {
      throw new Error(
        `Conversation « ${conversationId} » : la plateforme du canal est inconnue.`,
      );
    }
    const adapter = getAdapter(plateforme);
    if (!adapter.send) {
      throw new Error(
        `La plateforme « ${plateforme} » n'accepte aucun envoi de message.`,
      );
    }
    await adapter.send(conversationId, {
      kind: "texte",
      text,
      ...(fichiers && fichiers.length > 0 ? { fichiers } : {}),
      // ⚠️ `root_id` : répondre DANS un fil existant, jamais à la racine par accident.
      ...(filDe !== undefined && filDe !== "" ? { threadRootId: filDe } : {}),
    });
  };

  /**
   * PORT de publication inter-canal (`publier_dans_canal`) — FABRIQUÉ ICI, UNE SEULE
   * DÉFINITION, pour ses DEUX porteurs :
   *  - les RUNS de canal (`createRemoteReplyGenerator`, ci-dessous) ;
   *  - le WORKER LOURD (`createSdkHeavyWorker`, plus bas) : depuis le 2026-11-02 il
   *    peut publier le livrable d'un job (une image) dans un AUTRE canal, parce que
   *    c'est LUI qui le produit — sans cet outil, l'image retombait dans le canal de
   *    conversation, ce que l'utilisateur refusait explicitement.
   *
   * ⚠️ Le périmètre « canaux SUIVIS, même plateforme » est tenu par le PORT
   * (`src/chat/reply/channel-post.ts`), jamais par le modèle : un nom inventé est
   * refusé avec la marche à suivre (Configuration → Conversation → « Discussions —
   * Mattermost / Discord »). `conversationSource` est la garde ANTI-FUITE : un
   * fichier joint ne peut venir QUE de la conversation propriétaire (un identifiant
   * volé ailleurs est refusé, et les conversations LOCALES restent hors de portée).
   */
  const portDePublication = (
    /**
     * Conversation PROPRIÉTAIRE des fichiers joints, ou `undefined`.
     *
     * ⚠️ `undefined` = AUCUN contrôle d'appartenance, et c'est réservé à UN cas : la
     * publication d'un ENVOI PROGRAMMÉ (`publierEnvoiProgramme`, plus bas). Les
     * fichiers y ont été validés à la PROGRAMMATION (conversation source du run,
     * plateforme, taille), et à l'heure dite il n'y a plus de run — la cible n'est donc
     * pas la conversation d'origine. Les enregistrements ne peuvent venir que du
     * service (`envois-programmes.json`, écrit par le serveur seul).
     */
    conversationSource: string | undefined,
    plateforme: RemotePlatform,
  ) =>
    createChannelPostPort({
      plateforme,
      ...(conversationSource !== undefined ? { conversationSource } : {}),
      canaux: () =>
        chatMirror.conversations().map((conversation) => ({
          conversationId: conversation.id,
          titre: conversation.title,
          plateforme: conversation.platform,
        })),
      // ⚠️ UN SEUL mécanisme d'envoi : `envoyerDansCanal` (téléversement +
      // `file_ids` + échec VISIBLE). Aucun second chemin de fichiers.
      envoyer: ({ conversationId: cible, texte, filDe, fichierIds }) =>
        envoyerDansCanal(cible, texte, fichierIds, filDe),
      // ⚠️ RÉSOLUTION CÔTÉ SERVEUR des identifiants du store : propriété
      // (`sessionId`) et taille, jamais un chemin disque. Un identifiant
      // inconnu/expiré est refusé, jamais ignoré en silence.
      fichier: (fichierId) => filesStore.get(fichierId),
      // Borne de taille par fichier : celle du dépôt (`files.maxFileBytes`),
      // appliquée AVANT l'appel réseau (un binaire ne se tronque pas).
      maxFichierBytes: () => config.getNumber("files.maxFileBytes"),
      // Le fil demandé doit exister dans CE canal (garde avant tout appel réseau).
      filConnu: (cible, racine) => chatMirror.has(cible, racine),
      logger,
    });

  // --- ENVOIS PROGRAMMÉS (lot 28) : « poste cette image à 16h10 » -------------
  // ⚠️ CE QUE CE BLOC FERME (production, 2026-11-04 15:54) : Yuki a répondu qu'elle ne
  // pouvait pas programmer une publication « car je n'ai pas de minuteur ». C'était
  // exact pour elle — le planificateur existe depuis le lot 2 — et cet outil est sa
  // seule porte d'entrée. Aucun second ordonnanceur n'est créé : c'est le balayeur des
  // déclencheurs (`DeclencheurBalayeur`, plus bas) qui appelle `executerDus`.
  const envoisProgrammesStore = EnvoisProgrammesStore.open({
    path: env.envoisProgrammesPath,
    logger,
  });
  /**
   * PUBLICATION d'un envoi dû — ⚠️ LE MÊME CHEMIN que les autres messages :
   *  - CANAL : `createChannelPostPort` + `envoyerDansCanal` (donc `adapter.send` et sa
   *    file PAR CONVERSATION, `src/chat/reply/send-queue.ts:22`) — le point
   *    d'étranglement exact de la `ReplyProgress` d'un tour, bornes de plateforme
   *    comprises (`couperPourPlateforme`) ;
   *  - LOCAL : `PiHost.publierMessage`, le chemin de `envoyer_message` en local
   *    (`src/pi/sdk-host.ts:2489`).
   * Elle LÈVE en cas d'échec : le service en fait un échec PERSISTÉ et JOURNALISÉ,
   * jamais une perte silencieuse (canal quitté, fil supprimé, session disparue).
   */
  const publierEnvoiProgramme = async (input: {
    cible: CibleEnvoi;
    texte: string;
    fichierIds?: readonly string[];
  }): Promise<void> => {
    if (input.cible.type === "local") {
      if (!host) {
        throw new Error("Le host Pi n'est pas disponible : l'envoi n'a pas pu être publié.");
      }
      if (typeof host.publierMessage !== "function") {
        throw new Error(
          "Ce host ne sait pas publier dans une conversation sans tour de modèle : " +
            "l'envoi programmé n'a pas pu partir.",
        );
      }
      await host.publierMessage(input.cible.sessionId, input.texte);
      return;
    }
    // ⚠️ `conversationSource: undefined` : l'appartenance des fichiers a été vérifiée à
    // la PROGRAMMATION. Revalider ici contre la cible refuserait tout fichier produit
    // dans la conversation d'origine (le cas d'usage : une image générée ici, publiée
    // dans « L'Imagerie »).
    const port = portDePublication(undefined, input.cible.plateforme);
    const issue = await port.publier({
      canal: input.cible.conversationId,
      texte: input.texte,
      ...(input.fichierIds !== undefined && input.fichierIds.length > 0
        ? { fichierIds: input.fichierIds }
        : {}),
    });
    if (!issue.ok) throw new Error(issue.raison);
  };
  const envoisProgrammes = new EnvoisProgrammesService({
    store: envoisProgrammesStore,
    journal: declencheursJournal,
    // Canaux SUIVIS relus à chaque programmation (`apply: hot`) : le périmètre est le
    // même que `publier_dans_canal`, et il est tenu côté serveur.
    canaux: () =>
      chatMirror.conversations().map((conversation) => ({
        conversationId: conversation.id,
        titre: conversation.title,
        plateforme: conversation.platform,
      })),
    fichier: (fichierId) => filesStore.get(fichierId),
    maxFichierBytes: () => config.getNumber("files.maxFileBytes"),
    publier: publierEnvoiProgramme,
    logger,
  });
  /** Port rendu aux OUTILS (host local et runs de canal) : programmer, rien de plus. */
  const portEnvoisProgrammes = {
    programmer: async (request: ProgrammationInput) => envoisProgrammes.programmer(request),
  };
  /**
   * Port rendu à l'OUTIL `planifier_tache` (lot 31) : programmer une TÂCHE que le worker
   * lourd exécutera à l'heure dite. Le service tient toutes les bornes (30 s, 30 jours,
   * quota), le nom slugifié et la cible — l'outil ne décide de rien.
   */
  const portPlanificationTache = {
    planifier: async (request: PlanificationTacheInput) =>
      sourcesService.planifierTache(request),
  };
  logger.info("envois.ready", {
    store: env.envoisProgrammesPath,
    en_attente: envoisProgrammes.enAttente,
    connus: envoisProgrammes.lister().length,
  });

  /**
   * RÉDACTEUR d'une réponse distante — **COMMUN aux plateformes** (lot 21).
   *
   * ⚠️ Mêmes PORTES que le run local (`createRemoteRunTools` recalculé à chaque réponse),
   * même prompt, même politique d'outils : une seconde fabrique pour Discord aurait
   * dupliqué la politique d'outils, c'est-à-dire la seule chose qui décide de ce qu'un run
   * distant a le droit d'appeler.
   */
  const chatReplyGenerator = createRemoteReplyGenerator({
    available: () => resolveAvail().isAvailable("light"),
    // ⚠️ FUSEAU des horodatages du fil de canal (`ui.timeZone`, défaut UTC),
    // relu à chaque réponse : le prompt ne dépend pas du fuseau du process et
    // reste comparable à Mattermost.
    timeZone: fuseauHorodatage,
    // ⚠️ Le nom du bot dépend de la PLATEFORME DU RUN (celle de la conversation), pas de
    // `chat.mode` : un salon Discord doit s'entendre appeler par le pseudo du bot Discord
    // même quand l'interface regarde Mattermost (`runPlatformOf`, `src/chat/reply/generate.ts`).
    botName: (conversationId) =>
      chatMirror.bot(mirrorPlatformOf(conversationId) ?? "mattermost").username ?? "Yuki",
    // ⚠️ POLITIQUE PAR PLATEFORME : `toolAllowlistForChat` selon la plateforme DU RUN et
    // les DEUX réglages d'accès distant (`chat.remoteAgents`, `chat.remoteTools`), à
    // partir des MÊMES options que le host local. Ce n'est pas `chat.mode` qui décide :
    // un run né dans un salon Discord reste un run DISTANT même si l'interface affiche
    // Mattermost (et inversement). Les outils à approbation en sont RETIRÉS : une
    // approbation s'affiche dans l'interface web, jamais dans le canal
    // (`REMOTE_APPROVAL_REFUSAL`).
    runTools: (conversationId, onFileProduced, contexte) =>
      createRemoteRunTools({
        conversationId,
        chatMode: runPlatformOf(conversationId, config.getString("chat.mode") as ChatOriginMode),
        // ⚠️ ANTI-BOUCLE STRUCTURELLE : un tour RÉVEILLÉ par un rapport de tâche
        // (`contexte.origine === "job"`) n'a NI `delegate` NI les outils d'accès
        // distant. Ce n'est pas une consigne de prompt : le modèle ne peut pas
        // relancer un travail qu'il vient de recevoir, donc aucune redélégation en
        // boucle n'est possible. ⚠️ DÉCISION : un rapport est une DONNÉE — il ne doit
        // pas relancer du travail (ni délégation, ni génération d'image, ni
        // libraire, ni archive). Il garde seulement le SOCLE `toujours`
        // (lister/lire une pièce jointe, publier, envoyer un fichier déjà rattaché),
        // qui ne sort pas de la conversation.
        remoteAgents:
          config.getString("chat.remoteAgents") === "actives" && contexte.origine !== "job",
        // ⚠️ SECOND RÉGLAGE, INDÉPENDANT : image/consulter_workflow/libraire/archives.
        // « agents non + outils oui » est la configuration que l'utilisateur
        // demandait (génération d'image dans le canal sans délégation).
        remoteTools:
          config.getString("chat.remoteTools") === "actives" && contexte.origine !== "job",
        lightOptions: lightToolOptions,
        // ⚠️ PUBLICATION INTER-CANAL (décision A, 2026-11-02) : le périmètre
        // « canaux SUIVIS, même plateforme » est tenu par le PORT (une seule
        // définition, `portDePublication`) — le modèle ne peut pas le contourner. Un
        // canal hors miroir est refusé avec la marche à suivre (Configuration →
        // Conversation → « Discussions — Mattermost / Discord »), au lieu d'inventer
        // une validation humaine.
        // ⚠️ Le port est ENVELOPPÉ par le suivi du tour : ce que Yuki publie dans un
        // autre canal n'est PAS re-joint à sa réponse (sinon un fichier de tâche
        // apparaîtrait deux fois).
        channels: contexte.channelPosts.wrap(
          portDePublication(
            conversationId,
            mirrorPlatformOf(conversationId) ??
              (config.getString("chat.mode") === "discord" ? "discord" : "mattermost"),
          ),
        ),
        // ⚠️ ENVOI DE MESSAGE DANS CE CANAL (`envoyer_message`, 2026-11-04) : même
        // chemin de publication que l'accusé, l'image et la réponse finale —
        // `contexte.publierMessage` est la `ReplyProgress` du tour (file sérialisée,
        // ancrage au fil). Ce module ne fait qu'appliquer la BORNE de la plateforme
        // (la même que `publier_dans_canal`, `couperPourPlateforme`) puis publier.
        // ⚠️ ENVOI PROGRAMMÉ (`programmer_envoi`, lot 28) : le canal du run est la
        // cible par défaut, et le port borne tout (30 s minimum, 30 jours, 20 en
        // attente, canaux SUIVIS) — le modèle ne peut pas le contourner. Aucun modèle
        // n'est appelé à l'heure dite : le texte est FIGÉ.
        envoisProgrammes: portEnvoisProgrammes,
        // ⚠️ TÂCHE PLANIFIÉE (`planifier_tache`, lot 31) : groupe `toujours`. Depuis un
        // CANAL il n'y a pas de conversation locale à qui rendre le résultat ⇒ la tâche
        // est créée sans cible et son résultat tombe dans le fil « Déclencheurs » (le port
        // le DIT au modèle, qui ne peut donc pas promettre une réponse dans le canal).
        planifierTache: portPlanificationTache,
        // ⚠️ Sans `publierMessage` (appelant sans publication intermédiaire), le port
        // n'est pas construit : la politique le signale comme non implémenté au lieu
        // de laisser un outil promettre une publication qui n'existe pas.
        ...(contexte.publierMessage !== undefined
          ? {
              messages: createReplyMessagePort({
                plateforme:
                  mirrorPlatformOf(conversationId) ??
                  (config.getString("chat.mode") === "discord" ? "discord" : "mattermost"),
                publier: contexte.publierMessage,
                logger,
              }),
            }
          : {}),
        // MÊMES ports d'image que le host local : le générateur ComfyUI et la
        // copie de l'image dans le store des fichiers de la conversation (le canal).
        // ⚠️ Pas d'`onImage` : l'image d'un run distant part sur le CANAL, pas dans
        // le fil de l'interface web (aucune conversation web n'est concernée).
        images: {
          generate: comfyGenerator.generate,
          archive: generatedImageFiles,
          workflows: {
            candidates: () => comfyWorkflows.candidates(),
            documentationOf: (name: string) => comfyWorkflows.get(name)?.documentation ?? "",
          },
          // ⚠️ Capacité VISION relue à CHAQUE appel : sans « image » dans `input`, le
          // SDK remplacerait l'image jointe par « (tool image omitted…) » et le modèle
          // croirait l'avoir vue.
          receivesImages: () => effectiveLlmConfig(config).light.vision,
        },
        // MÊME port de fichiers que le host local : `lister_fichiers`/`lire_fichier`
        // travaillent sur la conversation FORCÉE (le canal), jamais sur la session
        // éphémère du run.
        files: filesService,
        vision: {
          // Référence RELUE à chaud (le modèle peut changer sans redémarrage).
          modelLabel: liveLightReference,
          imagesSupported: () => effectiveLlmConfig(config).light.vision,
        },
        onFileProduced,
        // ⚠️ OUTILS DES DEUX GROUPES : `createRemoteRunTools` ne construit les outils du
        // groupe `agents` que sous `chat.remoteAgents = actives`, et ceux du groupe
        // `outils` que sous `chat.remoteTools = actives` (l'image comprise). Les ports
        // sont fournis dans les deux cas — aucune seconde implémentation, donc aucun
        // garde-fou parallèle à maintenir.
        ...(agentDirectory ? { agents: agentDirectory } : {}),
        ...(secretStore ? { secrets: secretStore } : {}),
        // ⚠️ DÉLÉGATION : les jobs créés depuis un canal sont rattachés au CANAL
        // (`channelScopedDelegation`, `src/pi/sdk/remote-run-tools.ts`) et leur
        // rapport RÉVEILLE Yuki dans ce canal (`createChannelAwareWaker`, plus bas) :
        // ce n'est pas le serveur qui publie, c'est SON tour.
        ...(delegation ? { delegation } : {}),
        ...(heritageStore ? { heritage: heritageStore } : {}),
        ...(conversationArchive ? { conversationArchive } : {}),
        ...(remoteLibrarian ? { librarian: remoteLibrarian } : {}),
        // ⚠️ `envoyer_fichier` : le fichier doit ARRIVER DANS LE CANAL, pas
        // seulement dans l'interface web — sans post, l'outil ne servirait à rien
        // pour la personne qui parle dans le canal.
        filesSend: filesService,
        onFileSent: (file) => {
          void envoyerDansCanal(conversationId, `Fichier : « ${file.name} »`, [file.id]).catch(
            (error: unknown) => {
              logger.warn("chat.file_sent.failed", {
                conversation: conversationId,
                fichier: file.id,
                error: messageOf(error),
              });
            },
          );
        },
        logger,
      }),
    createWriter: (run) =>
      chatWriter(
        CHAT_REPLY_SYSTEM_PROMPT,
        // ⚠️ BORNE DU TOUR, dérivée de la POLITIQUE du run (relue à chaque réponse) :
        //  - base = « rédaction (`CHAT_REPLY_TIMEOUT_MS`) + une génération
        //    (`images.timeoutMs`, plafond de sécurité relu à chaque réponse) », comme
        //    avant — la valeur suit donc un changement dans `/config` ;
        //  - relevée au moins jusqu'à la borne des outils longs AUTORISÉS INLINE,
        //    calculée par `createRemoteRunTools` (`channelTurnTimeoutMs`,
        //    `src/llm/tool-policy.ts`) : sous `chat.remoteAgents = desactive` (le
        //    DÉFAUT), `generer_image` s'exécute DANS le tour — sans cette levée, il
        //    serait coupé en plein vol, ce qui était le défaut d'origine.
        () =>
          Math.max(
            CHAT_REPLY_TIMEOUT_MS + config.getNumber("images.timeoutMs"),
            run.inlineLongToolBudgetMs ?? 0,
          ),
        "réponse",
        run,
      ),
    // ⚠️ MESURE de l'accusé : `chat.progress.ack` porte sa SOURCE (`modele`/`repli`),
    // jamais son texte (voir `src/chat/reply/progress.ts`).
    logger,
  });

  /**
   * PIÈCES JOINTES entrantes préparées pour le MODÈLE — **COMMUN aux plateformes**.
   *
   * ⚠️ Seul le CACHE change (chaque plateforme télécharge à sa façon) : la politique de
   * vision, les bornes et les `notes` sont ceux de `src/chat/attachments.ts`.
   */
  const readChatImages = async (
    cache: ChatAttachmentCache,
    input: { conversationId: string; message: RemoteMessage },
  ) => {
    const prepared = await prepareMessageImages({
      cache,
      conversationId: input.conversationId,
      message: input.message,
      maxBytes: config.getNumber("files.imageMaxBytes"),
      maxWireBytes: config.getNumber("files.imageMaxWireBytes"),
      resize: sdkVisionImageResizer,
    });
    if (prepared.notes.length > 0) {
      logger.warn("chat.attachments.skipped", {
        conversation: input.conversationId,
        notes: prepared.notes.length,
      });
    }
    return prepared;
  };

  /**
   * JUGE du mode `auto` — **COMMUN aux plateformes** (lot 21).
   *
   * ⚠️ Un seul juge pour Mattermost ET Discord : la décision « ce message s'adresse-t-il à
   * Yuki ? » est la même, et en écrire deux aurait fait diverger le prompt et le modèle.
   */
  const chatJudge: ChatReplyJudge = async ({ message, channelTitle }) => {
    if (!resolveAvail().isAvailable("light")) return false;
    const writer = chatWriter(CHAT_JUDGE_SYSTEM_PROMPT, CHAT_JUDGE_TIMEOUT_MS, "juge");
    const answer = await writer(
      buildJudgePrompt({
        channelTitle,
        message,
        recent: chatMirror
          .messages(message.conversationId)
          .filter((item) => item.remoteId !== message.remoteId)
          .slice(-4),
      }),
    );
    return parseJudgeAnswer(answer);
  };

  // Client MATTERMOST (lot 2) : REST + temps réel + miroir. ⚠️ Le JETON ne sort
  // JAMAIS d'ici (coffre `YUKI_CHAT_MATTERMOST`, lu à chaque appel) et il n'est ni
  // journalisé ni renvoyé par une route.
  const mattermost: MattermostChatAdapter = new MattermostChatAdapter({
    baseUrl: () => chatMirror.baseUrl(),
    token: () => secretStore?.lookup(MATTERMOST_TOKEN_SECRET_NAME),
    store: chatMirror,
    logger,
    // ⚠️ PIÈCES JOINTES : le store de Yuki est la SEULE source d'octets d'un envoi
    // (aucune lecture disque directe). C'est lui qui porte l'image produite par
    // `generer_image` (copiée dans le store, `src/files/generated.ts`).
    files: filesStore,
    // ⚠️ Borne d'envoi : `MM_MAX_UPLOAD_BYTES` (100 Mo = défaut Mattermost depuis la
    // 5.33). Une instance bridée refuse en `413` : ce refus est ANNONCÉ dans le canal,
    // jamais contourné, et le texte part quand même.
    // Le générateur et le juge ne sont câblés que si un modèle léger est disponible :
    // sans lui, la décision `auto` rend « juge indisponible » et le rédacteur refuse
    // explicitement — on ne publie jamais une réponse inventée.
    judge: chatJudge,
    // RÉDACTION avec OUTILS (lot 20) : le câblage vit dans
    // `createRemoteReplyGenerator` (testable de bout en bout). Ici, on ne fournit
    // que les PORTES : disponibilité du modèle, nom du bot, POLITIQUE du run
    // (recalculée à chaque réponse) et écrivain SDK.
    generateReply: chatReplyGenerator,
    // ⚠️ IMAGES ENTRANTES : téléchargées SEULEMENT ici (à la demande), jamais pendant la
    // synchronisation, et seulement si le fichier est référencé par un message de CE
    // canal (garde de sûreté de `MattermostAttachmentCache`). La politique de vision est
    // celle, PARTAGÉE, de `src/files/vision.ts`.
    readImages: (input) => readChatImages(mattermostAttachments, input),
  });
  // Le registre rend l'adaptateur au transport et à `GET /api/chat/status`.
  registerAdapterProvider("mattermost", () => mattermost);

  /**
   * CACHE des PIÈCES JOINTES Mattermost (téléchargement À LA DEMANDE).
   *
   * ⚠️ UNE seule instance, qui réutilise le client REST de l'adaptateur : même débit,
   * même backoff, et un même `file_id` n'est téléchargé qu'UNE fois (bornes mémoire :
   * 32 pièces / 48 Mio). La garde d'appartenance (le fichier doit être référencé par un
   * message d'un canal SUIVI) est revérifiée à chaque lecture, cache compris.
   */
  const mattermostAttachments: MattermostAttachmentCache = new MattermostAttachmentCache({
    client: mattermost.rest,
    store: chatMirror,
    logger,
    // ⚠️ Borne de TÉLÉCHARGEMENT (20 Mio par défaut) : c'est elle qui évite d'accumuler
    // un fichier démesuré en mémoire. La politique de VISION borne ensuite ce qui part
    // réellement au modèle (`files.imageMaxBytes` / `files.imageMaxWireBytes`).
    maxBytes: () => MM_MAX_DOWNLOAD_BYTES,
  });

  /**
   * Port MATTERMOST de la page `/config → Conversation → « Discussions — Mattermost »`.
   *
   * ⚠️ Le jeton est ÉCRIT ici et n'en ressort jamais : `tokenConfigured()` est un
   * booléen, jamais la valeur, jamais un préfixe. Une fois enregistré, le jeton ne peut
   * plus être relu depuis l'interface — seulement remplacé.
   */
  /**
   * EFFACE un jeton du coffre (débranchement / suppression d'une connexion).
   *
   * ⚠️ Le coffre SAIT supprimer (`SecretStore.delete`, `src/secrets/store.ts:146`) :
   * aucune extension d'API n'a été nécessaire. L'erreur d'un coffre verrouillé est
   * PROPAGÉE (la route la rend en 502) : on ne prétend jamais avoir effacé un jeton
   * qu'on n'a pas pu effacer.
   */
  const effacerJeton = (nom: string): void => {
    if (!secretStore) return;
    // `delete` lève si le coffre est verrouillé : c'est voulu, et remonté plus haut.
    if (secretStore.delete(nom)) refreshSecretValues();
  };

  const mattermostPort: ChatMattermostPort = {
    baseUrl: () => chatMirror.baseUrl(),
    tokenConfigured: () => secretStore?.has(MATTERMOST_TOKEN_SECRET_NAME) === true,
    saveBaseUrl: (url) => chatMirror.setBaseUrl(url),
    saveToken: (token) => {
      if (!secretStore) {
        throw new Error(
          "Le coffre de secrets n'est pas disponible : le jeton Mattermost ne peut pas " +
            "être enregistré (redémarrez avec le volume `state` accessible).",
        );
      }
      secretStore.set(MATTERMOST_TOKEN_SECRET_NAME, token, "Jeton du bot Mattermost");
      // La liste de rédaction du journal est rafraîchie immédiatement : le jeton ne
      // pourra même pas apparaître dans une ligne de journal ultérieure.
      refreshSecretValues();
    },
    connect: () => mattermost.connect(),
    // ⚠️ DÉBRANCHER : la synchro s'arrête POUR DE VRAI (WebSocket fermé, balayeur
    // arrêté — `adapter.disconnect()`), puis le jeton est effacé du coffre. Le miroir
    // n'est PAS touché : ses conversations restent lisibles, et remettre le jeton suffit.
    deconnecter: async () => {
      await mattermost.disconnect();
      effacerJeton(MATTERMOST_TOKEN_SECRET_NAME);
    },
    miroir: () => chatMirror.statsOf("mattermost"),
    supprimerMiroir: () => chatMirror.purgePlatform("mattermost"),
    view: () => {
      const canaux = Object.entries(chatMirror.records())
        .filter(([, record]) => record.platform === "mattermost")
        .map(([id, record]) => ({
          id,
          titre: record.title,
          messageCount: record.messageCount,
          ...(record.replyMode !== undefined ? { replyMode: record.replyMode } : {}),
          // ⚠️ Valeurs EFFECTIVES : l'interface coche l'option réellement active.
          replyStyle: effectiveReplyStyle(record),
          quoteAuthor: effectiveQuoteAuthor(record),
          backfillFait: record.backfillDone,
          historiqueAnterieur:
            record.historiqueAnterieur === true || record.borneAtteinte === true,
        }));
      return {
        url: chatMirror.baseUrl(),
        jetonEnregistre: secretStore?.has(MATTERMOST_TOKEN_SECRET_NAME) === true,
        plateforme: mattermost.status(),
        synchronisation: mattermost.syncStatus(),
        miroir: chatMirror.statsOf("mattermost"),
        canaux,
      };
    },
    replySettings: (conversationId) => mattermost.replySettings(conversationId),
    applyReplySettings: (conversationId, patch) =>
      chatMirror.setReplySettings(conversationId, patch),
  };

  // Client DISCORD (lot 21) : REST + passerelle + miroir, MÊME modèle que Mattermost.
  // ⚠️ Le JETON ne sort JAMAIS d'ici (coffre `YUKI_CHAT_DISCORD`, lu à chaque appel) : il
  // n'est ni journalisé, ni renvoyé par une route, ni envoyé au CDN lors d'un
  // téléchargement de pièce jointe.
  const discord: DiscordChatAdapter = new DiscordChatAdapter({
    token: () => secretStore?.lookup(DISCORD_TOKEN_SECRET_NAME),
    store: chatMirror,
    logger,
    // Serveur suivi : `""` = tous les serveurs du bot (défaut, voir le schéma).
    guildId: () => config.getString("chat.discord.guildId"),
    // ⚠️ Borne d'ENVOI par fichier, relue à chaque message (défaut 8 Mio, plafond 25 Mio).
    maxUploadBytes: () => config.getNumber("chat.discord.maxUploadBytes"),
    // ⚠️ MÊMES fabriques que Mattermost : un générateur par plateforme aurait dupliqué la
    // politique d'outils et le prompt.
    judge: chatJudge,
    generateReply: chatReplyGenerator,
    files: filesStore,
    readImages: (input) => readChatImages(discordAttachments, input),
  });
  registerAdapterProvider("discord", () => discord);

  /**
   * CACHE des PIÈCES JOINTES Discord (téléchargement À LA DEMANDE).
   *
   * ⚠️ Aucun appel d'API pour LISTER : Discord fournit le nom, la taille, le type et
   * l'URL dans le message. Le téléchargement se fait sur le CDN, SANS le jeton, et
   * seulement pour un fichier déjà référencé par un message d'un canal suivi.
   */
  const discordAttachments: ChatAttachmentCache = new ChatAttachmentCache({
    port: discordAttachmentPort(discord.rest),
    store: chatMirror,
    logger,
    maxBytes: () => DISCORD_MAX_DOWNLOAD_BYTES,
  });

  /**
   * Port DISCORD de la page `/config → Conversation → « Discussions — Discord »`.
   *
   * ⚠️ Comme pour Mattermost : le jeton est ÉCRIT ici et n'en ressort jamais
   * (`tokenConfigured()` est un booléen). Les réglages scalaires (serveur, borne d'envoi)
   * vivent dans la configuration, pas dans le miroir.
   */
  const discordPort: ChatDiscordPort = {
    guildId: () => config.getString("chat.discord.guildId"),
    saveGuildId: (guildId) => {
      config.update({ "chat.discord.guildId": guildId });
    },
    maxUploadBytes: () => config.getNumber("chat.discord.maxUploadBytes"),
    saveMaxUploadBytes: (bytes) => {
      config.update({ "chat.discord.maxUploadBytes": Math.trunc(bytes) });
    },
    tokenConfigured: () => secretStore?.has(DISCORD_TOKEN_SECRET_NAME) === true,
    saveToken: (token) => {
      if (!secretStore) {
        throw new Error(
          "Le coffre de secrets n'est pas disponible : le jeton Discord ne peut pas être " +
            "enregistré (redémarrez avec le volume `state` accessible).",
        );
      }
      secretStore.set(DISCORD_TOKEN_SECRET_NAME, token, "Jeton du bot Discord");
      refreshSecretValues();
    },
    connect: () => discord.connect(),
    // ⚠️ MÊME contrat que Mattermost : la synchro s'arrête (passerelle fermée, balayeur
    // arrêté), le jeton est effacé, le miroir reste.
    deconnecter: async () => {
      await discord.disconnect();
      effacerJeton(DISCORD_TOKEN_SECRET_NAME);
    },
    miroir: () => chatMirror.statsOf("discord"),
    supprimerMiroir: () => chatMirror.purgePlatform("discord"),
    view: () => {
      const canaux = Object.entries(chatMirror.records())
        .filter(([, record]) => record.platform === "discord")
        .map(([id, record]) => ({
          id,
          titre: record.title,
          messageCount: record.messageCount,
          ...(record.replyMode !== undefined ? { replyMode: record.replyMode } : {}),
          replyStyle: effectiveReplyStyle(record),
          quoteAuthor: effectiveQuoteAuthor(record),
          backfillFait: record.backfillDone,
          historiqueAnterieur:
            record.historiqueAnterieur === true || record.borneAtteinte === true,
        }));
      const intent = discord.messageContentIntent();
      return {
        guildId: config.getString("chat.discord.guildId"),
        maxUploadBytes: config.getNumber("chat.discord.maxUploadBytes"),
        intentMessageContent: intent === undefined ? null : intent,
        jetonEnregistre: secretStore?.has(DISCORD_TOKEN_SECRET_NAME) === true,
        plateforme: discord.status(),
        synchronisation: discord.syncStatus(),
        miroir: chatMirror.statsOf("discord"),
        canaux,
      };
    },
    replySettings: (conversationId) => discord.replySettings(conversationId),
    applyReplySettings: (conversationId, patch) =>
      chatMirror.setReplySettings(conversationId, patch),
  };

  // Service de DISCUSSION : lit le mode (`chat.mode`, apply hot) et sert le miroir en
  // LECTURE seule. ⚠️ `chat.mode` ne filtre que la VUE : la synchronisation démarre
  // dès que la plateforme est configurée (décision du lot 1, tenue ici).
  const chatService = new ChatService({
    mode: () => config.getString("chat.mode"),
    remoteAgents: () => config.getString("chat.remoteAgents"),
    // ⚠️ SECOND réglage, INDÉPENDANT : image/libraire/archives sans délégation.
    remoteTools: () => config.getString("chat.remoteTools"),
    mirror: chatMirror,
  });

  if (gate.passed) {
    const idleTimeoutMs = config.getNumber("delegation.idleTimeoutMs");
    const totalTimeoutMs = config.getNumber("delegation.totalTimeoutMs");

    const jobStore = JobStore.open({ path: env.jobsStorePath, logger });
    const queue = new JobQueue({
      maxConcurrent: config.getNumber("delegation.maxConcurrent"),
      maxQueue: config.getNumber("delegation.maxQueue"),
    });
    // ⚠️ PROFIL DE CAPACITÉS (lot 35f) — STRUCTUREL, pas une permission : un bot
    // dont le profil n'est pas `complet` n'INSTANCIE PAS le worker lourd. Aucun
    // `run_command` ne peut donc exister, même par un job importé ou une tâche
    // planifiée : le worker qui les exécuterait n'a jamais été construit.
    // ⚠️ La garde elle-même vit dans `construireWorkerLourdSiAutorise`
    // (`src/bots/profils.ts`) : isolée, elle est TESTABLE avec un ESPION, ce que ce
    // point de composition ne permet pas (il exécute `main()` au chargement).
    const heavyWorker = construireWorkerLourdSiAutorise(profilBot, () =>
      createSdkHeavyWorker({
        cwd: env.piCwd,
        agentDir: env.piAgentDir,
        authPath: join(env.piAgentDir, "auth.json"),
        modelsPath,
        systemPrompt: config.getString("prompts.heavy"),
        modelReference: liveHeavyReference,
        thinking: liveHeavyThinking,
        // ⚠️ INVERSION DES RÔLES : le worker LOURD porte les outils d'ACTION
        // (`run_command`, `capturer_ecran`). Ceux-ci ne sont activés que si le
        // service d'exécution existe (mêmes garde-fous par agent, hors ligne =
        // refus, audit, plafond de sortie).
        tools: toolAllowlist("heavy", {
          // ⚠️ PROFIL (lot 35f) : redondance VOULUE. Ce bloc n'est atteint que si
          // `workerLourdAutorise(profilBot)` est vrai (le worker n'est pas construit
          // sinon), donc l'intersection ne retire rien aujourd'hui — mais si quelqu'un
          // déplaçait la garde, le profil resterait le dernier mot.
          profil: profilBot,
          executionEnabled: agentExecution !== undefined,
          screenshotsEnabled: agentExecution !== undefined,
          // ⚠️ TRANSFERT de fichiers : exposé seulement si le service existe.
          fileTransferEnabled: agentTransfers !== undefined,
          // ⚠️ LISTAGE des pièces jointes (lecture seule, identifiants compris) :
          // le worker doit pouvoir retrouver l'identifiant qu'exige `deposer_fichier`.
          fileListEnabled: filesService !== undefined,
          // ⚠️ LECTURE du CONTENU (image vue, texte décodé et borné, binaire
          // refusé) : sans elle, le worker savait qu'une image existait sans
          // pouvoir la voir — la boucle « lister → lire → déposer » restait ouverte.
          fileReadEnabled: filesService !== undefined,
          secretsEnabled: secretStore !== undefined,
          // ⚠️ IMAGES (lot 23) : `generer_image` + `consulter_workflow`. La valeur
          // suit l'EXISTENCE du générateur ComfyUI, câblé juste en dessous : sans
          // lui, l'outil ne serait construit que pour REFUSER, et la politique
          // annoncerait une capacité absente.
          imagesEnabled: comfyGenerator !== undefined,
          // ⚠️ AUCUN OUTIL DE PUBLICATION ICI, et c'est STRUCTUREL : le worker REND un
          // résultat, il ne parle pas (`docs/lot18-chat.md`, invariant « un seul
          // rédacteur »). `publier_dans_canal` reste au contraire disponible dans le RUN
          // DE CANAL (`REMOTE_SAFE_TOOLS`) : là, c'est Yuki qui écrit, et c'est légitime.
        }),
        ...(agentExecution ? { execution: agentExecution } : {}),
        ...(agentExecution ? { screenshots: agentExecution } : {}),
        ...(agentTransfers ? { transfers: agentTransfers } : {}),
        // ⚠️ IMAGES : MÊMES ports que le host local (générateur ComfyUI + copie dans
        // le store des fichiers). La conversation est FORCÉE par le worker à celle
        // de sa conversation propriétaire (le canal), et l'identifiant du fichier
        // produit remonte dans `HeavyRunResult.fichiers` ⇒ il est publié avec le
        // rapport. ⚠️ Pas d'`onImage` : un job n'alimente aucune interface web ;
        // c'est le RAPPORT qui est le canal de sortie.
        images: {
          generate: comfyGenerator.generate,
          archive: generatedImageFiles,
          workflows: {
            candidates: () => comfyWorkflows.candidates(),
            documentationOf: (name: string) => comfyWorkflows.get(name)?.documentation ?? "",
          },
        },
        // ⚠️ FICHIERS : la liste des pièces jointes de la conversation est jointe
        // AUTOMATIQUEMENT au premier message du worker (métadonnées seules).
        files: filesService,
        ...(secretStore ? { secrets: secretStore } : {}),
        // ⚠️ BORNE DES IMAGES SUR LE FIL : une tâche peut lire plusieurs images,
        // et chacune repartirait sinon dans CHAQUE appel modèle de sa boucle
        // d'outils (`500 request entity too large`). Relue à chaque job.
        imageRequestBudgetBytes: () => config.getNumber("files.imageRequestBudgetBytes"),
        idleTimeoutMs,
        totalTimeoutMs,
        // ⚠️ CHIEN DE GARDE DÉRIVÉ du plafond de génération RÉEL (relu à chaque job) :
        // une génération peut durer `images.timeoutMs` (1 h par défaut) pendant
        // laquelle la session n'émet AUCUN événement. Un chien de garde fixe à 16 min
        // deviendrait plus COURT que le plafond dès que celui-ci est relevé (vidéo) :
        // il tuerait alors le job AVANT la fin de la génération, sans explication.
        // `resolveToolWatchdogMs` garantit « plafond de génération + marge », sans
        // dépendre de la vigilance de qui règle les valeurs.
        toolWatchdogMs: () => resolveToolWatchdogMs(config.getNumber("images.timeoutMs")),
        logger,
      }),
    );
    // ⚠️ Sans worker lourd, il n'y a RIEN à déléguer : le service de délégation
    // n'est pas construit (sinon `delegate` annoncerait une capacité inexistante).
    if (heavyWorker !== undefined) {
      delegation = createDelegationService({
        store: jobStore,
        queue,
        heavy: heavyWorker,
        availability: availabilityPort,
        idleTimeoutMs,
        totalTimeoutMs,
        defaultDeadlineMs: () => config.getNumber("delegation.defaultDeadlineMs"),
        logger,
      });
    }

    const memoryStore = MemoryStore.open({ path: env.memoryStorePath, logger });
    const memoryIndex = new MemoryIndex({ path: env.memoryIndexPath, logger });
    // Écriture de fond (extraction + consolidation) sur le compte LOURD quand
    // il est disponible : libère le compte léger (déclaré mono-slot) pour le
    // run de conversation suivant. Repli sur le léger sinon. La référence est
    // RELUE à chaque passe ⇒ un changement de modèle s'applique sans redémarrage.
    const memoryWriteRef = (): string =>
      memoryWriteModelReference({
        heavyAvailable: resolveAvail().isAvailable("heavy"),
        heavyRef: liveHeavyReference(),
        lightRef: liveLightReference(),
        logger,
        usage: "extraction memoire",
      });
    memoryService = new MemoryService({
      store: memoryStore,
      index: memoryIndex,
      logger,
      enabled: () => config.getString("memory.enabled") === "on",
      bounds: () => ({
        topK: config.getNumber("memory.recall.topK"),
        budgetChars: config.getNumber("memory.recall.budgetChars"),
        timeoutMs: config.getNumber("memory.recall.timeoutMs"),
      }),
      extractor: createSdkMemoryExtractor({
        cwd: env.piCwd,
        agentDir: env.piAgentDir,
        authPath: join(env.piAgentDir, "auth.json"),
        modelsPath,
        modelReference: memoryWriteRef,
        thinking: () =>
          resolveAvail().isAvailable("heavy")
            ? liveHeavyThinking()
            : liveLightThinking(),
        timeoutMs: () => config.getNumber("memory.extract.timeoutMs"),
        logger,
      }),
      maxItemsPerPass: () => config.getNumber("memory.extract.maxItems"),
      // Passe de SOLIDIFICATION à la mise de côté d'une conversation : relecture
      // ENTIÈRE mais BORNÉE (taille d'un appel + nombre d'appels).
      setAsideBounds: () => ({
        maxChars: config.getNumber("memory.setAside.maxChars"),
        maxChunks: config.getNumber("memory.setAside.maxChunks"),
      }),
    });
    memoryService.start();
    logger.info("memory.ready", {
      enabled: config.getString("memory.enabled") === "on",
      entries: memoryStore.size,
      store: env.memoryStorePath,
      index: env.memoryIndexPath,
      write_role: heavyAvailableAtStart ? "heavy" : "light",
    });

    // CONSOLIDATION HEBDOMADAIRE (lot 29) — ⚠️ MODÈLE LOURD IMPOSÉ, SANS REPLI.
    // L'extracteur vise `liveHeavyReference()` : si le lourd est indisponible, la
    // passe est REFUSÉE (et le dit dans son rapport), elle n'est jamais confiée au
    // léger. Session éphémère SANS OUTIL (`tools: []`) : anti-récursion.
    const consolidationArchive = new ConsolidationArchiveStore({
      dir: env.memoryConsolidationDir,
      logger,
    });
    consolidationHebdo = new ConsolidationHebdo({
      store: memoryStore,
      index: memoryIndex,
      logger,
      archive: consolidationArchive,
      statePath: env.memoryConsolidationStatePath,
      settings: () => ({
        enabled: config.getString("memory.consolidation.enabled") === "on",
        cron: config.getString("memory.consolidation.cron"),
        // ⚠️ Fuseau LU, jamais supposé : « 3 h de Paris » = `Europe/Paris`.
        fuseau: config.getString("memory.consolidation.timeZone"),
        budgetTokens: config.getNumber("memory.consolidation.budgetTokens"),
        retention: config.getNumber("memory.consolidation.retention"),
      }),
      extractor: () =>
        createSdkConsolidationHebdoExtractor({
          cwd: env.piCwd,
          agentDir: env.piAgentDir,
          authPath: join(env.piAgentDir, "auth.json"),
          modelsPath,
          modelReference: liveHeavyReference,
          // ⚠️ Consolidation HEBDOMADAIRE : le LOURD est IMPOSÉ (aucun repli),
          // mais sa réflexion suit `llm.heavy.thinking` — jamais un `off` figé
          // (le défaut du rôle est `high`, voir `src/config/schema.ts`).
          thinking: liveHeavyThinking,
          // Une passe peut traiter un lot volumineux : délai GÉNÉREUX, jamais 30 s.
          timeoutMs: () => Math.max(180_000, config.getNumber("memory.extract.timeoutMs")),
          logger,
        }),
      // ⚠️ Contexte du modèle LOURD **réellement configuré**, LU dans `models.json`
      // (amendement ①) ; repli explicite sur la fiche en mémoire si le fichier est
      // illisible — jamais un 1 M codé en dur.
      contexteModele: () =>
        contexteModeleDepuisFichier(modelsPath, liveHeavyReference()) ??
        resolveModelsFrom(effectiveLlmConfig(config)).heavy.contextWindow,
    });
    logger.info("memory.consolidation.ready", {
      cron: config.getString("memory.consolidation.cron"),
      fuseau: config.getString("memory.consolidation.timeZone"),
      budget_tokens: config.getNumber("memory.consolidation.budgetTokens"),
      retention: config.getNumber("memory.consolidation.retention"),
      contexte_modele:
        contexteModeleDepuisFichier(modelsPath, liveHeavyReference()) ??
        resolveModelsFrom(effectiveLlmConfig(config)).heavy.contextWindow,
      archive_dir: consolidationArchive.dirPath,
      modele: liveHeavyReference(),
    });

    // Lot 13 : archive « vie antérieure » — dossier SÉPARÉ du store de mémoire,
    // jamais fusionné. On met en place la structure (notice + manifeste) si elle
    // manque, puis on la rend consultable à la demande (outil + signal).
    heritageStore = new HeritageStore({ dir: env.heritageDir, logger });
    heritageStore.ensureLayout();
    logger.info("memory.heritage.ready", {
      dir: heritageStore.dirPath,
      entries: heritageStore.info().entries,
    });

    // Archive des conversations MISES DE CÔTÉ : dossier dédié du volume `state`
    // (une conversation = un fichier JSON complet) + index plein texte FTS5
    // DÉRIVÉ. ⚠️ JAMAIS injectée dans le prompt : consultable uniquement sur
    // demande explicite via l'outil `chercher_conversations_archivees`.
    conversationArchive = new ConversationArchiveStore({
      dir: env.conversationArchiveDir,
      indexPath: env.conversationArchiveIndexPath,
      logger,
    });
    conversationArchive.ensureLayout();
    logger.info("memory.conversation_archive.ready", {
      dir: conversationArchive.dirPath,
      index: conversationArchive.indexFilePath,
      conversations: conversationArchive.info().conversations,
    });

    // --- Libraire de Pi-Web : client HTTP + archivage EN TÂCHE DE FOND --------
    // ⚠️ Le libraire est un service EXTERNE. Le client relit la configuration à
    // CHAQUE appel (`apply: hot`) ; l'archivage est soumis à un service de fond
    // DÉDIÉ qui réutilise le `JobStore`/`JobQueue` et le canal de report des jobs.
    // ⚠️ Les quatre outils ne sont exposés au modèle que si l'URL de base est
    // renseignée AU DÉMARRAGE (l'allowlist est fixée à la création du host) ;
    // c'est la seule action qui requiert un redémarrage.
    const librarianClient = createLibrarianClient({
      config: () => ({
        baseUrl: config.getString("librarian.baseUrl"),
        agentToken: config.getString("librarian.agentToken"),
        apiKey: config.getString("librarian.apiKey"),
      }),
      logger,
    });
    const librarianJobs = JobStore.open({ path: env.librarianJobsPath, logger });
    const librarianArchive = createLibrarianArchiveService({
      store: librarianJobs,
      client: librarianClient,
      synthesizer: createSdkLibrarianSynthesizer({
        cwd: env.piCwd,
        agentDir: env.piAgentDir,
        authPath: join(env.piAgentDir, "auth.json"),
        modelsPath,
        modelReference: () =>
          memoryWriteModelReference({
            heavyAvailable: resolveAvail().isAvailable("heavy"),
            heavyRef: liveHeavyReference(),
            lightRef: liveLightReference(),
            logger,
            usage: "synthese libraire",
          }),
        thinking: () =>
          resolveAvail().isAvailable("heavy")
            ? liveHeavyThinking()
            : liveLightThinking(),
        timeoutMs: () => config.getNumber("librarian.archiveTimeoutMs"),
        systemPrompt: LIBRARIAN_SYNTHESIZER_SYSTEM_PROMPT,
        logger,
      }),
      logger,
    });
    const librarianConfigured = config.getString("librarian.baseUrl").trim() !== "";
    // Captures de pages web (Libry) : stockage local + diffusion vers l'UI.
    // ⚠️ Ces captures ne sont plus ÉPHÉMÈRES : elles sont CONSERVÉES comme les
    // pièces jointes (même réglage `files.retentionDays`, même purge) et donc
    // RESTAURABLES après rechargement.
    librarianShots = new LibrarianShotsStore({
      dir: env.librarianShotsDir,
      logger,
      retentionDays: () => config.getNumber("files.retentionDays"),
    });
    librarianShots.ensureLayout();
    const purgedShotsAtStart = librarianShots.purgeExpired();
    const librarianConfiguredAtStart = librarianConfigured;
    const librarianCaptureEnabledAtStart =
      librarianConfiguredAtStart && config.getString("librarian.screenshot") === "on";
    logger.info("librarian.ready", {
      configured: librarianConfigured,
      capture: librarianCaptureEnabledAtStart,
      jobs: env.librarianJobsPath,
      shots: env.librarianShotsDir,
      purgedShots: purgedShotsAtStart,
      retentionDays: config.getNumber("files.retentionDays"),
    });

    // Diffusion des captures de pages web vers l'UI (trame de contrôle `screenshot`).
    const librarianShotListeners = new Set<(event: ScreenshotViewEvent) => void>();
    /**
     * Vue d'une capture, telle que l'interface l'affiche. UN SEUL constructeur :
     * la diffusion en direct et la RESTAURATION après rechargement produisent donc
     * exactement la même trame (aucune divergence possible entre les deux).
     */
    function librarianShotFrame(view: LibrarianShotView, sessionId: string): CapturedScreenshotView {
      return {
        agentId: view.host,
        agentName: view.host,
        sessionId,
        dataUrl: view.imageSrc,
        format: view.mimeType.split("/")[1] ?? "png",
        width: view.width ?? 0,
        height: view.height ?? 0,
        bytes: view.bytes,
        capturedAt: view.capturedAt,
        source: "web",
        url: view.pageUrl,
      };
    }
    const librarianShotBus: ScreenshotGatewayPort = {
      subscribeScreenshots: (listener) => {
        librarianShotListeners.add(listener);
        return () => {
          librarianShotListeners.delete(listener);
        };
      },
      // RESTAURATION après rechargement / bascule : les captures de cette
      // conversation encore valables (rétention non atteinte). Le transport les
      // renvoie en trames de CONTRÔLE juste après le snapshot.
      capturesForSession: (sessionId) => {
        const store = librarianShots;
        if (!store) return [];
        return store.list({ sessionId }).map((record) => ({
          kind: "captured" as const,
          screenshot: librarianShotFrame(store.toView(record), sessionId),
        }));
      },
    };
    const emitLibrarianShot = (view: LibrarianShotView): void => {
      if (!view.sessionId) return;
      const event: ScreenshotViewEvent = { kind: "captured", screenshot: librarianShotFrame(view, view.sessionId) };
      for (const listener of [...librarianShotListeners]) {
        try {
          listener(event);
        } catch {
          // Un client en échec ne doit pas interrompre les autres.
        }
      }
    };

    // ⚠️ LIBRAIRE D'UN RUN DISTANT : MÊMES ports que le host local (client,
    // archivage de fond, captures, stockage), avec les MÊMES bornes. La seule
    // différence est la conversation FORCÉE au canal (faite par
    // `buildRemoteRunTools`) : une capture doit être enregistrée dans le fil du
    // canal, pas sous l'identifiant éphémère du run.
    remoteLibrarian = librarianConfigured
      ? {
          client: librarianClient,
          archive: librarianArchive,
          // ⚠️ LECTURE du TEXTE d'une page (`POST /read`) : le MÊME client, donc la
          // MÊME configuration relue à chaud et les MÊMES erreurs typées.
          read: librarianClient,
          screenshot: librarianClient,
          shots: librarianShots,
          // ⚠️ COPIE de la capture dans le store des FICHIERS de la conversation (même
          // archiveur que `generer_image`) : c'est elle qui donne à la capture un
          // identifiant PUBLIABLE, donc l'image dans le canal. `buildRemoteRunTools`
          // l'enveloppe pour que l'identifiant remonte au message publié.
          files: generatedImageFiles,
          onShot: (view: LibrarianShotView) => emitLibrarianShot(view),
          captureEnabled: () => config.getString("librarian.screenshot") === "on",
          // ⚠️ Capacité VISION relue à chaque capture (le modèle peut changer à chaud).
          receivesImages: () => effectiveLlmConfig(config).light.vision,
        }
      : undefined;

    // Diffusion des IMAGES GÉNÉRÉES vers l'UI (trame de contrôle `image`). Les
    // abonnés sont posés par le transport WS ; un client en échec ne doit jamais
    // interrompre les autres. ⚠️ Seules des métadonnées et un chemin SAME-ORIGIN
    // voyagent : aucun octet d'image, aucun nom de fichier du serveur ComfyUI.
    const imageViewListeners = new Set<(view: ComfyImageView) => void>();
    const imageFinalPromptListeners = new Set<(view: ComfyImageFinalPromptView) => void>();
    imagesGateway = {
      subscribeImages: (listener) => {
        imageViewListeners.add(listener);
        return () => {
          imageViewListeners.delete(listener);
        };
      },
      subscribeImageFinalPrompts: (listener) => {
        imageFinalPromptListeners.add(listener);
        return () => {
          imageFinalPromptListeners.delete(listener);
        };
      },
      // RESTAURATION après rechargement / bascule : les images de cette
      // conversation encore valables (rétention non atteinte). Le transport les
      // renvoie en trames de CONTRÔLE juste après le snapshot — c'est ce qui fait
      // qu'une image générée ne disparaît plus au rechargement.
      imagesForSession: (sessionId) =>
        comfyImages.list({ sessionId }).map((record) => comfyImages.toView(record)),
    };
    const emitGeneratedImage = (view: ComfyImageView): void => {
      if (!view.sessionId) return;
      // ⚠️ Rattachement AVANT diffusion : c'est lui qui permet de retrouver
      // l'image au rechargement (la vue seule ne survit pas au fil).
      try {
        comfyImages.attach(view.id, view.sessionId);
      } catch (error) {
        logger.warn("comfy.image.attach.failed", { error: messageOf(error) });
      }
      for (const listener of [...imageViewListeners]) {
        try {
          listener(view);
        } catch {
          // Un client en échec ne doit pas interrompre les autres.
        }
      }
    };

    // ⚠️ PROMPT ENREGISTRÉ vs PROMPT LIVRÉ (`src/config/runtime.ts`) : `prompts.light` est
    // éditable dans Configuration et sa valeur ENREGISTRÉE l'emporte sur
    // `config/pi/system-prompt.md`. Un prompt sauvegardé AVANT le lot 28 ne parle donc pas
    // de `programmer_envoi` : le modèle suit la consigne la plus ancienne et affirme une
    // incapacité qui est fausse (« je n'ai pas de minuteur », production 2026-11-04),
    // pendant qu'un run de canal publie à l'heure dite. On le DIT au démarrage — jamais de
    // réécriture silencieuse du texte de l'utilisateur.
    const promptLeger = config.getString("prompts.light");
    // ⚠️ Un avertissement doit dire QUOI FAIRE (sinon c'est du bruit) : l'origine et
    // l'action sont dans les champs. Deux cas signalés : prompt VIDE (aucune
    // consigne) et prompt enregistré qui CONTREDIT une capacité (`programmer_envoi`).
    avertirSiPromptLegerIncomplet(logger, promptLeger, config.originOf("prompts.light"));
    host = createPiHost({
      agentDir: env.piAgentDir,
      cwd: env.piCwd,
      home: env.piHome,
      sessionsDir: env.piSessionsDir,
      systemPrompt: appendVoiceInstruction(promptLeger, isTtsEnabled(config)),
      settingsSeedPath: env.piSettingsSeedPath,
      modelsConfig: buildModelsConfigFrom(effective),
      model: lightRef,
      thinking: lightThinking,
      // ⚠️ MÊME CALCUL QUE LE RUN DISTANT (`createRemoteRunTools`) : une seule
      // fonction d'options (`lightToolOptions`) et une seule politique
      // (`toolAllowlistForChat`). Le host est la conversation LOCALE : il passe
      // donc `local`, et sa liste est, élément pour élément, celle d'avant.
      tools: toolAllowlistForChat("light", lightToolOptions(), {
        chatMode: "local",
        remoteAgents: false,
        remoteTools: false,
      }),
      // ⚠️ Sans worker lourd (profil restreint), `delegation` est ABSENT : le host n'a
      // donc ni port de délégation, ni outil `delegate` (retiré aussi par le profil).
      ...(delegation ? { delegation } : {}),
      ...(agentDirectory ? { directory: agentDirectory } : {}),
      ...(secretStore ? { secrets: secretStore } : {}),
      // DEMANDE de secret : la fenêtre s'affiche dans SA conversation (session
      // légère = celle de l'utilisateur).
      ...(agentExecution ? { secretRequests: agentExecution } : {}),
      heritage: heritageStore,
      conversationArchive,
      ...(librarianConfigured
        ? {
            librarian: {
              client: librarianClient,
              archive: librarianArchive,
              // ⚠️ LECTURE du TEXTE d'une page (`POST /read`) : c'est cet outil qui
              // évite au modèle de réclamer une capture d'écran faute de texte.
              read: librarianClient,
              screenshot: librarianClient,
              shots: librarianShots,
              // ⚠️ MÊME copie que pour un run distant : une capture devient un FICHIER
              // de la conversation (donc listable, lisible et transférable), comme
              // une image générée. En local, aucun canal n'est publié : c'est
              // l'interface qui l'affiche (trame de contrôle `captured`).
              files: generatedImageFiles,
              onShot: (view: LibrarianShotView) => emitLibrarianShot(view),
              captureEnabled: () => config.getString("librarian.screenshot") === "on",
            },
          }
        : {}),
      // FICHIERS : Yuki peut RENVOYER un fichier déjà présent dans la
      // conversation (fichier reçu, ou fichier déposé pour l'utilisateur).
      files: filesService,
      // IMAGES : Yuki génère une image sur le serveur ComfyUI, la VOIT (elle peut
      // juger et régénérer) et l'utilisateur la voit dans le fil (same-origin).
      images: {
        generator: comfyGenerator,
        // ⚠️ La copie rend l'image LISTABLE, LISIBLE et TRANSFÉRABLE (elle devient
        // un fichier de la conversation, rattaché au fil). Un échec de copie
        // n'échoue pas la génération : il devient un avertissement du résultat.
        archive: generatedImageFiles,
        onImage: (view: ComfyImageView) => emitGeneratedImage(view),
        // FICHE de l'image (prompt final) : émise APRÈS l'image, affichée SOUS
        // elle. Persistée avec l'image ⇒ la carte revient complète au rechargement.
        onImageFinalPrompt: (view: ComfyImageFinalPromptView) => {
          try {
            comfyImages.attachFinalPrompt(view.id, view.finalPrompt);
          } catch (error) {
            logger.warn("comfy.image.final_prompt.failed", { error: messageOf(error) });
          }
          for (const listener of [...imageFinalPromptListeners]) {
            try {
              listener(view);
            } catch {
              // Un client en échec ne doit pas interrompre les autres.
            }
          }
        },
        styles: {
          candidates: () => comfyWorkflows.candidates(),
          enabled: () => config.getString("images.baseUrl").trim() !== "",
        },
        // ⚠️ CONSIGNES D'ÉCRITURE par workflow : elles vivent AVEC le workflow
        // (même fichier `comfy/workflows.json`) et ne sont servies QU'À LA
        // DEMANDE, par l'outil `consulter_workflow` — jamais dans le prompt
        // système, jamais dans la scène, jamais dans le graphe posté à ComfyUI.
        workflows: {
          candidates: () => comfyWorkflows.candidates(),
          documentationOf: (name: string) => comfyWorkflows.get(name)?.documentation ?? "",
        },
      },
      personality: personalityStore,
      rules: rulesStore,
      // DRAIN GROUPÉ des notifications de sources : le host demande le bloc
      // `<sources>` au DÉBUT de chaque tour (jamais pendant) et le fusionne dans
      // l'envoi de ce tour — un seul `send`, donc pas de rafale de tours.
      sources: sourcesService,
      // ⚠️ ENVOI PROGRAMMÉ (`programmer_envoi`, lot 28) : depuis la conversation LOCALE
      // aussi — c'est même le cas le plus fréquent (« poste ça à 16h10 » se dit dans le
      // fil, même si la publication vise un canal).
      envoisProgrammes: portEnvoisProgrammes,
      // ⚠️ TÂCHE PLANIFIÉE (`planifier_tache`, lot 31) : « à 8 h, résume-moi le journal ».
      // Le résultat revient dans CETTE conversation (elle existe encore), et le fil n'est
      // jamais renommé « Déclencheurs » (`perso`).
      planifierTache: portPlanificationTache,
      eventSource: delegation,
      llmAvailable: () => resolveAvail().isAvailable("light"),
      memory: memoryService,
      // ⚠️ BORNE DES IMAGES SUR LE FIL : le SDK renvoie TOUT l'historique à
      // chaque tour, donc une image rendue par un outil repartait à chaque
      // tour suivant (`500 request entity too large`, contexte texte pourtant
      // minuscule). Relue à chaque appel ⇒ réglage `apply: hot`.
      imageRequestBudgetBytes: () => config.getNumber("files.imageRequestBudgetBytes"),
      // RÉACTIONS : le modèle les VOIT au tour suivant (prompt système, borné),
      // sans qu'aucun tour ne soit déclenché. Lecture seule depuis l'extension.
      reactions: reactionStore,
      logger,
    });
    // ⚠️ RÉVEIL DES JOBS — INVARIANT : **dans un canal, UN SEUL RÉDACTEUR, le tour de
    // Yuki** (`docs/lot18-chat.md`). Un job terminé doit être ANNONCÉ là où son auteur
    // attend, mais le serveur n'écrit jamais à sa place : le rapport est INJECTÉ comme
    // message dans la conversation du canal, Yuki le lit et sa RÉPONSE est publiée
    // (`wakeReport` des adaptateurs).
    //  - conversation LOCALE ⇒ le host Pi, à l'IDENTIQUE (il refuse une session qu'il
    //    n'a pas ouverte, `src/pi/sdk-host.ts` : un canal n'est pas une session Pi) ;
    //  - conversation de CANAL ⇒ `wake`, et le texte publié n'est qu'un REPLI dit
    //    quand le tour n'a pas pu avoir lieu (`createChannelAwareWaker`).
    const jobReportWaker = createChannelAwareWaker({
      fallback: host,
      // ⚠️ RÉVEIL : le rapport entre dans la conversation du canal comme message
      // SYSTÈME (`frameRapportSysteme`) ; les fichiers du job y sont rattachés pour que
      // Yuki puisse les publier. Le tour est borné par l'adaptateur (`ReplyLimiter`).
      wake: async (request) => {
        const plateforme = mirrorPlatformOf(request.conversationId);
        if (!plateforme) {
          throw new Error(
            `Conversation « ${request.conversationId} » : la plateforme du canal est inconnue.`,
          );
        }
        const adapter = getAdapter(plateforme);
        if (!adapter.wakeReport) {
          throw new Error(
            `La plateforme « ${plateforme} » ne sait pas réveiller Yuki dans un canal.`,
          );
        }
        await adapter.wakeReport(request);
      },
      // ⚠️ REPLI (SEUL cas où le serveur parle) : MÊME chemin que `envoyer_fichier`
      // (`envoyerDansCanal`), donc aucun second mécanisme de publication.
      post: (conversationId, text, fichiers) =>
        envoyerDansCanal(conversationId, text, fichiers),
      logger,
    });
    // ⚠️ `delegation` peut manquer (profil restreint ⇒ aucun worker lourd) : le
    // réveil est alors inutile, puisque rien ne peut être délégué.
    delegation?.setWaker(jobReportWaker);
    // ⚠️ Même réveil pour l'ARCHIVAGE du libraire : `archive_libraire` rend la
    // main tout de suite et son issue est rapportée plus tard — dans le canal
    // quand l'archivage a été demandé depuis un canal.
    librarianArchive.setWaker(jobReportWaker);
    // Réveil du modèle en fin de commande VALIDÉE : rapport synthétique portant
    // stdout/stderr/code de sortie, corrélé par `approval_id` (éphémère côté
    // humain : ni transcript, ni snapshot, ni rejeu, ni mémoire).
    // ⚠️ Aucune commande ne peut être approuvée depuis un canal (les outils à
    // approbation sont retirés de la politique distante), donc ce réveil ne
    // concerne en pratique que les conversations locales.
    agentExecution?.setWaker(jobReportWaker);

    host.subscribeAll((event) => {
      if (event.type === "state") {
        activeRuns = event.state === "streaming" ? 1 : 0;
      }
    });

    try {
      await host.start();
      piStatus = "ready";
      sessionsCount = (await host.listSessions()).length;
    } catch (error) {
      piStatus = "error";
      logger.error("pi.start.failed", { error: messageOf(error) });
    }

    // SOURCES : le host est prêt ⇒ on branche le réveil (tour `lancer`) et le
    // suivi des réponses (attachées aux entrées de la boîte, jamais dans un fil).
    sourcesService.setWaker(host);

    // MOTEUR HORLOGE (lot 2) — UN SEUL `setInterval` de 30 s (`DeclencheurBalayeur`),
    // démarré SEULEMENT quand un host existe : sans modèle, un passage planifié
    // n'aurait personne à réveiller (il serait journalisé `echec` à chaque tir).
    // ⚠️ L'état (`prochainPassage`, `dernierPassage`, `actif`, `toursDuJour`) est
    // PERSISTÉ dans `sources.json` : le premier balayage traite un passage manqué
    // pendant l'arrêt (règle de rattrapage : une fois si < 1 h, sinon sauté).
    // ⚠️ MOTEUR HORLOGE — LE DÉCLENCHEUR CRÉE **DIRECTEMENT UN JOB LOURD**
    // (décision 2026-11-04) : pas de tour de conversation, pas de délégation
    // depuis le rôle léger (qui n'a aucun outil d'action). Le worker lourd a déjà
    // tout ; son résultat est publié dans le fil « Déclencheurs » par
    // `host.publierMessage` (message assistant persisté, sans tour de modèle).
    // ⚠️ Un job ne peut PAS créer de déclencheur : le worker lourd n'a aucun outil
    // pour cela (anti-enchaînement structurel).
    if (delegation) {
      const serviceDelegation = delegation;
      sourcesService.setDeclencheurPorts({
        jobs: {
          delegate: (request) =>
            serviceDelegation.delegate({
              task: request.task,
              ...(request.context !== undefined ? { context: request.context } : {}),
              background: request.background !== false,
              lightSessionId: request.lightSessionId,
              ...(request.origin !== undefined ? { origin: request.origin } : {}),
            }),
          cancelJob: (jobId) => serviceDelegation.cancelJob(jobId),
        },
        publication: {
          // ⚠️ LOT 31 — les FICHIERS du résultat voyagent DANS LE TEXTE (marqueurs
          // `[fichier] …` ajoutés par le service) : c'est ce qui rend la carte du
          // résultat cliquable et la fait survivre au rechargement. Le troisième argument
          // porte la même information sous forme structurée, pour un rendu natif futur ;
          // `publierMessage` n'en a pas besoin (il persiste le texte tel quel).
          publier: async (sessionId, texte, fichiers) => {
            if (!host) throw new Error("Le host Pi n'est pas disponible.");
            if (typeof host.publierMessage !== "function") {
              throw new Error(
                "Ce host ne sait pas publier dans une conversation sans tour de modèle.",
              );
            }
            void fichiers;
            await host.publierMessage(sessionId, texte);
          },
        },
        // ⚠️ LOT 31 — MÉTADONNÉES des fichiers du résultat : c'est le service qui rend les
        // marqueurs `[fichier] <id> <nom> (<n> octets)`, donc la carte cliquable.
        fichier: (fichierId) => filesStore.get(fichierId),
      });
      // Le RÉSULTAT d'un job de déclencheur ne réveille PAS le léger : il part
      // par le port des déclencheurs (publier / se taire / éteindre).
      serviceDelegation.setDeclencheurs({
        recevoirResultat: (record) => sourcesService.recevoirResultat(record),
      });
    }

    /**
     * Lot 35e — RÉTENTION des archives de bots supprimés : la purge est faite
     * par le balayeur, JAMAIS par un minuteur dédié. On la limite à une passe
     * par heure : parcourir `bots-supprimes/` à chaque tick de 30 s serait du
     * travail inutile pour un dossier qui ne change qu'à une suppression.
     */
    let dernierePurgeArchives = 0;
    const INTERVALLE_PURGE_ARCHIVES_MS = 3_600_000;
    declencheursBalayeur = new DeclencheurBalayeur({
      store: sourcesStore,
      journal: declencheursJournal,
      // ⚠️ ENVOIS PROGRAMMÉS (lot 28) : exécutés par CE balayeur, jamais par un second
      // `setInterval` — un seul ordonnanceur dans le processus, donc un seul rythme et
      // un seul endroit à arrêter. Le retard est rattrapé une fois si < 1 h, sinon
      // l'envoi est marqué ÉCHOUÉ avec sa raison (jamais publié en retard en silence).
      envoisProgrammes: {
        executerDus: (maintenant) => envoisProgrammes.executerDus(maintenant),
      },
      // ⚠️ CONSOLIDATION HEBDOMADAIRE (lot 29) : port branché sur CE balayeur.
      // Aucun second `setInterval`, aucune `SourceRecord` : la passe est un
      // rendez-vous planifié, pas une source.
      passeHebdo: {
        executerSiDu: (maintenant) => consolidationHebdo?.executerSiDu(maintenant) ?? Promise.resolve(),
      },
      // ⚠️ RÉTENTION DES ARCHIVES DE BOTS SUPPRIMÉS (lot 35e) : 3 mois, purgés
      // par CE balayeur — aucun minuteur nouveau. Un dossier de plus de 90 jours
      // est effacé (journal `bot.archive.purged`) ; 89 jours survit. La purge ne
      // tourne qu'une fois par heure (elle parcourt un dossier, inutile de le
      // faire à chaque tick de 30 s).
      archivesBots: {
        purger: (maintenant) => {
          if (maintenant - dernierePurgeArchives < INTERVALLE_PURGE_ARCHIVES_MS) return 0;
          dernierePurgeArchives = maintenant;
          return purgerArchivesBots({
            stateDir: env.mountPoints.state,
            maintenant,
            logger,
          }).purges.length;
        },
      },
      logger,
      now: () => Date.now(),
      run: (nom, options) =>
        sourcesService.declencher(nom, {
          origine: ORIGINE_HORLOGE,
          ...(options.planifie !== undefined ? { planifie: options.planifie } : {}),
          plafondMs: options.plafondMs,
          signal: options.signal,
          // ⚠️ LOT 31 : le balayeur a DÉJÀ désarmé la tâche ponctuelle (un plantage ne la
          // rejoue pas) — sans ce drapeau, `declencher` la refuserait comme « en veille ».
          ...(options.desarmementPrealable === true ? { desarmementPrealable: true } : {}),
        }),
    });
    declencheursBalayeur.start();
    logger.info("sources.balayeur.started", {
      interval_ms: 30_000,
      planifies: sourcesStore
        .list()
        .filter((record) => record.declencheur.type === "planning").length,
    });

    // --- Providers / modèles LLM : rechargement À CHAUD (`apply: hot`) ------
    // Un changement de FOURNISSEUR (`baseUrl`/`api`), de modèle, de réflexion ou
    // de clé ne doit PLUS exiger de redémarrage. On observe le store : dès qu'un
    // de ces champs change, on réécrit `models.json`, on rafraîchit le runtime de
    // modèles PARTAGÉ (providers reconstruits EN PLACE) et on re-résout le
    // modèle de conversation. Les runs EN COURS se terminent avec leur
    // fournisseur/modèle d'origine ; le changement s'applique au PROCHAIN run /
    // au prochain job de fond (toutes les références sont relues « vivantes »).
    let llmHot = {
      lightApi: effective.light.api,
      lightBaseUrl: effective.light.baseUrl,
      lightModel: effective.light.model,
      lightThinking: effective.light.thinking,
      lightVision: effective.light.vision,
      heavyApi: effective.heavy.api,
      heavyBaseUrl: effective.heavy.baseUrl,
      heavyModel: effective.heavy.model,
      heavyThinking: effective.heavy.thinking,
      heavyVision: effective.heavy.vision,
    };
    const sameLlm = (a: typeof llmHot, b: EffectiveLlmConfig): boolean =>
      a.lightApi === b.light.api &&
      a.lightBaseUrl === b.light.baseUrl &&
      a.lightModel === b.light.model &&
      a.lightThinking === b.light.thinking &&
      a.lightVision === b.light.vision &&
      a.heavyApi === b.heavy.api &&
      a.heavyBaseUrl === b.heavy.baseUrl &&
      a.heavyModel === b.heavy.model &&
      a.heavyThinking === b.heavy.thinking &&
      a.heavyVision === b.heavy.vision;
    stopLlmHotReload = config.subscribe(() => {
      // Rafraîchit d'abord la liste des secrets masqués (clé saisie à chaud) —
      // clés d'env, clés de /config ET secrets du coffre (source unique).
      refreshSecretValues();
      const next = effectiveLlmConfig(config);
      if (sameLlm(llmHot, next)) return;
      llmHot = {
        lightApi: next.light.api,
        lightBaseUrl: next.light.baseUrl,
        lightModel: next.light.model,
        lightThinking: next.light.thinking,
        lightVision: next.light.vision,
        heavyApi: next.heavy.api,
        heavyBaseUrl: next.heavy.baseUrl,
        heavyModel: next.heavy.model,
        heavyThinking: next.heavy.thinking,
        heavyVision: next.heavy.vision,
      };
      logger.info("llm.model.reload.requested", {
        light: next.light.model,
        lightBaseUrl: next.light.baseUrl,
        lightVision: next.light.vision,
        heavy: next.heavy.model,
        heavyBaseUrl: next.heavy.baseUrl,
        heavyVision: next.heavy.vision,
      });
      const apply = host?.applyLlmConfig;
      if (host && apply) {
        void apply
          .call(host, {
            modelsConfig: buildModelsConfigFrom(next),
            conversationModel: resolveModelsFrom(next).light.reference,
            conversationThinking: next.light.thinking,
          })
          .catch((error: unknown) => {
            logger.error("llm.model.reload.failed", { error: messageOf(error) });
          });
      }
    });

    transport = createWsTransport({
      host,
      logger,
      serverVersion: env.version,
      replayBufferSize: config.getNumber("transport.replayBuffer"),
      replayBufferBytes: config.getNumber("transport.replayBytes"),
      // ⚠️ FUSEAU DES HORODATAGES (`ui.timeZone`, défaut UTC) : il remplace le
      // fuseau du NAVIGATEUR que portait la trame `message` (`tz`). Une seule
      // autorité pour les prompts, le fil de canal et la trame `welcome`.
      timeZone: { current: fuseauHorodatage },
      // « Continuer dans une conversation dédiée » : appel LLM ISOLÉ (session
      // éphémère en mémoire) NOURRI avec le transcript, sur le compte LOURD
      // quand il est disponible — appel LONG et exigeant, qui ne doit pas
      // occuper l'unique slot du léger réservé à la conversation — avec repli
      // sur le léger. La référence est RELUE à chaque appel ⇒ un changement de
      // modèle s'applique sans redémarrage. Aucun tour n'est exécuté dans la
      // conversation d'origine : elle n'est jamais polluée ni modifiée.
      recap: createRecapService(
        createSdkRecapWriter({
          cwd: env.piCwd,
          agentDir: env.piAgentDir,
          authPath: join(env.piAgentDir, "auth.json"),
          modelsPath,
          modelReference: () =>
            memoryWriteModelReference({
              heavyAvailable: resolveAvail().isAvailable("heavy"),
              heavyRef: liveHeavyReference(),
              lightRef: liveLightReference(),
              logger,
              usage: "recapitulatif",
            }),
          // Récapituler est une tâche de FIDÉLITÉ (restitution) : la réflexion
          // suit `llm.<role>.thinking` du modèle RÉELLEMENT retenu (lourd, ou
          // léger en repli) — jamais un `off` figé.
          thinking: () =>
            resolveAvail().isAvailable("heavy")
              ? liveHeavyThinking()
              : liveLightThinking(),
          timeoutMs: () => config.getNumber("recap.timeoutMs"),
          logger,
        }),
      ),
      // IMAGES générées : trame de contrôle `image` (aucun `seq` consommé, jamais
      // bufferisée), routée vers la SEULE conversation demandeuse. L'image est
      // servie en same-origin : la CSP n'est jamais élargie.
      ...(imagesGateway ? { images: imagesGateway } : {}),
      // FICHIERS : rattachement des fichiers joints à un message (`attach`) et
      // envoi par Yuki (trame de contrôle `file_sent`, jamais bufferisée).
      files: filesService,
      // ⚠️ VISION de la conversation : la capacité DÉCLARÉE (`/config`
      // `llm.light.vision`) est relue à CHAQUE message (apply: hot). Déclarée
      // sans vision ⇒ une image jointe est REFUSÉE avec un motif explicite au
      // lieu d'être silencieusement remplacée par « (tool image omitted…) ».
      vision: {
        conversationReceivesImages: () => effectiveLlmConfig(config).light.vision,
      },
      // TRANSFERT depuis une machine : trame de contrôle `file_received` (carte
      // cliquable « Inclure dans la discussion ») — signalement indispensable,
      // sinon l'utilisateur ignore que le fichier est sur le disque de Yuki.
      ...(agentTransfers ? { agentTransfers } : {}),
      // Épinglage des conversations : store hôte SÉPARÉ du JSONL du SDK Pi.
      pins: SessionPinStore.open({ path: env.sessionPinsPath, logger }),
      // SOURCES : la trame `sessions` dit quelles sources postent dans chaque fil
      // (modale de suppression) et la suppression d'un fil RÉAFFECTE les sources
      // qui y postaient (« nouvelle conversation à chaque fois ») au lieu de les
      // laisser pointer dans le vide.
      sources: sourcesService,
      // DISCUSSIONS : trame `sessions` des CANAUX MIROIR (`kind: "remote"`,
      // `readOnly` côté interface web, `canRun`), sélection d'un canal, et refus
      // d'écriture (`conversation_lecture_seule`) / de création
      // (`creation_desactivee`) tant que le mode est distant.
      chat: chatService,
      // RÉACTIONS : écrire une réaction ne déclenche AUCUN tour et n'alimente
      // jamais la synthèse vocale. Seules les RÉGULARITÉS (le même jugement sur
      // plusieurs messages) sont proposées à la mémoire — avec son filtre, son
      // `why` obligatoire et sa déduplication, jamais pour une réaction isolée.
      reactions: {
        set: (sessionId, entryId, reaction) => {
          const regularity = reactionStore.set(sessionId, entryId, reaction);
          if (regularity) rememberReactionRegularity(regularity);
          return regularity !== null;
        },
        clear: (sessionId, entryId) => reactionStore.clear(sessionId, entryId),
        forSession: (sessionId) => reactionStore.forSession(sessionId),
      },
      // Encart agents de la barre latérale (absent si le registre n'a pas démarré).
      ...(agentsGateway ? { agents: agentsGateway } : {}),
      // Validations humaines (D118) DANS la conversation : le transport route la
      // demande vers les clients de la SEULE conversation concernée. Le panneau
      // /config garde son affichage (routes HTTP) pour les cas hors conversation.
      ...(agentExecution ? { approvals: agentExecution } : {}),
      // Demandes de SECRET (`awaiting_secret`) : flux DÉDIÉ, trame de contrôle
      // éphémère routée vers la SEULE conversation (jamais une valeur).
      ...(agentExecution ? { secrets: agentExecution } : {}),
      // Captures d'écran : l'image est diffusée en trame de CONTRÔLE vers la
      // SEULE conversation demanderesse (jamais bufferisée, jamais persistée).
      // Combine les captures d'AGENTS et les captures de PAGES WEB (Libry).
      screenshots: {
        subscribeScreenshots: (listener) => {
          const offAgents = agentExecution?.subscribeScreenshots(listener);
          const offLibrarian = librarianShotBus.subscribeScreenshots(listener);
          return () => {
            offAgents?.();
            offLibrarian();
          };
        },
      },
      tts: {
        enabled: isTtsEnabled(config),
        config: {
          getString: (path) => config.getString(path),
          getNumber: (path) => config.getNumber(path),
        },
        synthesizer: segmentSynthesizer,
        resolveVoice: (id) => voiceStore.resolveVoice(id).voice,
        logger,
      },
    });

    // Notifications : on branche les DÉCLENCHEURS sur les événements réels
    // (fin de tâche de fond, validation en attente, réponse prête). Le service
    // lit la présence des clients via le transport et décide d'émettre ou non.
    stopPushTriggers = pushService?.bind({
      host,
      ...(agentExecution ? { approvals: agentExecution } : {}),
    });

    // ⚠️ FUSEAU DES HORODATAGES : on ANNONCE le changement aux clients
    // connectés (`time_zone`), sinon l'interface garderait l'ancien fuseau
    // jusqu'au prochain rechargement — alors que le serveur, lui, écrit déjà les
    // prompts dans le nouveau. Deux fuseaux pour un même instant : exactement le
    // défaut qu'on ferme.
    let fuseauCourant = fuseauHorodatage();
    stopTimeZoneReload = config.subscribe(() => {
      const suivant = fuseauHorodatage();
      if (suivant === fuseauCourant) return;
      fuseauCourant = suivant;
      transport?.notifyTimeZone?.(suivant);
      logger.info("ui.timezone.changed", { timeZone: suivant });
    });
  }

  const getSubsystems = (): SubsystemsSnapshot => {
    const availability = resolveAvail();
    // Modèles EFFECTIFS lus en direct : un changement à chaud doit se refléter
    // dans /health — afficher l'ancien modèle serait un MENSONGE.
    const live = effectiveLlmConfig(config);
    const counts =
      delegation?.counts() ??
      { running: 0, queued: 0, completed: 0, failed: 0, interrupted: 0 };
    return {
      pi: {
        status: piStatus,
        cwd: env.piCwd,
        agentDir: env.piAgentDir,
        sessionsDir: env.piSessionsDir,
        model: resolveModelsFrom(live).light.reference,
        sessionsCount,
        activeRuns,
      },
      transport: {
        ws: {
          clients: transport?.clientCount() ?? 0,
          replayBufferSize: config.getNumber("transport.replayBuffer"),
        },
        sse: false,
      },
      llm: {
        light: {
          provider: llmConfig.providers.light.id,
          model: live.light.model,
          status: availability.light.status,
          keyPresent: availability.light.keyPresent,
        },
        heavy: {
          provider: llmConfig.providers.heavy.id,
          model: live.heavy.model,
          status: availability.heavy.status,
          keyPresent: availability.heavy.keyPresent,
        },
      },
      jobs: {
        running: counts.running,
        queued: counts.queued,
        completed: counts.completed,
        failed: counts.failed,
        interrupted: counts.interrupted,
        maxConcurrent: config.getNumber("delegation.maxConcurrent"),
      },
      // Lot 8 : état informatif du moteur TTS (jamais bloquant pour /health).
      tts: (() => {
        const report = ttsDiagnostics.cachedStatus();
        return {
          status: report.state,
          modelCount: report.modelCount,
          engine: report.engine,
        };
      })(),
    };
  };

  // Déclencheur d'arrêt gracieux, alimenté juste après la création du serveur.
  // La route `POST /api/admin/restart` le rappelle avec le motif `RESTART` :
  // l'arrêt gracieux sort alors en 75 (`EX_TEMPFAIL`) et le superviseur interne
  // (`infra/gateway/supervisor.mjs`) relance le programme SANS redémarrer le
  // conteneur — jamais via le socket Docker.
  let triggerShutdown: ((reason: string) => void) | undefined;
  const server = createServer(
    {
      env,
      report: gate.report,
      gatePassed: gate.passed,
      startedAt,
      volumes,
      getSubsystems,
      config: {
        runtime: config,
        logger,
        // Mot de passe d'INSTANCE : section dédiée de /config (définir / changer).
        ...(instancePassword ? { password: instancePassword } : {}),
        // Retirer le mot de passe est REFUSÉ tant qu'un agent sensible existe.
        sensitiveAgentCount: () =>
          agentsDeps
            ? agentsDeps.store.list().filter((record) => record.sensitive === true && !record.revoked)
                .length
            : 0,
        onSecretSeen: rememberSecretValue,
        // BOTS (lot 35b, sous-lot 1b-3) : `GET /api/bots` et
        // `/api/bots/<id>/config`. Le registre lu au démarrage dit QUELS bots
        // existent (`null` en mode mono-bot historique ⇒ « yuki » seul).
        // ⚠️ LOT 35e : les mêmes routes servent l'ADMINISTRATION (créer,
        // cloner, supprimer) — `stateDir` est le volume `state` et le registre
        // en mémoire est REMPLACÉ après chaque écriture (deps mutables).
        // POINT D'EXTENSION : `retirerDesListesDAgents` sera branché quand les
        // agents porteront la liste de leurs bots autorisés (rien n'est inventé ici).
        bots: { registre: bots.registre, stateDir: env.mountPoints.state },
      },
      personality: { store: personalityStore, logger },
      rules: { store: rulesStore, logger },
      // SOURCES : API générique de réveil (`POST /api/sources/<nom>/messages`)
      // + boîte « Notifications ». Mêmes garde-fous que `/api/config` pour les
      // écritures d'administration ; le jeton de chaque source authentifie les
      // messages poussés par les programmes extérieurs.
      sources: {
        service: sourcesService,
        logger,
        journal: declencheursJournal,
        // PRÉ-AUTORISATIONS (lot 4/4) : registre persisté + annuaire des agents,
        // pour que la page de gestion propose une MACHINE précise (jamais un
        // champ libre où l'on taperait un identifiant au hasard).
        preAutorisations: preAutorisationsStore,
        // ENVOIS PROGRAMMÉS (lot 28) : la page de gestion les AFFICHE et les ANNULE.
        // ⚠️ Une liste invisible serait une bombe à retardement : c'est cette route qui
        // rend la fonction utilisable par une personne, pas seulement par le modèle.
        envois: envoisProgrammes,
        ...(agentStoreRef ? { agents: agentStoreRef } : {}),
      },
      // DISCUSSIONS : `GET /api/chat/status` (lecture GARDÉE par l'en-tête
      // `X-Yuki-Config: 1`) — mode, état de la plateforme, état Mattermost, motif de
      // refus de création ; plus l'URL du serveur, le JETON (écriture seule, une fois) et
      // le mode de réponse PAR CANAL. ⚠️ Jamais un jeton en réponse.
      chat: {
        service: chatService,
        mattermost: mattermostPort,
        discord: discordPort,
        logger,
        // ⚠️ RETOMBÉE DU MODE après suppression d'un miroir : `chat.mode` est un
        // réglage PROPRE AU BOT ACTIF (`scope: "bot"`, `apply: hot`) — il s'écrit
        // donc dans l'overlay du bot actif, jamais dans `config.json` d'instance.
        saveMode: (mode: string) => {
          config.update({ "chat.mode": mode }, { portee: "bot" });
        },
      },
      // Administration de la mémoire (archivage récupérable) : disponible
      // uniquement quand le service mémoire existe (porte passée).
      ...(memoryService
        ? {
            memory: {
              admin: memoryService,
              logger,
              ...(consolidationHebdo ? { consolidation: consolidationHebdo } : {}),
            },
          }
        : {}),
      // Administration de l'archive « vie antérieure » : INTERFACE uniquement.
      // RÉUTILISE le HeritageStore de LECTURE SEULE (l'outil du modèle reste
      // inchangé) ; disponible quand l'archive a été mise en place (porte passée).
      ...(heritageStore
        ? { heritage: { admin: new HeritageAdminService(heritageStore, { logger }), logger } }
        : {}),
      // Captures de pages web : servies MÊME ORIGINE (`/captures/<id>.<ext>`).
      ...(librarianShots ? { captures: { store: librarianShots, logger } } : {}),
      // FICHIERS échangés : dépôt (`POST /api/files`), liste, suppression et
      // SERVICE same-origin (`/fichiers/<id>.<ext>`). Disponible même en mode
      // dégradé : stocker et télécharger ne demande aucun modèle.
      files: { service: filesService, logger },
      // AVATAR : image PERSISTANTE servie same-origin (`/avatar`), API
      // (`/api/avatar`) et favicon (`/favicon.ico`). Hors du magasin de fichiers.
      avatar: { store: avatarStore, logger },
      // IMAGES générées : import des workflows, bouton de test et SERVICE
      // same-origin (`/images/<id>.<ext>`). Disponible même en mode dégradé :
      // importer un workflow et tester le serveur ne demande aucun modèle.
      images: {
        workflows: comfyWorkflows,
        images: comfyImages,
        // Le bouton « Tester la connexion » vérifie les valeurs SAISIES (pas
        // encore enregistrées) quand l'UI les fournit ; sinon la configuration.
        clientFor: (override) =>
          new ComfyClient({
            config: () => ({
              baseUrl: override.baseUrl ?? config.getString("images.baseUrl"),
              apiKey: override.apiKey ?? config.getString("images.apiKey"),
            }),
            logger,
            requestTimeoutMs: 8_000,
          }),
        logger,
      },
      voices: voicesDeps,
      tts: ttsDeps,
      ...(agentsDeps ? { agents: agentsDeps } : {}),
      ...(secretStore ? { secrets: { store: secretStore, logger } } : {}),
      ...(pushDeps ? { push: pushDeps } : {}),
      admin: {
        logger,
        requestShutdown: () => triggerShutdown?.(RESTART_REASON),
        // Refuse le redémarrage tant qu'un téléchargement est actif (le process
        // serait tué sans explication). Aucun téléchargement actif ⇒ inchangé.
        downloads: {
          hasActive: () => ttsDownloads.hasActive(),
          activeId: () => ttsDownloads.activeId(),
        },
      },
    },
    transport,
  );

  triggerShutdown = installGracefulShutdown(server, logger, {
    beforeClose: async () => {
      stopAgentsCertReload?.();
      stopAgentsCertReload = undefined;
      // Verrou des agents sensibles : plus aucun balayage après l'arrêt.
      stopLockSweep?.();
      stopLockSweep = undefined;
      // Rétention des fichiers : plus aucun balayage après l'arrêt.
      if (filesPurgeTimer) clearInterval(filesPurgeTimer);
      filesPurgeTimer = undefined;
      // MOTEUR HORLOGE : plus aucun passage planifié, et les tours en vol sont
      // abandonnés (l'état reste persisté dans `sources.json`).
      declencheursBalayeur?.stop();
      declencheursBalayeur = undefined;
      stopLlmHotReload?.();
      stopLlmHotReload = undefined;
      stopTimeZoneReload?.();
      stopTimeZoneReload = undefined;
      stopPushTriggers?.();
      stopPushTriggers = undefined;
      // DISCUSSIONS : plus aucune reconnexion ni rattrapage après l'arrêt (aucune
      // écriture tardive dans le miroir, aucune socket orpheline).
      await mattermost.disconnect();
      await discord.disconnect();
      // SOURCES : plus aucun suivi de run après l'arrêt (aucune écriture tardive
      // dans la boîte de notifications).
      sourcesService.detach();
      if (agentsServer) await closeAgentsServer(agentsServer);
      await transport?.close();
      await host?.stop();
      if (memoryService) {
        await memoryService.drain();
        memoryService.close();
        memoryService = undefined;
      }
      conversationArchive?.close();
      conversationArchive = undefined;
    },
  });

  const address = await startServer(server, env.gatewayHost, env.gatewayPort);
  logger.info("gateway.listening", {
    host: address.address,
    port: address.port,
    resolvedProfile: gate.report.resolvedProfile,
    mode: gate.report.mode,
    resolution: gate.report.resolution,
    pi: piStatus,
    light: availabilityAtStart.light.status,
    heavy: availabilityAtStart.heavy.status,
  });

  // DISCUSSIONS (lot 18, lot 2) — la SYNCHRONISATION démarre dès que la plateforme est
  // CONFIGURÉE (URL du serveur + jeton du bot dans le coffre), et cela INDÉPENDAMMENT
  // du mode affiché : `chat.mode` ne filtre que la VUE (décision du lot 1). Un échec est
  // journalisé ET remonté par le statut ; il ne bloque jamais le démarrage du gateway.
  if (chatMirror.baseUrl() !== "" && secretStore?.has(MATTERMOST_TOKEN_SECRET_NAME) === true) {
    void mattermost.connect().catch((error: unknown) => {
      logger.warn("chat.mattermost.connect_failed", { error: messageOf(error) });
    });
  }

  // DISCORD (lot 21) — même règle : la synchronisation démarre dès que le JETON est au
  // coffre, indépendamment du mode affiché. ⚠️ Aucune condition sur `guildId` : vide
  // signifie « tous les serveurs du bot » (voir `DiscordAdapterDeps.guildId`).
  if (secretStore?.has(DISCORD_TOKEN_SECRET_NAME) === true) {
    void discord.connect().catch((error: unknown) => {
      logger.warn("chat.discord.connect_failed", { error: messageOf(error) });
    });
  }

  // Port machines (Lot 4) : écoute LAN mTLS. Un échec d'écoute est journalisé
  // mais NE fait PAS tomber le gateway humain.
  if (agentsServer) {
    try {
      const agentsAddress = await startAgentsServer(agentsServer, agentsBindHost, agentsPort);
      logger.info("agents.listening", {
        host: agentsAddress.address,
        port: agentsAddress.port,
      });
    } catch (error) {
      logger.error("agents.listen.failed", {
        host: agentsBindHost,
        port: agentsPort,
        error: messageOf(error),
      });
    }
  }
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`Yuki gateway — erreur fatale : ${message}\n`);
  process.exitCode = 1;
});
