/**
 * FIL « DÉCLENCHEURS » (et mode LOCAL) — `envoyer_message` publie dans la session
 * locale, par le MÊME chemin que le résultat d'un déclencheur planifié (lot 27).
 *
 * ⚠️ POURQUOI CE TEST EXISTE : le fil « Déclencheurs » N'EST PAS un canal distant —
 * c'est une session LOCALE du host Pi (`src/sources/service.ts`, `setWaker(host)`).
 * Si l'outil n'existait qu'en canal, une réponse étalée sur plusieurs messages y serait
 * impossible, alors que l'exigence utilisateur est « dans le canal OU dans le fil local
 * « Déclencheurs » — les deux ».
 *
 * Ce qui est verrouillé :
 *  - l'outil est RÉELLEMENT fourni au runtime local (allowlist `messagesEnabled`) ;
 *  - un appel écrit un message ASSISTANT persisté (`appendMessage`) + transcript +
 *    trames habituelles (`run_started` → `delta` → `run_finished`) — donc un message
 *    PAR BULLE, dans l'ordre des appels ;
 *  - un texte vide est REFUSÉ et n'écrit rien.
 *
 * ⚠️ Échoue sur le code d'origine : ni l'outil ni le port n'existaient.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { toolAllowlistForChat } from "../../src/llm/tool-policy.js";
import type { PiEvent, PiLogger } from "../../src/pi/types.js";

type AnyTool = {
  name: string;
  execute: (...args: unknown[]) => Promise<{
    content: Array<{ type: string; text?: string }>;
    details?: unknown;
  }>;
};

const stub = vi.hoisted(() => ({
  appended: [] as Array<{ role?: unknown; content?: unknown }>,
  /** Outils custom REÇUS par le runtime local (ce que le SDK exposerait au modèle). */
  customTools: [] as Array<{ name?: string }>,
}));

vi.mock("../../src/pi/sdk/session-factory.js", () => ({
  createLightRuntime: async (options: { customTools?: Array<{ name?: string }> }) => {
    stub.customTools = options.customTools ?? [];
    const session = {
      sessionId: "session-reelle",
      subscribe: () => () => undefined,
      prompt: async () => undefined,
      abort: async () => undefined,
      sessionManager: {
        getSessionId: () => "session-reelle",
        getSessionName: () => undefined,
        getSessionFile: () => undefined,
        getBranch: () => [],
        appendMessage: (message: { role?: unknown; content?: unknown }) => {
          stub.appended.push(message);
          return "entry-publiee";
        },
        appendCustomEntry: () => "entry-custom",
      },
    };
    return { session };
  },
}));

vi.mock("../../src/pi/sdk/model-runtime.js", () => ({
  getSharedModelRuntime: async () => ({}),
  resolveSdkModel: () => undefined,
  resolveSdkThinking: () => undefined,
}));

import { createSdkPiHost } from "../../src/pi/sdk-host.js";
import { createSendMessageTools } from "../../src/pi/sdk/send-message-tool.js";

const noopLogger: PiLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const temps: string[] = [];

