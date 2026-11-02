/**
 * Types FILAIRES de Discord (lot 21) — REST v10 et Gateway v10.
 *
 * ⚠️ Ce fichier ne contient QUE la forme des charges utiles, telle que la documentent
 * les sources officielles (voir `docs/lot21-chat-discord.md`, section « Sources ») :
 *  - `resources/message.mdx` — objet Message, objet Attachment, `message_reference`,
 *    `GET /channels/{id}/messages` (ordre ANTÉCHRONOLOGIQUE, `limit` 1..100, `before` et
 *    `after` mutuellement exclusifs), `POST /channels/{id}/messages` ;
 *  - `resources/channel.mdx` — types de salons (0 texte, 5 annonces, 10/11/12 fils,
 *    4 catégorie…) et `parent_id` (catégorie pour un salon, SALON PARENT pour un fil) ;
 *  - `resources/guild.mdx` — `GET /guilds/{id}/channels` (⚠️ N'INCLUT PAS les fils) ;
 *  - `resources/user.mdx` — objet User, `GET /users/@me`, `GET /users/@me/guilds` ;
 *  - `resources/application.mdx` — `GET /applications/@me` et les drapeaux
 *    `GATEWAY_MESSAGE_CONTENT` (`1 << 18`) / `..._LIMITED` (`1 << 19`) qui disent si
 *    l'intent privilégié est activé ;
 *  - `events/gateway.mdx` + `events/gateway-events.mdx` — `HELLO` (`heartbeat_interval`),
 *    premier battement après `interval * jitter` (jitter ∈ [0,1]), `IDENTIFY`,
 *    `RESUME` (`session_id` + `seq`), `READY` (`resume_gateway_url`), `INVALID_SESSION` ;
 *  - `topics/opcodes-and-status-codes.mdx` — opcodes 0/1/2/6/7/9/10/11 et codes de
 *    fermeture (4004 jeton invalide, 4014 intent non autorisé : NE PAS reconnecter) ;
 *  - `topics/rate-limits.mdx` — en-têtes `X-RateLimit-*`, `429` + `retry_after` (secondes).
 *
 * ⚠️ Aucun de ces types ne porte de jeton : le jeton n'a PAS de type ici, il ne circule
 * que dans l'en-tête `Authorization` et dans les trames `IDENTIFY`/`RESUME`.
 */

/** Base de l'API REST (version 10, la seule non dépréciée avec la 9). */
export const DISCORD_API_BASE = "https://discord.com/api/v10";

/** URL de la passerelle, version et encodage EXPLICITES (doc : « it's a good idea »). */
export const DISCORD_GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

/**
 * Taille de page MAXIMALE de `GET /channels/{id}/messages`.
 *
 * ⚠️ Vérifié : `limit` va de 1 à 100 ; au-delà, Discord répond `400`. Contrairement à
 * Mattermost, la valeur n'est pas tronquée en silence — mais on ne la dépasse pas pour
 * autant : une page courte n'est PAS la preuve de la fin (des messages supprimés entre
 * deux appels suffisent), donc le client continue jusqu'à une page VIDE.
 */
export const DISCORD_MAX_PAGE = 100;

/** Espacement minimal entre deux requêtes REST (garde-fou de débit, 1 req / 250 ms). */
export const DISCORD_MIN_REQUEST_INTERVAL_MS = 250;

/** Nombre maximal de tentatives après un `429` (le `retry_after` est RESPECTÉ). */
export const DISCORD_MAX_RETRIES = 4;

/** Durée pendant laquelle le statut reste « ralenti » après un `429`. */
export const DISCORD_SLOW_WINDOW_MS = 60_000;

/**
 * Borne d'ENVOI par fichier, appliquée AVANT tout appel réseau (défaut 8 Mio).
 *
 * ⚠️ La limite documentée de Discord est plus haute : **20 Mio par fichier** par défaut
 * (`reference.mdx` → « Uploading Files »), davantage selon le boost du serveur, et la
 * taille MAXIMALE d'une requête de message est **25 Mio**. On choisit volontairement plus
 * BAS par défaut (une image générée dépasse rarement 8 Mio, et un envoi raté coûte une
 * réponse perdue) ; le réglage `chat.discord.maxUploadBytes` permet de monter jusqu'à
 * 25 Mio, jamais au-delà (`DISCORD_MAX_UPLOAD_CEILING`).
 */
