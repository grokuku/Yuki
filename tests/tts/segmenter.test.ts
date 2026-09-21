/**
 * Segmentation incrémentale par phrase (Lot 7, §5) — cas exhaustifs.
 */

import { describe, expect, it } from "vitest";

import {
  SentenceSegmenter,
  findSentenceEnd,
  forcedCutIndex,
} from "../../src/tts/segmenter.js";

/** Segmente un texte en un seul delta puis flush. */
function segmentAll(text: string, options = {}): string[] {
  const segmenter = new SentenceSegmenter(options);
  return [...segmenter.push(text), ...segmenter.flush()];
}

/** Segmente un texte delta par delta puis flush. */
function segmentFragments(fragments: string[], options = {}): string[] {
  const segmenter = new SentenceSegmenter(options);
  const out: string[] = [];
  for (const fragment of fragments) out.push(...segmenter.push(fragment));
  out.push(...segmenter.flush());
  return out;
}

describe("SentenceSegmenter — découpe par phrase complète", () => {
  it("émet le PREMIER segment dès la 1re ponctuation, même < minimum", () => {
    // Règle D44 : le premier segment part dès « Bonjour. » (8 car.) malgré
    // min = 24 — but : réduire le TTFA avec un moteur offline.
    const segmenter = new SentenceSegmenter({ minChars: 24, maxChars: 500 });
    expect(segmenter.push("Bonjour. ")).toEqual(["Bonjour."]);
    expect(segmenter.flush()).toEqual([]);
  });

  it("applique le minimum à partir du DEUXIÈME segment", () => {
    const segmenter = new SentenceSegmenter({ minChars: 24, maxChars: 500 });
    expect(segmenter.push("Bonjour. ")).toEqual(["Bonjour."]);
    // Les segments suivants respectent le minimum : deux petites phrases
    // restent fusionnées (rendues au flush).
    expect(segmenter.push("Oui. Non. ")).toEqual([]);
    expect(segmenter.flush()).toEqual(["Oui. Non."]);
  });

  it("n'émet pas quand la ponctuation n'est pas suivie d'un blanc", () => {
    expect(
      segmentAll("Bonjour.Comment ça va ?", { minChars: 1, maxChars: 500 }),
    ).toEqual(["Bonjour.Comment ça va ?"]);
  });

  it("découpe plusieurs phrases d'un même delta", () => {
    expect(segmentAll("Un. Deux. Trois.", { minChars: 1, maxChars: 500 })).toEqual([
      "Un.",
      "Deux.",
      "Trois.",
    ]);
  });

  it("gère un delta coupé au milieu d'une phrase", () => {
    expect(
      segmentFragments(["Bonjour le ", "monde. Comment", " ça va ?"], {
        minChars: 1,
        maxChars: 500,
      }),
    ).toEqual(["Bonjour le monde.", "Comment ça va ?"]);
  });

  it("fusionne les énoncés SUIVANTS plus courts que la longueur minimale", () => {
    const out = segmentAll(
      "C'est le début. Oui. Non. Peut-être. C'est ainsi que l'on décide.",
      { minChars: 24, maxChars: 500 },
    );
    // Le 1er segment suit la règle D44 (court) ; ensuite « Oui. Non. Peut-être. »
    // reste fusionné avec la phrase suivante (règle min inchangée).
    expect(out).toEqual([
      "C'est le début.",
      "Oui. Non. Peut-être. C'est ainsi que l'on décide.",
    ]);
  });
});

describe("SentenceSegmenter — premier segment dès la 1re ponctuation (D44)", () => {
  it("émet « Bonjour ! » (court) avant la longue phrase suivante", () => {
    const out = segmentAll(
      "Bonjour ! Voici une phrase beaucoup plus longue qui suit.",
      { minChars: 24, maxChars: 500 },
    );
    expect(out).toEqual([
      "Bonjour !",
      "Voici une phrase beaucoup plus longue qui suit.",
    ]);
  });

  it("ne raccourcit QUE le premier segment (les suivants fusionnent)", () => {
    const out = segmentAll(
      "Bonjour ! Et voici maintenant une phrase nettement plus longue. Oui. Non. Une autre phrase assez longue termine le flux.",
      { minChars: 24, maxChars: 500 },
    );
    expect(out).toEqual([
      "Bonjour !",
      "Et voici maintenant une phrase nettement plus longue.",
      "Oui. Non. Une autre phrase assez longue termine le flux.",
    ]);
  });

  it("conserve l'ordre et le texte (recollage = source, aucun doublon)", () => {
    const source =
      "Bonjour ! Comment allez-vous ? Moi, je vais très bien, merci. Et vous ?";
    const out = segmentAll(source, { minChars: 24, maxChars: 500 });
    // Aucune perte : le recollage (blancs normalisés) redonne la source.
    expect(out.join(" ").replace(/\s+/g, " ")).toBe(
      source.replace(/\s+/g, " "),
    );
    // Aucun doublon.
    expect(new Set(out).size).toBe(out.length);
  });

  it("s'applique à chaque run (réarmé par reset)", () => {
    const segmenter = new SentenceSegmenter({ minChars: 24, maxChars: 500 });
    expect(segmenter.push("Bonjour. ")).toEqual(["Bonjour."]);
    // Le 2e segment du même run obéit au minimum.
    expect(segmenter.push("Oui. Non. ")).toEqual([]);
    segmenter.reset();
    // Nouveau run : la règle du premier segment est de nouveau active.
    expect(segmenter.push("Merci beaucoup. ")).toEqual(["Merci beaucoup."]);
  });
});

