/**
 * DÉCISION de répondre sur un canal distant (lot 18, lot 2).
 *
 * Trois modes, PAR CANAL (`ChatReplyMode`) :
 *  - `tout`    → Yuki répond à CHAQUE message HUMAIN ;
 *  - `mention` → elle ne répond que si elle est CITÉE (`@Yuki`, `@<pseudo du bot>`,
 *                ou son identifiant) — détection EXPLICITE, jamais une heuristique
 *                de texte (« est-ce que ça a l'air adressé à Yuki ? » n'existe pas) ;
 *  - `auto`    → un appel modèle LÉGER juge si le message lui est adressé.
 *
 * ⚠️ ANTI-BOUCLE (la règle qui prime sur les trois autres) : un message dont
 * l'auteur est `botUserId` — ou déjà classé `assistant` — ne déclenche JAMAIS de
 * réponse, quel que soit le mode. Sans cela, Yuki répondrait à ses propres réponses
 * et le canal boucherait à l'infini.
 *
 * ⚠️ BORNES DU JUGE (`auto`) :
 *  1. jamais sur un message du bot ;
 *  2. jamais deux fois pour le même identifiant de message (`dejaJuge`) ;
 *  3. jamais si le canal n'est PAS en `auto` (le juge n'est même pas appelé).
 */

import type {
  ChatQuoteAuthor,
  ChatReplyMode,
  ChatReplyStyle,
  RemoteAuthor,
  RemoteMessage,
  RemotePlatform,
} from "../types.js";
import { isOwnMessage } from "../mirror/ingest.js";

/**
 * Mode de réponse par DÉFAUT quand le canal n'en a pas choisi.
 *
 * ⚠️ `mention` et pas `tout` : c'est le défaut le plus PRUDENT qui laisse le canal
 * utilisable (on peut parler à Yuki sans qu'elle réponde à tout le monde). Le choix
 * se fait ensuite par clic droit sur le canal.
 */
export const DEFAULT_REPLY_MODE: ChatReplyMode = "mention";

/**
 * Défaut de `replyMode` PAR PLATEFORME.
 *
 * ⚠️ Discord est explicitement à `mention` (décision du lot 21) : un bot dans un serveur
 * ACTIF qui répondrait à tous les messages y serait insupportable — et Discord n'a pas
 * de « fil par défaut » : chaque réponse non sollicitée crée un bruit visible par tout le
 * serveur. Mattermost garde son défaut du lot 18 (`DEFAULT_REPLY_MODE`).
 *
 * ⚠️ Le défaut est RÉSOLU PAR PLATEFORME, et non écrit en dur dans chaque adaptateur :
 * c'est ce qui permet aux deux valeurs de diverger (elles sont d'ailleurs IDENTIQUES
 * aujourd'hui — la structure existe pour que le jour où l'une change, l'autre ne suive pas
 * par accident).
 */
export const DEFAULT_REPLY_MODE_BY_PLATFORM: Readonly<Record<RemotePlatform, ChatReplyMode>> = {
  mattermost: DEFAULT_REPLY_MODE,
  discord: "mention",
};

/** Défaut EFFECTIF de `replyMode` pour une plateforme (jamais `undefined`). */
export function defaultReplyModeFor(platform: RemotePlatform): ChatReplyMode {
  return DEFAULT_REPLY_MODE_BY_PLATFORM[platform] ?? DEFAULT_REPLY_MODE;
}

/** Libellés français des modes (interface : clic droit sur un canal). */
export const REPLY_MODE_LABELS: Record<ChatReplyMode, string> = {
  tout: "Répondre à tous les messages",
  auto: "Répondre quand on s'adresse à Yuki (jugé par le modèle)",
  mention: "Répondre seulement si Yuki est citée",
};

/** Libellés français des styles de réponse (interface : clic droit sur un canal). */
export const REPLY_STYLE_LABELS: Record<ChatReplyStyle, string> = {
  fil: "Réponse dans le fil",
  nouveau: "Nouveau message (à la racine du canal)",
};

