/**
 * LOT 37 — SÉLECTEUR DE BOTS DE LA BARRE DU HAUT.
 *
 * ⚠️ LE DÉFAUT CORRIGÉ ICI (rapporté par l'utilisateur) : « je voulais avoir les
 * bots dans la barre du haut (là où est l'icône de Yuki) pour switcher facilement.
 * Là il faut que j'aille dans les paramètres, que je change de bot, et il me dit
 * que je n'ai qu'un seul bot actif. »
 * Autrement dit : la demande INITIALE du multi-bot (« dans la barre de titre il y
 * a écrit Yuki avec son avatar, on pourrait disposer de plusieurs bots à cet
 * endroit ») avait été livrée sous forme de `<select>` dans `/bots` — et un bot
 * neuf (`actif: false`) restait impossible à démarrer sans passer par les
 * paramètres.
 *
 * ⚠️ CES TESTS ÉCHOUENT SUR LE CODE D'ORIGINE : `bot-switcher.js` et
 * `bot-switcher-modele.js` n'existent pas, `#brand-avatar` est une image morte
 * (aucun bouton), aucun panneau ne liste les bots, et le bandeau de `/bots`
 * annonce « Ce bot n'est pas le bot ACTIF de l'instance (yuki) » — qui se lit
 * « il n'y a qu'un seul bot actif ».
 *
 * ⚠️ DOM SIMULÉ : Vitest tourne en `environment: "node"` (ni jsdom ni happy-dom).
 * Le strict nécessaire est simulé ci-dessous (createElement/append/textContent/
 * écouteurs) pour PILOTER le module réel et lire ce que verrait l'utilisateur.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { initBotSwitcher } from "../../public/ui/bot-switcher.js";

/**
 * ⚠️ Les DEUX modales d'administration sont REMPLACÉES par des espions : la
 * suppression réutilise `ouvrirSuppressionBot` (compteurs + case à cocher), et
 * ce fichier vérifie qu'elle est APPELÉE — pas comment elle dessine ses cases.
 */
const mocks = vi.hoisted(() => ({ suppression: vi.fn(), creation: vi.fn() }));
vi.mock("../../public/ui/bots-admin.js", () => ({
  ouvrirCreationBot: mocks.creation,
  ouvrirSuppressionBot: mocks.suppression,
}));
import {
  confirmationSuppressionBot,
  texteSuppressionBot,
} from "../../public/ui/config-pages.js";
import {
  attribuerSessions,
  badgeNonLus,
  entreeListe,
  etatBot,
  messageBandeauBot,
  nomBarreHaut,
  nonLusParBot,
  resumeBots,
  urlConversationBot,
} from "../../public/ui/bot-switcher-modele.js";

const ROOT = process.cwd();
const ui = (nom: string): string => readFileSync(join(ROOT, "public", "ui", nom), "utf8");

/**
 * Code SANS commentaires : un commentaire qui EXPLIQUE le défaut corrigé ne doit
 * pas être confondu avec le message affiché à l'utilisateur.
 */
function sansCommentaires(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .split("\n")
    .filter((ligne) => !/^\s*(\/\/|\*)/u.test(ligne))
    .join("\n");
}

// ─── DOM minimal (le strict nécessaire pour piloter le module) ─────────────

class Noeud {
  tag: string;
  parent: Noeud | null = null;
  children: Noeud[] = [];
  attrs = new Map<string, string>();
  classes = new Set<string>();
  private texte = "";
  hidden = false;
  disabled = false;
  listeners = new Map<string, Array<(event?: unknown) => void>>();
  value = "";

  constructor(tag: string) {
    this.tag = tag;
  }

  get parentNode(): Noeud | null {
    return this.parent;
  }

  set textContent(valeur: string) {
    this.texte = String(valeur);
    this.children = [];
  }

  get textContent(): string {
    if (this.children.length > 0) {
      return this.children.map((enfant) => enfant.textContent).join("");
    }
    return this.texte;
  }

  set className(valeur: string) {
    this.classes = new Set(String(valeur).split(/\s+/).filter((c) => c !== ""));
  }

  get className(): string {
    return [...this.classes].join(" ");
  }

  get classList() {
    const classes = this.classes;
    return {
      add: (nom: string) => classes.add(nom),
      remove: (nom: string) => classes.delete(nom),
      toggle: (nom: string, force?: boolean) => {
        const actif = force ?? !classes.has(nom);
        if (actif) classes.add(nom);
        else classes.delete(nom);
        return actif;
      },
      contains: (nom: string) => classes.has(nom),
    };
  }

  setAttribute(nom: string, valeur: unknown): void {
    this.attrs.set(nom, String(valeur));
  }

  getAttribute(nom: string): string | null {
    return this.attrs.get(nom) ?? null;
  }

  removeAttribute(nom: string): void {
    this.attrs.delete(nom);
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

  addEventListener(type: string, fn: (event?: unknown) => void): void {
    const liste = this.listeners.get(type) ?? [];
    liste.push(fn);
    this.listeners.set(type, liste);
  }

  removeEventListener(type: string, fn: (event?: unknown) => void): void {
    const liste = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      liste.filter((entree) => entree !== fn),
    );
  }

  /** Déclenche les écouteurs (aucune remontée : inutile ici). */
  dispatch(type: string, event: Record<string, unknown> = {}): void {
    for (const fn of this.listeners.get(type) ?? []) {
      fn({
        type,
        target: this,
        preventDefault: () => {},
        stopPropagation: () => {},
        ...event,
      });
    }
  }
}

function descendants(racine: Noeud): Noeud[] {
  const sortie: Noeud[] = [];
  for (const enfant of racine.children) sortie.push(enfant, ...descendants(enfant));
  return sortie;
}

const DOM_PRECEDENT = {
  document: (globalThis as Record<string, unknown>).document,
  Node: (globalThis as Record<string, unknown>).Node,
};

let corps: Noeud;
let ecouteursDocument: Map<string, Array<(event?: unknown) => void>>;

function installerDom(): void {
  corps = new Noeud("body");
  ecouteursDocument = new Map();
  (globalThis as Record<string, unknown>).Node = Noeud;
  (globalThis as Record<string, unknown>).document = {
    createElement: (tag: string) => new Noeud(tag),
    createTextNode: (texte: string) => {
      const noeud = new Noeud("#text");
      noeud.textContent = texte;
      return noeud;
    },
    body: corps,
    addEventListener: (type: string, fn: (event?: unknown) => void) => {
      const liste = ecouteursDocument.get(type) ?? [];
      liste.push(fn);
      ecouteursDocument.set(type, liste);
    },
    removeEventListener: () => {},
  };
}

afterEach(() => {
  vi.useRealTimers();
  (globalThis as Record<string, unknown>).document = DOM_PRECEDENT.document;
  (globalThis as Record<string, unknown>).Node = DOM_PRECEDENT.Node;
});

// ─── Banc : un sélecteur monté sur un DOM simulé ───────────────────────────

