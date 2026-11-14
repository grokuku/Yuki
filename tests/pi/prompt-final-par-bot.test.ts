/**
 * PROMPT FINAL D'UN BOT — ce que le MODÈLE reçoit vraiment, après TOUTES les
 * extensions du host (`before_agent_start`), pour DEUX bots à personnalités
 * distinctes.
 *
 * ⚠️ POURQUOI CE TEST (bug du 2026-11-14) : `grolaf` avait sa personnalité
 * enregistrée (« Tu es Grolaf… »), le badge disait « à chaud », et le bot
 * répondait « je suis Yuki ». Il fallait donc PROUVER le texte final, pas
 * supposer : c'est la seule façon de distinguer « la relecture ne marche pas »
 * de « une AUTRE source injecte l'identité de Yuki ».
 *
 * ⚠️ La chaîne est celle du SDK (`_extensionRunner.emitBeforeAgentStart`,
 * `dist/core/extensions/runner.js`) : chaque extension reçoit le prompt COURANT
 * et peut le REMPLACER ; celle qui ne pose rien ne change rien. On la rejoue ici
 * à l'identique, sans modèle et sans réseau (aucun E2E).
 *
 * Échoue sur l'origine : `promptDuTour` n'existe pas dans `PiHostOptions`, donc
 * le prompt final ne contient jamais la personnalité du bot — il reste celui du
 * démarrage (l'identité de la pile).
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  optionsHostBot,
  portsHostBot,
  type ContexteHostBot,
  type PortsHostBot,
} from "../../src/bots/hosts.js";
import { buildInlineExtensions } from "../../src/pi/sdk-host.js";
import type { PiHostOptions } from "../../src/pi/types.js";
import { envPourBot } from "../../src/memory/stores-bot.js";
import { creerConfigsBots } from "../../src/config/bots.js";
import { loadEnv, type Env } from "../../src/config/env.js";
import type { OutilsBot } from "../../src/bots/outils.js";
import type { PileSourcesBot } from "../../src/sources/par-bot.js";

const racines: string[] = [];

afterEach(() => {
  for (const racine of racines.splice(0)) rmSync(racine, { recursive: true, force: true });
});

/** Marqueurs DISTINCTIFS des deux personnalités (jamais le seul mot « Yuki »). */
const PERSONNALITE_PILE = [
  "Yuki est une entité unique.",
  "Même personne partout, quelle que soit la plateforme.",
  "Apparence : cheveux bleus, regard calme.",
].join("\n");

const PERSONNALITE_GROLAF = [
  "Le Cybergitan du 34.",
  "Tu es Grolaf, une conscience numérique avec le bagout du sud.",
].join("\n");

interface Banc {
  state: string;
  env: Env;
  processEnv: NodeJS.ProcessEnv;
}

