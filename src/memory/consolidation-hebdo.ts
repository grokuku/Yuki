/**
 * PASSE DE CONSOLIDATION HEBDOMADAIRE de la mémoire durable (lot 29).
 *
 * ⚠️ Elle est branchée sur le BALAYEUR EXISTANT (`src/sources/scheduler.ts`) :
 * un seul `setInterval` dans le processus, aucune `SourceRecord`, donc aucun
 * second rythme à arrêter et aucun déclencheur visible dans la page Sources.
 *
 * Enchaînement d'une passe :
 *   ① MESURER (amendement ①) — entrées, caractères, octets, tokens estimés,
 *      contexte du modèle LOURD lu (jamais codé), budget, nombre de lots ;
 *   ② interroger le modèle UNE fois par lot (JSON strict) ;
 *   ③ REFUS TOTAL dès qu'une réponse viole le protocole (aucune écriture) ;
 *   ④ appliquer de façon ATOMIQUE (tmp + `renameSync`, section synchrone) ;
 *   ⑤ ARCHIVER la version (amendement ②) puis reconstruire l'index FTS5 ;
 *   ⑥ journaliser le rapport (mesures comprises).
 *
 * ⚠️ ANTI-RÉCURSION : l'extracteur fourni est une session ÉPHÉMÈRE SANS OUTIL
 * (`tools: []`, voir `createSdkConsolidationHebdoExtractor`). La passe ne peut
 * donc ni déléguer, ni écrire ailleurs que dans la mémoire.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

import { parseCron, prochainPassage } from "../sources/cron.js";
import {
  ConsolidationArchiveStore,
  VERSION_MEMORY_FILE,
  VERSION_OPERATIONS_FILE,
  VERSION_RAPPORT_FILE,
  type ConsolidationVersion,
} from "./consolidation-archive.js";
import type { MemoryIndex } from "./index-db.js";
import type { MemoryStore } from "./store.js";
import type { MemoryEvent, MemoryExtractor, MemoryLogger } from "./types.js";
import {
  appliquerRegleContradiction,
  choisirGagnant,
  construirePromptHebdo,
  decouperEnLots,
  entreesExaminees,
  mesurerConsolidation,
  parseReponseHebdo,
  type MesureConsolidation,
  type WeeklyOpName,
  type WeeklyOperation,
} from "./weekly.js";

/** Cron de la passe : dimanche 03:00 (fuseau du réglage, `Europe/Paris`). */
export const CRON_HEBDO_DEFAUT = "0 3 * * 0";

/** Fuseau de planification par défaut. ⚠️ Ce n'est PAS `ui.timeZone` (UTC). */
export const FUSEAU_HEBDO_DEFAUT = "Europe/Paris";

/** Budget de tokens par défaut (modeste : un appel géant est lent et coûteux). */
export const BUDGET_TOKENS_DEFAUT = 200_000;

/**
 * Rattrapage maximal : un passage manqué est rejoué UNE fois s'il a moins de
 * 24 h de retard ; au-delà il est SAUTÉ et journalisé (jamais une passe
 * « surprise » plusieurs jours après l'arrêt).
 */
export const RATTRAPAGE_HEBDO_MAX_MS = 24 * 60 * 60 * 1000;

/**
 * Durée au-delà de laquelle un verrou `enCours` PERSISTÉ est considéré comme
 * orphelin (processus tué en pleine passe) et ignoré — sinon la consolidation
 * resterait bloquée pour toujours.
 */
export const VERROU_ORPHELIN_MS = 6 * 60 * 60 * 1000;

/** Réglages lus à CHAQUE décision (aucun redémarrage nécessaire). */
export interface ConsolidationHebdoSettings {
  enabled: boolean;
  cron: string;
  fuseau: string;
  budgetTokens: number;
  retention: number;
  /** Consigne complémentaire éventuelle ajoutée au prompt (facultative). */
  consigne?: string;
}

/** Compteurs par opération (rapport). */
export type CompteursOperations = Record<WeeklyOpName, number>;

