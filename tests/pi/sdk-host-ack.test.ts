/**
 * Intégration — ACCUSÉ DE RÉCEPTION dans le VRAI `src/pi/sdk-host.ts`.
 *
 * ⚠️ POURQUOI CE TEST EXISTE, ET CE QU'IL PROUVE :
 *  - l'accusé est le PREMIER TEXTE DU TOUR écrit par le MODÈLE : son texte vient
 *    du `text_delta` du modèle, il n'est PAS figé par le code (deux contextes
 *    différents ⇒ deux formulations différentes) ;
 *  - il est RETENU (jamais émis comme contenu) tant qu'on ne sait pas qu'une
 *    action longue suit : c'est ce qui garantit qu'il n'est ni prononcé par la
 *    synthèse vocale (qui ne lit que les `delta` de contenu) ni appris comme un
 *    souvenir ;
 *  - il est émis pendant `message_end` du message qui porte l'appel d'outil,
 *    donc AVANT `tool_execution_start` (ordre mesuré, pas seulement présence) ;
 *  - si le modèle n'écrit RIEN, le REPLI parle, avec des VARIATIONS (rotation) ;
 *  - un texte trop long n'est PAS un accusé : il part comme contenu (PIÈGE ⑥) ;
 *  - une question simple n'en produit AUCUN, deux actions n'en produisent qu'UN.
 *
 * Le runtime SDK est stubé (`vi.mock`), mais tout le reste est le vrai host. Les
 * événements rejoués sont EXACTEMENT ceux du SDK réel (voir `agent-loop.js` :
 * `text_delta`… puis `message_end`, puis `tool_execution_start`).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ACK_MAX_CHARS } from "../../src/pi/ack.js";
import type { PiEvent, PiLogger } from "../../src/pi/types.js";

type Manager = { getSessionId(): string; getBranch(): unknown[] };

const stub = vi.hoisted(() => ({
  sessionListeners: new Set<(event: unknown) => void>(),
  emit: (event: unknown): void => {
    for (const listener of [...stub.sessionListeners]) listener(event);
  },
  manager: undefined as unknown,
  onPrompt: undefined as unknown,
}));

vi.mock("../../src/pi/sdk/session-factory.js", () => ({
  createLightRuntime: async (options: {
    sessionManager: { getSessionId(): string; getBranch(): unknown[] };
  }) => {
    stub.manager = options.sessionManager;
    const session = {
      sessionId: options.sessionManager.getSessionId(),
      subscribe: (cb: (event: unknown) => void) => {
        stub.sessionListeners.add(cb);
        return () => stub.sessionListeners.delete(cb);
      },
      prompt: async () => {
        const onPrompt = stub.onPrompt as ((manager: Manager) => Promise<void>) | undefined;
        if (onPrompt) await onPrompt(options.sessionManager);
      },
      abort: async () => undefined,
      sessionManager: options.sessionManager,
    };
    return { session, dispose: async () => undefined };
  },
}));

vi.mock("../../src/pi/sdk/model-runtime.js", () => ({
  getSharedModelRuntime: async () => ({}),
  resolveSdkModel: () => undefined,
  resolveSdkThinking: () => undefined,
}));

import { createSdkPiHost } from "../../src/pi/sdk-host.js";

const noopLogger: PiLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const temps: string[] = [];
const hosts: Array<{ stop(): Promise<void> }> = [];

function makeHost() {
  const dir = mkdtempSync(join(tmpdir(), "yuki-ack-"));
  temps.push(dir);
  const host = createSdkPiHost({
    agentDir: join(dir, "agent"),
    cwd: join(dir, "workspace"),
    home: join(dir, "home"),
    sessionsDir: join(dir, "sessions"),
    systemPrompt: "prompt système de test",
    logger: noopLogger,
  });
  hosts.push(host);
  return host;
}

const USAGE = {
  input: 10,
  output: 20,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 30,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * Message assistant tel que le SDK le produit : des blocs `text` PUIS les blocs
 * `toolCall`. C'est la forme réelle (`agent-loop.js` → `message.content`).
 */
