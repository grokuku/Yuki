/**
 * Extension SDK : consigne d'ACCUSÉ DE RÉCEPTION (le modèle écrit son propre
 * accusé, au lieu d'un texte figé par le code).
 *
 * Enregistrée INLINE via `extensionFactories`. À CHAQUE tour (`before_agent_start`),
 * elle AJOUTE `ACK_RULE` au PROMPT SYSTÈME du tour — mécanisme NON PERSISTÉ : on
 * augmente seulement `systemPrompt` (« Replace the system prompt for this turn »),
 * JAMAIS `message` (qui créerait une entrée de session persistée). La consigne
 * n'entre donc ni dans le transcript, ni dans la mémoire, ni dans le snapshot.
 *
 * ⚠️ POURQUOI ELLE EXISTE : l'accusé était une phrase EN DUR (« C'est parti. »,
 * « Je m'en occupe. »), toujours la même — mécanique et répétitive. Le texte vient
 * désormais du PREMIER message du tour ; sans cette consigne, le modèle appelle
 * l'outil sans rien dire et le repli parle à sa place.
 *
 * ⚠️ Elle est enregistrée INCONDITIONNELLEMENT (même sans délégation) : la
 * génération d'image et l'envoi de commande sont aussi des actions longues, et le
 * ton de Yuki ne dépend d'aucune capacité activée.
 */

import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";

import { ACK_RULE } from "../ack.js";

/** Nom d'extension (utilisé par les tests d'ordre d'injection). */
export const ACK_EXTENSION_NAME = "yuki-ack";

/**
 * Construit la fabrique d'extension de l'accusé de réception. Aucun état, aucune
 * E/S : la consigne est une constante.
 */
export function createAckExtensionFactory(): InlineExtension {
  return {
    name: ACK_EXTENSION_NAME,
    hidden: true,
    factory: (pi: ExtensionAPI) => {
      pi.on("before_agent_start", (event) => ({
        systemPrompt: `${event.systemPrompt}\n\n${ACK_RULE}`,
      }));
    },
  };
}
