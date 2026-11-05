/**
 * LOT 30 — INTERFACE de la déconnexion des plateformes + sélecteur de mode conditionnel.
 *
 * Ce que ce fichier prouve :
 *  ① le sélecteur Local · Mattermost · Discord n'est AFFICHÉ qu'à partir de DEUX types de
 *    discussion actifs, et un mode inactif n'apparaît pas non plus DEDANS ;
 *  ② il se met à jour À CHAUD (le statut change ⇒ il apparaît/disparaît sans recharger) ;
 *  ③ un mode courant devenu inactif est BASCULÉ automatiquement (`resolveActiveMode`) ;
 *  ④ `/config` présente DEUX actions distinctes — « Débrancher » (miroir conservé) et
 *    « Supprimer la connexion » (destructif) — et la suppression exige une CASE À COCHER
 *    explicite, avec le décompte de ce qui sera perdu.
 *
 * ⚠️ DOM SIMULÉ : Vitest tourne en `environment: "node"` (ni jsdom ni happy-dom). Un DOM
 * minimal suffit pour PILOTER les modules réels et lire ce que verrait l'utilisateur.
 * ⚠️ Échoue sur le code d'origine : `modesActifs`, `selectorVisible`, `resolveActiveMode`,
 * `texteSuppression` et les deux boutons n'existent pas.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CONFIRMATION_SUPPRESSION,
  formatOctets,
  initChatPanel,
  texteDebranchement,
  texteSuppression,
} from "../../public/ui/chat-panel.js";
import {
  initChatModeSelector,
  modesActifs,
  resolveActiveMode,
  selectorVisible,
} from "../../public/ui/chat-mode.js";

const ROOT = process.cwd();

// ─── DOM minimal ───────────────────────────────────────────────────────────

class Noeud {
  tag: string;
  children: Noeud[];
  parent: Noeud | null;
  attrs: Map<string, string>;
  textContent: string;
  className: string;
  title: string;
  hidden: boolean;
  disabled: boolean;
  checked: boolean;
  type: string;
  id: string;
  valueInterne: string;
  listeners: Map<string, Array<(evenement?: unknown) => void>>;
  classList: { add: (nom: string) => void; toggle: (nom: string, actif?: boolean) => void; contains: (nom: string) => boolean };

  constructor(tag: string) {
    this.tag = tag;
    this.children = [];
    this.parent = null;
    this.attrs = new Map();
    this.textContent = "";
    this.className = "";
    this.title = "";
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.type = "";
    this.id = "";
    this.valueInterne = "";
    this.listeners = new Map();
    const classes = new Set<string>();
    this.classList = {
      add: (nom: string) => {
        classes.add(nom);
        this.className = [...classes].join(" ");
      },
      toggle: (nom: string, actif?: boolean) => {
        const actifEffectif = actif === undefined ? !classes.has(nom) : actif;
        if (actifEffectif) classes.add(nom);
        else classes.delete(nom);
        this.className = [...classes].join(" ");
      },
      contains: (nom: string) => classes.has(nom),
    };
  }

  setAttribute(nom: string, valeur: unknown): void {
    this.attrs.set(nom, String(valeur));
    if (nom === "type") this.type = String(valeur);
    if (nom === "id") this.id = String(valeur);
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

  addEventListener(type: string, fn: (evenement?: unknown) => void): void {
    const liste = this.listeners.get(type) ?? [];
    liste.push(fn);
    this.listeners.set(type, liste);
  }

  /** Déclenche un événement (le DOM simulé n'a pas de boucle d'événements). */
  declencher(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }

  get value(): string {
    return this.valueInterne;
  }

  set value(valeur: string) {
    this.valueInterne = String(valeur);
  }

  focus(): void {
    // Volontairement vide : le focus n'existe pas dans ce DOM simulé.
  }

  removeChild(noeud: Noeud): Noeud {
    const index = this.children.indexOf(noeud);
    if (index >= 0) this.children.splice(index, 1);
    noeud.parent = null;
    return noeud;
  }

  /** Classes EFFECTIVES d'un nœud (posées par `className`, `classList` ou l'attribut). */
  private classesDe(noeud: Noeud): string[] {
    const brut = `${noeud.className ?? ""} ${noeud.attrs.get("class") ?? ""}`;
    return brut.split(/\s+/u).filter((nom) => nom !== "");
  }

  /** Recherche d'un descendant par sélecteur de CLASSE (`.x`) ou de balise. */
  querySelector(selecteur: string): Noeud | null {
    const cible = selecteur.startsWith(".") ? selecteur.slice(1) : null;
    for (const descendant of descendants(this)) {
      if (cible !== null) {
        if (this.classesDe(descendant).includes(cible)) return descendant;
      } else if (descendant.tag === selecteur) return descendant;
    }
    return null;
  }
}

