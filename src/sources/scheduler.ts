/**
 * BALAYEUR DES DÉCLENCHEURS PLANIFIÉS (lot 2 — « moteur horloge »).
 *
 * Un **seul** `setInterval` (30 s par défaut, même motif que
 * `src/chat/sync/service.ts:85-150`), **horloge et timers injectables** : les
 * tests pilotent le temps sans attendre 30 secondes.
 *
 * ⚠️ Ce que ce module garantit, et pourquoi :
 *
 *  1. **État PERSISTÉ, jamais en mémoire seule** — `prochainPassage`,
 *     `dernierPassage`, `actif`, `toursDuJour` vivent dans `sources.json`
 *     (`store.markPlanification`). C'est ce qui rend la **reprise après
 *     redémarrage** réelle : au premier balayage, un `prochainPassage` dépassé est
 *     traité par la règle de RATTRAPAGE.
 *  2. **Rattrapage** : un passage manqué est rejoué **UNE SEULE FOIS** si le
 *     retard est **< 1 h** (`RATTRAPAGE_MAX_MS`) ; au-delà il est **SAUTÉ** et
 *     journalisé (`saut`). La politique `rattrapage: "sauter"` ne rattrape jamais.
 *  3. **Chevauchement** : par défaut (`chevauchement: "sauter"`), un passage qui
 *     arrive pendant qu'un tour de la MÊME source tourne est SAUTÉ et
 *     journalisé ; `remplacer` **abandonne** l'ancien tour (`abort`).
 *  4. **Plafond d'exécution** (`plafondMs`, 10 min par défaut, borné 60 s – 2 h) :
 *     c'est LUI qui protège des blocages — pas le chevauchement. À l'échéance le
 *     tour est `abort` et l'événement `plafond` est journalisé.
 *  5. **Garde-fou quotidien** (`maxToursParJour`, 200 par défaut) : au-delà, le
 *     déclencheur est SUSPENDU (`actif: false`) avec une raison LISIBLE, journal
 *     `desactive`.
 *
 * ⚠️ Le réarmement est PERSISTÉ **AVANT** de lancer le tour : un plantage pendant
 * le tour ne provoque pas un double tir au redémarrage.
 *
 * Aucun import SDK : le tour lui-même est un PORT (`options.run`), branché sur
 * `SourcesService.declencher` (`src/sources/service.ts`).
 */

import { jourLocal, parseCron, prochainPassage } from "./cron.js";
import type { DeclencheurJournal } from "./journal.js";
import { ORIGINE_HORLOGE, type DeclenchementResult, type DeclenchementFin } from "./service.js";
import {
  DEFAULT_FUSEAU,
  DEFAULT_MAX_TOURS_PAR_JOUR,
  DEFAULT_PLAFOND_MS,
  RATTRAPAGE_MAX_MS,
  type SourceRecord,
} from "./types.js";

/** Période de balayage par défaut (30 s). */
export const BALAYAGE_INTERVAL_MS = 30_000;

/** Grâce accordée au host pour rendre la main après un `abort` (30 s). */
export const GRACE_APRES_ABORT_MS = 30_000;

/** Journal minimal (le logger d'observabilité le satisfait). */
export interface BalayeurLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

/** Ce que le balayeur a besoin de faire d'un déclencheur (port du service). */
export type DeclencheurRunner = (
  nom: string,
  options: {
    origine: string;
    planifie?: number;
    plafondMs: number;
    signal: AbortSignal;
    /**
     * ⚠️ LOT 31 — la tâche ponctuelle a été DÉSARMÉE PAR LE BALAYEUR avant ce lancement
     * (un plantage ne doit pas la rejouer). Ce drapeau évite le refus « en veille ».
     */
    desarmementPrealable?: boolean;
  },
) => Promise<DeclenchementResult>;

/** Port étroit du store (aucune dépendance à la classe concrète). */
export interface BalayeurStore {
  list(): SourceRecord[];
  get(nom: string): SourceRecord | undefined;
  markPlanification(
    nom: string,
    etat: { prochainPassage?: string; dernierPassage?: string },
  ): SourceRecord | undefined;
  setActif(nom: string, actif: boolean, raison?: string): SourceRecord | undefined;
  incrementerTour(nom: string, jour: string): number;
  /**
   * ⚠️ LOT 32 — compte un passage RÉELLEMENT TIRÉ (jamais un saut) et rend le total.
   * Persisté : c'est ce qui rend « reste 6/14 » vrai après un redémarrage.
   */
  incrementerOccurrence(nom: string): number;
}