function assistantMessage(
  text: string,
  tool?: string,
): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [];
  if (text.length > 0) content.push({ type: "text", text });
  if (tool !== undefined) {
    content.push({ type: "toolCall", id: `call-${tool}`, name: tool, arguments: {} });
  }
  return {
    role: "assistant",
    content,
    api: "test",
    provider: "test",
    model: "test",
    usage: USAGE,
    stopReason: tool !== undefined ? "toolUse" : "stop",
    timestamp: Date.now(),
  };
}

function waitForRunFinished(events: PiEvent[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 4000;
    const tick = () => {
      if (events.some((e) => e.type === "run_finished")) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("run_finished non reçu"));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

afterEach(async () => {
  stub.sessionListeners.clear();
  stub.manager = undefined;
  stub.onPrompt = undefined;
  for (const host of hosts.splice(0)) await host.stop();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Joue un run avec l'ORDRE RÉEL du SDK : le modèle streame son texte, le message
 * est clos (`message_end`, contenu autoritatif), PUIS l'outil démarre.
 */
async function runOnce(input: {
  tool?: string;
  text?: string;
  twice?: boolean;
  /** Texte de la réponse qui suit l'outil (« le vrai texte s'ajoute APRÈS »). */
  answer?: string;
}): Promise<{ events: PiEvent[]; order: string[] }> {
  const host = makeHost();
  const events: PiEvent[] = [];
  const order: string[] = [];
  host.subscribeAll((event) => {
    events.push(event);
    if (event.type === "ack") order.push(`ack:${event.tool}:${event.source}`);
    if (event.type === "delta" && event.channel === "content") order.push("content");
  });
  await host.start();
  const sessionId = host.currentSessionId()!;

  stub.onPrompt = async () => {
    stub.emit({ type: "agent_start" });
    const text = input.text ?? "";
    if (input.tool !== undefined || text.length > 0) {
      // Le SDK ouvre TOUJOURS le message assistant avant de le streamer, même
      // quand le modèle part droit à l'outil (aucun `text_delta`).
      stub.emit({ type: "message_start", message: { role: "assistant" } });
    }
    if (text.length > 0) {
      stub.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: text },
      });
    }
    if (input.tool !== undefined || text.length > 0) {
      stub.emit({ type: "message_end", message: assistantMessage(text, input.tool) });
    }
    if (input.tool !== undefined) {
      stub.emit({ type: "tool_execution_start", toolName: input.tool });
      // ⚠️ PREUVE D'ORDRE : ce marqueur est posé APRÈS le retour de `emit`, donc
      // après tout ce que l'hôte fait synchroniquement sur cet événement.
      order.push("action-start");
      if (input.twice) {
        stub.emit({ type: "tool_execution_start", toolName: input.tool });
        order.push("action-start-2");
      }
      stub.emit({ type: "tool_execution_end", toolName: input.tool, isError: false });
    }
    const answer = input.answer ?? "Voilà, c'est noté.";
    stub.emit({ type: "message_start", message: { role: "assistant" } });
    stub.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: answer },
    });
    stub.emit({ type: "message_end", message: assistantMessage(answer) });
  };

  host.send(sessionId, "demande");
  await waitForRunFinished(events);
  return { events, order };
}

function ackOf(events: PiEvent[]) {
  return events.find((event) => event.type === "ack");
}