function descendants(racine: Noeud): Noeud[] {
  const sortie: Noeud[] = [];
  for (const enfant of racine.children) sortie.push(enfant, ...descendants(enfant));
  return sortie;
}

function trouver(racine: Noeud, predicat: (noeud: Noeud) => boolean): Noeud[] {
  return descendants(racine).filter(predicat);
}

const DOM_PRECEDENT = {
  document: (globalThis as Record<string, unknown>).document,
  Node: (globalThis as Record<string, unknown>).Node,
};

beforeEach(() => {
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
});

afterEach(() => {
  (globalThis as Record<string, unknown>).document = DOM_PRECEDENT.document;
  (globalThis as Record<string, unknown>).Node = DOM_PRECEDENT.Node;
});

/** Statut `GET /api/chat/status` avec les deux plateformes décrites par le test. */
function statut(options: {
  mode?: string;
  mattermost?: { jetonEnregistre?: boolean; canaux?: number };
  discord?: { jetonEnregistre?: boolean; canaux?: number };
}) {
  return {
    mode: options.mode ?? "local",
    plateforme: { etat: "on" },
    creation: { autorisee: true },
    distant: { agents: "desactive", outils: "desactive" },
    ...(options.mattermost
      ? {
          mattermost: {
            url: "https://mattermost.exemple.fr",
            jetonEnregistre: options.mattermost.jetonEnregistre === true,
            plateforme: { etat: options.mattermost.jetonEnregistre ? "on" : "off" },
            synchronisation: {
              demarre: false,
              canauxSuivis: options.mattermost.canaux ?? 0,
              backfill: { fait: false, imports: 0, borneAtteinte: false },
              rattrapageActif: false,
            },
            miroir: {
              conversations: options.mattermost.canaux ?? 0,
              messages: 12,
              octets: 2048,
            },
            canaux: Array.from({ length: options.mattermost.canaux ?? 0 }, (_, index) => ({
              id: `mm-canal-${index}`,
              titre: `canal ${index}`,
              messageCount: 12,
              backfillFait: true,
              historiqueAnterieur: false,
            })),
          },
        }
      : {}),
    ...(options.discord
      ? {
          discord: {
            guildId: "",
            maxUploadBytes: 8388608,
            intentMessageContent: null,
            jetonEnregistre: options.discord.jetonEnregistre === true,
            plateforme: { etat: options.discord.jetonEnregistre ? "on" : "off" },
            synchronisation: {
              demarre: false,
              canauxSuivis: options.discord.canaux ?? 0,
              backfill: { fait: false, imports: 0, borneAtteinte: false },
              rattrapageActif: false,
            },
            miroir: { conversations: options.discord.canaux ?? 0, messages: 0, octets: 0 },
            canaux: Array.from({ length: options.discord.canaux ?? 0 }, (_, index) => ({
              id: `dc-salon-${index}`,
              titre: `salon ${index}`,
              messageCount: 0,
              backfillFait: true,
              historiqueAnterieur: false,
            })),
          },
        }
      : {}),
  };
}

// ─── ② Sélecteur masqué tant qu'il n'y a pas DEUX types actifs ─────────────

