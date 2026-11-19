/**
 * `/config` → onglet **Modèles** — aide des rôles et bandeau conditionnel.
 *
 * Ce que ce fichier prouve (⚠️ ces assertions ÉCHOUENT sur l'arbre d'origine) :
 *  ① le texte d'aide « discussion = interface, travail = tâches déléguées » est
 *    PRÉSENT et RENDU sous le titre du groupe (via `group.intro`) ;
 *  ② le bandeau du rôle travail est CONDITIONNEL : visible si la clé manque,
 *    masqué (et vidé) si elle est là — testé sur la règle pure `bandeauTravail` ;
 *  ③ le bandeau vit dans l'onglet Modèles, écrit par `textContent` seulement
 *    (aucun `innerHTML`) et sans style inline (CSP `style-src 'self'`).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MODELE_DISCUSSION_INTRO,
  MODELE_TRAVAIL_INDISPONIBLE,
  bandeauTravail,
} from "../../public/ui/modeles-aide.js";

// ⚠️ Le CATALOGUE des champs a quitté `config.js` pour `config-fields.js` au
// sous-lot 1b-4 : on lit les DEUX (aucune assertion relâchée).
const CONFIG_JS =
  readFileSync(join(process.cwd(), "public", "ui", "config.js"), "utf8") +
  readFileSync(join(process.cwd(), "public", "ui", "config-fields.js"), "utf8") +
  readFileSync(join(process.cwd(), "public", "ui", "llm-choix.js"), "utf8");
const CONFIG_HTML = readFileSync(
  join(process.cwd(), "public", "ui", "config.html"),
  "utf8",
);

describe("aide des rôles dans l'onglet Modèles", () => {
  it("la phrase dit ce que fait CHAQUE rôle, sans jargon de clé", () => {
    expect(MODELE_DISCUSSION_INTRO).toBe(
      "Le modèle de discussion est l'interface : il comprend, choisit les " +
        "outils, répond. Le modèle de travail exécute les tâches déléguées et " +
        "les travaux de fond.",
    );
  });

  it("elle est portée par le MENU « Modèle de discussion » et RENDUE", () => {
    // ⚠️ GARDE RÉVISÉE (2026-11-19, LOT B) : le groupe de champs `llm-light`
    // (URL / clé / modèle / réflexion saisis à la main) est SUPPRIMÉ ; l'aide est
    // portée par la première des trois listes déroulantes du catalogue
    // (`public/ui/llm-choix.js`), sous le libellé « Modèle de discussion ».
    const choix = readFileSync(join(process.cwd(), "public", "ui", "llm-choix.js"), "utf8");
    const role = /libelle: "Modèle de discussion",[\s\S]*?visionSeulement: false/.exec(choix)?.[0] ?? "";
    expect(role).toContain("aide: MODELE_DISCUSSION_INTRO");
    // Le rendu utilise `text` (textContent) — jamais du markup.
    expect(choix).toContain('class: "config-helper", text: role.aide');
  });
});

describe("bandeau conditionnel du modèle de travail", () => {
  it("RÈGLE PURE : absent quand disponible, texte quand indisponible", () => {
    expect(bandeauTravail(true)).toEqual({ hidden: true, texte: "" });
    expect(bandeauTravail(false)).toEqual({
      hidden: false,
      texte:
        "Le modèle de travail est indisponible : les travaux de fond utilisent " +
        "le modèle de discussion (qualité réduite).",
    });
    expect(MODELE_TRAVAIL_INDISPONIBLE).toBe(bandeauTravail(false).texte);
  });

  it("l'élément vit dans le panneau `modeles` du HTML, masqué par défaut", () => {
    const panneau = /id="panel-modeles"[\s\S]*?<\/section>/.exec(CONFIG_HTML)?.[0] ?? "";
    expect(panneau).toContain('id="group-modeles"');
    expect(panneau).toMatch(/id="work-model-notice"[\s\S]*?hidden/);
  });

  it("`config.js` l'alimente depuis `status.heavyKey`, avec `textContent`", () => {
    expect(CONFIG_JS).toContain('getElementById("work-model-notice")');
    const bloc = /if \(workModelNoticeEl\) \{[\s\S]*?\n  \}/.exec(CONFIG_JS)?.[0] ?? "";
    expect(bloc).toContain("bandeauTravail(heavyKey)");
    expect(bloc).toContain("workModelNoticeEl.hidden = bandeau.hidden");
    expect(bloc).toContain("workModelNoticeEl.textContent = bandeau.texte");
    expect(bloc).not.toContain("innerHTML");
  });

  it("aucun style inline ajouté (CSP inchangée)", () => {
    expect(CONFIG_HTML).not.toMatch(/id="work-model-notice"[^>]*style=/);
    expect(CONFIG_JS).not.toContain("workModelNoticeEl.style");
  });
});
