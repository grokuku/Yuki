/**
 * Harnais E2E JETABLE — IMAGE GÉNÉRÉE par ComfyUI, affichée DANS la conversation.
 *
 * Chaîne COMPLÈTE et RÉELLE (aucun double dans le chemin) :
 *   faux serveur ComfyUI (vrai `node:http`, sur un port libre)
 *     → `ComfyClient` (POST /prompt, GET /history/{id}, GET /view)
 *     → `createComfyGenerator` (choix du workflow, injection des étiquettes)
 *     → `GeneratedImagesStore` (disque, identifiant aléatoire)
 *     → route same-origin `/images/<id>.<ext>`
 *     → trame de contrôle WS `image`
 *     → `<img>` dans le fil, sous la CSP RÉELLE.
 *
 * Endpoints JETABLES (hors application) :
 *   - `POST /e2e/generate?scene=…&style=…` : lance une VRAIE génération (le
 *     workflow a été importé juste avant par la route réelle
 *     `POST /api/images/workflows`), puis émet la vue vers la conversation.
 *   - `GET  /e2e/tool?scene=…&style=…` : passe par l'OUTIL `generer_image`
 *     (`src/pi/sdk/image-tools.ts`) — donc par le MÊME chemin que le modèle — et
 *     renvoie le TEXTE reçu par le modèle + les détails (preuve que le prompt
 *     final lui est bien transmis, encadré comme DONNÉE).
 *   - `GET  /e2e/last-prompt` : le JSON RÉELLEMENT POSTÉ à `/prompt` (preuve que
 *     le style n'y est pas).
 *   - `GET  /e2e/fail` : arme un échec serveur (500) pour la prochaine génération.
 *
 * ⚠️ Ne produit AUCUNE capture PNG suivie : le dossier du E2E est temporaire.
 *
 * Usage : cd Yuki && npx tsx "../Yuki and Libs/_tools/e2e-image-serve.ts"
 * Env : `YUKI_E2E_IMAGE_DIR` dossier d'état (OBLIGATOIRE).
 * Sortie : « READY http://127.0.0.1:<port> » puis reste vivant.
 */

import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import {
  ComfyClient,
  ComfyWorkflowStore,
  GeneratedImagesStore,
  createComfyGenerator,
  type ComfyImageFinalPromptView,
  type ComfyImageView,
  type ImagesGatewayPort,
} from "../../src/comfy/index.js";
import { createConfigRuntime } from "../../src/config/runtime.js";
import { loadEnv } from "../../src/config/env.js";
import { createApp, type AppContext } from "../../src/gateway/app.js";
import { createWsTransport } from "../../src/gateway/ws/server.js";
import { createLogger } from "../../src/observability/logger.js";
import { createPiHost } from "../../src/pi/host.js";
import { createImageTools } from "../../src/pi/sdk/image-tools.js";
import type { GpuReport } from "../../src/types/gpu.js";

const stateDir = process.env.YUKI_E2E_IMAGE_DIR;
if (!stateDir) throw new Error("YUKI_E2E_IMAGE_DIR requis");
const agentDir = join(stateDir, "agent");
const cwd = join(stateDir, "workspace");
const sessionsDir = join(agentDir, "sessions");
const imagesDir = join(stateDir, "comfy", "images");
for (const dir of [agentDir, cwd, sessionsDir, imagesDir]) mkdirSync(dir, { recursive: true });

