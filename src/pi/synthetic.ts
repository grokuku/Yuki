/**
 * Prompts SYNTHÉTIQUES du PiHost — source unique de vérité.
 *
 * Un prompt synthétique est envoyé au modèle par le SYSTÈME (jamais par
 * l'utilisateur) : report d'un job d'arrière-plan, résultat d'une commande
 * validée. Il est transmis au SDK (donc présent dans le contexte du modèle),
 * mais il ne doit JAMAIS apparaître comme un message de l'utilisateur :
 *
 *  - `startRun` (`src/pi/sdk-host.ts`) ne l'ajoute PAS au transcript de l'UI ;
 *  - son `userText` n'est PAS diffusé dans `run_started` (ni rejeu, ni snapshot) ;
 *  - la restauration du transcript (`transcriptFromEntries`) et l'extraction de
 *    mémoire (`memory-extension`) le reconnaissent à son PRÉFIXE et l'ignorent.
 *
 * ⚠️ Le préfixe est donc un CONTRAT : tout nouveau prompt synthétique doit
 * commencer EXACTEMENT par son en-tête, et être déclaré ici.
 *
 * Module PUR (aucun SDK, aucun typebox) : partagé entre le host réel, la
 * restauration du transcript, la mémoire et les doubles de test.
 */

import { APPROVAL_RESULT_HEADER, ORIGIN_APPROVAL_RESULT } from "../agents/approval-report.js";
import { REPORT_HEADER } from "../delegation/report.js";

/** Origine d'un prompt synthétique de report de job. */
export const ORIGIN_JOB_REPORT = "job_report";

/** Préfixes des textes utilisateur SYNTHÉTIQUES (jamais affichés, jamais mémorisés). */
export const SYNTHETIC_USER_PREFIXES: readonly string[] = [
  REPORT_HEADER,
  APPROVAL_RESULT_HEADER,
];

/** Origines SYNTHÉTIQUES connues (jamais de bulle utilisateur). */
export const SYNTHETIC_ORIGINS: readonly string[] = [
  ORIGIN_JOB_REPORT,
  ORIGIN_APPROVAL_RESULT,
];

/** `true` si l'origine désigne un prompt synthétique. */
export function isSyntheticOrigin(origin: string | undefined): boolean {
  return origin !== undefined && SYNTHETIC_ORIGINS.includes(origin);
}
