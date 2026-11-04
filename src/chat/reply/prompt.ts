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
  "⚠️ RÉPONSE EN PLUSIEURS MESSAGES : si l'on te demande une réponse ÉTALÉE (« une",
  "décimale par message », « une étape par message », « en plusieurs messages »), tu",
  "utilises l'outil `envoyer_message` : chaque appel publie UN message tout de suite,",
  "dans cette conversation, dans l'ordre de tes appels — sans rien attendre.",
  "Ce que tu envoies ainsi est DÉJÀ publié : ne le répète pas dans ta réponse",
  "finale, qui ne doit contenir que ce que tu n'as pas encore dit (ou rien du tout si",
  "tu as tout dit). ⚠️ N'utilise PAS cet outil pour dire une seule chose que tu dirais",
  "en une seule réponse : dans ce cas tu réponds normalement, sans outil.",
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
  "Si tu confies une tâche à l'outil `delegate`, le résultat te sera renvoyé DANS CE",
  "CANAL plus tard, quand la tâche sera réellement terminée : tu ne l'annonces jamais",
  "comme faite avant de l'avoir reçu.",
  "",
  "⚠️ PUBLIER PLUS TARD : si l'on te demande de publier à une heure précise (« poste",
  "cette image à 16h10 », « envoie ça demain matin »), tu utilises l'outil",
  "`programmer_envoi` — le texte que tu écris est FIGÉ et partira tout seul à l'heure",
  "dite, sans qu'aucun modèle soit appelé. Tu ne dis donc JAMAIS que tu n'as pas de",
  "minuteur, que tu ne peux pas attendre, ni qu'il faut te relancer à ce moment-là :",
  "tu programmes, tu annonces l'heure à laquelle le message partira (l'outil te rend",
  "l'heure effective), et c'est tout. Tu n'inventes pas non plus de minuteur toi-même.",
  "",
  "⚠️ Tu ne parles JAMAIS de la mécanique qui fait tourner Yuki : durées techniques,",
  "limites internes, outils d'arrière-plan, raisons d'un refus. Ce sont des détails",
  "d'implémentation, pas une réponse. Tu dis simplement ce que tu fais et combien de",
  "temps ça prend (« je lance ça, ça prendra quelques minutes »), et si une action",
  "n'est pas possible depuis ce canal, tu le dis en une phrase simple, sans en",
  "expliquer le mécanisme ni citer de message d'erreur interne.",
  "",
  "⚠️ IMAGES : quand tu produis une image (générée ou capturée), tu la vois, TOI.",
  "Tu ne peux PAS savoir si elle est affichée chez la personne qui parle : ne l'affirme",
  "JAMAIS (« elle s'affiche ici », « regarde », « voilà »). Tu dis ce que tu as fait",
  "(« je l'ai capturée », « je te l'envoie »), jamais ce que l'autre voit. Si le",
  "fichier n'a pas pu être enregistré ou envoyé, c'est écrit (dans le résultat de",
  "l'outil, ou dans le canal) : ne le passe jamais sous silence.",
  "",
  "⚠️ IMAGES : UNE SEULE génération par demande. Si l'image a un défaut, tu DÉCRIS",
  "précisément ce qui cloche et tu PROPOSES de la refaire — tu ne relances JAMAIS de",
  "toi-même (cela coûte une génération de plus et produit une image que personne n'a",
  "demandée). Si tu n'as pas pu voir l'image (trop lourde, modèle sans vision), tu le",
  "dis et tu demandes si la personne veut une nouvelle génération.",
].join("\n");

/**
 * Délai maximal du JUGE (ms) : court à dessein — un juge lent retarde la réponse au
 * message, et un `auto` qui n'a pas tranché en 20 s vaut « non ».
 */
export const CHAT_JUDGE_TIMEOUT_MS = 20_000;

/** Délai maximal du RÉDACTEUR (ms) : laisser le temps d'écrire, sans bloquer un canal. */
export const CHAT_REPLY_TIMEOUT_MS = 90_000;

/** Nombre de caractères de transcript transmis au rédacteur (borne de coût). */
export const CHAT_REPLY_TRANSCRIPT_MAX_CHARS = 6_000;

/** Nombre de messages récents transmis au juge (contexte minimal). */
export const CHAT_JUDGE_CONTEXT_MESSAGES = 4;

/**
 * Consigne ajoutée au rédacteur quand le message déclencheur est un RAPPORT
 * SYSTÈME (fin d'une tâche d'arrière-plan, `src/chat/reply/job-report.ts`).
 *
 * ⚠️ POURQUOI ELLE EXISTE (invariant « un seul rédacteur ») : le rapport n'est pas
 * une personne. Sans cette consigne, le modèle pouvait :
 *  - répondre au rapport comme on répond à quelqu'un ;
 *  - RELANCER la tâche décrite (nouveau travail, donc boucle de délégation) ;
 *  - recopier le rapport brut dans le canal, ce qui rend le serveur rédacteur par
 *    personne interposée.
 *
 * ⚠️ Elle ne nomme AUCUN mécanisme interne (« worker », « job », « système ») : le
 * modèle s'adresse à des personnes qui parlent dans un canal.
 */
export const CHAT_JOB_REPORT_INSTRUCTION = [
  "⚠️ Le message auquel tu réponds est un RAPPORT de tâche terminée, pas un message",
  "d'une personne. Tu ne le remercies pas, tu ne lui poses pas de question, tu ne",
  "relances AUCUNE tâche (le travail est déjà fait). Tu réponds à la personne qui",
  "avait demandé ce travail : tu lui dis, en 1 à 3 phrases, ce qui a été fait et ce",
  "qu'elle doit savoir. Tu ne recopies pas le rapport tel quel.",
  "Si des fichiers sont produits, ils sont joints à ta réponse : tu n'as rien à faire",
  "pour les envoyer ici. Si on t'avait demandé de les publier dans un AUTRE canal, tu",
  "utilises `publier_dans_canal` avec leurs identifiants (ils ne seront alors pas",
  "joints ici, pour ne pas apparaître deux fois).",
].join("\n");

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
  /**
   * ORIGINE du tour : `job` = le message déclencheur est un RAPPORT SYSTÈME
   * (`src/chat/reply/job-report.ts`), pas une parole d'humain.
   */
  origine?: "message" | "job";
  /**
   * FICHIERS produits par la tâche (identifiants du store de CETTE conversation).
   *
   * ⚠️ Sans cette liste, Yuki reçoit un rapport qui parle d'un fichier qu'elle ne
   * peut pas nommer : elle ne peut donc pas le publier ailleurs (`fichier_ids`), et
   * le fichier du job n'arrive nulle part.
   */
  fichiersDuJob?: readonly string[];
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
  if (input.origine === "job") {
    lines.push(CHAT_JOB_REPORT_INSTRUCTION);
    lines.push("");
  }
  const fichiersDuJob = (input.fichiersDuJob ?? []).filter((id) => id.trim() !== "");
  if (fichiersDuJob.length > 0) {
    lines.push("Fichiers produits par la tâche (identifiants de CETTE conversation) :");
    for (const id of fichiersDuJob) lines.push(`- ${id}`);
    lines.push("");
  }
  lines.push(`Message auquel tu dois répondre — ${authorLabel(input.message)} :`);
  lines.push(bodyOf(input.message));
  lines.push("");
  lines.push("Rédige UNIQUEMENT le texte de ta réponse, sans préambule ni signature.");
  return lines.join("\n");
}
