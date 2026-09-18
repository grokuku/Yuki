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

export interface ToolPolicyEntry {
  readonly role: LlmRole;
  /** Builtins exposés (allowlist passée au SDK). */
  readonly builtins: readonly BuiltinToolName[];
  /** Outils custom exposés. */
  readonly custom: readonly DelegateToolName[];
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

export const TOOL_POLICY: Readonly<Record<LlmRole, ToolPolicyEntry>> = {
  light: {
    role: "light",
    builtins: READ_ONLY_TOOLS,
    custom: DELEGATE_TOOLS,
    canDelegate: true,
  },
  heavy: {
    role: "heavy",
    builtins: READ_ONLY_TOOLS,
    custom: [],
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
}

/**
 * Allowlist effective passée au SDK pour un rôle : builtins + outils custom
 * activés. Le lourd n'a jamais d'outil de délégation.
 */
export function toolAllowlist(
  role: LlmRole,
  options: ToolAllowlistOptions = {},
): string[] {
  const entry = TOOL_POLICY[role];
  const delegationEnabled =
    options.delegationEnabled ?? entry.canDelegate;
  const tools: string[] = [...entry.builtins];
  if (entry.canDelegate && delegationEnabled) {
    tools.push(...entry.custom);
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