describe("accusé de réception — le MODÈLE écrit, le host RECONNAÎT", () => {
  it("DÉLÉGATION : la phrase du modèle devient l'accusé, AVANT le démarrage", async () => {
    const { events, order } = await runOnce({
      tool: "delegate",
      text: "Deux secondes, je m'en occupe.",
    });
    const ack = ackOf(events);
    expect(ack && ack.type === "ack" ? ack.text : "").toBe("Deux secondes, je m'en occupe.");
    expect(ack && ack.type === "ack" ? ack.source : "").toBe("model");
    // ⚠️ ORDRE MESURÉ : l'accusé précède le marqueur posé juste après le retour de
    // l'émission `tool_execution_start`, et AUCUN contenu n'est parti avant lui.
    expect(order).toEqual(["ack:delegate:model", "action-start", "content"]);
  });

  it("GÉNÉRATION D'IMAGE : un autre contexte ⇒ une AUTRE formulation (texte du modèle)", async () => {
    const { events, order } = await runOnce({
      tool: "generer_image",
      text: "Je lance la génération.",
    });
    const ack = ackOf(events);
    expect(ack && ack.type === "ack" ? ack.text : "").toBe("Je lance la génération.");
    expect(order).toEqual(["ack:generer_image:model", "action-start", "content"]);
  });

  it("le texte de l'accusé n'est JAMAIS émis comme contenu (donc jamais prononcé)", async () => {
    const { events } = await runOnce({ tool: "delegate", text: "Je m'y mets." });
    const contentDeltas = events
      .filter((event) => event.type === "delta" && event.channel === "content")
      .map((event) => (event.type === "delta" ? event.text : ""))
      .join("");
    expect(contentDeltas).toBe("Voilà, c'est noté.");
    expect(contentDeltas).not.toContain("Je m'y mets");
  });

  it("le texte du message de l'accusé n'entre pas dans la bulle (il est dans `ack`)", async () => {
    const { events } = await runOnce({ tool: "delegate", text: "Je prends ça en charge." });
    const ack = ackOf(events);
    expect(ack && ack.type === "ack" ? ack.text : "").toBe("Je prends ça en charge.");
    // Aucun delta d'un texte vide, aucun doublon de l'accusé dans le contenu.
    for (const event of events) {
      if (event.type !== "delta") continue;
      expect(event.text).not.toContain("Je prends ça en charge");
    }
  });

  it("COMMANDE envoyée à un agent : l'accusé du modèle, avant l'action", async () => {
    const { order } = await runOnce({ tool: "run_command", text: "C'est parti." });
    expect(order).toEqual(["ack:run_command:model", "action-start", "content"]);
  });

  it("QUESTION SIMPLE (aucun outil d'action) : AUCUN accusé, le texte part en flux", async () => {
    const { events, order } = await runOnce({ text: "Bonjour ! Comment puis-je t'aider ?" });
    expect(events.some((event) => event.type === "ack")).toBe(false);
    expect(order).toEqual(["content", "content"]);
  });

  it("outil de LECTURE : aucun accusé (ce n'est pas une action longue)", async () => {
    const { events } = await runOnce({ tool: "read", text: "Je regarde." });
    expect(events.some((event) => event.type === "ack")).toBe(false);
    // Le texte redevient du CONTENU ordinaire (il n'a pas été perdu en route).
    const contentDeltas = events
      .filter((event) => event.type === "delta" && event.channel === "content")
      .map((event) => (event.type === "delta" ? event.text : ""))
      .join("");
    expect(contentDeltas).toBe("Je regarde.Voilà, c'est noté.");
  });

  it("elle a DÉJÀ parlé (texte long, pas un accusé) : AUCUN accusé, le texte part en contenu", async () => {
    const long = `Voici une explication complète et détaillée. ${"a".repeat(ACK_MAX_CHARS)}`;
    const { events } = await runOnce({ tool: "delegate", text: long });
    expect(events.some((event) => event.type === "ack")).toBe(false);
    const contentDeltas = events
      .filter((event) => event.type === "delta" && event.channel === "content")
      .map((event) => (event.type === "delta" ? event.text : ""))
      .join("");
    expect(contentDeltas.startsWith(long)).toBe(true);
  });

  it("deux actions dans le MÊME run : un seul accusé", async () => {
    const { events, order } = await runOnce({
      tool: "delegate",
      text: "Je m'en occupe.",
      twice: true,
    });
    expect(events.filter((event) => event.type === "ack")).toHaveLength(1);
    expect(order).toEqual(["ack:delegate:model", "action-start", "action-start-2", "content"]);
  });
});

