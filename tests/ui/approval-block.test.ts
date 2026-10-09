/**
 * Bloc de validation humaine (D118) — logique PURE, VISIBILITÉ et garde-fous
 * STATIQUES de la source (rendu DOM, aucune `innerHTML`, aucun `style=`, CSP).
 *
 * ⚠️ DEUX défauts corrigés ici (usage réel) :
 *  1. le bloc pouvait apparaître SOUS la ligne de flottaison (jamais vu ⇒
 *     demande perdue) → on défile s'il était déjà en bas, sinon on affiche un
 *     indicateur cliquable ;
 *  2. le compte à rebours comparait l'horodatage SERVEUR à l'horloge CLIENTE
 *     (une horloge en avance faisait disparaître le bloc) → on compte une
 *     DURÉE (`ttlSeconds`) à partir de la réception.
 *
 * Le rendu/interaction RÉELS (viewport, CSP) sont mesurés en E2E (Chromium
 * headless + CDP) ; ici on teste la LOGIQUE avec un DOM minimal simulé.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createApprovalBlocks,
  formatRemaining,
  isExpired,
  localDeadline,
  machineLabel,
  remainingMs,
} from "../../public/ui/approval-block.js";

/* ─── DOM minimal (aucune dépendance) : assez pour exercer `show`/`reveal` ── */
class FakeNode {
  children: FakeNode[] = [];
  className = "";
  textContent = "";
  disabled = false;
  hidden = false;
  private readonly attrs = new Map<string, string>();
  private readonly listeners = new Map<string, Array<() => void>>();
  parent: FakeNode | null = null;

  constructor(readonly tag: string) {}

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
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

  addEventListener(type: string, fn: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  click(): void {
    for (const fn of this.listeners.get("click") ?? []) fn();
  }

  querySelector(selector: string): FakeNode | null {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }

  private matches(selector: string): boolean {
    if (selector.startsWith(".")) return this.className.split(/\s+/).includes(selector.slice(1));
    return this.tag === selector;
  }
}

beforeEach(() => {
  (globalThis as unknown as { Node: unknown }).Node = FakeNode;
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeNode(tag),
    createTextNode: (text: string) => {
      const node = new FakeNode("#text");
      node.textContent = String(text);
      return node;
    },
  };
});

afterEach(() => {
  vi.useRealTimers();
});

