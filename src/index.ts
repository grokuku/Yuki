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
  ComfyClient,
  ComfyWorkflowStore,
  GeneratedImagesStore,
  createComfyGenerator,
  type ComfyImageFinalPromptView,
  type ComfyImageView,
  type ImagesGatewayPort,
} from "./comfy/index.js";
import { createFilesService, FilesStore } from "./files/index.js";
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
  buildModelsConfigFrom,
  evaluateMissingKeyPolicy,
  resolveAvailability,
  resolveModelsFrom,
  resolveProvidersFrom,
  toolAllowlist,
  type EffectiveLlmConfig,
  type LlmConfig,
  type ThinkingLevelName,
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
  ConversationArchiveStore,
  HeritageAdminService,
  HeritageStore,
  MemoryIndex,
  MemoryService,
  MemoryStore,
  REACTIONS_SOURCE,
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
import { createPiHost, createSdkHeavyWorker, createSdkLibrarianSynthesizer, createSdkMemoryExtractor, createSdkRecapWriter, SessionPinStore, type PiHost, type PiThinkingLevel } from "./pi/index.js";
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
    },
    heavy: {
      api: config.getString("llm.heavy.api"),
      baseUrl: config.getString("llm.heavy.baseUrl"),
      model: config.getString("llm.heavy.model"),
      thinking: config.getString("llm.heavy.thinking") as ThinkingLevelName,
    },
  };
}

