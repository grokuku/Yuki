/**
 * Fenêtre FLOTTANTE de validation humaine (D118) — logique PURE, interaction et
 * garde-fous STATIQUES de la source.
 *
 * ⚠️ La demande REMPLACE le bloc qui vivait dans le fil : elle s'affiche
 * AU-DESSUS de l'interface, NON bloquante (aucun voile), DÉPLAÇABLE, ne se ferme
 * PAS au clic à côté, et reste jusqu'à décision ou expiration.
 *
 * ⚠️ Compte à rebours : une DURÉE (`ttlSeconds`) comptée depuis la RÉCEPTION,
 * jamais l'horodatage serveur comparé à l'horloge du poste (une horloge cliente
 * en avance ne doit PAS faire disparaître la fenêtre).
 *
 * Le rendu/interaction RÉELS (géométrie, CSP) sont mesurés en E2E (Chromium
 * headless + CDP) ; ici on teste la LOGIQUE avec un DOM minimal simulé.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createApprovalLayer,
  formatRemaining,
  isExpired,
  localDeadline,
  machineLabel,
  remainingMs,
} from "../../public/ui/approval-window.js";

/* ─── DOM minimal (aucune dépendance) : assez pour la fenêtre + le drag ───── */
class FakeNode {
  children: FakeNode[] = [];
  className = "";
  textContent = "";
  disabled = false;
  hidden = false;
  style: Record<string, string> = {};
  offsetWidth = 380;
  offsetHeight = 220;
  parent: FakeNode | null = null;
  private readonly attrs = new Map<string, string>();
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(readonly tag: string) {}

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }

  append(...nodes: FakeNode[]): void {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }

  appendChild(node: FakeNode): void {
    this.append(node);
  }

  remove(): void {
    if (!this.parent) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = null;
  }

  addEventListener(type: string, fn: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, fn: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    const index = list.indexOf(fn);
    if (index >= 0) list.splice(index, 1);
  }

  dispatch(type: string, event: Record<string, unknown> = {}): void {
    const payload = { target: this, preventDefault: () => undefined, ...event };
    for (const fn of this.listeners.get(type) ?? []) fn(payload);
  }

  click(): void {
    this.dispatch("click");
  }

  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return {
      left: Number.parseFloat(this.style.left ?? "0") || 0,
      top: Number.parseFloat(this.style.top ?? "0") || 0,
      width: this.offsetWidth,
      height: this.offsetHeight,
    };
  }

  matches(selector: string): boolean {
    return selector.split(",").some((part) => {
      const s = part.trim();
      if (s.startsWith(".")) return this.className.split(/\s+/).includes(s.slice(1));
      return this.tag === s;
    });
  }

  closest(selector: string): FakeNode | null {
    let node: FakeNode | null = this;
    while (node) {
      if (node.matches(selector)) return node;
      node = node.parent;
    }
    return null;
  }

  querySelector(selector: string): FakeNode | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeNode[] {
    const found: FakeNode[] = [];
    for (const child of this.children) {
      if (child.matches(selector)) found.push(child);
      found.push(...child.querySelectorAll(selector));
    }
    return found;
  }
}

class FakeDocument {
  readonly body = new FakeNode("body");
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  createElement(tag: string): FakeNode {
    return new FakeNode(tag);
  }

  createTextNode(text: string): FakeNode {
    const node = new FakeNode("#text");
    node.textContent = String(text);
    return node;
  }

  addEventListener(type: string, fn: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, fn: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    const index = list.indexOf(fn);
    if (index >= 0) list.splice(index, 1);
  }

  dispatch(type: string, event: Record<string, unknown> = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ preventDefault: () => undefined, ...event });
  }
}

let doc: FakeDocument;

beforeEach(() => {
  doc = new FakeDocument();
  (globalThis as unknown as { Node: unknown }).Node = FakeNode;
  (globalThis as unknown as { document: unknown }).document = doc;
});

afterEach(() => {
  vi.useRealTimers();
});

