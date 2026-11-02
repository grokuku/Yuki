/**
 * RÉGLAGE « Agents distants » — le chemin que cite le message de refus existe
 * VRAIMENT dans l'interface, et l'état effectif AFFICHÉ ne ment jamais.
 *
 * ⚠️ LES DEUX DÉFAUTS QUE CE FICHIER FERME (2026-11-02) :
 *  ① le refus d'un outil long renvoyait vers « Configuration → Discussions →
 *    Agents distants ». Or **aucun onglet ne s'appelle « Discussions »** : le 2ᵉ
 *    onglet s'appelle « Conversation » (`public/ui/config.html`, `#tab-conversation`).
 *    L'utilisateur a cherché et ne l'a pas trouvé.
 *  ② si `GET /api/chat/status` échoue, le `<select>` restait sur « Désactivés
 *    (défaut) » et le bouton d'enregistrement restait actif : l'utilisateur croyait
 *    lire un état effectif qui n'avait jamais été lu.
 *
 * ⚠️ CSP INCHANGÉE : le contrôle est construit avec `document.createElement`
 * (`h()`), jamais par `innerHTML`, et il n'ajoute aucun style inline.
 *
 * ⚠️ DOM SIMULÉ : Vitest tourne en `environment: "node"` et le projet n'embarque
 * ni jsdom ni happy-dom. Un DOM minimal (createElement/append/value/disabled) suffit
 * pour PILOTER le module réel `initChatPanel` et lire ce que verrait l'utilisateur.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  REMOTE_AGENTS_ANCHOR,
  REMOTE_AGENTS_HELP,
  REMOTE_AGENTS_LABEL,
  REMOTE_AGENTS_UNKNOWN,
  REMOTE_TOOLS_ANCHOR,
  REMOTE_TOOLS_HELP,
  REMOTE_TOOLS_LABEL,
  initChatPanel,
} from "../../public/ui/chat-panel.js";
import { REMOTE_AGENTS_SETTING_PATH } from "../../src/llm/tool-policy.js";

const ROOT = process.cwd();

function lire(chemin: string): string {
  return readFileSync(join(ROOT, chemin), "utf8");
}

// ─── DOM minimal (le strict nécessaire pour piloter le module) ─────────────

class Noeud {
  constructor(tag: string) {
    this.tag = tag;
    this.children = [] as Noeud[];
    this.parent = null as Noeud | null;
    this.attrs = new Map<string, string>();
    this.textContent = "";
    this.className = "";
    this.title = "";
    this.hidden = false;
    this.disabled = false;
    this.listeners = new Map<string, Array<() => void>>();
    this.valueInterne = "";
    this.indexSelectionne = undefined as number | undefined;
  }

  tag: string;
  children: Noeud[];
  parent: Noeud | null;
  attrs: Map<string, string>;
  textContent: string;
  className: string;
  title: string;
  hidden: boolean;
  disabled: boolean;
  listeners: Map<string, Array<() => void>>;
  valueInterne: string;
  indexSelectionne: number | undefined;

  setAttribute(nom: string, valeur: unknown): void {
    this.attrs.set(nom, String(valeur));
  }

  getAttribute(nom: string): string | null {
    return this.attrs.get(nom) ?? null;
  }

  append(...noeuds: Noeud[]): void {
    for (const noeud of noeuds) {
      noeud.parent = this;
      this.children.push(noeud);
    }
  }

  replaceChildren(...noeuds: Noeud[]): void {
    for (const enfant of this.children) enfant.parent = null;
    this.children = [];
    this.append(...noeuds);
  }

  removeChild(noeud: Noeud): Noeud {
    const index = this.children.indexOf(noeud);
    if (index >= 0) this.children.splice(index, 1);
    noeud.parent = null;
    return noeud;
  }

  addEventListener(type: string, fn: () => void): void {
    const liste = this.listeners.get(type) ?? [];
    liste.push(fn);
    this.listeners.set(type, liste);
  }

  scrollIntoView(): void {
    // Volontairement vide : le défilement n'existe pas dans ce DOM simulé.
  }

  get options(): Noeud[] {
    return this.children.filter((enfant) => enfant.tag === "option");
  }

  /** Sémantique d'un `<select>` : `value` = option sélectionnée (1ʳᵉ par défaut). */
  get value(): string {
    if (this.tag !== "select") return this.valueInterne;
    const index = this.indexSelectionne ?? (this.options.length > 0 ? 0 : -1);
    const option = index >= 0 ? this.options[index] : undefined;
    return option?.getAttribute("value") ?? "";
  }

  set value(valeur: string) {
    if (this.tag !== "select") {
      this.valueInterne = String(valeur);
      return;
    }
    this.indexSelectionne = this.options.findIndex(
      (option) => (option.getAttribute("value") ?? "") === String(valeur),
    );
  }

  /** Texte de l'option sélectionnée : ce que l'utilisateur LIT vraiment. */
  get texteSelectionne(): string {
    const index = this.indexSelectionne ?? (this.options.length > 0 ? 0 : -1);
    const option = index >= 0 ? this.options[index] : undefined;
    return option?.textContent ?? "";
  }
}

