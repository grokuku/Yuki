/**
 * Domaine « génération d'images » via un serveur ComfyUI — TYPES et ERREURS.
 *
 * AUCUN import SDK/typebox : cette couche est consommée par le gateway, par le
 * host Pi (via un port) et par les tests.
 *
 * ⚠️ Les codes d'erreur portent la cause RÉELLEMENT observée (statut HTTP,
 * message du serveur, code réseau). Aucune cause n'est inventée : le message
 * affiché (français, actionnable) est composé par `describeComfyFailure` à
 * partir de ce qui a été vu.
 */

/** Sous-ensemble du logger d'observabilité (jamais une valeur secrète). */
export interface ComfyLogger {
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, data?: Record<string, unknown>): void;
}

/** Configuration effective du serveur ComfyUI (relue à CHAQUE appel). */
export interface ComfyConfig {
  /** URL du serveur (ex. `http://10.10.0.5:8188`). Vide = non configuré. */
  baseUrl: string;
  /**
   * Jeton facultatif (serveur derrière un reverse-proxy). Envoyé en
   * `Authorization: Bearer …`. ⚠️ JAMAIS journalisé, JAMAIS renvoyé par l'API.
   */
  apiKey: string;
}

/** Fournisseur de configuration (lu à chaud : aucune redémarrage requis). */
export type ComfyConfigProvider = () => ComfyConfig;

/**
 * Codes d'échec. Chacun correspond à une OBSERVATION différente :
 *  - `not_configured` : aucune URL de serveur renseignée ;
 *  - `invalid_url` : URL refusée AVANT tout appel (schéma, forme) ;
 *  - `unreachable` : la connexion a échoué (refusée, DNS, réseau) ;
 *  - `timeout` : le délai borné est dépassé ;
 *  - `cancelled` : le tour a été interrompu (annulation) ;
 *  - `http_error` : le serveur a répondu un statut d'erreur ;
 *  - `invalid_response` : réponse inattendue (JSON ou type d'image) ;
 *  - `invalid_prompt` : ComfyUI a REFUSÉ le graphe (`error`/`node_errors`) ;
 *  - `execution_failed` : l'exécution a échoué côté ComfyUI (`status.error`) ;
 *  - `no_image` : l'exécution a réussi sans produire d'image ;
 *  - `image_too_large` : image au-delà du plafond de conservation ;
 *  - `scene_too_long` : scène au-delà de la borne (refus, jamais de coupe) ;
 *  - `no_workflow` : aucun workflow importé ;
 *  - `no_matching_workflow` : aucun workflow ne correspond ET aucun défaut ;
 *  - `workflow_not_found` : nom de workflow inconnu ;
 *  - `invalid_ratio` : format demandé illisible (`16:9` attendu) ;
 *  - `storage_failed` : impossible d'enregistrer l'image sur le volume.
 */
export type ComfyErrorCode =
  | "not_configured"
  | "invalid_url"
  | "unreachable"
  | "timeout"
  | "cancelled"
  | "http_error"
  | "invalid_response"
  | "invalid_prompt"
  | "execution_failed"
  | "no_image"
  | "image_too_large"
  | "scene_too_long"
  | "no_workflow"
  | "no_matching_workflow"
  | "workflow_not_found"
  | "invalid_ratio"
  | "storage_failed";

/** Erreur portant la cause observée (statut HTTP, code réseau, message serveur). */
export class ComfyError extends Error {
  override readonly name = "ComfyError";
  constructor(
    readonly code: ComfyErrorCode,
    message: string,
    options: {
      /** Statut HTTP réellement reçu (si une réponse a eu lieu). */
      status?: number;
      /** Message brut du serveur (borné), jamais réinventé. */
      serverMessage?: string;
      /** Code système Node (`ECONNREFUSED`, `ENOTFOUND`…). */
      causeCode?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : {});
    this.status = options.status;
    this.serverMessage = options.serverMessage;
    this.causeCode = options.causeCode;
  }

  readonly status: number | undefined;
  readonly serverMessage: string | undefined;
  readonly causeCode: string | undefined;
}

/** Vrai si l'erreur est une erreur ComfyUI connue (message déjà en français). */
export function isComfyError(error: unknown): error is ComfyError {
  return error instanceof ComfyError;
}

/** Image produite par ComfyUI, avant enregistrement. */
export interface ComfyImageBytes {
  bytes: Uint8Array;
  mimeType: string;
  /** Nœud qui a produit l'image (facultatif : doubles de test du client). */
  nodeId?: string;
  /** Nom de fichier renvoyé par ComfyUI (`/view?filename=…`). */
  filename: string;
  /** Sous-dossier ComfyUI (`""` le plus souvent). */
  subfolder: string;
  /** Type ComfyUI : `output` (SaveImage) ou `temp` (PreviewImage). */
  type: string;
  promptId: string;
  /**
   * Texte publié par le nœud étiqueté `YUKI_FINAL_PROMPT`.
   * ⚠️ Absent quand le workflow ne porte PAS cette étiquette (rien n'est lu).
   */
  finalPrompt?: ComfyFinalPromptResult;
}

