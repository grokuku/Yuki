/**
 * EXÉCUTION DES RÔLES À PARTIR DU CATALOGUE (lot B, 2026-11-19) — données PURES.
 *
 * ⚠️ CE MODULE EST LA SEULE RÈGLE QUI DÉCIDE QUEL MODÈLE TOURNE, ET OÙ.
 *
 * Le catalogue (`llm.fournisseurs` + `llm.modeles`, portée `instance`) décrit ce
 * qui EXISTE ; les sélections décrivent ce qui SERT :
 *
 *  1. `llm.bot.<rôle>`      — surcharge du bot (overlay du bot)   ← priorité 1
 *  2. `llm.defaut.<rôle>`   — défaut de l'installation            ← priorité 2
 *  3. rien                  — MODE DÉGRADÉ EXPLICITE (journal + état lisible)
 *
 * ⚠️ UN `modeleId` RENSEIGNÉ MAIS INTROUVABLE NE RETOMBE PAS SUR LE DÉFAUT. Il
 * produit un dégradé NOMMÉ (`modele_introuvable`) : une sélection cassée doit se
 * VOIR (journal `llm.role.modele_introuvable`, « modèle introuvable » dans
 * l'interface), pas être masquée par une valeur d'à côté. Aucun modèle n'est
 * jamais inventé, et rien ne lève : un catalogue à moitié édité doit laisser le
 * gateway démarrer pour qu'on puisse le corriger.
 *
 * ⚠️ LE FOURNISSEUR EST DÉRIVÉ DU MODÈLE (`modele.fournisseurId`) : adresse, type
 * d'API et clé viennent de `llm.fournisseurs` (+ chemin secret
 * `llm.fournisseur.<id>.apiKey`), jamais d'un réglage de rôle. La RÉFLEXION et la
 * VISION sont des propriétés du MODÈLE (`llm.modeles[].thinking` / `.vision`) :
 * elles suivent le modèle quel que soit le rôle qui le sélectionne.
 *
 * Aucun import SDK/typebox, aucun accès disque/réseau : testable seul.
 */

import {
  fournisseurParId,
  modeleParId,
  nomEnvCleFournisseur,
  ROLES_HERITES,
  type FournisseurLlm,
  type ModeleLlm,
  type RoleHerite,
  type SelectionsRoles,
} from "./catalogue.js";
import {
  HEAVY_THINKING_LEVEL_MAP,
  toModelConfig,
  type EffectiveLlmConfig,
  type EffectiveLlmRole,
  type ModelSpec,
  type ModelsConfig,
  type ModelsConfigProvider,
  type ThinkingLevelName,
} from "./models.js";
import type { LlmApi, LlmRole, ProviderSpec } from "./providers.js";

/**
 * Plafond de jetons de SORTIE d'un modèle du catalogue.
 *
 * ⚠️ Le catalogue ne le déclare pas (l'utilisateur n'a pas à le connaître pour
 * choisir un modèle) : on garde la valeur historique des deux rôles, qui
 * n'ampute aucun fournisseur connu. `models.json` l'exige, d'où cette constante
 * plutôt qu'un `undefined`.
 */
export const MAX_TOKENS_MODELE = 32_768;

/** Source complète d'une résolution : catalogue + sélections. */
export interface SourceExecution {
  readonly fournisseurs: readonly FournisseurLlm[];
  readonly modeles: readonly ModeleLlm[];
  /** Défauts d'instance (`llm.defaut.*`). */
  readonly defauts: SelectionsRoles;
  /** Surcharges du bot résolu (`llm.bot.*`). */
  readonly bot: SelectionsRoles;
}

/** D'où vient le `modeleId` retenu. */
export type ProvenanceModele = "bot" | "defaut" | "aucun";

/** Pourquoi un rôle n'a pas de modèle utilisable. */
export type CodeDegrade = "modele_introuvable" | "fournisseur_introuvable";

