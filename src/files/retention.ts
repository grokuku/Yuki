/**
 * RÉTENTION — règle UNIQUE, partagée par tout ce qui occupe le volume `state`.
 *
 * ⚠️ POURQUOI CE MODULE EXISTE : les pièces jointes, les IMAGES GÉNÉRÉES
 * (`/images/…`) et les CAPTURES du libraire (`/captures/…`) doivent obéir au
 * MÊME réglage (`files.retentionDays`) et à la MÊME sémantique d'expiration. Deux
 * calculs recopiés finiraient par diverger (une image gardée 30 jours, une pièce
 * jointe 7, et un réglage qui ne sert qu'à moitié).
 *
 * La règle, en trois lignes :
 *   - une durée de rétention est un nombre de JOURS, borné à **au moins 1 jour**
 *     (0 ou négatif ne veut pas dire « garder pour toujours » : cela veut dire
 *     « garder un jour » — on ne supprime jamais dans la seconde un fichier que
 *     l'utilisateur vient de déposer) ;
 *   - l'expiration est calculée à l'ÉCRITURE (`expiresAt`, ISO 8601) : un
 *     changement de réglage s'applique aux NOUVEAUX dépôts, jamais rétroactivement
 *     (on ne supprime pas sous les pieds ce qui est déjà là) ;
 *   - l'expiration est VÉRIFIÉE à la LECTURE (un expiré est supprimé puis traité
 *     comme absent ⇒ 404) ET par un BALAYAGE périodique : sans balayage, un
 *     fichier que personne ne relit resterait indéfiniment sur le disque.
 *
 * Aucune horloge implicite ici : l'appelant fournit `now` (ms Unix), ce qui rend
 * la rétention testable sans attendre 30 jours.
 */

/** Durée de rétention minimale (jours) : jamais zéro, jamais négative. */
export const MIN_RETENTION_DAYS = 1;

/** Millisecondes d'un jour. */
export const DAY_MS = 86_400_000;

/** Durée de rétention EFFECTIVE, en jours (entier ≥ 1). */
export function retentionDays(days: number): number {
  const value = Number.isFinite(days) ? Math.trunc(days) : MIN_RETENTION_DAYS;
  return Math.max(MIN_RETENTION_DAYS, value);
}

/** Instant d'expiration (ISO 8601) d'un dépôt fait à `at` (ms Unix). */
export function expiresAtIso(at: number, days: number): string {
  return new Date(at + retentionDays(days) * DAY_MS).toISOString();
}

/**
 * Vrai si `expiresAt` est ATTEINT (ou illisible : une date qu'on ne sait pas
 * lire ne prouve pas que le fichier est encore valable ⇒ on le traite expiré).
 */
export function isExpired(expiresAt: string | undefined, now: number): boolean {
  if (typeof expiresAt !== "string" || expiresAt === "") return true;
  const parsed = Date.parse(expiresAt);
  if (Number.isNaN(parsed)) return true;
  return parsed <= now;
}
