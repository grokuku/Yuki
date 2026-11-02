/**
 * Prompts du canal distant (lot 18, lot 2).
 *
 * Deux usages, deux prompts SYSTEME distincts :
 *  1. le JUGE du mode `auto` — il ne rédige rien, il répond `oui` ou `non` à une seule
 *     question : « ce message s'adresse-t-il à Yuki ? » ;
 *  2. le RÉDACTEUR de la réponse publiée dans le canal.
 *
 * ⚠️ Les prompts sont des CONSTANTES de code, pas des champs de configuration : ils
 * font partie du contrat de comportement (et le mode `auto` doit rester borné : une
 * question, une réponse de deux lettres).
 *
 * ⚠️ Le transcript envoyé au rédacteur est BORNÉ (`maxChars`) et **exclut** le message
 * déclencheur du corps du prompt (il est présenté à part, à la fin) : sans cette borne,
 * un canal actif ferait grossir chaque appel jusqu'au refus du fournisseur.
 *
 * ⚠️ HORODATAGE (lot 25). Le fil était injecté SANS aucune heure : le modèle ne pouvait
 * donc pas savoir quel message était récent, et citait une fiche du matin comme « la
 * dernière » sans voir celle produite trois minutes plus tard. Depuis ce lot :
 *   - chaque ligne du fil porte `[JJ/MM HH:mm]` (date ET heure, compact) ;
 *   - le prompt porte l'HEURE COURANTE au même format que les prompts locaux
 *     (`[horodatage] AAAA-MM-JJ HH:mm (heure locale)`, `src/pi/timestamp.ts:92`) ;
 *   - quand la fenêtre coupe, une mention DIT que l'historique est partiel.
 *
 * ⚠️ Pourquoi l'heure courante est en TÊTE DE FIL et non dans le prompt système :
 * `CHAT_REPLY_SYSTEM_PROMPT` est une CONSTANTE du contrat de comportement (elle ne peut
 * pas changer d'un run à l'autre), et le repère n'a de sens qu'à côté des horodatages
 * qu'il permet d'interpréter.
 */

import { buildTimestampPrefix, formatCompactDateTime } from "../../pi/timestamp.js";
import type { RemoteMessage } from "../types.js";
import { auteurAffichable } from "../mirror/names.js";

/** Entrée `auto` : une seule question, réponse `oui`/`non`. */
export const CHAT_JUDGE_SYSTEM_PROMPT = [
  "Tu es un filtre. On te donne le dernier message d'un canal de discussion et tu dis",
  "si ce message s'adresse à Yuki (l'assistante qui lit le canal) ou non.",
  "",
  "Réponds UNIQUEMENT par « oui » ou « non ». Aucune explication, aucune ponctuation.",
  "",
  "Réponds « oui » si le message pose une question à l'assistante, lui demande une action,",
  "la cite, ou poursuit clairement un échange avec elle.",
  "Réponds « non » si les humains se parlent entre eux, si le message est une annonce",
  "générale, une politesse adressée à quelqu'un d'autre, ou du bruit.",
].join("\n");

