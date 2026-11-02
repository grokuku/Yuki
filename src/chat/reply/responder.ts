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

import type { ChatQuoteAuthor, ChatReplyMode, ChatReplyStyle, RemoteMessage, RemotePlatform } from "../types.js";
import { isOwnMessage } from "../mirror/ingest.js";
import { auteurAffichable } from "../mirror/names.js";

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

/** Libellés français de la citation d'auteur (interface : clic droit sur un canal). */
export const QUOTE_AUTHOR_LABELS: Record<ChatQuoteAuthor, string> = {
  oui: "Citer l'auteur du message",
  non: "Ne pas citer l'auteur",
};

/** Nombre maximal de LIGNES reprises dans une citation (borne : jamais un pavé). */
export const REPLY_QUOTE_MAX_LINES = 3;

/** Nombre maximal de CARACTÈRES repris dans une citation (borne de coût et de bruit). */
export const REPLY_QUOTE_MAX_CHARS = 240;

/**
 * Caractères Markdown neutralisés dans une citation.
 *
 * ⚠️ Raison exacte : le texte cité vient d'un TIERS. Sans échappement, un message qui
 * contient `# titre`, `[texte](url)`, `**gras**` ou une clôture de bloc de code
 * changerait la FORME du message de Yuki. On rend donc le texte cité littéral, ligne
 * par ligne, dans un bloc `> …` — ce qui reste toujours rendu par Mattermost.
 */
const MARKDOWN_SIGNIFICANT = /[\\`*_{}[\]()#+!|<>~]/g;

/** Retire les caractères de contrôle (jamais de saut de ligne vertical dans une citation). */
function stripControlChars(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

/**
 * Neutralise un fragment de texte pour une citation Markdown.
 *
 * ⚠️ Les `@` reçoivent un espace de largeur nulle : sans cela, citer `@channel` ou
 * `@ici` RELANCERAIT une notification en citant un message — ce serait une injection
 * de mention, pas une citation.
 */
function escapeQuoted(text: string): string {
  return stripControlChars(text)
    .replace(MARKDOWN_SIGNIFICANT, (char) => `\\${char}`)
    .replace(/@/g, "@\u200B");
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

/**
 * Citation de l'auteur, en Markdown `>` (toujours rendu par Mattermost).
 *
 * Format : `> **@auteur** a écrit :` puis les premières lignes du message, bornées.
 *
 * @param options.maxLines nombre de lignes reprises (défaut `REPLY_QUOTE_MAX_LINES`).
 * @param options.maxChars longueur maximale (défaut `REPLY_QUOTE_MAX_CHARS`).
 */
export function quotePrefixOf(
  message: Pick<RemoteMessage, "author" | "text">,
  options: { maxLines?: number; maxChars?: number } = {},
): string {
  const maxLines = Math.max(1, options.maxLines ?? REPLY_QUOTE_MAX_LINES);
  const maxChars = Math.max(1, options.maxChars ?? REPLY_QUOTE_MAX_CHARS);
  const auteur = auteurAffichable(message.author);
  const lignes = stripControlChars(message.text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(0, maxLines);
  const corpsBrut = lignes.join("\n");
  const corps =
    corpsBrut.length > maxChars ? `${corpsBrut.slice(0, Math.max(1, maxChars - 1))}…` : corpsBrut;
  const entete = `> **@${escapeQuoted(auteur)}** a écrit :`;
  if (corps === "") return entete;
  const cite = corps
    .split("\n")
    .map((line) => `> ${escapeQuoted(line)}`)
    .join("\n");
  return `${entete}\n${cite}`;
}

/**
 * Compose le texte PUBLIÉ : citation (si demandée) puis réponse.
 *
 * ⚠️ `quoteAuthor = "non"` rend le texte EXACTEMENT tel quel — c'est le comportement
 * observé en production, et il ne change pas tant que l'utilisateur ne demande rien.
 */
export function composeReplyText(input: {
  text: string;
  message: Pick<RemoteMessage, "author" | "text">;
  quoteAuthor: ChatQuoteAuthor;
  maxLines?: number;
  maxChars?: number;
}): string {
  if (input.quoteAuthor !== "oui") return input.text;
  const prefixe = quotePrefixOf(input.message, {
    ...(input.maxLines !== undefined ? { maxLines: input.maxLines } : {}),
    ...(input.maxChars !== undefined ? { maxChars: input.maxChars } : {}),
  });
  const corps = input.text.trim();
  return corps === "" ? prefixe : `${prefixe}\n\n${corps}`;
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
