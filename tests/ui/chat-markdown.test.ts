/**
 * Rendu markdown du chat (volet 3) — logique PURE et cohérence AFFICHÉ / PARLÉ.
 *
 * Trois familles de vérifications :
 *  1. **Découpage en blocs stabilisés** (`splitStableBlocks`) : un bloc n'est
 *     émis que complet ; le résidu (fence non fermée, tableau/lien/liste en
 *     cours de frappe) reste en texte brut. Testable sans DOM.
 *  2. **Cas PARTAGÉS affiché/parlé** : pour un même corpus markdown, la
 *     structure affichée (client) et le texte parlé (filtre serveur) sont
 *     épinglés, et tout construct muet est présent à l'écran mais absent du
 *     parlé.
 *  3. **Miroir client ↔ serveur de la convention `muet`** : le JS vanilla ne
 *     peut pas importer le TS ; un test de non-divergence le garantit (même
 *     patron que `tts-frames.js` ↔ `framing.ts`).
 *
 * Le rendu DOM lui-même (nœuds, CSS, CSP) est prouvé par l'E2E navigateur.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MarkdownSpeechFilter } from "../../src/tts/markdown.js";
import {
  MUTE_BLOCK_LABELS as SERVER_MUTE_LABELS,
  isMuteInfoString as serverIsMuteInfoString,
} from "../../src/tts/mute.js";
import {
  MUTE_BLOCK_LABELS,
  isMuteInfoString,
  isSafeImageSrc,
  isSafeLink,
  parseBlocks,
  splitStableBlocks,
  tokenizeInline,
} from "../../public/ui/markdown.js";

type UiBlock = Record<string, unknown> & { type: string };

function finalBlocks(markdown: string): UiBlock[] {
  return parseBlocks(markdown, true).blocks as UiBlock[];
}

/** Types des blocs stabilisés d'un flux en cours. */
function stableTypes(markdown: string, from = 0): string[] {
  return (splitStableBlocks(markdown, from).blocks as UiBlock[]).map((b) => b.type);
}

/** Texte affichable d'un corpus de blocs (contenu brut destiné à l'écran). */
function displayModelText(blocks: UiBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "paragraph":
      case "heading":
      case "quote":
      case "code":
      case "mute":
        parts.push(String(block.text ?? ""));
        break;
      case "list":
        for (const item of (block.items as string[]) ?? []) parts.push(item);
        break;
      case "table": {
        for (const cell of (block.header as string[]) ?? []) parts.push(cell);
        for (const row of (block.rows as string[][]) ?? []) parts.push(...row);
        break;
      }
      default:
        break;
    }
  }
  return parts.join("\n");
}

function spoken(markdown: string): string {
  const filter = new MarkdownSpeechFilter();
  return filter.push(markdown) + filter.flush();
}

/* ─────────────────────── 1. Blocs stabilisés (pur, sans DOM) ────────────── */

describe("splitStableBlocks — blocs stabilisés et résidu brut", () => {
  it("un paragraphe n'est émis qu'une fois terminé (blanc/autre bloc/fin)", () => {
    expect(splitStableBlocks("Bonjour")).toEqual({ blocks: [], tail: "Bonjour" });
    expect(splitStableBlocks("Bonjour\n")).toEqual({ blocks: [], tail: "Bonjour\n" });
    expect(stableTypes("Bonjour\n\n")).toEqual(["paragraph"]);
    expect(splitStableBlocks("Bonjour\n\n").tail).toBe("");
  });

  it("un titre n'est stable qu'une fois sa ligne terminée", () => {
    expect(splitStableBlocks("# Tit").blocks).toEqual([]);
    expect(stableTypes("# Titre\n")).toEqual(["heading"]);
  });

  it("une fence non fermée reste en texte brut, puis se résout", () => {
    expect(splitStableBlocks("```js\nconst x").tail).toBe("```js\nconst x");
    expect(splitStableBlocks("```js\nconst x").blocks).toEqual([]);
    const done = splitStableBlocks("```js\nconst x = 1;\n```\n");
    expect(stableTypes("```js\nconst x = 1;\n```\n")).toEqual(["code"]);
    expect(done.tail).toBe("");
  });

  it("un tableau n'est stable qu'une fois confirmé par une séparatrice + terminé", () => {
    // Ligne `|` sans la suivante : décision en attente.
    expect(splitStableBlocks("| a | b |\n").blocks).toEqual([]);
    expect(splitStableBlocks("| a | b |\n").tail).toBe("| a | b |\n");
    // Confirmé par la séparatrice, mais touche encore la fin du flux : on attend.
    expect(splitStableBlocks("| a | b |\n| --- | --- |\n").blocks).toEqual([]);
    // Terminé par une ligne vide : émis.
    expect(stableTypes("| a | b |\n| --- | --- |\n| 1 | 2 |\n\n")).toEqual(["table"]);
  });

  it("une liste n'est stable qu'une fois terminée (liste « en cours de frappe »)", () => {
    expect(splitStableBlocks("- un\n- deux").blocks).toEqual([]);
    expect(splitStableBlocks("- un\n- deux\n- trois").tail).toBe("- un\n- deux\n- trois");
    expect(stableTypes("- un\n- deux\n\n")).toEqual(["list"]);
  });

  it("un lien/image non fermé reste brut (jamais de balise cassée au milieu)", () => {
    // Le paragraphe entier est en attente : rien n'est émis tant qu'il n'est
    // pas terminé, donc un `[` incomplet n'est jamais rendu comme un lien.
    expect(splitStableBlocks("Voir [la doc](http://x").blocks).toEqual([]);
    expect(stableTypes("Voir [la doc](http://x\n\n")).toEqual(["paragraph"]);
  });

  it("ne ré-analyse pas les blocs émis : le coût par delta reste borné au résidu", () => {
    // Simulation du flux incrémental : on n'accumule QUE les nouveaux blocs.
    let source = "";
    let from = 0;
    const emitted: string[] = [];
    for (const delta of ["# Tit", "re\n\n", "Un **gr", "as**.\n\n", "- a\n- b", "\n\nFin"]) {
      source += delta;
      const { blocks, tail } = parseBlocks(source, false, from);
      emitted.push(...(blocks as UiBlock[]).map((b) => b.type));
      from = tail.length > 0 ? source.length - tail.length : source.length;
    }
    expect(emitted).toEqual(["heading", "paragraph", "list"]);
    // Résidu final résolu par le flush.
    const flushed = (parseBlocks(source, true, from).blocks as UiBlock[]).map((b) => b.type);
    expect(flushed).toEqual(["paragraph"]);
  });

  it("un bloc muet est reconnu comme tel (type dédié)", () => {
    const blocks = finalBlocks("```muet\nsecret\n```\n");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("mute");
    expect(blocks[0]?.text).toBe("secret");
  });
});

