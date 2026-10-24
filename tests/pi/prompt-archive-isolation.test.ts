/**
 * PIÈGE ③ — l'archive des conversations ne fuit JAMAIS dans le prompt.
 *
 * Deux assertions STRUCTURELLES, pas des promesses :
 *  1. `buildInlineExtensions` (le SEUL chemin par lequel un contenu entre dans le
 *     prompt système, hors outils) ne contient AUCUNE extension d'archive : les
 *     extensions enregistrées sont exactement règles → personnalité → mémoire →
 *     annuaire → heritage, et aucune ne lit le port d'archive ;
 *  2. même en exécutant TOUS les handlers `before_agent_start` des extensions
 *     avec une archive PLEINE, aucun prompt système produit ne contient le texte
 *     archivé.
 *
 * ⚠️ La seule voie d'accès au contenu est l'OUTIL
 * `chercher_conversations_archivees`, sur demande explicite de l'utilisateur.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildInlineExtensions } from "../../src/pi/sdk-host.js";
import {
  CONVERSATION_ARCHIVE_TOOL_NAME,
  createConversationArchiveTools,
} from "../../src/pi/sdk/conversation-archive-tools.js";
import { ConversationArchiveStore } from "../../src/memory/index.js";
import type { HeritagePort } from "../../src/memory/index.js";
import type { MemoryPort } from "../../src/memory/types.js";
import type { PersonalityPort } from "../../src/personality/types.js";
import type { RulesPort } from "../../src/rules/types.js";
import { createLogger } from "../../src/observability/logger.js";

/** Texte SENTINELLE : s'il apparaît dans un prompt, c'est une fuite. */
const SECRET_TEXTE = "SENTINELLE-ARCHIVE-42 potager au fond du jardin";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-archive-leak-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function logger() {
  return createLogger({ level: "error", sink: () => undefined, secretValues: [] });
}

function populatedArchive(): ConversationArchiveStore {
  const dir = tempDir();
  const archive = new ConversationArchiveStore({
    dir: join(dir, "conversations-archive"),
    indexPath: join(dir, "index.sqlite"),
    logger: logger(),
  });
  archive.archiveConversation({
    id: "sess-leak",
    title: "Conversation sentinelle",
    archivedAt: "2026-10-24T12:00:00.000Z",
    messages: [{ at: "2026-10-20T10:00:00.000Z", role: "user", text: SECRET_TEXTE }],
  });
  return archive;
}

/** Port mémoire minimal : le rappel renvoie un bloc NON vide (pire cas). */
function memoryWithBlock(): MemoryPort {
  const block = "## Mémoire durable de Yuki\n- [fait] Un souvenir quelconque";
  return {
    recall: async () => ({
      block,
      enabled: true,
      entries: 1,
      chars: block.length,
      durationMs: 0,
    }),
    onTurnEnd: () => undefined,
    onBeforeCompact: () => undefined,
    onSessionSetAside: () => undefined,
  };
}

const HERITAGE: HeritagePort = {
  info: () => ({ present: false, entries: 0, manifest: null }),
  list: () => [],
  read: () => undefined,
};

const PERSONALITY: PersonalityPort = {
  read: () => ({ text: "Je suis Yuki.", chars: 15, truncated: false, exists: true }),
};

const RULES: RulesPort = {
  read: () => ({ text: "Règles strictes.", chars: 16, truncated: false, exists: true }),
};

type Handler = (event: unknown, ctx: unknown) => unknown;

