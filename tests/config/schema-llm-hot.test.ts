/**
 * Champs du CATALOGUE — `apply: "hot"` (fournisseur et modèles à chaud).
 *
 * ⚠️ `baseUrl` et `api` étaient `restart` tant que le runtime de modèles était figé
 * au démarrage. Depuis `PiHost.applyLlmConfig` + `refreshSharedModelRuntime`
 * (runtime PARTAGÉ rafraîchi EN PLACE), un changement de fournisseur peut suivre
 * la MÊME mécanique que le modèle : `hot`.
 *
 * ⚠️ GARDE RÉVISÉE (2026-11-19, LOT B) : les chemins ont changé
 * (`llm.fournisseurs` et `llm.modeles` remplacent `llm.light.*` / `llm.heavy.*`),
 * mais ce qui est VERROUILLÉ est identique : tout ce qui décide du fournisseur, du
 * modèle, de la réflexion, de la vision et de la CLÉ est appliqué À CHAUD — jamais
 * « redémarrage requis ».
 *
 * Ce test ÉCHOUE si l'un de ces champs repasse en `restart`, ou si une clé de
 * sélection (`llm.defaut.*` / `llm.bot.*`) cesse d'être à chaud.
 */

import { describe, expect, it } from "vitest";

import { CONFIG_SCHEMA, descriptorOf, type FieldDescriptor } from "../../src/config/schema.js";

const HOT_CATALOGUE_FIELDS = [
  "llm.fournisseurs",
  "llm.modeles",
  "llm.defaut.light",
  "llm.defaut.heavy",
  "llm.defaut.vision",
  "llm.bot.light",
  "llm.bot.heavy",
  "llm.bot.vision",
] as const;

describe("schéma llm.* — catalogue à chaud", () => {
  it("le catalogue et les sélections sont `apply: hot` (plus de « redémarrage requis »)", () => {
    for (const path of HOT_CATALOGUE_FIELDS) {
      const descriptor = CONFIG_SCHEMA[path] as FieldDescriptor | undefined;
      expect(descriptor, path).toBeDefined();
      expect(descriptor?.apply, path).toBe("hot");
    }
  });

  it("la clé d'un fournisseur est un chemin SECRET dynamique, à chaud", () => {
    // Le chemin n'est pas dans la table (un par fournisseur déclaré) : il est
    // reconnu par `descriptorOf`, exactement comme les clés historiques l'étaient.
    const descriptor = descriptorOf("llm.fournisseur.local.apiKey");
    expect(descriptor).toMatchObject({ secret: true, scope: "instance", apply: "hot" });
  });

  it("aucun réglage par rôle ne subsiste (remplacés, pas doublés)", () => {
    for (const chemin of [
      "llm.light.baseUrl",
      "llm.light.api",
      "llm.light.model",
      "llm.light.thinking",
      "llm.light.vision",
      "llm.light.apiKey",
      "llm.heavy.baseUrl",
      "llm.heavy.api",
      "llm.heavy.model",
      "llm.heavy.thinking",
      "llm.heavy.vision",
      "llm.heavy.apiKey",
      "llm.vision.baseUrl",
      "llm.vision.model",
      "llm.vision.thinking",
      "llm.vision.apiKey",
    ]) {
      expect(CONFIG_SCHEMA[chemin], chemin).toBeUndefined();
    }
  });
});
