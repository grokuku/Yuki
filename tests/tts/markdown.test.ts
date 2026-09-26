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

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { VOICE_SPEECH_INSTRUCTION } from "../../src/llm/prompts.js";
import { MarkdownSpeechFilter } from "../../src/tts/markdown.js";
import { MUTE_BLOCK_LABEL, isMuteInfoString } from "../../src/tts/mute.js";
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

  it("réécrit une image ![alt](url) en vide (le texte alternatif n'est plus lu)", () => {
    expect(filterAll(["![un chat](http://x/y.png)"])).toBe("");
    expect(filterAll(["Voir ![chat](x.png) ici"])).toBe("Voir ici");
  });

  it("gère un lien coupé entre deltas", () => {
    expect(filterAll(["[la ", "doc](http", "://x)"])).toBe("la doc");
  });

  it("gère une image coupée entre deux deltas (jamais d'alt émis)", () => {
    const filter = new MarkdownSpeechFilter();
    expect(filter.push("Voir ![cha")).toBe("Voir ");
    // L'espace de tête est absorbé (le filtre est incrémental sur un seul flux).
    expect(filter.push("t](x.png) ici")).toBe("ici");
    expect(filter.flush()).toBe("");
    expect(filterAll(["Voir ![cha", "t](x.png) ici"])).toBe("Voir ici");
  });

  it("laisse un crochet non-lien en place", () => {
    expect(filterAll(["un tableau [1] ici"])).toBe("un tableau [1] ici");
  });
});

describe("MarkdownSpeechFilter — tableaux muets", () => {
  it("ignore un tableau simple (avec pipes de bord)", () => {
    expect(filterAll(["| a | b |\n|---|---|\n| 1 | 2 |\nFin."])).toBe("Fin.");
  });

  it("ignore un tableau sans pipes de bord", () => {
    expect(filterAll(["a | b\n--- | ---\n1 | 2\n"])).toBe("");
  });

  it("conserve le texte autour d'un tableau", () => {
    expect(filterAll(["Avant\n| a | b |\n|---|---|\n| 1 | 2 |\nAprès"])).toBe(
      "Avant\nAprès",
    );
  });

  it("gère un tableau coupé entre deux deltas", () => {
    const filter = new MarkdownSpeechFilter();
    expect(filter.push("| a | b |\n")).toBe("");
    expect(filter.push("|---|")).toBe("");
    expect(filter.push("\n| 1 | 2 |\n")).toBe("");
    expect(filter.flush()).toBe("");
    expect(filterAll(["| a | b |\n", "|---|", "\n| 1 | 2 |\nFin."])).toBe("Fin.");
  });

  it("ne lit PAS un tableau une ligne `|` sans séparatrice (repli défensif)", () => {
    expect(filterAll(["Vrai | Faux"])).toBe("Vrai | Faux");
    expect(filterAll(["a | b\nligne suivante.\n"])).toBe("a | b\nligne suivante.\n");
  });
});

describe("MarkdownSpeechFilter — blocs muets (convention unique)", () => {
  const fence = "```" + MUTE_BLOCK_LABEL;

  it("ignore un bloc muet clôturé", () => {
    expect(filterAll([fence + "\nsecret\n```\nFin."])).toBe("Fin.");
  });

  it("ignore un bloc muet NON clôturé (y compris au flush)", () => {
    const out = filterAll(["Début.\n" + fence + "\nsecret\n", "encore secret"]);
    expect(out).toBe("Début.\n");
    expect(out).not.toContain("secret");
  });

  it("gère un bloc muet coupé entre deux deltas", () => {
    const filter = new MarkdownSpeechFilter();
    expect(filter.push("Avant.\n```")).toBe("Avant.\n");
    expect(filter.push(MUTE_BLOCK_LABEL + "\n")).toBe("");
    expect(filter.push("secret\n")).toBe("");
    expect(filter.push("```\nAprès.")).toBe("Après.");
  });

  it("n'annonce PAS un bloc muet, mais annonce encore un bloc de code", () => {
    expect(
      filterAll([fence + "\ncode\n```\n"], { codeAnnouncement: "Bloc de code omis." }),
    ).toBe("");
    expect(
      filterAll(["```js\ncode\n```\n"], { codeAnnouncement: "Bloc de code omis." }),
    ).toContain("Bloc de code omis.");
  });

  it("isMuteInfoString : premier mot, casse ignorée, sinon faux", () => {
    expect(isMuteInfoString(MUTE_BLOCK_LABEL)).toBe(true);
    expect(isMuteInfoString("MUET")).toBe(true);
    expect(isMuteInfoString("muet json")).toBe(true);
    expect(isMuteInfoString("json")).toBe(false);
    expect(isMuteInfoString("")).toBe(false);
  });
});

describe("MarkdownSpeechFilter — garde anti-divergence de la convention", () => {
  it("le filtre et le texte du prompt lisent la MÊME constante", () => {
    // Le filtre reconnaît l'étiquette canonique…
    const filter = new MarkdownSpeechFilter();
    const out = filter.push("```" + MUTE_BLOCK_LABEL + "\nsecret\n```\nFin.");
    expect(out + filter.flush()).toBe("Fin.");
    // …et le prompt la référence par interpolation (pas de littéral recopié).
    expect(VOICE_SPEECH_INSTRUCTION).toContain(MUTE_BLOCK_LABEL);
    expect(isMuteInfoString(MUTE_BLOCK_LABEL)).toBe(true);
  });

  it("aucun littéral d'étiquette en dur dans le filtre ni dans le prompt", () => {
    const markdown = readFileSync(join(process.cwd(), "src/tts/markdown.ts"), "utf8");
    const prompts = readFileSync(join(process.cwd(), "src/llm/prompts.ts"), "utf8");
    // Aucune chaîne littérale `"muet"`/`'muet'` : l'étiquette vient de `mute.ts`.
    expect(markdown).not.toMatch(/["']muet["']/);
    expect(prompts).not.toMatch(/["']muet["']/);
    // Les deux consommateurs importent bien la source unique.
    expect(markdown).toContain("./mute.js");
    expect(prompts).toContain("../tts/mute.js");
  });

  it("non-régression : titres, listes, citations et liens sont toujours lus", () => {
    expect(
      filterAll(["# Titre\n- un\n- deux\n> citation\n[la doc](http://x)"]),
    ).toBe("Titre\nun\ndeux\ncitation\nla doc");
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

  it("flush restitue un fragment retenu (lien non fermé)", () => {
    // Le `[` retenu n'est résolu qu'au `flush` : il ne doit pas être perdu.
    expect(filterAll(["un [lien"])).toBe("un [lien");
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

  it("un tableau ne produit aucun segment vocalisé (texte autour préservé)", () => {
    expect(segmentAll("| a | b |\n|---|---|\n| 1 | 2 |\n")).toEqual([]);
    expect(segmentAll("Avant.\n| a | b |\n|---|---|\n| 1 | 2 |\nAprès.")).toEqual([
      "Avant.",
      "Après.",
    ]);
  });
});
