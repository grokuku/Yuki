/**
 * PERSONNALITÉ : le FICHIER HISTORIQUE de l'instance (`<state>/personality.md`)
 * est une source, pour TOUS les bots — et l'interface montre la valeur EFFECTIVE.
 *
 * ⚠️ RÉGRESSION DU 2026-11-14 (signalée par l'utilisateur) : « la personnalité de
 * Yuki (le texte custom) a disparu. Je ne vois plus que ça : [texte générique] ».
 * Cause : `resoudrePersonnaliteBot` ne cherchait QUE
 * `<state>/bots/<id>/personality.md`. Sur une instance dont le texte custom vivait
 * dans `<state>/personality.md` (fichier d'INSTANCE, ancien emplacement mono-bot,
 * ou migration partielle / surcharge de déploiement), la résolution tombait sur le
 * DÉFAUT LIVRÉ (`config/pi/personnalite.md`) — donc la personnalité générique.
 *
 * ⚠️ CE QUI EST VERROUILLÉ ICI (ces tests ÉCHOUENT sur le code d'origine) :
 *  ① bot SANS fichier propre + fichier d'INSTANCE rempli ⇒ la personnalité
 *    effective est CELLE DU FICHIER (le cas de Yuki — le test central) ;
 *  ② champ `prompts.personnalite` RENSEIGNÉ ⇒ il gagne sur les deux fichiers ;
 *  ③ fichier DU BOT rempli ⇒ il gagne sur le fichier d'instance ;
 *  ④ AUCUN `botId` particulier n'est traité différemment (garde structurelle) ;
 *  ⑤ bot neuf, aucun fichier ⇒ défaut LIVRÉ, non vide (aucune régression) ;
 *  ⑥ l'interface reçoit et affiche la valeur EFFECTIVE + son ORIGINE.
 *
 * ⚠️ Aucune migration destructive : le fichier historique est LU, jamais déplacé
 * ni écrasé (les tests vérifient que son contenu est intact après résolution).
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { portsHostBot, type ContexteHostBot } from "../../src/bots/hosts.js";
import type { OutilsBot } from "../../src/bots/outils.js";
import {
  candidatsPersonnalite,
  resoudrePersonnaliteBot,
} from "../../src/bots/personnalite-bot.js";
import { creerConfigsBots } from "../../src/config/bots.js";
import { loadEnv, type Env } from "../../src/config/env.js";
import { createConfigRuntime, type ConfigRuntime } from "../../src/config/runtime.js";
import { ConfigStore } from "../../src/config/store.js";
import { handleConfigRequest } from "../../src/gateway/routes/config.js";
import { PersonalityStore } from "../../src/personality/store.js";
import { RulesStore } from "../../src/rules/store.js";
import { originLabel, provenanceNote } from "../../public/ui/config-patch.js";
import type { Logger } from "../../src/observability/logger.js";

const racines: string[] = [];

afterEach(() => {
  for (const racine of racines.splice(0)) rmSync(racine, { recursive: true, force: true });
});

/** Prompts livrés fixés : le banc ne dépend pas du contenu de `config/pi/`. */
const PROMPTS = {
  light: "Cadre d'exécution.",
  heavy: "Cadre lourd.",
  personnalite: "Personnalité LIVRÉE (défaut).",
};

/** Texte du fichier HISTORIQUE : celui qu'on ne doit plus perdre. */
const TEXTE_INSTANCE =
  "Je suis Yuki.\n\nSois l'assistante avec qui tu aurais envie de parler. Concise quand il faut.";
/** Texte du fichier DU BOT : plus spécifique. */
const TEXTE_BOT = "Je suis Yuki, et ceci est le texte de MON fichier de bot.";
/** Texte enregistré dans la configuration : le plus prioritaire. */
const TEXTE_CHAMP = "Texte ENREGISTRÉ par l'utilisateur pour ce bot.";

interface Banc {
  racine: string;
  state: string;
  env: Env;
  processEnv: NodeJS.ProcessEnv;
  configs: (botIds: readonly string[], pile: string) => Map<string, ConfigRuntime>;
}

