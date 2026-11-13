/**
 * COMPOSITION DU PROMPT SYSTÈME (2026-11-13) — les TROIS défauts signalés :
 *
 *  ① la PERSONNALITÉ n'était pas une entrée séparée : elle vivait dans le TEXTE
 *    de `prompts.light`, si bien qu'éditer le prompt pouvait effacer sans qu'on
 *    le voie les consignes d'outils ;
 *  ② la LISTE D'OUTILS était du texte FIGÉ : un bot déjà en place n'apprenait
 *    jamais qu'un outil avait été ajouté ou retiré ;
 *  ③ les prompts par défaut nommaient le bot EN DUR (« tu es Yuki ») : faux pour
 *    tout autre bot.
 *
 * ⚠️ ÉCHOUE SUR L'ORIGINE : `src/llm/prompt-systeme.ts` n'existe pas, la clé
 * `prompts.personnalite` non plus, et les prompts livrés contiennent encore
 * « Yuki » et une section d'outils figée.
 *
 * ⚠️ `main()` n'est jamais exécuté par les tests : le CÂBLAGE (host du bot de la
 * pile, worker lourd, hosts secondaires, route de config) n'est couvert que par
 * `tsc` et par les gardes STATIQUES de la fin de ce fichier.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { CONFIG_PATHS, CONFIG_SCHEMA } from "../../src/config/schema.js";
import { TOOL_POLICY, toolAllowlist } from "../../src/llm/tool-policy.js";
import {
  NOM_HISTORIQUE_EN_DUR,
  avertirSiPromptsASurveiller,
  promptNommeEnDur,
  type PromptWarnerLike,
} from "../../src/llm/prompts.js";
import {
  PHRASE_OUTIL_INCONNU,
  PHRASES_OUTILS,
  composerPromptSysteme,
  personnaliteDejaDansPrompt,
} from "../../src/llm/prompt-systeme.js";

const PERSONNALITE = "Tu parles comme un vieux sage, sans jargon.";
const PROMPT = "Cadre d'exécution : réponds court.";

describe("① `prompts.personnalite` est une clé de configuration `mixte`", () => {
  it("existe, de portée mixte, fusion par SURCHARGE (comme prompts.light/heavy)", () => {
    const descriptor = CONFIG_SCHEMA["prompts.personnalite"];
    expect(descriptor).toBeDefined();
    expect(descriptor?.scope).toBe("mixte");
    expect(descriptor?.mixteMerge).toBe("surcharge");
    expect(descriptor?.type).toBe("string");
    // Elle est COMPTÉE avec les autres clés (aucune clé fantôme).
    expect(CONFIG_PATHS).toContain("prompts.personnalite");
  });

  it("la personnalité par défaut est LIVRÉE dans un fichier (pas de texte en dur)", () => {
    const livre = readFileSync("config/pi/personnalite.md", "utf8");
    expect(livre.trim().length).toBeGreaterThan(0);
    // Récupérée depuis l'ancien prompt : le paragraphe d'identité n'est pas perdu.
    expect(livre).toContain("assistant conversationnel généraliste");
    // ⚠️ Et il ne nomme AUCUN bot : le nom est injecté à la composition.
    expect(livre).not.toContain(NOM_HISTORIQUE_EN_DUR);
  });
});

describe("② la liste d'outils est GÉNÉRÉE depuis l'allowlist réelle", () => {
  const outilsDe = (prompt: string): string[] =>
    prompt
      .slice(prompt.indexOf("<outils>"), prompt.indexOf("</outils>"))
      .split("\n")
      .filter((ligne) => ligne.startsWith("- `"))
      .map((ligne) => /- `([^`]+)`/u.exec(ligne)?.[1] ?? "");

  it("⚠️ éditer la PERSONNALITÉ ne change PAS la liste d'outils (le défaut signalé)", () => {
    const outils = ["read", "delegate"];
    const a = composerPromptSysteme({
      nom: "Kohai",
      personnalite: PERSONNALITE,
      prompt: PROMPT,
      outils,
    });
    const b = composerPromptSysteme({
      nom: "Kohai",
      personnalite: "Tu es brusque et direct.",
      prompt: PROMPT,
      outils,
    });
    expect(outilsDe(a)).toEqual(outils);
    expect(outilsDe(b)).toEqual(outils);
    // Et la personnalité, elle, a bien changé de bloc.
    expect(a).toContain(PERSONNALITE);
    expect(b).not.toContain(PERSONNALITE);
  });

  it("⚠️ deux allowlists ⇒ deux listes DIFFÉRENTES (ajout ET retrait suivis)", () => {
    const petit = composerPromptSysteme({ nom: "K", prompt: PROMPT, outils: ["read"] });
    const grand = composerPromptSysteme({
      nom: "K",
      prompt: PROMPT,
      outils: ["read", "delegate", "programmer_envoi"],
    });
    expect(outilsDe(petit)).toEqual(["read"]);
    expect(outilsDe(grand)).toEqual(["read", "delegate", "programmer_envoi"]);
    // Un outil RETIRÉ n'est plus annoncé…
    expect(grand).toContain("`delegate`");
    expect(petit).not.toContain("`delegate`");
    // … et un outil AJOUTÉ apparaît (même question, autre allowlist).
    expect(petit).not.toContain("`programmer_envoi`");
    expect(grand).toContain("`programmer_envoi`");
  });

  it("chaque outil annonce son NOM et sa PHRASE (jamais le nom seul)", () => {
    const prompt = composerPromptSysteme({ nom: "K", prompt: PROMPT, outils: ["read", "delegate"] });
    expect(prompt).toContain(`- \`read\` — ${PHRASES_OUTILS.read}`);
    expect(prompt).toContain(`- \`delegate\` — ${PHRASES_OUTILS.delegate}`);
    expect(String(PHRASES_OUTILS.read).length).toBeGreaterThan(10);
  });

  it("un outil AJOUTÉ au code sans phrase apparaît quand même (repli explicite)", () => {
    const prompt = composerPromptSysteme({
      nom: "K",
      prompt: PROMPT,
      outils: ["outil_tout_neuf"],
    });
    expect(prompt).toContain("`outil_tout_neuf`");
    expect(prompt).toContain(PHRASE_OUTIL_INCONNU);
  });

  it("aucun outil ouvert ⇒ le prompt le DIT franchement (jamais un bloc muet)", () => {
    const prompt = composerPromptSysteme({ nom: "K", prompt: PROMPT, outils: [] });
    expect(prompt).toContain("<outils>");
    expect(prompt).toContain("Aucun outil n'est ouvert pour ce bot");
    expect(outilsDe(prompt)).toEqual([]);
  });

  it("CHAQUE outil de la politique a une phrase (aucun outil muet en production)", () => {
    const noms = new Set<string>();
    for (const entree of Object.values(TOOL_POLICY)) {
      for (const liste of Object.values(entree)) {
        if (!Array.isArray(liste)) continue;
        for (const nom of liste as string[]) noms.add(nom);
      }
    }
    // Les allowlists RÉELLES (léger et lourd, tout activé) sont couvertes.
    for (const nom of toolAllowlist("heavy", {
      executionEnabled: true,
      screenshotsEnabled: true,
      fileTransferEnabled: true,
      fileListEnabled: true,
      fileReadEnabled: true,
      secretsEnabled: true,
      imagesEnabled: true,
    })) {
      noms.add(nom);
    }
    const sansPhrase = [...noms].filter((nom) => PHRASES_OUTILS[nom] === undefined);
    expect(sansPhrase).toEqual([]);
  });
});

describe("③ aucun nom de bot en dur : l'identité est INJECTÉE", () => {
  it("le nom injecté est celui du bot (un seul endroit le compose)", () => {
    const prompt = composerPromptSysteme({
      nom: "Kohai",
      personnalite: PERSONNALITE,
      prompt: PROMPT,
      outils: ["read"],
    });
    expect(prompt).toContain("Ton nom est Kohai.");
    expect(prompt).not.toContain(NOM_HISTORIQUE_EN_DUR);
    // Un nom vide n'invente rien : aucun bloc d'identité.
    expect(composerPromptSysteme({ nom: "  ", prompt: PROMPT })).toBe(PROMPT.trim());
  });

  it("les prompts par DÉFAUT ne contiennent plus le nom historique", () => {
    for (const fichier of [
      "config/pi/system-prompt.md",
      "config/pi/system-prompt-heavy.md",
      "config/pi/personnalite.md",
    ]) {
      expect(promptNommeEnDur(readFileSync(fichier, "utf8")), fichier).toBe(false);
    }
  });

  it("un prompt STOCKÉ qui nomme encore le bot est SIGNALÉ au démarrage", () => {
    const lignes: Array<{ message: string; champs: Record<string, unknown> }> = [];
    const logger: PromptWarnerLike = {
      warn: (message, champs = {}) => lignes.push({ message, champs }),
    };
    const signales = avertirSiPromptsASurveiller(
      logger,
      {
        personnalite: PERSONNALITE,
        light: "Tu es Yuki, et tu réponds court.",
        heavy: "Rapport factuel.",
      },
      { personnalite: "store", light: "store", heavy: "default" },
      "kohai",
    );
    expect(signales).toContain("prompts.light");
    const ligne = lignes.find((entree) => entree.message === "pi.prompt.nom_en_dur");
    expect(ligne).toBeDefined();
    expect(ligne?.champs.champ).toBe("prompts.light");
    expect(ligne?.champs.bot).toBe("kohai");
    // ⚠️ Rien n'est réécrit : le texte de l'utilisateur reste tel quel.
    expect(promptNommeEnDur("Tu es Yuki, et tu réponds court.")).toBe(true);
    // Une référence de SECRET légitime (majuscules) ne déclenche RIEN.
    expect(promptNommeEnDur("Écris ${YUKI_SECRET_NAS}.")).toBe(false);
  });
});

describe("④ personnalité et prompt système sont DEUX blocs séparés", () => {
  it("le prompt final contient la personnalité dans SON bloc, avant le prompt système", () => {
    const prompt = composerPromptSysteme({
      nom: "Kohai",
      personnalite: PERSONNALITE,
      prompt: PROMPT,
      outils: ["read"],
    });
    expect(prompt).toContain(`<personnalite>\n${PERSONNALITE}\n</personnalite>`);
    // L'ordre est : identité, personnalité, prompt système, outils.
    const idxIdentite = prompt.indexOf("Ton nom est Kohai.");
    const idxPersonnalite = prompt.indexOf("<personnalite>");
    const idxPrompt = prompt.indexOf(PROMPT);
    const idxOutils = prompt.indexOf("<outils>");
    expect(idxIdentite).toBeLessThan(idxPersonnalite);
    expect(idxPersonnalite).toBeLessThan(idxPrompt);
    expect(idxPrompt).toBeLessThan(idxOutils);
    // Le prompt système n'est PAS dans le bloc de personnalité.
    expect(prompt.indexOf("</personnalite>")).toBeLessThan(idxPrompt);
  });

  it("une personnalité vide n'ajoute AUCUN bloc (jamais un bloc vide)", () => {
    const prompt = composerPromptSysteme({ nom: "K", personnalite: "   ", prompt: PROMPT });
    expect(prompt).not.toContain("<personnalite>");
    expect(prompt).toContain(PROMPT);
  });

  it("⚠️ configuration d'AVANT : personnalité déjà dans le prompt ⇒ pas de doublon", () => {
    const ancien = `${PERSONNALITE}\n\nCadre d'exécution : réponds court.`;
    expect(personnaliteDejaDansPrompt(ancien, PERSONNALITE)).toBe(true);
    const prompt = composerPromptSysteme({
      nom: "Kohai",
      personnalite: PERSONNALITE,
      prompt: ancien,
      outils: ["read"],
    });
    // Le paragraphe n'apparaît qu'UNE fois (il est resté dans le prompt)…
    expect(prompt.split("vieux sage").length - 1).toBe(1);
    // … et le démarrage le DIT (aucun doublon silencieux).
    const lignes: Array<{ message: string; champs: Record<string, unknown> }> = [];
    avertirSiPromptsASurveiller(
      { warn: (message, champs = {}) => lignes.push({ message, champs }) },
      { personnalite: PERSONNALITE, light: ancien, heavy: "" },
      { personnalite: "default", light: "store", heavy: "default" },
    );
    const ligne = lignes.find((entree) => entree.message === "pi.prompt.personnalite_dupliquee");
    expect(ligne?.champs.champ).toBe("prompts.light");
  });
});

describe("⑤ le prompt système livré ne contient plus de liste d'outils FIGÉE", () => {
  it("le prompt léger renvoie au bloc généré au lieu d'énumérer les outils", () => {
    const livre = readFileSync("config/pi/system-prompt.md", "utf8");
    expect(livre).toContain("<outils>");
    expect(livre).not.toContain("`read`, `ls`, `grep`, `find`");
  });

  it("le prompt lourd non plus", () => {
    const livre = readFileSync("config/pi/system-prompt-heavy.md", "utf8");
    expect(livre).toContain("<outils>");
    expect(livre).not.toContain("`read`, `ls`, `grep`, `find`");
  });
});

describe("⑥ gardes STATIQUES du câblage (`main()` n'est jamais exécuté)", () => {
  const lire = (chemin: string): string =>
    readFileSync(new URL(`../../${chemin}`, import.meta.url), "utf8");

  it("le bot de la pile et les hosts secondaires passent par le MÊME assemblage", () => {
    expect(lire("src/index.ts")).toContain("composerPromptSysteme({");
    expect(lire("src/bots/hosts.ts")).toContain("composerPromptSysteme({");
    // Plus aucun prompt système construit sans personnalité ni outils.
    expect(lire("src/index.ts")).not.toContain(
      "systemPrompt: appendVoiceInstruction(promptLeger",
    );
  });

  it("l'allowlist qui part au host est celle qui est annoncée dans le prompt", () => {
    const source = lire("src/index.ts");
    expect(source).toContain("const outilsLegerPile = outilsLegerDuBot(botDuRun);");
    expect(source).toContain("outils: outilsLegerPile,");
    expect(source).toContain("tools: outilsLegerPile,");
  });

  it("la page « Personnalité » montre la liste réelle (lecture seule)", () => {
    expect(lire("public/ui/config-fields.js")).toContain("path: \"prompts.personnalite\"");
    expect(lire("public/ui/config-fields.js")).toContain("toolsInstruction: true");
    expect(lire("public/ui/config.js")).toContain("outilsGeneres");
  });
});
