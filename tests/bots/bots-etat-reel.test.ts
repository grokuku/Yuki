/**
 * LOT 36 (L8) — `/api/bots` DIT L'ÉTAT RÉEL, ET LES ROUTES DÉMARRENT/ARRÊTENT.
 *
 * ⚠️ Ces tests ÉCHOUENT sur le code d'origine : `bots.execution` n'existe pas,
 * `BotListing` n'a que le champ `actif` du REGISTRE — qui MENT (un bot allumé
 * dont le host a échoué s'affiche « actif »), et `PATCH /api/bots/<id>/actif`
 * n'écrit qu'un drapeau (« effet au redémarrage »).
 *
 * Ce qui est verrouillé ici, à la ROUTE (pas seulement au domaine) :
 *  ① `GET /api/bots` joint `execution` (`demarre`, `erreur`, `sessions`,
 *    `workers`) à chaque bot, et ces valeurs viennent de l'EXÉCUTION ;
 *  ② un bot `actif: true` mais dont le host n'a pas démarré est dit ARRÊTÉ
 *    (c'est exactement le mensonge corrigé) ;
 *  ③ `PATCH { actif: true }` DÉMARRE pour de vrai (pile + host) et ne demande
 *    plus de redémarrage ;
 *  ④ `PATCH { actif: false }` ARRÊTE et détruit ;
 *  ⑤ le bot PRINCIPAL est refusé par la route d'arrêt, en le disant.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CAPACITES_BOT, type BotRecord, type RegistreBots } from "../../src/bots/registry.js";
import { ExecutionBots, type HostsCyclePort } from "../../src/bots/execution.js";
import type { ConfigRuntime } from "../../src/config/runtime.js";
import { createConfigRuntime } from "../../src/config/runtime.js";
import { ConfigStore } from "../../src/config/store.js";
import { loadEnv } from "../../src/config/env.js";
import {
  handleConfigRequest,
  type ConfigApiDeps,
} from "../../src/gateway/routes/config.js";
import { createLogger } from "../../src/observability/logger.js";

const racines: string[] = [];

afterEach(() => {
  for (const racine of racines.splice(0)) rmSync(racine, { recursive: true, force: true });
});

const ECRITURE = { "x-yuki-config": "1", "content-type": "application/json" };
const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });

function bot(id: string, ordre: number, actif = false): BotRecord {
  return {
    id,
    nom: id === "yuki" ? "Yuki" : id,
    capacites: [...CAPACITES_BOT],
    actif,
    ordre,
    creeLe: "2026-01-01T00:00:00.000Z",
    plateformes: {},
  };
}

function racineTemp(): string {
  const racine = mkdtempSync(join(tmpdir(), "yuki-bots-etat-"));
  racines.push(racine);
  return racine;
}

interface Banc {
  deps: ConfigApiDeps;
  stateDir: string;
  demarres: Set<string>;
  construits: Set<string>;
  pilesOuvertes: string[];
  pilesFermees: string[];
  runtime: ConfigRuntime;
}

/**
 * Banc de route avec un port d'exécution RÉEL (`ExecutionBots`) sur des hosts
 * FACTICES : c'est le câblage de la route qui est vérifié, pas `main()`.
 */
function banc(bots: BotRecord[]): Banc {
  const racine = racineTemp();
  const stateDir = join(racine, "state");
  mkdirSync(join(stateDir, "bots"), { recursive: true });
  const registre: RegistreBots = { schemaVersion: 1, bots, echanges: {} };
  writeFileSync(join(stateDir, "bots.json"), `${JSON.stringify(registre, null, 2)}\n`);

  const env = loadEnv({
    YUKI_LOG_LEVEL: "error",
    YUKI_MOUNT_STATE: stateDir,
    YUKI_MOUNT_PI: join(racine, "pi"),
    YUKI_CONFIG_STORE_PATH: join(stateDir, "config.json"),
  });
  const runtime = createConfigRuntime({
    env,
    store: new ConfigStore(env.configStorePath),
    processEnv: {},
    promptDefaults: { light: "léger", heavy: "lourd" },
  });

  const construits = new Set<string>(["yuki"]);
  const demarres = new Set<string>(["yuki"]);
  const pilesOuvertes: string[] = [];
  const pilesFermees: string[] = [];
  const hosts: HostsCyclePort = {
    estConstruit: (id) => construits.has(id),
    estDemarre: (id) => demarres.has(id),
    demarrerBot: async (id) => {
      const inchange = demarres.has(id);
      construits.add(id);
      demarres.add(id);
      return { ok: true, inchange };
    },
    arreterBot: async (id) => {
      const inchange = !construits.has(id);
      construits.delete(id);
      demarres.delete(id);
      return { ok: true, inchange };
    },
  };
  const execution = new ExecutionBots({
    botDuRun: "yuki",
    hosts,
    ouvrirPile: (id) => pilesOuvertes.push(id),
    fermerPile: (id) => pilesFermees.push(id),
    sessions: (id) => (id === "yuki" ? 2 : 5),
    workers: { a: (id) => id === "kohai" },
    logger,
  });

  const deps: ConfigApiDeps = {
    runtime,
    logger,
    bots: {
      registre,
      stateDir,
      piSessionsDir: join(racine, "pi", "agent", "sessions"),
      retirerDesListesDAgents: () => 0,
      execution,
    },
  };
  return { deps, stateDir, demarres, construits, pilesOuvertes, pilesFermees, runtime };
}

