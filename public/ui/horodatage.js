/**
 * Horodatages de l'INTERFACE — miroir navigateur de `src/pi/timestamp.ts`.
 *
 * ⚠️ POURQUOI UN MIROIR : le navigateur ne peut pas importer du TypeScript, et le
 * projet n'a AUCUN bundler (`public/ui` est servi tel quel). Les RÈGLES sont donc
 * écrites deux fois — et un test les compare (`tests/ui/horodatage.test.ts`) :
 * mêmes instants, mêmes fuseaux, mêmes chaînes. Toute divergence casse le test.
 *
 * ⚠️ RÈGLE (2026-11-04, « tous les horodatages en UTC ») : TOUTES les dates de
 * l'interface sont rendues dans le fuseau du réglage `/config` `ui.timeZone`
 * (défaut `UTC`), JAMAIS dans celui du navigateur. C'est le fuseau du navigateur
 * qui faisait afficher une heure différente de Mattermost (UTC) pour le même
 * message.
 *
 * ⚠️ `timeZone` est passé EXPLICITEMENT à CHAQUE `Intl.DateTimeFormat` : sans
 * lui, l'implémentation retombe sur le fuseau du système — le piège qu'on ferme.
 *
 * ⚠️ Le fuseau courant vient du SERVEUR (`welcome.timeZone`, puis trame de
 * contrôle `time_zone`) : une seule autorité, appliquée à chaud.
 */

/** Fuseau de référence, identique à `DEFAULT_TIME_ZONE` (`src/pi/timestamp.ts`). */
export const DEFAULT_TIME_ZONE = "UTC";

/** Fuseau EFFECTIF courant (mis à jour par `setTimeZone`). */
let fuseauCourant = DEFAULT_TIME_ZONE;

/** `true` si `Intl` accepte ce fuseau (il LÈVE sur un nom inconnu). */
export function isValidTimeZone(candidate) {
  if (typeof candidate !== "string" || candidate.trim() === "") return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: candidate.trim() });
    return true;
  } catch {
    return false;
  }
}

/** Fuseau EFFECTIF d'une valeur : la valeur si elle est valide, sinon `UTC`. */
export function effectiveTimeZone(candidate) {
  return isValidTimeZone(candidate) ? String(candidate).trim() : DEFAULT_TIME_ZONE;
}

/** Fuseau courant de l'interface (jamais celui du navigateur). */
export function currentTimeZone() {
  return fuseauCourant;
}

/**
 * Fixe le fuseau de l'interface. Renvoie le fuseau EFFECTIF retenu : un nom
 * invalide ne casse rien, il retombe sur `UTC` (jamais une exception à l'écran).
 */
export function setTimeZone(candidate) {
  fuseauCourant = effectiveTimeZone(candidate);
  return fuseauCourant;
}

/** Formateur explicite : `timeZone` est TOUJOURS fourni. */
function formateur(options) {
  return new Intl.DateTimeFormat("fr-FR", { ...options, timeZone: fuseauCourant });
}

function partsOf(date, options) {
  const out = {};
  for (const part of formateur(options).formatToParts(date)) {
    if (part.type !== "literal") out[part.type] = part.value;
  }
  return out;
}

/**
 * Date + heure + fuseau : `08/10/2026 15:39 UTC`.
 *
 * ⚠️ Le suffixe est TOUJOURS présent : une heure seule est ambiguë dès qu'un
 * autre fuseau peut apparaître (canal distant en UTC, journal, copier-coller).
 */
export function formatDateTimeFr(date) {
  const p = partsOf(date, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute} ${fuseauCourant}`;
}

/** Heure seule : `15:39 UTC` (métadonnée d'un message du fil). */
export function formatHourFr(date) {
  const p = partsOf(date, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return `${p.hour}:${p.minute} ${fuseauCourant}`;
}

/** Jour + heure compacts : `08/10 15:39 UTC` (listes). */
export function formatDayMonthHourFr(date) {
  const p = partsOf(date, {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return `${p.day}/${p.month} ${p.hour}:${p.minute} ${fuseauCourant}`;
}

/** Date seule, longue : `dimanche 8 octobre 2026` (séparateur de jour). */
export function formatDayFr(date) {
  return formateur({
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

/** Date courte : `8 oct.` (listes de conversations). */
export function formatMonthDayFr(date) {
  return formateur({ day: "numeric", month: "short" }).format(date);
}

/**
 * Clé de jour `AAAA-MM-JJ` DANS LE FUSEAU COURANT : deux instants ont la même
 * clé s'ils tombent le même jour dans ce fuseau (comparaison des séparateurs).
 */
export function dayKeyOf(date) {
  const p = partsOf(date, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return `${p.year}-${p.month}-${p.day}`;
}

/** `true` si l'instant tombe le même jour que `reference` dans le fuseau courant. */
export function isSameDay(date, reference) {
  return dayKeyOf(date) === dayKeyOf(reference);
}

/**
 * Horodatage COMPACT `AAAAMMJJ-HHMMSS` DANS LE FUSEAU COURANT (`ui.timeZone`).
 *
 * Destiné aux NOMS FABRIQUÉS (`collé-AAAAMMJJ-HHMMSS.png`, cf.
 * `public/ui/clipboard-files.js`) : lisible tel quel et trié dans l'ordre
 * chronologique.
 *
 * ⚠️ POURQUOI ICI : le fuseau est fourni EXPLICITEMENT (`partsOf` passe
 * `timeZone` à chaque `Intl.DateTimeFormat`). Un nom d'image collée fabriqué
 * avec `getHours()` porterait l'heure LOCALE et contredirait l'horodatage UTC
 * affiché à côté — le piège qu'on ferme.
 *
 * @param {Date|number} date instant à rendre (un instant invalide ne produit
 *   jamais `NaN` dans un nom de fichier).
 * @returns {string} `AAAAMMJJ-HHMMSS`, ou `00000000-000000` si invalide.
 */
export function compactStampOf(date) {
  const at = date instanceof Date ? date : new Date(Number(date));
  if (Number.isNaN(at.getTime())) return "00000000-000000";
  const p = partsOf(at, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  return `${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}`;
}