/** Crée un gestionnaire de blocs câblé sur un conteneur simulé. */
function setup(options: {
  pinned?: boolean;
  now?: () => number;
} = {}) {
  const container = new FakeNode("main");
  const calls = { scrollToEnd: 0, attention: [] as boolean[] };
  const blocks = createApprovalBlocks({
    container: container as unknown as never,
    onDecide: () => undefined,
    now: options.now,
    isPinned: () => options.pinned ?? true,
    scrollToEnd: () => {
      calls.scrollToEnd += 1;
    },
    onAttention: (active: boolean) => {
      calls.attention.push(active);
    },
  });
  return { container, blocks, calls };
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

describe("expiration — jamais de clic dans le vide", () => {
  it("détecte l'échéance (échéance illisible ⇒ expiré)", () => {
    const now = 1_000_000;
    expect(isExpired(now + 1000, now)).toBe(false);
    expect(isExpired(now - 1, now)).toBe(true);
    expect(isExpired(Number.NaN, now)).toBe(true);
  });

  it("borne le temps restant à ≥ 0", () => {
    const now = 1_000_000;
    expect(remainingMs(now + 5000, now)).toBe(5000);
    expect(remainingMs(now - 5000, now)).toBe(0);
    expect(remainingMs(Number.NaN, now)).toBe(0);
  });

  it("formate le compte à rebours en français", () => {
    expect(formatRemaining(42_000)).toBe("42 s");
    expect(formatRemaining(0)).toBe("0 s");
    expect(formatRemaining(4 * 60_000 + 32_000)).toBe("4 min 32 s");
    expect(formatRemaining(60_000)).toBe("1 min 00 s");
  });
});

/* ══════════════ Candidat 2 : expiration insensible au décalage d'horloge ═══ */
describe("expiration insensible au décalage d'horloge CLIENTE", () => {
  it("l'échéance est une DURÉE comptée depuis la RÉCEPTION (pas une date serveur)", () => {
    const receivedAt = 2_000_000;
    expect(localDeadline(300, receivedAt)).toBe(receivedAt + 300_000);
    // Durée illisible ⇒ échéance passée (bloc retiré, jamais trompeur).
    expect(Number.isNaN(localDeadline(undefined, receivedAt))).toBe(true);
    expect(isExpired(localDeadline(undefined, receivedAt), receivedAt)).toBe(true);
  });

  it("une horloge cliente en avance de 10 min NE fait PAS expirer la demande", () => {
    const serverNow = Date.now();
    const clientSkew = 10 * 60_000; // horloge du navigateur en AVANCE
    const receivedAt = serverNow + clientSkew;
    const deadline = localDeadline(300, receivedAt);
    expect(isExpired(deadline, receivedAt)).toBe(false);
    expect(remainingMs(deadline, receivedAt)).toBe(300_000);
    // Contraste : l'ANCIEN calcul (date serveur ≤ horloge cliente) aurait conclu
    // à l'expiration immédiate — c'est exactement le défaut corrigé.
    const oldServerDeadline = serverNow + 300_000;
    expect(oldServerDeadline <= receivedAt).toBe(true);
  });

  it("le bloc RESTE affiché après show() malgré une horloge en avance de 10 min", () => {
    const clientNow = Date.now() + 10 * 60_000;
    const { container, blocks } = setup({ now: () => clientNow });
    blocks.show(approval({ id: "skew", ttlSeconds: 300 }));
    expect(container.children.length).toBe(1);
    const expiry = container.children[0].querySelector(".approval__expiry");
    expect(expiry?.textContent).toMatch(/Expire dans 5 min/);
    blocks.reset();
  });
});

/* ══════════════════ Candidat 1 : le bloc doit être VU ═══════════════════════ */
describe("le bloc de validation doit être VU (demande d'ACTION)", () => {
  it("utilisateur déjà en bas : défile jusqu'au bloc, AUCUN indicateur", () => {
    const { container, blocks, calls } = setup({ pinned: true });
    blocks.show(approval({ id: "a1" }));
    expect(calls.scrollToEnd).toBe(1);
    expect(calls.attention).toEqual([]);
    expect(container.children.length).toBe(1);
    blocks.reset();
  });

  it("utilisateur remonté dans le fil : NE déplace PAS la vue, mais SIGNALE la demande", () => {
    const { container, blocks, calls } = setup({ pinned: false });
    blocks.show(approval({ id: "a2" }));
    expect(calls.scrollToEnd).toBe(0);
    expect(calls.attention).toEqual([true]);
    expect(container.children.length).toBe(1);
    blocks.reset();
  });

  it("l'indicateur ramène sur le bloc puis disparaît (reveal)", () => {
    const { blocks, calls } = setup({ pinned: false });
    blocks.show(approval({ id: "a3" }));
    blocks.reveal();
    expect(calls.scrollToEnd).toBe(1);
    expect(calls.attention).toEqual([true, false]);
    blocks.reset();
  });

  it("l'indicateur se retire aussi quand l'utilisateur revoit la demande (acknowledge)", () => {
    const { blocks, calls } = setup({ pinned: false });
    blocks.show(approval({ id: "a4" }));
    blocks.acknowledge();
    expect(calls.attention).toEqual([true, false]);
    blocks.reset();
  });

  it("à l'expiration le bloc disparaît et l'indicateur est retiré", () => {
    vi.useFakeTimers();
    let t = 1_000_000;
    const { container, blocks, calls } = setup({ pinned: false, now: () => t });
    blocks.show(approval({ id: "a5", ttlSeconds: 30 }));
    expect(calls.attention).toEqual([true]);
    t += 31_000;
    vi.advanceTimersByTime(1000);
    expect(container.children.length).toBe(0);
    expect(calls.attention).toEqual([true, false]);
  });
});

describe("identité machine — nom + identifiant", () => {
  it("privilégie le nom lisible, replie sur l'identifiant", () => {
    expect(machineLabel({ agentId: "a1", agentName: "nuc00" })).toBe("nuc00");
    expect(machineLabel({ agentId: "a1", agentName: "  " })).toBe("a1");
    expect(machineLabel({ agentId: "a1" })).toBe("a1");
  });
});

describe("garde-fous statiques de approval-block.js (CSP + robustesse horloge)", () => {
  const source = readFileSync(join(process.cwd(), "public", "ui", "approval-block.js"), "utf8");

  it("construit le DOM sans injection HTML directe ni style en ligne", () => {
    expect(source).not.toContain("innerHTML");
    expect(source).not.toContain("style=");
    expect(source).toContain("createElement");
  });

  it("propose Valider et Refuser et mentionne l'expiration", () => {
    expect(source).toContain("Valider");
    expect(source).toContain("Refuser");
    expect(source).toContain("passé ce délai");
  });

  it("compte une DURÉE et ne compare JAMAIS l'horodatage serveur à l'horloge cliente", () => {
    expect(source).toContain("ttlSeconds");
    expect(source).toContain("localDeadline");
    // L'ancien défaut : parser/compare la date serveur (`Date.parse`).
    expect(source).not.toContain("Date.parse");
  });

  it("rappelle que le bloc/résultat n'entre pas dans l'historique", () => {
    expect(source).toContain("pas conservé dans l'historique");
  });
});
