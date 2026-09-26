/**
 * Rendu markdown incrémental du chat (volet 3 — UI vanilla, sans build).
 *
 * ─── Règles fondatrices ────────────────────────────────────────────────────
 *  1. **AUCUNE injection de HTML.** Tous les nœuds sont construits
 *     programmatiquement (`document.createElement` + `textContent`). On
 *     n'appelle JAMAIS `innerHTML` avec du contenu dérivé du modèle : c'est la
 *     garantie anti-injection, et la seule voie compatible avec la CSP
 *     (`script-src 'self'` interdit les gestionnaires en ligne, `style-src
 *     'self'` interdit les styles en ligne). Un construct impossible à rendre
 *     proprement sans casser la CSP n'est PAS forcé.
 *  2. **Rendu par blocs STABILISÉS.** On ne rend qu'un bloc *complet* ; tant
 *     qu'un bloc est incomplet (fence non fermée, tableau en cours, liste en
 *     cours de frappe, lien incomplet), il reste affiché en **texte brut
 *     temporaire** (`.md-tail`). C'est le même problème que le filtre serveur
 *     (`src/tts/markdown.ts` retient les fragments non résolus) ; le client le
 *     résout ici, de façon indépendante.
 *  3. **Couleurs de thème uniquement**, aucun style en ligne.
 *
 * ─── Convention du bloc muet (miroir du serveur) ───────────────────────────
 * Le bloc muet est défini UNE fois côté serveur (`src/tts/mute.ts`) et le
 * client ne peut pas importer du TS : ce module en est le **miroir JS**, comme
 * `public/ui/tts-frames.js` miroite `src/tts/framing.ts`. Un test de
 * synchronisation (`tests/ui/chat-markdown.test.ts`) garantit la non-divergence.
 * ⚠️ Toute modification de `MUTE_BLOCK_LABELS` doit être répercutée ici.
 *
 * ─── Modèle d'analyse ──────────────────────────────────────────────────────
 * `parseBlocks(text, final, from)` découpe un texte en une suite de blocs
 * typés. Il est **pur** (testable sans DOM). Les fonctions de rendu
 * (`renderBlock`, `renderInline`, `createMarkdownRenderer`) utilisent le DOM.
 */

/* ─────────────────────────── Convention muette (miroir) ─────────────────── */

/** Étiquettes d'info-string reconnues comme muettes (miroir de `mute.ts`). */
export const MUTE_BLOCK_LABELS = ["muet"];

/** Étiquette canonique (français). */
export const MUTE_BLOCK_LABEL = MUTE_BLOCK_LABELS[0];

/**
 * `true` si l'info-string d'un bloc de code désigne un bloc muet (premier mot,
 * casse ignorée). Miroir exact de `isMuteInfoString` serveur.
 *
 * @param {string} info
 * @returns {boolean}
 */
