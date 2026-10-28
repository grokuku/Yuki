/**
 * Harnais E2E JETABLE — ACCUSÉ DE RÉCEPTION écrit par le MODÈLE.
 *
 * Gateway RÉEL, hôte Pi SIMULÉ (`FakePiHost`, qui émet de VRAIES trames
 * `phase`/`run_summary` via `RunInstrumentation`, et qui applique la MÊME règle
 * d'accusé que la production : `ackShapedText` / `ackFallbackText` de
 * `src/pi/ack.ts`), pipeline TTS RÉEL dont le synthétiseur ENREGISTRE le texte
 * réellement prononcé.
 *
 * Cinq tours programmés :
 *   - `question`        : une question simple, aucun accusé ;
 *   - `action`          : le modèle écrit « Je m'en occupe. » PUIS appelle l'outil ;
 *   - `action_variant`  : le modèle écrit une AUTRE phrase (« Deux secondes, … ») ⇒
 *                         preuve que le texte vient du modèle, pas d'un libellé figé ;
 *   - `action_only`     : le modèle écrit l'accusé et le run s'achève (bulle = accusé seul) ;
 *   - `silent`          : le modèle va DROIT à l'outil ⇒ REPLI en dur, en ROTATION
 *                         (deux appels successifs donnent deux phrases différentes) ;
 *   - `media`           : l'accusé, puis une ACTION LONGUE (pause mesurée) pendant
 *                         laquelle le harnais crée de VRAIS médias — c'est la mesure
 *                         de l'ordre ACCUSÉ → IMAGE → CAPTURE → RÉPONSE, en direct
 *                         ET après rechargement.
 *
 * Un serveur de CONTRÔLE (hors CSP) permet de :
 *   - lancer un tour (`/send?script=…`) ;
 *   - créer un média daté (`/emit-media?kind=image|screenshot&at=<ISO>`) ;
 *   - relire les médias émis (`/media`) ;
 *   - relire la dernière synthèse `run_summary` (le TTFT RÉEL, mesuré serveur) ;
 *   - relire le texte réellement prononcé (`/spoken`).
 *
 * Usage : cd Yuki && npx tsx "../Yuki and Libs/_tools/e2e-ack-serve.ts"
 * Sortie : « READY http://127.0.0.1:<port> » puis « CONTROL http://… ».
 */

import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { deflateSync } from "node:zlib";

import type { ScreenshotGatewayPort, ScreenshotViewEvent } from "../../src/agents/execution.js";
import type { ComfyImageView, ImagesGatewayPort } from "../../src/comfy/types.js";
import { loadEnv } from "../../src/config/env.js";
import { createApp, type AppContext } from "../../src/gateway/app.js";
import { createWsTransport } from "../../src/gateway/ws/server.js";
import { createLogger } from "../../src/observability/logger.js";
import type { PiEvent } from "../../src/pi/types.js";
import type { SegmentSynthesizer, TtsPipelineDeps } from "../../src/tts/index.js";
import type { GpuReport } from "../../src/types/gpu.js";
import { FakePiHost, type FakeStep } from "../../tests/pi/host-double.js";

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
const env = loadEnv({
  YUKI_GPU_FIXTURE: "tests/fixtures/gpu/rtx4070-12g.txt",
  YUKI_LOG_LEVEL: "error",
});

/** Réponse STREAMÉE identique dans les deux tours (le SEUL écart est l'accusé). */
const ANSWER_TEXT = "Voici la réponse, courte et directe : deux lignes suffisent.";
/** Délai AVANT le premier token (mesure du TTFT : il ne doit pas bouger). */
const FIRST_TOKEN_DELAY_MS = 120;

function chatSteps(text: string, size = 10, delayMs = FIRST_TOKEN_DELAY_MS): FakeStep[] {
  const steps: FakeStep[] = [];
  for (let i = 0; i < text.length; i += size) {
    steps.push({ kind: "delta", channel: "content", text: text.slice(i, i + size), delayMs });
  }
  return steps;
}

/** Question simple : AUCUN accusé (aucune action n'est lancée). */
const QUESTION_STEPS: FakeStep[] = chatSteps(ANSWER_TEXT);
/**
 * ACTION écrite par le MODÈLE : une phrase courte, puis l'appel d'outil DANS LE
 * MÊME TOUR. Le délai est celui du PREMIER TEXTE du modèle (le même que le
 * premier token du tour « question ») : l'accusé n'ajoute donc aucun tour.
 */
const ACTION_STEPS: FakeStep[] = [
  { kind: "tool", tool: "delegate", text: "Je m'en occupe.", delayMs: FIRST_TOKEN_DELAY_MS },
  ...chatSteps(ANSWER_TEXT),
];
/**
 * MÊME mécanique, AUTRE contexte ⇒ AUTRE phrase. C'est la preuve que le texte
 * vient du modèle : aucune phrase n'est figée dans le code.
 */