/** Rapport complet d'une passe (mesures de l'amendement ① comprises). */
export interface RapportConsolidation {
  /** Horodatage ISO du début de passe. */
  at: string;
  dureeMs: number;
  fuseau: string;
  cron: string;
  /** Mesure faite AVANT tout découpage. */
  mesure: MesureConsolidation;
  /** Rappel direct des champs de mesure (pratique pour l'API/UI). */
  entrees: number;
  caracteres: number;
  tokensEstimes: number;
  contexteModele: number;
  budgetTokens: number;
  lots: number;
  pourcentContexte: number;
  nonExaminees: number;
  entreesAvant: number;
  entreesApres: number;
  operations: number;
  parOperation: CompteursOperations;
  suppressions: number;
  signalements: number;
  /** `true` seulement si la mémoire a réellement été modifiée. */
  applique: boolean;
  /** Raison du refus TOTAL (aucune écriture) le cas échéant. */
  refus?: string;
  /** Version d'archive déposée (nom du dossier). */
  version?: string;
}

/** État persisté (survit au redémarrage : armement + verrou). */
interface EtatConsolidation {
  version: 1;
  prochainPassage?: string;
  dernierPassage?: string;
  enCours?: boolean;
  enCoursDepuis?: string;
}

export interface ConsolidationHebdoOptions {
  store: MemoryStore;
  index: MemoryIndex;
  logger: MemoryLogger;
  archive: ConsolidationArchiveStore;
  /** Fichier JSON de l'état (volume `state`). */
  statePath: string;
  settings: () => ConsolidationHebdoSettings;
  /** Extracteur LOURD (absent ⇒ passe refusée, jamais de repli sur le léger). */
  extractor: () => MemoryExtractor | undefined;
  /** Fenêtre de contexte du modèle lourd RÉELLEMENT configuré (lue). */
  contexteModele: () => number;
  now?: () => number;
  plafondEntrees?: number;
}

/** État exposé à l'interface (jamais un secret, jamais un contenu de souvenir). */
export interface EtatConsolidationVue {
  actif: boolean;
  cron: string;
  fuseau: string;
  budgetTokens: number;
  retention: number;
  prochainPassage: string | null;
  dernierPassage: string | null;
  enCours: boolean;
  versions: ConsolidationVersion[];
  dernierRapport: RapportConsolidation | null;
  archiveDir: string;
}

export class ConsolidationHebdo {
  private readonly store: MemoryStore;
  private readonly index: MemoryIndex;
  private readonly logger: MemoryLogger;
  private readonly archive: ConsolidationArchiveStore;
  private readonly statePath: string;
  private readonly settings: () => ConsolidationHebdoSettings;
  private readonly extractor: () => MemoryExtractor | undefined;
  private readonly contexteModele: () => number;
  private readonly now: () => number;
  private readonly plafondEntrees: number;
  /** Verrou EN MÉMOIRE (le persisté sert à survivre au redémarrage). */
  private enCours = false;
  private dernierePasse: Promise<RapportConsolidation> | undefined;

  constructor(options: ConsolidationHebdoOptions) {
    this.store = options.store;
    this.index = options.index;
    this.logger = options.logger;
    this.archive = options.archive;
    this.statePath = options.statePath;
    this.settings = options.settings;
    this.extractor = options.extractor;
    this.contexteModele = options.contexteModele;
    this.now = options.now ?? Date.now;
    this.plafondEntrees = Math.max(1, Math.trunc(options.plafondEntrees ?? 20_000));
  }

  /** Attend la passe en cours (tests et arrêt gracieux). */
  async drain(): Promise<void> {
    await this.dernierePasse?.catch(() => undefined);
  }