/** Rôle résolu. `modele`/`fournisseur` absents ⇒ MODE DÉGRADÉ EXPLICITE. */
export interface RoleExecution {
  readonly role: RoleHerite;
  /** Dernière valeur RENSEIGNÉE (bot puis défaut) ; `""` si aucune. */
  readonly modeleId: string;
  readonly provenance: ProvenanceModele;
  readonly modele?: ModeleLlm;
  readonly fournisseur?: FournisseurLlm;
  readonly degrade?: { readonly code: CodeDegrade; readonly modeleId: string };
}

/** Plan complet : rôles résolus + contenu de `models.json`. */
export interface PlanExecution {
  readonly roles: Readonly<Record<RoleHerite, RoleExecution>>;
  /** Fournisseurs du catalogue, projetés en `ProviderSpec` (clé = identifiant). */
  readonly providers: Readonly<Record<string, ProviderSpec>>;
  /** Modèles réellement écrits dans `models.json` (fournisseur existant). */
  readonly modeles: readonly ModeleLlm[];
  /** Contenu de `config/pi/models.json`. */
  readonly file: ModelsConfig;
}

/** Provider `models.json`/runtime d'un fournisseur du catalogue. */
export function providerSpecDuCatalogue(fournisseur: FournisseurLlm): ProviderSpec {
  return {
    id: fournisseur.id,
    name: fournisseur.nom,
    baseUrl: fournisseur.baseUrl,
    api: fournisseur.api as LlmApi,
    // ⚠️ La clé n'est JAMAIS dans le catalogue : elle vit dans le chemin secret
    // `llm.fournisseur.<id>.apiKey`, reflété par `bridgeSecrets` sous ce nom.
    keyEnv: nomEnvCleFournisseur(fournisseur.id),
    // Une seule requête concurrente par fournisseur : décrire une image ou
    // répondre à une conversation ne doit pas partir en rafale sur le compte.
    maxConcurrentRequests: 1,
  };
}

/** Niveau de réflexion effectif d'un modèle (`off` si la valeur est vide). */
export function reflexionDuModele(modele: ModeleLlm): ThinkingLevelName {
  const valeur = modele.thinking as string;
  return valeur === "" ? "off" : (valeur as ThinkingLevelName);
}

/**
 * Spécification d'exécution d'un modèle du catalogue.
 *
 * ⚠️ `id` (passé au fournisseur) est le NOM du modèle (`modele.nom`) : c'est lui
 * que l'API connaît (`gemma4:31b`). L'identifiant du catalogue (`modele.id`, slug)
 * ne sert qu'aux sélections et n'est JAMAIS envoyé à un fournisseur.
 */
export function modelSpecDuCatalogue(
  modele: ModeleLlm,
  fournisseur: FournisseurLlm,
): ModelSpec {
  const thinking = reflexionDuModele(modele);
  const reasoning = thinking !== "off";
  return {
    // ⚠️ Pas de `role` : un modèle du catalogue ne « devient » pas léger ou lourd,
    // il est SÉLECTIONNÉ par un rôle — et la réflexion/la vision viennent de LUI.
    providerId: fournisseur.id,
    id: modele.nom,
    name: modele.nom,
    reasoning,
    ...(reasoning ? { thinkingLevelMap: HEAVY_THINKING_LEVEL_MAP } : {}),
    // ⚠️ DÉCLARATION UTILISATEUR (`llm.modeles[].vision`) : c'est elle, et rien
    // d'autre, qui décide si une image part vers le fournisseur.
    input: modele.vision ? ["text", "image"] : ["text"],
    contextWindow: modele.contexte,
    maxTokens: MAX_TOKENS_MODELE,
    defaultThinking: thinking,
    reference: `${fournisseur.id}/${modele.nom}`,
  };
}

