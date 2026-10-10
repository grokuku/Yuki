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
  COPIED_LABEL,
  COPY_FAILED_LABEL,
  COPY_LABEL,
  isExternalLink,
  isMuteInfoString,
  isSafeImageSrc,
  isSafeLink,
  parseBlocks,
  renderBlock,
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
  it("n'autorise QUE `http`/`https`, casse ignorée, tabulations et sauts de ligne neutralisés", () => {
    expect(isSafeLink("https://exemple.fr")).toBe(true);
    expect(isSafeLink("http://exemple.fr")).toBe(true);
    expect(isSafeLink("HTTPS://exemple.fr")).toBe(true);
    expect(isSafeLink("HttpS://exemple.fr")).toBe(true);
    expect(isExternalLink("https://exemple.fr")).toBe(true);
    expect(isExternalLink("http://exemple.fr")).toBe(true);
    // Cibles SANS schéma : même origine (pas un site web).
    expect(isSafeLink("/chemin")).toBe(true);
    expect(isSafeLink("#ancre")).toBe(true);
    expect(isExternalLink("/chemin")).toBe(false);
  });

  it("refuse `javascript:` sous TOUTES ses casses et variantes encodées", () => {
    const refusés = [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "JAVASCRIPT:alert(1)",
      " javascript:alert(1)", // espace de bord
      "\tjavascript:alert(1)", // tabulation de bord
      "\njavascript:alert(1)", // saut de ligne de bord
      "java\tscript:alert(1)", // tabulation INTERNE (le navigateur l'ignore)
      "java\nscript:alert(1)", // saut de ligne INTERNE
      "jav\u0000ascript:alert(1)", // NUL interne
      "\u0001javascript:alert(1)", // C0 de bord (le navigateur le retire)
    ];
    for (const href of refusés) {
      expect(isSafeLink(href), href).toBe(false);
      expect(isExternalLink(href), href).toBe(false);
    }
  });

  it("refuse `data:`, `file:`, `blob:`, `vbscript:`, `mailto:` et le protocol-relatif", () => {
    for (const href of [
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "blob:https://yuki.local/id",
      "vbscript:msgbox(1)",
      "mailto:a@b.fr",
      "//externe.example/x",
      "\\\\externe.example/x",
    ]) {
      expect(isSafeLink(href), href).toBe(false);
    }
  });

  it("n'autorise QUE `self`/`data:image` pour les images (CSP `img-src`)", () => {
    expect(isSafeImageSrc("data:image/png;base64,AAAA")).toBe(true);
    expect(isSafeImageSrc("/images/x.png")).toBe(true);
    expect(isSafeImageSrc("x.png")).toBe(true);
    expect(isSafeImageSrc("https://externe.example/x.png")).toBe(false);
    expect(isSafeImageSrc("//externe.example/x.png")).toBe(false);
    expect(isSafeImageSrc("data:text/html,<script>")).toBe(false);
    // Variantes encodées : jamais de contournement de la garde `img-src`.
    expect(isSafeImageSrc("java\tscript:x")).toBe(false);
    expect(isSafeImageSrc("\u0001https://externe.example/x.png")).toBe(false);
  });
});

/* ─── 2bis. Liens cliquables : autolink pur + rendu DOM (faux document) ──── */

/** Tampon DOM minimal (suffisant pour `renderBlock` : création de nœuds). */
function makeFakeDoc(): any {
  const make = (nodeType: number, nodeName: string): any => {
    const attrs: Record<string, string> = {};
    const node: any = {
      nodeType,
      nodeName,
      childNodes: [] as any[],
      appendChild(child: any) {
        this.childNodes.push(child);
        return child;
      },
      setAttribute(key: string, value: string) {
        attrs[key] = value;
        this[key] = value;
      },
      getAttribute(key: string) {
        return attrs[key];
      },
      addEventListener(type: string, handler: () => void) {
        (this.listeners[type] ||= []).push(handler);
      },
      dispatch(type: string) {
        for (const handler of this.listeners[type] ?? []) handler();
      },
    };
    node.listeners = {} as Record<string, Array<() => void>>;
    Object.defineProperty(node, "textContent", {
      get: () => {
        if (node.nodeType === 3) return String(node.nodeValue ?? "");
        if (node._ownText !== undefined) return node._ownText;
        return node.childNodes.map((c: any) => c.textContent ?? "").join("");
      },
      set: (value: unknown) => {
        node.childNodes = [];
        node._ownText = String(value ?? "");
      },
    });
    return node;
  };
  return {
    createElement: (tag: string) => make(1, tag.toUpperCase()),
    createTextNode: (value: string) => {
      const node = make(3, "#text");
      node.nodeValue = value;
      return node;
    },
    createDocumentFragment: () => make(11, "#fragment"),
  };
}

