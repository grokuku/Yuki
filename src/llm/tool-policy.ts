/**
 * Politique d'outils par modèle (données pures, AUCUN import SDK/typebox).
 *
 * GARANTIE STRUCTURELLE — pas une consigne : à aucun moment les modèles ne
 * reçoivent d'outil d'écriture (`write`, `edit`) ni d'exécution (`bash`,
 * `powershell`). Le sidecar isolé n'existe qu'au Lot 4 ; il ne faut donc
 * AUCUN outil d'exécution au Lot 2. Le lourd ne peut pas redéléguer.
 *
 * La table est extensible par simple ajout d'entrées aux lots 4/5.
 */

import type { LlmRole } from "./providers.js";

/** Outils builtins exposables (lecture seule au Lot 2). */
export type BuiltinToolName = "read" | "ls" | "grep" | "find";

/** Outils custom de délégation (fournis au léger uniquement). */
export type DelegateToolName = "delegate" | "job_status" | "cancel_job";

/**
 * Outils custom d'EXÉCUTION déléguée (Lot 4, B6bis). `run_command` permet au
 * modèle de lancer une commande sur un AGENT APPAIRÉ — jamais sur la machine de
 * Yuki. Le garde-fou (D118) s'applique côté agent, dans Yuki, AVANT l'envoi.
 */
export type ExecutionToolName = "run_command";

/**
 * Outils custom de CONSULTATION des agents appairés (Lot 4, extension).
 * `lister_agents` et `etat_agent` sont en **LECTURE SEULE** : ils n'exécutent ni
 * ne modifient rien. Activables indépendamment des outils d'exécution.
 */
export type AgentDirectoryToolName = "lister_agents" | "etat_agent";

/** Tous les noms d'outils custom, par catégorie (garde-fou testable). */
export type CustomToolName =
  | DelegateToolName
  | ExecutionToolName
  | AgentDirectoryToolName;

export interface ToolPolicyEntry {
  readonly role: LlmRole;
  /** Builtins exposés (allowlist passée au SDK). */
  readonly builtins: readonly BuiltinToolName[];
  /** Outils custom exposés. */
  readonly custom: readonly DelegateToolName[];
  /** Outils d'exécution déléguée (Lot 4). */
  readonly execution: readonly ExecutionToolName[];
  /** Outils de consultation des agents (Lot 4, lecture seule). */
  readonly directory: readonly AgentDirectoryToolName[];
  /** Le rôle peut-il déléguer à un worker lourd ? */
  readonly canDelegate: boolean;
}

/** Outils de lecture seule partagés par les deux rôles. */
export const READ_ONLY_TOOLS: readonly BuiltinToolName[] = [
  "read",
  "ls",
  "grep",
  "find",
];

export const DELEGATE_TOOLS: readonly DelegateToolName[] = [
  "delegate",
  "job_status",
  "cancel_job",
];

/**
 * Outils d'exécution déléguée (Lot 4). Non exposés par défaut : le câblage les
 * active seulement quand un service d'exécution est disponible et que
 * l'utilisateur n'a pas désactivé l'outil.
 */
export const EXECUTION_TOOLS: readonly ExecutionToolName[] = ["run_command"];

/**
 * Outils de consultation des agents (Lot 4, extension). Non exposés par défaut
 * (comme l'exécution) : le câblage les active dès qu'un service de consultation
 * existe — **indépendamment** de l'activation de l'exécution (consulter n'est
 * pas exécuter).
 */
export const AGENT_DIRECTORY_TOOLS: readonly AgentDirectoryToolName[] = [
  "lister_agents",
  "etat_agent",
];

export const TOOL_POLICY: Readonly<Record<LlmRole, ToolPolicyEntry>> = {
  light: {
    role: "light",
    builtins: READ_ONLY_TOOLS,
    custom: DELEGATE_TOOLS,
    execution: EXECUTION_TOOLS,
    directory: AGENT_DIRECTORY_TOOLS,
    canDelegate: true,
  },
  heavy: {
    role: "heavy",
    builtins: READ_ONLY_TOOLS,
    custom: [],
    execution: [],
    directory: [],
    canDelegate: false,
  },
};

export interface ToolAllowlistOptions {
  /**
   * Force la présence/absence des outils de délégation. Par défaut, suit la
   * politique du rôle. Quand la clé lourde manque, la délégation est désactivée
   * STRUCTURELLEMENT (les outils ne sont pas exposés).
   */
  delegationEnabled?: boolean;
  /**
   * Active l'outil d'exécution déléguée `run_command` (Lot 4). DÉSACTIVÉ par
   * défaut : seul le câblage l'active, quand un service d'exécution existe.
   */
  executionEnabled?: boolean;
  /**
   * Active les outils de consultation des agents `lister_agents`/`etat_agent`
   * (Lot 4, extension). DÉSACTIVÉ par défaut : seul le câblage les active, quand
   * un service de consultation existe. ⚠️ Indépendant de `executionEnabled` :
   * les deux peuvent être activés séparément (consulter n'est pas exécuter).
   */
  directoryEnabled?: boolean;
}

/**
 * Allowlist effective passée au SDK pour un rôle : builtins + outils custom
 * activés. Le lourd n'a jamais d'outil de délégation ni d'exécution.
 */
export function toolAllowlist(
  role: LlmRole,
  options: ToolAllowlistOptions = {},
): string[] {
  const entry = TOOL_POLICY[role];
  const delegationEnabled =
    options.delegationEnabled ?? entry.canDelegate;
  const executionEnabled = (options.executionEnabled ?? false) && entry.execution.length > 0;
  const directoryEnabled = (options.directoryEnabled ?? false) && entry.directory.length > 0;
  const tools: string[] = [...entry.builtins];
  if (entry.canDelegate && delegationEnabled) {
    tools.push(...entry.custom);
  }
  if (executionEnabled) {
    tools.push(...entry.execution);
  }
  if (directoryEnabled) {
    tools.push(...entry.directory);
  }
  return tools;
}

/** Outils d'écriture/exécution explicitement interdits au Lot 2. */
export const FORBIDDEN_TOOLS: readonly string[] = [
  "write",
  "edit",
  "bash",
  "powershell",
];

/** Vrai si l'allowlist contient un outil interdit (garde-fou testable). */
export function containsForbiddenTool(tools: readonly string[]): boolean {
  return tools.some((tool) => FORBIDDEN_TOOLS.includes(tool));
}
