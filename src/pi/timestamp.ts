/**
 * Repère temporel — POINT DE VÉRITÉ UNIQUE du formatage des dates et heures.
 * Module PUR (aucun import SDK, aucune I/O).
 *
 * Le modèle ne connaît NI la date NI l'heure : la base du prompt système et les
 * extensions inline n'injectent aucun contexte temporel. On préfixe donc le
 * texte STOCKÉ de chaque message utilisateur par un repère lisible :
 *
 *     [horodatage] YYYY-MM-DD HH:mm (UTC)
 *
 * ⚠️ RÈGLE (2026-11-04, « tous les horodatages en UTC ») : TOUT horodatage —
 * affiché dans l'interface, journalisé, ou transmis au modèle — est rendu dans
 * le fuseau du réglage `ui.timeZone` (`src/config/schema.ts`), dont le défaut
 * est **UTC**. Mattermost (le canal avec lequel on doit corréler les messages)
 * est en UTC : deux fuseaux pour un même événement rendaient la corrélation
 * impossible.
 *
 * ⚠️ Le fuseau du PROCESS n'est JAMAIS utilisé : `timeZone` est passé
 * EXPLICITEMENT à chaque `Intl.DateTimeFormat`. Un conteneur peut tourner en
 * UTC ou non selon l'image ; s'appuyer sur lui rendait le rendu dépendant de
 * l'hôte (le piège qui a déjà mordu). `TZ` peut être changé : rien ne bouge.
 *
 * ⚠️ Le SUFFIXE est TOUJOURS affiché (`(UTC)`, `(Europe/Paris)`) : une heure
 * seule est ambiguë dès qu'un autre fuseau peut apparaître (canal distant,
 * copier-coller, journal).
 *
 * ⚠️ EXCEPTION ASSUMÉE : la PLANIFICATION (`src/sources/cron.ts`,
 * `src/chat/envois/quand.ts`) interprète « tous les jours à 9 h » dans le
 * fuseau PROPRE de chaque déclencheur. Rien ici ne la concerne : ces modules
 * passent leur `timeZone` explicitement et ne passent pas par ces fonctions.
 */

/** Fuseau de référence : la valeur par défaut du réglage `ui.timeZone`. */
export const DEFAULT_TIME_ZONE = "UTC";

/** Locale technique produisant la forme ISO `YYYY-MM-DD` (chiffres latins). */
const COMPACT_LOCALE = "en-CA";

/** Locale d'affichage français (jour/mois/année, 24 h). */
const DISPLAY_LOCALE = "fr-FR";

const COMPACT_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  // `h23` évite le piège minuit = « 24 » de certaines implémentations.
  hourCycle: "h23",
};

const DISPLAY_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
};

/** Le repère tel qu'il apparaît en clair dans le texte stocké. */
export const TIMESTAMP_MARKER = "horodatage";

/**
 * Motif du préfixe en TÊTE de texte (ancré). Sert à le MASQUER à l'affichage
 * tout en le conservant en stockage.
 *
 * ⚠️ Les messages STOCKÉS AVANT le passage à l'UTC portent `(heure locale)` :
 * ils restent reconnus (aucune migration destructive des sessions ni de la
 * mémoire). Un préfixe neuf porte `(UTC)` ou `(<fuseau IANA>)`.
 */
export const TIMESTAMP_PREFIX_RE =
  /^\[horodatage\] \d{4}-\d{2}-\d{2} \d{2}:\d{2} \((?:heure locale|[A-Za-z][A-Za-z0-9_+\-/]*)\)/;