/** Tous les descendants (profondeur d'abord). */
function descendants(racine: Noeud): Noeud[] {
  const out: Noeud[] = [];
  for (const enfant of racine.children) {
    out.push(enfant, ...descendants(enfant));
  }
  return out;
}

const DOM_PRECEDENT = {
  document: (globalThis as Record<string, unknown>).document,
  Node: (globalThis as Record<string, unknown>).Node,
};

function installerDom(): void {
  (globalThis as Record<string, unknown>).Node = Noeud;
  (globalThis as Record<string, unknown>).document = {
    createElement: (tag: string) => new Noeud(tag),
    createTextNode: (texte: string) => {
      const noeud = new Noeud("#text");
      noeud.textContent = texte;
      return noeud;
    },
    activeElement: null,
    getElementById: () => null,
  };
}

afterEach(() => {
  (globalThis as Record<string, unknown>).document = DOM_PRECEDENT.document;
  (globalThis as Record<string, unknown>).Node = DOM_PRECEDENT.Node;
});

/** Réponse de statut factice : `null` ⇒ la route ÉCHOUE. */
function statutFactice(agents: "desactive" | "actives" | null) {
  return async () => {
    if (agents === null) {
      return {
        ok: false,
        status: 503,
        json: async () => ({ message: "gateway indisponible" }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        mode: "mattermost",
        distant: { agents },
        mattermost: { plateforme: { etat: "off" }, canaux: [] },
      }),
    };
  };
}

async function monterPanneau(agents: "desactive" | "actives" | null) {
  installerDom();
  const root = new Noeud("div");
  const panneau = initChatPanel({ root, fetchImpl: statutFactice(agents) as never });
  // Le montage initial déclenche une lecture ; on attend une lecture COMPLÈTE
  // (le module expose `refresh`, qui rend l'état courant).
  await panneau.refresh();
  const noeuds = descendants(root);
  const select = noeuds.find((noeud) => noeud.tag === "select");
  const bouton = noeuds.find(
    (noeud) => noeud.tag === "button" && noeud.textContent === "Enregistrer le réglage",
  );
  if (!select || !bouton) throw new Error("contrôle « Agents distants » non monté");
  return { root, select, bouton, noeuds };
}

// ─── ① Le chemin du refus ──────────────────────────────────────────────────

