/**
 * Harnais E2E JETABLE — ① séparation visuelle de tours assistant CONSÉCUTIFS et
 * ② pied de stats EN DIRECT (valeurs provisoires → valeurs finales).
 *
 * Gateway RÉEL, hôte Pi SIMULÉ (`FakePiHost`, qui émet de VRAIES trames
 * `phase`/`run_summary` via `RunInstrumentation`) et pipeline TTS RÉEL
 * (synthétiseur simulé qui ENREGISTRE le texte prononcé).
 *
 * Un serveur de CONTRÔLE (port séparé, hors CSP) permet de :
 *   - lancer un tour UTILISATEUR (`/send`) ou un tour SYNTHÉTIQUE de rapport
 *     (`/report`, origine `job_report` : AUCUNE bulle utilisateur) ;
 *   - relire la DERNIÈRE synthèse `run_summary` émise (valeurs FINALES) ;
 *   - relire le transcript SERVEUR et les segments réellement prononcés.
 *
 * Usage : cd Yuki && npx tsx "../Yuki and Libs/_tools/e2e-live-stats-serve.ts"
 * Sortie : « READY http://127.0.0.1:<port> » puis « CONTROL http://… ».
 */

import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";

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

/** Texte du 1er tour (accusé de réception) et du 2e tour (résultat réinjecté). */
const ACK_TEXT = "Je lance la tâche de fond, je reviens vers toi.";
const REPORT_TEXT = "Voici le résultat de la tâche de fond.";
const USER_TEXT = "Peux-tu analyser le dépôt en tâche de fond ?";

function chatSteps(text: string, size = 10, delayMs = 60): FakeStep[] {
  const steps: FakeStep[] = [];
  for (let i = 0; i < text.length; i += size) {
    steps.push({ kind: "delta", channel: "content", text: text.slice(i, i + size), delayMs });
  }
  return steps;
}

const host = new FakePiHost({
  sessionId: "e2e-live-stats-session",
  scripts: [
    { name: "ack", steps: chatSteps(ACK_TEXT, 8, 120) },
    { name: "report", steps: chatSteps(REPORT_TEXT, 8, 120) },
    { name: "third", steps: chatSteps("Troisième réponse, streamee pour la mesure du pied.", 10, 90) },
  ],
});
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
  serverVersion: "e2e-live-stats-0.1.0",
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

/* ─── Serveur de CONTRÔLE ─────────────────────────────────────────────────── */
const control = createHttpServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const send = (body: unknown, status = 200): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const sessionId = host.currentSessionId() ?? "e2e-live-stats-session";
  if (url.pathname === "/send") {
    // Tour UTILISATEUR : une bulle utilisateur + une bulle assistant.
    const text = url.searchParams.get("text") ?? USER_TEXT;
    const handle = host.send(sessionId, text);
    return send({ ok: true, runId: handle.runId, sessionId });
  }
  if (url.pathname === "/report") {
    // Tour SYNTHÉTIQUE (rapport de sous-agent) : AUCUNE bulle utilisateur, donc
    // DEUX bulles assistant CONSÉCUTIVES dans le fil.
    const text = url.searchParams.get("text") ?? REPORT_TEXT;
    const handle = host.send(sessionId, text, { origin: "job_report" });
    return send({ ok: true, runId: handle.runId, sessionId });
  }
  if (url.pathname === "/last-summary") {
    return send({ summary: lastSummary });
  }
  if (url.pathname === "/transcript") {
    const state = host.getState(sessionId);
    return send({
      roles: (state?.transcript ?? []).map((entry) => entry.role),
      text: (state?.transcript ?? []).map((entry) => entry.text).join("\n"),
    });
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
