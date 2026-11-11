/**
 * STORES DE MÉMOIRE PAR BOT (lot 35i) — **chemin de construction UNIQUE**.
 *
 * ⚠️ LE PROBLÈME RÉSOLU : les chemins de la mémoire sont résolus PAR BOT depuis
 * le lot 35a (`pathsForBot`, `src/bots/paths.ts`), mais rien n'empêchait un
 * appelant de construire un `MemoryStore` sur `env.memoryStorePath` en
 * contournant cette résolution — donc de lire la mémoire d'un AUTRE bot. Ce
 * module est le SEUL endroit du produit qui ouvre `memory.jsonl` et
 * `memory-index.sqlite`, et il ne les ouvre qu'à partir d'un `Env` **résolu
 * pour un bot** (`envPourBot`).
 *
 * ⚠️ `envPourBot` attend l'`Env` de l'**INSTANCE** (`loadEnv()`, rendu par
 * `preparerMultiBot` comme `envInstance`), JAMAIS un `Env` déjà résolu par bot :
 * `pathsForBot` surcharge `piSessionsDir` en `<pi>/sessions/<botId>`, et le
 * réappliquer empilerait `<botId>/<botId>`. En mode mono-bot historique
 * (`state/bots.json` absent), l'`Env` d'instance EST l'`Env` du bot : les
 * chemins historiques sont conservés tels quels.
 *
 * Aucun import SDK/typebox.
 */

import type { Env } from "../config/env.js";
import { estIdBot } from "../bots/registry.js";
import { pathsForBot } from "../bots/paths.js";

import { MemoryIndex } from "./index-db.js";
import { MemoryStore } from "./store.js";
import type { MemoryLogger } from "./types.js";

/** Mode de résolution (miroir de `ResultatPreparationBots["mode"]`). */
export type ModeResolutionBot = "mono" | "multi";

/** Erreur d'ouverture : un identifiant de bot invalide ne nomme aucun dossier. */
export class StoresMemoireError extends Error {
  override readonly name = "StoresMemoireError";
  constructor(
    readonly code: "bot_invalide" | "ouverture_impossible" | "deja_ouvert",
    message: string,
  ) {
    super(message);
  }
}

export interface OptionsEnvPourBot {
  /** `Env` de l'INSTANCE (jamais un `Env` déjà résolu par bot). */
  envInstance: Env;
  botId: string;
  mode: ModeResolutionBot;
  processEnv?: NodeJS.ProcessEnv;
}

/**
 * `Env` EFFECTIF d'un bot : l'`Env` d'instance en mode mono-bot historique, la
 * résolution `pathsForBot` en mode multi-bot.
 */
export function envPourBot(options: OptionsEnvPourBot): Env {
  if (!estIdBot(options.botId)) {
    throw new StoresMemoireError(
      "bot_invalide",
      `Identifiant de bot invalide : « ${String(options.botId)} » (aucun dossier de mémoire).`,
    );
  }
  if (options.mode === "mono") return options.envInstance;
  return pathsForBot(options.envInstance, options.botId, {
    ...(options.processEnv ? { processEnv: options.processEnv } : {}),
  }).env;
}

export interface OptionsOuvertureStoresMemoire {
  /** `Env` RÉSOLU pour ce bot (`envPourBot`). */
  env: Env;
  botId: string;
  logger?: MemoryLogger;
}

/** Stores mémoire d'UN bot (le seul moyen d'atteindre son `memory.jsonl`). */
export interface StoresMemoireBot {
  readonly botId: string;
  /** `Env` résolu du bot (ses chemins mémoire pointent sous SA racine). */
  readonly env: Env;
  readonly store: MemoryStore;
  readonly index: MemoryIndex;
  /** Fichier réellement ouvert (diagnostic, tests d'isolation). */
  readonly fichier: string;
  /** Index réellement ouvert (dérivé, reconstruit au besoin). */
  readonly fichierIndex: string;
  fermer(): void;
}

/**
 * Ouvre (ou crée) les stores mémoire d'un bot.
 *
 * ⚠️ L'index est OUVERT ici et reconstruit s'il est incomplet : sans cela, une
 * passe de consolidation sur un bot NON ACTIF écrirait dans son `memory.jsonl`
 * sans que son index suive (recherche vide jusqu'au prochain démarrage).
 * `MemoryIndex.open()` est idempotent, `MemoryService.start()` le rappelle sans
 * dommage.
 */