interface BotFactice {
  id: string;
  nom: string;
  actif: boolean;
  ordre: number;
  execution?: { demarre: boolean; erreur?: string; sessions?: number; workers?: number };
}

const BOTS: BotFactice[] = [
  // Le bot de la PILE : il tourne avec le gateway.
  { id: "yuki", nom: "Yuki", actif: true, ordre: 0, execution: { demarre: true } },
  // Un bot créé depuis l'interface : `actif: false`, PAS démarré. C'est LUI qui
  // bloquait l'utilisateur.
  { id: "kohai", nom: "Kohai", actif: false, ordre: 1, execution: { demarre: false } },
  // Un bot allumé dont le démarrage a ÉCHOUÉ : dit « erreur », jamais « actif ».
  {
    id: "nova",
    nom: "Nova",
    actif: true,
    ordre: 2,
    execution: { demarre: false, erreur: "clé du modèle absente" },
  },
];

function reponse(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body };
}

interface Banc {
  switcher: ReturnType<typeof initBotSwitcher>;
  button: Noeud;
  panel: Noeud;
  list: Noeud;
  /** RANGÉE d'avatars inline de la barre du haut (lot 38). */
  bar: Noeud;
  status: Noeud;
  /** Ligne de SYNTHÈSE du panneau (`resumeEl`) : « 3 bots. 1 en marche… ». */
  resume: Noeud;
  /** Nom affiché DANS le bouton de la barre du haut (`#bot-switcher-nom`). */
  nom: Noeud;
  nav: string[];
  patchs: Array<{ url: string; body: any }>;
  appels: string[];
  alertes: Array<{ titre: string; texte: string }>;
}

function banc(
  options: {
    bots?: BotFactice[];
    /** Bot du RUN (`GET /api/bots` → `botDuRun`) : plus de « bot principal ». */
    duRun?: string;
    echanges?: Record<string, { actif: boolean }>;
    reponsePanne?: { status: number; body: unknown };
    panneListe?: boolean;
    recherche?: string;
  } = {},
): Banc {
  installerDom();
  const button = new Noeud("button");
  const panel = new Noeud("div");
  panel.hidden = true;
  const list = new Noeud("ul");
  const status = new Noeud("p");
  status.hidden = true;
  const resume = new Noeud("p");
  const nom = new Noeud("span");
  nom.textContent = "Yuki";
  const bar = new Noeud("div");
  const nav: string[] = [];
  const patchs: Array<{ url: string; body: any }> = [];
  const appels: string[] = [];
  const duRun = options.duRun ?? "yuki";
  // Liste MUTABLE : après suppression, `GET /api/bots` rend la liste amputée.
  const bots = [...(options.bots ?? BOTS)];
  mocks.suppression.mockReset();
  mocks.suppression.mockImplementation(async ({ bot }: { bot: { id: string } }) => {
    const index = bots.findIndex((entree) => entree.id === bot.id);
    if (index < 0) return null;
    bots.splice(index, 1);
    return {
      bots,
      archive: `bots-supprimes/${bot.id}`,
      botActifSuivant: bots[0]?.id ?? null,
      rechargementRequis: false,
      sessionsPi: { etat: "ok" },
    };
  });

  const fetchImpl = async (url: string, init?: { method?: string; body?: string }) => {
    appels.push(`${init?.method ?? "GET"} ${url}`);
    if (url === "/api/bots" && (init?.method ?? "GET") === "GET") {
      if (options.panneListe) return reponse(503, { message: "gateway indisponible" });
      // ⚠️ Plus de `plafond` ni de `refuses` : il n'y a plus de limite au nombre
      // de bots en marche (décision utilisateur du 2026-11-13).
      return reponse(200, {
        bots,
        botDuRun: duRun,
        echanges: options.echanges ?? {},
      });
    }
    if (url === "/api/bots/echanges") {
      const corps = JSON.parse(init?.body ?? "{}");
      patchs.push({ url, body: corps });
      if (options.reponsePanne) {
        return reponse(options.reponsePanne.status, options.reponsePanne.body);
      }
      return reponse(200, {
        cle: `${corps.de}->${corps.vers}`,
        actif: corps.actif,
        inchange: false,
        echanges: { [`${corps.de}->${corps.vers}`]: { actif: corps.actif } },
      });
    }
    if (url.startsWith("/api/bots/") && url.endsWith("/actif")) {
      const corps = JSON.parse(init?.body ?? "{}");
      patchs.push({ url, body: corps });
      if (options.reponsePanne) {
        return reponse(options.reponsePanne.status, options.reponsePanne.body);
      }
      const id = url.slice("/api/bots/".length, -"/actif".length);
      const misAJour = bots.map((bot) =>
        bot.id === id
          ? { ...bot, actif: true, execution: { demarre: true } }
          : bot,
      );
      return reponse(200, {
        bots: misAJour,
        actif: true,
        inchange: false,
        redemarrageRequis: false,
        applique: { ok: true, inchange: false },
      });
    }
    return reponse(404, { message: "route inconnue" });
  };

  // Modale FACTICE : on n'ouvre aucune vraie fenêtre, on enregistre seulement
  // les alertes (refus du dernier bot, etc.).
  const alertes: Array<{ titre: string; texte: string }> = [];
  const HolafModal = {
    alert: async (titre: string, texte: string) => {
      alertes.push({ titre, texte });
    },
  };

  const switcher = initBotSwitcher({
    button,
    panel,
    list,
    barEl: bar,
    resumeEl: resume,
    statusEl: status,
    nomEl: nom,
    HolafModal,
    fetchImpl: fetchImpl as never,
    naviguer: (url: string) => nav.push(url),
    recherche: () => options.recherche ?? "",
    avatarPrincipal: () => null,
    statutMs: 0,
  });

  return { switcher, button, panel, list, bar, status, resume, nom, nav, patchs, appels, alertes };
}

/** Bouton d'avatar de la rangée pour un bot donné. */
function avatarDe(b: Banc, botId: string): Noeud {
  const item = descendants(b.bar).find(
    (noeud) => noeud.tag === "button" && noeud.getAttribute("data-bot-id") === botId,
  );
  if (!item) throw new Error(`avatar « ${botId} » absent de la rangée`);
  return item;
}

function itemDe(list: Noeud, botId: string): Noeud {
  const item = descendants(list).find(
    (noeud) => noeud.tag === "li" && noeud.getAttribute("data-bot-id") === botId,
  );
  if (!item) throw new Error(`entrée « ${botId} » absente de la liste`);
  return item;
}

// ─── ① l'avatar de la barre du haut est un BOUTON ─────────────────────────

