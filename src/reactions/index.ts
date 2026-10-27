/**
 * Domaine « RÉACTIONS aux messages de Yuki » — surface publique.
 *
 * Types PURS (catalogue des quatre registres, port de lecture/écriture) et
 * implémentation locale (journal JSONL du volume `state`).
 * Aucun import SDK ni `typebox` : l'injection dans la conversation est confinée
 * à `src/pi/sdk/reactions-extension.ts`.
 */

export {
  MEMORY_EXCLUDED_GROUPS,
  REACTIONS,
  REACTION_GROUPS,
  REACTION_REGULARITY_MIN,
  isMemoryEligibleGroup,
  isReactionId,
  reactionById,
  reactionsOfGroup,
  regularityMemory,
  type ReactionDef,
  type ReactionGroup,
  type ReactionGroupDef,
  type ReactionMemoryCandidate,
  type ReactionRegularity,
  type ReactionsGatewayPort,
  type ReactionsPort,
  type ReactionView,
} from "./types.js";

export { ReactionStore, type ReactionEvent, type ReactionStoreOptions } from "./store.js";

export {
  REACTIONS_EXCERPT_MAX,
  REACTIONS_PROMPT_MAX,
  REACTIONS_REMINDER,
  REACTIONS_TAG,
  formatReactionsBlock,
  type ReactionPromptItem,
} from "./prompt.js";
