/**
 * Outil `lister_secrets` — NOMS seulement, JAMAIS une valeur.
 *
 * Prouve : liste encadrée (donnée), libellés d'usage, coffre verrouillé ⇒
 * message honnête sans liste, coffre illisible ⇒ erreur honnête, et surtout
 * qu'aucune VALEUR ne peut sortir (la vue publique ne la porte pas).
 */

import { describe, expect, it } from "vitest";

import {
  createSecretRequestTool,
  createSecretTools,
} from "../../src/pi/sdk/execution-tools.js";
import { SECRET_LIST_TAG, type SecretDirectoryPort } from "../../src/secrets/directory.js";
import type {
  DirectSecretRequestInput,
  SecretRequestToolOutcome,
  SecretRequestToolPort,
} from "../../src/agents/execution.js";

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

/* ─── demander_secret : chemin du modèle vers la fenêtre de saisie ────────── */

type SecretRequestTool = ReturnType<typeof createSecretRequestTool>[number];

async function callWith(tool: SecretRequestTool, params: unknown): Promise<{
  text: string;
  details: unknown;
}> {
  const fn = tool.execute as unknown as (
    id: string,
    params: unknown,
    signal: undefined,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<{ content: Array<{ type: string; text?: string }>; details: unknown }>;
  const result = await fn("call", params, undefined, undefined, {
    sessionManager: { getSessionId: () => "sess-light" },
  });
  return {
    text: result.content.map((part) => part.text ?? "").join("\n"),
    details: result.details,
  };
}

function stubPort(
  impl?: (input: DirectSecretRequestInput) => SecretRequestToolOutcome,
): { port: SecretRequestToolPort; calls: DirectSecretRequestInput[] } {
  const calls: DirectSecretRequestInput[] = [];
  const port: SecretRequestToolPort = {
    requestSecret: (input) => {
      calls.push(input);
      if (impl) return impl(input);
      return {
        ok: true,
        request: {
          id: "sec-1",
          sessionId: input.sessionId,
          names: input.names,
          ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
          purpose: input.purpose,
          createdAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2026-01-01T00:10:00.000Z",
          ttlSeconds: 600,
        },
      };
    },
  };
  return { port, calls };
}

describe("demander_secret — demande DIRECTE (fenêtre dans la conversation)", () => {
  it("émet une demande (noms + raison + machine) et routе la conversation", async () => {
    const { port, calls } = stubPort();
    const tool = createSecretRequestTool(port)[0] as SecretRequestTool;
    const { text, details } = await callWith(tool, {
      secrets: ["YUKI_SECRET_NAS"],
      raison: "se connecter au NAS",
      machine: "nuc00",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.names).toEqual(["YUKI_SECRET_NAS"]);
    expect(calls[0]?.purpose).toBe("se connecter au NAS");
    expect(calls[0]?.agentName).toBe("nuc00");
    // ⚠️ Session de la conversation RÉELLE (celle de l'utilisateur).
    expect(calls[0]?.sessionId).toBe("sess-light");
    expect(details).toMatchObject({ status: "awaiting_secret", names: ["YUKI_SECRET_NAS"] });
    // Le modèle apprend qu'une fenêtre existe et qu'il ne verra JAMAIS la valeur.
    expect(text).toContain("fenêtre");
    expect(text).toMatch(/N'affirme PAS/);
  });

  it("DÉDOUBLONNE les noms et rejette un format invalide (pas de fenêtre fantôme)", async () => {
    const { port, calls } = stubPort();
    const tool = createSecretRequestTool(port)[0] as SecretRequestTool;
    await callWith(tool, { secrets: ["YUKI_SECRET_NAS", "YUKI_SECRET_NAS"], raison: "x" });
    expect(calls[0]?.names).toEqual(["YUKI_SECRET_NAS"]);

    const bad = await callWith(tool, { secrets: ["motdepasse"], raison: "x" });
    expect(bad.details).toEqual({ status: "invalid" });
    expect(bad.text).toContain("invalide");
    // Aucune demande émise pour un nom invalide.
    expect(calls).toHaveLength(1);

    const empty = await callWith(tool, { secrets: [], raison: "x" });
    expect(empty.details).toEqual({ status: "invalid" });
  });

  it("coffre verrouillé (port en échec) ⇒ message HONNÊTE, aucune fenêtre annoncée", async () => {
    const { port } = stubPort(() => ({
      ok: false,
      code: "vault_locked",
      message: "Coffre de secrets VERROUILLÉ.",
    }));
    const tool = createSecretRequestTool(port)[0] as SecretRequestTool;
    const { text, details } = await callWith(tool, {
      secrets: ["YUKI_SECRET_NAS"],
      raison: "x",
    });
    expect(details).toEqual({ status: "unavailable" });
    expect(text).toContain("VERROUILLÉ");
    // ⚠️ Aucune promesse de fenêtre : le modèle doit pouvoir dire NON honnêtement.
    expect(text).not.toContain("fenêtre");
  });
});
