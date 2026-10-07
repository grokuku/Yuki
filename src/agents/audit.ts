/**
 * Journal d'audit des exécutions (Lot 4, décision D127).
 *
 * Écrit un fichier JSONL : **commande + machine + horodatage + code de sortie**.
 * ⚠️ **JAMAIS la sortie complète** d'une commande (elle peut contenir des
 * secrets lus par la commande, cf. `docs/lot4.md` §6-vi) : les clés
 * `stdout`/`stderr`/`output`/`result` sont retirées, et la redaction existante
 * (`src/observability/logger.ts`) masque les valeurs secrètes.
 *
 * Rétention : `retentionDays` (purge des archives). Rotation par TAILLE :
 * l'archive est renommée `<path>.<horodatage>` dès que le fichier actif dépasse
 * `maxSizeBytes`.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { collectSecretValues, redactObject } from "../observability/logger.js";

export interface AuditLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** Entrée d'audit (vue appelante, camelCase). */
export interface AuditEntry {
  /** Nature : `command` (exécution) ou `connection` (connexion d'agent). */
  event: string;
  /** Machine concernée (= identifiant d'agent). */
  agentId: string;
  /** Commande exécutée (si applicable). */
  command?: string;
  /** Code de sortie du processus (si applicable). */
  exitCode?: number | null;
  /** Métadonnées libres (jamais la sortie complète). */
  meta?: Record<string, unknown>;
  /** Horodatage explicite (ISO) ; sinon l'instant courant. */
  ts?: string;
}

export interface AuditLogOptions {
  path: string;
  /** Seuil de rotation (octets). */
  maxSizeBytes: number;
  /** Rétention des archives (jours). */
  retentionDays: number;
  /** Valeurs à masquer (défaut : déduites de `process.env`). */
  secretValues?: string[];
  now?: () => number;
  logger?: AuditLogger;
}

/** Convertit un plafond en Mo (schéma `audit.maxSizeMb`) en octets. */
export function maxSizeBytesFromMb(mb: number): number {
  return Math.max(1, Math.trunc(mb)) * 1_024 * 1_024;
}

/** Clés dont la valeur ne doit JAMAIS être journalisée (sortie de commande). */
const FORBIDDEN_KEYS = /^(stdout|stderr|output|result|sortie)$/i;

const DAY_MS = 86_400_000;

/** Retire récursivement les champs de sortie de commande. */
function stripOutput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripOutput);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.test(key)) continue;
      out[key] = stripOutput(item);
    }
    return out;
  }
  return value;
}

function compactStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:.]/g, "").replace("Z", "Z");
}

export class AuditLog {
  private readonly path: string;
  private readonly maxSizeBytes: number;
  private readonly retentionDays: number;
  private readonly secretValues: string[];
  private readonly now: () => number;
  private readonly logger?: AuditLogger;

  private constructor(options: AuditLogOptions) {
    this.path = options.path;
    this.maxSizeBytes = Math.max(1, Math.trunc(options.maxSizeBytes));
    this.retentionDays = Math.max(0, Math.trunc(options.retentionDays));
    this.secretValues = options.secretValues ?? collectSecretValues();
    this.now = options.now ?? Date.now;
    this.logger = options.logger;
  }

  /** Ouvre le journal (crée le dossier) et purge les archives périmées. */
  static open(options: AuditLogOptions): AuditLog {
    const log = new AuditLog(options);
    try {
      mkdirSync(dirname(log.path), { recursive: true });
    } catch (error) {
      log.logger?.error("audit.open.failed", {
        path: log.path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    log.purge();
    return log;
  }

  get filePath(): string {
    return this.path;
  }

  get sizeBytes(): number {
    return existsSync(this.path) ? statSync(this.path).size : 0;
  }

  /** Ajoute une entrée (redigée, sans sortie de commande) au journal. */
  append(entry: AuditEntry): Record<string, unknown> {
    const record = this.sanitize(entry);
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, "utf8");
    if (this.sizeBytes >= this.maxSizeBytes) {
      this.rotate();
    }
    return record;
  }

  /** Construit l'enregistrement sûr : sortie retirée, secrets masqués. */
  private sanitize(entry: AuditEntry): Record<string, unknown> {
    const base: Record<string, unknown> = {
      ts: entry.ts ?? new Date(this.now()).toISOString(),
      event: entry.event,
      agent_id: entry.agentId,
    };
    if (entry.command !== undefined) base.command = entry.command;
    if (entry.exitCode !== undefined) base.exit_code = entry.exitCode;
    if (entry.meta !== undefined) base.meta = stripOutput(entry.meta);
    return redactObject(base, this.secretValues);
  }

  /** Archives présentes (chemins), triées. */
  archives(): string[] {
    return this.listArchives().sort();
  }

  private listArchives(): string[] {
    const dir = dirname(this.path);
    if (!existsSync(dir)) return [];
    const prefix = `${basename(this.path)}.`;
    return readdirSync(dir)
      .filter((name) => name.startsWith(prefix))
      .map((name) => join(dir, name));
  }

  /** Renomme le fichier actif en archive, puis purge. */
  rotate(): string | undefined {
    if (!existsSync(this.path)) return undefined;
    let archive = `${this.path}.${compactStamp(this.now())}`;
    let counter = 1;
    while (existsSync(archive)) {
      archive = `${this.path}.${compactStamp(this.now())}.${counter}`;
      counter += 1;
    }
    renameSync(this.path, archive);
    this.purge();
    return archive;
  }

  /** Supprime les archives plus vieilles que la rétention. Renvoie les chemins. */
  purge(): string[] {
    if (this.retentionDays <= 0) return [];
    const cutoff = this.now() - this.retentionDays * DAY_MS;
    const removed: string[] = [];
    for (const archive of this.listArchives()) {
      try {
        if (statSync(archive).mtimeMs < cutoff) {
          unlinkSync(archive);
          removed.push(archive);
        }
      } catch (error) {
        this.logger?.warn("audit.purge.failed", {
          path: archive,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return removed;
  }
}
