/**
 * MIGRATION MONO-BOT → MULTI-BOT (lot 35a, étape 1 : STRUCTURE + MIGRATION).
 *
 * ⚠️ OBJECTIF : déplacer les fichiers DU BOT HISTORIQUE (`yuki`) sous
 * `<state>/bots/yuki/` (et ses sessions sous `<pi>/agent/sessions/yuki`), puis
 * écrire `state/bots.json` — c'est CETTE écriture qui bascule le système en
 * résolution par bot. Aucun contenu n'est transformé : ce sont des `rename`,
 * donc les octets sont IDENTIQUES avant et après.
 *
 * ## Ordre IMPOSÉ (une coupure à n'importe quel moment reste reprenable)
 *  ① journal `state/migration-multibot.json` en `en_cours` ;
 *  ② `mkdir state/bots/<botId>/` ;
 *  ③ les chemins du volume `state` (`rename` sur le MÊME volume ⇒ atomique) ;
 *  ④ `piSessionsDir` — ⚠️ AUTRE VOLUME (`/data/pi`), donc NON atomique avec ③ ;
 *  ⑤ écriture FINALE de `bots.json` — la bascule ;
 *  ⑥ journal `termine`.
 *
 * Le journal est réécrit **après CHAQUE `rename` réussi** : une coupure ne
 * laisse jamais une entrée « faite » non enregistrée ni l'inverse.
 *
 * ## ⚠️ Règle vitale : les sessions Pi d'abord, `bots.json` ensuite
 * Si le déplacement des sessions échoue, `bots.json` n'est PAS écrit. Sinon
 * l'interface chercherait les conversations sous `<sessions>/<botId>` alors
 * qu'elles sont encore à la racine : Yuki **perdrait son historique de
 * conversations** (plus aucune reprise possible).
 *
 * Aucun import SDK/typebox.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import type { Env } from "../config/env.js";

import {
  BOT_YUKI,
  cheminRegistreBots,
  creerRegistreInitial,
  ecrireFichierAtomique0600,
  ecrireRegistreBots,
} from "./registry.js";
import {
  CHEMINS_BOT,
  CHEMINS_DERIVES,
  messageSurchargeIgnoree,
  racineBot,
  surchargesIgnorees,
  type CleChemin,
  type NatureChemin,
  type SurchargeIgnoree,
  type VolumeChemin,
} from "./paths.js";

/** Nom du journal de migration (sur le volume `state`). */
export const JOURNAL_MIGRATION_FICHIER = "migration-multibot.json";

/** Version du journal. */
export const JOURNAL_MIGRATION_VERSION = 1;

/** États du journal. */
export type EtatMigration = "en_cours" | "termine";

/** Statut d'une entrée : à faire, ou déjà déplacée. */
export type StatutEntree = "a_faire" | "faite";

/** Une ligne du journal : UN déplacement. */
export interface EntreeJournal {
  /** Clé de chemin (champ d'`Env` ou chemin dérivé). */
  cle: string;
  /** Chemin d'origine (mono-bot). */
  de: string;
  /** Chemin cible (sous le bot). */
  vers: string;
  volume: VolumeChemin;
  statut: StatutEntree;
}

/** Contenu de `state/migration-multibot.json`. */
export interface JournalMigration {
  version: 1;
  etat: EtatMigration;
  entrees: EntreeJournal[];
}

/** Une entrée du plan de migration (avant journalisation). */
export interface EntreePlan {
  cle: CleChemin;
  volume: VolumeChemin;
  nature: NatureChemin;
  origine: string;
  cible: string;
}

/** Plan de migration : les déplacements à faire et les surcharges ignorées. */
export interface PlanMigration {
  entrees: EntreePlan[];
  ignorees: SurchargeIgnoree[];
}

/** Résultat d'une migration. */
export type ResultatMigration =
  /** `bots.json` existait déjà : rien à faire. */
  | { etat: "deja_migre"; registrePath: string }
  /** Migration terminée : `bots.json` est écrit. */
  | { etat: "migre"; deplacees: number; ignorees: SurchargeIgnoree[]; journalPath: string }
  /**
   * Volume `state` non inscriptible AVANT tout déplacement : on reste en mode
   * mono-bot historique. ⚠️ Aucun fichier n'a été touché.
   */
  | { etat: "sans_volume"; avertissements: string[] }
  /** Échec en cours de route : `bots.json` n'est PAS écrit. */
  | {
      etat: "echec";
      code: "MIGRATION_ECHOUEE";
      cause: string;
      /** Entrées encore `a_faire` (identifiants de chemin). */
      entrees: string[];
    };