afterEach(() => {
  stub.appended.length = 0;
  stub.customTools = [];
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeHost() {
  const dir = mkdtempSync(join(tmpdir(), "yuki-envoyer-message-"));
  temps.push(dir);
  return createSdkPiHost({
    agentDir: join(dir, "agent"),
    cwd: join(dir, "workspace"),
    home: join(dir, "home"),
    sessionsDir: join(dir, "sessions"),
    systemPrompt: "prompt système de test",
    logger: noopLogger,
  });
}

/** Contexte d'outil minimal : la conversation vient de `getSessionId()`. */
function contexteLocal() {
  return { sessionManager: { getSessionId: () => "session-reelle" } };
}

describe("host local — envoyer_message publie dans la session courante", () => {
  it("un appel = un message assistant persisté, annoncé par les trames habituelles", async () => {
    const host = makeHost();
    const events: PiEvent[] = [];
    host.subscribeAll((event) => events.push(event));
    await host.start();
    const sessionId = host.currentSessionId() as string;

    // ① L'outil est RÉELLEMENT exposé au runtime local (fil « Déclencheurs » compris).
    const tool = (stub.customTools as AnyTool[]).find(
      (candidate) => candidate.name === "envoyer_message",
    );
    expect(tool, "le runtime local doit recevoir `envoyer_message`").toBeDefined();

    const premier = await tool!.execute(
      "appel-1",
      { texte: "3" },
      undefined,
      undefined,
      contexteLocal(),
    );
    expect(premier.content[0]?.text).toContain("Message 1 envoyé");

    await delay(20);

    // ② PERSISTÉ : un message assistant ordinaire, donc relisible après rechargement.
    expect(stub.appended).toHaveLength(1);
    expect(stub.appended[0]?.role).toBe("assistant");
    expect(JSON.stringify(stub.appended[0]?.content)).toContain('"3"');

    // ③ TRANSCRIPT : il apparaît comme une réponse de Yuki (une bulle par message).
    const etat = host.getState(sessionId);
    const assistants = etat?.transcript.filter((entry) => entry.role === "assistant") ?? [];
    expect(assistants.at(-1)?.text).toBe("3");

    // ④ TRAMES : bulle ouverte, texte, bulle close — sans `userText`.
    const types = events.map((event) => event.type);
    expect(types).toContain("run_started");
    expect(types).toContain("delta");
    expect(types).toContain("run_finished");

    await host.stop();
  });

  it("un texte vide est refusé et n'écrit rien", async () => {
    const host = makeHost();
    await host.start();
    const tool = (stub.customTools as AnyTool[]).find(
      (candidate) => candidate.name === "envoyer_message",
    );
    expect(tool).toBeDefined();

    const refus = await tool!.execute(
      "appel-1",
      { texte: "   " },
      undefined,
      undefined,
      contexteLocal(),
    );
    expect(refus.content[0]?.text).toContain("Rien n'a été envoyé");
    expect(stub.appended).toHaveLength(0);

    await host.stop();
  });

  it("la politique LOCALE du léger porte l'outil (fil « Déclencheurs »)", () => {
    // ⚠️ En mode `local`, `toolAllowlistForChat` rend la politique du rôle : c'est elle
    // qui décide que le fil local peut répondre en plusieurs messages.
    const outils = toolAllowlistForChat(
      "light",
      { messagesEnabled: true },
      { chatMode: "local", remoteAgents: false, remoteTools: false },
    );
    expect(outils).toContain("envoyer_message");
  });

  it("le plafond de 20 est PAR TOUR (en local, les outils sont partagés)", async () => {
    // ⚠️ Le défaut évité : en local, `createPiHost` ne construit ses outils QU'UNE fois,
    // pour TOUTES les conversations. Un compteur global refuserait le 21ᵉ message de la
    // vie du processus. La clé du tour est donc fournie par le PORT (`tour`).
    const envois: string[] = [];
    let tour = "run-1";
    const outil = createSendMessageTools({
      envoyer: async ({ texte }) => {
        envois.push(texte);
        return { ok: true, tronque: false };
      },
      tour: () => tour,
    })[0] as unknown as AnyTool;

    for (let index = 1; index <= 20; index += 1) {
      await outil.execute(`a${index}`, { texte: `m${index}` }, undefined, undefined, undefined);
    }
    const refus = await outil.execute("a21", { texte: "m21" }, undefined, undefined, undefined);
    expect(refus.content[0]?.text).toContain("maximum de 20 messages");
    expect(envois).toHaveLength(20);

    // Tour SUIVANT : le compteur repart de zéro.
    tour = "run-2";
    const suivant = await outil.execute("a22", { texte: "n1" }, undefined, undefined, undefined);
    expect(suivant.content[0]?.text).toContain("Message 1 envoyé");
    expect(envois).toHaveLength(21);
  });
});