/** Rend un corpus markdown et renvoie tous ses nœuds `<a>` (faux DOM). */
function renderedAnchors(markdown: string): any[] {
  const doc = makeFakeDoc();
  const roots = (parseBlocks(markdown, true).blocks as UiBlock[]).map((block) =>
    renderBlock(block, doc),
  );
  const found: any[] = [];
  const walk = (node: any): void => {
    if (!node) return;
    if (node.nodeName === "A") found.push(node);
    for (const child of node.childNodes ?? []) walk(child);
  };
  for (const root of roots) walk(root);
  return found;
}

describe("autolink des URL nues (pur)", () => {
  it("reconnaît http(s):// et conserve l'URL comme texte du lien", () => {
    expect(tokenizeInline("voir https://exemple.fr/doc")).toEqual([
      { type: "text", value: "voir " },
      { type: "link", children: [{ type: "text", value: "https://exemple.fr/doc" }], href: "https://exemple.fr/doc", autolink: true },
    ]);
  });

  it("retire la ponctuation de fin de phrase et les parenthèses non appariées", () => {
    expect(tokenizeInline("cf. https://exemple.fr/a).")).toEqual([
      { type: "text", value: "cf. " },
      { type: "link", children: [{ type: "text", value: "https://exemple.fr/a" }], href: "https://exemple.fr/a", autolink: true },
      { type: "text", value: ")." },
    ]);
    expect(tokenizeInline("https://exemple.fr/a(b)")[0]).toMatchObject({ href: "https://exemple.fr/a(b)" });
  });

  it("ne découpe pas un mot et ignore les URL dans le code", () => {
    expect(tokenizeInline("xhTTps://no.fr")).toEqual([{ type: "text", value: "xhTTps://no.fr" }]);
    expect(tokenizeInline("`https://code.fr`")).toEqual([{ type: "code", value: "https://code.fr" }]);
  });

  it("exige un hôte (un schéma seul n'est pas un lien)", () => {
    expect(tokenizeInline("http://")).toEqual([{ type: "text", value: "http://" }]);
    expect(tokenizeInline("https://")).toEqual([{ type: "text", value: "https://" }]);
    expect(tokenizeInline("http://x")).toEqual([
      { type: "link", children: [{ type: "text", value: "http://x" }], href: "http://x", autolink: true },
    ]);
  });
});

describe("liens rendus (faux DOM) — attributs de sécurité", () => {
  it("`https` et `http` deviennent des `<a>` externes en nouvel onglet", () => {
    for (const href of ["https://exemple.fr/x", "http://exemple.fr/x"]) {
      const [a] = renderedAnchors(`[doc](${href})`);
      expect(a, href).toBeDefined();
      expect(a.href).toBe(href);
      expect(a.target).toBe("_blank");
      expect(a.rel).toBe("noopener noreferrer");
      expect(a.title).toBe(href);
      expect(a.textContent).toBe("doc");
    }
  });

  it("`javascript:` (et variantes) reste du TEXTE : aucun `<a>` produit", () => {
    for (const href of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      " javascript:alert(1)",
      "java\tscript:alert(1)",
      "data:text/html,x",
      "file:///etc/passwd",
    ]) {
      expect(renderedAnchors(`[clic](${href})`), href).toEqual([]);
    }
  });

  it("une cible de même origine n'ouvre PAS de nouvel onglet", () => {
    const [a] = renderedAnchors("[config](/config)");
    expect(a.href).toBe("/config");
    expect(a.target).toBeUndefined();
    expect(a.rel).toBeUndefined();
  });

  it("un libellé vide affiche l'URL (lien jamais invisible)", () => {
    const [a] = renderedAnchors("[](https://exemple.fr)");
    expect(a.textContent).toBe("https://exemple.fr");
  });

  it("les URL des blocs de code ne sont JAMAIS cliquables", () => {
    expect(renderedAnchors("```\nhttps://exemple.fr\n```")).toEqual([]);
    expect(renderedAnchors("```muet\nhttps://exemple.fr\n```")).toEqual([]);
  });

  it("une URL nue devient un lien externe cliquable", () => {
    const [a] = renderedAnchors("Voir https://exemple.fr/doc pour la doc.");
    expect(a.href).toBe("https://exemple.fr/doc");
    expect(a.target).toBe("_blank");
    expect(a.rel).toBe("noopener noreferrer");
    expect(a.textContent).toBe("https://exemple.fr/doc");
  });
});

