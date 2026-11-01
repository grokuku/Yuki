/**
 * Registre des ADAPTATEURS de discussion (lot 18).
 *
 * Rôle unique : associer une plateforme à SON adaptateur. Aucune logique de
 * synchronisation, aucun stockage, aucune I/O : c'est le point d'entrée que le
 * reste du programme interroge (`getAdapter`, `listPlatforms`).
 *
 * ⚠️ Les adaptateurs LIVRÉS sont enregistrés à l'import du module (local,
 * discord) pour que `getAdapter` fonctionne sans cérémonie d'initialisation.
 * Une plateforme NON enregistrée lève `ChatAdapterError` (`unknown_platform`) :
 * jamais un `undefined` silencieux qui planterait trois appels plus loin.
 */

import { DiscordChatAdapter } from "./discord/adapter.js";
import { LocalChatAdapter } from "./local-adapter.js";
import { CHAT_MODES, type ChatAdapter, type ChatMode } from "./types.js";

export type ChatAdapterErrorCode = "unknown_platform" | "already_registered";

/** Erreur du registre : porte un CODE stable (jamais un message à parser). */
export class ChatAdapterError extends Error {
  override readonly name = "ChatAdapterError";
  constructor(
    readonly code: ChatAdapterErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Adaptateurs connus, par plateforme. */
const registry = new Map<ChatMode, ChatAdapter>();

/** Enregistre un adaptateur (remplace l'existant : redémarrage à chaud). */
export function registerAdapter(adapter: ChatAdapter): void {
  registry.set(adapter.platform, adapter);
}

/**
 * Adaptateur d'une plateforme.
 *
 * @throws {ChatAdapterError} `unknown_platform` si aucune implémentation
 *   n'existe (au lot 1, Mattermost n'en a pas encore : c'est le lot 2).
 */
export function getAdapter(platform: string): ChatAdapter {
  const adapter = registry.get(platform as ChatMode);
  if (!adapter) {
    throw new ChatAdapterError(
      "unknown_platform",
      `Aucun adaptateur de discussion pour « ${platform} ».`,
    );
  }
  return adapter;
}

/** Plateformes RÉELLEMENT enregistrées, dans l'ordre de `CHAT_MODES`. */
export function listPlatforms(): ChatMode[] {
  return CHAT_MODES.filter((mode) => registry.has(mode));
}

/**
 * Enregistrement des adaptateurs LIVRÉS.
 *
 * ⚠️ Mattermost n'est PAS enregistré au lot 1 (aucun client) : le service de
 * discussion rend alors un statut `off` explicite au lieu d'inventer une
 * connexion.
 */
registerAdapter(new LocalChatAdapter());
registerAdapter(new DiscordChatAdapter());
