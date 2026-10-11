/**
 * Construction du prompt de report (AUCUN import SDK/typebox).
 *
 * À la fin réelle d'un job (`completed`/`failed`), on réveille le léger avec un
 * prompt borné : en-tête explicite, `job_id`, statut, tâche, résultat brut (ou
 * `partial`, ou erreur) et consigne de résumé en 1–3 phrases, sans détails
 * techniques. Le lourd ne parle jamais directement à l'utilisateur.
 */

import type { JobRecord } from "../jobs/types.js";

export const REPORT_HEADER = "[RÉSULTAT DE TÂCHE EN ARRIÈRE-PLAN]";

/** Borne de sécurité du texte injecté dans le prompt de report (par job). */
export const REPORT_MAX_CHARS = 8_000;

export const REPORT_INSTRUCTION =
  "Résume ce résultat pour l'utilisateur en 1 à 3 phrases, en langage naturel, " +
  "sans détails techniques ni identifiants. Ne répète ni cet en-tête ni cette consigne.";

/**
 * Consigne du report LOTISSÉ (E4) : un seul tour pour plusieurs tâches.
 * ⚠️ Le préfixe reste `REPORT_HEADER` : c'est un CONTRAT d'éphémérité (mémoire,
 * restauration du transcript).
 */
export const REPORT_INSTRUCTION_BATCH =
  "Résume CES résultats pour l'utilisateur en 1 à 3 phrases par tâche, en langage " +
  "naturel, sans détails techniques ni identifiants. Ne répète ni cet en-tête ni cette consigne.";

function bounded(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max)}\n[…tronqué]`, truncated: true };
}

function rawOutcome(job: JobRecord): string {
  if (job.status === "failed") {
    const detail = job.result.partial ?? job.result.text;
    const message = job.error?.message ?? "échec sans détail";
    return detail
      ? `Erreur : ${message}\n\nTravail partiel :\n${detail}`
      : `Erreur : ${message}`;
  }
  const text = job.result.text ?? job.result.partial;
  return text && text.length > 0 ? text : "(aucun résultat textuel)";
}

function blockFor(job: JobRecord, maxChars: number): string {
  const { text } = bounded(rawOutcome(job), maxChars);
  return [
    `job_id: ${job.id}`,
    `statut: ${job.status}`,
    `tâche: ${job.task}`,
    "",
    "--- résultat brut ---",
    text,
    "--- fin du résultat ---",
  ].join("\n");
}

/**
 * Construit le prompt de report d'un job terminé. Le résultat est borné
 * (`REPORT_MAX_CHARS`) pour éviter d'injecter un rapport démesuré.
 */
export function buildReportPrompt(
  job: JobRecord,
  maxChars: number = REPORT_MAX_CHARS,
): string {
  return buildBatchReportPrompt([job], maxChars);
}

/**
 * Construit le prompt de report d'un LOT de jobs terminés (E4 — lotissement).
 * ⚠️ UN lot = UN SEUL tour : le prompt agrège tous les résultats et commence
 * TOUJOURS par `REPORT_HEADER` (contrat d'éphémérité : mémoire + restauration du
 * transcript le reconnaissent à son préfixe).
 */
export function buildBatchReportPrompt(
  jobs: readonly JobRecord[],
  maxChars: number = REPORT_MAX_CHARS,
): string {
  const list = jobs.filter(Boolean);
  if (list.length === 0) return REPORT_HEADER;
  const blocks = list.map((job) => blockFor(job, maxChars));
  const instruction =
    list.length > 1 ? REPORT_INSTRUCTION_BATCH : REPORT_INSTRUCTION;
  if (list.length === 1) {
    return [REPORT_HEADER, blocks[0] ?? "", "", `Consigne : ${instruction}`].join("\n");
  }
  return [
    REPORT_HEADER,
    `${list.length} tâches terminées :`,
    "",
    blocks.join("\n\n===\n\n"),
    "",
    `Consigne : ${instruction}`,
  ].join("\n");
}
