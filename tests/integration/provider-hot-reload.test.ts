/**
 * Intégration — CHANGEMENT DE FOURNISSEUR À CHAUD (`llm.*.baseUrl`) — VRAI SDK.
 *
 * On exerce le VRAI `createSdkPiHost` (SDK Pi réel) contre DEUX fournisseurs
 * OpenAI-compatibles simulés (HTTP local), A puis B, chacun comptant ses
 * requêtes et l'en-tête `Authorization` reçu :
 *   - changer `baseUrl` sans redémarrer re-cible le PROCHAIN run vers B (le
 *     runtime de modèles PARTAGÉ est rafraîchi EN PLACE, puis la session est
 *     re-ciblée) ;
 *   - un run EN VOL garde son fournisseur d'origine (bascule ENTRE les runs) ;
 *   - changer la CLÉ API sans redémarrer envoie la NOUVELLE clé au run suivant ;
 *   - AUCUN secret ne fuit dans les journaux.
 */

import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createPiHost } from "../../src/pi/host.js";
import {
  buildModelsConfigFrom,
  type EffectiveLlmConfig,
} from "../../src/llm/models.js";
import type { PiEvent, PiLogger } from "../../src/pi/types.js";

interface FakeProvider {
  readonly url: string;
  readonly requests: number;
  readonly auths: string[];
  /** Retient la réponse (le run reste EN VOL) jusqu'à `release()`. */
  hold(on: boolean): void;
  release(): void;
  close(): Promise<void>;
}