/* ─────── 2ter. Bouton « copier » des blocs de code (faux DOM) ───────────── */

/** Rend un corpus markdown et renvoie les racines + tous les nœuds (faux DOM). */
function renderRoots(markdown: string): { doc: any; roots: any[] } {
  const doc = makeFakeDoc();
  const roots = (parseBlocks(markdown, true).blocks as UiBlock[]).map((block) =>
    renderBlock(block, doc),
  );
  return { doc, roots };
}

/** Parcours en profondeur : tous les nœuds d'un arbre faux-DOM. */
function walkNodes(node: any, out: any[] = []): any[] {
  if (!node) return out;
  out.push(node);
  for (const child of node.childNodes ?? []) walkNodes(child, out);
  return out;
}

/** Tous les `<button class="md-copy-btn">` d'un rendu markdown. */
function renderedCopyButtons(markdown: string): any[] {
  const { roots } = renderRoots(markdown);
  return roots.flatMap((root) => walkNodes(root)).filter((n) => n.className === "md-copy-btn");
}

/** Le premier `<code>` d'un rendu markdown (contenu à copier). */
function renderedCodeNode(markdown: string): any | undefined {
  const { roots } = renderRoots(markdown);
  return roots.flatMap((root) => walkNodes(root)).find((n) => n.nodeName === "CODE");
}

