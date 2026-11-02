/**
 * Outils d'un run DISTANT (canal Mattermost/Discord) — `src/pi/sdk/**`.
 *
 * ⚠️ LE TROU QUE CE MODULE A FERMÉ (lot 20) : la réponse rédigée dans un canal
 * distant ouvrait une session éphémère SANS AUCUN OUTIL (`tools: []`), donc
 * `generer_image` était inatteignable depuis Mattermost — alors que
 * l'utilisateur l'a exigé (« je veux pouvoir générer et analyser des images sur
 * mattermost »).
 *
 * ⚠️ LE SECOND TROU QUE CE MODULE FERME (2026-11-02) : la politique distante
 * autorisait ~19 outils sous `chat.remoteAgents = actives`, alors que ce module
 * n'en construisait que 5 : la délégation, l'annuaire des agents, le coffre,
 * l'archive, le libraire et l'envoi de fichier étaient **autorisés mais
 * absents**. Un réglage qui ne donne rien est un mensonge d'interface — les
 * fabriques du host local sont donc instanciées ici, dans le MÊME ordre de
 * lecture, sous `actives` seulement.
 *
 * ⚠️ MÊME CHEMIN QUE LE MODE LOCAL, PAS UNE SECONDE LISTE : ce module n'écrit
 * aucune liste d'outils. Il instancie les MÊMES fabriques que le host local
 * (`createImageTools`, `createListFilesTool`, `createReadFileTool`,
 * `createDelegateTools`, `createAgentDirectoryTools`, `createSecretTools`,
 * `createHeritageTools`, `createConversationArchiveTools`,
 * `createLibrarianTools`, `createSendFileTools` — `src/pi/sdk-host.ts:1900-2060`) ;
 * l'ALLOWLIST, elle, vient de `toolAllowlistForChat` (`src/llm/tool-policy.ts`),
 * calculée à partir des MÊMES options que le host local. Une divergence entre la
 * politique et l'implémentation est donc détectable par test.
 *
 * ⚠️ AUCUN OUTIL À APPROBATION ICI : `run_command`, `capturer_ecran`,
 * `recuperer_fichier`, `deposer_fichier` et `demander_secret` exigent une
 * décision humaine qui s'affiche dans l'interface WEB (`APPROVAL_REQUIRED_TOOLS`,
 * `src/llm/tool-policy.ts`) ; ils ne sont NI autorisés NI construits (`src/pi/chat-run.ts`
 * les retire et `assertNoApprovalTool` lève si une liste en contient un). Un outil
 * à approbation dans un canal bloquerait le run POUR TOUJOURS.
 *
 * ⚠️ CONVERSATION FORCÉE : la session du run distant est ÉPHÉMÈRE (en mémoire,
 * identifiant jetable) : sans `sessionId` forcé, une image générée serait
 * rattachée à une conversation FANTÔME (invisible, jamais listable),
 * `lister_fichiers` ne verrait rien, `envoyer_fichier` chercherait dans un fil
 * inexistant et une capture du libraire serait enregistrée hors de tout fil. On
 * force donc l'identifiant du canal PARTOUT, comme le worker lourd force celui de
 * sa conversation propriétaire (`src/pi/sdk/heavy-worker.ts`,
 * `buildHeavyActionTools`).
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { AgentDirectoryPort } from "../../agents/directory.js";
import type {
  CancelOutcome,
  DelegateOutcome,
  DelegateRequest,
  DelegateServicePort,
  SteerOutcome,
} from "../../delegation/ports.js";
import type { FilesReadPort, FilesSendPort, WireFile } from "../../files/index.js";
import type { JobRecord } from "../../jobs/types.js";
import type { ConversationArchivePort } from "../../memory/conversation-archive.js";
import type { HeritagePort } from "../../memory/heritage.js";
import type { SecretDirectoryPort } from "../../secrets/directory.js";
import { createDelegateTools, createRunContextTracker } from "./delegate-tools.js";
import { createAgentDirectoryTools, createSecretTools } from "./execution-tools.js";
import { createChannelPostTool, type ChannelPostPort } from "./channel-post-tool.js";
import { guardLongToolsInChannel } from "./long-tool-guard.js";

export type { ChannelPostPort };
import { createConversationArchiveTools } from "./conversation-archive-tools.js";
import { createHeritageTools } from "./heritage-tools.js";
import { createImageTools, type ImageToolPort } from "./image-tools.js";
import { createLibrarianTools, type LibrarianToolsConfig } from "./librarian-tools.js";
import { createListFilesTool } from "./list-files-tool.js";
import { createReadFileTool } from "./read-file-tool.js";
import { createSendFileTools } from "./send-file-tool.js";

/**
 * Ports d'IMAGE d'un run distant : MÊMES ports que le host local, à ceci près
 * que la conversation n'est pas lue du contexte de l'outil — elle est FORCÉE
 * (voir `RemoteRunToolPorts.conversationId`).
 */
