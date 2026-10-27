/**
 * Validation d'un workflow ComfyUI (format API) + résolution des ÉTIQUETTES.
 *
 * ⚠️ PIÈGE ② (les identifiants de nœuds) : le MÊME graphe, avec des
 * identifiants DIFFÉRENTS, doit produire exactement les mêmes étiquettes et les
 * mêmes écritures. C'est la preuve que la localisation se fait PAR TITRE
 * (`_meta.title`) et jamais par numéro de nœud.
 *
 * ⚠️ PIÈGE ⑦ (le workflow mal formé) : tout refus doit DIRE ce qui est trouvé et
 * ce qui manque — jamais un refus muet, jamais une écriture au hasard.
 */

import { describe, expect, it } from "vitest";

import {
  YUKI_DEFAULT_NEGATIVE,
  YUKI_NODE_LABELS,
  applyYukiValues,
  validateApiWorkflow,
} from "../../src/comfy/index.js";

/** Nœud au format API : `{ class_type, inputs, _meta.title }`. */
function node(
  title: string | undefined,
  inputs: Record<string, unknown>,
  classType = "Input",
): Record<string, unknown> {
  return {
    class_type: classType,
    inputs,
    ...(title === undefined ? {} : { _meta: { title } }),
  };
}

/**
 * Workflow COMPLET, étiqueté. `ids` permet de REBAPTISER les nœuds (mêmes
 * titres, identifiants totalement différents).
 */
function fullWorkflow(ids: {
  prompt: string;
  negative: string;
  seed: string;
  size: string;
  save: string;
}): Record<string, unknown> {
  return {
    [ids.prompt]: node("YUKI_PROMPT", { text: "text" }, "CLIPTextEncode"),
    [ids.negative]: node("YUKI_NEGATIVE", { text: "text" }, "CLIPTextEncode"),
    [ids.seed]: node("YUKI_SEED", { seed: 0, steps: 20 }, "KSampler"),
    [ids.size]: node("YUKI_WIDTH", { width: 512, height: 512 }, "EmptyLatentImage"),
    [ids.save]: node(undefined, { filename_prefix: "Yuki" }, "SaveImage"),
  };
}

describe("résolution des étiquettes PAR TITRE", () => {
  it("résout les six étiquettes d'un graphe étiqueté", () => {
    // `YUKI_HEIGHT` est porté par le MÊME nœud que `YUKI_WIDTH` ? Non : un titre
    // par nœud. On ajoute donc un nœud dédié à la hauteur.
    const workflow = {
      ...fullWorkflow({ prompt: "6", negative: "7", seed: "3", size: "5", save: "9" }),
      h: node("YUKI_HEIGHT", { height: 512 }, "EmptyLatentImage"),
      out: node("YUKI_OUTPUT", { images: ["8", 0] }, "PreviewImage"),
    };
    const check = validateApiWorkflow(workflow);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.found).toEqual([...YUKI_NODE_LABELS]);
    expect(check.missing).toEqual([]);
    expect(check.labels.YUKI_PROMPT).toEqual({
      nodeId: "6",
      classType: "CLIPTextEncode",
      field: "text",
    });
    expect(check.labels.YUKI_SEED).toEqual({ nodeId: "3", classType: "KSampler", field: "seed" });
    expect(check.labels.YUKI_WIDTH).toEqual({
      nodeId: "5",
      classType: "EmptyLatentImage",
      field: "width",
    });
    expect(check.labels.YUKI_HEIGHT?.field).toBe("height");
    // ⚠️ `YUKI_OUTPUT` ne désigne AUCUN champ : c'est un nœud qu'on LIT.
    expect(check.labels.YUKI_OUTPUT).toEqual({ nodeId: "out", classType: "PreviewImage" });
    expect(check.labels.YUKI_OUTPUT?.field).toBeUndefined();
    expect(check.nodes).toBe(7);
  });

  it("trouve les MÊMES nœuds avec des identifiants TOTALEMENT différents", () => {
    const small = {
      ...fullWorkflow({ prompt: "1", negative: "2", seed: "3", size: "4", save: "5" }),
      h: node("YUKI_HEIGHT", { height: 512 }, "EmptyLatentImage"),
    };
    // Mêmes titres, identifiants non numériques et dans un autre ordre.
    const large = {
      h: node("YUKI_HEIGHT", { height: 512 }, "EmptyLatentImage"),
      "node-save": node(undefined, { filename_prefix: "Yuki" }, "SaveImage"),
      "zz-enc-prompt": node("YUKI_PROMPT", { text: "text" }, "CLIPTextEncode"),
      "aa-enc-neg": node("YUKI_NEGATIVE", { text: "text" }, "CLIPTextEncode"),
      "ks-42": node("YUKI_SEED", { seed: 0, steps: 20 }, "KSampler"),
      "latent-7": node("YUKI_WIDTH", { width: 512, height: 512 }, "EmptyLatentImage"),
    };

    const a = validateApiWorkflow(small);
    const b = validateApiWorkflow(large);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    // Les identifiants diffèrent…
    expect(a.labels.YUKI_PROMPT?.nodeId).toBe("1");
    expect(b.labels.YUKI_PROMPT?.nodeId).toBe("zz-enc-prompt");
    expect(a.labels.YUKI_SEED?.nodeId).toBe("3");
    expect(b.labels.YUKI_SEED?.nodeId).toBe("ks-42");
    // …mais les CHAMPS d'accueil et les étiquettes trouvées sont identiques.
    for (const label of YUKI_NODE_LABELS) {
      expect(b.labels[label]?.field).toBe(a.labels[label]?.field);
    }
    expect(b.found).toEqual(a.found);

    // Et l'INJECTION écrit dans les BONS nœuds, quelle que soit la numérotation.
    const values = {
      prompt: "une scène",
      negative: YUKI_DEFAULT_NEGATIVE,
      seed: 1234,
      width: 768,
      height: 512,
    };
    const written = applyYukiValues(b.workflow, b.labels, values);
    const byLabel = Object.fromEntries(written.injected.map((item) => [item.label, item]));
    expect(byLabel.YUKI_PROMPT).toMatchObject({
      nodeId: "zz-enc-prompt",
      field: "text",
      value: "une scène",
    });
    expect(byLabel.YUKI_SEED).toMatchObject({ nodeId: "ks-42", field: "seed", value: 1234 });
    expect(byLabel.YUKI_WIDTH).toMatchObject({
      nodeId: "latent-7",
      field: "width",
      value: 768,
    });
    expect(byLabel.YUKI_HEIGHT).toMatchObject({ nodeId: "h", field: "height", value: 512 });
    // Le graphe d'origine n'est PAS modifié (clone).
    const original = large["zz-enc-prompt"] as { inputs: Record<string, unknown> };
    expect(original.inputs.text).toBe("text");
  });

  it("accepte l'enveloppe { prompt: … } d'un export", () => {
    const workflow = {
      ...fullWorkflow({ prompt: "1", negative: "2", seed: "3", size: "4", save: "5" }),
      h: node("YUKI_HEIGHT", { height: 512 }, "EmptyLatentImage"),
    };
    const check = validateApiWorkflow({ prompt: workflow, client_id: "x" });
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.labels.YUKI_PROMPT?.nodeId).toBe("1");
  });
});