/** Exécute tous les `before_agent_start` et renvoie les prompts produits. */
async function runBeforeAgentStart(
  factories: ReturnType<typeof buildInlineExtensions>,
): Promise<{ names: string[]; prompts: string[] }> {
  const names: string[] = [];
  const prompts: string[] = [];
  for (const extension of factories) {
    names.push(extension.name);
    const handlers = new Map<string, Handler>();
    const run = typeof extension === "function" ? extension : extension.factory;
    (run as (pi: unknown) => void)({
      on: (name: string, handler: Handler) => {
        handlers.set(name, handler);
      },
    });
    const handler = handlers.get("before_agent_start");
    if (!handler) continue;
    const result = (await handler(
      { prompt: "Qu'est-ce qu'on s'était dit à propos du potager ?", systemPrompt: "BASE" },
      {},
    )) as { systemPrompt?: string } | undefined;
    if (result?.systemPrompt) prompts.push(result.systemPrompt);
  }
  return { names, prompts };
}

describe("PIÈGE ③ — aucune fuite de l'archive dans le prompt", () => {
  it("AUCUNE extension d'archive n'est enregistrée (règles → personnalité → mémoire → annuaire → heritage)", async () => {
    const archive = populatedArchive();
    const factories = buildInlineExtensions({
      rules: RULES,
      personality: PERSONALITY,
      memory: memoryWithBlock(),
      heritage: HERITAGE,
      logger: logger(),
    });
    // Le port d'archive n'est même pas une option de `buildInlineExtensions` :
    // rien ne peut l'injecter. On vérifie les NOMS réellement enregistrés.
    const { names } = await runBeforeAgentStart(factories);
    expect(names).toEqual([
      "yuki-rules",
      "yuki-personality",
      "yuki-memory",
      "yuki-heritage",
    ]);
    expect(names.some((name) => /archive/i.test(name))).toBe(false);
    archive.close();
  });

  it("le texte archivé n'apparaît dans AUCUN prompt système produit par les extensions", async () => {
    const archive = populatedArchive();
    const factories = buildInlineExtensions({
      rules: RULES,
      personality: PERSONALITY,
      memory: memoryWithBlock(),
      heritage: HERITAGE,
      logger: logger(),
    });
    const { prompts } = await runBeforeAgentStart(factories);
    expect(prompts.length).toBeGreaterThan(0);
    for (const prompt of prompts) {
      expect(prompt).not.toContain("SENTINELLE-ARCHIVE-42");
      expect(prompt).not.toContain("potager au fond du jardin");
    }
    archive.close();
  });

  it("le contenu n'est accessible QUE par l'outil, et seulement s'il est appelé", async () => {
    const archive = populatedArchive();
    // Sans appel : rien dans l'archive n'est « injecté » nulle part.
    const factories = buildInlineExtensions({ memory: memoryWithBlock(), logger: logger() });
    const { prompts } = await runBeforeAgentStart(factories);
    expect(prompts.join("\n")).not.toContain("SENTINELLE-ARCHIVE-42");

    // Avec appel explicite de l'outil : là, et seulement là, le texte sort.
    const tool = createConversationArchiveTools(archive)[0]!;
    expect(tool.name).toBe(CONVERSATION_ARCHIVE_TOOL_NAME);
    const fn = tool.execute as unknown as (
      id: string,
      values: unknown,
      signal: undefined,
    ) => Promise<{ content: { type: string; text: string }[] }>;
    const result = await fn("call-1", { recherche: "sentinelle" }, undefined);
    expect(result.content.map((part) => part.text).join("")).toContain("SENTINELLE-ARCHIVE-42");
    archive.close();
  });

  it("le bloc d'archive CITE ne devient jamais un souvenir (filtre déterministe)", async () => {
    const archive = populatedArchive();
    const tool = createConversationArchiveTools(archive)[0]!;
    const fn = tool.execute as unknown as (
      id: string,
      values: unknown,
      signal: undefined,
    ) => Promise<{ content: { type: string; text: string }[] }>;
    const framed = (await fn("call-1", { recherche: "sentinelle" }, undefined)).content
      .map((part) => part.text)
      .join("");
    const { sanitizeMemoryText } = await import("../../src/memory/filter.js");
    expect(sanitizeMemoryText(framed)).toBe("");
    archive.close();
  });
});