export type RemoteRunImagePorts = Omit<ImageToolPort, "sessionId" | "logger" | "consultation">;

/**
 * Ports du LIBRAIRE d'un run distant : MÊMES ports que le host local. La
 * session (pour les captures) est FORCÉE au canal par ce module, jamais lue du
 * contexte de l'outil.
 */
export type RemoteRunLibrarianPorts = Omit<LibrarianToolsConfig, "sessionId" | "receivesImages"> & {
  /** Le modèle du run reçoit-il les images ? (relu à chaque capture). */
  receivesImages?: () => boolean;
};

/** Capacité VISION du modèle du run distant (lue à l'exécution, jamais supposée). */
export interface RemoteRunVision {
  /** Référence `provider/modelId` effectivement résolue. */
  modelLabel: () => string;
  /** Le modèle accepte-t-il les images ? (`llm.light.vision`). */
  imagesSupported: () => boolean;
}

export interface RemoteRunToolPorts {
  /**
   * Conversation (canal) à laquelle rattacher le run : elle est FORCÉE sur
   * TOUS les outils qui manipulent une conversation (`generer_image`,
   * `lister_fichiers`, `lire_fichier`, `envoyer_fichier`, `capture_libraire`,
   * les jobs de `delegate`).
   */
  conversationId: string;
  /** Ports d'image (serveur ComfyUI). Absents ⇒ ni `generer_image` ni `consulter_workflow`. */
  images?: RemoteRunImagePorts;
  /** Port des fichiers de la conversation. Absent ⇒ ni `lister_fichiers` ni `lire_fichier`. */
  files?: FilesReadPort;
  /** Vision du modèle du run (transmise à `lire_fichier` pour dire la vérité). */
  vision?: RemoteRunVision;
  /**
   * Port de PUBLICATION inter-canal (`publier_dans_canal`, décision A).
   *
   * ⚠️ Fourni INDÉPENDAMMENT de `chat.remoteAgents` : publier un message ne touche à aucune
   * machine, donc aucune approbation n'est en jeu — l'outil fait partie de
   * `REMOTE_SAFE_TOOLS`. Le PÉRIMÈTRE (canaux suivis, même plateforme, fichiers de
   * la conversation SOURCE) est tenu par le port (`src/chat/reply/channel-post.ts`),
   * jamais par le modèle.
   */
  channels?: ChannelPostPort;
  /**
   * Fichier produit par le run (image générée COPIÉE dans le store des fichiers).
   * ⚠️ C'est ce que l'adaptateur joint au message publié (`file_ids`) : sans ce
   * rappel, l'image existerait sans jamais arriver dans le canal.
   */
  onFileProduced?: (fileId: string) => void;
  /** Annuaire des agents appairés. Absent ⇒ ni `lister_agents` ni `etat_agent`. */
  agents?: AgentDirectoryPort;
  /** Coffre de secrets. Absent ⇒ pas de `lister_secrets` (NOMS seulement). */
  secrets?: SecretDirectoryPort;
  /**
   * Service de DÉLÉGATION. Absent ⇒ ni `delegate` ni `job_status`/`cancel_job`/
   * `steer_job`. ⚠️ Les jobs créés ici sont rattachés au CANAL (conversation
   * forcée) : c'est ce rattachement qui fait revenir leur résultat dans le canal.
   */
  delegation?: DelegateServicePort;
  /** Archive « vie antérieure » (LECTURE SEULE). Absente ⇒ pas d'`archive_vie_anterieure`. */
  heritage?: HeritagePort;
  /** Archive des conversations mises de côté (LECTURE SEULE). Absente ⇒ pas de recherche. */
  conversationArchive?: ConversationArchivePort;
  /** Libraire (5 outils). Absent ⇒ aucun outil du libraire. */
  librarian?: RemoteRunLibrarianPorts;
  /** Fichiers ENVOYABLES par Yuki. Absent ⇒ pas d'`envoyer_fichier`. */
  filesSend?: FilesSendPort;
  /**
   * Fichier envoyé par Yuki : l'appelant le PUBLIE dans le canal (téléversement
   * + post). Sans ce rappel, `envoyer_fichier` n'afficherait le fichier que dans
   * l'interface web — invisible pour la personne qui parle dans le canal.
   */
  onFileSent?: (file: WireFile) => void;
}

