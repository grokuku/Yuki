/**
 * Extension SDK des RÉACTIONS — invoquée directement avec un faux `pi` et un
 * faux `ctx`. Prouve que :
 *  - les réactions sont injectées DANS LE PROMPT SYSTÈME (`systemPrompt`) et
 *    JAMAIS comme `message` : aucune entrée de session n'est donc créée, rien
 *    n'apparaît dans le transcript, et aucun tour n'est ouvert par l'extension ;
 *  - le bloc est BORNÉ (N dernières) et situé par l'extrait du message visé ;
 *  - sans réaction, RIEN n'est injecté (pas de bloc vide qui gonflerait le prompt) ;
 *  - un store en échec ne casse JAMAIS un tour (dégradation silencieuse) ;
 *  - la session interrogée est bien CELLE du contexte (jamais une autre).
 *
 * Aucun type SDK n'est importé au RUNTIME par `reactions-extension.ts` (imports
 * de types uniquement) : ce test n'a besoin d'aucun modèle ni réseau.
 */

import { describe, expect, it } from "vitest";

import {
  createReactionsExtensionFactory,
  type ReactionsPort,
} from "../../src/pi/sdk/reactions-extension.js";
import { buildInlineExtensions } from "../../src/pi/sdk-host.js";
import { REACTIONS_PROMPT_MAX } from "../../src/reactions/prompt.js";
import type { ReactionView } from "../../src/reactions/types.js";

type Handler = (event: unknown, ctx: unknown) => unknown;

function capture(port: ReactionsPort, maxItems?: number) {
  const handlers = new Map<string, Handler>();
  const factory = createReactionsExtensionFactory(
    port,
    maxItems !== undefined ? { maxItems } : {},
  );
  const run = typeof factory === "function" ? factory : factory.factory;
  run({
    on: (name: string, handler: Handler) => {
      handlers.set(name, handler);
    },
  } as never);
  return handlers;
}

/** Faux `ctx` dont la session est LECTURE SEULE (toute écriture ferait échouer). */
function readOnlyCtx(sessionId: string, entries: unknown[]): unknown {
  return {
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => entries,
      // Aucune méthode d'écriture n'est définie : un appel accidentel lèverait.
    },
  };
}

function messageEntry(id: string, role: string, text: string): unknown {
  return {
    type: "message",
    id,
    message: { role, content: [{ type: "text", text }] },
  };
}

function view(entryId: string, reaction: string): ReactionView {
  return {
    sessionId: "s1",
    entryId,
    reaction,
    at: "2026-10-24T10:00:00.000Z",
  };
}

function portOf(views: ReactionView[], observed: string[] = []): ReactionsPort {
  return {
    recentFor: (sessionId: string, limit: number) => {
      observed.push(`${sessionId}:${limit}`);
      return views.slice(-limit);
    },
  };
}

