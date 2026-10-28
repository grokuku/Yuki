/**
 * Façade du domaine « génération d'images via ComfyUI ».
 *
 * Cinq responsabilités SÉPARÉES, chacune dans son module :
 *  - `client.ts`     : le protocole HTTP de ComfyUI (`/prompt`, `/history/{id}`,
 *                      `/view`, `/system_stats`), délais bornés, erreurs fidèles ;
 *  - `validate.ts`   : validation du graphe au FORMAT API + résolution des
 *                      étiquettes `YUKI_*` PAR TITRE de nœud ;
 *  - `selection.ts`  : choix du workflow par PROXIMITÉ (libellé + description) ;
 *  - `consultation.ts` : MESURE des consultations préalables (par génération),
 *                      pour décider plus tard, sur des chiffres réels, si la
 *                      consigne suffit ;
 *  - `workflows.ts`  : stockage des workflows nommés (fichier séparé du volume
 *                      `state`, écriture atomique), dont leur DOCUMENTATION
 *                      D'ÉCRITURE (pour Yuki, jamais pour ComfyUI) ;
 *  - `images.ts`     : stockage LOCAL des images générées (servies en
 *                      same-origin, aucun élargissement de CSP) ;
 *  - `generator.ts`  : orchestration (choix → injection → appel → stockage).
 *
 * ⚠️ Aucun import du SDK Pi ni de `typebox` ici : cette couche ne dépend que de
 * `node:*` et du `fetch` natif. Le câblage (gateway, host Pi) la consomme.
 */

export {
  ComfyClient,
  DEFAULT_COMFY_GENERATION_TIMEOUT_MS,
  DEFAULT_COMFY_POLL_INTERVAL_MS,
  DEFAULT_COMFY_REQUEST_TIMEOUT_MS,
  MAX_COMFY_IMAGE_BYTES,
  MAX_FINAL_PROMPT_CHARS,
  findFinalPromptText,
  findImageRef,
  findImageRefForNode,
  normalizeComfyBaseUrl,
  type ComfyImageClientPort,
  type ComfyImageRef,
  type ComfyProgress,
  type ComfySystemStats,
  type FinalPromptRead,
} from "./client.js";
export {
  ComfyError,
  isComfyError,
  type ComfyConfig,
  type ComfyConfigProvider,
  type ComfyErrorCode,
  type ComfyFinalPromptResult,
  type ComfyFinalPromptText,
  type ComfyImageBytes,
  type ComfyImageFinalPromptView,
  type ComfyImageView,
  type ComfyLogger,
  type ImagesGatewayPort,
} from "./types.js";
export {
  YUKI_DEFAULT_NEGATIVE,
  YUKI_FINAL_PROMPT_LABEL,
  YUKI_NODE_LABELS,
  YUKI_OUTPUT_LABEL,
  YUKI_REQUIRED_LABEL,
  applyYukiValues,
  validateApiWorkflow,
  type WorkflowCheck,
  type WorkflowLabels,
  type WorkflowNodeRef,
  type YukiInjection,
  type YukiInjectionValues,
  type YukiNodeLabel,
} from "./validate.js";
export {
  MAX_TRACKED_SESSIONS,
  WorkflowConsultationTracker,
  type WorkflowConsultation,
  type WorkflowConsultationTrackerOptions,
} from "./consultation.js";
export {
  chooseWorkflow,
  foldText,
  tokenize,
  type WorkflowCandidate,
  type WorkflowChoice,
  type WorkflowChoiceReason,
} from "./selection.js";
export {
  IMAGE_STYLES_DESCRIPTION_MAX,
  IMAGE_STYLES_PROMPT_MAX,
  IMAGE_STYLES_TAG,
  formatImageStylesBlock,
} from "./prompt.js";
export {
  COMFY_WORKFLOWS_SCHEMA_VERSION,
  ComfyWorkflowError,
  ComfyWorkflowStore,
  MAX_COMFY_DESCRIPTION_CHARS,
  MAX_COMFY_DOCUMENTATION_CHARS,
  MAX_COMFY_NAME_CHARS,
  MAX_COMFY_WORKFLOWS,
  MAX_COMFY_WORKFLOW_BYTES,
  normalizeWorkflowDescription,
  normalizeWorkflowDocumentation,
  normalizeWorkflowName,
  type ComfyWorkflowEntry,
  type ComfyWorkflowErrorCode,
  type ComfyWorkflowsPort,
  type ComfyWorkflowSummary,
} from "./workflows.js";
export {
  GeneratedImagesStore,
  MAX_GENERATED_IMAGE_BYTES,
  pngDimensions,
  type GeneratedImageInput,
  type GeneratedImageRecord,
  type GeneratedImagesPort,
} from "./images.js";
export {
  MAX_IMAGE_SCENE_CHARS,
  createComfyGenerator,
  type ComfyImageGenerationPort,
  type ComfyGeneratorOptions,
  type GeneratedImage,
} from "./generator.js";