/* ─── PNG réel 64×64 (construit à la main : aucune dépendance) ──────────── */
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** PNG 64×64, damier sobre (l'image est VRAIMENT décodable par le navigateur). */
function buildPng(size = 64): Buffer {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 3 + 1);
    raw[row] = 0; // filtre « none »
    for (let x = 0; x < size; x += 1) {
      const shade = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0 ? 0x2b : 0xd8;
      raw[row + 1 + x * 3] = shade;
      raw[row + 2 + x * 3] = shade;
      raw[row + 3 + x * 3] = shade;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // profondeur 8 bits
  ihdr[9] = 2; // RVB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const PNG = buildPng();

/* ─── Faux serveur ComfyUI (API RÉELLE, vérifiée sur son code source) ───── */
const fake = {
  /** JSON RÉELLEMENT POSTÉ sur `/prompt` (preuve pour le E2E). */
  lastPrompt: "",
  /** Graphe reçu, par `prompt_id` : sert à publier les bonnes sorties. */
  graphs: new Map<string, Record<string, unknown>>(),
  /** Dernière image RÉELLEMENT demandée sur `/view` (preuve de l'image retenue). */
  lastView: null as { filename: string; type: string; subfolder: string } | null,
  /** Historique servi pour un prompt déjà terminé. */
  served: new Set<string>(),
  /** Prochaine soumission en échec (500) ? */
  fail: false,
  /**
   * Vrai ⇒ ComfyUI a PURGÉ son répertoire temporaire : `/history` et `/view`
   * répondent 404. Sert à prouver que l'image affichée est bien la COPIE de Yuki
   * (elle survit à la purge du serveur d'images).
   */
  purged: false,
  url: "",
};

/**
 * Nœuds d'AFFICHAGE de texte : ils publient `{"ui": {"text": [<texte>]}}` dans
 * l'historique (forme vérifiée dans le code source : `PreviewAny` et `SaveText`
 * du cœur, `ShowText`/`AIHToText` en extension).
 */
const DISPLAY_NODES = new Set(["PreviewAny", "SaveText", "ShowText", "AIHToText"]);

/**
 * Prompt final publié par les nœuds d'affichage : il DIFFÈRE de la scène (c'est
 * le travail de l'enhancer) et contient VOLONTAIREMENT une charge d'injection :
 * le bloc de la conversation doit l'afficher comme du TEXTE, jamais l'interpréter.
 */
const FINAL_PROMPT_TEXT =
  "Un phare isolé battu par les vagues au crépuscule, lumière rasante, embruns, focale 35 mm. " +
  "<img src=x onerror=\"window.__pwned=1\"><b>gras</b>";

/**
 * Sorties publiées pour un graphe, comme ComfyUI le fait : UNIQUEMENT pour les
 * nœuds qui écrivent une image (`SaveImage` → `output`, `PreviewImage` → `temp`, cf.
 * `nodes.py` : `PreviewImage(SaveImage)` réutilise `save_images`) et pour les
 * nœuds d'AFFICHAGE de texte (`ui.text`).
 */
function outputsOf(graph: Record<string, unknown>): Record<string, unknown> {
  const outputs: Record<string, unknown> = {};
  for (const [nodeId, raw] of Object.entries(graph)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const classType = (raw as Record<string, unknown>).class_type;
    if (classType === "SaveImage" || classType === "PreviewImage") {
      outputs[nodeId] = {
        images: [
          {
            filename: `Yuki_${nodeId}_00001_.png`,
            subfolder: "",
            type: classType === "PreviewImage" ? "temp" : "output",
          },
        ],
      };
      continue;
    }
    // ⚠️ `ui.text` est un TABLEAU (tuple/liste) chez tous les nœuds d'affichage.
    if (typeof classType === "string" && DISPLAY_NODES.has(classType)) {
      outputs[nodeId] = { text: [FINAL_PROMPT_TEXT], mode: ["Plain"] };
    }
  }
  return Object.keys(outputs).length > 0
    ? outputs
    : { "9": { images: [{ filename: "Yuki_00001_.png", subfolder: "", type: "output" }] } };
}

const comfyServer = createHttpServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/prompt" && req.method === "POST") {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      fake.lastPrompt = Buffer.concat(chunks).toString("utf8");
      // Une nouvelle soumission signifie que le serveur retravaille : la purge
      // simulée du temporaire est terminée (elle ne concerne que le PASSÉ).
      fake.purged = false;
      if (fake.fail) {
        fake.fail = false;
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "internal", message: "panne simulée du serveur" } }));
        return;
      }
      try {
        const parsed = JSON.parse(fake.lastPrompt) as { prompt?: Record<string, unknown> };
        fake.graphs.set("e2e-prompt", parsed.prompt ?? {});
      } catch {
        fake.graphs.set("e2e-prompt", {});
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ prompt_id: "e2e-prompt", number: 1, node_errors: {} }));
    });
    return;
  }
  if (url.pathname.startsWith("/history/")) {
    if (fake.purged) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "history purgé" }));
      return;
    }
    const id = decodeURIComponent(url.pathname.slice("/history/".length));
    res.writeHead(200, { "content-type": "application/json" });
    // Le prompt est « terminé » dès la PREMIÈRE lecture (aucune attente de 10 s).
    res.end(
      JSON.stringify({
        [id]: {
          prompt: [1, id, {}, {}, []],
          outputs: outputsOf(fake.graphs.get(id) ?? {}),
          status: { status_str: "success", completed: true, messages: [] },
        },
      }),
    );
    return;
  }
  if (url.pathname === "/view") {
    if (fake.purged) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("purged");
      return;
    }
    fake.lastView = {
      filename: url.searchParams.get("filename") ?? "",
      type: url.searchParams.get("type") ?? "",
      subfolder: url.searchParams.get("subfolder") ?? "",
    };
    res.writeHead(200, { "content-type": "image/png" });
    res.end(PNG);
    return;
  }
  if (url.pathname === "/system_stats") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ system: { comfyui_version: "0.3.40-e2e" }, devices: [{ name: "cuda:0" }] }));
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});
await new Promise<void>((resolve) => comfyServer.listen(0, "127.0.0.1", resolve));
fake.url = `http://127.0.0.1:${(comfyServer.address() as AddressInfo).port}`;

