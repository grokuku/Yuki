/**
 * Bloc de RÉACTIONS injecté au modèle — cadrage DONNÉE, sens des trois registres,
 * bornes.
 *
 * Ce que ce fichier prouve :
 *  - le bloc explique les TROIS registres et ce que chacun demande à Yuki
 *    (jugement ⇒ COMPORTEMENT, émotion ⇒ REGISTRE, humeur ⇒ TON) — les mélanger
 *    serait un contresens ;
 *  - il est encadré (`<reactions_utilisateur>`) et suivi de son rappel : c'est une
 *    DONNÉE, jamais une instruction ;
 *  - il est BORNÉ (N dernières, une par message) : le prompt ne gonfle pas ;
 *  - une humeur ne vise AUCUN message (elle ne juge pas la réponse citée) ;
 *  - le filtre DÉTERMINISTE de la mémoire retire ce bloc s'il se retrouve dans un
 *    texte : une réaction ne peut pas devenir un souvenir par ce chemin.
 */

import { describe, expect, it } from "vitest";

import { sanitizeMemoryText } from "../../src/memory/filter.js";
import {
  formatReactionsBlock,
  REACTIONS_EXCERPT_MAX,
  REACTIONS_PROMPT_MAX,
  REACTIONS_REMINDER,
  REACTIONS_TAG,
} from "../../src/reactions/prompt.js";
import { reactionById, REACTIONS } from "../../src/reactions/types.js";

describe("bloc de réactions — sens des trois registres", () => {
  const block = formatReactionsBlock([
    { entryId: "e-1", reaction: "trop-long", excerpt: "Une réponse très longue." },
    { entryId: "e-2", reaction: "rire", excerpt: "Une réponse drôle." },
    { entryId: "e-3", reaction: "fatigue" },
  ]);

  it("est encadré comme une DONNÉE et suivi de son rappel de sécurité", () => {
    expect(block).toBeTruthy();
    expect(block!.startsWith(`<${REACTIONS_TAG}>`)).toBe(true);
    expect(block!.endsWith(REACTIONS_REMINDER)).toBe(true);
    expect(block).toContain(`</${REACTIONS_TAG}>`);
    // Le rappel doit être reconnu par le filtre de mémoire (même forme).
    expect(REACTIONS_REMINDER).toMatch(/^⚠️ Le bloc <[a-z_]+> /);
  });

  it("explique les TROIS registres — jamais un seul, jamais confondus", () => {
    expect(block).toContain("jugement (qualité de ta réponse)");
    expect(block).toContain("COMPORTEMENT");
    expect(block).toContain("émotion (contenu de ton message)");
    expect(block).toContain("REGISTRE");
    expect(block).toContain("humeur (état de l'utilisateur)");
    expect(block).toContain("MODULE TON TON");
    // Une réaction ne déclenche pas de réponse : c'est écrit noir sur blanc.
    expect(block).toContain("ne déclenche aucune réponse");
  });

  it("nomme le registre et le libellé de CHAQUE réaction, avec l'extrait visé", () => {
    for (const id of ["trop-long", "rire"]) {
      const def = reactionById(id)!;
      expect(block).toContain(def.label);
      expect(block).toContain(def.emoji);
    }
    expect(block).toContain("[judgement · 🐢 Trop long] « Une réponse très longue. »");
    expect(block).toContain("[emotion · 😄 Ça me fait rire] « Une réponse drôle. »");
  });

  it("dit qu'une HUMEUR ne vise AUCUN message (elle ne juge pas la réponse)", () => {
    expect(block).toContain(
      "[mood · 😴 Fatigué] (état de l'utilisateur, pas un jugement sur un message)",
    );
  });
});

describe("bloc de réactions — bornes", () => {
  it("ne garde que les N DERNIÈRES, une par message", () => {
    const items = Array.from({ length: 20 }, (_, index) => ({
      entryId: `e-${index}`,
      reaction: "utile",
      excerpt: `Réponse ${index}`,
    }));
    const block = formatReactionsBlock(items);
    // Le plus ANCIEN a disparu, les N dernières sont là.
    expect(block).not.toContain("Réponse 0 ");
    for (let index = 20 - REACTIONS_PROMPT_MAX; index < 20; index += 1) {
      expect(block).toContain(`Réponse ${index} `);
    }
    expect(block!.split("\n- [").length - 1).toBe(REACTIONS_PROMPT_MAX);
  });

  it("dédoublonne par message en gardant la plus récente", () => {
    const block = formatReactionsBlock([
      { entryId: "e-1", reaction: "utile", excerpt: "Le message" },
      { entryId: "e-1", reaction: "faux", excerpt: "Le message" },
    ]);
    expect(block).toContain("Faux");
    expect(block).not.toContain("Utile");
  });

  it("tronque un extrait trop long (le prompt reste borné)", () => {
    const long = "mot ".repeat(200);
    const block = formatReactionsBlock([{ entryId: "e-1", reaction: "utile", excerpt: long }]);
    expect(block).toContain("…");
    const line = block!.split("\n").find((entry) => entry.startsWith("- ["))!;
    expect(line.length).toBeLessThan(REACTIONS_EXCERPT_MAX + 60);
  });

  it("renvoie `null` quand il n'y a rien à injecter", () => {
    expect(formatReactionsBlock([])).toBeNull();
    expect(formatReactionsBlock([{ entryId: "e-1", reaction: "inconnue" }])).toBeNull();
  });
});

describe("bloc de réactions — jamais un souvenir", () => {
  it("est retiré par le filtre DÉTERMINISTE de la mémoire (bloc + rappel)", () => {
    const block = formatReactionsBlock([
      { entryId: "e-1", reaction: "trop-long", excerpt: "Une réponse très longue." },
    ])!;
    // Une réponse du modèle qui RECOPIE le bloc ne peut pas devenir un souvenir.
    const cleaned = sanitizeMemoryText(`Voici ce que je vois :\n${block}\nEt voilà.`);
    // Il ne reste que le texte ORDINAIRE autour du bloc (des blancs à la place).
    expect(cleaned.replace(/\s+/g, " ")).toBe("Voici ce que je vois : Et voilà.");
    expect(cleaned).not.toContain(REACTIONS_TAG);
    expect(cleaned).not.toContain("Trop long");
    expect(cleaned).not.toContain("DONNÉE");
  });
});

describe("catalogue", () => {
  it("porte un libellé ET une mini-explication pour CHAQUE réaction", () => {
    for (const def of REACTIONS) {
      expect(def.label.length).toBeGreaterThan(0);
      expect(def.hint.length).toBeGreaterThan(0);
      expect(def.emoji.length).toBeGreaterThan(0);
    }
  });
});