  /**
   * Appelée par le balayeur à CHAQUE tick (30 s) : décide s'il y a une passe à
   * lancer. ⚠️ Ne bloque jamais le balayage : la passe elle-même est longue, et
   * le verrou empêche deux exécutions simultanées.
   */
  async executerSiDu(maintenant: number): Promise<void> {
    const reglages = this.settings();
    if (!reglages.enabled) return;
    let calendrier: ReturnType<typeof parseCron>;
    try {
      calendrier = parseCron(reglages.cron);
    } catch (error) {
      // Expression invalide : on le DIT une fois par tick, jamais un plantage.
      this.logger.warn("memory.consolidation.cron.invalide", {
        cron: reglages.cron,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const etat = this.lireEtat();
    const arme = typeof etat.prochainPassage === "string" ? Date.parse(etat.prochainPassage) : NaN;
    if (!Number.isFinite(arme)) {
      this.ecrireEtat({ ...etat, prochainPassage: this.prochain(calendrier, reglages.fuseau, maintenant) });
      return;
    }
    if (maintenant < arme) return;
    const retard = maintenant - arme;
    // ⚠️ Réarmement PERSISTÉ AVANT l'exécution : un plantage en pleine passe ne
    // provoque pas un second tir au redémarrage.
    const suivant = this.prochain(calendrier, reglages.fuseau, maintenant);
    this.ecrireEtat({
      ...etat,
      ...(suivant ? { prochainPassage: suivant } : {}),
      dernierPassage: new Date(arme).toISOString(),
    });
    if (retard > RATTRAPAGE_HEBDO_MAX_MS) {
      this.logger.info("memory.consolidation.saut", {
        raison:
          `passage manqué de ${Math.round(retard / 3_600_000)} h (maximum rattrapable ` +
          `${RATTRAPAGE_HEBDO_MAX_MS / 3_600_000} h) : sauté, le prochain passage est réarmé`,
        prochain: suivant,
      });
      return;
    }
    if (this.verrouActif(etat)) {
      this.logger.info("memory.consolidation.saut", {
        raison: "une passe de consolidation est déjà en cours (verrou `enCours`)",
      });
      return;
    }
    this.enCours = true;
    this.ecrireEtat({
      ...etat,
      ...(suivant ? { prochainPassage: suivant } : {}),
      dernierPassage: new Date(arme).toISOString(),
      enCours: true,
      enCoursDepuis: new Date(this.now()).toISOString(),
    });
    this.dernierePasse = this.executerPasse()
      .catch((error: unknown) => {
        this.logger.warn("memory.consolidation.failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return this.rapportVide(`passe en échec : ${messageOf(error)}`);
      })
      .finally(() => {
        this.enCours = false;
        const courant = this.lireEtat();
        this.ecrireEtat({ ...courant, enCours: false });
      });
    // ⚠️ On ne bloque PAS le balayeur : `drain()` permet d'attendre en test.
    await Promise.resolve();
  }

  /** Verrou actif ? (mémoire OU persisté et non orphelin) */
  private verrouActif(etat: EtatConsolidation): boolean {
    if (this.enCours) return true;
    if (etat.enCours !== true) return false;
    const depuis = typeof etat.enCoursDepuis === "string" ? Date.parse(etat.enCoursDepuis) : NaN;
    if (!Number.isFinite(depuis)) return true;
    if (this.now() - depuis < VERROU_ORPHELIN_MS) return true;
    this.logger.warn("memory.consolidation.verrou.orphelin", {
      en_cours_depuis: etat.enCoursDepuis,
    });
    return false;
  }

  private prochain(
    calendrier: ReturnType<typeof parseCron>,
    fuseau: string,
    depuis: number,
  ): string | undefined {
    try {
      return new Date(prochainPassage(calendrier, depuis, fuseau)).toISOString();
    } catch (error) {
      this.logger.warn("memory.consolidation.cron.aucune_occurrence", {
        fuseau,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  // --- État persisté -------------------------------------------------------

  private lireEtat(): EtatConsolidation {
    if (!existsSync(this.statePath)) return { version: 1 };
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.statePath, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { version: 1 };
      }
      const record = parsed as Record<string, unknown>;
      return {
        version: 1,
        ...(typeof record.prochainPassage === "string"
          ? { prochainPassage: record.prochainPassage }
          : {}),
        ...(typeof record.dernierPassage === "string"
          ? { dernierPassage: record.dernierPassage }
          : {}),
        ...(record.enCours === true ? { enCours: true } : {}),
        ...(typeof record.enCoursDepuis === "string"
          ? { enCoursDepuis: record.enCoursDepuis }
          : {}),
      };
    } catch (error) {
      this.logger.warn("memory.consolidation.state.read_failed", {
        path: this.statePath,
        error: messageOf(error),
      });
      return { version: 1 };
    }
  }

  private ecrireEtat(etat: EtatConsolidation): void {
    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      const tmp = `${this.statePath}.tmp-${randomBytes(4).toString("hex")}`;
      writeFileSync(tmp, `${JSON.stringify(etat, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, this.statePath);
    } catch (error) {
      this.logger.warn("memory.consolidation.state.write_failed", {
        path: this.statePath,
        error: messageOf(error),
      });
    }
  }

  // --- La passe ------------------------------------------------------------

  private rapportVide(refus: string): RapportConsolidation {
    const reglages = this.settings();
    const mesure = mesurerConsolidation({
      entrees: [],
      octetsFichier: 0,
      contexteModele: 0,
      budgetTokens: reglages.budgetTokens,
      plafondEntrees: this.plafondEntrees,
    });
    return {
      at: new Date(this.now()).toISOString(),
      dureeMs: 0,
      fuseau: reglages.fuseau,
      cron: reglages.cron,
      mesure,
      entrees: 0,
      caracteres: 0,
      tokensEstimes: 0,
      contexteModele: 0,
      budgetTokens: mesure.budgetTokens,
      lots: 0,
      pourcentContexte: 0,
      nonExaminees: 0,
      entreesAvant: this.store.size,
      entreesApres: this.store.size,
      operations: 0,
      parOperation: compteursVides(),
      suppressions: 0,
      signalements: 0,
      applique: false,
      refus,
    };
  }

  /**
   * Exécute la passe COMPLÈTE (mesure → lots → modèle → application → archive).
   * Publique pour être testable sans horloge ; le balayeur passe par
   * `executerSiDu`.
   */
  async executerPasse(): Promise<RapportConsolidation> {
    const demarre = this.now();
    const reglages = this.settings();
    const entreesAvant = [...this.store.entries];
    const octets = octetsFichier(this.store.filePath);
    const mesure = mesurerConsolidation({
      entrees: entreesAvant,
      octetsFichier: octets,
      contexteModele: this.contexteModele(),
      budgetTokens: reglages.budgetTokens,
      plafondEntrees: this.plafondEntrees,
    });
    this.logger.info("memory.consolidation.debut", {
      entrees: mesure.entrees,
      caracteres: mesure.caracteres,
      octets: mesure.octetsFichier,
      tokens_estimes: mesure.tokensEstimes,
      hypothese: mesure.hypothese,
      contexte_modele: mesure.contexteModele,
      budget_tokens: mesure.budgetTokens,
      lots: mesure.lots,
      pourcent_contexte: mesure.pourcentContexte,
      non_examinees: mesure.nonExaminees,
    });

    const base: RapportConsolidation = {
      at: new Date(demarre).toISOString(),
      dureeMs: 0,
      fuseau: reglages.fuseau,
      cron: reglages.cron,
      mesure,
      entrees: mesure.entrees,
      caracteres: mesure.caracteres,
      tokensEstimes: mesure.tokensEstimes,
      contexteModele: mesure.contexteModele,
      budgetTokens: mesure.budgetTokens,
      lots: mesure.lots,
      pourcentContexte: mesure.pourcentContexte,
      nonExaminees: mesure.nonExaminees,
      entreesAvant: entreesAvant.length,
      entreesApres: entreesAvant.length,
      operations: 0,
      parOperation: compteursVides(),
      suppressions: 0,
      signalements: 0,
      applique: false,
    };

    if (entreesAvant.length === 0) {
      this.logger.info("memory.consolidation.vide", {});
      return { ...base, dureeMs: this.now() - demarre };
    }
    const extractor = this.extractor();
    if (!extractor) {
      // ⚠️ Modèle LOURD imposé, SANS repli : pas de lourd ⇒ pas de passe.
      return this.refuser(base, demarre, "modèle lourd indisponible (aucun repli)");
    }

    const examinees = entreesExaminees(entreesAvant, mesure.plafondEntrees);
    const lots = decouperEnLots(examinees, mesure);
    const operations: WeeklyOperation[] = [];
    let signalements = 0;
    for (const [index, lot] of lots.entries()) {
      const prompt = construirePromptHebdo(lot, index + 1, lots.length, reglages.consigne);
      let brut: string;
      try {
        brut = await extractor(prompt);
      } catch (error) {
        return this.refuser(base, demarre, `lot ${index + 1} : appel au modèle en échec (${messageOf(error)})`);
      }
      const parsed = parseReponseHebdo(brut, { lot: index + 1, entrees: lot });
      if (!parsed.ok) {
        // ⚠️ REFUS TOTAL : aucune des opérations déjà lues n'est appliquée.
        return this.refuser(base, demarre, `lot ${index + 1} : ${parsed.raison}`);
      }
      const appliquees = appliquerRegleContradiction(parsed.operations, lot);
      signalements += appliquees.signalees;
      operations.push(...appliquees.operations);
      this.logger.info("memory.consolidation.lot", {
        lot: index + 1,
        lots: lots.length,
        entrees: lot.length,
        operations: appliquees.operations.length,
        signalees: appliquees.signalees,
      });
    }

    const parOperation = compteursVides();
    for (const operation of operations) parOperation[operation.op] += 1;
    const suppressions = parOperation.supprimer;
    const aAppliquer = operations.filter(
      (operation) => operation.op !== "garder" && operation.op !== "signaler",
    );

    // État AVANT la passe : c'est LUI qui est archivé (restaurable à l'octet),
    // puis on écrit de façon ATOMIQUE (tmp + rename) — section entièrement
    // SYNCHRONE : aucune écriture concurrente ne peut s'intercaler.
    const memoireAvant = lireTexte(this.store.filePath);
    const rapport: RapportConsolidation = {
      ...base,
      operations: aAppliquer.length,
      parOperation,
      suppressions,
      signalements,
      applique: false,
    };

    if (aAppliquer.length > 0) {
      const resultat = this.appliquer(aAppliquer, memoireAvant);
      rapport.applique = resultat.appliquees > 0;
      rapport.entreesApres = this.store.size;
      if (resultat.ignorees > 0) {
        this.logger.info("memory.consolidation.operations.ignorees", {
          ignorees: resultat.ignorees,
          raison: "entrées modifiées ou retirées entre la mesure et l'application",
        });
      }
    }
    rapport.dureeMs = this.now() - demarre;

    rapport.version = this.archiver(rapport, memoireAvant, operations, reglages);
    this.logger.info("memory.consolidation.fin", {
      applique: rapport.applique,
      entrees_avant: rapport.entreesAvant,
      entrees_apres: rapport.entreesApres,
      operations: rapport.operations,
      suppressions: rapport.suppressions,
      signalements: rapport.signalements,
      lots: rapport.lots,
      tokens_estimes: rapport.tokensEstimes,
      contexte_modele: rapport.contexteModele,
      budget_tokens: rapport.budgetTokens,
      pourcent_contexte: rapport.pourcentContexte,
      hypothese: rapport.mesure.hypothese,
      non_examinees: rapport.nonExaminees,
      version: rapport.version,
      duree_ms: rapport.dureeMs,
    });
    return rapport;
  }

  /** Refus TOTAL : rien n'est modifié, la tentative est ARCHIVÉE et journalisée. */
  private refuser(
    base: RapportConsolidation,
    demarre: number,
    raison: string,
  ): RapportConsolidation {
    const reglages = this.settings();
    const rapport: RapportConsolidation = {
      ...base,
      entreesApres: this.store.size,
      refus: raison,
      applique: false,
      dureeMs: this.now() - demarre,
    };
    rapport.version = this.archiver(rapport, lireTexte(this.store.filePath), [], reglages);
    this.logger.info("memory.consolidation.refus", {
      raison,
      version: rapport.version,
      entrees: rapport.entreesAvant,
    });
    return rapport;
  }

  /**
   * Applique les opérations : lignes `update`/`delete` AJOUTÉES au journal puis
   * réécriture ATOMIQUE du fichier (tmp + `renameSync`). Le journal reste
   * append-only dans son contenu (on n'efface aucune ligne d'origine).
   */
  private appliquer(
    operations: readonly WeeklyOperation[],
    memoireAvant: string,
  ): { appliquees: number; ignorees: number } {
    const entrees = [...this.store.entries];
    const at = new Date(this.now()).toISOString();
    const evenements: MemoryEvent[] = [];
    let ignorees = 0;
    for (const operation of operations) {
      const cible = entrees.find((entry) => entry.id === operation.ids[0]);
      if (!cible) {
        ignorees += 1;
        continue;
      }
      if (operation.op === "corriger") {
        evenements.push({
          v: 1,
          t: "update",
          id: cible.id,
          at,
          text: operation.text ?? cible.text,
          source: cible.source,
          cat: operation.cat ?? cible.cat,
          ...(operation.why ? { why: operation.why } : {}),
        });
        continue;
      }
      if (operation.op === "fusionner") {
        const gagnant = choisirGagnant(operation.ids, entrees);
        if (!gagnant) {
          // Une des entrées a disparu entre la mesure et l'application.
          ignorees += 1;
          continue;
        }
        evenements.push({
          v: 1,
          t: "update",
          id: gagnant.id,
          at,
          text: operation.text ?? gagnant.text,
          source: gagnant.source,
          cat: operation.cat ?? gagnant.cat,
          ...(operation.why ? { why: operation.why } : {}),
        });
        for (const id of operation.ids) {
          if (id === gagnant.id) continue;
          evenements.push({ v: 1, t: "delete", id, at });
        }
        continue;
      }
      if (operation.op === "supprimer") {
        evenements.push({ v: 1, t: "delete", id: cible.id, at });
      }
    }
    if (evenements.length === 0) return { appliquees: 0, ignorees };
    const base = memoireAvant.endsWith("\n") || memoireAvant.length === 0 ? memoireAvant : `${memoireAvant}\n`;
    const ajout = evenements.map((event) => `${JSON.stringify(event)}\n`).join("");
    const tmp = `${this.store.filePath}.tmp-${randomBytes(4).toString("hex")}`;
    writeFileSync(tmp, `${base}${ajout}`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, this.store.filePath);
    // ⚠️ Relire le journal (projection) PUIS reconstruire l'index : l'index FTS5
    // est DÉRIVÉ, il ne doit jamais survivre à une réécriture du fichier.
    this.store.reload();
    this.index.rebuild(this.store.entries);
    return { appliquees: evenements.length, ignorees };
  }

  /** Dépose la version (memory avant + opérations + rapport) et applique la rétention. */
  private archiver(
    rapport: RapportConsolidation,
    memoireAvant: string,
    operations: readonly WeeklyOperation[],
    reglages: ConsolidationHebdoSettings,
  ): string | undefined {
    try {
      const version = this.archive.sauvegarder({
        at: Date.parse(rapport.at),
        fuseau: reglages.fuseau,
        memoireAvant,
        operations: {
          at: rapport.at,
          refus: rapport.refus ?? null,
          applique: rapport.applique,
          operations: operations.map((operation) => ({
            op: operation.op,
            ids: operation.ids,
            ...(operation.text !== undefined ? { text: operation.text } : {}),
            ...(operation.cat !== undefined ? { cat: operation.cat } : {}),
            ...(operation.why !== undefined ? { why: operation.why } : {}),
            ...(operation.raison ? { raison: operation.raison } : {}),
          })),
        },
        rapport,
        retention: reglages.retention,
      });
      return version.nom;
    } catch (error) {
      this.logger.warn("memory.consolidation.archive.failed", { error: messageOf(error) });
      return undefined;
    }
  }

  // --- Versions : liste, téléchargement, restauration (amendement ②) -------

  listerVersions(): ConsolidationVersion[] {
    return this.archive.lister();
  }

  /** Contenu du `memory.jsonl` d'une version (téléchargement), ou `null`. */
  telechargerVersion(nom: unknown): { nom: string; contenu: string; octets: number } | null {
    const contenu = this.archive.lire(nom, VERSION_MEMORY_FILE);
    const chemin = this.archive.cheminDe(nom);
    if (contenu === null || chemin === null) return null;
    return { nom: String(nom), contenu, octets: Buffer.byteLength(contenu) };
  }

  /** Opérations appliquées d'une version (lecture seule). */
  operationsDeVersion(nom: unknown): string | null {
    return this.archive.lire(nom, VERSION_OPERATIONS_FILE);
  }

  /** Rapport d'une version (lecture seule). */
  rapportDeVersion(nom: unknown): string | null {
    return this.archive.lire(nom, VERSION_RAPPORT_FILE);
  }

  /**
   * RESTAURE une version : même mécanisme ATOMIQUE que la passe (`tmp` +
   * `renameSync`, côté archive) puis relecture du journal et RECONSTRUCTION de
   * l'index FTS5. `null` si le nom est invalide/absent (anti-traversée).
   */
  restaurerVersion(nom: unknown): { nom: string; entrees: number; octets: number } | null {
    const resultat = this.archive.restaurer(nom, this.store.filePath);
    if (!resultat) return null;
    this.store.reload();
    this.index.rebuild(this.store.entries);
    this.logger.info("memory.consolidation.restauration", {
      version: resultat.nom,
      entrees: this.store.size,
      octets: resultat.bytes,
    });
    return { nom: resultat.nom, entrees: this.store.size, octets: resultat.bytes };
  }

  /** Rapport de la DERNIÈRE passe (lu depuis la dernière version archivée). */
  dernierRapport(): RapportConsolidation | null {
    const versions = this.archive.lister();
    const derniere = versions[0];
    if (!derniere) return null;
    const contenu = this.archive.lire(derniere.nom, VERSION_RAPPORT_FILE);
    if (contenu === null) return null;
    try {
      return JSON.parse(contenu) as RapportConsolidation;
    } catch {
      return null;
    }
  }

  /** Vue complète pour l'interface (`GET /api/memory`). */
  etat(): EtatConsolidationVue {
    const reglages = this.settings();
    const etat = this.lireEtat();
    return {
      actif: reglages.enabled,
      cron: reglages.cron,
      fuseau: reglages.fuseau,
      budgetTokens: reglages.budgetTokens,
      retention: reglages.retention,
      prochainPassage: etat.prochainPassage ?? null,
      dernierPassage: etat.dernierPassage ?? null,
      enCours: this.enCours || etat.enCours === true,
      versions: this.archive.lister(),
      dernierRapport: this.dernierRapport(),
      archiveDir: this.archive.dirPath,
    };
  }
}

/**
 * Lit la fenêtre de contexte du modèle LOURD **réellement configuré** dans
 * `models.json` (amendement ① : on la LIT, on ne la code pas).
 *
 * `modele` peut être un identifiant (`deepseek-v4.1-flash`) ou une référence
 * (`llm-heavy/deepseek-v4.1-flash`). Rend `null` si le fichier est illisible ou
 * si le modèle n'y est pas : l'appelant choisit alors un repli EXPLICITE.
 */
export function contexteModeleDepuisFichier(
  modelsPath: string,
  modele: string,
): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(modelsPath, "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const providers = (parsed as { providers?: unknown }).providers;
  if (typeof providers !== "object" || providers === null) return null;
  const id = modele.includes("/") ? modele.slice(modele.lastIndexOf("/") + 1) : modele;
  for (const provider of Object.values(providers as Record<string, unknown>)) {
    if (typeof provider !== "object" || provider === null) continue;
    const modeles = (provider as { models?: unknown }).models;
    if (!Array.isArray(modeles)) continue;
    for (const modeleBrut of modeles) {
      if (typeof modeleBrut !== "object" || modeleBrut === null) continue;
      const record = modeleBrut as { id?: unknown; contextWindow?: unknown };
      if (record.id !== id) continue;
      const fenetre = record.contextWindow;
      if (typeof fenetre === "number" && Number.isFinite(fenetre) && fenetre > 0) {
        return Math.trunc(fenetre);
      }
    }
  }
  return null;
}

function compteursVides(): CompteursOperations {
  return { garder: 0, fusionner: 0, corriger: 0, supprimer: 0, signaler: 0 };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function lireTexte(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function octetsFichier(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
