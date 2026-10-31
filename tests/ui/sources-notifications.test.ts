/**
 * Garde-fous STATIQUES de l'interface des SOURCES et des NOTIFICATIONS.
 *
 * Ces tests ne prouvent pas le RENDU (c'est le rôle de
 * `_tools/e2e-sources.mjs`) : ils prouvent que les règles NON NÉGOCIABLES du
 * dépôt ne sont pas contournées par mégarde dans les deux nouveaux modules.
 *
 * ⚠️ Ce qu'ils protègent (les erreurs sont SILENCIEUSES à l'exécution) :
 *  - `innerHTML` / `insertAdjacentHTML` : injection de balisage impossible à
 *    relire dans une revue, et incompatible avec la CSP stricte du projet ;
 *  - attribut `style=` : interdit par la CSP `style-src 'self'` ;
 *  - `window.confirm` / `alert` : on passe par `HolafModal` ;
 *  - le compteur de non-lus doit être branché dans l'EN-TÊTE, la section doit
 *    exister, et « Continuer dans une conversation » doit être le SEUL chemin qui
 *    ouvre un fil ;
 *  - ⚠️ la LECTURE de la boîte exige le même en-tête que les mutations
 *    (`X-Yuki-Config: 1`) : la garde est côté serveur, l'interface doit suivre ;
 *  - ⚠️ la suppression d'un fil qui reçoit des sources passe par `HolafModal` et
 *    propose TROIS choix (aucune suppression silencieuse).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DELETE_WITH_SOURCES_LABEL } from "../../public/ui/sessions-panel.js";

const UI = join(process.cwd(), "public", "ui");

function read(name: string): string {
  return readFileSync(join(UI, name), "utf8");
}

const NOTIFICATIONS = read("notifications-panel.js");
const SOURCES_PANEL = read("sources-panel.js");
const APP = read("app.js");
const INDEX = read("index.html");
const CONFIG_HTML = read("config.html");
const CONFIG_JS = read("config.js");
const SESSIONS_PANEL = read("sessions-panel.js");
const STYLES = read("styles.css");

/**
 * Code SANS ses commentaires : les garde-fous portent sur le CODE, pas sur la
 * prose (un commentaire qui dit « aucun innerHTML » ne doit pas faire échouer le
 * test — et un commentaire ne peut pas injecter de balisage).
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Assertions communes aux deux nouveaux modules (CSP + DOM programmatique). */
function expectSafeDom(source: string, name: string): void {
  const stripped = code(source);
  expect(stripped, `${name} : innerHTML interdit`).not.toContain("innerHTML");
  expect(stripped, `${name} : insertAdjacentHTML interdit`).not.toContain("insertAdjacentHTML");
  expect(stripped, `${name} : outerHTML interdit`).not.toContain("outerHTML");
  // Aucun attribut de style posé à la main (`style="…"` ou `style=` dans un objet).
  expect(stripped, `${name} : aucun attribut style`).not.toMatch(/["']style["']\s*:/);
  expect(stripped, `${name} : aucun style= dans une chaîne`).not.toMatch(/\sstyle=/);
  expect(stripped, `${name} : window.confirm interdit`).not.toContain("window.confirm");
  expect(stripped, `${name} : window.alert interdit`).not.toContain("window.alert");
}

describe("modules UI des sources — CSP et DOM programmatique", () => {
  it("notifications-panel.js n'injecte aucun balisage et ne pose aucun style", () => {
    expectSafeDom(NOTIFICATIONS, "notifications-panel.js");
    expect(NOTIFICATIONS).toContain("textContent");
    expect(NOTIFICATIONS).toContain("createElement");
  });

  it("sources-panel.js n'injecte aucun balisage et ne pose aucun style", () => {
    expectSafeDom(SOURCES_PANEL, "sources-panel.js");
    // Toutes les confirmations passent par la brique HolafModal.
    expect(SOURCES_PANEL).toContain("HolafModal.confirm");
    expect(SOURCES_PANEL).toContain("HolafModal.open");
  });

  it("aucun `style=` dans le markup des deux pages (CSP `style-src 'self'`)", () => {
    expect(INDEX).not.toMatch(/\sstyle=/);
    expect(CONFIG_HTML).not.toMatch(/\sstyle=/);
  });

  it("le CSS des notifications vit dans styles.css (fichier servi, pas de <style>)", () => {
    expect(NOTIFICATIONS).not.toContain("<style");
    for (const selector of [".notifs-toggle__count", ".notifs-layer", ".notif__content", ".notif__reply"]) {
      expect(STYLES, selector).toContain(selector);
    }
  });
});

describe("page de discussion — section « Notifications »", () => {
  it("l'en-tête porte le compteur de non-lus et le bouton qui ouvre la section", () => {
    const topbar = INDEX.slice(INDEX.indexOf('<header class="topbar">'), INDEX.indexOf("</header>"));
    expect(topbar).toContain('id="sources-notifs-toggle"');
    expect(topbar).toContain('id="sources-notifs-count"');
    expect(topbar).toContain('aria-controls="sources-notifs-panel"');
  });

  it("la section existe dans la page, en `role=dialog` non modal", () => {
    expect(INDEX).toContain('id="sources-notifs-panel"');
    expect(INDEX).toContain('id="sources-notifs-list"');
    expect(INDEX).toMatch(/id="sources-notifs-panel"[\s\S]{0,200}role="dialog"|role="dialog"[\s\S]{0,200}id="sources-notifs-panel"/);
    expect(INDEX).toContain('aria-modal="false"');
  });

  it("`app.js` monte la section et branche « Continuer » sur la bascule de conversation", () => {
    expect(APP).toContain("initSourcesNotifications(");
    expect(APP).toContain("sources-notifs-toggle");
    // Le SEUL effet d'un clic « Continuer » : basculer vers la conversation
    // renvoyée par le serveur (jamais créer une session côté client).
    expect(APP).toContain('sendRaw({ type: "switch", sessionId })');
  });

  it("le contenu est REPLIÉ par défaut (<details>) et la réponse est dans la même entrée", () => {
    expect(NOTIFICATIONS).toContain('h("details"');
    expect(NOTIFICATIONS).toContain("notif__reply");
    // L'état affiché vient du serveur (reçu / traité / en échec).
    expect(NOTIFICATIONS).toContain("recu: \"reçu\"");
    expect(NOTIFICATIONS).toContain("traite: \"traité\"");
    expect(NOTIFICATIONS).toContain("echec: \"en échec\"");
  });

  it("« Continuer dans une conversation » est le SEUL bouton qui crée/ouvre un fil", () => {
    // Une seule route d'ouverture, et un seul libellé de bouton.
    expect(code(NOTIFICATIONS).split("/ouvrir").length - 1).toBe(1);
    expect(NOTIFICATIONS).toContain("Continuer dans une conversation");
    // Aucune autre route ne crée de conversation depuis l'interface.
    expect(NOTIFICATIONS).not.toContain('type: "new"');
    expect(NOTIFICATIONS).not.toContain("sendRaw({ type: \"new\"");
  });
});

describe("section « Notifications » — états et avis", () => {
  it("un AVIS de Yuki (`alerte`) n'est pas replié et n'ouvre aucune conversation", () => {
    expect(NOTIFICATIONS).toContain('alerte: "alerte"');
    // Le texte d'un avis est rendu directement (pas de <details>).
    expect(code(NOTIFICATIONS)).toContain('entry.etat === "alerte"');
    // Ce qui s'est passé malgré tout (fil disparu, bascule) est AFFICHÉ.
    expect(NOTIFICATIONS).toContain("entry.note");
    expect(NOTIFICATIONS).toContain("notif__note");
  });
});

describe("suppression d'un fil qui reçoit des sources (point ③)", () => {
  it("passe par HolafModal et propose les TROIS choix, sans `window.confirm`", () => {
    const source = code(SESSIONS_PANEL);
    // Aucune confirmation native.
    expect(source).not.toContain("window.confirm");
    expect(source).not.toContain("window.alert");
    // Le marquage `sources` du fil déclenche la modale dédiée.
    expect(source).toContain("confirmDeleteWithSources");
    expect(source).toContain("current?.sources");
    // Les trois issues sont proposées, NOMMÉES.
    expect(source).toContain("Rattacher ces sources à un autre fil");
    expect(source).toContain("nouvelle conversation à chaque fois");
    expect(DELETE_WITH_SOURCES_LABEL).toBe("Supprimer quand même");
    expect(source).toContain("modal.open");
    // ⚠️ Les sources ne sont jamais supprimées : la modale le DIT.
    expect(source).toContain("ne seront PAS supprimées");
    // …et la réaffectation passe par l'API des sources, avec la garde d'écriture.
    expect(source).toContain("/api/sources/");
    expect(source).toContain('"x-yuki-config": "1"');
    expect(source).toContain("PATCH");
  });

  it("« Continuer » reste le SEUL bouton qui ouvre un fil depuis la boîte", () => {
    // La suppression, elle, ne crée rien : elle réaffecte.
    expect(code(SESSIONS_PANEL)).not.toContain('type: "new"');
  });
});

describe("page /config — section « Sources »", () => {
  it("le conteneur est monté dans un onglet EXISTANT (aucun onglet nouveau)", () => {
    expect(CONFIG_HTML).toContain('id="sources-root"');
    // Les neuf onglets restent EXACTEMENT les mêmes (verrouillés par
    // `tests/integration/static-ui.test.ts`).
    const tabLabels = [...CONFIG_HTML.matchAll(/<button[^>]*role="tab"[^>]*>\s*([^<]+)/g)].map((m) =>
      m[1].trim(),
    );
    expect(tabLabels).toEqual([
      "Modèles",
      "Conversation",
      "Personnalité",
      "Voix",
      "Images",
      "Agents",
      "Secrets",
      "Système",
      "Maintenance",
    ]);
    // Monté par id depuis `config.js`, dans l'onglet Conversation.
    expect(CONFIG_JS).toContain("initSourcesPanel(");
    expect(CONFIG_JS).toContain('document.getElementById("sources-root")');
  });

  it("le panneau écrit avec l'en-tête de garde exigé par les routes protégées", () => {
    expect(SOURCES_PANEL).toContain('"x-yuki-config": "1"');
    expect(SOURCES_PANEL).toContain('"/api/sources"');
    expect(SOURCES_PANEL).toContain("/jeton");
  });

  it("⚠️ la LECTURE envoie le même en-tête de garde que les écritures", () => {
    // Le serveur refuse (403) une lecture SANS `X-Yuki-Config: 1` : sans cet
    // en-tête, la section Notifications resterait vide en silence.
    expect(code(NOTIFICATIONS)).toMatch(/WRITE_HEADERS\s*=\s*\{[^}]*"x-yuki-config":\s*"1"/);
    expect(code(NOTIFICATIONS)).toContain('doFetch("/api/sources/inbox", { headers: WRITE_HEADERS })');
    // Même exigence pour la liste des sources de `/config`.
    expect(code(SOURCES_PANEL)).toMatch(/JSON_HEADERS\s*=\s*\{[^}]*"x-yuki-config":\s*"1"/);
  });

  it("le jeton est présenté comme affiché UNE SEULE FOIS", () => {
    expect(SOURCES_PANEL).toContain("ne sera plus jamais affiché");
  });

  it("la borne d'injection du bloc <sources> est réglable dans /config", () => {
    expect(CONFIG_JS).toContain('"sources.promptTotalChars"');
    expect(CONFIG_JS).toContain('"sources"');
  });
});
