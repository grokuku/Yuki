/**
 * PROMPT SYSTÈME — ORDRE DES EXTENSIONS, RÈGLES STRICTES, et ABSENCE d'extension
 * de personnalité.
 *
 * ⚠️ CE FICHIER REMPLACE `tests/pi/personality-extension.test.ts` (2026-11-14) :
 * l'extension de personnalité n'existe PLUS. Elle était la SECONDE source de
 * personnalité (le fichier `personality.md`), concaténée APRÈS le prompt composé
 * — donc elle GAGNAIT sur `prompts.personnalite`. La personnalité a maintenant
 * une seule source, composée une fois par `src/llm/prompt-systeme.ts`.
 *
 * Ce qui est VERROUILLÉ ici :
 *  ① aucune extension de personnalité n'est enregistrée, et aucun fichier de
 *    `src/pi/**` ne lit plus `PersonalityPort` (le fichier n'est plus concaténé
 *    à la fin du `systemPrompt`) ;
 *  ② l'ORDRE d'application est **règles → mémoire → annuaire → heritage**, chaque
 *    bloc étant CONCATÉNÉ (aucun n'écrase un autre) ;
 *  ③ les RÈGLES restent une extension (relues à chaud, en dernier) et leur bloc
 *    balisé DÉCLARE qu'elles priment sur la personnalité ;
 *  ④ l'extension de règles n'enregistre AUCUN outil (le modèle ne peut pas
 *    écrire ses règles).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AGENT_LIST_TAG } from "../../src/agents/output.js";
import { HERITAGE_NOTICE } from "../../src/pi/sdk/heritage-extension.js";
import {
  RULES_EXTENSION_NAME,
  createRulesExtensionFactory,
} from "../../src/pi/sdk/rules-extension.js";
import { buildInlineExtensions } from "../../src/pi/sdk-host.js";
import type { MemoryPort, MemoryRecallResult } from "../../src/memory/types.js";
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

const rules = {
  read: () => ({
    text: "Ne jamais divulguer mes secrets.",
    chars: 30,
    truncated: false,
    exists: true,
  }),
};

const logger = { debug() {}, info() {}, warn() {}, error() {} };

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

describe("① plus d'extension de personnalité (une seule source)", () => {
  it("`buildInlineExtensions` n'enregistre AUCUNE extension de personnalité", () => {
    const extensions = buildInlineExtensions({
      rules,
      memory: fakeMemory("MEM"),
      directory: { list: () => [{ name: "nuc00", agentId: "a1" }] },
      heritage: { info: () => ({ present: true, entries: 1, manifest: null }) },
      logger,
    } as never);
    const noms = extensions.map((extension) => (extension as { name: string }).name);
    expect(noms).not.toContain("yuki-personality");
    expect(noms.some((nom) => /personal|personnal/i.test(nom))).toBe(false);
  });

  it("aucun fichier de `src/pi/**` ne lit le port de personnalité (plus de concaténation)", () => {
    // Garde STRUCTURELLE : le fichier `personality.md` n'est plus injecté dans le
    // prompt. S'il revenait par un import, ce test le dirait.
    const coupables: string[] = [];
    const parcourir = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const complet = join(dir, entry.name);
        if (entry.isDirectory()) {
          parcourir(complet);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
        const source = readFileSync(complet, "utf8");
        if (/PersonalityPort|PersonalityExtension|personality-extension/.test(source)) {
          coupables.push(complet.replace(`${process.cwd()}/`, ""));
        }
      }
    };
    parcourir(join(process.cwd(), "src", "pi"));
    expect(coupables).toEqual([]);
  });
});

describe("② ORDRE d'injection des extensions (verrou)", () => {
  it("enregistre dans l'ordre règles → mémoire → annuaire → heritage", () => {
    const extensions = buildInlineExtensions({
      rules,
      memory: fakeMemory("MEM"),
      directory: { list: () => [{ name: "nuc00", agentId: "a1" }] },
      heritage: { info: () => ({ present: true, entries: 1, manifest: null }) },
      logger,
    } as never);
    expect(extensions.map((extension) => (extension as { name: string }).name)).toEqual([
      RULES_EXTENSION_NAME,
      "yuki-memory",
      "yuki-agent-roster",
      "yuki-heritage",
    ]);
  });

  it("les quatre blocs sont présents, CONCATÉNÉS dans le bon ordre, sans écraser la base", async () => {
    const extensions = buildInlineExtensions({
      rules,
      memory: fakeMemory("## Mémoire durable de Yuki\n- [fait] un souvenir"),
      directory: { list: () => [{ name: "nuc00", agentId: "a1" }] },
      heritage: { info: () => ({ present: true, entries: 1, manifest: null }) },
      logger,
    } as never);

    const prompt = await runChain(extensions);

    const indexRules = prompt.indexOf("<regles>");
    const indexMemory = prompt.indexOf("## Mémoire durable de Yuki");
    const indexRoster = prompt.indexOf(`<${AGENT_LIST_TAG}>`);
    const indexHeritage = prompt.indexOf(HERITAGE_NOTICE);

    expect(indexRules).toBeGreaterThan(-1);
    expect(indexMemory).toBeGreaterThan(-1);
    expect(indexRoster).toBeGreaterThan(-1);
    expect(indexHeritage).toBeGreaterThan(-1);
    expect(indexRules).toBeLessThan(indexMemory);
    expect(indexMemory).toBeLessThan(indexRoster);
    expect(indexRoster).toBeLessThan(indexHeritage);
    expect(prompt.startsWith("PROMPT DE BASE")).toBe(true);
  });

  it("sans règles : les autres blocs restent présents (pas de régression)", async () => {
    const extensions = buildInlineExtensions({
      memory: fakeMemory("## Mémoire durable de Yuki\n- [fait] x"),
      directory: { list: () => [{ name: "nuc00", agentId: "a1" }] },
      heritage: { info: () => ({ present: true, entries: 1, manifest: null }) },
      logger,
    } as never);
    expect(extensions).toHaveLength(3);
    const prompt = await runChain(extensions);
    expect(prompt).toContain("## Mémoire durable de Yuki");
    expect(prompt).toContain(`<${AGENT_LIST_TAG}>`);
    expect(prompt).toContain(HERITAGE_NOTICE);
    expect(prompt).not.toContain("<regles>");
  });
});

describe("③ extension de RÈGLES strictes — injection et PRIORITÉ", () => {
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

  it("n'enregistre AUCUN outil : le modèle ne peut pas écrire ses règles", () => {
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
