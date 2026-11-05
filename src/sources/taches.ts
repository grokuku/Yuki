/**
 * TÂCHES PLANIFIÉES (`planifier_tache`, lot 31) — ce qui décide qu'une demande est
 * PROGRAMMABLE avant qu'elle ne devienne un `SourceRecord`.
 *
 * ⚠️ CE QUE CETTE CAPACITÉ AJOUTE, ET QUI LA DISTINGUE DE `programmer_envoi` :
 *
 *   - `programmer_envoi` publie un texte **DÉJÀ ÉCRIT**, à l'heure dite, sans appeler
 *     aucun modèle. C'est gratuit, déterministe, et borné au texte.
 *   - `planifier_tache` fait **AGIR un LLM** à l'heure dite : l'instruction est une
 *     DEMANDE (« résume le journal », « génère une image de … », « lance la commande
 *     … via un agent »), exécutée par le worker lourd, dont le RÉSULTAT est publié.
 *
 * ⚠️ 1 APPEL = 1 TÂCHE. Deux heures ⇒ deux appels. Une demande qui contient deux
 * horaires ne peut pas être décomposée ici sans deviner laquelle va où.
 *
 * ⚠️ Module PUR (aucune I/O, aucun SDK) : les bornes et les refus sont testables
 * séparément de l'outil et du service.
 */

import {
  analyserQuand,
  FUSEAU_ENVOIS,
  formaterInstantEnvoi,
} from "../chat/envois/quand.js";
import { DELAI_MIN_MS, HORIZON_MAX_MS } from "../chat/envois/types.js";
import { MAX_INSTRUCTION_TACHE_CHARS } from "./types.js";

/** Longueur maximale du LIBELLÉ retenu pour l'affichage (caractères). */
export const MAX_LIBELLE_TACHE_CHARS = 80;

/** Demande de planification, telle que l'outil la transmet au port. */
export interface PlanificationTacheInput {
  /** Délai relatif (`dans 30 min`), heure (`16:10`), jour relatif (`demain à 8 h`), ISO. */
  quand: string;
  /** Ce que le LLM devra FAIRE à l'heure dite (donnée de prompt, bornée). */
  instruction: string;
  /** Libellé libre choisi par le modèle ; omis ⇒ dérivé de l'instruction. */
  nom?: string;
  /**
   * Conversation DEMANDEUSE — résolue par l'appelant, jamais par le modèle.
   * ⚠️ C'est la cible de publication par défaut, pour que le résultat arrive LÀ où la
   * demande a été faite (et non dans un fil « Déclencheurs » impersonnel).
   */
  conversation: { session?: string };
}

/** Planification VALIDÉE, prête à être persistée. */
export interface PlanificationValidee {
  /** Instant voulu (ms epoch). */
  at: number;
  /** Instant EFFECTIF en français, DATE COMPLÈTE comprise (le modèle le répète). */
  quandLisible: string;
  /** Instruction normalisée (retours à la ligne normalisés, bornée). */
  instruction: string;
  /** Libellé humain retenu (jamais vide). */
  libelle: string;
  /** Fuseau de lecture retenu (`Europe/Paris`). */
  fuseau: string;
}

/** Issue de la validation : une planification, ou une raison LISIBLE du refus. */
export type ValidationPlanification =
  | ({ ok: true } & PlanificationValidee)
  | { ok: false; raison: string };

/** Refus : instruction vide. */
export const RAISON_INSTRUCTION_VIDE =
  "Rien n'a été programmé : l'instruction est vide. Écris dans `instruction` ce que je " +
  "devrai FAIRE à l'heure dite (« résume le journal », « génère une image de … »).";

/** Refus : instruction trop longue (borne de ce qui est persisté et réinjecté). */
export const RAISON_INSTRUCTION_TROP_LONGUE = (longueur: number): string =>
  `Rien n'a été programmé : l'instruction fait ${longueur} caractères, c'est plus que le ` +
  `maximum (${MAX_INSTRUCTION_TACHE_CHARS}). Résume-la : seuls les caractères enregistrés ` +
  "seront transmis à l'heure dite.";

/** Refus : date déjà passée (⚠️ une ISO DATÉE, jamais une heure seule). */
export const RAISON_TACHE_PASSEE = (lisible: string): string =>
  `Rien n'a été programmé : cette date est déjà passée (${lisible}). Donne une heure ` +
  "future — « dans 10 min », « 8 h » (demain si l'heure est passée), « demain à 8 h », ou " +
  "une date ISO complète.";

/** Refus : délai minimal (30 s). */
export const RAISON_TACHE_DELAI_MIN = (secondes: number): string =>
  `Rien n'a été programmé : il faut au moins ${Math.round(DELAI_MIN_MS / 1000)} secondes ` +
  `d'avance (demandé : ${secondes} s).`;

/** Refus : horizon (30 jours). */
export const RAISON_TACHE_HORIZON = (jours: number): string =>
  `Rien n'a été programmé : l'horizon maximal est de ` +
  `${Math.round(HORIZON_MAX_MS / 86_400_000)} jours (demandé : ${jours} jours).`;

