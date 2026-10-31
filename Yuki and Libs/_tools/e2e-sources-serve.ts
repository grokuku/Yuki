/**
 * Harnais E2E JETABLE — SOURCES + section « Notifications » de la page `/`.
 *
 * Monte un gateway RÉEL avec :
 *   - le domaine `src/sources` câblé (stores sur un dossier temporaire, coffre
 *     avec une clé de test) ;
 *   - un host Pi RÉEL (les conversations existent, la bascule `switch` marche)
 *     enveloppé par un « waker de démonstration » : `send` émet une VRAIE
 *     séquence `delta` puis `run_finished`, ce qui permet d'observer l'état
 *     `traite` et la réponse attachée à l'entrée, sans aucun modèle ;
 *   - deux sources de démonstration : `veille` (lancer un tour DANS UN FIL
 *     DÉSIGNÉ, choisi comme le ferait `/config` → Sources) et `mail` (stocker) ;
 *   - une conversation de travail créée au démarrage : elle sert de destination
 *     désignée, et c'est elle que la modale de suppression prendra pour cible.
 *
 * Usage : cd Yuki && npx tsx "../Yuki and Libs/_tools/e2e-sources-serve.ts"
 * Env :
 *   YUKI_E2E_DIR   dossier d'état (OBLIGATOIRE).
 * Sortie : « READY http://127.0.0.1:<port> » puis reste vivant.
 *
 * ⚠️ Routes `/api/e2e/*` : JETABLES, jamais montées en production.
 */

import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { WebSocket } from "ws";

import { loadEnv } from "../../src/config/env.js";
import { createConfigRuntime } from "../../src/config/runtime.js";
import { createApp, type AppContext } from "../../src/gateway/app.js";
import { createWsTransport } from "../../src/gateway/ws/server.js";
import { createLogger } from "../../src/observability/logger.js";
import { createPiHost } from "../../src/pi/host.js";
import { SessionPinStore } from "../../src/pi/session-pins.js";
import { SecretStore } from "../../src/secrets/store.js";
import { SourcesInbox } from "../../src/sources/inbox.js";
import { SourcesService, type SourcesHostEvent, type SourcesWaker } from "../../src/sources/service.js";
import { SourcesStore } from "../../src/sources/store.js";
import { sourceTokenName } from "../../src/sources/types.js";
import type { GpuReport } from "../../src/types/gpu.js";

const stateDir = process.env.YUKI_E2E_DIR;
if (!stateDir) throw new Error("YUKI_E2E_DIR requis");
const agentDir = join(stateDir, "agent");
const cwd = join(stateDir, "workspace");
const sessionsDir = join(agentDir, "sessions");
for (const dir of [agentDir, cwd, sessionsDir]) mkdirSync(dir, { recursive: true });

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
const env = loadEnv({ YUKI_GPU_FIXTURE: "tests/fixtures/gpu/rtx4070-12g.txt", YUKI_LOG_LEVEL: "error" });
const config = createConfigRuntime({
  env,
  promptDefaults: { light: "systeme leger", heavy: "systeme lourd" },
});

// --- Coffre (clé de TEST) : les jetons de sources y vivent -------------------
const vault = new SecretStore({
  path: join(stateDir, "secrets.vault"),
  key: "cle-de-test-e2e-sources-uniquement",
  logger,
});

// --- Hôte Pi RÉEL (aucun appel modèle n'est fait dans ce harnais) -----------
const host = createPiHost({
  agentDir,
  cwd,
  home: join(stateDir, "home"),
  sessionsDir,
  systemPrompt: "# Yuki\n\nAssistant de test E2E (sources).\n",
  settingsSeedPath: "config/pi/settings.json",
  logger,
});
await host.start();

/**
 * Waker de DÉMONSTRATION : délègue les sessions au host réel (pour que la bascule
 * `switch` de l'interface fonctionne) mais SIMULE la réponse d'un tour de source,
 * afin d'observer `etat: "traite"` + `reponse` dans l'entrée.
 */
class DemoWaker implements SourcesWaker {
  private listeners = new Set<(event: SourcesHostEvent) => void>();
  readonly sends: Array<{ sessionId: string; text: string }> = [];
  /** Conversations créées par « Continuer dans une conversation ». */
  created = 0;

  currentSessionId(): string | undefined {
    return host.currentSessionId();
  }

  send(sessionId: string, text: string): { runId: string; sessionId: string } {
    const runId = `e2e-run-${this.sends.length + 1}`;
    this.sends.push({ sessionId, text });
    const reply =
      "Résumé de démonstration : trois articles, rien d'anormal à signaler.";
    setTimeout(() => {
      for (const chunk of reply.split(" ")) {
        this.emit({ type: "delta", sessionId, runId, channel: "content", text: `${chunk} ` });
      }
      this.emit({ type: "run_finished", sessionId, runId, reason: "done" });
    }, 250);
    return { runId, sessionId };
  }

