/**
 * PROMPT DU TOUR — le prompt système est RELU À CHAQUE TOUR.
 *
 * ⚠️ LE BUG (2026-11-14, capture à l'appui) : le `systemPrompt` était FIGÉ au
 * démarrage du host. Le bot `grolaf` avait sa personnalité saisie
 * (« Tu es Grolaf, une conscience numérique avec le bagout du sud… ») et il
 * répondait « je suis là — Yuki » dans un canal Mattermost : éditer la
 * personnalité, un prompt ou les règles n'avait AUCUN effet sans redémarrer.
 *
 * ⚠️ CE QUI EST VERROUILLÉ ICI (ces tests ÉCHOUENT sur le code d'origine : ni
 * `src/bots/prompt-du-tour.ts` ni `src/pi/sdk/prompt-du-tour-extension.ts`
 * n'existent) :
 *  ① LE TEST CENTRAL : personnalité modifiée ⇒ le tour SUIVANT porte le nouveau
 *    texte, sans redémarrage (c'est littéralement le bug) ;
 *  ② deux bots, deux personnalités ⇒ chacun la sienne, aucune contamination ;
 *  ③ prompt léger modifié ⇒ effectif au tour suivant ; prompt lourd aussi (relu
 *    à chaque job du worker) ;
 *  ④ règles communes modifiées ⇒ effectives au tour suivant (chaîne RÉELLE) ;
 *  ⑤ fichier illisible ⇒ DERNIÈRE valeur connue, jamais un prompt vide ;
 *  ⑥ l'ORDRE des blocs est inchangé, `<regles>` en DERNIER ;
 *  ⑦ un bot SANS personnalité reçoit le DÉFAUT GÉNÉRIQUE — jamais le texte d'un
 *    autre bot — et une personnalité qui cite un autre bot est SIGNALÉE
 *    (`personnalite.nom_autre_bot`).
 *
 * ⚠️ Aucun E2E : la chaîne d'extensions est déroulée comme le fait le SDK
 * (`before_agent_start`, chaque handler recevant le prompt COURANT).
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

import { creerPortPromptDuTour } from "../../src/bots/prompt-du-tour.js";
import { candidatsPersonnalite } from "../../src/bots/personnalite-bot.js";
import { creerConfigsBots } from "../../src/config/bots.js";
import { loadEnv, type Env } from "../../src/config/env.js";
import type { ConfigRuntime } from "../../src/config/runtime.js";
import { portConsignes } from "../../src/consignes/index.js";
import { portReglesDuBot } from "../../src/rules/regles-bot.js";
import {
  PROMPT_DU_TOUR_EXTENSION_NAME,
  createPromptDuTourExtensionFactory,
} from "../../src/pi/sdk/prompt-du-tour-extension.js";
import { IDENTITY_TAG, PERSONALITY_TAG, TOOLS_TAG } from "../../src/llm/prompt-systeme.js";
import { buildInlineExtensions } from "../../src/pi/sdk-host.js";
import { RULES_EXTENSION_NAME } from "../../src/pi/sdk/rules-extension.js";

const racines: string[] = [];

afterEach(() => {
  for (const racine of racines.splice(0)) rmSync(racine, { recursive: true, force: true });
});

/** Prompts LIVRÉS fixés : le banc ne dépend pas du contenu de `config/pi/`. */
const PROMPTS = {
  light: "PROMPT LÉGER LIVRÉ.",
  heavy: "PROMPT LOURD LIVRÉ.",
  personnalite: "PERSONNALITÉ GÉNÉRIQUE LIVRÉE.",
};

/** Texte saisi pour grolaf (celui du bug). */
const TEXTE_GROLAF = "Tu es Grolaf, une conscience numérique avec le bagout du sud.";

interface Banc {
  racine: string;
  state: string;
  env: Env;
  processEnv: NodeJS.ProcessEnv;
  configs: (botIds: readonly string[], pile: string) => Map<string, ConfigRuntime>;
}

