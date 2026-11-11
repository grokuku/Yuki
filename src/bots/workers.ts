/**
 * UN WORKER LOURD PAR BOT, CRÉÉ PARESSEUSEMENT (lot 36, morceau L7).
 *
 * ⚠️ CE QUE CE MODULE ÉVITE : au démarrage, `main()` construit UN worker lourd
 * (profil GPU, outils d'action, session SDK) pour le bot de la pile. En
 * multi-bot, en construire un par bot au démarrage multiplierait la mémoire
 * (chaque worker garde ses options, son prompt et ses outils) pour des bots qui
 * ne délégueront peut-être jamais rien. Un bot muet paierait donc une facture
 * qu'il n'utilise pas.
 *
 * Trois règles, et elles suffisent :
 *  1. **PARESSEUX** : un worker n'est construit qu'à la PREMIÈRE demande de son
 *     bot (`pour`). Le constructeur ne construit RIEN — seule exception : les
 *     workers DÉJÀ construits par `main()` (le principal), qui sont réutilisés
 *     par identité.
 *  2. **STRUCTUREL** : un bot sans capacité `execution` ni `delegation` n'a
 *     jamais de worker (`workerLourdAutorise`, `src/bots/profils.ts`). Ce n'est
 *     pas une permission vérifiée à l'entrée : la fabrique n'est pas appelée.
 *  3. **PLAFONNÉ** : au-delà de `plafond` workers, la demande est REFUSÉE en le
 *     disant (plafond, workers déjà construits, bot demandeur) — jamais un
 *     worker silencieusement absent.
 *
 * ⚠️ La mémoire est MESURÉE (`rss`) et journalisée à chaque construction ainsi
 * qu'à la demande (`journaliserRss`) : c'est ce qui rend « combien coûte un bot
 * de plus » observable au lieu d'être supposé.
 *
 * Aucun import SDK/typebox : `T` est le worker réel, `creer` la seule couture.
 */

import type { CapaciteBot } from "./registry.js";
import { workerLourdAutorise } from "./profils.js";

/** Journal minimal attendu (le `Logger` de l'application le satisfait). */
export interface WorkersLourdsLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

/** Plafond par DÉFAUT des workers simultanés (le plafond des bots est 6 max). */
export const MAX_WORKERS_LOURDS_DEFAUT = 3;

/** Ramène une valeur quelconque à un plafond entier borné. */
export function normaliserPlafondWorkers(valeur: unknown): number {
  const nombre = typeof valeur === "number" ? valeur : Number(valeur);
  if (!Number.isFinite(nombre)) return MAX_WORKERS_LOURDS_DEFAUT;
  const entier = Math.trunc(nombre);
  if (entier < 1) return 1;
  return entier;
}

/** Raison d'un refus de worker (le journal et les tests la nomment). */
export type RefusWorker = "capacites" | "plafond";

export interface OptionsWorkersLourds<T> {
  /** Bot de la PILE : son worker est celui que `main()` a déjà construit. */
  readonly botDePile: string;
  /** Workers DÉJÀ construits (le principal), réutilisés par identité. */
  readonly existants?: ReadonlyMap<string, T>;
  /** Capacités d'un bot (`undefined` = mono-bot historique ⇒ autorisé). */
  readonly capacites: (botId: string) => readonly CapaciteBot[] | undefined;
  /** Fabrique : n'est appelée que si les capacités l'autorisent et sous le plafond. */
  readonly creer: (botId: string) => T;
  /** Plafond de workers simultanés (défaut {@link MAX_WORKERS_LOURDS_DEFAUT}). */
  readonly plafond?: unknown;
  /** Mesure de mémoire (défaut `process.memoryUsage().rss`), injectable en test. */
  readonly rss?: () => number;
  readonly logger?: WorkersLourdsLogger;
}

/** Ce qu'un relevé mémoire dit (journalisé tel quel). */
export interface ReleveWorkers {
  readonly workers: number;
  readonly plafond: number;
  readonly rssMb: number;
  readonly bots: string[];
}

