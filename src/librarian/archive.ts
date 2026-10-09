/**
 * Archivage du libraire en TÂCHE DE FOND — AUCUN import SDK/typebox.
 *
 * ⚠️ DEMANDE EXPLICITE : l'archivage ne doit JAMAIS bloquer la conversation.
 * `schedule()` rend donc la main IMMÉDIATEMENT : il valide, crée un job et le
 * met en file — sans AUCUN appel réseau, sans AUCUNE attente du modèle.
 *
 * En coulisses (sans lien avec le run de la conversation) :
 *   1. vérification des doublons (`GET /library`) — le libraire n'archive JAMAIS
 *      tout seul et le serveur ne scrape pas `sourceUrl` ;
 *   2. rédaction de la synthèse par un appel de modèle ISOLÉ (session éphémère,
 *      port `LibrarianSynthesizer`) ;
 *   3. `POST /archive`.
 *
 * ⚠️ RÉUTILISE le mécanisme de tâches de fond existant : le MÊME `JobStore`
 * (journal append-only), la MÊME `JobQueue` (concurrence bornée) et le MÊME canal
 * de REPORT que la délégation — à la fin d'un job, on réveille la session légère
 * avec `buildReportPrompt` (origine `job_report`). L'issue (succès comme ÉCHEC)
 * devient donc VISIBLE dans la conversation : un archivage silencieusement raté
 * est écarté par construction.
 *
 * ⚠️ Un fichier de journal SÉPARÉ de celui de la délégation est utilisé par le
 * câblage (`librarian-jobs.jsonl`) : les jobs d'archivage ne se mêlent pas aux
 * jobs de délégation (`job_status`/`cancel_job` ne les voient pas — l'annulation
 * d'une archive n'a d'ailleurs pas de sens ici).
 */

import type { LightWaker } from "../delegation/ports.js";
import { buildReportPrompt } from "../delegation/report.js";
import { JobQueue } from "../jobs/queue.js";
import type { JobStore } from "../jobs/store.js";
import type { JobRecord } from "../jobs/types.js";
import { messageOfLibrarianError } from "./errors.js";
import { buildSynthesisPrompt, parseSynthesis } from "./prompt.js";
import type {
  LibrarianArchiveInput,
  LibrarianArchivePort,
  LibrarianLogger,
  LibrarianPort,
  LibrarianScheduleOutcome,
  LibrarianSynthesizer,
} from "./types.js";

/** Origine des jobs d'archivage (diagnostic / corrélation). */
export const ORIGIN_LIBRARIAN_ARCHIVE = "librarian_archive";
/** Origine du prompt de report (même valeur que la délégation). */
export const ORIGIN_JOB_REPORT = "job_report";

/** Concurrence et file d'archivage (bornes ; l'archivage est rare). */
export const DEFAULT_LIBRARIAN_MAX_CONCURRENT = 2;
export const DEFAULT_LIBRARIAN_MAX_QUEUE = 10;

export interface LibrarianArchiveServiceOptions {
  store: JobStore;
  /** Port du libraire (doublons + `POST /archive`). */
  client: LibrarianPort;
  /** Rédacteur de synthèse (session de modèle ISOLÉE). */
  synthesizer: LibrarianSynthesizer;
  logger: LibrarianLogger;
  queue?: JobQueue;
  waker?: LightWaker;
  now?: () => number;
  idFactory?: () => string;
}

interface PendingEntry {
  key: string;
  input: LibrarianArchiveInput;
  lightSessionId: string;
}

/** Service d'archivage en tâche de fond. */
export class LibrarianArchiveService implements LibrarianArchivePort {
  private readonly store: JobStore;
  private readonly client: LibrarianPort;
  private readonly synthesizer: LibrarianSynthesizer;
  private readonly logger: LibrarianLogger;
  private readonly queue: JobQueue;
  private readonly now: () => number;
  private readonly idFactory: () => string;

