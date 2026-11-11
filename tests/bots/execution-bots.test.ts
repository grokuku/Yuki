/**
 * LOT 36 (L8) — L'ÉTAT RÉEL DES BOTS, ET DÉMARRER / ARRÊTER PAR BOT.
 *
 * ⚠️ Ces tests ÉCHOUENT sur le code d'origine : `src/bots/execution.ts` n'existe
 * pas, `GET /api/bots` n'a que le champ `actif` du REGISTRE (qui ment : un bot
 * allumé dont le host a échoué s'affiche « actif »), et aucune route ne démarre
 * ni n'arrête un bot (L2 n'écrit qu'un drapeau, « effet au redémarrage »).
 *
 * Ce qui est verrouillé ici :
 *  ① l'état vient de l'EXÉCUTION (`demarre`, `erreur`, `sessions`, `workers`),
 *    jamais du registre ;
 *  ② DÉMARRER **crée** la pile PUIS le host (sinon le bouton ne fait rien) ;
 *  ③ ARRÊTER **détruit** host + pile, et laisse `demarre: false` ;
 *  ④ arrêt IDEMPOTENT (déjà arrêté ⇒ aucune étape, `inchange: true`) ;
 *  ⑤ le bot PRINCIPAL est refusé, en le disant (ni démarré ni arrêté par ici) ;
 *  ⑥ une erreur de démarrage est MÉMORISÉE et affichée, jamais avalée.
 */

import { describe, expect, it } from "vitest";

import type { ArretBotLogger } from "../../src/bots/arret.js";
import { ExecutionBots, type HostsCyclePort } from "../../src/bots/execution.js";

function journalEspion(): ArretBotLogger & { lignes: string[] } {
  const lignes: string[] = [];
  const noter = (message: string): void => {
    lignes.push(message);
  };
  return { lignes, info: noter, warn: noter };
}

/** Hosts FACTICES : la Map et les compteurs sont observés de l'extérieur. */
function hostsFactices(options: { echecDemarrage?: string } = {}) {
  const construits = new Set<string>();
  const demarres = new Set<string>();
  const port: HostsCyclePort = {
    estConstruit: (botId) => construits.has(botId),
    estDemarre: (botId) => demarres.has(botId),
    demarrerBot: async (botId) => {
      if (options.echecDemarrage === botId) {
        return { ok: false, inchange: false, erreur: "start a échoué" };
      }
      const inchange = demarres.has(botId);
      construits.add(botId);
      demarres.add(botId);
      return { ok: true, inchange };
    },
    arreterBot: async (botId) => {
      const inchange = !construits.has(botId);
      construits.delete(botId);
      demarres.delete(botId);
      return { ok: true, inchange };
    },
  };
  return { port, construits, demarres };
}

interface Banc {
  execution: ExecutionBots;
  hosts: ReturnType<typeof hostsFactices>;
  pilesOuvertes: string[];
  pilesFermees: string[];
  appels: string[];
  workers: Set<string>;
  sessions: Map<string, number>;
  log: ReturnType<typeof journalEspion>;
}

function banc(
  options: { echecDemarrage?: string; connexions?: string[] } = {},
): Banc {
  const hosts = hostsFactices(options);
  // ⚠️ Le bot PRINCIPAL tourne dès le démarrage (c'est `main()` qui le démarre) :
  // c'est l'état de départ réaliste de l'instance.
  hosts.construits.add("yuki");
  hosts.demarres.add("yuki");
  const pilesOuvertes: string[] = [];
  const pilesFermees: string[] = [];
  const appels: string[] = [];
  const workers = new Set<string>();
  const sessions = new Map<string, number>([["yuki", 3], ["kohai", 7]]);
  const log = journalEspion();
  const execution = new ExecutionBots({
    botDePile: "yuki",
    hosts: hosts.port,
    ouvrirPile: (botId) => pilesOuvertes.push(botId),
    fermerPile: (botId) => pilesFermees.push(botId),
    sessions: (botId) => sessions.get(botId) ?? 0,
    workers: { a: (botId) => workers.has(botId) },
    ...(options.connexions !== undefined
      ? { connecterPlateformes: async (botId: string) => void options.connexions?.push(botId) }
      : {}),
    etapesArret: () => ({
      run: () => void appels.push("run"),
      sources: () => void appels.push("sources"),
      memory: () => void appels.push("memory"),
      tts: () => void appels.push("tts"),
      plateforme: () => void appels.push("plateforme"),
    }),
    logger: log,
  });
  return {
    execution,
    hosts,
    pilesOuvertes,
    pilesFermees,
    appels,
    workers,
    sessions,
    log,
  };
}