describe("SentenceSegmenter — premier segment (D44), cas limites", () => {
  it("ignore un premier « segment » qui ne serait QUE de la ponctuation", () => {
    const out = segmentAll("........ Bonjour tout le monde. Ensuite.", {
      minChars: 24,
      maxChars: 500,
    });
    expect(out[0]).toBe("........ Bonjour tout le monde.");
    expect(out[0]).not.toBe("........");
  });

  it("traite proprement un flux qui COMMENCE par de la ponctuation", () => {
    const out = segmentAll("! Bonjour tout le monde. Ensuite la suite arrive.", {
      minChars: 24,
      maxChars: 500,
    });
    expect(out[0]).toBe("! Bonjour tout le monde.");
    expect(out[0].trim()).not.toBe("!");
  });

  it("ne crée pas un premier segment absurde sur une abréviation (M.)", () => {
    const out = segmentAll("M. Dupont est arrivé tôt. Nous l'avons salué.", {
      minChars: 24,
      maxChars: 500,
    });
    expect(out[0]).toBe("M. Dupont est arrivé tôt.");
    expect(out[0]).not.toBe("M.");
  });

  it("ignore un bloc de code en TÊTE (le plancher ne le vocalise pas)", () => {
    const out = segmentAll(
      "```js\nconst x = 1;\n```\nBonjour tout le monde. Ensuite la suite arrive.",
      { minChars: 24, maxChars: 500 },
    );
    expect(out[0]).toBe("Bonjour tout le monde.");
    expect(out.join(" ")).not.toContain("const");
    expect(out.join(" ")).not.toContain("```");
  });

  it("ne dépasse jamais la longueur maximale (segments non finaux)", () => {
    const out = segmentAll("Bonjour ! " + "mot ".repeat(120).trim() + " fin.", {
      minChars: 24,
      maxChars: 40,
    });
    for (const segment of out.slice(0, -1)) {
      expect(segment.length).toBeLessThanOrEqual(40);
    }
  });

  it("reste linéaire sur un flux long, delta par delta (chemin critique)", () => {
    // 4 000 phrases poussées une à une : `push` est synchrone, sans `await` ni
    // regex quadratique. Un glissement dans le chemin des deltas exploserait
    // ce budget (très large : mesuré en dizaines de ms).
    const sentences = Array.from(
      { length: 4_000 },
      (_, i) => `Phrase numéro ${i}.`,
    );
    const segmenter = new SentenceSegmenter({ minChars: 1, maxChars: 500 });
    const out: string[] = [];
    const started = performance.now();
    for (const sentence of sentences) out.push(...segmenter.push(`${sentence} `));
    out.push(...segmenter.flush());
    const elapsed = performance.now() - started;
    expect(out).toEqual(sentences);
    expect(elapsed).toBeLessThan(2_000);
  });
});

describe("SentenceSegmenter — ponctuation française", () => {
  it("ne coupe pas sur une abréviation ni une initiale", () => {
    const out: string[] = [];
    const segmenter = new SentenceSegmenter({ minChars: 1, maxChars: 500 });
    out.push(...segmenter.push("M. Dupont est arrivé. Il attend. "));
    out.push(...segmenter.flush());
    expect(out).toEqual(["M. Dupont est arrivé.", "Il attend."]);
  });

  it("ne coupe pas sur un nombre décimal", () => {
    expect(
      segmentAll("La valeur 3.14 est proche. Ensuite on continue.", {
        minChars: 1,
        maxChars: 500,
      }),
    ).toEqual(["La valeur 3.14 est proche.", "Ensuite on continue."]);
  });

  it("gère les guillemets français et l'ellipse", () => {
    expect(
      segmentAll("Il a dit : « Bonjour ! » puis il partit… Et ensuite ?", {
        minChars: 1,
        maxChars: 500,
      }),
    ).toEqual(["Il a dit : « Bonjour ! » puis il partit…", "Et ensuite ?"]);
  });

  it("consomme les fermetures après la ponctuation", () => {
    expect(
      segmentAll('Il a demandé « pourquoi ? » à tous. Fin.', {
        minChars: 1,
        maxChars: 500,
      }),
    ).toEqual(["Il a demandé « pourquoi ? » à tous.", "Fin."]);
  });
});

