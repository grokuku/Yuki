/**
 * CÂBLAGE LLM : du CATALOGUE à l'exécution (lot B, 2026-11-19).
 *
 * ⚠️ CE MODULE EST LE SEUL ENDROIT QUI TRADUIT LA CONFIGURATION EN MODÈLES.
 * Il rend, pour UN bot :
 *  - `file` : le contenu de `models.json` (tous les fournisseurs/modèles du
 *    catalogue — un fichier partagé par tous les bots) ;
 *  - `models` / `providers` : les modèles et fournisseurs RÉSOLUS des rôles
 *    `light` et `heavy` (forme `LlmConfig`, consommée par la disponibilité, les
 *    hosts et les workers) ;
 *  - `effective` : la projection « baseUrl / api / model / thinking / vision »
 *    par rôle, y compris `vision` (repli de description d'image) ;
 *  - `degrade` : les rôles SANS modèle utilisable (état lisible, journalisé par
 *    `src/index.ts`), jamais un plantage.
 *
 * ⚠️ RÉSOLUTION (une seule règle, `src/llm/execution.ts`) :
 * `llm.bot.<rôle>` → `llm.defaut.<rôle>` → dégradé explicite. La RÉFLEXION et la
 * VISION viennent du MODÈLE (`llm.modeles[]`), plus du rôle.
 *
 * ⚠️ Aucune clé en clair : `models.json` ne référence que des variables
 * d'environnement (`$YUKI_LLM_FOURNISSEUR_<ID>_API_KEY`), reflétées par
 * `ConfigRuntime.bridgeSecrets`.
 */

import type { ConfigRuntime } from "../config/runtime.js";
import {
  defautsInstance,
  fournisseurParId,
  surchargesBot,
  type FournisseurLlm,
  type RoleHerite,
} from "./catalogue.js";
import {
  effectiveDuPlan,
  modelSpecDuCatalogue,
  modelesDuPlan,
  planifierExecution,
  providersDuPlan,
  rolesDegrades,
  signaturePlan,
  type CodeDegrade,
  type PlanExecution,
  type ProvenanceModele,
} from "./execution.js";
import type { EffectiveLlmConfig, ModelSpec } from "./models.js";
import type { LlmRole, ProviderSpec } from "./providers.js";

/**
 * Contexte budgétaire d'un rôle DÉGRADÉ (`model === ""`).
 *
 * ⚠️ Valeur PUREMENT interne (bornage des images et des messages) : elle ne rend
 * aucun appel possible — une référence vide fait échouer le run avec un message
 * explicite, ce qui est le comportement voulu en dégradé.
 */
const CONTEXTE_DEGRADE = 32_768;

function modeleDegrade(role: LlmRole): ModelSpec {
  return {
    providerId: "",
    id: "",
    name: role === "heavy" ? "modèle de travail introuvable" : "modèle de discussion introuvable",
    reasoning: false,
    input: ["text"],
    contextWindow: CONTEXTE_DEGRADE,
    maxTokens: 0,
    defaultThinking: "off",
    reference: "",
  };
}

/** Rôle dégradé, tel que l'interface et le journal le décrivent. */
export interface RoleDegrade {
  readonly role: RoleHerite;
  readonly code: CodeDegrade | "aucun_modele";
  readonly modeleId: string;
}

export interface LlmRouting {
  readonly effective: EffectiveLlmConfig;
  readonly models: Readonly<Record<LlmRole, ModelSpec>>;
  readonly providers: Readonly<Record<LlmRole, ProviderSpec>>;
  readonly file: PlanExecution["file"];
  readonly plan: PlanExecution;
  /** Rôles sans modèle utilisable (vide = tout va bien). */
  readonly degrade: readonly RoleDegrade[];
  /** Référence du modèle de VISION (`fournisseur/modèle`) ou `""` (aucun repli). */
  readonly visionReference: string;
  /** Un modèle de vision est-il sélectionné et utilisable ? */
  readonly visionConfiguree: boolean;
  /** Provenance du modèle de chaque rôle (`bot` / `defaut` / `aucun`). */
  readonly provenance: Readonly<Record<RoleHerite, ProvenanceModele>>;
}

/** Sélections d'un bot (`llm.bot.*`), lues avec l'overlay de CE bot. */
function surchargesDuBot(config: ConfigRuntime, botId: string) {
  return surchargesBot({
    getString: (path) => String(config.valeurPour(botId, path)),
  });
}

/**
 * Résout les modèles, les fournisseurs et le fichier `models.json` POUR UN BOT.
 *
 * `botId` par défaut = bot ACTIF du runtime ; les hosts des autres bots passent le
 * leur (chacun a ses surcharges, un seul `models.json` partagé).
 */
export function llmRouting(config: ConfigRuntime, botId = config.botId): LlmRouting {
  const fournisseurs = config.fournisseurs() as readonly FournisseurLlm[];
  const plan = planifierExecution({
    fournisseurs,
    modeles: config.modeles(),
    defauts: defautsInstance(config),
    bot: surchargesDuBot(config, botId),
  });
  const models = modelesDuPlan(plan);
  const providers = providersDuPlan(plan);
  const vision = plan.roles.vision;
  const visionReference =
    vision.modele === undefined || vision.fournisseur === undefined
      ? ""
      : modelSpecDuCatalogue(vision.modele, vision.fournisseur).reference;
  return {
    effective: effectiveDuPlan(plan),
    models: models ?? { light: modeleDegrade("light"), heavy: modeleDegrade("heavy") },
    providers:
      providers ??
      ({
        light: { id: "", name: "", baseUrl: "", api: "openai-completions", keyEnv: "", maxConcurrentRequests: 1 },
        heavy: { id: "", name: "", baseUrl: "", api: "openai-completions", keyEnv: "", maxConcurrentRequests: 1 },
      } as const),
    file: plan.file,
    plan,
    degrade: rolesDegrades(plan),
    visionReference,
    visionConfiguree: visionReference !== "",
    provenance: {
      light: plan.roles.light.provenance,
      heavy: plan.roles.heavy.provenance,
      vision: plan.roles.vision.provenance,
    },
  };
}

/**
 * Fournisseur du catalogue par identifiant (routes de test de connexion).
 *
 * ⚠️ Utilisé par `POST /api/config/llm/test` : il ne fait AUCUN appel réseau
 * lui-même, il fournit seulement l'adresse et le chemin de clé.
 */
export function fournisseurDuCatalogue(
  config: ConfigRuntime,
  id: string,
): FournisseurLlm | undefined {
  return fournisseurParId(config.fournisseurs(), id);
}

/** Signature de rechargement à chaud (catalogue + rôles résolus du bot). */
export function signatureRouting(routing: LlmRouting): string {
  return signaturePlan(routing.plan);
}
