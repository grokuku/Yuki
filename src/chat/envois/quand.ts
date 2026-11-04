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
    }
  | { ok: false; raison: string };

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

/** `16:10` · `16:10:30` (heure locale du jour). */
const HEURE_SEULE = /^(\d{1,2})[:h](\d{2})(?::(\d{2}))?$/u;

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
  "(« 16:10 » pour aujourd'hui, ou une date ISO comme « 2026-11-04T16:10:00+01:00 »).";

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

  // ④ HEURE SEULE : aujourd'hui (dans le fuseau de Yuki).
  const heureSeule = HEURE_SEULE.exec(minuscule);
  if (heureSeule) {
    const aujourdhui = partiesLocales(maintenant, FUSEAU_ENVOIS);
    const heure = Number.parseInt(heureSeule[1] ?? "", 10);
    const minute = Number.parseInt(heureSeule[2] ?? "", 10);
    const seconde = heureSeule[3] === undefined ? 0 : Number.parseInt(heureSeule[3], 10);
    return instantLocal(
      aujourdhui.annee,
      aujourdhui.mois,
      aujourdhui.jour,
      heure,
      minute,
      seconde,
      texte,
      "heure",
    );
  }

  return { ok: false, raison: `Heure incompréhensible : « ${texte} ». ${QUAND_FORMES_ATTENDUES}` };
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
