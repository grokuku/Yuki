/**
 * LOT 36 (L2) — ON/OFF RÉEL D'UN BOT.
 *
 * Ce que ce fichier verrouille :
 *  - `definirActif` écrit `actif` (jusque-là AUCUNE route ne le faisait) et rend
 *    la liste des bots qui DOIVENT tourner ;
 *  - le PLAFOND `bots.maxActifs` refuse d'allumer un bot de plus
 *    (`409 plafond_actifs`, message nommant le plafond ET les bots allumés) ;
 *  - éteindre le DERNIER bot actif est REFUSÉ (`409 dernier_bot_actif`) : une
 *    instance sans bot actif ne redémarrerait pas ;
 *  - `inchange` n'écrit RIEN (aucune écriture inutile, aucun faux changement) ;
 *  - la route `PATCH /api/bots/<id>/actif` exige `X-Yuki-Config: 1` et met à
 *    jour le registre EN MÉMOIRE (sinon `GET /api/bots` mentirait).
 *
 * ⚠️ Échoue sur le code d'origine : `definirActif` et la route n'existent pas
 * (405 en `PATCH` sur `/api/bots/<id>/actif`).
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AdminBotError, definirActif } from "../../src/bots/admin.js";
import { CAPACITES_BOT, type BotRecord, type RegistreBots } from "../../src/bots/registry.js";
import { loadEnv } from "../../src/config/env.js";
import { createConfigRuntime } from "../../src/config/runtime.js";
import { ConfigStore } from "../../src/config/store.js";
import { handleConfigRequest } from "../../src/gateway/routes/config.js";
import { createLogger } from "../../src/observability/logger.js";

const racines: string[] = [];

afterEach(() => {
  for (const racine of racines.splice(0)) rmSync(racine, { recursive: true, force: true });
});

const ECRITURE = { "x-yuki-config": "1", "content-type": "application/json" };

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

function registre(bots: BotRecord[]): RegistreBots {
  return { schemaVersion: 1, bots, echanges: {} };
}

interface Bac {
  stateDir: string;
  registre: RegistreBots;
}

/** Volume `state` réel : `definirActif` ÉCRIT le registre (c'est le sujet du lot). */
function bac(bots: BotRecord[]): Bac {
  const racine = mkdtempSync(join(tmpdir(), "yuki-bot-actif-"));
  racines.push(racine);
  const stateDir = join(racine, "state");
  mkdirSync(join(stateDir, "bots"), { recursive: true });
  const registreCourant = registre(bots);
  writeFileSync(
    join(stateDir, "bots.json"),
    `${JSON.stringify(registreCourant, null, 2)}\n`,
  );
  return { stateDir, registre: registreCourant };
}

function actifsDuFichier(stateDir: string): string[] {
  const lu = JSON.parse(readFileSync(join(stateDir, "bots.json"), "utf8")) as RegistreBots;
  return lu.bots.filter((entree) => entree.actif).map((entree) => entree.id);
}

function refusDe(fn: () => unknown): AdminBotError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AdminBotError);
    return error as AdminBotError;
  }
  throw new Error("aucun refus levé");
}

