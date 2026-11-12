/**
 * OVERLAY de configuration du bot actif (lot 35b, sous-lot 1b-1).
 *
 * Ce que ce fichier verrouille :
 *  - un SECOND store, plat, `<state>/bots/<id>/config.overlay.json`, écrit de
 *    façon atomique et en 0600 — jamais imbriqué dans `config.json` ;
 *  - la précédence `env > overlay > store commun > défaut` ;
 *  - `mixte` + `surcharge` : l'overlay REMPLACE la valeur commune ;
 *  - `mixte` + `et` : CONJONCTION (instance `off` ⇒ `off` même si le bot est `on`) ;
 *  - `bot` : l'overlay prime, le store commun sert de repli ;
 *  - overlay ABSENT ⇒ exactement le comportement d'avant le lot ;
 *  - une clé de bot n'est JAMAIS écrite dans `config.json`.
 *
 * ⚠️ Échoue sur le code d'origine : `ConfigRuntime` n'y connaît aucun overlay
 * (`runtime.overlayPath` absent, `update()` n'écrit que `config.json`).
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadEnv } from "../../src/config/env.js";
import { ConfigRuntime, createConfigRuntime } from "../../src/config/runtime.js";
import { ConfigStore } from "../../src/config/store.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Banc {
  /** Runtime neuf construit sur les fichiers de CE banc (état courant du disque). */
  runtime: () => ConfigRuntime;
  racine: string;
  storePath: string;
  overlayPath: string;
}

/**
 * Banc d'essai : un volume `state` neuf, un store commun, un bot `yuki`.
 * `runtime()` relit le DISQUE tel qu'il est maintenant (c'est ce qui permet de
 * vérifier qu'« une clé survit à un redémarrage »).
 */
function banc(processEnv: NodeJS.ProcessEnv = {}): Banc {
  const racine = mkdtempSync(join(tmpdir(), "yuki-overlay-"));
  tempDirs.push(racine);
  const stateDir = join(racine, "state");
  const storePath = join(stateDir, "config.json");
  const overlayPath = join(stateDir, "bots", "yuki", "config.overlay.json");
  const runtime = (): ConfigRuntime =>
    createConfigRuntime({
      env: loadEnv({
        YUKI_MOUNT_STATE: stateDir,
        YUKI_CONFIG_STORE_PATH: storePath,
        YUKI_PI_SYSTEM_PROMPT: join(racine, "light.md"),
        YUKI_PI_HEAVY_SYSTEM_PROMPT: join(racine, "heavy.md"),
      }),
      store: new ConfigStore(storePath),
      processEnv: { ...processEnv },
      promptDefaults: { light: "prompt livré léger", heavy: "prompt livré lourd" },
    });
  return { runtime, racine, storePath, overlayPath };
}

/** Valeurs du store COMMUN tel qu'il est SUR LE DISQUE. */
function communSurDisque(storePath: string): Record<string, unknown> {
  return new ConfigStore(storePath).load().values;
}

describe("① overlay absent ⇒ comportement IDENTIQUE à avant le lot", () => {
  it("aucun fichier d'overlay n'est créé par la simple lecture", () => {
    const b = banc();
    const runtime = b.runtime();
    expect(runtime.getString("chat.mode")).toBe("local");
    expect(runtime.getString("tts.voice")).toBe("");
    expect(runtime.overlayPath).toBe(b.overlayPath);
    expect(() => statSync(b.overlayPath)).toThrow();
  });

  it("une valeur héritée du store commun reste EFFECTIVE (repli)", () => {
    const b = banc();
    new ConfigStore(b.storePath).write({ "chat.mode": "discord", "tts.voice": "voix-heritee" });
    const runtime = b.runtime();
    expect(runtime.getString("chat.mode")).toBe("discord");
    expect(runtime.getString("tts.voice")).toBe("voix-heritee");
    expect(runtime.originOf("chat.mode")).toBe("store");
  });
});

