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

import { APPROVAL_REQUIRED_TOOLS, READ_ONLY_TOOLS, approvalRequiredTools, channelTurnTimeoutMs, toolAllowlistForChat } from "../llm/tool-policy.js";
import type { ChatOriginMode, ToolAllowlistOptions } from "../llm/tool-policy.js";
import type { FilesReadPort, FilesSendPort, WireFile } from "../files/index.js";
import type { AgentDirectoryPort } from "../agents/directory.js";
import type { DelegateServicePort } from "../delegation/ports.js";
import type { ConversationArchivePort } from "../memory/conversation-archive.js";
import type { HeritagePort } from "../memory/heritage.js";
import type { SecretDirectoryPort } from "../secrets/directory.js";
import type { PiLogger } from "./types.js";
import { ackRuleFor, ackToolsOf } from "./ack.js";
import { createAckExtensionFactory } from "./sdk/ack-extension.js";
import {
  createDelegationExtensionFactory,
  type PendingJobEntry,
} from "./sdk/delegation-extension.js";
import {
  buildRemoteRunTools,
  type ChannelPostPort,
  type RemoteRunImagePorts,
  type RemoteRunLibrarianPorts,
  type RemoteRunVision,
} from "./sdk/remote-run-tools.js";
import type { MessageSendPort } from "./sdk/send-message-tool.js";

export interface RemoteRunToolsOptions {
  /** Conversation (canal distant) : les fichiers du run y sont rattachés. */
  conversationId: string;
  /** Origine du run (`chat.mode`). `local` n'a pas de sens ici : c'est le host. */
  chatMode: ChatOriginMode;
  /** `chat.remoteAgents === "actives"` (relu à chaque réponse, `apply: hot`). */
  remoteAgents: boolean;
  /**
   * `chat.remoteTools === "actives"` (relu à chaque réponse, `apply: hot`).
   *
   * ⚠️ INDÉPENDANT de `remoteAgents` : c'est ce qui permet « images oui, agents
   * non » (demande utilisateur du 2026-11-02).
   */
  remoteTools: boolean;
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
  /**
   * Fichier produit par le run (image générée ou capture) COPIÉ dans le store des
   * fichiers de la conversation : l'adaptateur le joint au message publié.
   */
  onFileProduced?: (fileId: string) => void;
  /**
   * Ports des outils d'AGENTS — utilisés SEULEMENT sous `remoteAgents = actives`.
   * Fournis mais désactivés, ils ne construisent rien : la politique les retire,
   * donc les instancier ne servirait qu'à élargir la surface pour rien.
   */
  agents?: AgentDirectoryPort;
  /** Coffre (NOMS seulement, `lister_secrets`). Groupe `agents` uniquement. */
  secrets?: SecretDirectoryPort;
  /** Délégation (`delegate`, `job_status`, `cancel_job`, `steer_job`). Groupe `agents`. */
  delegation?: DelegateServicePort;
  /** Archive « vie antérieure ». Groupe `outils` (sous `remoteTools`). */
  heritage?: HeritagePort;
  /** Archive des conversations mises de côté. Groupe `outils` (sous `remoteTools`). */
  conversationArchive?: ConversationArchivePort;
  /** Libraire (5 outils, bornes du host local). Groupe `outils` (sous `remoteTools`). */
  librarian?: RemoteRunLibrarianPorts;
  /** Fichiers envoyables (`envoyer_fichier`). Groupe `toujours` : toujours construit. */
  filesSend?: FilesSendPort;
  /** Fichier envoyé par Yuki : l'appelant le publie DANS LE CANAL. */
  onFileSent?: (file: WireFile) => void;
  /**
   * Publication inter-canal (`publier_dans_canal`, décision A).
   *
   * ⚠️ Utilisé MÊME sous `chat.remoteAgents = desactive` : c'est un message, pas une
   * action sur une machine, donc aucune approbation n'est requise. Le périmètre (canaux
   * suivis, plateforme du run) est tenu par le port, pas par l'allowlist.
   */
  channels?: ChannelPostPort;
  /**
   * Envoi de message DANS la conversation courante (`envoyer_message`, 2026-11-04).
   *
   * ⚠️ Groupe `toujours` : un message ne touche à aucune machine, donc il ne dépend
   * ni de `chat.remoteAgents` ni de `chat.remoteTools` — comme `publier_dans_canal`.
   * Le port publie par `ReplyProgress` (le canal), jamais par un second chemin.
   */
  messages?: MessageSendPort;
  logger?: PiLogger;
}

