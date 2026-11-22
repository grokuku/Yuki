/**
 * RÉCURRENCE demandée par le MODÈLE (`planifier_tache`, récurrences) — traduction en
 * DÉCLENCHEUR DURABLE existant.
 *
 * ⚠️ POURQUOI UNE TRADUCTION, ET PAS UN SECOND MÉCANISME : une récurrence créée par le
 * modèle devient un `SourceRecord` de type `planning` — le MÊME objet qu'un déclencheur
 * durable créé dans l'interface. Elle hérite donc gratuitement du cron évalué dans le
 * fuseau, du balayeur unique, du plafond d'exécution, du garde-fou quotidien, des quotas
 * (`MAX_SOURCES`), de la fin de récurrence (`occurrencesMax` / `jusquAu`), de la page de
 * gestion (visible ET modifiable) et du journal. Un second ordonnanceur aurait été une
 * deuxième source de vérité sur l'heure.
 *
 * ⚠️ QUATRE FORMES, ET RIEN D'AUTRE : `tous_les_jours` (HH:MM), `chaque_semaine`
 * (jour + HH:MM), `toutes_les_heures` (N, 1–24) et `tous_les_mois` (jour du mois +
 * HH:MM). Ce sont les quatre demandes réelles (« tous les jours à 8 h », « tous les
 * lundis 9 h », « toutes les 6 heures », « le 1ᵉʳ du mois 10 h »). Le modèle ne compose
 * PAS d'expression cron : il choisit une forme, et c'est ici que la traduction est
 * tenue (un modèle qui écrirait `*\/7 * * * *` produirait un cron faux sans le savoir).
 *
 * Module PUR (aucune I/O, aucun SDK) : la traduction et les refus sont testables seuls.
 */

import { validateFuseau } from "./cron.js";
import { DEFAULT_FUSEAU } from "./types.js";

/** Les quatre formes acceptées (⚠️ discriminées par `type`). */
export type RecurrenceDemandee =
  | { type: "tous_les_jours"; heure: string }
  | { type: "chaque_semaine"; jour: string | number; heure: string }
  | { type: "toutes_les_heures"; heures: number }
  | { type: "tous_les_mois"; jourDuMois: number; heure: string };

/** Récurrence VALIDÉE : une expression cron prête pour le déclencheur durable. */
export interface RecurrenceValidee {
  /** Expression cron à 5 champs (`src/sources/cron.ts` la revalide au stockage). */
  expression: string;
  /** Fuseau d'évaluation (jamais celui du processus). */
  fuseau: string;
  /** Formulation FRANÇAISE de la récurrence (« tous les jours à 08:00 »). */
  lisible: string;
}

/** Issue de la validation d'une récurrence. */
export type ValidationRecurrence =
  | ({ ok: true } & RecurrenceValidee)
  | { ok: false; raison: string };

/** Bornes de « toutes les N heures ». */
export const MIN_HEURES_RECURRENCE = 1;
export const MAX_HEURES_RECURRENCE = 24;

/**
 * Jours de la semaine acceptés (⚠️ `0` = dimanche, convention cron, et `7` aussi).
 * Les noms sont comparés SANS accent ni casse (`lundi`, `Lundi`, `LUNDI`).
 */
const JOURS: Readonly<Record<string, number>> = {
  dimanche: 0,
  lundi: 1,
  mardi: 2,
  mercredi: 3,
  jeudi: 4,
  vendredi: 5,
  samedi: 6,
};

/** Formes attendues, rappelées à chaque refus (le modèle peut se corriger seul). */
export const RECURRENCE_FORMES_ATTENDUES =
  "Formes acceptées : { type: \"tous_les_jours\", heure: \"08:00\" }, " +
  "{ type: \"chaque_semaine\", jour: \"lundi\", heure: \"09:00\" }, " +
  "{ type: \"toutes_les_heures\", heures: 6 } ou " +
  "{ type: \"tous_les_mois\", jourDuMois: 1, heure: \"10:00\" }.";

/** Retire les accents et la casse (`é` → `e`) pour comparer des noms saisis librement. */
function sansAccent(texte: string): string {
  return texte
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .trim()
    .toLowerCase();
}

