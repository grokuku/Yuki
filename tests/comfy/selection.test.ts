/**
 * Choix du WORKFLOW par PROXIMITÉ (libellé + description courte).
 *
 * ⚠️ Le style ne part JAMAIS dans le prompt : il ne sert QU'À choisir le
 * workflow. Ce module est PUR (aucune I/O) et son score est DÉTERMINISTE : à
 * égalité, l'ordre alphabétique du nom d'usage tranche.
 */

import { describe, expect, it } from "vitest";

import { chooseWorkflow, foldText, tokenize, type WorkflowCandidate } from "../../src/comfy/index.js";

/** Les trois workflows de l'énoncé (manga, réaliste, infographie). */
const CANDIDATES: WorkflowCandidate[] = [
  {
    name: "manga",
    description: "Manga / anime — traits marqués, trames",
    isDefault: false,
  },
  {
    name: "realiste",
    description: "Photo réaliste — rendu naturel, profondeur",
    isDefault: false,
  },
  {
    name: "infographie",
    description: "Infographie — aplats, formes nettes, lisible",
    isDefault: true,
  },
];

describe("choix par proximité", () => {
  it("« un truc style dessin animé japonais » ⇒ le workflow manga", () => {
    const choice = chooseWorkflow(CANDIDATES, "un truc style dessin animé japonais");
    expect(choice).not.toBeNull();
    expect(choice?.name).toBe("manga");
    expect(choice?.reason).toBe("proximity");
  });

  it("« photo » ⇒ le workflow réaliste", () => {
    expect(chooseWorkflow(CANDIDATES, "photo")?.name).toBe("realiste");
  });

  it("« un schéma avec des aplats » ⇒ le workflow infographie", () => {
    expect(chooseWorkflow(CANDIDATES, "un schéma avec des aplats")?.name).toBe("infographie");
  });

  it("sans précision, choisit d'après la SCÈNE quand elle évoque un style", () => {
    // La scène parle de « traits » et de « trames » : c'est la description de manga.
    const choice = chooseWorkflow(CANDIDATES, "un personnage aux traits marqués, trames");
    expect(choice?.name).toBe("manga");
  });

  it("rien ne correspond ⇒ le workflow PAR DÉFAUT", () => {
    const choice = chooseWorkflow(CANDIDATES, "zzz qqq wwww");
    expect(choice).toEqual({ name: "infographie", reason: "default", score: 0 });
  });

  it("rien ne correspond ET aucun défaut ⇒ null (jamais un choix au hasard)", () => {
    const withoutDefault = CANDIDATES.map((candidate) => ({ ...candidate, isDefault: false }));
    expect(chooseWorkflow(withoutDefault, "zzz qqq wwww")).toBeNull();
  });

  it("un SEUL workflow importé est utilisé, même sans correspondance", () => {
    const only = [{ name: "manga", description: "Manga / anime", isDefault: false }];
    expect(chooseWorkflow(only, "un paysage de montagne")).toEqual({
      name: "manga",
      reason: "only",
      score: 0,
    });
  });

  it("aucun workflow ⇒ null", () => {
    expect(chooseWorkflow([], "manga")).toBeNull();
    expect(chooseWorkflow([], undefined)).toBeNull();
  });

  it("une intention vide ne déclenche aucun score : le défaut tranche", () => {
    expect(chooseWorkflow(CANDIDATES, "")?.reason).toBe("default");
    expect(chooseWorkflow(CANDIDATES, undefined)?.reason).toBe("default");
  });

  it("à égalité de score, l'ordre alphabétique tranche (déterminisme)", () => {
    const tied: WorkflowCandidate[] = [
      { name: "zebra", description: "aplats", isDefault: false },
      { name: "ananas", description: "aplats", isDefault: false },
    ];
    expect(chooseWorkflow(tied, "aplats")?.name).toBe("ananas");
  });
});

describe("normalisation du texte", () => {
  it("plie les accents et la casse", () => {
    expect(foldText("Dessin Animé Réaliste")).toBe("dessin anime realiste");
  });

  it("découpe en mots utiles (≥ 3 lettres, hors mots vides, dédoublonnés)", () => {
    // « un », « truc » et « style » sont des mots vides : ils ne départagent rien.
    expect(tokenize("un truc style dessin animé japonais, un truc")).toEqual([
      "dessin",
      "anime",
      "japonais",
    ]);
  });
});