/** Prompt système du rédacteur de réponse. */
export const CHAT_REPLY_SYSTEM_PROMPT = [
  "Tu es Yuki, une assistante qui participe à un canal de discussion d'équipe.",
  "Tu réponds en FRANÇAIS, de façon concise et utile, comme un message de chat :",
  "pas de titre, pas de liste à puces interminable, pas de formule de politesse creuse.",
  "",
  "Tu réponds au DERNIER message, en tenant compte du fil fourni.",
  "Si tu ne sais pas, tu le dis simplement. Tu ne prétends jamais avoir fait une action",
  "que tu n'as pas faite. Tu ne révèles aucun secret, aucun jeton, aucun chemin interne.",
  "Tu n'écris qu'une seule RÉPONSE DE FOND ; une ligne d'accusé de réception avant une",
  "action longue est permise (elle part séparément, dans le canal). Pas de balise ni de",
  "bloc de code si ce n'est pas nécessaire.",
  "",
  "Depuis ce canal, certaines actions sont IMPOSSIBLES : exécuter une commande sur une",
  "machine, transférer un fichier vers une machine appairée, demander un secret. Elles",
  "exigent une validation",
  "humaine qui s'affiche uniquement dans l'interface web et ne peut pas être donnée",
  "ici. Si on te les demande, tu le dis clairement au lieu d'attendre ou d'inventer.",
  "",
  "⚠️ Tu peux PUBLIER un message dans un AUTRE canal suivi avec l'outil",
  "`publier_dans_canal` (canaux de la liste Configuration → Conversation → " +
  "« Discussions — Mattermost / Discord »). Cet outil",
  "transportait du TEXTE — il transporte aussi des FICHIERS : passe leurs identifiants",
  "dans `fichier_ids` (ceux de `lister_fichiers`, ou l'image que tu viens de produire),",
  "trois au maximum, et seulement des fichiers de CETTE conversation. Tu ne dis donc",
  "JAMAIS que tu ne peux pas envoyer l'image : si l'outil est dans ta liste, tu",
  "l'envoies. Si cet outil",
  "n'est pas dans ta liste, ou si le canal demandé n'est pas suivi, tu réponds",
  "simplement que tu ne peux pas le faire. Tu n'invoques JAMAIS une validation",
  "humaine, une approbation ou une limitation technique imaginaire pour une action",
  "que tu n'as pas : une capacité absente se dit en une phrase, sans justification",
  "inventée.",
  "",
  "Si tu confies une tâche à un worker (outil de délégation), le résultat te sera",
  "renvoyé DANS CE CANAL plus tard, quand la tâche sera réellement terminée : tu ne",
  "l'annonces jamais comme faite avant de l'avoir reçu.",
].join("\n");

/**
 * Délai maximal du JUGE (ms) : court à dessein — un juge lent retarde la réponse au
 * message, et un `auto` qui n'a pas tranché en 20 s vaut « non ».
 */
export const CHAT_JUDGE_TIMEOUT_MS = 20_000;

/** Délai maximal du RÉDACTEUR (ms) : laisser le temps d'écrire, sans bloquer un canal. */
export const CHAT_REPLY_TIMEOUT_MS = 90_000;

/**
 * Délai maximal du RÉSUMÉ d'un rapport de job d'arrière-plan (ms).
 *
 * ⚠️ Il s'agit de la publication du résultat d'un `delegate` (ou d'un archivage du
 * libraire) dans le canal. Il est plus COURT que celui du rédacteur : résumer un
 * rapport déjà borné (`REPORT_MAX_CHARS`) ne demande pas une génération d'image, et
 * une personne qui attend le résultat d'une tâche ne doit pas attendre trois
 * minutes de plus. Au-delà, `createChannelAwareWaker` publie une phrase honnête
 * (job terminé, résumé indisponible) plutôt que rien du tout.
 */
export const CHAT_JOB_REPORT_TIMEOUT_MS = 45_000;

/** Nombre de caractères de transcript transmis au rédacteur (borne de coût). */
export const CHAT_REPLY_TRANSCRIPT_MAX_CHARS = 6_000;

/** Nombre de messages récents transmis au juge (contexte minimal). */
export const CHAT_JUDGE_CONTEXT_MESSAGES = 4;

/**
 * Mention ajoutée au-dessus de la réponse quand la fenêtre a coupé le fil.
 *
 * ⚠️ SANS elle, le modèle croit avoir TOUT vu : il répond alors « comme si » l'échange
 * complet lui était connu, alors que les messages les plus anciens ont été jetés.
 */
export const CHAT_PARTIAL_HISTORY_NOTICE =
  "⚠️ Historique PARTIEL : l'historique ci-dessus est incomplet — des messages plus " +
  "anciens ne sont pas affichés (fenêtre bornée aux messages les plus récents).";