/**
 * Analyse une heure `HH:MM` (formes réelles : `08:00`, `8:00`, `8h00`, `8 h 30`).
 *
 * ⚠️ On refuse plutôt que de deviner : une heure illisible produirait un cron faux
 * (donc une récurrence qui tire à la mauvaise heure, constatée des jours plus tard).
 */
function analyserHeure(brut: unknown): { heure: number; minute: number } | undefined {
  const texte = typeof brut === "string" ? brut.trim() : "";
  // ⚠️ `8 h` / `8h` (heure pleine, sans minutes) est la forme qu'on écrit réellement —
  // même tolérance que `analyserQuand` (`src/chat/envois/quand.ts`).
  const avecMinutes = /^(\d{1,2})\s*[:h]\s*(\d{1,2})$/u.exec(texte);
  const sansMinutes = /^(\d{1,2})\s*h$/u.exec(texte);
  const heure = Number(avecMinutes?.[1] ?? sansMinutes?.[1] ?? Number.NaN);
  const minute = avecMinutes ? Number(avecMinutes[2]) : 0;
  if (!avecMinutes && !sansMinutes) return undefined;
  if (!Number.isInteger(heure) || !Number.isInteger(minute)) return undefined;
  if (heure < 0 || heure > 23) return undefined;
  if (minute < 0 || minute > 59) return undefined;
  return { heure, minute };
}

/** Jour de la semaine (0 = dimanche) : nom français ou chiffre 0–7 (7 = dimanche). */
function analyserJour(brut: unknown): number | undefined {
  if (typeof brut === "number" && Number.isInteger(brut)) {
    return brut >= 0 && brut <= 7 ? brut % 7 : undefined;
  }
  const texte = sansAccent(typeof brut === "string" ? brut : "");
  if (texte === "") return undefined;
  if (/^\d$/u.test(texte)) {
    const nombre = Number(texte);
    return nombre >= 0 && nombre <= 7 ? nombre % 7 : undefined;
  }
  return JOURS[texte];
}

