/**
 * Barrel du sous-domaine SDK Pi (`src/pi/sdk/**`).
 *
 * ⚠️ Seul sous-domaine autorisé à importer `@earendil-works/...` et `typebox`.
 * Aucun autre domaine (`src/llm`, `src/jobs`, `src/delegation`) ne doit y
 * accéder ; rien hors de `src/pi/**` n'importe d'ici.
 *
 * Ce barrel n'importe PAS directement le SDK (voir test de frontière) : il
 * ré-exporte les modules de la couche.
 */

export {
  getSharedModelRuntime,
  providerHasAuth,
  resolveSdkModel,
  resolveSdkThinking,
} from "./model-runtime.js";
export type { SdkModel, SdkModelRuntimeConfig, SdkThinkingLevel } from "./model-runtime.js";

export { createEphemeralSession, createLightRuntime } from "./session-factory.js";
export type {
  EphemeralSession,
  EphemeralSessionOptions,
  LightRuntimeOptions,
} from "./session-factory.js";

export { createSdkHeavyWorker } from "./heavy-worker.js";
export type { SdkHeavyWorkerConfig } from "./heavy-worker.js";

export { createDelegateTools, createRunContextTracker } from "./delegate-tools.js";
export type {
  DelegateToolsConfig,
  RunContext,
  RunContextTracker,
} from "./delegate-tools.js";

// Lot 12 — mémoire durable : extension SDK (rappel + déclencheurs) et extracteur.
export {
  createMemoryExtensionFactory,
  type MemoryExtensionOptions,
} from "./memory-extension.js";

// Lot 4 (extension) — annuaire minimal des agents injecté à chaque tour.
export {
  createAgentRosterExtensionFactory,
  type AgentRosterExtensionOptions,
} from "./agent-roster-extension.js";

// Personnalité de Yuki — base du prompt injectée à chaque tour (enregistrée EN PREMIER).
export {
  PERSONALITY_EXTENSION_NAME,
  createPersonalityExtensionFactory,
  type PersonalityExtensionOptions,
} from "./personality-extension.js";
export {
  MEMORY_EXTRACTOR_SYSTEM_PROMPT,
  createSdkMemoryExtractor,
  type SdkMemoryExtractorConfig,
} from "./memory-extractor.js";

// Lot 13 — archive « vie antérieure » : outil de consultation + signal d'existence.
export { createHeritageTools } from "./heritage-tools.js";
export {
  HERITAGE_NOTICE,
  createHeritageExtensionFactory,
  type HeritageExtensionOptions,
} from "./heritage-extension.js";

// Libraire de Pi-Web — quatre outils (recherche, liste, relecture, archivage).
export { createLibrarianTools, MAX_ARCHIVE_MATERIAL_CHARS, type LibrarianToolsConfig } from "./librarian-tools.js";
export {
  createSdkLibrarianSynthesizer,
  type SdkLibrarianSynthesizerConfig,
} from "./librarian-synthesizer.js";