function banc(): Banc {
  const racine = mkdtempSync(join(tmpdir(), "yuki-prompt-final-"));
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

const journal = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Outils du bot : SEULEMENT ce que `portsHostBot` lit (chemins, personnalité). */
function outilsDuBot(envBot: Env, botId: string, personnalite: string): OutilsBot {
  const personalityPath = join(envBot.mountPoints.state, `${botId}-personality.md`);
  writeFileSync(personalityPath, personnalite, "utf8");
  const rulesPath = join(envBot.mountPoints.state, `${botId}-rules.md`);
  writeFileSync(rulesPath, `règles de ${botId}`, "utf8");
  return {
    botId,
    env: envBot,
    chemins: { personalityPath, rulesPath },
    // ⚠️ AUCUN store de personnalité : le module LIT le chemin demandé
    // (`lireFichierPersonnalite`), donc le fichier écrit ci-dessus est bien la
    // source — pas le port d'un autre bot.
    personnalite: undefined,
    regles: { get: () => `règles de ${botId}` },
    reactions: { recent: () => [] },
    archive: { search: async () => [] },
  } as unknown as OutilsBot;
}

const pileFactice = { service: { takePending: () => undefined } } as unknown as PileSourcesBot;

function contexteDuBot(b: Banc, botId: string, personnalite: string): ContexteHostBot {
  const env = envPourBot({ envInstance: b.env, botId, mode: "multi", processEnv: b.processEnv });
  return {
    botId,
    env,
    // Pas de `config` : la personnalité vient du FICHIER du bot (amorçage), ce qui
    // reproduit exactement la cascade `champ > fichier du bot > fichier d'instance`.
    outils: outilsDuBot(env, botId, personnalite),
    pile: pileFactice,
  };
}

/**
 * Rejoue la chaîne `before_agent_start` du SDK : chaque extension voit le prompt
 * COURANT, et seule une valeur `systemPrompt` rendue le remplace.
 */
async function promptFinal(options: PiHostOptions): Promise<string> {
  let systeme = options.systemPrompt;
  const extensions = buildInlineExtensions(options);
  expect(extensions.length).toBeGreaterThan(0);
  for (const extension of extensions) {
    // ⚠️ `InlineExtension` ET `ExtensionFactory` cohabitent dans la chaîne : la
    // première porte sa `factory`, la seconde EST la fabrique.
    const fabrique = (extension as { factory?: unknown }).factory ?? extension;
    const gestionnaires: ((event: unknown) => unknown)[] = [];
    (fabrique as (api: unknown) => void)({
      on: (nom: string, gestionnaire: (event: unknown) => unknown) => {
        if (nom === "before_agent_start") gestionnaires.push(gestionnaire);
      },
    });
    for (const gestionnaire of gestionnaires) {
      const resultat = (await gestionnaire({
        type: "before_agent_start",
        prompt: "bonjour",
        systemPrompt: systeme,
      })) as { systemPrompt?: string } | undefined;
      if (resultat?.systemPrompt !== undefined) systeme = resultat.systemPrompt;
    }
  }
  return systeme;
}

interface PromptDuBanc {
  options: PiHostOptions;
  ports: PortsHostBot;
}

function bancDeuxBots(): { b: Banc; bots: Record<string, PromptDuBanc> } {
  const b = banc();
  const configs = creerConfigsBots({
    env: b.env,
    bots: ["yuki", "grolaf"],
    pile: "yuki",
    promptDefaults: { light: "Consignes de conversation livrées.", heavy: "Worker livré." },
    processEnv: b.processEnv,
  });
  // ⚠️ Les PORTS de chaque bot sont calculés AVANT les options : celui de la pile
  // porte son propre `promptDuTour`, exactement comme dans `main()`.
  const portsParBot = new Map<string, PortsHostBot>();
  for (const [botId, personnalite] of [
    ["yuki", PERSONNALITE_PILE],
    ["grolaf", PERSONNALITE_GROLAF],
  ] as const) {
    const base = contexteDuBot(b, botId, personnalite);
    const config = configs.get(botId);
    expect(config, `configuration du bot ${botId}`).toBeDefined();
    const contexte: ContexteHostBot = {
      ...base,
      config: config as NonNullable<ContexteHostBot["config"]>,
    };
    const ports = portsHostBot(contexte, journal);
    expect(ports, `ports du host ${botId}`).toBeDefined();
    portsParBot.set(botId, ports as PortsHostBot);
  }
  const optionsPile: PiHostOptions = {
    botId: "yuki",
    agentDir: join(b.env.piAgentDir, "agent"),
    cwd: b.env.piCwd,
    home: b.env.piHome,
    sessionsDir: b.env.piSessionsDir,
    // ⚠️ Le prompt FIGÉ du démarrage porte un marqueur : le test vérifie qu'il ne
    // survit PAS dans le prompt final (sinon deux identités cohabitent).
    systemPrompt: `PROMPT-FIGE-DU-DEMARRAGE Yuki est une entité unique.`,
    model: "llm-light/gemma4:31b",
    tools: ["lire_fichier"],
    sources: { takePending: () => undefined },
    heritage: undefined,
    rules: { get: () => "" } as unknown as NonNullable<PiHostOptions["rules"]>,
    reactions: { recent: () => [] } as unknown as NonNullable<PiHostOptions["reactions"]>,
    // ⚠️ Le bot de la PILE a lui aussi son prompt RELU À CHAQUE TOUR : sans cette
    // ligne, son prompt resterait celui du démarrage (le défaut que ce test ferme).
    promptDuTour: portsParBot.get("yuki")?.promptDuTour,
    logger: journal,
  } as PiHostOptions;

  const bots: Record<string, PromptDuBanc> = {};
  for (const botId of ["yuki", "grolaf"] as const) {
    const ports = portsParBot.get(botId) as PortsHostBot;
    const options =
      botId === "yuki" ? optionsPile : optionsHostBot(botId, optionsPile, ports);
    bots[botId] = { options, ports };
  }
  return { b, bots };
}

describe("prompt FINAL d'un bot (après toutes les extensions)", () => {
  it("grolaf : le modèle reçoit SON identité et SA personnalité, jamais celle de Yuki", async () => {
    const { bots } = bancDeuxBots();
    const prompt = await promptFinal(bots.grolaf!.options);
    expect(prompt).toContain("Grolaf");
    expect(prompt).toContain("Le Cybergitan du 34.");
    // ⚠️ Marqueurs DISTINCTIFS de la personnalité de Yuki : aucun ne doit passer.
    expect(prompt).not.toContain("Yuki est une entité unique");
    expect(prompt).not.toContain("Même personne partout");
    expect(prompt).not.toContain("cheveux bleus");
    // Le prompt FIGÉ du démarrage ne survit pas à la relecture.
    expect(prompt).not.toContain("PROMPT-FIGE-DU-DEMARRAGE");
  });

  it("yuki (bot de la pile) : identité et personnalité inchangées", async () => {
    const { bots } = bancDeuxBots();
    const prompt = await promptFinal(bots.yuki!.options);
    expect(prompt).toContain("Yuki");
    expect(prompt).toContain("Yuki est une entité unique.");
    expect(prompt).not.toContain("Le Cybergitan du 34.");
    // ⚠️ Même pour la pile : UN SEUL prompt, celui de la relecture (le figé a
    // disparu). Un prompt qui garde les deux textes est exactement le symptôme
    // « je suis Yuki / lui n'a pas reçu les updates ».
    expect(prompt).not.toContain("PROMPT-FIGE-DU-DEMARRAGE");
  });

  it("un SEUL bloc de personnalité, à chaque tour", async () => {
    const { bots } = bancDeuxBots();
    for (const botId of ["yuki", "grolaf"] as const) {
      for (const tour of [1, 2]) {
        const prompt = await promptFinal(bots[botId]!.options);
        const ouvertures = prompt.split("<personnalite>").length - 1;
        expect(ouvertures, `${botId} tour ${tour}`).toBe(1);
        expect(prompt.split("</personnalite>").length - 1, `${botId} tour ${tour}`).toBe(1);
      }
    }
  });

  it("garde : `index.ts` ne rédige plus une réponse de canal avec un prompt « Tu es Yuki » figé", () => {
    const source = readFileSync(join(process.cwd(), "src", "index.ts"), "utf8");
    // ⚠️ La rédaction distante doit composer le prompt du bot PROPRIÉTAIRE du canal
    // (`promptRedacteurDuBot`), jamais passer la constante commune : c'était elle
    // qui faisait répondre « je suis Yuki » dans le canal de `grolaf`.
    expect(source).toContain("promptRedacteurDuBot(");
    expect(source).not.toContain("chatWriter(\n        CHAT_REPLY_SYSTEM_PROMPT");
  });
});
