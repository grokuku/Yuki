/**
 * Filtrage markdown pour la parole (Lot 7, §5).
 *
 * Vérifie le retrait des marqueurs, la résolution des marqueurs coupés entre
 * deux deltas, l'ignorance des blocs de code (y compris non clôturés) et la
 * réécriture des liens.
 *
 * Depuis le Lot 8, le filtre retire aussi les **emojis, symboles décoratifs et
 * caractères invisibles** et normalise les espaces (second étage
 * `SpeechSanitizer`). Les tests correspondants sont plus bas.
 */

import { describe, expect, it } from "vitest";

import { MarkdownSpeechFilter } from "../../src/tts/markdown.js";
import { SentenceSegmenter } from "../../src/tts/segmenter.js";

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

describe("MarkdownSpeechFilter — nettoyage non parlé (Lot 8)", () => {
  it("retire les emojis (emphase, lien, titre)", () => {
    expect(filterAll(["Bonjour **le** monde 😊 !"])).toBe("Bonjour le monde !");
    expect(filterAll(["[la 😊 doc](http://x) à lire"])).toBe("la doc à lire");
    expect(filterAll(["# Titre 🎉"])).toBe("Titre ");
  });

  it("préserve toute la ponctuation de fin de phrase autour de l'emoji", () => {
    expect(filterAll(["Bonjour ! 😊 Ensuite, ça continue."])).toBe(
      "Bonjour ! Ensuite, ça continue.",
    );
    expect(filterAll(["Vraiment ? 🤔 Oui. 🎉"])).toBe("Vraiment ? Oui. ");
  });

  it("traite un emoji coupé entre deux deltas (jamais de demi-emoji émis)", () => {
    const filter = new MarkdownSpeechFilter();
    const first = filter.push("Bonjour \uD83D"); // high surrogate retenu
    expect(first).toBe("Bonjour ");
    expect(first).not.toMatch(/[\uD800-\uDBFF\uDC00-\uDFFF]/);
    const second = filter.push("\uDE0A !"); // low surrogate : l'emoji est supprimé
    expect(second).toBe("!");
    expect(second).not.toMatch(/[\uD800-\uDBFF\uDC00-\uDFFF]/);
    expect(second + filter.flush()).toBe("!");
    // Résultat complet, ponctuation intacte.
    expect(filterAll(["Bonjour \uD83D", "\uDE0A !"])).toBe("Bonjour !");
  });

  it("normalise les espaces et supprime les invisibles", () => {
    expect(filterAll(["un  mot\u00a0coupé\u200d!"])).toBe("un mot coupé!");
  });

  it("est idempotent à travers le filtre", () => {
    const once = filterAll(["Un 😊 test 🎉 avec des accents éàç et 3,14 € !"]);
    expect(filterAll([once])).toBe(once);
  });
});

describe("MarkdownSpeechFilter — interaction avec le segmenteur", () => {
  function segmentAll(text: string): string[] {
    const segmenter = new SentenceSegmenter({ minChars: 1, maxChars: 500 });
    return [...segmenter.push(text), ...segmenter.flush()];
  }

  it("le filtrage ne casse pas le découpage en phrases", () => {
    expect(segmentAll("Bonjour ! 😊 Ensuite, ça continue.")).toEqual([
      "Bonjour !",
      "Ensuite, ça continue.",
    ]);
    expect(segmentAll("Il fait beau ☀️ aujourd'hui. On sort ? 🎉")).toEqual([
      "Il fait beau aujourd'hui.",
      "On sort ?",
    ]);
  });

  it("produit le même découpage que le texte nettoyé manuellement", () => {
    const dirty = "Un 😊 test. Deux 🎉 points ! Trois ⭐ enfin ?";
    const clean = "Un test. Deux points ! Trois enfin ?";
    expect(segmentAll(dirty)).toEqual(segmentAll(clean));
  });

  it("un texte 100 % emoji ne produit aucun segment vocalisé", () => {
    expect(segmentAll("😀😃😄🎉")).toEqual([]);
  });
});