describe("② aiguillage des écritures : une clé de bot ne fuit pas dans config.json", () => {
  it("`update()` d'une clé `bot` écrit dans l'overlay, jamais dans le store commun", () => {
    const b = banc();
    const runtime = b.runtime();
    runtime.update({ "chat.mode": "mattermost" });

    expect(runtime.getString("chat.mode")).toBe("mattermost");
    expect(communSurDisque(b.storePath)).toEqual({});
    const overlay = JSON.parse(readFileSync(b.overlayPath, "utf8")) as Record<string, unknown>;
    expect(overlay).toEqual({ "chat.mode": "mattermost" });
  });

  it("l'overlay est PLAT et en 0600", () => {
    const b = banc();
    b.runtime().update({ "tts.voice": "alloy" });
    const texte = readFileSync(b.overlayPath, "utf8");
    expect(JSON.parse(texte)).toEqual({ "tts.voice": "alloy" });
    // Aucune enveloppe `schemaVersion`/`values` : un overlay se lit à l'œil.
    expect(texte).not.toContain("schemaVersion");
    expect(statSync(b.overlayPath).mode & 0o777).toBe(0o600);
  });

  it("`update()` d'une clé `instance` continue d'écrire dans le store commun", () => {
    const b = banc();
    b.runtime().update({ "llm.light.model": "autre-modele" });
    expect(communSurDisque(b.storePath)).toEqual({ "llm.light.model": "autre-modele" });
    expect(() => statSync(b.overlayPath)).toThrow();
  });

  it("`portee: \"instance\"` force le store commun (côté instance d'une clé mixte)", () => {
    const b = banc();
    b.runtime().update({ "tts.enabled": "on" }, { portee: "instance" });
    expect(communSurDisque(b.storePath)).toEqual({ "tts.enabled": "on" });
    expect(() => statSync(b.overlayPath)).toThrow();
  });
});

describe("③ l'overlay est relu au REDÉMARRAGE", () => {
  it("une clé de bot écrite dans l'overlay survit à un `reload`", () => {
    const b = banc();
    b.runtime().update({ "chat.mode": "discord", "tts.voice": "voix-du-bot" });

    const apres = b.runtime();
    expect(apres.getString("chat.mode")).toBe("discord");
    expect(apres.getString("tts.voice")).toBe("voix-du-bot");
    expect(apres.originOf("tts.voice")).toBe("store");
  });

  it("un overlay ILLISIBLE ne casse pas le démarrage : fichier conservé, valeur commune utilisée", () => {
    const b = banc();
    b.runtime().update({ "chat.mode": "discord" });
    writeFileSync(b.overlayPath, "{ ceci n'est pas du JSON");

    const apres = b.runtime();
    expect(apres.getString("chat.mode")).toBe("local");
    expect(apres.warnings.join("\n")).toContain("overlay de configuration du bot");
    // ⚠️ Jamais d'écrasement d'un fichier qu'on n'a pas su lire.
    expect(readFileSync(b.overlayPath, "utf8")).toBe("{ ceci n'est pas du JSON");
  });

  it("un champ d'INSTANCE trouvé dans l'overlay est ignoré et DIT", () => {
    const b = banc();
    mkdirSync(join(b.racine, "state", "bots", "yuki"), { recursive: true });
    writeFileSync(
      b.overlayPath,
      JSON.stringify({ "llm.light.model": "depuis-overlay", "chat.mode": "discord" }),
    );
    const apres = b.runtime();
    expect(apres.getString("llm.light.model")).toBe("gemma4:31b");
    expect(apres.getString("chat.mode")).toBe("discord");
    expect(apres.warnings.join("\n")).toContain("champ d'INSTANCE présent dans l'overlay");
  });
});

