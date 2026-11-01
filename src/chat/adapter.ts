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

/**
 * FOURNISSEURS d'adaptateur, par plateforme.
 *
 * ⚠️ POURQUOI UN FOURNISSEUR ET PAS SEULEMENT UNE INSTANCE : un adaptateur distant a
 * besoin du stockage, du coffre et de la configuration du serveur ; les construire au
 * chargement du module obligerait à importer la moitié du programme ici. Le fournisseur
 * est enregistré au DÉMARRAGE (`src/index.ts`) et rend l'instance déjà câblée.
 */
const providers = new Map<ChatMode, () => ChatAdapter | null>();

/** Enregistre un adaptateur (remplace l'existant : redémarrage à chaud). */
export function registerAdapter(adapter: ChatAdapter): void {
  registry.set(adapter.platform, adapter);
}

/**
 * Enregistre un FOURNISSEUR d'adaptateur (construction paresseuse mais unique).
 * Une plateforme ainsi déclarée apparaît dans `listPlatforms()`. */
export function registerAdapterProvider(
  platform: ChatMode,
  provider: () => ChatAdapter | null,
): void {
  providers.set(platform, provider);
  registry.delete(platform);
}

/** Désenregistre une plateforme (tests : retour à l'état « non livrée »). */
export function unregisterAdapter(platform: ChatMode): void {
  registry.delete(platform);
  providers.delete(platform);
}

/**
 * Adaptateur d'une plateforme.
 *
 * @throws {ChatAdapterError} `unknown_platform` si aucune implémentation
 *   n'existe (au lot 1, Mattermost n'en a pas encore : c'est le lot 2).
 */
export function getAdapter(platform: string): ChatAdapter {
  const direct = registry.get(platform as ChatMode);
  if (direct) return direct;
  const provider = providers.get(platform as ChatMode);
  const built = provider?.() ?? null;
  if (built) return built;
  throw new ChatAdapterError(
    "unknown_platform",
    `Aucun adaptateur de discussion pour « ${platform} ».`,
  );
}

/** Plateformes RÉELLEMENT disponibles (instance ou fournisseur enregistré). */
export function listPlatforms(): ChatMode[] {
  return CHAT_MODES.filter((mode) => registry.has(mode) || providers.has(mode));
}

/**
 * Enregistrement des adaptateurs LIVRÉS.
 *
 * `local` et `discord` sont autonomes : ils n'ont besoin de rien. Mattermost est
 * enregistré par un FOURNISSEUR au démarrage du serveur (`src/index.ts`) : il lui faut
 * le miroir, le coffre et la configuration.
 */
registerAdapter(new LocalChatAdapter());
registerAdapter(new DiscordChatAdapter());