describe("bouton « copier » des blocs de code", () => {
  it("un bloc de code clôturé porte un VRAI <button> avec aria-label et title", () => {
    const [button] = renderedCopyButtons("```\nconst x = 1;\n```\n");
    expect(button).toBeDefined();
    expect(button.nodeName).toBe("BUTTON");
    expect(button.type).toBe("button");
    expect(button.getAttribute("aria-label")).toBe(COPY_LABEL);
    expect(button.title).toBe(COPY_LABEL);
  });

  it("un bloc « muet » porte aussi le bouton (en plus de la marque muet)", () => {
    const { roots } = renderRoots("```muet\nsecret brut 42\n```\n");
    const all = roots.flatMap((root) => walkNodes(root));
    expect(all.some((n) => n.className === "md-copy-btn")).toBe(true);
    expect(all.some((n) => n.className === "md-mute-badge")).toBe(true);
  });

  it("la cible de copie est EXACTEMENT le contenu du bloc (bouton et marque exclus)", () => {
    // Cas piégeux : indentation, tabulation, espaces de fin, échappements HTML,
    // Unicode, retours à la ligne — le texte doit être reproduit À L'IDENTIQUE.
    const payload = [
      "function f() {",
      "\techo \"h\u00e9llo & <monde> 'x'\"", // tabulation + & < > quotes + é
      "    return 42;   ", // espaces de fin conservés
      "}",
    ].join("\n");
    const markdown = "```bash\n" + payload + "\n```\n";
    const code = renderedCodeNode(markdown);
    expect(code).toBeDefined();
    expect(code.textContent).toBe(payload);
    // Ni le libellé "Copier" ni la marque "muet" ne polluent la cible.
    expect(code.textContent).not.toContain("Copier");
    expect(code.textContent).not.toContain("muet");
  });

  it("le contenu d'un bloc muet reste propre (ni marque, ni bouton)", () => {
    const payload = "donnees {\"brutes\": [1, 2, 3]}";
    const code = renderedCodeNode("```muet\n" + payload + "\n```\n");
    expect(code?.textContent).toBe(payload);
  });

  it("aucun bouton sur le code EN LIGNE ni sur les tableaux (choix assumé)", () => {
    expect(renderedCopyButtons("du `code` en ligne\n")).toEqual([]);
    expect(renderedCopyButtons("| A | B |\n| --- | --- |\n| 1 | 2 |\n\n")).toEqual([]);
  });

  it("les libellés d'état sont explicites et en français", () => {
    expect(COPY_LABEL).toMatch(/copier/i);
    expect(COPIED_LABEL).toMatch(/copi\u00e9/i);
    expect(COPY_FAILED_LABEL).toMatch(/impossible/i);
  });

  it("TTS non perturbée : le bloc de code reste SILENCIEUX (ni contenu, ni libellé)", () => {
    const md = "```\nsecret brut 42\n```\n";
    const said = spoken(md);
    expect(said).not.toContain("secret brut 42");
    expect(said).not.toContain("Copier");
    expect(said).not.toContain("Copié");
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

describe("constructs NON FERMÉS / malformés — jamais de contenu avalé", () => {
  const CASES: Array<{ name: string; markdown: string; type: string; payload: string }> = [
    {
      name: "fence ``` non fermée",
      markdown: "Voici :\n```python\nprint('bonjour')\n",
      type: "code",
      payload: "print('bonjour')",
    },
    {
      name: "fence ~~~ non fermée",
      markdown: "~~~\ndu code ici\n",
      type: "code",
      payload: "du code ici",
    },
    {
      name: "bloc muet non fermé",
      markdown: "Intro.\n```muet\ndonnees brutes 42\n",
      type: "mute",
      payload: "donnees brutes 42",
    },
    {
      name: "fence avec espaces en fin de ligne",
      markdown: "```js   \nconst y = 2;\n```   \nFin.",
      type: "code",
      payload: "const y = 2;",
    },
    {
      name: "info-string inattendue",
      markdown: "```weird-info x y\npayload spécial\n```\n",
      type: "code",
      payload: "payload spécial",
    },
    {
      name: "tableau incomplet (touche la fin du flux)",
      markdown: "| A | B |\n| --- | --- |\n| 1 | 2 |",
      type: "table",
      payload: "1",
    },
  ];

  for (const testCase of CASES) {
    it(`${testCase.name} : résolu en fin de flux, contenu présent (jamais avalé)`, () => {
      const blocks = finalBlocks(testCase.markdown);
      expect(blocks.some((b) => b.type === testCase.type)).toBe(true);
      expect(displayModelText(blocks)).toContain(testCase.payload);
    });
  }

  it("un flux incrémental ne perd AUCUN caractère (fence non fermée comprise)", () => {
    const markdown = "Début.\n\n```python\nprint('x')\nconsole.log('y')\n";
    let source = "";
    let from = 0;
    const rendered: string[] = [];
    for (let i = 0; i < markdown.length; i += 5) {
      source += markdown.slice(i, i + 5);
      const { blocks, tail } = parseBlocks(source, false, from);
      for (const b of blocks as UiBlock[]) rendered.push(displayModelText([b]));
      rendered.push(tail);
      from = tail.length > 0 ? source.length - tail.length : source.length;
    }
    const { blocks } = parseBlocks(source, true, from);
    for (const b of blocks as UiBlock[]) rendered.push(displayModelText([b]));
    const joined = rendered.join("\n");
    expect(joined).toContain("Début.");
    expect(joined).toContain("print('x')");
    expect(joined).toContain("console.log('y')");
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

  it("le bouton « copier » n'emploie ni onclick ni style inline (CSP stricte)", () => {
    const source = readFileSync(join(process.cwd(), "public/ui/markdown.js"), "utf8");
    // Aucun gestionnaire en ligne ni style posé via attribut/JSOM.
    expect(source).not.toMatch(/onclick\s*=/i);
    expect(source).not.toContain(".style.");
    expect(source).not.toContain('setAttribute("style"');
    // L'icône vient de la brique holaf-icons (jamais un SVG dessiné en dur).
    expect(source).toContain("HolafIcons");
    expect(source).not.toContain("<svg");
    expect(source).toContain("DOMParser");
    // Le clic est câblé par addEventListener (jamais `onclick`).
    expect(source).toContain('addEventListener("click"');
  });
});