describe("① `definirActif` — le domaine", () => {
  it("ALLUME un bot : le fichier est écrit, la liste des actifs rendue", () => {
    const b = bac([bot("yuki", 0, true), bot("kohai", 1)]);
    const resultat = definirActif({
      stateDir: b.stateDir,
      registre: b.registre,
      botId: "kohai",
      actif: true,
    });
    expect(resultat.actif).toBe(true);
    expect(resultat.inchange).toBe(false);
    expect(resultat.demarrageRequis).toBe(true);
    expect(resultat.arretRequis).toBe(false);
    expect(resultat.actifs).toEqual(["yuki", "kohai"]);
    // ⚠️ C'est bien le FICHIER qui change (aucun état seulement en mémoire).
    expect(actifsDuFichier(b.stateDir)).toEqual(["yuki", "kohai"]);
  });

  it("ÉTEINT un bot (deux actifs) : il reste un bot qui doit tourner", () => {
    const b = bac([bot("yuki", 0, true), bot("kohai", 1, true)]);
    const resultat = definirActif({
      stateDir: b.stateDir,
      registre: b.registre,
      botId: "kohai",
      actif: false,
    });
    expect(resultat.inchange).toBe(false);
    expect(resultat.arretRequis).toBe(true);
    expect(resultat.actifs).toEqual(["yuki"]);
    expect(actifsDuFichier(b.stateDir)).toEqual(["yuki"]);
  });

  it("`inchange` : rien n'est écrit, le registre rendu est le MÊME objet", () => {
    const b = bac([bot("yuki", 0, true)]);
    const resultat = definirActif({
      stateDir: b.stateDir,
      registre: b.registre,
      botId: "yuki",
      actif: true,
    });
    expect(resultat.inchange).toBe(true);
    expect(resultat.registre).toBe(b.registre);
    expect(resultat.demarrageRequis).toBe(false);
    expect(resultat.arretRequis).toBe(false);
  });

  it("⚠️ PLAFOND : allumer un bot de plus est REFUSÉ, en nommant plafond et actifs", () => {
    const b = bac([bot("yuki", 0, true), bot("b2", 1, true), bot("b3", 2, true), bot("b4", 3)]);
    const refus = refusDe(() =>
      definirActif({ stateDir: b.stateDir, registre: b.registre, botId: "b4", actif: true }),
    );
    expect(refus.code).toBe("plafond_actifs");
    expect(refus.status).toBe(409);
    expect(refus.message).toContain("3");
    expect(refus.message).toContain("yuki, b2, b3");
    // Rien n'a été écrit : les trois bots restent les seuls actifs.
    expect(actifsDuFichier(b.stateDir)).toEqual(["yuki", "b2", "b3"]);
  });

  it("le plafond se règle à l'appel (défaut 3)", () => {
    const b = bac([bot("yuki", 0, true), bot("b2", 1, true), bot("b3", 2)]);
    // Défaut 3 ⇒ il reste une place.
    expect(() =>
      definirActif({ stateDir: b.stateDir, registre: b.registre, botId: "b3", actif: true }),
    ).not.toThrow();
    const b2 = bac([bot("yuki", 0, true), bot("b2", 1, true), bot("b3", 2)]);
    const refus = refusDe(() =>
      definirActif({
        stateDir: b2.stateDir,
        registre: b2.registre,
        botId: "b3",
        actif: true,
        maxActifs: 2,
      }),
    );
    expect(refus.code).toBe("plafond_actifs");
    expect(refus.message).toContain("2");
  });

  it("⚠️ DERNIER bot actif : l'éteindre est REFUSÉ (sinon plus de démarrage possible)", () => {
    const b = bac([bot("yuki", 0, true), bot("kohai", 1)]);
    const refus = refusDe(() =>
      definirActif({ stateDir: b.stateDir, registre: b.registre, botId: "yuki", actif: false }),
    );
    expect(refus.code).toBe("dernier_bot_actif");
    expect(refus.status).toBe(409);
    expect(refus.message).toContain("DERNIER");
    expect(actifsDuFichier(b.stateDir)).toEqual(["yuki"]);
  });

  it("refuse un `actif` non booléen (400) et un bot inconnu (404)", () => {
    const b = bac([bot("yuki", 0, true)]);
    const invalide = refusDe(() =>
      definirActif({ stateDir: b.stateDir, registre: b.registre, botId: "yuki", actif: "on" }),
    );
    expect(invalide.code).toBe("actif_invalide");
    expect(invalide.status).toBe(400);
    const inconnu = refusDe(() =>
      definirActif({ stateDir: b.stateDir, registre: b.registre, botId: "fantome", actif: true }),
    );
    expect(inconnu.code).toBe("bot_inconnu");
    expect(inconnu.status).toBe(404);
  });
});

// ── La route ────────────────────────────────────────────────────────────────

interface BancRoute {
  stateDir: string;
  deps: Parameters<typeof handleConfigRequest>[0]["deps"];
}

