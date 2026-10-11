/**
 * Extension SDK de personnalité + VERROU DE L'ORDRE D'INJECTION.
 *
 * Prouve :
 *  - la personnalité est injectée dans le PROMPT SYSTÈME du tour (mécanisme NON
 *    PERSISTÉ) et JAMAIS comme `message` (`Object.keys(result) === ["systemPrompt"]`) ;
 *  - fichier absent/vide ⇒ AUCUNE injection ;
 *  - l'ORDRE d'application est **règles → personnalité → mémoire → annuaire →
 *    heritage**, et chaque bloc est CONCATÉNÉ (aucun n'écrase un autre).
 *
 * ⚠️ Point délicat : quatre autres extensions modifient déjà le prompt du tour.
 * L'ordre est verrouillé en testant directement `buildInlineExtensions`
 * (`src/pi/sdk-host.ts`), source de vérité de l'enregistrement. Ordre attendu :
 * **règles → personnalité → mémoire → annuaire → heritage**.
 */

import { describe, expect, it } from "vitest";

import { AGENT_LIST_TAG } from "../../src/agents/output.js";
import { HERITAGE_NOTICE } from "../../src/pi/sdk/heritage-extension.js";
import {
  PERSONALITY_EXTENSION_NAME,
  createPersonalityExtensionFactory,
} from "../../src/pi/sdk/personality-extension.js";
import {
  RULES_EXTENSION_NAME,
  createRulesExtensionFactory,
} from "../../src/pi/sdk/rules-extension.js";
import { buildInlineExtensions } from "../../src/pi/sdk-host.js";
import type { MemoryPort, MemoryRecallResult } from "../../src/memory/types.js";
import type { PersonalityDocument, PersonalityPort } from "../../src/personality/types.js";
import type { RulesDocument, RulesPort } from "../../src/rules/types.js";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

type Handler = (event: unknown, ctx?: unknown) => unknown;

/** Récupère le handler `before_agent_start` d'une fabrique d'extension. */
function handlersOf(extension: InlineExtension): Handler[] {
  const handlers: Handler[] = [];
  const run = typeof extension === "function" ? extension : extension.factory;
  run({
    on: (name: string, handler: Handler) => {
      if (name === "before_agent_start") handlers.push(handler);
    },
  } as never);
  return handlers;
}

function fakePersonality(text: string): PersonalityPort {
  return {
    read: (): PersonalityDocument => ({
      text,
      chars: Array.from(text).length,
      truncated: false,
      exists: text.length > 0,
    }),
  };
}

function fakeRules(text: string): RulesPort {
  return {
    read: (): RulesDocument => ({
      text,
      chars: Array.from(text).length,
      truncated: false,
      exists: text.length > 0,
    }),
  };
}

function fakeMemory(block: string | null): MemoryPort {
  return {
    recall: async (): Promise<MemoryRecallResult> => ({
      block,
      enabled: true,
      entries: block ? 1 : 0,
      chars: block ? block.length : 0,
      durationMs: 0,
    }),
    onTurnEnd: () => undefined,
    onBeforeCompact: () => undefined,
  };
}

const personality = {
  read: () => ({ text: "Je suis Yuki, calme et précise.", chars: 32, truncated: false, exists: true }),
};

const rules = {
  read: () => ({
    text: "Ne jamais divulguer mes secrets.",
    chars: 30,
    truncated: false,
    exists: true,
  }),
};

/** Réplique du chaînage du SDK : chaque handler reçoit le prompt COURANT. */
async function runChain(
  extensions: InlineExtension[],
  base = "PROMPT DE BASE",
): Promise<string> {
  let current = base;
  for (const extension of extensions) {
    for (const handler of handlersOf(extension)) {
      const result = (await handler({
        prompt: "Bonjour",
        systemPrompt: current,
      })) as { systemPrompt?: string } | undefined;
      if (result && result.systemPrompt !== undefined) current = result.systemPrompt;
    }
  }
  return current;
}

