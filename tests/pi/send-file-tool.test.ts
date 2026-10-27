/**
 * Outil `envoyer_fichier` — Yuki RENVOIE un fichier de la conversation.
 *
 * Prouve : la liste des fichiers envoyables (sans contenu), l'envoi par nom OU
 * identifiant, le REFUS honnête quand rien ne correspond (aucun fichier inventé),
 * l'absence de conversation courante, et le fait que le nom d'un fichier ne peut
 * jamais venir d'une autre conversation (le service applique son périmètre).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import { FilesService } from "../../src/files/service.js";
import { FilesStore } from "../../src/files/store.js";
import { createSendFileTools } from "../../src/pi/sdk/send-file-tool.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type HostTool = ReturnType<typeof createSendFileTools>[number];

interface CallResult {
  text: string;
  details: unknown;
}

/** Appelle l'outil avec (ou sans) contexte de session — comme le SDK. */
async function call(
  tool: HostTool,
  params: Record<string, unknown>,
  // `null` = aucune conversation courante (contexte absent, comme hors session).
  sessionId: string | null = "sess-1",
): Promise<CallResult> {
  const fn = tool.execute as unknown as (
    id: string,
    values: unknown,
    signal: undefined,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<{ content: { type: string; text: string }[]; details: unknown }>;
  const ctx =
    sessionId === null
      ? undefined
      : ({
          sessionManager: { getSessionId: () => sessionId },
        } as unknown as ExtensionContext);
  const result = await fn("call-1", params, undefined, undefined, ctx);
  return { text: result.content.map((part) => part.text).join(""), details: result.details };
}

async function serviceWith(files: Array<{ name: string; body: string; sessionId: string }>): Promise<FilesService> {
  const dir = mkdtempSync(join(tmpdir(), "yuki-send-file-tool-"));
  dirs.push(dir);
  const store = new FilesStore({ dir, maxBytes: () => 1_000_000 });
  store.ensureLayout();
  const service = new FilesService({ store });
  for (const file of files) {
    const saved = await store.saveBytes(new Uint8Array(Buffer.from(file.body)), {
      name: file.name,
      mimeType: "text/plain",
      origin: "user",
      sessionId: file.sessionId,
    });
    if (!saved.ok) throw new Error("dépôt impossible dans le test");
  }
  return service;
}

describe("outil `envoyer_fichier` — envoi par Yuki", () => {
  it("est nommé et son prompt interdit d'inventer un fichier", () => {
    const tool = createSendFileTools(new FilesService({
      store: new FilesStore({ dir: mkdtempSync(join(tmpdir(), "yuki-send-file-nom-")) }),
    }))[0]!;
    expect(tool.name).toBe("envoyer_fichier");
    const description = tool.description ?? "";
    expect(description).toContain("DÉJÀ présent");
    expect(description).toMatch(/n'invente/i);
    expect(description).toMatch(/téléchargeable/);
    expect(tool.promptSnippet ?? "").toContain("envoyer_fichier");
  });

  it("liste les fichiers envoyables de la conversation (sans contenu)", async () => {
    const service = await serviceWith([
      { name: "notes.txt", body: "secret-notes", sessionId: "sess-1" },
      { name: "autre.txt", body: "autre-contenu", sessionId: "sess-2" },
    ]);
    const tool = createSendFileTools(service)[0]!;
    const { text, details } = await call(tool, {});
    expect(text).toContain("notes.txt");
    // ⚠️ Ni le contenu, ni les fichiers d'une AUTRE conversation.
    expect(text).not.toContain("secret-notes");
    expect(text).not.toContain("autre.txt");
    expect(details).toMatchObject({ status: "sent", available: ["notes.txt"] });
  });

  it("envoie par NOM exact et confirme que le fichier est dans le fil", async () => {
    const service = await serviceWith([{ name: "notes.txt", body: "abc", sessionId: "sess-1" }]);
    const diffuses: string[] = [];
    service.subscribeSent((view) => diffuses.push(view.name));
    const tool = createSendFileTools(service)[0]!;
    const { text, details } = await call(tool, { fichier: "notes.txt" });
    expect(text).toContain("Fichier envoyé");
    expect(text).toContain("DANS la conversation");
    expect(text).toContain("inutile d'en recopier le contenu");
    expect(diffuses).toEqual(["notes.txt"]);
    expect(details).toMatchObject({ status: "sent", reference: "notes.txt" });
  });

  it("REFUSE honnêtement un fichier inconnu (et rappelle ce qui est disponible)", async () => {
    const service = await serviceWith([{ name: "notes.txt", body: "abc", sessionId: "sess-1" }]);
    const tool = createSendFileTools(service)[0]!;
    const { text, details } = await call(tool, { fichier: "inexistant.pdf" });
    expect(text).toContain("rien n'a été envoyé");
    expect(text).toContain("notes.txt");
    expect(details).toMatchObject({ status: "unknown", reference: "inexistant.pdf" });
  });

  it("sans conversation courante : réponse honnête, aucun envoi", async () => {
    const service = await serviceWith([{ name: "notes.txt", body: "abc", sessionId: "sess-1" }]);
    const tool = createSendFileTools(service)[0]!;
    const { text, details } = await call(tool, { fichier: "notes.txt" }, null);
    expect(text).toContain("aucune conversation courante");
    expect(details).toMatchObject({ status: "unavailable" });
  });
});
