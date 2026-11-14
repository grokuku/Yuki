/**
 * PROMPT DU RÉDACTEUR D'UN CANAL, PAR BOT — composition + garde + journal.
 *
 * ⚠️ CE QUE CE MODULE FERME (2026-11-14) : dans un canal Mattermost, la réponse
 * était rédigée avec la constante commune `CHAT_REPLY_SYSTEM_PROMPT`, qui
 * commençait par « Tu es Yuki ». `grolaf` — personnalité enregistrée, badge
 * « à chaud », prompt du tour relu correctement côté host LOCAL — répondait donc
 * « je suis Yuki, pas grolaf ». Le chemin du CANAL n'avait jamais reçu ni son nom
 * ni sa personnalité.
 *
 * ⚠️ TROIS CHOSES, DANS CET ORDRE :
 *  1. la GARDE refuse une personnalité héritée d'un AUTRE bot (`refus` + journal) ;
 *  2. la composition injecte identité + personnalité + règles de canal ;
 *  3. le JOURNAL dit ce qui a été injecté (`chat.reponse.prompt_bot`) : le texte
 *     exact restait invisible, c'est ce qui a rendu ce bug si long à identifier.
 *
 * ⚠️ DÉDOUBLONNAGE : le journal ne répète pas la même ligne à chaque réponse
 * (une empreinte par couple `bot`/`source`), sinon un canal actif noierait tout.
 */

import type { OriginePersonnaliteEffective, ProvenancePersonnalite } from "../../personality/personality.js";
import {
  refuserPersonnaliteEtrangere,
  type PersonnaliteConnue,
} from "../../bots/personnalite-garde.js";

import { chatReplySystemPrompt } from "./prompt.js";

/** Journal minimal attendu (le logger applicatif en est un sur-ensemble). */
export interface LoggerPromptRedacteur {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

/** Personnalité RÉSOLUE d'un bot, avec sa provenance. */
export interface PersonnaliteDuBot {
  readonly texte: string;
  readonly origine: OriginePersonnaliteEffective;
  readonly provenance: ProvenancePersonnalite;
  readonly fichier: string | null;
}

export interface OptionsPromptRedacteurBot {
  /** Bot PROPRIÉTAIRE de la conversation (celui qui doit parler). */
  readonly botId: string;
  /** Nom AFFICHÉ du bot (registre). */
  readonly nom: string;
  readonly personnalite: PersonnaliteDuBot;
  /** Personnalités connues des autres bots (garde). */
  readonly autres?: readonly PersonnaliteConnue[];
  readonly logger?: LoggerPromptRedacteur;
  /**
   * Mémoire de dédoublonnage (facultative : une par gateway). Absente ⇒ chaque
   * appel journalise (tests).
   */
  readonly memoire?: Map<string, string>;
}

/** Extrait lisible d'un texte (blancs compactés, borné) pour le journal. */
function extrait(texte: string, max = 120): string {
  const compact = texte.replace(/\s+/gu, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max)}…`;
}

/** Journal qui ne répète pas la MÊME ligne (même empreinte) deux fois. */
function journalerUneFois(
  logger: LoggerPromptRedacteur | undefined,
  memoire: Map<string, string> | undefined,
  nature: "info" | "warn",
  message: string,
  empreinte: string,
  fields: Record<string, unknown>,
): void {
  if (logger === undefined) return;
  if (memoire !== undefined) {
    if (memoire.get(message) === empreinte) return;
    memoire.set(message, empreinte);
  }
  logger[nature](message, fields);
}

/**
 * Compose le prompt système du rédacteur pour le bot PROPRIÉTAIRE du canal.
 *
 * ⚠️ Un refus de la garde ne lève jamais : le bot répond quand même, avec son
 * identité et sans bloc de personnalité — plutôt qu'avec une fausse identité.
 */
export function promptRedacteurDuBot(options: OptionsPromptRedacteurBot): string {
  const verdict = refuserPersonnaliteEtrangere({
    botId: options.botId,
    texte: options.personnalite.texte,
    provenance: options.personnalite.provenance,
    autres: options.autres ?? [],
  });

  if (verdict.refus !== undefined) {
    journalerUneFois(
      options.logger,
      options.memoire,
      "warn",
      "personnalite.autre_bot_refusee",
      `${options.botId}|${verdict.refus.autreBot}|${verdict.refus.provenance}`,
      {
        bot: options.botId,
        autre_bot: verdict.refus.autreBot,
        provenance: verdict.refus.provenance,
        ...(options.personnalite.fichier !== null
          ? { fichier: options.personnalite.fichier }
          : {}),
        consequence:
          "le texte de personnalité d'un AUTRE bot a été REFUSÉ : la réponse de ce canal est rédigée sans bloc de personnalité (identité du bot conservée)",
        action:
          "renseignez « Personnalité » de ce bot (champ prompts.personnalite) : un bot ne peut pas parler avec l'identité d'un autre",
      },
    );
  }

  const personnalite = verdict.texte;
  const prompt = chatReplySystemPrompt({ botName: options.nom, personnalite });

  // ⚠️ DIAGNOSTIC (bug du 2026-11-14) : sans cette ligne, on ne pouvait pas dire
  // QUELLE source avait parlé dans un canal — le prompt n'était journalisé nulle part.
  journalerUneFois(
    options.logger,
    options.memoire,
    "info",
    "chat.reponse.prompt_bot",
    `${options.botId}|${options.personnalite.provenance}|${personnalite.length}|${extrait(personnalite)}`,
    {
      bot: options.botId,
      nom: options.nom,
      personnalite_origine: options.personnalite.origine,
      personnalite_source: options.personnalite.provenance,
      ...(options.personnalite.fichier !== null
        ? { personnalite_fichier: options.personnalite.fichier }
        : {}),
      personnalite_chars: personnalite.length,
      ...(personnalite !== "" ? { personnalite_extrait: extrait(personnalite) } : {}),
      ...(verdict.refus !== undefined ? { personnalite_refusee: verdict.refus.autreBot } : {}),
    },
  );

  return prompt;
}