describe("④ précédence : env > overlay > store commun > défaut", () => {
  it("défaut < store commun < overlay", () => {
    const b = banc();
    // 1. défaut.
    expect(b.runtime().getString("tts.voice")).toBe("");
    // 2. store commun (valeur héritée, écrite à la main).
    new ConfigStore(b.storePath).write({ "tts.voice": "voix-commune" });
    expect(b.runtime().getString("tts.voice")).toBe("voix-commune");
    // 3. overlay du bot.
    b.runtime().update({ "tts.voice": "voix-bot" });
    expect(b.runtime().getString("tts.voice")).toBe("voix-bot");
    // Le store commun n'a pas été réécrit : il garde la valeur de repli.
    expect(communSurDisque(b.storePath)).toEqual({ "tts.voice": "voix-commune" });
  });

  it("l'environnement reste PRIORITAIRE sur le store (clé d'instance)", () => {
    const b = banc({ YUKI_LLM_LIGHT_MODEL: "modele-env" });
    // Le store est écrit AVANT la construction : le champ est verrouillé par
    // l'environnement, donc un `PUT` le viserait serait refusé (`locked_by_env`).
    new ConfigStore(b.storePath).write({ "llm.light.model": "modele-store" });
    const runtime = b.runtime();
    expect(runtime.getString("llm.light.model")).toBe("modele-env");
    expect(runtime.originOf("llm.light.model")).toBe("env");
    expect(() => runtime.update({ "llm.light.model": "autre" })).toThrowError();
  });

  it("une clé de bot ne peut PAS être fixée par l'environnement (lot 35b) : la variable est annoncée", () => {
    const b = banc({ YUKI_TTS_VOICE: "voix-env" });
    const runtime = b.runtime();
    expect(runtime.getString("tts.voice")).toBe("");
    expect(runtime.warnings.join("\n")).toContain("YUKI_TTS_VOICE");
  });
});

/**
 * ⚠️ CLASSEMENT VALIDÉ — TROIS CLÉS RECLASSÉES `instance` : `chat.remoteAgents`,
 * `chat.remoteTools` (avant `bot`) et `memory.consolidation.enabled` (avant
 * `mixte`). Ce bloc verrouille la CONSÉQUENCE DE LECTURE : la valeur effective est
 * la COMMUNE, jamais celle de l'overlay du bot (sinon la valeur d'instance ne
 * serait plus jamais lue), et l'écriture par la route du bot est REFUSÉE.
 */
