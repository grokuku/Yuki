/**
 * UNE SEULE PERSONNALITÉ — `prompts.personnalite` (décision utilisateur du
 * 2026-11-14 : « évidemment qu'il ne faut qu'UNE personnalité »).
 *
 * ⚠️ CE QUI ÉTAIT FAUX : deux textes d'identité entraient dans le prompt du tour —
 * la clé `prompts.personnalite` (composée par `composerPromptSysteme`) ET le
 * fichier `personality.md`, CONCATÉNÉ À LA FIN du `systemPrompt` par l'extension
 * de personnalité. Le fichier passait donc en dernier : il GAGNAIT.
 *
 * ⚠️ CE QUI EST VERROUILLÉ ICI (ces tests ÉCHOUENT sur le code d'origine) :
 *  ① le prompt composé ne contient la personnalité qu'UNE fois, même quand le
 *    fichier et la clé portent le MÊME texte ;
 *  ② `personality.md` n'est plus concaténé à la fin de `systemPrompt` ;
 *  ③ fichier rempli + aucune personnalité enregistrée ⇒ le texte du FICHIER est
 *    repris (rien n'est perdu) et le journal le dit ;
 *  ④ personnalité enregistrée ⇒ c'est ELLE, le fichier ne s'ajoute pas (et le
 *    journal dit que le fichier est ignoré) ;
 *  ⑤ `rules.md` reste PRIORITAIRE : son bloc vient après la personnalité et son
 *    en-tête DÉCLARE la primauté ;
 *  ⑥ un bot neuf (fichier vide, aucune surcharge) a une personnalité NON VIDE.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { portsHostBot, type ContexteHostBot } from "../../src/bots/hosts.js";
import type { OutilsBot } from "../../src/bots/outils.js";
import { resoudrePersonnaliteBot } from "../../src/bots/personnalite-bot.js";
import { creerConfigsBots } from "../../src/config/bots.js";
import { loadEnv, type Env } from "../../src/config/env.js";
import type { ConfigRuntime } from "../../src/config/runtime.js";
import { composerPromptSysteme } from "../../src/llm/prompt-systeme.js";
import { PersonalityStore } from "../../src/personality/store.js";
import { personnaliteEffective } from "../../src/personality/personality.js";
import { RulesStore } from "../../src/rules/store.js";
import { buildInlineExtensions } from "../../src/pi/sdk-host.js";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

const racines: string[] = [];

afterEach(() => {
  for (const racine of racines.splice(0)) rmSync(racine, { recursive: true, force: true });
});

type Handler = (event: unknown, ctx?: unknown) => unknown;

interface LigneJournal {
  niveau: "debug" | "info" | "warn" | "error";
  message: string;
  champs: Record<string, unknown>;
}

function journalFactice(): {
  info(message: string, champs?: Record<string, unknown>): void;
  warn(message: string, champs?: Record<string, unknown>): void;
  lignes: LigneJournal[];
} {
  const lignes: LigneJournal[] = [];
  const pousser =
    (niveau: LigneJournal["niveau"]) =>
    (message: string, champs: Record<string, unknown> = {}): void => {
      lignes.push({ niveau, message, champs });
    };
  return { lignes, info: pousser("info"), warn: pousser("warn") };
}

interface Banc {
  state: string;
  env: Env;
  processEnv: NodeJS.ProcessEnv;
}

function banc(): Banc {
  const racine = mkdtempSync(join(tmpdir(), "yuki-personnalite-unique-"));
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

/** Prompts livrés fixés : le banc ne dépend pas du contenu de `config/pi/`. */
const PROMPTS = {
  light: "Cadre d'exécution.",
  heavy: "Cadre lourd.",
  personnalite: "Personnalité LIVRÉE (défaut).",
};

function configDe(b: Banc, botId: string): ConfigRuntime {
  const configs = creerConfigsBots({
    env: b.env,
    bots: [botId],
    pile: botId,
    promptDefaults: PROMPTS,
    processEnv: b.processEnv,
  });
  const config = configs.get(botId);
  if (config === undefined) throw new Error(`configuration absente pour ${botId}`);
  return config;
}

