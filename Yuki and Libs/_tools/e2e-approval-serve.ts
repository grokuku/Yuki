/**
 * Harnais E2E JETABLE — validation humaine DANS la conversation (D118).
 *
 * Gateway RÉEL avec un hôte Pi RÉEL hors ligne et un port d'approbations EN
 * MÉMOIRE (aucun agent réel) : DEUX demandes de validation sont rattachées à la
 * conversation courante. Les fenêtres flottantes doivent apparaître AU-DESSUS
 * de l'interface (pas dans le fil), disparaître à la décision, ne JAMAIS revenir
 * une fois décidées, et n'entrer NI dans le transcript NI au rechargement.
 *
 * Usage : cd Yuki && npx tsx "../Yuki and Libs/_tools/e2e-approval-serve.ts"
 * Env :
 *   YUKI_E2E_APPROVAL_DIR  dossier d'état (OBLIGATOIRE).
 * Sortie : « READY http://127.0.0.1:<port> » puis reste vivant.
 */

import { createServer as createHttpServer } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { loadEnv } from "../../src/config/env.js";
import { createApp, type AppContext } from "../../src/gateway/app.js";
import { createWsTransport } from "../../src/gateway/ws/server.js";
import { createLogger } from "../../src/observability/logger.js";
import { createPiHost } from "../../src/pi/host.js";
import type {
  ApprovalDecisionOutcome,
  ApprovalGatewayPort,
  ApprovalViewEvent,
  ExecutionOutcome,
  PendingApprovalView,
} from "../../src/agents/execution.js";
import type { GpuReport } from "../../src/types/gpu.js";

const stateDir = process.env.YUKI_E2E_APPROVAL_DIR;
if (!stateDir) throw new Error("YUKI_E2E_APPROVAL_DIR requis");

/**
 * Longueur (en lignes) de la commande de la demande #1. Par défaut une commande
 * courte ; un test de FORME la rend énorme (ex. 120 lignes) pour prouver que la
 * fenêtre ne dépasse jamais le viewport.
 * `rm -rf /srv/cache` reste dans les PREMIÈRES lignes (aperçu visible même replié).
 */
function longCommand(lines: number): string {
  const head = ["#!/usr/bin/env bash", "set -euo pipefail", "rm -rf /srv/cache", "cd /srv/data"];
  const body: string[] = [];
  for (let i = head.length; i < lines; i += 1) {
    body.push(`echo "étape ${i + 1}/… : synchronisation du volume /srv/data"`);
  }
  return [...head, ...body].slice(0, Math.max(head.length, lines)).join("\n");
}

const longLines = Number.parseInt(process.env.YUKI_E2E_APPROVAL_LONG_LINES ?? "", 10);
const command1 = Number.isFinite(longLines) && longLines > 0 ? longCommand(longLines) : "rm -rf /srv/cache";
const agentDir = join(stateDir, "agent");
const cwd = join(stateDir, "workspace");
const sessionsDir = join(agentDir, "sessions");
for (const dir of [agentDir, cwd, sessionsDir]) mkdirSync(dir, { recursive: true });

/** Port d'approbations EN MÉMOIRE (DEUX demandes pour la conversation courante).
 * Deux demandes simultanées prouvent que plusieurs fenêtres flottantes cohabitent
 * sans s'écraser. */
class StubApprovalPort implements ApprovalGatewayPort {
  private readonly entries = new Map<string, PendingApprovalView>();

  constructor(private readonly sessionId: string) {
    const now = Date.now();
    const mk = (
      id: string,
      agentId: string,
      agentName: string,
      command: string,
      destructive: boolean,
      destructiveReasons: string[],
    ): PendingApprovalView => ({
      id,
      sessionId,
      agentId,
      agentName,
      command,
      destructive,
      destructiveIds: destructive ? ["rm"] : [],
      destructiveReasons,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 300_000).toISOString(),
      ttlSeconds: 300,
    });
    this.entries.set(
      "apr-e2e-1",
      mk("apr-e2e-1", "agent-nuc00", "nuc00", command1, true, ["suppression (rm)"]),
    );
    // Une seule demande pour les tests de FORME (fenêtre isolée, sans chevauchement).
    if (process.env.YUKI_E2E_APPROVAL_ONLY_LONG === "1") return;
    this.entries.set(
      "apr-e2e-2",
      mk("apr-e2e-2", "agent-nuc01", "nuc01", "ls -la /srv", false, []),
    );
  }

  subscribeApprovals(_listener: (event: ApprovalViewEvent) => void): () => void {
    return () => undefined;
  }

  pendingApprovals(sessionId: string): PendingApprovalView[] {
    return [...this.entries.values()].filter((a) => a.sessionId === sessionId);
  }

  async decideApproval(
    id: string,
    decision: "approve" | "deny",
  ): Promise<ApprovalDecisionOutcome> {
    const approval = this.entries.get(id);
    if (!approval) {
      return { ok: false, code: "approval_not_found", message: "Cette demande n'existe plus." };
    }
    this.entries.delete(id);
    if (decision === "deny") return { ok: true, decision: "deny", approval };
    const outcome: ExecutionOutcome = {
      status: "completed",
      agentId: approval.agentId,
      agentName: approval.agentName,
      command: approval.command,
      destructive: approval.destructive,
      destructiveIds: approval.destructiveIds,
      exitCode: 0,
      framed:
        `<sortie machine="${approval.agentId}" commande="${approval.command}" code="0" tronquee="non" delai_depasse="non">\n` +
        "--- sortie standard ---\n(suppression effectuée)\n</sortie>",
      message: "Commande exécutée (code de sortie 0).",
      durationMs: 12,
    };
    return { ok: true, decision: "approve", approval, outcome };
  }
}

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
const env = loadEnv({
  YUKI_GPU_FIXTURE: "tests/fixtures/gpu/rtx4070-12g.txt",
  YUKI_LOG_LEVEL: "error",
});

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
const approvals = new StubApprovalPort(sessionId);

const transport = createWsTransport({
  host,
  logger,
  serverVersion: "e2e-0.1.0",
  replayBufferSize: 1000,
  replayBufferBytes: 1_000_000,
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
server.listen(0, "127.0.0.1", () => {
  const address = server.address() as AddressInfo;
  console.log(`READY http://127.0.0.1:${address.port}`);
});
setInterval(() => {}, 1 << 30);
