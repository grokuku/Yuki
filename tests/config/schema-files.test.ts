/**
 * Configuration des FICHIERS échangés (`files.*`).
 *
 * Les bornes sont des GARDE-FOUS, pas des réglages cosmétiques : le plafond de
 * taille protège le volume `state` (partagé avec la configuration, la mémoire et
 * les conversations), la rétention borne la durée de vie, et les bornes
 * d'injection bornent ce qui part réellement au modèle.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CONFIG_SCHEMA, validateDescriptor, type FieldDescriptor } from "../../src/config/schema.js";

const PATHS = [
  "files.maxFileBytes",
  "files.imageMaxBytes",
  "files.imageMaxWireBytes",
  "files.retentionDays",
  "files.maxAttachments",
  "files.promptChars",
  "files.promptTotalChars",
] as const;

describe("configuration des fichiers", () => {
  it("les sept champs existent, sont des entiers appliqués À CHAUD", () => {
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

  it("le plafond de VISION vaut 3 500 000 octets par défaut (~4,7 Mio en base64)", () => {    const descriptor = CONFIG_SCHEMA["files.imageMaxBytes"] as FieldDescriptor;
    expect(descriptor.type).toBe("int");
    expect(descriptor.default).toBe(3_500_000);
    expect(descriptor.max).toBe(20_000_000);
    // 1 octet est une valeur LÉGALE (tout refuser), 0 ne l'est pas.
    expect(descriptor.min).toBe(1);
    expect(validateDescriptor(descriptor, 0).ok).toBe(false);
    expect(validateDescriptor(descriptor, 1).ok).toBe(true);
    expect(validateDescriptor(descriptor, 20_000_001).ok).toBe(false);
    expect(descriptor.env).toBe("YUKI_FILES_IMAGE_MAX_BYTES");
  });

  it("le plafond TRANSMIS vaut 700 000 octets base64 (la cible : quelques centaines de Ko)", () => {
    // ⚠️ C'est LA borne qui a manqué (incident du 2026-11-01) : exprimée en octets
    // d'ORIGINE, elle laissait partir 4 666 668 octets de base64 et le fournisseur
    // répondait `500 « request entity too large »`.
    const descriptor = CONFIG_SCHEMA["files.imageMaxWireBytes"] as FieldDescriptor;
    expect(descriptor.type).toBe("int");
    expect(descriptor.apply).toBe("hot");
    expect(descriptor.default).toBe(700_000);
    // Sous ~1 Mo transmis : c'est la mesure du chemin qui FONCTIONNE (479,5 Ko).
    expect(descriptor.default).toBeLessThan(1_000_000);
    expect(descriptor.max).toBe(20_000_000);
    expect(descriptor.min).toBe(1_000);
    expect(validateDescriptor(descriptor, 999).ok).toBe(false);
    expect(validateDescriptor(descriptor, 1_000).ok).toBe(true);
    expect(validateDescriptor(descriptor, 20_000_001).ok).toBe(false);
    expect(descriptor.env).toBe("YUKI_FILES_IMAGE_MAX_WIRE_BYTES");
  });

  it("le plafond TRANSMIS est BRANCHÉ et RELU à chaque message (sinon le réglage est mort)", () => {
    // Même méthode que `tests/pi/boundary.test.ts` : on lit la composition root.
    const index = readFileSync(join(process.cwd(), "src", "index.ts"), "utf8");
    expect(index).toContain(
      'imageMaxWireBytes: () => config.getNumber("files.imageMaxWireBytes")',
    );
    const service = readFileSync(join(process.cwd(), "src", "files", "service.ts"), "utf8");
    expect(service).toContain("maxWireBytes: wireLimit");
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
