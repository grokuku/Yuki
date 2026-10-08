/**
 * Extension SDK de mémoire (Lot 12) — invoquée directement avec un faux `pi` et
 * un faux `ctx`. Prouve que :
 *  - le RAPPEL augmente SEULEMENT `systemPrompt` (mécanisme NON PERSISTÉ) et
 *    JAMAIS `message` (qui créerait une entrée `CustomMessageEntry` persistée,
 *    donc une pollution du transcript) ;
 *  - l'absence de mémoire est silencieuse (dégradation gracieuse) ;
 *  - `agent_end` déclenche l'écriture sur le DERNIER échange réel (et ignore les
 *    prompts SYNTHIQUES de report de job) ;
 *  - `session_before_compact` déclenche la consolidation.
 *
 * Aucun type SDK n'est importé au RUNTIME par `memory-extension.ts` (imports de
 * types uniquement), donc ce test n'a besoin d'aucun modèle ni réseau.
 */

import { describe, expect, it } from "vitest";

import { createMemoryExtensionFactory, MEMORY_IDLE_NOTICE } from "../../src/pi/sdk/memory-extension.js";
import type {
  BeforeCompactInput,
  MemoryPort,
  MemoryRecallResult,
  TurnEndInput,
} from "../../src/memory/types.js";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface Captured {
  handlers: Map<string, Handler>;
  factory: ReturnType<typeof createMemoryExtensionFactory>;
}

function capture(port: MemoryPort, prefixes: readonly string[] = []): Captured {
  const handlers = new Map<string, Handler>();
  const factory = createMemoryExtensionFactory(port, {
    syntheticUserPrefixes: prefixes,
  });
  const run = typeof factory === "function" ? factory : factory.factory;
  run({
    on: (name: string, handler: Handler) => {
      handlers.set(name, handler);
    },
  } as never);
  return { handlers, factory };
}

function fakePort(overrides: Partial<MemoryPort> = {}): MemoryPort {
  return {
    recall: async (): Promise<MemoryRecallResult> => ({
      block: null,
      enabled: false,
      entries: 0,
      chars: 0,
      durationMs: 0,
    }),
    onTurnEnd: () => undefined,
    onBeforeCompact: () => undefined,
    ...overrides,
  };
}

/** Faux `ctx` dont la session est LECTURE SEULE (toute écriture ferait échouer). */
function readOnlyCtx(entries: unknown[]): unknown {
  return {
    sessionManager: {
      getBranch: () => entries,
      // Aucune méthode d'écriture n'est définie : un appel accidentel lèverait.
    },
  };
}

describe("extension de mémoire — RAPPEL (before_agent_start)", () => {
  it("injecte le bloc DANS LE PROMPT SYSTÈME, jamais comme message (non persisté)", async () => {
    const block = "## Mémoire durable de Yuki\n- [fait] X (donnée)";
    const port = fakePort({
      recall: async () => ({ block, enabled: true, entries: 1, chars: block.length, durationMs: 1 }),
    });
    const { handlers } = capture(port);
    const handler = handlers.get("before_agent_start");
    expect(handler).toBeDefined();

    const result = (await handler!(
      { prompt: "Bonjour", systemPrompt: "PROMPT SYSTÈME DE BASE" },
      readOnlyCtx([]),
    )) as { message?: unknown; systemPrompt?: string };

    // Preuve : seul `systemPrompt` est renvoyé — aucune clé `message`.
    expect(Object.keys(result)).toEqual(["systemPrompt"]);
    expect(result.message).toBeUndefined();
    expect(result.systemPrompt).toBe(`PROMPT SYSTÈME DE BASE\n\n${block}`);
    // Un bloc de souvenirs ne DOUBLE pas la mention d'état vide.
    expect(result.systemPrompt).not.toContain(MEMORY_IDLE_NOTICE);
  });

  it("ne renvoie RIEN quand la mémoire est DÉSACTIVÉE (dégradation silencieuse)", async () => {
    const { handlers } = capture(fakePort());
    const result = await handlers.get("before_agent_start")!(
      { prompt: "Bonjour", systemPrompt: "BASE" },
      readOnlyCtx([]),
    );
    expect(result).toBeUndefined();
  });

  it("mémoire ACTIVÉE sans souvenir pertinent ⇒ UNE mention honnête, jamais comme message", async () => {
    const port = fakePort({
      recall: async () => ({ block: null, enabled: true, entries: 0, chars: 0, durationMs: 0 }),
    });
    const { handlers } = capture(port);
    const result = (await handlers.get("before_agent_start")!(
      { prompt: "Bonjour", systemPrompt: "BASE" },
      readOnlyCtx([]),
    )) as { message?: unknown; systemPrompt?: string } | undefined;

    expect(result).toBeDefined();
    expect(Object.keys(result!)).toEqual(["systemPrompt"]);
    expect(result!.message).toBeUndefined();
    expect(result!.systemPrompt).toBe(`BASE\n\n${MEMORY_IDLE_NOTICE}`);
    // EXACTEMENT une fois (pas de doublon).
    expect(result!.systemPrompt!.split(MEMORY_IDLE_NOTICE)).toHaveLength(2);
  });
});

describe("extension de mémoire — ÉCRITURE (agent_end / compaction)", () => {
  const entries = [
    {
      id: "e1",
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "Je préfère le thé" }] },
    },
    {
      id: "e2",
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "C'est noté" }] },
    },
  ];

  it("déclenche une extraction sur le DERNIER échange, avec la source du message", async () => {
    const calls: TurnEndInput[] = [];
    const { handlers } = capture(fakePort({ onTurnEnd: (input) => calls.push(input) }));
    await handlers.get("agent_end")!({}, readOnlyCtx(entries));
    expect(calls).toEqual([
      { userText: "Je préfère le thé", assistantText: "C'est noté", source: "e1" },
    ]);
  });

  it("ignore un échange dont le prompt est SYNTHÉTIQUE (report de job)", async () => {
    const calls: TurnEndInput[] = [];
    const synthetic = [
      {
        id: "e1",
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "[RÉSULTAT DE TÂCHE EN ARRIÈRE-PLAN]\n..." }],
        },
      },
      {
        id: "e2",
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "Terminé." }] },
      },
    ];
    const { handlers } = capture(
      fakePort({ onTurnEnd: (input) => calls.push(input) }),
      ["[RÉSULTAT DE TÂCHE EN ARRIÈRE-PLAN]"],
    );
    await handlers.get("agent_end")!({}, readOnlyCtx(synthetic));
    expect(calls).toHaveLength(0);
  });

  it("déclenche la consolidation avec les messages sur le point d'être perdus", async () => {
    const calls: BeforeCompactInput[] = [];
    const { handlers } = capture(
      fakePort({ onBeforeCompact: (input) => calls.push(input) }),
    );
    await handlers.get("session_before_compact")!(
      {
        preparation: {
          messagesToSummarize: [
            { role: "user", content: [{ type: "text", text: "Un message perdu" }] },
            { role: "toolResult", content: [{ type: "text", text: "résultat d'outil" }] },
          ],
          turnPrefixMessages: [
            { role: "assistant", content: [{ type: "text", text: "Réponse partielle" }] },
          ],
          previousSummary: "résumé précédent",
        },
      },
      readOnlyCtx([]),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.messages).toEqual([
      { role: "user", text: "Un message perdu" },
      { role: "assistant", text: "Réponse partielle" },
    ]);
    expect(calls[0]?.previousSummary).toBe("résumé précédent");
  });
});