export function ouvrirStoresMemoireBot(
  options: OptionsOuvertureStoresMemoire,
): StoresMemoireBot {
  const { env, botId } = options;
  const fichier = env.memoryStorePath;
  const fichierIndex = env.memoryIndexPath;
  const store = MemoryStore.open({
    path: fichier,
    ...(options.logger ? { logger: options.logger } : {}),
  });
  const index = new MemoryIndex({
    path: fichierIndex,
    ...(options.logger ? { logger: options.logger } : {}),
  });
  if (index.open() && index.count() !== store.size) {
    index.rebuild(store.entries);
  }
  let ferme = false;
  return {
    botId,
    env,
    store,
    index,
    fichier,
    fichierIndex,
    fermer: () => {
      if (ferme) return;
      ferme = true;
      index.close();
    },
  };
}

export interface OptionsFabriqueMemoire {
  envInstance: Env;
  mode: ModeResolutionBot;
  logger?: MemoryLogger;
  processEnv?: NodeJS.ProcessEnv;
}

/**
 * FABRIQUE PARESSEUSE — un jeu de stores par bot, ouvert à la demande et gardé
 * ouvert (les passes de consolidation, elles, sont longues).
 *
 * ⚠️ La fabrique REFUSE un identifiant inconnu de la résolution : deux appels
 * avec le même `botId` rendent le MÊME objet (jamais deux écrivains sur un même
 * `memory.jsonl` — la règle « un seul rédacteur » vaut aussi ici).
 */
export class FabriqueMemoireBots {
  private readonly cache = new Map<string, StoresMemoireBot>();
  private readonly options: OptionsFabriqueMemoire;

  constructor(options: OptionsFabriqueMemoire) {
    this.options = options;
  }

  /** `Env` résolu d'un bot (même résolution que `storesDe`). */
  envDe(botId: string): Env {
    return envPourBot({
      envInstance: this.options.envInstance,
      botId,
      mode: this.options.mode,
      ...(this.options.processEnv ? { processEnv: this.options.processEnv } : {}),
    });
  }

  /** Stores d'un bot (ouverts au premier appel, puis réutilisés). */
  storesDe(botId: string): StoresMemoireBot {
    const existant = this.cache.get(botId);
    if (existant) return existant;
    const stores = ouvrirStoresMemoireBot({
      env: this.envDe(botId),
      botId,
      ...(this.options.logger ? { logger: this.options.logger } : {}),
    });
    this.cache.set(botId, stores);
    return stores;
  }

  /** Bots dont les stores sont ouverts. */
  get botsOuverts(): string[] {
    return [...this.cache.keys()];
  }

  /**
   * Vrai si les stores de ce bot sont DÉJÀ ouverts (lecture seule, aucune
   * ouverture). Permet à un appelant de ne pas re-résoudre l'`Env` pour rien.
   */
  estOuvert(botId: string): boolean {
    return this.cache.has(botId);
  }

  /**
   * ADOPTE des stores ouverts ailleurs (lot 36, L3-b).
   *
   * ⚠️ `main()` ouvre les stores du bot de la pile AVANT de construire la
   * fabrique (lot 35i) : sans adoption, une passe de consolidation appellerait
   * `storesDe(pile)` et ouvrirait un SECOND `MemoryStore` sur le même
   * `memory.jsonl` — deux écrivains. Adopter les enregistre dans le cache.
   *
   * Idempotent pour le MÊME objet ; refuse un AUTRE jeu de stores pour le même
   * bot (ce serait précisément le second écrivain qu'on veut interdire).
   */
  adopter(stores: StoresMemoireBot): void {
    const existant = this.cache.get(stores.botId);
    if (existant === stores) return;
    if (existant) {
      throw new StoresMemoireError(
        "deja_ouvert",
        `Stores déjà ouverts pour le bot « ${stores.botId} » (${existant.fichier}) : ` +
          `un second jeu (${stores.fichier}) créerait deux écrivains.`,
      );
    }
    this.cache.set(stores.botId, stores);
  }

  /**
   * FERME les stores d'UN bot (lot 36, L9) : son index est fermé, aucune
   * écriture tardive ne peut plus partir. ⚠️ Le bot de la PILE n'est pas fermé
   * par ici : ses stores sont ceux de `main()`, fermés avec l'instance.
   *
   * Rend `true` si des stores existaient pour ce bot.
   */
  fermerBot(botId: string): boolean {
    const stores = this.cache.get(botId);
    if (stores === undefined) return false;
    this.cache.delete(botId);
    stores.fermer();
    return true;
  }

  /** Ferme tous les index ouverts (arrêt gracieux). */
  fermerTout(): void {
    for (const stores of this.cache.values()) stores.fermer();
    this.cache.clear();
  }
}