describe("⑤ter clés reclassées `instance` : lecture COMMUNE, écriture de bot refusée", () => {
  /** Clé → valeur VALIDE de son enum (les deux familles n'ont pas le même vocabulaire). */
  const RECLASSEES: ReadonlyArray<readonly [string, string]> = [
    ["chat.remoteAgents", "actives"],
    ["chat.remoteTools", "actives"],
    ["memory.consolidation.enabled", "off"],
  ];

  it("la valeur de l'INSTANCE est lue (aucun chemin ne lit l'overlay du bot)", () => {
    const b = banc();
    const runtime = b.runtime();
    runtime.update({ "chat.remoteAgents": "actives" }, { portee: "instance" });
    runtime.update({ "chat.remoteTools": "actives" }, { portee: "instance" });
    runtime.update({ "memory.consolidation.enabled": "off" }, { portee: "instance" });
    expect(runtime.getString("chat.remoteAgents")).toBe("actives");
    expect(runtime.getString("chat.remoteTools")).toBe("actives");
    expect(runtime.getString("memory.consolidation.enabled")).toBe("off");
    // Un overlay de bot qui porterait encore l'ancienne portée est IGNORÉ
    // (averti, jamais appliqué) : la valeur d'instance reste la seule lue.
    for (const [cle] of RECLASSEES) {
      expect(runtime.snapshotPour("yuki").fields[cle].scope).toBe("instance");
    }
  });

  it("une valeur d'OVERLAY périmée ne reprend pas la main (précédence)", () => {
    const b = banc();
    mkdirSync(join(b.racine, "state", "bots", "yuki"), { recursive: true });
    writeFileSync(
      b.overlayPath,
      JSON.stringify({
        "chat.remoteTools": "actives",
        "memory.consolidation.enabled": "off",
      }),
      "utf8",
    );
    const runtime = b.runtime();
    // ⚠️ Valeurs d'INSTANCE (défauts) : l'overlay ne les surcharge plus.
    expect(runtime.getString("chat.remoteTools")).toBe("desactive");
    expect(runtime.getString("memory.consolidation.enabled")).toBe("on");
    expect(runtime.warnings.join("\n")).toContain("chat.remoteTools");
  });

  it("aucune des trois ne s'écrit par la route du bot (`instance_scoped_field`)", () => {
    for (const [cle, valeur] of RECLASSEES) {
      const runtime = banc().runtime();
      // Le REFUS est porté par le runtime (`ConfigUpdateOptions.refuser`), avec
      // `instance_scoped_field` en `code` et une phrase actionnable en message.
      expect(() =>
        runtime.update({ [cle]: valeur }, { portee: "bot", refuser: "instance" }),
      ).toThrow(/page de l'instance/);
      // Et la route d'instance l'accepte (jamais de clé sans écran NI sans route).
      const runtime2 = banc().runtime();
      expect(() =>
        runtime2.update({ [cle]: valeur }, { portee: "instance", refuser: "bot" }),
      ).not.toThrow();
      expect(runtime2.getString(cle)).toBe(valeur);
    }
  });
});

describe("⑤ `mixte` + `et` : CONJONCTION (le bot ne peut que RESTREINDRE)", () => {
  it("instance OFF ⇒ OFF même si le bot est ON", () => {
    const runtime = banc().runtime();
    runtime.update({ "tts.enabled": "off" }, { portee: "instance" });
    runtime.update({ "tts.enabled": "on" }, { portee: "bot" });
    expect(runtime.getString("tts.enabled")).toBe("off");
  });

  it("instance ON et bot ON ⇒ ON", () => {
    const runtime = banc().runtime();
    runtime.update({ "tts.enabled": "on" }, { portee: "instance" });
    runtime.update({ "tts.enabled": "on" }, { portee: "bot" });
    expect(runtime.getString("tts.enabled")).toBe("on");
  });

  it("bot OFF ⇒ OFF même si l'instance est ON", () => {
    const runtime = banc().runtime();
    runtime.update({ "push.enabled": "on" }, { portee: "instance" });
    runtime.update({ "push.enabled": "off" }, { portee: "bot" });
    expect(runtime.getString("push.enabled")).toBe("off");
  });

  it("les DEUX côtés absents ⇒ défaut du schéma (aucun changement de comportement)", () => {
    const runtime = banc().runtime();
    expect(runtime.getString("push.enabled")).toBe("on");
    expect(runtime.getString("tts.enabled")).toBe("off");
    expect(runtime.originOf("push.enabled")).toBe("default");
  });

  it("activer la voix depuis la page (portée par défaut) RESTE effectif", () => {
    // ⚠️ Non-régression : `PUT { tts.enabled: "on" }` ne doit pas devenir un
    // no-op sous prétexte que le côté « instance » est au défaut.
    const runtime = banc().runtime();
    runtime.update({ "tts.enabled": "on" });
    expect(runtime.getString("tts.enabled")).toBe("on");
  });
});

describe("⑥ `mixte` + `surcharge` : l'overlay REMPLACE la valeur commune", () => {
  it("prompt : le bot remplace le prompt d'instance, puis le rend en le réinitialisant", () => {
    const b = banc();
    const runtime = b.runtime();
    runtime.update({ "prompts.light": "prompt d'instance" }, { portee: "instance" });
    expect(runtime.getString("prompts.light")).toBe("prompt d'instance");

    runtime.update({ "prompts.light": "prompt du bot" });
    expect(runtime.getString("prompts.light")).toBe("prompt du bot");
    expect(communSurDisque(b.storePath)).toEqual({ "prompts.light": "prompt d'instance" });

    // Réinitialiser au défaut efface AUSSI la valeur commune : le défaut revient.
    runtime.update({ "prompts.light": null });
    expect(runtime.getString("prompts.light")).toBe("prompt livré léger");
    expect(communSurDisque(b.storePath)).toEqual({});
  });
});

describe("⑦ réinitialisation et audit", () => {
  it("`null` efface l'overlay ET la valeur héritée du store commun (le défaut revient)", () => {
    const b = banc();
    new ConfigStore(b.storePath).write({ "chat.mode": "discord" });
    const runtime = b.runtime();
    expect(runtime.getString("chat.mode")).toBe("discord");

    const resultat = runtime.update({ "chat.mode": null });
    expect(resultat.changes).toEqual([
      expect.objectContaining({ path: "chat.mode", from: "discord", to: null }),
    ]);
    expect(runtime.getString("chat.mode")).toBe("local");
    expect(communSurDisque(b.storePath)).toEqual({});
  });

  it("les changements d'une clé de bot sont audités comme ceux d'une clé d'instance", () => {
    const runtime = banc().runtime();
    const resultat = runtime.update({ "chat.mode": "discord" });
    expect(resultat.changes).toEqual([
      { path: "chat.mode", secret: false, from: "local", to: "discord" },
    ]);
    expect(resultat.applied.hot).toEqual(["chat.mode"]);
  });
});
