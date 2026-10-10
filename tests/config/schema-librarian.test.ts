/**
 * Schéma de configuration — section « Libraire » (agentToken optionnel).
 */

import { describe, expect, it } from "vitest";

import { CONFIG_SCHEMA, validateField } from "../../src/config/schema.js";

describe("schéma — libraire (Libry)", () => {
  it("agentToken est FACULTATIF : la chaîne vide est une valeur valide, et reste secrète", () => {
    expect(CONFIG_SCHEMA["librarian.agentToken"]?.secret).toBe(true);
    expect(CONFIG_SCHEMA["librarian.agentToken"]?.allowEmpty).toBe(true);
    expect(validateField("librarian.agentToken", "")).toEqual({ ok: true, value: "" });
    expect(validateField("librarian.agentToken", "abc")).toEqual({ ok: true, value: "abc" });
  });

  it("apiKey reste LE secret de référence (vide refusé, comme tout secret non vide)", () => {
    expect(CONFIG_SCHEMA["librarian.apiKey"]?.secret).toBe(true);
    const empty = validateField("librarian.apiKey", "   ");
    expect(empty.ok).toBe(false);
  });

  it("screenshot est un enum `off|on`, par défaut `on`", () => {
    expect(CONFIG_SCHEMA["librarian.screenshot"]).toMatchObject({
      type: "enum",
      enum: ["off", "on"],
      default: "on",
      apply: "hot",
    });
    expect(validateField("librarian.screenshot", "on")).toEqual({ ok: true, value: "on" });
    expect(validateField("librarian.screenshot", "off")).toEqual({ ok: true, value: "off" });
    expect(validateField("librarian.screenshot", "maybe").ok).toBe(false);
  });
});