export function isMuteInfoString(info) {
  const first = String(info ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return first.length > 0 && MUTE_BLOCK_LABELS.includes(first);
}

/* ─────────────────────────── Analyse des blocs (pure) ───────────────────── */

/** Une ligne est « vide » si elle ne contient que des blancs. */
function isBlank(line) {
  return line.trim().length === 0;
}

/** Détecte une fence de code (``` ou ~~~), avec son info-string. */
function readFence(line) {
  const t = line.trim();
  const m = /^(`{3,}|~{3,})/.exec(t);
  if (!m) return null;
  const seq = m[1];
  return { char: seq[0], count: seq.length, info: t.slice(seq.length).trim() };
}

/** `true` si la ligne clôt une fence ouverte avec `char` (au moins `min`). */
function isClosingFence(line, char, min) {
  const t = line.trim();
  if (t.length === 0 || t.length < min) return false;
  for (const c of t) {
    if (c !== char) return false;
  }
  return true;
}

/**
 * `true` si la ligne est une séparatrice de tableau markdown (tirets,
 * deux-points, pipes, blancs ; au moins un tiret). Miroir de `isTableSeparator`
 * serveur — elle ne sert qu'à confirmer qu'une ligne contenant `|` ouvre un
 * tableau.
 */
export function isTableSeparator(line) {
  const t = line.trim();
  if (t.length === 0) return false;
  let dashes = 0;
  for (const c of t) {
    if (c === "-") dashes += 1;
    else if (c === ":" || c === "|" || c === " " || c === "\t") continue;
    else return false;
  }
  return dashes > 0;
}

/** Classifie une ligne en tête de bloc. */
function classify(line) {
  if (isBlank(line)) return { kind: "blank" };
  if (readFence(line)) return { kind: "fence" };

  const heading = /^(#{1,6})(?:\s|$)/.exec(line.trimStart());
  if (heading) {
    const trimmed = line.trimStart();
    return { kind: "heading", level: heading[1].length, text: trimmed.slice(heading[1].length).trim() };
  }

  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return { kind: "hr" };

  const quote = /^\s*>(?:\s?)([\s\S]*)$/.exec(line);
  if (quote) return { kind: "quote", text: quote[1] };

  const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
  if (bullet) return { kind: "bullet", text: bullet[1] };

  const ordered = /^\s*(\d{1,9})[.)]\s+(.*)$/.exec(line);
  if (ordered) return { kind: "ordered", text: ordered[2] };

  if (line.includes("|")) return { kind: "tableRow" };

  return { kind: "text" };
}

/** `true` si la ligne ouvre un nouveau bloc (interrompt un paragraphe). */
function startsNewBlock(c) {
  return (
    c.kind === "fence" ||
    c.kind === "heading" ||
    c.kind === "hr" ||
    c.kind === "quote" ||
    c.kind === "bullet" ||
    c.kind === "ordered"
  );
}

/**
 * Découpe `text` en blocs et renvoie le résidu non résolu.
 *
 * @param {string} text
 * @param {boolean} [final] — fin de flux : tout est résolu (pas de résidu).
 * @param {number} [from] — offset de départ (rendu incrémental : on ne ré-analyse
 *   jamais les blocs déjà émis).
 * @returns {{ blocks: Array<object>, tail: string }}
 */
export function parseBlocks(text, final = false, from = 0) {
  /** Lignes avec leurs offsets absolus et leur état « terminée ». */
  const lines = [];
  {
    let start = Math.max(0, from);
    for (let k = start; k < text.length; k += 1) {
      if (text[k] === "\n") {
        lines.push({ text: text.slice(start, k), start, end: k + 1, terminated: true });
        start = k + 1;
      }
    }
    if (start < text.length) {
      lines.push({ text: text.slice(start), start, end: text.length, terminated: false });
    }
  }

  /** Texte brut des lignes [fromLine, toLine) (sans le dernier `\n`). */
  function sliceLines(fromLine, toLine) {
    if (fromLine >= toLine) return "";
    const start = lines[fromLine].start;
    const end = toLine < lines.length ? lines[toLine].start : text.length;
    let s = text.slice(start, end);
    if (s.endsWith("\n")) s = s.slice(0, -1);
    return s;
  }

  /** La ligne `j` ouvre-t-elle un tableau (ligne `|` + séparatrice) ? */
  function isTableStart(j) {
    if (j + 1 >= lines.length) return false;
    return lines[j].text.includes("|") && isTableSeparator(lines[j + 1].text);
  }

  /** Construit le bloc commençant à `idx`, ou `null` s'il est incomplet. */
  function readBlock(idx) {
    const line = lines[idx];
    const c = classify(line.text);

    // --- Bloc de code / muet ------------------------------------------------
    if (c.kind === "fence") {
      const fence = readFence(line.text);
      let close = -1;
      for (let j = idx + 1; j < lines.length; j += 1) {
        if (isClosingFence(lines[j].text, fence.char, fence.count)) {
          close = j;
          break;
        }
      }
      if (close !== -1) {
        // La fence de clôture doit être une ligne complète (sinon elle pourrait
        // encore grandir, ou ne pas en être une).
        if (!lines[close].terminated && !final) return null;
        const content = sliceLines(idx + 1, close);
        const muted = isMuteInfoString(fence.info);
        return {
          block: muted
            ? { type: "mute", info: fence.info, text: content }
            : { type: "code", info: fence.info, text: content },
          next: close + 1,
        };
      }
      if (!final) return null; // fence non fermée : on attend
      return {
        block: isMuteInfoString(fence.info)
          ? { type: "mute", info: fence.info, text: sliceLines(idx + 1, lines.length) }
          : { type: "code", info: fence.info, text: sliceLines(idx + 1, lines.length) },
        next: lines.length,
      };
    }

    // --- Titre --------------------------------------------------------------
    if (c.kind === "heading") {
      if (!line.terminated && !final) return null;
      return { block: { type: "heading", level: c.level, text: c.text }, next: idx + 1 };
    }

    // --- Règle horizontale --------------------------------------------------
    if (c.kind === "hr") {
      if (!line.terminated && !final) return null;
      return { block: { type: "hr" }, next: idx + 1 };
    }

    // --- Tableau (ligne `|` + séparatrice) ----------------------------------
    if (c.kind === "tableRow" && isTableStart(idx)) {
      let j = idx + 2;
      while (
        j < lines.length &&
        !isBlank(lines[j].text) &&
        lines[j].text.includes("|")
      ) {
        j += 1;
      }
      // Tant que le tableau touche la fin du flux, une ligne peut encore
      // arriver : on attend (sauf en fin de flux).
      if (j >= lines.length && !final) return null;
      return { block: readTable(idx, j), next: j };
    }

    // --- Citation -----------------------------------------------------------
    if (c.kind === "quote") {
      let j = idx;
      while (j < lines.length && classify(lines[j].text).kind === "quote") j += 1;
      if (j >= lines.length && !final) return null;
      const parts = [];
      for (let k = idx; k < j; k += 1) parts.push(classify(lines[k].text).text);
      return { block: { type: "quote", text: parts.join("\n") }, next: j };
    }

    // --- Liste (puces ou numérotée) -----------------------------------------
    if (c.kind === "bullet" || c.kind === "ordered") {
      const ordered = c.kind === "ordered";
      const items = [];
      let j = idx;
      while (j < lines.length) {
        const cj = classify(lines[j].text);
        if (cj.kind !== (ordered ? "ordered" : "bullet")) break;
        items.push(cj.text);
        j += 1;
      }
      if (j >= lines.length && !final) return null;
      return { block: { type: "list", ordered, items }, next: j };
    }

    // --- Paragraphe ---------------------------------------------------------
    let j = idx;
    while (j < lines.length) {
      if (j > idx) {
        const cj = classify(lines[j].text);
        if (cj.kind === "blank" || startsNewBlock(cj) || isTableStart(j)) break;
      }
      j += 1;
    }
    // Un paragraphe n'est stable que lorsqu'une ligne le termine (blanc, autre
    // bloc, ou fin de flux en mode `final`) : sinon la suite appartiendrait au
    // même paragraphe.
    if (j >= lines.length && !final) return null;
    return { block: { type: "paragraph", text: sliceLines(idx, j) }, next: j };
  }

  /** Tableau : en-tête + lignes de corps (séparatrice exclue du rendu). */
  function readTable(idx, end) {
    const cells = (line) => {
      let s = line.trim();
      if (s.startsWith("|")) s = s.slice(1);
      if (s.endsWith("|")) s = s.slice(0, -1);
      return s.split("|").map((cell) => cell.trim());
    };
    const header = cells(lines[idx].text);
    const rows = [];
    for (let j = idx + 2; j < end; j += 1) rows.push(cells(lines[j].text));
    return { type: "table", header, rows };
  }

  const blocks = [];
  let idx = 0;
  while (idx < lines.length) {
    if (isBlank(lines[idx].text)) {
      idx += 1;
      continue;
    }
    const anchor = lines[idx].start;
    const result = readBlock(idx);
    if (result === null) {
      return { blocks, tail: text.slice(anchor) };
    }
    blocks.push(result.block);
    idx = result.next;
  }
  return { blocks, tail: "" };
}

/** Raccourci : blocs stabilisés + résidu d'un texte en cours de flux. */
export function splitStableBlocks(text, from = 0) {
  return parseBlocks(text, false, from);
}

/* ─────────────────────────── Analyse inline (pure) ──────────────────────── */

/** `true` si le point de code est un caractère de mot (pour `_`). */
function isWordChar(ch) {
  return ch !== undefined && /[0-9A-Za-zÀ-ÿ]/.test(ch);
}

/** Lit `[label](href)` à partir de l'index du `[`. `null` si incomplet. */
function matchLink(text, open) {
  const close = text.indexOf("]", open + 1);
  if (close === -1) return null;
  if (text[close + 1] !== "(") return null;
  const closeParen = text.indexOf(")", close + 2);
  if (closeParen === -1) return null;
  const label = text.slice(open + 1, close);
  if (label.includes("\n")) return null;
  const href = text.slice(close + 2, closeParen).trim();
  return { label, href, next: closeParen + 1 };
}

/**
 * Découpe un fragment inline en jetons typés (pur, testable sans DOM).
 *
 * Jetons : `{type:"text", value}` · `{type:"code", value}` ·
 * `{type:"strong"|"em"|"del", children}` · `{type:"link", children, href}` ·
 * `{type:"image", alt, src}`. Un marqueur non fermé reste du texte littéral
 * (repli défensif : jamais de balise cassée).
 *
 * @param {string} text
 * @returns {Array<object>}
 */
export function tokenizeInline(text) {
  const source = String(text ?? "");
  const tokens = [];
  let buffer = "";
  const flush = () => {
    if (buffer.length > 0) {
      tokens.push({ type: "text", value: buffer });
      buffer = "";
    }
  };

  let i = 0;
  while (i < source.length) {
    const ch = source[i];

    // Code inline (pas d'imbrication).
    if (ch === "`") {
      const end = source.indexOf("`", i + 1);
      if (end !== -1) {
        flush();
        tokens.push({ type: "code", value: source.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    // Image ![alt](src).
    if (ch === "!" && source[i + 1] === "[") {
      const parsed = matchLink(source, i + 1);
      if (parsed) {
        flush();
        tokens.push({ type: "image", alt: parsed.label, src: parsed.href });
        i = parsed.next;
        continue;
      }
    }

    // Lien [texte](href).
    if (ch === "[") {
      const parsed = matchLink(source, i);
      if (parsed) {
        flush();
        tokens.push({ type: "link", children: tokenizeInline(parsed.label), href: parsed.href });
        i = parsed.next;
        continue;
      }
    }

    // Gras (** / __) puis barré (~~).
    if ((ch === "*" || ch === "_") && source[i + 1] === ch) {
      const end = source.indexOf(ch + ch, i + 2);
      if (end !== -1 && end > i + 2) {
        flush();
        tokens.push({ type: "strong", children: tokenizeInline(source.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if (ch === "~" && source[i + 1] === "~") {
      const end = source.indexOf("~~", i + 2);
      if (end !== -1 && end > i + 2) {
        flush();
        tokens.push({ type: "del", children: tokenizeInline(source.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }

    // Italique (* / _). Pour `_`, on exige une frontière de mot afin de ne pas
    // casser les identifiants (`snake_case`).
    if (ch === "*" || ch === "_") {
      const boundaryOk =
        ch === "*" || (!isWordChar(source[i - 1]) && !isWordChar(source[i + 1]));
      const end = source.indexOf(ch, i + 1);
      if (boundaryOk && end !== -1 && end > i + 1) {
        flush();
        tokens.push({ type: "em", children: tokenizeInline(source.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }

    buffer += ch;
    i += 1;
  }
  flush();
  return tokens;
}

/* ─────────────────────────── Rendu DOM ───────────────────────────────────── */

/** `true` si `href` est une destination sûre (jamais `javascript:`…). */
export function isSafeLink(href) {
  const h = String(href ?? "").trim();
  if (h.length === 0) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return /^(https?|mailto):/i.test(h);
  return true; // relatif / ancre : même origine
}

/**
 * `true` si `src` peut être chargée par le navigateur SANS violer la CSP
 * (`img-src 'self' data:`). Une URL distante (`http(s)://`, `//hôte`) est
 * refusée : elle déclencherait une violation CSP (et une requête réseau non
 * désirée). Ces images sont alors rendues en **placeholder**.
 */
export function isSafeImageSrc(src) {
  const s = String(src ?? "").trim();
  if (s.length === 0) return false;
  if (s.startsWith("//")) return false; // protocol-relatif = distant
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return /^data:image\//i.test(s);
  return true; // chemin relatif / absolu de même origine
}

/** Construit les nœuds DOM d'une liste de jetons inline. */
function renderInline(tokens, doc) {
  const frag = doc.createDocumentFragment();
  for (const token of tokens) {
    switch (token.type) {
      case "text":
        frag.appendChild(doc.createTextNode(token.value));
        break;
      case "code": {
        const code = doc.createElement("code");
        code.className = "md-code";
        code.textContent = token.value;
        frag.appendChild(code);
        break;
      }
      case "strong": {
        const el = doc.createElement("strong");
        el.appendChild(renderInline(token.children, doc));
        frag.appendChild(el);
        break;
      }
      case "em": {
        const el = doc.createElement("em");
        el.appendChild(renderInline(token.children, doc));
        frag.appendChild(el);
        break;
      }
      case "del": {
        const el = doc.createElement("del");
        el.appendChild(renderInline(token.children, doc));
        frag.appendChild(el);
        break;
      }
      case "link": {
        if (isSafeLink(token.href)) {
          const a = doc.createElement("a");
          a.className = "md-link";
          a.href = token.href;
          a.rel = "noopener noreferrer";
          a.appendChild(renderInline(token.children, doc));
          frag.appendChild(a);
        } else {
          // Destination refusée : le texte reste affiché, jamais de lien piégé.
          frag.appendChild(renderInline(token.children, doc));
        }
        break;
      }
      case "image": {
        frag.appendChild(renderImage(token.alt, token.src, doc));
        break;
      }
      default:
        break;
    }
  }
  return frag;
}

/**
 * Rend une image. Une source autorisée par la CSP devient un vrai `<img>` ;
 * sinon un **placeholder** accessible (rôle `img`, `aria-label`) qui affiche le
 * texte alternatif — jamais de requête vers un domaine externe (CSP `img-src`).
 */
function renderImage(alt, src, doc) {
  const label = String(alt ?? "").trim();
  if (isSafeImageSrc(src)) {
    const img = doc.createElement("img");
    img.className = "md-image";
    img.src = src;
    img.alt = label;
    img.loading = "lazy";
    return img;
  }
  const span = doc.createElement("span");
  span.className = "md-image md-image--placeholder";
  span.setAttribute("role", "img");
  span.setAttribute("aria-label", label.length > 0 ? `Image : ${label}` : "Image");
  span.textContent = label.length > 0 ? `image : ${label}` : "image";
  return span;
}

/**
 * Construit le nœud DOM d'un bloc.
 *
 * @param {object} block
 * @param {Document} doc
 * @returns {Node}
 */
export function renderBlock(block, doc = document) {
  switch (block.type) {
    case "heading": {
      const level = Math.min(6, Math.max(1, block.level));
      const el = doc.createElement(`h${level}`);
      el.className = "md-heading";
      el.appendChild(renderInline(tokenizeInline(block.text), doc));
      return el;
    }
    case "paragraph": {
      const p = doc.createElement("p");
      p.className = "md-paragraph";
      p.appendChild(renderInline(tokenizeInline(block.text), doc));
      return p;
    }
    case "list": {
      const list = doc.createElement(block.ordered ? "ol" : "ul");
      list.className = "md-list";
      for (const item of block.items) {
        const li = doc.createElement("li");
        li.appendChild(renderInline(tokenizeInline(item), doc));
        list.appendChild(li);
      }
      return list;
    }
    case "quote": {
      const quote = doc.createElement("blockquote");
      quote.className = "md-quote";
      quote.appendChild(renderInline(tokenizeInline(block.text), doc));
      return quote;
    }
    case "code":
      return renderCode(block.text, block.info, false, doc);
    case "mute":
      return renderCode(block.text, block.info, true, doc);
    case "table": {
      const table = doc.createElement("table");
      table.className = "md-table";
      const thead = doc.createElement("thead");
      const headRow = doc.createElement("tr");
      for (const cell of block.header) {
        const th = doc.createElement("th");
        th.appendChild(renderInline(tokenizeInline(cell), doc));
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      table.appendChild(thead);
      const tbody = doc.createElement("tbody");
      for (const row of block.rows) {
        const tr = doc.createElement("tr");
        for (const cell of row) {
          const td = doc.createElement("td");
          td.appendChild(renderInline(tokenizeInline(cell), doc));
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      return table;
    }
    case "hr":
      return doc.createElement("hr");
    default: {
      const p = doc.createElement("p");
      p.className = "md-paragraph";
      p.textContent = String(block.text ?? "");
      return p;
    }
  }
}

/**
 * Rend un bloc de code. Un bloc **muet** est affiché avec une marque DISCRÈTE
 * indiquant qu'il n'est pas lu à voix haute (règle fondatrice : le visuel est
 * muet mais affiché) ; il reste un `<pre><code>` à l'écran.
 */
function renderCode(text, info, muted, doc) {
  const wrapper = doc.createElement("div");
  wrapper.className = muted ? "md-code-block md-code-block--mute" : "md-code-block";

  if (muted) {
    const badge = doc.createElement("span");
    badge.className = "md-mute-badge";
    badge.textContent = "muet — non lu";
    badge.setAttribute("aria-label", "Bloc non lu à voix haute");
    wrapper.appendChild(badge);
  }

  const pre = doc.createElement("pre");
  const code = doc.createElement("code");
  const language = String(info ?? "").trim().split(/\s+/)[0] ?? "";
  if (language.length > 0) code.className = `language-${language}`;
  code.textContent = text;
  pre.appendChild(code);
  wrapper.appendChild(pre);
  return wrapper;
}

/**
 * Rendu incrémental d'un message assistant.
 *
 * `push(delta)` ajoute du texte et n'émet que les **nouveaux blocs stabilisés** :
 * le coût par delta est borné au seul bloc en cours (jamais un re-parse complet
 * de la réponse, donc pas de O(n²)). Le résidu instable est affiché tel quel
 * dans `.md-tail` (texte brut temporaire).
 *
 * @returns {{ element: HTMLDivElement, push: (d: string) => void, flush: () => void,
 *            setText: (t: string) => void, text: () => string }}
 */
export function createMarkdownRenderer() {
  const element = document.createElement("div");
  element.className = "message__body markdown";

  let source = "";
  let scanFrom = 0;
  /** @type {HTMLElement | null} */
  let tailEl = null;

  function appendBlock(block) {
    const node = renderBlock(block, document);
    if (tailEl) element.insertBefore(node, tailEl);
    else element.appendChild(node);
  }

  function renderTail(tail) {
    if (tail.length === 0) {
      if (tailEl) {
        tailEl.remove();
        tailEl = null;
      }
      return;
    }
    if (!tailEl) {
      tailEl = document.createElement("div");
      tailEl.className = "md-tail";
      element.appendChild(tailEl);
    }
    tailEl.textContent = tail;
  }

  return {
    element,
    push(delta) {
      if (delta) source += delta;
      // `parseBlocks` ne repart que du résidu : les blocs renvoyés sont donc
      // TOUS nouveaux (jamais de re-parse des blocs déjà affichés).
      const { blocks, tail } = parseBlocks(source, false, scanFrom);
      for (const block of blocks) appendBlock(block);
      // Le prochain scan repart du résidu (ancre du bloc incomplet).
      scanFrom = tail.length > 0 ? source.length - tail.length : source.length;
      renderTail(tail);
    },
    flush() {
      const { blocks } = parseBlocks(source, true, scanFrom);
      for (const block of blocks) appendBlock(block);
      scanFrom = source.length;
      renderTail("");
    },
    setText(text) {
      source = String(text ?? "");
      scanFrom = 0;
      tailEl = null;
      element.textContent = "";
      const { blocks } = parseBlocks(source, true);
      for (const block of blocks) appendBlock(block);
      scanFrom = source.length;
    },
    text() {
      return source;
    },
  };
}
