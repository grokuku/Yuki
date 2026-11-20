/**
 * GARDES **STATIQUES** DU CÂBLAGE DU PROMPT LOURD (audit 2026-11-20).
 *
 * ⚠️ POURQUOI STATIQUES : `main()` n'est JAMAIS exécuté par les tests. Le
 * câblage du prompt du worker lourd et du registre de workers ne peut donc être
 * vérifié que par `tsc` (qui voit les ports) et par ces gardes sur la SOURCE.
 *
 * ⚠️ La correction est PARTAGÉE par tous les chemins (run planifié, étape de
 * chaîne, déclencheur, run DISTANT et délégation WEB) : ils passent tous par
 * `creerWorkerLourd(botId)` → `WorkersLourdsBots.pour(botId)`. Ce fichier nomme
 * la ligne unique qui le garantit.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");

function source(...morceaux: string[]): string {
  return readFileSync(join(SRC, ...morceaux), "utf8");
}

describe("câblage du prompt lourd — gardes statiques (audit 2026-11-20)", () => {
  const index = source("index.ts");
  const workers = source("bots", "workers.ts");
  const promptLourd = source("bots", "prompt-lourd.ts");

  it("le prompt du worker lourd vient de `composerPromptLourd` (bot propriétaire)", () => {
    // ⚠️ Échoue sur l'origine : le câblage appelait `composerPromptSysteme` avec
    // `role: "heavy"`, sans personnalité ni consignes.
    expect(index).toContain("composerPromptLourd({");
    expect(promptLourd).toContain('options.config.getString("prompts.heavy")');
    // Les ports sont construits POUR CE BOT (jamais ceux de la pile).
    expect(index).toContain("consignes: portConsignes({");
    expect(index).toContain("regles: portReglesDuBot({");
    expect(index).toContain("chemin: outilsBot?.chemins.consignesPath ?? env.consignesPath");
    expect(index).toContain("cheminBot: outilsBot?.chemins.rulesPath ?? env.rulesPath");
  });

  it("la mémoire du worker est celle du BOT (résolue par son identifiant)", () => {
    // ⚠️ Échoue sur l'origine : `memoire` n'était pas passé au worker.
    expect(index).toContain("memoire: () => servicesMemoire?.pour(botId),");
    // Archives de RECHERCHE : les ports sont ceux du bot, et la politique les
    // ouvre quand ils existent (capacité `memoire`).
    expect(index).toContain("heritage: () => {");
    expect(index).toContain("conversationArchive: () =>");
    expect(index).toContain("heritageEnabled: heritageDisponible");
    expect(index).toContain("conversationArchiveEnabled: archiveDisponible");
    expect(index).toContain("outilsBotsParId?.get(botId)?.archive");
  });

  it("le plafond figé de workers a disparu ; un plafond imposé est DIT", () => {
    // ⚠️ Échoue sur l'origine : `plafond: MAX_WORKERS_LOURDS_DEFAUT` (3).
    expect(index).not.toContain("plafond: MAX_WORKERS_LOURDS_DEFAUT");
    expect(workers).toContain("MAX_WORKERS_LOURDS_DEFAUT = Number.POSITIVE_INFINITY");
    // Le dépassement (si un opérateur impose un plafond) remonte au modèle.
    expect(index).toContain("workerRefus: (botId) =>");
    expect(index).toContain("workersLourds?.refusLisible(botId)");
  });

  it("un bot arrêté libère son worker (hook branché sur `oublier`)", () => {
    // ⚠️ Échoue sur l'origine : `oublier` retirait la référence sans libérer.
    expect(index).toContain("liberer: (botId, worker) =>");
    expect(index).toContain("workersLourds?.oublier(botId);");
  });

  it("le run DISTANT et la délégation WEB passent par le worker du BOT", () => {
    // Un seul site de fabrique, indexé par `botId` : les trois chemins différés
    // (planifié, déclencheur, délégation distante/web) en héritent.
    expect(index).toContain("const creerWorkerLourd = (botId: string)");
    expect(index).toContain("heavyPour: (botId) =>");
    expect(index).toContain(": workersLourds?.pour(botId),");
  });
});