/** Fournisseur OpenAI-compatible minimal qui répond par `label`. */
async function startFakeProvider(label: string): Promise<FakeProvider> {
  const state = {
    requests: 0,
    hold: false,
    auths: [] as string[],
    releases: [] as Array<() => void>,
  };
  const server: Server = createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.includes("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    state.requests += 1;
    state.auths.push(req.headers.authorization ?? "");
    req.on("data", () => {
      /* consomme le corps */
    });
    req.on("end", () => {
      const respond = (): void => {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const chunk = (delta: Record<string, unknown>, finish: string | null) =>
          `data: ${JSON.stringify({
            id: `chatcmpl-${label}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: "test-model",
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`;
        res.write(chunk({ role: "assistant", content: "" }, null));
        res.write(chunk({ content: label }, null));
        res.write(
          `data: ${JSON.stringify({
            id: `chatcmpl-${label}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: "test-model",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
          })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
      };
      if (state.hold) state.releases.push(respond);
      else respond();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    get requests() {
      return state.requests;
    },
    get auths() {
      return state.auths;
    },
    hold(on: boolean) {
      state.hold = on;
    },
    release() {
      state.releases.splice(0).forEach((fn) => fn());
    },
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

function effective(baseUrl: string): EffectiveLlmConfig {
  const role = {
    api: "openai-completions",
    baseUrl,
    model: "test-model",
    thinking: "off" as const,
  };
  return { light: role, heavy: role };
}

const temps: string[] = [];
const providers: FakeProvider[] = [];

afterEach(async () => {
  for (const provider of providers.splice(0)) await provider.close();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env["YUKI_LLM_LIGHT_API_KEY"];
  delete process.env["YUKI_LLM_HEAVY_API_KEY"];
});

function waitForFinish(events: PiEvent[], runId: string, timeoutMs = 15_000) {
  return new Promise<Extract<PiEvent, { type: "run_finished" }>>(
    (resolve, reject) => {
      const started = Date.now();
      const tick = (): void => {
        const found = events.find(
          (event): event is Extract<PiEvent, { type: "run_finished" }> =>
            event.type === "run_finished" && event.runId === runId,
        );
        if (found) return resolve(found);
        if (Date.now() - started > timeoutMs) {
          return reject(new Error(`run_finished(${runId}) non reçu`));
        }
        setTimeout(tick, 25);
      };
      tick();
    },
  );
}

async function waitForCondition(
  fn: () => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const started = Date.now();
  while (!fn()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition non atteinte");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function makeHarness(baseUrl: string): Promise<{
  host: ReturnType<typeof createPiHost>;
  sessionId: string;
  events: PiEvent[];
  contents: string[];
  lines: Array<Record<string, unknown>>;
}> {
  const root = mkdtempSync(join(tmpdir(), "yuki-provider-hot-"));
  temps.push(root);
  const agentDir = join(root, "agent");
  const events: PiEvent[] = [];
  const contents: string[] = [];
  const lines: Array<Record<string, unknown>> = [];
  const logger: PiLogger = {
    debug: () => {},
    info: (msg, fields) => lines.push({ level: "info", msg, ...(fields ?? {}) }),
    warn: (msg, fields) => lines.push({ level: "warn", msg, ...(fields ?? {}) }),
    error: (msg, fields) => lines.push({ level: "error", msg, ...(fields ?? {}) }),
  };
  process.env["YUKI_LLM_LIGHT_API_KEY"] = "sk-light-secret-0000";
  process.env["YUKI_LLM_HEAVY_API_KEY"] = "sk-heavy-secret-0000";
  const host = createPiHost({
    agentDir,
    cwd: join(root, "workspace"),
    home: join(root, "home"),
    sessionsDir: join(agentDir, "sessions"),
    systemPrompt: readFileSync("config/pi/system-prompt.md", "utf8"),
    settingsSeedPath: "config/pi/settings.json",
    modelsConfig: buildModelsConfigFrom(effective(baseUrl)),
    model: "llm-light/test-model",
    thinking: "off",
    llmAvailable: true,
    logger,
  });
  host.subscribeAll((event) => {
    events.push(event);
    if (event.type === "delta" && event.channel === "content") {
      contents.push(event.text);
    }
  });
  await host.start();
  const sessionId = host.currentSessionId();
  if (!sessionId) throw new Error("session initiale absente");
  return { host, sessionId, events, contents, lines };
}

describe("intégration — changement de fournisseur à chaud (VRAI SDK)", () => {
  it("baseUrl : la requête SUIVANTE part vers le NOUVEAU fournisseur, sans redémarrage", async () => {
    const providerA = await startFakeProvider("REPONSE-A");
    const providerB = await startFakeProvider("REPONSE-B");
    providers.push(providerA, providerB);

    const h = await makeHarness(providerA.url);
    try {
      // 1er run : part vers A (aucune bascule encore).
      h.contents.length = 0;
      const first = h.host.send(h.sessionId, "bonjour");
      await waitForFinish(h.events, first.runId);
      expect(providerA.requests).toBe(1);
      expect(providerB.requests).toBe(0);
      expect(h.contents.join("")).toContain("REPONSE-A");

      // Bascule À CHAUD vers B : comme le ferait l'abonnement `config.subscribe`
      // de `src/index.ts` (même `applyLlmConfig`, aucun second chemin).
      expect(h.host.applyLlmConfig).toBeTypeOf("function");
      await h.host.applyLlmConfig!({
        modelsConfig: buildModelsConfigFrom(effective(providerB.url)),
        conversationModel: "llm-light/test-model",
        conversationThinking: "off",
      });

      // 2e run : part vers B, SANS redémarrage ; A n'est plus sollicité.
      h.contents.length = 0;
      const second = h.host.send(h.sessionId, "et maintenant ?");
      const finish = await waitForFinish(h.events, second.runId);
      expect(finish.reason).toBe("done");
      expect(providerB.requests).toBe(1);
      expect(providerA.requests).toBe(1);
      expect(h.contents.join("")).toContain("REPONSE-B");

      // Le runtime rafraîchi + la session re-ciblée sont journalisés.
      expect(h.lines.some((l) => l["msg"] === "pi.model.reloaded")).toBe(true);
      expect(h.lines.some((l) => l["msg"] === "pi.model.switched")).toBe(true);
    } finally {
      await h.host.stop();
    }
  });

  it("un run EN VOL garde son fournisseur d'origine (bascule ENTRE les runs)", async () => {
    const providerA = await startFakeProvider("REPONSE-A");
    const providerB = await startFakeProvider("REPONSE-B");
    providers.push(providerA, providerB);

    const h = await makeHarness(providerA.url);
    try {
      // A retient sa réponse : le run reste EN VOL.
      providerA.hold(true);
      h.contents.length = 0;
      const first = h.host.send(h.sessionId, "un");
      await waitForCondition(() => providerA.requests === 1);
      expect(providerB.requests).toBe(0);

      // Changement de fournisseur PENDANT le run.
      await h.host.applyLlmConfig!({
        modelsConfig: buildModelsConfigFrom(effective(providerB.url)),
        conversationModel: "llm-light/test-model",
        conversationThinking: "off",
      });

      // Le run EN VOL n'est PAS cassé : il se termine avec le fournisseur A.
      providerA.release();
      const finish = await waitForFinish(h.events, first.runId);
      expect(finish.reason).toBe("done");
      expect(h.contents.join("")).toContain("REPONSE-A");
      expect(providerA.requests).toBe(1);
      expect(providerB.requests).toBe(0);

      // Run suivant : la bascule a eu lieu ENTRE les deux runs.
      providerA.hold(false);
      h.contents.length = 0;
      const second = h.host.send(h.sessionId, "deux");
      await waitForFinish(h.events, second.runId);
      expect(providerB.requests).toBe(1);
      expect(h.contents.join("")).toContain("REPONSE-B");
    } finally {
      await h.host.stop();
    }
  });

  it("clé API : la requête suivante envoie la NOUVELLE clé, sans redémarrage ni fuite", async () => {
    const providerA = await startFakeProvider("REPONSE-A");
    providers.push(providerA);

    const h = await makeHarness(providerA.url);
    try {
      const first = h.host.send(h.sessionId, "un");
      await waitForFinish(h.events, first.runId);
      expect(providerA.auths.at(-1)).toBe("Bearer sk-light-secret-0000");

      // Nouvelle clé saisie à chaud : le pont `bridgeSecrets` met à jour
      // `process.env` ; le SDK résout la clé À CHAQUE requête.
      process.env["YUKI_LLM_LIGHT_API_KEY"] = "sk-light-secret-9999";

      const second = h.host.send(h.sessionId, "deux");
      await waitForFinish(h.events, second.runId);
      expect(providerA.auths.at(-1)).toBe("Bearer sk-light-secret-9999");

      // AUCUNE fuite : ni l'ancienne ni la nouvelle clé n'apparaît dans les logs.
      const joined = JSON.stringify(h.lines);
      expect(joined).not.toContain("sk-light-secret-0000");
      expect(joined).not.toContain("sk-light-secret-9999");
    } finally {
      await h.host.stop();
    }
  });
});
