/**
 * DEUX PAGES DE CONFIGURATION (lot 35d, sous-lot 1b-4) — ce que ce fichier
 * VERROUILLE :
 *
 *  ① **7 onglets** sur la page Instance (`config.html`), **6** sur la page Bot
 *    (`bots.html`), avec les libellés EXACTS et dans l'ordre ;
 *  ② la règle de PORTÉE : la page Instance ne rend que les clés `instance` /
 *    `mixte`, la page Bot que `bot` / `mixte` — croisée avec `CONFIG_SCHEMA`
 *    (l'autorité), pas avec un miroir ;
 *  ③ ⚠️ AUCUNE CLÉ PERDUE, AUCUNE CLÉ EN DOUBLE : chaque clé du catalogue est
 *    rendue sur les pages que sa portée autorise, exactement une fois par page ;
 *    une clé `mixte` est rendue sur LES DEUX ;
 *  ④ les ancres (`#declencheurs`, `#chat-remote-agents`…) tombent sur un onglet
 *    qui EXISTE sur la page visée ;
 *  ⑤ la modale à TROIS CHOIX du changement de bot (jamais `window.confirm(`) et
 *    la modale « bientôt disponible » de l'ajout ;
 *  ⑥ les gardes CSP/`innerHTML`/`.style.` s'appliquent AUX DEUX pages.
 *
 * ⚠️ ÉCHOUE SUR LE CODE D'ORIGINE : ni `public/ui/config-pages.js`, ni
 * `public/ui/config-fields.js`, ni `public/ui/bots.html` n'existent (l'import
 * du module échoue) — et `/config` y portait 10 onglets au lieu de 7.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { REMOTE_AGENTS_ANCHOR, REMOTE_TOOLS_ANCHOR } from "../../public/ui/chat-panel.js";
import { ALL_FIELDS, GROUPS } from "../../public/ui/config-fields.js";
import {
  ANCRES_PROFONDES,
  PAGES,
  champsDePage,
  demandeChangementBot,
  groupesParOnglet,
  idsOnglets,
  ligneDePage,
  modaleAjoutBot,
  ongletDuHash,
  ongletsDePage,
  porteeRendue,
  scopeDeCle,
} from "../../public/ui/config-pages.js";
import { CONFIG_SCHEMA } from "../../src/config/schema.js";

const lire = (nom: string): string =>
  readFileSync(join(process.cwd(), "public", "ui", nom), "utf8");

const CONFIG_HTML = lire("config.html");
const BOTS_HTML = lire("bots.html");
const CONFIG_JS = lire("config.js");
const INDEX_HTML = lire("index.html");

/** Groupe du catalogue par identifiant (présence garantie par les tests). */
const groupe = (id: string) => {
  const trouve = GROUPS.find((entree) => entree.id === id);
  if (!trouve) throw new Error(`groupe ${id} absent du catalogue`);
  return trouve;
};

/** Portée réelle de CHAQUE clé du catalogue (autorité = le schéma). */
const SCOPES: Record<string, string> = Object.fromEntries(
  Object.entries(CONFIG_SCHEMA).map(([path, descriptor]) => [path, descriptor.scope]),
);

/** Clés rendues par une page, avec leur nombre d'apparitions. */
function clesRendues(page: string): Map<string, number> {
  const vues = new Map<string, number>();
  for (const [, groupes] of Object.entries(groupesParOnglet(page, GROUPS))) {
    for (const group of groupes) {
      for (const field of champsDePage(page, group, SCOPES)) {
        vues.set(field.path, (vues.get(field.path) ?? 0) + 1);
      }
    }
  }
  return vues;
}

/** Libellés d'onglets lus dans un fichier HTML (ordre du DOM). */
function libellesHtml(html: string): string[] {
  return [...html.matchAll(/<button[^>]*role="tab"[^>]*>\s*([^<]+)/g)].map((m) => m[1].trim());
}

