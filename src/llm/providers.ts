/**
 * Définition des fournisseurs LLM (données pures, AUCUN import SDK/typebox).
 *
 * Deux providers DISTINCTS, nommés par RÔLE — `llm-light` / `llm-heavy` — et
 * non par fournisseur :
 *  - `llm-light` : compte dédié, une seule requête concurrente. Le léger ne
 *    doit JAMAIS faire la queue derrière le lourd.
 *  - `llm-heavy` : compte dédié, jusqu'à 3 requêtes concurrentes pour les
 *    tâches d'arrière-plan.
 *
 * Le nommage est NEUTRE : changer de fournisseur ne doit pas toucher au code.
 * Depuis le Lot 11, tout se règle dans la page `/config` :
 *  - `baseUrl`, `api` et l'identifiant de modèle sont GÉNÉRÉS dans
 *    `models.json` au démarrage (`buildModelsConfigFrom`, écriture atomique) —
 *    le SDK n'interpole PAS `$VAR` pour ces champs ;
 *  - la clé, référencée par `models.json` via `$…_API_KEY`, vit dans le store
 *    (`0600`) et/ou l'environnement (`YUKI_LLM_<ROLE>_API_KEY`).
 *
 * Les valeurs par défaut restent spécifiques au fournisseur actuel : ce sont des
 * DONNÉES (endpoint, identifiants de modèle), pas des identifiants de code.
 */

/** Rôles LLM du système. Extensible aux lots suivants (ex. `vision`). */
export type LlmRole = "light" | "heavy";

export const LLM_ROLES: readonly LlmRole[] = ["light", "heavy"];

/** API de transport comprise par le SDK Pi. */
export type LlmApi = "openai-completions";

export interface ProviderSpec {
  /** Identifiant du provider (clé dans `models.json`), neutre par rôle. */
  readonly id: string;
  /** Libellé humain neutre. */
  readonly name: string;
  /** Endpoint compatible OpenAI. */
  readonly baseUrl: string;
  /** Type d'API du SDK. */
  readonly api: LlmApi;
  /** Nom de la variable d'environnement portant la clé (jamais la valeur). */
  readonly keyEnv: string;
  /** Requêtes concurrentes maximales admises par ce compte. */
  readonly maxConcurrentRequests: number;
}

/** Noms de variables d'environnement par rôle (schéma NEUTRE, un bloc par rôle). */
export interface RoleEnvNames {
  readonly api: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly thinking: string;
}

export const LLM_ENV: Readonly<Record<LlmRole, RoleEnvNames>> = {
  light: {
    api: "YUKI_LLM_LIGHT_API",
    baseUrl: "YUKI_LLM_LIGHT_BASE_URL",
    apiKey: "YUKI_LLM_LIGHT_API_KEY",
    model: "YUKI_LLM_LIGHT_MODEL",
    thinking: "YUKI_LLM_LIGHT_THINKING",
  },
  heavy: {
    api: "YUKI_LLM_HEAVY_API",
    baseUrl: "YUKI_LLM_HEAVY_BASE_URL",
    apiKey: "YUKI_LLM_HEAVY_API_KEY",
    model: "YUKI_LLM_HEAVY_MODEL",
    thinking: "YUKI_LLM_HEAVY_THINKING",
  },
};

export const LIGHT_PROVIDER: ProviderSpec = {
  id: "llm-light",
  name: "LLM léger",
  baseUrl: "https://ollama.com/v1",
  api: "openai-completions",
  keyEnv: LLM_ENV.light.apiKey,
  maxConcurrentRequests: 1,
};

export const HEAVY_PROVIDER: ProviderSpec = {
  id: "llm-heavy",
  name: "LLM lourd",
  baseUrl: "https://ollama.com/v1",
  api: "openai-completions",
  keyEnv: LLM_ENV.heavy.apiKey,
  maxConcurrentRequests: 3,
};

/** Table rôle → provider. Les deux rôles pointent des providers DISTINCTS. */
export const PROVIDERS: Readonly<Record<LlmRole, ProviderSpec>> = {
  light: LIGHT_PROVIDER,
  heavy: HEAVY_PROVIDER,
};

export function providerForRole(role: LlmRole): ProviderSpec {
  return PROVIDERS[role];
}

/** Lit une variable d'environnement non vide et rognée, sinon `undefined`. */
export function readEnvString(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const raw = env[name];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Résout les providers EFFECTIFS : `YUKI_LLM_<ROLE>_{API,BASE_URL}` surchargent
 * les défauts. La clé (`apiKey`) n'est jamais lue ici — seule sa présence compte
 * (`src/llm/availability.ts`). Si l'interpolation ne fonctionne pas côté SDK,
 * ce sont les valeurs de `models.json` qui font foi à l'exécution.
 */
export function resolveProviders(
  env: NodeJS.ProcessEnv = process.env,
): Record<LlmRole, ProviderSpec> {
  const build = (role: LlmRole, base: ProviderSpec): ProviderSpec => {
    const api = (readEnvString(env, LLM_ENV[role].api) ?? base.api) as LlmApi;
    const baseUrl = readEnvString(env, LLM_ENV[role].baseUrl) ?? base.baseUrl;
    return { ...base, api, baseUrl };
  };
  return {
    light: build("light", LIGHT_PROVIDER),
    heavy: build("heavy", HEAVY_PROVIDER),
  };
}
