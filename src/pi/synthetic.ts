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
import { ORIGIN_SECRET_STORED, SECRET_STORED_HEADER } from "../agents/secret-report.js";
import { REPORT_HEADER } from "../delegation/report.js";
import { RECAP_HEADER } from "../recap/prompt.js";
import { ORIGIN_SOURCE } from "../sources/frame.js";

/** Origine d'un prompt synthétique de report de job. */
export const ORIGIN_JOB_REPORT = "job_report";

/**
 * Origine d'un prompt synthétique de RÉCAPITULATIF de conversation dédiée.
 * Le récapitulatif est une DONNÉE générée (jamais une parole de l'utilisateur) :
 * il n'est pas prononcé par la TTS (c'est un message de rôle `user`), il ne
 * produit PAS de bulle utilisateur (le transcript le rend en bloc `recap`), et il
 * n'entre PAS dans la mémoire durable.
 */
export const ORIGIN_RECAP = "recap";

/**
 * Origine du prompt synthétique de CONFIRMATION d'enregistrement d'un secret
 * (après saisie dans la fenêtre `awaiting_secret` d'une demande DIRECTE).
 * C'est une DONNÉE système (jamais une parole de l'utilisateur) : pas de bulle,
 * pas de mémoire — et elle ne porte JAMAIS la valeur du secret.
 * La constante est définie dans `src/agents/secret-report.ts` (source unique).
 */

/**
 * Origine d'un message de SOURCE — programme extérieur branché par l'utilisateur
 * (voir `src/sources/frame.ts`, qui est la source UNIQUE de la constante).
 * ⚠️ SYNTHÉTIQUE : un message de source ne produit AUCUNE bulle utilisateur — il
 * vit dans la section « Notifications », jamais dans un fil.
 */

/** Préfixes des textes utilisateur SYNTHÉTIQUES (jamais affichés, jamais mémorisés). */
export const SYNTHETIC_USER_PREFIXES: readonly string[] = [
  REPORT_HEADER,
  APPROVAL_RESULT_HEADER,
  RECAP_HEADER,
  SECRET_STORED_HEADER,
];

/** Origines SYNTHÉTIQUES connues (jamais de bulle utilisateur). */
export const SYNTHETIC_ORIGINS: readonly string[] = [
  ORIGIN_JOB_REPORT,
  ORIGIN_APPROVAL_RESULT,
  ORIGIN_RECAP,
  ORIGIN_SECRET_STORED,
  // Un message de source est une DONNÉE poussée par un programme : il ne doit
  // jamais apparaître comme une parole de l'utilisateur.
  ORIGIN_SOURCE,
];

/** `true` si l'origine désigne un prompt synthétique. */
export function isSyntheticOrigin(origin: string | undefined): boolean {
  return origin !== undefined && SYNTHETIC_ORIGINS.includes(origin);
}
