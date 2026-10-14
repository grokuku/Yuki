/**
 * Harnais E2E JETABLE — gateway RÉEL avec l'API des notifications (PWA + Web
 * Push) câblée, pour le rendu headless Chromium de l'interface.
 *
 * ⚠️ Ce harnais ne peut PAS prouver l'envoi réel vers un service de push (il
 * faudrait un navigateur abonné et un accès sortant). Il prouve ce qui est
 * prouvable : manifeste + service worker servis, MÊME ORIGINE, types MIME
 * corrects, CSP non élargie au-delà de `manifest-src 'self'`.
 *
 * Usage : cd Yuki && npx tsx "../Yuki and Libs/_tools/e2e-push-serve.ts"
 * Env :
 *   YUKI_E2E_PUSH_DIR  dossier d'état (OBLIGATOIRE) : clés VAPID + abonnements.
 * Sortie : « READY http://127.0.0.1:<port> » puis reste vivant.
 */

import { createServer as createHttpServer } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { loadEnv } from "../../src/config/env.js";
import { createConfigRuntime } from "../../src/config/runtime.js";
import { createApp, type AppContext } from "../../src/gateway/app.js";
import { createLogger } from "../../src/observability/logger.js";
import { PushSubscriptionStore } from "../../src/push/store.js";
import { loadOrCreateVapidKeys } from "../../src/push/vapid.js";
import type { GpuReport } from "../../src/types/gpu.js";

const dir = process.env.YUKI_E2E_PUSH_DIR;
if (!dir) throw new Error("YUKI_E2E_PUSH_DIR requis");
mkdirSync(dir, { recursive: true });

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
const env = loadEnv({
  YUKI_GPU_FIXTURE: "tests/fixtures/gpu/rtx4070-12g.txt",
  YUKI_LOG_LEVEL: "error",
  YUKI_MOUNT_STATE: dir,
  YUKI_PUSH_VAPID_PATH: join(dir, "push-vapid.json"),
  YUKI_PUSH_SUBSCRIPTIONS_PATH: join(dir, "push-subscriptions.json"),
});
const config = createConfigRuntime({
  env,
  promptDefaults: { light: "systeme leger", heavy: "systeme lourd" },
});

const { keys } = loadOrCreateVapidKeys(env.pushVapidPath, logger);
const store = new PushSubscriptionStore({ path: env.pushSubscriptionsPath, logger });

const context: AppContext = {
  env,
  report: {} as GpuReport,
  gatePassed: true,
  startedAt: Date.now(),
  volumes: [],
  publicDir: "public/ui",
  config: { runtime: config, logger },
  push: {
    store,
    logger,
    enabled: () => config.getString("push.enabled") === "on",
    publicKey: keys.publicKey,
  },
};

const server = createHttpServer(createApp(context));
server.listen(0, "127.0.0.1", () => {
  const address = server.address() as AddressInfo;
  console.log(`READY http://127.0.0.1:${address.port}`);
});
setInterval(() => {}, 1 << 30);
