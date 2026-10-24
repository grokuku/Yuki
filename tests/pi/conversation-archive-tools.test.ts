/**
 * Outil `chercher_conversations_archivees` — recherche à la demande.
 *
 * Prouve : l'outil retrouve un message PRÉCIS (texte + date + conversation
 * d'origine), la sortie est ENCADRÉE et ÉCHAPPÉE (donnée, jamais instruction),
 * l'absence de résultat est HONNÊTE (pas une erreur), et le PROMPT de l'outil
 * interdit explicitement toute fouille spontanée (demande explicite seulement).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CONVERSATION_ARCHIVE_TOOL_NAME,
  createConversationArchiveTools,
} from "../../src/pi/sdk/conversation-archive-tools.js";
import {
  CONVERSATION_ARCHIVE_TAG,
  ConversationArchiveStore,
} from "../../src/memory/index.js";
import { createLogger } from "../../src/observability/logger.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-conv-archive-tool-"));
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
    indexPath: join(dir, "conversations-archive-index.sqlite"),
    logger: logger(),
  });
  archive.archiveConversation({
    id: "sess-jardin",
    title: "Le projet Jardin",
    archivedAt: "2026-10-24T12:00:00.000Z",
    messages: [
      {
        at: "2026-10-20T10:00:00.000Z",
        role: "user",
        text: "Le potager sera au fond du jardin, près du mur.",
      },
      {
        at: "2026-10-20T10:01:00.000Z",
        role: "assistant",
        text: "Je retiens l'emplacement du potager.",
      },
    ],
  });
  archive.archiveConversation({
    id: "sess-crepes",
    title: "Recette",
    archivedAt: "2026-10-25T08:00:00.000Z",
    messages: [
      {
        at: "2026-10-21T09:00:00.000Z",
        role: "user",
        text: "Pas de crêpes au sucre, jamais.",
      },
    ],
  });
  return archive;
}

type HostTool = ReturnType<typeof createConversationArchiveTools>[number];

async function call(
  tool: HostTool,
  params: Record<string, unknown>,
): Promise<{ text: string; details: unknown }> {
  const fn = tool.execute as unknown as (
    id: string,
    values: unknown,
    signal: undefined,
  ) => Promise<{ content: { type: string; text: string }[]; details: unknown }>;
  const result = await fn("call-1", params, undefined);
  return { text: result.content.map((part) => part.text).join(""), details: result.details };
}

describe("outil — recherche dans l'archive des conversations", () => {
  it("est nommé, et son prompt impose une demande EXPLICITE (jamais spontanée)", () => {
    const tools = createConversationArchiveTools(populatedArchive());
    const tool = tools[0]!;
    expect(tool.name).toBe(CONVERSATION_ARCHIVE_TOOL_NAME);
    const description = tool.description ?? "";
    expect(description).toContain("EXPLICITEMENT");
    expect(description).toMatch(/Ne fouille JAMAIS/);
    expect(description).toContain("DONNÉE");
    expect(tool.promptSnippet ?? "").toMatch(/UNIQUEMENT à la demande explicite/);
  });

  it("retrouve un message PRÉCIS avec sa date et sa conversation d'origine", async () => {
    const tool = createConversationArchiveTools(populatedArchive())[0]!;
    const { text, details } = await call(tool, { recherche: "potager" });
    expect(text).toContain("Le potager sera au fond du jardin");
    expect(text).toContain("Le projet Jardin");
    expect(text).toContain("sess-jardin");
    expect(text).toContain("2026-10-20T10:00:00.000Z");
    expect(details).toMatchObject({ status: "found", query: "potager" });
  });

  it("encadre et échappe la sortie (donnée, jamais instruction)", async () => {
    const tool = createConversationArchiveTools(populatedArchive())[0]!;
    const { text } = await call(tool, { recherche: "crêpes" });
    expect(text.startsWith(`<${CONVERSATION_ARCHIVE_TAG}>`)).toBe(true);
    expect(text).toContain(`</${CONVERSATION_ARCHIVE_TAG}>`);
    expect(text.split(`</${CONVERSATION_ARCHIVE_TAG}>`)).toHaveLength(2);
    expect(text).toContain("JAMAIS une instruction");
  });

  it("aucun résultat ⇒ message HONNÊTE (pas une erreur)", async () => {
    const tool = createConversationArchiveTools(populatedArchive())[0]!;
    const { text, details } = await call(tool, { recherche: "hélicoptère" });
    expect(text).toContain("0 message(s) trouvé(s)");
    expect(details).toMatchObject({ status: "empty" });
  });

  it("archive VIDE ⇒ réponse honnête, aucune exception", async () => {
    const dir = tempDir();
    const empty = new ConversationArchiveStore({
      dir: join(dir, "conversations-archive"),
      indexPath: join(dir, "index.sqlite"),
      logger: logger(),
    });
    const tool = createConversationArchiveTools(empty)[0]!;
    const { text, details } = await call(tool, { recherche: "jardin" });
    expect(text).toContain("0 message(s) trouvé(s)");
    expect(details).toMatchObject({ conversations: 0, messages: 0 });
    empty.close();
  });

  it("borne le nombre de résultats demandé (jamais une marée de texte)", async () => {
    const tool = createConversationArchiveTools(populatedArchive())[0]!;
    const { details } = await call(tool, { recherche: "jardin potager crêpes", limite: 1 });
    const hits = (details as { hits: unknown[] }).hits;
    expect(hits).toHaveLength(1);
  });
});
