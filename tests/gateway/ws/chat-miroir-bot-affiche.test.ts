/**
 * Transport WS — la LISTE DES CANAUX EST CELLE DU BOT AFFICHÉ (lot 45).
 *
 * Ce que ce fichier prouve, et rien d'autre :
 *  1. un client rattaché à un bot SECONDAIRE reçoit les canaux de SON miroir, et
 *     AUCUN canal du bot courant du gateway ;
 *  2. les canaux de TOUTES les plateformes de ce bot sont listés ENSEMBLE (aucun
 *     filtre par plateforme, aucun onglet) ;
 *  3. sélectionner un canal du bot secondaire sert SON transcript (le miroir du
 *     bot courant ne contient pas ce canal : un mauvais miroir rendrait
 *     `session_inconnue`) ;
 *  4. le bot courant garde exactement son comportement (non-régression).
 *
 * ⚠️ Échoue sur le code d'origine : `mirrorSessions()` lisait `options.chat`
 * (miroir du bot COURANT, `<state>/chat-mirror.json`) pour TOUS les clients. Un
 * bot secondaire — dont les canaux sont dans `<state>/bots/<id>/chat-mirror.json`
 * — n'avait donc jamais rien à lister, alors que son adaptateur les avait bien
 * importés. C'est le défaut signalé : « je suis censé voir dans la page web les
 * canaux auxquels il a accès, là ça reste vide ».
 */

import { afterEach, describe, expect, it } from "vitest";

import { ChatService } from "../../../src/chat/index.js";
import { FakePiHost } from "../../pi/host-double.js";
import type { ChatGatewayPort } from "../../../src/gateway/ws/server.js";
import type { ServerFrame } from "../../../src/gateway/ws/protocol.js";
import { startHarness, TestClient, type Harness } from "./harness.js";

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

type SessionsFrame = Extract<ServerFrame, { type: "sessions" }>;

/** Un port de discussion dont le miroir contient EXACTEMENT les canaux donnés. */
function portAvec(canaux: { id: string; platform: "mattermost" | "discord"; titre: string }[]): ChatGatewayPort {
  return new ChatService({
    mode: () => "local",
    // ⚠️ Les DEUX plateformes sont activées : la liste ne doit pas filtrer.
    enabled: () => true,
    mirror: {
      conversations: () =>
        canaux.map((canal) => ({
          id: canal.id,
          platform: canal.platform,
          remoteId: canal.id,
          title: canal.titre,
          updatedAt: "2026-11-13T09:00:00.000Z",
          messageCount: 1,
          readOnly: true,
          canRun: true,
        })),
      messages: (conversationId) =>
        canaux.some((canal) => canal.id === conversationId)
          ? [
              {
                remoteId: `post-${conversationId}`,
                conversationId,
                author: { id: "u1", nom: "Camille", estBot: false },
                role: "user" as const,
                text: `message de ${conversationId}`,
                sentAt: "2026-11-13T08:59:00.000Z",
              },
            ]
          : [],
    },
  });
}

/**
 * Deux bots : le courant du gateway (miroir `mm-yuki`) et `granolaf` (miroir à
 * lui, deux plateformes). Les identifiants sont DISJOINTS : un mauvais miroir ne
 * peut pas passer inaperçu.
 */
async function connecter(botId?: string) {
  const chatCourant = portAvec([
    { id: "mm-yuki", platform: "mattermost", titre: "canal du bot courant" },
  ]);
  const chatGranolaf = portAvec([
    { id: "dc-salon-a", platform: "discord", titre: "salon discord de granolaf" },
    { id: "mm-canal-b", platform: "mattermost", titre: "canal mattermost de granolaf" },
  ]);
  // Host RÉEL (double) du bot secondaire : le transport refuse un bot inconnu ou
  // arrêté, donc « aucun repli » est déjà prouvé ailleurs (`multibot.test.ts`).
  const hostGranolaf = new FakePiHost({ sessionId: "s-granolaf" });
  await hostGranolaf.start();
  const h = await startHarness({
    sessionId: "s1",
    sessions: [{ id: "s1" }],
    chat: chatCourant,
    chatPour: (id: string) => (id === "granolaf" ? chatGranolaf : undefined),
    autresHosts: { granolaf: hostGranolaf },
  });
  harnesses.push(h);
  const client = await TestClient.connect(botId === undefined ? h.url : h.urlBot(botId));
  client.send(botId === undefined ? { type: "hello" } : { type: "hello", botId });
  await client.waitFor((f) => f.type === "sessions");
  return { h, client };
}

function derniereListe(client: TestClient): SessionsFrame {
  const frames = client.frames.filter((f): f is SessionsFrame => f.type === "sessions");
  const frame = frames.at(-1);
  if (!frame) throw new Error("aucune trame sessions");
  return frame;
}

describe("liste des canaux — MIROIR DU BOT AFFICHÉ", () => {
  it("un bot secondaire liste SES canaux, et aucun du bot courant", async () => {
    const { client } = await connecter("granolaf");
    const ids = derniereListe(client).sessions.map((session) => session.id);
    expect(ids).toContain("dc-salon-a");
    expect(ids).toContain("mm-canal-b");
    // ⚠️ Le cœur du défaut : le canal du miroir du bot COURANT ne doit pas fuiter.
    expect(ids).not.toContain("mm-yuki");
    await client.close();
  });

  it("les plateformes d'un même bot sont listées ENSEMBLE (aucun filtre, aucun onglet)", async () => {
    const { client } = await connecter("granolaf");
    const distants = derniereListe(client)
      .sessions.filter((session) => session.kind === "remote")
      .map((session) => session.platform);
    expect([...distants].sort()).toEqual(["discord", "mattermost"]);
    await client.close();
  });

  it("le bot courant du gateway garde son propre miroir (non-régression)", async () => {
    const { client } = await connecter();
    const ids = derniereListe(client).sessions.map((session) => session.id);
    expect(ids).toContain("mm-yuki");
    expect(ids).not.toContain("dc-salon-a");
    await client.close();
  });

  it("sélectionner un canal du bot secondaire sert SON transcript", async () => {
    const { client } = await connecter("granolaf");
    client.send({ type: "switch", sessionId: "dc-salon-a" });
    const snapshot = (await client.waitFor(
      (f) => f.type === "snapshot" && f.sessionId === "dc-salon-a",
      3000,
    )) as Extract<ServerFrame, { type: "snapshot" }>;
    expect(snapshot.transcript[0]).toMatchObject({ role: "user", text: "message de dc-salon-a" });
    await client.close();
  });
});
