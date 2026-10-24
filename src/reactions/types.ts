/**
 * Domaine « RÉACTIONS aux messages de Yuki » — CATALOGUE PUR.
 *
 * L'utilisateur pose une réaction sur UN message de Yuki. Ce n'est PAS un
 * message : elle ne déclenche AUCUN tour, elle n'est jamais prononcée par la
 * synthèse vocale, et elle n'entre dans le prompt que comme DONNÉE au tour
 * SUIVANT (voir `./prompt.ts` et `src/pi/sdk/reactions-extension.ts`).
 *
 * ⚠️ TROIS REGISTRES, JAMAIS CONFONDUS (c'est ce que le modèle reçoit) :
 *   ① `judgement` — sur la QUALITÉ de la réponse ⇒ corrige le COMPORTEMENT ;
 *   ② `emotion`   — sur le CONTENU (registre CASUAL) ⇒ informe sur le REGISTRE ;
 *   ③ `mood`      — sur L'UTILISATEUR (jamais sur le message) ⇒ module le TON.
 * Les mélanger serait un contresens : un jugement n'est pas une humeur, et une
 * humeur ne juge JAMAIS la réponse.
 *
 * Aucun import SDK ni `typebox` (domaine de données testable en isolation).
 */

import type { MemoryCategory } from "../memory/types.js";

/** Registre d'une réaction (voir l'en-tête : les trois ne se confondent pas). */
export type ReactionGroup = "judgement" | "emotion" | "mood";

/** Une réaction proposée à l'utilisateur. */
export interface ReactionDef {
  /** Identifiant STABLE (jamais réutilisé : il est persisté et corrélé). */
  id: string;
  group: ReactionGroup;
  /** Pictogramme affiché (du TEXTE : aucune icône SVG n'est écrite à la main). */
  emoji: string;
  /** Libellé court, affiché À CÔTÉ du pictogramme. */
  label: string;
  /**
   * MINI-EXPLICATION affichée sous le libellé : elle dit ce que la réaction
   * SIGNIFIE pour Yuki, pour que l'utilisateur ne se trompe pas de registre.
   */
  hint: string;
}

/** Un groupe du menu (titre + sens), dans l'ordre d'affichage. */
export interface ReactionGroupDef {
  id: ReactionGroup;
  title: string;
  /** Ce que ce registre demande à Yuki (une ligne, impérative et non ambiguë). */
  meaning: string;
}

/**
 * Groupes, dans l'ORDRE du menu : jugement technique → émotion → humeur.
 * ⚠️ L'ordre porte du sens : on corrige d'abord la réponse, on lit ensuite le
 * ressenti, on termine par l'état de l'utilisateur (qui module seulement le ton).
 */
export const REACTION_GROUPS: readonly ReactionGroupDef[] = [
  {
    id: "judgement",
    title: "Jugement technique",
    meaning: "sur la QUALITÉ de la réponse ⇒ corrige le COMPORTEMENT",
  },
  {
    id: "emotion",
    title: "Réaction émotionnelle",
    meaning: "sur le CONTENU (registre casual) ⇒ informe sur le REGISTRE",
  },
  {
    id: "mood",
    title: "Humeur",
    meaning: "sur MOI, pas sur le message ⇒ module le TON",
  },
];

/** Catalogue COMPLET (l'ordre est celui du menu, groupe par groupe). */
export const REACTIONS: readonly ReactionDef[] = [
  // ① JUGEMENT TECHNIQUE — sur la qualité.
  {
    id: "utile",
    group: "judgement",
    emoji: "👍",
    label: "Utile",
    hint: "La réponse était ce qu'il fallait.",
  },
  {
    id: "a-cote",
    group: "judgement",
    emoji: "👎",
    label: "À côté",
    hint: "La réponse ne répond pas à la question posée.",
  },
  {
    id: "trop-long",
    group: "judgement",
    emoji: "🐢",
    label: "Trop long",
    hint: "Trop de texte pour ce qui était demandé.",
  },
  {
    id: "trop-bavard",
    group: "judgement",
    emoji: "⚡",
    label: "Trop bavard",
    hint: "Trop de détails, de relances ou de remplissage.",
  },
  {
    id: "incompris",
    group: "judgement",
    emoji: "❓",
    label: "Incompris",
    hint: "La demande n'a pas été comprise.",
  },
  {
    id: "faux",
    group: "judgement",
    emoji: "⚠️",
    label: "Faux",
    hint: "Une affirmation de la réponse est fausse.",
  },
  // ② RÉACTION ÉMOTIONNELLE — sur le contenu, registre CASUAL (jamais technique).
  {
    id: "rire",
    group: "emotion",
    emoji: "😄",
    label: "Ça me fait rire",
    hint: "Ça m'a amusé — un ressenti, pas un avis sur la qualité.",
  },
  {
    id: "touche",
    group: "emotion",
    emoji: "😢",
    label: "Ça me touche",
    hint: "Ça m'a ému.",
  },
  {
    id: "reflexion",
    group: "emotion",
    emoji: "🤔",
    label: "Ça me fait réfléchir",
    hint: "Ça m'a donné à penser.",
  },
  {
    id: "indifferent",
    group: "emotion",
    emoji: "😐",
    label: "Ça me laisse indifférent",
    hint: "Ni plus ni moins : neutre.",
  },
  // ③ HUMEUR — sur L'UTILISATEUR : module le ton, ne juge pas le message.
  {
    id: "bien",
    group: "mood",
    emoji: "🙂",
    label: "Je vais bien",
    hint: "Mon humeur du moment, pas ton message.",
  },
  {
    id: "fatigue",
    group: "mood",
    emoji: "😴",
    label: "Fatigué",
    hint: "Allège le rythme et la longueur.",
  },
  {
    id: "agace",
    group: "mood",
    emoji: "😤",
    label: "Agacé",
    hint: "Ton plus direct, moins d'entrain.",
  },
  {
    id: "content",
    group: "mood",
    emoji: "🎉",
    label: "Content",
    hint: "Ton enthousiaste bienvenu.",
  },
];