describe("chemin d'activation du réglage « Agents distants »", () => {
  it("le refus nomme l'ONGLET RÉEL (« Conversation ») et le libellé EXACT du contrôle", () => {
    expect(REMOTE_AGENTS_SETTING_PATH).toContain(
      `Configuration → Conversation → ${REMOTE_AGENTS_LABEL}`,
    );
    // ⚠️ Le défaut d'origine : « Discussions » n'est pas un onglet de `/config`.
    expect(REMOTE_AGENTS_SETTING_PATH).not.toContain("Discussions");
    expect(REMOTE_AGENTS_LABEL).toBe("Agents distants");
  });

  it("AUCUN fichier de `src/` ne renvoie vers un onglet « Discussions »", () => {
    const fichiers = readdirSync(join(ROOT, "src"), { recursive: true, withFileTypes: true })
      .filter((entree) => entree.isFile() && entree.name.endsWith(".ts"))
      .map((entree) => join(entree.parentPath, entree.name));
    expect(fichiers.length).toBeGreaterThan(50);
    // « → Discussions » (ou « /config → Discussions ») désigne un onglet QUI N'EXISTE
    // PAS. Le titre de SECTION « Discussions — Mattermost » reste, lui, légitime.
    const mauvais = /(?:Configuration|\/config)\s*→\s*Discussions/u;
    const coupables = fichiers.filter((fichier) => mauvais.test(readFileSync(fichier, "utf8")));
    expect(coupables).toEqual([]);
  });

  it("le panneau rend le contrôle et écrit la CLÉ de configuration attendue", () => {
    const source = lire("public/ui/chat-panel.js");
    expect(REMOTE_AGENTS_ANCHOR).toBe("chat-remote-agents");
    // ⚠️ Fabrique COMMUNE aux deux contrôles : ce qui distingue « Agents distants »,
    // c'est son ancre, sa CLÉ et la valeur d'état qu'il lit.
    expect(source).toContain("anchor: REMOTE_AGENTS_ANCHOR");
    expect(source).toContain('cle: "chat.remoteAgents"');
    expect(source).toContain("body: JSON.stringify({ [cle]: select.value })");
    expect(source).toContain("x-yuki-config");
    // ⚠️ La valeur effective vient du SERVEUR, jamais d'une supposition locale.
    expect(source).toContain("lire: (state) => state?.distant?.agents");
  });

  it("l'aide dit ce que le réglage change (images inline vs délégation)", () => {
    expect(REMOTE_AGENTS_HELP).toContain("GÉNÉRATION D'IMAGE");
    expect(REMOTE_AGENTS_HELP).toContain("DÉLÉGUER");
    expect(REMOTE_AGENTS_HELP).toContain("GLOBAL");
  });

  it("aucun `innerHTML` dans le panneau (CSP stricte)", () => {
    const source = lire("public/ui/chat-panel.js");
    // La règle est une INTERDICTION en tête de fichier : on cherche une AFFECTION
    // réelle (`.innerHTML =`), jamais la mention de la règle elle-même.
    expect(source).not.toMatch(/\.innerHTML\s*=/u);
    expect(source).not.toMatch(/outerHTML\s*=/u);
    expect(source).not.toMatch(/insertAdjacentHTML/u);
  });

  it("le panneau expose une fabrique montable (aucune E/S au chargement)", () => {
    expect(typeof initChatPanel).toBe("function");
  });
});

// ─── ② L'état effectif affiché ne ment jamais ──────────────────────────────

describe("état effectif du réglage « Agents distants »", () => {
  it("statut INDISPONIBLE ⇒ « Valeur inconnue », jamais un faux « Désactivés »", async () => {
    const { select, bouton, noeuds } = await monterPanneau(null);
    expect(select.value).toBe("inconnue");
    expect(select.texteSelectionne).toBe(REMOTE_AGENTS_UNKNOWN);
    // ⚠️ Le mensonge d'origine : la première option (« Désactivés (défaut) »).
    expect(select.texteSelectionne).not.toContain("Désactivés");
    // ⚠️ On ne modifie pas un état qu'on ne connaît pas.
    expect(select.disabled).toBe(true);
    expect(bouton.disabled).toBe(true);
    const etat = noeuds.find((noeud) => noeud.textContent.startsWith("Valeur effective :"));
    expect(etat?.textContent ?? "").toContain("Valeur effective : inconnue");
    expect(etat?.textContent ?? "").toContain("impossible de joindre le serveur");
  });

  it("statut DISPONIBLE (`desactive`) ⇒ valeur effective écrite, contrôles actifs", async () => {
    const { select, bouton, noeuds } = await monterPanneau("desactive");
    expect(select.value).toBe("desactive");
    expect(select.disabled).toBe(false);
    expect(bouton.disabled).toBe(false);
    const etat = noeuds.find((noeud) => noeud.textContent.startsWith("Valeur effective :"));
    expect(etat?.textContent ?? "").toContain("agents DÉSACTIVÉS");
    // L'option d'état inconnu n'existe PLUS dans la liste.
    expect(select.options.map((option) => option.getAttribute("value"))).toEqual([
      "desactive",
      "actives",
    ]);
  });

  it("statut DISPONIBLE (`actives`) ⇒ valeur effective écrite, contrôles actifs", async () => {
    const { select, bouton, noeuds } = await monterPanneau("actives");
    expect(select.value).toBe("actives");
    expect(select.disabled).toBe(false);
    expect(bouton.disabled).toBe(false);
    const etat = noeuds.find((noeud) => noeud.textContent.startsWith("Valeur effective :"));
    expect(etat?.textContent ?? "").toContain("agents ACTIVÉS");
  });
});