describe("accusé de réception — le texte est RETENU, jamais streamé", () => {
  it("le texte de l'accusé n'est émis qu'APRÈS la fin du message (donc jamais comme contenu)", async () => {
    const host = makeHost();
    const order: string[] = [];
    host.subscribeAll((event) => {
      if (event.type === "ack") order.push("ack");
      if (event.type === "delta" && event.channel === "content") order.push(`content:${event.text}`);
    });
    await host.start();
    const sessionId = host.currentSessionId()!;
    stub.onPrompt = async () => {
      stub.emit({ type: "agent_start" });
      stub.emit({ type: "message_start", message: { role: "assistant" } });
      stub.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Je m'en occupe" },
      });
      // ⚠️ MARQUEUR : tout ce qui précède la fin du message est encore RETENU.
      order.push("mid-message");
      stub.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "." },
      });
      stub.emit({ type: "message_end", message: assistantMessage("Je m'en occupe.", "delegate") });
      stub.emit({ type: "tool_execution_start", toolName: "delegate" });
      stub.emit({ type: "tool_execution_end", toolName: "delegate", isError: false });
    };
    host.send(sessionId, "fais ce travail long");
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 4000;
      const tick = () => {
        if (order.includes("ack")) return resolve();
        if (Date.now() > deadline) return reject(new Error("accusé non reçu"));
        setTimeout(tick, 5);
      };
      tick();
    });
    // Avant la fin du message : RIEN n'a été émis (ni accusé, ni contenu).
    expect(order).toEqual(["mid-message", "ack"]);
  });

  it("un texte PLUS LONG que la borne est relâché comme CONTENU (jamais retenu pour rien)", async () => {
    const host = makeHost();
    const events: PiEvent[] = [];
    const order: string[] = [];
    host.subscribeAll((event) => {
      events.push(event);
      if (event.type === "ack") order.push("ack");
      if (event.type === "delta" && event.channel === "content") {
        order.push(`content:${event.text.length}`);
      }
    });
    await host.start();
    const sessionId = host.currentSessionId()!;
    const long = "a".repeat(ACK_MAX_CHARS + 20);
    let releasedBeforeMessageEnd = false;
    stub.onPrompt = async () => {
      stub.emit({ type: "agent_start" });
      stub.emit({ type: "message_start", message: { role: "assistant" } });
      stub.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: long },
      });
      // Le texte dépasse la borne : il est relâché IMMÉDIATEMENT, sans attendre la
      // fin du message (aucune latence ajoutée à une vraie réponse).
      releasedBeforeMessageEnd = order.length === 1;
      stub.emit({ type: "message_end", message: assistantMessage(long, "delegate") });
      stub.emit({ type: "tool_execution_start", toolName: "delegate" });
      stub.emit({ type: "tool_execution_end", toolName: "delegate", isError: false });
    };
    host.send(sessionId, "fais ce travail long");
    await waitForRunFinished(events);
    expect(releasedBeforeMessageEnd).toBe(true);
    expect(order).toContain(`content:${long.length}`);
    expect(order).not.toContain("ack");
  });
});

