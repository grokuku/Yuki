/**
 * RÈGLES D'UN BOT — RÉSOLUTION DE LA SOURCE ET INJECTION (lot 48).
 *
 * ⚠️ BUG CORRIGÉ : `<state>/bots/<id>/rules.md` n'était PAS lu pour le bot de la
 * PILE. La migration multi-bot (lot 35a) a DÉPLACÉ `<state>/rules.md` sous le
 * dossier du bot ; le host de la pile recevait pourtant le store d'INSTANCE, donc
 * il lisait un fichier disparu. Résultat : les règles du bot de la pile
 * n'étaient JAMAIS appliquées (les bots secondaires, eux, lisaient le leur).
 *
 * Ce qui est VERROUILLÉ :
 *  ① la résolution est la MÊME que celle de la personnalité : fichier DU BOT →
 *    fichier HISTORIQUE d'instance → rien (le premier non vide gagne) ;
 *  ② le constructeur est PARTAGÉ (`portReglesDuBot`) par le host de la pile et
 *    par les hosts secondaires : aucune divergence possible ;
 *  ③ le texte retenu est réellement INJECTÉ au prompt du tour (extension SDK) ;
 *  ④ aucun `botId` n'est traité à part (aucun `botId === "…"` dans la résolution
 *    ni dans le câblage des hosts).
 *
 * ⚠️ Ces tests ÉCHOUENT sur le code d'origine : `src/rules/regles-bot.ts` n'existe
 * pas (le host de la pile recevait le store d'instance) et le fichier du bot
 * n'était jamais lu pour lui.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RULES_EXTENSION_NAME, createRulesExtensionFactory } from "../../src/pi/sdk/rules-extension.js";
import {
  candidatsRegles,
  lireDocumentRegles,
  portReglesBot,
  portReglesDuBot,
  reglesEffectives,
} from "../../src/rules/regles-bot.js";

const racines: string[] = [];

afterEach(() => {
  for (const dir of racines.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Une instance migrée : `<state>` + le dossier du bot. */
function instance(): { state: string; rulesBot: string; rulesInstance: string } {
  const state = mkdtempSync(join(tmpdir(), "yuki-regles-bot-"));
  racines.push(state);
  const dossierBot = join(state, "bots", "yuki");
  mkdirSync(dossierBot, { recursive: true });
  return {
    state,
    rulesBot: join(dossierBot, "rules.md"),
    rulesInstance: join(state, "rules.md"),
  };
}

function ecrire(chemin: string, texte: string): void {
  mkdirSync(join(chemin, ".."), { recursive: true });
  writeFileSync(chemin, texte, "utf8");
}

describe("① fichier du bot → fichier d'instance → rien", () => {
  it("le fichier DU BOT est lu (cas de l'instance migrée)", () => {
    const b = instance();
    ecrire(b.rulesBot, "Toujours répondre en français.");
    const port = portReglesDuBot({
      botId: "yuki",
      cheminBot: b.rulesBot,
      cheminInstance: b.rulesInstance,
    });

    expect(port.read().text).toBe("Toujours répondre en français.");
    expect(port.provenance()).toBe("bot");
    expect(port.chemin()).toBe(b.rulesBot);
  });

  it("le fichier HISTORIQUE d'instance sert de repli (migration partielle)", () => {
    const b = instance();
    ecrire(b.rulesInstance, "Règle restée à l'ancien emplacement.");
    const port = portReglesDuBot({
      botId: "yuki",
      cheminBot: b.rulesBot,
      cheminInstance: b.rulesInstance,
    });

    expect(port.read().text).toBe("Règle restée à l'ancien emplacement.");
    expect(port.provenance()).toBe("instance");
    expect(port.chemin()).toBe(b.rulesInstance);
  });

  it("le fichier du bot PRIME sur le fichier d'instance", () => {
    const b = instance();
    ecrire(b.rulesBot, "Version du BOT.");
    ecrire(b.rulesInstance, "Version de l'INSTANCE.");
    const port = portReglesDuBot({
      botId: "yuki",
      cheminBot: b.rulesBot,
      cheminInstance: b.rulesInstance,
    });

    expect(port.read().text).toBe("Version du BOT.");
  });

  it("aucun fichier rempli ⇒ RIEN n'est injecté (aucune exception)", () => {
    const b = instance();
    const port = portReglesDuBot({
      botId: "yuki",
      cheminBot: b.rulesBot,
      cheminInstance: b.rulesInstance,
    });

    expect(port.read()).toEqual({ text: "", chars: 0, truncated: false, exists: false });
    expect(port.provenance()).toBe("aucune");
    expect(port.chemin()).toBeNull();
  });

  it("un fichier vide ne dit rien : le candidat suivant gagne", () => {
    const b = instance();
    ecrire(b.rulesBot, "   \n");
    ecrire(b.rulesInstance, "Règle d'instance.");
    const port = portReglesDuBot({
      botId: "yuki",
      cheminBot: b.rulesBot,
      cheminInstance: b.rulesInstance,
    });

    expect(port.read().text).toBe("Règle d'instance.");
    expect(port.provenance()).toBe("instance");
  });

  it("même chemin (mono-bot) ⇒ un SEUL candidat, portée « bot »", () => {
    const b = instance();
    const candidats = candidatsRegles(
      { portee: "bot", chemin: b.rulesInstance },
      { portee: "instance", chemin: b.rulesInstance },
    );
    expect(candidats).toHaveLength(1);
    expect(candidats[0]?.portee).toBe("bot");
  });
});

