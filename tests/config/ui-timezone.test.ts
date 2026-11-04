/**
 * RÉGLAGE `ui.timeZone` — fuseau de TOUS les horodatages (« tous en UTC »,
 * demande utilisateur du 2026-11-04).
 *
 * Ce qui est verrouillé ici :
 *  1. le champ existe, son défaut est `UTC`, il est appliqué À CHAUD ;
 *  2. un fuseau INCONNU est REFUSÉ (sinon tous les horodatages retomberaient
 *     silencieusement sur UTC : une heure fausse, sans le dire) ;
 *  3. l'environnement peut l'imposer (`YUKI_UI_TIME_ZONE`) et le verrouille ;
 *  4. ⚠️ NON-RÉGRESSION : la PLANIFICATION n'est pas concernée — un déclencheur
 *     `0 9 * * *` en `Europe/Paris` tire toujours à 9 h Paris, et un envoi
 *     programmé garde son instant absolu, quel que soit le fuseau d'AFFICHAGE.
 *
 * ⚠️ ÉCHEC SUR L'ORIGINE (mesuré) : `CONFIG_SCHEMA["ui.timeZone"]` n'existait pas ;
 * il n'y avait AUCUN réglage de fuseau, donc les prompts suivaient le fuseau du
 * process et l'interface celui du navigateur.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadEnv } from "../../src/config/env.js";
import {
  ConfigRuntime,
  ConfigValidationError,
  LockedByEnvError,
  createConfigRuntime,
} from "../../src/config/runtime.js";
import { CONFIG_SCHEMA, validateField } from "../../src/config/schema.js";
import { ConfigStore } from "../../src/config/store.js";
import { effectiveTimeZone, formatCompactDateTime } from "../../src/pi/timestamp.js";
import { parseCron, prochainPassage } from "../../src/sources/cron.js";
import { formaterInstantEnvoi } from "../../src/chat/envois/quand.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeRuntime(
  processEnv: NodeJS.ProcessEnv = {},
): { runtime: ConfigRuntime; storePath: string } {
  const root = mkdtempSync(join(tmpdir(), "yuki-fuseau-"));
  tempDirs.push(root);
  const storePath = join(root, "state", "config.json");
  const env = loadEnv({
    YUKI_MOUNT_STATE: join(root, "state"),
    YUKI_CONFIG_STORE_PATH: storePath,
  });
  const runtime = createConfigRuntime({
    env,
    store: new ConfigStore(storePath),
    processEnv,
    promptDefaults: { light: "prompt", heavy: "prompt" },
  });
  return { runtime, storePath };
}

describe("ui.timeZone — un seul fuseau, réglable, par défaut UTC", () => {
  it("le schéma déclare UTC par défaut, à chaud, surchargeable par l'environnement", () => {
    const descriptor = CONFIG_SCHEMA["ui.timeZone"];
    expect(descriptor).toBeDefined();
    expect(descriptor?.default).toBe("UTC");
    expect(descriptor?.apply).toBe("hot");
    expect(descriptor?.env).toBe("YUKI_UI_TIME_ZONE");
  });

  it("un fuseau INCONNU est refusé, un fuseau IANA est accepté", () => {
    const refuse = validateField("ui.timeZone", "Mars/Olympus");
    expect(refuse.ok).toBe(false);
    expect(refuse.ok === false && refuse.code).toBe("invalid_timezone");
    expect(validateField("ui.timeZone", "Europe/Paris")).toEqual({
      ok: true,
      value: "Europe/Paris",
    });
    // La chaîne vide n'est pas un fuseau : `null` restaure le défaut.
    expect(validateField("ui.timeZone", "").ok).toBe(false);
  });

  it("l'instantané sert la valeur ET le défaut (ce que lit la page /config)", () => {
    const { runtime } = makeRuntime();
    expect(runtime.snapshot().fields["ui.timeZone"]).toMatchObject({
      value: "UTC",
      default: "UTC",
      origin: "default",
      apply: "hot",
    });
  });

  it("le changement est appliqué À CHAUD (aucun redémarrage)", () => {
    const { runtime } = makeRuntime();
    const date = new Date("2026-11-02T10:46:00.000Z");
    expect(formatCompactDateTime(date, effectiveTimeZone(runtime.getString("ui.timeZone")))).toBe(
      "2026-11-02 10:46",
    );

    runtime.update({ "ui.timeZone": "Europe/Paris" });
    expect(runtime.originOf("ui.timeZone")).toBe("store");
    expect(
      formatCompactDateTime(date, effectiveTimeZone(runtime.getString("ui.timeZone"))),
    ).toBe("2026-11-02 11:46");

    // `null` restaure le défaut (UTC).
    runtime.update({ "ui.timeZone": null });
    expect(runtime.getString("ui.timeZone")).toBe("UTC");
  });

  it("un fuseau invalide est REFUSÉ par le gateway (jamais persisté)", () => {
    const { runtime } = makeRuntime();
    expect(() => runtime.update({ "ui.timeZone": "Mars/Olympus" })).toThrow(
      ConfigValidationError,
    );
    expect(runtime.getString("ui.timeZone")).toBe("UTC");
  });

  it("`YUKI_UI_TIME_ZONE` impose la valeur et verrouille le champ", () => {
    const { runtime } = makeRuntime({ YUKI_UI_TIME_ZONE: "America/New_York" });
    expect(runtime.getString("ui.timeZone")).toBe("America/New_York");
    expect(runtime.originOf("ui.timeZone")).toBe("env");
    expect(() => runtime.update({ "ui.timeZone": "UTC" })).toThrow(LockedByEnvError);
  });
});

describe("⚠️ NON-RÉGRESSION — la PLANIFICATION garde SON fuseau", () => {
  const PARIS = "Europe/Paris";

  it("`0 9 * * *` en Europe/Paris tire à 9 h PARIS, quel que soit l'affichage", () => {
    const { runtime } = makeRuntime();
    const expr = parseCron("0 9 * * *");
    const depuis = Date.parse("2026-06-01T00:00:00.000Z");
    const avant = prochainPassage(expr, depuis, PARIS);

    // On change le fuseau d'AFFICHAGE : l'instant planifié ne bouge pas.
    runtime.update({ "ui.timeZone": "Asia/Tokyo" });
    const apres = prochainPassage(expr, depuis, PARIS);

    expect(apres).toBe(avant);
    // 9 h à Paris en juin (CEST, +2) = 07:00 UTC. ⚠️ Surtout PAS 09:00 UTC.
    expect(new Date(avant).toISOString()).toBe("2026-06-01T07:00:00.000Z");
    // …et l'affichage du MÊME instant reste une heure différente selon le réglage.
    expect(formatCompactDateTime(new Date(avant), "Asia/Tokyo")).toBe("2026-06-01 16:00");
    expect(formatCompactDateTime(new Date(avant), "UTC")).toBe("2026-06-01 07:00");
  });

  it("un envoi programmé garde son instant absolu et son propre fuseau", () => {
    const { runtime } = makeRuntime();
    const at = Date.parse("2026-11-04T15:10:00.000Z");
    const avant = formaterInstantEnvoi(at, PARIS);

    runtime.update({ "ui.timeZone": "Asia/Tokyo" });
    const apres = formaterInstantEnvoi(at, PARIS);

    // Le texte de l'envoi porte le fuseau de l'ENVOI, jamais celui de l'affichage.
    expect(apres).toBe(avant);
    expect(apres).toContain("Europe/Paris");
    // L'instant, lui, est absolu : la même milliseconde.
    expect(new Date(at).toISOString()).toBe("2026-11-04T15:10:00.000Z");
  });

  it("`prochainPassage` stocké (ISO) n'est pas décalé par le réglage d'affichage", () => {
    const { runtime } = makeRuntime();
    const expr = parseCron("30 8 * * 1-5");
    const depuis = Date.parse("2026-11-02T00:00:00.000Z");
    const stocke = new Date(prochainPassage(expr, depuis, PARIS)).toISOString();
    runtime.update({ "ui.timeZone": "Europe/Paris" });
    expect(new Date(prochainPassage(expr, depuis, PARIS)).toISOString()).toBe(stocke);
    // 8 h 30 à Paris en novembre (CET, +1) = 07:30 UTC.
    expect(stocke).toBe("2026-11-02T07:30:00.000Z");
  });
});
