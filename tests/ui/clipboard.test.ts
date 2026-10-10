/**
 * Bouton « copier » — LOGIQUE de presse-papiers (unitaire, sans navigateur).
 *
 * Le PIÈGE de cette fonctionnalité est le presse-papiers : `navigator.clipboard`
 * n'existe QUE dans un contexte sécurisé (HTTPS ou `localhost`). Yuki s'atteint
 * aussi en HTTP simple sur une IP de LAN. Ce test couvre les TROIS cas ET
 * l'échec franc (jamais un bouton qui ne dit rien).
 *
 * Les interactions DOM réelles (clic, presse-papiers RÉEL, position du bouton)
 * sont prouvées par l'E2E Chromium ; ici on épingle la logique de repli avec des
 * dépendances injectées.
 */

import { describe, expect, it, vi } from "vitest";

import { copyText } from "../../public/ui/clipboard.js";

/** Faux `document` minimal : `<textarea>` temporaire + `execCommand`. */
function makeFakeDoc(options: { execResult?: boolean; throwExec?: boolean } = {}) {
  const { execResult = true, throwExec = false } = options;
  const created: any[] = [];
  const body: any = {
    children: [] as any[],
    appendChild(child: any) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    removeChild(child: any) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      child.parentNode = null;
      return child;
    },
  };
  const doc: any = {
    body,
    activeElement: null,
    execCommand(command: string) {
      if (throwExec) throw new Error("execCommand indisponible");
      expect(command).toBe("copy");
      return execResult;
    },
    createElement(tag: string) {
      const area: any = {
        tag,
        className: "",
        value: "",
        parentNode: null,
        selected: false,
        setAttribute() {},
        select() {
          this.selected = true;
        },
        setSelectionRange() {},
      };
      created.push(area);
      return area;
    },
  };
  return { doc, body, created };
}

describe("copyText — presse-papiers avec repli", () => {
  it("API moderne disponible : copie et renvoie « copied » (sans repli)", async () => {
    const calls: string[] = [];
    const nav: any = { clipboard: { writeText: async (t: string) => void calls.push(t) } };
    const { doc } = makeFakeDoc();
    const exec = vi.spyOn(doc, "execCommand");
    const status = await copyText("bonjour", { nav, doc });
    expect(status).toBe("copied");
    expect(calls).toEqual(["bonjour"]);
    expect(exec).not.toHaveBeenCalled();
  });

  it("API moderne REFUSÉE (permission) : bascule sur le repli execCommand", async () => {
    const nav: any = {
      clipboard: {
        writeText: async () => {
          throw new Error("NotAllowedError");
        },
      },
    };
    const { doc, created } = makeFakeDoc({ execResult: true });
    const status = await copyText("texte refusé", { nav, doc });
    expect(status).toBe("copied");
    // Le repli a bien copié la MÊME valeur exacte.
    expect(created[0]?.value).toBe("texte refusé");
    expect(created[0]?.selected).toBe(true);
    // Le champ temporaire est retiré du DOM (aucun artefact).
    expect(doc.body.children).toEqual([]);
  });

  it("API moderne ABSENTE (contexte non sécurisé) : repli execCommand", async () => {
    const nav: any = {}; // pas de navigator.clipboard
    const { doc, created } = makeFakeDoc({ execResult: true });
    const status = await copyText("héllo & <monde>\n\tfin", { nav, doc });
    expect(status).toBe("copied");
    expect(created[0]?.value).toBe("héllo & <monde>\n\tfin");
  });

  it("API absente ET repli refusé : renvoie « failed » (jamais un silence)", async () => {
    const nav: any = {};
    const { doc } = makeFakeDoc({ execResult: false });
    expect(await copyText("x", { nav, doc })).toBe("failed");
  });

  it("API refusée ET repli en exception : renvoie « failed »", async () => {
    const nav: any = {
      clipboard: {
        writeText: async () => {
          throw new Error("refus");
        },
      },
    };
    const { doc } = makeFakeDoc({ throwExec: true });
    expect(await copyText("x", { nav, doc })).toBe("failed");
  });

  it("restaure le focus volé par le champ temporaire", async () => {
    const nav: any = {};
    const { doc } = makeFakeDoc({ execResult: true });
    const focused: string[] = [];
    doc.activeElement = {
      focus() {
        focused.push("previous");
      },
    };
    await copyText("y", { nav, doc });
    expect(focused).toEqual(["previous"]);
  });

  it("sans `navigator` ni `document` : échec honnête, pas de plantage", async () => {
    expect(await copyText("z", { nav: undefined as never, doc: undefined as never })).toBe("failed");
  });
});