describe("extension de réactions — injection en DONNÉE", () => {
  it("ajoute le bloc au PROMPT SYSTÈME, jamais comme message (non persisté)", async () => {
    const handlers = capture(portOf([view("e-1", "trop-long")]));
    const handler = handlers.get("before_agent_start");
    expect(handler).toBeDefined();

    const result = (await handler!(
      { prompt: "Bonjour", systemPrompt: "PROMPT SYSTÈME DE BASE" },
      readOnlyCtx("s1", [messageEntry("e-1", "assistant", "Une réponse très longue.")]),
    )) as { message?: unknown; systemPrompt?: string };

    // Preuve : seul `systemPrompt` est renvoyé — aucune clé `message`.
    expect(Object.keys(result)).toEqual(["systemPrompt"]);
    expect(result.message).toBeUndefined();
    expect(result.systemPrompt!.startsWith("PROMPT SYSTÈME DE BASE\n\n<reactions_utilisateur>")).toBe(
      true,
    );
    expect(result.systemPrompt).toContain("Trop long");
    // Situé par l'extrait du message visé (le modèle sait DE QUOI on parle).
    expect(result.systemPrompt).toContain("Une réponse très longue.");
  });

  it("n'injecte RIEN quand aucune réaction n'est posée (prompt non gonflé)", async () => {
    const handlers = capture(portOf([]));
    const result = await handlers.get("before_agent_start")!(
      { prompt: "Bonjour", systemPrompt: "BASE" },
      readOnlyCtx("s1", [messageEntry("e-1", "assistant", "Réponse")]),
    );
    expect(result).toBeUndefined();
  });

  it("lit les réactions de LA session du contexte, bornées à N", async () => {
    const observed: string[] = [];
    const handlers = capture(portOf([view("e-1", "utile")], observed));
    await handlers.get("before_agent_start")!(
      { prompt: "Bonjour", systemPrompt: "BASE" },
      readOnlyCtx("sess-42", []),
    );
    expect(observed).toEqual([`sess-42:${REACTIONS_PROMPT_MAX}`]);
  });

  it("respecte une borne explicite plus petite", async () => {
    const views = [
      view("e-1", "utile"),
      view("e-2", "faux"),
      view("e-3", "fatigue"),
    ];
    const handlers = capture(portOf(views), 2);
    const result = (await handlers.get("before_agent_start")!(
      { prompt: "Bonjour", systemPrompt: "BASE" },
      readOnlyCtx("s1", []),
    )) as { systemPrompt?: string };
    expect(result.systemPrompt).toContain("Fatigué");
    expect(result.systemPrompt).toContain("Faux");
    expect(result.systemPrompt).not.toContain("Utile");
  });

  it("survit à un store en ÉCHEC (le tour part sans les réactions)", async () => {
    const handlers = capture({
      recentFor: () => {
        throw new Error("store indisponible");
      },
    });
    const result = await handlers.get("before_agent_start")!(
      { prompt: "Bonjour", systemPrompt: "BASE" },
      readOnlyCtx("s1", []),
    );
    expect(result).toBeUndefined();
  });

  it("survit à un contexte SANS identifiant de session", async () => {
    const handlers = capture(portOf([view("e-1", "utile")]));
    const result = await handlers.get("before_agent_start")!(
      { prompt: "Bonjour", systemPrompt: "BASE" },
      { sessionManager: { getSessionId: () => "", getBranch: () => [] } },
    );
    expect(result).toBeUndefined();
  });

  it("n'enregistre QUE `before_agent_start` (aucun autre point de câblage)", () => {
    const handlers = capture(portOf([]));
    expect([...handlers.keys()]).toEqual(["before_agent_start"]);
  });
});

describe("chaîne d'extensions — place des RÉACTIONS", () => {
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const port = portOf([view("e-1", "utile")]);

  function names(reactions?: ReactionsPort): string[] {
    const extensions = buildInlineExtensions({
      rules: { read: () => ({ text: "Règle.", chars: 6, truncated: false, exists: true }) },
      personality: {
        read: () => ({ text: "Je suis Yuki.", chars: 13, truncated: false, exists: true }),
      },
      memory: {
        recall: async () => ({ block: null, enabled: true, entries: 0, chars: 0, durationMs: 0 }),
        onTurnEnd: () => undefined,
        onBeforeCompact: () => undefined,
      },
      directory: { list: () => [] },
      heritage: { info: () => ({ present: false, entries: 0, manifest: null }) },
      ...(reactions ? { reactions } : {}),
      logger,
    } as never);
    return extensions.map((extension) => (extension as { name: string }).name);
  }

  it("s'ajoute EN DERNIER (règles → personnalité → mémoire → annuaire → heritage → réactions)", () => {
    expect(names(port)).toEqual([
      "yuki-rules",
      "yuki-personality",
      "yuki-memory",
      "yuki-agent-roster",
      "yuki-heritage",
      "yuki-reactions",
    ]);
  });

  it("n'est pas enregistrée du tout sans port (host nu, aucun bloc vide)", () => {
    expect(names()).not.toContain("yuki-reactions");
  });
});