describe("① les onglets de bots de la barre du haut ouvrent le panneau", () => {
  it("le markup porte les ONGLETS et le bouton « … » du panneau", () => {
    const html = ui("index.html");
    // ⚠️ LOT 39 : les onglets (`#bot-bar`) sont le point de bascule IMMÉDIAT ;
    // chaque onglet porte son propre nom, il n'y a PLUS de nom isolé à droite.
    expect(html).toMatch(/<div\s+id="bot-bar"[^>]*class="bot-bar"/);
    expect(html).not.toContain('id="bot-switcher-nom"');
    // Le panneau existant reste câblé (Ajouter / Retirer) — bouton « … » seul.
    expect(html).toMatch(
      /<button[^>]*id="bot-switcher-btn"[^>]*aria-controls="bot-switcher-panel"/,
    );
    expect(html).toMatch(/id="bot-switcher-btn"[\s\S]{0,400}?class="brand__plus"/);
    expect(html).toContain('id="bot-switcher-panel"');
    expect(html).toContain('id="bot-switcher-list"');
    expect(html).toContain('id="bot-switcher-add"');
    expect(html).toMatch(/<button[^>]*id="bot-switcher-btn"[^>]*aria-haspopup="dialog"/);
  });

  it("un clic ouvre le panneau et met `aria-expanded` à `true`", async () => {
    const b = banc();
    await b.switcher.rafraichir();
    expect(b.panel.hidden).toBe(true);
    b.button.dispatch("click");
    expect(b.panel.hidden).toBe(false);
    expect(b.button.getAttribute("aria-expanded")).toBe("true");
    b.switcher.fermer();
    expect(b.panel.hidden).toBe(true);
    expect(b.button.getAttribute("aria-expanded")).toBe("false");
  });

  it("aucun `innerHTML` ni style inline dans le sélecteur (CSP stricte)", () => {
    for (const fichier of ["bot-switcher.js", "bot-switcher-modele.js"]) {
      const source = ui(fichier);
      expect(source, fichier).not.toMatch(/\.innerHTML\s*=/u);
      expect(source, fichier).not.toMatch(/insertAdjacentHTML/u);
      // ⚠️ On cherche une AFFECTION réelle (`.style.left = …`), jamais la
      // mention de la règle dans un commentaire.
      expect(source, fichier).not.toMatch(/\.style\.[A-Za-z]+\s*=/u);
      expect(source, fichier).not.toContain('setAttribute("style"');
    }
  });
});

// ─── ② la liste dit l'ÉTAT RÉEL, y compris pour les bots ARRÊTÉS ──────────

describe("② tous les bots sont listés, avec leur état RÉEL", () => {
  it("les trois bots apparaissent — y compris ARRÊTÉ et EN ERREUR", async () => {
    const b = banc();
    await b.switcher.rafraichir();
    b.switcher.ouvrir();
    const noms = descendants(b.list)
      .filter((noeud) => noeud.classes.has("bot-switcher__nom"))
      .map((noeud) => noeud.textContent);
    expect(noms).toEqual(["Yuki", "Kohai", "Nova"]);
    const etats = descendants(b.list)
      .filter((noeud) => noeud.classes.has("bot-switcher__etat"))
      .map((noeud) => noeud.textContent);
    expect(etats).toEqual([
      "en marche",
      "arrêté",
      "arrêté — clé du modèle absente",
    ]);
    // ⚠️ Aucun état ne recopie le drapeau `actif` : Nova est `actif: true` mais
    // ARRÊTÉE (son démarrage a échoué) — l'afficher « en marche » serait le
    // mensonge corrigé au lot 36 (L8). Et la RAISON du refus est écrite.
    expect(etats[2]).not.toBe("en marche");
  });

  it("un bot ARRÊTÉ porte un bouton « Démarrer » ; un bot démarré n'en a pas", async () => {
    const b = banc();
    await b.switcher.rafraichir();
    b.switcher.ouvrir();
    const boutons = (botId: string) =>
      descendants(itemDe(b.list, botId))
        .filter((noeud) => noeud.tag === "button")
        .map((noeud) => noeud.textContent);
    expect(boutons("kohai")).toContain("Démarrer");
    // ⚠️ Un bot EN ERREUR reçoit « Réessayer » : même action, mais le verbe dit
    // qu'on a compris l'échec précédent (la raison est affichée juste à côté).
    expect(boutons("nova")).toContain("Réessayer");
    expect(boutons("yuki")).not.toContain("Démarrer");
  });

  it("la synthèse est en FRANÇAIS LISIBLE et nomme la raison réelle", async () => {
    const b = banc();
    await b.switcher.rafraichir();
    // ⚠️ L'ancien bandeau disait « 3 bot(s) · 2 actif(s) sur 3 maximum ·
    // 1 démarré(s) » : du jargon de registre. On dit « en marche » / « arrêté ».
    expect(b.resume.textContent).toContain("3 bots.");
    expect(b.resume.textContent).toContain("1 en marche");
    expect(b.resume.textContent).toContain("2 arrêtés");
    expect(b.resume.textContent).toContain("Nova : clé du modèle absente");
    expect(b.resume.textContent).not.toContain("actif");
    expect(b.resume.textContent).not.toContain("démarré");
    // ⚠️ Plus AUCUN « au maximum » : il n'y a plus de plafond.
    expect(b.resume.textContent).not.toContain("maximum");
    const b2 = banc({ panneListe: true });
    await b2.switcher.rafraichir();
    // Gateway injoignable : on le DIT, et le panneau reste utilisable.
    expect(b2.status.textContent).toContain("n'a pas pu être lue");
  });
});

// ─── ③ cliquer un bot ARRÊTÉ le DÉMARRE (le blocage actuel) ───────────────

describe("③ cliquer un bot arrêté le DÉMARRE, puis ouvre sa conversation", () => {
  it("`PATCH /api/bots/kohai/actif { actif: true }` AVANT la navigation", async () => {
    const b = banc();
    await b.switcher.rafraichir();
    b.switcher.ouvrir();
    const choix = descendants(itemDe(b.list, "kohai")).find((noeud) =>
      noeud.classes.has("bot-switcher__choix"),
    );
    choix?.dispatch("click");
    await vi.waitFor(() => expect(b.nav).toEqual(["/?b=kohai"]));
    const actifs = b.patchs.filter((entree) => entree.url.endsWith("/actif"));
    expect(actifs).toHaveLength(1);
    expect(actifs[0].url).toBe("/api/bots/kohai/actif");
    expect(actifs[0].body).toEqual({ actif: true });
    // ⚠️ L'ordre compte : naviguer d'abord ferait refuser le WebSocket
    // (« ce bot est arrêté ») et l'utilisateur retomberait sur une erreur.
    expect(b.appels.filter((appel) => appel.startsWith("PATCH")).length).toBe(1);
  });

  it("un bouton « Démarrer » explicite fait la MÊME chose", async () => {
    const b = banc();
    await b.switcher.rafraichir();
    b.switcher.ouvrir();
    const demarrer = descendants(itemDe(b.list, "kohai")).find(
      (noeud) => noeud.textContent === "Démarrer",
    );
    demarrer?.dispatch("click");
    await vi.waitFor(() => expect(b.nav).toEqual(["/?b=kohai"]));
    expect(b.patchs.some((entree) => entree.url === "/api/bots/kohai/actif")).toBe(true);
  });

  it("un REFUS du serveur (dernier bot actif) : AUCUNE navigation, message repris tel quel", async () => {
    // ⚠️ RÉÉCRIT (n'était « un REFUS du serveur (plafond)… ») : le plafond est
    // supprimé, le SEUL refus qui reste sur cette route est `dernier_bot_actif`.
    const b = banc({
      reponsePanne: {
        status: 409,
        body: {
          code: "dernier_bot_actif",
          message:
            "Impossible d'éteindre « kohai » : c'est le DERNIER bot actif. " +
            "Allumez d'abord un autre bot, sinon le gateway ne pourrait plus démarrer.",
        },
      },
    });
    await b.switcher.rafraichir();
    b.switcher.ouvrir();
    const choix = descendants(itemDe(b.list, "kohai")).find((noeud) =>
      noeud.classes.has("bot-switcher__choix"),
    );
    choix?.dispatch("click");
    await vi.waitFor(() => expect(b.status.textContent).toContain("DERNIER bot actif"));
    expect(b.nav).toEqual([]);
    expect(b.status.hidden).toBe(false);
    // Le message du serveur est repris TEL QUEL (aucun « échec » anonyme).
    expect(b.status.textContent).not.toContain("un seul bot");
  });
});