describe("① deux pages, deux jeux d'onglets", () => {
  it("la page INSTANCE déclare 7 onglets, libellés exacts et dans l'ordre", () => {
    expect(PAGES.instance.scopes).toEqual(["instance", "mixte"]);
    expect(libellesHtml(CONFIG_HTML)).toEqual([
      "Modèles",
      "Exécution",
      "Images",
      "Agents",
      "Secrets",
      "Système",
      "Maintenance",
    ]);
    // Le markup et le module pur disent la MÊME chose (une seule vérité).
    expect(libellesHtml(CONFIG_HTML)).toEqual(
      ongletsDePage("instance").map((onglet) => onglet.libelle),
    );
    expect([...CONFIG_HTML.matchAll(/role="tab"/g)].length).toBe(7);
    expect([...CONFIG_HTML.matchAll(/role="tabpanel"/g)].length).toBe(7);
  });

  it("la page BOT déclare 6 onglets, libellés exacts et dans l'ordre", () => {
    expect(PAGES.bot.scopes).toEqual(["bot", "mixte"]);
    expect(libellesHtml(BOTS_HTML)).toEqual([
      "Général",
      "Personnalité",
      "Voix",
      "Mémoire",
      "Plateformes",
      "Déclencheurs",
    ]);
    expect(libellesHtml(BOTS_HTML)).toEqual(
      ongletsDePage("bot").map((onglet) => onglet.libelle),
    );
    expect([...BOTS_HTML.matchAll(/role="tab"/g)].length).toBe(6);
    expect([...BOTS_HTML.matchAll(/role="tabpanel"/g)].length).toBe(6);
    // La page se DÉCLARE comme page de bot (c'est ce que lit `config.js`).
    expect(BOTS_HTML).toContain('data-config-page="bot"');
    expect(CONFIG_HTML).toContain('data-config-page="instance"');
  });

  it("chaque onglet qui porte des champs a son panneau ET son conteneur", () => {
    for (const [page, html] of [
      ["instance", CONFIG_HTML],
      ["bot", BOTS_HTML],
    ] as const) {
      for (const onglet of idsOnglets(page)) {
        expect(html, `${page}/${onglet}`).toContain(`id="panel-${onglet}"`);
        expect(html, `${page}/${onglet}`).toContain(`aria-controls="panel-${onglet}"`);
      }
      // Un groupe rendu sur cette page ⇒ le conteneur `#group-<onglet>` existe,
      // sinon ses lignes seraient silencieusement perdues au rendu.
      for (const [onglet, groupes] of Object.entries(groupesParOnglet(page, GROUPS))) {
        if (groupes.length === 0) continue;
        expect(html, `${page} → #group-${onglet}`).toContain(`id="group-${onglet}"`);
      }
    }
  });

  it("une ligne d'explication sous le titre, sur CHAQUE page (④)", () => {
    expect(CONFIG_HTML).toContain('id="page-ligne"');
    expect(BOTS_HTML).toContain('id="page-ligne"');
    expect(ligneDePage("instance")).toContain("Restent communs");
    expect(ligneDePage("bot")).toContain("Ce qui est propre à un bot est dans Bot");
    // Remplie par le module (aucune phrase figée en double dans le markup).
    expect(CONFIG_JS).toContain("pageLigneEl.textContent = ligneDePage(PAGE)");
  });

  it("le catalogue ne contient AUCUNE clé fantôme (toutes existent au schéma)", () => {
    const inconnues = ALL_FIELDS.filter((field) => !(field.path in CONFIG_SCHEMA)).map(
      (field) => field.path,
    );
    expect(inconnues).toEqual([]);
    // Et chaque groupe déclare ses onglets : un groupe sans `tabs` ne serait
    // rendu NULLE PART.
    const sansOnglet = GROUPS.filter(
      (group) => typeof group.tabs !== "object" || Object.keys(group.tabs).length === 0,
    ).map((group) => group.id);
    expect(sansOnglet).toEqual([]);
  });
});

