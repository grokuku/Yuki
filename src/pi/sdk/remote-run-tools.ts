/**
 * Outils d'un run DISTANT (canal Mattermost/Discord) — `src/pi/sdk/**`.
 *
 * ⚠️ LE TROU QUE CE MODULE FERME : la réponse rédigée dans un canal distant
 * ouvrait une session éphémère SANS AUCUN OUTIL (`src/pi/sdk/prompt-writer.ts`,
 * `tools: []`), donc `generer_image` était inatteignable depuis Mattermost —
 * alors que l'utilisateur l'a exigé (« je veux pouvoir générer et analyser des
 * images sur mattermost »).
 *
 * ⚠️ MÊME CHEMIN QUE LE MODE LOCAL, PAS UNE SECONDE LISTE : ce module n'écrit
 * aucune liste d'outils. Il instancie les MÊMES fabriques que le host local
 * (`createImageTools`, `createListFilesTool`, `createReadFileTool` —
 * `src/pi/sdk-host.ts:1988-2040`) ; l'ALLOWLIST, elle, vient de
 * `toolAllowlistForChat` (`src/llm/tool-policy.ts`), calculée à partir des MÊMES
 * options que le host local. Une divergence entre la politique et
 * l'implémentation est donc détectable par test : le jeu construit ici couvre
 * EXACTEMENT `REMOTE_SAFE_TOOLS` (`tests/llm/tool-policy.test.ts`).
 *
 * ⚠️ CONVERSATION FORCÉE : la session du run distant est ÉPHÉMÈRE (en mémoire,
 * identifiant jetable) : sans `sessionId` forcé, une image générée serait
 * rattachée à une conversation FANTÔME (invisible, jamais listable) et
 * `lister_fichiers` ne verrait rien. On force donc l'identifiant du canal, comme
 * le worker lourd force celui de sa conversation propriétaire
 * (`src/pi/sdk/heavy-worker.ts`, `buildHeavyActionTools`).
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { FilesReadPort } from "../../files/index.js";
import { createImageTools, type ImageToolPort } from "./image-tools.js";
import { createListFilesTool } from "./list-files-tool.js";
import { createReadFileTool } from "./read-file-tool.js";

/**
 * Ports d'IMAGE d'un run distant : MÊMES ports que le host local, à ceci près
 * que la conversation n'est pas lue du contexte de l'outil — elle est FORCÉE
 * (voir `RemoteRunToolPorts.conversationId`).
 */
export type RemoteRunImagePorts = Omit<ImageToolPort, "sessionId" | "logger" | "consultation">;

/** Capacité VISION du modèle du run distant (lue à l'exécution, jamais supposée). */
export interface RemoteRunVision {
  /** Référence `provider/modelId` effectivement résolue. */
  modelLabel: () => string;
  /** Le modèle accepte-t-il les images ? (`llm.light.vision`). */
  imagesSupported: () => boolean;
}

export interface RemoteRunToolPorts {
  /**
   * Conversation (canal) à laquelle rattacher les fichiers du run : elle est
   * FORCÉE sur `generer_image`, `lister_fichiers` et `lire_fichier`.
   */
  conversationId: string;
  /** Ports d'image (serveur ComfyUI). Absents ⇒ ni `generer_image` ni `consulter_workflow`. */
  images?: RemoteRunImagePorts;
  /** Port des fichiers de la conversation. Absent ⇒ ni `lister_fichiers` ni `lire_fichier`. */
  files?: FilesReadPort;
  /** Vision du modèle du run (transmise à `lire_fichier` pour dire la vérité). */
  vision?: RemoteRunVision;
  /**
   * Fichier produit par le run (image générée COPIÉE dans le store des fichiers).
   * ⚠️ C'est ce que l'adaptateur joint au message publié (`file_ids`) : sans ce
   * rappel, l'image existerait sans jamais arriver dans le canal.
   */
  onFileProduced?: (fileId: string) => void;
}

/**
 * Construit les outils d'un run distant.
 *
 * ⚠️ Aucun outil d'ACTION ici (`run_command`, `capturer_ecran`, transferts) et
 * aucun outil qui exige une approbation humaine : une approbation s'affiche
 * dans l'interface web et ne peut pas être donnée depuis un canal. La liste
 * exacte est `REMOTE_SAFE_TOOLS` (`src/llm/tool-policy.ts`), et elle est
 * VERROUILLÉE par un test.
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

  return tools;
}