describe("ExecutionBots.etat — l'EXÉCUTION, pas le registre", () => {
  it("un bot sans host démarré est dit ARRÊTÉ, quelles que soient ses données", () => {
    const b = banc();
    expect(b.execution.etat("kohai")).toEqual({ demarre: false, sessions: 7, workers: 0 });
  });

  it("démarré ⇒ demarre: true ; worker construit ⇒ workers: 1", () => {
    const b = banc();
    b.hosts.construits.add("kohai");
    b.hosts.demarres.add("kohai");
    b.workers.add("kohai");
    expect(b.execution.etat("kohai")).toEqual({ demarre: true, sessions: 7, workers: 1 });
  });

  it("les sessions sont celles du BOT (pas un total)", () => {
    const b = banc();
    expect(b.execution.etat("yuki").sessions).toBe(3);
    expect(b.execution.etat("kohai").sessions).toBe(7);
    expect(b.execution.etat("fantome").sessions).toBe(0);
  });
});

describe("DÉMARRER — crée la pile puis le host", () => {
  it("ouvre la pile AVANT de démarrer le host, et rend l'état réel", async () => {
    const b = banc();
    const issue = await b.execution.demarrer("kohai");

    expect(b.pilesOuvertes).toEqual(["kohai"]);
    expect(b.hosts.demarres.has("kohai")).toBe(true);
    expect(issue.ok).toBe(true);
    expect(issue.inchange).toBe(false);
    expect(issue.etat).toEqual({ demarre: true, sessions: 7, workers: 0 });
  });

  it("un bot déjà démarré ⇒ inchange, aucune erreur", async () => {
    const b = banc();
    await b.execution.demarrer("kohai");
    const second = await b.execution.demarrer("kohai");
    expect(second.ok).toBe(true);
    expect(second.inchange).toBe(true);
  });

  it("un démarrage qui échoue est MÉMORISÉ et affiché (`erreur`), jamais avalé", async () => {
    const b = banc({ echecDemarrage: "kohai" });
    const issue = await b.execution.demarrer("kohai");

    expect(issue.ok).toBe(false);
    expect(issue.raison).toContain("start a échoué");
    expect(b.execution.etat("kohai").erreur).toBe("start a échoué");
    expect(b.log.lignes).toContain("bots.demarrage.echec");
  });

  it("une pile qui ne s'ouvre pas est dite, et le host n'est PAS démarré", async () => {
    const hosts = hostsFactices();
    const log = journalEspion();
    const execution = new ExecutionBots({
      botDePile: "yuki",
      hosts: hosts.port,
      ouvrirPile: () => {
        throw new Error("sources.json illisible");
      },
      sessions: () => 0,
      workers: { a: () => false },
      logger: log,
    });

    const issue = await execution.demarrer("kohai");

    expect(issue.ok).toBe(false);
    expect(issue.raison).toContain("sources.json illisible");
    expect(hosts.demarres.has("kohai")).toBe(false);
    expect(execution.etat("kohai").erreur).toContain("sources.json illisible");
  });

  it("démarrer un bot CONNECTE SES plateformes (L10), jamais celles d'un autre", async () => {
    const connexions: string[] = [];
    const b = banc({ connexions });
    await b.execution.demarrer("kohai");
    expect(connexions).toEqual(["kohai"]);
  });

  it("le bot PRINCIPAL n'est pas démarré par la route (il tourne avec le gateway)", async () => {
    const b = banc();
    const issue = await b.execution.demarrer("yuki");
    expect(issue.ok).toBe(true);
    expect(issue.inchange).toBe(true);
    expect(b.pilesOuvertes).toEqual([]);
    expect(issue.raison).toContain("instance");
  });
});