describe("extension de personnalité — injection (before_agent_start)", () => {
  it("injecte le bloc dans le PROMPT SYSTÈME, jamais comme message (non persisté)", async () => {
    const [handler] = handlersOf(
      createPersonalityExtensionFactory(fakePersonality("Je suis Yuki.")),
    );
    const result = (await handler!({
      prompt: "Bonjour",
      systemPrompt: "PROMPT DE BASE",
    })) as { message?: unknown; systemPrompt?: string };

    expect(Object.keys(result)).toEqual(["systemPrompt"]);
    expect(result.message).toBeUndefined();
    expect(result.systemPrompt).toContain("PROMPT DE BASE");
    expect(result.systemPrompt).toContain("<personnalite>");
    expect(result.systemPrompt).toContain("Je suis Yuki.");
  });

  it("fichier ABSENT ou VIDE : aucune injection (aucun bloc vide)", async () => {
    for (const text of ["", "   ", "\n"]) {
      const [handler] = handlersOf(createPersonalityExtensionFactory(fakePersonality(text)));
      const result = await handler!({ prompt: "Bonjour", systemPrompt: "BASE" });
      expect(result).toBeUndefined();
    }
  });

  it("lecture qui ÉCHOUE : aucune exception, tour omis", async () => {
    const [handler] = handlersOf(
      createPersonalityExtensionFactory({
        read: () => {
          throw new Error("disque illisible");
        },
      }),
    );
    expect(await handler!({ prompt: "x", systemPrompt: "BASE" })).toBeUndefined();
  });
});

describe("ORDRE d'injection des extensions (verrou)", () => {
  it("enregistre dans l'ordre règles → personnalité → mémoire → annuaire → heritage", () => {
    const extensions = buildInlineExtensions({
      rules,
      personality,
      memory: fakeMemory("MEM"),
      directory: { list: () => [{ name: "nuc00", agentId: "a1" }] },
      heritage: { info: () => ({ present: true, entries: 1, manifest: null }) },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    } as never);
    expect(extensions.map((extension) => (extension as { name: string }).name)).toEqual([
      RULES_EXTENSION_NAME,
      PERSONALITY_EXTENSION_NAME,
      "yuki-memory",
      "yuki-agent-roster",
      "yuki-heritage",
    ]);
  });

  it("les cinq blocs sont présents, CONCATÉNÉS dans le bon ordre (règles AVANT personnalité)", async () => {
    const extensions = buildInlineExtensions({
      rules,
      personality,
      memory: fakeMemory("## Mémoire durable de Yuki\n- [fait] un souvenir"),
      directory: { list: () => [{ name: "nuc00", agentId: "a1" }] },
      heritage: { info: () => ({ present: true, entries: 1, manifest: null }) },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    } as never);

    const prompt = await runChain(extensions);

    const indexRules = prompt.indexOf("<regles>");
    const indexPersonality = prompt.indexOf("<personnalite>");
    const indexMemory = prompt.indexOf("## Mémoire durable de Yuki");
    const indexRoster = prompt.indexOf(`<${AGENT_LIST_TAG}>`);
    const indexHeritage = prompt.indexOf(HERITAGE_NOTICE);

    // Les cinq blocs sont présents…
    expect(indexRules).toBeGreaterThan(-1);
    expect(indexPersonality).toBeGreaterThan(-1);
    expect(indexMemory).toBeGreaterThan(-1);
    expect(indexRoster).toBeGreaterThan(-1);
    expect(indexHeritage).toBeGreaterThan(-1);
    // …et dans l'ORDRE attendu : les RÈGLES viennent EN PREMIER.
    expect(indexRules).toBeLessThan(indexPersonality);
    expect(indexPersonality).toBeLessThan(indexMemory);
    expect(indexMemory).toBeLessThan(indexRoster);
    expect(indexRoster).toBeLessThan(indexHeritage);
    // Le prompt de base est toujours là (aucun écrasement).
    expect(prompt.startsWith("PROMPT DE BASE")).toBe(true);
  });

  it("sans personnalité : les autres blocs restent présents (pas de régression)", async () => {
    const extensions = buildInlineExtensions({
      memory: fakeMemory("## Mémoire durable de Yuki\n- [fait] x"),
      directory: { list: () => [{ name: "nuc00", agentId: "a1" }] },
      heritage: { info: () => ({ present: true, entries: 1, manifest: null }) },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    } as never);
    expect(extensions).toHaveLength(3);
    const prompt = await runChain(extensions);
    expect(prompt).toContain("## Mémoire durable de Yuki");
    expect(prompt).toContain(`<${AGENT_LIST_TAG}>`);
    expect(prompt).toContain(HERITAGE_NOTICE);
    expect(prompt).not.toContain("<personnalite>");
    expect(prompt).not.toContain("<regles>");
  });

  it("sans règles : la personnalité et le reste restent présents (pas de régression)", async () => {
    const extensions = buildInlineExtensions({
      personality,
      memory: fakeMemory("## Mémoire durable de Yuki\n- [fait] x"),
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    } as never);
    const prompt = await runChain(extensions);
    expect(prompt).toContain("<personnalite>");
    expect(prompt).not.toContain("<regles>");
  });
});