// ─── ④ cliquer un bot DÉJÀ démarré bascule la conversation ────────────────

describe("④ cliquer un bot démarré BASCULE (URL `?b=`, donc fil et WebSocket)", () => {
  it("navigue vers `/?b=kohai` sans aucun PATCH quand le bot tourne déjà", async () => {
    const b = banc({
      bots: [
        BOTS[0],
        { ...BOTS[1], actif: true, execution: { demarre: true } },
      ],
    });
    await b.switcher.rafraichir();
    b.switcher.ouvrir();
    const choix = descendants(itemDe(b.list, "kohai")).find((noeud) =>
      noeud.classes.has("bot-switcher__choix"),
    );
    choix?.dispatch("click");
    await vi.waitFor(() => expect(b.nav).toEqual(["/?b=kohai"]));
    expect(b.patchs).toEqual([]);
  });

  it("le bot PRINCIPAL s'ouvre SANS `?b=` (seule forme valable en mono-bot)", () => {
    expect(urlConversationBot("yuki", "yuki")).toBe("/");
    expect(urlConversationBot("kohai", "yuki")).toBe("/?b=kohai");
    expect(urlConversationBot("kohai", null)).toBe("/?b=kohai");
  });

  it("l'entrée de la conversation courante est démarquée", async () => {
    const b = banc({ recherche: "?b=kohai" });
    await b.switcher.rafraichir();
    b.switcher.ouvrir();
    expect(itemDe(b.list, "kohai").classes.has("bot-switcher__item--courant")).toBe(true);
    expect(itemDe(b.list, "yuki").classes.has("bot-switcher__item--courant")).toBe(false);
  });
});

// ─── ⑤ téléphone ──────────────────────────────────────────────────────────

describe("⑤ téléphone : la barre du haut reste le point de bascule", () => {
  it("le CSS révèle la marque quand l'instance a plusieurs bots", () => {
    const css = ui("styles.css");
    const media = css.slice(css.indexOf("@media (max-width: 767px)"));
    expect(media).toContain("body.has-bot-switcher .brand");
    // Le panneau remonte du bas de l'écran (390 px de large).
    expect(media).toMatch(/\.bot-switcher\s*\{[^}]*position:\s*fixed/s);
    const source = readFileSync(join(ROOT, "public", "ui", "bot-switcher.js"), "utf8");
    expect(source).toContain('"has-bot-switcher"');
    expect(source).toContain("bots.length > 0");
  });

  it("un APPUI LONG sur l'avatar ouvre le panneau (aucun clic droit au doigt)", async () => {
    vi.useFakeTimers();
    const b = banc();
    await b.switcher.rafraichir();
    expect(b.panel.hidden).toBe(true);
    b.button.dispatch("pointerdown", { pointerType: "touch", clientX: 10, clientY: 10 });
    vi.advanceTimersByTime(700);
    expect(b.panel.hidden).toBe(false);
    b.button.dispatch("pointerup", { pointerType: "touch" });
  });
});

// ─── ⑥ « il me dit que je n'ai qu'un seul bot actif » ─────────────────────

describe("⑥ le message « un seul bot actif » est corrigé (vrai nombre)", () => {
  it("le bandeau de `/bots` dit le NOMBRE RÉEL (ici 1 en marche), pas « un seul »", () => {
    // ⚠️ RÉÉCRIT : plus de « sur 3 au maximum » (le plafond n'existe plus).
    const texte = messageBandeauBot({
      bot: BOTS[1],
      bots: [BOTS[0], BOTS[1]],
      duRun: "yuki",
    });
    expect(texte).toContain("1 bot en marche");
    expect(texte).not.toContain("maximum");
    expect(texte).toContain("Démarrer");
    expect(texte.toLowerCase()).not.toContain("un seul");
    // ⚠️ L'ancien message, qui se lisait « il n'y a qu'un seul bot actif ».
    expect(texte).not.toContain("n'est pas le bot ACTIF de l'instance");
    expect(texte).not.toContain("ACTIF");
  });

  it("le nombre affiché est celui des bots VRAIMENT en marche (ici 2)", () => {
    const texte = messageBandeauBot({ bot: BOTS[1], bots: BOTS });
    expect(texte).toContain("2 bots en marche");
    expect(texte).toContain("(yuki, nova)");
  });

  it("aucun bandeau pour un bot ACTIF (on n'affiche pas un avertissement inutile)", () => {
    expect(messageBandeauBot({ bot: BOTS[0], bots: BOTS })).toBe("");
  });

  it("`config.js` n'écrit plus le message d'origine (il délègue au modèle)", () => {
    const config = sansCommentaires(ui("config.js"));
    expect(config).not.toContain("n'est pas le bot ACTIF de l'instance (");
    expect(config).not.toContain("un seul bot actif");
    expect(ui("config.js")).toContain("messageBandeauBot");
  });

  it("le refus WebSocket d'un bot arrêté NOMME l'action (barre du haut)", () => {
    const serveur = readFileSync(
      join(ROOT, "src", "gateway", "ws", "server.ts"),
      "utf8",
    );
    expect(serveur).toContain("est ARRÊTÉ");
    expect(serveur).toContain("barre du haut");
    expect(serveur).toContain("Bots connus");
    expect(serveur).not.toContain("est inconnu ou arrêté : aucun host");
  });

  it("⚠️ la synthèse ne parle JAMAIS de limite ni de maximum", () => {
    // ⚠️ RÉÉCRIT (n'était « la limite par défaut est bien 3 ») : `PLAFOND_ACTIFS_DEFAUT`
    // et la notion de plafond ont été SUPPRIMÉS (décision utilisateur).
    for (const texte of [resumeBots(BOTS), resumeBots([])]) {
      expect(texte.toLowerCase()).not.toContain("limite");
      expect(texte.toLowerCase()).not.toContain("maximum");
    }
    expect(resumeBots(BOTS)).toContain("1 en marche");
  });
});

// ─── ⑦ boucle entre bots : clic droit / appui long ────────────────────────