async function appel(
  deps: ConfigApiDeps,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = ECRITURE,
): Promise<{ status: number; body: any }> {
  const response = await handleConfigRequest({
    method,
    path,
    headers,
    body: body === undefined ? "" : JSON.stringify(body),
    deps,
  });
  return { status: response.status, body: response.body };
}

describe("① GET /api/bots — l'état vient de l'EXÉCUTION", () => {
  it("joint `execution` à chaque bot (démarré, sessions, worker)", async () => {
    const b = banc([bot("yuki", 0, true), bot("kohai", 1, true)]);
    const reponse = await appel(b.deps, "GET", "/api/bots");

    expect(reponse.status).toBe(200);
    const yuki = reponse.body.bots.find((entree: { id: string }) => entree.id === "yuki");
    const kohai = reponse.body.bots.find((entree: { id: string }) => entree.id === "kohai");
    expect(yuki.execution).toEqual({ demarre: true, sessions: 2, workers: 0 });
    // ⚠️ `actif: true` MAIS aucun host démarré : l'état réel dit ARRÊTÉ.
    expect(kohai.actif).toBe(true);
    expect(kohai.execution).toEqual({ demarre: false, sessions: 5, workers: 1 });
  });

  it("une erreur d'exécution est AFFICHÉE, jamais avalée", async () => {
    const b = banc([bot("yuki", 0, true), bot("kohai", 1)]);
    await appel(b.deps, "PATCH", "/api/bots/kohai/actif", { actif: true });
    const reponse = await appel(b.deps, "GET", "/api/bots");
    const kohai = reponse.body.bots.find((entree: { id: string }) => entree.id === "kohai");
    expect(kohai.execution.demarre).toBe(true);
    expect(kohai.execution.erreur).toBeUndefined();
  });
});

describe("② PATCH actif — DÉMARRE et ARRÊTE pour de vrai", () => {
  it("allumer DÉMARRE (pile puis host) et ne demande plus de redémarrage", async () => {
    const b = banc([bot("yuki", 0, true), bot("kohai", 1)]);
    const reponse = await appel(b.deps, "PATCH", "/api/bots/kohai/actif", { actif: true });

    expect(reponse.status).toBe(200);
    expect(reponse.body.redemarrageRequis).toBe(false);
    expect(reponse.body.applique).toEqual({ ok: true, inchange: false });
    expect(reponse.body.execution.demarre).toBe(true);
    // ⚠️ La pile est ouverte AVANT le host (sinon aucun déclencheur n'existe).
    expect(b.pilesOuvertes).toEqual(["kohai"]);
    expect(b.demarres.has("kohai")).toBe(true);
  });

  it("éteindre ARRÊTE et détruit (host + pile)", async () => {
    const b = banc([bot("yuki", 0, true), bot("kohai", 1, true)]);
    await appel(b.deps, "PATCH", "/api/bots/kohai/actif", { actif: true });
    b.demarres.add("kohai");
    b.construits.add("kohai");

    const reponse = await appel(b.deps, "PATCH", "/api/bots/kohai/actif", { actif: false });

    expect(reponse.status).toBe(200);
    expect(reponse.body.redemarrageRequis).toBe(false);
    expect(reponse.body.execution.demarre).toBe(false);
    expect(b.demarres.has("kohai")).toBe(false);
    expect(b.pilesFermees).toEqual(["kohai"]);
  });

  it("éteindre le bot PRINCIPAL est refusé par l'exécution, en le disant", async () => {
    const b = banc([bot("yuki", 0, true), bot("kohai", 1, true)]);
    const reponse = await appel(b.deps, "PATCH", "/api/bots/kohai/actif", { actif: false });
    expect(reponse.status).toBe(200);
    // `yuki` reste seul actif : l'éteindre serait un 409 `dernier_bot_actif` (L2).
    const refus = await appel(b.deps, "PATCH", "/api/bots/yuki/actif", { actif: false });
    expect(refus.status).toBe(409);
    expect(refus.body.code).toBe("dernier_bot_actif");
  });

  it("sans port d'exécution, on retombe sur le comportement de L2 (redémarrage requis)", async () => {
    const b = banc([bot("yuki", 0, true), bot("kohai", 1)]);
    const sansExecution: ConfigApiDeps = {
      ...b.deps,
      bots: { ...(b.deps.bots as NonNullable<ConfigApiDeps["bots"]>), execution: undefined },
    };
    const reponse = await appel(sansExecution, "PATCH", "/api/bots/kohai/actif", { actif: true });
    expect(reponse.status).toBe(200);
    expect(reponse.body.redemarrageRequis).toBe(true);
    expect(reponse.body.execution).toBeUndefined();
  });
});
