/**
 * PROFILS DE CAPACITÉS (lot 35f) — LA PARTIE STRUCTURELLE.
 *
 * ⚠️ Le profil d'un bot n'est pas seulement une table d'outils
 * (`PROFIL_OUTILS`, `src/llm/tool-policy.ts`) : c'est aussi la décision de
 * CONSTRUIRE, ou non, le WORKER LOURD. Un bot `lecture` ou `accueil` n'a aucun
 * worker : `run_command` ne peut donc pas exister, même par un job importé, une
 * tâche planifiée ou un déclencheur — le worker qui l'exécuterait n'a jamais été
 * instancié. C'est STRUCTUREL, pas une permission qu'on pourrait oublier de
 * vérifier à un point d'entrée.
 *
 * ⚠️ POURQUOI CE MODULE : `src/index.ts` est un point de composition que les
 * tests n'importent pas (il exécute `main()` au chargement). Isolée ici, la garde
 * est TESTABLE avec un ESPION : `profil !== "complet"` ⇒ la fabrique n'est
 * JAMAIS appelée.
 *
 * Aucun import SDK/typebox.
 */

import type { ProfilBot } from "./registry.js";

/**
 * Le profil autorise-t-il un worker lourd ?
 *
 * `undefined` (aucun registre, mono-bot historique) vaut `complet` : le
 * comportement d'avant, à l'identique.
 */
export function workerLourdAutorise(profil: ProfilBot | undefined): boolean {
  return (profil ?? "complet") === "complet";
}

/**
 * Construit le worker lourd SI le profil l'autorise, sinon `undefined`.
 *
 * ⚠️ La fabrique n'est appelée que dans le cas `complet` : c'est ce que vérifie
 * le test à espion. Aucune autre condition n'ouvre le worker (ni un réglage, ni
 * un drapeau de requête).
 */
export function construireWorkerLourdSiAutorise<T>(
  profil: ProfilBot | undefined,
  fabrique: () => T,
): T | undefined {
  if (!workerLourdAutorise(profil)) return undefined;
  return fabrique();
}