export interface RemoteRunTools {
  /** Allowlist EXACTE à passer à la session (politique de l'origine du run). */
  tools: readonly string[];
  /** Définitions construites (opaques hors de `src/pi/**`). */
  customTools: readonly unknown[];
  /**
   * BORNE (ms) que le TOUR doit couvrir à cause d'outils longs AUTORISÉS INLINE.
   *
   * ⚠️ `0` quand aucun outil long n'est autorisé inline : quand `delegate` existe
   * (groupe `agents` ouvert), les outils longs sont REFUSÉS (donc coût zéro), et
   * en LOCAL ce champ n'est jamais lu (le host n'a pas de borne de tour).
   * ⚠️ Sans `delegate`, `generer_image` peut s'exécuter inline : la borne du tour
   * doit alors valoir AU MOINS `images.timeoutMs` (1 h), sinon la génération
   * serait coupée en plein vol — le défaut même que le refus prétendait fermer.
   * ⚠️ INDÉPENDANT des deux réglages : c'est l'ABSENCE de `delegate` qui décide,
   * pas la valeur de `chat.remoteTools`.
   */
  inlineLongToolBudgetMs?: number;
  /**
   * EXTENSIONS INLINE du run (opaques hors de `src/pi/**`).
   *
   * ⚠️ Elles portent la CONSIGNE D'ACCUSÉ (`ackRuleFor(tools)`) et, quand
   * `delegate` existe (groupe `agents` ouvert), la RÈGLE DE DÉLÉGATION + la liste
   * des jobs du CANAL (`createDelegationExtensionFactory`,
   * `src/pi/sdk/delegation-extension.ts`).
   *
   * ⚠️ Sans la consigne d'accusé, le modèle du canal appelle l'outil SANS RIEN DIRE :
   * c'est alors la table de replis qui parle à sa place — le comportement mécanique
   * (« toujours la même phrase ») que l'utilisateur a refusé (2026-11-02).
   */
  extensionFactories?: readonly unknown[];
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
 * Jobs EN COURS de la CONVERSATION (le canal), pour la règle de délégation.
 *
 * ⚠️ On interroge la CONVERSATION, jamais l'identifiant de la session
 * éphémère du run : elle ne désigne aucun fil, donc `pendingJobs` y rendrait
 * toujours « aucun job » et le modèle n'aurait rien à relayer. Une lecture en
 * échec est traitée comme « aucun job » (on ne casse jamais un tour pour un
 * diagnostic).
 */
function jobsOfConversation(
  port: DelegateServicePort | undefined,
  conversationId: string,
): PendingJobEntry[] {
  if (!port) return [];
  try {
    return port.pendingJobs(conversationId).map((job) => ({
      jobId: job.jobId,
      task: job.task,
      ...(job.status !== undefined ? { status: job.status } : {}),
      ...(job.startedAt !== undefined ? { startedAt: job.startedAt } : {}),
    }));
  } catch {
    return [];
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
    remoteTools: options.remoteTools,
  });
  assertNoApprovalTool(tools);

  // ⚠️ DEUX INTERRUPTEURS, DEUX FAMILLES DE PORTS :
  //  - `agents` (délégation, annuaire, coffre) ne sont transmis que sous
  //    `remoteAgents = actives` ;
  //  - `outils` (libraire, archives) ne sont transmis que sous
  //    `remoteTools = actives` ;
  //  - `images` suit `chat.remoteTools` (groupe `outils`) ; `files` et
  //    `filesSend` (groupes `toujours`) sont transmis TOUJOURS : `buildRemoteRunTools`
  //    décide, et la politique a déjà tranché.
  // Construire un port que la politique retire n'ouvrirait rien — un test vérifie
  // que les DÉFINITIONS restent, elles aussi, dans le périmètre autorisé.
  const actifs = options.remoteAgents;
  const outilsOuverts = options.remoteTools;

  const customTools = buildRemoteRunTools({
    conversationId: options.conversationId,
    // ⚠️ IMAGE = groupe `outils` : le port n'est transmis que sous
    // `remoteTools = actives`. Sinon la définition existerait sans sa permission —
    // exactement l'écart politique ↔ définitions que les tests interdisent.
    ...(outilsOuverts && options.images ? { images: options.images } : {}),
    ...(options.files ? { files: options.files } : {}),
    ...(options.vision ? { vision: options.vision } : {}),
    ...(options.onFileProduced ? { onFileProduced: options.onFileProduced } : {}),
    // ⚠️ PUBLICATION INTER-CANAL : hors de tout bloc de réglage À DESSEIN — l'outil est
    // dans le groupe `toujours` (aucun réglage), et le construire seulement sous
    // `actives` ferait diverger la politique de l'implémentation (l'écart est
    // journalisé, mais autant ne pas l'avoir).
    ...(options.channels ? { channels: options.channels } : {}),
    // ⚠️ ENVOI DE MESSAGE (`envoyer_message`) : groupe `toujours`, donc transmis hors
    // de tout bloc de réglage — sinon la politique (qui pousse le socle incondition-
    // nellement) autoriserait un outil que ce run n'instancie pas.
    ...(options.messages ? { messages: options.messages } : {}),
    ...(actifs && options.agents ? { agents: options.agents } : {}),
    ...(actifs && options.secrets ? { secrets: options.secrets } : {}),
    ...(actifs && options.delegation ? { delegation: options.delegation } : {}),
    ...(outilsOuverts && options.heritage ? { heritage: options.heritage } : {}),
    ...(outilsOuverts && options.conversationArchive
      ? { conversationArchive: options.conversationArchive }
      : {}),
    ...(outilsOuverts && options.librarian ? { librarian: options.librarian } : {}),
    // ⚠️ `envoyer_fichier` est du groupe `toujours` : son port est transmis même
    // sans aucun réglage (il ne sort pas de la conversation).
    ...(options.filesSend ? { filesSend: options.filesSend } : {}),
    ...(options.onFileSent ? { onFileSent: options.onFileSent } : {}),
  });
  assertNoApprovalToolDefinition(customTools);

