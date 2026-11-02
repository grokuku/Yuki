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

import { APPROVAL_REQUIRED_TOOLS, READ_ONLY_TOOLS, approvalRequiredTools, toolAllowlistForChat } from "../llm/tool-policy.js";
import type { ChatOriginMode, ToolAllowlistOptions } from "../llm/tool-policy.js";
import type { FilesReadPort, FilesSendPort, WireFile } from "../files/index.js";
import type { AgentDirectoryPort } from "../agents/directory.js";
import type { DelegateServicePort } from "../delegation/ports.js";
import type { ConversationArchivePort } from "../memory/conversation-archive.js";
import type { HeritagePort } from "../memory/heritage.js";
import type { SecretDirectoryPort } from "../secrets/directory.js";
import type { PiLogger } from "./types.js";
import {
  buildRemoteRunTools,
  type RemoteRunImagePorts,
  type RemoteRunLibrarianPorts,
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
  /**
   * Ports des outils d'AGENTS — utilisés SEULEMENT sous `remoteAgents = actives`.
   * Fournis mais désactivés, ils ne construisent rien : la politique les retire,
   * donc les instancier ne servirait qu'à élargir la surface pour rien.
   */
  agents?: AgentDirectoryPort;
  /** Coffre (NOMS seulement, `lister_secrets`). Sous `actives` uniquement. */
  secrets?: SecretDirectoryPort;
  /** Délégation (`delegate`, `job_status`, `cancel_job`, `steer_job`). Sous `actives` uniquement. */
  delegation?: DelegateServicePort;
  /** Archive « vie antérieure ». Sous `actives` uniquement. */
  heritage?: HeritagePort;
  /** Archive des conversations mises de côté. Sous `actives` uniquement. */
  conversationArchive?: ConversationArchivePort;
  /** Libraire (5 outils, bornes du host local). Sous `actives` uniquement. */
  librarian?: RemoteRunLibrarianPorts;
  /** Fichiers envoyables (`envoyer_fichier`). Sous `actives` uniquement. */
  filesSend?: FilesSendPort;
  /** Fichier envoyé par Yuki : l'appelant le publie DANS LE CANAL. */
  onFileSent?: (file: WireFile) => void;
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
 * LÈVE si le jeu de DÉFINITIONS contient un outil à approbation.
 *
 * ⚠️ Ce n'est pas redondant avec `assertNoApprovalTool` : celui-ci contrôle la
 * LISTE, celui-là ce qui est réellement CONSTRUIT. Un outil instancié mais absent
 * de la liste serait filtré par le SDK ; l'inverse (liste propre, définition à
 * approbation fournie par un port mal câblé) est exactement ce qu'on refuse.
 */
export function assertNoApprovalToolDefinition(
  customTools: readonly unknown[],
): void {
  const noms = customTools
    .map((tool) => (tool as { name?: string }).name)
    .filter((name): name is string => typeof name === "string");
  const bloquants = noms.filter((name) => APPROVAL_REQUIRED_TOOLS.includes(name));
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

  // ⚠️ SOUS `desactive`, les ports d'AGENTS ne sont même pas transmis : la
  // politique les retire, donc les construire n'ouvrirait rien — et un test
  // vérifie que les DÉFINITIONS restent, elles aussi, dans `REMOTE_SAFE_TOOLS`.
  const actifs = options.remoteAgents;

  const customTools = buildRemoteRunTools({
    conversationId: options.conversationId,
    ...(options.images ? { images: options.images } : {}),
    ...(options.files ? { files: options.files } : {}),
    ...(options.vision ? { vision: options.vision } : {}),
    ...(options.onFileProduced ? { onFileProduced: options.onFileProduced } : {}),
    ...(actifs && options.agents ? { agents: options.agents } : {}),
    ...(actifs && options.secrets ? { secrets: options.secrets } : {}),
    ...(actifs && options.delegation ? { delegation: options.delegation } : {}),
    ...(actifs && options.heritage ? { heritage: options.heritage } : {}),
    ...(actifs && options.conversationArchive
      ? { conversationArchive: options.conversationArchive }
      : {}),
    ...(actifs && options.librarian ? { librarian: options.librarian } : {}),
    ...(actifs && options.filesSend ? { filesSend: options.filesSend } : {}),
    ...(actifs && options.onFileSent ? { onFileSent: options.onFileSent } : {}),
  });
  assertNoApprovalToolDefinition(customTools);

  // ⚠️ ÉCART DIT, JAMAIS SILENCIEUX : la politique peut autoriser un outil que
  // ce run n'instancie pas (port absent — pas de coffre, pas de libraire
  // configuré, pas de service de délégation). Le modèle ne le voit pas — le SDK
  // ne registre que les définitions fournies — et on le JOURNALISE pour que
  // l'écart ne devienne pas un mystère.
  //
  // ⚠️ Les BUILTINS (`read`, `ls`, `grep`, `find`) ne sont JAMAIS « manquants » :
  // ils sont fournis par le SDK lui-même dès qu'ils figurent dans l'allowlist
  // (`node_modules/@earendil-works/…/core/agent-session.js`, outillage natif).
  // Les compter comme manquants rendait ce journal FAUX.
  const fournis = new Set(customTools.map((tool) => (tool as { name?: string }).name));
  const builtins = new Set<string>(READ_ONLY_TOOLS);
  const manquants = tools.filter((tool) => !fournis.has(tool) && !builtins.has(tool));
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