/** Provider de `models.json` pour un fournisseur et ses modèles. */
function providerModels(
  fournisseur: FournisseurLlm,
  modeles: readonly ModeleLlm[],
): ModelsConfigProvider {
  return {
    name: fournisseur.nom,
    baseUrl: fournisseur.baseUrl,
    api: fournisseur.api,
    apiKey: `$${nomEnvCleFournisseur(fournisseur.id)}`,
    // ⚠️ `requiresAssistantAfterToolResult` — indispensable dès qu'une image
    // entre dans le chemin (un résultat d'outil porteur d'image insère un message
    // `user` APRÈS le message `tool` ; sans ce drapeau, les fournisseurs dont le
    // gabarit exige un tour `assistant` entre les deux refusent la requête).
    compat: { supportsDeveloperRole: false, requiresAssistantAfterToolResult: true },
    models: modeles.map((modele) =>
      toModelConfig(modelSpecDuCatalogue(modele, fournisseur)),
    ),
  };
}

/**
 * Contenu de `models.json` depuis le catalogue : TOUS les fournisseurs et TOUS
 * leurs modèles.
 *
 * ⚠️ Tout le catalogue est écrit, pas seulement les modèles sélectionnés : le SDK
 * doit pouvoir résoudre n'importe quelle sélection (y compris celle d'un AUTRE
 * bot, servie par le même fichier partagé). Un modèle dont le fournisseur n'existe
 * pas est IGNORÉ (il est déjà en dégradé explicite côté rôle).
 */
export function buildModelsConfigDepuisCatalogue(
  fournisseurs: readonly FournisseurLlm[],
  modeles: readonly ModeleLlm[],
): ModelsConfig {
  const providers: Record<string, ModelsConfigProvider> = {};
  for (const fournisseur of fournisseurs) {
    const siens = modeles.filter((modele) => modele.fournisseurId === fournisseur.id);
    // ⚠️ Un fournisseur sans modèle n'est PAS écrit : un provider sans modèle
    // n'ouvre aucune sélection et ne ferait que traîner dans le fichier.
    if (siens.length === 0) continue;
    providers[fournisseur.id] = providerModels(fournisseur, siens);
  }
  return { providers };
}

/** Résout UN rôle : bot → défaut → dégradé (jamais un repli silencieux). */
export function resoudreRole(
  role: RoleHerite,
  source: Pick<SourceExecution, "fournisseurs" | "modeles" | "defauts" | "bot">,
): RoleExecution {
  const duBot = source.bot[role].trim();
  const duDefaut = source.defauts[role].trim();
  const provenance: ProvenanceModele = duBot !== "" ? "bot" : duDefaut !== "" ? "defaut" : "aucun";
  const modeleId = duBot !== "" ? duBot : duDefaut;
  if (modeleId === "") return { role, modeleId: "", provenance };

  const modele = modeleParId(source.modeles, modeleId);
  if (modele === undefined) {
    return { role, modeleId, provenance, degrade: { code: "modele_introuvable", modeleId } };
  }
  const fournisseur = fournisseurParId(source.fournisseurs, modele.fournisseurId);
  if (fournisseur === undefined) {
    return { role, modeleId, provenance, modele, degrade: { code: "fournisseur_introuvable", modeleId } };
  }
  return { role, modeleId, provenance, modele, fournisseur };
}

/**
 * PLAN D'EXÉCUTION complet : rôles résolus + `models.json`.
 *
 * Fonction PURE (deux appels avec les mêmes entrées rendent le même plan, donc la
 * même signature de rechargement à chaud).
 */
export function planifierExecution(source: SourceExecution): PlanExecution {
  const providers: Record<string, ProviderSpec> = {};
  for (const fournisseur of source.fournisseurs) {
    providers[fournisseur.id] = providerSpecDuCatalogue(fournisseur);
  }
  const roles = {} as Record<RoleHerite, RoleExecution>;
  for (const role of ROLES_HERITES) roles[role] = resoudreRole(role, source);
  return {
    roles,
    providers,
    modeles: source.modeles,
    file: buildModelsConfigDepuisCatalogue(source.fournisseurs, source.modeles),
  };
}

/**
 * Projection d'un rôle résolu sur l'ancienne forme « config effective »
 * (`baseUrl`/`api`/`model`/`thinking`/`vision`), consommée par les outils, les
 * workers et la disponibilité.
 *
 * ⚠️ Dégradé ⇒ TOUS les champs sont vides : `model === ""` est le signal explicite
 * « aucun modèle utilisable », jamais remplacé par une valeur d'à côté.
 */