/* ─────────────────────── 2. Analyse inline (pur) ────────────────────────── */

describe("tokenizeInline — jetons de mise en forme", () => {
  it("reconnaît gras, italique, code, lien et image", () => {
    expect(tokenizeInline("**gras**")).toEqual([{ type: "strong", children: [{ type: "text", value: "gras" }] }]);
    expect(tokenizeInline("*ita*")).toEqual([{ type: "em", children: [{ type: "text", value: "ita" }] }]);
    expect(tokenizeInline("`c`")).toEqual([{ type: "code", value: "c" }]);
    expect(tokenizeInline("[t](https://x)")).toEqual([
      { type: "link", children: [{ type: "text", value: "t" }], href: "https://x" },
    ]);
    expect(tokenizeInline("![alt](x.png)")).toEqual([{ type: "image", alt: "alt", src: "x.png" }]);
  });

  it("un marqueur non fermé reste du texte littéral (aucune balise cassée)", () => {
    expect(tokenizeInline("**pas fermé")).toEqual([{ type: "text", value: "**pas fermé" }]);
    expect(tokenizeInline("un [lien")).toEqual([{ type: "text", value: "un [lien" }]);
  });

  it("ne casse pas les identifiants à underscore", () => {
    expect(tokenizeInline("snake_case ici")).toEqual([{ type: "text", value: "snake_case ici" }]);
  });
});

describe("sécurité des destinations (CSP / anti-injection)", () => {
  it("refuse `javascript:` et les schémas inconnus, accepte http(s)/mailto/relatif", () => {
    expect(isSafeLink("javascript:alert(1)")).toBe(false);
    expect(isSafeLink("data:text/html,<script>")).toBe(false);
    expect(isSafeLink("https://exemple.fr")).toBe(true);
    expect(isSafeLink("mailto:a@b.fr")).toBe(true);
    expect(isSafeLink("/chemin")).toBe(true);
    expect(isSafeLink("#ancre")).toBe(true);
  });

  it("n'autorise QUE `self`/`data:image` pour les images (CSP `img-src`)", () => {
    expect(isSafeImageSrc("data:image/png;base64,AAAA")).toBe(true);
    expect(isSafeImageSrc("/images/x.png")).toBe(true);
    expect(isSafeImageSrc("x.png")).toBe(true);
    expect(isSafeImageSrc("https://externe.example/x.png")).toBe(false);
    expect(isSafeImageSrc("//externe.example/x.png")).toBe(false);
    expect(isSafeImageSrc("data:text/html,<script>")).toBe(false);
  });
});

/* ─────────────── 3. Cas PARTAGÉS affiché ↔ parlé (cohérence) ─────────────── */

interface SharedCase {
  name: string;
  markdown: string;
  display: string[];
  spoken: string;
  /** Contenu affiché mais jamais prononcé (constructs muets). */
  displayedNotSpoken: string[];
}

