/**
 * Extension SDK — signal d'existence de l'archive « vie antérieure » (Lot 13).
 *
 * Prouve : une seule ligne ajoutée au PROMPT SYSTÈME (mécanisme NON PERSISTÉ,
 * jamais `message`), AUCUN contenu d'archive injecté, et aucune injection quand
 * l'archive est absente/vide ou illisible.
 */

import { describe, expect, it } from "vitest";

import {
  HERITAGE_NOTICE,
  createHeritageExtensionFactory,
} from "../../src/pi/sdk/heritage-extension.js";
import type { HeritageInfo } from "../../src/memory/index.js";

type Handler = (event: unknown) => unknown;

function capture(
  info: () => HeritageInfo,
): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const factory = createHeritageExtensionFactory({ info });
  const run = typeof factory === "function" ? factory : factory.factory;
  run({
    on: (name: string, handler: Handler) => {
      handlers.set(name, handler);
    },
  } as never);
  return handlers;
}

function inject(
  handlers: Map<string, Handler>,
  systemPrompt = "PROMPT SYSTÈME DE BASE",
): { message?: unknown; systemPrompt?: string } | undefined {
  const handler = handlers.get("before_agent_start");
  expect(handler).toBeDefined();
  return handler!({ prompt: "Bonjour", systemPrompt }) as
    | { message?: unknown; systemPrompt?: string }
    | undefined;
}

describe("archive « vie antérieure » — signal d'existence (prompt système)", () => {
  it("archive peuplée : ajoute UNE ligne au prompt système, jamais un message", () => {
    const handlers = capture(() => ({ present: true, entries: 3, manifest: null }));
    const result = inject(handlers);
    expect(Object.keys(result ?? {})).toEqual(["systemPrompt"]);
    expect(result?.message).toBeUndefined();
    expect(result?.systemPrompt).toContain("PROMPT SYSTÈME DE BASE");
    expect(result?.systemPrompt).toContain(HERITAGE_NOTICE);
    expect(result?.systemPrompt).toContain("archive_vie_anterieure");
  });

  it("archive ABSENTE ou VIDE : aucune injection", () => {
    expect(inject(capture(() => ({ present: false, entries: 0, manifest: null })))).toBeUndefined();
    expect(inject(capture(() => ({ present: true, entries: 0, manifest: null })))).toBeUndefined();
  });

  it("lecture qui ÉCHOUE : aucune exception, tour omis", () => {
    const handlers = capture(() => {
      throw new Error("disque illisible");
    });
    expect(inject(handlers)).toBeUndefined();
  });
});