describe("définition d'« actif » et visibilité du sélecteur", () => {
  it("`local` est TOUJOURS actif, même à zéro conversation", () => {
    expect(modesActifs(statut({}))).toEqual(["local"]);
    expect(selectorVisible(statut({}))).toBe(false);
  });

  it("une plateforme est active si un jeton est au coffre, MÊME déconnectée", () => {
    // ⚠️ « configurée mais en erreur » est précisément le moment où l'on veut garder
    // l'onglet : c'est là qu'on lit la raison et qu'on répare.
    const etat = statut({
      mode: "mattermost",
      mattermost: { jetonEnregistre: true, canaux: 0 },
      discord: {},
    });
    (etat.mattermost as { plateforme: { etat: string } }).plateforme.etat = "off";
    expect(modesActifs(etat)).toContain("mattermost");
    expect(selectorVisible(etat)).toBe(true);
  });

  it("une plateforme débranchée dont le miroir garde des conversations reste active", () => {
    const etat = statut({ mattermost: { jetonEnregistre: false, canaux: 2 } });
    expect(modesActifs(etat)).toEqual(["local", "mattermost"]);
    expect(selectorVisible(etat)).toBe(true);
  });

  it("un seul type actif ⇒ sélecteur MASQUÉ ; deux ⇒ visible", () => {
    expect(selectorVisible(statut({ mattermost: {}, discord: {} }))).toBe(false);
    expect(
      selectorVisible(statut({ mattermost: { jetonEnregistre: true }, discord: {} })),
    ).toBe(true);
    expect(
      selectorVisible(
        statut({ mattermost: { jetonEnregistre: true }, discord: { jetonEnregistre: true } }),
      ),
    ).toBe(true);
  });

  it("état INCONNU (gateway injoignable) ⇒ visible (on ne retire pas un contrôle à l'aveugle)", () => {
    expect(selectorVisible(null)).toBe(true);
    expect(selectorVisible(undefined)).toBe(true);
  });

  it("le sélecteur est MASQUÉ (attribut `hidden`), pas seulement désactivé", () => {
    const source = readFileSync(join(ROOT, "public", "ui", "chat-mode.js"), "utf8");
    expect(source).toContain("root.hidden = !visible");
    expect(source).toContain("group.hidden = !visible");
  });
});

