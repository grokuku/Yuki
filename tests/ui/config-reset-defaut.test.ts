/**
 * CÂBLAGE de « Réinitialiser au défaut » dans la page `/config`.
 *
 * ⚠️ Défaut signalé (2026-11-04) : « si je fais réinitialiser au défaut, c'est
 * vide ! ». Le bouton écrivait `FIELD_DEFAULTS[path]`, où `"prompts.light"` et
 * `"prompts.heavy"` valaient `""` — le défaut RÉEL est le CONTENU DU FICHIER
 * LIVRÉ, que seul le serveur connaît. Un prompt vide prive le modèle de toute
 * consigne SANS que rien ne le signale.
 *
 * Ce fichier verrouille le CÂBLAGE (les RÈGLES pures sont testées dans
 * `tests/ui/config-patch.test.ts`, le contrat serveur dans
 * `tests/config/reset-prompt-defaut.test.ts`) :
 *  1. le miroir UI ne prétend plus que le défaut des prompts est vide ;
 *  2. le bouton passe par `resetValueFor` (défaut du SERVEUR d'abord) ;
 *  3. l'état « valeur par défaut » / « personnalisé » est AFFICHÉ ;
 *  4. un champ vidé est REFUSÉ avant l'envoi (`emptyValueRefusals`) ;
 *  5. le prompt de CANAL est explicitement dit NON réglable ici ;
 *  6. aucun `innerHTML`, aucun style inline (CSP stricte inchangée).
 *
 * ⚠️ Ces assertions ÉCHOUENT sur le code d'origine (`git show HEAD:public/ui/config.js`
 * contient `"prompts.light": ""`, n'a ni `originBadge` ni `emptyValueRefusals`).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const UI = join(process.cwd(), "public", "ui");
const lire = (nom: string): string => readFileSync(join(UI, nom), "utf8");

// ⚠️ Le CATALOGUE (groupes, libellés, miroir des défauts) a quitté `config.js`
// pour `config-fields.js` au sous-lot 1b-4 : on lit les DEUX.
const CONFIG_JS = lire("config.js") + lire("config-fields.js");
const CONFIG_CSS = lire("config.css");

describe("« Réinitialiser au défaut » — câblage de la page /config", () => {
  it("⚠️ le miroir UI ne déclare plus un défaut VIDE pour les prompts", () => {
    // La cause exacte du défaut signalé : `"prompts.light": ""`.
    expect(CONFIG_JS).not.toMatch(/"prompts\.light"\s*:\s*""/);
    expect(CONFIG_JS).not.toMatch(/"prompts\.heavy"\s*:\s*""/);
    // Le miroir reste utilisable pour les autres champs (non-régression).
    expect(CONFIG_JS).toContain('"gpu.minDriver": 580');
    expect(CONFIG_JS).toContain('"tts.speed": 100');
  });

  it("le bouton utilise le défaut SERVI par le serveur (`default`), pas le miroir seul", () => {
    expect(CONFIG_JS).toContain("resetValueFor(");
    // `fieldDefault` (aide « Valeur par défaut » + reset) délègue à la règle pure.
    expect(CONFIG_JS).toMatch(/function fieldDefault\(field\) \{\s*return resetValueFor\(/);
    // Le reset réécrit la valeur dans le contrôle : jamais un `delete` du champ seul.
    expect(CONFIG_JS).toMatch(/control\.value = String\(fallback\)/);
  });

  it("l'état « valeur par défaut » / « personnalisé » est AFFICHÉ (③)", () => {
    expect(CONFIG_JS).toContain("originBadge(");
    expect(CONFIG_JS).toContain("originLabel(");
    // La classe est construite depuis l'origine (`badge--origin-${modifier}`).
    expect(CONFIG_JS).toContain("badge--origin-");
    expect(CONFIG_JS).toContain('modifier = entry.origin === "store" ? "store" : "default"');
    // Les classes sont réellement stylées (pas de style inline, CSP inchangée).
    expect(CONFIG_CSS).toContain(".badge--origin-default");
    expect(CONFIG_CSS).toContain(".badge--origin-store");
  });

  it("un champ vidé est REFUSÉ avant l'envoi (jamais persisté)", () => {
    expect(CONFIG_JS).toContain("emptyValueRefusals(");
    // Le refus est posé AVANT le `put` : on vérifie l'ordre dans `save()`.
    const save = CONFIG_JS.slice(CONFIG_JS.indexOf("async function save("));
    const refus = save.indexOf("emptyValueRefusals(");
    const put = save.indexOf("HolafFetch.put(");
    expect(refus).toBeGreaterThan(-1);
    expect(put).toBeGreaterThan(-1);
    expect(refus).toBeLessThan(put);
  });

  it("⚠️ dit que le prompt de CANAL n'est pas réglable (constante du code)", () => {
    // Sans cette phrase, l'utilisateur croit pouvoir régler aussi le prompt publié
    // dans Mattermost / Discord (constante `src/chat/reply/prompt.ts`).
    expect(CONFIG_JS).toContain("src/chat/reply/prompt.ts");
    expect(CONFIG_JS).toMatch(/CANAL/);
    expect(CONFIG_CSS).toContain(".config-group__note");
  });

  it("l'aide tronque un prompt long au lieu d'imprimer des milliers de caractères", () => {
    expect(CONFIG_JS).toContain("caractères)");
    expect(CONFIG_JS).toMatch(/field\.kind === "textarea" \|\| text\.length > 96/);
  });

  it("CSP stricte : aucun `innerHTML`, aucun style inline dans le module", () => {
    expect(CONFIG_JS).not.toContain("innerHTML");
    expect(CONFIG_JS).not.toContain(".style.");
    expect(CONFIG_JS).not.toContain('setAttribute("style"');
  });
});
