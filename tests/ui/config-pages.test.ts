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
 *  ⑤ la modale à TROIS CHOIX du changement de bot (jamais `window.confirm(`) ;
 *  ⑤bis ⚠️ LOT 35e : la modale d'AJOUT crée vraiment (plus de « bientôt
 *    disponible ») et la zone de danger porte la SUPPRESSION — les deux
 *    assertions de ⑤ qui décrivaient l'ancien report ont été INVERSÉES, avec
 *    leurs libellés, pas supprimées ;
 *  ⑥ les gardes CSP/`innerHTML`/`.style.` s'appliquent AUX DEUX pages ET à tout
 *    nouveau fichier d'interface (`bots-admin.js`).
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
  CAPACITES_PAGE,
  CLONE_ELEMENTS,
  MAX_BOTS_PAGE,
  NOM_BOT_MAX_PAGE,
  PHRASE_CAPACITES,
  RETENTION_ARCHIVES_JOURS_PAGE,
  confirmationSuppressionBot,
  defautsClone,
  libelleTaille,
  ligneDePage,
  modaleCreationBot,
  ongletDuHash,
  ongletsDePage,
  porteeRendue,
  scopeDeCle,
  texteSuppressionBot,
  validerCreationBot,
} from "../../public/ui/config-pages.js";
import {
  ELEMENTS_CLONE,
  MAX_BOTS,
  NOM_BOT_MAX,
  RETENTION_ARCHIVES_JOURS,
} from "../../src/bots/admin.js";
import { CAPACITES_BOT } from "../../src/bots/registry.js";
import { OUTILS_DES_CAPACITES } from "../../src/llm/index.js";
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

  // ⚠️ LOT 35e — INVERSION ASSUMÉE de l'assertion précédente (« bientôt
  // disponible ») : la décision utilisateur est que l'écran d'ajout existe.
  // Le test garde son rôle : il vérifie ce que fait réellement « ＋ ».
  it("« ＋ » ouvre la VRAIE modale de création (POST /api/bots, plus de report)", () => {
    const spec = modaleCreationBot({ bots: [{ id: "yuki", nom: "Yuki" }] });
    expect(spec.titre).toBe("Ajouter un bot");
    expect(spec.message).not.toContain("bientôt disponible");
    expect(spec.message).not.toContain("lot ultérieur");
    expect(spec.cloneables).toEqual([{ id: "yuki", libelle: "Yuki (yuki)" }]);
    // ⚠️ LOT 35h — CRÉATION SIMPLE : plus aucun choix de profil dans la modale
    // (ni capacités, ni slug : le serveur les dérive). La clé `profils` a disparu.
    expect(spec).not.toHaveProperty("profils");
    expect(CONFIG_JS).not.toContain("bot-creation-profil");
    // Le bouton ouvre la modale (brique HolafModal) et la création est réelle.
    expect(CONFIG_JS).toContain("ouvrirCreationBot({ HolafModal, bots: botsConnus })");
    const admin = lire("bots-admin.js");
    expect(admin).toContain('fetch("/api/bots"');
    expect(admin).toContain('method: "POST"');
    expect(admin).toContain('"x-yuki-config": "1"');
    // Après création, la page bascule sur le nouveau bot.
    expect(CONFIG_JS).toContain("location.assign(urlBot(cree.id))");
  });

  // ⚠️ LOT 35e — seconde INVERSION ASSUMÉE : la zone de danger porte désormais
  // la suppression (archivage 90 jours), plus une promesse de lot ultérieur.
  it("la zone de danger de « Général » propose une VRAIE suppression (archivage)", () => {
    expect(BOTS_HTML).toContain('id="bot-general-root"');
    expect(CONFIG_JS).toContain("function renderBotGeneral()");
    // Le bouton existe et le texte dit que RIEN n'est effacé.
    expect(CONFIG_JS).toContain('text: "Supprimer ce bot"');
    expect(CONFIG_JS).toContain("N'EFFACE RIEN");
    expect(CONFIG_JS).toContain("CONSERVÉES 3 mois");
    expect(CONFIG_JS).toContain("ouvrirSuppressionBot({ HolafModal, bot: botCourant })");
    const admin = lire("bots-admin.js");
    expect(admin).toContain('method: "DELETE"');
    // Confirmation FORTE (motif du lot 30) : case à cocher qui ACTIVE le bouton.
    expect(admin).toContain('type: "checkbox"');
    expect(admin).toContain(".holaf-modal-btn-danger");
    expect(admin).toContain("bouton.disabled = laCase.checked !== true");
  });
});