describe("⑦ boucle entre bots : un seul interrupteur, orienté", () => {
  it("le clic droit sur l'avatar ouvre le menu et écrit `de`/`vers`/`actif`", async () => {
    const b = banc({ echanges: { "kohai->nova": { actif: true } } });
    await b.switcher.rafraichir();
    b.switcher.ouvrir();
    const avatar = descendants(itemDe(b.list, "kohai")).find((noeud) =>
      noeud.classes.has("bot-switcher__avatar"),
    );
    avatar?.dispatch("contextmenu");
    const menu = descendants(itemDe(b.list, "kohai")).find((noeud) =>
      noeud.classes.has("bot-switcher__menu"),
    );
    expect(menu).toBeDefined();
    // ⚠️ Les entrées de BOUCLE portent leur propre classe : le menu contient
    // aussi Démarrer/Arrêter (première entrée) et le retrait (dernière).
    const entrees = (menu?.children ?? [])
      .filter((noeud) => noeud.tag === "button")
      .filter((noeud) => noeud.classes.has("bot-switcher__menu-item--boucle"));
    // Deux cibles possibles : « Yuki » et « Nova » (jamais soi-même).
    expect(entrees).toHaveLength(2);
    expect(entrees[0].textContent).toContain("vers « Yuki »");
    // ⚠️ L'état vient du REGISTRE : la boucle vers Nova est déjà autorisée.
    expect(entrees[1].textContent).toContain("Couper la boucle vers « Nova »");
    expect(entrees[1].textContent).toContain("autorisée");
    entrees[1].dispatch("click");
    await vi.waitFor(() => expect(b.patchs).toHaveLength(1));
    expect(b.patchs[0].url).toBe("/api/bots/echanges");
    expect(b.patchs[0].body).toEqual({ de: "kohai", vers: "nova", actif: false });
  });

  it("un bot seul n'a AUCUNE boucle à régler (et le dit)", async () => {
    const b = banc({ bots: [BOTS[0]] });
    await b.switcher.rafraichir();
    b.switcher.ouvrir();
    const avatar = descendants(itemDe(b.list, "yuki")).find((noeud) =>
      noeud.classes.has("bot-switcher__avatar"),
    );
    avatar?.dispatch("contextmenu");
    const menu = descendants(itemDe(b.list, "yuki")).find((noeud) =>
      noeud.classes.has("bot-switcher__menu"),
    );
    expect(menu?.textContent).toContain("Aucun autre bot");
  });
});

// ─── ⑦ bis SUPPRIMER un bot depuis le panneau ─────────────────────────────

/** Ouvre le menu d'une entrée (clic droit sur son avatar) et cherche un bouton. */
function boutonDuMenu(list: Noeud, botId: string, texte: string): Noeud | null {
  const item = itemDe(list, botId);
  const avatar = descendants(item).find((noeud) => noeud.classes.has("bot-switcher__avatar"));
  avatar?.dispatch("contextmenu");
  const menu = descendants(itemDe(list, botId)).find((noeud) =>
    noeud.classes.has("bot-switcher__menu"),
  );
  return (
    (menu?.children ?? []).find(
      (noeud) => noeud.tag === "button" && noeud.textContent === texte,
    ) ?? null
  );
}

describe("⑦ bis le panneau donne accès à la SUPPRESSION (sans la réinventer)", () => {
  it("le menu d'une entrée porte « Retirer ce bot… », réutilise `ouvrirSuppressionBot`", async () => {
    const b = banc();
    await b.switcher.rafraichir();
    b.switcher.ouvrir();
    const bouton = boutonDuMenu(b.list, "kohai", "Retirer ce bot…");
    expect(bouton).not.toBeNull();
    // ⚠️ Jamais à côté de « Démarrer » : deux boutons de même poids, dont un
    // destructeur, finissent cliqués par erreur.
    const item = itemDe(b.list, "kohai");
    expect(
      descendants(item).some((noeud) => noeud.classes.has("bot-switcher__menu-item--danger")),
    ).toBe(true);
    // La modale EXISTANTE est appelée : aucune seconde confirmation dans ce module.
    const source = ui("bot-switcher.js");
    expect(source).toContain('from "./bots-admin.js"');
    expect(source).toContain("ouvrirSuppressionBot({");
    expect(source).not.toMatch(/method:\s*"DELETE"/u);
  });

  it("le libellé évite « Supprimer » (les E2E cliquent ce texte au mot près)", () => {
    const source = ui("bot-switcher.js");
    expect(source).toContain("Retirer ce bot…");
    expect(source).not.toContain("Supprimer ce bot");
    // Le bouton de fermeture ne contient pas « Fermer » : un doublon masqué
    // détournerait `clickButton("Fermer")` de `e2e-sources`.
    const html = ui("index.html");
    expect(html).toMatch(/id="bot-switcher-close"[\s\S]{0,200}>Masquer</);
  });

  it("la modale de confirmation dit les COMPTEURS et la rétention de 90 jours", () => {
    const texte = texteSuppressionBot({
      bot: { id: "kohai", nom: "Kohai" },
      compteurs: { conversations: 4, souvenirs: 128, declencheurs: 3, octets: 184320 },
      retentionJours: 90,
    });
    expect(texte).toContain("4 conversation(s)");
    expect(texte).toContain("128 souvenir(s)");
    expect(texte).toContain("3 déclencheur(s)");
    expect(texte).toContain("CONSERVÉES 3 mois (90 jours)");
    // La case à cocher est OBLIGATOIRE : son libellé nomme l'archivage.
    expect(confirmationSuppressionBot()).toContain("conservées 3 mois");
  });

  it("un bot RETIRÉ qui était celui de la page ⇒ bascule sur un AUTRE bot", async () => {
    const b = banc({ recherche: "?b=kohai" });
    await b.switcher.rafraichir();
    b.switcher.ouvrir();
    boutonDuMenu(b.list, "kohai", "Retirer ce bot…")?.dispatch("click");
    await vi.waitFor(() => expect(b.nav).toEqual(["/"]));
    // La modale existante a bien été appelée avec le bot et les MÊMES appels HTTP.
    expect(mocks.suppression).toHaveBeenCalledTimes(1);
    expect(mocks.suppression.mock.calls[0][0].bot).toEqual({ id: "kohai", nom: "Kohai" });
    // Le panneau ne reste pas sur un bot qui n'existe plus.
    const noms = descendants(b.list)
      .filter((noeud) => noeud.classes.has("bot-switcher__nom"))
      .map((noeud) => noeud.textContent);
    expect(noms).not.toContain("Kohai");
  });

  it("un bot retiré qui n'était PAS celui de la page ⇒ aucune navigation, 90 jours dits", async () => {
    const b = banc({ recherche: "?b=yuki" });
    await b.switcher.rafraichir();
    b.switcher.ouvrir();
    boutonDuMenu(b.list, "kohai", "Retirer ce bot…")?.dispatch("click");
    await vi.waitFor(() => expect(b.status.textContent).toContain("90 jours"));
    expect(b.nav).toEqual([]);
    expect(b.status.textContent).toContain("archivé");
  });

  it("renoncer dans la modale ne retire RIEN (liste intacte)", async () => {
    mocks.suppression.mockResolvedValueOnce(null);
    const b = banc();
    await b.switcher.rafraichir();
    b.switcher.ouvrir();
    boutonDuMenu(b.list, "kohai", "Retirer ce bot…")?.dispatch("click");
    await vi.waitFor(() => expect(mocks.suppression).toHaveBeenCalledTimes(1));
    const noms = descendants(b.list)
      .filter((noeud) => noeud.classes.has("bot-switcher__nom"))
      .map((noeud) => noeud.textContent);
    expect(noms).toEqual(["Yuki", "Kohai", "Nova"]);
  });

  it("le DERNIER bot est refusé en FRANÇAIS, avant tout appel destructeur", async () => {
    const b = banc({ bots: [BOTS[0]] });
    await b.switcher.rafraichir();
    b.switcher.ouvrir();
    boutonDuMenu(b.list, "yuki", "Retirer ce bot…")?.dispatch("click");
    await vi.waitFor(() => expect(b.alertes).toHaveLength(1));
    expect(b.alertes[0].titre).toBe("Suppression impossible");
    expect(b.alertes[0].texte).toContain("DERNIER bot");
    expect(b.alertes[0].texte).toContain("ne peut pas démarrer");
    expect(mocks.suppression).not.toHaveBeenCalled();
    expect(b.nav).toEqual([]);
  });

  it("le refus 409 `dernier_bot` du SERVEUR existe et dit la même chose", () => {
    // ⚠️ Défense en PROFONDEUR : l'UI refuse sans aller-retour, le domaine refuse
    // aussi (une autre page pourrait appeler la route). Même message, même cause.
    const admin = readFileSync(join(ROOT, "src", "bots", "admin.ts"), "utf8");
    expect(admin).toContain('"dernier_bot"');
    expect(admin).toContain("Impossible de supprimer le DERNIER bot");
    expect(admin).toContain("ne peut pas démarrer");
  });
});

