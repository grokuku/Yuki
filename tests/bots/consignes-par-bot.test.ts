/**
 * CONSIGNES DURABLES PAR BOT — le bot écrit dans SON fichier.
 *
 * Défaut à empêcher : un host secondaire qui hériterait du port du bot du run
 * écrirait dans le fichier d'un AUTRE bot (même famille de bug que les replis
 * vers le « bot principal »). Ce fichier VERROUILLE :
 *  ① `portsHostBot` construit un port dont le fichier est
 *    `<state>/bots/<id>/consignes.md` de CE bot — deux bots, deux fichiers ;
 *  ② `optionsHostBot` POSE le port du bot et le RETIRE quand il n'y en a pas
 *    (jamais celui du bot du run) ;
 *  ③ aucune condition sur un `botId` particulier dans le câblage.
 *
 * ⚠️ ÉCHOUE SUR LE CODE D'ORIGINE : `consignes` n'existe pas dans
 * `PortsHostBot`/`PiHostOptions`, et `Env` n'a pas `consignesPath`.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  optionsHostBot,
  portsHostBot,
  type ContexteHostBot,
} from "../../src/bots/hosts.js";
import { CAPACITES_BOT, cheminRegistreBots, ecrireRegistreBots } from "../../src/bots/registry.js";
import type { OutilsBot } from "../../src/bots/outils.js";
import { creerConfigsBots } from "../../src/config/bots.js";
import { loadEnv, type Env } from "../../src/config/env.js";
import { envPourBot } from "../../src/memory/stores-bot.js";
import type { PiHostOptions } from "../../src/pi/types.js";

const racines: string[] = [];

afterEach(() => {
  for (const racine of racines.splice(0)) rmSync(racine, { recursive: true, force: true });
});

interface Banc {
  state: string;
  env: Env;
  processEnv: NodeJS.ProcessEnv;
}

function banc(): Banc {
  const racine = mkdtempSync(join(tmpdir(), "yuki-consignes-bot-"));
  racines.push(racine);
  const state = join(racine, "state");
  mkdirSync(state, { recursive: true });
  mkdirSync(join(racine, "pi", "agent", "sessions"), { recursive: true });
  const processEnv: NodeJS.ProcessEnv = {};
  const env = loadEnv({
    YUKI_MOUNT_STATE: state,
    YUKI_MOUNT_PI_AGENT: join(racine, "pi"),
    YUKI_CONFIG_STORE_PATH: join(state, "config.json"),
    YUKI_LOG_LEVEL: "error",
  });
  return { state, env, processEnv };
}

const PROMPTS = { light: "prompt livré léger", heavy: "prompt livré lourd" };

function deuxBots(): { b: Banc; configs: Map<string, import("../../src/config/runtime.js").ConfigRuntime> } {
  const b = banc();
  const bots = ["yuki", "kohai"].map((id, ordre) => ({
    id,
    nom: id,
    capacites: [...CAPACITES_BOT],
    actif: ordre === 0,
    ordre,
    creeLe: "2026-01-01T00:00:00.000Z",
    plateformes: {},
  }));
  ecrireRegistreBots(cheminRegistreBots(b.state), { schemaVersion: 1, bots, echanges: {} });
  const configs = creerConfigsBots({
    env: b.env,
    bots: bots.map((entree) => entree.id),
    pile: "yuki",
    promptDefaults: PROMPTS,
    processEnv: b.processEnv,
  });
  return { b, configs };
}

/** Outils factices : seul le chemin des consignes compte ici (il est RÉEL). */
function outilsFactices(envBot: Env, botId: string): OutilsBot {
  return {
    botId,
    env: envBot,
    chemins: {
      personalityPath: join(envBot.mountPoints.state, "personality.md"),
      rulesPath: join(envBot.mountPoints.state, "rules.md"),
      consignesPath: join(envBot.mountPoints.state, "bots", botId, "consignes.md"),
    },
    personnalite: { read: () => ({ text: "", chars: 0, truncated: false, exists: false }) },
    regles: { get: () => "" },
    reactions: { recent: () => [] },
    archive: { search: async () => [] },
  } as unknown as OutilsBot;
}

