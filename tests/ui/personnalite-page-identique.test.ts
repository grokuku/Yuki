/**
 * LA PAGE « PERSONNALITÉ » D'UN BOT EST LA MÊME POUR TOUS LES BOTS.
 *
 * Défaut corrigé (capture utilisateur, 2026-11-13) : `/bots?b=grolaf` affichait
 * les TROIS zones du catalogue (Personnalité · prompt léger · prompt lourd),
 * tandis que `/bots?b=yuki` affichait un panneau HISTORIQUE (Avatar partagé,
 * `personality.md`, `rules.md`). Cause : le composant `personality-panel.js`
 * était monté sous la garde `panneauxDuBotActif && personalityRoot`
 * (`public/ui/config.js`) — donc SEULEMENT quand le bot affiché était le bot
 * ACTIF. C'était un reste du « bot principal ».
 *
 * Ce que ce fichier VERROUILLE :
 *  ① la page « Personnalité » est IDENTIQUE pour deux bots (mêmes champs, mêmes
 *    identifiants) — aucun composant monté par condition de bot ;
 *  ② AUCUN panneau `personality.md` / `rules.md` sur la page d'un bot, quel que
 *    soit le bot ;
 *  ③ ces deux blocs existent dans `/config` (Réglages généraux) et restent
 *    ÉDITABLES (enregistrement, retour arrière, historique des versions) ;
 *  ④ l'AVATAR reste sur la page du bot (onglet « Général »), pas sur `/config` ;
 *  ⑤ AUCUNE condition sur un `botId` particulier dans le rendu de la page
 *    Personnalité (ni `"yuki"`, ni `BOT_YUKI`, ni `bot.id === …`).
 *
 * ⚠️ ÉCHOUE SUR LE CODE D'ORIGINE : `bots.html` y contient `personality-root`
 * (monté pour le seul bot actif) et `config.html` ne contient ni
 * `personality-root` ni les panneaux `rules.md` / `personality.md`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { GROUPS } from "../../public/ui/config-fields.js";
import { champsDePage, groupesParOnglet, idsOnglets } from "../../public/ui/config-pages.js";
import { CONFIG_SCHEMA } from "../../src/config/schema.js";

const lire = (nom: string): string =>
  readFileSync(join(process.cwd(), "public", "ui", nom), "utf8");

const BOTS_HTML = lire("bots.html");
const CONFIG_HTML = lire("config.html");
const CONFIG_JS = lire("config.js");
const PANEL_JS = lire("personality-panel.js");
const AVATAR_JS = lire("avatar.js");

/** Portée réelle de chaque clé (autorité = le schéma serveur). */
const SCOPES: Record<string, string> = Object.fromEntries(
  Object.entries(CONFIG_SCHEMA).map(([path, descriptor]) => [path, descriptor.scope]),
);

/** Contenu d'un `<section role="tabpanel" id="panel-<onglet>">` d'un fichier HTML. */
function panneau(html: string, onglet: string): string {
  const match = new RegExp(
    `<section[^>]*id="panel-${onglet}"[^>]*>([\\s\\S]*?)</section>`,
  ).exec(sansCommentairesHtml(html));
  if (match === null) throw new Error(`panneau ${onglet} introuvable`);
  return match[1];
}

/**
 * Markup SANS ses commentaires : ce que le navigateur rend réellement. Un
 * commentaire qui DÉCRIT le déménagement n'est pas un panneau affiché.
 */
function sansCommentairesHtml(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, "");
}

/**
 * Code JS SANS ses commentaires : c'est le code qui monte (ou non) un panneau,
 * pas la phrase qui explique le changement.
 */