describe("⑤bis ajout / clone / suppression — les données décidées", () => {
  it("les défauts de clonage sont ceux décidés : identité+capacités OUI, le reste NON", () => {
    expect(defautsClone()).toEqual({
      identite: true,
      capacites: true,
      memoire: false,
      declencheurs: false,
      agents: false,
    });
    // L'interface et le SERVEUR décrivent les mêmes éléments, dans le même ordre.
    expect(CLONE_ELEMENTS.map((element) => element.id)).toEqual(
      ELEMENTS_CLONE.map((element) => element.id),
    );
    for (const element of ELEMENTS_CLONE) {
      const pendant = CLONE_ELEMENTS.find((entree) => entree.id === element.id);
      expect(pendant, element.id).toBeTruthy();
      expect(pendant?.defaut, element.id).toBe(element.defaut);
      expect(Boolean(pendant?.indisponible), element.id).toBe(Boolean(element.indisponible));
    }
    // « Mémoire » décochée : un clone croirait avoir vécu la même chose.
    const memoire = CLONE_ELEMENTS.find((element) => element.id === "memoire");
    expect(memoire?.aide).toContain("croirait avoir vécu la même chose");
  });

  it("les bornes de l'interface sont celles du serveur (6 / 40 / 90)", () => {
    expect(MAX_BOTS_PAGE).toBe(MAX_BOTS);
    expect(NOM_BOT_MAX_PAGE).toBe(NOM_BOT_MAX);
    expect(RETENTION_ARCHIVES_JOURS_PAGE).toBe(RETENTION_ARCHIVES_JOURS);
    // ⚠️ Le slug n'est plus saisi : aucune copie de motif côté interface à garder
    // synchronisée (il est dérivé et validé par le serveur).
    expect(CONFIG_JS).not.toContain("bot-creation-slug");
  });

  it("`validerCreationBot` ne demande QUE le nom (vide et trop long refusés)", () => {
    expect(validerCreationBot({ nom: "" }).champs.nom).toContain("obligatoire");
    expect(validerCreationBot({ nom: "   " }).champs.nom).toContain("obligatoire");
    expect(validerCreationBot({}).champs.nom).toContain("obligatoire");
    expect(
      validerCreationBot({ nom: "n".repeat(NOM_BOT_MAX_PAGE + 1) }).champs.nom,
    ).toContain("trop long");
    // Cas nominal : un nom suffit, rien d'autre n'est demandé.
    const ok = validerCreationBot({ nom: "  Kohai  " });
    expect(ok.ok).toBe(true);
    expect(ok.champs).toEqual({});
    // Le formulaire ne produit plus de slug : c'est le SERVEUR qui le dérive.
    expect(ok).not.toHaveProperty("slug");
  });

  it("la modale de création annonce la limite de 6 bots", () => {
    const spec = modaleCreationBot({ bots: Array.from({ length: 6 }, (_, i) => ({ id: `b${i}` })) });
    expect(spec.maxBots).toBe(MAX_BOTS_PAGE);
    expect(spec.atteint).toBe(true);
    expect(spec.limite).toContain(String(MAX_BOTS_PAGE));
    expect(CONFIG_JS).toContain("Limite de bots atteinte");
  });

  it("la confirmation de suppression affiche les COMPTEURS réels et la rétention", () => {
    const texte = texteSuppressionBot({
      bot: { id: "kohai", nom: "Kohai" },
      compteurs: { conversations: 3, souvenirs: 12, declencheurs: 2, octets: 2048 },
      retentionJours: RETENTION_ARCHIVES_JOURS,
    });
    expect(texte).toContain("Kohai (kohai)");
    expect(texte).toContain("3 conversation(s)");
    expect(texte).toContain("12 souvenir(s)");
    expect(texte).toContain("2 déclencheur(s)");
    expect(texte).toContain("2,0 ko");
    expect(texte).toContain("CONSERVÉES 3 mois (90 jours)");
    expect(texte).toContain("effacées");
    // La case à cocher est EXPLICITE (pas un simple « OK »).
    expect(confirmationSuppressionBot()).toContain("conservées 3 mois");
    // Taille lisible (jamais un nombre d'octets brut).
    expect(libelleTaille(0)).toBe("0 o");
    expect(libelleTaille(1024)).toBe("1,0 ko");
    expect(libelleTaille(3 * 1024 * 1024)).toBe("3,0 Mo");
  });
});