/** `true` si le fuseau IANA est accepté par `Intl` (sinon `Intl` lève). */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat(COMPACT_LOCALE, { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalise un fuseau candidat : renvoie le nom s'il est non vide ET valide,
 * sinon `undefined` (⇒ l'appelant décide, jamais le fuseau du process).
 */
export function resolveTimeZone(
  candidate?: string | null,
): string | undefined {
  const value = typeof candidate === "string" ? candidate.trim() : "";
  if (value.length > 0 && isValidTimeZone(value)) return value;
  return undefined;
}

/**
 * Fuseau EFFECTIF d'un rendu : le candidat s'il est valide, sinon `UTC`.
 *
 * ⚠️ C'est LA fonction à appeler partout (prompts, interface, journal) : il
 * n'existe aucun chemin qui retombe sur le fuseau du process.
 */
export function effectiveTimeZone(candidate?: string | null): string {
  return resolveTimeZone(candidate) ?? DEFAULT_TIME_ZONE;
}

/** Formateur explicite pour un fuseau (jamais de repli sur le process). */
function formatter(
  timeZone: string | undefined,
  options: Intl.DateTimeFormatOptions,
  locale: string,
): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(locale, {
    ...options,
    timeZone: effectiveTimeZone(timeZone),
  });
}

/** Parties d'une date dans le fuseau EFFECTIF (jamais celui du process). */
function partsOf(
  date: Date,
  timeZone: string | undefined,
  options: Intl.DateTimeFormatOptions,
  locale: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of formatter(timeZone, options, locale).formatToParts(date)) {
    if (part.type !== "literal") out[part.type] = part.value;
  }
  return out;
}

/**
 * Date + heure au format compact `YYYY-MM-DD HH:mm` (ex. `2026-10-08 15:39`).
 * `timeZone` absent ⇒ `UTC` (jamais le fuseau du process).
 */
export function formatCompactDateTime(date: Date, timeZone?: string): string {
  const parts = partsOf(date, timeZone, COMPACT_OPTIONS, COMPACT_LOCALE);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/**
 * Date + heure lisibles en français, TOUJOURS suffixées du fuseau :
 * `08/10/2026 15:39 UTC`. Sert aux affichages (interface, rapports, journal).
 * `timeZone` absent ⇒ `UTC`.
 */
export function formatDateTimeFr(date: Date, timeZone?: string): string {
  const zone = effectiveTimeZone(timeZone);
  const parts = partsOf(date, zone, DISPLAY_OPTIONS, DISPLAY_LOCALE);
  return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute} ${zone}`;
}

/** Heure seule `HH:mm UTC` (métadonnée de message) ; `timeZone` absent ⇒ `UTC`. */
export function formatHourFr(date: Date, timeZone?: string): string {
  const zone = effectiveTimeZone(timeZone);
  const parts = partsOf(
    date,
    zone,
    { hour: "2-digit", minute: "2-digit", hourCycle: "h23" },
    DISPLAY_LOCALE,
  );
  return `${parts.hour}:${parts.minute} ${zone}`;
}

/**
 * Date seule en français (`dimanche 8 octobre 2026`), sans suffixe de fuseau :
 * un séparateur de jour ne porte pas d'heure. `timeZone` absent ⇒ `UTC`.
 */
export function formatDayFr(date: Date, timeZone?: string): string {
  return formatter(
    timeZone,
    { weekday: "long", day: "numeric", month: "long", year: "numeric" },
    DISPLAY_LOCALE,
  ).format(date);
}

/**
 * Clé de jour (`YYYY-MM-DD`) dans le fuseau EFFECTIF : deux instants ont la
 * même clé s'ils tombent le même jour DANS CE FUSEAU.
 */
export function dayKeyOf(date: Date, timeZone?: string): string {
  const parts = partsOf(date, timeZone, COMPACT_OPTIONS, COMPACT_LOCALE);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * Préfixe complet, tel qu'il sera STOCKÉ puis affiché par le modèle :
 * `[horodatage] YYYY-MM-DD HH:mm (UTC)`.
 */
export function buildTimestampPrefix(date: Date, timeZone?: string): string {
  return `[horodatage] ${formatCompactDateTime(date, timeZone)} (${effectiveTimeZone(timeZone)})`;
}

export interface StoredUserTextOptions {
  /** Instant de l'envoi (préfixe calculé sur CET instant). */
  at: Date;
  /** Fuseau du réglage `ui.timeZone` ; absent/invalide ⇒ `UTC`. */
  timeZone?: string;
  /**
   * `true` pour un prompt SYNTHÉTIQUE (report de job d'arrière-plan) : il n'est
   * jamais horodaté (il ne correspond à aucun message utilisateur).
   */
  synthetic?: boolean;
}

/**
 * Texte RÉELLEMENT transmis au SDK (donc STOCKÉ dans la session) : le message
 * utilisateur préfixé de son repère temporel. Un prompt synthétique est renvoyé
 * INCHANGÉ.
 */
export function buildStoredUserText(
  text: string,
  options: StoredUserTextOptions,
): string {
  if (options.synthetic) return text;
  return `${buildTimestampPrefix(options.at, options.timeZone)} ${text}`;
}

/**
 * Retire le préfixe temporel d'un texte (affichage). Un texte sans préfixe est
 * renvoyé inchangé (tolérant : messages d'avant l'horodatage).
 */
export function stripTimestampPrefix(text: string): string {
  const match = TIMESTAMP_PREFIX_RE.exec(text);
  if (!match) return text;
  const rest = text.slice(match[0].length);
  return rest.startsWith(" ") ? rest.slice(1) : rest;
}
