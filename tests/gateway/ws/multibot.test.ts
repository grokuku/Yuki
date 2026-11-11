/**
 * LOT 36 — L4 : TRANSPORT WS MULTI-HOST.
 *
 * Ce que ce fichier prouve, et rien d'autre :
 *  1. une trame SANS `botId` est servie par le PRINCIPAL, exactement comme avant
 *     L4 (`welcome` sans champ `bot`, aucune option ajoutée) ;
 *  2. une trame AVEC `botId` est servie par le host DE CE BOT (ses conversations,
 *     son run) ;
 *  3. un bot INCONNU ou ARRÊTÉ est refusé par une trame `error` qui le NOMME —
 *     jamais un repli silencieux sur le principal ;
 *  4. une session de `kohai` n'est JAMAIS lisible depuis `yuki` : ni son tampon
 *     de rejeu, ni son snapshot, ni sa liste (registre de flux PAR BOT) ;
 *  5. `?bot=<id>` sur l'URL du WebSocket rattache la connexion AVANT la première
 *     trame, et refuse un bot inconnu sans même ouvrir la connexion.
 *
 * ⚠️ Les deux hosts portent VOLONTAIREMENT le même identifiant de session
 * (`sess-1`) : c'est la seule façon de faire apparaître une fuite entre bots si
 * les registres de flux étaient partagés.
 */

import { afterEach, describe, expect, it } from "vitest";

import { parseClientMessage } from "../../../src/gateway/ws/protocol.js";
import { FakePiHost } from "../../pi/host-double.js";
import { startHarness, TestClient, type Harness } from "./harness.js";

const SESSION_COMMUNE = "sess-1";

const scriptKohai = {
  steps: [
    { kind: "delta" as const, channel: "content" as const, text: "reponse-de-kohai" },
  ],
};

const scriptYuki = {
  steps: [{ kind: "delta" as const, channel: "content" as const, text: "reponse-de-yuki" }],
};

/** Un host de bot secondaire, démarré, avec SA conversation propre. */
async function hostKohai(): Promise<FakePiHost> {
  const kohai = new FakePiHost({
    sessionId: SESSION_COMMUNE,
    scripts: [scriptKohai, scriptKohai],
    sessions: [
      { id: "sess-kohai", title: "kohai-conv" },
      { id: "sess-kohai-seul", title: "kohai-prive" },
    ],
  });
  await kohai.start();
  return kohai;
}

let harness: Harness | undefined;
const clients: TestClient[] = [];

afterEach(async () => {
  while (clients.length > 0) await clients.pop()?.close();
  await harness?.close();
  harness = undefined;
});

async function connect(url: string, hello: Record<string, unknown>): Promise<TestClient> {
  const client = await TestClient.connect(url);
  clients.push(client);
  client.send({ type: "hello", ...hello });
  return client;
}