/** `08:00` (affichage normalisé, jamais `8:0`). */
function heureLisible(heure: number, minute: number): string {
  return `${String(heure).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** Noms de jours pour l'affichage (`0` = dimanche). */
const JOURS_LISIBLES: readonly string[] = [
  "dimanche",
  "lundi",
  "mardi",
  "mercredi",
  "jeudi",
  "vendredi",
  "samedi",
];

/**
 * Heures de tir de « toutes les N heures ».
 *
 * ⚠️ DÉCISION : la série est calée sur MINUIT LOCAL (0, N, 2N, … tant que < 24). Un
 * intervalle glissant « toutes les 6 h à partir de maintenant » n'est pas exprimable en
 * cron sans état, et un état dériverait au premier redémarrage. Le calage sur minuit est
 * donc DIT dans la formulation rendue (« à 00:00, 06:00, 12:00 et 18:00 »).
 */
function heuresDeLEcart(ecart: number): number[] {
  const heures: number[] = [];
  for (let heure = 0; heure < 24; heure += ecart) heures.push(heure);
  return heures;
}

/**
 * Valide une récurrence et la traduit en déclencheur durable (`planning`).
 *
 * ⚠️ Chaque refus NOMME la forme fautive et rappelle les formes acceptées : le modèle
 * doit pouvoir corriger son appel sans deviner.
 */
export function validerRecurrence(
  brut: unknown,
  fuseauDemande?: unknown,
): ValidationRecurrence {
  if (brut === null || typeof brut !== "object" || Array.isArray(brut)) {
    return {
      ok: false,
      raison: `Rien n'a été programmé : la récurrence est illisible. ${RECURRENCE_FORMES_ATTENDUES}`,
    };
  }
  const demande = brut as Record<string, unknown>;
  const type = typeof demande["type"] === "string" ? sansAccent(demande["type"] as string) : "";

  let fuseau: string;
  try {
    fuseau = validateFuseau(
      typeof fuseauDemande === "string" && fuseauDemande.trim() !== ""
        ? fuseauDemande
        : DEFAULT_FUSEAU,
      DEFAULT_FUSEAU,
    );
  } catch (error) {
    return { ok: false, raison: error instanceof Error ? error.message : String(error) };
  }

  if (type === "tous_les_jours") {
    const heure = analyserHeure(demande["heure"]);
    if (heure === undefined) {
      return {
        ok: false,
        raison:
          "Rien n'a été programmé : « tous_les_jours » demande une heure lisible " +
          `(\`heure\`: « 08:00 »). ${RECURRENCE_FORMES_ATTENDUES}`,
      };
    }
    return {
      ok: true,
      expression: `${heure.minute} ${heure.heure} * * *`,
      fuseau,
      lisible: `tous les jours à ${heureLisible(heure.heure, heure.minute)}`,
    };
  }

  if (type === "chaque_semaine") {
    const jour = analyserJour(demande["jour"]);
    if (jour === undefined) {
      return {
        ok: false,
        raison:
          "Rien n'a été programmé : « chaque_semaine » demande un jour lisible " +
          "(`jour`: « lundi » … « dimanche »). " +
          RECURRENCE_FORMES_ATTENDUES,
      };
    }
    const heure = analyserHeure(demande["heure"]);
    if (heure === undefined) {
      return {
        ok: false,
        raison:
          "Rien n'a été programmé : « chaque_semaine » demande une heure lisible " +
          `(\`heure\`: « 09:00 »). ${RECURRENCE_FORMES_ATTENDUES}`,
      };
    }
    return {
      ok: true,
      expression: `${heure.minute} ${heure.heure} * * ${jour}`,
      fuseau,
      lisible: `chaque ${JOURS_LISIBLES[jour]} à ${heureLisible(heure.heure, heure.minute)}`,
    };
  }

  if (type === "toutes_les_heures") {
    const ecart = typeof demande["heures"] === "number" ? demande["heures"] : Number.NaN;
    if (
      !Number.isInteger(ecart) ||
      ecart < MIN_HEURES_RECURRENCE ||
      ecart > MAX_HEURES_RECURRENCE
    ) {
      return {
        ok: false,
        raison:
          "Rien n'a été programmé : « toutes_les_heures » demande un entier de " +
          `${MIN_HEURES_RECURRENCE} à ${MAX_HEURES_RECURRENCE} (\`heures\`). ` +
          RECURRENCE_FORMES_ATTENDUES,
      };
    }
    const heures = heuresDeLEcart(ecart);
    const champ =
      ecart === 1 ? "*" : heures.map((heure) => String(heure)).join(",");
    return {
      ok: true,
      expression: `0 ${champ} * * *`,
      fuseau,
      lisible:
        ecart === 1
          ? "toutes les heures (à la minute 0)"
          : `toutes les ${ecart} heures (à ${heures
              .map((heure) => `${String(heure).padStart(2, "0")}:00`)
              .join(", ")})`,
    };
  }

  if (type === "tous_les_mois") {
    const jour = typeof demande["jourDuMois"] === "number" ? demande["jourDuMois"] : Number.NaN;
    if (!Number.isInteger(jour) || jour < 1 || jour > 31) {
      return {
        ok: false,
        raison:
          "Rien n'a été programmé : « tous_les_mois » demande un jour du mois de 1 à 31 " +
          "(`jourDuMois`). " +
          RECURRENCE_FORMES_ATTENDUES,
      };
    }
    const heure = analyserHeure(demande["heure"]);
    if (heure === undefined) {
      return {
        ok: false,
        raison:
          "Rien n'a été programmé : « tous_les_mois » demande une heure lisible " +
          `(\`heure\`: « 10:00 »). ${RECURRENCE_FORMES_ATTENDUES}`,
      };
    }
    return {
      ok: true,
      expression: `${heure.minute} ${heure.heure} ${jour} * *`,
      fuseau,
      lisible:
        `le ${jour} de chaque mois à ${heureLisible(heure.heure, heure.minute)}` +
        // ⚠️ Dit franchement : les mois courts n'ont pas de 31.
        (jour > 28 ? " (⚠️ les mois qui n'ont pas ce jour-là sont sautés)" : ""),
    };
  }

  return {
    ok: false,
    raison:
      `Rien n'a été programmé : type de récurrence inconnu (« ${String(demande["type"])} »). ` +
      RECURRENCE_FORMES_ATTENDUES,
  };
}