/**
 * Port des ENVOIS PROGRAMMÉS (lot 28).
 *
 * ⚠️ POURQUOI ICI, ET PAS UN SECOND MINUTEUR : le balayeur est LE rythme du processus
 * (un seul `setInterval`, 30 s). Un envoi programmé a exactement la même nature qu'un
 * passage planifié — « quelque chose est dû à cet instant » — donc il est exécuté par
 * le même tick. Un second ordonnanceur aurait donné deux rythmes, deux arrêts à gérer
 * et un risque de double publication à la reprise.
 *
 * ⚠️ `executerDus` ne doit JAMAIS lever : le balayeur doit continuer à balayer même si
 * un envoi échoue (le service persiste et journalise l'échec de son côté).
 */
export interface EnvoisProgrammesRunner {
  /** Publie les envois dont l'heure est passée. Rend le nombre publié (mesure). */
  executerDus(maintenant: number): Promise<number>;
}

/**
 * Port de la CONSOLIDATION HEBDOMADAIRE de la mémoire (lot 29).
 *
 * ⚠️ MÊME RAISON D'ÊTRE QUE LES ENVOIS PROGRAMMÉS : la passe est un rendez-vous
 * planifié (« le dimanche à 3 h, heure de Paris »). Elle est donc décidée par CE
 * balayeur — un seul `setInterval` dans le processus, aucun `SourceRecord`
 * (elle n'a ni tâche déléguée, ni publication dans un fil).
 *
 * ⚠️ La méthode est appelée à CHAQUE tick et doit rendre la main VITE : la passe
 * elle-même est longue (`await` interne interdit), et son verrou `enCours`
 * empêche deux exécutions simultanées.
 */
export interface PasseHebdoRunner {
  executerSiDu(maintenant: number): Promise<void>;
}

