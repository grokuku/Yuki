/**
 * Outil `lister_secrets` — NOMS seulement, JAMAIS une valeur.
 *
 * Prouve : liste encadrée (donnée), libellés d'usage, coffre verrouillé ⇒
 * message honnête sans liste, coffre illisible ⇒ erreur honnête, et surtout
 * qu'aucune VALEUR ne peut sortir (la vue publique ne la porte pas).
 */

import { describe, expect, it } from "vitest";

import { createSecretTools } from "../../src/pi/sdk/execution-tools.js";
import { SECRET_LIST_TAG, type SecretDirectoryPort } from "../../src/secrets/directory.js";

const SECRET_VALUE = "SUPER-SECRET-NAS-0123456789";

function stubDirectory(options: {
  configured?: boolean;
  entries?: Array<{ name: string; label?: string; updatedAt: string }>;
  throwOnList?: boolean;
}): SecretDirectoryPort {
  return {
    isConfigured: () => options.configured ?? true,
    list: () => {
      if (options.throwOnList) throw new Error("coffre illisible");
      return options.entries ?? [];
    },
  };
}

type SecretTool = ReturnType<typeof createSecretTools>[number];

async function call(tool: SecretTool): Promise<{ text: string; details: unknown }> {
  const fn = tool.execute as unknown as (
    id: string,
    params: unknown,
    signal: undefined,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<{ content: Array<{ type: string; text?: string }>; details: unknown }>;
  const result = await fn("call", {}, undefined, undefined, {});
  return {
    text: result.content.map((part) => part.text ?? "").join("\n"),
    details: result.details,
  };
}

describe("lister_secrets — NOMS seulement", () => {
  it("liste les noms et libellés dans un bloc encadré, sans aucune valeur", async () => {
    const tool = createSecretTools(
      stubDirectory({
        entries: [
          { name: "YUKI_SECRET_NAS", label: "accès NAS", updatedAt: "2026-01-01T00:00:00.000Z" },
          { name: "YUKI_SECRET_TOKEN", updatedAt: "2026-01-02T00:00:00.000Z" },
        ],
      }),
    )[0] as SecretTool;
    const { text, details } = await call(tool);
    expect(text).toContain(`<${SECRET_LIST_TAG}>`);
    expect(text).toContain("YUKI_SECRET_NAS — accès NAS");
    expect(text).toContain("YUKI_SECRET_TOKEN");
    expect(text).toContain("AUCUNE valeur");
    // ⚠️ Aucune valeur ne peut fuiter : le port n'en porte pas.
    expect(text).not.toContain(SECRET_VALUE);
    expect(details).toEqual({ status: "ok", count: 2 });
  });

  it("coffre verrouillé ⇒ message honnête, pas de liste", async () => {
    const tool = createSecretTools(stubDirectory({ configured: false }))[0] as SecretTool;
    const { text, details } = await call(tool);
    expect(text).toContain("verrouillé");
    expect(text).not.toContain(`<${SECRET_LIST_TAG}>`);
    expect(details).toEqual({ status: "locked" });
  });

  it("coffre illisible ⇒ erreur honnête", async () => {
    const tool = createSecretTools(stubDirectory({ throwOnList: true }))[0] as SecretTool;
    const { text, details } = await call(tool);
    expect(text).toContain("illisible");
    expect(details).toEqual({ status: "error" });
  });
});
