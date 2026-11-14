/**
 * INJECTION DES CONSIGNES — blocs `<consignes>` / `<faits>` dans le prompt.
 *
 * Ce que ce fichier VERROUILLE :
 *  ① listes VIDES ⇒ AUCUN bloc (jamais un bloc vide dans le prompt) ;
 *  ② position : APRÈS `</personnalite>` et AVANT le prompt système ;
 *  ③ `<regles>` reste EN DERNIER, dans la chaîne réelle des extensions ;
 *  ④ plafond global de 8 000 caractères : la troncature est DITE dans le prompt
 *    (jamais silencieuse) ;
 *  ⑤ une consigne enregistrée est injectée AU TOUR SUIVANT (le test central) ;
 *  ⑥ fichier absent ⇒ aucune injection, aucune erreur.
 *
 * ⚠️ ÉCHOUE SUR LE CODE D'ORIGINE : `src/consignes/**` n'existe pas.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

import {
  MAX_INJECTION_CHARS,
  blocsConsignes,
  insererConsignes,
  portConsignes,
} from "../../src/consignes/index.js";
import { composerPromptSysteme } from "../../src/llm/prompt-systeme.js";
import { createConsignesExtensionFactory } from "../../src/pi/sdk/consignes-extension.js";
import { createConsignesTools } from "../../src/pi/sdk/consignes-tools.js";
import { RULES_EXTENSION_NAME } from "../../src/pi/sdk/rules-extension.js";
import { buildInlineExtensions } from "../../src/pi/sdk-host.js";

const racines: string[] = [];

function cheminTemporaire(): string {
  const racine = mkdtempSync(join(tmpdir(), "yuki-consignes-injection-"));
  racines.push(racine);
  return join(racine, "bots", "yuki", "consignes.md");
}

afterEach(() => {
  for (const dir of racines.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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

const logger = { debug() {}, info() {}, warn() {}, error() {} };

const PROMPT_COMPOSE = composerPromptSysteme({
  nom: "Yuki",
  personnalite: "Tu es Yuki, calme et précise.",
  prompt: "PROMPT SYSTÈME LÉGER",
  outils: ["read", "memoriser_consigne"],
});

describe("① listes vides ⇒ aucun bloc", () => {
  it("un document vide ne produit AUCUN texte", () => {
    expect(blocsConsignes({ consignes: [], faits: [] })).toBe("");
    expect(insererConsignes(PROMPT_COMPOSE, "")).toBe(PROMPT_COMPOSE);
  });

  it("l'extension ne rend RIEN quand le fichier est absent (pas d'erreur)", async () => {
    const port = portConsignes({ botId: "yuki", chemin: cheminTemporaire() });
    const extension = createConsignesExtensionFactory(port);
    expect(await handlerDe(extension)({ prompt: "x", systemPrompt: PROMPT_COMPOSE })).toBeUndefined();
  });
});

describe("② position : après la personnalité, avant le prompt système", () => {
  it("insère `</personnalite>` → blocs → prompt système", () => {
    const blocs = blocsConsignes({
      consignes: ["Ne refais plus jamais ça."],
      faits: ["Mon NAS est à 10.0.0.5."],
    });
    const prompt = insererConsignes(PROMPT_COMPOSE, blocs);
    const finPersonnalite = prompt.indexOf("</personnalite>");
    const debutConsignes = prompt.indexOf("<consignes>");
    const debutFaits = prompt.indexOf("<faits>");
    const promptSysteme = prompt.indexOf("PROMPT SYSTÈME LÉGER");
    expect(finPersonnalite).toBeGreaterThan(-1);
    expect(debutConsignes).toBeGreaterThan(finPersonnalite);
    expect(debutFaits).toBeGreaterThan(debutConsignes);
    expect(promptSysteme).toBeGreaterThan(debutFaits);
  });

  it("sans personnalité composée, insère après l'identité (toujours avant le prompt)", () => {
    const prompt = composerPromptSysteme({ nom: "Yuki", prompt: "PROMPT SYSTÈME LÉGER" });
    const resultat = insererConsignes(prompt, blocsConsignes({ consignes: ["sois bref"], faits: [] }));
    expect(resultat.indexOf("</identite>")).toBeLessThan(resultat.indexOf("<consignes>"));
    expect(resultat.indexOf("<consignes>")).toBeLessThan(resultat.indexOf("PROMPT SYSTÈME LÉGER"));
  });
});

describe("③ `<regles>` reste EN DERNIER (chaîne réelle des extensions)", () => {
  it("l'ordre est consignes → règles, et le bloc `<regles>` ferme le prompt", async () => {
    const port = portConsignes({ botId: "yuki", chemin: cheminTemporaire() });
    port.ajouter("consigne", "Ne refais plus jamais ça.");
    const extensions = buildInlineExtensions({
      consignes: port,
      rules: {
        read: () => ({ text: "Règles communes.", chars: 16, truncated: false, exists: true }),
      },
      logger,
    } as never);
    const noms = extensions.map((extension) => (extension as { name: string }).name);
    expect(noms).toContain("yuki-consignes");
    expect(noms).toContain(RULES_EXTENSION_NAME);
    expect(noms.indexOf("yuki-consignes")).toBeLessThan(noms.indexOf(RULES_EXTENSION_NAME));

    const prompt = await derouler(extensions, PROMPT_COMPOSE);
    expect(prompt.indexOf("<consignes>")).toBeGreaterThan(prompt.indexOf("</personnalite>"));
    expect(prompt.indexOf("<consignes>")).toBeLessThan(prompt.indexOf("PROMPT SYSTÈME LÉGER"));
    // ⚠️ Les règles sont APRÈS tout le reste : elles priment.
    expect(prompt.lastIndexOf("<regles>")).toBeGreaterThan(prompt.indexOf("<outils>"));
    expect(prompt.endsWith("</regles>")).toBe(true);
  });
});

describe("④ plafond global : la troncature est DITE dans le prompt", () => {
  it(`au-delà de ${MAX_INJECTION_CHARS} caractères, la mention de troncature apparaît`, () => {
    const consignes = Array.from({ length: 40 }, (_, index) =>
      `consigne ${index} : ${"détail ".repeat(30)}`,
    );
    const blocs = blocsConsignes({ consignes, faits: [] });
    expect(Array.from(blocs).length).toBeLessThanOrEqual(MAX_INJECTION_CHARS);
    expect(blocs).toContain("non injectée(s)");
    expect(blocs).toContain(`${MAX_INJECTION_CHARS}`);
    // Ce qui reste est bien le DÉBUT de la liste (les plus anciennes restent).
    expect(blocs).toContain("consigne 0 ");
    expect(blocs).not.toContain("consigne 39 ");
  });

  it("sous le plafond, aucune mention parasite", () => {
    const blocs = blocsConsignes({ consignes: ["sois bref"], faits: ["j'habite à Lyon"] });
    expect(blocs).not.toContain("non injectée(s)");
  });
});

describe("⑤ le test CENTRAL : consigne enregistrée ⇒ injectée AU TOUR SUIVANT", () => {
  it("le bot enregistre par l'outil, l'extension suivante la voit", async () => {
    const chemin = cheminTemporaire();
    const port = portConsignes({ botId: "yuki", chemin });
    const extension = createConsignesExtensionFactory(port);
    const outils = createConsignesTools(port);
    const memoriser = outils.find((outil) => outil.name === "memoriser_consigne");
    if (!memoriser) throw new Error("outil memoriser_consigne absent");

    // Tour 1 : aucune consigne ⇒ aucun bloc.
    expect(await handlerDe(extension)({ prompt: "x", systemPrompt: PROMPT_COMPOSE })).toBeUndefined();

    // Le bot enregistre la consigne (écriture DIRECTE, décision utilisateur).
    const fn = memoriser.execute as unknown as (
      id: string,
      params: unknown,
      signal: undefined,
      onUpdate: undefined,
      ctx: unknown,
    ) => Promise<{ content: Array<{ text?: string }> }>;
    const resultat = await fn("c1", { texte: "Ne refais plus jamais ça." }, undefined, undefined, {});
    expect(resultat.content.map((part) => part.text).join("\n")).toContain("sera injectée");

    // Tour 2 : la consigne est là, sans redémarrage.
    const suivant = (await handlerDe(extension)({
      prompt: "x",
      systemPrompt: PROMPT_COMPOSE,
    })) as { systemPrompt: string };
    expect(suivant.systemPrompt).toContain("<consignes>");
    expect(suivant.systemPrompt).toContain("Ne refais plus jamais ça.");
  });

  it("un FAIT est injecté systématiquement (toujours, pas seulement s'il est pertinent)", () => {
    const chemin = cheminTemporaire();
    const port = portConsignes({ botId: "yuki", chemin });
    port.ajouter("fait", "Mon NAS est à 10.0.0.5.");
    const blocs = blocsConsignes(port.lire());
    expect(blocs).toContain("<faits>");
    expect(blocs).toContain("Mon NAS est à 10.0.0.5.");
    // ⚠️ Ce n'est pas la mémoire : le bloc ne dit jamais « souvenir pertinent ».
    expect(blocs).toContain("Ce ne sont pas des souvenirs de la mémoire.");
  });
});
