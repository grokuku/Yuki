/**
 * INTERPRÉTATION de l'argument `quand` d'un envoi programmé — module PUR, testable.
 *
 * ⚠️ DÉCISION (lot 28) : **DEUX formes acceptées**, pas une.
 *
 *  1. **Un DÉLAI RELATIF** — `dans 30 min`, `dans 2 h`, `dans 90 s`, `dans 3 jours`.
 *     C'est la forme la plus ROBUSTE pour un modèle : elle ne demande aucun calcul de
 *     date, aucun raisonnement de fuseau, aucun changement de jour. « dans 45 minutes »
 *     ne peut pas se tromper d'heure.
 *  2. **Un INSTANT ABSOLU** — ISO 8601 avec décalage explicite
 *     (`2026-11-04T16:10:00+01:00`, `…Z`) quand la personne a donné une heure précise
 *     (« poste à 16h10 »), ou `16:10` seul (heure locale du jour).
 *
 * ⚠️ LOT 31 — LA RÈGLE DE L'HEURE SEULE (elle manquait) : une heure seule DÉJÀ PASSÉE
 * désigne la PROCHAINE occurrence, donc DEMAIN. Avant, `analyserQuand("00:00")` à 17 h
 * rendait aujourd'hui minuit ⇒ « déjà passé » ⇒ refus : exactement l'exemple d'une
 * demande récurrente (« tous les jours à minuit ») qui échouait. Le report est SIGNALÉ
 * (`reporte: true`) et la confirmation rendue porte la DATE COMPLÈTE, donc la personne
 * voit qu'il s'agit de demain.
 * ⚠️ Une ISO DATÉE dans le passé, elle, reste REFUSÉE : elle nomme un jour précis.
 * ⚠️ Les jours relatifs (`demain`, `après-demain`) sont acceptés devant une heure.
 *
 * ⚠️ Le refus d'ISO SANS décalage n'aurait servi à rien : le modèle écrit rarement
 * `+01:00`. Une ISO nue (`2026-11-04T16:10`) est donc interprétée dans le fuseau de
 * Yuki (`FUSEAU_ENVOIS`) — et le RÉSULTAT rendu au modèle porte l'instant effectif
 * avec son fuseau, donc l'ambiguïté est LEVÉE, pas cachée.
 *
 * ⚠️ LE FUSEAU N'EST JAMAIS CELUI DU PROCESSUS : en conteneur il est en UTC, et
 * « 16h10 » deviendrait « 18h10 » à Paris (le piège est documenté dans
 * `src/sources/cron.ts:21-22`). On réutilise donc l'outillage de fuseaux du moteur
 * horloge (`validateFuseau`, `partiesLocales`, `instantsDeLHeureLocale`).
 */

import { instantsDeLHeureLocale, partiesLocales, validateFuseau } from "../../sources/cron.js";

/**
 * Fuseau par défaut des envois programmés : **le même que celui des déclencheurs**
 * (`src/sources/cron.ts:368`, `Europe/Paris`).
 */
export const FUSEAU_ENVOIS = "Europe/Paris";

/** Instant résolu, ou raison LISIBLE du refus. */
export type AnalyseQuand =
  | {
      ok: true;
      /** Instant voulu (ms epoch). */
      at: number;
      /** Forme reconnue, pour le journal et les tests. */
      forme: "relatif" | "iso" | "heure";
      /**
       * ⚠️ LOT 31 — `true` quand une HEURE SEULE, déjà passée aujourd'hui, a été
       * reportée au LENDEMAIN (« à 8 h » demandé à 17 h ⇒ demain 8 h). Le report est
       * DIT dans le résultat : la confirmation rendue porte la DATE COMPLÈTE, donc la
       * personne qui lit voit qu'il s'agit de demain, pas d'aujourd'hui.
       */
      reporte?: true;
      /** Jour RELATIF explicitement demandé (« demain », « après-demain »). */
      jourRelatif?: JourRelatif;
    }
  | { ok: false; raison: string };

/** Jour relatif accepté devant une heure (`demain à 8 h`, `après-demain 18:00`). */
export type JourRelatif = "demain" | "apres-demain";

/** Durée d'une unité relative, en millisecondes (⚠️ `j` = jour, jamais un mois). */
const UNITES: Readonly<Record<string, number>> = {
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  seconde: 1_000,
  secondes: 1_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  heure: 3_600_000,
  heures: 3_600_000,
  j: 86_400_000,
  jour: 86_400_000,
  jours: 86_400_000,
};

/** `dans 30 min` · `dans 2h` · `dans 1 heure` · `dans 3 jours`. */
const RELATIF = /^dans\s+(\d{1,6})\s*([a-zé]+)$/u;

