/**
 * PAGE `/config` — volet « Versions de la mémoire » de la consolidation
 * hebdomadaire (lot 29, amendement ②).
 *
 * ⚠️ Échoue sur le code d'origine : `personality-panel.js` n'affiche que le
 * bouton « Réinitialiser la mémoire », et `config.js` ne connaît aucun champ
 * `memory.consolidation.*`.
 *
 * Ce qui est verrouillé :
 *  - les réglages sont dans la page (groupe « Mémoire durable ») et le miroir
 *    `FIELD_DEFAULTS` est cohérent avec le schéma (`Europe/Paris`, cron, budget) ;
 *  - l'UI affiche les versions avec DEUX boutons (télécharger, restaurer) ;
 *  - la restauration passe par `HolafModal` (jamais la boîte native) ;
 *  - aucun `innerHTML`, aucun style en ligne (CSP stricte inchangée).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const PUBLIC = join(process.cwd(), "public", "ui");
const RACINE = process.cwd();

function fichier(nom: string): string {
  return readFileSync(join(PUBLIC, nom), "utf8");
}

/* ⚠️ Depuis le sous-lot 1b-4, le CATALOGUE des champs (groupes, libellés,
 * miroir des défauts) a été extrait de `config.js` vers `config-fields.js`
 * (module pur, importable sans DOM) : les assertions de contenu lisent donc
 * les DEUX fichiers, sans rien relâcher. */
const CONFIG_CATALOGUE = fichier("config-fields.js");

describe("réglages de la consolidation dans /config", () => {
  it("les cinq champs sont dans le groupe « Mémoire durable »", () => {
    const source = fichier("config.js") + CONFIG_CATALOGUE;
    for (const chemin of [
      "memory.consolidation.enabled",
      "memory.consolidation.cron",
      "memory.consolidation.timeZone",
      "memory.consolidation.budgetTokens",
      "memory.consolidation.retention",
    ]) {
      expect(source, chemin).toContain(`path: "${chemin}"`);
    }
    // ⚠️ Le fuseau de PLANIFICATION est dit distinct de celui des horodatages.
    expect(source).toContain("Distinct du fuseau d'AFFICHAGE");
  });

  it("le miroir FIELD_DEFAULTS porte les mêmes défauts que le schéma", () => {
    const source = fichier("config.js") + CONFIG_CATALOGUE;
    expect(source).toContain('"memory.consolidation.enabled": "on"');
    expect(source).toContain('"memory.consolidation.cron": "0 3 * * 0"');
    expect(source).toContain('"memory.consolidation.timeZone": "Europe/Paris"');
    expect(source).toContain('"memory.consolidation.budgetTokens": 200000');
    expect(source).toContain('"memory.consolidation.retention": 12');
  });
});

describe("bloc « Versions de la mémoire » (panneau Personnalité)", () => {
  const source = fichier("personality-panel.js");

  it("liste les versions, les télécharge et les restaure", () => {
    expect(source).toContain("/api/memory/versions/");
    expect(source).toContain("/download");
    expect(source).toContain("/restore");
    expect(source).toContain("Télécharger");
    expect(source).toContain("Restaurer");
    expect(source).toContain("Versions de la mémoire");
  });

  it("affiche le rapport de mesure (tokens, contexte, budget, lots, %)", () => {
    expect(source).toContain("tokensEstimes");
    expect(source).toContain("contexteModele");
    expect(source).toContain("budgetTokens");
    expect(source).toContain("pourcentContexte");
    expect(source).toContain("nonExaminees");
    expect(source).toContain("hypothese");
  });

  it("confirme la restauration par `HolafModal` (jamais une boîte native)", async () => {
    expect(source).toContain("HolafModal.confirm");
    expect(source).toContain("Restaurer cette version");
    // Le mot n'apparaît que dans un commentaire ; aucun APPEL réel.
    expect(source).not.toMatch(/window\.confirm\s*\(/);
  });

  it("n'écrit aucun HTML brut et aucun style en ligne (CSP stricte)", () => {
    // Aucune AFFECTATION de HTML brut (le mot peut apparaître en commentaire).
    expect(source).not.toMatch(/\.innerHTML\s*=/);
    // Aucun attribut `style=` sur un élément (le mot apparaît en commentaire).
    expect(source).not.toMatch(/["']style["']\s*:/);
    // La CSP n'a pas été élargie pour ce lot.
    const csp = readFileSync(join(RACINE, "src", "gateway", "routes", "static.ts"), "utf8");
    expect(csp).toContain("default-src 'none'; script-src 'self'; style-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
  });
});
