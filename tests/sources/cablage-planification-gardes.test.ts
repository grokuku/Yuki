/**
 * AUDIT 2026-11-20 — GARDES **STATIQUES** DU CÂBLAGE DE `main()`.
 *
 * ⚠️ POURQUOI STATIQUES : `main()` n'est JAMAIS exécuté par les tests (il ouvre le
 * port, les hosts, les workers). Le câblage des trois défauts ne peut donc être
 * vérifié que par `tsc` (qui voit les ports) et par ces gardes sur la SOURCE : elles
 * nomment la ligne qui, si elle revenait, rouvrirait le défaut.
 *
 * Ce qui est VERROUILLÉ ici :
 *  ① `planifier_tache` / `programmer_envoi` d'un run distant sont construits PAR BOT
 *    (`portsPlanificationPour(botDuTourDistant(…))`), plus jamais avec les ports de la
 *    pile ;
 *  ② `BalayeurBots` ne reçoit AUCUN journal global : le journal vient de la cible
 *    (une ligne par bot) ;
 *  ③ l'état des hosts est un RELAIS MUTABLE lu à chaque tick (`hostEstDemarre`), pas
 *    la décision `aDemarrer` figée au démarrage.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");

function source(...morceaux: string[]): string {
  return readFileSync(join(SRC, ...morceaux), "utf8");
}

describe("câblage de main() — gardes statiques (audit 2026-11-20)", () => {
  const index = source("index.ts");
  /** Période EXACTE du générateur de réponse distante (`runTools` → `createWriter`). */
  const debutRunDistant = index.indexOf("runTools: (conversationId, onFileProduced, contexte) =>");
  const finRunDistant = index.indexOf("createWriter: (run, conversationId, botRecu) =>");
  const blocRunDistant = index.slice(debutRunDistant, finRunDistant);

  it("① les ports de planification d'un run distant sont ceux du BOT DU TOUR", () => {
    expect(debutRunDistant).toBeGreaterThan(-1);
    expect(finRunDistant).toBeGreaterThan(debutRunDistant);
    // ⚠️ Échoue sur l'origine : `envoisProgrammes: portEnvoisProgrammes` et
    // `planifierTache: portPlanificationTache` (la PILE) étaient passés à TOUS les
    // canaux — la tâche de `grolaf` était écrite et exécutée par le bot du run.
    expect(blocRunDistant).not.toContain("envoisProgrammes: portEnvoisProgrammes,");
    expect(blocRunDistant).not.toContain("planifierTache: portPlanificationTache,");
    // Deux sites d'appel (envois + tâche) dans CE bloc.
    expect(blocRunDistant.split("portsPlanificationPour(").length - 1).toBe(2);
    // Le bot vient de l'ADAPTATEUR (`contexte.botId`), pas d'une constante.
    expect(blocRunDistant).toContain("botDuTourDistant(conversationId, contexte.botId)");
  });

  it("① le run LOCAL garde les ports de la PILE (aucune régression du fil web)", () => {
    // `optionsHostPile` est le host du bot AFFICHÉ : ses outils restent ceux de la pile.
    expect(index).toContain("envoisProgrammes: portEnvoisProgrammes,\n");
    expect(index).toContain("planifierTache: portPlanificationTache,\n");
  });

  it("② `BalayeurBots` n'est construit avec AUCUN journal global", () => {
    // ⚠️ Échoue sur l'origine : `BalayeurBots` était construit sans `journal`, et le
    // `DeclencheurBalayeur` interne n'en recevait donc aucun ⇒ `saut`, `plafond` et
    // `desactive` n'étaient jamais écrits.
    const debut = index.indexOf("declencheursBalayeur = new BalayeurBots({");
    expect(debut).toBeGreaterThan(-1);
    const bloc = index.slice(debut, index.indexOf("declencheursBalayeur.start()", debut));
    expect(bloc).not.toMatch(/^\s{6}journal:/m);
    // ⚠️ Le journal de repli du balayeur reste possible pour les doubles de test :
    // c'est `CibleBalayage.journal` (par bot) qui doit exister côté sources.
    expect(source("sources", "par-bot.ts")).toContain("journal: pile.journal");
  });

  it("③ le balayeur lit l'état RÉEL des hosts (relais mutable, pas `aDemarrer`)", () => {
    // ⚠️ Échoue sur l'origine : les cibles venaient de `aDemarrer`, figé au boot.
    expect(index).toContain("let hostEstDemarre: (botId: string) => boolean");
    expect(index).toContain("estDemarre: (botId) => hostEstDemarre(botId)");
    // Le relais est posé APRÈS la construction des hosts : c'est la ligne qui rend
    // l'activation à chaud visible au tick suivant.
    expect(index).toContain(
      "hostEstDemarre = (botId) => hostsBots?.estDemarre(botId) ?? botId === botDuRun;",
    );
  });

  it("④ un bot sans host démarré n'a AUCUN repli sur le host de l'instance", () => {
    // ⚠️ Échoue sur l'origine : `const hote = hostsBots?.pourDemarre(botId) ?? hoteSources;`
    // ⇒ `sessionAlive` interrogeait les sessions d'un AUTRE bot, le `sessionId` de la
    // tâche était EFFACÉ et un fil « Déclencheurs » naissait chez le bot du run.
    const debut = index.indexOf("brancherServiceSources = (service, botId) => {");
    const fin = index.indexOf("const ports = portsDeclencheurPour(botId);", debut);
    expect(debut).toBeGreaterThan(-1);
    expect(fin).toBeGreaterThan(debut);
    const bloc = index.slice(debut, fin);
    expect(bloc).not.toContain("?? hoteSources");
    expect(bloc).not.toContain("pourDemarre(botId) ??");
    // Le refus NOMMÉ est le seul repli autorisé.
    expect(bloc).toContain("const hote = hostDuBot(botId) ?? hoteSansHost(botId);");
    // ⚠️ AUDIT (③) : la pile du bot du run n'est jamais « branchée » — son signalement
    // de tâches interrompues est donc posé à côté de son waker.
    expect(index).toContain("sourcesService.signalerTachesInterrompues();");
  });
});