/**
 * Map `botId → worker lourd`, construite à la demande.
 *
 * ⚠️ Aucun worker n'est construit au démarrage par cette classe : elle ne fait
 * que SEMER ceux que `main()` a déjà construits (`existants`). C'est la
 * propriété testée par « un bot muet ne coûte rien au démarrage ».
 */
export class WorkersLourdsBots<T> {
  private readonly options: OptionsWorkersLourds<T>;
  private readonly map = new Map<string, T>();
  /** Refus déjà dits (un par bot et par raison : pas de spam au journal). */
  private readonly refuses = new Map<string, RefusWorker>();
  readonly plafond: number;

  constructor(options: OptionsWorkersLourds<T>) {
    this.options = options;
    this.plafond = normaliserPlafondWorkers(options.plafond ?? MAX_WORKERS_LOURDS_DEFAUT);
    for (const [botId, worker] of options.existants ?? []) this.map.set(botId, worker);
  }

  /** Worker d'un bot — construit à la PREMIÈRE demande, ou `undefined`. */
  pour(botId: string): T | undefined {
    const deja = this.map.get(botId);
    if (deja !== undefined) return deja;

    // ⚠️ STRUCTUREL : sans capacité, la fabrique n'est même pas appelée.
    if (!workerLourdAutorise(this.options.capacites(botId))) {
      this.refuser(botId, "capacites");
      return undefined;
    }
    // ⚠️ PLAFOND : refus EXPLICITE, nommant le plafond et les workers existants.
    if (this.map.size >= this.plafond) {
      this.refuser(botId, "plafond");
      return undefined;
    }

    const worker = this.options.creer(botId);
    this.map.set(botId, worker);
    this.refuses.delete(botId);
    this.options.logger?.info("bots.worker.construit", {
      bot: botId,
      workers: this.map.size,
      plafond: this.plafond,
      rss_mb: this.rssMo(),
    });
    return worker;
  }

  /** Le bot a-t-il un worker CONSTRUIT ? */
  a(botId: string): boolean {
    return this.map.has(botId);
  }

  /** Bots ayant un worker (ordre de construction). */
  construits(): string[] {
    return [...this.map.keys()];
  }

  /** Nombre de workers construits. */
  get taille(): number {
    return this.map.size;
  }

  /** Raison du refus mémorisé pour un bot, ou `undefined`. */
  refus(botId: string): RefusWorker | undefined {
    return this.refuses.get(botId);
  }

  /** Relevé mémoire (aucune écriture). */
  releve(): ReleveWorkers {
    return {
      workers: this.map.size,
      plafond: this.plafond,
      rssMb: this.rssMo(),
      bots: [...this.map.keys()],
    };
  }

  /** Journalise le relevé (`bots.workers.rss`) et le rend. */
  journaliserRss(): ReleveWorkers {
    const releve = this.releve();
    this.options.logger?.info("bots.workers.rss", {
      workers: releve.workers,
      plafond: releve.plafond,
      rss_mb: releve.rssMb,
      bots: releve.bots.join(","),
    });
    return releve;
  }

  /** Oublie le worker d'un bot (arrêt ciblé, L9). Rend `true` s'il en avait un. */
  oublier(botId: string): boolean {
    return this.map.delete(botId);
  }

  private refuser(botId: string, raison: RefusWorker): void {
    if (this.refuses.get(botId) === raison) return;
    this.refuses.set(botId, raison);
    this.options.logger?.warn(
      raison === "capacites" ? "bots.worker.refuse" : "bots.worker.plafond",
      raison === "capacites"
        ? { bot: botId, raison: "aucune capacite execution/delegation" }
        : {
            bot: botId,
            raison: `plafond de ${this.plafond} worker(s) atteint`,
            construits: [...this.map.keys()].join(","),
          },
    );
  }

  private rssMo(): number {
    const mesure = (this.options.rss ?? (() => process.memoryUsage().rss))();
    return Math.round(mesure / (1024 * 1024));
  }
}
