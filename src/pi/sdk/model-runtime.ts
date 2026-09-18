/**
 * Runtime de modèles SDK (confidentiel — `src/pi/sdk/**` uniquement).
 *
 * Crée un `ModelRuntime` unique et PARTAGÉ (clé = chemins `auth.json` /
 * `models.json`) : la session légère et les sessions lourdes éphémères lisent
 * le même `models.json`. Aucun appel réseau au démarrage (`PI_OFFLINE=1`).
 */

import {
  ModelRuntime,
  resolveCliModel,
  type ResolveCliModelResult,
} from "@earendil-works/pi-coding-agent";

/** Type `Model` du SDK, obtenu sans importer `@earendil-works/pi-ai`. */
export type SdkModel = NonNullable<ResolveCliModelResult["model"]>;
export type SdkThinkingLevel = NonNullable<ResolveCliModelResult["thinkingLevel"]>;

export interface SdkModelRuntimeConfig {
  authPath: string;
  modelsPath: string;
}

const runtimeCache = new Map<string, Promise<ModelRuntime>>();

function cacheKey(config: SdkModelRuntimeConfig): string {
  return `${config.authPath}\u0000${config.modelsPath}`;
}

/**
 * Renvoie le `ModelRuntime` partagé pour ces chemins (mémoïsé). Deux appels
 * concurrents pour les mêmes chemins obtiennent la MÊME instance.
 */
export function getSharedModelRuntime(
  config: SdkModelRuntimeConfig,
): Promise<ModelRuntime> {
  const key = cacheKey(config);
  const existing = runtimeCache.get(key);
  if (existing) return existing;
  const created = ModelRuntime.create({
    authPath: config.authPath,
    modelsPath: config.modelsPath,
  }).catch((error: unknown) => {
    // Ne pas mémoriser un échec : un nouveau démarrage doit pouvoir réessayer.
    runtimeCache.delete(key);
    throw error;
  });
  runtimeCache.set(key, created);
  return created;
}

/** Résout une référence `provider/modelId` en objet modèle (sans vérifier l'auth). */
export function resolveSdkModel(
  runtime: ModelRuntime,
  reference: string,
): SdkModel | undefined {
  const resolved = resolveCliModel({ cliModel: reference, modelRuntime: runtime });
  if (resolved.model) return resolved.model;
  // Repli : `provider` + `modelId` explicites (les ids contiennent un `:` qui
  // peut brouiller le parseur de pattern).
  const slash = reference.indexOf("/");
  if (slash > 0) {
    const provider = reference.slice(0, slash);
    const modelId = reference.slice(slash + 1);
    return runtime.getModel(provider, modelId);
  }
  return undefined;
}

/** Niveau de raisonnement déduit d'une référence `provider/model:level` (sinon undefined). */
export function resolveSdkThinking(
  runtime: ModelRuntime,
  reference: string,
): SdkThinkingLevel | undefined {
  const resolved = resolveCliModel({ cliModel: reference, modelRuntime: runtime });
  return resolved.thinkingLevel;
}

/** Vrai si une authentification est configurée pour ce provider (aucun réseau). */
export function providerHasAuth(
  runtime: ModelRuntime,
  providerId: string,
): boolean {
  return runtime.getProviderAuthStatus(providerId).configured;
}