// ─── ⑧ « Ajouter un bot » depuis le panneau ───────────────────────────────

describe("⑧ « Ajouter un bot » réutilise la modale existante", () => {
  it("le sélecteur appelle `ouvrirCreationBot` (aucune seconde modale)", () => {
    const source = ui("bot-switcher.js");
    expect(source).toContain('from "./bots-admin.js"');
    expect(source).toContain("ouvrirCreationBot({ HolafModal, bots })");
    // Un bot neuf est `actif: false` : le message le DIT et donne le geste.
    expect(source).toContain("Il est ARRÊTÉ");
  });
});

// ─── ⑩ chaque onglet porte SON nom (plus de « Yuki » détaché) ────────────

describe("⑩ « j'ai la tête à Yuki, puis la tête à Grolaf, puis écrit Yuki » corrigé", () => {
  it("chaque onglet = avatar + nom, y compris pour un bot NON affiché", async () => {
    const b = banc({ recherche: "?b=kohai" });
    await b.switcher.rafraichir();
    const nomDe = (botId: string) =>
      descendants(avatarDe(b, botId)).find((noeud) => noeud.classes.has("bot-bar__nom"))
        ?.textContent;
    // ⚠️ LE DÉFAUT : un avatar par bot, puis UN nom isolé à droite — on lisait
    // « tête à Yuki, tête à Grolaf, puis Yuki ». Chaque onglet porte le sien.
    expect(["yuki", "kohai", "nova"].map(nomDe)).toEqual(["Yuki", "Kohai", "Nova"]);
    // Le nom est DANS le bouton qui bascule, pas à côté.
    for (const botId of ["yuki", "kohai", "nova"]) {
      const item = avatarDe(b, botId);
      const nom = descendants(item).find((noeud) => noeud.classes.has("bot-bar__nom"));
      expect(nom).toBeDefined();
      // L'avatar précède le nom dans l'ordre du DOM.
      expect(descendants(item).indexOf(nom!)).toBeGreaterThan(
        descendants(item).findIndex((noeud) => noeud.classes.has("bot-bar__avatar")),
      );
    }
  });

  it("le panneau /bots garde son nom dans le bouton (aucun nom en dur)", async () => {
    const html = ui("bots.html");
    expect(html).toMatch(/<span id="bot-switcher-nom" class="brand__name">/);
    expect(html).not.toMatch(/<span class="brand__name">Yuki<\/span>/u);
    const b = banc({ recherche: "?b=kohai" });
    await b.switcher.rafraichir();
    expect(b.nom.textContent).toBe("Kohai");
  });

  it("DEUX bots de même nom restent écrits PAREIL : aucun slug à l'écran", () => {
    const bots = [
      { id: "yuki", nom: "Yuki", actif: true, ordre: 0 },
      { id: "grolaf", nom: "Grolaf", actif: false, ordre: 1 },
      { id: "grolaf-2", nom: "Grolaf", actif: false, ordre: 2 },
    ];
    // ⚠️ Décision utilisateur : « le slug on s'en fout ». Le doublon est empêché
    // à la CRÉATION, pas maquillé à l'affichage.
    expect(entreeListe(bots[1]).nomAffiche).toBe("Grolaf");
    expect(entreeListe(bots[2]).nomAffiche).toBe("Grolaf");
    expect(nomBarreHaut(bots, "grolaf-2")).toBe("Grolaf");
    expect(ui("bot-switcher-modele.js")).not.toContain("} (${id})");
  });

  it("⚠️ un bot `actif` qui ne démarre pas dit son ERREUR, jamais un plafond", async () => {
    // ⚠️ RÉÉCRIT (n'était « le panneau liste TOUS les bots, y compris les REFUSÉS
    // du plafond ») : sans plafond, la seule cause possible d'un « pas démarré »
    // est une VRAIE erreur (`execution.erreur`), affichée telle quelle.
    const b = banc({
      bots: [
        BOTS[0],
        BOTS[1],
        { ...BOTS[2], actif: true, execution: { demarre: false, erreur: "port occupé" } },
      ],
    });
    await b.switcher.rafraichir();
    b.switcher.ouvrir();
    const etats = descendants(b.list)
      .filter((noeud) => noeud.classes.has("bot-switcher__etat"))
      .map((noeud) => noeud.textContent);
    expect(etats).toHaveLength(3);
    expect(etats[2]).toContain("port occupé");
    expect(etats[2]).not.toContain("maximum");
    expect(b.resume.textContent).toContain("Nova : port occupé");
  });
});

// ─── ⑪ MENU du nom+avatar : Démarrer/Arrêter, boucles, retrait ─────────────