describe("sélecteur monté — masquage, boutons inactifs, mise à jour À CHAUD", () => {
  function monter() {
    const racine = new Noeud("div");
    const selecteur = initChatModeSelector({ root: racine, onChange: () => undefined });
    return { racine, groupe: racine.children[0] as Noeud, selecteur };
  }

  function boutons(groupe: Noeud): Noeud[] {
    return groupe.children.filter((noeud) => noeud.tag === "button");
  }

  it("1 type actif ⇒ conteneur MASQUÉ (aucun espace, aucun bouton inutile)", () => {
    const { racine, groupe, selecteur } = monter();
    selecteur.update(statut({ mattermost: {}, discord: {} }));
    expect(racine.hidden).toBe(true);
    expect(groupe.hidden).toBe(true);
  });

  it("2 types actifs ⇒ conteneur VISIBLE, et Discord INACTIF n'apparaît plus", () => {
    const { racine, groupe, selecteur } = monter();
    selecteur.update(
      statut({ mattermost: { jetonEnregistre: true }, discord: { jetonEnregistre: false } }),
    );
    expect(racine.hidden).toBe(false);
    expect(groupe.hidden).toBe(false);
    const visibles = boutons(groupe)
      .filter((bouton) => bouton.hidden !== true)
      .map((bouton) => bouton.getAttribute("data-mode"));
    expect(visibles).toEqual(["local", "mattermost"]);
  });

  it("MISE À JOUR À CHAUD : le statut change, le sélecteur apparaît puis disparaît", () => {
    const { racine, selecteur } = monter();
    selecteur.update(statut({ mattermost: {}, discord: {} }));
    expect(racine.hidden).toBe(true);
    // Seconde lecture du statut, sans recharger la page : Mattermost vient d'être configuré.
    selecteur.update(statut({ mattermost: { jetonEnregistre: true }, discord: {} }));
    expect(racine.hidden).toBe(false);
    // Puis supprimé : retour à un seul type actif.
    selecteur.update(statut({ mattermost: {}, discord: {} }));
    expect(racine.hidden).toBe(true);
  });

  it("le mode courant reste marqué actif (`aria-pressed`) quand il est affiché", () => {
    const { groupe, selecteur } = monter();
    selecteur.update(
      statut({ mode: "mattermost", mattermost: { jetonEnregistre: true }, discord: {} }),
    );
    const mattermost = boutons(groupe).find(
      (bouton) => bouton.getAttribute("data-mode") === "mattermost",
    );
    expect(mattermost?.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("bascule AUTOMATIQUE quand le mode courant n'est plus actif", () => {
  it("mode = mattermost et Mattermost n'est plus actif ⇒ bascule sur `local`", () => {
    expect(
      resolveActiveMode(statut({ mode: "mattermost", mattermost: {}, discord: {} })),
    ).toBe("local");
  });

  it("mode actif ⇒ aucune bascule", () => {
    expect(
      resolveActiveMode(
        statut({ mode: "mattermost", mattermost: { jetonEnregistre: true }, discord: {} }),
      ),
    ).toBeNull();
    expect(resolveActiveMode(statut({ mode: "local", mattermost: {}, discord: {} }))).toBeNull();
  });

  it("aucune bascule quand l'état est INCONNU (on ne change pas un mode à l'aveugle)", () => {
    expect(resolveActiveMode(null)).toBeNull();
  });

  it("`app.js` applique la bascule par `saveChatMode` et redemande la trame `sessions`", () => {
    const source = readFileSync(join(ROOT, "public", "ui", "app.js"), "utf8");
    expect(source).toContain("resolveActiveMode");
    expect(source).toContain("basculeModeEnCours");
    expect(source).toContain('sendRaw({ type: "chat_refresh" })');
  });
});

// ─── ④ Débrancher / Supprimer dans /config ─────────────────────────────────

describe("textes de l'action destructive", () => {
  it("le décompte de ce qui sera perdu est AFFICHÉ (conversations, messages, taille)", () => {
    const texte = texteSuppression("mattermost", {
      conversations: 3,
      messages: 412,
      octets: 3 * 1024 * 1024,
    });
    expect(texte).toContain("3 conversations");
    expect(texte).toContain("412 messages");
    expect(texte).toContain("3,0 Mio");
    expect(texte).toContain("jeton du bot");
  });

  it("le débranchement ANNONCE que les conversations restent lisibles", () => {
    const texte = texteDebranchement("discord", { conversations: 2 });
    expect(texte).toContain("2 conversations");
    expect(texte).toContain("resteront lisibles");
    expect(texte).toContain("Débrancher Discord");
  });

  it("les tailles sont lisibles en français", () => {
    expect(formatOctets(0)).toBe("0 octet");
    expect(formatOctets(1)).toBe("1 octet");
    expect(formatOctets(900)).toBe("900 octets");
    expect(formatOctets(2048)).toBe("2,0 Kio");
    expect(formatOctets(5 * 1024 * 1024)).toBe("5,0 Mio");
  });

  it("la case à cocher est une FORMULE explicite, pas un simple « OK »", () => {
    expect(CONFIRMATION_SUPPRESSION).toContain("effacées définitivement");
    expect(CONFIRMATION_SUPPRESSION).toContain("ne pourront pas être récupérées");
    const source = readFileSync(join(ROOT, "public", "ui", "chat-panel.js"), "utf8");
    // ⚠️ Jamais `window.confirm` : confirmation par `HolafModal` (brique maison).
    expect(source).not.toContain("window.confirm(");
  });
});

describe("panneau /config — deux actions DISTINCTES", () => {
  interface Appel {
    url: string;
    method: string;
    body?: string;
  }

  /** `fetch` factice : sert le statut, mémorise les écritures. */
  function fetchFactice(etat: ReturnType<typeof statut>) {
    const appels: Appel[] = [];
    const impl = async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? "GET";
      appels.push({ url, method, ...(init?.body !== undefined ? { body: init.body } : {}) });
      if (method === "GET") {
        return { ok: true, status: 200, json: async () => etat };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };
    return { appels, impl };
  }

  interface ModaleFactice {
    appels: { confirm: unknown[]; open: Array<Record<string, unknown>> };
    confirm: (titre: string, message: string, opts?: unknown) => Promise<boolean>;
    open: (opts: Record<string, unknown>) => unknown;
    reponseConfirm: boolean;
  }

  /** Modale factice : rend un `ctrl` avec un pied contenant le bouton DANGER réel. */
  function modaleFactice(): ModaleFactice {
    const appels = { confirm: [] as unknown[], open: [] as Array<Record<string, unknown>> };
    const factice: ModaleFactice = {
      appels,
      reponseConfirm: true,
      confirm: async (titre, message, opts) => {
        appels.confirm.push({ titre, message, opts });
        return factice.reponseConfirm;
      },
      open: (opts) => {
        appels.open.push(opts);
        const pied = new Noeud("div");
        const danger = new Noeud("button");
        danger.setAttribute("class", "holaf-modal-btn-danger");
        pied.append(danger);
        const ctrl = { footer: pied, el: new Noeud("div"), close: () => undefined };
        (opts.onOpen as ((c: unknown) => void) | undefined)?.(ctrl);
        return ctrl;
      },
    };
    return factice;
  }

  async function monterPanneau(etat: ReturnType<typeof statut>, modale: ModaleFactice) {
    const racine = new Noeud("div");
    const { appels, impl } = fetchFactice(etat);
    const panneau = initChatPanel({
      root: racine,
      HolafModal: modale as never,
      fetchImpl: impl as never,
    });
    await panneau.refresh();
    // Laisse les éventuelles continuations asynchrones se terminer.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const boutons = trouver(racine, (noeud) => noeud.tag === "button");
    return { racine, panneau, appels, boutons };
  }

  const etatDeuxPlateformes = () =>
    statut({
      mode: "local",
      mattermost: { jetonEnregistre: true, canaux: 3 },
      discord: { jetonEnregistre: true, canaux: 1 },
    });

  it("présente « Débrancher » (discret) ET « Supprimer la connexion » (rouge)", async () => {
    const { boutons } = await monterPanneau(etatDeuxPlateformes(), modaleFactice());
    const debrancher = boutons.filter((bouton) => bouton.textContent === "Débrancher");
    const supprimer = boutons.filter((bouton) => bouton.textContent === "Supprimer la connexion");
    // Une paire par plateforme.
    expect(debrancher).toHaveLength(2);
    expect(supprimer).toHaveLength(2);
    // ⚠️ Le bouton destructeur est VISUELLEMENT dangereux (`button--stop`), l'autre non.
    for (const bouton of supprimer) expect(bouton.className).toContain("button--stop");
    for (const bouton of debrancher) expect(bouton.className).not.toContain("button--stop");
  });

  it("« Débrancher » envoie `DELETE /api/chat/<plateforme>/connexion` (miroir conservé)", async () => {
    const modale = modaleFactice();
    const { boutons, appels } = await monterPanneau(etatDeuxPlateformes(), modale);
    const bouton = boutons.find((noeud) => noeud.textContent === "Débrancher");
    if (!bouton) throw new Error("bouton « Débrancher » absent");
    bouton.declencher("click");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(modale.appels.confirm).toHaveLength(1);
    const appel = appels.find((entree) => entree.method === "DELETE");
    expect(appel?.url).toBe("/api/chat/mattermost/connexion");
  });

  it("« Débrancher » ANNULÉ n'envoie aucune requête", async () => {
    const modale = modaleFactice();
    modale.reponseConfirm = false;
    const { boutons, appels } = await monterPanneau(etatDeuxPlateformes(), modale);
    const bouton = boutons.find((noeud) => noeud.textContent === "Débrancher");
    if (!bouton) throw new Error("bouton « Débrancher » absent");
    bouton.declencher("click");
    await new Promise((resolve) => setTimeout(resolve, 0));
    // La confirmation a bien été DEMANDÉE (message : le miroir reste), puis annulée.
    expect(modale.appels.confirm).toHaveLength(1);
    expect(appels.some((entree) => entree.method === "DELETE")).toBe(false);
  });

  it("« Supprimer » exige la CASE À COCHER, puis envoie la confirmation au serveur", async () => {
    const modale = modaleFactice();
    const { boutons, appels } = await monterPanneau(etatDeuxPlateformes(), modale);
    // Le premier « Supprimer la connexion » est celui de Mattermost (ordre des sections).
    const bouton = boutons.find((noeud) => noeud.textContent === "Supprimer la connexion");
    if (!bouton) throw new Error("bouton « Supprimer la connexion » absent");
    bouton.declencher("click");
    await new Promise((resolve) => setTimeout(resolve, 0));

    // ① une modale dédiée a été ouverte (jamais `window.confirm`).
    expect(modale.appels.open).toHaveLength(1);
    const options = modale.appels.open[0] as {
      content: Noeud;
      buttons: Array<{ text: string; type?: string; onClick?: () => unknown }>;
      onOpen?: (ctrl: unknown) => void;
      onClose?: (resultat: unknown) => void;
    };
    // ② le contenu ANNONCE ce qui sera perdu.
    const textes = [options.content.textContent, ...descendants(options.content).map((n) => n.textContent)]
      .join(" ")
      .replace(/\s+/gu, " ");
    expect(textes).toContain("3 conversations");
    expect(textes).toContain("IRRÉVERSIBLE");
    // La case à cocher porte une formule EXPLICITE (pas un simple « OK »).
    expect(textes).toContain(CONFIRMATION_SUPPRESSION);

    // ③ le bouton destructeur est DÉSACTIVÉ tant que la case n'est pas cochée.
    const danger = options.buttons.find((entree) => entree.type === "danger");
    if (!danger) throw new Error("bouton destructeur absent de la modale");
    const caseACocher = trouver(options.content, (noeud) => noeud.tag === "input")[0];
    if (!caseACocher) throw new Error("case à cocher absente");
    expect(caseACocher.type).toBe("checkbox");
    // Sans case cochée, le clic du bouton destructeur REFUSE la fermeture.
    expect(danger.onClick?.()).toBe(false);

    // ④ on coche : le bouton devient actif, et la confirmation aboutit.
    caseACocher.checked = true;
    caseACocher.declencher("change");
    expect(danger.onClick?.()).toBe(true);
    options.onClose?.(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const appel = appels.find((entree) => entree.method === "DELETE");
    expect(appel?.url).toBe("/api/chat/mattermost/miroir");
    // ⚠️ Le serveur REFUSE sans ce corps : la confirmation est explicite dans la requête.
    expect(JSON.parse(appel?.body ?? "{}")).toEqual({ confirmation: true });
  });

  it("le bouton destructeur reste INACTIF tant que la case n'est pas cochée", async () => {
    const modale = modaleFactice();
    const { boutons } = await monterPanneau(etatDeuxPlateformes(), modale);
    boutons
      .find((noeud) => noeud.textContent === "Supprimer la connexion")
      ?.declencher("click");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const options = modale.appels.open[0] as { content: Noeud; onOpen?: (ctrl: unknown) => void };
    const pied = new Noeud("div");
    const dangerNode = new Noeud("button");
    dangerNode.setAttribute("class", "holaf-modal-btn-danger");
    pied.append(dangerNode);
    options.onOpen?.({ footer: pied });
    expect(dangerNode.disabled).toBe(true);
    const caseACocher = trouver(options.content, (noeud) => noeud.tag === "input")[0];
    if (!caseACocher) throw new Error("case à cocher absente");
    caseACocher.checked = true;
    caseACocher.declencher("change");
    expect(dangerNode.disabled).toBe(false);
  });
});
