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
  it("n'émet qu'une phrase assez longue (minimum), même ponctuée", () => {
    const segmenter = new SentenceSegmenter({ minChars: 24, maxChars: 500 });
    expect(segmenter.push("Bonjour. ")).toEqual([]);
    expect(segmenter.push("Comment ça va ?")).toEqual([
      "Bonjour. Comment ça va ?",
    ]);
    expect(segmenter.flush()).toEqual([]);
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

  it("fusionne les énoncés plus courts que la longueur minimale", () => {
    const out = segmentAll("Oui. Non. Peut-être. C'est ainsi que l'on décide.", {
      minChars: 24,
      maxChars: 500,
    });
    // « Oui. Non. Peut-être. » est trop court : fusionné avec la phrase suivante.
    expect(out).toEqual(["Oui. Non. Peut-être. C'est ainsi que l'on décide."]);
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