const SHARED_CASES: SharedCase[] = [
  {
    name: "paragraphe simple",
    markdown: "Bonjour, comment vas-tu ?",
    display: ["paragraph"],
    spoken: "Bonjour, comment vas-tu ?",
    displayedNotSpoken: [],
  },
  {
    name: "titre + gras/italique/code/lien",
    markdown:
      "# Résumé\n\nUn **point clé** et de l'*italique*, du `code` et un [lien](https://exemple.fr).\n",
    display: ["heading", "paragraph"],
    spoken: "Résumé\n\nUn point clé et de l'italique, du code et un lien.\n",
    displayedNotSpoken: [],
  },
  {
    name: "listes à puces et numérotée",
    markdown: "- un\n- deux\n\n1. premier\n2. second\n",
    display: ["list", "list"],
    spoken: "un\ndeux\n\npremier\nsecond\n",
    displayedNotSpoken: [],
  },
  {
    name: "citation + bloc de code (muet naturel)",
    markdown: "> Une citation\n\n```js\nconst secret = 1;\n```\n",
    display: ["quote", "code"],
    spoken: "Une citation\n\n",
    displayedNotSpoken: ["const secret = 1;"],
  },
  {
    name: "tableau (muet naturel) entre deux paragraphes",
    markdown: "Valeurs :\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nFin.\n",
    display: ["paragraph", "table", "paragraph"],
    spoken: "Valeurs :\n\n\nFin.\n",
    displayedNotSpoken: ["A", "B", "1", "2"],
  },
  {
    name: "image (muette) + bloc muet explicite",
    markdown:
      "Regarde cette illustration :\n\n![un chat](https://exemple.fr/chat.png)\n\n```muet\nsecret brut 42\n```\n\nVoilà.\n",
    display: ["paragraph", "paragraph", "mute", "paragraph"],
    spoken: "Regarde cette illustration :\n\n\n\n\nVoilà.\n",
    displayedNotSpoken: ["un chat", "secret brut 42"],
  },
];

describe("cas PARTAGÉS — affiché (client) ↔ parlé (serveur)", () => {
  for (const testCase of SHARED_CASES) {
    it(`${testCase.name} : la structure affichée et le texte parlé sont conformes`, () => {
      const blocks = finalBlocks(testCase.markdown);
      expect(blocks.map((b) => b.type)).toEqual(testCase.display);
      expect(spoken(testCase.markdown)).toBe(testCase.spoken);
    });

    it(`${testCase.name} : ce qui est affiché mais muet n'est PAS prononcé`, () => {
      const blocks = finalBlocks(testCase.markdown);
      const displayed = displayModelText(blocks);
      const said = spoken(testCase.markdown);
      for (const payload of testCase.displayedNotSpoken) {
        expect(displayed, `affiché : ${payload}`).toContain(payload);
        expect(said, `parlé : ${payload}`).not.toContain(payload);
      }
    });
  }

  it("une image n'est jamais prononcée, mais son texte alternatif est AFFICHÉ", () => {
    const blocks = finalBlocks("![un chat](https://exemple.fr/chat.png)\n");
    const paragraph = blocks[0];
    expect(paragraph?.type).toBe("paragraph");
    const tokens = tokenizeInline(String(paragraph?.text ?? ""));
    expect(tokens).toEqual([{ type: "image", alt: "un chat", src: "https://exemple.fr/chat.png" }]);
    expect(spoken("![un chat](https://exemple.fr/chat.png)\n")).not.toContain("un chat");
  });
});

/* ─────────────── 4. Miroir client ↔ serveur de la convention `muet` ──────── */

describe("miroir client ↔ serveur — convention du bloc muet", () => {
  it("les étiquettes du client ÉGALENT celles du serveur (source unique)", () => {
    expect(MUTE_BLOCK_LABELS).toEqual(SERVER_MUTE_LABELS);
  });

  it("`isMuteInfoString` se comporte à l'identique des deux côtés", () => {
    const samples = ["muet", "MUET", "Muet json", "json", "js", "", "  ", "muetx", "silent"];
    for (const sample of samples) {
      expect(isMuteInfoString(sample), sample).toBe(serverIsMuteInfoString(sample));
    }
  });
});

/* ─────────────── 5. Garde anti-injection (aucun HTML dérivé) ─────────────── */

describe("garde anti-injection — le rendu n'emploie jamais innerHTML", () => {
  it("public/ui/markdown.js ne contient AUCUN innerHTML (nœuds programmatiques)", () => {
    const source = readFileSync(join(process.cwd(), "public/ui/markdown.js"), "utf8");
    // Aucun usage réel (`.innerHTML`), hors commentaires de documentation.
    expect(source).not.toContain(".innerHTML");
    expect(source).not.toContain(".insertAdjacentHTML");
    expect(source).not.toContain(".outerHTML");
    // Les nœuds sont construits explicitement.
    expect(source).toContain("createElement");
    expect(source).toContain("createTextNode");
  });

  it("app.js ne vide la conversation via innerHTML que pour l'EFFACER (jamais du contenu)", () => {
    const source = readFileSync(join(process.cwd(), "public/ui/app.js"), "utf8");
    const matches = source.match(/\.innerHTML/g) ?? [];
    expect(matches.length).toBe(1);
    expect(source).toContain('els.conversation.innerHTML = ""');
  });
});
