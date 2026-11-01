/**
 * Intégration — LE CORPS HTTP NE GROSSIT PAS AVEC LE NOMBRE D'IMAGES VUES.
 *
 * ⚠️ LE INCIDENT MESURÉ (2026-11-01) que ce fichier verrouille : l'utilisateur
 * obtenait `500 « request entity too large »` sur TOUS les modèles alors que le
 * contexte TEXTE était minuscule (« redescendu à 23 k » après compactage). Cause :
 * le SDK renvoie à CHAQUE requête TOUT l'historique de la session
 * (`core/agent-loop.js` : `transformContext(messages)` puis un seul appel modèle),
 * donc chaque bloc `{type:"image"}` déjà vu repart dans le corps HTTP de chaque
 * tour suivant. La compaction n'y change rien : elle ne compte une image que pour
 * `ESTIMATED_IMAGE_CHARS = 4800` caractères (~1 200 jetons) et CONSERVE les
 * messages récents tels quels, blocs image compris.
 *
 * ⚠️ CE TEST MESURE LE CORPS HTTP RÉEL : le VRAI `createSdkPiHost` (SDK Pi réel)
 * parle à un fournisseur SIMULÉ local, qui enregistre la taille de CHAQUE corps
 * reçu. Aucune approximation (`JSON.stringify` interne), aucune doublure du
 * transport.
 *
 * ⚠️ La VISION reste ACTIVE et c'est vérifié : la requête du tour qui PORTE
 * l'image contient bien l'image ; ce sont les tours SUIVANTS qui ne la portent
 * plus (elle y est remplacée par un texte explicite).
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
import type { PiEvent, PiLogger } from "../../src/pi/types.js";

/**
 * Poids TRANSMIS d'une image de test (base64). 800 000 octets ≈ une capture
 * d'écran réduite à la borne `files.imageMaxWireBytes` (défaut 700 000).
 */
const IMAGE_BASE64 = Buffer.alloc(600_000, 0x41).toString("base64");
const IMAGE_BYTES = IMAGE_BASE64.length;

/** Plafond d'une REQUÊTE (réglage `files.imageRequestBudgetBytes`, défaut). */
const REQUEST_BUDGET_BYTES = 1_500_000;

interface FakeProvider {
  url: string;
  close(): Promise<void>;
  /** Taille du corps de CHAQUE requête reçue, dans l'ordre. */
  bodies: number[];
}

/** Fournisseur OpenAI-compatible minimal : il enregistre le corps, puis répond. */
async function startFakeProvider(): Promise<FakeProvider> {
  const bodies: number[] = [];
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
      bodies.push(body.length);
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
      res.write(chunk({ content: "Vu." }, null));
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
    bodies,
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

const logger: PiLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Attend qu'un événement `run_finished` du runId arrive. */
function waitForFinish(
  events: PiEvent[],
  runId: string,
  timeoutMs = 20_000,
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

interface Harness {
  send(text: string, images?: readonly { data: string; mimeType: string }[]): Promise<void>;
  bodies: number[];
}

/**
 * Ouvre un host RÉEL sur un fournisseur simulé et rend une fonction `send`
 * qui attend la fin de chaque run. `budget` est le plafond d'images PAR REQUÊTE
 * (omis ⇒ pas de borne, c'est-à-dire le comportement d'AVANT le correctif).
 */
async function withHost(
  options: { budget?: number | undefined },
  run: (harness: Harness) => Promise<void>,
): Promise<void> {
  const provider = await startFakeProvider();
  const root = mkdtempSync(join(tmpdir(), "yuki-image-budget-"));
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
      vision: true,
    },
    heavy: {
      api: providerSpec.api,
      baseUrl: provider.url,
      model: "test-model",
      thinking: "off",
      vision: true,
    },
  };
  process.env["YUKI_LLM_LIGHT_API_KEY"] = "test-key";

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
    ...(options.budget !== undefined
      ? { imageRequestBudgetBytes: () => options.budget as number }
      : {}),
    logger,
  });

  try {
    host.subscribeAll((event) => events.push(event));
    await host.start();
    const sessionId = host.currentSessionId();
    expect(sessionId).toEqual(expect.any(String));

    await run({
      bodies: provider.bodies,
      async send(text, images) {
        const handle = host.send(
          sessionId as string,
          text,
          images === undefined ? undefined : { images },
        );
        const finish = await waitForFinish(events, handle.runId);
        expect(finish.reason).toBe("done");
      },
    });
  } finally {
    await host.stop();
    await provider.close();
    delete process.env["YUKI_LLM_LIGHT_API_KEY"];
  }
}

const IMAGE = { data: IMAGE_BASE64, mimeType: "image/jpeg" };

describe("intégration — une image vue ne repart pas dans chaque requête", () => {
  it("la requête qui PORTE l'image la contient, la SUIVANTE ne la contient plus", async () => {
    await withHost({ budget: REQUEST_BUDGET_BYTES }, async (harness) => {
      // Tour 1 : l'image est jointe ⇒ elle DOIT partir (la vision reste active).
      await harness.send("regarde cette image", [IMAGE]);
      // Tour 2 : simple message texte.
      await harness.send("et maintenant ?");

      expect(harness.bodies).toHaveLength(2);
      const [first, second] = harness.bodies as [number, number];
      // La vision fonctionne : le corps du tour 1 porte bien l'image.
      expect(first).toBeGreaterThan(IMAGE_BYTES);
      // ⚠️ LE CŒUR DU CORRECTIF : le tour 2 ne re-transmet PAS l'image déjà vue.
      // Sur l'origine, `second` ≈ `first` (l'historique entier est re-sérialisé).
      expect(second).toBeLessThan(IMAGE_BYTES / 2);
      expect(second).toBeLessThan(first);
    });
  });

  it("trois images vues : le corps ne croît pas et reste sous le plafond", async () => {
    await withHost({ budget: REQUEST_BUDGET_BYTES }, async (harness) => {
      await harness.send("image A", [IMAGE]);
      await harness.send("image B", [IMAGE]);
      await harness.send("image C", [IMAGE]);
      await harness.send("et maintenant ?");

      expect(harness.bodies).toHaveLength(4);
      const corpus = Math.max(...harness.bodies);
      // Sur l'origine : 3 images accumulées ≈ 2,4 Mo de base64 dans le 4e corps
      // (c'est exactement le `500 request entity too large` rapporté).
      expect(corpus).toBeLessThan(REQUEST_BUDGET_BYTES + 200_000);
      // Et il ne croît plus : le dernier tour n'est pas plus gros que le premier.
      const last = harness.bodies[3] as number;
      expect(last).toBeLessThanOrEqual(harness.bodies[0] as number);
    });
  });
});
