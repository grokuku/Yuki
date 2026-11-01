/**
 * Intégration — le CONTEXTE de `delegate` et les PIÈCES JOINTES arrivent au worker.
 *
 * ⚠️ POURQUOI CE TEST EXISTE : `delegate(task, context?)` était un CANAL MORT.
 * Le contexte était stocké (`delegation/service.ts:280`), recopié dans la requête
 * du worker (`:676`, `ports.ts:31`)… puis JAMAIS lu : le premier prompt du
 * sous-agent n'était que `composeFirstPrompt(request.task, steers)`. Et rien ne
 * transmettait les pièces jointes : le worker ne pouvait donc pas connaître
 * l'identifiant qu'exige `deposer_fichier`.
 *
 * ⚠️ CE TEST EXERCE LE CODE RÉEL ET LE VRAI TRANSPORT : le VRAI worker lourd SDK
 * (`createSdkHeavyWorker`), le VRAI service de délégation et le VRAI service des
 * fichiers, face à un FOURNISSEUR SIMULÉ local (HTTP compatible OpenAI) qui
 * CAPTURE le corps de la requête. On lit donc le prompt tel que le modèle l'a
 * reçu — pas une reconstruction.
 */

import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDelegationService } from "../../src/delegation/index.js";
import { DELEGATION_CONTEXT_HEADER, MAX_DELEGATION_CONTEXT_CHARS } from "../../src/delegation/steer.js";
import { createFilesService } from "../../src/files/index.js";
import { FilesStore } from "../../src/files/store.js";
import { JobQueue, JobStore } from "../../src/jobs/index.js";
import type { JobRecord } from "../../src/jobs/types.js";
import type { ModelsConfig } from "../../src/llm/models.js";
import { createLogger } from "../../src/observability/logger.js";
import { resolvePiPaths, writeModelsFile } from "../../src/pi/config.js";
import { createSdkHeavyWorker } from "../../src/pi/index.js";

/** Fournisseur OpenAI-compatible minimal qui CAPTURE les corps de requête. */
interface FakeProvider {
  url: string;
  bodies: string[];
  close(): Promise<void>;
}

