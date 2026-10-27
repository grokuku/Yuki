/**
 * Configuration des FICHIERS échangés (`files.*`).
 *
 * Les bornes sont des GARDE-FOUS, pas des réglages cosmétiques : le plafond de
 * taille protège le volume `state` (partagé avec la configuration, la mémoire et
 * les conversations), la rétention borne la durée de vie, et les bornes
 * d'injection bornent ce qui part réellement au modèle.
 */

import { describe, expect, it } from "vitest";

import { CONFIG_SCHEMA, validateDescriptor, type FieldDescriptor } from "../../src/config/schema.js";

const PATHS = [
  "files.maxFileBytes",
  "files.retentionDays",
  "files.maxAttachments",
  "files.promptChars",
  "files.promptTotalChars",
] as const;

describe("configuration des fichiers", () => {
  it("les cinq champs existent, sont des entiers appliqués À CHAUD", () => {
    for (const path of PATHS) {
      const descriptor = CONFIG_SCHEMA[path] as FieldDescriptor | undefined;
      expect(descriptor, path).toBeDefined();
      expect(descriptor?.type).toBe("int");
      expect(descriptor?.apply).toBe("hot");
      expect(typeof descriptor?.default).toBe("number");
    }
  });

  it("le plafond par fichier vaut 2 Gio par défaut et reste TRÈS HAUT", () => {
    const descriptor = CONFIG_SCHEMA["files.maxFileBytes"] as FieldDescriptor;
    expect(descriptor.default).toBe(2_147_483_648);
    expect(descriptor.max).toBe(8_589_934_592);
    // Un plafond trop bas refuserait des fichiers legitimes : au moins 1 Mio.
    expect(descriptor.min).toBe(1_048_576);
  });

  it("la rétention vaut 30 jours par défaut", () => {
    expect((CONFIG_SCHEMA["files.retentionDays"] as FieldDescriptor).default).toBe(30);
  });

  it("les bornes sont VALIDÉES (refus hors plage, entier attendu)", () => {
    const descriptor = CONFIG_SCHEMA["files.maxFileBytes"] as FieldDescriptor;
    expect(validateDescriptor(descriptor, "1024").ok).toBe(false);
    expect(validateDescriptor(descriptor, 1_048_576).ok).toBe(true);
    expect(validateDescriptor(descriptor, "pas un nombre").ok).toBe(false);
    const retention = CONFIG_SCHEMA["files.retentionDays"] as FieldDescriptor;
    expect(validateDescriptor(retention, 0).ok).toBe(false);
    expect(validateDescriptor(retention, 30).ok).toBe(true);
  });

  it("aucun de ces champs n'est un SECRET (jamais masqué : ce sont des bornes)", () => {
    for (const path of PATHS) {
      expect(CONFIG_SCHEMA[path]?.secret).toBeUndefined();
    }
  });
});
