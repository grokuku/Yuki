/**
 * Outil `lister_fichiers` — les IDENTIFIANTS des pièces jointes, enfin rendus.
 *
 * ⚠️ POURQUOI CE TEST EXISTE : `deposer_fichier` exige un identifiant
 * (`/^[a-f0-9]{32}$/`) et AUCUN outil ne le rendait au worker lourd — le canal
 * « celui qui peut agir ne sait pas quoi » restait mort. On prouve ici que
 * l'outil : (1) rend les identifiants, (2) ne sort jamais de la conversation,
 * (3) refuse proprement quand aucune conversation n'est identifiée, (4) borne
 * et le DIT.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import type { FilesListPort, WireFile } from "../../src/files/types.js";
import { createListFilesTool } from "../../src/pi/sdk/list-files-tool.js";

const ID = "0123456789abcdef0123456789abcdef";

function wire(id: string, name: string): WireFile {
  return {
    id,
    name,
    mimeType: "image/png",
    bytes: 2048,
    kind: "image",
    readable: false,
    url: `/fichiers/${id}.png`,
    createdAt: "2026-11-01T14:02:00.000Z",
    expiresAt: "2026-12-01T14:02:00.000Z",
  };
}

/** Port factice : deux fichiers sur `conv-1`, aucun sur `conv-vide`. */
function stubPort(files: WireFile[]): { port: FilesListPort; sessions: string[] } {
  const sessions: string[] = [];
  const port: FilesListPort = {
    listForSession(sessionId: string): WireFile[] {
      sessions.push(sessionId);
      return sessionId === "conv-1" ? files : [];
    },
  };
  return { port, sessions };
}

type HostTool = ReturnType<typeof createListFilesTool>[number];

async function call(
  tool: HostTool,
  sessionId: string | null = "conv-1",
): Promise<{ text: string; details: unknown }> {
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
      : ({ sessionManager: { getSessionId: () => sessionId } } as unknown as ExtensionContext);
  const result = await fn("call-1", {}, undefined, undefined, ctx);
  return { text: result.content.map((part) => part.text).join(""), details: result.details };
}

describe("outil `lister_fichiers`", () => {
  it("rend les IDENTIFIANTS des fichiers (ce qu'exige deposer_fichier)", async () => {
    const { port } = stubPort([wire(ID, "photo.png")]);
    const [tool] = createListFilesTool(port);
    const { text, details } = await call(tool!);
    expect(tool!.name).toBe("lister_fichiers");
    expect(text).toContain(ID);
    expect(text).toContain("photo.png");
    expect(details).toMatchObject({
      status: "listed",
      total: 1,
      shown: 1,
      omitted: 0,
      files: [{ id: ID, name: "photo.png" }],
    });
  });

  it("FORCE la conversation propriétaire (session éphémère du worker ignorée)", async () => {
    const { port, sessions } = stubPort([wire(ID, "photo.png")]);
    const [tool] = createListFilesTool(port, { sessionId: () => "conv-proprietaire" });
    await call(tool!, "session-ephemere");
    expect(sessions).toEqual(["conv-proprietaire"]);
  });

  it("REFUSE proprement quand aucune conversation n'est identifiée", async () => {
    const { port, sessions } = stubPort([wire(ID, "photo.png")]);
    const [tool] = createListFilesTool(port);
    const { text, details } = await call(tool!, null);
    expect(text).toContain("aucune conversation n'est identifiée");
    expect(details).toMatchObject({ status: "unavailable" });
    // Aucune divination : le port n'a même pas été interrogé.
    expect(sessions).toEqual([]);
  });

  it("une conversation SANS fichier le dit (et n'invente rien)", async () => {
    const { port } = stubPort([]);
    const [tool] = createListFilesTool(port);
    const { text, details } = await call(tool!, "conv-vide");
    expect(text).toContain("Aucune pièce jointe");
    expect(details).toMatchObject({ status: "empty", total: 0 });
  });

  it("BORNE la liste et dit COMBIEN de fichiers ne sont pas montrés", async () => {
    const files = Array.from({ length: 5 }, (_value, index) =>
      wire(index.toString(16).padStart(32, "0"), `f${index}.png`),
    );
    const { port } = stubPort(files);
    const [tool] = createListFilesTool(port, { max: 2 });
    const { text, details } = await call(tool!);
    expect(details).toMatchObject({ status: "listed", total: 5, shown: 2, omitted: 3 });
    expect(text).toContain("3 autre(s) pièce(s) jointe(s) non listée(s)");
    expect(text).toContain(files[1]!.id);
    expect(text).not.toContain(files[2]!.id);
  });
});
