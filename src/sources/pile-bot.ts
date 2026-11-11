/**
 * FABRIQUE DES PILES SOURCES PAR BOT (lot 36, morceau L3-c).
 *
 * ⚠️ POURQUOI CE MODULE : depuis le lot 35j, `SourcesParBot` sait résoudre
 * « jeton → bot propriétaire → SES sources », et `main()` savait ouvrir une pile
 * par bot (`sourcesStore`, `sourcesInbox`, journal, pré-autorisations, service,
 * envois). Mais cette ouverture vivait DANS `main()`, avec trois manques :
 *
 *  1. elle ne connaissait ni la configuration PAR BOT (L3-a) ni les outils PAR
 *     BOT (L3-b) : la pile d'un bot lisait les bornes (`sources.promptTotalChars`,
 *     `files.maxFileBytes`) de la configuration du PRINCIPAL ;
 *  2. elle rappelait `envPourBot` à chaque ouverture, alors que L3-b le résout
 *     déjà pour les mêmes bots — deux résolutions pour un bot, c'est-à-dire deux
 *     `Env` qui peuvent diverger (et le symptôme `<bot>/<bot>` si l'un dérive de
 *     l'autre) ;
 *  3. elle n'était pas testable : la garde « la pile du principal est EXACTEMENT
 *     celle d'avant » ne pouvait s'écrire qu'en démarrant tout `main()`.
 *
 * Ce module rend ces trois points structurels :
 *  - {@link creerResolveurEnvBot} résout l'`Env` d'un bot **UNE SEULE FOIS** et
 *    rend le MÊME objet aux appelants suivants (piles ET outils L3-b) ;
 *  - {@link FabriquePilesSources} rend, par bot, une {@link PileSourcesBot} qui
 *    porte **son** `Env`, **sa** configuration, **ses** outils, **ses** fichiers ;
 *  - le bot de la PILE n'est jamais reconstruit : ses objets sont REÇUS
 *    (`existantsPile`) et rendus tels quels (`===`), ce qui est la garde de
 *    non-régression du morceau.
 *
 * ⚠️ CE QUE CE MODULE NE FAIT PAS (L3-d) : aucun `PiHost` par bot. La pile porte
 * la place d'accueil (`config`, `outils`), rien de plus.
 *
 * Aucun import SDK/typebox.
 */

import type { OutilsBot } from "../bots/outils.js";
import type { Env } from "../config/env.js";
import type { ConfigRuntime } from "../config/runtime.js";
import type { PreAutorisationStore } from "../agents/preautorisations.js";
import type { EnvoisProgrammesService } from "../chat/envois/index.js";
import { envPourBot, type ModeResolutionBot } from "../memory/stores-bot.js";
import type { SourcesInbox } from "./inbox.js";
import type { DeclencheurJournal } from "./journal.js";
import type { PileSourcesBot } from "./par-bot.js";
import type { BalayeurStore } from "./scheduler.js";
import type { SourcesLogger, SourcesService } from "./service.js";

/** Résolution d'un `Env` par bot (couture de test : comptage des appels). */
export type ResolutionEnvBot = (options: {
  envInstance: Env;
  botId: string;
  mode: ModeResolutionBot;
  processEnv?: NodeJS.ProcessEnv;
}) => Env;

export interface OptionsResolveurEnvBot {
  /** `Env` de l'INSTANCE — JAMAIS un `Env` déjà dérivé par bot. */
  envInstance: Env;
  mode: ModeResolutionBot;
  /** Bot de la PILE : son `Env` est déjà résolu (`preparerMultiBot`). */
  pile: string;
  /** `Env` de la PILE, déjà résolu. Rendus TELS QUELS pour ce bot. */
  envPile: Env;
  /** Environnement source des surcharges de chemins (tests ; défaut `process.env`). */
  processEnv?: NodeJS.ProcessEnv;
  /** Couture de test (défaut `envPourBot`). */
  resoudre?: ResolutionEnvBot;
}