/** Libellés français de la mention d'auteur (interface : clic droit sur un canal). */
export const QUOTE_AUTHOR_LABELS: Record<ChatQuoteAuthor, string> = {
  oui: "Mentionner l'auteur du message (il est notifié)",
  non: "Ne mentionner personne",
};

/**
 * Longueur maximale du préfixe ajouté : une MENTION, jamais une citation.
 *
 * ⚠️ Le préfixe le plus long possible est `<@` + un identifiant Discord + `>` (22
 * caractères) ou `@` + un pseudo Mattermost (22 caractères au plus, règle serveur) :
 * 32 laisse une marge sans jamais laisser passer un pavé. C'est cette borne qui
 * remplace les 240 caractères de l'ancienne citation de texte.
 */
export const REPLY_MENTION_MAX_CHARS = 32;

/**
 * Pseudo Mattermost valide (documentation : 3 à 22 caractères, commence par une lettre,
 * minuscules, chiffres et `.` `-` `_`).
 *
 * ⚠️ Un pseudo qui n'entre pas dans ce motif n'est PAS mentionné : Mattermost ne
 * notifie que sur le **pseudo** (un surnom ou un nom complet tapé après `@` ne
 * déclenche aucune notification, cf. doc « Manage your Mattermost profile »).
 */
const MATTERMOST_USERNAME = /^[a-z][a-z0-9._-]{2,21}$/;

/** Identifiant Discord (« snowflake ») : uniquement des chiffres. */
const DISCORD_SNOWFLAKE = /^\d{5,25}$/;

/**
 * Mots qu'une mention Mattermost ne doit JAMAIS produire.
 *
 * ⚠️ `@channel`, `@all` et `@here` notifient TOUT LE CANAL (documentation Mattermost,
 * « Mention people in messages ») : un auteur dont le pseudo serait l'un de ces mots
 * transformerait une réponse en notification de masse.
 */
const MASS_MENTION_WORDS: ReadonlySet<string> = new Set(["channel", "all", "here"]);

/** Plateforme d'une conversation miroir (`mm-…` / `dc-…`), ou `undefined`. */
function platformOfConversationId(conversationId: string | undefined): RemotePlatform | undefined {
  if (typeof conversationId !== "string") return undefined;
  if (conversationId.startsWith("mm-")) return "mattermost";
  if (conversationId.startsWith("dc-")) return "discord";
  return undefined;
}

/**
 * Message d'ORIGINE auquel une réponse doit se rattacher : `undefined` (= racine du
 * canal) ou l'identifiant de la RACINE du fil.
 *
 * ⚠️ Deux pièges traités ici :
 *  1. `nouveau` ⇒ **aucun** `root_id`, même si le message d'origine est dans un fil ;
 *  2. `fil` ⇒ la RACINE (`threadRootId`), **jamais le message lui-même** : répondre à
 *     une réponse de fil avec `root_id` = ce message créerait un fil IMBRIQUÉ, que
 *     Mattermost n'affiche pas comme une réponse du fil d'origine.
 */
export function rootIdForReply(input: {
  replyStyle: ChatReplyStyle;
  message: Pick<RemoteMessage, "remoteId" | "threadRootId">;
}): string | undefined {
  if (input.replyStyle === "nouveau") return undefined;
  const root = input.message.threadRootId;
  return root !== undefined && root !== "" ? root : input.message.remoteId;
}

/** Mention native d'un auteur, telle qu'une plateforme la comprend. */
export interface AuthorMention {
  /** Forme EXACTE à écrire dans le message (`@pseudo` ou `<@identifiant>`). */
  mention: string;
  /**
   * Identifiants dont la mention est AUTORISÉE par la plateforme.
   *
   * ⚠️ Discord neutralise les mentions d'un message de bot par défaut
   * (`allowed_mentions: { parse: [] }`, cf. `src/chat/discord/client.ts`) : sans cette
   * liste, `<@identifiant>` s'afficherait sans notifier personne.
   */
  userIds: readonly string[];
}

/** Message PRÊT à publier : son texte et les mentions qu'il est autorisé à déclencher. */
export interface ComposedReply {
  text: string;
  /** Vide quand aucune mention n'est posée (ou hors Discord). */
  mentionUserIds: readonly string[];
}

