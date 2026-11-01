/**
 * Transport WS — CONVERSATIONS MIROIR d'un canal distant (lot 18, lot 1).
 *
 * Ce que ce fichier prouve :
 *  - la trame `sessions` distingue `kind` (`local` | `remote`) et porte
 *    `readOnly` (l'interface web ne crée ni n'écrit) **ET** `canRun` (un miroir
 *    répond, donc il n'est pas inerte) ;
 *  - sélectionner un canal miroir sert un snapshot SYNTHÉTIQUE (`state: "idle"`,
 *    `readOnly: true`) SANS toucher au focus Pi : le serveur ne reprend aucune
 *    session hôte ;
 *  - toute ÉCRITURE visant un miroir est REFUSÉE par le serveur
 *    (`conversation_lecture_seule`) : `message`, `rename`, `pin`, `setAside`,
 *    `delete`, `compact`, `reaction` ;
 *  - en mode distant, `new` est refusé aussi côté serveur (`creation_desactivee`)
 *    — la création n'est pas seulement grisée en CSS ;
 *  - la liste ne contient que les canaux du mode courant ; changer de mode et
 *    demander `chat_refresh` suffit à la mettre à jour.
 *
 * ⚠️ Échoue sur le code d'origine : ni `kind`/`readOnly`/`canRun` dans la trame,
 * ni refus d'écriture, ni sélection de miroir.
 */

import { afterEach, describe, expect, it } from "vitest";

import { ChatService } from "../../../src/chat/index.js";
import type { ChatGatewayPort } from "../../../src/gateway/ws/server.js";
import type { ServerFrame } from "../../../src/gateway/ws/protocol.js";
import { startHarness, TestClient, type Harness } from "./harness.js";

const harnesses: Harness[] = [];

/** Mode courant des ports de test (mutable : le mode peut changer à chaud). */
const currentMode = { value: "local" };

afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

type SessionsFrame = Extract<ServerFrame, { type: "sessions" }>;
type SnapshotFrame = Extract<ServerFrame, { type: "snapshot" }>;
type ErrorFrame = Extract<ServerFrame, { type: "error" }>;

/** Service distant pilotable : un mode MUTABLE + un canal miroir, sans réseau. */
function chatPort(mode: string, mirrors = true): ChatGatewayPort {
  currentMode.value = mode;
  const conversations = mirrors
    ? [
        {
          id: "mm-canal-1",
          platform: "mattermost" as const,
          remoteId: "canal-1",
          title: "Canal général",
          updatedAt: "2026-10-31T09:00:00.000Z",
          messageCount: 2,
          readOnly: true,
          canRun: true,
        },
      ]
    : [];
  return new ChatService({
    mode: () => currentMode.value,
    mirror: {
      conversations: () => conversations,
      messages: (conversationId) =>
        conversationId === "mm-canal-1"
          ? [
              {
                remoteId: "post-1",
                conversationId: "mm-canal-1",
                author: { id: "u1", nom: "Camille", estBot: false },
                role: "user" as const,
                text: "Bonjour",
                sentAt: "2026-10-31T08:59:00.000Z",
              },
            ]
          : [],
    },
  });
}

async function connect(mode: string, options: { mirrors?: boolean } = {}) {
  const h = await startHarness({
    sessionId: "s1",
    sessions: [{ id: "s1" }, { id: "s2" }],
    chat: chatPort(mode, options.mirrors ?? true),
  });
  harnesses.push(h);
  const c = await TestClient.connect(h.url);
  c.send({ type: "hello" });
  await c.waitFor((f) => f.type === "sessions");
  return { h, c };
}

function lastSessions(c: TestClient): SessionsFrame {
  const frames = c.frames.filter((f): f is SessionsFrame => f.type === "sessions");
  const frame = frames.at(-1);
  if (!frame) throw new Error("aucune trame sessions");
  return frame;
}

