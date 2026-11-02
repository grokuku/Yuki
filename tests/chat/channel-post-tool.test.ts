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
  CHANNEL_POST_MAX_FILES,
  FICHIER_AUTRE_CONVERSATION_RAISON,
  FICHIER_AUTRE_PLATEFORME_RAISON,
  createChannelPostPort,
  resoudreCanal,
} from "../../src/chat/index.js";
import { MM_DEFAULT_MAX_POST_CHARS } from "../../src/chat/mattermost/adapter.js";
import { DISCORD_MAX_CONTENT_CHARS } from "../../src/chat/discord/types.js";
import { MattermostChatAdapter } from "../../src/chat/mattermost/adapter.js";
import { FilesStore } from "../../src/files/index.js";
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

/** Identifiants de fichiers (forme du store : 32 hexadécimaux). */
/** PNG 1×1 valide (aucune I/O réseau). */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const ID_A = "a".repeat(32);
const ID_B = "b".repeat(32);
const ID_C = "c".repeat(32);
const ID_D = "d".repeat(32);
const ID_E = "e".repeat(32);
const ID_F = "f".repeat(32);
const ID_G = "0".repeat(32);
const ID_H = "1".repeat(32);
const ID_I = "9".repeat(32);
const ID_J = "8".repeat(32);

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
  fichierIds?: readonly string[];
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
    expect(outcome.raison).toContain("Configuration → Conversation");
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
    expect(CANAL_NON_SUIVI_RAISON).toContain("Configuration → Conversation");
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

// ─── Fichiers joints (`fichier_ids`) ────────────────────────────────────────

/** Faux store de fichiers : identifiant → { conversation, taille }. */
function fichiersFactices(
  entrees: Record<string, { sessionId?: string; name: string; bytes: number }>,
) {
  return (id: string) => entrees[id] ?? null;
}

function portAvecFichiers(
  entrees: Record<string, { sessionId?: string; name: string; bytes: number }>,
  options: { maxBytes?: number; source?: string } = {},
) {
  const envois: Envoi[] = [];
  const port = createChannelPostPort({
    plateforme: "mattermost",
    canaux: () => CANAUX,
    conversationSource: options.source ?? GENERAL,
    fichier: fichiersFactices(entrees),
    ...(options.maxBytes !== undefined ? { maxFichierBytes: () => options.maxBytes as number } : {}),
    envoyer: async (input) => {
      envois.push(input);
    },
  });
  return { port, envois };
}