describe("⑪ clic droit / appui long sur le nom+avatar : les TROIS gestes", () => {
  it("le clic droit sur le BOUTON de la barre du haut ouvre le menu du bot courant", async () => {
    const b = banc({ recherche: "?b=yuki" });
    await b.switcher.rafraichir();
    b.button.dispatch("contextmenu");
    await vi.waitFor(() => expect(b.panel.hidden).toBe(false));
    await vi.waitFor(() => {
      const menu = descendants(b.list).find((noeud) =>
        noeud.classes.has("bot-switcher__menu"),
      );
      expect(menu).toBeDefined();
    });
    const menu = descendants(b.list).find((noeud) => noeud.classes.has("bot-switcher__menu"));
    expect(menu?.textContent).toContain("Bot « Yuki »");
    // Le bot de l'instance suit le gateway : la ligne existe et n'agit pas.
    expect(menu?.textContent).toContain("ce bot suit le gateway");
    expect(menu?.textContent).toContain("Retirer ce bot…");
  });

  it("le menu d'un bot ARRÊTÉ porte « Démarrer » ; démarré, « Arrêter »", async () => {
    const b = banc({ recherche: "?b=kohai" });
    await b.switcher.rafraichir();
    b.switcher.ouvrir();
    const avatar = descendants(itemDe(b.list, "kohai")).find((noeud) =>
      noeud.classes.has("bot-switcher__avatar"),
    );
    avatar?.dispatch("contextmenu");
    let menu = descendants(itemDe(b.list, "kohai")).find((noeud) =>
      noeud.classes.has("bot-switcher__menu"),
    );
    expect(menu?.textContent).toContain("Démarrer « Kohai »");

    // Bot DÉMARRÉ (Nova, avec un état d'exécution réel) : c'est « Arrêter ».
    const b2 = banc({
      bots: [BOTS[0], { ...BOTS[1], actif: true, execution: { demarre: true } }],
    });
    await b2.switcher.rafraichir();
    b2.switcher.ouvrir();
    const avatar2 = descendants(itemDe(b2.list, "kohai")).find((noeud) =>
      noeud.classes.has("bot-switcher__avatar"),
    );
    avatar2?.dispatch("contextmenu");
    menu = descendants(itemDe(b2.list, "kohai")).find((noeud) =>
      noeud.classes.has("bot-switcher__menu"),
    );
    expect(menu?.textContent).toContain("Arrêter « Kohai »");
  });

  it("« Arrêter » écrit `PATCH { actif: false }` et dit le refus du serveur", async () => {
    const b = banc({
      bots: [BOTS[0], { ...BOTS[1], actif: true, execution: { demarre: true } }],
      reponsePanne: {
        status: 409,
        body: { code: "dernier_bot_actif", message: "Éteindre le dernier bot actif est impossible." },
      },
    });
    await b.switcher.rafraichir();
    b.switcher.ouvrir();
    const avatar = descendants(itemDe(b.list, "kohai")).find((noeud) =>
      noeud.classes.has("bot-switcher__avatar"),
    );
    avatar?.dispatch("contextmenu");
    const bouton = descendants(itemDe(b.list, "kohai")).find(
      (noeud) => noeud.tag === "button" && noeud.textContent === "Arrêter « Kohai »",
    );
    bouton?.dispatch("click");
    await vi.waitFor(() => expect(b.status.textContent).toContain("dernier bot actif"));
    expect(b.patchs[0]).toEqual({
      url: "/api/bots/kohai/actif",
      body: { actif: false },
    });
  });

  it("l'APPUI LONG sur le nom+avatar (téléphone) ouvre le menu du bot courant", async () => {
    vi.useFakeTimers();
    const b = banc({ recherche: "?b=yuki" });
    await b.switcher.rafraichir();
    b.button.dispatch("pointerdown", { pointerType: "touch", clientX: 10, clientY: 10 });
    vi.advanceTimersByTime(700);
    expect(b.panel.hidden).toBe(false);
    // Le panneau est ouvert ET le menu du bot courant est déplié.
    await vi.waitFor(() => {
      const menu = descendants(b.list).find((noeud) =>
        noeud.classes.has("bot-switcher__menu"),
      );
      expect(menu).toBeDefined();
    });
    b.button.dispatch("pointerup", { pointerType: "touch" });
  });
});

// ─── ⑨ modèle pur : états et monogrammes ──────────────────────────────────

describe("⑨ modèle pur", () => {
  it("`etatBot` ne confond jamais `actif` (registre) et `demarre` (exécution)", () => {
    expect(etatBot(BOTS[0], "yuki").code).toBe("duRun");
    expect(etatBot(BOTS[1], "yuki").code).toBe("arrete");
    expect(etatBot(BOTS[2], "yuki").code).toBe("erreur");
    // Mode dégradé (aucun port d'exécution) : on ne SAIT pas, on ne ment pas.
    expect(etatBot({ id: "kohai", actif: true }, "yuki").code).toBe("inconnu");
    // Un bot arrêté est démariable ; un bot du run, non.
    expect(etatBot(BOTS[1], "yuki").demarrable).toBe(true);
    expect(etatBot(BOTS[0], "yuki").demarrable).toBe(false);
    // ⚠️ LOT 38 : la RAISON réelle est rendue, jamais un code muet.
    expect(etatBot(BOTS[2], "yuki").libelle).toBe("arrêté — clé du modèle absente");
    expect(etatBot(BOTS[2], "yuki").raison).toBe("clé du modèle absente");
  });

  it("`entreeListe` produit le monogramme et l'URL de conversation", () => {
    const entree = entreeListe(BOTS[1], { duRun: "yuki", courant: "kohai" });
    expect(entree.monogramme).toBe("K");
    expect(entree.url).toBe("/?b=kohai");
    expect(entree.courant).toBe(true);
    expect(entree.avatarClasse).toMatch(/^bot-switcher__avatar--c[1-6]$/);
  });

  it("aucun fichier de l'UI n'AFFICHE qu'un seul bot peut être actif", () => {
    const fichiers = readdirSync(join(ROOT, "public", "ui"))
      .filter((nom) => nom.endsWith(".js") || nom.endsWith(".html"))
      .map((nom) => join(ROOT, "public", "ui", nom));
    // ⚠️ On lit le CODE, pas les commentaires qui EXPLIQUENT le défaut corrigé.
    const coupables = fichiers.filter((fichier) =>
      /un seul bot (actif|à la fois)|seul bot actif|n'est pas le bot ACTIF de l'instance/iu.test(
        sansCommentaires(readFileSync(fichier, "utf8")),
      ),
    );
    expect(coupables).toEqual([]);
  });
});

// ─── ⑫ LOT 38 — RANGÉE D'AVATARS INLINE + BADGES DE NON-LUS ───────────────

