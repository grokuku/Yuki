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
