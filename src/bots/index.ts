/**
 * FAÇADE MULTI-BOT (lot 35a, étape 1 : STRUCTURE + MIGRATION).
 *
 * Point d'entrée UNIQUE du démarrage : lit `state/bots.json`, migre la
 * disposition mono-bot si nécessaire, refuse un démarrage à moitié migré, puis
 * renvoie l'`Env` EFFECTIF (chemins du bot actif) à passer au reste du câblage.
 *
 * ⚠️ Aucune fonction visible : ce module ne crée ni page, ni route, ni écran.
 * Le produit se comporte exactement comme avant — seuls les CHEMINS changent.
 *
 * ⚠️ `bots.json` ABSENT ⇒ mode **mono-bot historique** : `env` est rendu tel
 * quel. C'est le filet de sécurité (volume non inscriptible, lecture seule,
 * migration désactivée) : jamais de démarrage cassé par ce lot.
 *
 * Aucun import SDK/typebox.
 */

import type { Env } from "../config/env.js";

import {
  BOT_YUKI,
  RegistreBotsError,
  botActif,
  cheminRegistreBots,
  lireRegistreBots,
  type BotRecord,
  type RegistreBots,
} from "./registry.js";
import {
  cheminsOrigineEncorePresents,
  migrerVersMultiBot,
  type JournalisationMigration,
} from "./migrate.js";
import {
  messageSurchargeIgnoree,
  pathsForBot,
  type CheminsBot,
  type SurchargeIgnoree,
} from "./paths.js";

export * from "./registry.js";
export * from "./paths.js";
export * from "./migrate.js";

/** Mode de résolution retenu au démarrage. */
export type ModeBots = "mono" | "multi";

/** Résultat de la préparation du démarrage. */
export interface ResultatPreparationBots {
  mode: ModeBots;
  /** `Env` à utiliser partout ailleurs (surchargé en mode `multi`). */
  env: Env;
  /** Bot actif (`null` en mode mono-bot historique). */
  bot: BotRecord | null;
  /** Registre lu (`null` en mode mono-bot historique). */
  registre: RegistreBots | null;
  /** Chemins effectifs du bot (`null` en mode mono-bot historique). */
  chemins: CheminsBot | null;
  /** Migration effectuée pendant CETTE préparation ? */
  migration: "aucune" | "effectuee" | "deja_faite" | "impossible";
  /** Avertissements À JOURNALISER au démarrage (surcharges ignorées…). */
  avertissements: string[];
}

/** Codes de refus de démarrage — chacun avec un message FRANÇAIS explicite. */
export type CodeRefusDemarrage =
  | "MIGRATION_PARTIELLE"
  | "MIGRATION_ECHOUEE"
  | "REGISTRE_INVALIDE"
  | "AUCUN_BOT_ACTIF";

/** Démarrage REFUSÉ : mieux vaut ne pas démarrer que lire au mauvais endroit. */
export class DemarrageRefuseError extends Error {
  override readonly name = "DemarrageRefuseError";
  readonly code: CodeRefusDemarrage;
  readonly details: string[];