describe("⑫ les bots CÔTE À CÔTE dans la barre du haut", () => {
  it("un avatar par bot, le bot affiché démarqué, un bot arrêté marqué", async () => {
    const b = banc({ recherche: "?b=kohai" });
    await b.switcher.rafraichir();
    const ids = descendants(b.bar)
      .filter((noeud) => noeud.tag === "button")
      .map((noeud) => noeud.getAttribute("data-bot-id"));
    expect(ids).toEqual(["yuki", "kohai", "nova"]);
    // Le bot AFFICHÉ : classe (jamais un style inline) + `aria-current`.
    expect(avatarDe(b, "kohai").classes.has("bot-bar__item--courant")).toBe(true);
    expect(avatarDe(b, "kohai").getAttribute("aria-current")).toBe("true");
    // Un bot ARRÊTÉ reste VISIBLE et marqué ; une erreur est distinguée.
    expect(avatarDe(b, "kohai").classes.has("bot-bar__item--arrete")).toBe(true);
    expect(avatarDe(b, "nova").classes.has("bot-bar__item--arrete")).toBe(true);
    expect(avatarDe(b, "nova").classes.has("bot-bar__item--erreur")).toBe(true);
    expect(avatarDe(b, "yuki").classes.has("bot-bar__item--marche")).toBe(true);
  });

  it("cliquer un avatar bascule IMMÉDIATEMENT (aucun panneau intermédiaire)", async () => {
    const b = banc();
    await b.switcher.rafraichir();
    expect(b.panel.hidden).toBe(true);
    avatarDe(b, "kohai").dispatch("click");
    await vi.waitFor(() => expect(b.nav).toEqual(["/?b=kohai"]));
    // ⚠️ Le panneau ne s'est PAS ouvert : la bascule est directe.
    expect(b.panel.hidden).toBe(true);
    // Un bot arrêté est démarré AVANT la navigation (sinon WS refusé).
    expect(b.patchs.some((entree) => entree.url === "/api/bots/kohai/actif")).toBe(true);
  });

  it("cliquer l'avatar du bot AFFICHÉ ne recharge rien", async () => {
    const b = banc({ recherche: "?b=kohai" });
    await b.switcher.rafraichir();
    avatarDe(b, "kohai").dispatch("click");
    await vi.waitFor(() => expect(b.nav).toEqual([]));
    expect(b.patchs).toEqual([]);
  });

  it("pas de débordement : cadre DÉFILANT, onglets bornés, noms tronqués", () => {
    const css = ui("styles.css");
    expect(css).toMatch(/\.bot-bar\s*\{[^}]*display:\s*flex[^}]*overflow-x:\s*auto/s);
    expect(css).toMatch(/\.bot-bar\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%/s);
    // Un onglet = pilule AVATAR + NOM : plus de cercle de 24 px.
    expect(css).toMatch(/\.bot-bar__item\s*\{[^}]*display:\s*inline-flex[^}]*border-radius:\s*999px/s);
    expect(css).toMatch(/\.bot-bar__item\s*\{[^}]*gap:\s*7px/s);
    // Les 24 px sont portés par l'AVATAR de l'onglet (22 px en téléphone).
    expect(css).toMatch(/\.bot-bar__avatar\s*\{[^}]*width:\s*24px[^}]*height:\s*24px/s);
    expect(css).toMatch(/body\.has-bot-switcher \.brand\s*\{[^}]*display:\s*flex/s);
    // ⚠️ 40 caractères ne cassent pas la barre : largeur bornée + ellipse.
    expect(css).toMatch(
      /\.bot-bar__nom\s*\{[^}]*max-width:[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/s,
    );
    // L'onglet AFFICHÉ est démarqué par une CLASSE (jamais un style inline).
    expect(ui("bot-switcher.js")).toContain('"bot-bar__item--courant"');
    expect(css).toMatch(/\.bot-bar__item--courant\s*\{[^}]*border-color:\s*var\(--accent\)/s);
    // Plus de nom isolé à droite de la rangée.
    const html = ui("index.html");
    expect(html).not.toContain('id="bot-switcher-nom"');
    const media = css.slice(css.indexOf("@media (max-width: 767px)"));
    expect(media).toMatch(/\.bot-bar\s*\{[^}]*max-width:\s*52vw/s);
    expect(media).toMatch(/\.bot-bar__avatar\s*\{[^}]*width:\s*22px[^}]*height:\s*22px/s);
    // Téléphone : le nom n'est affiché QUE pour l'onglet AFFICHÉ (justifié en CSS).
    expect(media).toMatch(/\.bot-bar__nom\s*\{[^}]*display:\s*none/s);
    expect(media).toMatch(
      /\.bot-bar__item--courant \.bot-bar__nom\s*\{[^}]*display:\s*inline-block[^}]*max-width:\s*72px/s,
    );
    // Le bouton « … » n'est jamais masqué (seule porte d'Ajouter / Retirer).
    expect(media).not.toMatch(/\.brand__plus\s*\{[^}]*display:\s*none/s);
  });

  it("le panneau reste accessible (clic droit / appui long sur un avatar)", async () => {
    vi.useFakeTimers();
    const b = banc();
    await b.switcher.rafraichir();
    avatarDe(b, "nova").dispatch("contextmenu");
    expect(b.panel.hidden).toBe(false);
    // Le menu du bot visé est ouvert (Démarrer/Arrêter, boucles, retrait).
    expect(b.list.textContent).toContain("Retirer ce bot…");
    b.switcher.fermer();
    avatarDe(b, "kohai").dispatch("pointerdown", { pointerType: "touch", clientX: 5, clientY: 5 });
    vi.advanceTimersByTime(700);
    expect(b.panel.hidden).toBe(false);
  });
});

describe("⑬ badges de non-lus PAR BOT (lot 38)", () => {
  it("un point pour 1 message, le nombre au-delà, rien pour 0", () => {
    expect(badgeNonLus(0)).toBe("");
    expect(badgeNonLus(1)).toBe("•");
    expect(badgeNonLus(4)).toBe("4");
    expect(badgeNonLus(12)).toBe("9+");
  });

  it("le décompte est PAR BOT (jamais le total de l'instance)", () => {
    const attribution = attribuerSessions({}, ["s-yuki", "s-kohai"], "yuki");
    const table = attribuerSessions(attribution, ["s-grolaf"], "grolaf");
    const compteurs = nonLusParBot(
      { "s-yuki": 1, "s-kohai": 2, "s-grolaf": 3 },
      table,
    );
    expect(compteurs).toEqual({ yuki: 3, grolaf: 3 });
  });

  it("le badge s'affiche par bot, et disparaît quand le compteur est éteint", async () => {
    const b = banc();
    await b.switcher.rafraichir();
    b.switcher.majSessions(["s-yuki"], { "s-yuki": 1 }, "yuki");
    const badge = (botId: string) =>
      descendants(avatarDe(b, botId)).find((noeud) => noeud.classes.has("bot-bar__badge"));
    expect(badge("yuki")?.textContent).toBe("•");
    expect(badge("yuki")?.hidden).toBe(false);
    // Aucun non-lu sur Kohai : badge MASQUÉ.
    expect(badge("kohai")?.hidden).toBe(true);
    // Plusieurs messages ⇒ le nombre.
    b.switcher.majNonLus({ "s-yuki": 3 });
    expect(badge("yuki")?.textContent).toBe("3");
    // Ouvrir la conversation éteint le compteur (`app.js`) ⇒ badge effacé.
    b.switcher.majNonLus({});
    expect(badge("yuki")?.textContent).toBe("");
    expect(badge("yuki")?.hidden).toBe(true);
    expect(b.switcher.etat().nonLus).toEqual({});
  });
});