function contexteDe(
  b: Banc,
  botId: string,
  configs: Map<string, import("../../src/config/runtime.js").ConfigRuntime>,
): ContexteHostBot {
  const env = envPourBot({
    envInstance: b.env,
    botId,
    mode: "multi",
    processEnv: b.processEnv,
  });
  const config = configs.get(botId);
  return {
    botId,
    env,
    ...(config !== undefined ? { config } : {}),
    outils: outilsFactices(env, botId),
  };
}

describe("① deux bots ⇒ deux fichiers de consignes", () => {
  it("le port de chaque host vise `<state>/bots/<id>/consignes.md`", () => {
    const { b, configs } = deuxBots();
    const yuki = portsHostBot(contexteDe(b, "yuki", configs));
    const kohai = portsHostBot(contexteDe(b, "kohai", configs));
    if (!yuki || !kohai) throw new Error("ports absents");
    expect(yuki.consignes?.chemin()).toBe(join(b.state, "bots", "yuki", "consignes.md"));
    expect(kohai.consignes?.chemin()).toBe(join(b.state, "bots", "kohai", "consignes.md"));
    expect(yuki.consignes?.chemin()).not.toBe(kohai.consignes?.chemin());
  });

  it("une consigne enregistrée par un bot ne touche PAS le fichier de l'autre", () => {
    const { b, configs } = deuxBots();
    const yuki = portsHostBot(contexteDe(b, "yuki", configs));
    const kohai = portsHostBot(contexteDe(b, "kohai", configs));
    if (!yuki?.consignes || !kohai?.consignes) throw new Error("ports absents");
    expect(yuki.consignes.ajouter("consigne", "consigne de yuki").ok).toBe(true);
    expect(kohai.consignes.lire()).toEqual({ consignes: [], faits: [] });
    expect(existsSync(join(b.state, "bots", "kohai", "consignes.md"))).toBe(false);
    expect(existsSync(join(b.state, "bots", "yuki", "consignes.md"))).toBe(true);
  });

  it("aucun `botId` n'est traité à part dans le câblage (garde structurelle)", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(join(process.cwd(), "src", "bots", "hosts.ts"), "utf8");
    const zone = source.slice(
      source.indexOf("consignes: portConsignes("),
      source.indexOf("consignes: portConsignes(") + 400,
    );
    expect(zone).toContain("contexte.env.consignesPath");
    expect(zone).not.toMatch(/botId\s*===/);
    expect(zone).not.toContain('"yuki"');
  });
});

describe("② `optionsHostBot` : posé ou RETIRÉ, jamais hérité", () => {
  it("le port du bot est posé quand il existe", () => {
    const { b, configs } = deuxBots();
    const contexte = contexteDe(b, "kohai", configs);
    const ports = portsHostBot(contexte);
    if (!ports) throw new Error("ports absents");
    const optionsPile = {
      systemPrompt: "prompt du bot du run",
      consignes: portsHostBot(contexteDe(b, "yuki", configs))?.consignes,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    } as unknown as PiHostOptions;
    const options = optionsHostBot("kohai", optionsPile, ports);
    expect(options.consignes).toBe(ports.consignes);
  });

  it("sans port pour ce bot, celui du bot du run est RETIRÉ", () => {
    const { b, configs } = deuxBots();
    const contexte = contexteDe(b, "yuki", configs);
    const ports = portsHostBot(contexte);
    if (!ports) throw new Error("ports absents");
    const { consignes: _ignore, ...sansConsignes } = ports;
    void _ignore;
    const optionsPile = {
      systemPrompt: "prompt du bot du run",
      consignes: ports.consignes,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    } as unknown as PiHostOptions;
    const options = optionsHostBot("kohai", optionsPile, sansConsignes);
    expect(options.consignes).toBeUndefined();
  });
});

describe("③ le fichier humain reste la seule source", () => {
  it("un fichier écrit à la main est lu tel quel par le port du bot", () => {
    const { b, configs } = deuxBots();
    const chemin = join(b.state, "bots", "kohai", "consignes.md");
    mkdirSync(join(b.state, "bots", "kohai"), { recursive: true });
    writeFileSync(chemin, "## Consignes\n\n- sois bref\n\n## Faits\n\n- j'habite à Lyon\n", "utf8");
    const ports = portsHostBot(contexteDe(b, "kohai", configs));
    expect(ports?.consignes?.lire()).toEqual({
      consignes: ["sois bref"],
      faits: ["j'habite à Lyon"],
    });
  });
});