async function nextSessions(c: TestClient, afterCount: number): Promise<SessionsFrame> {
  const count = () => c.frames.filter((f) => f.type === "sessions").length;
  const frame = await c.waitFor(() => count() > afterCount, 3000);
  if (frame.type !== "sessions") throw new Error(`trame inattendue : ${frame.type}`);
  return frame;
}

describe("trame `sessions` — nature, lecture seule, capacité de run", () => {
  it("les conversations locales portent kind/platform/readOnly/canRun", async () => {
    const { c } = await connect("local");
    const frame = lastSessions(c);
    const local = frame.sessions.find((s) => s.id === "s1");
    expect(local).toMatchObject({
      kind: "local",
      platform: "local",
      readOnly: false,
      canRun: true,
    });
    // Mode local : aucun canal distant dans la liste.
    expect(frame.sessions.every((s) => s.kind === "local")).toBe(true);
    await c.close();
  });

  it("en mode distant, le canal miroir est `remote`, `readOnly` MAIS `canRun`", async () => {
    const { c } = await connect("mattermost");
    const frame = lastSessions(c);
    const mirror = frame.sessions.find((s) => s.id === "mm-canal-1");
    expect(mirror).toMatchObject({
      kind: "remote",
      platform: "mattermost",
      // L'interface web n'y crée rien et n'y écrit pas…
      readOnly: true,
      // …mais la conversation RÉPOND : elle n'est pas inerte.
      canRun: true,
    });
    // En mode distant, la liste ne contient QUE les canaux de la plateforme :
    // les conversations locales sont masquées (pas supprimées) et reviennent au
    // retour en mode local.
    expect(frame.sessions.map((s) => s.id)).toEqual(["mm-canal-1"]);
    await c.close();
  });
});

describe("sélection d'un canal miroir — snapshot synthétique, focus Pi INTACT", () => {
  it("sert le transcript du miroir en `readOnly`, sans changer de session hôte", async () => {
    const { h, c } = await connect("mattermost");
    const focusBefore = h.host.currentSessionId();
    c.send({ type: "switch", sessionId: "mm-canal-1" });

    const frame = (await c.waitFor(
      (f) => f.type === "snapshot" && f.sessionId === "mm-canal-1",
      3000,
    )) as SnapshotFrame;
    expect(frame.state).toBe("idle");
    expect(frame.sessionId).toBe("mm-canal-1");
    expect(frame.transcript[0]).toMatchObject({ role: "user", text: "Bonjour" });
    // ⚠️ Le focus Pi n'a PAS bougé : un miroir n'a pas de fichier de session.
    expect(h.host.currentSessionId()).toBe(focusBefore);

    // La conversation ACTIVE de la liste est le canal, pas la session Pi.
    expect(lastSessions(c).activeId).toBe("mm-canal-1");
    await c.close();
  });

  it("un canal inconnu répond `session_inconnue` (jamais un écran vide muet)", async () => {
    const { c } = await connect("mattermost");
    c.send({ type: "switch", sessionId: "mm-inexistant" });
    const frame = (await c.waitFor(
      (f) => f.type === "error",
      3000,
    )) as ErrorFrame;
    expect(frame.code).toBe("session_inconnue");
    await c.close();
  });
});

describe("écriture dans un miroir — REFUSÉE par le serveur", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["message", { clientMsgId: "m1", text: "coucou" }],
    ["rename", { sessionId: "mm-canal-1", title: "Autre nom" }],
    ["pin", { sessionId: "mm-canal-1", pinned: true }],
    ["setAside", { sessionId: "mm-canal-1" }],
    ["delete", { sessionId: "mm-canal-1" }],
    ["compact", { sessionId: "mm-canal-1", requestId: "r1" }],
    ["reaction", { sessionId: "mm-canal-1", entryId: "post-1", reaction: "heart" }],
  ];

  for (const [type, extra] of cases) {
    it(`\`${type}\` ⇒ conversation_lecture_seule`, async () => {
      const { c } = await connect("mattermost");
      // On AFFICHE le canal puis on tente l'écriture (comme le ferait l'UI).
      c.send({ type: "switch", sessionId: "mm-canal-1" });
      await c.waitFor((f) => f.type === "snapshot" && f.sessionId === "mm-canal-1", 3000);
      c.send({ type, ...extra });
      const frame = (await c.waitFor(
        (f) => f.type === "error" && f.code === "conversation_lecture_seule",
        3000,
      )) as ErrorFrame;
      expect(frame.code).toBe("conversation_lecture_seule");
      // Aucune écriture n'a atteint la session hôte : pas la moindre trame
      // `accepted` (donc aucun run).
      expect(c.frames.some((f) => f.type === "accepted")).toBe(false);
      await c.close();
    });
  }
});

