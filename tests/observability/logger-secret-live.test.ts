/**
 * Redaction des secrets — liste MUTABLE EN PLACE.
 *
 * ⚠️ POURQUOI CE TEST EXISTE : au démarrage, le logger reçoit un instantané des
 * clés connues. Si l'utilisateur saisit une NOUVELLE clé via `/config` APRÈS le
 * démarrage, cette clé doit être masquée elle aussi. `src/index.ts` garde donc
 * la RÉFÉRENCE du tableau `secretValues` et le met à jour à chaque changement de
 * configuration. Ce test prouve que la mutation EN PLACE suffit — un tableau
 * recopié (nouvelle référence) laisserait fuir la nouvelle clé.
 */

import { describe, expect, it } from "vitest";

import { createLogger } from "../../src/observability/logger.js";

describe("logger — redaction d'un secret ajouté à chaud", () => {
  it("masque une clé ajoutée APRÈS la création quand le tableau est muté en place", () => {
    const lines: string[] = [];
    const secretValues: string[] = [];
    const logger = createLogger({
      level: "debug",
      sink: (line) => lines.push(line),
      secretValues,
    });

    // La clé n'est pas encore connue : elle apparaîtrait en clair.
    logger.info("avant", { detail: "sk-old-000000" });
    expect(lines.at(-1)).toContain("sk-old-000000");

    // Nouvelle clé saisie à chaud : on MUTE le même tableau (référence partagée).
    secretValues.splice(0, secretValues.length, "sk-new-111111");

    logger.info("apres", { detail: "la clé est sk-new-111111 ici" });
    expect(lines.at(-1)).not.toContain("sk-new-111111");
    expect(lines.at(-1)).toContain("[REDACTED]");
  });

  it("masque aussi une clé passée dans un message libre non structuré", () => {
    const lines: string[] = [];
    const secretValues = ["sk-live-222222"];
    const logger = createLogger({
      level: "debug",
      sink: (line) => lines.push(line),
      secretValues,
    });
    logger.error("échec Authorization: Bearer sk-live-222222");
    expect(lines.at(-1)).not.toContain("sk-live-222222");
  });
});