/**
 * Résolveur d'`Env` PAR BOT, mémoïsé.
 *
 * ⚠️ `envPourBot` n'est PAS idempotent (`pathsForBot` surcharge
 * `piSessionsDir` en `<pi>/sessions/<botId>` : le réappliquer empile
 * `<bot>/<bot>`). Un seul résolveur par processus, partagé par les piles (ce
 * module) et par les outils (L3-b, `creerOutilsBots({ resoudreEnvBot })`) : le
 * second appelant reçoit **le même objet**, donc jamais un second `Env`.
 */
export interface ResolveurEnvBots {
  /** `Env` de ce bot — résolu au plus UNE fois. */
  pour(botId: string): Env;
  /** Bots réellement résolus ici (le bot de la pile n'y figure pas : il est reçu). */
  readonly resolus: readonly string[];
}

export function creerResolveurEnvBot(options: OptionsResolveurEnvBot): ResolveurEnvBots {
  const memo = new Map<string, Env>();
  // ⚠️ La pile entre dans le cache AVANT toute demande : son `Env` vient du
  // démarrage (`preparerMultiBot`) et ne doit jamais être recalculé.
  memo.set(options.pile, options.envPile);
  const resolus: string[] = [];
  const resoudre: ResolutionEnvBot = options.resoudre ?? ((input) => envPourBot(input));
  return {
    pour(botId: string): Env {
      const deja = memo.get(botId);
      if (deja !== undefined) return deja;
      const envBot = resoudre({
        envInstance: options.envInstance,
        botId,
        mode: options.mode,
        ...(options.processEnv ? { processEnv: options.processEnv } : {}),
      });
      memo.set(botId, envBot);
      resolus.push(botId);
      return envBot;
    },
    get resolus(): readonly string[] {
      return [...resolus];
    },
  };
}

/**
 * Objets d'UN bot qui touchent ses déclencheurs, ses envois et ses
 * pré-autorisations. Chacun pointe un fichier situé sous `<state>/bots/<id>/`.
 */
export interface ObjetsPileSources {
  readonly store: BalayeurStore;
  readonly inbox: SourcesInbox;
  readonly journal: DeclencheurJournal;
  readonly preAutorisations: PreAutorisationStore;
  readonly service: SourcesService;
  /** Envois programmés de CE bot (absent ⇒ aucun envoi exécuté pour lui). */
  readonly envois?: EnvoisProgrammesService;
}

/** Ce qu'un constructeur de pile reçoit pour UN bot (jamais pour un autre). */
export interface ContextePileBot {
  readonly botId: string;
  /** `Env` résolu de CE bot (une seule résolution, cf. {@link ResolveurEnvBots}). */
  readonly envBot: Env;
  /** Configuration DE CE BOT (L3-a) — absente si elle n'a pas été construite. */
  readonly config?: ConfigRuntime;
  /** Outils DE CE BOT (L3-b) — absents tant que la Map n'est pas construite. */
  readonly outils?: OutilsBot;
}

export interface OptionsFabriquePilesSources {
  /** Bot de la PILE (ses objets existent déjà). */
  pile: string;
  /** `Env` de la PILE (déjà résolu) : identité du champ `env` de sa pile. */
  envPile: Env;
  /** Résolveur mémoïsé (`creerResolveurEnvBot`) — une résolution par bot. */
  envs: ResolveurEnvBots;
  /** Configuration d'un bot (L3-a). Absente ⇒ la pile n'en porte pas. */
  configPour?: (botId: string) => ConfigRuntime | undefined;
  /**
   * Outils d'un bot (L3-b). ⚠️ Relu à CHAQUE lecture : la Map des outils est
   * construite APRÈS la première pile (celle du bot actif, ouverte très tôt).
   */
  outilsPour?: (botId: string) => OutilsBot | undefined;
  /** Objets DÉJÀ construits du bot de la PILE : réutilisés, jamais reconstruits. */
  existantsPile: ObjetsPileSources;
  /** Construit les objets d'un AUTRE bot (son store, sa boîte, son journal, …). */
  construire: (contexte: ContextePileBot) => ObjetsPileSources;
  logger: SourcesLogger;
}