export const DISCORD_MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/** Plafond ABSOLU de la taille d'une requête de message (doc : « 25 MiB »). */
export const DISCORD_MAX_UPLOAD_CEILING = 25 * 1024 * 1024;

/**
 * Taille maximale d'une pièce jointe TÉLÉCHARGÉE (20 Mio).
 *
 * ⚠️ Bornée comme pour Mattermost : on ne charge pas 25 Mio en mémoire pour les donner à
 * un modèle de vision qui n'en verrait qu'une vignette. La politique de vision partagée
 * (`src/files/vision.ts`) borne ensuite ce qui part réellement au modèle.
 */
export const DISCORD_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

/** Longueur maximale d'un `content` de message (doc : « up to 2000 characters »). */
export const DISCORD_MAX_CONTENT_CHARS = 2_000;

/** Hôtes autorisés pour le téléchargement d'une pièce jointe (jamais un tiers). */
export const DISCORD_CDN_HOSTS: readonly string[] = [
  "cdn.discordapp.com",
  "media.discordapp.net",
];

/**
 * INTENTS demandés à l'`IDENTIFY`.
 *
 *  - `GUILDS` (`1 << 0`) : création/mise à jour des salons — NON privilégié ;
 *  - `GUILD_MESSAGES` (`1 << 9`) : `MESSAGE_CREATE`/`UPDATE`/`DELETE` des serveurs —
 *    NON privilégié ;
 *  - `MESSAGE_CONTENT` (`1 << 15`) : ⚠️ **PRIVILÉGIÉ**. Sans lui, `content`,
 *    `attachments`, `embeds` et `components` arrivent **VIDES** (sauf mention du bot,
 *    message privé, ou message du bot lui-même). Il doit être activé dans le PORTAIL
 *    DÉVELOPPEUR, sinon l'`IDENTIFY` est refusé par la fermeture `4014`.
 */
export const DISCORD_INTENT_GUILDS = 1 << 0;
export const DISCORD_INTENT_GUILD_MESSAGES = 1 << 9;
export const DISCORD_INTENT_MESSAGE_CONTENT = 1 << 15;

/** Intents NON privilégiés (toujours demandés). */
export const DISCORD_INTENTS_STANDARD = DISCORD_INTENT_GUILDS | DISCORD_INTENT_GUILD_MESSAGES;

/** Intents demandés quand l'intent privilégié est censé être activé. */
export const DISCORD_INTENTS_WITH_CONTENT =
  DISCORD_INTENTS_STANDARD | DISCORD_INTENT_MESSAGE_CONTENT;

/** Drapeaux de l'application qui disent si `MESSAGE_CONTENT` est activé. */
export const DISCORD_APP_FLAG_MESSAGE_CONTENT = 1 << 18;
export const DISCORD_APP_FLAG_MESSAGE_CONTENT_LIMITED = 1 << 19;

/** Types de salons qui sont des CONVERSATIONS (un fil n'en est pas une). */
export const DISCORD_TEXT_CHANNEL_TYPE = 0;
export const DISCORD_ANNOUNCEMENT_CHANNEL_TYPE = 5;
export const DISCORD_CATEGORY_CHANNEL_TYPE = 4;

/** Types de FILS : leur `parent_id` est le salon parent, jamais une conversation. */
export const DISCORD_THREAD_CHANNEL_TYPES: readonly number[] = [10, 11, 12];

/** Époque des flocons de neige Discord (2015-01-01), en millisecondes. */
export const DISCORD_EPOCH_MS = 1_420_070_400_000;

/** Un utilisateur Discord (champs utilisés seulement). */
export interface DiscordUser {
  id: string;
  username?: string;
  /** Nom d'affichage global (« global_name »), souvent absent. */
  global_name?: string | null;
  /** `true` pour une application/bot. */
  bot?: boolean;
}

/** Une guilde partielle (`GET /users/@me/guilds`). */
export interface DiscordGuild {
  id: string;
  name?: string;
}

/** Un salon (`GET /guilds/{id}/channels`). */
export interface DiscordChannel {
  id: string;
  /** 0 texte, 5 annonces, 4 catégorie, 10/11/12 fil, 2 vocal, 15 forum… */
  type?: number;
  name?: string;
  guild_id?: string;
  /** Catégorie (salon) ou SALON PARENT (fil). */
  parent_id?: string | null;
  position?: number;
  /** Dernier message du salon (flocon), quand il est fourni. */
  last_message_id?: string | null;
}