describe("L4 — botId sur la trame de connexion", () => {
  it("sans botId : c'est le PRINCIPAL qui répond, trame welcome inchangée", async () => {
    harness = await startHarness({ scripts: [scriptYuki], autresHosts: { kohai: await hostKohai() } });
    const client = await connect(harness.url, {});

    const welcome = await client.waitFor("welcome");
    // ⚠️ GARDE DE NON-RÉGRESSION : aucun champ `bot` pour un client d'avant L4.
    expect(Object.prototype.hasOwnProperty.call(welcome, "bot")).toBe(false);

    const sessions = await client.waitFor("sessions");
    const titres = sessions.type === "sessions" ? sessions.sessions.map((s) => s.title) : [];
    expect(titres.some((titre) => titre.includes("kohai"))).toBe(false);
    expect(sessions.type === "sessions" && sessions.activeId).toBe(SESSION_COMMUNE);

    // Le run part bien sur le host du principal.
    client.send({ type: "message", clientMsgId: "m1", text: "bonjour" });
    await client.waitFor("run_started");
    await client.waitFor(
      (frame) => frame.type === "delta" && frame.text === "reponse-de-yuki",
    );
    expect(harness.host.sentOptions.length).toBe(1);
  });

  it("botId=kohai : c'est SON host qui répond (liste et run)", async () => {
    const kohai = await hostKohai();
    harness = await startHarness({ scripts: [scriptYuki], autresHosts: { kohai } });
    const client = await connect(harness.url, { botId: "kohai" });

    const welcome = await client.waitFor("welcome");
    expect(welcome.type === "welcome" && welcome.bot).toBe("kohai");

    const sessions = await client.waitFor("sessions");
    const titres =
      sessions.type === "sessions" ? sessions.sessions.map((s) => s.title) : [];
    // La liste est celle de kohai — et celle du principal n'y est pas.
    expect(titres).toContain("kohai-conv");
    expect(titres).toContain("kohai-prive");

    client.send({ type: "message", clientMsgId: "k1", text: "bonjour kohai" });
    await client.waitFor("run_started");
    await client.waitFor(
      (frame) => frame.type === "delta" && frame.text === "reponse-de-kohai",
    );
    // ⚠️ Le principal n'a RIEN reçu : son host n'a jamais été sollicité.
    expect(harness.host.sentOptions.length).toBe(0);
    expect(kohai.sentOptions.length).toBe(1);
  });

  it("bot inconnu : erreur explicite nommant le bot, aucun service rendu", async () => {
    harness = await startHarness({ scripts: [scriptYuki] });
    const client = await connect(harness.url, { botId: "fantome" });

    const erreur = await client.waitFor("error");
    expect(erreur.type === "error" && erreur.code).toBe("bot_inconnu");
    expect(erreur.type === "error" && erreur.message).toContain("fantome");

    // ⚠️ AUCUN REPLI : ni `welcome` ni `sessions` ne suivent l'erreur.
    expect(client.frames.some((frame) => frame.type === "welcome")).toBe(false);
    expect(client.frames.some((frame) => frame.type === "sessions")).toBe(false);
  });

  it("bot ARRÊTÉ : erreur explicite nommant le bot, jamais un repli", async () => {
    const kohai = await hostKohai();
    harness = await startHarness({
      scripts: [scriptYuki],
      autresHosts: { kohai },
      botsArretes: ["kohai"],
    });
    const client = await connect(harness.url, { botId: "kohai" });

    const erreur = await client.waitFor("error");
    expect(erreur.type === "error" && erreur.code).toBe("bot_inconnu");
    expect(erreur.type === "error" && erreur.message).toContain("kohai");
    expect(client.frames.some((frame) => frame.type === "sessions")).toBe(false);
  });

  it("resume porte aussi le botId (reconnexion sur le bot affiché)", async () => {
    harness = await startHarness({ autresHosts: { kohai: await hostKohai() } });
    const client = await connect(harness.url, { botId: "kohai" });
    await client.waitFor("welcome");
    await client.waitFor("snapshot");

    client.send({ type: "resume", sessionId: SESSION_COMMUNE, fromSeq: 0, botId: "kohai" });
    const welcome = await client.waitFor(
      (frame) => frame.type === "welcome" && frame.resumed,
    );
    expect(welcome.type === "welcome" && welcome.bot).toBe("kohai");
  });
});