describe("②③ la PORTÉE décide de ce qui est rendu, une seule fois par page", () => {
  it("la page Instance ne rend QUE des clés `instance` ou `mixte`", () => {
    const fautives = [...clesRendues("instance").keys()].filter(
      (path) => scopeDeCle(SCOPES, path) === "bot",
    );
    expect(fautives).toEqual([]);
    expect(porteeRendue("instance", "bot")).toBe(false);
    expect(porteeRendue("instance", "instance")).toBe(true);
    expect(porteeRendue("instance", "mixte")).toBe(true);
  });

  it("la page Bot ne rend QUE des clés `bot` ou `mixte`", () => {
    const fautives = [...clesRendues("bot").keys()].filter(
      (path) => scopeDeCle(SCOPES, path) === "instance",
    );
    expect(fautives).toEqual([]);
    expect(porteeRendue("bot", "instance")).toBe(false);
    expect(porteeRendue("bot", "bot")).toBe(true);
    expect(porteeRendue("bot", "mixte")).toBe(true);
  });

  it("⚠️ chaque clé du catalogue est rendue EXACTEMENT une fois par page autorisée", () => {
    const instance = clesRendues("instance");
    const bot = clesRendues("bot");
    for (const field of ALL_FIELDS) {
      const scope = scopeDeCle(SCOPES, field.path);
      const surInstance = instance.get(field.path) ?? 0;
      const surBot = bot.get(field.path) ?? 0;
      if (scope === "instance") {
        expect(surInstance, `${field.path} (instance)`).toBe(1);
        expect(surBot, `${field.path} (instance) ne doit PAS être sur la page Bot`).toBe(0);
      } else if (scope === "bot") {
        expect(surBot, `${field.path} (bot)`).toBe(1);
        expect(surInstance, `${field.path} (bot) ne doit PAS être sur la page Instance`).toBe(0);
      } else {
        // ⚠️ Une clé `mixte` est rendue sur LES DEUX pages : valeur commune sur
        // Instance, SURCHARGE du bot sur la page Bot. Jamais deux fois sur la même.
        expect(surInstance, `${field.path} (mixte → Instance)`).toBe(1);
        expect(surBot, `${field.path} (mixte → Bot)`).toBe(1);
      }
    }
  });

  it("⚠️ aucune clé `bot` du catalogue n'est PERDUE, aucune n'est en DOUBLE", () => {
    const bot = clesRendues("bot");
    const clesBot = ALL_FIELDS.map((field) => field.path).filter(
      (path) => scopeDeCle(SCOPES, path) === "bot",
    );
    // Aucune perdue : toutes présentes.
    expect(clesBot.filter((path) => (bot.get(path) ?? 0) === 0)).toEqual([]);
    // Aucune en double.
    expect([...bot.entries()].filter(([, n]) => n > 1).map(([path]) => path)).toEqual([]);
    // Le total de la page est la somme exacte : clés `bot` + clés `mixte`.
    const mixtes = ALL_FIELDS.map((field) => field.path).filter(
      (path) => scopeDeCle(SCOPES, path) === "mixte",
    );
    expect(bot.size).toBe(clesBot.length + mixtes.length);
  });

  it("les 5 clés MIXTES sont bien celles du schéma (aucune dérive)", () => {
    const mixtesSchema = Object.entries(SCOPES)
      .filter(([, scope]) => scope === "mixte")
      .map(([path]) => path)
      .sort();
    const mixtesCatalogue = ALL_FIELDS.map((field) => field.path)
      .filter((path) => scopeDeCle(SCOPES, path) === "mixte")
      .sort();
    expect(mixtesCatalogue).toEqual(mixtesSchema);
    expect(mixtesSchema).toEqual([
      "memory.consolidation.enabled",
      "prompts.heavy",
      "prompts.light",
      "push.enabled",
      "tts.enabled",
    ]);
  });

  it("les clés `bot` rendues par un AUTRE composant restent couvertes", () => {
    // `tts.voice` est écrit par la bibliothèque des voix ; `chat.*` par le
    // panneau des plateformes et le sélecteur de mode. Ces clés ne sont pas des
    // champs de formulaire : elles ne doivent PAS être dans le catalogue (sinon
    // deux contrôles écriraient la même clé), mais leur propriétaire doit exister.
    const ailleurs: Record<string, string> = {
      "tts.voice": "voices-panel.js",
      "chat.mode": "chat-mode.js",
      "chat.remoteAgents": "chat-panel.js",
      "chat.remoteTools": "chat-panel.js",
    };
    for (const [path, fichier] of Object.entries(ailleurs)) {
      expect(ALL_FIELDS.some((field) => field.path === path), path).toBe(false);
      expect(lire(fichier), `${path} dans ${fichier}`).toContain(path);
    }
  });

  it("`config.js` filtre par portée à l'ÉCRITURE aussi (jamais deux routes à la fois)", () => {
    // Page Bot : tout le patch part sur la route du bot (portée `bot`).
    expect(CONFIG_JS).toContain("cheminConfigBot(botCourant?.id ?? BOT_REPLI)");
    // Page Instance : découpage de la portée, comme depuis le sous-lot 1b-3.
    expect(CONFIG_JS).toContain("splitConfigPatchByScope(patch, scopesOfState())");
    // La lecture suit la même règle.
    expect(CONFIG_JS).toContain('const url = PAGE_BOT');
    expect(CONFIG_JS).toContain(': "/api/config";');
  });
});

