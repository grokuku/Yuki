/**
 * Harnais E2E JETABLE — BOUTON « REVENIR EN BAS DE LA CONVERSATION ».
 *
 * Gateway RÉEL, hôte Pi SIMULÉ (`FakePiHost` : de VRAIS deltas `content` en
 * flux) et une demande de validation EN MÉMOIRE (fenêtre flottante affichée au
 * chargement). Un serveur de CONTRÔLE (port séparé, hors CSP) permet de :
 *   - lancer un tour qui STREAME un long texte (`/stream?chars=&delayMs=`) ;
 *   - lancer un tour court (`/turn?text=`) ;
 *   - lire l'état du fil et le transcript serveur (`/state`).
 *
 * Sert à MESURER : apparition/disparition du bouton (seuil), retour en bas au
 * clic, non-recouvrement avec la fenêtre de validation, absence de clignotement
 * pendant un flux.
 *
 * Usage : cd Yuki && npx tsx "../Yuki and Libs/_tools/e2e-scroll-button-serve.ts"
 * Sortie : « READY http://127.0.0.1:<port> » puis « CONTROL http://… ».
 */

import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";

import { loadEnv } from "../../src/config/env.js";
import { createApp, type AppContext } from "../../src/gateway/app.js";
import { createWsTransport } from "../../src/gateway/ws/server.js";
import { createLogger } from "../../src/observability/logger.js";
import type {
  ApprovalDecisionOutcome,
  ApprovalGatewayPort,
  ApprovalViewEvent,
  PendingApprovalView,
} from "../../src/agents/execution.js";
import type { GpuReport } from "../../src/types/gpu.js";
import { FakePiHost, type FakeStep } from "../../tests/pi/host-double.js";

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
const env = loadEnv({
  YUKI_GPU_FIXTURE: "tests/fixtures/gpu/rtx4070-12g.txt",
  YUKI_LOG_LEVEL: "error",
});

const SESSION_ID = "e2e-scroll-session";

/** Texte de remplissage : N paragraphes courts (construit un fil défilable). */
function fillerTurn(n: number): string {
  return `Message de remplissage #${n} : une ligne assez longue pour occuper une partie de l'écran.`;
}

/** Script en FLUX : `chars` caractères découpés en petits deltas. */
function streamScript(chars: number, delayMs: number): FakeStep[] {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789 ";
  const total = Math.max(1, Math.floor(chars));
  const steps: FakeStep[] = [];
  for (let i = 0; i < total; i += 8) {
    let chunk = "";
    for (let j = i; j < Math.min(i + 8, total); j += 1) {
      chunk += alphabet[j % alphabet.length];
    }
    steps.push({ kind: "delta", channel: "content", text: chunk, delayMs });
  }
  return steps;
}

const host = new FakePiHost({ sessionId: SESSION_ID, latencyScale: 0 });
await host.start();

/* ─── Port d'approbations EN MÉMOIRE (une demande en attente, poussable) ─── */
class StubApprovalPort implements ApprovalGatewayPort {
  private readonly listeners = new Set<(event: ApprovalViewEvent) => void>();
  private entry: PendingApprovalView | null;

  constructor(private readonly sessionId: string) {
    this.entry = this.make("apr-scroll-1");
  }

  private make(id: string): PendingApprovalView {
    const now = Date.now();
    return {
      id,
      sessionId: this.sessionId,
      agentId: "agent-nuc00",
      agentName: "nuc00",
      command: "rm -rf /srv/cache",
      destructive: true,
      destructiveIds: ["rm"],
      destructiveReasons: ["suppression (rm)"],
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 600_000).toISOString(),
      ttlSeconds: 600,
    };
  }

  /** (Re)met une demande en attente et la diffuse. */
  add(id: string): void {
    this.entry = this.make(id);
    for (const listener of this.listeners) {
      listener({ kind: "requested", approval: this.entry });
    }
  }

  remove(): void {
    if (!this.entry) return;
    const approval = this.entry;
    this.entry = null;
    for (const listener of this.listeners) {
      listener({ kind: "decided", approval, decision: "deny" });
    }
  }

  subscribeApprovals(listener: (event: ApprovalViewEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  pendingApprovals(sessionId: string): PendingApprovalView[] {
    return this.entry && this.entry.sessionId === sessionId ? [this.entry] : [];
  }

  async decideApproval(id: string): Promise<ApprovalDecisionOutcome> {
    if (!this.entry || this.entry.id !== id) {
      return { ok: false, code: "approval_not_found", message: "Cette demande n'existe plus." };
    }
    const approval = this.entry;
    this.entry = null;
    return { ok: true, decision: "deny", approval };
  }
}

const approvals = new StubApprovalPort(SESSION_ID);

const transport = createWsTransport({
  host,
  logger,
  serverVersion: "e2e-scroll-0.1.0",
  replayBufferSize: 4000,
  replayBufferBytes: 8_000_000,
  approvals,
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

/* ─── Remplissage initial : un fil assez long pour DÉFILER ──────────────── */
const FILL = Number.parseInt(process.env.YUKI_E2E_SCROLL_FILL ?? "14", 10);
for (let i = 0; i < FILL; i += 1) {
  host.pushScript({ steps: [{ kind: "delta", channel: "content", text: fillerTurn(i), delayMs: 0 }] });
  host.send(SESSION_ID, `Question de remplissage ${i} ?`);
  await new Promise((r) => setTimeout(r, 5));
}
await new Promise((r) => setTimeout(r, 200));

/* ─── Serveur de CONTRÔLE ─────────────────────────────────────────────────── */
const control = createHttpServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const send = (body: unknown, status = 200): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === "/stream") {
    const chars = Number.parseInt(url.searchParams.get("chars") ?? "4000", 10);
    const delayMs = Number.parseInt(url.searchParams.get("delayMs") ?? "5", 10);
    host.pushScript({ steps: streamScript(chars, delayMs) });
    const handle = host.send(SESSION_ID, "Explique en détail, s'il te plaît.");
    return send({ ok: true, runId: handle.runId });
  }
  if (url.pathname === "/turn") {
    const text = url.searchParams.get("text") ?? "ok";
    host.pushScript({
      steps: [{ kind: "delta", channel: "content", text, delayMs: 0 }],
    });
    const handle = host.send(SESSION_ID, "Question courte ?");
    return send({ ok: true, runId: handle.runId });
  }
  if (url.pathname === "/state") {
    const state = host.getState(SESSION_ID);
    return send({
      state: state?.state ?? "idle",
      count: state?.transcript.length ?? 0,
    });
  }
  if (url.pathname === "/approval/add") {
    approvals.add("apr-scroll-" + Date.now());
    return send({ ok: true });
  }
  if (url.pathname === "/approval/remove") {
    approvals.remove();
    return send({ ok: true });
  }
  return send({ error: "unknown" }, 404);
});
await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve));
const controlAddress = control.address() as AddressInfo;
console.log(`CONTROL http://127.0.0.1:${controlAddress.port}`);

setInterval(() => {}, 1 << 30);
