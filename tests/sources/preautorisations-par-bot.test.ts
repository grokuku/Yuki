/**
 * ⚠️ LOT 36 (L11) — PRÉ-AUTORISATIONS CONSOMMÉES AU NOM DU BOT DU RUN.
 *
 * Ce que ce test verrouille : le démarrage branche un port PAR SERVICE
 * D'EXÉCUTION, adossé au registre de SON bot (`<state>/bots/<bot>/preautorisations.json`).
 * Un job de `kohai` ne peut donc plus consommer — ni se voir refuser — une
 * autorisation de `yuki`.
 *
 * ⚠️ Échoue sur le code d'origine : le démarrage passait le MÊME port (lié à
 * `botDuRun`, donc au bot de la pile) à TOUS les services
 * (`executionsAgents.pourChacun(setPreAutorisations)`), et
 * `brancherPreAutorisationsParBot` n'existait pas.
 */

import { describe, expect, it } from "vitest";

import { ExecutionsAgentsBots } from "../../src/agents/executions-bots.js";
import { brancherPreAutorisationsParBot, portPreAutorisations } from "../../src/sources/par-bot.js";
import type { SourcesParBot } from "../../src/sources/par-bot.js";

const journal = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Service d'exécution FACTICE : retient le port qu'on lui pose. */
class FauxService {
  port: { consommer(demande: { declencheur: string }): unknown } | undefined;
  setPreAutorisations(port: { consommer(demande: { declencheur: string }): unknown }): void {
    this.port = port;
  }
}

/**
 * `SourcesParBot` FACTICE : `pourBot(id)` rend un registre qui NOTE le bot dont
 * il a consommé — c'est exactement ce qui doit rester distinct.
 */
function parBotFactice(consommations: string[]): SourcesParBot {
  return {
    pourBot: (botId: string) => {
      const registre = {
        consommer: (demande: { declencheur: string }) => {
          consommations.push(`${botId}:${demande.declencheur}`);
          return { kind: "aucun" as const };
        },
      };
      return { preAutorisations: registre };
    },
  } as unknown as SourcesParBot;
}

describe("pré-autorisations par bot (lot 36, L11)", () => {
  it("chaque service consomme dans le registre de SON bot (jamais celui du principal)", () => {
    const consommations: string[] = [];
    const parBot = parBotFactice(consommations);

    const executions = new ExecutionsAgentsBots<FauxService>({
      botDuRun: "yuki",
      bots: ["kohai"],
      creer: () => new FauxService(),
      logger: journal,
    });

    // ⚠️ Le branchement de PRODUCTION : le port est construit par bot.
    brancherPreAutorisationsParBot(executions, (botId) =>
      portPreAutorisations(parBot, () => botId),
    );

    // Un job de `kohai` (déclencheur) consomme : c'est SON registre qui est lu.
    executions.pour("kohai")?.port?.consommer({ declencheur: "hebdo" });
    executions.pour("yuki")?.port?.consommer({ declencheur: "quotidien" });

    expect(consommations).toEqual(["kohai:hebdo", "yuki:quotidien"]);
    // ⚠️ Et surtout : les deux services n'ont PAS le même port (l'ancien
    // branchement en donnait un seul, donc un nom unique pour tous).
    expect(executions.pour("kohai")?.port).not.toBe(executions.pour("yuki")?.port);
  });

  it("un bot sans service d'exécution n'est pas branché (aucun port fabriqué)", () => {
    const fabriques: string[] = [];
    const executions = new ExecutionsAgentsBots<FauxService>({
      botDuRun: "yuki",
      bots: ["kohai"],
      creer: () => new FauxService(),
      logger: journal,
    });
    brancherPreAutorisationsParBot(executions, (botId) => {
      fabriques.push(botId);
      return portPreAutorisations(parBotFactice([]), () => botId);
    });
    expect(fabriques).toEqual(["yuki", "kohai"]);
    expect(executions.pour("senpai")).toBeUndefined();
  });
});