const ACTION_VARIANT_STEPS: FakeStep[] = [
  {
    kind: "tool",
    tool: "generer_image",
    text: "Deux secondes, je m'en occupe.",
    delayMs: FIRST_TOKEN_DELAY_MS,
  },
  ...chatSteps(ANSWER_TEXT),
];
/**
 * ACTION SANS CONTENU : le modèle écrit l'accusé, l'action dure, et le run
 * s'achève SANS aucun autre texte. C'est le cas signalé par l'utilisateur (« la
 * bulle de réponse était VIDE ») : la bulle doit porter l'accusé seul.
 */
const ACTION_ONLY_STEPS: FakeStep[] = [
  { kind: "tool", tool: "generer_image", text: "C'est parti.", delayMs: FIRST_TOKEN_DELAY_MS },
];
/**
 * MODÈLE MUET : il appelle l'outil sans avoir rien écrit ⇒ le REPLI en dur parle.
 * Deux appels successifs doivent donner DEUX phrases différentes (rotation).
 */
const SILENT_STEPS: FakeStep[] = [
  { kind: "tool", tool: "delegate", delayMs: FIRST_TOKEN_DELAY_MS },
  ...chatSteps(ANSWER_TEXT),
];
/**
 * ACTION LONGUE, IMAGE, RÉPONSE : l'accusé part au premier texte du modèle, puis
 * l'action dure (pause mesurable) — c'est PENDANT cette pause que le harnais émet
 * les médias, exactement comme une génération d'image réelle —, puis la réponse
 * arrive. Le fil doit donc être : BULLE D'ACCUSÉ → CARTES MÉDIA → BULLE DE RÉPONSE.
 */
const MEDIA_PAUSE_MS = 1600;
const MEDIA_STEPS: FakeStep[] = [
  { kind: "tool", tool: "generer_image", text: "C'est parti.", delayMs: FIRST_TOKEN_DELAY_MS },
  { kind: "wait", delayMs: MEDIA_PAUSE_MS },
  ...chatSteps(ANSWER_TEXT),
];

/* ─── MÉDIAS (images générées + captures) : preuve de l'ORDRE du fil ──────
 * ⚠️ L'ordre ACCUSÉ → IMAGE → TEXTE et sa CONSERVATION au rechargement ne peuvent
 * se mesurer que si le fil contient de VRAIS médias ré-émis après le snapshot
 * (`restoreMedia`). On les sert donc ici, en same-origin, avec de vrais octets PNG.
 * Aucun ComfyUI, aucun agent : seuls comptent l'instant de création et la place
 * dans le fil. */
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

