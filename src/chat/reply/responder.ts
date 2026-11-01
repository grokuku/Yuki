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

import type { ChatReplyMode, RemoteMessage } from "../types.js";
import { isOwnMessage } from "../mirror/ingest.js";

/**
 * Mode de réponse par DÉFAUT quand le canal n'en a pas choisi.
 *
 * ⚠️ `mention` et pas `tout` : c'est le défaut le plus PRUDENT qui laisse le canal
 * utilisable (on peut parler à Yuki sans qu'elle réponde à tout le monde). Le choix
 * se fait ensuite par clic droit sur le canal.
 */
export const DEFAULT_REPLY_MODE: ChatReplyMode = "mention";

/** Libellés français des modes (interface : clic droit sur un canal). */
export const REPLY_MODE_LABELS: Record<ChatReplyMode, string> = {
  tout: "Répondre à tous les messages",
  auto: "Répondre quand on s'adresse à Yuki (jugé par le modèle)",
  mention: "Répondre seulement si Yuki est citée",
};

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
 * ⚠️ L'ordre importe : l'anti-boucle est évalué AVANT le mode. Un message du bot
 * ne sera donc jamais jugé (borne n°1) ni renvoyé, même en mode `tout`.
 */
export async function decideReply(input: DecideReplyInput): Promise<ReplyDecision> {
  const { message, replyMode } = input;
  // 1. ANTI-BOUCLE — prime sur tout le reste.
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
