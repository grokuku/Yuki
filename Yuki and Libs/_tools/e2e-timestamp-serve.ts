/**
 * Harnais E2E JETABLE — horodatage du fil (heures + séparateurs de jour).
 *
 * Gateway RÉEL avec un hôte Pi RÉEL hors ligne et DEUX conversations
 * pré-écrites sur disque : un fil A étalé sur DEUX jours (pour prouver les
 * séparateurs de jour) et un fil B d'un autre jour (pour la bascule). Les
 * messages utilisateur sont stockés AVEC leur préfixe d'horodatage, comme le
 * fait désormais le host : la restauration doit le MASQUER et afficher l'heure.
 *
 * Usage : cd Yuki && npx tsx "../Yuki and Libs/_tools/e2e-timestamp-serve.ts"
 * Env :
 *   YUKI_E2E_TIME_DIR  dossier d'état (OBLIGATOIRE).
 * Sortie : « READY http://127.0.0.1:<port> » puis reste vivant.
 */

import { createServer as createHttpServer } from "node:http";
import { mkdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { loadEnv } from "../../src/config/env.js";
import { createApp, type AppContext } from "../../src/gateway/app.js";
import { createWsTransport } from "../../src/gateway/ws/server.js";
import { createLogger } from "../../src/observability/logger.js";
import { createPiHost } from "../../src/pi/host.js";
import type { GpuReport } from "../../src/types/gpu.js";

const stateDir = process.env.YUKI_E2E_TIME_DIR;
if (!stateDir) throw new Error("YUKI_E2E_TIME_DIR requis");
const agentDir = join(stateDir, "agent");
const cwd = join(stateDir, "workspace");
const sessionsDir = join(agentDir, "sessions");
for (const dir of [agentDir, cwd, sessionsDir]) mkdirSync(dir, { recursive: true });

const USAGE = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(text: string, ts: number): Record<string, unknown> {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test",
    provider: "test",
    model: "test",
    usage: USAGE,
    stopReason: "stop",
    timestamp: ts,
  };
}

/** Message utilisateur STOCKÉ avec son préfixe d'horodatage (comme en production). */
function user(stamp: string, text: string, ts: number): Record<string, unknown> {
  return {
    role: "user",
    content: `[horodatage] ${stamp} (heure locale) ${text}`,
    timestamp: ts,
  };
}

/**
 * Écrit une session JSONL PERSISTÉE puis FIGE sa mtime sur sa DERNIÈRE
 * activité (le plus récent des horodatages de messages), comme en production
 * où le fichier est écrit quand le message arrive.
 *
 * ⚠️ Sans ce figeage, les deux fils seedés dans la même milliseconde (fréquent :
 * 6 puis 2 écritures consécutives) ont des mtime quasi ÉGAUX. Or l'activation
 * au démarrage passe par `SessionManager.continueRecent` → `findMostRecentSession`,
 * qui trie par **mtime de fichier** (et non par horodatage de message). Le fil B
 * écrit en SECOND gagnait alors quand l'horloge avançait entre les deux seeds ⇒
 * le harnais croyait être sur le fil A alors qu'il affichait B.
 * En figant la mtime sur la dernière activité, l'ordre redevient EXPLICITE et
 * cohérent avec la liste (`updatedAt` = horodatage de message) : A est le plus
 * récent selon les DEUX critères, quel que soit le rythme de l'horloge.
 */
function seed(entries: Array<Record<string, unknown>>): string {
  const manager = SessionManager.create(cwd, sessionsDir);
  for (const entry of entries) manager.appendMessage(entry as never);
  const file = manager.getSessionFile();
  if (file) {
    const lastActivity = entries.reduce((max, entry) => {
      const ts = typeof entry.timestamp === "number" ? entry.timestamp : 0;
      return ts > max ? ts : max;
    }, 0);
    // mtime en SECONDES : le plus récent des messages de ce fil.
    utimesSync(file, lastActivity / 1000, lastActivity / 1000);
  }
  return manager.getSessionId();
}

const at = (iso: string): number => Date.parse(iso);

// Fil A — DEUX jours (2026-10-07 puis 2026-10-08) : DEUX séparateurs attendus,
// dont deux messages le MÊME jour (aucun séparateur entre eux).
seed([
  user("2026-10-07 15:39", "Première question du fil A", at("2026-10-07T15:39:00Z")),
  assistant("Première réponse du fil A", at("2026-10-07T15:41:00Z")),
  user("2026-10-07 16:12", "Deuxième question, même jour", at("2026-10-07T16:12:00Z")),
  assistant("Deuxième réponse, même jour", at("2026-10-07T16:14:00Z")),
  user("2026-10-08 09:05", "Question du lendemain", at("2026-10-08T09:05:00Z")),
  assistant("Réponse du lendemain", at("2026-10-08T09:07:00Z")),
]);

// Fil B — autre jour, plus ANCIEN (le fil A reste le plus récent = actif).
seed([
  user("2026-10-01 10:30", "Question du fil B", at("2026-10-01T10:30:00Z")),
  assistant("Réponse du fil B", at("2026-10-01T10:31:00Z")),
]);

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

const transport = createWsTransport({
  host,
  logger,
  serverVersion: "e2e-0.1.0",
  replayBufferSize: 1000,
  replayBufferBytes: 1_000_000,
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