describe("④ ancres : elles tombent sur un onglet qui EXISTE", () => {
  it("la page Bot porte les ancres des réglages qui y ont déménagé", () => {
    const ancres = new Map(ANCRES_PROFONDES.bot);
    // ⚠️ Les deux ancres du panneau des discussions sont EXACTEMENT celles que
    // `chat-panel.js` exporte (aucune chaîne recopiée qui dérive).
    expect(ancres.get(REMOTE_AGENTS_ANCHOR)).toBe("plateformes");
    expect(ancres.get(REMOTE_TOOLS_ANCHOR)).toBe("plateformes");
    expect(ancres.get("declencheurs")).toBe("declencheurs");
    expect(ancres.get("sources")).toBe("declencheurs");
    expect(ancres.get("journal-declencheurs")).toBe("declencheurs");
    for (const [, onglet] of ancres) {
      expect(idsOnglets("bot"), onglet).toContain(onglet);
    }
    // La cible de l'ancre EXISTE dans le markup : le panneau des sources est
    // monté dans `#sources-root`, lui-même dans le panneau « Déclencheurs ».
    const panneau = BOTS_HTML.slice(
      BOTS_HTML.indexOf('id="panel-declencheurs"'),
      BOTS_HTML.indexOf("</main>"),
    );
    expect(panneau).toContain('id="sources-root"');
    expect(BOTS_HTML).toContain('id="tab-declencheurs"');
  });

  it("le hash d'un onglet connu ouvre cet onglet, un inconnu n'ouvre rien", () => {
    expect(ongletDuHash("bot", "#voix")).toBe("voix");
    expect(ongletDuHash("bot", "declencheurs")).toBe("declencheurs");
    expect(ongletDuHash("instance", "#systeme")).toBe("systeme");
    // « Déclencheurs » n'est PLUS un onglet de l'instance.
    expect(ongletDuHash("instance", "#declencheurs")).toBe(null);
    expect(ongletDuHash("instance", "#conversation")).toBe(null);
    expect(ongletDuHash("bot", "#nimporte-quoi")).toBe(null);
  });

  it("⚠️ le lien de la barre latérale vise la page du BOT", () => {
    expect(INDEX_HTML).toContain('href="/bots?b=yuki#declencheurs"');
    expect(INDEX_HTML).not.toContain('href="/config#declencheurs"');
    // Les trois autres entrées déplacées du menu téléphone suivent.
    expect(INDEX_HTML).toContain('href="/bots?b=yuki#personnalite"');
    expect(INDEX_HTML).toContain('href="/bots?b=yuki#memoire"');
    expect(INDEX_HTML).toContain('href="/bots?b=yuki#voix"');
    // Ce qui est resté commun ne bouge pas.
    expect(INDEX_HTML).toContain('href="/config#systeme"');
    expect(INDEX_HTML).toContain('href="/config#agents"');
    expect(INDEX_HTML).toContain('href="/config#secrets"');
  });

  it("chaque page renvoie vers l'autre (on ne cherche pas un réglage disparu)", () => {
    expect(CONFIG_HTML).toContain('href="/bots"');
    expect(BOTS_HTML).toContain('href="/config"');
  });
});

