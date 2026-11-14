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

/**
 * PORTÉE d'un fichier d'amorçage candidat.
 *
 * ⚠️ `bot` = le fichier DU BOT (`<state>/bots/<id>/personality.md`) ; `instance`
 * = le fichier HISTORIQUE de l'instance (`<state>/personality.md`, l'ancien
 * emplacement mono-bot). Le second n'est PAS un vestige : c'est là que vit le
 * texte des instances migrées ou surchargées — on le LIT, jamais on ne le
 * déplace ni ne l'écrase.
 */
export type PorteeFichierPersonnalite = "bot" | "instance";

/** Un fichier d'amorçage candidat, DÉJÀ LU (le texte vient du disque). */
export interface FichierPersonnalite {
  readonly portee: PorteeFichierPersonnalite;
  /** Chemin réel du fichier (diagnostic, journal, interface). */
  readonly chemin: string;
  /** Contenu lu (vide ⇒ fichier absent ou vide : ce candidat ne dit rien). */
  readonly texte: string;
}

/**
 * PROVENANCE FINE de la personnalité retenue — ce que l'interface doit DIRE.
 *
 * ⚠️ Plus fine que `OriginePersonnaliteEffective` (qui ne distingue que
 * « champ » / « fichier » / « aucune ») : elle sépare le DÉFAUT LIVRÉ du texte
 * de l'utilisateur, et le fichier DU BOT du fichier HISTORIQUE. Sans elle, une
 * reprise de fichier s'affiche comme « valeur par défaut » — c'est exactement
 * ce qui fait croire que la personnalité a disparu.
 */
export type ProvenancePersonnalite =
  /** Valeur ENREGISTRÉE pour ce bot (`prompts.personnalite`, origine ≠ défaut). */
  | "bot"
  /** Reprise du fichier DU BOT (`<state>/bots/<id>/personality.md`). */
  | "fichier-bot"
  /** Reprise du fichier HISTORIQUE d'instance (`<state>/personality.md`). */
  | "fichier-instance"
  /** Défaut LIVRÉ (`config/pi/personnalite.md`) : la personnalité de personne. */
  | "defaut"
  /** Aucun texte nulle part (aucun bloc composé). */
  | "aucune";

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
  /**
   * Fichiers d'amorçage candidats, du plus SPÉCIFIQUE au plus GÉNÉRAL
   * (`bot` puis `instance`). Le premier non vide gagne.
   */
  readonly fichiers?: readonly FichierPersonnalite[];
  /**
   * Contenu du fichier d'amorçage DU BOT — raccourci équivalent à un unique
   * candidat `{ portee: "bot". }`. Conservé pour les appelants historiques.
   */
  readonly fichier?: string;
}

/** Personnalité retenue pour un bot, avec l'origine de la valeur. */
export interface PersonnaliteEffective {
  /** Texte retenu (vide ⇒ aucune personnalité : aucun bloc composé). */
  readonly texte: string;
  /** D'où vient ce texte — jamais deux à la fois (catégorie large). */
  readonly origine: OriginePersonnaliteEffective;
  /** D'où vient ce texte, PRÉCISÉMENT (défaut livré ≠ fichier historique). */
  readonly provenance: ProvenancePersonnalite;
  /** Fichier qui a servi, quand la provenance est un fichier. */
  readonly fichier?: FichierPersonnalite;
}

/**
 * Résout LA personnalité d'un bot : une seule valeur, jamais une concaténation.
 *
 * Ordre de priorité :
 *  1. `prompts.personnalite` **renseigné** (par l'utilisateur) — c'est LUI ;
 *  2. le fichier DU BOT (`<state>/bots/<id>/personality.md`) — reprise, pas perte ;
 *  3. ⚠️ le fichier HISTORIQUE de l'instance (`<state>/personality.md`) : c'est
 *     là que vit le texte des instances migrées ou surchargées ; l'ignorer fait
 *     DISPARAÎTRE la personnalité de l'utilisateur (le défaut livré s'affiche) ;
 *  4. le défaut livré de `prompts.personnalite` (jamais vide en pratique :
 *     un bot neuf a donc une personnalité) ;
 *  5. rien (aucun bloc composé).
 *
 * ⚠️ Aucun `botId` n'est traité à part : le fichier historique est cherché pour
 * TOUS les bots, par le même code.
 */
export function personnaliteEffective(
  sources: SourcesPersonnalite,
): PersonnaliteEffective {
  const candidats: readonly FichierPersonnalite[] =
    sources.fichiers ??
    (sources.fichier !== undefined
      ? [{ portee: "bot", chemin: "", texte: sources.fichier }]
      : []);
  // Le PLUS SPÉCIFIQUE d'abord : l'ordre de la liste porte la priorité.
  const fichier = candidats.find((candidat) => candidat.texte.trim() !== "");

  if (sources.champ.trim() !== "" && sources.champRenseigne) {
    return { texte: sources.champ, origine: "champ", provenance: "bot" };
  }
  if (fichier !== undefined) {
    return {
      texte: fichier.texte,
      origine: "fichier",
      provenance: fichier.portee === "instance" ? "fichier-instance" : "fichier-bot",
      ...(fichier.chemin !== "" ? { fichier } : {}),
    };
  }
  if (sources.champ.trim() !== "") {
    return { texte: sources.champ, origine: "champ", provenance: "defaut" };
  }
  return { texte: "", origine: "aucune", provenance: "aucune" };
}
