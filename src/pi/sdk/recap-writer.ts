/**
 * Écrivain de RÉCAPITULATIF côté SDK (confidentiel — `src/pi/sdk/**`).
 *
 * ⚠️ CHEMIN ISOLÉ : chaque récapitulatif ouvre une session ÉPHÉMÈRE EN MÉMOIRE
 * (`SessionManager.inMemory`, via `createEphemeralSession`) — exactement comme
 * l'extracteur de mémoire. Le prompt de récapitulation ne touche JAMAIS la
 * session de l'utilisateur : il n'apparaît donc ni dans son historique ni dans son
 * transcript. Aucun outil n'est exposé (le modèle ne fait que rédiger).
 */

import type { PiLogger, PiThinkingLevel } from "../types.js";
import { RECAP_SYSTEM_PROMPT, type RecapWriter } from "../../recap/index.js";
import { createSdkPromptWriter } from "./prompt-writer.js";

export interface SdkRecapWriterConfig {
  cwd: string;
  agentDir: string;
  authPath: string;
  modelsPath: string;
  /**
   * Référence `provider/modelId` utilisée pour le récapitulatif (ex. le LOURD).
   * Une FONCTION est relue à chaque appel ⇒ un changement de modèle (`apply: hot`)
   * s'applique sans redémarrage.
   */
  modelReference: string | (() => string);
  thinking: PiThinkingLevel | (() => PiThinkingLevel);
  /** Délai maximal d'un récapitulatif (ms), lu à chaud : au-delà, on interrompt. */
  timeoutMs: () => number;
  logger: PiLogger;
}

/**
 * Fabrique l'écrivain SDK : `prompt → réponse brute du modèle`.
 *
 * ⚠️ Lève si le modèle est introuvable ou si aucun texte n'a été produit : le
 * service de récapitulatif traduit cet échec en message HONNÊTE, et AUCUNE
 * conversation n'est créée (règle « tout ou rien »).
 */
export function createSdkRecapWriter(config: SdkRecapWriterConfig): RecapWriter {
  // ⚠️ MÊME chemin SDK que les autres usages (`createSdkPromptWriter`) : seule
  // l'identité change (prompt système, libellé des erreurs).
  return createSdkPromptWriter({
    cwd: config.cwd,
    agentDir: config.agentDir,
    authPath: config.authPath,
    modelsPath: config.modelsPath,
    systemPrompt: RECAP_SYSTEM_PROMPT,
    modelReference: config.modelReference,
    thinking: config.thinking,
    timeoutMs: config.timeoutMs,
    logger: config.logger,
    label: "récapitulatif",
  });
}