describe("④ encarts de renvoi : un groupe déplacé DIT où il est allé", () => {
  const avecRenvoi = GROUPS.filter((group) => group.renvoi);

  it("les groupes éclatés portent un renvoi sur AU MOINS une page", () => {
    const ids = avecRenvoi.map((group) => group.id);
    for (const id of ["prompts", "memoire", "tts", "notifications", "sources"]) {
      expect(ids, id).toContain(id);
    }
  });

  it("la VOIX renvoie vers la page Bot, et la page Bot vers le MOTEUR (Système)", () => {
    const tts = groupe("tts");
    expect(tts?.renvoi?.instance?.lien).toEqual({
      href: "/bots#voix",
      libelle: "Bot · Voix",
    });
    expect(tts?.renvoi?.bot?.lien).toEqual({
      href: "/config#systeme",
      libelle: "Configuration · Système",
    });
    // ⚠️ Les 9 clés TECHNIQUES de la voix restent côté Instance · Système.
    const techniques = [
      "tts.enabled",
      "tts.engine",
      "tts.baseUrl",
      "tts.language",
      "tts.prefetchDepth",
      "tts.minSentenceChars",
      "tts.maxSentenceChars",
      "tts.timeoutMs",
      "tts.volume",
    ];
    for (const path of techniques) {
      expect(champsDePage("instance", tts, SCOPES).map((field) => field.path), path).toContain(path);
    }
    expect(champsDePage("instance", tts, SCOPES).length).toBe(9);
    // Sur la page Bot, seules les clés de la voix du bot restent.
    expect(champsDePage("bot", tts, SCOPES).map((field) => field.path).sort()).toEqual([
      "tts.cfg",
      "tts.emotion",
      "tts.enabled",
      "tts.exaggeration",
      "tts.speed",
    ]);
  });

  it("chaque renvoi a un texte ET un lien vers un onglet qui existe", () => {
    for (const group of avecRenvoi) {
      for (const [page, renvoi] of Object.entries(group.renvoi ?? {})) {
        expect(typeof (renvoi as { texte?: string }).texte, group.id).toBe("string");
        expect((renvoi as { texte: string }).texte.length, group.id).toBeGreaterThan(20);
        const lien = (renvoi as { lien?: { href: string } }).lien;
        expect(lien, `${group.id}/${page}`).toBeTruthy();
        // Le lien vise une page connue, avec un onglet qui y existe vraiment.
        const [chemin, hash = ""] = String(lien?.href ?? "").split("#");
        const cible = chemin === "/bots" ? "bot" : "instance";
        expect(["bot", "instance"], etiquette(page)).toContain(cible);
        expect(hash === "" || idsOnglets(cible).includes(hash), `${group.id} → ${hash}`).toBe(true);
      }
    }
    // Le rendu existe (et n'utilise que `textContent` + un `<a>` : CSP inchangée).
    expect(CONFIG_JS).toContain("function renderRenvoi(");
    expect(CONFIG_JS).toContain("config-renvoi__lien");
  });

  function etiquette(id: string): string {
    return `groupe ${id}`;
  }
});