/**
 * Rend un `DelegateServicePort` dont les jobs appartiennent à la CONVERSATION
 * FORCÉE (le canal) et dont la lecture est CLOSE sur elle.
 *
 * ⚠️ Deux garanties distinctes :
 *  - `delegate` : le job est rattaché au canal (`lightSessionId`), donc son
 *    rapport RÉVEILLE Yuki dans CE canal (voir `createChannelAwareWaker`,
 *    `src/chat/reply/channel-waker.ts`) — il ne « remonte » pas dans une session
 *    éphémère que personne ne verra, et il n'est pas publié par le serveur ;
 *  - `job_status`/`cancel_job`/`steer_job` : un job d'un AUTRE canal (ou d'une
 *    conversation locale) répond `not_found`. Sans ce cloisonnement, n'importe
 *    quel membre d'un canal pourrait lire ou annuler le travail d'un autre.
 */
function channelScopedDelegation(
  service: DelegateServicePort,
  conversation: () => string,
): DelegateServicePort {
  const owns = (job: JobRecord | undefined): job is JobRecord =>
    job !== undefined && job.lightSessionId === conversation();
  return {
    delegate: (request: DelegateRequest): Promise<DelegateOutcome> =>
      service.delegate({ ...request, lightSessionId: conversation() }),
    jobStatus: (jobId: string): JobRecord | undefined => {
      const job = service.jobStatus(jobId);
      return owns(job) ? job : undefined;
    },
    cancelJob: (jobId: string): Promise<CancelOutcome> =>
      owns(service.jobStatus(jobId))
        ? service.cancelJob(jobId)
        : Promise.resolve({ status: "not_found", job_id: jobId }),
    steerJob: (jobId: string, text: string): Promise<SteerOutcome> =>
      owns(service.jobStatus(jobId))
        ? service.steerJob(jobId, text)
        : Promise.resolve({
            status: "not_found",
            job_id: jobId,
            note:
              "Ce job n'appartient pas à cette conversation : il n'est pas " +
              "orientable depuis ce canal.",
          }),
    hasPendingWork: (sessionId: string): boolean => service.hasPendingWork(sessionId),
    pendingJobs: (sessionId: string) => service.pendingJobs(sessionId),
  };
}

/**
 * Construit les outils d'un run distant.
 *
 * ⚠️ Chaque port ABSENT retire ses outils : un run distant sans coffre exposé
 * n'a pas `lister_secrets`, etc. L'appelant (`src/pi/chat-run.ts`) ne fournit ces
 * ports QUE sous `chat.remoteAgents = actives`, si bien que la liste construite
 * ici est exactement celle de la politique (`REMOTE_SAFE_TOOLS` quand les agents
 * sont désactivés).
 */
