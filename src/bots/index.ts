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

import { join } from "node:path";

import type { Env } from "../config/env.js";

import { resoudreDemarrageBots } from "./actifs.js";
import { botHistoriqueMono } from "./courant.js";
import {
  BOT_YUKI,
  RegistreBotsError,
  cheminRegistreBots,
  lireRegistreBots,
  type BotRecord,
  type RegistreBots,
} from "./registry.js";
import {
  cheminsOrigineEncorePresents,
  etatSessionsOrigine,
  migrerVersMultiBot,
  reparerSessionsBot,
  type EtatSessionsOrigine,
  type JournalisationMigration,
} from "./migrate.js";
import {
  messageSurchargeIgnoree,
  pathsForBot,
  type CheminsBot,
  type SurchargeIgnoree,
} from "./paths.js";

export * from "./registry.js";
export * from "./courant.js";
export * from "./actifs.js";
export * from "./paths.js";
export * from "./migrate.js";
export * from "./admin.js";
// ⚠️ PROFILS DE CAPACITÉS RÉELS (lot 35f) : la garde STRUCTURELLE du worker lourd
// (`workerLourdAutorise`, `construireWorkerLourdSiAutorise`).
export * from "./profils.js";

/** Mode de résolution retenu au démarrage. */
export type ModeBots = "mono" | "multi";

/** Résultat de la préparation du démarrage. */
export interface ResultatPreparationBots {
  mode: ModeBots;
  /** `Env` à utiliser partout ailleurs (surchargé en mode `multi`). */
  env: Env;
  /**
   * `Env` de l'**INSTANCE**, jamais surchargé (lot 35i).
   *
   * ⚠️ C'est LUI qu'attend `pathsForBot` (et donc la fabrique des stores de
   * mémoire par bot, `src/memory/stores-bot.ts`) : le réappliquer à `env`
   * empilerait les chemins (`<pi>/sessions/<botId>/<botId>`).
   */
  envInstance: Env;
  /**
   * Bot du RUN — celui dont le processus tient les objets d'instance
   * (configuration d'instance, `agentExecution`, mémoire, host par défaut).
   *
   * ⚠️ LOT 45 : il n'y a PLUS de « bot principal ». Ce bot est simplement le
   * PREMIER à démarrer (par `ordre`, puis par `id`) : aucun identifiant n'est
   * privilégié, et supprimer `yuki` ne change rien à la règle.
   *
   * ⚠️ Il n'est JAMAIS `null` : en mode mono-bot historique, c'est le bot
   * historique (`botHistoriqueMono`), dont les chemins sont ceux d'avant 35a.
   */
  bot: BotRecord;
  /**
   * Bots qui DOIVENT TOURNER (`actif: true`), TOUS, dans l'ordre de démarrage.
   * En mode mono-bot historique : liste vide.
   *
   * ⚠️ Aucun plafond (décision utilisateur) : la liste n'est jamais tronquée.
   */
  aDemarrer: BotRecord[];
  /** Registre lu (`null` en mode mono-bot historique). */
  registre: RegistreBots | null;
  /** Chemins effectifs du bot (`null` en mode mono-bot historique). */
  chemins: CheminsBot | null;
  /** Migration effectuée pendant CETTE préparation ? */
  migration: "aucune" | "effectuee" | "deja_faite" | "sessions_reprises" | "impossible";
  /** Avertissements À JOURNALISER au démarrage (surcharges ignorées…). */
  avertissements: string[];
}