describe("SentenceSegmenter — coupe forcée (longueur maximale)", () => {
  it("coupe à la virgule la plus proche avant la borne", () => {
    const text =
      "Voici une longue première partie, puis une seconde partie qui continue encore et encore sans ponctuation forte finale";
    const out = segmentAll(text, { minChars: 1, maxChars: 40 });
    expect(out.length).toBeGreaterThan(1);
    expect(out[0]).toBe("Voici une longue première partie,");
    expect(out.join(" ").replace(/\s+/g, " ")).toBe(text);
  });

  it("ne dépasse jamais la borne (segments non finaux)", () => {
    const text = "a".repeat(50) + " " + "b".repeat(50) + " fin.";
    const out = segmentAll(text, { minChars: 8, maxChars: 40 });
    for (const segment of out.slice(0, -1)) {
      expect(segment.length).toBeLessThanOrEqual(40);
    }
    // La coupe forcée peut scinder un mot sans blanc : on ignore les blancs.
    expect(out.join("").replace(/\s+/g, "")).toBe(
      text.replace(/\s+/g, ""),
    );
  });

  it("coupe à l'espace s'il n'y a pas de virgule", () => {
    const text = "mot ".repeat(20).trim();
    const out = segmentAll(text, { minChars: 1, maxChars: 40 });
    for (const segment of out.slice(0, -1)) {
      expect(segment.length).toBeLessThanOrEqual(40);
    }
  });
});

describe("SentenceSegmenter — flush du résidu", () => {
  it("émet le résidu sans ponctuation finale", () => {
    expect(segmentAll("Un. Deux", { minChars: 1, maxChars: 500 })).toEqual([
      "Un.",
      "Deux",
    ]);
  });

  it("émet un résidu plus court que le minimum", () => {
    expect(segmentAll("Voici une longue phrase terminée. Oui", {
      minChars: 24,
      maxChars: 500,
    })).toEqual(["Voici une longue phrase terminée.", "Oui"]);
  });
});

describe("SentenceSegmenter — markdown intégré", () => {
  it("segmente le texte filtré et ignore le code", () => {
    const segments = segmentAll(
      "## Titre\n**Bonjour** à tous, voici [la doc](http://x) pour commencer.\n```js\nconst x = 1;\n```",
      { minChars: 1, maxChars: 500 },
    );
    const joined = segments.join(" ");
    expect(joined).toContain("# Titre".slice(2));
    expect(joined).toContain("Bonjour");
    expect(joined).toContain("la doc");
    expect(joined).not.toContain("##");
    expect(joined).not.toContain("**");
    expect(joined).not.toContain("http");
    expect(joined).not.toContain("const");
  });
});

describe("SentenceSegmenter — cas limites", () => {
  it("ignore un texte vide", () => {
    const segmenter = new SentenceSegmenter();
    expect(segmenter.push("")).toEqual([]);
    expect(segmenter.flush()).toEqual([]);
  });

  it("purge son état au reset", () => {
    const segmenter = new SentenceSegmenter({ minChars: 1, maxChars: 500 });
    segmenter.push("Un. Deux.");
    segmenter.reset();
    expect(segmenter.flush()).toEqual([]);
  });

  it("ramène min à max si min > max (pas de blocage)", () => {
    const segmenter = new SentenceSegmenter({ minChars: 200, maxChars: 40 });
    const out = segmenter.push("Phrase numéro une. Phrase numéro deux. Phrase trois.");
    expect(out.length).toBeGreaterThan(0);
    expect(segmenter.flush().length).toBeGreaterThanOrEqual(0);
  });
});

describe("helpers exportés", () => {
  it("findSentenceEnd renvoie -1 sans frontière acceptable", () => {
    expect(findSentenceEnd("pas de ponctuation ici", 1, 500)).toBe(-1);
    expect(findSentenceEnd("court. ", 100, 500)).toBe(-1);
  });

  it("forcedCutIndex privilégie la virgule, sinon l'espace", () => {
    expect(forcedCutIndex("un, deux trois quatre cinq six sept", 12)).toBe(3);
    expect(forcedCutIndex("un deux trois quatre cinq", 12)).toBe(7);
  });
});
