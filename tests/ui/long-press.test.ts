/**
 * APPUI LONG (tactile) — logique RÉELLE du module, sur un élément factice.
 *
 * L'appui long est le SEUL moyen d'ouvrir le menu du titre (conversations) et
 * le menu de niveau (agents) sur un téléphone : s'il se déclenchait au mauvais
 * moment (défilement, souris) ou laissait passer le clic suivant, il changerait
 * de conversation ou basculerait un agent par accident. Ces tests verrouillent
 * les trois propriétés qui l'empêchent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  attachLongPress,
  LONG_PRESS_CLICK_GUARD_MS,
  LONG_PRESS_MS,
  LONG_PRESS_MOVE_PX,
} from "../../public/ui/long-press.js";

type Handler = (event: Record<string, unknown>) => void;

/** Document factice : suffisant pour un écouteur de capture one-shot. */
class FakeDoc {
  listeners = new Map<string, Handler[]>();

  addEventListener(type: string, fn: Handler): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, fn: Handler): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((candidate) => candidate !== fn),
    );
  }

  /** Émet un événement sur le document (phase de capture). */
  emit(type: string, event: Record<string, unknown> = {}): Record<string, unknown>[] {
    const results: Record<string, unknown>[] = [];
    for (const fn of this.listeners.get(type) ?? []) {
      const payload = {
        type,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        stopImmediatePropagation: vi.fn(),
        ...event,
      };
      fn(payload);
      results.push(payload);
    }
    return results;
  }
}

/** Élément factice : enregistre et émet des écouteurs DOM. */
class FakeTarget {
  listeners = new Map<string, Handler[]>();

  constructor(public ownerDocument: FakeDoc) {}

  addEventListener(type: string, fn: Handler): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, fn: Handler): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((candidate) => candidate !== fn),
    );
  }

  emit(type: string, event: Record<string, unknown> = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ type, ...event });
  }
}

describe("attachLongPress — appui long tactile", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    const doc = new FakeDoc();
    const element = new FakeTarget(doc);
    const onLongPress = vi.fn();
    const detach = attachLongPress(
      element as unknown as Parameters<typeof attachLongPress>[0],
      onLongPress,
    );
    return { doc, element, onLongPress, detach };
  }

  it("un appui tactile de 500 ms déclenche UNE fois, avec le point de départ", () => {
    const { element, onLongPress } = setup();
    element.emit("pointerdown", { pointerType: "touch", clientX: 42, clientY: 84 });
    vi.advanceTimersByTime(LONG_PRESS_MS - 1);
    expect(onLongPress).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onLongPress).toHaveBeenCalledWith({ x: 42, y: 84 });
  });

  it("la SOURIS est ignorée : le clic droit reste le déclencheur du bureau", () => {
    const { element, onLongPress } = setup();
    element.emit("pointerdown", { pointerType: "mouse", button: 0, clientX: 10, clientY: 10 });
    vi.advanceTimersByTime(LONG_PRESS_MS * 3);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("un relâchement avant le seuil n'ouvre rien", () => {
    const { element, onLongPress } = setup();
    element.emit("pointerdown", { pointerType: "touch", clientX: 5, clientY: 5 });
    vi.advanceTimersByTime(LONG_PRESS_MS - 50);
    element.emit("pointerup", { pointerType: "touch" });
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("un DÉFILEMENT (déplacement > seuil) annule l'appui long", () => {
    const { element, onLongPress } = setup();
    element.emit("pointerdown", { pointerType: "touch", clientX: 5, clientY: 5 });
    element.emit("pointermove", {
      pointerType: "touch",
      clientX: 5,
      clientY: 5 + LONG_PRESS_MOVE_PX + 1,
    });
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("le clic qui SUIT un appui long est absorbé (avant tout écouteur d'élément)", () => {
    const { doc, element, onLongPress } = setup();
    element.emit("pointerdown", { pointerType: "touch", clientX: 1, clientY: 1 });
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    // Clic de relâchement : il est intercepté en CAPTURE sur le document.
    const events = doc.emit("click");
    expect(events).toHaveLength(1);
    expect(events[0].preventDefault).toHaveBeenCalled();
    expect(events[0].stopImmediatePropagation).toHaveBeenCalled();
    // One-shot : un vrai clic ULTÉRIEUR n'est plus absorbé.
    expect(doc.emit("click")).toHaveLength(0);
  });

  it("filet de sécurité : sans clic, l'absorption expire (aucun clic avalé plus tard)", () => {
    const { doc, element } = setup();
    element.emit("pointerdown", { pointerType: "touch", clientX: 1, clientY: 1 });
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(doc.listeners.get("click") ?? []).toHaveLength(1);
    vi.advanceTimersByTime(LONG_PRESS_CLICK_GUARD_MS);
    expect(doc.listeners.get("click") ?? []).toHaveLength(0);
  });

  it("le désarmement retire les écouteurs et le minuteur", () => {
    const { element, onLongPress, detach } = setup();
    detach();
    element.emit("pointerdown", { pointerType: "touch", clientX: 1, clientY: 1 });
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("tolère un élément absent (aucune exception)", () => {
    expect(() =>
      attachLongPress(
        undefined as unknown as Parameters<typeof attachLongPress>[0],
        () => undefined,
      ),
    ).not.toThrow();
  });
});