  subscribeAll(listener: (event: SourcesHostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: SourcesHostEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  async newSession(): Promise<{ sessionId: string }> {
    this.created += 1;
    return host.newSession();
  }

  async renameSession(id: string, title: string): Promise<void> {
    await host.renameSession(id, title);
  }

  async resume(sessionFile: string): Promise<{ sessionId: string }> {
    return host.resume(sessionFile);
  }

  async sessionFileFor(id: string): Promise<string | undefined> {
    return host.sessionFileFor(id);
  }

  /** Conversations EXISTANTES : sélecteur « Envoyer dans : » + vérification ④. */
  async listSessions(): Promise<Array<{ sessionId: string; title?: string; updatedAt?: string }>> {
    const list = await host.listSessions();
    return list.map((info) => ({
      sessionId: info.sessionId,
      ...(info.title ? { title: info.title } : {}),
      ...(info.updatedAt ? { updatedAt: info.updatedAt } : {}),
    }));
  }
}

const waker = new DemoWaker();
const sourcesStore = new SourcesStore({ path: join(stateDir, "sources.json"), logger });
const sourcesInbox = new SourcesInbox({ path: join(stateDir, "sources-inbox.json"), logger });
const sourcesService = new SourcesService({
  store: sourcesStore,
  inbox: sourcesInbox,
  logger,
  tokens: vault,
  promptTotalChars: () => config.getNumber("sources.promptTotalChars"),
});
sourcesService.setWaker(waker);

/**
 * Conversation de TRAVAIL : la destination que l'utilisateur désignerait dans
 * `/config` → Sources (« Envoyer dans : »). Elle est créée AVANT les sources et
 * apparaît dans la liste des conversations comme n'importe quel fil.
 */
const workSession = await host.newSession();
await host.renameSession(workSession.sessionId, "Conversation de travail");
const WORK_SESSION = workSession.sessionId;

/** Sources de démonstration (jetons stables pour le scénario). */
function declare(
  nom: string,
  settings: { tour: "lancer" | "stocker"; conversation: string; consigne: string },
): void {
  if (!sourcesStore.has(nom)) {
    sourcesStore.create(nom, settings);
    vault.set(sourceTokenName(nom), `jeton-${nom}-e2e`, `Jeton E2E de ${nom}`);
  }
}
// `veille` : destination DÉSIGNÉE explicitement (⚠️ le programme extérieur, lui,
// n'envoie que `lancer` — c'est la CONFIGURATION qui porte le fil).
declare("veille", {
  tour: "lancer",
  conversation: WORK_SESSION,
  consigne: "si rien d'anormal, ne dis rien",
});
// `mail` : aucune destination (elle stocke) — elle sert à la boîte et au compteur.
declare("mail", {
  tour: "stocker",
  conversation: "aucune",
  consigne: "préviens-moi seulement si le message est urgent",
});

// --- Transport WS (la page de discussion doit vivre normalement) -----------
const transport = createWsTransport({
  host,
  logger,
  serverVersion: "e2e-0.1.0",
  replayBufferSize: 1000,
  replayBufferBytes: 1_000_000,
  pins: SessionPinStore.open({ path: join(stateDir, "session-pins.json"), logger }),
  // SOURCES : marquage des fils (modale de suppression) et réaffectation réelle
  // des sources quand un fil qu'elles alimentent est supprimé.
  sources: sourcesService,
});

const context: AppContext = {
  env,
  report: {} as GpuReport,
  gatePassed: true,
  startedAt: Date.now(),
  volumes: [],
  publicDir: "public/ui",
  config: { runtime: config, logger },
  sources: { service: sourcesService, logger },
};

const app = createApp(context);

/** Socket factice : satisfait une signature d'agent (aucun agent ici). */
function fakeAgentSocket(): WebSocket {
  const socket = new EventEmitter() as unknown as EventEmitter & { readyState: number };
  socket.readyState = 1;
  (socket as unknown as { send: () => boolean }).send = () => true;
  (socket as unknown as { close: () => void }).close = () => socket.emit("close", 1000);
  return socket as unknown as WebSocket;
}
void fakeAgentSocket;

const server = createHttpServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/api/e2e/sources-state") {
    // Diagnostic du scénario : combien de conversations ont été CRÉÉES, combien
    // d'envois le waker a vus, l'état des sources (destination) et des entrées
    // (état / réponse / note). Aucun contenu de notification n'est exposé au-delà
    // de ce que l'API réelle rend déjà.
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        created: waker.created,
        sends: waker.sends.map((send) => ({ sessionId: send.sessionId })),
        workSession: WORK_SESSION,
        sources: sourcesStore.list().map((record) => ({
          nom: record.nom,
          conversation: record.conversation,
          sessionId: record.sessionId ?? null,
        })),
        entries: sourcesInbox.size,
        nonLus: sourcesInbox.unreadCount(),
        inbox: sourcesInbox.list().map((entry) => ({
          id: entry.id,
          source: entry.source,
          etat: entry.etat,
          titre: entry.titre,
          texte: entry.texte,
          ...(entry.reponse ? { reponse: entry.reponse } : {}),
          ...(entry.note ? { note: entry.note } : {}),
        })),
      }),
    );
    return;
  }
  app(req, res);
});
transport.attach(server);
server.listen(0, "127.0.0.1", () => {
  const address = server.address() as AddressInfo;
  console.log(`READY http://127.0.0.1:${address.port}`);
});
setInterval(() => {}, 1 << 30);