describe("⑥ gardes CSP : elles s'appliquent AUX DEUX pages", () => {
  it("aucun innerHTML, aucun window.confirm(, aucun style inline dans le code servi", () => {
    for (const nom of ["config.js", "config-fields.js", "config-pages.js", "bots-admin.js"]) {
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

describe("⑦ CAPACITÉS d'un bot (lot 35h) — une case par famille, décochées au départ", () => {
  /**
   * Mot-clé attendu dans l'aide d'une capacité ↔ OUTIL qui porte cette capacité.
   *
   * ⚠️ Ce couplage est le garde-fou anti-divergence : le libellé et l'aide sont une
   * COPIE rédigée à la main, la table d'outils est l'autorité
   * (`OUTILS_DES_CAPACITES`). Si une capacité gagne une famille d'outils sans que
   * son aide bouge, la garde tombe.
   */
  const MOTS: ReadonlyArray<{ capacite: string; mots: readonly string[] }> = [
    { capacite: "fichiers", mots: ["fichier"] },
    { capacite: "envoi", mots: ["conversation"] },
    { capacite: "libraire", mots: ["bibliothèque"] },
    { capacite: "web", mots: ["page web"] },
    { capacite: "images", mots: ["image"] },
    { capacite: "agents", mots: ["machine"] },
    { capacite: "execution", mots: ["commande"] },
    { capacite: "delegation", mots: ["travail"] },
    { capacite: "secrets", mots: ["coffre"] },
    { capacite: "programmation", mots: ["programmer"] },
    { capacite: "memoire", mots: ["vie antérieure"] },
    { capacite: "builtins", mots: ["read", "grep"] },
  ];

  it("les cases de l'interface sont EXACTEMENT les capacités du registre", () => {
    expect(CAPACITES_PAGE.map((capacite) => capacite.id)).toEqual([...CAPACITES_BOT]);
  });

  it("chaque capacité a un libellé court et une ligne d'explication", () => {
    for (const capacite of CAPACITES_PAGE) {
      expect(typeof capacite.libelle, capacite.id).toBe("string");
      expect(capacite.libelle.trim().length, capacite.id).toBeGreaterThan(2);
      expect(capacite.libelle.length, capacite.id).toBeLessThanOrEqual(30);
      expect(capacite.aide.trim().length, capacite.id).toBeGreaterThan(20);
      expect(capacite.aide.trim().endsWith("."), capacite.id).toBe(true);
    }
  });

  it("l'aide de chaque case nomme ce que la capacité ouvre VRAIMENT", () => {
    for (const { capacite, mots } of MOTS) {
      const entree = CAPACITES_PAGE.find((candidat) => candidat.id === capacite);
      expect(entree, capacite).toBeTruthy();
      // Garde croisée : la capacité existe bien dans la table serveur.
      expect(Object.keys(OUTILS_DES_CAPACITES), capacite).toContain(capacite);
      for (const mot of mots) {
        expect(entree?.aide.toLowerCase(), `${capacite} / ${mot}`).toContain(mot);
      }
    }
  });

  it("la phrase fixe de l'onglet Général est celle décidée", () => {
    expect(PHRASE_CAPACITES).toBe(
      "Un bot peut toujours répondre. Tout le reste s'autorise ici.",
    );
    // ⚠️ Garde de RENDU : la phrase doit être AFFICHÉE (pas seulement définie).
    expect(CONFIG_JS).toContain("PHRASE_CAPACITES");
    expect(CONFIG_JS).toContain("CAPACITES_PAGE");
    expect(CONFIG_JS).toContain("bot-capacite-");
    // Aucun champ « Profil » ne subsiste sur la page du bot.
    expect(CONFIG_JS).not.toContain("profilDePage");
    expect(CONFIG_JS).not.toContain("ligneLecture(\"Profil\"");
  });

  it("l'enregistrement passe par PATCH /api/bots/<id> (les cases reprennent l'état réel en cas d'échec)", () => {
    expect(CONFIG_JS).toContain("method: \"PATCH\"");
    expect(CONFIG_JS).toContain("capacites: demandees");
    // Échec ⇒ on REMET l'état réel (aucune case qui mente).
    expect(CONFIG_JS).toContain("laCase.checked = cochees.has(id)");
  });

  it("la création ne porte AUCUNE case de capacité (elles vivent dans Général)", () => {
    const admin = lire("bots-admin.js");
    const creation = admin.slice(
      admin.indexOf("export function ouvrirCreationBot"),
      admin.indexOf("export async function ouvrirSuppressionBot"),
    );
    // Aucune case de capacité dans la création (l'identifiant des cases vit dans
    // la section « Général » : `bot-capacite-<bot>-<capacité>`).
    expect(creation).not.toContain("bot-capacite");
    expect(creation).not.toContain("CAPACITES_PAGE");
    expect(creation).not.toContain("profil");
    expect(creation).toContain('fetch("/api/bots"');
    // Le corps envoyé est le NOM (et l'avatar/clone facultatifs), rien d'autre.
    expect(creation).toContain("nom: champNom.value.trim()");
    expect(creation).not.toContain("slug:");
  });
});


/**
 * ⚠️ LOT 35i — ONGLET « MÉMOIRE » DE LA PAGE BOT, ET SESSIONS Pi DANS LA
 * PHRASE DE SUPPRESSION.
 *
 * Ce que ce bloc verrouille :
 *  - les **8 clés `bot`** de la mémoire durable sont TOUTES dans l'onglet
 *    « Mémoire » de `/bots` (les deux bornes de mise de côté y manquaient), avec
 *    l'interrupteur MIXTE `memory.consolidation.enabled` ;
 *  - la phrase de suppression NOMME les sessions Pi et dit qu'elles sont
 *    copiées dans l'archive — ou qu'elles restent en place si la copie échoue ;
 *  - l'interface PRÉVIENT quand l'API remonte `sessionsPi.etat === "echec"`.
 */
describe("⑧ LOT 35i — onglet « Mémoire » d'un bot et sessions Pi", () => {
  const CLES_MEMOIRE_BOT = [
    "memory.enabled",
    "memory.recall.topK",
    "memory.recall.budgetChars",
    "memory.recall.timeoutMs",
    "memory.extract.maxItems",
    "memory.extract.timeoutMs",
    "memory.setAside.maxChars",
    "memory.setAside.maxChunks",
  ];

  it("les 8 clés `bot` + l'interrupteur de consolidation sont dans l'onglet Mémoire du bot", () => {
    const onglets = groupesParOnglet("bot", GROUPS);
    const memoire = onglets.memoire ?? [];
    const cles = new Set(
      memoire.flatMap((entree) => champsDePage("bot", entree, SCOPES).map((f) => f.path)),
    );
    for (const cle of CLES_MEMOIRE_BOT) {
      expect(cles.has(cle), cle).toBe(true);
      // Ce sont bien des clés `bot` au schéma (aucune clé d'instance glissée ici).
      expect(SCOPES[cle], cle).toBe("bot");
    }
    expect(cles.has("memory.consolidation.enabled")).toBe(true);
    expect(SCOPES["memory.consolidation.enabled"]).toBe("mixte");
    // ⚠️ Aucune clé d'INSTANCE de la planification ne fuit dans l'onglet du bot.
    for (const cle of [
      "memory.consolidation.cron",
      "memory.consolidation.timeZone",
      "memory.consolidation.budgetTokens",
      "memory.consolidation.retention",
    ]) {
      expect(cles.has(cle), cle).toBe(false);
    }
  });

  it("chaque clé de l'onglet a un libellé et une explication (aucun champ muet)", () => {
    const memoire = (groupesParOnglet("bot", GROUPS).memoire ?? []).flatMap((entree) =>
      champsDePage("bot", entree, SCOPES),
    );
    for (const champ of memoire) {
      expect(champ.label, champ.path).toBeTruthy();
      expect(String(champ.helper ?? "").length, champ.path).toBeGreaterThan(10);
    }
  });

  it("la phrase de suppression NOMME les sessions Pi et leur sort", () => {
    const texte = texteSuppressionBot({
      bot: { id: "kohai", nom: "Kohai" },
      compteurs: { conversations: 1, souvenirs: 2, declencheurs: 0, octets: 0, sessions: 4 },
      retentionJours: RETENTION_ARCHIVES_JOURS,
    });
    expect(texte).toContain("sessions Pi");
    expect(texte).toContain("4 fichier(s) de conversation");
    expect(texte).toContain("COPIÉES dans la même archive");
    expect(texte).toContain("restent en place");
    expect(texte).toContain("avertissement");
    expect(texte).toContain("CONSERVÉES 3 mois (90 jours)");
  });

  it("volume `pi` inconnu ⇒ la phrase ne prétend pas qu'il n'y a aucune session", () => {
    const texte = texteSuppressionBot({
      bot: { id: "kohai", nom: "Kohai" },
      compteurs: { conversations: 0, souvenirs: 0, declencheurs: 0, octets: 0, sessions: null },
    });
    expect(texte).toContain("sessions Pi");
    expect(texte).not.toContain("0 fichier(s) de conversation");
  });

  it("l'interface PRÉVIENT quand les sessions n'ont pas pu être archivées", () => {
    // Garde de source : la réponse de `DELETE /api/bots/<id>` porte `sessionsPi`
    // et l'interface affiche une alerte sur l'état `echec` (jamais un silence).
    expect(CONFIG_JS).toContain("resultat.sessionsPi?.etat === \"echec\"");
    expect(CONFIG_JS).toContain("Conversations conservées à part");
  });
});
