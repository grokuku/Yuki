/**
 * BADGES D'APPLICATION — ils doivent dire la VÉRITÉ, dans les deux sens.
 *
 * ⚠️ LE BUG (2026-11-14) : le badge « redémarrage » était posé sur la
 * personnalité, les prompts, les règles, les consignes et les faits — des textes
 * désormais RELUS À CHAQUE TOUR. Il annonçait donc un redémarrage inutile…
 * et, comme il était discret, il n'a pas empêché de croire qu'une personnalité
 * éditée s'appliquait (grolaf répondait « je suis là — Yuki »).
 *
 * Ce que ce fichier VERROUILLE :
 *  ① `prompts.personnalite`, `prompts.light` et `prompts.heavy` sont `apply: "hot"`
 *    (recomposés à chaque tour / à chaque job) — un badge « redémarrage » y serait
 *    MENSONGER ;
 *  ② un champ qui exige VRAIMENT un redémarrage l'écrit en toutes lettres
 *    (« nécessite un redémarrage pour s'appliquer »), pas un mot isolé ;
 *  ③ ce que la page Instance et la page Bot annoncent dans leur légende est
 *    exactement ce que le badge affiche ;
 *  ④ les réglages qui restent honnêtement en redémarrage le restent
 *    (`tts.enabled` : la consigne de voix n'est pas relue à chaque tour).
 *
 * ⚠️ `public/ui/config.js` est un module à effets de bord (DOM) : on vérifie son
 * TEXTE, comme les autres gardes d'interface de ce dépôt.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CONFIG_SCHEMA } from "../../src/config/schema.js";

function lire(fichier: string): string {
  return readFileSync(join(process.cwd(), "public", "ui", fichier), "utf8");
}

const CONFIG_JS = lire("config.js");

/** Phrase EXACTE d'un champ qui exige un redémarrage (pas un badge d'un mot). */
const PHRASE_REDEMARRAGE = "nécessite un redémarrage pour s'appliquer";

describe("① les textes relus à chaque tour ne portent plus de badge « redémarrage »", () => {
  it("`prompts.personnalite`, `prompts.light` et `prompts.heavy` sont `apply: \"hot\"`", () => {
    // ⚠️ Ces trois clés sont recomposées par l'extension du prompt du tour
    // (personnalité/prompt léger) et à chaque job du worker (prompt lourd).
    for (const cle of ["prompts.personnalite", "prompts.light", "prompts.heavy"]) {
      expect(CONFIG_SCHEMA[cle]?.apply, cle).toBe("hot");
    }
  });

  it("la personnalité n'est jamais annoncée comme exigeant un redémarrage", () => {
    const apply = CONFIG_SCHEMA["prompts.personnalite"]?.apply;
    expect(apply).not.toBe("restart");
    // Le badge affiché pour cette clé est donc « à chaud » (rendu par `applyBadge`).
    expect(CONFIG_JS).toContain('text: hot ? "à chaud" :');
  });
});

describe('② un champ qui exige un redémarrage le DIT en toutes lettres', () => {
  it("le badge n'est plus un mot isolé", () => {
    expect(CONFIG_JS).toContain(PHRASE_REDEMARRAGE);
    // Aucun badge d'un seul mot « redémarrage » ne doit subsister.
    expect(CONFIG_JS).not.toMatch(/text:\s*"redémarrage"/u);
    expect(CONFIG_JS).not.toContain('"redémarrage"]');
  });

  it("`tts.enabled` reste honnêtement en redémarrage (la voix n'est pas relue à chaque tour)", () => {
    expect(CONFIG_SCHEMA["tts.enabled"]?.apply).toBe("restart");
  });

  it("il reste des champs en redémarrage : ils ne sont pas tous devenus « à chaud »", () => {
    const enRedemarrage = Object.values(CONFIG_SCHEMA).filter(
      (descripteur) => descripteur.apply === "restart",
    );
    expect(enRedemarrage.length).toBeGreaterThan(0);
  });
});

describe("③ les deux pages annoncent la MÊME phrase que le badge", () => {
  it("`config.html` et `bots.html` emploient la phrase explicite", () => {
    for (const page of ["config.html", "bots.html"]) {
      const html = lire(page);
      expect(html, page).toContain(PHRASE_REDEMARRAGE);
      // L'ancienne légende (badge d'un mot) ne doit plus être là.
      expect(html, page).not.toContain('<span class="badge badge--restart">redémarrage</span>');
      expect(html, page).not.toContain("prend\n        effet au prochain redémarrage");
    }
  });
});