/**
 * Valide une demande de tâche planifiée.
 *
 * ⚠️ ORDRE DES CONTRÔLES = ordre du DROIT : le premier refus est celui qu'on lit, il
 * doit donc être le plus utile. Instruction (le fond) → heure (quand) → bornes d'heure
 * → longueur.
 */
export function validerPlanificationTache(
  input: PlanificationTacheInput,
  maintenant: number,
): ValidationPlanification {
  // ① INSTRUCTION : une tâche sans instruction réveillerait un worker pour rien.
  const brut = typeof input.instruction === "string" ? input.instruction : "";
  const instruction = brut.replace(/\r\n?/g, "\n").trim();
  if (instruction === "") return { ok: false, raison: RAISON_INSTRUCTION_VIDE };

  // ② HEURE : mêmes formes que `programmer_envoi` (même parseur, même fuseau).
  const heure = analyserQuand(input.quand, maintenant);
  if (!heure.ok) return { ok: false, raison: heure.raison };

  // ③ BORNES : passé refusé (une ISO datée), puis 30 s de marge, puis 30 jours.
  const delai = heure.at - maintenant;
  if (delai < 0) return { ok: false, raison: RAISON_TACHE_PASSEE(formaterInstantEnvoi(heure.at)) };
  if (delai < DELAI_MIN_MS) {
    return { ok: false, raison: RAISON_TACHE_DELAI_MIN(Math.floor(delai / 1000)) };
  }
  if (delai > HORIZON_MAX_MS) {
    return { ok: false, raison: RAISON_TACHE_HORIZON(Math.ceil(delai / 86_400_000)) };
  }

  // ④ LONGUEUR : ce qui est persisté est ce qui sera transmis ; on refuse AVANT de
  // tronquer (une tâche tronquée ferait autre chose que ce qui a été demandé).
  if (instruction.length > MAX_INSTRUCTION_TACHE_CHARS) {
    return { ok: false, raison: RAISON_INSTRUCTION_TROP_LONGUE(instruction.length) };
  }

  return {
    ok: true,
    at: heure.at,
    quandLisible: formaterInstantEnvoi(heure.at, FUSEAU_ENVOIS),
    instruction,
    libelle: libelleDeTache(input.nom, instruction),
    fuseau: FUSEAU_ENVOIS,
  };
}

/**
 * Libellé d'une tâche : celui demandé, sinon les premiers mots de l'instruction.
 * ⚠️ Une PREMIÈRE ligne d'instruction (« Génère une image… ») est un bien meilleur nom
 * qu'un horodatage : c'est ce que la page de gestion affichera.
 */
export function libelleDeTache(nom: unknown, instruction: string): string {
  const demande = typeof nom === "string" ? nom.trim().replace(/\s+/gu, " ") : "";
  const base = demande !== "" ? demande : instruction.split(/\r?\n/u)[0] ?? instruction;
  const propre = base.trim().replace(/\s+/gu, " ");
  const coupe =
    propre.length > MAX_LIBELLE_TACHE_CHARS
      ? `${propre.slice(0, MAX_LIBELLE_TACHE_CHARS - 1).trimEnd()}…`
      : propre;
  return coupe === "" ? "Tâche planifiée" : coupe;
}

/**
 * TÂCHE transmise au worker lourd pour une tâche PONCTUELLE.
 *
 * ⚠️ Différente de `tacheDeDeclencheur` (surveillance récurrente) sur trois points :
 *  - il n'y a pas de `RIEN` : une tâche a été DEMANDÉE, son résultat doit être dit (même
 *    « rien à signaler » est une réponse, pas un silence) ;
 *  - il n'y a pas de `DÉSACTIVER` : une tâche ponctuelle s'éteint APRÈS son tir, il n'y a
 *    rien à éteindre ;
 *  - l'absence de PRÉ-AUTORISATION est dite AVANT l'action, pour que le worker n'essaie
 *    pas `run_command` puis ne reste pas bloqué.
 */
export function tachePonctuelle(input: {
  nom: string;
  libelle: string;
  instruction: string;
  quand: string;
}): string {
  return [
    `Tu exécutes la TÂCHE PLANIFIÉE « ${input.libelle} » (${input.nom}), demandée pour le ${input.quand}.`,
    "Tu l'exécutes en TÂCHE DE FOND : personne n'attend devant l'écran, et cette tâche ne se",
    "rejouera pas — elle s'éteint dès qu'elle est terminée.",
    "",
    "Instruction de l'utilisateur :",
    input.instruction,
    "",
    "Règles de réponse :",
    "- ta réponse est publiée TELLE QUELLE dans la conversation qui a demandé la tâche",
    "  (pas de préambule, pas de politesses) : dis ce qui a été FAIT et ce qui a échoué ;",
    "- si le résultat produit des FICHIERS (image, document), ils sont joints automatiquement ;",
    "- ⚠️ cette tâche n'a AUCUNE pré-autorisation : une action qui exige une approbation",
    "  humaine (`run_command` sur une machine appairée) ÉCHOUERA proprement. Si tu en as",
    "  besoin, dis-le clairement à la place, ne reste pas bloquée et n'invente pas un succès.",
  ].join("\n");
}
