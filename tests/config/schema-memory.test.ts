/**
 * Champs `memory.*` du schéma de configuration + chemins du store (Lot 12).
 * Expose ce qui est RÉGLABLE : activation, top-k, budget, timeouts, maxItems.
 * ⚠️ Type autorisé : `string | int | enum` (l'activation est un enum, pas un bool).
 */

import { describe, expect, it } from "vitest";

import { loadEnv } from "../../src/config/env.js";
import {
  CONFIG_SCHEMA,
  validateField,
  type FieldDescriptor,
} from "../../src/config/schema.js";

const MEMORY_FIELDS: Record<
  string,
  { type: string; def: string | number; min?: number; max?: number; apply: string }
> = {
  "memory.enabled": { type: "enum", def: "on", apply: "hot" },
  "memory.recall.topK": { type: "int", def: 5, min: 0, max: 20, apply: "hot" },
  "memory.recall.budgetChars": {
    type: "int",
    def: 8000,
    min: 0,
    max: 40000,
    apply: "hot",
  },
  "memory.recall.timeoutMs": {
    type: "int",
    def: 400,
    min: 20,
    max: 5000,
    apply: "hot",
  },
  "memory.extract.maxItems": {
    type: "int",
    def: 3,
    min: 0,
    max: 10,
    apply: "hot",
  },
  "memory.extract.timeoutMs": {
    type: "int",
    def: 30000,
    min: 1000,
    max: 300000,
    apply: "hot",
  },
};

describe("schéma memory.*", () => {
  it("expose les réglages avec type, défaut, bornes et apply", () => {
    for (const [path, expected] of Object.entries(MEMORY_FIELDS)) {
      const descriptor = CONFIG_SCHEMA[path] as FieldDescriptor | undefined;
      expect(descriptor, path).toBeDefined();
      expect(descriptor?.type, path).toBe(expected.type);
      expect(descriptor?.default, path).toBe(expected.def);
      expect(descriptor?.apply, path).toBe(expected.apply);
      if (expected.min !== undefined) expect(descriptor?.min, path).toBe(expected.min);
      if (expected.max !== undefined) expect(descriptor?.max, path).toBe(expected.max);
    }
  });

  it("activation = enum on|off (jamais un booléen)", () => {
    const descriptor = CONFIG_SCHEMA["memory.enabled"] as FieldDescriptor;
    expect(descriptor.type).toBe("enum");
    expect(descriptor.enum).toEqual(["off", "on"]);
    expect(validateField("memory.enabled", "on")).toEqual({ ok: true, value: "on" });
    expect(validateField("memory.enabled", "off")).toEqual({ ok: true, value: "off" });
    expect(validateField("memory.enabled", "yes").ok).toBe(false);
    expect(validateField("memory.enabled", true).ok).toBe(false);
  });

  it("borne les entiers (budget, top-k, timeouts)", () => {
    expect(validateField("memory.recall.topK", 21).ok).toBe(false);
    expect(validateField("memory.recall.topK", -1).ok).toBe(false);
    expect(validateField("memory.recall.budgetChars", 0)).toEqual({
      ok: true,
      value: 0,
    });
    expect(validateField("memory.recall.timeoutMs", 10).ok).toBe(false);
  });
});

describe("chemins de la mémoire (persistance)", () => {
  it("par défaut, le store et l'index vivent sur le volume `state` (survit au redémarrage)", () => {
    const env = loadEnv({});
    expect(env.memoryStorePath).toBe("/data/state/memory.jsonl");
    expect(env.memoryIndexPath).toBe("/data/state/memory-index.sqlite");
  });

  it("suit la surcharge du volume `state`", () => {
    const env = loadEnv({ YUKI_MOUNT_STATE: "/custom/state" });
    expect(env.memoryStorePath).toBe("/custom/state/memory.jsonl");
    expect(env.memoryIndexPath).toBe("/custom/state/memory-index.sqlite");
  });

  it("reste surchargeable explicitement", () => {
    const env = loadEnv({
      YUKI_MEMORY_STORE_PATH: "/tmp/mem.jsonl",
      YUKI_MEMORY_INDEX_PATH: "/tmp/mem.sqlite",
    });
    expect(env.memoryStorePath).toBe("/tmp/mem.jsonl");
    expect(env.memoryIndexPath).toBe("/tmp/mem.sqlite");
  });
});
