/**
 * RÉSOLUTION DES BOTS AU DÉMARRAGE — QUI DOIT TOURNER, ET AVEC LEQUEL LE
 * PROCESSUS TRAVAILLE.
 *
 * ⚠️ LOT 45 — PLUS DE « BOT PRINCIPAL ». Jusqu'ici ce module élisait un
 * `principal` (= `botActif`, qui privilégiait TOUJOURS `yuki`, même éteinte) :
 * une identité spéciale survivait donc dans le registre, et supprimer `yuki`
 * n'avait pas le même sens que supprimer un autre bot. Ce privilège est
 * SUPPRIMÉ : les bots sont ÉGAUX.
 *
 * Ce qui reste, et ce sont DEUX choses distinctes :
 *  - `aDemarrer` : TOUS les bots `actif: true`, triés par `ordre` puis par
 *    identifiant. Aucun plafond (décision utilisateur du 2026-11-13 : « retire
 *    le plafond. Chacun fait comme il a envie en fonction de ses ressources ») ;
 *  - `botCourant` : le PREMIER de cette liste. C'est le **bot du RUN** — celui
 *    dont le processus tient les objets d'instance (configuration d'instance,
 *    `agentExecution`, mémoire, host par défaut du transport). Il n'est plus élu
 *    par IDENTITÉ (aucun identifiant privilégié) : c'est le premier par `ordre`,
 *    et c'est exactement ce que `resoudreBotCourant` rend sans demande.
 *
 * ⚠️ « Bot du RUN » ≠ « bot DEMANDÉ » (`?b=`, `?bot=`, trame WS) : la demande se
 * résout dans `src/bots/courant.ts`, à chaque requête, et peut désigner
 * n'importe quel bot du registre — jamais un bot absent de `aDemarrer` pour
 * autant : son host n'existe pas.
 *
 * ⚠️ `MAX_BOTS` (`registry.ts`) n'a rien à voir : c'est le nombre de bots
 * CRÉABLES, pas le nombre qui tournent.
 *
 * ⚠️ Ce module est PUR (aucune écriture, aucun démarrage) : il DÉCRIT ce que le
 * démarrage doit faire. Les tests le vérifient sans lancer de gateway.
 *
 * Aucun import SDK/typebox.
 */

import { botsParOrdre } from "./courant.js";
import type { BotRecord, RegistreBots } from "./registry.js";

/**
 * Bots qui DOIVENT TOURNER : `actif === true`, dans l'ordre DÉTERMINISTE de
 * `botsParOrdre` (`ordre`, puis `id` — deux redémarrages ne peuvent pas élire
 * deux bots différents selon l'ordre du fichier).
 *
 * ⚠️ L'ordre n'est PAS réimplémenté ici : `botsParOrdre` (`courant.ts`) est la
 * seule définition de l'ordre d'affichage/d'exécution, donc le bot du run et le
 * bot courant sans demande sont forcément le MÊME.
 *
 * ⚠️ Aucune troncature : la liste rend TOUS les bots actifs, sans exception.
 */
export function botsAActiver(registre: RegistreBots): BotRecord[] {
  return botsParOrdre(registre).filter((bot) => bot.actif === true);
}

/** Ce que le démarrage doit faire, calculé sans rien écrire. */
export interface ResolutionDemarrageBots {
  /**
   * Bot du RUN : le PREMIER bot à démarrer (par `ordre`, puis par `id`), donc
   * `null` quand aucun bot n'est actif. ⚠️ Aucun identifiant n'est privilégié, et
   * c'est exactement ce que `resoudreBotCourant(registre)` rend sans demande.
   */
  readonly botCourant: BotRecord | null;
  /** TOUS les bots marqués `actif`, dans l'ordre de démarrage. */
  readonly aDemarrer: readonly BotRecord[];
}

/**
 * Résout le démarrage : le bot du run et la liste COMPLÈTE des bots à faire
 * tourner.
 *
 * ⚠️ `aDemarrer` peut être VIDE (tous les bots éteints) : c'est un ÉTAT valide de
 * ce calcul, et c'est l'appelant qui refuse le démarrage avec un message clair
 * (`AUCUN_BOT_ACTIF`). Une fonction pure ne lève pas pour une configuration.
 */
export function resoudreDemarrageBots(registre: RegistreBots): ResolutionDemarrageBots {
  const aDemarrer = botsAActiver(registre);
  return {
    botCourant: aDemarrer[0] ?? null,
    aDemarrer,
  };
}