/**
 * Fabrique des piles : UNE instance par processus, une pile par bot.
 *
 * ⚠️ Deux gardes, et elles suffisent :
 *  1. **une seule pile par bot** (`ouvrir` est idempotent) : deux `SourcesService`
 *     sur le même `sources.json` écriraient le même fichier — « un seul
 *     rédacteur » vaut aussi ici ;
 *  2. **le bot de la pile n'est jamais reconstruit** : ses objets sont ceux que
 *     `main()` a construits, rendus par identité.
 */
export class FabriquePilesSources {
  private readonly options: OptionsFabriquePilesSources;
  private readonly piles = new Map<string, PileSourcesBot>();

  constructor(options: OptionsFabriquePilesSources) {
    this.options = options;
  }

  /**
   * Pile d'un bot (ouverte à la demande puis gardée).
   *
   * ⚠️ L'appelant a déjà vérifié que ce bot existe (`SourcesParBot.pourBot`) :
   * ici on ne décide QUE du contenu de la pile.
   */
  ouvrir(botId: string): PileSourcesBot {
    const existante = this.piles.get(botId);
    if (existante !== undefined) return existante;

    const options = this.options;
    const estPile = botId === options.pile;
    const outilsPour = options.outilsPour;
    const envBot = estPile ? options.envPile : options.envs.pour(botId);
    const config = options.configPour?.(botId);
    const outils = outilsPour?.(botId);
    const objets = estPile
      ? options.existantsPile
      : options.construire({
          botId,
          envBot,
          ...(config !== undefined ? { config } : {}),
          ...(outils !== undefined ? { outils } : {}),
        });

    const pile: PileSourcesBot = {
      botId,
      env: envBot,
      store: objets.store,
      inbox: objets.inbox,
      journal: objets.journal,
      preAutorisations: objets.preAutorisations,
      service: objets.service,
      ...(config !== undefined ? { config } : {}),
      // ⚠️ GETTER, jamais une valeur figée : la Map des outils (L3-b) est
      // construite après la première pile. L3-d y lira les stores du bon bot.
      get outils(): OutilsBot | undefined {
        return outilsPour?.(botId);
      },
      ...(objets.envois !== undefined ? { envois: objets.envois } : {}),
      // Un arrêt gracieux ne laisse aucun suivi de run derrière lui.
      fermer: () => {
        objets.service.detach();
      },
    };
    this.piles.set(botId, pile);
    if (!estPile) {
      options.logger.info("sources.pile.ouverte", {
        bot: botId,
        sources: envBot.sourcesStorePath,
        inbox: envBot.sourcesInboxPath,
        journal: envBot.declencheursJournalPath,
        preautorisations: envBot.preAutorisationsPath,
        envois: envBot.envoisProgrammesPath,
        config: config !== undefined,
      });
    }
    return pile;
  }

  /** Pile déjà ouverte (`undefined` sinon) — ne construit rien. */
  get(botId: string): PileSourcesBot | undefined {
    return this.piles.get(botId);
  }

  /** Piles ouvertes, dans l'ordre d'ouverture (diagnostic, arrêt gracieux). */
  ouvertes(): PileSourcesBot[] {
    return [...this.piles.values()];
  }

  /**
   * FERME la pile d'un bot (lot 36, L8/L9) : suivi des runs détaché, entrée
   * oubliée. ⚠️ La pile du bot de la PILE n'est jamais fermée ici : elle est
   * celle de `main()`, fermée avec l'instance.
   *
   * Rend `true` si une pile existait (donc si quelque chose a été fermé).
   */
  fermerBot(botId: string): boolean {
    if (botId === this.options.pile) return false;
    const pile = this.piles.get(botId);
    if (pile === undefined) return false;
    this.piles.delete(botId);
    try {
      pile.fermer();
    } catch (error) {
      this.options.logger.warn("sources.pile.fermeture_echouee", {
        bot: botId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.options.logger.info("sources.pile.fermee", { bot: botId });
    return true;
  }

  /** Une pile est-elle ouverte pour ce bot ? */
  estOuverte(botId: string): boolean {
    return this.piles.has(botId);
  }
}