  constructor(code: CodeRefusDemarrage, message: string, details: string[] = []) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/** Options de préparation (les coutures servent aux tests). */
export interface OptionsPreparationBots {
  processEnv?: NodeJS.ProcessEnv;
  logger?: JournalisationMigration;
  /**
   * Migration automatique quand `bots.json` est absent (défaut : `true`).
   * ⚠️ `false` ⇒ mode mono-bot historique STRICT : aucune écriture, aucun
   * déplacement (utilisé par les tests et par un démarrage en lecture seule).
   */
  migrationAutomatique?: boolean;
}

/**
 * Prépare l'environnement d'exécution.
 *
 * ⚠️ Peut LEVER `DemarrageRefuseError` : c'est volontaire (jamais de
 * fonctionnement à moitié migré). L'appelant laisse alors le processus sortir
 * en erreur, avec la liste exacte des chemins en cause.
 */
export function preparerMultiBot(
  env: Env,
  options: OptionsPreparationBots = {},
): ResultatPreparationBots {
  const processEnv = options.processEnv ?? process.env;
  const logger = options.logger;
  const stateDir = env.mountPoints.state;
  const registrePath = cheminRegistreBots(stateDir);
  const avertissements: string[] = [];

  let registre: RegistreBots | null;
  try {
    registre = lireRegistreBots(registrePath);
  } catch (error) {
    throw refusRegistre(error, registrePath);
  }

  let migration: ResultatPreparationBots["migration"] = "aucune";

  if (!registre) {
    if (options.migrationAutomatique === false) {
      // Mode mono-bot historique STRICT : rien n'est lu ni écrit ailleurs.
      return {
        mode: "mono",
        env,
        bot: null,
        registre: null,
        chemins: null,
        migration,
        avertissements,
      };
    }
    const resultat = migrerVersMultiBot(env, { processEnv, ...(logger ? { logger } : {}) });
    switch (resultat.etat) {
      case "sans_volume": {
        // ⚠️ Aucun déplacement n'a eu lieu : mode mono-bot historique.
        avertissements.push(...resultat.avertissements);
        migration = "impossible";
        return {
          mode: "mono",
          env,
          bot: null,
          registre: null,
          chemins: null,
          migration,
          avertissements,
        };
      }
      case "echec": {
        throw new DemarrageRefuseError(
          "MIGRATION_ECHOUEE",
          `Migration multi-bot INCOMPLÈTE : ${resultat.cause}\n` +
            "`state/bots.json` n'a PAS été écrit (le bot garde son historique). " +
            "Corrigez la cause puis redémarrez : la migration reprendra où elle s'est arrêtée.\n" +
            `Entrées encore à faire :${listeEnClair(resultat.entrees)}`,
          resultat.entrees,
        );
      }
      case "deja_migre":
        migration = "deja_faite";
        break;
      case "migre":
        migration = "effectuee";
        avertissements.push(...resultat.ignorees.map(messageSurchargeIgnoree));
        break;
    }
    try {
      registre = lireRegistreBots(registrePath);
    } catch (error) {
      throw refusRegistre(error, registrePath);
    }
    if (!registre) {
      // La migration vient d'écrire `bots.json` : son absence serait un bug.
      throw new DemarrageRefuseError(
        "MIGRATION_ECHOUEE",
        `Le registre des bots est introuvable après migration (${registrePath}).`,
      );
    }
  }

  const bot = botActif(registre);
  if (!bot) {
    throw new DemarrageRefuseError(
      "AUCUN_BOT_ACTIF",
      "Le registre des bots ne contient aucun bot actif : démarrage refusé.",
      registre.bots.map((entree) => `${entree.id} (actif=${entree.actif})`),
    );
  }
  if (bot.id !== BOT_YUKI) {
    // ⚠️ Seul `yuki` est attendu à la fin du lot 35a ; un autre identifiant
    // n'est pas une erreur de schéma mais il doit être DIT (pas de surprise).
    avertissements.push(
      `Le bot actif est « ${bot.id} » et non « ${BOT_YUKI} » : résolution par bot appliquée.`,
    );
  }

  // ⚠️ GARDE : `bots.json` présent MAIS un chemin d'origine encore là ⇒ refus.
  const restants = cheminsOrigineEncorePresents(env, bot.id, processEnv);
  if (restants.length > 0) {
    throw new DemarrageRefuseError(
      "MIGRATION_PARTIELLE",
      "MIGRATION_PARTIELLE : `bots.json` existe mais des chemins d'origine sont encore présents.\n" +
        "Démarrage REFUSÉ pour ne pas faire tourner Yuki sur deux dispositions à la fois.\n" +
        `Chemins en double :${listeEnClair(restants)}`,
      restants,
    );
  }

  const resolution = pathsForBot(env, bot.id, { processEnv });
  avertissements.push(
    ...resolution.surchargesIgnorees.map((entree: SurchargeIgnoree) =>
      messageSurchargeIgnoree(entree),
    ),
  );
  return {
    mode: "multi",
    env: resolution.env,
    bot,
    registre,
    chemins: resolution.chemins,
    migration,
    avertissements,
  };
}

/** Liste lisible (`\n  - chemin`) — le message doit NOMMER les chemins en cause. */
function listeEnClair(entrees: readonly string[]): string {
  if (entrees.length === 0) return "";
  return `\n  - ${entrees.join("\n  - ")}`;
}

function refusRegistre(error: unknown, path: string): DemarrageRefuseError {
  if (error instanceof RegistreBotsError) {
    return new DemarrageRefuseError("REGISTRE_INVALIDE", error.message, [path]);
  }
  return new DemarrageRefuseError(
    "REGISTRE_INVALIDE",
    `Registre des bots illisible (${path}) : ${
      error instanceof Error ? error.message : String(error)
    }`,
    [path],
  );
}