export function buildRemoteRunTools(ports: RemoteRunToolPorts): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  const conversation = (): string => ports.conversationId;

  if (ports.images) {
    // ⚠️ COPIE de l'image dans le store des FICHIERS : c'est elle qui rend
    // l'image envoyable (l'adaptateur lève ses octets par son port de fichiers).
    // On l'enveloppe pour RETENIR l'identifiant produit — l'appelant le joint au
    // message publié. Le port d'origine n'est pas modifié (même déduplication).
    const archive = ports.images.archive;
    const images: ImageToolPort = {
      ...ports.images,
      sessionId: conversation,
      ...(archive
        ? {
            archive: {
              archive: (input) => {
                const outcome = archive.archive(input);
                if (outcome.ok) ports.onFileProduced?.(outcome.file.id);
                return outcome;
              },
            },
          }
        : {}),
    };
    tools.push(...createImageTools(images));
  }

  if (ports.files) {
    tools.push(...createListFilesTool(ports.files, { sessionId: conversation }));
    tools.push(
      ...createReadFileTool(ports.files, {
        sessionId: conversation,
        ...(ports.vision
          ? {
              imagesSupported: ports.vision.imagesSupported(),
              modelLabel: ports.vision.modelLabel(),
            }
          : {}),
      }),
    );
  }

  if (ports.agents) {
    // LECTURE SEULE : noms, identifiants, état, niveau, historique (jamais une
    // sortie de commande). Le rendu est encadré/échappé par `src/agents/output.ts`.
    tools.push(...createAgentDirectoryTools(ports.agents));
  }

  if (ports.secrets) {
    // ⚠️ NOMS seulement : l'outil ne rend JAMAIS une valeur (`frameSecretList`).
    tools.push(...createSecretTools(ports.secrets));
  }

  if (ports.delegation) {
    // ⚠️ Une seule fabrique pour les quatre outils : `createDelegateTools` est
    // celui du host local. Le tracker est local au run (aucun contexte de run
    // n'existe pour une session éphémère) : le rattachement au canal est assuré
    // par `channelScopedDelegation`, jamais par le contexte de l'outil.
    tools.push(
      ...createDelegateTools({
        service: channelScopedDelegation(ports.delegation, conversation),
        tracker: createRunContextTracker(),
      }),
    );
  }

  if (ports.heritage) {
    tools.push(...createHeritageTools(ports.heritage));
  }

  if (ports.conversationArchive) {
    tools.push(...createConversationArchiveTools(ports.conversationArchive));
  }

  if (ports.librarian) {
    tools.push(
      ...createLibrarianTools({
        ...ports.librarian,
        // ⚠️ La CAPTURE d'une page est enregistrée dans le fil du CANAL (sinon
        // elle serait rattachée à la session éphémère, donc irrestaurable).
        sessionId: conversation,
        // ⚠️ CAPACITÉ VISION relue à CHAQUE appel : sans « image » dans `input`,
        // le SDK remplacerait la capture par « (tool image omitted…) » et le
        // modèle croirait l'avoir vue.
        receivesImages: ports.librarian.receivesImages ?? (() => ports.vision?.imagesSupported() ?? true),
      }),
    );
  }

  if (ports.channels) {
    // ⚠️ PUBLICATION INTER-CANAL (décision A) : l'outil ne porte AUCUNE règle de périmètre —
    // le port refuse un canal non suivi (ou d'une autre plateforme) avec une raison
    // actionnable. Rien ici ne permet donc au modèle d'écrire hors du miroir.
    // ⚠️ FICHIERS (2026-11-02) : `fichier_ids` sont des identifiants du STORE des
    // fichiers, résolus et VALIDÉS par le port (appartenance à la conversation
    // source, même plateforme, bornes) — jamais des chemins, jamais des octets.
    tools.push(...createChannelPostTool(ports.channels));
  }

  if (ports.filesSend) {
    const service = ports.filesSend;
    // ⚠️ Le fichier envoyé doit ARRIVER DANS LE CANAL : le port d'origine ne
    // diffuse qu'une trame de contrôle vers l'interface web. On l'enveloppe pour
    // que l'appelant le publie (téléversement + post) — jamais silencieux.
    tools.push(
      ...createSendFileTools(
        {
          listForSession: (sessionId) => service.listForSession(sessionId),
          send: (sessionId, reference) => {
            const file = service.send(sessionId, reference);
            if (file) ports.onFileSent?.(file);
            return file;
          },
        },
        { sessionId: conversation },
      ),
    );
  }

  // ⚠️ OUTILS LONGS REFUSÉS (lot 23) : un run de CANAL est borné par
  // `CHAT_REPLY_TIMEOUT_MS` (90 s) alors que `generer_image` peut prendre 180 s.
  // Le refus est porté par l'OUTIL (`LONG_RUNNING_TOOLS`, `src/llm/tool-policy.ts`) :
  // c'est le seul endroit où le modèle ne peut pas l'ignorer. ⚠️ Le refus ne
  // renvoie vers `delegate` QUE si la délégation existe dans ce run (sous
  // `chat.remoteAgents = actives`) : sinon il dirait de lancer un outil absent.
  // Les outils non longs sortent de ce garde-fou inchangés, et le mode LOCAL n'y
  // passe jamais.
  return guardLongToolsInChannel(tools, {
    delegationAvailable: ports.delegation !== undefined,
  });
}
