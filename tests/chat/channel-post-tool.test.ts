/**
 * PUBLICATION INTER-CANAL — `publier_dans_canal` (décision A, 2026-11-02).
 *
 * Ce que ce fichier prouve :
 *  - un canal SUIVI reçoit le message (nom lisible OU identifiant), et l'identifiant
 *    transmis est bien celui de CE canal (jamais un autre) ;
 *  - un canal NON SUIVI est refusé EXPLICITEMENT (message actionnable), ZÉRO envoi ;
 *  - un canal d'une AUTRE plateforme (`dc-…` depuis Mattermost) est refusé, ZÉRO envoi ;
 *  - un texte trop long est TRONQUÉ EN LE DISANT (limites réutilisées de Mattermost et
 *    de Discord), jamais un échec silencieux ;
 *  - publier dans un FIL (`root_id`) fonctionne, et un fil inconnu est refusé ;
 *  - l'outil est dans `REMOTE_SAFE_TOOLS`, disponible sous `chat.remoteAgents =
 *    desactive`, et JAMAIS dans `APPROVAL_REQUIRED_TOOLS` (aucune validation à donner) ;
 *  - le message publié revient par le WebSocket, il est ingéré (`estBot`), et il ne
 *    déclenche AUCUNE réponse (anti-boucle) — vérifié contre un vrai serveur fixture.
 *
 * ⚠️ Échoue sur le code d'origine : ni `src/chat/reply/channel-post.ts` ni
 * `src/pi/sdk/channel-post-tool.ts` n'existaient — Yuki répondait donc qu'une
 * « validation humaine » était nécessaire, ce qui était faux.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import {
  CANAL_AUTRE_PLATEFORME_RAISON,
  CANAL_NON_SUIVI_RAISON,
  createChannelPostPort,
  resoudreCanal,
} from "../../src/chat/index.js";
import { MM_DEFAULT_MAX_POST_CHARS } from "../../src/chat/mattermost/adapter.js";
import { DISCORD_MAX_CONTENT_CHARS } from "../../src/chat/discord/types.js";
import { MattermostChatAdapter } from "../../src/chat/mattermost/adapter.js";
import { ChatMirrorStore } from "../../src/chat/mirror/store.js";
import { conversationIdOfChannel } from "../../src/chat/mirror/ingest.js";
import { createChannelPostTool } from "../../src/pi/sdk/channel-post-tool.js";
import { createRemoteRunTools } from "../../src/pi/index.js";
import { APPROVAL_REQUIRED_TOOLS, REMOTE_SAFE_TOOLS } from "../../src/llm/index.js";

const TOKEN = "jeton-bot-secret-0123456789";
const BOT_ID = "botidentifiant0123456789ab";
const GENERAL = conversationIdOfChannel("canal-general");
const IMAGERIE = conversationIdOfChannel("canal-imagerie");
const DISCORD_SALON = "dc-salon-1";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type HostTool = ReturnType<typeof createChannelPostTool>[number];

async function callTool(
  tool: HostTool,
  params: Record<string, unknown>,
): Promise<{ text: string; details: Record<string, unknown> }> {
  const fn = tool.execute as unknown as (
    id: string,
    values: unknown,
    signal: undefined,
    onUpdate: undefined,
    ctx: undefined,
  ) => Promise<{ content: { type: string; text: string }[]; details: Record<string, unknown> }>;
  const result = await fn("call-1", params, undefined, undefined, undefined);
  return { text: result.content.map((part) => part.text).join(""), details: result.details };
}

const CANAUX = [
  { conversationId: GENERAL, titre: "Général", plateforme: "mattermost" },
  { conversationId: IMAGERIE, titre: "L'Imagerie", plateforme: "mattermost" },
  { conversationId: DISCORD_SALON, titre: "général-discord", plateforme: "discord" },
];

interface Envoi {
  conversationId: string;
  texte: string;
  filDe?: string;
}

function portEspion(options: { filConnu?: boolean } = {}) {
  const envois: Envoi[] = [];
  const port = createChannelPostPort({
    plateforme: "mattermost",
    canaux: () => CANAUX,
    envoyer: async (input) => {
      envois.push(input);
    },
    ...(options.filConnu !== undefined
      ? { filConnu: () => options.filConnu === true }
      : {}),
  });
  return { port, envois };
}

describe("port de publication — périmètre (canaux SUIVIS)", () => {
  it("publie dans un canal suivi désigné par son NOM lisible", async () => {
    const { port, envois } = portEspion();
    const outcome = await port.publier({ canal: "l'imagerie", texte: "Voici le rendu." });
    expect(outcome).toEqual({
      ok: true,
      conversationId: IMAGERIE,
      titre: "L'Imagerie",
      tronque: false,
    });
    expect(envois).toEqual([{ conversationId: IMAGERIE, texte: "Voici le rendu." }]);
  });

  it("accepte aussi l'IDENTIFIANT (et ne confond pas deux canaux)", async () => {
    const { port, envois } = portEspion();
    const outcome = await port.publier({ canal: GENERAL, texte: "bonjour" });
    expect(outcome.ok).toBe(true);
    expect(envois[0]?.conversationId).toBe(GENERAL);
  });

  it("canal NON suivi ⇒ refus explicite, AUCUN envoi", async () => {
    const { port, envois } = portEspion();
    const outcome = await port.publier({ canal: "Canal inconnu", texte: "bonjour" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("attendu : refus");
    expect(outcome.raison).toContain("pas suivi");
    expect(outcome.raison).toContain("Configuration → Discussions");
    // La liste réelle est rendue : le modèle propose le bon canal au lieu d'en inventer un.
    expect(outcome.canaux?.map((canal) => canal.titre)).toEqual(["Général", "L'Imagerie"]);
    expect(envois).toHaveLength(0);
  });

  it("canal d'une AUTRE plateforme ⇒ refus explicite, AUCUN envoi", async () => {
    const { port, envois } = portEspion();
    const outcome = await port.publier({ canal: DISCORD_SALON, texte: "bonjour" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("attendu : refus");
    expect(outcome.raison).toBe(CANAL_AUTRE_PLATEFORME_RAISON);
    // Un nom qui n'existe que côté Discord est aussi refusé (il n'est pas dans la liste).
    const parNom = await port.publier({ canal: "général-discord", texte: "bonjour" });
    expect(parNom.ok).toBe(false);
    expect(envois).toHaveLength(0);
  });

  it("ambiguïté de nom ⇒ refus (jamais un choix silencieux)", () => {
    const canaux = [
      { conversationId: "mm-a", titre: "Atelier", plateforme: "mattermost" },
      { conversationId: "mm-b", titre: "Atelier", plateforme: "mattermost" },
    ];
    const resolution = resoudreCanal(canaux, "atelier");
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error("attendu : ambigu");
    expect(resolution.raison).toContain("Plusieurs canaux");
    expect(CANAL_NON_SUIVI_RAISON).toContain("Configuration → Discussions");
  });

  it("texte trop long ⇒ TRONQUÉ en le disant (limite Mattermost réutilisée)", async () => {
    const { port, envois } = portEspion();
    const long = "a".repeat(MM_DEFAULT_MAX_POST_CHARS + 500);
    const outcome = await port.publier({ canal: "Général", texte: long });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("attendu : publication");
    expect(outcome.tronque).toBe(true);
    const envoye = envois[0]?.texte ?? "";
    expect([...envoye].length).toBeLessThanOrEqual(MM_DEFAULT_MAX_POST_CHARS);
    expect(envoye).toContain("message tronqué");
  });

  it("publie DANS UN FIL quand le message racine existe, refuse un fil inconnu", async () => {
    const ok = portEspion({ filConnu: true });
    const dedans = await ok.port.publier({
      canal: "L'Imagerie",
      texte: "dans le fil",
      filDe: "post-racine",
    });
    expect(dedans.ok).toBe(true);
    expect(ok.envois[0]?.filDe).toBe("post-racine");

    const ko = portEspion({ filConnu: false });
    const refus = await ko.port.publier({
      canal: "L'Imagerie",
      texte: "dans le fil",
      filDe: "post-fantome",
    });
    expect(refus.ok).toBe(false);
    expect(ko.envois).toHaveLength(0);
  });

  it("l'échec d'envoi est VISIBLE (jamais un succès silencieux)", async () => {
    const port = createChannelPostPort({
      plateforme: "mattermost",
      canaux: () => CANAUX,
      envoyer: async () => {
        throw new Error("le serveur a refusé (403)");
      },
    });
    const outcome = await port.publier({ canal: "Général", texte: "bonjour" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("attendu : refus");
    expect(outcome.raison).toContain("L'envoi a échoué");
    expect(outcome.raison).toContain("403");
  });

  it("la borne Discord (2 000) est appliquée sur la plateforme Discord", async () => {
    const envois: Envoi[] = [];
    const port = createChannelPostPort({
      plateforme: "discord",
      canaux: () => CANAUX,
      envoyer: async (input) => {
        envois.push(input);
      },
    });
    const outcome = await port.publier({ canal: DISCORD_SALON, texte: "b".repeat(2_500) });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("attendu : publication");
    expect(outcome.tronque).toBe(true);
    expect([...(envois[0]?.texte ?? "")].length).toBeLessThanOrEqual(DISCORD_MAX_CONTENT_CHARS);
  });
});

describe("outil `publier_dans_canal` — politique d'outils", () => {
  it("est dans REMOTE_SAFE_TOOLS, jamais dans les outils à approbation", () => {
    expect(REMOTE_SAFE_TOOLS).toContain("publier_dans_canal");
    expect(APPROVAL_REQUIRED_TOOLS).not.toContain("publier_dans_canal");
  });

  it("est CONSTRUIT même sous `chat.remoteAgents = desactive`", () => {
    const { port } = portEspion();
    const run = createRemoteRunTools({
      conversationId: GENERAL,
      chatMode: "mattermost",
      remoteAgents: false,
      lightOptions: () => ({}),
      channels: port,
    });
    const noms = run.customTools.map((tool) => (tool as { name?: string }).name);
    expect(run.tools).toContain("publier_dans_canal");
    expect(noms).toContain("publier_dans_canal");
  });

  it("liste les canaux disponibles quand `canal` est omis, et refuse proprement", async () => {
    const { port, envois } = portEspion();
    const tool = createChannelPostTool(port)[0]!;
    expect(tool.name).toBe("publier_dans_canal");

    const liste = await callTool(tool, {});
    expect(liste.text).toContain("L'Imagerie");
    expect(liste.text).toContain(IMAGERIE);

    const refus = await callTool(tool, { canal: "Nulle part", texte: "bonjour" });
    expect(refus.text).toContain("Rien n'a été publié");
    expect(refus.text).toContain("pas suivi");
    expect(refus.details.status).toBe("refus");

    const vide = await callTool(tool, { canal: "Général", texte: "   " });
    expect(vide.text).toContain("texte du message est vide");
    expect(envois).toHaveLength(0);
  });

  it("le prompt de l'outil interdit d'inventer une validation", () => {
    const { port } = portEspion();
    const tool = createChannelPostTool(port)[0]!;
    expect(tool.description).toContain("AUCUNE validation");
    expect(tool.description).toContain("n'invente");
  });
});

// ─── Bout en bout : vrai serveur Mattermost, vrai WebSocket ─────────────────

interface Fixture {
  baseUrl: string;
  created: Array<Record<string, unknown>>;
  broadcast(event: string, post: Record<string, unknown>): void;
}

async function startFixture(): Promise<Fixture> {
  const created: Array<Record<string, unknown>> = [];

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/api/v4/users/me") {
      send({ id: BOT_ID, username: "yuki", first_name: "Yuki" });
      return;
    }
    if (url.pathname === "/api/v4/users/me/teams") {
      send([{ id: "equipe-1", name: "holaf" }]);
      return;
    }
    if (url.pathname === "/api/v4/users/me/teams/equipe-1/channels") {
      send([
        { id: "canal-general", display_name: "Général", type: "O" },
        { id: "canal-imagerie", display_name: "L'Imagerie", type: "O" },
      ]);
      return;
    }
    if (url.pathname.startsWith("/api/v4/channels/") && url.pathname.endsWith("/posts")) {
      send({ order: [], posts: {} });
      return;
    }
    if (url.pathname === "/api/v4/users/ids") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const ids = JSON.parse(Buffer.concat(chunks).toString("utf8") || "[]") as string[];
        send(ids.map((id) => ({ id, username: id === BOT_ID ? "yuki" : `nom-${id}` })));
      });
      return;
    }
    if (url.pathname === "/api/v4/posts") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<
          string,
          unknown
        >;
        created.push(body);
        send({
          id: `envoye-${created.length}`,
          channel_id: body.channel_id,
          user_id: BOT_ID,
          message: body.message,
          root_id: body.root_id,
          create_at: 1_700_000_000_000 + created.length,
        });
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "inconnu" }));
  });

  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket: WebSocket) => {
    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw)) as { action?: string; data?: { token?: string } };
      if (frame.action !== "authentication_challenge" || frame.data?.token !== TOKEN) {
        socket.send(JSON.stringify({ status: "FAIL", seq_reply: 1, error: { id: "denied" } }));
        return;
      }
      socket.send(JSON.stringify({ status: "OK", seq_reply: 1 }));
      socket.send(JSON.stringify({ event: "hello", data: { server_version: "10.0.0" }, seq: 1 }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  cleanups.push(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    created,
    broadcast(event, post) {
      const payload = JSON.stringify({ event, data: { post: JSON.stringify(post) }, seq: 2 });
      for (const client of wss.clients) {
        if (client.readyState === client.OPEN) client.send(payload);
      }
    },
  };
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const debut = Date.now();
  while (Date.now() - debut < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Délai dépassé en attendant : ${label}`);
}

describe("bout en bout — publication réelle et anti-boucle", () => {
  it("le message part avec le BON `channel_id`, et le retour WebSocket ne répond PAS", async () => {
    const fixture = await startFixture();
    const root = mkdtempSync(join(tmpdir(), "yuki-channel-post-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const store = ChatMirrorStore.open({
      indexPath: join(root, "chat-mirror.json"),
      messagesDir: join(root, "chat-mirror"),
    });
    const adapter = new MattermostChatAdapter({
      baseUrl: () => fixture.baseUrl,
      token: () => TOKEN,
      store,
      pollIntervalMs: 0,
    });
    cleanups.push(() => adapter.disconnect());
    await adapter.connect();
    await waitFor(() => adapter.status().etat === "on", "la connexion temps réel");
    // Mode `tout` : si l'anti-boucle ne tenait pas, la publication déclencherait une réponse.
    store.setReplyMode(GENERAL, "tout");
    store.setReplyMode(IMAGERIE, "tout");

    const port = createChannelPostPort({
      plateforme: "mattermost",
      canaux: () =>
        store.conversations().map((conversation) => ({
          conversationId: conversation.id,
          titre: conversation.title,
          plateforme: conversation.platform,
        })),
      envoyer: async ({ conversationId, texte, filDe }) => {
        await adapter.send(conversationId, {
          kind: "texte",
          text: texte,
          ...(filDe !== undefined ? { threadRootId: filDe } : {}),
        });
      },
    });
    const tool = createChannelPostTool(port)[0]!;

    const resultat = await callTool(tool, { canal: "L'Imagerie", texte: "Le chat roux est prêt." });
    expect(resultat.details.status).toBe("publie");
    expect(fixture.created).toHaveLength(1);
    // ⚠️ Le message part vers LE CANAL DEMANDÉ (et pas la conversation courante).
    expect(fixture.created[0]?.channel_id).toBe("canal-imagerie");
    expect(fixture.created[0]?.message).toBe("Le chat roux est prêt.");

    // ② Le serveur rediffuse le post publié (auteur = bot) : il revient dans le miroir…
    fixture.broadcast("posted", {
      id: "envoye-1",
      channel_id: "canal-imagerie",
      user_id: BOT_ID,
      message: "Le chat roux est prêt.",
      create_at: 1_700_000_000_500,
    });
    await waitFor(
      () => store.message(IMAGERIE, "envoye-1") !== undefined,
      "l'ingestion du message publié",
    );
    const revenu = store.message(IMAGERIE, "envoye-1");
    expect(revenu?.author.estBot).toBe(true);
    expect(revenu?.role).toBe("assistant");

    // ③ …et il ne produit AUCUNE réponse, même en mode `tout`.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(fixture.created).toHaveLength(1);
  });
});