/** Journalisation minimale (facultative). */
export interface JournalisationMigration {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** Options d'exécution (les coutures servent aux tests). */
export interface OptionsMigration {
  botId?: string;
  processEnv?: NodeJS.ProcessEnv;
  logger?: JournalisationMigration;
  /** Déplacement bas niveau (défaut : `renameSync`). Injecté pour les tests. */
  deplacer?: (origine: string, cible: string) => void;
  /**
   * Appelé APRÈS chaque entrée enregistrée comme faite. ⚠️ Une exception levée
   * ici n'est PAS rattrapée : c'est la simulation d'une COUPURE (arrêt brutal).
   */
  apresEntree?: (entree: EntreeJournal, index: number) => void;
}

/** Chemin du journal de migration. */
export function cheminJournalMigration(stateDir: string): string {
  return join(stateDir, JOURNAL_MIGRATION_FICHIER);
}

/** Chemin de transit du dossier de sessions (même volume `pi` ⇒ `rename`). */
export function cheminTransitSessions(origine: string): string {
  return join(dirname(origine), `${basename(origine)}.en-migration`);
}

/**
 * Construit le plan : tous les chemins du bot, SAUF ceux qu'une surcharge de
 * déploiement place hors de leur volume (⚠️ aucun déplacement sauvage).
 */
export function planifierMigration(
  env: Env,
  botId: string = BOT_YUKI,
  processEnv: NodeJS.ProcessEnv = process.env,
): PlanMigration {
  const ignorees = surchargesIgnorees(env, processEnv);
  const ignoreesCles = new Set<string>(ignorees.map((entree) => entree.cle));
  const racine = racineBot(env, botId);
  const entrees: EntreePlan[] = [];
  for (const definition of CHEMINS_BOT) {
    if (ignoreesCles.has(definition.cle)) continue;
    const origine = env[definition.cle];
    const cible =
      definition.volume === "pi"
        ? join(env.piSessionsDir, botId)
        : join(racine, definition.relatif);
    entrees.push({
      cle: definition.cle,
      volume: definition.volume,
      nature: definition.nature,
      origine,
      cible,
    });
  }
  for (const definition of CHEMINS_DERIVES) {
    entrees.push({
      cle: definition.cle,
      volume: definition.volume,
      nature: definition.nature,
      origine: definition.origine(env),
      cible: join(racine, definition.relatif),
    });
  }
  return { entrees, ignorees };
}

/**
 * État de la RACINE des sessions Pi (`<pi>/agent/sessions`) au regard de la
 * migration d'un bot.
 *
 * ⚠️ Ce dossier d'origine EXISTE TOUJOURS après migration : il est le PARENT du
 * dossier du bot (`<origine>/<botId>`). Sa simple présence ne prouve donc rien.
 * Ce qui distingue les deux états, c'est le CONTENU de la racine :
 *  - un dossier de bot CONNU (`<origine>/<autreBot>`) ⇒ normal, jamais touché ;
 *  - d'autres entrées (dossiers de projet Pi, fichiers) ⇒ sessions restées À
 *    PLAT, donc NON migrées — sauf si le journal atteste le déplacement fait
 *    (`statut: "faite"`) : dans ce cas la racine ne porte plus les sessions de
 *    CE bot et ses entrées ne sont pas des doublons (autres bots, résidus).
 */
export interface EtatSessionsOrigine {
  /** Racine des sessions (`env.piSessionsDir`, volume `pi`). */
  readonly origine: string;
  /** Dossier de sessions du bot (`<origine>/<botId>`). */
  readonly cible: string;
  /** Vrai si le dossier de sessions du bot existe déjà. */
  readonly ciblePresente: boolean;
  /** Entrées de la racine qui n'appartiennent à aucun bot connu. */
  readonly restes: string[];
  /**
   * Vrai si ces entrées SONT les sessions du bot restées à plat : la reprise
   * (`reparerSessionsBot`) les déplace sous `<origine>/<botId>`.
   */
  readonly nonMigrees: boolean;
}

/** Options communes aux contrôles du dossier de sessions. */
export interface OptionsSessions {
  /**
   * Identifiants de bots CONNUS (registre). Leur dossier à la racine est
   * légitime : il n'est ni un doublon, ni une session à plat.
   */
  botIds?: Iterable<string>;
  /** Déplacement bas niveau (défaut : `renameSync`). Injecté pour les tests. */
  deplacer?: (origine: string, cible: string) => void;
}

/** Décrit l'état de la racine des sessions pour `botId`. */
export function etatSessionsOrigine(
  env: Env,
  botId: string = BOT_YUKI,
  options: OptionsSessions = {},
): EtatSessionsOrigine {
  const origine = env.piSessionsDir;
  const cible = join(origine, botId);
  const connus = new Set<string>([...(options.botIds ?? []), botId]);
  const ciblePresente = estRepertoire(cible);

  let restes: string[] = [];
  if (existsSync(origine) && estRepertoire(origine)) {
    let noms: string[];
    try {
      noms = readdirSync(origine);
    } catch {
      // Racine illisible : on ne conclut RIEN (jamais de refus sur un doute).
      noms = [];
    }
    restes = noms.filter((nom) => !(connus.has(nom) && estRepertoire(join(origine, nom))));
  }

  return {
    origine,
    cible,
    ciblePresente,
    restes,
    nonMigrees: restes.length > 0 && !(ciblePresente && sessionsDejaDeplacees(env)),
  };
}

/** Vrai si le journal de migration atteste que les sessions du bot sont rangées. */
function sessionsDejaDeplacees(env: Env): boolean {
  const journal = lireJournalMigration(cheminJournalMigration(env.mountPoints.state));
  if (!journal) return false;
  return journal.entrees.some(
    (entree) => entree.cle === "piSessionsDir" && entree.statut === "faite",
  );
}

/** Résultat d'une reprise du dossier de sessions. */
export type ResultatReparationSessions =
  /** Rien à déplacer : sessions déjà rangées, ou entrées étrangères au bot. */
  | { etat: "rien_a_faire"; etatSessions: EtatSessionsOrigine }
  /** Entrées déplacées sous le dossier du bot (aucun contenu transformé). */
  | { etat: "repare"; cible: string; deplaces: string[] }
  /** Noms déjà présents dans la cible : refus, RIEN n'a été déplacé. */
  | { etat: "conflit"; cible: string; conflits: string[] }
  /** Déplacement impossible (droits, volume…) : rien de perdu, rien de fini. */
  | { etat: "impossible"; cause: string };

/**
 * REPRISE de la migration des sessions : quand `bots.json` existe alors que des
 * sessions sont restées À PLAT, on ne refuse pas — on les range sous
 * `<origine>/<botId>` (`rename` dans le MÊME volume : atomique, contenu
 * IDENTIQUE). ⚠️ Aucun écrasement : un nom déjà présent dans la cible fait
 * échouer la reprise AVANT tout déplacement.
 *
 * Idempotent : rappelée après une reprise réussie, elle ne fait rien.
 */
export function reparerSessionsBot(
  env: Env,
  botId: string = BOT_YUKI,
  options: OptionsSessions = {},
): ResultatReparationSessions {
  const etatSessions = etatSessionsOrigine(env, botId, options);
  if (etatSessions.restes.length === 0) return { etat: "rien_a_faire", etatSessions };
  // Entrées étrangères au bot (autre bot, résidus) : on ne touche à RIEN.
  if (!etatSessions.nonMigrees) return { etat: "rien_a_faire", etatSessions };

  const conflits = etatSessions.restes.filter((nom) =>
    existsSync(join(etatSessions.cible, nom)),
  );
  if (conflits.length > 0) {
    return { etat: "conflit", cible: etatSessions.cible, conflits };
  }

  const deplacer = options.deplacer ?? deplacerParRenommage;
  const deplaces: string[] = [];
  try {
    mkdirSync(etatSessions.cible, { recursive: true });
    for (const nom of etatSessions.restes) {
      deplacer(join(etatSessions.origine, nom), join(etatSessions.cible, nom));
      deplaces.push(nom);
    }
  } catch (error) {
    // ⚠️ Une coupure en cours de reprise laisse un état REPRENABLE : les entrées
    // déjà déplacées sont dans la cible, les autres encore à plat.
    return { etat: "impossible", cause: messageOf(error) };
  }
  return { etat: "repare", cible: etatSessions.cible, deplaces };
}

/**
 * Liste les chemins d'ORIGINE encore présents alors que `bots.json` existe.
 * ⚠️ Un démarrage dans cet état est REFUSÉ (`MIGRATION_PARTIELLE`) : jamais de
 * fonctionnement à moitié migré.
 *
 * Cas particulier des sessions (`/data/pi/agent/sessions`) : le dossier
 * d'origine EXISTE TOUJOURS après migration (il CONTIENT `<botId>`) ; il n'est
 * donc signalé que si des sessions y sont restées À PLAT (voir
 * `etatSessionsOrigine`) — un dossier de bot connu n'est jamais un doublon.
 */
export function cheminsOrigineEncorePresents(
  env: Env,
  botId: string = BOT_YUKI,
  processEnv: NodeJS.ProcessEnv = process.env,
  options: OptionsSessions = {},
): string[] {
  const plan = planifierMigration(env, botId, processEnv);
  const presents: string[] = [];
  for (const entree of plan.entrees) {
    if (entree.volume === "pi") {
      const etat = etatSessionsOrigine(env, botId, options);
      if (etat.nonMigrees) presents.push(etat.origine);
      continue;
    }
    if (existsSync(entree.origine)) presents.push(entree.origine);
  }
  return presents;
}

function estRepertoire(chemin: string): boolean {
  try {
    return statSync(chemin).isDirectory();
  } catch {
    return false;
  }
}

/** Lit le journal. `null` s'il est absent ; une forme invalide est ignorée. */
export function lireJournalMigration(path: string): JournalMigration | null {
  let texte: string;
  try {
    texte = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    const brut: unknown = JSON.parse(texte);
    if (typeof brut !== "object" || brut === null || Array.isArray(brut)) return null;
    const obj = brut as Record<string, unknown>;
    if (obj["version"] !== JOURNAL_MIGRATION_VERSION) return null;
    const etat = obj["etat"];
    if (etat !== "en_cours" && etat !== "termine") return null;
    const brutes = obj["entrees"];
    if (!Array.isArray(brutes)) return null;
    const entrees: EntreeJournal[] = [];
    for (const brute of brutes as unknown[]) {
      if (typeof brute !== "object" || brute === null) return null;
      const entree = brute as Record<string, unknown>;
      const cle = entree["cle"];
      const de = entree["de"];
      const vers = entree["vers"];
      const volume = entree["volume"];
      const statut = entree["statut"];
      if (typeof cle !== "string") return null;
      if (typeof de !== "string" || typeof vers !== "string") return null;
      if (volume !== "state" && volume !== "pi") return null;
      if (statut !== "a_faire" && statut !== "faite") return null;
      entrees.push({ cle, de, vers, volume, statut });
    }
    return { version: JOURNAL_MIGRATION_VERSION, etat, entrees };
  } catch {
    return null;
  }
}

/** Écrit le journal de façon ATOMIQUE et en 0600 (comme le registre). */
export function ecrireJournalMigration(path: string, journal: JournalMigration): void {
  ecrireFichierAtomique0600(path, `${JSON.stringify(journal, null, 2)}\n`);
}

/** Migration complète (reprise idempotente incluse). */
export function migrerVersMultiBot(
  env: Env,
  options: OptionsMigration = {},
): ResultatMigration {
  const botId = options.botId ?? BOT_YUKI;
  const logger = options.logger;
  const stateDir = env.mountPoints.state;
  const registrePath = cheminRegistreBots(stateDir);
  const journalPath = cheminJournalMigration(stateDir);

  // ⓪ `bots.json` déjà écrit : le système est déjà basculé.
  if (existsSync(registrePath)) {
    return { etat: "deja_migre", registrePath };
  }

  const plan = planifierMigration(env, botId, options.processEnv);
  for (const ignoree of plan.ignorees) {
    logger?.warn("bots.migration.surcharge_ignoree", {
      variable: ignoree.variable,
      valeur: ignoree.valeur,
      volume: ignoree.volume,
      detail: messageSurchargeIgnoree(ignoree),
    });
  }

  // ① JOURNAL — écrit AVANT tout déplacement (reprise après coupure).
  const ignoreesCles = new Set<string>(plan.ignorees.map((entree) => entree.cle));
  const journalExistant = lireJournalMigration(journalPath);
  let journal: JournalMigration;
  if (journalExistant) {
    journal = fusionnerJournal(journalExistant, plan.entrees, ignoreesCles, logger);
    reecrireJournal(journalPath, journal, logger);
  } else {
    journal = {
      version: JOURNAL_MIGRATION_VERSION,
      etat: "en_cours",
      entrees: plan.entrees.map((entree) => ({
        cle: entree.cle,
        de: entree.origine,
        vers: entree.cible,
        volume: entree.volume,
        statut: "a_faire",
      })),
    };
    try {
      ecrireJournalMigration(journalPath, journal);
    } catch (error) {
      // ⚠️ Rien n'a encore été déplacé : on reste en mode mono-bot historique.
      const detail = `journal de migration non inscriptible (${journalPath}) : ${messageOf(error)}`;
      logger?.warn("bots.migration.sans_volume", { detail });
      return { etat: "sans_volume", avertissements: [detail] };
    }
  }

  const deplacer = options.deplacer ?? deplacerParRenommage;

  // ② Racine du bot.
  try {
    mkdirSync(racineBot(env, botId), { recursive: true });
  } catch (error) {
    return echecMigration(
      journal,
      `création de ${racineBot(env, botId)} impossible : ${messageOf(error)}`,
      logger,
    );
  }

  const parCle = new Map<string, EntreePlan>(
    plan.entrees.map((entree) => [entree.cle as string, entree]),
  );

  // ③④ Déplacements, entrée par entrée, journal réécrit après CHAQUE succès.
  let deplacees = 0;
  for (const [index, entree] of journal.entrees.entries()) {
    if (entree.statut === "faite") continue;
    // Les chemins du plan courant priment : l'environnement a pu changer entre
    // deux démarrages. Une entrée absente du plan (chemin retiré du code) est
    // rejouée avec les chemins HISTORIQUES qu'elle porte.
    const courante = parCle.get(entree.cle);
    const origine = courante?.origine ?? entree.de;
    const cible = courante?.cible ?? entree.vers;
    try {
      if (entree.volume === "pi") {
        deplacerSessions(origine, cible, deplacer);
      } else {
        deplacerChemin(origine, cible, deplacer);
      }
    } catch (error) {
      // ⚠️ On n'écrit PAS `bots.json` : le système reste cohérent avec le
      // journal, et la prochaine tentative reprend les entrées `a_faire`.
      return echecMigration(
        journal,
        `déplacement de ${origine} vers ${cible} impossible : ${messageOf(error)}`,
        logger,
      );
    }
    entree.statut = "faite";
    deplacees += 1;
    reecrireJournal(journalPath, journal, logger);
    logger?.info("bots.migration.entree", {
      cle: entree.cle,
      volume: entree.volume,
      nature: courante?.nature ?? null,
      de: origine,
      vers: cible,
    });
    options.apresEntree?.(entree, index);
  }

  // ⑤ `bots.json` : LA bascule. Écrite en DERNIER, après les sessions.
  try {
    ecrireRegistreBots(registrePath, creerRegistreInitial({ botId }));
  } catch (error) {
    return echecMigration(
      journal,
      `écriture de ${registrePath} impossible : ${messageOf(error)}`,
      logger,
    );
  }

  // ⑥ Journal `termine` (meilleur effort : `bots.json` est déjà la vérité).
  journal.etat = "termine";
  reecrireJournal(journalPath, journal, logger);
  logger?.info("bots.migration.terminee", {
    botId,
    deplacees,
    ignorees: plan.ignorees.length,
  });
  return { etat: "migre", deplacees, ignorees: plan.ignorees, journalPath };
}

/** Déplacement par défaut : `rename` (jamais une copie, jamais un contenu transformé). */
function deplacerParRenommage(origine: string, cible: string): void {
  renameSync(origine, cible);
}

/** Déplace un fichier ou un dossier simple. Idempotent. */
function deplacerChemin(
  origine: string,
  cible: string,
  deplacer: (origine: string, cible: string) => void,
): void {
  if (!existsSync(origine)) return; // déjà déplacé, ou jamais créé
  if (existsSync(cible)) {
    throw new Error(
      `la cible existe déjà (${cible}) alors que l'origine est encore là (${origine}) : conflit, aucun écrasement`,
    );
  }
  mkdirSync(dirname(cible), { recursive: true });
  deplacer(origine, cible);
}

/**
 * Déplace le dossier de SESSIONS du bot (`<pi>/agent/sessions` →
 * `<pi>/agent/sessions/<botId>`).
 *
 * ⚠️ `rename(<sessions>) → <sessions>/<botId>` est impossible (un dossier ne
 * peut pas devenir son propre sous-dossier). On passe donc par un dossier de
 * TRANSIT, sur le MÊME volume (`pi`) : deux `rename` au lieu d'une copie
 * récursive. Une coupure entre les deux est reprise au démarrage suivant.
 */
function deplacerSessions(
  origine: string,
  cible: string,
  deplacer: (origine: string, cible: string) => void,
): void {
  const transit = cheminTransitSessions(origine);
  const nomBot = basename(cible);
  if (existsSync(cible)) {
    if (existsSync(transit)) {
      throw new Error(
        `dossier de transit résiduel (${transit}) alors que ${cible} existe : intervention manuelle requise`,
      );
    }
    // Déjà déplacé. Il ne doit rien rester d'autre à la racine.
    const restes = existsSync(origine) ? readdirSync(origine).filter((nom) => nom !== nomBot) : [];
    if (restes.length === 0) return;
    throw new Error(
      `la cible ${cible} existe alors que ${origine} contient encore : ${restes.join(", ")}`,
    );
  }
  if (existsSync(transit)) {
    // Reprise : le premier `rename` a eu lieu, le second non.
    mkdirSync(origine, { recursive: true });
    deplacer(transit, cible);
    return;
  }
  if (!existsSync(origine)) return; // aucune session : rien à déplacer
  if (!estRepertoire(origine)) {
    throw new Error(`${origine} n'est pas un dossier : déplacement des sessions impossible`);
  }
  if (readdirSync(origine).length === 0) return; // dossier vide : rien à déplacer
  deplacer(origine, transit);
  mkdirSync(origine, { recursive: true });
  deplacer(transit, cible);
}

/**
 * Fusionne le journal lu sur le disque avec le plan courant : les entrées
 * `faite` restent FAITES (on ne rejoue jamais un déplacement), les entrées du
 * plan absentes du journal sont ajoutées `a_faire`.
 */
function fusionnerJournal(
  journal: JournalMigration,
  plan: readonly EntreePlan[],
  ignoreesCles: ReadonlySet<string>,
  logger?: JournalisationMigration,
): JournalMigration {
  const parCle = new Map<string, EntreeJournal>();
  for (const entree of journal.entrees) {
    if (entree.statut === "a_faire" && ignoreesCles.has(entree.cle)) {
      // ⚠️ Une surcharge de déploiement apparue depuis le début de la migration
      // INTERDIT ce déplacement : l'entrée quitte la liste des travaux à faire.
      logger?.warn("bots.migration.entree_ignoree", {
        cle: entree.cle,
        de: entree.de,
        vers: entree.vers,
      });
      continue;
    }
    parCle.set(entree.cle, entree);
  }
  const entrees: EntreeJournal[] = [];
  for (const entree of plan) {
    const connue = parCle.get(entree.cle);
    if (connue) {
      // Une entrée déjà `faite` garde ses chemins HISTORIQUES ; une entrée
      // `a_faire` reprend les chemins du plan courant (l'environnement a pu
      // changer entre deux démarrages).
      entrees.push(
        connue.statut === "faite"
          ? connue
          : { ...connue, de: entree.origine, vers: entree.cible, statut: "a_faire" },
      );
      parCle.delete(entree.cle);
    } else {
      entrees.push({
        cle: entree.cle,
        de: entree.origine,
        vers: entree.cible,
        volume: entree.volume,
        statut: "a_faire",
      });
    }
  }
  // ⚠️ Aucune entrée du journal n'est PERDUE : celles qui ne sont plus dans le
  // plan (surcharge ajoutée depuis) sont conservées telles quelles.
  for (const restante of parCle.values()) entrees.push(restante);
  return {
    version: JOURNAL_MIGRATION_VERSION,
    etat: journal.etat === "termine" ? "en_cours" : journal.etat,
    entrees,
  };
}

function reecrireJournal(
  path: string,
  journal: JournalMigration,
  logger?: JournalisationMigration,
): void {
  try {
    ecrireJournalMigration(path, journal);
  } catch (error) {
    // Le journal est un FILET : ne pas pouvoir le réécrire n'annule pas un
    // déplacement réussi, mais c'est signalé (la reprise reposera sur l'état
    // réel du disque, qui est idempotent).
    logger?.warn("bots.migration.journal_echec", {
      path,
      error: messageOf(error),
    });
  }
}

function echecMigration(
  journal: JournalMigration,
  cause: string,
  logger?: JournalisationMigration,
): ResultatMigration {
  const restantes = journal.entrees
    .filter((entree) => entree.statut === "a_faire")
    .map((entree) => `${entree.cle} (${entree.de} → ${entree.vers})`);
  logger?.error("bots.migration.echec", { cause, restantes });
  return {
    etat: "echec",
    code: "MIGRATION_ECHOUEE",
    cause,
    entrees: restantes,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
