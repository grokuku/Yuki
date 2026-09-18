import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  JobError,
  JobStore,
  type JobEvent,
} from "../../src/jobs/index.js";
import { createLogger } from "../../src/observability/logger.js";

const tempDirs: string[] = [];

function tempStorePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-jobs-"));
  tempDirs.push(dir);
  return join(dir, "jobs.jsonl");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function newStore(path: string, idFactory?: () => string): JobStore {
  return JobStore.open({
    path,
    logger: createLogger({ level: "error", sink: () => {}, secretValues: [] }),
    ...(idFactory ? { idFactory } : {}),
  });
}

const created = {
  task: "analyser X",
  deadlineMs: 1500,
  lightSessionId: "sess-1",
  origin: "user",
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("JobStore — transitions & journal", () => {
  it("applique une séquence valide et versionne le record", () => {
    const path = tempStorePath();
    const store = newStore(path);
    store.append("job-1", "created", { status: "queued", ...created });
    store.append("job-1", "queued", {});
    store.append("job-1", "started", {
      status: "running",
      startedAt: "2026-01-01T00:00:01.000Z",
      heavySessionId: "heavy-1",
    });
    store.append("job-1", "progress", { result: { partial: "en cours" } });
    store.append("job-1", "completed", {
      status: "completed",
      finishedAt: "2026-01-01T00:00:02.000Z",
      result: { text: "fini", usage: { input: 5, output: 3 } },
    });
    store.append("job-1", "notified", {
      notified: true,
      reportedAt: "2026-01-01T00:00:03.000Z",
    });

    const record = store.get("job-1");
    expect(record).toMatchObject({
      schemaVersion: 1,
      id: "job-1",
      status: "completed",
      task: "analyser X",
      deadlineMs: 1500,
      lightSessionId: "sess-1",
      heavySessionId: "heavy-1",
      notified: true,
      result: { text: "fini", partial: "en cours", usage: { input: 5, output: 3 } },
    });
    expect(store.counts()).toEqual({
      running: 0,
      queued: 0,
      completed: 1,
      failed: 0,
      interrupted: 0,
    });

    // Journal append-only : une ligne par événement.
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(6);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("rejette toute transition illégale (sans écrire)", () => {
    const path = tempStorePath();
    const store = newStore(path);
    store.append("job-1", "created", { status: "queued", ...created });
    // queued → completed est illégal (il faut passer par running).
    expect(() =>
      store.append("job-1", "completed", { status: "completed" }),
    ).toThrowError(JobError);
    // Aucune écriture n'a eu lieu pour la transition rejetée.
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);

    store.append("job-1", "started", { status: "running" });
    store.append("job-1", "completed", { status: "completed" });
    const before = readFileSync(path, "utf8");
    expect(() =>
      store.append("job-1", "started", { status: "running" }),
    ).toThrowError(JobError);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("rejette un événement pour un job inconnu", () => {
    const store = newStore(tempStorePath());
    expect(() =>
      store.append("ghost", "started", { status: "running" }),
    ).toThrowError(/inconnu/);
  });

  it("est idempotent : un eventId déjà appliqué est ignoré", () => {
    const store = newStore(tempStorePath());
    const event = store.append("job-1", "created", { status: "queued", ...created });
    expect(store.apply(event)).toBe(false);
    expect([...store.events].filter((e) => e.eventId === event.eventId)).toHaveLength(1);
  });

  it("« dernier seq gagnant » : un événement plus ancien est ignoré", () => {
    const path = tempStorePath();
    const store = newStore(path);
    store.append("job-1", "created", { status: "queued", ...created });
    store.append("job-1", "started", { status: "running" });
    // Séquence hors ordre : progress (seq 2) arrive après started (seq 3).
    const events: JobEvent[] = [
      ...store.events.slice(0, 2),
      { ...store.events[0]!, seq: 3, eventId: "late-started", kind: "started", patch: { status: "running" } },
      { ...store.events[0]!, seq: 2, eventId: "old-progress", kind: "progress", patch: { result: { partial: "vieux" } } },
    ];
    const replayed = JobStore.fromEvents(events, { path });
    expect(replayed.get("job-1")?.result.partial).toBeUndefined();
  });

  it("notified est monotone", () => {
    const store = newStore(tempStorePath());
    store.append("job-1", "created", { status: "queued", ...created });
    store.append("job-1", "started", { status: "running" });
    store.append("job-1", "completed", { status: "completed" });
    store.append("job-1", "notified", { notified: true });
    expect(store.get("job-1")?.notified).toBe(true);
    // Une tentative de remettre notified=false est sans effet.
    store.apply({
      seq: store.sequence + 1,
      ts: "2026-01-01T00:00:04.000Z",
      eventId: "reset-notified",
      jobId: "job-1",
      kind: "notified",
      patch: { notified: false },
    });
    expect(store.get("job-1")?.notified).toBe(true);
  });
});

describe("JobStore — persistance & rejeu déterministe", () => {
  it("survit à un redémarrage simulé (rejouer le journal reconstruit l'état)", () => {
    const path = tempStorePath();
    const first = newStore(path);
    first.append("job-a", "created", { status: "queued", ...created });
    first.append("job-a", "started", { status: "running" });
    first.append("job-a", "completed", {
      status: "completed",
      result: { text: "résultat A" },
    });
    first.append("job-b", "created", { status: "queued", ...created, task: "B" });
    first.append("job-b", "started", { status: "running" });
    first.append("job-b", "failed", {
      status: "failed",
      error: { message: "boum" },
    });

    const reopened = newStore(path);
    expect(reopened.size).toBe(2);
    expect(reopened.get("job-a")).toMatchObject({
      status: "completed",
      result: { text: "résultat A" },
    });
    expect(reopened.get("job-b")).toMatchObject({
      status: "failed",
      error: { message: "boum" },
    });
    expect(reopened.counts()).toEqual({
      running: 0,
      queued: 0,
      completed: 1,
      failed: 1,
      interrupted: 0,
    });

    // Rejeu déterministe : deux reconstructions donnent le même état.
    const a = JobStore.fromEvents(first.events, { path }).list();
    const b = JobStore.fromEvents(first.events, { path }).list();
    expect(a).toEqual(b);
  });
});