/** Écrit `personality.md` (le fichier d'amorçage) sur le disque du bot. */
function storePersonnalite(b: Banc, texte: string): PersonalityStore {
  const store = new PersonalityStore({
    path: join(b.state, "personality.md"),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  if (texte !== "") store.write(texte, "user");
  return store;
}

/** Contexte de host minimal : les ports du fichier + de la configuration. */
function contexteDe(
  b: Banc,
  config: ConfigRuntime,
  personnalite: PersonalityStore,
): ContexteHostBot {
  const outils = {
    botId: "yuki",
    env: b.env,
    chemins: { personalityPath: personnalite.filePath },
    personnalite,
    regles: new RulesStore({ path: join(b.state, "rules.md") }),
  } as unknown as OutilsBot;
  return {
    botId: "yuki",
    env: b.env,
    config,
    outils,
    nom: "Yuki",
    outilsAutorises: ["read"],
  };
}

/**
 * Le prompt COMPLET d'un tour, assemblé comme le `PiHost` : le `systemPrompt` des
 * ports, puis la CHAÎNE des extensions (chacune concatène son bloc).
 *
 * ⚠️ Sur le code d'origine, `PortsHostBot` porte `personality` : l'extension de
 * personnalité est donc enregistrée et le fichier est concaténé EN DERNIER — le
 * test le voit.
 */
async function promptComplet(
  contexte: ContexteHostBot,
  journal?: ReturnType<typeof journalFactice>,
): Promise<string> {
  const ports = portsHostBot(contexte, journal as never);
  if (ports === undefined) throw new Error("ports absents : pas de prompt à vérifier");
  const options = { ...ports } as unknown as Parameters<typeof buildInlineExtensions>[0];
  let courant = ports.systemPrompt;
  for (const extension of buildInlineExtensions(options)) {
    for (const handler of handlersOf(extension)) {
      const result = (await handler({ prompt: "Bonjour", systemPrompt: courant })) as
        | { systemPrompt?: string }
        | undefined;
      if (result?.systemPrompt !== undefined) courant = result.systemPrompt;
    }
  }
  return courant;
}

function handlersOf(extension: InlineExtension): Handler[] {
  const handlers: Handler[] = [];
  const run = typeof extension === "function" ? extension : extension.factory;
  (run as (pi: unknown) => void)({
    on: (name: string, handler: Handler) => {
      if (name === "before_agent_start") handlers.push(handler);
    },
  });
  return handlers;
}

/** Occurrences d'un texte (comptage exact, pas un `includes`). */
function occurrences(texte: string, motif: string): number {
  if (motif === "") return 0;
  return texte.split(motif).length - 1;
}

// ── 0. La résolution PURE, sans plomberie ─────────────────────────────────

describe("résolution sans concaténation (personnaliteEffective)", () => {
  // ⚠️ GARDE RÉVISÉE (2026-11-14) : la résolution rend désormais aussi la
  // PROVENANCE fine (`bot` / `fichier-bot` / `fichier-instance` / `defaut` /
  // `aucune`) — c'est elle que l'interface affiche. Les valeurs attendues sont
  // donc PLUS PRÉCISES, jamais moins.
  it("champ RENSEIGNÉ ⇒ c'est lui, même quand le fichier porte un autre texte", () => {
    expect(
      personnaliteEffective({ champ: "Texte du champ.", champRenseigne: true, fichier: "Texte du fichier." }),
    ).toEqual({ texte: "Texte du champ.", origine: "champ", provenance: "bot" });
  });

  it("champ NON renseigné + fichier rempli ⇒ le FICHIER est repris (pas de perte)", () => {
    expect(
      personnaliteEffective({
        champ: "Personnalité LIVRÉE (défaut).",
        champRenseigne: false,
        fichier: "Texte du fichier.",
      }),
    ).toEqual({ texte: "Texte du fichier.", origine: "fichier", provenance: "fichier-bot" });
  });

  it("champ non renseigné + fichier vide ⇒ le défaut LIVRÉ (bot neuf non vide)", () => {
    expect(
      personnaliteEffective({ champ: "Personnalité LIVRÉE.", champRenseigne: false, fichier: "" }),
    ).toEqual({ texte: "Personnalité LIVRÉE.", origine: "champ", provenance: "defaut" });
  });

  it("ni champ ni fichier ⇒ aucune personnalité (aucun bloc vide)", () => {
    expect(personnaliteEffective({ champ: "", champRenseigne: true, fichier: "  " })).toEqual({
      texte: "",
      origine: "aucune",
      provenance: "aucune",
    });
  });
});

// ── ①②③④⑥. Le prompt RÉEL d'un bot ──────────────────────────────────────

describe("② `personality.md` n'est plus concaténé à la fin du prompt", () => {
  it("le texte du fichier n'apparaît pas quand une personnalité est enregistrée", async () => {
    const b = banc();
    const config = configDe(b, "yuki");
    config.update({ "prompts.personnalite": "Personnalité du CHAMP." }, { portee: "bot" });
    const store = storePersonnalite(b, "SENTINELLE-FICHIER-42");

    const prompt = await promptComplet(contexteDe(b, config, store));

    expect(prompt).not.toContain("SENTINELLE-FICHIER-42");
    expect(prompt).toContain("Personnalité du CHAMP.");
  });
});

describe("① la personnalité n'apparaît qu'UNE fois dans le prompt composé", () => {
  it("même texte dans le fichier ET dans la clé ⇒ une seule occurrence", async () => {
    const b = banc();
    const config = configDe(b, "yuki");
    config.update({ "prompts.personnalite": "Je suis Yuki, calme et précise." }, { portee: "bot" });
    const store = storePersonnalite(b, "Je suis Yuki, calme et précise.");

    const prompt = await promptComplet(contexteDe(b, config, store));

    expect(occurrences(prompt, "Je suis Yuki, calme et précise.")).toBe(1);
    expect(occurrences(prompt, "<personnalite>")).toBe(1);
    expect(occurrences(prompt, "</personnalite>")).toBe(1);
  });
});

describe("③ fichier rempli + personnalité non renseignée ⇒ reprise, pas perte", () => {
  it("le texte du fichier devient la personnalité du bot, et le journal le DIT", async () => {
    const b = banc();
    const config = configDe(b, "yuki");
    const store = storePersonnalite(b, "Je suis Yuki, gardienne de la maison.");
    const journal = journalFactice();

    const prompt = await promptComplet(contexteDe(b, config, store), journal);

    expect(prompt).toContain("<personnalite>");
    expect(prompt).toContain("Je suis Yuki, gardienne de la maison.");
    // Le défaut LIVRÉ n'est pas retenu : le fichier est plus spécifique.
    expect(prompt).not.toContain("Personnalité LIVRÉE (défaut).");
    expect(occurrences(prompt, "Je suis Yuki, gardienne de la maison.")).toBe(1);
    expect(journal.lignes.map((ligne) => ligne.message)).toContain(
      "personality.amorcee_depuis_fichier",
    );
  });
});

describe("④ personnalité enregistrée ⇒ c'est elle (le fichier ne s'ajoute pas)", () => {
  it("le journal signale le fichier IGNORÉ, avec l'action pour le récupérer", async () => {
    const b = banc();
    const config = configDe(b, "yuki");
    config.update({ "prompts.personnalite": "Texte du champ." }, { portee: "bot" });
    const store = storePersonnalite(b, "Texte du fichier.");
    const journal = journalFactice();

    const prompt = await promptComplet(contexteDe(b, config, store), journal);

    expect(prompt).toContain("Texte du champ.");
    expect(prompt).not.toContain("Texte du fichier.");
    const ligne = journal.lignes.find((l) => l.message === "personality.fichier_ignore");
    expect(ligne?.niveau).toBe("warn");
    expect(String(ligne?.champs.action)).toContain("Personnalité");
  });

  it("la garde d'antan `personality.deux_sources` n'existe plus (une seule source)", () => {
    const source = readFileSync(join(process.cwd(), "src", "index.ts"), "utf8");
    expect(source).not.toContain("personality.deux_sources");
  });
});

describe("⑤ `rules.md` reste prioritaire (règles dures, pas une personnalité)", () => {
  it("le bloc `<regles>` est présent, APRÈS la personnalité, et déclare sa primauté", async () => {
    const b = banc();
    const config = configDe(b, "yuki");
    config.update({ "prompts.personnalite": "Personnalité du CHAMP." }, { portee: "bot" });
    const store = storePersonnalite(b, "");
    const contexte = contexteDe(b, config, store);
    // Les règles sont un fichier À PART : elles ne sont pas une personnalité.
    (contexte.outils as OutilsBot).regles.write("Ne jamais divulguer un secret.", "user");

    const prompt = await promptComplet(contexte);

    const indexPersonnalite = prompt.indexOf("<personnalite>");
    const indexRegles = prompt.indexOf("<regles>");
    expect(indexPersonnalite).toBeGreaterThan(-1);
    expect(indexRegles).toBeGreaterThan(-1);
    expect(indexRegles).toBeGreaterThan(indexPersonnalite);
    expect(prompt).toContain("Ne jamais divulguer un secret.");
    expect(prompt).toContain("PRIMENT sur votre personnalité");
    // Une règle n'est jamais rangée dans le bloc de personnalité.
    expect(prompt.slice(indexPersonnalite, indexRegles)).not.toContain("Ne jamais divulguer");
  });
});

describe("⑥ un bot neuf a une personnalité NON VIDE", () => {
  it("fichier vide, aucune surcharge ⇒ le défaut livré est composé", async () => {
    const b = banc();
    const config = configDe(b, "yuki");
    const store = storePersonnalite(b, "");

    const contexte = contexteDe(b, config, store);
    const resolution = resoudrePersonnaliteBot({
      botId: "yuki",
      config,
      store,
      cheminFichier: store.filePath,
    });
    expect(resolution.origine).toBe("champ");
    expect(resolution.texte.trim()).not.toBe("");

    const prompt = await promptComplet(contexte);
    expect(prompt).toContain("<personnalite>");
    expect(prompt).toContain("Personnalité LIVRÉE (défaut).");
    // Composée par le point d'assemblage UNIQUE, pas par une extension.
    expect(prompt.startsWith(
      composerPromptSysteme({
        nom: "Yuki",
        personnalite: PROMPTS.personnalite,
        prompt: PROMPTS.light,
        outils: ["read"],
      }),
    )).toBe(true);
  });
});
