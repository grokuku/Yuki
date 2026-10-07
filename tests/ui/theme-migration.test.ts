/**
 * Migration des préférences de thème (LOT 3 — refonte V2 holaf-lib).
 *
 * Contexte : le catalogue `tokens` passe de 0.3.0 (5 familles :
 * indigo/midnight/slate/emerald/amber) à 0.4.0 (6 familles : corail/ambre/
 * emeraude/turquoise/amethyste/neutre). Les anciens noms de presets N'EXISTENT
 * PLUS côté brique : un `setTheme("indigo-dark")` jetterait « preset inconnu ».
 *
 * Exigence : AUCUNE préférence utilisateur perdue. `theme.js` convertit donc
 * la valeur mémorisée via `HolafTokens.MIGRATIONS` (table portée par la brique
 * 0.4.0) — avec un repli statique strictement identique si la brique manque.
 *
 * Ce test exerce la logique PURE (`normalizeStored` / `legacyTarget`) dans les
 * DEUX chemins : (1) sans brique chargée (repli statique), (2) avec la table
 * `HolafTokens.MIGRATIONS`. Le comportement navigateur de bout en bout (les
 * vrais contrôles, la réécriture dans localStorage) est prouvé par
 * `_tools/e2e-theme.mjs`.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { FAMILIES, legacyTarget, normalizeStored } from "../../public/ui/theme.js";

/** V1 → V2 attendu (identifié par la note de migration de la brique). */
const OLD_TO_NEW: ReadonlyArray<[string, string]> = [
  ["indigo-light", "amethyste-light"],
  ["indigo-dark", "amethyste-dark"],
  ["midnight-light", "amethyste-light"],
  ["midnight-dark", "amethyste-dark"],
  ["slate-light", "neutre-light"],
  ["slate-dark", "neutre-dark"],
  ["emerald-light", "emeraude-light"],
  ["emerald-dark", "emeraude-dark"],
  ["amber-light", "ambre-light"],
  ["amber-dark", "ambre-dark"],
  ["dark", "amethyste-dark"],
  ["light", "amethyste-light"],
  ["midnight", "amethyste-dark"],
  ["slate", "neutre-dark"],
];

const DEFAULT_PRESET = "neutre-dark";
const V2_PRESETS = [
  "corail-light", "corail-dark",
  "ambre-light", "ambre-dark",
  "emeraude-light", "emeraude-dark",
  "turquoise-light", "turquoise-dark",
  "amethyste-light", "amethyste-dark",
  "neutre-light", "neutre-dark",
];

describe("Familles V2 de l'UI Yuki", () => {
  it("expose les 6 familles attendues (libellés = identifiants côté markup)", () => {
    expect(FAMILIES).toEqual(["corail", "ambre", "emeraude", "turquoise", "amethyste", "neutre"]);
  });
});

describe("Migration des préférences — table de repli statique (sans brique)", () => {
  it("convertit les 10 anciens presets et les 4 alias vers les familles V2", () => {
    for (const [old, expected] of OLD_TO_NEW) {
      expect(legacyTarget(old), old).toBe(expected);
    }
  });

  it("normalizeStored : ancien nom → preset V2, marqué `migrated`", () => {
    for (const [old, expected] of OLD_TO_NEW) {
      expect(normalizeStored(old), old).toEqual({ preset: expected, migrated: true });
    }
  });
});

describe("Migration des préférences — via HolafTokens.MIGRATIONS", () => {
  // Le chemin navigateur réel : `window.HolafTokens` (brique chargée) fournit
  // la table. En Node, la brique s'expose sur globalThis : on l'alias à window.
  beforeAll(() => {
    const g = globalThis as unknown as { HolafTokens?: unknown; window?: unknown };
    expect(g.HolafTokens, "la brique tokens doit s'être exposée à l'import").toBeTruthy();
    g.window = globalThis;
  });

  it("la table de la brique (0.4.0) est bien celle appliquée", () => {
    const table = (globalThis as unknown as { HolafTokens: { MIGRATIONS: Record<string, string> } })
      .HolafTokens.MIGRATIONS;
    for (const [old, expected] of OLD_TO_NEW) {
      expect(table[old], old).toBe(expected);
      expect(legacyTarget(old), old).toBe(expected);
      expect(normalizeStored(old), old).toEqual({ preset: expected, migrated: true });
    }
  });
});

describe("Migration des préférences — idempotence, inconnu, absence", () => {
  it("un preset V2 est conservé tel quel, SANS réécriture (idempotence)", () => {
    for (const preset of V2_PRESETS) {
      expect(normalizeStored(preset), preset).toEqual({ preset, migrated: false });
    }
  });

  it("idempotence : rejouer la migration d'une valeur déjà migrée ne change rien", () => {
    const first = normalizeStored("indigo-dark");
    expect(first).toEqual({ preset: "amethyste-dark", migrated: true });
    const second = normalizeStored(first.preset);
    expect(second).toEqual({ preset: "amethyste-dark", migrated: false });
  });

  it("valeur inconnue → défaut `neutre-dark`, marquée `migrated`", () => {
    for (const junk of ["valeur-inconnue", "corail", "indigo", "indigo-", "-dark", " ", "42"]) {
      expect(normalizeStored(junk), JSON.stringify(junk)).toEqual({
        preset: DEFAULT_PRESET,
        migrated: true,
      });
    }
  });

  it("ancien « système » (chaîne vide) → défaut", () => {
    expect(normalizeStored("")).toEqual({ preset: DEFAULT_PRESET, migrated: true });
  });

  it("clé ABSENTE (null) → défaut SANS réécriture (première visite)", () => {
    expect(normalizeStored(null)).toEqual({ preset: DEFAULT_PRESET, migrated: false });
  });

  it("aucun type inattendu ne fait planter la normalisation", () => {
    for (const value of [undefined, 0, 1, {}, [], true, false, Symbol("s")]) {
      expect(() => normalizeStored(value as unknown as string)).not.toThrow();
      expect(normalizeStored(value as unknown as string).preset).toBe(DEFAULT_PRESET);
    }
    expect(() => legacyTarget(undefined as unknown as string)).not.toThrow();
    expect(legacyTarget(undefined as unknown as string)).toBeNull();
  });

  it("toute migration pointe vers un preset RÉELLEMENT présent dans le catalogue", () => {
    for (const [old] of OLD_TO_NEW) {
      const target = normalizeStored(old).preset;
      expect(V2_PRESETS, `${old} → ${target}`).toContain(target);
    }
  });
});