describe("extension de RÈGLES strictes — injection (before_agent_start)", () => {
  it("injecte le bloc dans le PROMPT SYSTÈME, jamais comme message (non persisté)", async () => {
    const [handler] = handlersOf(createRulesExtensionFactory(fakeRules("Ne jamais mentir.")));
    const result = (await handler!({
      prompt: "Bonjour",
      systemPrompt: "PROMPT DE BASE",
    })) as { message?: unknown; systemPrompt?: string };

    expect(Object.keys(result)).toEqual(["systemPrompt"]);
    expect(result.message).toBeUndefined();
    expect(result.systemPrompt).toContain("PROMPT DE BASE");
    expect(result.systemPrompt).toContain("<regles>");
    expect(result.systemPrompt).toContain("Ne jamais mentir.");
  });

  it("déclare la priorité règles > personnalité > mémoire dans l'en-tête", async () => {
    const [handler] = handlersOf(createRulesExtensionFactory(fakeRules("x")));
    const result = (await handler!({
      prompt: "Bonjour",
      systemPrompt: "BASE",
    })) as { systemPrompt?: string };
    expect(result.systemPrompt).toContain("PRIMENT sur votre personnalité");
    expect(result.systemPrompt).toContain("NON MODIFIABLES");
  });

  it("fichier ABSENT ou VIDE : aucune injection (aucun en-tête orphelin)", async () => {
    for (const text of ["", "   ", "\n"]) {
      const [handler] = handlersOf(createRulesExtensionFactory(fakeRules(text)));
      const result = await handler!({ prompt: "Bonjour", systemPrompt: "BASE" });
      expect(result).toBeUndefined();
    }
  });

  it("lecture qui ÉCHOUE : aucune exception, tour omis", async () => {
    const [handler] = handlersOf(
      createRulesExtensionFactory({
        read: () => {
          throw new Error("disque illisible");
        },
      }),
    );
    expect(await handler!({ prompt: "x", systemPrompt: "BASE" })).toBeUndefined();
  });

  it("n'enregistre AUCUN outil : Yuki ne peut pas écrire ses règles via l'extension", () => {
    // L'extension ne s'abonne QU'à `before_agent_start` (injection) : aucun
    // outil n'est déclaré, donc le modèle ne peut pas écrire `rules.md`.
    const events: string[] = [];
    const extension = createRulesExtensionFactory(fakeRules("x"));
    const run = typeof extension === "function" ? extension : extension.factory;
    run({
      on: (name: string) => {
        events.push(name);
      },
      // Toute tentative de déclarer un outil lèverait (piège volontaire).
      registerTool: () => {
        throw new Error("un outil ne doit JAMAIS être enregistré par l'extension de règles");
      },
      addTool: () => {
        throw new Error("un outil ne doit JAMAIS être enregistré par l'extension de règles");
      },
    } as never);
    expect(events).toEqual(["before_agent_start"]);
  });
});
