/**
 * AUDIT 2026-11-20 (⑤) — CYCLE ACTIVER / DÉLÉGUER / ARRÊTER / RÉACTIVER.
 *
 * ⚠️ CE QUI EST MESURÉ : le **NOMBRE de workers VIVANTS**, alimenté par la fabrique
 * (`creer`) et vidé par le hook de libération (`liberer`) — jamais une ligne de journal.
 * Un worker « orphelin » est un worker dont les ressources ne sont plus référencées par
 * le registre mais qui n'ont jamais été libérées : il ferait monter le RSS à chaque cycle
 * d'activation.
 *
 * ⚠️ Le chaînon réel testé est celui de `src/index.ts` : `fermerPile` d'un bot ARRÊTÉ
 * appelle `workersLourds.oublier(botId)`, qui appelle `liberer` AVANT de retirer la
 * référence. Le test de CONTRÔLE (second cas) montre qu'une chaîne sans `oublier` laisse
 * bien un orphelin : l'assertion mord.
 *
 * ⚠️ Sur l'origine, ce cycle était DÉJÀ correct (le lot précédent a ajouté `liberer`) :
 * ces tests verrouillent un comportement existant, ils ne révèlent pas de défaut.
 */

import { describe, expect, it } from "vitest";

import { ExecutionBots, type HostsCyclePort } from "../../src/bots/execution.js";
import type { CapaciteBot } from "../../src/bots/registry.js";
import { WorkersLourdsBots } from "../../src/bots/workers.js";

const TOUTES: readonly CapaciteBot[] = ["fichiers", "execution", "delegation"];

function journal(): { info: () => void; warn: () => void } {
  return { info: () => {}, warn: () => {} };
}

/** Hosts FACTICES : la Map dit ce qui est CONSTRUIT, l'ensemble ce qui est DÉMARRÉ. */
function hostsFactices(): HostsCyclePort & { construits: Set<string>; demarres: Set<string> } {
  const construits = new Set<string>(["yuki"]);
  const demarres = new Set<string>(["yuki"]);
  return {
    construits,
    demarres,
    estConstruit: (botId) => construits.has(botId),
    estDemarre: (botId) => demarres.has(botId),
    demarrerBot: async (botId) => {
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
}

interface Banc {
  execution: ExecutionBots;
  workers: WorkersLourdsBots<{ botId: string }>;
  /** Workers dont les RESSOURCES n'ont jamais été libérées (le compte qui compte). */
  vivants: Set<string>;
  liberes: string[];
}

/**
 * Banc du cycle : `fermerPile` fait ce que fait `src/index.ts` pour un bot arrêté.
 * `avecOubli: false` reproduit une chaîne INCOMPLÈTE (le contrôle négatif).
 */
function banc(options: { avecOubli?: boolean } = {}): Banc {
  const hosts = hostsFactices();
  const vivants = new Set<string>();
  const liberes: string[] = [];
  const log = journal();
  const workers = new WorkersLourdsBots<{ botId: string }>({
    botDuRun: "yuki",
    capacites: () => TOUTES,
    creer: (botId) => {
      vivants.add(botId);
      return { botId };
    },
    liberer: (botId) => {
      liberes.push(botId);
      vivants.delete(botId);
    },
    logger: log,
  });
  const execution = new ExecutionBots({
    botDuRun: "yuki",
    hosts,
    ouvrirPile: () => undefined,
    fermerPile: (botId) => {
      if (options.avecOubli === false) return;
      workers.oublier(botId);
    },
    sessions: () => 0,
    workers: { a: (botId) => workers.a(botId) },
    logger: log,
  });
  return { execution, workers, vivants, liberes };
}

describe("⑤ cycle activer → déléguer → arrêter → réactiver → déléguer", () => {
  it("aucun worker orphelin : le compte REDESCEND à zéro, puis remonte à UN (pas deux)", async () => {
    const b = banc();

    // ① ACTIVER
    const demarrage = await b.execution.demarrer("kohai");
    expect(demarrage.ok).toBe(true);

    // ② DÉLÉGUER : la première délégation construit le worker du bot.
    expect(b.workers.pour("kohai")).toBeDefined();
    expect(b.workers.taille).toBe(1);
    expect(b.vivants.size).toBe(1);
    expect(b.execution.etat("kohai").workers).toBe(1);

    // ③ ARRÊTER : le worker est RETIRÉ et ses ressources LIBÉRÉES.
    const arret = await b.execution.arreter("kohai");
    expect(arret.ok).toBe(true);
    expect(b.workers.taille).toBe(0);
    expect(b.vivants.size).toBe(0);
    expect(b.liberes).toEqual(["kohai"]);
    expect(b.execution.etat("kohai").workers).toBe(0);

    // ④ RÉACTIVER puis ⑤ DÉLÉGUER DEUX FOIS : un SEUL worker vivant, jamais deux.
    expect((await b.execution.demarrer("kohai")).ok).toBe(true);
    const premier = b.workers.pour("kohai");
    expect(b.workers.pour("kohai")).toBe(premier); // réutilisé, pas reconstruit
    expect(b.workers.taille).toBe(1);
    expect(b.vivants.size).toBe(1);
    expect(b.liberes).toEqual(["kohai"]);
  });

  it("CONTRÔLE — sans `oublier` dans `fermerPile`, l'orphelin APPARAÎT (l'assertion mord)", async () => {
    const b = banc({ avecOubli: false });
    await b.execution.demarrer("kohai");
    b.workers.pour("kohai");
    await b.execution.arreter("kohai");
    // ⚠️ Le worker n'est plus dans l'état d'exécution… mais ses ressources sont VIVANTES :
    // c'est exactement l'orphelin que le câblage de production évite.
    expect(b.workers.taille).toBe(1);
    expect(b.vivants.size).toBe(1);
    expect(b.liberes).toEqual([]);
  });
});
