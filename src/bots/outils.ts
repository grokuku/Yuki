/**
 * OUTILS D'UN BOT (lot 36, morceau L3-b) — MÉMOIRE, ARCHIVE, AVATAR,
 * PERSONNALITÉ, RÈGLES, ÉPINGLES, RÉACTIONS.
 *
 * ⚠️ POURQUOI CE MODULE : depuis le lot 35a, `pathsForBot` sait calculer les
 * chemins PROPRES à un bot (`<state>/bots/<id>/…`), mais `main()` construisait
 * encore UN seul jeu d'objets, aux chemins de la PILE. Ouvrir la mémoire, l
 * archive, l'avatar, la personnalité, les règles, les épingles ou les réactions
 * d'un AUTRE bot n'avait donc aucune fabrique : le prochain appelant aurait
 * recopié la liste des constructeurs (et se serait trompé un jour).
 *
 * Ce module est cette fabrique. Elle ne BRANCHE rien : elle rend disponible, par
 * bot, ce que la suite (L3-d) donnera à chaque pile. Aucun appelant existant
 * n'est modifié — `main()` garde ses objets et ses variables.
 *
 * ⚠️ RÈGLES (les mêmes que `src/config/bots.ts`, L3-a) :
 *  1. **Le principal reste le même objet.** `main()` a déjà construit la
 *     personnalité, les règles, l'avatar, les réactions, l'archive et les stores
 *     de mémoire du bot de la pile : ils sont REÇUS (`existantsPile`) et
 *     réutilisés tels quels, jamais reconstruits — deux `MemoryStore` sur le
 *     même `memory.jsonl` violeraient « un seul rédacteur ».
 *  2. **`envPourBot` une seule fois par bot.** `envPourBot` n'est PAS idempotent
 *     (`pathsForBot` surcharge `piSessionsDir` en `<pi>/sessions/<botId>` : le
 *     réappliquer empile `<bot>/<bot>`). La base est TOUJOURS l'`Env` d'INSTANCE
 *     (`bots.envInstance`), la résolution a lieu ICI une seule fois par bot, et
 *     `creerOutilsBot` REFUSE un `Env` déjà dérivé deux fois.
 *  3. **La Map ne contient que les bots concernés** : ceux qui DOIVENT tourner
 *     (L1) plus le bot de la pile — jamais ceux que le plafond a refusés.
 *  4. **Aucun contenu journalisé** : on journalise des CHEMINS et un identifiant,
 *     jamais le texte d'une personnalité, d'une règle ou d'un souvenir.
 *
 * Aucun import SDK/typebox.
 */

import { join } from "node:path";

import type { Env } from "../config/env.js";
import type { ConfigRuntime } from "../config/runtime.js";
import { AvatarStore } from "../identity/avatar.js";
import { ConversationArchiveStore } from "../memory/conversation-archive-store.js";
import {
  envPourBot,
  ouvrirStoresMemoireBot,
  type FabriqueMemoireBots,
  type ModeResolutionBot,
  type StoresMemoireBot,
} from "../memory/stores-bot.js";
import { SessionPinStore } from "../pi/session-pins.js";
import { PersonalityStore } from "../personality/index.js";
import { ReactionStore } from "../reactions/index.js";
import { RulesStore } from "../rules/index.js";

import { pathsForBot } from "./paths.js";
import { estIdBot } from "./registry.js";

/** Journal minimal attendu (le `Logger` de l'application le satisfait). */
export interface OutilsBotLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/**
 * Erreurs de la fabrique — chacune NOMME le refus (jamais un `throw` muet).
 *
 * - `bot_invalide` : l'identifiant devient un nom de dossier, il est refusé
 *   avant tout calcul de chemin (même règle que le registre) ;
 * - `env_double_resolution` : l'`Env` fourni a déjà été dérivé pour ce bot
 *   (`<pi>/sessions/<bot>/<bot>`) — le symptôme du double `envPourBot` ;
 * - `env_incoherent` : l'`Env` et les stores mémoire ne désignent pas le même
 *   `memory.jsonl` (deux bots mélangés).
 */
