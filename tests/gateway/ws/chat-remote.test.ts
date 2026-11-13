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
 *  - ⚠️ ADAPTÉ le 2026-11-10 : la liste contient TOUJOURS les conversations
 *    locales, PLUS les canaux des plateformes activées (le mode exclusif
 *    `chat.mode` est retiré : il coupait les plateformes non choisies). `new`
 *    n'est plus refusé : le local n'est plus un mode qu'on quitte.
 *    Le refus d'ÉCRITURE dans un miroir, lui, reste (`conversation_lecture_seule`)
 *    — c'est une autre règle : on ne compose pas dans un canal distant.
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

/** Interrupteurs des ports de test (mutable : ils changent à chaud). */
const currentMode = { value: "local" };
/** Plateformes ACTIVÉES pour le port de test (`chat.<plateforme>.enabled`). */
const currentActives = { value: [] as ("mattermost" | "discord")[] };

afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

type SessionsFrame = Extract<ServerFrame, { type: "sessions" }>;
type SnapshotFrame = Extract<ServerFrame, { type: "snapshot" }>;
type ErrorFrame = Extract<ServerFrame, { type: "error" }>;

/** Service distant pilotable : un mode MUTABLE + un canal miroir, sans réseau. */
function chatPort(
  mode: string,
  mirrors = true,
  actifs: readonly ("mattermost" | "discord")[] = mode === "local" ? [] : [mode as "mattermost" | "discord"],
): ChatGatewayPort {
  currentMode.value = mode;
  currentActives.value = [...actifs];
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
    enabled: (plateforme) => currentActives.value.includes(plateforme),
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
    // ⚠️ Les conversations locales sont TOUJOURS listées (c'était la régression :
    // un mode distant les faisait disparaître). Les canaux miroir déjà importés le
    // sont aussi : les masquer les rendrait inaccessibles depuis l'interface.
    expect(frame.sessions.filter((s) => s.kind === "local").map((s) => s.id)).toEqual([
      "s1",
      "s2",
    ]);
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
    // ⚠️ Le LOCAL et le canal distant COEXISTENT : c'est la régression corrigée
    // (« je pouvais parler au bot en local ET sur mattermost »).
    expect(frame.sessions.map((s) => s.id).sort()).toEqual(["mm-canal-1", "s1", "s2"]);
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

describe("création locale — TOUJOURS possible, même plateformes activées", () => {
  it("`new` crée dans tous les cas (le local n'est plus un mode qu'on quitte)", async () => {
    const { h, c } = await connect("mattermost");
    // ⚠️ Échoue sur l'origine : `creation_desactivee` y était renvoyé en mode distant.
    const count = () => c.frames.filter((f) => f.type === "sessions").length;
    c.send({ type: "new" });
    const after = await nextSessions(c, count());
    expect(c.frames.some((f) => f.type === "error" && f.code === "creation_desactivee")).toBe(false);
    expect(after.activeId).toBe(h.host.currentSessionId());
    await c.close();
  });
});

describe("local et distant EN MÊME TEMPS — aucune collision", () => {
  it("à la connexion : la conversation locale est servie (plus de snapshot vide)", async () => {
    const { h, c } = await connect("mattermost");
    // ⚠️ Échoue sur l'origine : un snapshot VIDE `readOnly` y était servi en mode
    // distant, ce qui retirait le local de l'écran.
    const frame = lastSessions(c);
    expect(frame.activeId).toBe(h.host.currentSessionId());
    const snapshot = (await c.waitFor(
      (f) => f.type === "snapshot" && f.sessionId === h.host.currentSessionId(),
      3000,
    )) as SnapshotFrame;
    expect(snapshot.readOnly).not.toBe(true);
    await c.close();
  });

  it("`message` part dans la conversation locale même si le canal distant est listé", async () => {
    const { c } = await connect("mattermost");
    c.send({ type: "message", clientMsgId: "m1", text: "coucou" });
    // ⚠️ Échoue sur l'origine : le mode distant refusait TOUTE écriture web.
    await c.waitFor(
      (f) => f.type === "error" && f.code === "conversation_lecture_seule",
      1500,
    ).then(
      () => {
        throw new Error("l'écriture locale a été refusée à tort");
      },
      () => undefined,
    );
    await c.close();
  });

  it("écrire DANS un miroir reste refusé (règle inchangée)", async () => {
    const { c } = await connect("mattermost");
    c.send({ type: "switch", sessionId: "mm-canal-1" });
    await c.waitFor((f) => f.type === "snapshot" && f.sessionId === "mm-canal-1", 3000);
    c.send({ type: "message", clientMsgId: "m2", text: "dans le canal" });
    const frame = (await c.waitFor(
      (f) => f.type === "error" && f.code === "conversation_lecture_seule",
      3000,
    )) as ErrorFrame;
    expect(frame.code).toBe("conversation_lecture_seule");
    await c.close();
  });

  it("les deux plateformes activées listent leurs canaux, sans se marcher dessus", async () => {
    const { c } = await connect("local", { mirrors: true });
    // Les deux interrupteurs allumés, côté service (comme deux `PUT` de config).
    currentActives.value = ["mattermost", "discord"];
    const count = () => c.frames.filter((f) => f.type === "sessions").length;
    c.send({ type: "chat_refresh" });
    const after = await nextSessions(c, count());
    // Le canal Mattermost reste listé avec les conversations locales.
    expect(after.sessions.map((s) => s.id).sort()).toEqual(["mm-canal-1", "s1", "s2"]);
    await c.close();
  });
});

describe("la liste suit les INTERRUPTEURS, sans redémarrage", () => {
  it("`chat_refresh` renvoie la liste des plateformes activées", async () => {
    const { c } = await connect("local", { mirrors: false });
    expect(lastSessions(c).sessions.some((s) => s.kind === "remote")).toBe(false);
    c.send({ type: "chat_refresh" });
    const after = await nextSessions(c, 1);
    // Aucune plateforme activée : la liste reste celle du local, AUTORITAIRE.
    expect(after.sessions.map((s) => s.id)).toEqual(["s1", "s2"]);
    await c.close();
  });
});