describe("② la résolution est PURE et testable sans disque", () => {
  it("le premier document NON VIDE gagne, dans l'ordre reçu", () => {
    const resolution = reglesEffectives([
      {
        candidat: { portee: "bot", chemin: "/b/rules.md" },
        document: { text: "", chars: 0, truncated: false, exists: true },
      },
      {
        candidat: { portee: "instance", chemin: "/i/rules.md" },
        document: { text: "Règle.", chars: 6, truncated: false, exists: true },
      },
    ]);
    expect(resolution.texte).toBe("Règle.");
    expect(resolution.provenance).toBe("instance");
    expect(resolution.fichier?.chemin).toBe("/i/rules.md");
  });

  it("un fichier ABSENT ou illisible rend un document vide, jamais une exception", () => {
    expect(lireDocumentRegles(join(tmpdir(), "yuki-inexistant-", "rules.md"))).toEqual({
      text: "",
      chars: 0,
      truncated: false,
      exists: false,
    });
    expect(lireDocumentRegles("")).toEqual({ text: "", chars: 0, truncated: false, exists: false });
  });

  it("la borne des règles s'applique à la LECTURE (jamais silencieuse)", () => {
    const b = instance();
    ecrire(b.rulesBot, "a".repeat(9_000));
    const document = lireDocumentRegles(b.rulesBot);
    expect(document.truncated).toBe(true);
    expect(document.chars).toBe(8_000);
  });
});

describe("③ le texte est réellement INJECTÉ au prompt du tour", () => {
  it("le bloc `<regles>` du tour contient les règles du FICHIER DU BOT", () => {
    const b = instance();
    ecrire(b.rulesBot, "Ne jamais divulguer un secret.");
    const port = portReglesDuBot({
      botId: "yuki",
      cheminBot: b.rulesBot,
      cheminInstance: b.rulesInstance,
    });

    const handlers: Array<(event: { systemPrompt: string }) => { systemPrompt?: string } | undefined> =
      [];
    const extension = createRulesExtensionFactory(port);
    expect(extension.name ?? RULES_EXTENSION_NAME).toBe(RULES_EXTENSION_NAME);
    const run = typeof extension === "function" ? extension : extension.factory;
    run({
      on: (_name: string, handler: (event: { systemPrompt: string }) => { systemPrompt?: string }) => {
        handlers.push(handler);
      },
    } as never);

    const resultat = handlers[0]?.({ systemPrompt: "PROMPT DE BASE" });
    expect(resultat?.systemPrompt).toContain("PROMPT DE BASE");
    expect(resultat?.systemPrompt).toContain("<regles>");
    expect(resultat?.systemPrompt).toContain("Ne jamais divulguer un secret.");
  });

  it("aucun fichier rempli ⇒ aucun bloc, et aucun en-tête orphelin", () => {
    const b = instance();
    const port = portReglesDuBot({
      botId: "yuki",
      cheminBot: b.rulesBot,
      cheminInstance: b.rulesInstance,
    });
    let handler: ((event: { systemPrompt: string }) => unknown) | undefined;
    const extension = createRulesExtensionFactory(port);
    const run = typeof extension === "function" ? extension : extension.factory;
    run({
      on: (_name: string, h: (event: { systemPrompt: string }) => unknown) => {
        handler = h;
      },
    } as never);
    expect(handler?.({ systemPrompt: "PROMPT DE BASE" })).toBeUndefined();
  });

  it("la relecture est FRAÎCHE (une règle modifiée s'applique au tour suivant)", () => {
    const b = instance();
    ecrire(b.rulesBot, "Première version.");
    const port = portReglesDuBot({ botId: "yuki", cheminBot: b.rulesBot });
    expect(port.read().text).toBe("Première version.");
    ecrire(b.rulesBot, "Seconde version.");
    expect(port.read().text).toBe("Seconde version.");
  });
});

describe("④ aucun bot n'est traité à part (règle absolue)", () => {
  it("la résolution et le câblage des hosts ne comparent aucun identifiant", () => {
    for (const fichier of ["src/rules/regles-bot.ts", "src/bots/hosts.ts"]) {
      const source = readFileSync(join(process.cwd(), fichier), "utf8");
      expect(source, fichier).not.toMatch(/botId\s*===\s*"/);
    }
  });

  it("le host de la pile et les hosts secondaires passent par le MÊME constructeur", () => {
    const index = readFileSync(join(process.cwd(), "src", "index.ts"), "utf8");
    const hosts = readFileSync(join(process.cwd(), "src", "bots", "hosts.ts"), "utf8");
    // Garde statique : le host de la pile ne reçoit plus le store d'instance.
    expect(index).toContain("rules: portReglesPile,");
    expect(index).not.toContain("rules: rulesStore,");
    expect(index).toContain("portReglesDuBot({");
    expect(hosts).toContain("portReglesDuBot({");
  });

  it("le port est celui qu'attend l'extension (lecture seule, `RulesPort`)", () => {
    const b = instance();
    ecrire(b.rulesBot, "Règle.");
    const port = portReglesBot({
      botId: "yuki",
      fichiers: [{ portee: "bot", chemin: b.rulesBot }],
    });
    expect(typeof port.read).toBe("function");
    expect(Object.keys(port)).not.toContain("write");
  });
});