export interface DeclencheurBalayeurOptions {
  store: BalayeurStore;
  run: DeclencheurRunner;
  logger: BalayeurLogger;
  /** Journal des déclencheurs (absent ⇒ aucune trace, le balayeur fonctionne). */
  journal?: Pick<DeclencheurJournal, "append">;
  /** Envois programmés (lot 28). Absent ⇒ aucun envoi n'est exécuté par ce balayeur. */
  envoisProgrammes?: EnvoisProgrammesRunner;
  /** Consolidation hebdomadaire de la mémoire (lot 29). Absent ⇒ rien n'est planifié. */
  passeHebdo?: PasseHebdoRunner;
  /** Horloge injectable (tests). */
  now?: () => number;
  /** Planificateur périodique injectable (tests). */
  setInterval?: (callback: () => void, delayMs: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  /** Minuteur d'abandon injectable (tests). */
  setTimeout?: (callback: () => void, delayMs: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  /** Période de balayage (défaut `BALAYAGE_INTERVAL_MS`). */
  intervalMs?: number;
  /**
   * Origine transmise au port. ⚠️ Défaut `horloge` : c'est la SEULE origine que
   * `SourcesService.declencher` accepte (anti-enchaînement).
   */
  origine?: string;
}

/**
 * Raison persistée pendant l'exécution d'une tâche ponctuelle.
 *
 * ⚠️ C'est le texte que lit la page de gestion si le processus meurt pendant l'exécution
 * (le motif final « terminée : … »/« échouée : … » est écrit à la fin). Il dit ce qui
 * s'est RÉELLEMENT passé, pas « en cours » sans plus.
 */
export const RAISON_TACHE_EN_COURS = "en cours d'exécution (désarmée avant lancement)";

/**
 * Raison LISIBLE de l'extinction par FIN DE RÉCURRENCE (lot 32).
 *
 * ⚠️ Même canal que `DÉSACTIVER` (`setActif(false, raison)` + journal `desactive`) : la
 * page de gestion affiche donc cette phrase à côté de l'état, et l'utilisateur sait
 * POURQUOI le déclencheur s'est arrêté.
 */
export function raisonFinOccurrences(faites: number, max: number): string {
  return `terminée : ${faites}/${max} passages`;
}

/** Raison LISIBLE de l'extinction par DATE de fin (`jusquAu`, lot 32). */
export function raisonFinDate(instant: number, fuseau: string | undefined): string {
  return `terminée : fin prévue le ${dateLongue(instant, fuseau)}`;
}

/** Date longue en français (« 19 novembre 2026 »), dans le fuseau du déclencheur. */
function dateLongue(instant: number, fuseau: string | undefined): string {
  try {
    return new Intl.DateTimeFormat("fr-FR", {
      timeZone: fuseau ?? DEFAULT_FUSEAU,
      dateStyle: "long",
    }).format(new Date(instant));
  } catch {
    return new Date(instant).toISOString();
  }
}

/**
 * Raison LISIBLE d'une suspension par le garde-fou quotidien.
 */
export function raisonGardeFouQuotidien(max: number, jour: string): string {
  return (
    `Nombre maximal de tours par jour atteint (${max} le ${jour}) : le déclencheur ` +
    "est mis en veille. Réactivez-le dans Paramètres → Sources, ou augmentez le garde-fou."
  );
}

interface TourEnVol {
  controller: AbortController;
  /** Libère la place quand le tour est vraiment terminé. */
  fin: Promise<DeclenchementFin>;
}

/**
 * Balayeur : compare `prochainPassage` à l'heure courante et lance les passages.
 * Ne fait AUCUN travail de modèle lui-même (port `run`).
 */
export class DeclencheurBalayeur {
  private readonly options: DeclencheurBalayeurOptions;
  private readonly now: () => number;
  private readonly setIntervalFn: (callback: () => void, delayMs: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;
  private readonly setTimeoutFn: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private readonly intervalMs: number;
  private readonly origine: string;
  private timer: unknown = null;
  /** Un seul passage de balayage à la fois (deux ticks ne se chevauchent pas). */
  private balayageEnCours = false;
  /** Tours en vol PAR DÉCLENCHEUR (chevauchement). */
  private readonly enVol = new Map<string, TourEnVol>();
  private arrete = true;

  constructor(options: DeclencheurBalayeurOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.intervalMs = Math.max(1_000, options.intervalMs ?? BALAYAGE_INTERVAL_MS);
    this.origine = options.origine ?? ORIGINE_HORLOGE;
    this.setIntervalFn =
      options.setInterval ??
      ((callback, delayMs) => {
        const handle = setInterval(callback, delayMs);
        // Un balayage ne doit pas retenir le processus en vie.
        (handle as { unref?: () => void }).unref?.();
        return handle;
      });
    this.clearIntervalFn =
      options.clearInterval ??
      ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
    this.setTimeoutFn =
      options.setTimeout ??
      ((callback, delayMs) => {
        const handle = setTimeout(callback, delayMs);
        (handle as { unref?: () => void }).unref?.();
        return handle;
      });
    this.clearTimeoutFn =
      options.clearTimeout ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** Démarre le balayage (idempotent) : ⚠️ un balayage immédiat a lieu. */
  start(): void {
    if (!this.arrete) return;
    this.arrete = false;
    this.timer = this.setIntervalFn(() => {
      void this.tick();
    }, this.intervalMs);
    // ⚠️ REPRISE APRÈS REDÉMARRAGE : le premier balayage traite tout de suite un
    // `prochainPassage` dépassé (règle de rattrapage), sans attendre 30 s.
    void this.tick();
  }

  /** Arrête le balayage et ABANDONNE les tours en vol. */
  stop(): void {
    this.arrete = true;
    if (this.timer !== null) {
      this.clearIntervalFn(this.timer);
      this.timer = null;
    }
    for (const [nom, tour] of [...this.enVol]) {
      this.journaler("saut", nom, "Arrêt du balayeur : le tour en cours est abandonné.");
      tour.controller.abort();
      this.enVol.delete(nom);
    }
  }

  /** Vrai si un tour de ce déclencheur est en vol (diagnostic, tests). */
  enCours(nom: string): boolean {
    return this.enVol.has(nom);
  }

  /**
   * UN balayage : parcourt les déclencheurs PLANIFIÉS. ⚠️ Public pour les tests
   * (le temps y est injecté).
   */
  async tick(): Promise<void> {
    if (this.balayageEnCours) return;
    this.balayageEnCours = true;
    try {
      const maintenant = this.now();
      // ⚠️ ENVOIS PROGRAMMÉS D'ABORD (lot 28) : ce sont des publications à une heure
      // précise, indépendantes des déclencheurs. Ils passent par CE tick, donc par le
      // seul `setInterval` du processus — et ils sont exécutés même quand aucun
      // déclencheur n'est défini.
      if (this.options.envoisProgrammes) {
        try {
          await this.options.envoisProgrammes.executerDus(maintenant);
        } catch (error) {
          // ⚠️ Un envoi en échec ne doit pas empêcher les déclencheurs d'être balayés.
          this.options.logger.warn("sources.balayeur.envois_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      // ⚠️ CONSOLIDATION HEBDOMADAIRE (lot 29) : décidée ici, JAMAIS attendue. Une
      // passe peut durer plusieurs minutes (plusieurs appels au modèle lourd) :
      // l'attendre retarderait tous les déclencheurs planifiés du même tick.
      // Le verrou `enCours` de la passe garantit qu'un seul travail tourne.
      if (this.options.passeHebdo) {
        void this.options.passeHebdo.executerSiDu(maintenant).catch((error: unknown) => {
          this.options.logger.warn("sources.balayeur.passe_hebdo_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      for (const record of this.options.store.list()) {
        if (record.actif === false) continue;
        if (record.declencheur.type === "planning") await this.balayer(record, maintenant);
        // ⚠️ LOT 31 — TÂCHE PONCTUELLE (`planifier_tache`) : un SEUL passage, à un instant
        // absolu. Elle est balayée par CE tick (aucun second ordonnanceur).
        else if (record.declencheur.type === "ponctuel") {
          await this.balayerPonctuel(record, maintenant);
        }
      }
    } catch (error) {
      this.options.logger.warn("sources.balayeur.tick_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.balayageEnCours = false;
    }
  }

  private async balayer(record: SourceRecord, maintenant: number): Promise<void> {
    if (record.declencheur.type !== "planning") return;
    const nom = record.nom;
    const { expression, fuseau } = record.declencheur;
    let calendrier: ReturnType<typeof parseCron>;
    try {
      calendrier = parseCron(expression);
    } catch (error) {
      const raison = error instanceof Error ? error.message : String(error);
      this.options.store.setActif(nom, false, raison);
      this.journaler("desactive", nom, raison);
      return;
    }

    // ① Armement : pas de prochain passage connu ⇒ on en calcule un (aucun tir).
    const arme = this.instant(record.prochainPassage);
    if (arme === undefined) {
      const suivant = this.calculer(calendrier, fuseau, maintenant, nom);
      if (suivant === undefined) return;
      this.options.store.markPlanification(nom, {
        prochainPassage: new Date(suivant).toISOString(),
      });
      return;
    }

    // ② Pas encore l'heure.
    if (maintenant < arme) return;

    // ③ L'heure est passée. ⚠️ FIN DE RÉCURRENCE (lot 32) AVANT le réarmement : quand la
    // récurrence est finie, on ne réécrit NI `dernierPassage` (le passage n'a pas eu lieu)
    // NI `prochainPassage`.
    // Deux formes indépendantes :
    //   • `occurrencesMax` : le compteur est PERSISTÉ et ne compte que les passages
    //     réellement tirés (jamais un saut) ; dès qu'il a atteint le maximum, plus aucun
    //     passage ne part ;
    //   • `jusquAu` : passé cet instant, plus aucun passage ne part.
    // ⚠️ L'extinction passe par `setActif(false, raison)` + journal `desactive` — le
    // MÊME canal que `DÉSACTIVER`, donc la même visibilité dans `/config`.
    const fin = this.finDeRecurrence(record, maintenant, fuseau);
    if (fin !== undefined) {
      this.options.store.setActif(nom, false, fin);
      this.journaler("desactive", nom, fin);
      return;
    }

    // ③ ter On RÉARME ensuite (un plantage ne double pas le tir).
    const retard = maintenant - arme;
    const suivant = this.calculer(calendrier, fuseau, maintenant, nom);
    this.options.store.markPlanification(nom, {
      ...(suivant !== undefined ? { prochainPassage: new Date(suivant).toISOString() } : {}),
      dernierPassage: new Date(arme).toISOString(),
    });

    // ④ Rattrapage : une seule fois si < 1 h, sinon on saute — et on le DIT.
    if (retard > RATTRAPAGE_MAX_MS) {
      this.journaler(
        "saut",
        nom,
        `Passage manqué de ${Math.round(retard / 60_000)} min (maximum rattrapable ` +
          `${Math.round(RATTRAPAGE_MAX_MS / 60_000)} min) : il est sauté ; le prochain ` +
          `passage est réarmé${suivant !== undefined ? ` à ${new Date(suivant).toISOString()}` : ""}.`,
      );
      return;
    }
    if (record.rattrapage === "sauter") {
      this.journaler(
        "saut",
        nom,
        `Passage de ${new Date(arme).toISOString()} sauté (rattrapage désactivé pour ce déclencheur).`,
      );
      return;
    }

    // ⑤ Garde-fou QUOTIDIEN : au-delà du plafond, on SUSPEND avec une raison.
    const joue = Math.max(1, record.maxToursParJour ?? DEFAULT_MAX_TOURS_PAR_JOUR);
    const jour = jourLocal(maintenant, fuseau);
    const compte = this.options.store.incrementerTour(nom, jour);
    if (compte > joue) {
      const raison = raisonGardeFouQuotidien(joue, jour);
      this.options.store.setActif(nom, false, raison);
      this.journaler("desactive", nom, raison);
      return;
    }

    // ⑥ Chevauchement : sauté par défaut, ou l'ancien tour est ABANDONNÉ.
    const dejaEnVol = this.enVol.get(nom);
    if (dejaEnVol !== undefined) {
      if (record.chevauchement !== "remplacer") {
        this.journaler(
          "saut",
          nom,
          "Un tour de ce déclencheur est encore en cours : ce passage est sauté " +
            "(chevauchement « sauter »).",
        );
        return;
      }
      this.journaler(
        "saut",
        nom,
        "Chevauchement « remplacer » : le tour en cours est abandonné au profit du nouveau.",
      );
      dejaEnVol.controller.abort();
      this.enVol.delete(nom);
    }

    await this.lancer(record, arme);
  }

  /**
   * Fin de récurrence ATTEINTE ? Rend la raison LISIBLE de l'extinction, ou `undefined`.
   *
   * ⚠️ `occurrencesMax` : on compare le compteur DÉJÀ persisté — celui du passage qui
   * vient de se terminer. Incrémenter ici compterait aussi les passages SAUTÉS (le
   * réarmement précède les règles de rattrapage et de chevauchement), ce qui afficherait
   * « 14/14 passages » alors que Yuki n'a rien exécuté : le compteur est incrémenté au
   * seul endroit où le passage est réellement lancé.
   */
  private finDeRecurrence(
    record: SourceRecord,
    maintenant: number,
    fuseau: string,
  ): string | undefined {
    const max = record.occurrencesMax;
    if (typeof max === "number" && Number.isFinite(max) && max >= 1) {
      const faites = Math.max(0, Math.trunc(record.occurrencesFaites ?? 0));
      if (faites >= Math.trunc(max)) return raisonFinOccurrences(faites, Math.trunc(max));
    }
    if (typeof record.jusquAu === "string" && record.jusquAu !== "") {
      const limite = this.instant(record.jusquAu);
      if (limite !== undefined && maintenant > limite) {
        return raisonFinDate(limite, fuseau);
      }
    }
    return undefined;
  }

  /**
   * UN passage de tâche PONCTUELLE (lot 31).
   *
   * ⚠️ ORDRE CRITIQUE : **désarmer AVANT de lancer**. Le motif est persisté
   * (`setActif(false, …)`) AVANT l'appel au runner : si le processus meurt pendant
   * l'exécution, le redémarrage ne trouve plus de tâche active et ne la rejoue donc pas.
   * À la fin, le motif devient « terminée : <heure> » ou « échouée : <raison> » — le même
   * canal que `DÉSACTIVER`, donc la même visibilité dans `/config`.
   *
   * ⚠️ Une échéance manquée de plus de `RATTRAPAGE_MAX_MS` (1 h, machine arrêtée) n'est
   * PAS exécutée en retard : une tâche ponctuelle dit quelque chose de daté (« le résumé
   * du journal de 7 h »), la rejouer à 15 h tromperait. Elle est dite « non exécutée ».
   */
  private async balayerPonctuel(record: SourceRecord, maintenant: number): Promise<void> {
    if (record.declencheur.type !== "ponctuel") return;
    const nom = record.nom;
    const echeance = this.instant(record.declencheur.a);
    if (echeance === undefined) {
      const raison = `Date de la tâche illisible (« ${record.declencheur.a} ») : elle ne peut pas être exécutée.`;
      this.options.store.setActif(nom, false, raison);
      this.journaler("desactive", nom, raison);
      return;
    }
    if (maintenant < echeance) return;

    const heure = this.heureLisible(echeance, record.declencheur.fuseau);
    const retard = maintenant - echeance;
    // ⚠️ DÉSARMER D'ABORD (voir le commentaire du dessus), puis décider.
    this.options.store.setActif(nom, false, RAISON_TACHE_EN_COURS);

    if (retard > RATTRAPAGE_MAX_MS) {
      const raison =
        `non exécutée : l'échéance du ${heure} est passée depuis ` +
        `${Math.round(retard / 60_000)} min (maximum exécutable en retard : ` +
        `${Math.round(RATTRAPAGE_MAX_MS / 60_000)} min).`;
      this.journaler("saut", nom, raison);
      this.options.store.setActif(nom, false, raison);
      this.journaler("desactive", nom, raison);
      return;
    }

    const resultat = await this.lancer(record, echeance, { desarmementPrealable: true });
    if (resultat.outcome !== "started" || resultat.fin === undefined) {
      const raison = `échouée : ${resultat.raison ?? "elle n'a pas pu démarrer."}`;
      this.options.store.setActif(nom, false, raison);
      this.journaler("desactive", nom, raison);
      return;
    }
    // ⚠️ Le motif définitif attend la VRAIE fin (résultat du worker), sans bloquer le
    // tick : le balayeur ne s'arrête pas sur une tâche de fond.
    void resultat.fin
      .then((fin) => {
        const raison =
          fin.reason === "done"
            ? `terminée : ${heure}`
            : `échouée : ${
                fin.plafond
                  ? "plafond d'exécution atteint (voir la conversation)"
                  : "la tâche de fond n'a pas abouti (voir la conversation)"
              }`;
        this.options.store.setActif(nom, false, raison);
        this.journaler("desactive", nom, raison);
      })
      .catch(() => undefined);
  }

  /** Heure lisible (« 4 novembre 2026 à 08:00 ») d'une échéance, dans son fuseau. */
  private heureLisible(instant: number, fuseau: string | undefined): string {
    try {
      return new Intl.DateTimeFormat("fr-FR", {
        timeZone: fuseau ?? DEFAULT_FUSEAU,
        dateStyle: "long",
        timeStyle: "short",
      }).format(new Date(instant));
    } catch {
      return new Date(instant).toISOString();
    }
  }

  /** Lance un tour et retient sa place jusqu'à sa VRAIE fin (ou le plafond). */
  private async lancer(
    record: SourceRecord,
    arme: number,
    options: { desarmementPrealable?: boolean } = {},
  ): Promise<{
    outcome: DeclenchementResult["outcome"];
    raison?: string;
    fin?: Promise<DeclenchementFin>;
  }> {
    const nom = record.nom;
    const plafondMs = Math.max(60_000, record.plafondMs ?? DEFAULT_PLAFOND_MS);
    const controller = new AbortController();
    const minuteur = this.setTimeoutFn(() => {
      // ⚠️ Le plafond est la SEULE protection contre un tour qui ne rend jamais la
      // main : on `abort` ; l'événement `plafond` est écrit par le service quand le
      // tour a RÉELLEMENT été arrêté (et ici, en dernier recours, par le filet).
      this.options.logger.warn("sources.balayeur.plafond", {
        source: nom,
        plafond_ms: plafondMs,
      });
      controller.abort("plafond");
    }, plafondMs);

    let resultat: DeclenchementResult;
    try {
      resultat = await this.options.run(nom, {
        origine: this.origine,
        planifie: arme,
        plafondMs,
        signal: controller.signal,
        ...(options.desarmementPrealable === true ? { desarmementPrealable: true } : {}),
      });
    } catch (error) {
      this.clearTimeoutFn(minuteur);
      const raison = `Le passage n'a pas pu démarrer : ${messageOf(error)}`;
      this.journaler("echec", nom, raison);
      return { outcome: "failed", raison };
    }
    if (resultat.outcome !== "started") {
      this.clearTimeoutFn(minuteur);
      if (resultat.outcome === "failed") {
        this.journaler("echec", nom, resultat.raison ?? "Le passage n'a pas pu démarrer.");
      }
      return {
        outcome: resultat.outcome,
        ...(resultat.raison !== undefined ? { raison: resultat.raison } : {}),
      };
    }
    // ⚠️ Filet : si le host ne rend jamais `run_finished` (abort non appliqué),
    // la place est libérée après le plafond + une grâce — jamais un blocage muet.
    const delai = plafondMs + GRACE_APRES_ABORT_MS;
    let grace: unknown;
    const filet = new Promise<DeclenchementFin>((resolve) => {
      grace = this.setTimeoutFn(() => {
        this.journaler(
          "plafond",
          nom,
          `Le tour n'a pas rendu la main ${Math.round(delai / 60_000)} min après son ` +
            "démarrage : la place est libérée (le run est considéré abandonné).",
        );
        resolve({ reason: "abort", texte: "", plafond: true });
      }, delai);
    });
    const fin = Promise.race([resultat.fin, filet]);
    const tour: TourEnVol = { controller, fin };
    this.enVol.set(nom, tour);
    void fin
      .catch(() => ({ reason: "error", texte: "" }) as DeclenchementFin)
      .finally(() => {
        this.clearTimeoutFn(grace);
        this.clearTimeoutFn(minuteur);
        if (this.enVol.get(nom) === tour) this.enVol.delete(nom);
        this.options.logger.info("sources.balayeur.tour.termine", { source: nom });
      });
    // ⚠️ LOT 32 — LE COMPTEUR DE PASSAGES (persisté) n'est incrémenté ICI qu'une fois
    // le tour RÉELLEMENT lancé : un saut (rattrapage refusé, chevauchement, garde-fou)
    // n'a jamais compté. Il est écrit avant la fin du tour : un plantage ne le remet pas
    // à zéro au redémarrage.
    if (record.declencheur.type === "planning") {
      const compte = this.options.store.incrementerOccurrence(nom);
      this.options.logger.info("sources.balayeur.passage.compte", {
        source: nom,
        occurrences: compte,
        ...(record.occurrencesMax !== undefined ? { maximum: record.occurrencesMax } : {}),
      });
    }
    this.options.logger.info("sources.balayeur.tour.lance", {
      source: nom,
      planifie: new Date(arme).toISOString(),
      plafond_ms: plafondMs,
    });
    return { outcome: "started", fin };
  }

  /** Prochain passage calculé, ou suspension EXPLICITE si l'expression est impossible. */
  private calculer(
    calendrier: ReturnType<typeof parseCron>,
    fuseau: string,
    depuis: number,
    nom: string,
  ): number | undefined {
    try {
      return prochainPassage(calendrier, depuis, fuseau);
    } catch (error) {
      const raison = error instanceof Error ? error.message : String(error);
      this.options.store.setActif(nom, false, raison);
      this.journaler("desactive", nom, raison);
      return undefined;
    }
  }

  /** Instant d'une chaîne ISO (borné : `undefined` si absente ou illisible). */
  private instant(iso: string | undefined): number | undefined {
    if (typeof iso !== "string" || iso === "") return undefined;
    const at = Date.parse(iso);
    return Number.isFinite(at) ? at : undefined;
  }

  private journaler(
    event: "saut" | "plafond" | "desactive" | "echec" | "refus",
    source: string,
    raison: string,
  ): void {
    this.options.journal?.append({ event, source, raison });
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