/** Repère d'une ligne dont l'instant d'envoi est illisible (jamais une heure inventée). */
const UNKNOWN_LINE_TIMESTAMP = "[horodatage inconnu]";

/** Auteur affichable d'un message (jamais vide, jamais un identifiant brut). */
function authorLabel(message: RemoteMessage): string {
  return auteurAffichable(message.author);
}

/** Extrait le texte d'un message pour un prompt (mention de suppression comprise). */
function bodyOf(message: RemoteMessage): string {
  const text = message.text ?? "";
  return message.deleted === true ? `${text} [message supprimé]` : text;
}

/**
 * Repère COMPACT d'une ligne de fil : `[JJ/MM HH:mm]`.
 *
 * ⚠️ Même horloge et même fuseau que les prompts locaux : `formatCompactDateTime`
 * (`src/pi/timestamp.ts:81`) rend `AAAA-MM-JJ HH:mm` avec `Intl` et le fuseau demandé.
 * On en dérive la forme courte — la fenêtre de 6 000 caractères est déjà serrée, et
 * chaque ligne paie son horodatage (il entre dans le décompte, voir `buildReplyPrompt`).
 *
 * ⚠️ La DATE est toujours présente, même pour aujourd'hui : « 11:46 » seul ne dit pas
 * de quel jour il s'agit après une nuit de messages, et une ligne datée du 02/11 se
 * compare d'un coup d'œil à l'heure courante.
 */
export function formatLineTimestamp(sentAt: string, timeZone?: string): string {
  const instant = new Date(sentAt);
  if (!Number.isFinite(instant.getTime())) return UNKNOWN_LINE_TIMESTAMP;
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(
    formatCompactDateTime(instant, timeZone),
  );
  if (!match) return UNKNOWN_LINE_TIMESTAMP;
  const [, , mois, jour, heure, minute] = match;
  return `[${jour}/${mois} ${heure}:${minute}]`;
}

/**
 * Prompt du JUGE : le contexte récent, puis le message à juger, puis la question.
 *
 * ⚠️ Aucune consigne de rédaction : le juge n'écrit pas de message, il rend un verdict.
 */
export function buildJudgePrompt(input: {
  channelTitle: string;
  message: RemoteMessage;
  recent?: readonly RemoteMessage[];
}): string {
  const lines: string[] = [];
  if (input.channelTitle !== "") lines.push(`Canal : ${input.channelTitle}`);
  const recent = (input.recent ?? []).slice(-CHAT_JUDGE_CONTEXT_MESSAGES);
  if (recent.length > 0) {
    lines.push("Messages précédents :");
    for (const message of recent) {
      lines.push(`- ${authorLabel(message)} : ${bodyOf(message)}`);
    }
  }
  lines.push(`Auteur du message à juger : ${authorLabel(input.message)}`);
  lines.push(`Message à juger :`);
  lines.push(bodyOf(input.message));
  lines.push("");
  lines.push("Ce message s'adresse-t-il à Yuki ? Réponds « oui » ou « non ».");
  return lines.join("\n");
}

/**
 * Interprète la réponse du juge.
 *
 * ⚠️ DÉFENSIF et CONSERVATEUR : seule une réponse commençant par « oui » (ou « yes »)
 * vaut acceptation. Tout le reste — y compris une réponse vide ou un modèle bavard qui
 * commence par autre chose — vaut refus. Un faux négatif ne coûte qu'un silence ; un
 * faux positif fait répondre Yuki au milieu d'une conversation qui ne la concernait pas.
 */
export function parseJudgeAnswer(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/^[^a-zà-ÿ]+/u, "");
  if (normalized === "") return false;
  return normalized.startsWith("oui") || normalized.startsWith("yes");
}