export class OutilsBotError extends Error {
  override readonly name = "OutilsBotError";
  constructor(
    readonly code: "bot_invalide" | "env_double_resolution" | "env_incoherent",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Les SEPT chemins par bot (ceux dont dépendent la mémoire, l'archive, l'avatar,
 * la personnalité, les règles, les épingles et les réactions).
 *
 * ⚠️ Les noms suivent `Env` (`reactionsStorePath`, `conversationArchiveDir`) :
 * ce sont EXACTEMENT les valeurs que `main()` lit aujourd'hui pour construire
 * ses objets — la garde de non-régression compare ces sept-là.
 */
export interface CheminsOutilsBot {
  readonly memoryStorePath: string;
  readonly conversationsArchiveDir: string;
  readonly avatarDir: string;
  readonly personalityPath: string;
  readonly rulesPath: string;
  readonly sessionPinsPath: string;
  readonly reactionsPath: string;
}

/** Les sept chemins d'un `Env` (résolu pour un bot, ou d'instance en mono-bot). */
export function cheminsOutils(env: Env): CheminsOutilsBot {
  return {
    memoryStorePath: env.memoryStorePath,
    conversationsArchiveDir: env.conversationArchiveDir,
    avatarDir: env.avatarDir,
    personalityPath: env.personalityPath,
    rulesPath: env.rulesPath,
    sessionPinsPath: env.sessionPinsPath,
    reactionsPath: env.reactionsStorePath,
  };
}

/**
 * Objets DÉJÀ construits par `main()` pour le bot de la pile. Tout ce qui est
 * fourni est RÉUTILISÉ tel quel (`===`), jamais reconstruit.
 */
export interface OutilsBotExistants {
  memoire?: StoresMemoireBot;
  archive?: ConversationArchiveStore;
  avatar?: AvatarStore;
  personnalite?: PersonalityStore;
  regles?: RulesStore;
  pins?: SessionPinStore;
  reactions?: ReactionStore;
}

/** Jeu d'objets d'UN bot (mémoire, archive, avatar, personnalité, règles, épingles, réactions). */
export interface OutilsBot {
  readonly botId: string;
  /** `Env` RÉSOLU de ce bot (tous ses chemins pointent sous SA racine). */
  readonly env: Env;
  /** Les sept chemins (diagnostic, journal, garde de non-régression). */
  readonly chemins: CheminsOutilsBot;
  /** Configuration de CE bot (L3-a), si elle a été construite. */
  readonly config: ConfigRuntime | undefined;
  readonly memoire: StoresMemoireBot;
  readonly archive: ConversationArchiveStore;
  readonly avatar: AvatarStore;
  readonly personnalite: PersonalityStore;
  readonly regles: RulesStore;
  readonly pins: SessionPinStore;
  readonly reactions: ReactionStore;
}

export interface OptionsOutilsBot {
  botId: string;
  /** `Env` RÉSOLU pour CE bot (`envPourBot`, appliqué une seule fois). */
  envBot: Env;
  /** `Env` de l'INSTANCE (base de la résolution : garde du double `envPourBot`). */
  envInstance: Env;
  mode: ModeResolutionBot;
  configBot?: ConfigRuntime;
  logger?: OutilsBotLogger;
  /** Stores mémoire déjà ouverts (sinon ils sont ouverts ici). */
  memoire?: StoresMemoireBot;
  /** Objets déjà construits (bot de la pile) : réutilisés, jamais reconstruits. */
  existants?: OutilsBotExistants;
  /** Environnement source des surcharges de chemins (tests ; défaut `process.env`). */
  processEnv?: NodeJS.ProcessEnv;
}

/**
 * Vérifie que `envBot` a été dérivé EXACTEMENT une fois pour `botId`.
 *
 * ⚠️ On compare au chemin DOUBLE (`<pi>/sessions/<bot>/<bot>`) plutôt qu'à un
 * suffixe : un bot nommé « sessions » ne doit pas être confondu avec le dossier
 * des sessions, et une surcharge de déploiement hors volume reste acceptée.
 */
function verifierEnvNonDouble(options: {
  botId: string;
  envBot: Env;
  envInstance: Env;
  processEnv?: NodeJS.ProcessEnv;
}): void {
  const canonique = pathsForBot(
    options.envInstance,
    options.botId,
    options.processEnv ? { processEnv: options.processEnv } : {},
  ).env;
  const double = join(canonique.piSessionsDir, options.botId);
  if (options.envBot.piSessionsDir === double) {
    throw new OutilsBotError(
      "env_double_resolution",
      `L'Env du bot « ${options.botId} » a été résolu DEUX fois ` +
        `(${options.envBot.piSessionsDir}) : appliquer « envPourBot » à un Env ` +
        "déjà dérivé empile le dossier du bot. La base doit être l'Env d'INSTANCE.",
    );
  }
}

/**
 * Les outils d'UN bot.
 *
 * ⚠️ `memoire` vient de préférence de la fabrique (`FabriqueMemoireBots`) : c'est
 * le seul chemin de construction qui garantit UN `MemoryStore` par `memory.jsonl`.
 * Omis, il est ouvert ici (même fonction `ouvrirStoresMemoireBot`) — l'appelant
 * doit alors en être le seul propriétaire.
 */
export function creerOutilsBot(options: OptionsOutilsBot): OutilsBot {
  const { botId, envBot } = options;
  if (!estIdBot(botId)) {
    throw new OutilsBotError(
      "bot_invalide",
      `Identifiant de bot invalide pour les outils : « ${String(botId)} » ` +
        "(attendu : minuscules, chiffres, « _ » ou « - », commençant par une lettre).",
    );
  }
  verifierEnvNonDouble({
    botId,
    envBot,
    envInstance: options.envInstance,
    ...(options.processEnv ? { processEnv: options.processEnv } : {}),
  });

  const existants = options.existants ?? {};
  const memoire =
    options.memoire ??
    existants.memoire ??
    ouvrirStoresMemoireBot({
      env: envBot,
      botId,
      ...(options.logger ? { logger: options.logger } : {}),
    });
  // ⚠️ Un store de mémoire ouvert sur UN fichier et un `Env` qui en désigne un
  // AUTRE : c'est exactement le mélange de deux bots. Refus AVANT d'ouvrir quoi
  // que ce soit d'autre (l'archive n'a pas encore de handle).
  if (memoire.botId !== botId || memoire.fichier !== envBot.memoryStorePath) {
    throw new OutilsBotError(
      "env_incoherent",
      `Stores mémoire incohérents avec l'Env du bot « ${botId} » : ` +
        `stores=${memoire.botId}/${memoire.fichier}, env=${botId}/${envBot.memoryStorePath}.`,
    );
  }

  const logger = options.logger;
  const archive =
    existants.archive ??
    new ConversationArchiveStore({
      dir: envBot.conversationArchiveDir,
      indexPath: envBot.conversationArchiveIndexPath,
      ...(logger ? { logger } : {}),
    });

  return {
    botId,
    env: envBot,
    chemins: cheminsOutils(envBot),
    config: options.configBot,
    memoire,
    archive,
    avatar: existants.avatar ?? new AvatarStore({ dir: envBot.avatarDir }),
    personnalite:
      existants.personnalite ??
      new PersonalityStore({
        path: envBot.personalityPath,
        ...(logger ? { logger } : {}),
      }),
    regles:
      existants.regles ??
      new RulesStore({
        path: envBot.rulesPath,
        ...(logger ? { logger } : {}),
      }),
    pins:
      existants.pins ??
      SessionPinStore.open({
        path: envBot.sessionPinsPath,
        ...(logger ? { logger } : {}),
      }),
    reactions:
      existants.reactions ??
      ReactionStore.open({
        path: envBot.reactionsStorePath,
        ...(logger ? { logger } : {}),
      }),
  };
}

export interface OptionsOutilsBots {
  /** `Env` de l'INSTANCE — JAMAIS un `Env` déjà résolu par bot. */
  envInstance: Env;
  mode: ModeResolutionBot;
  /** Bots qui DOIVENT tourner (L1, `aDemarrer`), dans l'ordre du démarrage. */
  bots: readonly string[];
  /** Bot de la PILE (`main()`), toujours présent même en mode mono-bot. */
  pile: string;
  /** Configurations par bot déjà construites (L3-a) — jamais reconstruites. */
  configs?: ReadonlyMap<string, ConfigRuntime>;
  /** Fabrique des stores de mémoire (un seul `MemoryStore` par bot). */
  fabrique: FabriqueMemoireBots;
  /**
   * Objets DÉJÀ construits par `main()` pour le bot de la PILE. ⚠️ Ignorés pour
   * tout autre bot : un objet de la pile n'est pas l'objet d'un autre bot.
   */
  existantsPile?: OutilsBotExistants;
  logger?: OutilsBotLogger;
  /** Environnement source des surcharges de chemins (tests ; défaut `process.env`). */
  processEnv?: NodeJS.ProcessEnv;
  /** Couture de test : comptage des résolutions d'`Env` (défaut `envPourBot`). */
  resoudreEnvBot?: (botId: string) => Env;
}

/**
 * Les stores de mémoire d'un bot, toujours par la fabrique.
 *
 * ⚠️ Trois cas, et un seul objet par bot dans tous les cas :
 *  1. `main()` a déjà ouvert ceux de la pile (`existantsPile.memoire`) ⇒ ils
 *     sont ADOPTÉS par la fabrique, pour que ses passes de consolidation
 *     (`storesDe`, lot 35i) ne rouvrent pas un second écrivain ;
 *  2. la fabrique les a déjà ouverts ⇒ mêmes objets, aucune réouverture ;
 *  3. sinon on les ouvre une fois, puis on les confie à la fabrique.
 */
function storesMemoireDe(options: {
  botId: string;
  envBot: Env;
  fabrique: FabriqueMemoireBots;
  existant?: StoresMemoireBot;
  logger?: OutilsBotLogger;
}): StoresMemoireBot {
  const { botId, envBot, fabrique, existant } = options;
  if (existant) {
    if (existant.botId !== botId) {
      throw new OutilsBotError(
        "env_incoherent",
        `Stores mémoire du bot « ${existant.botId} » fournis pour le bot « ${botId} ».`,
      );
    }
    fabrique.adopter(existant);
    return existant;
  }
  if (fabrique.estOuvert(botId)) return fabrique.storesDe(botId);
  const stores = ouvrirStoresMemoireBot({
    env: envBot,
    botId,
    ...(options.logger ? { logger: options.logger } : {}),
  });
  fabrique.adopter(stores);
  return stores;
}

/**
 * Map `botId → OutilsBot` des bots à DÉMARRER (L1), plus le bot de la PILE.
 *
 * Ordre : celui du démarrage (déterministe, `src/bots/actifs.ts`), puis la pile
 * si elle n'y figure pas. Un identifiant répété n'est construit qu'UNE fois.
 * Les bots REFUSÉS par le plafond (`refusesActifs`) n'y sont jamais.
 *
 * ⚠️ Un seul `envPourBot` par bot : la résolution a lieu ici (ou est reprise de
 * l'`Env` des stores de la pile, déjà résolu), puis circule dans tout le jeu.
 *
 * ⚠️ Effet de bord assumé : les stores de mémoire des bots à démarrer sont
 * OUVERTS (fichier + index créés si absents). C'est le comportement attendu —
 * un bot qui doit tourner a une mémoire — et cela reste sans effet en mode
 * mono-bot, où la Map ne contient que la pile et réutilise ses objets.
 */
export function creerOutilsBots(options: OptionsOutilsBots): Map<string, OutilsBot> {
  const resoudre =
    options.resoudreEnvBot ??
    ((botId: string): Env =>
      envPourBot({
        envInstance: options.envInstance,
        botId,
        mode: options.mode,
        ...(options.processEnv ? { processEnv: options.processEnv } : {}),
      }));

  const outils = new Map<string, OutilsBot>();
  const ordre: string[] = [...options.bots];
  if (!ordre.includes(options.pile)) ordre.push(options.pile);

  for (const botId of ordre) {
    if (outils.has(botId)) continue;
    const estPile = botId === options.pile;
    const existants = estPile ? options.existantsPile : undefined;
    // Un `Env` déjà résolu n'est JAMAIS re-résolu : `envPourBot` n'est pas
    // idempotent (cf. en-tête du module).
    const envBot = existants?.memoire?.env ?? resoudre(botId);
    const memoire = storesMemoireDe({
      botId,
      envBot,
      fabrique: options.fabrique,
      ...(existants?.memoire ? { existant: existants.memoire } : {}),
      ...(options.logger ? { logger: options.logger } : {}),
    });
    const configBot = options.configs?.get(botId);
    outils.set(
      botId,
      creerOutilsBot({
        botId,
        envBot,
        envInstance: options.envInstance,
        mode: options.mode,
        ...(configBot ? { configBot } : {}),
        ...(options.logger ? { logger: options.logger } : {}),
        ...(options.processEnv ? { processEnv: options.processEnv } : {}),
        memoire,
        ...(existants ? { existants } : {}),
      }),
    );
  }
  return outils;
}