describe("étiquettes OBLIGATOIRES et facultatives", () => {
  it("REFUSE sans YUKI_PROMPT et liste trouvées / manquantes", () => {
    const workflow = {
      3: node("YUKI_SEED", { seed: 1 }, "KSampler"),
      7: node("YUKI_WIDTH", { width: 512 }, "EmptyLatentImage"),
      9: node("YUKI_HEIGHT", { height: 512 }, "EmptyLatentImage"),
      11: node(undefined, { filename_prefix: "Yuki" }, "SaveImage"),
    };
    const check = validateApiWorkflow(workflow);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.code).toBe("missing_required_label");
    expect(check.found).toEqual(["YUKI_SEED", "YUKI_WIDTH", "YUKI_HEIGHT"]);
    expect(check.missing).toEqual(["YUKI_PROMPT", "YUKI_NEGATIVE", "YUKI_OUTPUT"]);
    expect(check.message).toContain("YUKI_PROMPT");
    expect(check.message).toContain("OBLIGATOIRE");
  });

  it("accepte un graphe sans les étiquettes FACULTATIVES (elles sont listées comme manquantes)", () => {
    const workflow = {
      1: node("YUKI_PROMPT", { text: "text" }, "CLIPTextEncode"),
      2: node(undefined, { filename_prefix: "Yuki" }, "SaveImage"),
    };
    const check = validateApiWorkflow(workflow);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.found).toEqual(["YUKI_PROMPT"]);
    expect(check.missing).toEqual([
      "YUKI_NEGATIVE",
      "YUKI_SEED",
      "YUKI_WIDTH",
      "YUKI_HEIGHT",
      "YUKI_OUTPUT",
    ]);
    // Aucune valeur n'est inventée pour les étiquettes absentes.
    const written = applyYukiValues(check.workflow, check.labels, {
      prompt: "une scène",
      negative: "négatif",
      seed: 5,
      width: 8,
      height: 9,
    });
    expect(written.injected.map((item) => item.label)).toEqual(["YUKI_PROMPT"]);
  });
});

