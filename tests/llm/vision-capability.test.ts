/**
 * CAPACITÉ VISION : un réglage EXPOSÉ, qui produit la déclaration du modèle.
 *
 * ⚠️ Le problème d'origine : `input` n'était réglable NULLE PART (ni dans
 * `/config`, ni dans `models.json` — généré au démarrage depuis
 * `src/llm/models.ts`). L'utilisateur ne pouvait donc pas dire « mon modèle voit
 * les images » : la seule voie était d'éditer un fichier du dépôt, et une
 * édition du `models.json` du volume était écrasée au démarrage suivant.
 *
 * Ces tests ÉCHOUENT sur le code d'origine : le champ `llm.<role>.vision` n'existe
 * pas dans le schéma, `EffectiveLlmRole` n'a pas de `vision`, et
 * `sdkModelSupportsImages` n'existe pas.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { CONFIG_SCHEMA } from "../../src/config/schema.js";
import type { EffectiveLlmConfig } from "../../src/llm/models.js";
import {
  buildModelsConfig,
  buildModelsConfigFrom,
  resolveModelsFrom,
} from "../../src/llm/models.js";
import { sdkModelSupportsImages, type SdkModel } from "../../src/pi/sdk/model-runtime.js";

const EFFECTIVE: EffectiveLlmConfig = {
  light: {
    api: "openai-completions",
    baseUrl: "https://light.example/v1",
    model: "modele-leger",
    thinking: "off",
    vision: true,
  },
  heavy: {
    api: "openai-completions",
    baseUrl: "https://heavy.example/v1",
    model: "modele-lourd",
    thinking: "high",
    vision: true,
  },
};

describe("réglage `llm.<role>.vision` — exposé, à chaud, et DÉCLARATIF", () => {
  it("existe dans le schéma de configuration pour les deux rôles", () => {
    for (const role of ["light", "heavy"] as const) {
      const field = CONFIG_SCHEMA[`llm.${role}.vision`];
      expect(field).toBeDefined();
      expect(field?.type).toBe("enum");
      // ⚠️ Deux états seulement : « oui » ou « non ». Pas de « peut-être » qui
      // laisserait croire à une mesure — la capacité est une DÉCLARATION.
      expect(field?.enum).toEqual(["oui", "non"]);
      expect(field?.default).toBe("oui");
      // Un changement doit s'appliquer au job/message suivant, sans redémarrage.
      expect(field?.apply).toBe("hot");
    }
  });

  it("est proposé dans l'interface /config de l'onglet « Modèles »", () => {
    const ui = readFileSync("public/ui/config.js", "utf8");
    expect(ui).toContain("llm.light.vision");
    expect(ui).toContain("llm.heavy.vision");
    expect(ui).toContain("Reçoit les images (vision)");
  });

  it("produit `input` dans models.json : « non » ⇒ texte seul", () => {
    const withVision = buildModelsConfigFrom(EFFECTIVE);
    expect(withVision.providers["llm-heavy"]?.models[0]?.input).toEqual(["text", "image"]);

    const withoutVision = buildModelsConfigFrom({
      ...EFFECTIVE,
      heavy: { ...EFFECTIVE.heavy, vision: false },
    });
    // ⚠️ Sans « image », le SDK remplace la pièce jointe par
    // « (tool image omitted: model does not support images) » : c'est CE champ
    // qui décide, et rien d'autre.
    expect(withoutVision.providers["llm-heavy"]?.models[0]?.input).toEqual(["text"]);
    expect(resolveModelsFrom({ ...EFFECTIVE, heavy: { ...EFFECTIVE.heavy, vision: false } }).heavy.input).toEqual([
      "text",
    ]);
  });

  it("le fichier livré `config/pi/models.json` déclare le lourd multimodal", () => {
    // ⚠️ Ce fichier n'est PAS celui qui est lu au démarrage (celui du volume est
    // réécrit par `buildModelsConfigFrom`) : il est le reflet testé du défaut.
    const shipped = JSON.parse(readFileSync("config/pi/models.json", "utf8")) as unknown;
    expect(shipped).toEqual(JSON.parse(JSON.stringify(buildModelsConfig())));
    const heavy = (shipped as { providers: Record<string, { models: { input: string[] }[] }> })
      .providers["llm-heavy"]?.models[0]?.input;
    expect(heavy).toEqual(["text", "image"]);
  });

  it("la capacité est lue au RUNTIME sur le modèle résolu (`model.input`)", () => {
    const model = (input: ("text" | "image")[]) => ({ input }) as unknown as SdkModel;
    expect(sdkModelSupportsImages(model(["text"]))).toBe(false);
    expect(sdkModelSupportsImages(model(["text", "image"]))).toBe(true);
    // Un modèle sans champ `input` lisible ne fait jamais passer une image.
    expect(sdkModelSupportsImages({} as unknown as SdkModel)).toBe(false);
  });
});
