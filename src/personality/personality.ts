/**
 * Personnalité d'un bot — RÈGLES PURES (bornes, résolution de la source).
 *
 * ⚠️ UNE SEULE SOURCE DE PERSONNALITÉ (décision utilisateur du 2026-11-14) :
 * la clé de configuration **`prompts.personnalite`** (portée `mixte` : défaut
 * d'instance + surcharge par bot). Elle seule compose le prompt du tour, via le
 * point d'assemblage unique (`src/llm/prompt-systeme.ts`).
 *
 * Le fichier `personality.md` n'est PLUS une source de personnalité : c'est un
 * simple **défaut d'amorçage**, lu une fois par bot quand aucune personnalité
 * n'a été RENSEIGNÉE (`personnaliteEffective` ci-dessous). Il n'est JAMAIS
 * concaténé au prompt : sinon deux textes d'identité se contrediraient, et
 * c'était le fichier qui gagnait (bug corrigé par ce lot).
 *
 * La borne et le format du bloc sont PROPRES à la personnalité ; le mécanisme
 * de bornage lui-même est partagé (`clampText`, `src/state/`).
 */

import { clampText } from "../state/text-document-store.js";

/** Borne DURE du contenu de personnalité (décision utilisateur : 8 000 caractères). */
export const PERSONALITY_MAX_CHARS = 8_000;
/** Nombre de versions conservées dans l'historique (décision utilisateur : 20). */
export const PERSONALITY_HISTORY_MAX = 20;
/** Nom du fichier de personnalité (dans le volume `state`). */
export const PERSONALITY_FILE_NAME = "personality.md";
/** Sous-dossier des snapshots horodatés. */
export const PERSONALITY_HISTORY_DIR_NAME = "personality-history";
/** Journal append-only des écritures (avant/après, source, horodatage). */
export const PERSONALITY_JOURNAL_FILE_NAME = "personality-journal.jsonl";
/** Balise d'encadrement du bloc de personnalité injecté dans le prompt. */
export const PERSONALITY_TAG = "personnalite";

/**
 * En-tête du bloc injecté. Explicite sur la NATURE du contenu : c'est
 * l'IDENTITÉ de Yuki (sa base), à la différence de la mémoire (données
 * factuelles) et de l'annuaire (données machines).
 */
export const PERSONALITY_BLOCK_HEADER = [
  "## Personnalité de Yuki",
  "Le texte encadré ci-dessous décrit QUI est Yuki et COMMENT elle s'exprime.",
  "C'est sa base d'identité : incarnez-la comme votre propre voix.",
].join("\n");

/** Résultat de la normalisation d'un texte de personnalité à la borne. */
export interface ClampedPersonality {
  /** Contenu borné (au plus `max` points de code). */
  text: string;
  /** Nombre de points de code du contenu borné. */
  chars: number;
  /** `true` si le texte fourni dépassait la borne et a été tronqué. */
  truncated: boolean;
}

/**
 * Borne un texte de personnalité à `max` **points de code** (un emoji = un
 * caractère, pas deux). Le débordement est SIGNALÉ (`truncated`), jamais
 * silencieux.
 */
export function clampPersonalityText(
  text: string,
  max: number = PERSONALITY_MAX_CHARS,
): ClampedPersonality {
  return clampText(text, max);
}

/**
 * Encadre la personnalité dans le bloc injecté au prompt système du tour.
 * Renvoie une chaîne VIDE si le contenu est vide (⇒ RIEN n'est injecté : pas de
 * bloc vide). Le contenu est du Markdown de CONFIANCE (l'utilisateur l'édite),
 * donc NON échappé — le balisage Markdown doit rester interprétable.
 *
 * ⚠️ Plus AUCUNE extension ne concatène ce bloc (il n'y a plus d'extension de
 * personnalité) : le bloc du prompt est `blocPersonnalite`
 * (`src/llm/prompt-systeme.ts`), qui n'écrit pas de nom en dur. Cette fonction
 * reste le format du domaine (et son test).
 */
export function framePersonality(text: string): string {
  if (text.trim().length === 0) return "";
  return [
    PERSONALITY_BLOCK_HEADER,
    "",
    `<${PERSONALITY_TAG}>`,
    text,
    `</${PERSONALITY_TAG}>`,
  ].join("\n");
}

/** Origine de la personnalité EFFECTIVE d'un bot (une seule valeur retenue). */
export type OriginePersonnaliteEffective = "champ" | "fichier" | "aucune";

/**
 * Les DEUX candidats d'un bot. Aucun autre texte n'est consulté.
 *
 * ⚠️ `champRenseigne` n'est pas `champ !== ""` : le champ a un défaut LIVRÉ
 * (`config/pi/personnalite.md`) qui n'est PAS un texte de l'utilisateur. Un
 * défaut livré ne doit donc pas masquer un `personality.md` déjà écrit (ce
 * serait une perte silencieuse) ; une valeur ENREGISTRÉE, elle, est un choix et
 * l'emporte toujours.
 */
export interface SourcesPersonnalite {
  /** Valeur effective de `prompts.personnalite` (bot > instance > défaut livré). */
  readonly champ: string;
  /** `true` si l'utilisateur a ENREGISTRÉ une valeur (origine ≠ `default`). */
  readonly champRenseigne: boolean;
  /** Contenu du fichier d'amorçage (`personality.md`), lu UNE fois par bot. */
  readonly fichier: string;
}

/** Personnalité retenue pour un bot, avec l'origine de la valeur. */
export interface PersonnaliteEffective {
  /** Texte retenu (vide ⇒ aucune personnalité : aucun bloc composé). */
  readonly texte: string;
  /** D'où vient ce texte — jamais deux à la fois. */
  readonly origine: OriginePersonnaliteEffective;
}

/**
 * Résout LA personnalité d'un bot : une seule valeur, jamais une concaténation.
 *
 * Ordre de priorité :
 *  1. `prompts.personnalite` **renseigné** (par l'utilisateur) — c'est LUI ;
 *  2. le fichier `personality.md` (défaut d'amorçage) — reprise, pas perte ;
 *  3. le défaut livré de `prompts.personnalite` (jamais vide en pratique :
 *     un bot neuf a donc une personnalité) ;
 *  4. rien (aucun bloc composé).
 */
export function personnaliteEffective(
  sources: SourcesPersonnalite,
): PersonnaliteEffective {
  if (sources.champ.trim() !== "" && sources.champRenseigne) {
    return { texte: sources.champ, origine: "champ" };
  }
  if (sources.fichier.trim() !== "") {
    return { texte: sources.fichier, origine: "fichier" };
  }
  if (sources.champ.trim() !== "") {
    return { texte: sources.champ, origine: "champ" };
  }
  return { texte: "", origine: "aucune" };
}
