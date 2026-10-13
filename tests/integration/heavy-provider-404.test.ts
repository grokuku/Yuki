/**
 * Intégration — DÉLÉGATION face à un FOURNISSEUR qui refuse (404).
 *
 * ⚠️ POURQUOI CE TEST EXISTE : en usage réel, une délégation a échoué avec un
 * `404` « service introuvable » renvoyé par le fournisseur du modèle lourd. Le
 * rapport de job portait alors la cause BRUTE (`404: {"message":"service
 * introuvable",...}`), ce qui poussait le léger à INVENTER « le worker lourd
 * n'est pas disponible » et à reprendre le travail lui-même.
 *
 * ⚠️ CE TEST EXERCE LE CODE RÉEL ET LE VRAI TRANSPORT : le VRAI worker lourd SDK
 * (`createSdkHeavyWorker`) et le VRAI service de délégation parlent à un
 * FOURNISSEUR SIMULÉ local (HTTP compatible OpenAI), sans réseau externe. On
 * vérifie (1) qu'un refus 404 est traduit en cause FRANÇAISE actionnable et
 * fidèle dans le rapport, et (2) qu'une délégation RÉUSSIT de bout en bout
 * (job terminé + résultat rapporté au léger).
 */

import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDelegationService } from "../../src/delegation/index.js";
import { JobQueue, JobStore } from "../../src/jobs/index.js";
import type { JobRecord } from "../../src/jobs/types.js";
import type { ModelsConfig } from "../../src/llm/models.js";
import { createLogger } from "../../src/observability/logger.js";
import { resolvePiPaths, writeModelsFile } from "../../src/pi/config.js";
import { createSdkHeavyWorker } from "../../src/pi/index.js";

/** Corps EXACT renvoyé par le fournisseur simulé sur un modèle inconnu. */
const PROVIDER_404_BODY = { message: "service introuvable", type: "not_found" };

interface FakeProvider {
  url: string;
  close(): Promise<void>;
}

/**
 * Fournisseur OpenAI-compatible minimal :
 *  - modèle dont le nom contient « broken » → 404 JSON (« service introuvable ») ;
 *  - tout autre modèle → flux SSE d'une réponse courte.
 */
async function startFakeProvider(): Promise<FakeProvider> {
  const server: Server = createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.includes("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      let model = "";
      try {
        model = String((JSON.parse(body) as { model?: unknown }).model ?? "");
      } catch {
        model = "";
      }
      if (model.includes("broken")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: PROVIDER_404_BODY }));
        return;
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const chunk = (delta: Record<string, unknown>, finish: string | null) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      res.write(chunk({ role: "assistant", content: "" }, null));
      res.write(chunk({ content: "Inventaire terminé." }, null));
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

