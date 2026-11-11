/**
 * ⚠️ LOT 36 (L11) — UN SERVICE DE MÉMOIRE PAR BOT.
 *
 * Ce que ces tests verrouillent : le host d'un bot secondaire reçoit un
 * `MemoryPort` adossé à SES stores. Un souvenir de `yuki` n'est donc jamais
 * visible pour `kohai`, et `kohai` n'est plus muet (avant L11, le port `memory`
 * était retiré de son host : il n'avait aucune mémoire).
 *
 * ⚠️ Échoue sur le code d'origine : `src/memory/services-bot.ts` n'existe pas,
 * et `src/bots/hosts.ts` RETIRAIT le port `memory` de tout host secondaire.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadEnv, type Env } from "../../src/config/env.js";
import {
  FabriqueMemoireBots,
  MemoryService,
  ServicesMemoireBots,
  type MemoryPort,
  type StoresMemoireBot,
} from "../../src/memory/index.js";

const racines: string[] = [];

afterEach(() => {
  for (const racine of racines.splice(0)) rmSync(racine, { recursive: true, force: true });
});

const journal = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function envDeTest(): Env {
  const racine = mkdtempSync(join(tmpdir(), "yuki-mem-services-"));
  racines.push(racine);
  const state = join(racine, "state");
  mkdirSync(state, { recursive: true });
  mkdirSync(join(racine, "pi", "agent", "sessions"), { recursive: true });
  return loadEnv({
    YUKI_MOUNT_STATE: state,
    YUKI_MOUNT_PI_AGENT: join(racine, "pi"),
    YUKI_LOG_LEVEL: "error",
  });
}

interface Banc {
  env: Env;
  fabrique: FabriqueMemoireBots;
  services: ServicesMemoireBots<MemoryService>;
  crees: Array<{ botId: string; fichier: string }>;
}

/** Banc : le service du principal est un objet DISTINCT (comme `main()`). */
function banc(): Banc {
  const env = envDeTest();
  const fabrique = new FabriqueMemoireBots({ envInstance: env, mode: "multi", logger: journal });
  const storesPile = fabrique.storesDe("yuki");
  const principal = new MemoryService({
    store: storesPile.store,
    index: storesPile.index,
    logger: journal,
    enabled: () => true,
    bounds: () => ({ topK: 5, budgetChars: 8_000, timeoutMs: 1_000 }),
  });
  // Comme `main()` : le service du principal est démarré à la construction.
  principal.start();
  const crees: Banc["crees"] = [];
  const services = new ServicesMemoireBots<MemoryService>({
    pile: "yuki",
    principal,
    storesDe: (botId) => fabrique.storesDe(botId),
    creer: (botId: string, stores: StoresMemoireBot) => {
      crees.push({ botId, fichier: stores.fichier });
      return new MemoryService({
        store: stores.store,
        index: stores.index,
        logger: journal,
        enabled: () => true,
        bounds: () => ({ topK: 5, budgetChars: 8_000, timeoutMs: 1_000 }),
      });
    },
    logger: journal,
  });
  return { env, fabrique, services, crees };
}

/** Écrit un souvenir dans la mémoire d'un bot (par SON store). */
function ecrire(b: Banc, botId: string, texte: string): void {
  const stores = b.fabrique.storesDe(botId);
  stores.store.add({ text: texte, source: "conversation:test", cat: "preference" });
  stores.index.rebuild(stores.store.entries);
}

describe("services de mémoire par bot (lot 36, L11)", () => {
  it("le PRINCIPAL est le service de `main()`, par identité", () => {
    const b = banc();
    const principal = b.services.pour("yuki");
    expect(principal).toBe(b.services.pour("yuki"));
    // Aucun service n'a été construit pour un autre bot.
    expect(b.crees).toEqual([]);
  });

  it("⚠️ TEST CENTRAL : `kohai` lit SA mémoire, pas celle de `yuki`", async () => {
    const b = banc();
    ecrire(b, "yuki", "Yuki retient que l'utilisateur aime les réponses courtes.");
    // `kohai` n'a rien : son service est construit à la demande, sur SES stores.
    const kohai = b.services.pour("kohai") as MemoryPort;

    expect(b.crees).toEqual([
      { botId: "kohai", fichier: join(b.env.mountPoints.state, "bots", "kohai", "memory.jsonl") },
    ]);

    // ⚠️ Le rappel de `kohai` ne rend JAMAIS un souvenir de `yuki`.
    const rappelKohai = await kohai.recall("réponses courtes");
    expect(rappelKohai.entries).toBe(0);
    expect(rappelKohai.block).toBeNull();

    // Et celui de `yuki`, lui, le retrouve (la mémoire du principal est intacte).
    const rappelYuki = await b.services.pour("yuki").recall("réponses courtes");
    expect(rappelYuki.entries).toBe(1);
    expect(rappelKohai.entries).not.toBe(rappelYuki.entries);
  });

  it("chaque bot garde SON service (jamais deux fois le même, jamais celui d'un autre)", () => {
    const b = banc();
    const kohai = b.services.pour("kohai");
    const senpai = b.services.pour("senpai");
    expect(kohai).not.toBe(senpai);
    expect(kohai).not.toBe(b.services.pour("yuki"));
    expect(b.services.pour("kohai")).toBe(kohai);
    // Deux constructions pour deux bots (un service par bot), jamais plus.
    expect(b.crees.map((entree) => entree.botId)).toEqual(["kohai", "senpai"]);
  });

  it("oublier un bot ARRÊTÉ retire son service (un redémarrage en construit un NEUF)", () => {
    const b = banc();
    const premier = b.services.pour("kohai");
    expect(b.services.oublier("kohai")).toBe(true);
    expect(b.services.a("kohai")).toBe(false);
    const second = b.services.pour("kohai");
    expect(second).not.toBe(premier);
    // ⚠️ Le service de la pile n'est jamais oublié : il vit avec l'instance.
    expect(b.services.oublier("yuki")).toBe(false);
    expect(b.services.pour("yuki")).toBe(b.services.pour("yuki"));
  });
});
