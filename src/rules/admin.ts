/**
 * ÉDITION DES RÈGLES — l'interface écrit LE FICHIER QU'ELLE LIT.
 *
 * ⚠️ PROBLÈME RÉSOLU : `GET/PUT /api/self/rules` écrivait dans un store ouvert sur
 * `<state>/rules.md` (fichier d'INSTANCE), alors que l'injection lit d'abord le
 * fichier DU BOT (`<state>/bots/<id>/rules.md`, déplacé là par la migration du
 * lot 35a). Après migration, l'utilisateur enregistrait donc ses règles dans un
 * fichier que **plus personne ne lisait** : l'enregistrement « réussissait » et
 * rien ne changeait dans le prompt — la pire des pannes, une panne SILENCIEUSE.
 *
 * Ce store applique donc EXACTEMENT la résolution du port de lecture
 * (`src/rules/regles-bot.ts`, `candidatsRegles`) et écrit le premier fichier qui
 * DIT quelque chose :
 *   ① le fichier du bot, s'il contient déjà des règles (c'est lui qui est injecté) ;
 *   ② le fichier d'instance, s'il contient déjà des règles ;
 *   ③ sinon, la cible est le fichier d'instance (`<state>/rules.md`) : c'est
 *      l'emplacement historique et PARTAGÉ, donc celui qui convient à des règles
 *      communes ; après écriture, la résolution le trouve en ② et le lit.
 *
 * ⚠️ Aucun `botId` n'est traité à part, et aucun fichier existant n'est déplacé ni
 * écrasé : chaque cible a son propre historique (`rules-history`) et son propre
 * journal (`rules-journal.jsonl`), posés à côté du fichier écrit.
 *
 * Aucun import SDK/typebox.
 */

import { existsSync } from "node:fs";

import { RULES_MAX_CHARS } from "./rules.js";
import {
  candidatsRegles,
  lireDocumentRegles,
  type CandidatFichierRegles,
  type PorteeFichierRegles,
} from "./regles-bot.js";
import { RulesStore } from "./store.js";
import type {
  RulesAdminPort,
  RulesDocument,
  RulesHistoryEntry,
  RulesLogger,
  RulesSource,
  RulesWriteResult,
} from "./types.js";

/** Emplacement courant de l'édition (ce que l'interface doit DIRE). */
export interface EmplacementRegles {
  /** Fichier qui sera lu ET écrit. */
  readonly chemin: string;
  /** `bot` (fichier du bot) ou `instance` (fichier historique, partagé). */
  readonly portee: PorteeFichierRegles;
  /** `true` si le fichier contient déjà des règles (sinon il sera créé). */
  readonly existe: boolean;
}

export interface OptionsReglesAdmin {
  /**
   * Fichier HISTORIQUE de l'instance (`<state>/rules.md`) : cible par DÉFAUT
   * quand aucun fichier ne contient encore de règles.
   */
  readonly instancePath: string;
  /** Fichier DU BOT de la pile (`<state>/bots/<id>/rules.md`). */
  readonly cheminBot?: string;
  readonly logger?: RulesLogger;
  /** Horloge des snapshots (tests). */
  readonly now?: () => number;
  /** Valeurs à masquer dans le journal d'écriture (tests). */
  readonly secretValues?: string[];
}

/**
 * Port d'administration des règles : lecture à chaud (même résolution que
 * l'injection) + écriture atomique, historique et réversion sur le fichier LU.
 */
export class ReglesAdminEffectives implements RulesAdminPort {
  readonly maxChars = RULES_MAX_CHARS;
  private readonly instancePath: string;
  private readonly cheminBot: string | undefined;
  private readonly logger: RulesLogger | undefined;
  private readonly now: (() => number) | undefined;
  private readonly secretValues: string[] | undefined;
  /** Un store par fichier cible (un seul écrivain par fichier). */
  private readonly stores = new Map<string, RulesStore>();

  constructor(options: OptionsReglesAdmin) {
    this.instancePath = options.instancePath;
    this.cheminBot = options.cheminBot;
    this.logger = options.logger;
    this.now = options.now;
    this.secretValues = options.secretValues;
  }

  /** Fichiers candidats, dans l'ordre de priorité de l'injection. */
  candidats(): CandidatFichierRegles[] {
    return candidatsRegles(
      this.cheminBot !== undefined
        ? { portee: "bot", chemin: this.cheminBot }
        : undefined,
      { portee: "instance", chemin: this.instancePath },
    );
  }

  /**
   * Fichier qui sera LU et ÉCRIT.
   *
   * ⚠️ C'est la même règle que l'injection : le premier candidat REMPLI gagne ;
   * à défaut, le fichier d'instance (partagé) est créé.
   */  emplacement(): EmplacementRegles {
    const candidats = this.candidats();
    for (const candidat of candidats) {
      const document = lireDocumentRegles(candidat.chemin);
      // Un fichier EXISTANT mais vide n'est pas une source : il ne dit rien
      // (même règle que la résolution), mais il est le bon endroit pour écrire.
      if (document.text.trim() !== "") {
        return { chemin: candidat.chemin, portee: candidat.portee, existe: true };
      }
    }
    for (const candidat of candidats) {
      if (existsSync(candidat.chemin)) {
        return { chemin: candidat.chemin, portee: candidat.portee, existe: true };
      }
    }
    const instance = candidats.find((candidat) => candidat.portee === "instance");
    const cible = instance ?? candidats[0];
    if (cible === undefined) {
      // Impossible en pratique (`instancePath` est toujours fourni) : on le DIT
      // plutôt que d'écrire au hasard.
      throw new Error("Aucun fichier de règles cible : chemin d'instance absent.");
    }
    return { chemin: cible.chemin, portee: cible.portee, existe: false };
  }

  /** Store du fichier courant (un par chemin, jamais deux écrivains). */
  private store(): RulesStore {
    const cible = this.emplacement().chemin;
    const existant = this.stores.get(cible);
    if (existant !== undefined) return existant;
    const store = new RulesStore({
      path: cible,
      ...(this.logger !== undefined ? { logger: this.logger } : {}),
      ...(this.now !== undefined ? { now: this.now } : {}),
      ...(this.secretValues !== undefined ? { secretValues: this.secretValues } : {}),
    });
    this.stores.set(cible, store);
    return store;
  }

  read(): RulesDocument {
    return this.store().read();
  }

  write(text: string, source: RulesSource): RulesWriteResult {
    const cible = this.emplacement();
    const result = this.store().write(text, source);
    this.logger?.info("rules.cible", {
      portee: cible.portee,
      fichier: cible.chemin,
      consequence:
        "les règles ont été écrites dans le fichier RELU à chaque tour (aucune copie divergente)",
    });
    return result;
  }

  revert(source: RulesSource): RulesWriteResult | null {
    return this.store().revert(source);
  }

  history(limit?: number): RulesHistoryEntry[] {
    return this.store().history(limit);
  }
}
