/**
 * Harnais E2E JETABLE — gateway RÉEL avec l'API agents câblée, pour le rendu
 * headless Chromium de la page « Agents » de /config (Lot 4, B5).
 *
 * Usage : cd Yuki && npx tsx "../Yuki and Libs/_tools/e2e-agents-serve.ts"
 * Env :
 *   YUKI_E2E_AGENTS       identifiants d'agents à pré-enregistrer (séparés par ,)
 *   YUKI_E2E_NAMES        noms correspondant aux agents (même ordre, optionnel)
 *   YUKI_E2E_APPROVALS    "1" ⇒ ajoute une validation en attente (niveaux 2/3)
 *   YUKI_E2E_PENDING_CODE code d'appairage pour lequel déposer une `pair_begin`
 *                         EN ATTENTE (test du formulaire d'appairage, D119)
 * Sortie : « READY http://127.0.0.1:<port> » puis reste vivant.
 */

import { createServer as createHttpServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { randomBytes } from "node:crypto";
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
  codeKey,
  computeProof,
  maxSizeBytesFromMb,
  normalizeCode,
  PAIR_NONCE_SIZE,
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
const seedNames = (process.env.YUKI_E2E_NAMES ?? "")
  .split(",")
  .map((name) => name.trim());
for (let i = 0; i < seed.length; i += 1) {
  const id = seed[i] as string;
  store.markSeen(id);
  const name = seedNames[i];
  if (name) store.setName(id, name);
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

// Une trame d'agent EN ATTENTE pour un code connu : le formulaire d'appairage
// de la page Agents doit alors pouvoir le résoudre (`matched: true`).
if (process.env.YUKI_E2E_PENDING_CODE) {
  const code = process.env.YUKI_E2E_PENDING_CODE;
  const agentNonce = randomBytes(PAIR_NONCE_SIZE);
  const proof = computeProof(codeKey(normalizeCode(code)), Buffer.from("", "utf8"), agentNonce);
  pairing.beginPairing(
    { type: "pair_begin", protoVersion: 1, agentNonce, yukiFpClaimed: "", proof },
    { ip: "127.0.0.1" },
  );
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