// ─── ②bis Deux contrôles, deux valeurs effectives ─────────────────────────

/**
 * Statut factice à DEUX capacités, et journal des écritures (pour prouver que
 * chaque contrôle écrit SA clé).
 */
function statutDeux(agents: string, outils: string | undefined, ecritures: unknown[] = []) {
  return async (url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === "PUT") {
      ecritures.push({ url, body: init.body });
      return { ok: true, status: 200, json: async () => ({}) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        mode: "mattermost",
        distant: outils === undefined ? { agents } : { agents, outils },
        mattermost: { plateforme: { etat: "off" }, canaux: [] },
      }),
    };
  };
}

async function monterComplet(agents: string, outils: string | undefined, ecritures: unknown[] = []) {
  installerDom();
  const root = new Noeud("div");
  const panneau = initChatPanel({ root, fetchImpl: statutDeux(agents, outils, ecritures) as never });
  await panneau.refresh();
  const noeuds = descendants(root);
  const selects = noeuds.filter((noeud) => noeud.tag === "select");
  const boutons = noeuds.filter(
    (noeud) => noeud.tag === "button" && noeud.textContent === "Enregistrer le réglage",
  );
  return { root, noeuds, selects, boutons, panneau };
}

describe("deux réglages, DEUX contrôles (agents / outils)", () => {
  it("le panneau monte les deux sections, dans l'ordre agents puis outils", async () => {
    const { selects } = await monterComplet("desactive", "actives");
    expect(selects).toHaveLength(2);
    expect(selects[0]?.getAttribute("id")).toBe(REMOTE_AGENTS_ANCHOR);
    expect(selects[1]?.getAttribute("id")).toBe(REMOTE_TOOLS_ANCHOR);
    // ⚠️ Les libellés sont distincts : deux listes, pas une.
    expect(REMOTE_AGENTS_LABEL).not.toBe(REMOTE_TOOLS_LABEL);
  });

  it("chaque contrôle affiche SA valeur effective (aucun ne devine l'autre)", async () => {
    const { selects, noeuds } = await monterComplet("desactive", "actives");
    expect(selects[0]?.value).toBe("desactive");
    expect(selects[1]?.value).toBe("actives");
    const textes = noeuds
      .filter((noeud) => noeud.textContent.startsWith("Valeur effective :"))
      .map((noeud) => noeud.textContent);
    expect(textes).toHaveLength(2);
    expect(textes[0]).toContain("agents DÉSACTIVÉS");
    expect(textes[1]).toContain("outils ACTIVÉS");
  });

  it("état d'OUTILS illisible ⇒ « Valeur inconnue », jamais un faux « Désactivés »", async () => {
    const { selects, boutons } = await monterComplet("actives", undefined);
    const outils = selects[1]!;
    expect(outils.value).toBe("inconnue");
    expect(outils.texteSelectionne).toBe(REMOTE_AGENTS_UNKNOWN);
    expect(outils.disabled).toBe(true);
    expect(boutons[1]?.disabled).toBe(true);
    // ⚠️ L'autre contrôle, lui, reste lisible ET actif : les deux états sont distincts.
    expect(selects[0]?.value).toBe("actives");
    expect(selects[0]?.disabled).toBe(false);
  });

  it("chaque bouton écrit SA clé de configuration", async () => {
    const ecritures: unknown[] = [];
    const { selects, boutons } = await monterComplet("desactive", "desactive", ecritures);
    selects[1]!.value = "actives";
    const clic = boutons[1]!.listeners.get("click") ?? [];
    expect(clic).toHaveLength(1);
    clic[0]!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const corps = ecritures.map((e) => JSON.parse((e as { body: string }).body));
    expect(corps).toEqual([{ "chat.remoteTools": "actives" }]);
  });

  it("l'aide de chaque contrôle dit CONCRÈTEMENT ce qu'il ouvre", () => {
    // ⚠️ Les deux textes doivent être actionnables, pas des étiquettes.
    expect(REMOTE_TOOLS_HELP).toContain("génération d'image");
    expect(REMOTE_TOOLS_HELP).toContain("libraire");
    expect(REMOTE_TOOLS_HELP).toContain("archive");
    expect(REMOTE_AGENTS_HELP).toContain("MACHINES");
    expect(REMOTE_AGENTS_HELP).toContain("DÉLÉGUER");
    // Et chacun dit que l'AUTRE famille ne dépend pas de lui.
    expect(REMOTE_AGENTS_HELP).toContain("GÉNÉRATION D'IMAGE");
    expect(REMOTE_TOOLS_HELP).toContain("sans ouvrir la délégation");
    // Les outils à approbation restent annoncés comme exclus.
    expect(REMOTE_TOOLS_HELP).toContain("approbation");
  });

  it("l'ancre `/config#chat-remote-tools` ouvre aussi l'onglet « Conversation »", () => {
    const source = lire("public/ui/config.js");
    expect(source).toContain(`[REMOTE_TOOLS_ANCHOR, "conversation"]`);
  });
});