describe("création — refusée côté SERVEUR en mode distant", () => {
  it("`new` ⇒ creation_desactivee avec le motif du service", async () => {
    const { c } = await connect("mattermost");
    c.send({ type: "new" });
    const frame = (await c.waitFor(
      (f) => f.type === "error" && f.code === "creation_desactivee",
      3000,
    )) as ErrorFrame;
    expect(frame.message).toContain("désactivée");
    await c.close();
  });

  it("en mode local, `new` crée (comportement inchangé)", async () => {
    const { h, c } = await connect("local", { mirrors: false });
    const before = h.host.currentSessionId();
    const count = () => c.frames.filter((f) => f.type === "sessions").length;
    c.send({ type: "new" });
    // On attend la trame `sessions` SUIVANTE (celle de la création).
    const after = await nextSessions(c, count());
    expect(after.activeId).not.toBe(before);
    expect(h.host.currentSessionId()).toBe(after.activeId);
    await c.close();
  });
});

describe("mode distant — aucune écriture web, aucun affichage local", () => {
  it("à la connexion : snapshot VIDE en `readOnly`, aucune conversation ouverte", async () => {
    const { c } = await connect("mattermost");
    const frame = (await c.waitFor(
      (f) => f.type === "snapshot" && f.readOnly === true && f.sessionId !== "mm-canal-1",
      3000,
    )) as SnapshotFrame;
    expect(frame.transcript).toEqual([]);
    expect(lastSessions(c).activeId).toBeNull();
    await c.close();
  });

  it("`message` est refusé même sans canal sélectionné (mode distant)", async () => {
    const { c } = await connect("mattermost");
    c.send({ type: "message", clientMsgId: "m1", text: "coucou" });
    const frame = (await c.waitFor(
      (f) => f.type === "error" && f.code === "conversation_lecture_seule",
      3000,
    )) as ErrorFrame;
    expect(frame.message).toContain("mode distant");
    expect(c.frames.some((f) => f.type === "accepted")).toBe(false);
    await c.close();
  });

  it("retour au mode local : la liste revient et la création redevient possible", async () => {
    const { h, c } = await connect("mattermost");
    // Le mode change à chaud côté service (comme `PUT /api/config`), puis on
    // demande la liste : elle est AUTORITAIRE côté serveur.
    const count = () => c.frames.filter((f) => f.type === "sessions").length;
    currentMode.value = "local";
    c.send({ type: "chat_refresh" });
    const after = await nextSessions(c, count());
    expect(after.sessions.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(after.activeId).toBe(h.host.currentSessionId());
    currentMode.value = "local";
    await c.close();
  });
});

describe("mode courant — la liste suit le mode, sans redémarrage", () => {
  it("`chat_refresh` renvoie la liste du mode courant", async () => {
    const { c } = await connect("local");
    expect(lastSessions(c).sessions.some((s) => s.kind === "remote")).toBe(false);
    c.send({ type: "chat_refresh" });
    const after = await nextSessions(c, 1);
    // Toujours en mode local : aucun canal distant n'apparaît, et la liste
    // reste AUTORITAIRE (mêmes conversations).
    expect(after.sessions.map((s) => s.id)).toEqual(["s1", "s2"]);
    await c.close();
  });
});
