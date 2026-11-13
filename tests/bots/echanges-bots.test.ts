/**
 * LOT 37 — ON/OFF DE LA BOUCLE ENTRE DEUX BOTS (`echanges["a->b"].actif`), et ce
 * que `GET /api/bots` doit dire VRAI au sélecteur de la barre du haut.
 *
 * ⚠️ CES TESTS ÉCHOUENT SUR LE CODE D'ORIGINE :
 *  - `GET /api/bots` ne renvoyait QUE `{ bots }` : ni `principal`, ni `echanges`
 *    — le sélecteur ne pouvait donc pas dire quel bot tourne (d'où le « il n'y a
 *    qu'un seul bot actif » rapporté par l'utilisateur) ;
 *  - aucune route n'écrivait `echanges` : la décision « un seul interrupteur par
 *    paire, aucun frein » n'existait que dans le SCHÉMA du registre.
 *
 * Verrouillé ici :
 *  ① `definirEchange` écrit la paire ORIENTÉE, de façon idempotente, et refuse
 *    un bot inconnu, une paire réflexive et un `actif` non booléen ;
 *  ② `PATCH /api/bots/echanges` l'expose à l'interface (200 + `echanges` à jour) ;
 *  ③ la paire n'a AUCUN autre champ que `actif` (pas de frein par paire) ;
 *  ④ `GET /api/bots` porte `principal` et `echanges` (plus de `plafond`).
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AdminBotError, definirEchange } from "../../src/bots/admin.js";
import {
  CAPACITES_BOT,
  type BotRecord,
  type RegistreBots,
  cheminRegistreBots,
  lireRegistreBots,
} from "../../src/bots/registry.js";
import { loadEnv } from "../../src/config/env.js";
import { ConfigStore } from "../../src/config/store.js";
import { createConfigRuntime } from "../../src/config/runtime.js";
import { handleConfigRequest } from "../../src/gateway/routes/config.js";
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
    capacites: id === "yuki" ? [...CAPACITES_BOT] : [],
    actif,
    ordre,
    creeLe: "2026-01-01T00:00:00.000Z",
    plateformes: {},
  };
}

function registre(): RegistreBots {
  return {
    schemaVersion: 1,
    bots: [bot("yuki", 0, true), bot("kohai", 1), bot("nova", 2)],
    echanges: {},
  };
}

function racineTemp(): string {
  const racine = mkdtempSync(join(tmpdir(), "yuki-echanges-"));
  racines.push(racine);
  return racine;
}

// ─── ① domaine ─────────────────────────────────────────────────────────────

describe("① `definirEchange` — un seul interrupteur, orienté", () => {
  it("écrit `echanges[\"kohai->nova\"] = { actif: true }` SUR LE DISQUE", () => {
    const stateDir = racineTemp();
    const resultat = definirEchange({
      stateDir,
      registre: registre(),
      de: "kohai",
      vers: "nova",
      actif: true,
    });
    expect(resultat.cle).toBe("kohai->nova");
    expect(resultat.inchange).toBe(false);
    const relu = JSON.parse(readFileSync(join(stateDir, "bots.json"), "utf8"));
    // ⚠️ UN SEUL champ : aucun frein par paire (décision utilisateur).
    expect(relu.echanges).toEqual({ "kohai->nova": { actif: true } });
    // La paire INVERSE n'est pas écrite : l'interrupteur est ORIENTÉ.
    expect(relu.echanges["nova->kohai"]).toBeUndefined();
    expect(() => lireRegistreBots(cheminRegistreBots(stateDir))).not.toThrow();
  });

  it("est IDEMPOTENT : le même état ne réécrit rien (`inchange`)", () => {
    const stateDir = racineTemp();
    const premier = definirEchange({
      stateDir,
      registre: registre(),
      de: "kohai",
      vers: "nova",
      actif: true,
    });
    const second = definirEchange({
      stateDir,
      registre: premier.registre,
      de: "kohai",
      vers: "nova",
      actif: true,
    });
    expect(second.inchange).toBe(true);
    expect(second.echanges).toEqual({ "kohai->nova": { actif: true } });
  });

  it("BASCULE l'interrupteur d'une paire déjà réglée", () => {
    const stateDir = racineTemp();
    const premier = definirEchange({
      stateDir,
      registre: registre(),
      de: "yuki",
      vers: "kohai",
      actif: true,
    });
    const second = definirEchange({
      stateDir,
      registre: premier.registre,
      de: "yuki",
      vers: "kohai",
      actif: false,
    });
    expect(second.inchange).toBe(false);
    expect(second.actif).toBe(false);
    expect(second.echanges["yuki->kohai"]).toEqual({ actif: false });
  });

  it("REFUSE un bot inconnu, une paire réflexive et un `actif` non booléen", () => {
    const stateDir = racineTemp();
    const cas = [
      { de: "kohai", vers: "fantome", actif: true, code: "bot_inconnu" },
      { de: "fantome", vers: "kohai", actif: true, code: "bot_inconnu" },
      { de: "kohai", vers: "kohai", actif: true, code: "echange_invalide" },
      { de: "kohai", vers: "nova", actif: "oui", code: "echange_invalide" },
    ] as const;
    for (const entree of cas) {
      let refus: unknown = null;
      try {
        definirEchange({
          stateDir,
          registre: registre(),
          de: entree.de,
          vers: entree.vers,
          actif: entree.actif,
        });
      } catch (error) {
        refus = error;
      }
      expect(refus, `${entree.de}->${entree.vers}`).toBeInstanceOf(AdminBotError);
      expect((refus as AdminBotError).code).toBe(entree.code);
    }
  });
});

// ─── ② route ───────────────────────────────────────────────────────────────

interface Banc {
  runtime: ReturnType<typeof createConfigRuntime>;
  deps: Parameters<typeof handleConfigRequest>[0]["deps"];
  stateDir: string;
}

function banc(options: { registre?: RegistreBots | null } = {}): Banc {
  const root = racineTemp();
  const stateDir = join(root, "state");
  const env = loadEnv({
    YUKI_LOG_LEVEL: "error",
    YUKI_MOUNT_STATE: stateDir,
    YUKI_CONFIG_STORE_PATH: join(stateDir, "config.json"),
  });
  const runtime = createConfigRuntime({
    env,
    store: new ConfigStore(env.configStorePath),
    processEnv: {},
    promptDefaults: { light: "P", heavy: "H" },
  });
  const registreCourant = options.registre ?? null;
  const deps = {
    runtime,
    logger,
    bots: { registre: registreCourant, stateDir },
  } as Parameters<typeof handleConfigRequest>[0]["deps"];
  return { runtime, deps, stateDir };
}

async function appel(
  b: Banc,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const response = await handleConfigRequest({
    method,
    path,
    headers: { ...ECRITURE },
    body: body === undefined ? "" : JSON.stringify(body),
    deps: b.deps,
  });
  return { status: response.status, body: response.body };
}

describe("② `PATCH /api/bots/echanges`", () => {
  it("écrit la paire et renvoie l'index COMPLET des échanges", async () => {
    const b = banc({ registre: registre() });
    const { status, body } = await appel(b, "PATCH", "/api/bots/echanges", {
      de: "kohai",
      vers: "nova",
      actif: true,
    });
    expect(status).toBe(200);
    expect(body.cle).toBe("kohai->nova");
    expect(body.actif).toBe(true);
    expect(body.echanges).toEqual({ "kohai->nova": { actif: true } });
  });

  it("le registre EN MÉMOIRE suit l'écriture (ce que lit `GET /api/bots`)", async () => {
    const b = banc({ registre: registre() });
    await appel(b, "PATCH", "/api/bots/echanges", {
      de: "yuki",
      vers: "nova",
      actif: false,
    });
    expect(b.deps.bots?.registre?.echanges).toEqual({ "yuki->nova": { actif: false } });
  });

  it("un bot inconnu est refusé en le NOMMANT (404), sans rien écrire", async () => {
    const b = banc({ registre: registre() });
    const { status, body } = await appel(b, "PATCH", "/api/bots/echanges", {
      de: "kohai",
      vers: "fantome",
      actif: true,
    });
    expect(status).toBe(404);
    expect(body.code).toBe("bot_inconnu");
    expect(body.message).toContain("fantome");
    expect(b.deps.bots?.registre?.echanges).toEqual({});
  });

  it("un corps sans `de`/`vers` est refusé (400) plutôt que deviné", async () => {
    const b = banc({ registre: registre() });
    const { status, body } = await appel(b, "PATCH", "/api/bots/echanges", {
      actif: true,
    });
    expect(status).toBe(400);
    expect(body.code).toBe("echange_invalide");
  });

  it("sans registre (mono-bot), le refus est explicite", async () => {
    const b = banc({ registre: null });
    const { status, body } = await appel(b, "PATCH", "/api/bots/echanges", {
      de: "yuki",
      vers: "kohai",
      actif: true,
    });
    expect(status).toBe(409);
    expect(body.code).toBe("registre_absent");
  });
});

// ─── ③ ce que `GET /api/bots` doit dire ───────────────────────────────────

describe("③ `GET /api/bots` porte le bot du RUN et les échanges", () => {
  it("⚠️ ne porte PLUS de plafond (il n'y en a plus)", async () => {
    // ⚠️ RÉÉCRIT (n'était « renvoie `plafond: 3` ») : la décision utilisateur du
    // 2026-11-13 a supprimé le plafond de bots en marche.
    const b = banc({ registre: registre() });
    const { status, body } = await appel(b, "GET", "/api/bots");
    expect(status).toBe(200);
    expect(body.plafond).toBeUndefined();
    expect(body.refuses).toBeUndefined();
    // ⚠️ LOT 45 : plus de « principal ». `botDuRun` nomme le bot du RUN (celui
    // dont le host sert une connexion SANS `?b=`) — le premier par `ordre`.
    expect(body.botDuRun).toBe(b.runtime.botId);
    expect(body.principal).toBeUndefined();
    expect(body.echanges).toEqual({});
    // Les bots eux-mêmes restent EXACTEMENT la même forme qu'avant (lot 35b).
    expect(body.bots.map((entree: { id: string }) => entree.id)).toEqual([
      "yuki",
      "kohai",
      "nova",
    ]);
  });

  it("les échanges écrits par la route sont RELUS par la liste", async () => {
    const b = banc({ registre: registre() });
    await appel(b, "PATCH", "/api/bots/echanges", {
      de: "kohai",
      vers: "nova",
      actif: true,
    });
    const { body } = await appel(b, "GET", "/api/bots");
    expect(body.echanges).toEqual({ "kohai->nova": { actif: true } });
  });

  it("en mono-bot historique (aucun registre), un seul bot et AUCUNE boucle", async () => {
    const b = banc({ registre: null });
    const { body } = await appel(b, "GET", "/api/bots");
    expect(body.bots).toHaveLength(1);
    expect(body.echanges).toEqual({});
    expect(body.plafond).toBeUndefined();
  });
});