describe("ARRÊTER — détruit host et pile", () => {
  it("arrête le host, ferme la pile et exécute les étapes du bot", async () => {
    const b = banc();
    await b.execution.demarrer("kohai");

    const issue = await b.execution.arreter("kohai");

    expect(issue.ok).toBe(true);
    expect(b.hosts.demarres.has("kohai")).toBe(false);
    expect(b.hosts.construits.has("kohai")).toBe(false);
    expect(b.pilesFermees).toEqual(["kohai"]);
    expect(b.appels).toEqual(["run", "sources", "memory", "tts", "plateforme"]);
    expect(issue.etat.demarre).toBe(false);
  });

  it("ARRÊT IDEMPOTENT : déjà arrêté ⇒ inchange, AUCUNE étape", async () => {
    const b = banc();
    const premier = await b.execution.arreter("kohai");
    const second = await b.execution.arreter("kohai");

    expect(premier.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.inchange).toBe(true);
    expect(b.appels).toEqual([]);
  });

  it("arrêter un bot ne touche PAS les autres", async () => {
    const b = banc();
    await b.execution.demarrer("yuki");
    await b.execution.demarrer("kohai");
    await b.execution.demarrer("autre");

    await b.execution.arreter("kohai");

    expect(b.hosts.demarres.has("yuki")).toBe(true);
    expect(b.hosts.demarres.has("autre")).toBe(true);
    expect(b.pilesFermees).toEqual(["kohai"]);
  });

  it("le bot PRINCIPAL est refusé, en le disant", async () => {
    const b = banc();
    const issue = await b.execution.arreter("yuki");
    expect(issue.ok).toBe(false);
    expect(issue.raison).toContain("instance");
    expect(b.appels).toEqual([]);
  });

  it("un arrêt incomplet (étape en échec) est dit et laisse une erreur visible", async () => {
    const hosts = hostsFactices();
    const log = journalEspion();
    const execution = new ExecutionBots({
      botDePile: "yuki",
      hosts: hosts.port,
      ouvrirPile: () => undefined,
      sessions: () => 0,
      workers: { a: () => false },
      etapesArret: () => ({
        memory: () => {
          throw new Error("drain impossible");
        },
      }),
      logger: log,
    });
    await execution.demarrer("kohai");

    const issue = await execution.arreter("kohai");

    expect(issue.ok).toBe(false);
    expect(issue.raison).toContain("memory");
    expect(execution.etat("kohai").erreur).toContain("memory");
  });
});

// ─── ⑦ LOT 38 — LA RAISON D'UN ÉCHEC DE DÉMARRAGE EST AFFICHABLE ──────────

describe("⑦ une raison d'échec constatée au démarrage est MÉMORISÉE", () => {
  it("`noterErreurs` rend la cause réelle dans `etat()`, puis un succès l'efface", async () => {
    const hosts = hostsFactices();
    const execution = new ExecutionBots({
      botDePile: "yuki",
      hosts: hosts.port,
      ouvrirPile: () => undefined,
      sessions: () => 0,
      workers: { a: () => false },
      logger: journalEspion(),
    });

    execution.noterErreurs({
      kohai: "« kohai » n'a pas pu démarrer : son dossier de sessions est celui du bot de l'instance.",
    });

    const etat = execution.etat("kohai");
    expect(etat.demarre).toBe(false);
    expect(etat.erreur).toContain("dossier de sessions");
    // Une raison vide n'écrase rien (jamais une erreur muette).
    execution.noterErreurs({ kohai: "   " });
    expect(execution.etat("kohai").erreur).toContain("dossier de sessions");
    // Démarrer avec succès efface la raison (l'état ne ment pas dans l'autre sens).
    await execution.demarrer("kohai");
    expect(execution.etat("kohai").demarre).toBe(true);
    expect(execution.etat("kohai").erreur).toBeUndefined();
  });
});