/** PNG 48×48 réel (damier) : le navigateur le décode vraiment. */
function buildPng(size = 48): Buffer {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x += 1) {
      const shade = (Math.floor(x / 6) + Math.floor(y / 6)) % 2 === 0 ? 0x2b : 0xd8;
      raw[row + 1 + x * 3] = shade;
      raw[row + 2 + x * 3] = shade;
      raw[row + 3 + x * 3] = shade;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const PNG = buildPng();

/** Conversation du harnais (une seule). */
const HARNESS_SESSION_ID = "e2e-ack-session";

/** Médias émis par le harnais, dans l'ordre de leur CRÉATION (chronologie). */
const images: ComfyImageView[] = [];
const captures: ScreenshotViewEvent[] = [];
const imageListeners = new Set<(view: ComfyImageView) => void>();
const captureListeners = new Set<(event: ScreenshotViewEvent) => void>();

const imagesPort: ImagesGatewayPort = {
  subscribeImages: (listener) => {
    imageListeners.add(listener);
    return () => {
      imageListeners.delete(listener);
    };
  },
  imagesForSession: () => [...images],
};

const screenshotsPort: ScreenshotGatewayPort = {
  subscribeScreenshots: (listener) => {
    captureListeners.add(listener);
    return () => {
      captureListeners.delete(listener);
    };
  },
  capturesForSession: () => [...captures],
};

/**
 * Crée un média à l'instant `at` et le diffuse (trame de contrôle). C'est
 * exactement ce que fait la production : le média est créé PENDANT l'action, donc
 * entre l'accusé et la réponse.
 */
function emitMedia(kind: "image" | "screenshot", label: string, at: Date): ComfyImageView | ScreenshotViewEvent {
  if (kind === "image") {
    const id = `img-${label}`;
    const view: ComfyImageView = {
      id,
      imageSrc: `/images/${id}.png`,
      mimeType: "image/png",
      width: 48,
      height: 48,
      bytes: PNG.length,
      createdAt: at.toISOString(),
      promptId: `p-${label}`,
      // ⚠️ Le transport route la trame vers les clients de CETTE conversation :
      // sans identifiant, aucune trame n'est envoyée (comme en production, où la
      // vue est rattachée AVANT diffusion).
      sessionId: HARNESS_SESSION_ID,
    };
    images.push(view);
    for (const listener of [...imageListeners]) listener(view);
    return view;
  }
  const id = `shot-${label}`;
  const event: ScreenshotViewEvent = {
    kind: "captured",
    screenshot: {
      agentId: "e2e-machine",
      agentName: "e2e-machine",
      sessionId: HARNESS_SESSION_ID,
      dataUrl: `/captures/${id}.png`,
      format: "png",
      width: 48,
      height: 48,
      bytes: PNG.length,
      capturedAt: at.toISOString(),
      source: "web",
      url: `https://e2e.local/${label}`,
    },
  };
  captures.push(event);
  for (const listener of [...captureListeners]) listener(event);
  return event;
}

const host = new FakePiHost({ sessionId: HARNESS_SESSION_ID });
await host.start();

/** Dernière synthèse FINALE observée (trame `run_summary`). */
let lastSummary: PiEvent | null = null;
host.subscribeAll((event) => {
  if (event.type === "run_summary") lastSummary = event;
});

/* ─── Pipeline TTS RÉEL (synthétiseur ENREGISTREUR) ───────────────────────── */
const spoken: string[] = [];
const synthesizer: SegmentSynthesizer = async (request) => {
  spoken.push(request.text);
  return (async function* () {
    yield { type: "format", sampleRate: 16_000, channels: 1 };
    yield { type: "data", bytes: Buffer.alloc(1_600) };
  })();
};
const ttsConfig: Record<string, number | string> = {
  "tts.prefetchDepth": 1,
  "tts.minSentenceChars": 1,
  "tts.maxSentenceChars": 200,
  "tts.engine": "chatterbox",
  "tts.voice": "",
};
const ttsPipeline: TtsPipelineDeps = {
  enabled: true,
  config: {
    getString: (path) => String(ttsConfig[path] ?? ""),
    getNumber: (path) => Number(ttsConfig[path] ?? 0),
  },
  synthesizer,
  resolveVoice: () => null,
  logger,
};

const transport = createWsTransport({
  host,
  logger,
  serverVersion: "e2e-ack-0.1.0",
  replayBufferSize: 1000,
  replayBufferBytes: 1_000_000,
  tts: ttsPipeline,
  images: imagesPort,
  screenshots: screenshotsPort,
});

const context: AppContext = {
  env,
  report: {} as GpuReport,
  gatePassed: true,
  startedAt: Date.now(),
  volumes: [],
  publicDir: "public/ui",
};

const appHandler = createApp(context);
const server = createHttpServer((req, res) => {
  const path = (req.url ?? "").split("?")[0];
  if (path.startsWith("/images/") || path.startsWith("/captures/")) {
    res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
    res.end(PNG);
    return;
  }
  appHandler(req, res);
});
transport.attach(server);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address() as AddressInfo;
console.log(`READY http://127.0.0.1:${address.port}`);

/* ─── Serveur de CONTRÔLE ─────────────────────────────────────────────────── */
const control = createHttpServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const send = (body: unknown, status = 200): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const sessionId = host.currentSessionId() ?? "e2e-ack-session";
  if (url.pathname === "/send") {
    const requested = url.searchParams.get("script");
    const script =
      requested === "action"
        ? "action"
        : requested === "action_variant"
          ? "action_variant"
          : requested === "action_only"
            ? "action_only"
            : requested === "silent"
              ? "silent"
              : requested === "media"
                ? "media"
                : "question";
    lastSummary = null;
    // Le script est EMPILÉ avant l'envoi : le double le consomme au démarrage.
    host.pushScript({
      name: script,
      steps:
        script === "action"
          ? [...ACTION_STEPS]
          : script === "action_variant"
            ? [...ACTION_VARIANT_STEPS]
            : script === "action_only"
              ? [...ACTION_ONLY_STEPS]
              : script === "silent"
                ? [...SILENT_STEPS]
                : script === "media"
                  ? [...MEDIA_STEPS]
                  : [...QUESTION_STEPS],
    });
    const handle = host.send(sessionId, "Peux-tu t'occuper de ça ?");
    return send({ ok: true, runId: handle.runId, script, sessionId });
  }
  // Émission d'un MÉDIA (image générée ou capture) à l'instant demandé : c'est ce
  // qui remplace la génération réelle au milieu du run.
  if (url.pathname === "/emit-media") {
    const kind = url.searchParams.get("kind") === "screenshot" ? "screenshot" : "image";
    const label = url.searchParams.get("label") ?? `m${images.length + captures.length}`;
    const at = new Date(url.searchParams.get("at") ?? Date.now());
    const view = emitMedia(kind, label, at);
    return send({ ok: true, kind, at: at.toISOString(), view });
  }
  if (url.pathname === "/media") {
    return send({ images, captures });
  }
  if (url.pathname === "/last-summary") {
    return send({ summary: lastSummary });
  }
  if (url.pathname === "/spoken") {
    return send({ spoken });
  }
  if (url.pathname === "/spoken-reset") {
    spoken.length = 0;
    return send({ ok: true });
  }
  return send({ error: "not_found" }, 404);
});
await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve));
console.log(`CONTROL http://127.0.0.1:${(control.address() as AddressInfo).port}`);
