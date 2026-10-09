/**
 * Archivage du libraire en TÂCHE DE FOND — preuves des deux exigences NON
 * négociables.
 *
 * 1. L'outil rend la main IMMÉDIATEMENT : `schedule()` retourne AVANT que le
 *    moindre appel réseau n'ait été émis (aucune attente, jamais).
 * 2. L'issue est VISIBLE : un succès COMME un échec réveille la conversation via
 *    le canal de report des jobs (`buildReportPrompt`, origine `job_report`).
 *
 * Plus : vérification des doublons, idempotence, et AUCUN secret dans les logs.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LibrarianArchiveService } from "../../src/librarian/archive.js";
import { LibrarianClient } from "../../src/librarian/client.js";
import { LibrarianError } from "../../src/librarian/errors.js";
import type { LightWaker } from "../../src/delegation/ports.js";
import type {
  LibrarianArchivePayload,
  LibrarianPort,
  LibrarianSynthesizer,
} from "../../src/librarian/types.js";
import { JobStore } from "../../src/jobs/store.js";
import { createLibrarianTools } from "../../src/pi/sdk/librarian-tools.js";
import { createLogger } from "../../src/observability/logger.js";
import { startMockLibrarian, type MockLibrarian } from "./mock-librarian.js";

const tempDirs: string[] = [];
const servers: MockLibrarian[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-librarian-"));
  tempDirs.push(dir);
  return dir;
}

function silentLogger(lines: string[] = []) {
  return createLogger({
    level: "debug",
    sink: (line) => lines.push(line),
    secretValues: [],
  });
}

interface StubClient extends LibrarianPort {
  libraryCalls: number;
  archiveCalls: LibrarianArchivePayload[];
}

function stubClient(options: {
  library?: () => Promise<{ library: Array<{ name: string; version: string }> }>;
  archive?: (payload: LibrarianArchivePayload) => Promise<void>;
} = {}): StubClient {
  const archiveCalls: LibrarianArchivePayload[] = [];
  const client: StubClient = {
    libraryCalls: 0,
    archiveCalls,
    status: async () => ({}),
    search: async () => ({ results: [] }),
    library: async () => {
      client.libraryCalls += 1;
      return options.library ? options.library() : { library: [] };
    },
    doc: async () => ({ raw: {} }),
    archive: async (payload) => {
      archiveCalls.push(payload);
      if (options.archive) await options.archive(payload);
      return { name: payload.name, version: payload.version, status: 201 };
    },
  };
  return client;
}

const VALID_SYNTHESIS = JSON.stringify({
  summary: "Un résumé.",
  keyPoints: ["k1", "k2"],
  api: [{ signature: "sig", description: "desc" }, "signature-seule"],
  examples: [{ title: "ex1", code: "code1" }],
  breakingChanges: ["casse A"],
});

function buildService(
  client: LibrarianPort,
  overrides: {
    synthesizer?: LibrarianSynthesizer;
    waker?: LightWaker;
    lines?: string[];
  } = {},
): { service: LibrarianArchiveService; store: JobStore } {
  const store = JobStore.open({ path: join(tempDir(), "jobs.jsonl"), logger: silentLogger() });
  const service = new LibrarianArchiveService({
    store,
    client,
    synthesizer: overrides.synthesizer ?? (async () => VALID_SYNTHESIS),
    logger: silentLogger(overrides.lines),
    ...(overrides.waker ? { waker: overrides.waker } : {}),
  });
  return { service, store };
}

const INPUT = {
  name: "react",
  version: "18",
  type: "lib",
  material: "React est une bibliothèque d'interface.",
};

describe("libraire — archivage en tâche de fond", () => {
  it("rend la main IMMÉDIATEMENT : retourne AVANT tout appel réseau", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let libraryCalled = false;
    const client = stubClient({
      library: async () => {
        libraryCalled = true;
        await gate;
        return { library: [] };
      },
    });
    const { service } = buildService(client);

    const outcome = service.schedule(INPUT, { lightSessionId: "s1" });
    // ⚠️ PREUVE : au retour de `schedule`, AUCUN appel réseau n'a été émis.
    expect(outcome).toMatchObject({ status: "launched" });
    expect(libraryCalled).toBe(false);
    expect(service.pendingCount()).toBe(1);

    release();
    const settled = await service.settled((outcome as { job_id: string }).job_id);
    expect(settled?.status).toBe("completed");
    expect(libraryCalled).toBe(true);
  });

  it("issue VISIBLE en cas de SUCCÈS : réveille la conversation (origine job_report)", async () => {
    const calls: Array<{ sessionId: string; text: string; origin?: string; jobId?: string }> = [];
    const client = stubClient();
    const { service } = buildService(client, {
      waker: {
        send: (sessionId, text, opts) => {
          calls.push({ sessionId, text, ...(opts?.origin ? { origin: opts.origin } : {}), ...(opts?.jobId ? { jobId: opts.jobId } : {}) });
          return { runId: "r1" };
        },
      },
    });
    const outcome = service.schedule(INPUT, { lightSessionId: "conv-1" });
    const record = await service.settled((outcome as { job_id: string }).job_id);
    expect(record?.status).toBe("completed");
    expect(client.archiveCalls).toHaveLength(1);
    expect(client.archiveCalls[0]).toMatchObject({
      name: "react",
      version: "18",
      type: "lib",
      content: {
        summary: "Un résumé.",
        keyPoints: ["k1", "k2"],
        api: [{ signature: "sig", description: "desc" }, { signature: "signature-seule" }],
        examples: [{ title: "ex1", code: "code1" }],
        breakingChanges: ["casse A"],
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sessionId).toBe("conv-1");
    expect(calls[0]?.origin).toBe("job_report");
    expect(calls[0]?.text).toContain("[RÉSULTAT DE TÂCHE EN ARRIÈRE-PLAN]");
    expect(calls[0]?.text).toContain("Archive enregistrée");
  });

  it("issue VISIBLE en cas d'ÉCHEC : un archivage raté n'est jamais silencieux", async () => {
    const calls: Array<{ text: string }> = [];
    const client = stubClient({
      archive: async () => {
        throw new LibrarianError("web_unavailable");
      },
    });
    const { service } = buildService(client, {
      waker: { send: (_s, text) => { calls.push({ text }); return {}; } },
    });
    const outcome = service.schedule(INPUT, { lightSessionId: "conv-2" });
    const record = await service.settled((outcome as { job_id: string }).job_id);
    expect(record?.status).toBe("failed");
    expect(record?.error?.message).toContain("moteurs de recherche web");
    // Le report EST émis, avec le statut d'échec : l'utilisateur sera prévenu.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("statut: failed");
    expect(calls[0]?.text).toContain("moteurs de recherche web");
  });

  it("synthèse inexploitable → échec VISIBLE, RIEN n'est archivé", async () => {
    const calls: Array<{ text: string }> = [];
    const client = stubClient();
    const { service } = buildService(client, {
      synthesizer: async () => "désolé je ne peux pas",
      waker: { send: (_s, text) => { calls.push({ text }); return {}; } },
    });
    const outcome = service.schedule(INPUT, { lightSessionId: "conv-3" });
    const record = await service.settled((outcome as { job_id: string }).job_id);
    expect(record?.status).toBe("failed");
    expect(client.archiveCalls).toHaveLength(0);
    expect(record?.error?.message).toContain("synthèse");
    expect(calls[0]?.text).toContain("statut: failed");
  });

  it("vérifie les DOUBLONS via /library : rien n'est archivé si le couple (nom, version) existe déjà", async () => {
    const client = stubClient({
      library: async () => ({ library: [{ name: "react", version: "18" }] }),
    });
    const { service } = buildService(client);
    const outcome = service.schedule(INPUT, { lightSessionId: "s" });
    const record = await service.settled((outcome as { job_id: string }).job_id);
    expect(record?.status).toBe("completed");
    expect(record?.result.text).toContain("DÉJÀ");
    expect(client.archiveCalls).toHaveLength(0);
    expect(client.libraryCalls).toBe(1);
  });

  it("archive une AUTRE version du même nom (les versions cohabitent légitimement)", async () => {
    const client = stubClient({
      library: async () => ({ library: [{ name: "react", version: "17" }] }),
    });
    const { service } = buildService(client);
    const outcome = service.schedule(INPUT, { lightSessionId: "s" });
    const record = await service.settled((outcome as { job_id: string }).job_id);
    expect(record?.status).toBe("completed");
    expect(client.archiveCalls).toHaveLength(1);
    expect(client.archiveCalls[0]).toMatchObject({ name: "react", version: "18" });
  });

  it("idempotence : un second appel pendant le vol ne crée PAS un second job", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = stubClient({
      library: async () => {
        await gate;
        return { library: [] };
      },
    });
    const { service, store } = buildService(client);

    const first = service.schedule(INPUT, { lightSessionId: "s" });
    const second = service.schedule(INPUT, { lightSessionId: "s" });
    expect(first.status).toBe("launched");
    expect(second).toMatchObject({
      status: "already_pending",
      job_id: (first as { job_id: string }).job_id,
    });
    expect(store.list()).toHaveLength(1);

    release();
    await service.settled((first as { job_id: string }).job_id);
  });

  it("aucun secret dans les logs, même quand l'appel échoue (401)", async () => {
    const mock = await startMockLibrarian(() => ({ status: 401, body: {} }));
    servers.push(mock);
    const token = "jeton-SECRET-abcdefgh";
    const key = "lib-SECRET-0123456789";
    const lines: string[] = [];
    const client = new LibrarianClient({
      config: () => ({ baseUrl: mock.baseUrl, agentToken: token, apiKey: key }),
      logger: silentLogger(lines),
    });
    const { service } = buildService(client, { lines });
    const outcome = service.schedule(INPUT, { lightSessionId: "s" });
    const record = await service.settled((outcome as { job_id: string }).job_id);
    expect(record?.status).toBe("failed");
    expect(record?.error?.message).toContain("clé libraire");
    const logs = lines.join("\n");
    expect(logs).not.toContain(token);
    expect(logs).not.toContain(key);
  });

  it("l'OUTIL archive_libraire rend la main sans attendre le réseau (client bloqué)", async () => {
    // Le client ne résout JAMAIS : si l'outil attendait le réseau, il ne
    // terminerait pas. L'appel rend pourtant la main immédiatement.
    const client = stubClient({
      library: () => new Promise(() => undefined),
    });
    const { service } = buildService(client);
    const tools = createLibrarianTools({ client, archive: service });
    const tool = tools.find((entry) => entry.name === "archive_libraire");
    if (!tool) throw new Error("outil archive_libraire introuvable");

    const fn = tool.execute as unknown as (
      id: string,
      params: unknown,
      signal: undefined,
      onUpdate: undefined,
      ctx: unknown,
    ) => Promise<{ content: Array<{ type: string; text?: string }>; details: unknown }>;
    const result = await fn(
      "call",
      { name: "a", version: "1", contenu: "matière" },
      undefined,
      undefined,
      { sessionManager: { getSessionId: () => "conv-1" } },
    );
    const text = result.content.map((part) => part.text ?? "").join("\n");
    expect(JSON.parse(text)).toMatchObject({ status: "launched" });
    expect(text).toContain("PAS encore terminé");
    // Le job est bien parti en fond (non attendu, non terminé).
    expect(service.pendingCount()).toBe(1);
    expect(client.libraryCalls).toBe(1);
    expect(client.archiveCalls).toEqual([]);
  });
});