/** Une pièce jointe (objet Attachment). */
export interface DiscordAttachment {
  id: string;
  filename?: string;
  content_type?: string;
  size?: number;
  /** URL de contenu, SIGNÉE et EXPIRANTE (à ne pas conserver indéfiniment). */
  url?: string;
  proxy_url?: string;
}

/** Référence à un message (réponse). */
export interface DiscordMessageReference {
  message_id?: string;
  channel_id?: string;
  guild_id?: string;
  /** `false` : si le message référencé n'existe plus, on envoie quand même. */
  fail_if_not_exists?: boolean;
}

/** Un message Discord (champs utilisés seulement). */
export interface DiscordMessage {
  id: string;
  channel_id: string;
  /** ⚠️ VIDE sans l'intent `MESSAGE_CONTENT` (sauf mention/DM/message du bot). */
  content?: string;
  author?: DiscordUser;
  /** Instant d'envoi (ISO8601 fourni par Discord, jamais deviné). */
  timestamp?: string;
  /** Instant de la dernière édition (ISO8601), ou `null`. */
  edited_timestamp?: string | null;
  attachments?: DiscordAttachment[];
  message_reference?: DiscordMessageReference;
  /** Type de message : `0` = DEFAULT, `19` = réponse, `7` = arrivée… */
  type?: number;
  /** Type du SALON (champ supplémentaire des événements `MESSAGE_CREATE`). */
  channel_type?: number;
  guild_id?: string;
  webhook_id?: string;
}

/** Application de l'utilisateur courant (`GET /applications/@me`). */
export interface DiscordApplication {
  id: string;
  name?: string;
  /** Champ `flags` (chaîne décimale dans l'API, parfois nombre). */
  flags?: number | string;
  bot_public?: boolean;
}

/** Charge utile de la passerelle (enveloppe commune). */
export interface DiscordGatewayPayload {
  op: number;
  d?: unknown;
  /** Numéro de séquence — `null` quand `op != 0`. */
  s?: number | null;
  /** Nom de l'événement — `null` quand `op != 0`. */
  t?: string | null;
}

/** Objet `READY` (sous-ensemble utile : session et URL de reprise). */
export interface DiscordReadyPayload {
  session_id?: string;
  resume_gateway_url?: string;
  user?: DiscordUser;
  v?: number;
}

/** Événement normalisé par le socket : l'appelant ne voit jamais la trame brute. */
export type DiscordMessageEventKind = "MESSAGE_CREATE" | "MESSAGE_UPDATE" | "MESSAGE_DELETE";

export interface DiscordMessageEvent {
  kind: DiscordMessageEventKind;
  /** Le message (partiel pour `MESSAGE_DELETE` : `id` + `channel_id`). */
  message: DiscordMessage;
}

/** Message lisible d'une valeur inconnue (jamais un objet sérialisé en vrac). */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Horodatage d'un flocon de neige (ms Unix), ou `undefined` si ce n'en est pas un. */
export function timestampOfSnowflake(snowflake: string): number | undefined {
  if (typeof snowflake !== "string" || !/^\d{1,20}$/.test(snowflake)) return undefined;
  try {
    return Number(BigInt(snowflake) >> 22n) + DISCORD_EPOCH_MS;
  } catch {
    return undefined;
  }
}

/** Flocon synthétique pour un instant (ms Unix) — utilisé pour borner une fenêtre. */
export function snowflakeOfTimestamp(ms: number): string {
  const value = BigInt(Math.max(0, Math.trunc(ms) - DISCORD_EPOCH_MS)) << 22n;
  return value.toString();
}

/** `true` si la valeur a la forme d'un message exploitable. */
export function isDiscordMessage(value: unknown): value is DiscordMessage {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { id?: unknown; channel_id?: unknown };
  return (
    typeof candidate.id === "string" &&
    candidate.id !== "" &&
    typeof candidate.channel_id === "string" &&
    candidate.channel_id !== ""
  );
}

/** `true` si ce type de salon est une CONVERSATION (fil exclu). */
export function isConversationChannelType(type: number | undefined): boolean {
  return type === DISCORD_TEXT_CHANNEL_TYPE || type === DISCORD_ANNOUNCEMENT_CHANNEL_TYPE;
}

/** `true` si ce type de salon est un FIL (⇒ `threadRootId`, pas une conversation). */
export function isThreadChannelType(type: number | undefined): boolean {
  return type !== undefined && DISCORD_THREAD_CHANNEL_TYPES.includes(type);
}