function sansCommentaires(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * Champs de l'onglet « Personnalité » d'un bot, DANS L'ORDRE — lus depuis le
 * catalogue pur (`config-pages.js` + `config-fields.js`), qui ne connaît AUCUN
 * bot : ce qui est rendu ne peut donc pas dépendre de celui qui est affiché.
 */
function champsPersonnaliteBot(): string[] {
  const groupes = groupesParOnglet("bot", GROUPS).personnalite ?? [];
  return groupes.flatMap((groupe) =>
    champsDePage("bot", groupe, SCOPES).map((field) => field.path),
  );
}

describe("① la page « Personnalité » est IDENTIQUE pour tous les bots", () => {
  it("les trois zones du catalogue, dans l'ordre, quel que soit le bot", () => {
    expect(champsPersonnaliteBot()).toEqual([
      "prompts.personnalite",
      "prompts.light",
      "prompts.heavy",
    ]);
    // Le calcul ne prend AUCUN identifiant de bot : deux bots (yuki, grolaf)
    // rendent forcément la MÊME liste, les MÊMES libellés.
    const groupe = (groupesParOnglet("bot", GROUPS).personnalite ?? [])[0];
    if (!groupe) throw new Error("groupe « prompts » absent de l'onglet Personnalité");
    // Le titre vient du CATALOGUE (aucun miroir côté test).
    const titre = (groupe as { title?: string }).title;
    expect(titre).toBe("Personnalité et prompts système");
    const libelles = champsDePage("bot", groupe, SCOPES).map((field) => field.label);
    expect(libelles).toEqual([
      "Personnalité",
      "Prompt système — léger",
      "Prompt système — lourd",
    ]);
  });

  it("l'onglet ne monte AUCUN composant : un seul conteneur de champs", () => {
    const contenu = panneau(BOTS_HTML, "personnalite");
    // Le panneau ne contient QUE le conteneur des champs rendus par `config.js`.
    expect(contenu).toContain('id="group-personnalite"');
    // Aucun autre point de montage (`<id>-root`) : rien qui puisse apparaître
    // pour un bot et pas pour un autre.
    expect(contenu.match(/id="[^"]*-root"/g) ?? []).toEqual([]);
  });

  it("la page du bot déclare TOUJOURS le même onglet Personnalité", () => {
    expect(idsOnglets("bot")).toContain("personnalite");
    expect(BOTS_HTML).toContain('id="tab-personnalite"');
    expect(BOTS_HTML).toContain('aria-controls="panel-personnalite"');
  });
});

describe("② aucun panneau personality.md / rules.md sur la page d'un bot", () => {
  it("le markup de la page d'un bot ne les contient plus", () => {
    const rendu = sansCommentairesHtml(BOTS_HTML);
    expect(rendu).not.toContain('id="personality-root"');
    expect(rendu).not.toContain("personality.md");
    expect(rendu).not.toContain("Règles strictes");
    expect(rendu).not.toContain("rules.md");
  });

  it("le montage du panneau est réservé à la page INSTANCE (`!PAGE_BOT`)", () => {
    const code = sansCommentaires(CONFIG_JS);
    // La garde qui réservait ce panneau au bot ACTIF a disparu du montage.
    expect(code).toContain(
      "if (!PAGE_BOT && personalityRoot) {\n      initPersonalityPanel(",
    );
    // ⚠️ Aucune autre occurrence de `initPersonalityPanel(` (un second montage
    // caché ramènerait le panneau sur une autre page ou pour un seul bot).
    expect(code.match(/initPersonalityPanel\(/g)?.length).toBe(1);
    // La page Instance est la seule à livrer l'emplacement du panneau.
    expect(CONFIG_HTML).toContain('id="personality-root"');
    expect(BOTS_HTML).not.toContain('id="personality-root"');
  });

  it("un bot QUI QUE CE SOIT ne peut pas l'afficher (aucun montage conditionnel)", () => {
    // `panneauxDuBotActif` garde encore les panneaux qui lisent le bot ACTIF
    // (voix, assistants) ; il ne garde PLUS la personnalité partagée.
    expect(sansCommentaires(CONFIG_JS)).not.toMatch(
      /panneauxDuBotActif\s*&&\s*personalityRoot/,
    );
  });
});

describe("③ les deux blocs vivent dans /config et restent ÉDITABLES", () => {
  it("`/config` monte le panneau dans l'onglet « Modèles » (mêmes onglets)", () => {
    // Aucun onglet ajouté : les réglages communs restent dans un onglet existant.
    expect(idsOnglets("instance")).toHaveLength(7);
    expect(panneau(CONFIG_HTML, "modeles")).toContain('id="personality-root"');
    // L'onglet « Modèles » porte déjà la valeur COMMUNE des prompts : la
    // personnalité partagée de l'instance y est à sa place.
    expect(panneau(CONFIG_HTML, "modeles")).toContain('id="group-modeles"');
  });

  it("les fichiers restent lisibles ET enregistrables (aucune perte)", () => {
    // `personality.md` : lecture, écriture, retour arrière, historique.
    expect(PANEL_JS).toContain('"/api/self/personality"');
    expect(PANEL_JS).toContain('"/api/self/personality/revert"');
    // `rules.md` : lecture, écriture, retour arrière, historique.
    expect(PANEL_JS).toContain('"/api/self/rules"');
    expect(PANEL_JS).toContain('"/api/self/rules/revert"');
    // L'historique des versions (les 20 dernières, côté serveur) est rendu.
    expect(PANEL_JS).toContain("renderHistory");
    expect(PANEL_JS).toContain("renderRulesHistory");
    expect(PANEL_JS).toContain("Revenir à la version précédente");
    // Aucun style inline, aucun HTML brut (CSP inchangée).
    expect(PANEL_JS).not.toContain("innerHTML");
    expect(PANEL_JS).not.toContain(".style.");
    expect(PANEL_JS).not.toContain("window.confirm(");
  });

  it("l'avertissement « ne mettez pas la même chose aux deux endroits » a disparu", () => {
    expect(PANEL_JS).not.toContain("ne mettez pas la même chose aux deux endroits");
  });
});

describe("④ l'avatar reste sur la page du BOT (onglet Général)", () => {
  it("la section Avatar est montée par le rendu de l'onglet Général", () => {
    expect(CONFIG_JS).toContain("import { creerSectionAvatar } from './avatar.js';");
    expect(CONFIG_JS).toMatch(/function renderBotGeneral\(\)[\s\S]*sectionAvatarDuBot\(\)/);
    expect(AVATAR_JS).toContain("export function creerSectionAvatar(");
    expect(AVATAR_JS).toContain('text: "Changer l\'avatar"');
  });

  it("elle n'est ni sur `/config` ni dans le panneau de la personnalité partagée", () => {
    expect(CONFIG_HTML).not.toContain("Changer l'avatar");
    expect(PANEL_JS).not.toContain("creerSectionAvatar");
    expect(PANEL_JS).not.toContain("avatar.js");
  });
});

describe("⑤ aucune condition sur un botId particulier (garde structurelle)", () => {
  it("le rendu de la page Personnalité ne nomme aucun bot", () => {
    // Le markup de l'onglet, son conteneur et le code de montage.
    const zone = [
      panneau(BOTS_HTML, "personnalite"),
      CONFIG_JS.slice(
        CONFIG_JS.indexOf("function render()"),
        CONFIG_JS.indexOf("function renderGroup("),
      ),
      CONFIG_JS.slice(
        CONFIG_JS.indexOf("if (!PAGE_BOT && personalityRoot)"),
        CONFIG_JS.indexOf("setInterval(() => void pollHealth(), 5000)"),
      ),
      PANEL_JS,
    ].join("\n");
    for (const interdit of ["BOT_YUKI", '"yuki"', "'yuki'", "botHistoriqueMono"]) {
      expect(zone, interdit).not.toContain(interdit);
    }
    // Aucune comparaison à un identifiant de bot dans tout le module d'interface.
    expect(CONFIG_JS).not.toContain("BOT_YUKI");
    expect(CONFIG_JS).not.toMatch(/===\s*"yuki"/);
  });
});
