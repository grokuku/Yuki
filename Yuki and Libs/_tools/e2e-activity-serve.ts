/**
 * Harnais E2E JETABLE — gateway RÉEL avec un hôte Pi SIMULÉ (FakePiHost) et le
 * pipeline TTS RÉEL (synthétiseur simulé qui ENREGISTRE le texte prononcé).
 *
 * Sert la page de discussion `/` sous la CSP réelle pour prouver, dans un vrai
 * navigateur :
 *   - l'indicateur d'attente est VISIBLE entre l'envoi et le premier token ;
 *   - les trames `job_*` produisent un élément visible ;
 *   - les libellés d'état ne sont JAMAIS prononcés (le synthétiseur ne reçoit
 *     que le contenu).
 *
 * Un serveur de CONTRÔLE (port séparé) permet au harnais mjs de déclencher des
 * trames `job_*` et de relire les segments réellement prononcés.
 *
 * Usage :
 *   cd Yuki && npx tsx "../Yuki and Libs/_tools/e2e-activity-serve.ts"
 * Sortie : « READY http://127.0.0.1:<port> » puis « CONTROL http://… ».
 */

import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";

import { loadEnv } from "../../src/config/env.js";
import { createApp, type AppContext } from "../../src/gateway/app.js";
import { createWsTransport } from "../../src/gateway/ws/server.js";
import { createLogger } from "../../src/observability/logger.js";
import type { PiSessionStateName } from "../../src/pi/types.js";
import type { SegmentSynthesizer, TtsPipelineDeps } from "../../src/tts/index.js";
import type { GpuReport } from "../../src/types/gpu.js";
import { FakePiHost, type FakeStep } from "../../tests/pi/host-double.js";

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
const env = loadEnv({
  YUKI_GPU_FIXTURE: "tests/fixtures/gpu/rtx4070-12g.txt",
  YUKI_LOG_LEVEL: "error",
});

/** Réponse du premier tour, streamée APRÈS un long silence (attente observable). */
const REPLY_TEXT = "Voici la réponse, une fois l'attente terminée.";
const FIRST_TOKEN_DELAY_MS = 1_600;

function chatSteps(text: string, size = 12, delayMs = 25): FakeStep[] {
  const steps: FakeStep[] = [];
  for (let i = 0; i < text.length; i += size) {
    steps.push({ kind: "delta", channel: "content", text: text.slice(i, i + size), delayMs });
  }
  return steps;
}

const host = new FakePiHost({
  sessionId: "e2e-activity-session",
  scripts: [
    {
      name: "activity-delayed",
      steps: [
        // Long silence de PREMIER token : la fenêtre d'attente est franche.
        { kind: "delta", channel: "content", text: REPLY_TEXT, delayMs: FIRST_TOKEN_DELAY_MS },
      ],
    },
    { name: "activity-follow-up", steps: chatSteps("Deuxième réponse.", 12, 25) },
    { name: "activity-third", steps: chatSteps("Troisième réponse.", 12, 25) },
  ],
});
await host.start();

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
  serverVersion: "e2e-activity-0.1.0",
  replayBufferSize: 1000,
  replayBufferBytes: 1_000_000,
  tts: ttsPipeline,
});

const context: AppContext = {
  env,
  report: {} as GpuReport,
  gatePassed: true,
  startedAt: Date.now(),
  volumes: [],
  publicDir: "public/ui",
};

const server = createHttpServer(createApp(context));
transport.attach(server);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address() as AddressInfo;
console.log(`READY http://127.0.0.1:${address.port}`);

/* ─── Serveur de CONTRÔLE (hors navigateur, hors CSP) ────────────────────── */
const control = createHttpServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const send = (body: unknown, status = 200): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const sessionId = host.currentSessionId() ?? "e2e-activity-session";
  if (url.pathname === "/job-start") {
    host.emitExternal({
      type: "job_started",
      sessionId,
      jobId: url.searchParams.get("jobId") ?? "job-1",
      task: url.searchParams.get("task") ?? "analyse",
    });
    return send({ ok: true });
  }
  if (url.pathname === "/job-finish") {
    const status = url.searchParams.get("status") ?? "completed";
    host.emitExternal({
      type: "job_finished",
      sessionId,
      jobId: url.searchParams.get("jobId") ?? "job-1",
      status: status as "completed" | "failed" | "cancelled" | "interrupted",
    });
    return send({ ok: true });
  }
  if (url.pathname === "/job-report") {
    host.emitExternal({
      type: "job_report",
      sessionId,
      jobId: url.searchParams.get("jobId") ?? "job-1",
    });
    return send({ ok: true });
  }
  // E5 — état de session SERVEUR (`waiting` = travail non achevé). Le badge UI
  // est piloté par CET état, jamais par le texte du modèle.
  if (url.pathname === "/state") {
    const state = (url.searchParams.get("state") ?? "idle") as PiSessionStateName;
    host.emitExternal({ type: "state", sessionId, state });
    return send({ ok: true });
  }
  // E3 — étape d'ACTIVITÉ d'un sous-agent (trame de contrôle éphémère).
  if (url.pathname === "/job-activity") {
    const task = url.searchParams.get("task");
    const detail = url.searchParams.get("detail");
    const status = url.searchParams.get("status");
    host.emitExternal({
      type: "job_activity",
      sessionId,
      jobId: url.searchParams.get("jobId") ?? "act-1",
      stage: url.searchParams.get("stage") ?? "job_started",
      ...(task !== null ? { task } : {}),
      ...(detail !== null ? { detail } : {}),
      ...(status !== null ? { status: status as "completed" | "failed" | "cancelled" | "interrupted" } : {}),
      at: new Date().toISOString(),
    });
    return send({ ok: true });
  }
  // Transcript SERVEUR de la conversation (preuve d'éphémérité : la trame
  // d'activité ne doit jamais y entrer).
  if (url.pathname === "/transcript") {
    const state = host.getState();
    const text = (state?.transcript ?? []).map((entry) => entry.text).join("\n");
    return send({ text });
  }
  if (url.pathname === "/spoken") {
    return send({ spoken });
  }
  if (url.pathname === "/spoken-reset") {
    spoken.length = 0;
    return send({ ok: true });
  }
  return send({ error: "unknown" }, 404);
});
await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve));
const controlAddress = control.address() as AddressInfo;
console.log(`CONTROL http://127.0.0.1:${controlAddress.port}`);

setInterval(() => {}, 1 << 30);