function banc(): Banc {
  const racine = mkdtempSync(join(tmpdir(), "yuki-prompt-du-tour-"));
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
  return {
    racine,
    state,
    env,
    processEnv,
    configs: (botIds, pile) =>
      creerConfigsBots({
        env,
        bots: [...botIds],
        pile,
        promptDefaults: PROMPTS,
        processEnv,
      }),
  };
}

function configDe(b: Banc, botId: string): ConfigRuntime {
  const config = b.configs([botId], botId).get(botId);
  if (config === undefined) throw new Error(`configuration absente pour ${botId}`);
  return config;
}

function cheminBotPerso(b: Banc, botId: string): string {
  return join(b.state, "bots", botId, "personality.md");
}

function ecrire(chemin: string, texte: string): void {
  mkdirSync(join(chemin, ".."), { recursive: true });
  writeFileSync(chemin, texte, "utf8");
}

/** Port du tour d'un bot, comme `portsHostBot`/`main()` le construisent. */
function portDe(
  b: Banc,
  botId: string,
  config: ConfigRuntime | undefined,
  options: {
    nom?: string;
    role?: "light" | "heavy";
    autresBots?: readonly string[];
    logger?: { info(message: string, fields?: Record<string, unknown>): void; warn(message: string, fields?: Record<string, unknown>): void };
    personnalite?: () => string;
    valeurInitiale?: string;
  } = {},
): ReturnType<typeof creerPortPromptDuTour> {
  return creerPortPromptDuTour({
    botId,
    nom: options.nom ?? botId,
    ...(config !== undefined ? { config } : {}),
    ...(options.role !== undefined ? { role: options.role } : {}),
    outils: ["read"],
    fichiersPersonnalite: candidatsPersonnalite(
      { portee: "bot", chemin: cheminBotPerso(b, botId) },
      { portee: "instance", chemin: join(b.state, "personality.md") },
    ),
    voix: false,
    valeurInitiale: options.valeurInitiale ?? "PROMPT INITIAL DU HOST",
    ...(options.autresBots !== undefined ? { autresBots: options.autresBots } : {}),
    ...(options.personnalite !== undefined ? { personnalite: options.personnalite } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  });
}

const logger = { debug() {}, info() {}, warn() {}, error() {} };

type Handler = (event: unknown, ctx?: unknown) => unknown;

/** Handler `before_agent_start` d'une fabrique d'extension. */
function handlerDe(extension: InlineExtension): Handler {
  let trouve: Handler | undefined;
  const run = typeof extension === "function" ? extension : extension.factory;
  run({
    on: (name: string, handler: Handler) => {
      if (name === "before_agent_start") trouve = handler;
    },
  } as never);
  if (!trouve) throw new Error("handler before_agent_start absent");
  return trouve;
}

/** Réplique du chaînage SDK : chaque handler reçoit le prompt COURANT. */
async function derouler(extensions: InlineExtension[], base: string): Promise<string> {
  let courant = base;
  for (const extension of extensions) {
    const resultat = (await handlerDe(extension)({
      prompt: "Bonjour",
      systemPrompt: courant,
    })) as { systemPrompt?: string } | undefined;
    if (resultat?.systemPrompt !== undefined) courant = resultat.systemPrompt;
  }
  return courant;
}

/** Journal qui retient les messages (clé du journal seulement, jamais le texte). */
function journalFactice(): {
  messages: string[];
  logger: {
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
} {
  const messages: string[] = [];
  return {
    messages,
    logger: {
      debug(message: string): void {
        messages.push(message);
      },
      info(message: string): void {
        messages.push(message);
      },
      warn(message: string): void {
        messages.push(message);
      },
      error(message: string): void {
        messages.push(message);
      },
    },
  };
}

// ── ① LE TEST CENTRAL : personnalité modifiée ⇒ tour SUIVANT ───────────────

describe("① personnalité modifiée ⇒ le tour SUIVANT porte le nouveau texte", () => {
  it("le port du tour relit la personnalité à chaque appel (aucun redémarrage)", () => {
    const b = banc();
    const config = configDe(b, "grolaf");
    const port = portDe(b, "grolaf", config, { nom: "Grolaf" });

    // Tour 1 : rien n'est saisi ⇒ la personnalité LIVRÉE (générique).
    const tour1 = port.lire();
    expect(tour1).toContain(PROMPTS.personnalite);
    expect(tour1).not.toContain("Grolaf, une conscience");

    // L'utilisateur SAISIT sa personnalité (route /api/bots/<id>/config).
    config.update({ "prompts.personnalite": TEXTE_GROLAF }, { portee: "bot" });

    // Tour 2 : le texte du message SUIVANT est le nouveau, sans redémarrage.
    const tour2 = port.lire();
    expect(tour2).toContain(TEXTE_GROLAF);
    expect(tour2).not.toContain(PROMPTS.personnalite);
    expect(tour2).toContain(`<${PERSONALITY_TAG}>`);
  });

  it("par l'EXTENSION : le prompt du tour est remplacé, pas concaténé", async () => {
    const b = banc();
    const config = configDe(b, "grolaf");
    const port = portDe(b, "grolaf", config, { nom: "Grolaf" });
    const extension = createPromptDuTourExtensionFactory(port, { logger });
    expect((extension as { name: string }).name).toBe(PROMPT_DU_TOUR_EXTENSION_NAME);

    const avant = (await handlerDe(extension)({
      prompt: "Bonjour",
      systemPrompt: "PROMPT FIGÉ DU DÉMARRAGE",
    })) as { systemPrompt?: string };
    expect(avant.systemPrompt).not.toContain("PROMPT FIGÉ DU DÉMARRAGE");
    expect(avant.systemPrompt).toContain("Ton nom est Grolaf.");

    config.update({ "prompts.personnalite": TEXTE_GROLAF }, { portee: "bot" });
    const apres = (await handlerDe(extension)({
      prompt: "Bonjour",
      systemPrompt: "PROMPT FIGÉ DU DÉMARRAGE",
    })) as { systemPrompt?: string };
    expect(apres.systemPrompt).toContain(TEXTE_GROLAF);
  });

  it("le fichier de personnalité du bot est relu lui aussi (écriture directe)", () => {
    const b = banc();
    const config = configDe(b, "grolaf");
    const port = portDe(b, "grolaf", config, { nom: "Grolaf" });

    ecrire(cheminBotPerso(b, "grolaf"), "TEXTE DU FICHIER, version 1.");
    expect(port.lire()).toContain("TEXTE DU FICHIER, version 1.");

    ecrire(cheminBotPerso(b, "grolaf"), "TEXTE DU FICHIER, version 2.");
    const tour2 = port.lire();
    expect(tour2).toContain("TEXTE DU FICHIER, version 2.");
    expect(tour2).not.toContain("version 1");
  });
});

// ── ② deux bots, deux personnalités ───────────────────────────────────────

describe("② deux bots ⇒ chacun SA personnalité (aucune contamination)", () => {
  it("le port de chaque bot ne lit que SON overlay", () => {
    const b = banc();
    const configs = b.configs(["yuki", "grolaf"], "yuki");
    const configYuki = configs.get("yuki") as ConfigRuntime;
    const configGrolaf = configs.get("grolaf") as ConfigRuntime;
    configYuki.update({ "prompts.personnalite": "Je suis Yuki." }, { portee: "bot" });
    configGrolaf.update({ "prompts.personnalite": TEXTE_GROLAF }, { portee: "bot" });

    const portYuki = portDe(b, "yuki", configYuki, { nom: "Yuki" });
    const portGrolaf = portDe(b, "grolaf", configGrolaf, { nom: "Grolaf" });

    const promptYuki = portYuki.lire();
    const promptGrolaf = portGrolaf.lire();

    expect(promptYuki).toContain("Je suis Yuki.");
    expect(promptYuki).not.toContain("Grolaf");
    expect(promptGrolaf).toContain(TEXTE_GROLAF);
    expect(promptGrolaf).not.toContain("Je suis Yuki.");
    expect(promptYuki).toContain("Ton nom est Yuki.");
    expect(promptGrolaf).toContain("Ton nom est Grolaf.");
  });
});

// ── ③ prompts (léger ET lourd) modifiés ⇒ tour suivant ────────────────────

describe("③ prompt système modifié ⇒ effectif au tour suivant", () => {
  it("prompt LÉGER : le tour suivant porte le nouveau texte", () => {
    const b = banc();
    const config = configDe(b, "grolaf");
    const port = portDe(b, "grolaf", config, { nom: "Grolaf" });

    expect(port.lire()).toContain(PROMPTS.light);
    config.update({ "prompts.light": "NOUVEAU CADRE D'EXÉCUTION." }, { portee: "bot" });
    const tour2 = port.lire();
    expect(tour2).toContain("NOUVEAU CADRE D'EXÉCUTION.");
    expect(tour2).not.toContain(PROMPTS.light);
  });

  it("prompt LOURD : recomposé à chaque job du worker (jamais figé au 1er delegate)", () => {
    const b = banc();
    const config = configDe(b, "grolaf");
    const port = portDe(b, "grolaf", config, { nom: "Grolaf", role: "heavy" });

    expect(port.lire()).toContain(PROMPTS.heavy);
    config.update({ "prompts.heavy": "NOUVEAU CADRE LOURD." }, { portee: "bot" });
    expect(port.lire()).toContain("NOUVEAU CADRE LOURD.");
  });

  it("garde de CÂBLAGE : le worker lourd relit une FONCTION de prompt à chaque job", () => {
    // `main()` n'est jamais exécuté par les tests : le câblage n'est couvert que
    // par cette garde statique et par `tsc`.
    const worker = readFileSync(
      join(process.cwd(), "src", "pi", "sdk", "heavy-worker.ts"),
      "utf8",
    );
    expect(worker).toContain("systemPrompt: string | (() => string);");
    expect(worker).toContain("liveValue(config.systemPrompt)");
    const index = readFileSync(join(process.cwd(), "src", "index.ts"), "utf8");
    expect(index).toContain("systemPrompt: () => {");
    expect(index).toContain('configBot.getString("prompts.heavy")');
  });
});

// ── ④ règles communes modifiées ⇒ tour suivant (chaîne réelle) ────────────

describe("④ règles communes modifiées ⇒ effectives au tour suivant", () => {
  it("le port des règles est relu à chaque tour, dans la chaîne des extensions", async () => {
    const b = banc();
    const config = configDe(b, "grolaf");
    const cheminRegles = join(b.state, "bots", "grolaf", "rules.md");
    ecrire(cheminRegles, "RÈGLE 1 : ne divulgue jamais un secret.");
    const port = portDe(b, "grolaf", config, { nom: "Grolaf" });

    const extensions = (): InlineExtension[] =>
      buildInlineExtensions({
        promptDuTour: port,
        rules: portReglesDuBot({ botId: "grolaf", cheminBot: cheminRegles }),
        logger,
      });

    const tour1 = await derouler(extensions(), "PROMPT INITIAL");
    expect(tour1).toContain("RÈGLE 1 : ne divulgue jamais un secret.");

    // L'utilisateur modifie les règles (page /config ou /bots).
    ecrire(cheminRegles, "RÈGLE 2 : cite toujours la source.");

    const tour2 = await derouler(extensions(), "PROMPT INITIAL");
    expect(tour2).toContain("RÈGLE 2 : cite toujours la source.");
    expect(tour2).not.toContain("RÈGLE 1");
  });
});

// ── ⑤ fichier illisible ⇒ dernière valeur connue ─────────────────────────

describe("⑤ lecture impossible ⇒ DERNIÈRE valeur connue, jamais un prompt vide", () => {
  it("une source qui LÈVE rend le dernier prompt et le journal le dit", () => {
    const b = banc();
    const { messages, logger: journal } = journalFactice();
    let casse = false;
    const port = portDe(b, "grolaf", undefined, {
      nom: "Grolaf",
      logger: journal,
      personnalite: () => {
        if (casse) throw new Error("disque illisible");
        return "PERSONNALITÉ CONNUE.";
      },
    });

    const avant = port.lire();
    expect(avant).toContain("PERSONNALITÉ CONNUE.");
    expect(port.derniereLue()).toBe(avant);

    casse = true;
    const apres = port.lire();
    // ⚠️ Jamais un prompt vide, jamais d'exception : la dernière valeur connue.
    expect(apres).toBe(avant);
    expect(apres.trim().length).toBeGreaterThan(0);
    expect(messages).toContain("prompt.du_tour.relecture_echec");
  });

  it("un overlay ILLISIBLE ne fait pas perdre la valeur précédente", () => {
    const b = banc();
    const config = configDe(b, "grolaf");
    const port = portDe(b, "grolaf", config, { nom: "Grolaf" });
    config.update({ "prompts.personnalite": TEXTE_GROLAF }, { portee: "bot" });
    const avant = port.lire();
    expect(avant).toContain(TEXTE_GROLAF);

    // Le fichier d'overlay devient illisible (JSON tronqué) : `reload()` conserve
    // l'état en mémoire et le SIGNALE, il n'efface rien.
    writeFileSync(config.overlayPath, "{ pas du tout du JSON", "utf8");
    const apres = port.lire();
    expect(apres).toBe(avant);
    expect(apres.trim().length).toBeGreaterThan(0);
  });

  it("sans AUCUNE valeur connue, le port rend le prompt initial du host (jamais vide)", () => {
    const b = banc();
    const port = portDe(b, "grolaf", undefined, {
      nom: "Grolaf",
      valeurInitiale: "PROMPT INITIAL DU HOST",
      personnalite: () => {
        throw new Error("illisible dès le premier tour");
      },
    });
    expect(port.lire()).toBe("PROMPT INITIAL DU HOST");
  });

  it("le prompt du host reste utilisé si le port n'a rien à poser (aucun prompt vide)", async () => {
    const extension = createPromptDuTourExtensionFactory({
      lire: () => "",
      derniereLue: () => undefined,
    });
    expect(await handlerDe(extension)({ prompt: "x", systemPrompt: "BASE" })).toBeUndefined();
  });
});

// ── ⑥ l'ORDRE des blocs est inchangé (<regles> en dernier) ────────────────

describe("⑥ ordre des blocs inchangé, `<regles>` EN DERNIER", () => {
  it("identité → personnalité → consignes/faits → prompt → outils → règles", async () => {
    const b = banc();
    const config = configDe(b, "grolaf");
    config.update({ "prompts.personnalite": TEXTE_GROLAF }, { portee: "bot" });
    config.update({ "prompts.light": "PROMPT LÉGER DU TOUR." }, { portee: "bot" });
    const port = portDe(b, "grolaf", config, { nom: "Grolaf" });
    const consignes = portConsignes({ botId: "grolaf", chemin: join(b.state, "bots", "grolaf", "consignes.md") });
    consignes.ajouter("consigne", "Ne refais plus jamais ça.");
    consignes.ajouter("fait", "Mon NAS est à 10.0.0.5.");
    const cheminRegles = join(b.state, "bots", "grolaf", "rules.md");
    ecrire(cheminRegles, "Règles communes de l'instance.");

    const extensions = buildInlineExtensions({
      promptDuTour: port,
      consignes,
      rules: portReglesDuBot({ botId: "grolaf", cheminBot: cheminRegles }),
      logger,
    });
    const noms = extensions.map((extension) => (extension as { name: string }).name);
    // ⚠️ Le prompt du tour passe EN PREMIER : il POSE la base que les autres
    // complètent (consignes insérées, règles concaténées).
    expect(noms).toEqual([PROMPT_DU_TOUR_EXTENSION_NAME, "yuki-consignes", RULES_EXTENSION_NAME]);

    const prompt = await derouler(extensions, "PROMPT INITIAL DU HOST");
    const positions = [
      `<${IDENTITY_TAG}>`,
      `<${PERSONALITY_TAG}>`,
      "<consignes>",
      "<faits>",
      "PROMPT LÉGER DU TOUR.",
      `<${TOOLS_TAG}>`,
      "<regles>",
    ].map((bloc) => prompt.indexOf(bloc));
    for (const [index, position] of positions.entries()) {
      expect(position, `bloc ${index} absent`).toBeGreaterThan(-1);
    }
    for (let index = 1; index < positions.length; index += 1) {
      expect(positions[index], `bloc ${index} hors ordre`).toBeGreaterThan(
        positions[index - 1] as number,
      );
    }
    // ⚠️ Les règles FERMENT le prompt : elles priment sur tout le reste.
    expect(prompt.trimEnd().endsWith("</regles>")).toBe(true);
  });
});

// ── ⑦ bot sans personnalité : DÉFAUT, jamais le texte d'un autre bot ──────

describe("⑦ bot sans personnalité ⇒ défaut GÉNÉRIQUE, jamais un autre bot", () => {
  it("le prompt d'un bot sans personnalité ne contient pas celle d'un autre", () => {
    const b = banc();
    const configs = b.configs(["yuki", "grolaf"], "yuki");
    const configYuki = configs.get("yuki") as ConfigRuntime;
    const configGrolaf = configs.get("grolaf") as ConfigRuntime;
    // Yuki a SA personnalité ; grolaf n'en a AUCUNE (ni champ, ni fichier).
    configYuki.update({ "prompts.personnalite": "Je suis Yuki, et ceci n'est pas pour grolaf." }, { portee: "bot" });

    const promptGrolaf = portDe(b, "grolaf", configGrolaf, { nom: "Grolaf" }).lire();
    expect(promptGrolaf).toContain(PROMPTS.personnalite);
    expect(promptGrolaf).not.toContain("ceci n'est pas pour grolaf");
    expect(promptGrolaf).toContain("Ton nom est Grolaf.");

    // Et le bot qui a la sienne la garde.
    expect(portDe(b, "yuki", configYuki, { nom: "Yuki" }).lire()).toContain(
      "Je suis Yuki, et ceci n'est pas pour grolaf.",
    );
  });

  it("une personnalité qui CITE un autre bot est SIGNALÉE (avertissement, pas blocage)", () => {
    const b = banc();
    const { messages, logger: journal } = journalFactice();
    const config = configDe(b, "grolaf");
    config.update(
      { "prompts.personnalite": "Tu es Grolaf ; en cas de doute, demande à Yuki." },
      { portee: "bot" },
    );

    const prompt = portDe(b, "grolaf", config, {
      nom: "Grolaf",
      autresBots: ["Yuki", "Kohai"],
      logger: journal,
    }).lire();

    expect(prompt).toContain("demande à Yuki");
    expect(messages).toContain("personnalite.nom_autre_bot");
  });

  it("n'avertit PAS quand le nom cité est celui du bot lui-même", () => {
    const b = banc();
    const { messages, logger: journal } = journalFactice();
    const config = configDe(b, "grolaf");
    config.update({ "prompts.personnalite": "Tu es Grolaf, et tu restes Grolaf." }, { portee: "bot" });

    portDe(b, "grolaf", config, {
      nom: "Grolaf",
      autresBots: ["Grolaf", "Yuki"],
      logger: journal,
    }).lire();

    expect(messages).not.toContain("personnalite.nom_autre_bot");
  });
});