describe("étiquette YUKI_OUTPUT : le nœud de l'IMAGE FINALE", () => {
  it("accepte n'importe quel nœud de sortie, MÊME sans champ inscriptible", () => {
    // ⚠️ `PreviewImage` n'a qu'une entrée `images` (aucun champ à écrire) : c'est
    // justement le cas visé. Aucun refus, aucun champ résolu.
    const check = validateApiWorkflow({
      1: node("YUKI_PROMPT", { text: "text" }, "CLIPTextEncode"),
      "preview-final": node("YUKI_OUTPUT", { images: ["5", 0] }, "PreviewImage"),
    });
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.found).toEqual(["YUKI_PROMPT", "YUKI_OUTPUT"]);
    expect(check.labels.YUKI_OUTPUT).toEqual({
      nodeId: "preview-final",
      classType: "PreviewImage",
    });
  });

  it("reste FACULTATIVE : un graphe sans elle est valide et la liste comme manquante", () => {
    const check = validateApiWorkflow({
      1: node("YUKI_PROMPT", { text: "text" }, "CLIPTextEncode"),
      9: node(undefined, { filename_prefix: "Yuki" }, "SaveImage"),
    });
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.missing).toContain("YUKI_OUTPUT");
    expect(check.labels.YUKI_OUTPUT).toBeUndefined();
  });

  it("REFUSE deux nœuds portant le titre YUKI_OUTPUT (comme les autres étiquettes)", () => {
    const check = validateApiWorkflow({
      1: node("YUKI_PROMPT", { text: "text" }, "CLIPTextEncode"),
      2: node("YUKI_OUTPUT", { images: ["5", 0] }, "PreviewImage"),
      3: node("YUKI_OUTPUT", { images: ["6", 0] }, "SaveImage"),
    });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.code).toBe("duplicate_label");
    expect(check.message).toContain("YUKI_OUTPUT");
    expect(check.message).toContain("UN SEUL");
  });

  it("n'écrit RIEN dans le graphe (elle désigne une sortie, pas une valeur)", () => {
    const workflow = {
      1: node("YUKI_PROMPT", { text: "text" }, "CLIPTextEncode"),
      2: node("YUKI_OUTPUT", { images: ["5", 0] }, "PreviewImage"),
    };
    const check = validateApiWorkflow(workflow);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    const written = applyYukiValues(check.workflow, check.labels, { prompt: "une scène" });
    expect(written.injected.map((item) => item.label)).toEqual(["YUKI_PROMPT"]);
    // Le nœud de sortie reste INTACT (aucune clé ajoutée dans ses entrées).
    const out = written.workflow["2"] as { inputs: Record<string, unknown> };
    expect(Object.keys(out.inputs)).toEqual(["images"]);
  });
});

describe("refus explicites (PIÈGE ⑦)", () => {
  it("refuse un titre d'étiquette porté par DEUX nœuds", () => {
    const workflow = {
      1: node("YUKI_PROMPT", { text: "text" }),
      2: node("YUKI_PROMPT", { text: "text" }),
    };
    const check = validateApiWorkflow(workflow);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.code).toBe("duplicate_label");
    expect(check.message).toContain("YUKI_PROMPT");
    expect(check.message).toContain("UN SEUL");
  });

  it("refuse un workflow d'INTERFACE (nodes/links) en expliquant l'export API", () => {
    const check = validateApiWorkflow({ nodes: [], links: [], version: 0.4 });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.code).toBe("unsupported_format");
    expect(check.message).toContain("Save (API Format)");
  });

  it("refuse un JSON qui n'est pas un objet", () => {
    for (const raw of [null, 42, "texte", [], [] as unknown[]]) {
      const check = validateApiWorkflow(raw);
      expect(check.ok).toBe(false);
      if (check.ok) continue;
      expect(["invalid_workflow", "unsupported_format"]).toContain(check.code);
      expect(check.message.length).toBeGreaterThan(10);
    }
  });

  it("refuse un nœud sans class_type ou sans inputs", () => {
    const check = validateApiWorkflow({ 1: { inputs: { text: "x" } } });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.code).toBe("invalid_workflow");
    expect(check.message).toContain("class_type");
  });

  it("refuse un graphe VIDE", () => {
    const check = validateApiWorkflow({});
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.message).toContain("VIDE");
  });

  it("refuse une étiquette posée sur un nœud sans champ inscriptible", () => {
    const check = validateApiWorkflow({
      1: node("YUKI_PROMPT", { text: "text" }),
      2: node("YUKI_SEED", { denoise: 0.5, strength: 0.7 }, "KSampler"),
    });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.code).toBe("unsupported_label");
    expect(check.message).toContain("YUKI_SEED");
    expect(check.message).toContain("seed");
  });

  it("préfère `seed` à un autre entier du même nœud", () => {
    const check = validateApiWorkflow({
      1: node("YUKI_PROMPT", { text: "text" }),
      2: node("YUKI_SEED", { steps: 20, seed: 1 }, "KSampler"),
    });
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.labels.YUKI_SEED?.field).toBe("seed");
  });

  it("accepte `prompt` comme champ texte quand `text` est absent", () => {
    const check = validateApiWorkflow({
      1: node("YUKI_PROMPT", { prompt: "text" }, "SomeTextNode"),
    });
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.labels.YUKI_PROMPT?.field).toBe("prompt");
  });
});
