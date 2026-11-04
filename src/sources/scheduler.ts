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
}

export interface DeclencheurBalayeurOptions {
  store: BalayeurStore;
  run: DeclencheurRunner;
  logger: BalayeurLogger;
  /** Journal des déclencheurs (absent ⇒ aucune trace, le balayeur fonctionne). */
  journal?: Pick<DeclencheurJournal, "append">;
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

/** Raison LISIBLE d'une suspension par le garde-fou quotidien. */
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
      for (const record of this.options.store.list()) {
        if (record.declencheur.type !== "planning") continue;
        if (record.actif === false) continue;
        await this.balayer(record, maintenant);
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

    // ③ L'heure est passée : on RÉARME d'abord (un plantage ne double pas le tir).
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

  /** Lance un tour et retient sa place jusqu'à sa VRAIE fin (ou le plafond). */
  private async lancer(record: SourceRecord, arme: number): Promise<void> {
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
      });
    } catch (error) {
      this.clearTimeoutFn(minuteur);
      this.journaler("echec", nom, `Le passage n'a pas pu démarrer : ${messageOf(error)}`);
      return;
    }
    if (resultat.outcome !== "started") {
      this.clearTimeoutFn(minuteur);
      if (resultat.outcome === "failed") {
        this.journaler("echec", nom, resultat.raison ?? "Le passage n'a pas pu démarrer.");
      }
      return;
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
    this.options.logger.info("sources.balayeur.tour.lance", {
      source: nom,
      planifie: new Date(arme).toISOString(),
      plafond_ms: plafondMs,
    });
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
