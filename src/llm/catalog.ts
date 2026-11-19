import type { ThinkingLevelName } from "./models.js";

export const roles = ["light", "heavy"] as const;
export interface CatalogProvider { id: string; name: string; baseUrl: string }
export interface CatalogModel {
  id: string;
  provider: string;
  model: string;
  thinking: ThinkingLevelName;
  vision: boolean;
}
export interface Catalog {
  providers: CatalogProvider[];
  models: CatalogModel[];
  light: string;
  heavy: string;
}
const emptyCatalog: Catalog = { providers: [], models: [], light: "light", heavy: "heavy" };
const idPattern = /^[a-z0-9]{1,64}$/;
export function keyPath(id: string): string {
  return roles.some(role => role === id) ? `llm.${id}.apiKey` : `llm.provider.${id}.apiKey`;
}
export function keyEnv(id: string): string {
  return roles.some(role => role === id) ? `YUKI_LLM_${id.toUpperCase()}_API_KEY` : `YUKI_LLM_PROVIDER_${id}_API_KEY`;
}
export function providerSecretId(path: string): string | undefined {
  return /^llm\.provider\.([a-z0-9]{1,64})\.apiKey$/.exec(path)?.[1];
}

export function readCatalog(raw: string): Catalog {
  if (!raw) return emptyCatalog;
  const data = JSON.parse(raw) as Catalog;
  const providers = new Set<string>(roles);
  const models = new Set<string>(roles);
  const references = new Set<string>();
  function add(ids: Set<string>, id: string) {
    if (typeof id !== "string" || !idPattern.test(id) || ids.has(id)) throw Error("Identifiant invalide ou en double.");
    ids.add(id);
  }
  if (!Array.isArray(data.providers) || !Array.isArray(data.models)) throw Error("Catalogue invalide.");
  for (const p of data.providers) {
    add(providers, p.id);
    if (typeof p.name !== "string" || !p.name.trim() || typeof p.baseUrl !== "string" || !URL.canParse(p.baseUrl) ||
        (new URL(p.baseUrl).username || new URL(p.baseUrl).password || !["http:", "https:"].includes(new URL(p.baseUrl).protocol))) throw Error("Nom et URL HTTP du fournisseur requis.");
  }
  for (const m of data.models) {
    add(models, m.id);
    const reference = m.provider + "/" + String(m.model).trim();
    if (!providers.has(m.provider) || typeof m.model !== "string" || !m.model.trim() ||
        typeof m.vision !== "boolean" || !["off","minimal","low","medium","high","xhigh","max"].includes(m.thinking) ||
        references.has(reference)) throw Error("Vérifiez le fournisseur, le modèle et ses capacités. Chaque modèle doit être unique par fournisseur.");
    references.add(reference);
  }
  if (!models.has(data.light) || !models.has(data.heavy)) throw Error("Sélectionnez les deux modèles par défaut.");
  // Reconstruct the public document using only its declared fields.
  return {
    providers: data.providers.map(({id, name, baseUrl}) => ({id, name: name.trim(), baseUrl: baseUrl.trim()})),
    models: data.models.map(({id, provider, model, thinking, vision}) => ({id, provider, model: model.trim(), thinking, vision})),
    light: data.light, heavy: data.heavy,
  };
}