/**
 * MENTION NATIVE de l'auteur d'un message — celle qui **notifie** la personne.
 *
 * ⚠️ Décision utilisateur du 2026-11-02 : « je veux la version qui notifie ». Le réglage
 * `quoteAuthor` ne cite donc PLUS le texte du message d'origine (la plateforme affiche
 * déjà cette citation, la redoubler était du bruit) : il pose une mention, en tête.
 *
 *  - **Mattermost** : `@pseudo` (le PSEUDO, en minuscules). Source : documentation
 *    Mattermost « Mention people in messages » — « mention a teammate by using the @
 *    symbol plus their username to send them a mention notification ». Un surnom ou un
 *    nom complet ne notifie pas (doc « Manage your Mattermost profile »).
 *  - **Discord** : `<@identifiant>` (forme moderne ; `<@!identifiant>` est l'ancienne
 *    forme de pseudo de serveur, dépréciée). Source : documentation Discord sur les
 *    mentions — « User mention: `<@USER_ID>` ». ⚠️ Notre client neutralise les mentions
 *    par défaut (`allowed_mentions: { parse: [] }`) : l'identifiant rendu ici doit être
 *    AUTORISÉ par l'appelant (`mentionUserIds`), sinon `<@id>` s'affiche sans notifier.
 *
 * Rend `undefined` quand aucune mention SÛRE n'est possible :
 *  - auteur ROBOT (dont Yuki elle-même) : la mentionner créerait une notification
 *    circulaire (et, pour Yuki, une boucle de notification) ;
 *  - nom qui n'est pas un pseudo valide (forme courte d'un auteur non résolu, surnom
 *    avec espaces…) : une mention qui ne résout personne n'apporte rien ;
 *  - pseudo de masse (`channel`, `all`, `here`) : jamais une notification de canal ;
 *  - identifiant Discord non numérique : la forme `<@…>` serait affichée brute.
 */
export function mentionOfAuthor(input: {
  author: Pick<RemoteAuthor, "id" | "nom"> & { estBot?: boolean };
  platform: RemotePlatform;
  /** Identifiant du bot : sa propre mention est TOUJOURS refusée. */
  botUserId?: string;
}): AuthorMention | undefined {
  const id = typeof input.author.id === "string" ? input.author.id.trim() : "";
  if (input.author.estBot === true) return undefined;
  if (input.botUserId !== undefined && input.botUserId !== "" && id === input.botUserId) {
    return undefined;
  }
  if (input.platform === "discord") {
    if (!DISCORD_SNOWFLAKE.test(id)) return undefined;
    const mention = `<@${id}>`;
    if (mention.length > REPLY_MENTION_MAX_CHARS) return undefined;
    return { mention, userIds: [id] };
  }
  const brut = typeof input.author.nom === "string" ? input.author.nom.trim() : "";
  const pseudo = brut.toLowerCase();
  if (!MATTERMOST_USERNAME.test(pseudo)) return undefined;
  if (MASS_MENTION_WORDS.has(pseudo)) return undefined;
  const mention = `@${pseudo}`;
  if (mention.length > REPLY_MENTION_MAX_CHARS) return undefined;
  return { mention, userIds: [] };
}

/**
 * Compose le message PUBLIÉ : mention de l'auteur (si demandée) puis le texte de Yuki.
 *
 * ⚠️ `quoteAuthor = "non"` rend le texte EXACTEMENT tel quel (comportement par défaut).
 * ⚠️ `mentionUserIds` n'est PAS décoratif : chez Discord, le client neutralise les
 * mentions par défaut ; c'est cette liste qui autorise la SEULE personne mentionnée
 * (jamais `@everyone`, jamais un rôle).
 *
 * ⚠️ LIMITE ASSUMÉE : une mention identifie une PERSONNE, pas un message. Deux messages
 * simultanés de la même personne ne sont plus distingués par le préfixe — ce sont
 * `root_id` (Mattermost) et `message_reference` (Discord) qui portent l'ancrage.
 */