/** Store de position simulé (localStorage indisponible en environnement node). */
function fakeStore() {
  const values = new Map<string, string>();
  return {
    values,
    get: (key: string) => values.get(key) ?? null,
    set: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

function setup(options: { now?: () => number } = {}) {
  const store = fakeStore();
  const decisions: Array<{ id: string; decision: string }> = [];
  const layer = createApprovalLayer({
    onDecide: (id: string, decision: string) => decisions.push({ id, decision }),
    now: options.now,
    doc: doc as unknown as never,
    win: { innerWidth: 1600, innerHeight: 1000 } as unknown as never,
    store,
  });
  return { layer, store, decisions };
}

/** Texte AGRÉGÉ d'un sous-arbre (le DOM simulé n'agrège pas `textContent`). */
function textOf(node: FakeNode): string {
  return node.children.map((child) => `${child.textContent}${textOf(child)}`).join("");
}

function approval(overrides: Record<string, unknown> = {}) {
  return {
    id: "ap-1",
    agentId: "agent-1",
    agentName: "nuc00",
    command: "rm -rf /srv/cache",
    destructive: true,
    destructiveIds: ["rm"],
    destructiveReasons: ["suppression (rm)"],
    ttlSeconds: 300,
    ...overrides,
  };
}

const windows = () => doc.body.querySelectorAll(".approval-window");

describe("expiration — jamais de clic dans le vide", () => {
  it("détecte l'échéance (échéance illisible ⇒ expiré)", () => {
    const now = 1_000_000;
    expect(isExpired(now + 1000, now)).toBe(false);
    expect(isExpired(now - 1, now)).toBe(true);
    expect(isExpired(Number.NaN, now)).toBe(true);
  });

  it("borne le temps restant à ≥ 0 et formate en français", () => {
    expect(remainingMs(1_000_000 + 5000, 1_000_000)).toBe(5000);
    expect(remainingMs(Number.NaN, 0)).toBe(0);
    expect(formatRemaining(42_000)).toBe("42 s");
    expect(formatRemaining(4 * 60_000 + 32_000)).toBe("4 min 32 s");
  });
});

describe("compte à rebours insensible au décalage d'horloge CLIENTE", () => {
  it("l'échéance est une DURÉE comptée depuis la RÉCEPTION (pas une date serveur)", () => {
    const receivedAt = 2_000_000;
    expect(localDeadline(300, receivedAt)).toBe(receivedAt + 300_000);
    expect(Number.isNaN(localDeadline(undefined, receivedAt))).toBe(true);
  });

  it("une horloge cliente en avance de 10 min NE fait PAS expirer la fenêtre", () => {
    vi.useFakeTimers();
    // Horloge du navigateur en AVANCE de 10 min par rapport au serveur.
    let t = Date.now() + 10 * 60_000;
    const { layer } = setup({ now: () => t });
    layer.show(approval({ id: "skew" }));
    expect(windows().length).toBe(1);
    const expiry = windows()[0].querySelector(".approval__expiry");
    expect(expiry?.textContent).toMatch(/Expire dans 5 min/);
    t += 1_500; // une seconde et demie plus tard, toujours en avance
    vi.advanceTimersByTime(1000);
    expect(windows().length).toBe(1);
    layer.reset();
  });
});

describe("fenêtre flottante — non bloquante, déplaçable, non fermable au clic à côté", () => {
  it("s'affiche AU-DESSUS de l'interface (couche dédiée montée sur body) et NON bloquante", () => {
    const { layer } = setup();
    layer.show(approval({ id: "a1" }));
    expect(doc.body.children[0]).toBe(layer.element as unknown as FakeNode);
    expect((layer.element as unknown as { className: string }).className).toBe("approval-layer");
    // La couche elle-même n'a AUCUN écouteur de clic : rien à fermer à côté.
    expect(doc.body.querySelector(".approval-layer")).not.toBeNull();
    layer.reset();
  });

  it("ne se ferme PAS si on clique à côté (aucun écouteur extérieur)", () => {
    const { layer } = setup();
    layer.show(approval({ id: "a2" }));
    // Clics à l'extérieur (document + corps de page) : la fenêtre doit rester.
    doc.dispatch("mousedown", { clientX: 5, clientY: 5 });
    doc.dispatch("click", { clientX: 5, clientY: 5 });
    doc.body.dispatch("click", { clientX: 5, clientY: 5 });
    expect(windows().length).toBe(1);
    layer.reset();
  });

  it("DÉPLACE réellement la fenêtre au glisser (position modifiée, mémorisée)", () => {
    const { layer, store } = setup();
    layer.show(approval({ id: "a3" }));
    const win = windows()[0];
    expect(win.style.left).toBe("1204px"); // 1600 - 380 - 16
    expect(win.style.top).toBe("764px"); // 1000 - 220 - 16
    const bar = win.querySelector(".approval-window__bar");
    expect(bar).not.toBeNull();
    bar?.dispatch("mousedown", { button: 0, clientX: 100, clientY: 100 });
    doc.dispatch("mousemove", { clientX: 50, clientY: 80 });
    expect(win.style.left).toBe("1154px"); // -50
    expect(win.style.top).toBe("744px"); // -20
    doc.dispatch("mouseup", {});
    expect(store.get("yuki.approval.position")).toBe(JSON.stringify({ left: 1154, top: 744 }));
    layer.reset();
  });

  it("déplace aussi au CLAVIER (flèches) — accessibilité", () => {
    const { layer } = setup();
    layer.show(approval({ id: "a4" }));
    const win = windows()[0];
    const bar = win.querySelector(".approval-window__bar");
    bar?.dispatch("keydown", { key: "ArrowLeft" });
    expect(win.style.left).toBe("1188px"); // 1204 - 16
    layer.reset();
  });

  it("contenu COMPLET : machine + id, commande, motif, expiration, Valider/Refuser", () => {
    const { layer, decisions } = setup();
    layer.show(approval({ id: "a5" }));
    const win = windows()[0];
    const text = textOf(win);
    expect(text).toContain("nuc00");
    expect(text).toContain("id agent-1");
    expect(text).toContain("rm -rf /srv/cache");
    expect(text).toContain("suppression (rm)");
    expect(text).toMatch(/Expire dans 5 min/);
    const buttons = win.querySelectorAll(".approval__btn");
    const labels = buttons.map((b) => b.textContent);
    expect(labels).toContain("Valider");
    expect(labels).toContain("Refuser");
    // Valider part bien par la décision.
    buttons.find((b) => b.textContent === "Valider")?.click();
    expect(decisions).toEqual([{ id: "a5", decision: "approve" }]);
    layer.reset();
  });

  it("accessibilité : role=dialog + aria-modal=false (fenêtre NON modale)", () => {
    const { layer } = setup();
    layer.show(approval({ id: "a6" }));
    const win = windows()[0];
    expect(win.getAttribute("role")).toBe("dialog");
    expect(win.getAttribute("aria-modal")).toBe("false");
    layer.reset();
  });

  it("à l'expiration la fenêtre disparaît (compte à rebours jusqu'au bout)", () => {
    vi.useFakeTimers();
    let t = 1_000_000;
    const { layer } = setup({ now: () => t });
    layer.show(approval({ id: "a7", ttlSeconds: 30 }));
    expect(windows().length).toBe(1);
    t += 31_000;
    vi.advanceTimersByTime(1000);
    expect(windows().length).toBe(0);
  });
});

describe("plusieurs demandes en attente — aucune n'écrase l'autre", () => {
  it("une fenêtre DISTINCTE par demande, positions en cascade", () => {
    const { layer } = setup();
    layer.show(approval({ id: "m1", agentId: "a1", agentName: "un" }));
    layer.show(approval({ id: "m2", agentId: "a2", agentName: "deux" }));
    expect(windows().length).toBe(2);
    const ids = windows().map((w) => w.getAttribute("data-approval-id"));
    expect(ids).toEqual(["m1", "m2"]);
    expect(windows()[0].style.left).not.toBe(windows()[1].style.left);
    // La décision d'une seule retire la bonne fenêtre.
    layer.clear("m1");
    expect(windows().length).toBe(1);
    expect(windows()[0].getAttribute("data-approval-id")).toBe("m2");
    layer.reset();
  });

  it("mettre à jour la MÊME demande ne duplique pas la fenêtre", () => {
    const { layer } = setup();
    layer.show(approval({ id: "same" }));
    layer.show(approval({ id: "same", command: "ls" }));
    expect(windows().length).toBe(1);
    expect(textOf(windows()[0])).toContain("ls");
    layer.reset();
  });
});

describe("identité machine — nom + identifiant", () => {
  it("privilégie le nom lisible, replie sur l'identifiant", () => {
    expect(machineLabel({ agentId: "a1", agentName: "nuc00" })).toBe("nuc00");
    expect(machineLabel({ agentId: "a1", agentName: "  " })).toBe("a1");
  });
});

describe("garde-fous statiques (CSP + positionnement par CSSOM)", () => {
  const source = readFileSync(join(process.cwd(), "public", "ui", "approval-window.js"), "utf8");
  const css = readFileSync(join(process.cwd(), "public", "ui", "styles.css"), "utf8");

  it("construit le DOM sans injection HTML directe ni style en ligne", () => {
    expect(source).not.toContain("innerHTML");
    expect(source).not.toContain("style=");
    expect(source).toContain("createElement");
  });

  it("positionne par CSSOM (el.style.left/top), technique du projet", () => {
    expect(source).toContain("el.style.left");
    expect(source).toContain("el.style.top");
    // Le `position: fixed` vit dans la FEUILLE (aucun style en ligne dans le markup).
    expect(css).toMatch(/\.approval-window\s*\{[^}]*position:\s*fixed/);
  });

  it("la couche laisse passer les clics, seule la fenêtre les capte (non bloquant)", () => {
    expect(css).toMatch(/\.approval-layer\s*\{[^}]*pointer-events:\s*none/);
    expect(css).toMatch(/\.approval-window\s*\{[^}]*pointer-events:\s*auto/);
  });

  it("compte une DURÉE et ne compare JAMAIS l'horodatage serveur à l'horloge cliente", () => {
    expect(source).toContain("ttlSeconds");
    expect(source).not.toContain("Date.parse");
  });

  it("rappelle que le résultat n'entre pas dans l'historique", () => {
    expect(source).toContain("pas conservé dans l'historique");
  });
});
