/**
 * Harnais E2E JETABLE — ACCUSÉ DE RÉCEPTION (déclenché par l'ACTION).
 *
 * Gateway RÉEL, hôte Pi SIMULÉ (`FakePiHost`, qui émet de VRAIES trames
 * `phase`/`run_summary` via `RunInstrumentation`), pipeline TTS RÉEL dont le
 * synthétiseur ENREGISTRE le texte réellement prononcé.
 *
 * Deux tours programmés, strictement identiques SAUF l'accusé :
 *   - `question` : une question simple, aucun accusé ;
 *   - `action`   : une ACTION démarre (délégation), l'accusé part AVANT le contenu.
 *
 * Un serveur de CONTRÔLE (hors CSP) permet de :
 *   - lancer un tour (`/send?script=question|action`) ;
 *   - relire la dernière synthèse `run_summary` (le TTFT RÉEL, mesuré serveur) ;
 *   - relire le texte réellement prononcé (`/spoken`).
 *
 * Usage : cd Yuki && npx tsx "../Yuki and Libs/_tools/e2e-ack-serve.ts"
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
 * ACTION SANS CONTENU : l'accusé part, l'action dure, et le run s'achève SANS
 * aucun texte. C'est le cas signalé par l'utilisateur (« la bulle de réponse
 * était VIDE ») : la bulle doit porter l'accusé seul, jamais rester muette.
 */
const ACTION_ONLY_STEPS: FakeStep[] = [
  { kind: "ack", text: "C'est parti.", tool: "generer_image", delayMs: 0 },
];
/**
 * Action qui démarre : l'accusé part AVANT le premier token, donc AVANT le
 * contenu — et sans ajouter un seul milliseconde au TTFT (même délai de premier
 * token que le tour « question », seul l'accusé s'ajoute).
 */
const ACTION_STEPS: FakeStep[] = [
  { kind: "ack", text: "Je m'en occupe.", tool: "delegate", delayMs: 0 },
  ...chatSteps(ANSWER_TEXT),
];

const host = new FakePiHost({ sessionId: "e2e-ack-session" });
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
  const sessionId = host.currentSessionId() ?? "e2e-ack-session";
  if (url.pathname === "/send") {
    const requested = url.searchParams.get("script");
    const script =
      requested === "action" ? "action" : requested === "action_only" ? "action_only" : "question";
    lastSummary = null;
    // Le script est EMPILÉ avant l'envoi : le double le consomme au démarrage.
    host.pushScript({
      name: script,
      steps:
        script === "action"
          ? [...ACTION_STEPS]
          : script === "action_only"
            ? [...ACTION_ONLY_STEPS]
            : [...QUESTION_STEPS],
    });
    const handle = host.send(sessionId, "Peux-tu t'occuper de ça ?");
    return send({ ok: true, runId: handle.runId, script, sessionId });
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
