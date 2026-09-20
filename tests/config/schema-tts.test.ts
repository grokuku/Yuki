/**
 * Champs `tts.*` du schéma de configuration (Lot 7 §9.1) — types autorisés,
 * bornes, défauts, `apply`, et la valeur vide légitime de `tts.voice`.
 */

import { describe, expect, it } from "vitest";

import {
  CONFIG_SCHEMA,
  validateField,
  type FieldDescriptor,
} from "../../src/config/schema.js";

const TTS_FIELDS: Record<
  string,
  { type: string; def: string | number; min?: number; max?: number; apply: string }
> = {
  "tts.enabled": { type: "enum", def: "off", apply: "restart" },
  "tts.engine": { type: "enum", def: "chatterbox", apply: "restart" },
  "tts.baseUrl": { type: "string", def: "http://tts:8081", apply: "restart" },
  "tts.language": { type: "enum", def: "fr", apply: "restart" },
  "tts.voice": { type: "string", def: "", apply: "hot" },
  "tts.emotion": { type: "enum", def: "neutre", apply: "hot" },
  "tts.speed": { type: "int", def: 100, min: 50, max: 200, apply: "hot" },
  "tts.exaggeration": { type: "int", def: 500, min: 0, max: 1500, apply: "hot" },
  "tts.cfg": { type: "int", def: 500, min: 0, max: 1500, apply: "hot" },
  "tts.prefetchDepth": { type: "int", def: 2, min: 0, max: 2, apply: "hot" },
  "tts.minSentenceChars": { type: "int", def: 24, min: 8, max: 500, apply: "hot" },
  "tts.maxSentenceChars": { type: "int", def: 240, min: 40, max: 2000, apply: "hot" },
  "tts.timeoutMs": { type: "int", def: 15_000, min: 1_000, max: 120_000, apply: "hot" },
  "tts.volume": { type: "int", def: 100, min: 0, max: 100, apply: "hot" },
};

describe("schéma tts.*", () => {
  it("expose les champs de la spec avec type, défaut, bornes et apply", () => {
    for (const [path, expected] of Object.entries(TTS_FIELDS)) {
      const descriptor = CONFIG_SCHEMA[path] as FieldDescriptor | undefined;
      expect(descriptor, path).toBeDefined();
      expect(descriptor?.type, path).toBe(expected.type);
      expect(descriptor?.default, path).toBe(expected.def);
      expect(descriptor?.apply, path).toBe(expected.apply);
      if (expected.min !== undefined) expect(descriptor?.min, path).toBe(expected.min);
      if (expected.max !== undefined) expect(descriptor?.max, path).toBe(expected.max);
    }
  });

  it("aucun champ n'utilise de booléen (FieldType = string|int|enum)", () => {
    for (const [path, descriptor] of Object.entries(CONFIG_SCHEMA)) {
      expect(["string", "int", "enum"], path).toContain(descriptor.type);
    }
  });

  it("tts.voice accepte la chaîne vide (voix par défaut)", () => {
    expect(validateField("tts.voice", "")).toEqual({ ok: true, value: "" });
    expect(validateField("tts.voice", "camille")).toEqual({
      ok: true,
      value: "camille",
    });
  });

  it("un string ordinaire reste refusé s'il est vide", () => {
    const result = validateField("tts.baseUrl", "");
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ code: "empty_value" });
  });

  it("valide les énumérations", () => {
    expect(validateField("tts.enabled", "on")).toEqual({ ok: true, value: "on" });
    expect(validateField("tts.enabled", "maybe")).toMatchObject({
      ok: false,
      code: "invalid_enum",
    });
    expect(validateField("tts.emotion", "dramatique").ok).toBe(true);
    expect(validateField("tts.engine", "chatterbox").ok).toBe(true);
  });

  it("applique les bornes des entiers", () => {
    expect(validateField("tts.exaggeration", 1500).ok).toBe(true);
    expect(validateField("tts.exaggeration", 1501)).toMatchObject({
      ok: false,
      code: "above_max",
    });
    expect(validateField("tts.speed", 49)).toMatchObject({ ok: false, code: "below_min" });
    expect(validateField("tts.speed", "abc")).toMatchObject({
      ok: false,
      code: "invalid_int",
    });
    expect(validateField("tts.prefetchDepth", 3)).toMatchObject({
      ok: false,
      code: "above_max",
    });
  });
});