/* ─── Configuration + briques du domaine (les VRAIES) ───────────────────── */
const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
const env = loadEnv({
  YUKI_GPU_FIXTURE: "tests/fixtures/gpu/rtx4070-12g.txt",
  YUKI_LOG_LEVEL: "error",
  // ⚠️ Le serveur d'images est le FAUX serveur ci-dessus (même processus).
  YUKI_IMAGES_BASE_URL: fake.url,
  YUKI_COMFY_IMAGES_DIR: imagesDir,
  YUKI_COMFY_WORKFLOWS_PATH: join(stateDir, "comfy", "workflows.json"),
});
const config = createConfigRuntime({
  env,
  // ⚠️ Les surcharges d'ENVIRONNEMENT sont lues depuis `processEnv` : c'est LUI
  // qui porte l'URL du faux serveur ComfyUI (`YUKI_IMAGES_BASE_URL`).
  processEnv: { ...process.env, YUKI_IMAGES_BASE_URL: fake.url },
  promptDefaults: { light: "# Yuki\n\nAssistant de test E2E.\n", heavy: "# Yuki lourd\n" },
});

const workflows = new ComfyWorkflowStore({ path: env.comfyWorkflowsPath, logger });
const images = new GeneratedImagesStore({ dir: env.comfyImagesDir, logger });
images.ensureLayout();
const client = new ComfyClient({
  config: () => ({
    baseUrl: config.getString("images.baseUrl"),
    apiKey: config.getString("images.apiKey"),
  }),
  logger,
  pollIntervalMs: 50,
  generationTimeoutMs: () => 30_000,
});
const generator = createComfyGenerator({
  client,
  workflows,
  images,
  sizes: () => ({
    width: config.getNumber("images.width"),
    height: config.getNumber("images.height"),
  }),
  logger,
});

/* ─── Hôte Pi RÉEL hors ligne + transport WS ───────────────────────────── */
const host = createPiHost({
  agentDir,
  cwd,
  home: join(stateDir, "home"),
  sessionsDir,
  systemPrompt: "# Yuki\n\nAssistant de test E2E.\n",
  settingsSeedPath: "config/pi/settings.json",
  logger,
});
await host.start();
const sessionId = host.currentSessionId();
if (!sessionId) throw new Error("aucune session courante");