export function composeReply(input: {
  text: string;
  message: Pick<RemoteMessage, "author"> & { conversationId?: string };
  quoteAuthor: ChatQuoteAuthor;
  /** Plateforme de la conversation (sinon déduite de `conversationId`). */
  platform?: RemotePlatform;
  botUserId?: string;
}): ComposedReply {
  if (input.quoteAuthor !== "oui") return { text: input.text, mentionUserIds: [] };
  const platform = input.platform ?? platformOfConversationId(input.message.conversationId);
  if (platform === undefined) return { text: input.text, mentionUserIds: [] };
  const mention = mentionOfAuthor({
    author: input.message.author,
    platform,
    ...(input.botUserId !== undefined ? { botUserId: input.botUserId } : {}),
  });
  if (mention === undefined) return { text: input.text, mentionUserIds: [] };
  const corps = input.text.trim();
  return {
    text: corps === "" ? mention.mention : `${mention.mention}\n\n${corps}`,
    mentionUserIds: mention.userIds,
  };
}

/** Juge `auto` : rend `true` si le message s'adresse à Yuki. */
export type ChatReplyJudge = (input: {
  message: RemoteMessage;
  channelTitle: string;
}) => Promise<boolean>;

/** Décision rendue : un booléen ET sa raison (jamais un booléen nu). */
export interface ReplyDecision {
  repondre: boolean;
  /** Code STABLE de la raison (`auteur_bot`, `mention`, `juge`, …). */
  raison: ReplyReason;
  /** Phrase lisible en français, affichable dans un statut ou un journal. */
  detail: string;
}

/** Raisons possibles d'une décision (codes stables). */
export type ReplyReason =
  | "auteur_bot"
  | "message_supprime"
  | "mode_tout"
  | "mention"
  | "pas_de_mention"
  | "juge_oui"
  | "juge_non"
  | "juge_indisponible"
  | "deja_juge";

/**
 * Échappe une chaîne pour l'utiliser dans une expression régulière.
 * (Une citation contient souvent des caractères spéciaux : `@yuki.dev` par ex.)
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `true` si le texte CITE le bot.
 *
 * ⚠️ Détection EXPLICITE, pas une heuristique : on cherche les alias fournis
 * (`@yuki`, `@<username>`, l'identifiant du bot) avec une FRONTIÈRE de mot, pour
 * qu'un `@yukiko` ne déclenche pas Yuki et qu'une adresse e-mail ne compte pas.
 * Aucune autre règle (« la question est au bout », « il y a un point
 * d'interrogation »…) n'entre ici : c'est justement ce que fait le mode `auto`.
 */
export function isBotMentioned(text: string, aliases: readonly string[]): boolean {
  if (typeof text !== "string" || text.trim() === "") return false;
  for (const alias of aliases) {
    const needle = alias.trim();
    if (needle === "" || needle === "@") continue;
    // ⚠️ La frontière GAUCHE exclut les caractères de mot et `/` : `contact@yuki.fr` ou
    // `https://x/yuki` ne citent personne. En revanche `@` est AUTORISÉ devant, pour que
    // la forme de mention brute (`<@identifiant>`) soit reconnue.
    const pattern = new RegExp(`(^|[^\\w/])${escapeRegExp(needle)}(?![\\w-])`, "iu");
    if (pattern.test(text)) return true;
  }
  return false;
}

/**
 * Alias de citation d'un bot, dédupliqués et non vides.
 *
 * ⚠️ On ne retient QUE les formes EXPLICITES : `@<username>`, `@<nom affiché>` et
 * l'identifiant brut du bot. Un pseudo NU (« yuki ») n'est PAS un alias : il
 * apparaîtrait dans une phrase qui ne cite personne, et la détection deviendrait une
 * heuristique — précisément ce qu'on refuse.
 */
export function botAliases(input: {
  botUserId?: string;
  botUsername?: string;
  displayName?: string;
}): string[] {
  const out = new Set<string>();
  const addAt = (value: string | undefined) => {
    const trimmed = value?.trim();
    if (!trimmed) return;
    const bare = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
    if (bare === "") return;
    out.add(`@${bare}`);
  };
  addAt(input.botUsername);
  addAt(input.displayName);
  // L'identifiant brut (26 caractères alphanumériques chez Mattermost) est un alias
  // légitime : on le cherche aussi, sans `@`.
  const id = input.botUserId?.trim();
  if (id !== undefined && id !== "") out.add(id);
  return [...out];
}