function banc(): Banc {
  const racine = mkdtempSync(join(tmpdir(), "yuki-personnalite-instance-"));
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

/** Chemin du fichier HISTORIQUE d'instance (`<state>/personality.md`). */
function cheminInstance(b: Banc): string {
  return join(b.state, "personality.md");
}

/** Chemin du fichier DU BOT (`<state>/bots/<id>/personality.md`). */
function cheminBot(b: Banc, botId: string): string {
  return join(b.state, "bots", botId, "personality.md");
}

function ecrire(chemin: string, texte: string): void {
  mkdirSync(join(chemin, ".."), { recursive: true });
  writeFileSync(chemin, texte, "utf8");
}

/** Résolution EXACTE de la production : fichier du bot, puis fichier d'instance. */
function resoudre(
  b: Banc,
  botId: string,
  config: ConfigRuntime | undefined,
): ReturnType<typeof resoudrePersonnaliteBot> {
  return resoudrePersonnaliteBot({
    botId,
    config,
    fichiers: candidatsPersonnalite(
      { portee: "bot", chemin: cheminBot(b, botId) },
      { portee: "instance", chemin: cheminInstance(b) },
    ),
  });
}

/** Contexte de host minimal (fichier du bot + fichier d'instance, comme `main()`). */
function contexteDe(b: Banc, botId: string, config: ConfigRuntime): ContexteHostBot {
  const storeBot = new PersonalityStore({ path: cheminBot(b, botId) });
  const storeInstance = new PersonalityStore({ path: cheminInstance(b) });
  const outils = {
    botId,
    env: b.env,
    chemins: { personalityPath: storeBot.filePath },
    personnalite: storeBot,
    regles: new RulesStore({ path: join(b.state, "rules.md") }),
  } as unknown as OutilsBot;
  return {
    botId,
    nom: botId,
    env: b.env,
    config,
    outils,
    outilsAutorises: ["read"],
    personnaliteInstance: {
      portee: "instance",
      chemin: storeInstance.filePath,
      store: storeInstance,
    },
  };
}

function loggerFactice(): { messages: string[]; logger: Logger } {
  const messages: string[] = [];
  const pousser = (message: string): void => {
    messages.push(message);
  };
  return {
    messages,
    logger: {
      debug: pousser,
      info: pousser,
      warn: pousser,
      error: pousser,
    } as unknown as Logger,
  };
}

// ── ① LE CAS DE YUKI : pas de fichier de bot, fichier d'instance rempli ────

describe("① fichier HISTORIQUE d'instance rempli + aucun fichier de bot ⇒ c'est LUI", () => {
  it("la personnalité effective est celle du fichier d'instance (pas le défaut livré)", () => {
    const b = banc();
    const config = b.configs(["yuki"], "yuki").get("yuki");
    if (config === undefined) throw new Error("configuration absente");
    ecrire(cheminInstance(b), TEXTE_INSTANCE);

    const resolution = resoudre(b, "yuki", config);

    expect(resolution.texte).toBe(TEXTE_INSTANCE);
    expect(resolution.origine).toBe("fichier");
    expect(resolution.provenance).toBe("fichier-instance");
    expect(resolution.fichier).toBe(cheminInstance(b));
    expect(resolution.texte).not.toContain("Personnalité LIVRÉE");
  });

  it("le prompt du bot CONTIENT le texte du fichier d'instance, jamais le défaut", () => {
    const b = banc();
    const config = b.configs(["yuki"], "yuki").get("yuki");
    if (config === undefined) throw new Error("configuration absente");
    ecrire(cheminInstance(b), TEXTE_INSTANCE);

    const ports = portsHostBot(contexteDe(b, "yuki", config));
    if (ports === undefined) throw new Error("ports absents");

    expect(ports.systemPrompt).toContain("Sois l'assistante avec qui tu aurais envie de parler.");
    expect(ports.systemPrompt).not.toContain("Personnalité LIVRÉE (défaut).");
  });

  it("le journal DIT quel fichier a servi, et pour quel bot", () => {
    const b = banc();
    const config = b.configs(["kohai"], "kohai").get("kohai");
    if (config === undefined) throw new Error("configuration absente");
    ecrire(cheminInstance(b), TEXTE_INSTANCE);
    const { messages, logger } = loggerFactice();

    resoudrePersonnaliteBot({
      botId: "kohai",
      config,
      fichiers: candidatsPersonnalite(
        { portee: "bot", chemin: cheminBot(b, "kohai") },
        { portee: "instance", chemin: cheminInstance(b) },
      ),
      logger,
    });

    expect(messages).toContain("personality.amorcee_depuis_fichier");
  });

  it("aucune migration destructive : le fichier d'instance est INTACT après résolution", () => {
    const b = banc();
    ecrire(cheminInstance(b), TEXTE_INSTANCE);
    const config = b.configs(["yuki"], "yuki").get("yuki");

    resoudre(b, "yuki", config);

    expect(readFileSync(cheminInstance(b), "utf8")).toBe(TEXTE_INSTANCE);
  });
});

// ── ②③ L'ordre de priorité complet ─────────────────────────────────────────

describe("②③ ordre de priorité : champ > fichier du bot > fichier d'instance > défaut", () => {
  it("champ RENSEIGNÉ ⇒ il gagne sur les DEUX fichiers", () => {
    const b = banc();
    const config = b.configs(["yuki"], "yuki").get("yuki");
    if (config === undefined) throw new Error("configuration absente");
    config.update({ "prompts.personnalite": TEXTE_CHAMP }, { portee: "bot" });
    ecrire(cheminInstance(b), TEXTE_INSTANCE);
    ecrire(cheminBot(b, "yuki"), TEXTE_BOT);

    const resolution = resoudre(b, "yuki", config);

    expect(resolution.texte).toBe(TEXTE_CHAMP);
    expect(resolution.origine).toBe("champ");
    expect(resolution.provenance).toBe("bot");
  });

  it("fichier DU BOT rempli ⇒ il gagne sur le fichier d'instance", () => {
    const b = banc();
    const config = b.configs(["yuki"], "yuki").get("yuki");
    ecrire(cheminInstance(b), TEXTE_INSTANCE);
    ecrire(cheminBot(b, "yuki"), TEXTE_BOT);

    const resolution = resoudre(b, "yuki", config);

    expect(resolution.texte).toBe(TEXTE_BOT);
    expect(resolution.provenance).toBe("fichier-bot");
    expect(resolution.fichier).toBe(cheminBot(b, "yuki"));
  });

  it("fichier du bot VIDE (fichier présent mais blanc) ⇒ l'instance reprend la main", () => {
    const b = banc();
    const config = b.configs(["yuki"], "yuki").get("yuki");
    ecrire(cheminBot(b, "yuki"), "   \n\n");
    ecrire(cheminInstance(b), TEXTE_INSTANCE);

    const resolution = resoudre(b, "yuki", config);

    expect(resolution.texte).toBe(TEXTE_INSTANCE);
    expect(resolution.provenance).toBe("fichier-instance");
  });
});

// ── ④ AUCUN botId particulier ──────────────────────────────────────────────

describe("④ aucun `botId` particulier n'est traité différemment", () => {
  it("le fichier historique est trouvé pour TOUS les bots, par le même code", () => {
    const b = banc();
    const ids = ["yuki", "kohai", "un-bot-quelconque", "bot-42"];
    const configs = b.configs(ids, "yuki");
    ecrire(cheminInstance(b), TEXTE_INSTANCE);

    for (const botId of ids) {
      const resolution = resoudre(b, botId, configs.get(botId));
      expect(resolution.texte, `bot ${botId}`).toBe(TEXTE_INSTANCE);
      expect(resolution.provenance, `bot ${botId}`).toBe("fichier-instance");
    }
  });

  it("garde STRUCTURELLE : la résolution ne nomme aucun bot (ni `yuki`, ni un autre)", () => {
    const sources = [
      readFileSync(join(process.cwd(), "src", "bots", "personnalite-bot.ts"), "utf8"),
      readFileSync(join(process.cwd(), "src", "personality", "personality.ts"), "utf8"),
    ];
    for (const source of sources) {
      // Aucun `botId === "…"`, aucun identifiant de bot en dur dans la résolution.
      expect(source).not.toMatch(/botId\s*===\s*["']/);
      expect(source).not.toMatch(/["']yuki["']/);
    }
  });

  it("garde de CÂBLAGE : `main()` et les hosts passent le fichier d'instance", () => {
    const index = readFileSync(join(process.cwd(), "src", "index.ts"), "utf8");
    // Le bot de la PILE : les deux fichiers sont candidats.
    expect(index).toContain("portee: \"instance\", chemin: personalityStore.filePath");
    // Les bots SECONDAIRES : le contexte de host porte le fichier historique.
    expect(index).toContain("personnaliteInstance:");
    expect(index).toContain("personnaliteEffective:");
  });
});

// ── ⑤ bot neuf ─────────────────────────────────────────────────────────────

describe("⑤ bot neuf (aucun fichier, aucune valeur) ⇒ défaut LIVRÉ, non vide", () => {
  it("le texte composé est le défaut livré, marqué comme tel", () => {
    const b = banc();
    const config = b.configs(["nouveau"], "nouveau").get("nouveau");

    const resolution = resoudre(b, "nouveau", config);

    expect(resolution.texte).toBe(PROMPTS.personnalite);
    expect(resolution.provenance).toBe("defaut");
    expect(resolution.texte.trim()).not.toBe("");
  });
});

// ── ⑥ l'interface : valeur EFFECTIVE + ORIGINE ─────────────────────────────

describe("⑥ l'interface reçoit la valeur EFFECTIVE et son origine", () => {
  async function configApi(
    b: Banc,
    botId: string,
    config: ConfigRuntime,
  ): Promise<Record<string, unknown>> {
    const { logger } = loggerFactice();
    const runtime = createConfigRuntime({
      env: b.env,
      store: new ConfigStore(b.env.configStorePath),
      processEnv: b.processEnv,
      promptDefaults: PROMPTS,
      botId,
    });
    const reponse = await handleConfigRequest({
      method: "GET",
      path: `/api/bots/${botId}/config`,
      headers: { accept: "application/json" },
      body: "",
      deps: {
        runtime,
        logger,
        personnaliteEffective: (id: string) => {
          const resolution = resoudre(b, id, config);
          return {
            texte: resolution.texte,
            chars: Array.from(resolution.texte).length,
            provenance: resolution.provenance,
            chemin: resolution.fichier,
          };
        },
      },
    });
    return reponse.body as Record<string, unknown>;
  }

  it("le champ « Personnalité » d'un bot montre le texte EFFECTIF du fichier historique", async () => {
    const b = banc();
    const config = b.configs(["yuki"], "yuki").get("yuki");
    if (config === undefined) throw new Error("configuration absente");
    ecrire(cheminInstance(b), TEXTE_INSTANCE);

    const body = await configApi(b, "yuki", config);
    const fields = body.fields as Record<string, Record<string, unknown>>;
    const champ = fields["prompts.personnalite"];

    expect(champ?.value).toBe(TEXTE_INSTANCE);
    expect(champ?.provenance).toBe("fichier-instance");
    expect(champ?.fichier).toBe(cheminInstance(b));

    // Ce que l'UI affiche : la valeur effective, son origine et sa provenance.
    expect(originLabel(champ)).toBe("reprise du fichier historique");
    expect(provenanceNote(champ)).toContain("fichier HISTORIQUE");
    expect(provenanceNote(champ)).toContain("personnalité");
  });

  it("une valeur ENREGISTRÉE n'est jamais remplacée dans le champ", async () => {
    const b = banc();
    const config = b.configs(["yuki"], "yuki").get("yuki");
    if (config === undefined) throw new Error("configuration absente");
    config.update({ "prompts.personnalite": TEXTE_CHAMP }, { portee: "bot" });
    ecrire(cheminInstance(b), TEXTE_INSTANCE);

    const body = await configApi(b, "yuki", config);
    const fields = body.fields as Record<string, Record<string, unknown>>;
    const champ = fields["prompts.personnalite"];

    expect(champ?.value).toBe(TEXTE_CHAMP);
    expect(champ?.provenance).toBeUndefined();
    // L'origine affichée reste celle d'une VALEUR de l'utilisateur.
    expect(originLabel(champ)).toBe("personnalisé");
  });

  it("bot neuf : le champ n'est PAS vide (défaut livré) et son origine est dite", async () => {
    const b = banc();
    const config = b.configs(["nouveau"], "nouveau").get("nouveau");
    if (config === undefined) throw new Error("configuration absente");

    const body = await configApi(b, "nouveau", config);
    const fields = body.fields as Record<string, Record<string, unknown>>;
    const champ = fields["prompts.personnalite"];

    expect(String(champ?.value ?? "")).not.toBe("");
  });
});
