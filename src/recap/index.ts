/**
 * Domaine `recap` — « Continuer dans une conversation dédiée ».
 *
 * Un appel LLM produit un RÉCAPITULATIF EXHAUSTIF (jamais un résumé) qui devient
 * le point de départ d'une nouvelle conversation dédiée au sujet. Le fil
 * d'origine n'est jamais modifié.
 */

export {
  buildGeneratorPrompt,
  fallbackTitle,
  frameRecapPrompt,
  measureMessages,
  normalizeSubject,
  parseGeneratorOutput,
  parseRecapPrompt,
  RECAP_BODY_CLOSE,
  RECAP_BODY_OPEN,
  RECAP_DATA_REMINDER,
  RECAP_HEADER,
  RECAP_INPUT_MAX_CHARS,
  RECAP_START_INSTRUCTION,
  RECAP_SYSTEM_PROMPT,
  RECAP_TITLE_MAX_CHARS,
  TITLE_PREFIX,
} from "./prompt.js";
export type {
  BuildGeneratorPromptInput,
  FrameRecapPromptInput,
  ParsedGeneratorOutput,
  ParsedRecapPrompt,
  RecapSourceMessage,
  RecapSourceRole,
} from "./prompt.js";

export { createRecapService } from "./service.js";
export type {
  RecapGenerator,
  RecapInput,
  RecapResult,
  RecapWriter,
} from "./service.js";

export { RecapError } from "./errors.js";
export type { RecapErrorCode } from "./errors.js";