  private waker?: LightWaker;
  /** Jobs en file ou en cours, par clé `name@version` (idempotence). */
  private readonly pending = new Map<string, string>();
  /** Entrées nécessaires au démarrage d'un job (matière + session). */
  private readonly entries = new Map<string, PendingEntry>();
  /** Résolveurs de fin de job (tests / attente bornée). */
  private readonly completions = new Map<string, (record: JobRecord) => void>();

  constructor(options: LibrarianArchiveServiceOptions) {
    this.store = options.store;
    this.client = options.client;
    this.synthesizer = options.synthesizer;
    this.logger = options.logger;
    this.queue =
      options.queue ??
      new JobQueue({
        maxConcurrent: DEFAULT_LIBRARIAN_MAX_CONCURRENT,
        maxQueue: DEFAULT_LIBRARIAN_MAX_QUEUE,
      });
    this.now = options.now ?? Date.now;
    this.idFactory =
      options.idFactory ??
      (() => `lib-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    if (options.waker) this.waker = options.waker;
  }

  /** Renseigne le réveil du léger une fois le host construit. */
  setWaker(waker: LightWaker): void {
    this.waker = waker;
  }

  /** Nombre de jobs d'archivage en file ou en cours (diagnostic / tests). */
  pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Soumet un archivage. ⚠️ Rend la main IMMÉDIATEMENT : aucun appel réseau.
   * Idempotent : un second appel pour le même `name@version` en vol renvoie le
   * même job au lieu d'en créer un nouveau.
   */
  schedule(
    input: LibrarianArchiveInput,
    options: { lightSessionId: string },
  ): LibrarianScheduleOutcome {
    const key = `${input.name}@${input.version}`;
    const existing = this.pending.get(key);
    if (existing) return { status: "already_pending", job_id: existing };

    const jobId = this.idFactory();
    const admission = this.queue.admit(jobId);
    if (admission.admission === "rejected") {
      this.logger.warn("librarian.archive.queue_full", { job_id: jobId });
      return { status: "rejected", reason: "queue_full" };
    }

    const createdAt = new Date(this.now()).toISOString();
    this.store.append(jobId, "created", {
      status: "queued",
      task: `Archiver « ${input.name} ${input.version} »`,
      deadlineMs: 0,
      lightSessionId: options.lightSessionId,
      origin: ORIGIN_LIBRARIAN_ARCHIVE,
      createdAt,
    });
    this.store.append(jobId, "queued", {});
    this.entries.set(jobId, {
      key,
      input,
      lightSessionId: options.lightSessionId,
    });
    this.pending.set(key, jobId);

    if (admission.admission === "start") this.startJob(jobId);
    return { status: "launched", job_id: jobId };
  }

  /**
   * Attente bornée de la fin d'un job (tests et observabilité). Résout
   * IMMÉDIATEMENT si le job est déjà terminal ou inconnu.
   */
  settled(jobId: string): Promise<JobRecord | undefined> {
    const existing = this.store.get(jobId);
    if (existing && (existing.status === "completed" || existing.status === "failed")) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve) => {
      this.completions.set(jobId, resolve);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Interne                                                             */
  /* ------------------------------------------------------------------ */

  private startJob(jobId: string): void {
    const entry = this.entries.get(jobId);
    if (!entry) return;
    const record = this.store.get(jobId);
    if (!record || record.status !== "queued") return;
    this.store.append(jobId, "started", {
      status: "running",
      startedAt: new Date(this.now()).toISOString(),
    });
    // ⚠️ Le travail démarre dans une MICROTÂCHE : `schedule()` a déjà rendu la
    // main quand le PREMIER appel réseau est émis. La conversation n'attend rien.
    queueMicrotask(() => {
      void this.run(jobId, entry);
    });
  }

  private async run(jobId: string, entry: PendingEntry): Promise<void> {
    const { input } = entry;
    try {
      // 1) Doublons — le libraire n'archive jamais tout seul, et on ne veut pas
      //    créer deux fois la MÊME fiche. ⚠️ On ne se base que sur le couple
      //    exact (nom, version) : plusieurs versions d'un même nom cohabitent
      //    légitimement (cf. contrat Pi-Web), on n'empêche PAS d'en ajouter une.
      const library = await this.client.library();
      const duplicate = library.library.find(
        (item) => item.name === input.name && item.version === input.version,
      );
      if (duplicate) {
        this.finish(jobId, {
          status: "completed",
          text:
            `Archivage ignoré : « ${input.name} ${input.version} » est DÉJÀ dans la ` +
            "bibliothèque. Aucun doublon n'a été créé.",
        });
        return;
      }

      // 2) Rédaction de la synthèse (modèle isolé).
      const raw = await this.synthesizer(
        buildSynthesisPrompt({
          name: input.name,
          version: input.version,
          ...(input.type !== undefined ? { type: input.type } : {}),
          ...(input.sourceUrl !== undefined ? { sourceUrl: input.sourceUrl } : {}),
          material: input.material,
        }),
      );
      const content = parseSynthesis(raw);
      if (!content) {
        this.finish(jobId, {
          status: "failed",
          error:
            "La synthèse n'a pas pu être produite : la réponse du modèle est " +
            "inexploitable. Rien n'a été archivé.",
        });
        return;
      }

      // 3) Enregistrement.
      await this.client.archive({
        name: input.name,
        version: input.version,
        ...(input.type !== undefined ? { type: input.type } : {}),
        ...(input.sourceUrl !== undefined ? { sourceUrl: input.sourceUrl } : {}),
        content,
      });
      this.finish(jobId, {
        status: "completed",
        text:
          `Archive enregistrée : « ${input.name} ${input.version} » ` +
          `(${content.keyPoints.length} point(s) clé, ${content.examples.length} exemple(s)).`,
      });
    } catch (error) {
      this.finish(jobId, { status: "failed", error: messageOfLibrarianError(error) });
    }
  }

  private finish(
    jobId: string,
    result: { status: "completed" | "failed"; text?: string; error?: string },
  ): void {
    const entry = this.entries.get(jobId);
    this.entries.delete(jobId);
    if (entry) this.pending.delete(entry.key);
    const finishedAt = new Date(this.now()).toISOString();

    if (result.status === "completed") {
      this.store.append(jobId, "completed", {
        status: "completed",
        finishedAt,
        result: { text: result.text ?? "" },
      });
    } else {
      this.store.append(jobId, "failed", {
        status: "failed",
        finishedAt,
        error: { message: result.error ?? "échec de l'archivage" },
      });
    }

    const next = this.queue.release(jobId);
    if (next) this.startJob(next);

    const record = this.store.get(jobId);
    if (record) {
      const resolve = this.completions.get(jobId);
      if (resolve) {
        this.completions.delete(jobId);
        resolve(record);
      }
    }
    this.reportJob(jobId);
  }

  /**
   * Réveille la session légère avec le résultat — MÊME canal que la délégation
   * (`buildReportPrompt`, origine `job_report`). Un échec ne peut donc pas
   * passer inaperçu.
   */
  private reportJob(jobId: string): void {
    const record = this.store.get(jobId);
    if (!record) return;
    if (this.waker) {
      try {
        this.waker.send(record.lightSessionId, buildReportPrompt(record), {
          origin: ORIGIN_JOB_REPORT,
          jobId,
        });
      } catch (error) {
        this.logger.warn("librarian.archive.report.failed", {
          job_id: jobId,
          error: messageOfLibrarianError(error),
        });
      }
    }
    this.store.append(jobId, "notified", {
      notified: true,
      reportedAt: new Date(this.now()).toISOString(),
    });
  }
}

/** Fabrique du service d'archivage. */
export function createLibrarianArchiveService(
  options: LibrarianArchiveServiceOptions,
): LibrarianArchiveService {
  return new LibrarianArchiveService(options);
}