const BY_ID = new Map<string, ReactionDef>(REACTIONS.map((item) => [item.id, item]));

/** `true` si `value` est un identifiant de réaction CONNU. */
export function isReactionId(value: unknown): value is string {
  return typeof value === "string" && BY_ID.has(value);
}

/** Définition d'une réaction, ou `undefined` si l'identifiant est inconnu. */
export function reactionById(id: unknown): ReactionDef | undefined {
  return typeof id === "string" ? BY_ID.get(id) : undefined;
}

/** Réactions d'un groupe, dans l'ordre du menu. */
export function reactionsOfGroup(group: ReactionGroup): ReactionDef[] {
  return REACTIONS.filter((item) => item.group === group);
}

/**
 * Nombre de MESSAGES DISTINCTS portant la même réaction à partir duquel la
 * répétition cesse d'être un cas isolé et devient une RÉGULARITÉ mémorisable.
 * ⚠️ Une réaction ISOLÉE n'est jamais un souvenir.
 */
export const REACTION_REGULARITY_MIN = 3;

/** Une réaction COURANTE, telle que la projette le store. */
export interface ReactionView {
  sessionId: string;
  entryId: string;
  reaction: string;
  at: string;
}

/**
 * PORT consommé par l'extension SDK (`before_agent_start`) : il ne fait que
 * LIRE. Aucun type du SDK ne traverse ce contrat, et rien ici ne peut ouvrir un
 * tour.
 */
export interface ReactionsPort {
  /**
   * Les `limit` dernières réactions ENCORE posées pour une conversation (de la
   * plus ancienne à la plus récente). Ne lève jamais : un store indisponible
   * renvoie un tableau vide.
   */
  recentFor(sessionId: string, limit: number): ReactionView[];
}

/**
 * PORT du transport WebSocket pour les réactions (écriture + lecture par
 * conversation). Distinct de `ReactionsPort` (lecture seule, consommée par
 * l'extension SDK) : **le transport ne peut pas lire dans le prompt** et
 * **l'extension ne peut pas écrire**.
 */
export interface ReactionsGatewayPort {
  /** Pose (ou change) la réaction d'un message. `false` si rien n'a changé. */
  set(sessionId: string, entryId: string, reaction: string): boolean;
  /** Retire la réaction d'un message. `false` s'il n'y en avait pas. */
  clear(sessionId: string, entryId: string): boolean;
  /**
   * Réactions COURANTES d'une conversation (`entryId → reaction`), fusionnées
   * dans le snapshot : c'est ce qui fait survivre une réaction au rechargement
   * et à la reconnexion.
   */
  forSession(sessionId: string): ReadonlyMap<string, string>;
}

/** Une répétition observée (donnée déterministe, jamais une impression). */
export interface ReactionRegularity {
  reaction: string;
  group: ReactionGroup;
  /** Nombre de MESSAGES DISTINCTS portant cette réaction. */
  count: number;
}

/** Souvenir candidat dérivé d'une régularité (forme attendue par la mémoire). */
export interface ReactionMemoryCandidate {
  text: string;
  cat: MemoryCategory;
  why: string;
}

/** Catégorie de mémoire d'un registre (un jugement est une préférence, etc.). */
function categoryOf(group: ReactionGroup): MemoryCategory {
  if (group === "emotion") return "relation";
  if (group === "mood") return "fait";
  return "preference";
}

/**
 * Traduit une RÉGULARITÉ en souvenir CANDIDAT — formulation DÉTERMINISTE (le
 * code écrit la phrase, aucun modèle n'est appelé pour la inventer) et
 * justification (`why`) TOUJOURS renseignée, comme l'exige la mémoire durable.
 *
 * `null` si la réaction n'est pas connue (catalogue modifié depuis l'écriture).
 */
export function regularityMemory(
  regularity: ReactionRegularity,
): ReactionMemoryCandidate | null {
  const def = reactionById(regularity.reaction);
  if (!def) return null;
  const count = Math.max(1, Math.floor(regularity.count));
  let text: string;
  if (def.group === "mood") {
    text =
      `L'utilisateur a réagi souvent « ${def.label} » (${count} messages) : ` +
      "c'est son ÉTAT, jamais un jugement sur mes réponses.";
  } else if (def.group === "emotion") {
    text =
      `L'utilisateur réagit souvent « ${def.label} » à mes messages ` +
      `(${count} messages) : ce registre lui parle.`;
  } else {
    text =
      `L'utilisateur juge souvent mes réponses « ${def.label} » ` +
      `(${count} messages) : c'est une tendance, pas un cas isolé.`;
  }
  return {
    text,
    cat: categoryOf(def.group),
    why:
      `Répétition observée sur ${count} messages DIFFÉRENTS : ce n'est pas ` +
      "une impression isolée, donc ça durera.",
  };
}