export function effRole(role: RoleExecution): EffectiveLlmRole {
  return {
    api: role.fournisseur?.api ?? "",
    baseUrl: role.fournisseur?.baseUrl ?? "",
    // ⚠️ Le NOM du modèle (identifiant côté fournisseur), pas l'identifiant du
    // catalogue.
    model: role.modele?.nom ?? "",
    thinking: role.modele === undefined ? "off" : reflexionDuModele(role.modele),
    // Le rôle `vision` voit les images par définition ; les autres suivent la
    // déclaration du MODÈLE.
    vision: role.role === "vision" ? role.modele !== undefined : role.modele?.vision === true,
  };
}

/** Config effective des trois rôles (forme attendue par les consommateurs). */
export function effectiveDuPlan(plan: PlanExecution): EffectiveLlmConfig {
  return {
    light: effRole(plan.roles.light),
    heavy: effRole(plan.roles.heavy),
    vision: effRole(plan.roles.vision),
  };
}

/** Modèles des deux rôles de conversation/travail (forme `LlmConfig.models`). */
export function modelesDuPlan(
  plan: PlanExecution,
): Record<LlmRole, ModelSpec> | undefined {
  const build = (role: LlmRole): ModelSpec | undefined => {
    const resolu = plan.roles[role];
    if (resolu.modele === undefined || resolu.fournisseur === undefined) return undefined;
    return modelSpecDuCatalogue(resolu.modele, resolu.fournisseur);
  };
  const light = build("light");
  const heavy = build("heavy");
  if (light === undefined || heavy === undefined) return undefined;
  return { light, heavy };
}

/** Providers des deux rôles (forme `LlmConfig.providers`), `undefined` si dégradé. */
export function providersDuPlan(
  plan: PlanExecution,
): Record<LlmRole, ProviderSpec> | undefined {
  const build = (role: LlmRole): ProviderSpec | undefined => {
    const fournisseur = plan.roles[role].fournisseur;
    return fournisseur === undefined ? undefined : providerSpecDuCatalogue(fournisseur);
  };
  const light = build("light");
  const heavy = build("heavy");
  if (light === undefined || heavy === undefined) return undefined;
  return { light, heavy };
}

/** Rôles en dégradé (ordre stable : léger, lourd, vision). */
export function rolesDegrades(
  plan: PlanExecution,
): Array<{ role: RoleHerite; code: CodeDegrade | "aucun_modele"; modeleId: string }> {
  const out: Array<{ role: RoleHerite; code: CodeDegrade | "aucun_modele"; modeleId: string }> = [];
  for (const role of ROLES_HERITES) {
    const resolu = plan.roles[role];
    if (resolu.degrade !== undefined) {
      out.push({ role, code: resolu.degrade.code, modeleId: resolu.degrade.modeleId });
      continue;
    }
    // ⚠️ Le rôle `vision` VIDE n'est pas un dégradé : « aucun repli » est l'état
    // normal d'une installation qui n'a pas de modèle de vision.
    if (role !== "vision" && resolu.modele === undefined) {
      out.push({ role, code: "aucun_modele", modeleId: "" });
    }
  }
  return out;
}

/**
 * Signature de rechargement à chaud : elle change dès qu'un rôle, un modèle, un
 * fournisseur ou une sélection change — c'est elle qui déclenche la réécriture de
 * `models.json` et le rafraîchissement du runtime, bot par bot.
 */
export function signaturePlan(plan: PlanExecution): string {
  const parRole = ROLES_HERITES.map((role) => {
    const resolu = plan.roles[role];
    const modele = resolu.modele;
    return [
      role,
      modele === undefined ? "" : `${resolu.fournisseur?.id ?? ""}/${modele.nom}`,
      modele === undefined ? "off" : reflexionDuModele(modele),
    ];
  });
  return JSON.stringify([plan.file, parRole]);
}