async function main(): Promise<void> {
  // --- (1) Configuration : store + env + défauts ----------------------------
  const env = loadEnv();
  const config = createConfigRuntime({
    env,
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

  /** Balayage périodique de la RÉTENTION du volume `state` (voir plus bas). */
  let filesPurgeTimer: ReturnType<typeof setInterval> | undefined;

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
  // Purge RÉELLE au démarrage : un fichier expiré pendant l'arrêt est supprimé
  // avec son analyse (le plafond ne sert à rien si l'expiré reste).
  const purgedFilesAtStart = filesStore.purgeExpired();
  const filesService = createFilesService({
    store: filesStore,
    logger,
    maxAttachments: () => config.getNumber("files.maxAttachments"),
    promptChars: () => config.getNumber("files.promptChars"),
    promptTotalChars: () => config.getNumber("files.promptTotalChars"),
  });
  // Balayage périodique : la rétention est une BORNE DE DISQUE, pas une promesse.
  // ⚠️ Le MÊME balayage purge les pièces jointes, les images générées et les
  // captures du libraire (voir `purgeStateVolume`) : un seul réglage, une seule
  // passe ⇒ impossible qu'un type survive au réglage d'un autre.
  filesPurgeTimer = setInterval(purgeStateVolume, FILES_PURGE_INTERVAL_MS);
  filesPurgeTimer.unref?.();
  logger.info("files.ready", {
    dir: env.filesDir,
    purged: purgedFilesAtStart,
    retentionDays: config.getNumber("files.retentionDays"),
    maxFileBytes: config.getNumber("files.maxFileBytes"),
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
    // Délai de la génération COMPLÈTE, réglable à chaud (10 s à 10 min).
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
  /** Bus de diffusion des images générées (posé quand le transport démarre). */
  let imagesGateway: ImagesGatewayPort | undefined;
  let transport: Transport | undefined;
  let delegation: DelegationService | undefined;
  /** Désabonnement du rechargement À CHAUD des modèles LLM (voir plus bas). */
  let stopLlmHotReload: (() => void) | undefined;
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

  if (gate.passed) {
    const idleTimeoutMs = config.getNumber("delegation.idleTimeoutMs");
    const totalTimeoutMs = config.getNumber("delegation.totalTimeoutMs");

    const jobStore = JobStore.open({ path: env.jobsStorePath, logger });
    const queue = new JobQueue({
      maxConcurrent: config.getNumber("delegation.maxConcurrent"),
      maxQueue: config.getNumber("delegation.maxQueue"),
    });
    const heavyWorker = createSdkHeavyWorker({
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
        executionEnabled: agentExecution !== undefined,
        screenshotsEnabled: agentExecution !== undefined,
        secretsEnabled: secretStore !== undefined,
      }),
      ...(agentExecution ? { execution: agentExecution } : {}),
      ...(agentExecution ? { screenshots: agentExecution } : {}),
      ...(secretStore ? { secrets: secretStore } : {}),
      idleTimeoutMs,
      totalTimeoutMs,
      logger,
    });
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
        thinking: "off",
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
        modelReference: liveLightReference,
        thinking: "off",
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

    host = createPiHost({
      agentDir: env.piAgentDir,
      cwd: env.piCwd,
      home: env.piHome,
      sessionsDir: env.piSessionsDir,
      systemPrompt: appendVoiceInstruction(
        config.getString("prompts.light"),
        isTtsEnabled(config),
      ),
      settingsSeedPath: env.piSettingsSeedPath,
      modelsConfig: buildModelsConfigFrom(effective),
      model: lightRef,
      thinking: lightThinking,
      tools: toolAllowlist("light", {
        delegationEnabled: heavyAvailableAtStart,
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
        librarianEnabled: librarianConfigured,
        librarianCaptureEnabled: librarianCaptureEnabledAtStart,
        // FICHIERS : `envoyer_fichier` (Yuki RENVOIE un fichier de la
        // conversation). Toujours actif : le stockage existe dès le démarrage.
        filesEnabled: true,
        // IMAGES générées : l'outil `generer_image` est TOUJOURS proposé (il
        // refuse explicitement tant qu'aucune URL de serveur n'est configurée,
        // avec la marche à suivre) — configurer ComfyUI ne demande donc aucun
        // redémarrage.
        imagesEnabled: true,
      }),
      ...(heavyAvailableAtStart ? { delegation } : {}),
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
              screenshot: librarianClient,
              shots: librarianShots,
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
      eventSource: delegation,
      llmAvailable: () => resolveAvail().isAvailable("light"),
      memory: memoryService,
      // RÉACTIONS : le modèle les VOIT au tour suivant (prompt système, borné),
      // sans qu'aucun tour ne soit déclenché. Lecture seule depuis l'extension.
      reactions: reactionStore,
      logger,
    });
    delegation.setWaker(host);
    librarianArchive.setWaker(host);
    // Réveil du modèle en fin de commande VALIDÉE : rapport synthétique portant
    // stdout/stderr/code de sortie, corrélé par `approval_id` (éphémère côté
    // humain : ni transcript, ni snapshot, ni rejeu, ni mémoire).
    agentExecution?.setWaker(host);

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
      heavyApi: effective.heavy.api,
      heavyBaseUrl: effective.heavy.baseUrl,
      heavyModel: effective.heavy.model,
      heavyThinking: effective.heavy.thinking,
    };
    const sameLlm = (a: typeof llmHot, b: EffectiveLlmConfig): boolean =>
      a.lightApi === b.light.api &&
      a.lightBaseUrl === b.light.baseUrl &&
      a.lightModel === b.light.model &&
      a.lightThinking === b.light.thinking &&
      a.heavyApi === b.heavy.api &&
      a.heavyBaseUrl === b.heavy.baseUrl &&
      a.heavyModel === b.heavy.model &&
      a.heavyThinking === b.heavy.thinking;
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
        heavyApi: next.heavy.api,
        heavyBaseUrl: next.heavy.baseUrl,
        heavyModel: next.heavy.model,
        heavyThinking: next.heavy.thinking,
      };
      logger.info("llm.model.reload.requested", {
        light: next.light.model,
        lightBaseUrl: next.light.baseUrl,
        heavy: next.heavy.model,
        heavyBaseUrl: next.heavy.baseUrl,
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
            }),
          // Récapituler est une tâche de FIDÉLITÉ (restitution), pas de
          // raisonnement : le niveau de réflexion reste « off » pour être
          // compatible avec les DEUX modèles et borné en durée.
          thinking: "off",
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
      // Épinglage des conversations : store hôte SÉPARÉ du JSONL du SDK Pi.
      pins: SessionPinStore.open({ path: env.sessionPinsPath, logger }),
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
      },
      personality: { store: personalityStore, logger },
      rules: { store: rulesStore, logger },
      // Administration de la mémoire (archivage récupérable) : disponible
      // uniquement quand le service mémoire existe (porte passée).
      ...(memoryService ? { memory: { admin: memoryService, logger } } : {}),
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
      stopLlmHotReload?.();
      stopLlmHotReload = undefined;
      stopPushTriggers?.();
      stopPushTriggers = undefined;
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