describe("accusé de réception — REPLI quand le modèle n'écrit rien", () => {
  it("il va droit à l'outil ⇒ le repli parle, et il est ANNONCÉ comme tel", async () => {
    const { events, order } = await runOnce({ tool: "delegate" });
    const ack = ackOf(events);
    expect(ack && ack.type === "ack" ? ack.text : "").toBe("Je m'en occupe.");
    expect(ack && ack.type === "ack" ? ack.source : "").toBe("fallback");
    expect(order).toEqual(["ack:delegate:fallback", "action-start", "content"]);
  });

  it("VARIATIONS : deux replis consécutifs ne répètent PAS la même phrase", async () => {
    // Deux runs dans la MÊME conversation : la rotation avance d'un cran.
    const texts = await replaysFallbackTwice("delegate");
    expect(texts).toHaveLength(2);
    expect(texts[0]).not.toBe(texts[1]);
    expect(texts[0]).toBe("Je m'en occupe.");
    expect(texts[1]).toBe("Deux secondes, je m'en occupe.");
  });

  it("la rotation vaut aussi pour la génération d'image", async () => {
    const texts = await replaysFallbackTwice("generer_image");
    expect(texts[0]).toBe("C'est parti.");
    expect(texts[1]).toBe("Je lance la génération.");
  });
});

/** Rejoue deux runs SANS texte de modèle dans la même conversation. */
async function replaysFallbackTwice(tool: string): Promise<string[]> {
  const host = makeHost();
  const acks: string[] = [];
  let runIndex = 0;
  host.subscribeAll((event) => {
    if (event.type === "ack") acks.push(event.text);
  });
  await host.start();
  const sessionId = host.currentSessionId()!;
  stub.onPrompt = async () => {
    runIndex += 1;
    stub.emit({ type: "agent_start" });
    stub.emit({ type: "message_start", message: { role: "assistant" } });
    stub.emit({ type: "message_end", message: assistantMessage("", tool) });
    stub.emit({ type: "tool_execution_start", toolName: tool });
    stub.emit({ type: "tool_execution_end", toolName: tool, isError: false });
    const answer = assistantMessage(`Réponse ${runIndex}.`);
    stub.emit({ type: "message_start", message: { role: "assistant" } });
    stub.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: `Réponse ${runIndex}.` },
    });
    stub.emit({ type: "message_end", message: answer });
  };
  const finish = (): Promise<void> =>
    new Promise((resolve) => {
      const tick = () => {
        const finished = acks.length >= 1 && host.getState(sessionId)?.state !== "streaming";
        if (finished) resolve();
        else setTimeout(tick, 5);
      };
      tick();
    });
  host.send(sessionId, "fais ce travail long");
  await finish();
  // Second tour : la rotation doit avoir avancé.
  host.send(sessionId, "encore");
  await new Promise<void>((resolve) => {
    const tick = () => (acks.length >= 2 ? resolve() : setTimeout(tick, 5));
    tick();
  });
  await host.stop();
  hosts.splice(hosts.indexOf(host), 1);
  return acks;
}

describe("accusé de réception — invariants (aucun doublon, aucune bulle vide)", () => {
  it("le transcript ne contient QUE les textes du modèle : jamais l'accusé comme réponse", async () => {
    const host = makeHost();
    const events: PiEvent[] = [];
    host.subscribeAll((event) => events.push(event));
    await host.start();
    const sessionId = host.currentSessionId()!;
    stub.onPrompt = async () => {
      stub.emit({ type: "agent_start" });
      stub.emit({ type: "message_start", message: { role: "assistant" } });
      stub.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Deux secondes." },
      });
      stub.emit({ type: "message_end", message: assistantMessage("Deux secondes.", "delegate") });
      stub.emit({ type: "tool_execution_start", toolName: "delegate" });
      stub.emit({ type: "tool_execution_end", toolName: "delegate", isError: false });
    };
    host.send(sessionId, "fais ce travail long");
    await waitForRunFinished(events);
    const transcript = host.getState(sessionId)?.transcript ?? [];
    const assistants = transcript.filter((entry) => entry.role === "assistant");
    // ⚠️ AUCUNE bulle vide : le run n'a produit AUCUN corps de réponse, donc
    // l'unique entrée assistant ne porte QUE l'accusé (jamais un texte qui
    // contiendrait la phrase du modèle).
    expect(assistants).toHaveLength(1);
    expect(assistants[0].text).toBe("");
    expect(assistants[0].ack).toBe("Deux secondes.");
    expect(events.some((event) => event.type === "ack")).toBe(true);
  });
});
