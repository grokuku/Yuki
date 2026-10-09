/**
 * Outil `capturer_ecran` — ANTI-EXFILTRATION.
 *
 * Prouve que le résultat rendu au MODÈLE ne contient QUE des métadonnées :
 * jamais le `data:` URL ni le base64 de l'image. Et que le refus est HONNÊTE
 * quand la capacité est absente.
 */

import { describe, expect, it } from "vitest";

import { createScreenshotTool } from "../../src/pi/sdk/execution-tools.js";
import type { ScreenshotOutcome, ScreenshotRequest } from "../../src/agents/execution.js";

type ScreenshotTool = ReturnType<typeof createScreenshotTool>[number];

function stubService(outcome: ScreenshotOutcome): {
  service: { capture: (request: ScreenshotRequest) => Promise<ScreenshotOutcome> };
  calls: ScreenshotRequest[];
} {
  const calls: ScreenshotRequest[] = [];
  return {
    service: {
      capture: async (request) => {
        calls.push(request);
        return outcome;
      },
    },
    calls,
  };
}

async function call(
  tool: ScreenshotTool,
  params: Record<string, unknown>,
  ctx: unknown = {},
): Promise<{ text: string; details: unknown }> {
  const fn = tool.execute as unknown as (
    id: string,
    params: unknown,
    signal: undefined,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<{ content: Array<{ type: string; text?: string }>; details: unknown }>;
  const result = await fn("call", params, undefined, undefined, ctx);
  return { text: result.content.map((part) => part.text ?? "").join("\n"), details: result.details };
}

describe("outil capturer_ecran", () => {
  it("expose un seul outil nommé capturer_ecran", () => {
    const { service } = stubService({ status: "captured", agentId: "a", message: "ok" });
    const tools = createScreenshotTool(service);
    expect(tools.map((tool) => tool.name)).toEqual(["capturer_ecran"]);
  });

  it("ne renvoie au modèle QUE des métadonnées (jamais le blob)", async () => {
    const { service, calls } = stubService({
      status: "captured",
      agentId: "agent-a",
      agentName: "nuc00",
      width: 1280,
      height: 720,
      bytes: 140 * 1024,
      format: "jpeg",
      message: "Capture d'écran affichée dans la conversation (1280×720, ~140 Ko).",
    });
    const tools = createScreenshotTool(service);
    const { text, details } = await call(tools[0]!, { agent_id: "nuc00" });
    expect(text).toContain("1280");
    expect(text).toContain("720");
    expect(text).toContain("image_displayed_to_human");
    // ⚠️ Aucune donnée binaire dans ce que voit le modèle.
    expect(text).not.toContain("data:image");
    expect(text).not.toContain("base64");
    expect(JSON.stringify(details)).not.toContain("data:");
    expect(JSON.stringify(details)).not.toContain("base64");
    // L'appel est marqué par son origine (audit).
    expect(calls[0]?.origin).toBe("capturer_ecran");
  });

  it("refus HONNÊTE quand la capacité est absente", async () => {
    const { service } = stubService({
      status: "unsupported",
      agentId: "agent-a",
      message:
        "Capture d'écran impossible : cette machine n'a pas d'affichage ou d'outil de capture (l'agent n'a pas déclaré la capacité « screenshot »).",
    });
    const tools = createScreenshotTool(service);
    const { text } = await call(tools[0]!, { agent_id: "agent-a" });
    expect(text).toContain("affichage");
    expect(text).toContain("outil de capture");
    expect(text).toContain("unsupported");
  });

  it("transmet l'agent désigné tel quel (nom ou identifiant)", async () => {
    const { service, calls } = stubService({
      status: "captured",
      agentId: "agent-a",
      width: 100,
      height: 100,
      bytes: 10,
      message: "ok",
    });
    const tools = createScreenshotTool(service);
    await call(tools[0]!, { agent_id: "agent-id-technique" });
    expect(calls[0]?.agentId).toBe("agent-id-technique");
  });
});
