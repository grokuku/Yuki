/**
 * Repère temporel des messages — module PUR (aucun import SDK, aucune I/O).
 *
 * Le modèle ne connaît NI la date NI l'heure : la base du prompt système et les
 * extensions inline n'injectent aucun contexte temporel. On préfixe donc le
 * texte STOCKÉ de chaque message utilisateur par un repère lisible :
 *
 *     [horodatage] YYYY-MM-DD HH:mm (heure locale)
 *
 * Format STRICTEMENT identique à celui de Pi-Web (`buildDateContextContent`).
 * La mention « (heure locale) » est OBLIGATOIRE : sans elle, le modèle peut
 * supposer de l'UTC et calculer des écarts faux. L'ordre année-mois-jour rend
 * la date triable lexicographiquement.
 *
 * ⚠️ L'heure est celle du FUSEAU DEMANDÉ (celui du navigateur quand le client le
 * transmet), sinon celle du PROCESS Node. Un conteneur en UTC afficherait donc
 * une heure fausse : d'où la préférence pour le fuseau du client.
 */

/** Locale technique produisant la forme ISO `YYYY-MM-DD` (chiffres latins). */
const COMPACT_LOCALE = "en-CA";

const COMPACT_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  // `h23` évite le piège minuit = « 24 » de certaines implémentations.
  hourCycle: "h23",
};

/** Le repère tel qu'il apparaît en clair dans le texte stocké. */
export const TIMESTAMP_MARKER = "horodatage";

/**
 * Motif du préfixe en TÊTE de texte (ancré). Sert à le MASQUER à l'affichage
 * tout en le conservant en stockage.
 */
export const TIMESTAMP_PREFIX_RE =
  /^\[horodatage\] \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(heure locale\)/;

/** `true` si le fuseau IANA est accepté par `Intl` (sinon `Intl` lève). */
function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat(COMPACT_LOCALE, { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalise un fuseau candidat (ex. fourni par le navigateur) : renvoie le nom
 * s'il est non vide ET valide, sinon `undefined` (⇒ fuseau du process).
 */
export function resolveTimeZone(
  candidate?: string | null,
): string | undefined {
  const value = typeof candidate === "string" ? candidate.trim() : "";
  if (value.length > 0 && isValidTimeZone(value)) return value;
  return undefined;
}

/** Formateur compact pour un fuseau donné (repli silencieux si fuseau invalide). */
function compactFormatter(timeZone?: string): Intl.DateTimeFormat {
  const resolved = resolveTimeZone(timeZone);
  if (resolved) {
    return new Intl.DateTimeFormat(COMPACT_LOCALE, {
      ...COMPACT_OPTIONS,
      timeZone: resolved,
    });
  }
  return new Intl.DateTimeFormat(COMPACT_LOCALE, COMPACT_OPTIONS);
}

/**
 * Date + heure LOCALES au format compact `YYYY-MM-DD HH:mm` (ex. `2026-10-08 15:39`).
 * `timeZone` absent ⇒ fuseau du process Node.
 */
export function formatCompactDateTime(date: Date, timeZone?: string): string {
  const parts = compactFormatter(timeZone).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

/**
 * Préfixe complet, tel qu'il sera STOCKÉ puis affiché par le modèle :
 * `[horodatage] YYYY-MM-DD HH:mm (heure locale)`.
 */
export function buildTimestampPrefix(date: Date, timeZone?: string): string {
  return `[horodatage] ${formatCompactDateTime(date, timeZone)} (heure locale)`;
}

export interface StoredUserTextOptions {
  /** Instant de l'envoi (préfixe calculé sur CET instant). */
  at: Date;
  /** Fuseau IANA (navigateur) ; absent/invalide ⇒ fuseau du process Node. */
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