/** Codes de refus de démarrage — chacun avec un message FRANÇAIS explicite. */
export type CodeRefusDemarrage =
  | "MIGRATION_PARTIELLE"
  | "MIGRATION_ECHOUEE"
  | "SESSIONS_NON_MIGREES"
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
  /**
   * Reprise AUTOMATIQUE des sessions restées à plat quand `bots.json` existe
   * (défaut : `true`). `false` ⇒ refus explicite `SESSIONS_NON_MIGREES`, sans
   * aucun déplacement (démarrage en lecture seule).
   */
  reparationSessions?: boolean;
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
        envInstance: env,
        bot: botHistoriqueMono(),
        aDemarrer: [],
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
          envInstance: env,
          bot: botHistoriqueMono(),
          aDemarrer: [],
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

  // ⚠️ LOT 45 — AUCUN « BOT PRINCIPAL » : plus d'élection par identité. Le bot du
  // RUN est le premier à démarrer (par `ordre`, puis `id`) ; les autres sont ses
  // ÉGAUX. AUCUN plafond non plus : tous les bots `actif: true` démarrent
  // (décision utilisateur du 2026-11-13).
  const demarrage = resoudreDemarrageBots(registre);
  const bot = demarrage.botCourant;
  if (!bot || demarrage.aDemarrer.length === 0) {
    // ⚠️ Aucun bot ACTIF : il n'y a rien à faire tourner. Le refus nomme l'état
    // exact — mieux vaut ne pas démarrer qu'inventer un bot.
    throw new DemarrageRefuseError(
      "AUCUN_BOT_ACTIF",
      "Aucun bot n'est marqué actif (« doit tourner ») : démarrage refusé.",
      registre.bots.map((entree) => `${entree.id} (actif=${entree.actif})`),
    );
  }

  // ⚠️ GARDE ① (volume `pi`) : les SESSIONS du bot. La racine
  // (`/data/pi/agent/sessions`) EXISTE TOUJOURS après migration — elle contient
  // les dossiers des bots. Elle n'est donc un problème que si des sessions y
  // sont restées À PLAT : dans ce cas on REPREND la migration (au lieu de
  // refuser), et on ne refuse que si la reprise est impossible (conflit de nom,
  // volume en lecture seule).
  const botIds = registre.bots.map((entree) => entree.id);
  // ⚠️ Le dossier d'ORIGINE des sessions est celui du bot historique quand il
  // existe encore (c'est SON dossier qui a été mis à plat avant 35a). Sinon,
  // c'est celui du bot du run : aucun identifiant n'est inventé.
  const botSessions = botIds.includes(BOT_YUKI) ? BOT_YUKI : bot.id;
  const etatSessions = etatSessionsOrigine(env, botSessions, { botIds });
  if (etatSessions.nonMigrees) {
    if (options.reparationSessions === false) {
      throw refusSessionsNonMigrees(etatSessions, null);
    }
    const reparation = reparerSessionsBot(env, botSessions, { botIds });
    switch (reparation.etat) {
      case "repare":
        migration = "sessions_reprises";
        avertissements.push(
          `Sessions Pi NON migrées : ${reparation.deplaces.length} entrée(s) rangée(s) ` +
            `sous ${reparation.cible} (reprise automatique, contenus inchangés).`,
        );
        break;
      case "conflit":
        throw refusSessionsNonMigrees(etatSessions, reparation);
      case "impossible":
        throw refusSessionsNonMigrees(etatSessions, reparation);
      case "rien_a_faire":
        // Incohérence (l'état dit « à plat », la reprise ne trouve rien) : on
        // refuse plutôt que de démarrer sur un doute.
        throw refusSessionsNonMigrees(etatSessions, {
          etat: "impossible",
          cause: "aucune entrée n'a pu être reprise",
        });
    }
  } else if (etatSessions.restes.length > 0) {
    // Sessions rangées (journal `faite`) : ces entrées ne sont pas les siennes
    // (dossier d'un autre bot, résidus). Aucun refus — mais on le DIT.
    avertissements.push(
      `Dossier de sessions ${etatSessions.origine} : entrées sans dossier de bot ` +
        `connu (${etatSessions.restes.join(", ")}) — laissées EN PLACE.`,
    );
  }

  // ⚠️ GARDE ② (volume `state`) : `bots.json` présent MAIS un chemin d'origine
  // encore là ⇒ refus.
  const restants = cheminsOrigineEncorePresents(env, bot.id, processEnv, { botIds });
  if (restants.length > 0) {
    throw new DemarrageRefuseError(
      "MIGRATION_PARTIELLE",
      "MIGRATION_PARTIELLE : `bots.json` existe mais des chemins d'origine sont encore présents.\n" +
        "Démarrage REFUSÉ pour ne pas faire tourner un bot sur deux dispositions à la fois.\n" +
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
    envInstance: env,
    bot,
    aDemarrer: [...demarrage.aDemarrer],
    registre,
    chemins: resolution.chemins,
    migration,
    avertissements,
  };
}

/** Refus : sessions restées à plat et reprise impossible. Message DISTINCT du
 * « chemins en double » (ce n'est pas la même cause ni le même remède). */
function refusSessionsNonMigrees(
  etat: EtatSessionsOrigine,
  reparation: { etat: "conflit"; conflits: string[] } | { etat: "impossible"; cause: string } | null,
): DemarrageRefuseError {
  const details = etat.restes.map((nom) => join(etat.origine, nom));
  let remede: string;
  if (reparation === null) {
    remede =
      "Reprise AUTOMATIQUE désactivée (`reparationSessions: false`) : relancez sans la désactiver.";
  } else if (reparation.etat === "conflit") {
    remede =
      `Un dossier de bot existe déjà (${etat.cible}) et contient les mêmes noms : ` +
      `rien n'est écrasé. Rangez ou renommez ${reparation.conflits.join(", ")} à la main, puis redémarrez.`;
  } else {
    remede = `Reprise impossible (${reparation.cause}) : la migration reprendra au redémarrage.`;
  }
  return new DemarrageRefuseError(
    "SESSIONS_NON_MIGREES",
    "SESSIONS_NON_MIGREES : `bots.json` existe mais les sessions Pi ne sont pas rangées " +
      `sous le dossier du bot (${etat.cible}).\n` +
      "Démarrage REFUSÉ : lancer Yuki maintenant ferait lire les sessions au mauvais endroit " +
      "(l'historique serait vu comme vide).\n" +
      `Sessions non migrées :${listeEnClair(details)}\n` +
      `Remède : ${remede}`,
    details,
  );
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
