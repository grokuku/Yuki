/**
 * Champs `agents.*` et `audit.*` du schéma de configuration + chemins persistés
 * (Lot 4). Expose ce qui est RÉGLABLE :
 *   - `agents.bindHost`, `agents.port`, `agents.defaultLevel` ;
 *   - `audit.retentionDays`, `audit.maxSizeMb`.
 * ⚠️ Type autorisé : `string | int | enum` (aucun booléen, aucun tableau).
 */

import { describe, expect, it } from "vitest";

import { loadEnv, readConfigEnvOverrides } from "../../src/config/env.js";
import {
  CONFIG_SCHEMA,
  validateField,
  type FieldDescriptor,
} from "../../src/config/schema.js";

const AGENT_FIELDS: Record<
  string,
  { type: string; def: string | number; min?: number; max?: number; apply: string }
> = {
  "agents.bindHost": { type: "string", def: "0.0.0.0", apply: "restart" },
  "agents.serverName": { type: "string", def: "", apply: "hot" },
  "agents.port": { type: "int", def: 9443, min: 1, max: 65535, apply: "restart" },
  "agents.defaultLevel": { type: "enum", def: "destructive", apply: "hot" },
  "audit.retentionDays": { type: "int", def: 30, min: 1, max: 3650, apply: "hot" },
  "audit.maxSizeMb": { type: "int", def: 16, min: 1, max: 4096, apply: "hot" },
};

describe("schéma agents.* / audit.*", () => {
  it("expose les réglages avec type, défaut, bornes et apply", () => {
    for (const [path, expected] of Object.entries(AGENT_FIELDS)) {
      const descriptor = CONFIG_SCHEMA[path] as FieldDescriptor | undefined;
      expect(descriptor, path).toBeDefined();
      expect(descriptor?.type, path).toBe(expected.type);
      expect(descriptor?.default, path).toBe(expected.def);
      expect(descriptor?.apply, path).toBe(expected.apply);
      if (expected.min !== undefined) expect(descriptor?.min, path).toBe(expected.min);
      if (expected.max !== undefined) expect(descriptor?.max, path).toBe(expected.max);
    }
  });

  it("niveau par défaut = enum disabled|always|destructive|never (les 4 niveaux D118)", () => {
    const descriptor = CONFIG_SCHEMA["agents.defaultLevel"] as FieldDescriptor;
    expect(descriptor.type).toBe("enum");
    expect(descriptor.enum).toEqual(["disabled", "always", "destructive", "never"]);
    for (const value of descriptor.enum ?? []) {
      expect(validateField("agents.defaultLevel", value)).toEqual({ ok: true, value });
    }
    expect(validateField("agents.defaultLevel", "yes").ok).toBe(false);
    expect(validateField("agents.defaultLevel", true).ok).toBe(false);
  });

  it("borne le port et les entiers d'audit", () => {
    expect(validateField("agents.port", 0).ok).toBe(false);
    expect(validateField("agents.port", 65536).ok).toBe(false);
    expect(validateField("agents.port", "9443")).toEqual({ ok: true, value: 9443 });
    expect(validateField("audit.retentionDays", 0).ok).toBe(false);
    expect(validateField("audit.maxSizeMb", 0).ok).toBe(false);
    expect(validateField("audit.maxSizeMb", false).ok).toBe(false);
  });

  it("hôte d'écoute = chaîne non vide", () => {
    expect(validateField("agents.bindHost", "127.0.0.1")).toEqual({
      ok: true,
      value: "127.0.0.1",
    });
    expect(validateField("agents.bindHost", "").ok).toBe(false);
  });

  it("`agents.serverName` : chaîne VIDE admise (défaut), multi-valeurs par virgules", () => {
    // Défaut = vide, et `allowEmpty` le rend VALIDE (sinon un enregistrement
    // « vide » serait refusé alors que c'est l'état par défaut).
    expect(CONFIG_SCHEMA["agents.serverName"]?.allowEmpty).toBe(true);
    expect(validateField("agents.serverName", "")).toEqual({ ok: true, value: "" });
    expect(validateField("agents.serverName", "   ")).toEqual({ ok: true, value: "" });
    // Plusieurs valeurs séparées par des virgules : la validation n'impose RIEN
    // au-delà du type chaîne (le découpage/épuration est fait par le module SAN).
    expect(validateField("agents.serverName", "10.10.0.5, yuki.lan")).toEqual({
      ok: true,
      value: "10.10.0.5, yuki.lan",
    });
    expect(validateField("agents.serverName", 42).ok).toBe(false);
  });

  it("`agents.serverName` : surcharge par `YUKI_AGENTS_SERVER_NAME`", () => {
    // Chemin normal depuis un `docker-compose` : l'opérateur passe l'IP de l'hôte.
    expect(
      readConfigEnvOverrides({ YUKI_AGENTS_SERVER_NAME: "10.10.0.5" })[
        "agents.serverName"
      ],
    ).toBe("10.10.0.5");
    // Une variable vide n'est PAS une surcharge.
    expect(
      readConfigEnvOverrides({ YUKI_AGENTS_SERVER_NAME: "  " })["agents.serverName"],
    ).toBeUndefined();
    expect(readConfigEnvOverrides({})["agents.serverName"]).toBeUndefined();
  });
});

describe("chemins persistés des agents (volume state)", () => {
  it("par défaut, store d'agents et journal d'audit vivent sur le volume `state`", () => {
    const env = loadEnv({});
    expect(env.agentsStorePath).toBe("/data/state/agents.jsonl");
    expect(env.auditLogPath).toBe("/data/state/audit.jsonl");
  });

  it("suit la surcharge du volume `state`", () => {
    const env = loadEnv({ YUKI_MOUNT_STATE: "/custom/state" });
    expect(env.agentsStorePath).toBe("/custom/state/agents.jsonl");
    expect(env.auditLogPath).toBe("/custom/state/audit.jsonl");
  });

  it("reste surchargeable explicitement", () => {
    const env = loadEnv({
      YUKI_AGENTS_STORE_PATH: "/tmp/agents.jsonl",
      YUKI_AUDIT_LOG_PATH: "/tmp/audit.jsonl",
    });
    expect(env.agentsStorePath).toBe("/tmp/agents.jsonl");
    expect(env.auditLogPath).toBe("/tmp/audit.jsonl");
  });
});
