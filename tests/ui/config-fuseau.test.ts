/**
 * `/config` — le réglage `ui.timeZone` est EXPOSÉ et APPLIQUÉ à chaud.
 *
 * Contrainte utilisateur : « jamais d'édition de fichier à la main ». Un réglage qui
 * piloterait tous les horodatages sans être dans la page de gestion serait
 * inutilisable.
 *
 * ⚠️ `public/ui/config.js` est un module à effets de bord (DOM) : on vérifie donc
 * sa SOURCE, comme les autres garde-fous statiques du projet
 * (`tests/ui/sidebar-agents.test.ts`). Le miroir `FIELD_DEFAULTS` doit rester
 * aligné sur `src/config/schema.ts` — un défaut recopié de travers ferait
 * afficher « Défaut : UTC » sur un champ qui n'en a pas.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CONFIG_SCHEMA } from "../../src/config/schema.js";

const CONFIG_JS = readFileSync(
  join(process.cwd(), "public", "ui", "config.js"),
  "utf8",
);
const APP_JS = readFileSync(join(process.cwd(), "public", "ui", "app.js"), "utf8");

describe("page /config — fuseau des horodatages", () => {
  it("le champ `ui.timeZone` est déclaré dans un groupe de la page", () => {
    expect(CONFIG_JS).toContain('path: "ui.timeZone"');
    expect(CONFIG_JS).toContain('label: "Fuseau horaire des horodatages"');
    // Il vit dans l'onglet « Système » (groupe « Affichage »).
    expect(CONFIG_JS).toMatch(/"affichage"/);
  });

  it("son défaut UI vaut celui du SCHÉMA (aucune divergence)", () => {
    expect(CONFIG_SCHEMA["ui.timeZone"]?.default).toBe("UTC");
    const mirror = /"ui\.timeZone":\s*"([^"]*)"/.exec(CONFIG_JS);
    expect(mirror?.[1]).toBe(CONFIG_SCHEMA["ui.timeZone"]?.default);
  });

  it("l'aide dit que la PLANIFICATION n'est pas concernée", () => {
    // ⚠️ Sans cette phrase, un utilisateur changerait le fuseau pour décaler ses
    // déclencheurs — et conclurait que rien ne marche.
    expect(CONFIG_JS).toContain("La PLANIFICATION n'est pas");
    expect(CONFIG_JS).toContain("SON");
  });

  it("le fuseau est appliqué à chaque instantané (donc après chaque enregistrement)", () => {
    const applySnapshot = /function applySnapshot\(body\) \{[\s\S]*?\n\}/.exec(CONFIG_JS)?.[0] ?? "";
    expect(applySnapshot).toContain('state.fields["ui.timeZone"]');
    expect(applySnapshot).toContain("setTimeZone(");
  });
});

describe("conversation — le fuseau vient du SERVEUR, pas du navigateur", () => {
  it("`app.js` adopte `welcome.timeZone` et la trame `time_zone`", () => {
    expect(APP_JS).toContain('if (type === "time_zone")');
    expect(APP_JS).toContain("setTimeZone(frame.timeZone)");
    // Réaffichage à chaud : heures ET séparateurs de jour.
    expect(APP_JS).toContain("function reafficherHorodatages(");
  });

  it("`app.js` n'envoie PLUS le fuseau du navigateur dans la trame `message`", () => {
    // ⚠️ C'est ce champ (`tz`) qui datait les prompts dans l'heure de la machine :
    // deux heures pour un même message face à Mattermost (UTC).
    expect(APP_JS).not.toContain("CLIENT_TIME_ZONE");
    expect(APP_JS).not.toMatch(/type: "message",[\s\S]{0,200}tz:/);
  });

  it("aucune page ne formate une DATE sans fuseau", () => {
    // Garde-fou de régression : `toLocaleString`/`toLocaleTimeString` sans
    // `timeZone` prennent celui du NAVIGATEUR.
    for (const file of [
      "app.js",
      "config.js",
      "sessions-panel.js",
      "sidebar-agents.js",
      "declencheurs-vue.js",
      "preautorisations-vue.js",
    ]) {
      const source = readFileSync(join(process.cwd(), "public", "ui", file), "utf8");
      expect(source, file).not.toMatch(/\.toLocaleTimeString\(/);
      // Seule exception ADMISE : les COMPTEURS de jetons de `declencheurs-vue.js`
      // (`entree.toLocaleString("fr-FR")`) — des nombres, pas des instants.
      const dates = source
        .split("\n")
        .filter((line) => /\.toLocaleString\(\s*"fr-FR"/.test(line))
        .filter((line) => !/\b(entree|sortie)\b/.test(line));
      expect(dates, file).toEqual([]);
    }
  });
});