describe("publication inter-canal — FICHIERS joints", () => {
  it("joint les fichiers demandés (identifiants du store) : la requête les porte", async () => {
    const { port, envois } = portAvecFichiers({
      [ID_A]: { sessionId: GENERAL, name: "chat.png", bytes: 70 },
    });
    const outcome = await port.publier({
      canal: "L'Imagerie",
      texte: "Voici le rendu.",
      fichierIds: [ID_A],
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("attendu : publication");
    expect(outcome.fichiers).toBe(1);
    expect(envois[0]?.fichierIds).toEqual([ID_A]);
  });

  it("SANS `fichierIds` : le message part en TEXTE SEUL (non-régression)", async () => {
    const { port, envois } = portAvecFichiers({});
    const outcome = await port.publier({ canal: "L'Imagerie", texte: "bonjour" });
    expect(outcome.ok).toBe(true);
    expect(envois[0]?.fichierIds).toBeUndefined();
  });

  it("fichier d'une AUTRE conversation ⇒ refus, ZÉRO requête", async () => {
    const { port, envois } = portAvecFichiers({
      [ID_B]: { sessionId: IMAGERIE, name: "ailleurs.png", bytes: 70 },
    });
    const outcome = await port.publier({
      canal: "L'Imagerie",
      texte: "Voici le rendu.",
      fichierIds: [ID_B],
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("attendu : refus");
    expect(outcome.raison).toBe(FICHIER_AUTRE_CONVERSATION_RAISON);
    expect(envois).toHaveLength(0);
  });

  it("fichier d'une AUTRE plateforme ⇒ refus (un fichier Mattermost ne part pas sur Discord)", async () => {
    const { port, envois } = portAvecFichiers({
      [ID_C]: { sessionId: DISCORD_SALON, name: "discord.png", bytes: 70 },
    });
    const outcome = await port.publier({
      canal: "L'Imagerie",
      texte: "Voici le rendu.",
      fichierIds: [ID_C],
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("attendu : refus");
    expect(outcome.raison).toBe(FICHIER_AUTRE_PLATEFORME_RAISON);
    expect(envois).toHaveLength(0);
  });

  it("fichier inconnu ou expiré ⇒ refus explicite, ZÉRO requête", async () => {
    const { port, envois } = portAvecFichiers({});
    const outcome = await port.publier({
      canal: "L'Imagerie",
      texte: "Voici le rendu.",
      fichierIds: [ID_D],
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("attendu : refus");
    expect(outcome.raison).toContain("introuvable ou expiré");
    expect(envois).toHaveLength(0);
  });

  it("PLUS DE TROIS fichiers ⇒ refus explicite (jamais une coupe silencieuse)", async () => {
    const entrees: Record<string, { sessionId?: string; name: string; bytes: number }> = {};
    for (const id of [ID_E, ID_F, ID_G, ID_H]) {
      entrees[id] = { sessionId: GENERAL, name: `${id.slice(0, 1)}.png`, bytes: 10 };
    }
    const { port, envois } = portAvecFichiers(entrees);
    const outcome = await port.publier({
      canal: "L'Imagerie",
      texte: "quatre fichiers",
      fichierIds: [ID_E, ID_F, ID_G, ID_H],
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("attendu : refus");
    expect(outcome.raison).toContain(String(CHANNEL_POST_MAX_FILES));
    expect(outcome.raison).toContain("Rien n'a été publié");
    expect(envois).toHaveLength(0);
  });

  it("fichier trop GROS ⇒ refus AVANT le réseau (un binaire ne se tronque pas)", async () => {
    const { port, envois } = portAvecFichiers(
      { [ID_I]: { sessionId: GENERAL, name: "enorme.png", bytes: 5_000 } },
      { maxBytes: 1_000 },
    );
    const outcome = await port.publier({
      canal: "L'Imagerie",
      texte: "trop gros",
      fichierIds: [ID_I],
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("attendu : refus");
    expect(outcome.raison).toContain("dépasse la taille maximale");
    expect(envois).toHaveLength(0);
  });

  it("l'OUTIL transmet `fichier_ids` au port et annonce les pièces jointes", async () => {
    const { port, envois } = portAvecFichiers({
      [ID_J]: { sessionId: GENERAL, name: "chat.png", bytes: 70 },
    });
    const tool = createChannelPostTool(port)[0]!;
    const resultat = await callTool(tool, {
      canal: "L'Imagerie",
      texte: "Voici le rendu.",
      fichier_ids: [ID_J],
    });
    expect(resultat.details.status).toBe("publie");
    expect(resultat.details.fichiers).toBe(1);
    expect(resultat.text).toContain("pièce");
    expect(envois[0]?.fichierIds).toEqual([ID_J]);
  });

  it("la DESCRIPTION de l'outil dit qu'il peut joindre des fichiers", () => {
    const { port } = portEspion();
    const tool = createChannelPostTool(port)[0]!;
    // ⚠️ Sans cette phrase, le modèle continue de répondre « je ne peux pas envoyer
    // l'image » : la capacité existe mais personne ne le sait.
    expect(tool.description).toContain("fichier_ids");
    expect(tool.description).toContain("trois fichiers au maximum");
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
    // ⚠️ Le refus couvre désormais les deux cas : ni texte ni fichier.
    expect(vide.text).toContain("ni texte ni fichier");
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
  /** Charge multipart de chaque `POST /files` (une entrée par fichier téléversé). */
  uploads: string[];
  broadcast(event: string, post: Record<string, unknown>): void;
}

async function startFixture(): Promise<Fixture> {
  const created: Array<Record<string, unknown>> = [];
  const uploads: string[] = [];

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
    if (url.pathname === "/api/v4/files") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        uploads.push(`${String(req.headers["content-type"] ?? "")}\n${Buffer.concat(chunks).toString("utf8")}`);
        res.writeHead(201, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            file_infos: [
              { id: `fichier-${uploads.length}`, name: "image-generee.png", size: 70, mime_type: "image/png" },
            ],
          }),
        );
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
    uploads,
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

describe("bout en bout — publication d'une IMAGE dans un autre canal", () => {
  it("le fichier part en MULTIPART (`POST /files`) puis le post porte `file_ids`", async () => {
    const fixture = await startFixture();
    const root = mkdtempSync(join(tmpdir(), "yuki-channel-post-files-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const store = ChatMirrorStore.open({
      indexPath: join(root, "chat-mirror.json"),
      messagesDir: join(root, "chat-mirror"),
    });
    // ⚠️ VRAI store de fichiers (sur disque) : l'adaptateur lève les octets par ce
    // port, exactement comme en production (`src/files/store.ts`).
    const files = new FilesStore({ dir: join(root, "files"), retentionDays: () => 30 });
    files.ensureLayout();
    const image = files.saveBytes(PNG, {
      name: "image-generee.png",
      mimeType: "image/png",
      origin: "yuki",
    });
    expect(image.ok).toBe(true);
    if (!image.ok) throw new Error("dépôt refusé");
    // Le fichier appartient à la conversation SOURCE (le canal d'où Yuki publie).
    expect(files.attach(image.record.id, GENERAL)).not.toBeNull();

    const adapter = new MattermostChatAdapter({
      baseUrl: () => fixture.baseUrl,
      token: () => TOKEN,
      store,
      pollIntervalMs: 0,
      files,
    });
    cleanups.push(() => adapter.disconnect());
    await adapter.connect();
    await waitFor(() => adapter.status().etat === "on", "la connexion temps réel");

    const port = createChannelPostPort({
      plateforme: "mattermost",
      conversationSource: GENERAL,
      canaux: () =>
        store.conversations().map((conversation) => ({
          conversationId: conversation.id,
          titre: conversation.title,
          plateforme: conversation.platform,
        })),
      fichier: (id) => files.get(id),
      envoyer: async ({ conversationId, texte, filDe, fichierIds }) => {
        await adapter.send(conversationId, {
          kind: "texte",
          text: texte,
          ...(filDe !== undefined ? { threadRootId: filDe } : {}),
          ...(fichierIds !== undefined ? { fichiers: fichierIds } : {}),
        });
      },
    });
    const tool = createChannelPostTool(port)[0]!;

    const resultat = await callTool(tool, {
      canal: "L'Imagerie",
      texte: "Le chat roux est prêt.",
      fichier_ids: [image.record.id],
    });
    expect(resultat.details.status).toBe("publie");
    // ① Le fichier est TÉLÉVERSÉ (multipart) sur le canal CIBLE.
    expect(fixture.uploads).toHaveLength(1);
    expect(fixture.uploads[0]).toContain("multipart/form-data");
    // ② Le post porte le `file_ids` rendu par le téléversement.
    expect(fixture.created).toHaveLength(1);
    expect(fixture.created[0]?.file_ids).toEqual(["fichier-1"]);
    expect(fixture.created[0]?.channel_id).toBe("canal-imagerie");
  });
});
