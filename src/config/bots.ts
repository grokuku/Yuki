/**
 * CONFIGURATION PAR BOT (lot 36, morceau L3-a).
 *
 * ⚠️ POURQUOI CE MODULE : le runtime de configuration (`./runtime.ts`) est déjà
 * « lié à un bot » (`ConfigRuntimeOptions.botId`) et sait lire/écrire l'overlay
 * d'un bot donné (`snapshotPour` / `updatePour`). Ce qui manquait, c'est la
 * FABRIQUE : jusqu'ici `main()` construisait UN runtime pour le bot de la pile,
 * et la configuration des AUTRES bots n'existait que sous forme d'accès disque
 * ponctuels.
 *
 * `creerConfigBot(botId)` rend un `ConfigRuntime` lié à ce bot :
 *  - même store COMMUN pour tous les bots (`config.json` = l'INSTANCE, fichier
 *    unique partagé — `pathsForBot` ne le déplace pas) ;
 *  - overlay PROPRE au bot (`<state>/bots/<botId>/config.overlay.json`) ;
 *  - mêmes défauts de prompts livrés (fichiers globaux à l'instance).
 * Deux bots ⇒ deux overlays, deux ensembles de valeurs : c'est vérifié par
 * `tests/config/config-bots.test.ts`.
 *
 * ⚠️ NON-RÉGRESSION : `main()` garde le runtime du bot de la PILE sous le nom
 * `config` (`src/index.ts`, section « (1) Configuration »). C'est **l'entrée de
 * la Map** pour ce bot, jamais un second runtime : deux runtimes pour le même
 * `botId` tiendraient deux caches de son overlay et divergeraient en silence.
 *
 * ⚠️ CE QUE CE MORCEAU NE FAIT PAS (L3-b/L3-d) : la Map n'est PAS branchée sur
 * les piles (un seul `PiHost` existe encore). Elle est construite, journalisée
 * et disponible pour la suite.
 *
 * ⚠️ DEUX RÈGLES À RESPECTER PAR LA SUITE, déjà vraies ici :
 *  1. **Un seul rédacteur par overlay.** Écrire l'overlay d'un bot doit passer
 *     par SON runtime (`runtime.update(patch)`), pas par `updatePour(botId)`
 *     depuis un autre runtime : le second écrit le disque mais ne rafraîchit
 *     pas le cache mémoire du premier, qui lirait alors une valeur périmée.
 *  2. **Un seul pont `process.env`.** Seul le runtime de la pile appelle
 *     `bridgeSecrets()` : `process.env` est GLOBAL au processus, un second bot
 *     y écraserait les clés du premier.
 *
 * Aucun import SDK/typebox.
 */

import { estIdBot } from "../bots/registry.js";

import type { Env } from "./env.js";
import { createConfigRuntime, type ConfigRuntime, type ConfigRuntimeOptions } from "./runtime.js";

/**
 * Identifiant de bot refusé par la fabrique.
 *
 * ⚠️ L'identifiant devient un NOM DE DOSSIER (`<state>/bots/<id>/`) : le refuser
 * ici évite qu'une valeur fantaisiste (`../autre`, chaîne vide) fasse écrire un
 * overlay hors de l'arborescence du bot. La règle est celle du registre
 * (`ID_BOT_PATTERN`, `src/bots/registry.ts:55`) — jamais une seconde règle.
 */
export class BotIdInvalideError extends Error {
  override readonly name = "BotIdInvalideError";
  constructor(readonly botId: unknown) {
    super(
      `Identifiant de bot invalide pour la configuration : « ${String(botId)} » ` +
        "(attendu : minuscules, chiffres, « _ » ou « - », commençant par une lettre).",
    );
  }
}

export interface OptionsConfigBot {
  /**
   * `Env` d'INSTANCE (mode multi-bot : celui rendu par `preparerMultiBot`).
   * ⚠️ Les chemins PROPRES au bot n'entrent pas en jeu ici : le store commun
   * (`configStorePath`) et la racine des overlays (`mountPoints.state`) sont
   * globaux — la racine des overlays porte déjà le sous-dossier du bot.
   */
  env: Env;
  /**
   * Défauts des prompts (contenu des fichiers livrés). Lus par le runtime
   * lui-même quand ils sont omis ; `main()` les fournit pour que TOUS les bots
   * partagent les mêmes défauts que la pile (et pour garder le repli du code).
   */
  promptDefaults?: { light: string; heavy: string; personnalite?: string };
  /** Environnement source (tests). Défaut : `process.env`. */
  processEnv?: NodeJS.ProcessEnv;
  /** Store commun injectable (tests). */
  store?: ConfigRuntimeOptions["store"];
}

/** Runtime de configuration lié à UN bot. */
export function creerConfigBot(botId: string, options: OptionsConfigBot): ConfigRuntime {
  if (!estIdBot(botId)) throw new BotIdInvalideError(botId);
  return createConfigRuntime({
    env: options.env,
    botId,
    promptDefaults: options.promptDefaults,
    processEnv: options.processEnv,
    store: options.store,
  });
}

export interface OptionsConfigsBots extends OptionsConfigBot {
  /**
   * Bots qui DOIVENT TOURNER (lot 36, L1 : `ResolutionDemarrageBots.aDemarrer`),
   * dans l'ordre du démarrage. ⚠️ Les bots REFUSÉS par le plafond n'y sont pas :
   * leur configuration n'est donc pas construite.
   */
  bots: readonly string[];
  /**
   * Bot de la PILE construite par `main()` (`bots.bot`, ou `yuki` en mode
   * mono-bot historique). ⚠️ TOUJOURS présent dans la Map : en mode mono (aucun
   * registre, aucun volume), `bots` est vide alors qu'une configuration reste
   * indispensable.
   */
  pile: string;
}

/**
 * Map `botId → ConfigRuntime` des bots À DÉMARRER, plus le bot de la pile.
 *
 * Ordre : celui du démarrage (déterministe, `bots/actifs.ts`), puis le bot de la
 * pile s'il n'y figure pas. Un identifiant répété n'est construit qu'UNE fois
 * (un seul runtime par bot : voir l'avertissement « un seul rédacteur »).
 */
export function creerConfigsBots(
  options: OptionsConfigsBots,
): Map<string, ConfigRuntime> {
  const configs = new Map<string, ConfigRuntime>();
  for (const botId of options.bots) {
    if (configs.has(botId)) continue;
    configs.set(botId, creerConfigBot(botId, options));
  }
  if (!configs.has(options.pile)) {
    configs.set(options.pile, creerConfigBot(options.pile, options));
  }
  return configs;
}
