import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AuditLog,
  maxSizeBytesFromMb,
  type AuditLogOptions,
} from "../../src/agents/index.js";

const tempDirs: string[] = [];

function tempAuditPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-audit-"));
  tempDirs.push(dir);
  return join(dir, "audit.jsonl");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function open(path: string, overrides: Partial<AuditLogOptions> = {}): AuditLog {
  return AuditLog.open({
    path,
    maxSizeBytes: 1_000_000,
    retentionDays: 30,
    secretValues: [],
    ...overrides,
  });
}

function linesOf(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("AuditLog — écriture", () => {
  it("écrit une ligne JSON par entrée (commande + machine + horodatage + code)", () => {
    const path = tempAuditPath();
    const log = open(path, { now: () => Date.parse("2026-10-07T12:00:00.000Z") });
    log.append({ event: "command", agentId: "agent-1", command: "uname -a", exitCode: 0 });
    const lines = linesOf(path);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      ts: "2026-10-07T12:00:00.000Z",
      event: "command",
      agent_id: "agent-1",
      command: "uname -a",
      exit_code: 0,
    });
  });

  it("journalise une connexion (sans commande)", () => {
    const path = tempAuditPath();
    const log = open(path);
    const rec = log.append({ event: "connection", agentId: "agent-2", meta: { peer: "10.0.0.2" } });
    expect(rec.event).toBe("connection");
    expect(linesOf(path)[0].command).toBeUndefined();
  });
});

describe("AuditLog — redaction effective", () => {
  it("masque une valeur secrète présente dans la commande", () => {
    const path = tempAuditPath();
    const log = open(path, { secretValues: ["SUPER-SECRET-TOKEN"] });
    log.append({
      event: "command",
      agentId: "agent-1",
      command: "curl -H 'Authorization: SUPER-SECRET-TOKEN' http://x",
      exitCode: 1,
    });
    const line = linesOf(path)[0];
    expect(line.command).toBe("curl -H 'Authorization: [REDACTED]' http://x");
    expect(JSON.stringify(line)).not.toContain("SUPER-SECRET-TOKEN");
  });

  it("masque une valeur sous une clé ressemblant à un secret", () => {
    const path = tempAuditPath();
    const log = open(path);
    log.append({
      event: "command",
      agentId: "agent-1",
      command: "true",
      meta: { apiKey: "abc123" },
    });
    const meta = linesOf(path)[0].meta as Record<string, unknown>;
    expect(meta.apiKey).toBe("[REDACTED]");
  });
});

describe("AuditLog — jamais la sortie complète", () => {
  it("retire stdout/stderr/output/result des métadonnées", () => {
    const path = tempAuditPath();
    const log = open(path);
    log.append({
      event: "command",
      agentId: "agent-1",
      command: "cat secret.txt",
      exitCode: 0,
      meta: {
        stdout: "contenu complet de la sortie",
        stderr: "erreurs",
        output: "x",
        result: "y",
        durationMs: 12,
      },
    });
    const meta = linesOf(path)[0].meta as Record<string, unknown>;
    expect(meta.stdout).toBeUndefined();
    expect(meta.stderr).toBeUndefined();
    expect(meta.output).toBeUndefined();
    expect(meta.result).toBeUndefined();
    expect(meta.durationMs).toBe(12);
    expect(JSON.stringify(linesOf(path)[0])).not.toContain("contenu complet de la sortie");
  });
});

describe("AuditLog — rotation par taille", () => {
  it("archive le fichier dès qu'il dépasse le seuil", () => {
    const path = tempAuditPath();
    const log = open(path, { maxSizeBytes: 160 });
    for (let i = 0; i < 6; i++) {
      log.append({
        event: "command",
        agentId: `agent-${i}`,
        command: `echo ligne-${i}-avec-un-peu-de-texte-pour-peser`,
        exitCode: 0,
      });
    }
    const archives = log.archives();
    expect(archives.length).toBeGreaterThanOrEqual(1);
    // Aucune entrée perdue : le total (actif + archives) vaut 6.
    const total =
      linesOf(path).length + archives.reduce((sum, file) => sum + linesOf(file).length, 0);
    expect(total).toBe(6);
    // Le fichier actif est reparti sous le seuil.
    expect(log.sizeBytes).toBeLessThan(160);
  });
});

describe("AuditLog — purge par rétention", () => {
  it("supprime les archives plus vieilles que retentionDays", () => {
    const path = tempAuditPath();
    let now = Date.now();
    const log = open(path, { maxSizeBytes: 120, retentionDays: 30, now: () => now });
    for (let i = 0; i < 6; i++) {
      log.append({ event: "command", agentId: `agent-${i}`, command: `echo ${i}-texte`, exitCode: 0 });
    }
    expect(log.archives().length).toBeGreaterThanOrEqual(1);

    // 31 jours plus tard : les archives dépassent la rétention.
    now += 31 * 86_400_000;
    const removed = log.purge();
    expect(removed.length).toBeGreaterThanOrEqual(1);
    expect(log.archives()).toHaveLength(0);
  });

  it("conservation : rien n'est purgé avant la rétention", () => {
    const path = tempAuditPath();
    const log = open(path, { maxSizeBytes: 120, retentionDays: 30 });
    for (let i = 0; i < 4; i++) {
      log.append({ event: "command", agentId: `agent-${i}`, command: `echo ${i}`, exitCode: 0 });
    }
    expect(log.purge()).toHaveLength(0);
  });
});

describe("maxSizeBytesFromMb", () => {
  it("convertit les Mo du schéma en octets", () => {
    expect(maxSizeBytesFromMb(16)).toBe(16 * 1024 * 1024);
    expect(maxSizeBytesFromMb(0)).toBe(1024 * 1024);
  });
});
