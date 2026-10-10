/**
 * Intégration — VISIBILITÉ de l'erreur d'un run sur le VRAI hôte (`sdk-host.ts`).
 *
 * ⚠️ POURQUOI CE TEST EXISTE : un `stage=error` sans cause a rendu invisible un
 * échec réel (tous les messages suivants échouaient instantanément, l'UI
 * affichait « Une erreur est survenue. »). La cause était pourtant produite par
 * le SDK (message assistant `stopReason:"error"` porteur d'un `errorMessage`)
 * puis JETÉE : `sdk-host.ts` ne reprenait `message.errorMessage` que sur le rejet
 * de `prompt()`, jamais sur un `message_end` en erreur.
 *
 * ⚠️ CE TEST EXERCE LE CODE RÉEL ET LE VRAI TRANSPORT : le VRAI `createSdkPiHost`
 * (SDK Pi réel) parle à un FOURNISSEUR SIMULÉ local (HTTP compatible OpenAI). On
 * enchaîne un run RÉUSSI puis un SECOND prompt que le fournisseur refuse : le
 * premier ne doit PAS être en erreur, le second DOIT exposer la cause BRUTE du
 * fournisseur (jamais « Une erreur est survenue. »).
 */

import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createPiHost } from "../../src/pi/host.js";
import type { ProviderSpec } from "../../src/llm/providers.js";
import { buildModelsConfigFrom, type EffectiveLlmConfig } from "../../src/llm/models.js";
import { toServerMessage } from "../../src/gateway/ws/server.js";
import type { PiEvent, PiLogger } from "../../src/pi/types.js";

/** Cause BRUTE renvoyée par le fournisseur simulé au 2e appel. */
const PROVIDER_ERROR = "Quota épuisé pour le modèle léger (test).";

interface FakeProvider {
  url: string;
  close(): Promise<void>;
  requests: number;
}

/**
 * Fournisseur OpenAI-compatible minimal :
 *  - 1re requête → flux SSE d'une réponse courte (« Bonjour. ») ;
 *  - requêtes suivantes → 400 JSON avec un message d'erreur porteur.
 */
async function startFakeProvider(): Promise<FakeProvider> {
  const state = { requests: 0 };
  const server: Server = createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.includes("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    // Consomme le corps (sinon la socket reste bloquée).
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      state.requests += 1;
      if (state.requests > 1) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: { message: PROVIDER_ERROR, type: "rate_limit_error" },
          }),
        );
        return;
      }
      void body;
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
          model: "test-model",
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      res.write(chunk({ role: "assistant", content: "" }, null));
      res.write(chunk({ content: "Bonjour." }, null));
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "test-model",
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
    requests: 0,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function captureLogger(lines: Array<Record<string, unknown>>): PiLogger {
  const capture =
    (level: string) =>
    (message: string, fields?: Record<string, unknown>): void => {
      lines.push({ level, msg: message, ...(fields ?? {}) });
    };
  return {
    debug: capture("debug"),
    info: capture("info"),
    warn: capture("warn"),
    error: capture("error"),
  };
}

/** Attend qu'un événement `run_finished` du runId satisfasse le prédicat. */
function waitForFinish(
  events: PiEvent[],
  runId: string,
  timeoutMs = 15_000,
): Promise<Extract<PiEvent, { type: "run_finished" }>> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      const found = events.find(
        (event): event is Extract<PiEvent, { type: "run_finished" }> =>
          event.type === "run_finished" && event.runId === runId,
      );
      if (found) {
        resolve(found);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`run_finished(${runId}) non reçu dans les temps`));
        return;
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

describe("intégration — la cause d'un échec de run est VISIBLE", () => {
  it("expose le message BRUT du fournisseur quand un run échoue", async () => {
    const provider = await startFakeProvider();
    const root = mkdtempSync(join(tmpdir(), "yuki-pi-error-"));
    temps.push(root);
    const agentDir = join(root, "agent");
    const cwd = join(root, "workspace");
    const home = join(root, "home");
    const sessionsDir = join(agentDir, "sessions");

    const providerSpec: ProviderSpec = {
      id: "llm-light",
      name: "LLM léger (test)",
      baseUrl: provider.url,
      api: "openai-completions",
      keyEnv: "YUKI_LLM_LIGHT_API_KEY",
      maxConcurrentRequests: 1,
    };
    const effective: EffectiveLlmConfig = {
      light: {
        api: providerSpec.api,
        baseUrl: provider.url,
        model: "test-model",
        thinking: "off",
      },
      heavy: {
        api: providerSpec.api,
        baseUrl: provider.url,
        model: "test-model",
        thinking: "off",
      },
    };
    process.env["YUKI_LLM_LIGHT_API_KEY"] = "test-key";

    const logLines: Array<Record<string, unknown>> = [];
    const logger = captureLogger(logLines);
    const events: PiEvent[] = [];
    const host = createPiHost({
      agentDir,
      cwd,
      home,
      sessionsDir,
      systemPrompt: readFileSync("config/pi/system-prompt.md", "utf8"),
      settingsSeedPath: "config/pi/settings.json",
      modelsConfig: buildModelsConfigFrom(effective),
      model: "llm-light/test-model",
      thinking: "off",
      llmAvailable: true,
      logger,
    });

    try {
      host.subscribeAll((event) => events.push(event));
      await host.start();
      const sessionId = host.currentSessionId();
      expect(sessionId).toEqual(expect.any(String));

      // 1) Run RÉUSSI (le fournisseur répond normalement).
      const first = host.send(sessionId!, "Bonjour");
      const firstFinish = await waitForFinish(events, first.runId);
      expect(firstFinish.reason).toBe("done");

      // 2) SECOND prompt : le fournisseur refuse → l'échec DOIT porter la cause.
      const second = host.send(sessionId!, "tu as eu mon message ?");
      const secondFinish = await waitForFinish(events, second.runId);
      expect(secondFinish.reason).toBe("error");
      // L'UI reçoit un message UTILE (mappé en français), jamais « Une erreur
      // est survenue. » ni la cause brute illisible.
      expect(secondFinish.errorMessage).toBeDefined();
      expect(secondFinish.errorMessage).toContain("crédits ou quota épuisés");

      // Le TROU DE JOURNALISATION est bouché : la cause BRUTE est journalisée
      // à la fois sur la trame d'erreur dédiée ET sur `stage=error`.
      const runErrorLine = logLines.find((line) => line["msg"] === "pi.run.error");
      expect(runErrorLine).toBeDefined();
      expect(JSON.stringify(runErrorLine)).toContain("Quota épuisé");

      const errorLine = logLines.find(
        (line) => line["msg"] === "pi.phase" && line["stage"] === "error",
      );
      expect(errorLine).toBeDefined();
      expect(JSON.stringify(errorLine)).toContain("Quota épuisé");

      // Le vrai transport relaie bien la cause jusqu'à l'UI.
      const frame = toServerMessage(secondFinish);
      expect(frame.type).toBe("run_finished");
      expect(frame.type === "run_finished" && frame.errorMessage).toContain(
        "crédits ou quota épuisés",
      );
    } finally {
      await host.stop();
      await provider.close();
      delete process.env["YUKI_LLM_LIGHT_API_KEY"];
    }
  });
});
