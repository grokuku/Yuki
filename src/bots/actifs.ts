/**
 * RÉSOLUTION DES BOTS AU DÉMARRAGE — QUI DOIT TOURNER.
 *
 * ⚠️ DEUX NOTIONS DISTINCTES, et c'est TOUT l'objet de ce module :
 *  - le bot **PRINCIPAL** (`principal`) : celui dont l'identité sert de référence
 *    (c'est `botActif`, qui privilégie TOUJOURS `yuki`, `registry.ts:297-306`) ;
 *  - les bots qui **DOIVENT TOURNER** (`aDemarrer`) : TOUS ceux dont `actif` vaut
 *    `true`, triés par `ordre` puis par identifiant.
 *
 * Un bot principal peut donc ne pas tourner (l'utilisateur a éteint « yuki ») ;
 * et un bot qui tourne n'est pas forcément le principal. Les deux listes sont
 * rendues séparément plutôt que confondues : confondre les deux ferait d'un
 * bouton on/off un changement d'identité.
 *
 * ⚠️ AUCUN PLAFOND (décision utilisateur du 2026-11-13 : « retire le plafond.
 * Chacun fait comme il a envie en fonction de ses ressources, limiter c'est mal
 * à mon sens »). L'ancien réglage `bots.maxActifs` (défaut 3) a été SUPPRIMÉ :
 * `aDemarrer` n'est plus tronqué et aucun bot `actif` n'est écarté. Le coût réel
 * (autant de piles que de bots) n'est pas caché pour autant : le démarrage
 * JOURNALISE le nombre de bots démarrés (`bots.demarrage`).
 *
 * ⚠️ `MAX_BOTS` (`registry.ts`) n'a rien à voir : c'est le nombre de bots
 * CRÉABLES, pas le nombre qui tournent.
 *
 * ⚠️ Ce module est PUR (aucune écriture, aucun démarrage) : il DÉCRIT ce que le
 * démarrage doit faire. Les tests le vérifient sans lancer de gateway.
 *
 * Aucun import SDK/typebox.
 */

import { botActif, type BotRecord, type RegistreBots } from "./registry.js";

/**
 * Bots qui DOIVENT TOURNER : `actif === true`, triés par `ordre` puis par
 * identifiant (l'ordre doit être DÉTERMINISTE : deux redémarrages ne peuvent pas
 * élire deux bots différents selon l'ordre du fichier).
 *
 * ⚠️ Aucune troncature : la liste rend TOUS les bots actifs, sans exception.
 */
export function botsAActiver(registre: RegistreBots): BotRecord[] {
  return registre.bots
    .filter((bot) => bot.actif === true)
    .sort((a, b) => (a.ordre === b.ordre ? a.id.localeCompare(b.id) : a.ordre - b.ordre));
}

/** Ce que le démarrage doit faire, calculé sans rien écrire. */
export interface ResolutionDemarrageBots {
  /** Bot d'IDENTITÉ (`botActif` privilégie `yuki`) — peut ne pas tourner. */
  readonly principal: BotRecord | null;
  /** TOUS les bots marqués `actif`, dans l'ordre de démarrage. */
  readonly aDemarrer: readonly BotRecord[];
}

/**
 * Résout le démarrage : le principal (identité) et la liste COMPLÈTE des bots à
 * faire tourner.
 *
 * ⚠️ `aDemarrer` peut être VIDE (tous les bots éteints) : c'est un ÉTAT valide de
 * ce calcul, et c'est l'appelant qui refuse le démarrage avec un message clair
 * (`AUCUN_BOT_ACTIF`). Une fonction pure ne lève pas pour une configuration.
 */
export function resoudreDemarrageBots(registre: RegistreBots): ResolutionDemarrageBots {
  return {
    principal: botActif(registre),
    aDemarrer: botsAActiver(registre),
  };
}