export interface DecideReplyInput {
  message: RemoteMessage;
  /** Mode de réponse EFFECTIF du canal (`replyMode` persisté ou défaut). */
  replyMode: ChatReplyMode;
  /** Identifiant du bot (Yuki). */
  botUserId?: string;
  /** Alias de citation (`@yuki`, `@<username>`, identifiant). */
  aliases: readonly string[];
  /** Titre du canal (transmis au juge pour le contexte). */
  channelTitle?: string;
  /** Juge `auto` (`undefined` ⇒ mode `auto` INDISPONIBLE, décision explicite). */
  judge?: ChatReplyJudge;
  /** `true` si ce message a DÉJÀ été jugé (borne n°2 : jamais deux fois). */
  dejaJuge?: (remoteId: string) => boolean;
}

/**
 * Décide si Yuki répond à un message.
 *
 * ⚠️ L'ordre importe : l'anti-boucle est évaluée AVANT le mode. Un message de robot
 * — Yuki ou n'importe quel AUTRE bot — ne sera donc jamais jugé (borne n°1) ni renvoyé,
 * même en mode `tout`. Sans le premier test, deux bots se répondraient indéfiniment.
 */
export async function decideReply(input: DecideReplyInput): Promise<ReplyDecision> {
  const { message, replyMode } = input;
  // 0. ANTI-BOUCLE — un ROBOT, QUEL QU'IL SOIT, ne reçoit jamais de réponse.
  // ⚠️ `estBot` est calculé à l'ingestion (`src/chat/mirror/ingest.ts`) : il couvre
  // `author.bot` chez Discord (un AUTRE bot) et l'identifiant du bot de Yuki. Le cas
  // « Yuki elle-même » est ainsi déjà couvert ici ; `isOwnMessage` reste en second filet
  // pour un message ingéré AVANT que le miroir ne connaisse l'identifiant du bot.
  if (message.author.estBot === true) {
    return {
      repondre: false,
      raison: "auteur_bot",
      detail: "Message envoyé par un robot : aucune réponse (anti-boucle).",
    };
  }
  // 1. ANTI-BOUCLE (second filet) — Yuki elle-même, quand `estBot` n'a pas pu être posé.
  if (isOwnMessage(message, input.botUserId)) {
    return {
      repondre: false,
      raison: "auteur_bot",
      detail: "Message envoyé par Yuki elle-même : aucune réponse (anti-boucle).",
    };
  }
  if (message.deleted === true) {
    return {
      repondre: false,
      raison: "message_supprime",
      detail: "Message supprimé chez la plateforme : aucune réponse.",
    };
  }
  if (replyMode === "tout") {
    return {
      repondre: true,
      raison: "mode_tout",
      detail: "Mode « répondre à tous les messages » : Yuki répond.",
    };
  }
  if (replyMode === "mention") {
    const cited = isBotMentioned(message.text, input.aliases);
    return cited
      ? { repondre: true, raison: "mention", detail: "Yuki est citée dans le message." }
      : {
          repondre: false,
          raison: "pas_de_mention",
          detail: "Yuki n'est pas citée : aucune réponse (mode « mention »).",
        };
  }
  // 2. Mode `auto` : le juge tranche, une seule fois par message.
  if (input.dejaJuge?.(message.remoteId) === true) {
    return {
      repondre: false,
      raison: "deja_juge",
      detail: "Ce message a déjà été jugé : pas de second jugement.",
    };
  }
  if (!input.judge) {
    return {
      repondre: false,
      raison: "juge_indisponible",
      detail:
        "Le modèle qui juge les messages (mode « auto ») n'est pas disponible : " +
        "aucune réponse n'est envoyée plutôt que de répondre au hasard.",
    };
  }
  const repondre = await input.judge({
    message,
    channelTitle: input.channelTitle ?? "",
  });
  return repondre
    ? { repondre: true, raison: "juge_oui", detail: "Le message s'adresse à Yuki." }
    : { repondre: false, raison: "juge_non", detail: "Le message ne s'adresse pas à Yuki." };
}