describe("L4 — une session de kohai n'est jamais lisible depuis yuki", () => {
  it("le rejeu de yuki ne contient AUCUNE trame du run de kohai", async () => {
    const kohai = await hostKohai();
    harness = await startHarness({ scripts: [scriptYuki], autresHosts: { kohai } });

    // 1) kohai travaille dans SA session (même identifiant que celle du principal).
    const clientKohai = await connect(harness.url, { botId: "kohai" });
    await clientKohai.waitFor("snapshot");
    clientKohai.send({ type: "message", clientMsgId: "k1", text: "travail kohai" });
    await clientKohai.waitFor(
      (frame) => frame.type === "delta" && frame.text === "reponse-de-kohai",
    );

    // 2) un client du PRINCIPAL demande le rejeu COMPLET de la même session.
    const clientYuki = await connect(harness.url, {});
    await clientYuki.waitFor("snapshot");
    clientYuki.send({ type: "resume", sessionId: SESSION_COMMUNE, fromSeq: 0 });
    await clientYuki.waitFor((frame) => frame.type === "welcome" && frame.resumed);

    const fuites = clientYuki.frames.filter(
      (frame) =>
        frame.type === "delta" && frame.text.includes("reponse-de-kohai"),
    );
    expect(fuites).toEqual([]);
    // Le snapshot de yuki ne porte pas non plus le contenu de kohai.
    const snapshot = clientYuki.frames.find((frame) => frame.type === "snapshot");
    expect(
      snapshot && snapshot.type === "snapshot"
        ? snapshot.transcript.some((entry) => entry.text.includes("reponse-de-kohai"))
        : false,
    ).toBe(false);
  });

  it("une conversation PRIVÉE de kohai est introuvable pour yuki", async () => {
    harness = await startHarness({ autresHosts: { kohai: await hostKohai() } });
    const client = await connect(harness.url, {});
    await client.waitFor("sessions");

    client.send({ type: "switch", sessionId: "sess-kohai-seul" });
    const erreur = await client.waitFor("error");
    expect(erreur.type === "error" && erreur.code).toBe("session_inconnue");

    // …et la liste du principal ne la contient pas.
    const sessions = client.frames.find((frame) => frame.type === "sessions");
    const ids =
      sessions && sessions.type === "sessions"
        ? sessions.sessions.map((session) => session.id)
        : [];
    expect(ids).not.toContain("sess-kohai-seul");
  });
});

describe("L4 — `?bot=` sur l'URL du WebSocket", () => {
  it("rattache la connexion au bot AVANT la première trame", async () => {
    harness = await startHarness({ autresHosts: { kohai: await hostKohai() } });
    const client = await TestClient.connect(harness.urlBot("kohai"));
    clients.push(client);
    // Aucun `botId` dans la trame : l'URL a déjà décidé.
    client.send({ type: "hello" });

    const sessions = await client.waitFor("sessions");
    const titres =
      sessions.type === "sessions" ? sessions.sessions.map((s) => s.title) : [];
    expect(titres).toContain("kohai-conv");
  });

  it("bot inconnu : la connexion est REFUSÉE (aucun host principal en repli)", async () => {
    harness = await startHarness({ autresHosts: { kohai: await hostKohai() } });
    await expect(TestClient.connect(harness.urlBot("fantome"))).rejects.toBeTruthy();
  });

  it("sans `?bot=` : comportement d'avant L4 (principal)", async () => {
    harness = await startHarness({ autresHosts: { kohai: await hostKohai() } });
    const client = await TestClient.connect(harness.url);
    clients.push(client);
    client.send({ type: "hello" });

    const welcome = await client.waitFor("welcome");
    expect(Object.prototype.hasOwnProperty.call(welcome, "bot")).toBe(false);
  });
});

describe("L4 — validation du champ botId", () => {
  it("un botId vide est REFUSÉ (jamais le principal par défaut)", () => {
    const resultat = parseClientMessage(JSON.stringify({ type: "hello", botId: "   " }));
    expect(resultat).toEqual({ ok: false, error: "invalid_bot_id" });
  });

  it("un botId lisible est conservé (espaces retirés)", () => {
    const resultat = parseClientMessage(
      JSON.stringify({ type: "hello", botId: " kohai " }),
    );
    expect(resultat.ok).toBe(true);
    expect(resultat.ok && resultat.message.type === "hello" && resultat.message.botId).toBe(
      "kohai",
    );
  });

  it("une trame sans botId reste valide et SANS champ (compat)", () => {
    const resultat = parseClientMessage(JSON.stringify({ type: "hello" }));
    expect(resultat.ok).toBe(true);
    expect(
      resultat.ok &&
        Object.prototype.hasOwnProperty.call(resultat.message, "botId"),
    ).toBe(false);
  });
});