/**
 * Port d'images du harnais : diffusion en direct (trames de contrôle) ET
 * RESTAURATION depuis le store disque — c'est la même mécanique que le câblage
 * réel (`src/index.ts`), donc le rechargement de la page prouve la conservation.
 */
class StubImagesPort implements ImagesGatewayPort {
  private readonly listeners = new Set<(view: ComfyImageView) => void>();
  private readonly ficheListeners = new Set<(view: ComfyImageFinalPromptView) => void>();

  subscribeImages(listener: (view: ComfyImageView) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeImageFinalPrompts(listener: (view: ComfyImageFinalPromptView) => void): () => void {
    this.ficheListeners.add(listener);
    return () => {
      this.ficheListeners.delete(listener);
    };
  }

  imagesForSession(sessionId: string): ComfyImageView[] {
    return images.list({ sessionId }).map((record) => images.toView(record));
  }

  emit(view: ComfyImageView): void {
    for (const listener of [...this.listeners]) listener(view);
  }

  emitFiche(view: ComfyImageFinalPromptView): void {
    for (const listener of [...this.ficheListeners]) listener(view);
  }
}
const imagePort = new StubImagesPort();

/**
 * Délai (ms) avant l'émission de la FICHE de la prochaine génération : il permet
 * de MESURER, dans le navigateur, que l'image ne bouge pas quand la fiche arrive
 * (elle est insérée SOUS elle). ⚠️ L'ORDRE reste celui du code réel : image
 * d'abord, fiche ensuite.
 */
let ficheDelayMs = 0;

// ⚠️ L'OUTIL RÉEL du modèle (`generer_image`) : le E2E passe par LUI pour
// prouver ce que le MODÈLE reçoit (prompt final encadré comme DONNÉE, borné).
const [generateImageTool] = createImageTools({
  generate: (input) => generator.generate(input),
  onImage: (view) => {
    // Rattachement AVANT diffusion, comme le câblage réel : c'est ce qui rend
    // l'image RESTAURABLE après rechargement.
    if (view.sessionId) images.attach(view.id, view.sessionId);
    imagePort.emit(view);
  },
  onImageFinalPrompt: (fiche) => {
    // Persistée avec l'image, exactement comme `src/index.ts` le fait.
    images.attachFinalPrompt(fiche.id, fiche.finalPrompt);
    const delay = ficheDelayMs;
    if (delay <= 0) {
      imagePort.emitFiche(fiche);
      return;
    }
    setTimeout(() => imagePort.emitFiche(fiche), delay);
  },
});
if (!generateImageTool) throw new Error("outil generer_image introuvable");

const transport = createWsTransport({
  host,
  logger,
  serverVersion: "e2e-0.1.0",
  replayBufferSize: 1000,
  replayBufferBytes: 1_000_000,
  images: imagePort,
});

const context: AppContext = {
  env,
  report: {} as GpuReport,
  gatePassed: true,
  startedAt: Date.now(),
  volumes: [],
  publicDir: "public/ui",
  // API de configuration : indispensable pour que la page `/config` monte ses
  // panneaux (dont celui des IMAGES) au lieu d'afficher son bandeau d'erreur.
  config: { runtime: config, logger },
  images: {
    workflows,
    images,
    clientFor: (override) =>
      new ComfyClient({
        config: () => ({
          baseUrl: override.baseUrl ?? config.getString("images.baseUrl"),
          apiKey: override.apiKey ?? config.getString("images.apiKey"),
        }),
        logger,
        requestTimeoutMs: 5_000,
      }),
    logger,
  },
};

const app = createApp(context);
const server = createHttpServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  // Endpoint JETABLE : VRAIE génération, puis émission de la vue vers le fil.
  if (url.pathname === "/e2e/generate") {
    const scene = url.searchParams.get("scene") ?? "une scène";
    const style = url.searchParams.get("style") ?? undefined;
    void generator
      .generate({
        scene,
        ...(style ? { style } : {}),
      })
      .then((image) => {
        images.attach(image.record.id, sessionId);
        imagePort.emit({
          id: image.record.id,
          imageSrc: image.record.imageSrc,
          mimeType: image.record.mimeType,
          bytes: image.record.bytes,
          createdAt: image.record.createdAt,
          promptId: image.promptId,
          ...(image.record.width !== undefined ? { width: image.record.width } : {}),
          ...(image.record.height !== undefined ? { height: image.record.height } : {}),
          sessionId,
        });
        if (image.finalPrompt?.status === "found") {
          // Persistée AVEC l'image (comme `onImageFinalPrompt` du câblage réel) :
          // la fiche revient donc après un rechargement.
          images.attachFinalPrompt(image.record.id, image.finalPrompt.prompt);
          imagePort.emitFiche({
            id: image.record.id,
            finalPrompt: image.finalPrompt.prompt,
            sessionId,
          });
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            workflow: image.workflowName,
            imageSrc: image.record.imageSrc,
            bytes: image.record.bytes,
          }),
        );
      })
      .catch((error: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      });
    return;
  }
  if (url.pathname === "/e2e/tool") {
    // MÊME chemin que le MODÈLE : l'outil réel, avec un contexte de session.
    const scene = url.searchParams.get("scene") ?? "une scène";
    const style = url.searchParams.get("style");
    ficheDelayMs = Math.max(0, Number(url.searchParams.get("ficheDelayMs") ?? 0) || 0);
    const execute = generateImageTool.execute as unknown as (
      id: string,
      params: unknown,
      signal: undefined,
      onUpdate: undefined,
      ctx: unknown,
    ) => Promise<{ content: Array<{ type: string; text?: string }>; details: unknown }>;
    void execute(
      "e2e-call",
      { scene, ...(style ? { style } : {}) },
      undefined,
      undefined,
      { sessionManager: { getSessionId: () => sessionId } },
    )
      .then((result) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            text: result.content.map((part) => part.text ?? "").join("\n"),
            details: result.details,
          }),
        );
      })
      .catch((error: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ ok: false, text: "", message: error instanceof Error ? error.message : String(error) }),
        );
      });
    return;
  }
  if (url.pathname === "/e2e/purge-comfy") {
    // ComfyUI « purge » son répertoire temporaire : l'image affichée ne doit PAS
    // en dépendre (Yuki en garde une copie sur SON disque).
    fake.purged = true;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ purged: true }));
    return;
  }
  if (url.pathname === "/e2e/reset-media") {
    // Vide le stockage d'images du harnais (remise à zéro d'une série de mesures).
    let removed = 0;
    for (const record of images.list()) {
      if (images.remove(record.id)) removed += 1;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ removed }));
    return;
  }
  if (url.pathname === "/e2e/images") {
    // Ce que le STORE contient réellement (métadonnées seules, jamais les octets).
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        images: images.list({ sessionId }).map((record) => images.toView(record)),
        dir: env.comfyImagesDir,
      }),
    );
    return;
  }
  if (url.pathname === "/e2e/last-prompt") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ body: fake.lastPrompt }));
    return;
  }
  if (url.pathname === "/e2e/fail") {
    fake.fail = true;
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  if (url.pathname === "/e2e/last-view") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(fake.lastView ?? {}));
    return;
  }
  if (url.pathname === "/e2e/comfy-url") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ url: fake.url }));
    return;
  }
  app(req, res);
});
transport.attach(server);
server.listen(0, "127.0.0.1", () => {
  const address = server.address() as AddressInfo;
  console.log(`READY http://127.0.0.1:${address.port}`);
});
setInterval(() => {}, 1 << 30);