  // ⚠️ RÈGLE DE DÉLÉGATION EN CANAL (lot 23) : SANS elle, le modèle du canal ne
  // savait pas qu'il pouvait déléguer — il faisait le travail long lui-même, et
  // le tour était coupé à `CHAT_REPLY_TIMEOUT_MS` (90 s) sans aucun message.
  //
  // ⚠️ SOUS `chat.remoteAgents = actives` SEULEMENT : sous `desactive`, `delegate`
  // n'existe pas (groupe `agents`) et une règle qui ordonne un outil absent
  // ferait inventer une action au modèle. ⚠️ Le DÉFAUT de `chat.remoteAgents`
  // reste `desactive` — donc, par défaut, la délégation est IMPOSSIBLE en canal,
  // quel que soit `chat.remoteTools` (les outils n'ouvrent pas la délégation).
  const regleDelegation =
    actifs && options.delegation
      ? [
          createDelegationExtensionFactory({
            activeJobs: () => jobsOfConversation(options.delegation, options.conversationId),
            ...(options.logger ? { logger: options.logger } : {}),
          }),
        ]
      : [];

  // ⚠️ CONSIGNE D'ACCUSÉ (décision utilisateur 2026-11-02) : l'accusé est ÉCRIT PAR LE
  // MODÈLE, comme en local. La consigne voyage par le MÊME mécanisme que la règle de
  // délégation (`extensionFactories` → prompt système du tour), donc ZÉRO appel modèle
  // supplémentaire : c'est le tour existant qui la porte.
  //
  // ⚠️ PARAMÉTRÉE PAR L'ALLOWLIST RÉELLE DU RUN (`ackRuleFor`, `src/pi/ack.ts`) et non
  // `ACK_RULE` (la variante locale, qui cite `run_command` — outil qu'un canal n'a
  // jamais). Citer un outil absent décrit une action que le modèle ne peut pas lancer.
  //
  // ⚠️ INUTILE (donc absente) sans aucun déclencheur : sans action longue, une consigne
  // d'accusé ne pourrait que produire du bruit dans le prompt.
  const regleAccuse: readonly unknown[] =
    ackToolsOf(tools).length > 0 ? [createAckExtensionFactory(ackRuleFor(tools))] : [];

  // L'ordre suit celui du host local (`src/pi/sdk-host.ts:2025`) : les règles du run
  // d'abord, la consigne d'accusé en dernier.
  const extensionFactories: readonly unknown[] = [...regleDelegation, ...regleAccuse];

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
      outils: options.remoteTools,
      tools: manquants,
    });
  }

  // ⚠️ BORNE DU TOUR quand des outils longs sont AUTORISÉS INLINE (2026-11-02) :
  // quand `delegate` n'existe pas (groupe `agents` fermé — le DÉFAUT), le
  // garde-fou ne refuse PAS `generer_image` (`guardLongToolsInChannel`) s'il est
  // ouvert par `chat.remoteTools`. Un tour de canal vaut `CHAT_REPLY_TIMEOUT_MS`
  // (90 s) alors que la génération peut durer `images.timeoutMs` (1 h) : la
  // borne est donc DÉRIVÉE des outils longs réellement construits, jamais devinée.
  // Avec `delegate`, tous les outils longs sont refusés inline ⇒ budget 0 (la
  // borne de base reste inchangée).
  const delegationDisponible = actifs && options.delegation !== undefined;
  const inlineLongToolBudgetMs = delegationDisponible
    ? 0
    : channelTurnTimeoutMs({
        tools: customTools.map((tool) => (tool as { name?: string }).name ?? ""),
        delegationAvailable: false,
        baseMs: 0,
      });

  return {
    tools,
    customTools,
    inlineLongToolBudgetMs,
    ...(extensionFactories.length > 0 ? { extensionFactories } : {}),
  };
}