function bancRoute(bots: BotRecord[], options: { maxActifs?: number } = {}): BancRoute {
  const b = bac(bots);
  const env = loadEnv({
    YUKI_LOG_LEVEL: "error",
    YUKI_MOUNT_STATE: b.stateDir,
    YUKI_CONFIG_STORE_PATH: join(b.stateDir, "config.json"),
  });
  const runtime = createConfigRuntime({
    env,
    store: new ConfigStore(env.configStorePath),
    processEnv: {},
    promptDefaults: { light: "P", heavy: "H" },
  });
  const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
  const deps = {
    runtime,
    logger,
    bots: {
      registre: b.registre,
      stateDir: b.stateDir,
      ...(options.maxActifs !== undefined ? { maxActifs: options.maxActifs } : {}),
    },
  } as BancRoute["deps"];
  return { stateDir: b.stateDir, deps };
}

async function appel(
  b: BancRoute,
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
    deps: b.deps,
  });
  return { status: response.status, body: response.body };
}

describe("② `PATCH /api/bots/<id>/actif` — la route", () => {
  it("allume un bot, met à jour le registre EN MÉMOIRE et le fichier", async () => {
    const b = bancRoute([bot("yuki", 0, true), bot("kohai", 1)]);
    const reponse = await appel(b, "PATCH", "/api/bots/kohai/actif", { actif: true });
    expect(reponse.status).toBe(200);
    expect(reponse.body.actif).toBe(true);
    expect(reponse.body.inchange).toBe(false);
    expect(reponse.body.actifs).toEqual(["yuki", "kohai"]);
    expect(reponse.body.redemarrageRequis).toBe(true);
    // ⚠️ La liste suit IMMÉDIATEMENT (registre en mémoire remplacé).
    const liste = await appel(b, "GET", "/api/bots");
    expect(
      liste.body.bots.find((entree: { id: string }) => entree.id === "kohai").actif,
    ).toBe(true);
    expect(actifsDuFichier(b.stateDir)).toEqual(["yuki", "kohai"]);
  });

  it("exige `X-Yuki-Config: 1` (403) et n'écrit RIEN", async () => {
    const b = bancRoute([bot("yuki", 0, true), bot("kohai", 1)]);
    const refus = await appel(b, "PATCH", "/api/bots/kohai/actif", { actif: true }, {
      "content-type": "application/json",
    });
    expect(refus.status).toBe(403);
    expect(actifsDuFichier(b.stateDir)).toEqual(["yuki"]);
  });

  it("rend le refus du PLAFOND tel quel (409 plafond_actifs)", async () => {
    const b = bancRoute(
      [bot("yuki", 0, true), bot("b2", 1, true), bot("b3", 2, true), bot("b4", 3)],
      { maxActifs: 3 },
    );
    const refus = await appel(b, "PATCH", "/api/bots/b4/actif", { actif: true });
    expect(refus.status).toBe(409);
    expect(refus.body.code).toBe("plafond_actifs");
    expect(String(refus.body.message)).toContain("bots.maxActifs");
  });

  it("rend le refus du DERNIER bot actif (409 dernier_bot_actif)", async () => {
    const b = bancRoute([bot("yuki", 0, true), bot("kohai", 1)]);
    const refus = await appel(b, "PATCH", "/api/bots/yuki/actif", { actif: false });
    expect(refus.status).toBe(409);
    expect(refus.body.code).toBe("dernier_bot_actif");
  });

  it("405 en GET, 404 pour un bot inconnu, 400 pour un corps non booléen", async () => {
    const b = bancRoute([bot("yuki", 0, true), bot("kohai", 1)]);
    expect((await appel(b, "GET", "/api/bots/kohai/actif")).status).toBe(405);
    expect((await appel(b, "PATCH", "/api/bots/fantome/actif", { actif: true })).status).toBe(404);
    const invalide = await appel(b, "PATCH", "/api/bots/kohai/actif", { actif: "oui" });
    expect(invalide.status).toBe(400);
    expect(invalide.body.code).toBe("actif_invalide");
  });

  it("mode mono-bot (registre absent) ⇒ 409 registre_absent", async () => {
    const b = bancRoute([bot("yuki", 0, true)]);
    b.deps.bots!.registre = null;
    const refus = await appel(b, "PATCH", "/api/bots/yuki/actif", { actif: true });
    expect(refus.status).toBe(409);
    expect(refus.body.code).toBe("registre_absent");
  });
});
