/**
 * Filtrage markdown pour la parole (Lot 7, §5).
 *
 * Vérifie le retrait des marqueurs, la résolution des marqueurs coupés entre
 * deux deltas, l'ignorance des blocs de code (y compris non clôturés) et la
 * réécriture des liens.
 */

import { describe, expect, it } from "vitest";

import { MarkdownSpeechFilter } from "../../src/tts/markdown.js";

function filterAll(fragments: string[], options = {}): string {
  const filter = new MarkdownSpeechFilter(options);
  let out = "";
  for (const fragment of fragments) out += filter.push(fragment);
  return out + filter.flush();
}

describe("MarkdownSpeechFilter — marqueurs inline", () => {
  it("retire les emphases (gras/italique/barre)", () => {
    expect(filterAll(["**gras**"])).toBe("gras");
    expect(filterAll(["__gras__"])).toBe("gras");
    expect(filterAll(["*italique*"])).toBe("italique");
    expect(filterAll(["~~barre~~"])).toBe("barre");
  });

  it("résout un marqueur coupé entre deux deltas", () => {
    expect(filterAll(["**gr", "as**"])).toBe("gras");
    expect(filterAll(["*it", "ali", "que*"])).toBe("italique");
  });

  it("retire les délimiteurs de code inline", () => {
    expect(filterAll(["un `champ` ici"])).toBe("un champ ici");
  });
});

describe("MarkdownSpeechFilter — blocs", () => {
  it("retire les titres et les puces de liste", () => {
    expect(filterAll(["# Titre"])).toBe("Titre");
    expect(filterAll(["### Sous-titre"])).toBe("Sous-titre");
    expect(filterAll(["- item un"])).toBe("item un");
    expect(filterAll(["+ item deux"])).toBe("item deux");
    expect(filterAll(["* item trois"])).toBe("item trois");
    expect(filterAll(["1. premier"])).toBe("premier");
    expect(filterAll(["12) douzième"])).toBe("douzième");
  });

  it("retire les citations", () => {
    expect(filterAll(["> une citation"])).toBe("une citation");
  });
});

describe("MarkdownSpeechFilter — blocs de code", () => {
  it("ignore le contenu d'un bloc de code clôturé", () => {
    const out = filterAll(["Voici.\n```js\nconst x = 1;\n```\nFin."]);
    expect(out).toBe("Voici.\nFin.");
    expect(out).not.toContain("const");
  });

  it("gère un bloc de code coupé entre deltas", () => {
    const filter = new MarkdownSpeechFilter();
    expect(filter.push("Avant.\n```")).toBe("Avant.\n");
    expect(filter.push("python\n")).toBe("");
    expect(filter.push("print('x')\n")).toBe("");
    expect(filter.push("```\nAprès.")).toBe("Après.");
  });

  it("ignore un bloc de code NON clôturé (y compris au flush)", () => {
    const out = filterAll(["Début.\n```\nsecret\n", "encore secret"]);
    expect(out).toBe("Début.\n");
    expect(out).not.toContain("secret");
  });

  it("insère une annonce si demandé", () => {
    const out = filterAll(["Voici.\n```\ncode\n```\nFin."], {
      codeAnnouncement: "Bloc de code omis.",
    });
    expect(out).toContain("Bloc de code omis.");
  });
});

describe("MarkdownSpeechFilter — liens", () => {
  it("réécrit [texte](url) en texte", () => {
    expect(filterAll(["voir [la doc](http://exemple.fr) ici"])).toBe(
      "voir la doc ici",
    );
  });

  it("réécrit une image ![alt](url) en alt", () => {
    expect(filterAll(["![un chat](http://x/y.png)"])).toBe("un chat");
  });

  it("gère un lien coupé entre deltas", () => {
    expect(filterAll(["[la ", "doc](http", "://x)"])).toBe("la doc");
  });

  it("laisse un crochet non-lien en place", () => {
    expect(filterAll(["un tableau [1] ici"])).toBe("un tableau [1] ici");
  });
});

describe("MarkdownSpeechFilter — robustesse", () => {
  it("ne perd pas le texte vide", () => {
    expect(filterAll([""])).toBe("");
  });

  it("conserve un texte déjà propre", () => {
    const text = "Bonjour, ceci est une phrase normale.";
    expect(filterAll([text])).toBe(text);
  });
});