// ─── ③ L'ancre qui rend le contrôle trouvable ──────────────────────────────

describe("ancre `/config#chat-remote-agents`", () => {
  it("`tabFromHash` reconnaît l'ancre et ouvre l'onglet « Conversation »", () => {
    const source = lire("public/ui/config.js");
    // ⚠️ Depuis le découpage des deux accès (2026-11-02), la table porte AUSSI
    // l'ancre `chat-remote-tools` : on vérifie l'ENTRÉE, pas la forme de la ligne.
    expect(source).toContain(`[REMOTE_AGENTS_ANCHOR, "conversation"]`);
    expect(source).toContain("return ANCRES_PROFONDES.get(raw) ?? null;");
    // Le défilement est SÉPARÉ de la sélection d'onglet (et tolère l'absence de l'élément).
    expect(source).toContain("function revealHashTarget()");
    expect(source).toContain("typeof target.scrollIntoView !== \"function\"");
    // Appelé APRÈS le montage du panneau, une fois la hauteur stabilisée (le contrôle
    // n'existe pas avant, et les sections se remplissent après la lecture d'état).
    const montage = source.indexOf("initChatPanel({");
    const defilement = source.indexOf("revealHashTarget();", montage);
    expect(montage).toBeGreaterThan(-1);
    expect(defilement).toBeGreaterThan(montage);
    expect(source).toContain("onFirstRender: () => revealHashTarget()");
  });

  it("la cible est bien dans le panneau « Conversation », en fin d'onglet", () => {
    const html = lire("public/ui/config.html");
    const panneau = html.indexOf('id="panel-conversation"');
    const finPanneau = html.indexOf('id="panel-personnalite"');
    const chatRoot = html.indexOf('id="chat-root"');
    expect(panneau).toBeGreaterThan(-1);
    expect(finPanneau).toBeGreaterThan(panneau);
    // `#chat-root` (qui porte le contrôle « Agents distants ») est DANS ce panneau :
    // l'ancre ne peut donc pas envoyer les champs dans un autre onglet.
    expect(chatRoot).toBeGreaterThan(panneau);
    expect(chatRoot).toBeLessThan(finPanneau);
  });
});
