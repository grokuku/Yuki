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
  "files.imageRequestBudgetBytes",
  "files.retentionDays",
  "files.maxAttachments",
  "files.promptChars",
  "files.promptTotalChars",
] as const;

describe("configuration des fichiers", () => {
  it("les huit champs existent, sont des entiers appliqués À CHAUD", () => {
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

  it("le plafond d'IMAGES PAR REQUÊTE vaut 1 500 000 octets base64 et est BRANCHÉ deux fois", () => {
    // ⚠️ Une borne PAR IMAGE ne suffit pas : le SDK renvoie à CHAQUE tour tout
    // l'historique, donc une image déjà vue repartait dans chaque requête
    // (mesuré : 2,4 Mo de corps après trois images vues, `500 request entity too
    // large` alors que le contexte TEXTE était minuscule).
    const descriptor = CONFIG_SCHEMA["files.imageRequestBudgetBytes"] as FieldDescriptor;
    expect(descriptor.type).toBe("int");
    expect(descriptor.apply).toBe("hot");
    expect(descriptor.default).toBe(1_500_000);
    // Au moins deux images pleines (`files.imageMaxWireBytes` = 700 000), sinon la
    // pièce jointe du tour et le résultat d'outil ne tiendraient pas ensemble.
    expect(descriptor.default).toBeGreaterThanOrEqual(2 * 700_000);
    expect(descriptor.max).toBe(60_000_000);
    expect(descriptor.min).toBe(1_000);
    expect(validateDescriptor(descriptor, 999).ok).toBe(false);
    expect(validateDescriptor(descriptor, 1_000).ok).toBe(true);
    expect(validateDescriptor(descriptor, 60_000_001).ok).toBe(false);
    expect(descriptor.env).toBe("YUKI_FILES_IMAGE_REQUEST_BUDGET_BYTES");

    // BRANCHÉ deux fois : session LÉGÈRE (sdk-host) ET worker LOURD (par tâche).
    // ⚠️ LOT 36 (L7) — GARDE MISE À JOUR (nommée) : le worker lourd est construit
    // PAR BOT, donc sa borne est lue dans la configuration DU BOT (repli sur
    // celle de l'instance). La règle vérifiée est la même : DEUX branchements.
    const index = readFileSync(join(process.cwd(), "src", "index.ts"), "utf8");
    const leger = index.split(
      'imageRequestBudgetBytes: () => config.getNumber("files.imageRequestBudgetBytes")',
    ).length - 1;
    const lourd = index.split(
      'imageRequestBudgetBytes: () =>\n          (configsBots.get(botId) ?? config).getNumber("files.imageRequestBudgetBytes")',
    ).length - 1;
    expect(leger).toBe(1);
    expect(lourd).toBe(1);
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
