/**
 * Champs `llm.*` de FOURNISSEUR — `apply: "hot"` (Lot « fournisseur à chaud »).
 *
 * ⚠️ `baseUrl` et `api` étaient `restart` tant que le runtime de modèles était
 * figé au démarrage. Depuis `PiHost.applyLlmConfig` + `refreshSharedModelRuntime`
 * (runtime PARTAGÉ rafraîchi EN PLACE), un changement de fournisseur peut rider
 * la MÊME mécanique que le modèle : ils sont désormais `hot`.
 *
 * Ce test ÉCHOUE si l'un de ces champs repasse en `restart` (régression du
 * comportement « redémarrage requis »).
 */

import { describe, expect, it } from "vitest";

import { CONFIG_SCHEMA, type FieldDescriptor } from "../../src/config/schema.js";

const HOT_PROVIDER_FIELDS = [
  "llm.light.baseUrl",
  "llm.light.api",
  "llm.heavy.baseUrl",
  "llm.heavy.api",
] as const;

describe("schéma llm.* — fournisseur à chaud", () => {
  it("baseUrl et api sont `apply: hot` (plus de « redémarrage requis »)", () => {
    for (const path of HOT_PROVIDER_FIELDS) {
      const descriptor = CONFIG_SCHEMA[path] as FieldDescriptor | undefined;
      expect(descriptor, path).toBeDefined();
      expect(descriptor?.apply, path).toBe("hot");
    }
  });

  it("les champs modèle / réflexion restent `hot` (non régressés)", () => {
    for (const path of [
      "llm.light.model",
      "llm.light.thinking",
      "llm.heavy.model",
      "llm.heavy.thinking",
      "llm.light.apiKey",
      "llm.heavy.apiKey",
    ]) {
      const descriptor = CONFIG_SCHEMA[path] as FieldDescriptor | undefined;
      expect(descriptor?.apply, path).toBe("hot");
    }
  });
});
