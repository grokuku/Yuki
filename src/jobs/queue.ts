/**
 * File FIFO bornée de jobs (AUCUN import SDK/typebox).
 *
 * - `maxConcurrent` jobs lourds simultanés (défaut 3) ;
 * - `maxQueue` jobs en attente (défaut 10) ;
 * - dépassement → refus explicite `queue_full` (jamais de blocage silencieux).
 *
 * La file ne connaît que des identifiants de jobs : l'orchestration (démarrage
 * effectif du worker) appartient au service de délégation.
 */

export const DEFAULT_MAX_CONCURRENT = 3;
export const DEFAULT_MAX_QUEUE = 10;

export type Admission =
  | { admission: "start" }
  | { admission: "queued"; position: number }
  | { admission: "rejected"; reason: "queue_full" };

export interface JobQueueOptions {
  maxConcurrent?: number;
  maxQueue?: number;
}

export class JobQueue {
  private readonly maxConcurrent: number;
  private readonly maxQueue: number;
  private readonly waiting: string[] = [];
  private readonly running = new Set<string>();

  constructor(options: JobQueueOptions = {}) {
    this.maxConcurrent = Math.max(
      1,
      Math.floor(options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT),
    );
    this.maxQueue = Math.max(0, Math.floor(options.maxQueue ?? DEFAULT_MAX_QUEUE));
  }

  get capacity(): number {
    return this.maxConcurrent;
  }

  get queueLimit(): number {
    return this.maxQueue;
  }

  get runningCount(): number {
    return this.running.size;
  }

  get queuedCount(): number {
    return this.waiting.length;
  }

  isRunning(jobId: string): boolean {
    return this.running.has(jobId);
  }

  isQueued(jobId: string): boolean {
    return this.waiting.includes(jobId);
  }

  /** Tente d'admettre un job : démarrage immédiat, mise en file ou refus. */
  admit(jobId: string): Admission {
    if (this.running.has(jobId) || this.waiting.includes(jobId)) {
      return this.running.has(jobId)
        ? { admission: "start" }
        : { admission: "queued", position: this.waiting.indexOf(jobId) + 1 };
    }
    if (this.running.size < this.maxConcurrent) {
      this.running.add(jobId);
      return { admission: "start" };
    }
    if (this.waiting.length >= this.maxQueue) {
      return { admission: "rejected", reason: "queue_full" };
    }
    this.waiting.push(jobId);
    return { admission: "queued", position: this.waiting.length };
  }

  /**
   * Libère le slot d'un job terminé et renvoie l'identifiant du prochain job à
   * démarrer (FIFO), s'il y en a un.
   */
  release(jobId: string): string | undefined {
    this.running.delete(jobId);
    const next = this.waiting.shift();
    if (next === undefined) return undefined;
    this.running.add(next);
    return next;
  }

  /** Retire un job en attente (annulation). Renvoie `true` s'il était en file. */
  remove(jobId: string): boolean {
    const index = this.waiting.indexOf(jobId);
    if (index < 0) return false;
    this.waiting.splice(index, 1);
    return true;
  }

  /** Vide la file (les slots en cours ne sont pas touchés). */
  drain(): string[] {
    return this.waiting.splice(0);
  }
}
