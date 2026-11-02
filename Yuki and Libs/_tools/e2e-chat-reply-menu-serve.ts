/**
 * Harnais E2E JETABLE — gateway RÉEL, mode DISTANT, UN canal miroir dans le miroir
 * persisté : sert à prouver le menu contextuel « réglages de réponse » (quand /
 * comment / citer) sans aucun serveur Mattermost.
 *
 * Usage : cd Yuki && npx tsx "../Yuki and Libs/_tools/e2e-chat-reply-menu-serve.ts"
 * Env :
 *   YUKI_E2E_CHAT_DIR  dossier d'état (OBLIGATOIRE).
 * Sortie : « READY http://127.0.0.1:<port> » puis reste vivant.
 */

import { createServer as createHttpServer } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { loadEnv } from "../../src/config/env.js";
import { createApp, type AppContext } from "../../src/gateway/app.js";
import { createWsTransport } from "../../src/gateway/ws/server.js";
import type { ChatMattermostPort } from "../../src/gateway/routes/chat.js";
import { createLogger } from "../../src/observability/logger.js";
import { createPiHost } from "../../src/pi/host.js";
import { ChatMirrorStore, ChatService } from "../../src/chat/index.js";
import type { GpuReport } from "../../src/types/gpu.js";

const stateDir = process.env.YUKI_E2E_CHAT_DIR;
if (!stateDir) throw new Error("YUKI_E2E_CHAT_DIR requis");
const agentDir = join(stateDir, "agent");
const cwd = join(stateDir, "workspace");
const sessionsDir = join(agentDir, "sessions");
for (const dir of [agentDir, cwd, sessionsDir]) mkdirSync(dir, { recursive: true });

/** Une session locale minimale : la page doit pouvoir s'ouvrir sans elle aussi. */
const manager = SessionManager.create(cwd, sessionsDir);
manager.appendMessage({ role: "user", content: "Bonjour", timestamp: Date.now() });

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
const env = loadEnv({ YUKI_GPU_FIXTURE: "tests/fixtures/gpu/rtx4070-12g.txt", YUKI_LOG_LEVEL: "error" });

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

/* ─── Miroir RÉEL : un canal Mattermost suivi, deux messages ───────────── */
const chatMirror = ChatMirrorStore.open({
  indexPath: join(stateDir, "chat-mirror.json"),
  messagesDir: join(stateDir, "chat-mirror"),
  logger,
});
const CHANNEL = "canal-e2e";
const CONVERSATION = `mm-${CHANNEL}`;
chatMirror.setBaseUrl("https://mattermost.exemple.fr");
// ⚠️ `YUKI_E2E_CHAT_VIDE=1` : miroir SANS aucun canal. Sert à prouver le SECOND
// sens de l'encart de la barre latérale (liste VIDE ⇒ l'encart d'échec parle, et
// dit POURQUOI) sans le confondre avec « aucun canal synchronisé ».
if (process.env.YUKI_E2E_CHAT_VIDE !== "1") {
  chatMirror.ensureConversation({
    conversationId: CONVERSATION,
    platform: "mattermost",
    remoteId: CHANNEL,
    title: "Général",
  });
  chatMirror.upsert({
    remoteId: "p1",
    conversationId: CONVERSATION,
    author: { id: "humain-1", nom: "Camille", estBot: false },
    role: "user",
    text: "Bonjour Yuki, peux-tu regarder la capture ?",
    sentAt: "2026-11-01T10:00:00.000Z",
  });
}

/** Service de discussion : il lit le miroir, ne décide de rien. */
const chatService = new ChatService({
  mode: () => "mattermost",
  remoteAgents: () => "desactive",
  mirror: chatMirror,
});

/** Port Mattermost de la page `/config` (aucun jeton ici : rien n'est configuré). */
const mattermostPort: ChatMattermostPort = {
  baseUrl: () => chatMirror.baseUrl(),
  tokenConfigured: () => false,
  saveBaseUrl: (url) => chatMirror.setBaseUrl(url),
  saveToken: () => undefined,
  connect: async () => undefined,
  view: () => {
    const canaux = Object.entries(chatMirror.records())
      .filter(([, record]) => record.platform === "mattermost")
      .map(([id, record]) => ({
        id,
        titre: record.title,
        messageCount: record.messageCount,
        ...(record.replyMode !== undefined ? { replyMode: record.replyMode } : {}),
        // ⚠️ Valeurs EFFECTIVES (défauts appliqués) : c'est ce que l'interface coche.
        replyStyle: record.replyStyle ?? "fil",
        quoteAuthor: record.quoteAuthor ?? "non",
        backfillFait: record.backfillDone,
        historiqueAnterieur: false,
      }));
    return {
      url: chatMirror.baseUrl(),
      jetonEnregistre: false,
      plateforme: { etat: "connexion" },
      synchronisation: {
        demarre: true,
        canauxSuivis: canaux.length,
        backfill: { fait: true, imports: 1, borneAtteinte: false },
        rattrapageActif: true,
      },
      canaux,
    };
  },
  replySettings: (conversationId) => {
    const record = chatMirror.record(conversationId);
    if (!record) return undefined;
    return {
      ...(record.replyMode !== undefined ? { replyMode: record.replyMode } : {}),
      replyStyle: record.replyStyle ?? "fil",
      quoteAuthor: record.quoteAuthor ?? "non",
    };
  },
  applyReplySettings: (conversationId, patch) => chatMirror.setReplySettings(conversationId, patch),
};

const transport = createWsTransport({
  host,
  logger,
  serverVersion: "e2e-0.1.0",
  replayBufferSize: 1000,
  replayBufferBytes: 1_000_000,
  // ⚠️ Le transport ne parle à AUCUNE plateforme : il ne lit que le service.
  chat: {
    mode: () => "mattermost",
    isRemote: () => true,
    creationRefusal: () => "La création est désactivée en mode distant.",
    conversations: () => chatMirror.conversations(),
    conversation: (conversationId) =>
      chatMirror.conversations().find((item) => item.id === conversationId) ?? null,
    messages: (conversationId) => chatMirror.messages(conversationId),
    subscribe: (listener) => chatMirror.onChange(listener),
  },
});

const context: AppContext = {
  env,
  report: {} as GpuReport,
  gatePassed: true,
  startedAt: Date.now(),
  volumes: [],
  publicDir: "public/ui",
  chat: { service: chatService, mattermost: mattermostPort, logger },
};

const server = createHttpServer(createApp(context));
transport.attach(server);
server.listen(0, "127.0.0.1", () => {
  const address = server.address() as AddressInfo;
  console.log(`READY http://127.0.0.1:${address.port}`);
});
setInterval(() => {}, 1 << 30);
