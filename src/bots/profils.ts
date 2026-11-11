/**
 * CAPACITÉS D'UN BOT — LA PARTIE STRUCTURELLE (lot 35h, ex-`profils.ts`).
 *
 * ⚠️ Les capacités ne sont pas seulement une table d'outils
 * (`OUTILS_DES_CAPACITES`, `src/llm/tool-policy.ts`) : ce sont aussi la décision
 * de CONSTRUIRE, ou non, le WORKER LOURD. Un bot sans capacité `execution` ni
 * `delegation` n'a aucun worker : `run_command` ne peut donc pas exister, même
 * par un job importé, une tâche planifiée ou un déclencheur — le worker qui
 * l'exécuterait n'a jamais été instancié. C'est STRUCTUREL, pas une permission
 * qu'on pourrait oublier de vérifier à un point d'entrée.
 *
 * ⚠️ `execution` ET `delegation` ouvrent le worker : la première lui donne ses
 * outils (`run_command`, `capturer_ecran`), la seconde donne au bot de quoi
 * lancer un job. Une seule des deux suffit — un bot qui délègue a besoin d'un
 * worker pour exécuter le job délégué.
 *
 * ⚠️ POURQUOI CE MODULE : `src/index.ts` est un point de composition que les
 * tests n'importent pas (il exécute `main()` au chargement). Isolée ici, la garde
 * est TESTABLE avec un ESPION : aucune des deux capacités ⇒ la fabrique n'est
 * JAMAIS appelée.
 *
 * Aucun import SDK/typebox.
 */

import type { CapaciteBot } from "./registry.js";

/** Capacités qui exigent un worker lourd (et donc l'instancient). */
export const CAPACITES_WORKER_LOURD: readonly CapaciteBot[] = ["execution", "delegation"];

/**
 * Les capacités autorisent-elles un worker lourd ?
 *
 * `undefined` (aucun bot en jeu : mono-bot historique) vaut « oui » : le
 * comportement d'avant, à l'identique. Un bot du registre a TOUJOURS une liste
 * (un ancien bot sans `capacites` reçoit toutes les capacités à la lecture) :
 * seule une liste qui ne contient ni `execution` ni `delegation` ferme le worker.
 */
export function workerLourdAutorise(capacites: readonly CapaciteBot[] | undefined): boolean {
  if (capacites === undefined) return true;
  return capacites.some((capacite) =>
    (CAPACITES_WORKER_LOURD as readonly string[]).includes(capacite),
  );
}

/**
 * Construit le worker lourd SI les capacités l'autorisent, sinon `undefined`.
 *
 * ⚠️ La fabrique n'est appelée que si `execution` ou `delegation` est autorisée :
 * c'est ce que vérifie le test à espion. Aucune autre condition n'ouvre le worker
 * (ni un réglage, ni un drapeau de requête).
 */
export function construireWorkerLourdSiAutorise<T>(
  capacites: readonly CapaciteBot[] | undefined,
  fabrique: () => T,
): T | undefined {
  if (!workerLourdAutorise(capacites)) return undefined;
  return fabrique();
}