/**
 * `16:10` · `16:10:30` · `16h10` · `8 h` · `8h` (heure locale du jour).
 *
 * ⚠️ LOT 31 : l'espace autour du séparateur et l'heure SANS minutes (« 8 h », la
 * forme que les gens écrivent réellement) sont acceptées — `demain à 8 h` échouait
 * jusqu'ici, alors que c'est l'exemple le plus courant.
 */
const HEURE_SEULE = /^(\d{1,2})\s*[:h]\s*(\d{1,2})(?:\s*:\s*(\d{1,2}))?$/u;

/** `8 h` · `8h` : heure pleine, sans minutes. */
const HEURE_SANS_MINUTE = /^(\d{1,2})\s*h$/u;

/**
 * `demain …` · `après-demain …` suivi d'une heure (« demain à 8 h », « après-demain
 * 18:00 »). ⚠️ Le préfixe ne s'applique QU'À une heure : « demain » tout seul n'est pas
 * un instant (on demande alors l'heure au lieu de deviner).
 */
const JOUR_RELATIF_PREFIXE =
  /^(demain|apr[eè]s[\s-]demain)\s*(?:à\s+|a\s+|vers\s+|pour\s+)?(.+)$/u;

/**
 * `2026-11-04T16:10[:30]` — ISO SANS décalage (interprétée dans `FUSEAU_ENVOIS`).
 *
 * ⚠️ `[Tt]` : un modèle écrit parfois `t` en minuscule. On ne met PAS tout en
 * minuscule (`toLowerCase`) pour autant — cela casserait le `T`/`Z` des ISO avec
 * décalage, que `Date.parse` exige en majuscule (piège constaté en écrivant ce lot).
 */
const ISO_NUE = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{1,2}):(\d{2})(?::(\d{2}))?$/u;

/** `…Z` ou `…+01:00` — ISO AVEC décalage explicite (aucune ambiguïté possible). */
const ISO_DECALEE =
  /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?(?:[Zz]|[+-]\d{2}:?\d{2})$/u;

/** Message UNIQUE de forme attendue (le modèle le recopie rarement, mais il est juste). */
export const QUAND_FORMES_ATTENDUES =
  "Indique un DÉLAI (« dans 30 min », « dans 2 h », « dans 3 jours ») ou une HEURE " +
  "(« 16:10 » — aujourd'hui, ou DEMAIN si cette heure est déjà passée —, " +
  "« demain à 8 h », « après-demain 18:00 », ou une date ISO comme " +
  "« 2026-11-04T16:10:00+01:00 »).";

/**
 * Résout `quand` en instant absolu.
 *
 * ⚠️ Aucune exception : toute forme non reconnue rend une raison en français qui
 * NOMME les formes acceptées — c'est ce qui permet au modèle de corriger son appel
 * au lieu de renoncer.
 */
