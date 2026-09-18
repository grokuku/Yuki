/**
 * `FakeHeavyWorker` — double déterministe du worker lourd, sans SDK ni réseau.
 *
 * Permet de contrôler finement la durée d'un job (inline vs pending), de
 * simuler un premier token, un travail partiel, une annulation ou un échec.
 */

import type {
  HeavyRunHandle,
  HeavyRunRequest,
  HeavyRunResult,
  HeavyWorker,
} from "../../src/delegation/ports.js";

export interface FakeHeavyBehavior {
  /** Résout automatiquement après ce délai (ms). Ignoré si `manual`. */
  autoMs?: number;
  /** Résultat renvoyé (défaut : `completed` avec le texte `résultat lourd`). */
  result?: HeavyRunResult;
  /** Émet un premier token avant de résoudre. */
  firstToken?: boolean;
  /** Travail partiel émis (appel `onProgress`) avant de résoudre. */
  partial?: string;
  /** Ne résout jamais tout seul : le test appelle `finish`/`cancel`. */
  manual?: boolean;
}

interface RecordedRun {
  request: HeavyRunRequest;
  behavior: FakeHeavyBehavior;
  resolve: (result: HeavyRunResult) => void;
  settled: boolean;
}

export class FakeHeavyWorker implements HeavyWorker {
  readonly runs: HeavyRunRequest[] = [];
  readonly behaviors: FakeHeavyBehavior[] = [];
  private readonly pending: RecordedRun[] = [];
  private autoTimer: ReturnType<typeof setTimeout> | undefined;

  /** Programme le comportement du prochain `run`. */
  push(behavior: FakeHeavyBehavior = {}): void {
    this.behaviors.push(behavior);
  }

  run(request: HeavyRunRequest): HeavyRunHandle {
    const behavior = this.behaviors.shift() ?? {};
    this.runs.push(request);
    let resolve!: (result: HeavyRunResult) => void;
    const promise = new Promise<HeavyRunResult>((r) => {
      resolve = r;
    });
    const record: RecordedRun = { request, behavior, resolve, settled: false };
    this.pending.push(record);

    if (behavior.firstToken) request.onFirstToken?.();
    if (behavior.partial !== undefined) request.onProgress?.(behavior.partial);

    if (!behavior.manual) {
      this.autoTimer = setTimeout(() => {
        this.settle(record, behavior.result ?? { status: "completed", text: "résultat lourd" });
      }, behavior.autoMs ?? 0);
      this.autoTimer.unref?.();
    }

    return {
      promise,
      cancel: async (): Promise<void> => {
        this.settle(record, { status: "cancelled" });
      },
    };
  }

  private settle(record: RecordedRun, result: HeavyRunResult): void {
    if (record.settled) return;
    record.settled = true;
    record.resolve(result);
  }

  /** Résout explicitement le run d'index `index`. */
  finish(index: number, result: HeavyRunResult): void {
    const record = this.pending[index];
    if (!record) return;
    this.settle(record, result);
  }

  /** Résout le dernier run enregistré. */
  finishLast(result: HeavyRunResult): void {
    this.finish(this.pending.length - 1, result);
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  dispose(): void {
    if (this.autoTimer) clearTimeout(this.autoTimer);
  }
}
