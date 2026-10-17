/**
 * Harnais E2E JETABLE — demande de SECRET par Yuki (`demander_secret`).
 *
 * Gateway RÉEL + hôte Pi RÉEL hors ligne, avec un VRAI `AgentExecutionService`
 * (coffre de secrets CHIFFRÉ, registre des demandes). Au démarrage, on invoque
 * RÉELLEMENT l'outil `demander_secret` — donc on exerce la chaîne COMPLÈTE :
 * outil → port → registre → trame de contrôle WS → fenêtre flottante. Les
 * fenêtres doivent apparaître AU-DESSUS de l'interface (pas dans le fil),
 * n'entrer NI dans le transcript NI dans l'audit, et la VALEUR saisie ne doit
 * JAMAIS revenir au client ni se retrouver sur le disque.
 *
 * ⚠️ On n'écrit JAMAIS la valeur : le marqueur de réception ne porte que le NOM
 * et la LONGUEUR (preuve de réception sans stockage).
 *
 * Usage : cd Yuki && npx tsx "../Yuki and Libs/_tools/e2e-secret-serve.ts"
 * Env :
 *   YUKI_E2E_SECRET_DIR     dossier d'état (OBLIGATOIRE).
 *   YUKI_E2E_SECRET_TTL_MS  TTL du registre (défaut : celui du produit).
 *   YUKI_E2E_SECRET_ONLY    « 1 » : une seule demande (test d'expiration).
 * Sortie : « READY http://127.0.0.1:<port> » puis reste vivant.
 */

import { createServer as createHttpServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { loadEnv } from "../../src/config/env.js";
import { createApp, type AppContext } from "../../src/gateway/app.js";
import { createWsTransport } from "../../src/gateway/ws/server.js";
import { createLogger } from "../../src/observability/logger.js";
import { createPiHost } from "../../src/pi/host.js";
import { createSecretRequestTool } from "../../src/pi/sdk/execution-tools.js";
import {
  AgentExecutionService,
  AgentHub,
  AgentStore,
  ApprovalRegistry,
  AuditLog,
} from "../../src/agents/index.js";
import type { SecretRequestGatewayPort } from "../../src/agents/execution.js";
import { SecretStore } from "../../src/secrets/store.js";
import { SecretRequestRegistry } from "../../src/secrets/requests.js";
import type { GpuReport } from "../../src/types/gpu.js";

const stateDir = process.env.YUKI_E2E_SECRET_DIR;
if (!stateDir) throw new Error("YUKI_E2E_SECRET_DIR requis");

const ttlRaw = Number.parseInt(process.env.YUKI_E2E_SECRET_TTL_MS ?? "", 10);
const ttlMs = Number.isFinite(ttlRaw) && ttlRaw > 0 ? ttlRaw : undefined;
const onlyOne = process.env.YUKI_E2E_SECRET_ONLY === "1";

const agentDir = join(stateDir, "agent");
const cwd = join(stateDir, "workspace");
const sessionsDir = join(agentDir, "sessions");
for (const dir of [agentDir, cwd, sessionsDir]) mkdirSync(dir, { recursive: true });

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

// ── Service d'exécution RÉEL (coffre + registre) ──────────────────────────
const store = AgentStore.open({
  path: join(stateDir, "agents.jsonl"),
  defaults: { level: "never", privilege: "normal" },
  logger,
});
const audit = AuditLog.open({
  path: join(stateDir, "audit.jsonl"),
  maxSizeBytes: 1_000_000,
  retentionDays: 30,
  logger,
});
const hub = new AgentHub({ logger });
const approvals = new ApprovalRegistry({ logger });
const secretStore = new SecretStore({
  path: join(stateDir, "secrets.vault.json"),
  key: "cle-maitre-e2e",
  env: {},
  logger,
});
const secretRequests = new SecretRequestRegistry({
  logger,
  ...(ttlMs !== undefined ? { ttlMs } : {}),
});
const execution = new AgentExecutionService({
  store,
  hub,
  audit,
  approvals,
  secrets: secretStore,
  secretRequests,
  logger,
});

/* ⚠️ Marqueur de RÉCEPTION : NOM + LONGUEUR seulement — JAMAIS la valeur. */
const secretPort: SecretRequestGatewayPort = {
  subscribeSecrets: (listener) => execution.subscribeSecrets(listener),
  pendingSecrets: (sessionId) => execution.pendingSecrets(sessionId),
  submitSecret: async (id, values) => {
    const result = await execution.submitSecret(id, values);
    writeFileSync(
      join(stateDir, "secret-received.json"),
      JSON.stringify({
        ok: result.ok,
        id,
        names: Object.keys(values),
        bytes: Object.values(values).map((value) => value.length),
      }),
    );
    return result;
  },
};

const transport = createWsTransport({
  host,
  logger,
  serverVersion: "e2e-0.1.0",
  replayBufferSize: 1000,
  replayBufferBytes: 1_000_000,
  secrets: secretPort,
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

  // ── Déclenchement : on invoque RÉELLEMENT l'outil `demander_secret` ──────
  const [tool] = createSecretRequestTool(execution);
  const call = tool.execute as unknown as (
    id: string,
    params: unknown,
    signal: undefined,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<unknown>;
  const ctx = { sessionManager: { getSessionId: () => sessionId } };
  void call(
    "e2e-1",
    { secrets: ["YUKI_SECRET_NAS"], raison: "se connecter au NAS de sauvegarde", machine: "nuc00" },
    undefined,
    undefined,
    ctx,
  );
  if (!onlyOne) {
    void call(
      "e2e-2",
      { secrets: ["YUKI_SECRET_WIFI"], raison: "se connecter au wifi du bureau" },
      undefined,
      undefined,
      ctx,
    );
  }
});
setInterval(() => {}, 1 << 30);
