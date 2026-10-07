/**
 * Harnais E2E JETABLE — gateway RÉEL avec l'API agents câblée, pour le rendu
 * headless Chromium de la page « Agents » de /config (Lot 4, B5).
 *
 * Usage : cd Yuki && npx tsx "../Yuki and Libs/_tools/e2e-agents-serve.ts"
 * Env :
 *   YUKI_E2E_AGENTS    identifiants d'agents à pré-enregistrer (séparés par ,)
 *   YUKI_E2E_APPROVALS "1" ⇒ ajoute une validation en attente (niveaux 2/3)
 * Sortie : « READY http://127.0.0.1:<port> » puis reste vivant.
 */

import { createServer as createHttpServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import {
  AgentExecutionService,
  AgentHub,
  AgentStore,
  ApprovalRegistry,
  AuditLog,
  caDirectoryIn,
  CertificateAuthority,
  maxSizeBytesFromMb,
  PairingManager,
} from "../../src/agents/index.js";
import { loadEnv } from "../../src/config/env.js";
import { createConfigRuntime } from "../../src/config/runtime.js";
import { createApp, type AppContext } from "../../src/gateway/app.js";
import { createLogger } from "../../src/observability/logger.js";
import type { GpuReport } from "../../src/types/gpu.js";

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
const env = loadEnv({ YUKI_GPU_FIXTURE: "tests/fixtures/gpu/rtx4070-12g.txt", YUKI_LOG_LEVEL: "error" });
const config = createConfigRuntime({
  env,
  promptDefaults: { light: "systeme leger", heavy: "systeme lourd" },
});
const dir = mkdtempSync(join(tmpdir(), "yuki-e2e-agents-"));

const store = AgentStore.open({
  path: join(dir, "agents.jsonl"),
  defaults: { level: "destructive", privilege: "normal" },
  logger,
});
const audit = AuditLog.open({
  path: join(dir, "audit.jsonl"),
  maxSizeBytes: maxSizeBytesFromMb(1),
  retentionDays: 30,
  logger,
});
const ca = CertificateAuthority.open({ dir: caDirectoryIn(dir), logger });
const pairing = new PairingManager({ ca, store, audit, logger });
const hub = new AgentHub({ logger });
const approvals = new ApprovalRegistry({ logger });
const execution = new AgentExecutionService({ store, hub, audit, approvals, logger });
void execution;

const seed = (process.env.YUKI_E2E_AGENTS ?? "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);
for (const id of seed) {
  store.markSeen(id);
  audit.append({
    event: "command",
    agentId: id,
    command: "ls -la /srv",
    exitCode: 0,
    meta: { status: "completed" },
  });
}
if (process.env.YUKI_E2E_APPROVALS === "1" && seed[0]) {
  approvals.request({ agentId: seed[0], command: "systemctl restart nginx", destructive: true });
}

const context: AppContext = {
  env,
  report: {} as GpuReport,
  gatePassed: true,
  startedAt: Date.now(),
  volumes: [],
  publicDir: "public/ui",
  config: { runtime: config, logger },
  agents: { pairing, store, logger, hub, audit, approvals },
};

const server = createHttpServer(createApp(context));
server.listen(0, "127.0.0.1", () => {
  const address = server.address() as AddressInfo;
  console.log(`READY http://127.0.0.1:${address.port}`);
});
setInterval(() => {}, 1 << 30);
