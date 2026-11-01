/**
 * Intégration — le worker lourd reçoit une IMAGE (résultat d'outil) sans casser.
 *
 * ⚠️ POURQUOI CE TEST EXISTE (régression en usage réel, 2026-11-01) : « le lourd a
 * l'air de marcher tant qu'il ne doit pas voir d'image ». Reproduit ici AVEC une
 * image, contre un fournisseur volontairement STRICT (comme les serveurs
 * compatibles OpenAI dont le template de chat exige un tour `assistant` entre un
 * `tool` et un `user`) :
 *
 *  ① la requête qui SUIT un résultat d'outil porteur d'une image part avec la
 *     suite `tool` → `user` « Attached image(s) from tool result: » — le SDK
 *     n'écrit jamais l'image dans le message `tool`, il ajoute un message `user` ;
 *  ② sans `compat.requiresAssistantAfterToolResult` (faux par défaut côté SDK),
 *     AUCUN message `assistant` n'est intercalé ⇒ 400 « invalid message order »
 *     ⇒ le job échoue. Une requête SANS image n'a jamais de `user` après `tool` :
 *     c'est le seul écart structurel image / sans image, donc exactement le
 *     symptôme observé ;
 *  ③ avec le drapeau (`src/llm/models.ts` → `buildModelsConfigFrom`), le SDK
 *     intercale « I have processed the tool results. » et le modèle voit l'image.
 *
 * Ce test ÉCHOUE sur le code d'origine (le job reste `failed`) : le fournisseur
 * simulé refuse la suite `tool` → `user`.
 *
 * Il verrouille AUSSI la CONFORMITÉ du bloc transmis (comparé à `generer_image`,
 * dont le résultat d'outil porte exactement le même bloc) :
 *  - `{ type: "image", data, mimeType }` ⇒ `image_url.url = "data:<mime>;base64,<base64 BRUT>"` ;
 *  - `data` n'est PAS déjà une data-URL (sinon `data:image/png;base64,data:image/png;base64,…`).
 */

import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createFilesService } from "../../src/files/index.js";
import { FilesStore } from "../../src/files/store.js";
import { buildModelsConfigFrom, DEFAULT_EFFECTIVE_LLM_CONFIG } from "../../src/llm/models.js";
import { createLogger } from "../../src/observability/logger.js";
import { resolvePiPaths, writeModelsFile } from "../../src/pi/config.js";
import { createSdkHeavyWorker } from "../../src/pi/index.js";

/** PNG 1×1 valide : dimensions connues de l'analyse ⇒ chemin rapide (aucune réduction). */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF/9G0AAAAASUVORK5CYII=",
  "base64",
);

const SESSION = "conv-image-lourde";

interface CapturedMessage {
  role: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: unknown;
}

interface CapturedRequest {
  messages: CapturedMessage[];
}

interface FakeProvider {
  url: string;
  /** Corps de requête BRUTS, tels qu'envoyés par le SDK. */
  bodies: string[];
  close(): Promise<void>;
}

/**
 * Fournisseur OpenAI-compatible STRICT : refuse (400) un message `user` qui suit
 * directement un message `tool` — c'est ce que font les serveurs qui exigent un
 * tour `assistant` entre un résultat d'outil et un message utilisateur.
 */