function modelsFor(url: string): ModelsConfig {
  const model = (id: string) => ({
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    contextWindow: 8_192,
    maxTokens: 2_048,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  return {
    providers: {
      "llm-heavy": {
        name: "LLM lourd (test)",
        baseUrl: url,
        api: "openai-completions",
        apiKey: "$YUKI_LLM_HEAVY_API_KEY",
        compat: { supportsDeveloperRole: false },
        models: [model("heavy-ok"), model("heavy-broken")],
      },
    },
  };
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });

interface Harness {
  service: ReturnType<typeof createDelegationService>;
  store: JobStore;
  reports: Array<{ sessionId: string; text: string }>;
  close(): Promise<void>;
}

async function makeHarness(modelId: string): Promise<Harness> {
  const provider = await startFakeProvider();
  const root = mkdtempSync(join(tmpdir(), "yuki-heavy-404-"));
  tempDirs.push(root);
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  const home = join(root, "home");
  const paths = resolvePiPaths({
    agentDir,
    cwd,
    home,
    sessionsDir: join(agentDir, "sessions"),
    settingsSeedPath: "config/pi/settings.json",
  });
  writeModelsFile(paths, modelsFor(provider.url), logger);
  process.env["YUKI_LLM_HEAVY_API_KEY"] = "test-key";

  const heavy = createSdkHeavyWorker({
    cwd: paths.cwd,
    agentDir: paths.agentDir,
    authPath: join(paths.agentDir, "auth.json"),
    modelsPath: paths.modelsPath,
    systemPrompt: "Tu es un worker lourd de test.",
    modelReference: `llm-heavy/${modelId}`,
    thinking: "off",
    tools: [],
    idleTimeoutMs: 30_000,
    totalTimeoutMs: 30_000,
    logger,
  });
  const store = JobStore.open({ path: join(root, "jobs.jsonl"), logger });
  const reports: Harness["reports"] = [];
  const service = createDelegationService({
    store,
    queue: new JobQueue({ maxConcurrent: 3, maxQueue: 10 }),
    heavy,
    availability: { isAvailable: () => true },
    logger,
    idleTimeoutMs: 30_000,
    totalTimeoutMs: 30_000,
    resultBatchWindowMs: 0,
  });
  service.setWaker({
    send: (sessionId, text) => {
      reports.push({ sessionId, text });
      return { runId: "run-report-1" };
    },
  });
  return {
    service,
    store,
    reports,
    async close() {
      await provider.close();
      delete process.env["YUKI_LLM_HEAVY_API_KEY"];
    },
  };
}

/** Attend qu'un job devienne terminal (source de vérité : le JobStore). */
async function waitTerminal(
  store: JobStore,
  jobId: string,
  timeoutMs = 20_000,
): Promise<JobRecord> {
  const started = Date.now();
  for (;;) {
    const record = store.get(jobId);
    if (
      record &&
      (record.status === "completed" ||
        record.status === "failed" ||
        record.status === "cancelled" ||
        record.status === "interrupted")
    ) {
      return record;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`job ${jobId} non terminal dans les temps`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("intégration — délégation réelle face à un fournisseur (404 vs OK)", () => {
  it("un 404 du fournisseur produit une cause FRANÇAISE fidèle (jamais la cause brute/inventée)", async () => {
    const h = await makeHarness("heavy-broken");
    try {
      const outcome = await h.service.delegate({
        task: "Inventaire de dépôt.",
        lightSessionId: "sess-1",
      });
      expect(outcome.status).toBe("dispatched");
      if (outcome.status !== "dispatched") throw new Error("ticket attendu");

      const record = await waitTerminal(h.store, outcome.job_id);
      expect(record.status).toBe("failed");

      const message = record.error?.message ?? "";
      // Cause TRADUITE : le fournisseur ne connaît pas le modèle/l'endpoint.
      expect(message).toContain("ne reconnaît pas le modèle ou l'endpoint");
      expect(message).toContain("404");
      // Ni la cause BRUTE illisible, ni une cause INVENTÉE.
      expect(message).not.toContain("not_found");
      expect(message).not.toContain("introuvable");
      expect(message).not.toContain("indisponible");

      // Le RAPPORT livré au léger PORTE cette cause exacte (il pourra la citer).
      h.service.flushPendingReports();
      expect(h.reports).toHaveLength(1);
      const report = h.reports[0]?.text ?? "";
      expect(report).toContain("statut: failed");
      expect(report).toContain("ne reconnaît pas le modèle ou l'endpoint");
      expect(report).not.toContain("not_found");
    } finally {
      await h.close();
    }
  });

  it("une délégation RÉUSSIT de bout en bout et le résultat est rapporté", async () => {
    const h = await makeHarness("heavy-ok");
    try {
      const outcome = await h.service.delegate({
        task: "Inventaire de dépôt.",
        lightSessionId: "sess-1",
      });
      expect(outcome.status).toBe("dispatched");
      if (outcome.status !== "dispatched") throw new Error("ticket attendu");

      const record = await waitTerminal(h.store, outcome.job_id);
      expect(record.status).toBe("completed");
      expect(record.result.text ?? "").toContain("Inventaire terminé.");

      h.service.flushPendingReports();
      expect(h.reports).toHaveLength(1);
      const report = h.reports[0]?.text ?? "";
      expect(report).toContain("statut: completed");
      expect(report).toContain("Inventaire terminé.");
    } finally {
      await h.close();
    }
  });
});
