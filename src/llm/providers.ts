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

/**
 * Rôles LLM de CONVERSATION / TRAVAIL.
 *
 * ⚠️ Le modèle de VISION DE REPLI n'est PAS un rôle de cette table : il ne mène
 * aucune conversation et n'exécute aucun travail (il ne fait que DÉCRIRE une
 * image). Il a son propre emplacement (`VISION_PROVIDER`, `llm.vision.*`) pour
 * qu'il ne puisse JAMAIS être choisi comme modèle de discussion ou de travail.
 */
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

/**
 * Variables d'environnement du modèle de VISION DÉDIÉ (`llm.vision.*`).
 *
 * ⚠️ Mêmes noms que les deux rôles, avec le suffixe du rôle (`_VISION_`) : la
 * clé se règle donc exactement comme les autres (`YUKI_LLM_VISION_API_KEY`),
 * et `ConfigRuntime.bridgeSecrets` la reflète dans `process.env` pour que
 * `models.json` la référence (`$YUKI_LLM_VISION_API_KEY`).
 *
 * ⚠️ Pas de `api` : le dialecte du repli n'est pas un choix (une seule valeur
 * possible, `openai-completions`, portée par `VISION_PROVIDER.api`). Un réglage
 * à une seule valeur n'est pas un réglage.
 */
export const LLM_ENV_VISION: RoleEnvNames = {
  api: "YUKI_LLM_VISION_API",
  baseUrl: "YUKI_LLM_VISION_BASE_URL",
  apiKey: "YUKI_LLM_VISION_API_KEY",
  model: "YUKI_LLM_VISION_MODEL",
  thinking: "YUKI_LLM_VISION_THINKING",
};

/** Alias DÉPRÉCIÉS (lecture seule) — utilisés si le canonique manque. */
export const LLM_ENV_ALIAS: Readonly<Record<LlmRole, string>> = {
  light: "YUKI_LLM_DISCUSSION_API_KEY",
  heavy: "YUKI_LLM_TRAVAIL_API_KEY",
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

/**
 * Provider du modèle de VISION DE REPLI — TROISIÈME emplacement, distinct des
 * deux rôles de conversation/travail.
 *
 * ⚠️ `baseUrl` VIDE par défaut : il n'existe aucun fournisseur de vision par
 * défaut (le choisir à la place de l'utilisateur reviendrait à inventer un
 * modèle). `baseUrl` ET `model` vides ⇒ le provider n'est PAS écrit dans
 * `models.json`, donc aucun repli (`not_configured`) : c'est le seul
 * interrupteur, il n'y a pas de booléen `enabled` à tenir cohérent.
 *
 * ⚠️ Une seule requête concurrente : décrire une image ne doit pas faire la
 * queue derrière les jobs de fond ni retarder la conversation.
 */
export const VISION_PROVIDER: ProviderSpec = {
  id: "llm-vision",
  name: "LLM vision (repli)",
  baseUrl: "",
  api: "openai-completions",
  keyEnv: LLM_ENV_VISION.apiKey,
  maxConcurrentRequests: 1,
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
  const keyEnvFor = (role: LlmRole): string => {
    const canonical = LLM_ENV[role].apiKey;
    const rawCanonical = env[canonical];
    if (typeof rawCanonical === "string" && rawCanonical.trim() !== "") return canonical;
    const alias = LLM_ENV_ALIAS[role];
    const rawAlias = env[alias];
    if (typeof rawAlias === "string" && rawAlias.trim() !== "") return alias;
    return canonical;
  };
  const build = (role: LlmRole, base: ProviderSpec): ProviderSpec => {
    const api = (readEnvString(env, LLM_ENV[role].api) ?? base.api) as LlmApi;
    const baseUrl = readEnvString(env, LLM_ENV[role].baseUrl) ?? base.baseUrl;
    return { ...base, api, baseUrl, keyEnv: keyEnvFor(role) };
  };
  return {
    light: build("light", LIGHT_PROVIDER),
    heavy: build("heavy", HEAVY_PROVIDER),
  };
}