async function startStrictProvider(fileId: string): Promise<FakeProvider> {
  const bodies: string[] = [];
  const server: Server = createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.includes("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      bodies.push(body);
      const request = JSON.parse(body) as CapturedRequest;
      const roles = request.messages.map((message) => message.role);
      for (let index = 1; index < roles.length; index += 1) {
        if (roles[index] === "user" && roles[index - 1] === "tool") {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              error: {
                message:
                  "invalid message order: a 'user' message cannot follow a 'tool' " +
                  "message without an assistant message",
                type: "invalid_request_error",
              },
            }),
          );
          return;
        }
      }

      // Première requête : le modèle DEMANDE la lecture de l'image de la session.
      const wantsTool = bodies.length === 1;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const chunk = (delta: Record<string, unknown>, finish: string | null) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-image",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "lourd-image",
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      res.write(chunk({ role: "assistant", content: "" }, null));
      if (wantsTool) {
        res.write(
          chunk(
            {
              tool_calls: [
                {
                  index: 0,
                  id: "call_image_1",
                  type: "function",
                  function: {
                    name: "lire_fichier",
                    arguments: JSON.stringify({ identifiant: fileId }),
                  },
                },
              ],
            },
            null,
          ),
        );
        res.write(chunk({}, "tool_calls"));
      } else {
        res.write(chunk({ content: "Image vue." }, null));
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-image",
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: "lourd-image",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
          })}\n\n`,
        );
      }
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

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
    delete process.env["YUKI_LLM_HEAVY_API_KEY"];
  }
});

describe("worker lourd — une IMAGE de résultat d'outil part dans une requête conforme", () => {
  it("lire_fichier sur une image : session lourde qui DÉMARRE et requête acceptée", async () => {
    const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
    const root = mkdtempSync(join(tmpdir(), "yuki-heavy-image-"));
    tempDirs.push(root);
    const paths = resolvePiPaths({
      agentDir: join(root, "agent"),
      cwd: join(root, "workspace"),
      home: join(root, "home"),
      sessionsDir: join(root, "agent", "sessions"),
      settingsSeedPath: "config/pi/settings.json",
    });

    // VRAI store + VRAI service de fichiers : l'image est rattachée à la session.
    const filesStore = new FilesStore({ dir: join(root, "fichiers"), maxBytes: () => 5_000_000 });
    filesStore.ensureLayout();
    const files = createFilesService({ store: filesStore });
    const saved = await files.saveUpload(
      (async function* () {
        yield new Uint8Array(PNG);
      })(),
      { name: "capture.png", mimeType: "image/png", origin: "user", sessionId: SESSION },
    );
    if (!saved.ok) throw new Error("dépôt de l'image impossible dans le banc de test");

    const provider = await startStrictProvider(saved.file.id);
    try {
      // ⚠️ Le `models.json` vient de la PRODUCTION (`buildModelsConfigFrom`) :
      // c'est lui qui porte `compat.requiresAssistantAfterToolResult`.
      writeModelsFile(
        paths,
        buildModelsConfigFrom({
          light: { ...DEFAULT_EFFECTIVE_LLM_CONFIG.light, baseUrl: provider.url },
          heavy: { ...DEFAULT_EFFECTIVE_LLM_CONFIG.heavy, baseUrl: provider.url },
        }),
        logger,
      );
      process.env["YUKI_LLM_HEAVY_API_KEY"] = "test-key";

      const worker = createSdkHeavyWorker({
        cwd: paths.cwd,
        agentDir: paths.agentDir,
        authPath: join(paths.agentDir, "auth.json"),
        modelsPath: paths.modelsPath,
        systemPrompt: "Tu es le worker lourd de test.",
        modelReference: `llm-heavy/${DEFAULT_EFFECTIVE_LLM_CONFIG.heavy.model}`,
        thinking: "high",
        tools: ["lister_fichiers", "lire_fichier"],
        files,
        idleTimeoutMs: 15_000,
        totalTimeoutMs: 15_000,
        logger,
      });

      const result = await worker
        .run({
          jobId: "job-image-1",
          task: "Lis l'image de la conversation et décris-la.",
          lightSessionId: SESSION,
        } as never)
        .promise;

      // ① La session lourde DÉMARRE et le fournisseur strict accepte la requête.
      expect(result.status).toBe("completed");
      if (result.status !== "completed") throw new Error(`job en échec : ${result.error}`);

      // ② La requête qui porte l'image est bien la seconde.
      expect(provider.bodies).toHaveLength(2);
      const second = JSON.parse(provider.bodies[1] ?? "{}") as CapturedRequest;
      const roles = second.messages.map((message) => message.role);

      // ③ ORDRE CONFORME : aucun `user` collé derrière un `tool` (le 400 du banc).
      for (let index = 1; index < roles.length; index += 1) {
        if (roles[index] === "user") expect(roles[index - 1]).not.toBe("tool");
      }
      const toolIndex = roles.indexOf("tool");
      expect(toolIndex).toBeGreaterThan(0);
      expect(roles[toolIndex + 1]).toBe("assistant");
      expect(roles[toolIndex + 2]).toBe("user");

      // ④ BLOC IMAGE : même forme que `generer_image` (image-tools.ts:593-596) —
      // base64 BRUT (jamais une data-URL imbriquée) et MIME d'image réel.
      const imageMessage = second.messages[toolIndex + 2];
      const blocks = imageMessage?.content as Array<Record<string, unknown>> | undefined;
      const imageBlock = blocks?.find((block) => block["type"] === "image_url");
      expect(imageBlock).toBeDefined();
      const url = (imageBlock?.["image_url"] as { url: string }).url;
      expect(url.startsWith("data:image/png;base64,")).toBe(true);
      expect(url.slice("data:image/png;base64,".length)).toBe(PNG.toString("base64"));

      // ⑤ Le message `tool`, lui, ne porte QUE du texte : l'image n'y est pas.
      const toolMessage = second.messages[toolIndex];
      expect(typeof toolMessage?.content).toBe("string");
      expect(toolMessage?.tool_call_id).toBe("call_image_1");
    } finally {
      await provider.close();
    }
  });
});