/**
 * Texte publié par un nœud d'AFFICHAGE, lu dans `outputs[<nœud>].text`.
 *
 * ⚠️ Forme VÉRIFIÉE dans le code source de ComfyUI et de ses extensions :
 *  - `PreviewAny` (`comfy_extras/nodes_preview_any.py` :
 *    `return {"ui": {"text": (value,)}, …}`) — un TUPLE, donc un TABLEAU en JSON ;
 *  - `SaveText` (`comfy_extras/nodes_text.py` : `ui={"text": (text,)}`) — idem ;
 *  - `ShowText` / `AIHToText` (extensions) — une LISTE d'un texte.
 * Une CHAÎNE simple est aussi acceptée (nœuds maison) : on ne devine rien, on lit
 * ce qui est publié et, sinon, on le DIT (`status: "empty"`).
 */
export interface ComfyFinalPromptText {
  /** Nœud étiqueté `YUKI_FINAL_PROMPT`. */
  nodeId: string;
  /** Texte publié, BORNÉ (voir `MAX_FINAL_PROMPT_CHARS`). */
  text: string;
  /** Longueur RÉELLE du texte avant la borne (dit à l'utilisateur si coupé). */
  totalChars: number;
  /** Vrai si le texte a été coupé à la borne. */
  truncated: boolean;
}

/**
 * Résultat de la lecture du nœud `YUKI_FINAL_PROMPT`.
 *
 * ⚠️ `empty` n'est PAS un silence : le message d'échec liste ce que le nœud a
 * réellement publié, pour que l'utilisateur puisse corriger son graphe.
 */
export type ComfyFinalPromptResult =
  | { status: "found"; prompt: ComfyFinalPromptText }
  | {
      /** Le nœud étiqueté n'a publié AUCUN texte dans l'historique. */
      status: "empty";
      nodeId: string;
      /** Clés réellement publiées par ce nœud (`images`, `gifs`…), jamais le texte. */
      publishedKeys: string[];
    };

/**
 * FICHE d'une image générée : le PROMPT FINAL lu sur le nœud `YUKI_FINAL_PROMPT`.
 *
 * ⚠️ Elle peut arriver APRÈS l'image (le texte est lu/parsé après les octets) :
 * l'interface doit alors l'afficher SOUS l'image, sans jamais déplacer l'image.
 * Ce n'est jamais une consigne : c'est une SORTIE du workflow (lecture seule).
 */
export interface ComfyImageFinalPromptView {
  /** Image à compléter (`/images/<id>.<ext>`). */
  id: string;
  finalPrompt: ComfyFinalPromptText;
  /** Conversation demandeuse (routage de la trame WS). */
  sessionId?: string;
}

/**
 * Port consommé par le transport WebSocket pour AFFICHER une image générée DANS
 * la conversation (trame de contrôle, jamais bufferisée).
 */
export interface ImagesGatewayPort {
  subscribeImages(listener: (view: ComfyImageView) => void): () => void;
  /**
   * Complète une image DÉJÀ affichée par sa FICHE (prompt final), quand le texte
   * du workflow n'est connu qu'APRÈS l'image. Optionnel : un transport qui ne la
   * connaît pas ne restaure rien (comportement d'avant).
   */
  subscribeImageFinalPrompts?(
    listener: (view: ComfyImageFinalPromptView) => void,
  ): () => void;
  /**
   * Images ENCORE VALABLES d'une conversation (rétention non atteinte), de la
   * plus ancienne à la plus récente. Optionnel : un transport qui ne la connaît
   * pas ne restaure rien (comportement d'avant). C'est la source de la
   * RESTAURATION après rechargement : l'image n'est plus un état purement
   * éphémère, elle est conservée comme une pièce jointe.
   */
  imagesForSession?(sessionId: string): ComfyImageView[];
}

/** Vue d'une image générée destinée à l'interface (trame de contrôle WS). */
export interface ComfyImageView {
  id: string;
  /** Chemin same-origin servable (`/images/<id>.<ext>`). */
  imageSrc: string;
  mimeType: string;
  width?: number;
  height?: number;
  bytes: number;
  createdAt: string;
  /**
   * Instant d'EXPIRATION (ISO 8601) : la même rétention que les pièces jointes
   * (`files.retentionDays`). Affiché par l'interface et vérifié côté serveur.
   */
  expiresAt?: string;
  /** Conversation demandeuse (routage de la trame WS). */
  sessionId?: string;
  /** Identifiant du prompt ComfyUI (diagnostic, jamais une donnée sensible). */
  promptId: string;
  /**
   * Prompt FINAL produit par le workflow (`YUKI_FINAL_PROMPT`), affiché sous
   * l'image en LECTURE seule. ⚠️ Absent quand le workflow n'a pas l'étiquette :
   * c'est une SORTIE, jamais une donnée réinjectée dans un graphe.
   */
  finalPrompt?: ComfyFinalPromptText;
}