async function startFakeProvider(): Promise<FakeProvider> {
  const bodies: string[] = [];
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
      bodies.push(body);
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
          model: "heavy-ok",
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      res.write(chunk({ role: "assistant", content: "" }, null));
      res.write(chunk({ content: "Fichier déposé." }, null));
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "heavy-ok",
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
    bodies,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

function modelsFor(url: string): ModelsConfig {
  return {
    providers: {
      "llm-heavy": {
        name: "LLM lourd (test)",
        baseUrl: url,
        api: "openai-completions",
        apiKey: "$YUKI_LLM_HEAVY_API_KEY",
        compat: { supportsDeveloperRole: false },
        models: [
          {
            id: "heavy-ok",
            name: "heavy-ok",
            reasoning: false,
            input: ["text"],
            contextWindow: 8_192,
            maxTokens: 2_048,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
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

const SESSION = "conv-utilisateur-42";

interface Harness {
  provider: FakeProvider;
  service: ReturnType<typeof createDelegationService>;
  store: JobStore;
  files: ReturnType<typeof createFilesService>;
  close(): Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const provider = await startFakeProvider();
  const root = mkdtempSync(join(tmpdir(), "yuki-heavy-context-"));
  tempDirs.push(root);
  const paths = resolvePiPaths({
    agentDir: join(root, "agent"),
    cwd: join(root, "workspace"),
    home: join(root, "home"),
    sessionsDir: join(root, "agent", "sessions"),
    settingsSeedPath: "config/pi/settings.json",
  });
  writeModelsFile(paths, modelsFor(provider.url), logger);
  process.env["YUKI_LLM_HEAVY_API_KEY"] = "test-key";

  const filesStore = new FilesStore({ dir: join(root, "fichiers"), maxBytes: () => 1_000_000 });
  filesStore.ensureLayout();
  const files = createFilesService({ store: filesStore });

  const heavy = createSdkHeavyWorker({
    cwd: paths.cwd,
    agentDir: paths.agentDir,
    authPath: join(paths.agentDir, "auth.json"),
    modelsPath: paths.modelsPath,
    systemPrompt: "Tu es un worker lourd de test.",
    modelReference: "llm-heavy/heavy-ok",
    thinking: "off",
    tools: ["read", "ls", "grep", "find", "lister_fichiers"],
    files,
    idleTimeoutMs: 30_000,
    totalTimeoutMs: 30_000,
    logger,
  });
  const store = JobStore.open({ path: join(root, "jobs.jsonl"), logger });
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
  service.setWaker({ send: () => ({ runId: "run-report-1" }) });

  return {
    provider,
    service,
    store,
    files,
    async close() {
      await provider.close();
      delete process.env["YUKI_LLM_HEAVY_API_KEY"];
    },
  };
}

async function waitTerminal(store: JobStore, jobId: string, timeoutMs = 20_000): Promise<JobRecord> {
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
    if (Date.now() - started > timeoutMs) throw new Error(`job ${jobId} non terminal dans les temps`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Texte complet du corps de requête envoyé au modèle (échappements résolus). */
function promptBody(provider: FakeProvider): string {
  return provider.bodies.map((body) => body.replace(/\\n/g, "\n")).join("\n---\n");
}

describe("intégration — contexte et pièces jointes du worker lourd", () => {
  it("le CONTEXTE de `delegate` est dans le premier prompt du worker", async () => {
    const harness = await makeHarness();
    try {
      const outcome = await harness.service.delegate({
        task: "Inventaire du dépôt.",
        context: "Le dépôt est monté sur /workspace et l'utilisateur attend un CSV.",
        lightSessionId: SESSION,
      });
      expect(outcome.status).toBe("dispatched");
      if (outcome.status !== "dispatched") throw new Error("ticket attendu");
      const record = await waitTerminal(harness.store, outcome.job_id);
      expect(record.status).toBe("completed");

      const body = promptBody(harness.provider);
      expect(body).toContain("Inventaire du dépôt.");
      expect(body).toContain(DELEGATION_CONTEXT_HEADER.replace(/'/g, "'"));
      expect(body).toContain("Le dépôt est monté sur /workspace");
      // Cadre honnête : le contexte n'est PAS la consigne.
      expect(body).toContain("ce n'est PAS la consigne");
    } finally {
      await harness.close();
    }
  });

  it("les PIÈCES JOINTES sont jointes AUTOMATIQUEMENT, avec leur IDENTIFIANT (jamais le contenu)", async () => {
    const harness = await makeHarness();
    try {
      const saved = harness.files.saveUpload(
        (async function* () {
          yield new Uint8Array(Buffer.from("CONTENU-SECRET-DU-FICHIER"));
        })(),
        { name: "capture.png", mimeType: "image/png", origin: "user", sessionId: SESSION },
      );
      const uploaded = await saved;
      if (!uploaded.ok) throw new Error("dépôt impossible dans le test");

      const outcome = await harness.service.delegate({
        task: "Dépose la capture sur nuc00:/tmp/capture.png",
        lightSessionId: SESSION,
      });
      expect(outcome.status).toBe("dispatched");
      if (outcome.status !== "dispatched") throw new Error("ticket attendu");
      const record = await waitTerminal(harness.store, outcome.job_id);
      expect(record.status).toBe("completed");

      const body = promptBody(harness.provider);
      // L'identifiant est LÀ : c'est exactement ce qu'exige `deposer_fichier`.
      expect(body).toContain(uploaded.file.id);
      expect(body).toContain("capture.png");
      // Métadonnées seules : le CONTENU du fichier n'est jamais transmis.
      expect(body).not.toContain("CONTENU-SECRET-DU-FICHIER");
    } finally {
      await harness.close();
    }
  });

  it("un contexte au-delà du plafond est REFUSÉ AVANT tout appel au modèle", async () => {
    const harness = await makeHarness();
    try {
      const outcome = await harness.service.delegate({
        task: "Inventaire du dépôt.",
        context: "x".repeat(MAX_DELEGATION_CONTEXT_CHARS + 1),
        lightSessionId: SESSION,
      });
      expect(outcome.status).toBe("dispatched");
      if (outcome.status !== "dispatched") throw new Error("ticket attendu");
      const record = await waitTerminal(harness.store, outcome.job_id);
      expect(record.status).toBe("failed");
      const message = record.error?.message ?? "";
      expect(message).toContain("REFUSÉ");
      expect(message).toContain(String(MAX_DELEGATION_CONTEXT_CHARS));
      // Refus = RIEN n'a été exécuté : le fournisseur n'a reçu aucune requête.
      expect(harness.provider.bodies).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });
});
