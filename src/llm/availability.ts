/**
 * Disponibilité des LLM (données pures, AUCUN import SDK/typebox).
 *
 * La vérification est basée UNIQUEMENT sur la présence de la clé configurée
 * dans l'environnement : aucun appel réseau, compatible `PI_OFFLINE=1`.
 * `models.json` référence `$YUKI_LLM_LIGHT_API_KEY` /
 * `$YUKI_LLM_HEAVY_API_KEY` ; ici on ne lit que la présence de ces variables,
 * jamais leur valeur.
 */

import { resolveModels } from "./models.js";
import type { ModelSpec } from "./models.js";
import {
  resolveProviders,
  type LlmRole,
  type ProviderSpec,
} from "./providers.js";

export type LlmRoleStatus = "ready" | "unavailable";

export interface LlmRoleState {
  role: LlmRole;
  provider: string;
  model: string;
  status: LlmRoleStatus;
  keyPresent: boolean;
}

export interface LlmAvailability {
  light: LlmRoleState;
  heavy: LlmRoleState;
  isAvailable(role: LlmRole): boolean;
}

/** Politique en cas de clé manquante. `degrade` par défaut. */
export type LlmMissingKeyMode = "degrade" | "refuse";

/** Config LLM effective (providers + modèles résolus depuis l'environnement). */
export interface LlmConfig {
  providers: Readonly<Record<LlmRole, ProviderSpec>>;
  models: Readonly<Record<LlmRole, ModelSpec>>;
}

/**
 * Résout la configuration LLM effective : les variables neutres
 * `YUKI_LLM_<ROLE>_*` surchargent les défauts. Aucun accès réseau.
 */
export function resolveLlmConfig(
  env: NodeJS.ProcessEnv = process.env,
): LlmConfig {
  const providers = resolveProviders(env);
  const models = resolveModels(env, providers);
  return { providers, models };
}

function roleState(
  role: LlmRole,
  env: NodeJS.ProcessEnv,
  config: LlmConfig,
): LlmRoleState {
  const provider = config.providers[role];
  const model = config.models[role];
  const raw = env[provider.keyEnv];
  const keyPresent = typeof raw === "string" && raw.trim().length > 0;
  return {
    role,
    provider: provider.id,
    model: model.id,
    status: keyPresent ? "ready" : "unavailable",
    keyPresent,
  };
}

/** Résout la disponibilité des deux rôles sans aucun accès réseau. */
export function resolveAvailability(
  env: NodeJS.ProcessEnv = process.env,
  config: LlmConfig = resolveLlmConfig(env),
): LlmAvailability {
  const light = roleState("light", env, config);
  const heavy = roleState("heavy", env, config);
  return {
    light,
    heavy,
    isAvailable(role: LlmRole): boolean {
      return role === "light" ? light.status === "ready" : heavy.status === "ready";
    },
  };
}

export interface MissingKeyDecision {
  /** Vrai si le démarrage doit être refusé (mode `refuse`). */
  refuse: boolean;
  /** Rôles dont la clé manque. */
  missing: LlmRole[];
}

/** Applique la politique « clé manquante ». */
export function evaluateMissingKeyPolicy(
  availability: LlmAvailability,
  mode: LlmMissingKeyMode,
): MissingKeyDecision {
  const missing: LlmRole[] = [];
  if (!availability.light.keyPresent) missing.push("light");
  if (!availability.heavy.keyPresent) missing.push("heavy");
  return { refuse: mode === "refuse" && missing.length > 0, missing };
}