/**
 * Prompt du RÉDACTEUR : fil borné + dernier message, puis consigne de réponse.
 *
 * @param input.maxChars budget de caractères du fil, horodatages et retours à la ligne
 *   compris (défaut `CHAT_REPLY_TRANSCRIPT_MAX_CHARS`).
 * @param input.now instant courant (défaut : maintenant) — injecté par les tests.
 * @param input.timeZone fuseau IANA ; absent ⇒ fuseau du process Node.
 */
export function buildReplyPrompt(input: {
  channelTitle: string;
  transcript: readonly RemoteMessage[];
  message: RemoteMessage;
  botName?: string;
  maxChars?: number;
  now?: Date;
  timeZone?: string;
  /**
   * Pièces jointes qui n'ont PAS pu être transmises (fichier non image, trop lourd,
   * illisible). ⚠️ Elles sont DITES au rédacteur : sans cela il répondrait comme si le
   * message n'en portait aucune, alors que l'humain croit avoir joint une image.
   */
  notes?: readonly string[];
}): string {
  const maxChars = input.maxChars ?? CHAT_REPLY_TRANSCRIPT_MAX_CHARS;
  const now = input.now ?? new Date();
  const timeZone = input.timeZone;
  const lines: string[] = [];
  if (input.botName !== undefined && input.botName !== "") lines.push(`Tu es ${input.botName}.`);
  if (input.channelTitle !== "") lines.push(`Canal : ${input.channelTitle}`);
  lines.push("");
  // ⚠️ NOTION DE PRÉSENT : sans cette ligne, « tout à l'heure » et « ce matin » n'ont
  // aucun point de référence, même avec des messages horodatés.
  lines.push(`Heure courante : ${buildTimestampPrefix(now, timeZone)}`);
  lines.push("");
  lines.push("Fil récent (du plus ancien au plus récent) :");

  // ⚠️ On garde les messages les PLUS RÉCENTS quand la borne est atteinte : couper la
  // fin retirerait justement le contexte du message auquel il faut répondre.
  // ⚠️ L'horodatage de ligne ENTRE dans le décompte (il fait partie du coût réel), et le
  // retour à la ligne aussi : sans cela la fenêtre déborderait sans le dire.
  const ordered = [...input.transcript].reverse();
  const kept: string[] = [];
  let used = 0;
  let dropped = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    const message = ordered[index] as RemoteMessage;
    if (message.remoteId === input.message.remoteId) continue;
    const root = message.threadRootId !== undefined ? " (réponse de fil)" : "";
    const line = `${formatLineTimestamp(message.sentAt, timeZone)} ${authorLabel(message)}${root} : ${bodyOf(message)}`;
    const cost = line.length + (kept.length > 0 ? 1 : 0);
    if (used + cost > maxChars && kept.length > 0) {
      // ⚠️ On COMPTE ce qui est jeté : c'est ce qui déclenche la mention « historique
      // partiel » (le message déclencheur, présenté à part, n'en fait pas partie).
      dropped = ordered
        .slice(index)
        .filter((reste) => reste.remoteId !== input.message.remoteId).length;
      break;
    }
    used += cost;
    kept.push(line);
  }
  for (const line of kept.reverse()) lines.push(line);
  if (kept.length === 0) lines.push("(aucun message précédent)");
  if (dropped > 0) {
    lines.push("");
    lines.push(CHAT_PARTIAL_HISTORY_NOTICE);
  }

  const notes = (input.notes ?? []).filter((note) => note.trim() !== "");
  if (notes.length > 0) {
    lines.push("");
    lines.push("Pièces jointes du message (NON transmises au modèle) :");
    for (const note of notes) lines.push(`- ${note}`);
  }

  lines.push("");
  lines.push(`Message auquel tu dois répondre — ${authorLabel(input.message)} :`);
  lines.push(bodyOf(input.message));
  lines.push("");
  lines.push("Rédige UNIQUEMENT le texte de ta réponse, sans préambule ni signature.");
  return lines.join("\n");
}