describe("⑤ sélecteur de bot : état dans l'URL, modales HolafModal", () => {
  it("`?b=` est respecté et un slug INCONNU retombe sur `yuki`, sans erreur", () => {
    expect(CONFIG_JS).toContain('new URLSearchParams(location.search).get("b")');
    expect(CONFIG_JS).toContain('const BOT_REPLI = "yuki"');
    // Repli : le bot demandé, sinon `yuki`, sinon le bot actif, sinon le premier.
    expect(CONFIG_JS).toContain("parId(demande) ?? parId(BOT_REPLI) ?? actif ?? botsConnus[0]");
    // L'URL est réécrite avec le bot réellement affiché (lien partageable).
    expect(CONFIG_JS).toContain('url.searchParams.set("b", botCourant.id)');
    // Aucune erreur visible pour un slug inconnu : pas de bandeau d'erreur dédié.
    expect(BOTS_HTML).toContain('id="bot-select"');
    expect(BOTS_HTML).toContain('id="bot-add"');
  });

  it("des modifications non enregistrées ⇒ TROIS choix, jamais `window.confirm(`", () => {
    const modale = demandeChangementBot({ sale: true, botActuel: "yuki", botVise: "nova" });
    expect(modale).toBeTruthy();
    expect(modale?.boutons.map((bouton) => bouton.text)).toEqual([
      "Enregistrer",
      "Abandonner",
      "Rester sur ce bot",
    ]);
    expect(modale?.boutons.map((bouton) => bouton.value)).toEqual([
      "enregistrer",
      "abandonner",
      "rester",
    ]);
    // Le bot visé est NOMMÉ : on sait ce qu'on quitte et ce qu'on ouvre.
    expect(modale?.message).toContain("nova");
    expect(modale?.titre).toBe("Modifications non enregistrées");
    // Rien en attente ⇒ aucune modale (le changement ne demande rien).
    expect(demandeChangementBot({ sale: false, botVise: "nova" })).toBe(null);
    // La modale est ouverte par HolafModal (brique), avec un choix par bouton.
    expect(CONFIG_JS).toContain("HolafModal.open({");
    expect(CONFIG_JS).toContain("_onResolve");
    // ⚠️ Une fermeture par ✕ ou Échap vaut « rester » : on ne change pas de bot
    // et on ne jette rien en silence.
    expect(CONFIG_JS).toContain('typeof valeur === "string" ? valeur : "rester"');
    expect(CONFIG_JS).not.toContain("window.confirm(");
  });

  it("« ＋ » annonce que l'écran d'ajout est un lot ULTÉRIEUR (il ne crée rien)", () => {
    const spec = modaleAjoutBot();
    expect(spec.titre).toContain("bientôt disponible");
    expect(spec.message).toContain("lot ultérieur");
    expect(CONFIG_JS).toContain("modaleAjoutBot()");
    // Aucun appel d'écriture de bot n'est fait par ce bouton.
    expect(CONFIG_JS).not.toContain('post("/api/bots"');
    expect(CONFIG_JS).not.toContain('put("/api/bots"');
  });

  it("la zone de danger de « Général » n'offre AUCUN bouton de suppression", () => {
    expect(BOTS_HTML).toContain('id="bot-general-root"');
    // Les informations sont en LECTURE SEULE, et la suppression est annoncée
    // comme un lot ultérieur — sans bouton inerte.
    expect(CONFIG_JS).toContain("function renderBotGeneral()");
    expect(CONFIG_JS).toContain("La suppression d'un bot n'est PAS disponible ici");
    expect(CONFIG_JS).not.toContain("delete(\"/api/bots");
    expect(CONFIG_JS).not.toContain("Supprimer ce bot");
  });
});

describe("⑥ gardes CSP : elles s'appliquent AUX DEUX pages", () => {
  it("aucun innerHTML, aucun window.confirm(, aucun style inline dans le code servi", () => {
    for (const nom of ["config.js", "config-fields.js", "config-pages.js"]) {
      const source = lire(nom);
      expect(source, nom).not.toContain("innerHTML");
      expect(source, nom).not.toContain("window.confirm(");
      expect(source, nom).not.toContain(".style.");
      expect(source, nom).not.toContain('setAttribute("style"');
    }
  });

  it("aucun attribut style= dans le markup des DEUX pages", () => {
    for (const nom of ["config.html", "bots.html"]) {
      const html = lire(nom);
      expect(html, nom).not.toMatch(/\sstyle=/);
      expect(html, nom).not.toContain("innerHTML");
      expect(html, nom).not.toContain("window.confirm(");
    }
  });

  it("les deux pages chargent le MÊME module et la MÊME feuille (une seule vérité)", () => {
    expect(CONFIG_HTML).toContain('src="/ui/config.js"');
    expect(BOTS_HTML).toContain('src="/ui/config.js"');
    expect(CONFIG_HTML).toContain('href="/ui/config.css"');
    expect(BOTS_HTML).toContain('href="/ui/config.css"');
    // Le CSS des encarts de renvoi et du sélecteur est livré.
    const css = lire("config.css");
    for (const classe of [
      ".config-page-line",
      ".config-renvoi",
      ".config-renvoi__lien",
      ".bot-selecteur",
      ".bot-info",
      ".bot-danger",
    ]) {
      expect(css, classe).toContain(classe);
    }
  });
});