export function analyserQuand(brut: unknown, maintenant: number): AnalyseQuand {
  const texte = typeof brut === "string" ? brut.trim().replace(/\s+/gu, " ") : "";
  if (texte === "") {
    return { ok: false, raison: `Aucune heure n'a été donnée. ${QUAND_FORMES_ATTENDUES}` };
  }
  // ⚠️ La comparaison des UNITÉS et de l'heure seule se fait en minuscules ; les ISO
  // sont lues sur le texte ORIGINAL (voir `ISO_NUE`).
  const minuscule = texte.toLowerCase();

  // ① DÉLAI RELATIF — la forme la plus robuste, évaluée en premier.
  const relatif = RELATIF.exec(minuscule);
  if (relatif) {
    const nombre = Number.parseInt(relatif[1] ?? "", 10);
    const unite = relatif[2] ?? "";
    const duree = UNITES[unite];
    if (!Number.isFinite(nombre) || duree === undefined) {
      return {
        ok: false,
        raison:
          `Unité de temps inconnue : « ${unite} ». Utilise s (secondes), min ` +
          "(minutes), h (heures) ou j (jours).",
      };
    }
    return { ok: true, at: maintenant + nombre * duree, forme: "relatif" };
  }

  // ② ISO AVEC décalage : `Date.parse` suffit (l'instant est absolu).
  if (ISO_DECALEE.test(texte)) {
    const at = Date.parse(normaliserIso(texte));
    if (!Number.isFinite(at)) {
      return { ok: false, raison: `Cette date n'existe pas : « ${texte} ». ${QUAND_FORMES_ATTENDUES}` };
    }
    return { ok: true, at, forme: "iso" };
  }

  // ③ ISO NUE : interprétée dans le fuseau de Yuki (jamais celui du processus).
  const isoNue = ISO_NUE.exec(texte);
  if (isoNue) {
    const annee = Number.parseInt(isoNue[1] ?? "", 10);
    const mois = Number.parseInt(isoNue[2] ?? "", 10);
    const jour = Number.parseInt(isoNue[3] ?? "", 10);
    const heure = Number.parseInt(isoNue[4] ?? "", 10);
    const minute = Number.parseInt(isoNue[5] ?? "", 10);
    const seconde = isoNue[6] === undefined ? 0 : Number.parseInt(isoNue[6], 10);
    return instantLocal(annee, mois, jour, heure, minute, seconde, texte, "iso");
  }

  // ④ JOUR RELATIF + HEURE : « demain à 8 h », « après-demain 18:00 ».
  const relatifJour = JOUR_RELATIF_PREFIXE.exec(minuscule);
  if (relatifJour) {
    const jourRelatif: JourRelatif = relatifJour[1]?.startsWith("demain")
      ? "demain"
      : "apres-demain";
    const heureDemandee = lireHeure(relatifJour[2] ?? "");
    if (heureDemandee === undefined) {
      return {
        ok: false,
        raison:
          `Heure incompréhensible après « ${relatifJour[1] ?? ""} » : « ${texte} ». ` +
          "Écris par exemple « demain à 8 h » ou « après-demain 18:30 ».",
      };
    }
    const jour = decalerJours(
      partiesLocales(maintenant, FUSEAU_ENVOIS),
      jourRelatif === "demain" ? 1 : 2,
    );
    const issue = instantLocal(
      jour.annee,
      jour.mois,
      jour.jour,
      heureDemandee.heure,
      heureDemandee.minute,
      heureDemandee.seconde,
      texte,
      "heure",
    );
    return issue.ok ? { ...issue, jourRelatif } : issue;
  }
  // « demain » tout seul : on ne devine PAS l'heure, on la demande.
  if (minuscule === "demain" || /^apr[eè]s[\s-]demain$/u.test(minuscule)) {
    return {
      ok: false,
      raison:
        `Précise l'HEURE de « ${texte} » (par exemple « demain à 8 h » ou ` +
        "« demain 18:30 »). ",
    };
  }

  // ⑤ HEURE SEULE : aujourd'hui — ou DEMAIN si cette heure est déjà passée.
  const heureSeule = lireHeure(minuscule);
  if (heureSeule !== undefined) {
    const aujourdhui = partiesLocales(maintenant, FUSEAU_ENVOIS);
    const issue = instantLocal(
      aujourdhui.annee,
      aujourdhui.mois,
      aujourdhui.jour,
      heureSeule.heure,
      heureSeule.minute,
      heureSeule.seconde,
      texte,
      "heure",
    );
    if (!issue.ok) return issue;
    // ⚠️ LOT 31 — L'HEURE SEULE DÉJÀ PASSÉE VAUT DEMAIN, jamais un refus :
    // `analyserQuand("00:00")` à 17 h rendait aujourd'hui minuit ⇒ « déjà passé » ⇒
    // refus. Une heure seule est la forme NATURELLE d'une demande récurrente
    // (« tous les jours à 8 h ») : elle doit désigner la PROCHAINE occurrence.
    // ⚠️ Une ISO DATÉE dans le passé reste refusée (elle dit un jour précis : la
    // reporter changerait EN SILENCE ce que la personne a demandé).
    if (issue.at > maintenant) return issue;
    const demain = decalerJours(aujourdhui, 1);
    const reportee = instantLocal(
      demain.annee,
      demain.mois,
      demain.jour,
      heureSeule.heure,
      heureSeule.minute,
      heureSeule.seconde,
      texte,
      "heure",
    );
    return reportee.ok ? { ...reportee, reporte: true } : reportee;
  }

  return { ok: false, raison: `Heure incompréhensible : « ${texte} ». ${QUAND_FORMES_ATTENDUES}` };
}

/** Heure locale lue dans un texte borné, ou `undefined`. */
function lireHeure(texte: string): { heure: number; minute: number; seconde: number } | undefined {
  const avecMinutes = HEURE_SEULE.exec(texte.trim());
  if (avecMinutes) {
    return {
      heure: Number.parseInt(avecMinutes[1] ?? "", 10),
      minute: Number.parseInt(avecMinutes[2] ?? "", 10),
      seconde: avecMinutes[3] === undefined ? 0 : Number.parseInt(avecMinutes[3], 10),
    };
  }
  const pleine = HEURE_SANS_MINUTE.exec(texte.trim());
  if (pleine) return { heure: Number.parseInt(pleine[1] ?? "", 10), minute: 0, seconde: 0 };
  return undefined;
}

