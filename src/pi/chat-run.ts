/**
 * Façade PURE du jeu d'outils d'un run DISTANT — `src/pi/**` (hors `sdk/`).
 *
 * ⚠️ POURQUOI CETTE FAÇADE : la composition root (`src/index.ts`) ne doit pas
 * importer `src/pi/sdk/**` (invariant 3 de `tests/pi/boundary.test.ts`) et aucun
 * type du SDK ne doit traverser la façade. On expose donc :
 *  - la POLITIQUE (`tools`), calculée par `toolAllowlistForChat` — le MÊME
 *    calcul que le mode local, à partir des MÊMES options ;
 *  - les DÉFINITIONS (`customTools`) sous forme OPAQUE (`unknown[]`), comme
 *    `PiHostOptions.customTools` ;
 *  - le REFUS AVANT EXÉCUTION des outils qui exigent une approbation humaine.
 */

import { approvalRequiredTools, toolAllowlistForChat } from "../llm/tool-policy.js";
import type { ChatOriginMode, ToolAllowlistOptions } from "../llm/tool-policy.js";
import type { FilesReadPort } from "../files/index.js";
import type { PiLogger } from "./types.js";
import {
  buildRemoteRunTools,
  type RemoteRunImagePorts,
  type RemoteRunVision,
} from "./sdk/remote-run-tools.js";

export interface RemoteRunToolsOptions {
  /** Conversation (canal distant) : les fichiers du run y sont rattachés. */
  conversationId: string;
  /** Origine du run (`chat.mode`). `local` n'a pas de sens ici : c'est le host. */
  chatMode: ChatOriginMode;
  /** `chat.remoteAgents === "actives"` (relu à chaque réponse, `apply: hot`). */
  remoteAgents: boolean;
  /**
   * Options de politique du rôle LÉGER — LES MÊMES que le host local
   * (`createPiHost`). C'est ce partage qui interdit une seconde liste.
   */
  lightOptions: () => ToolAllowlistOptions;
  /** Ports d'image (serveur ComfyUI) : absents ⇒ ni `generer_image` ni `consulter_workflow`. */
  images?: RemoteRunImagePorts;
  /** Port des fichiers de la conversation : absent ⇒ ni `lister_fichiers` ni `lire_fichier`. */
  files?: FilesReadPort;
  /** Vision du modèle du run distant. */
  vision?: RemoteRunVision;
  /** Fichier produit par le run (image copiée dans le store), à joindre au message. */
  onFileProduced?: (fileId: string) => void;
  logger?: PiLogger;
}

export interface RemoteRunTools {
  /** Allowlist EXACTE à passer à la session (politique de l'origine du run). */
  tools: readonly string[];
  /** Définitions construites (opaques hors de `src/pi/**`). */
  customTools: readonly unknown[];
}

/**
 * Message français d'un refus d'exécution : une approbation demandée depuis un
 * canal ne peut être NI vue NI donnée. Exporté pour que le test vérifie le
 * TEXTE, pas seulement le fait que ça lève.
 */
export const REMOTE_APPROVAL_REFUSAL =
  "Cette action nécessite une approbation humaine, qui ne peut pas être donnée " +
  "depuis un canal distant (Mattermost/Discord) : elle s'affiche uniquement " +
  "dans l'interface web de Yuki. Rien n'a été exécuté.";

/**
 * LÈVE si une allowlist destinée à un run distant contient un outil qui exige
 * une approbation humaine.
 *
 * ⚠️ Second filet : `toolAllowlistForChat` les RETIRE déjà de toute politique
 * distante (`APPROVAL_REQUIRED_TOOLS`). Cette assertion couvre le cas où une
 * liste serait construite à la main (ou la politique contournée) : mieux vaut
 * un refus AVANT exécution qu'un run en attente pour toujours.
 */
export function assertNoApprovalTool(tools: readonly string[]): void {
  const bloquants = approvalRequiredTools(tools);
  if (bloquants.length > 0) {
    throw new Error(
      `${REMOTE_APPROVAL_REFUSAL} Outils refusés : ${bloquants.join(", ")}.`,
    );
  }
}

/**
 * Calcule le jeu d'outils d'un run distant : la POLITIQUE de son origine, puis
 * les DÉFINITIONS correspondantes (mêmes fabriques que le host local).
 */
export function createRemoteRunTools(options: RemoteRunToolsOptions): RemoteRunTools {
  const tools = toolAllowlistForChat("light", options.lightOptions(), {
    chatMode: options.chatMode,
    remoteAgents: options.remoteAgents,
  });
  assertNoApprovalTool(tools);

  const customTools = buildRemoteRunTools({
    conversationId: options.conversationId,
    ...(options.images ? { images: options.images } : {}),
    ...(options.files ? { files: options.files } : {}),
    ...(options.vision ? { vision: options.vision } : {}),
    ...(options.onFileProduced ? { onFileProduced: options.onFileProduced } : {}),
  });

  // ⚠️ ÉCART DIT, JAMAIS SILENCIEUX : avec `remoteAgents = actives`, la politique
  // autorise aussi des outils qu'un run ÉPHÉMÈRE distant n'instancie pas encore
  // (délégation, coffre, libraire, archive, envoi de fichier : ils supposent un
  // état de conversation persistant). Le modèle ne les voit pas — le SDK ne
  // registre que les définitions fournies — et on le JOURNALISE pour que l'écart
  // ne devienne pas un mystère.
  const fournis = new Set(customTools.map((tool) => (tool as { name?: string }).name));
  const manquants = tools.filter((tool) => !fournis.has(tool));
  if (manquants.length > 0) {
    options.logger?.info("chat.remote.tools.unimplemented", {
      conversation: options.conversationId,
      mode: options.chatMode,
      agents: options.remoteAgents,
      tools: manquants,
    });
  }

  return { tools, customTools };
}