/**
 * Décale une date LOCALE de `jours` jours, sur le CALENDRIER (jamais en ajoutant
 * 86 400 000 ms : le jour du changement d'heure dure 23 ou 25 h, et « demain »
 * deviendrait « aujourd'hui » à 00 h 30 le jour du retour à l'heure d'hiver).
 */
function decalerJours(
  jour: { annee: number; mois: number; jour: number },
  jours: number,
): { annee: number; mois: number; jour: number } {
  const decale = new Date(Date.UTC(jour.annee, jour.mois - 1, jour.jour + jours));
  return {
    annee: decale.getUTCFullYear(),
    mois: decale.getUTCMonth() + 1,
    jour: decale.getUTCDate(),
  };
}

/** `t`/`z` minuscules remis en majuscules pour `Date.parse` (les chiffres intacts). */
function normaliserIso(texte: string): string {
  return texte.replace(/[Tt]/u, "T").replace(/[Zz]$/u, "Z");
}

/**
 * Instant d'une heure LOCALE dans `FUSEAU_ENVOIS`.
 *
 * ⚠️ Deux cas réels traités explicitement :
 *  - **heure inexistante** (passage à l'heure d'été : 2 h 30 n'existe pas ce
 *    jour-là) ⇒ refus qui propose 3 h — jamais un instant décalé en silence ;
 *  - **heure répétée** (retour à l'heure d'hiver : 2 h 30 a lieu deux fois) ⇒ on
 *    retient le PREMIER, et on le dit dans le résultat (l'instant effectif est rendu).
 */
function instantLocal(
  annee: number,
  mois: number,
  jour: number,
  heure: number,
  minute: number,
  seconde: number,
  source: string,
  forme: "iso" | "heure",
): AnalyseQuand {
  if (mois < 1 || mois > 12 || jour < 1 || jour > 31) {
    return {
      ok: false,
      raison: `Cette date n'existe pas : « ${source} ». ${QUAND_FORMES_ATTENDUES}`,
    };
  }
  if (heure > 23 || minute > 59 || seconde > 59) {
    return {
      ok: false,
      raison:
        `Cette heure n'existe pas : « ${source} » (heures 00-23, minutes et secondes ` +
        "00-59).",
    };
  }
  // `instantsDeLHeureLocale` ignore les secondes : on les ajoute après.
  const instants = instantsDeLHeureLocale(annee, mois, jour, heure, minute, FUSEAU_ENVOIS);
  const premier = instants[0];
  if (premier === undefined) {
    // Le jour peut aussi être simplement impossible (31 février) : on le distingue
    // d'un trou d'heure d'été en regardant si la date existe à midi.
    const midi = instantsDeLHeureLocale(annee, mois, jour, 12, 0, FUSEAU_ENVOIS)[0];
    if (midi === undefined) {
      return {
        ok: false,
        raison: `Cette date n'existe pas : « ${source} ». ${QUAND_FORMES_ATTENDUES}`,
      };
    }
    return {
      ok: false,
      raison:
        `L'heure « ${heure}:${String(minute).padStart(2, "0")} » n'existe pas le ` +
        `${jour}/${mois}/${annee} dans le fuseau ${FUSEAU_ENVOIS} (changement d'heure). ` +
        "Choisis une autre heure.",
    };
  }
  return { ok: true, at: premier + seconde * 1_000, forme };
}

/**
 * Rendu LISIBLE d'un instant, dans le fuseau des envois — c'est CE TEXTE que le
 * modèle répète à la personne, et que la page de gestion affiche.
 *
 * ⚠️ Il porte toujours le fuseau (« 4 novembre 2026 à 16:10 (Europe/Paris) ») :
 * l'instant est absolu, mais le lecteur doit pouvoir vérifier qu'il s'agit bien de
 * SON heure.
 */
export function formaterInstantEnvoi(at: number, fuseau: string = FUSEAU_ENVOIS): string {
  const valide = fuseauValide(fuseau);
  const formateur = new Intl.DateTimeFormat("fr-FR", {
    timeZone: valide,
    dateStyle: "long",
    timeStyle: "short",
  });
  return `${formateur.format(new Date(at))} (${valide})`;
}

/** Fuseau retenu : `FUSEAU_ENVOIS` si le fourni est inconnu (jamais une exception ici). */
function fuseauValide(fuseau: string): string {
  try {
    return validateFuseau(fuseau, FUSEAU_ENVOIS);
  } catch {
    return FUSEAU_ENVOIS;
  }
}
