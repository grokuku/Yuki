/**
 * Lot 33 — « Modèle de discussion » / « Modèle de travail ».
 *
 * Ce que ce fichier prouve (⚠️ ces assertions ÉCHOUENT sur l'arbre d'origine) :
 *  ① les alias de clé `YUKI_LLM_DISCUSSION_API_KEY` / `YUKI_LLM_TRAVAIL_API_KEY`
 *    sont LUS si le canonique manque, mais le CANONIQUE reste prioritaire ;
 *  ② le juge du mode `auto` garde une réflexion `off` FIGÉE, même quand
 *    `llm.heavy.thinking = "high"` — c'est l'exception assumée (un juge tourne à
 *    chaque message) ; les autres usages, eux, SUIVENT la configuration ;
 *  ③ tout repli vers le modèle de discussion journalise `llm.fallback`
 *    `{ usage, de, vers, raison }`, sans contenu ni clé ;
 *  ④ le runbook porte la table des HUIT usages (une seule source de vérité).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readConfigEnvOverrides } from "../../src/config/env.js";
import { CONFIG_SCHEMA } from "../../src/config/schema.js";
import {
  LLM_ENV_ALIAS,
  resolveAvailability,
  resolveProviders,
} from "../../src/llm/index.js";
import { memoryWriteModelReference } from "../../src/memory/index.js";

const INDEX_TS = readFileSync(join(process.cwd(), "src", "index.ts"), "utf8");
const RUNBOOK = readFileSync(join(process.cwd(), "docs", "runbook.md"), "utf8");

describe("alias de clé (lecture seule) — le canonique reste prioritaire", () => {
  it("les alias DÉPRÉCIÉS sont nommés et documentés côté providers", () => {
    expect(LLM_ENV_ALIAS).toEqual({
      light: "YUKI_LLM_DISCUSSION_API_KEY",
      heavy: "YUKI_LLM_TRAVAIL_API_KEY",
    });
  });

  it("sans clé du tout : le provider pointe le canonique", () => {
    const providers = resolveProviders({});
    expect(providers.light.keyEnv).toBe("YUKI_LLM_LIGHT_API_KEY");
    expect(providers.heavy.keyEnv).toBe("YUKI_LLM_HEAVY_API_KEY");
  });

  it("alias seul : il est LU (et rend le rôle disponible, sans réseau)", () => {
    const providers = resolveProviders({
      YUKI_LLM_DISCUSSION_API_KEY: "alias-light",
      YUKI_LLM_TRAVAIL_API_KEY: "alias-heavy",
    });
    expect(providers.light.keyEnv).toBe("YUKI_LLM_DISCUSSION_API_KEY");
    expect(providers.heavy.keyEnv).toBe("YUKI_LLM_TRAVAIL_API_KEY");

    const availability = resolveAvailability({
      YUKI_LLM_DISCUSSION_API_KEY: "alias-light",
      YUKI_LLM_TRAVAIL_API_KEY: "alias-heavy",
    });
    expect(availability.isAvailable("light")).toBe(true);
    expect(availability.isAvailable("heavy")).toBe(true);
    // La valeur de la clé ne sort JAMAIS de la disponibilité.
    expect(JSON.stringify(availability)).not.toContain("alias-light");
  });

  it("les deux définis : le CANONIQUE gagne, l'alias est ignoré", () => {
    const providers = resolveProviders({
      YUKI_LLM_LIGHT_API_KEY: "canonique-light",
      YUKI_LLM_HEAVY_API_KEY: "canonique-heavy",
      YUKI_LLM_DISCUSSION_API_KEY: "alias-light",
      YUKI_LLM_TRAVAIL_API_KEY: "alias-heavy",
    });
    expect(providers.light.keyEnv).toBe("YUKI_LLM_LIGHT_API_KEY");
    expect(providers.heavy.keyEnv).toBe("YUKI_LLM_HEAVY_API_KEY");
  });

  it("alias vide : jamais une surcharge (canonique conservé)", () => {
    const providers = resolveProviders({
      YUKI_LLM_DISCUSSION_API_KEY: "   ",
      YUKI_LLM_TRAVAIL_API_KEY: "",
    });
    expect(providers.light.keyEnv).toBe("YUKI_LLM_LIGHT_API_KEY");
    expect(providers.heavy.keyEnv).toBe("YUKI_LLM_HEAVY_API_KEY");
  });

  it("`readConfigEnvOverrides` propage l'alias au store, canonique prioritaire", () => {
    expect(
      readConfigEnvOverrides({ YUKI_LLM_DISCUSSION_API_KEY: "alias-light" })[
        "llm.light.apiKey"
      ],
    ).toBe("alias-light");
    expect(
      readConfigEnvOverrides({
        YUKI_LLM_TRAVAIL_API_KEY: "alias-heavy",
      })["llm.heavy.apiKey"],
    ).toBe("alias-heavy");
    expect(
      readConfigEnvOverrides({
        YUKI_LLM_LIGHT_API_KEY: "canonique-light",
        YUKI_LLM_DISCUSSION_API_KEY: "alias-light",
      })["llm.light.apiKey"],
    ).toBe("canonique-light");
    expect(
      readConfigEnvOverrides({ YUKI_LLM_DISCUSSION_API_KEY: "  " })[
        "llm.light.apiKey"
      ],
    ).toBeUndefined();
  });
});

describe("juge du mode `auto` — réflexion `off` FIGÉE, l'exception assumée", () => {
  it("la prémisse est réelle : le défaut du rôle travail est `high`", () => {
    expect(CONFIG_SCHEMA["llm.heavy.thinking"]?.default).toBe("high");
  });

  it("la fabrique `chatWriter` (juge ET rédacteur de canal) force `off`", () => {
    const start = INDEX_TS.indexOf("const chatWriter = (");
    expect(start).toBeGreaterThan(-1);
    // Corps COMPLET de la fabrique : jusqu'au `});` qui ferme
    // `createSdkPromptWriter({ … })` (le `thinking: "off"` est DEDANS).
    const end = INDEX_TS.indexOf("\n    });", INDEX_TS.indexOf("createSdkPromptWriter({", start));
    expect(end).toBeGreaterThan(start);
    const block = INDEX_TS.slice(start, end);

    // ⚠️ Le juge est l'EXCEPTION : il ne suit NI le lourd NI le léger.
    expect(block).toContain('thinking: "off"');
    expect(block).not.toContain("liveHeavyThinking");
    expect(block).not.toContain("liveLightThinking");
    expect(block).not.toContain("thinking: () =>");
  });

  it("le juge ET le rédacteur de canal passent bien par cette fabrique", () => {
    // ⚠️ GARDE RENOMMÉE (2026-11-14) : la constante commune a été remplacée par un
    // prompt COMPOSÉ PAR BOT (le « Tu es Yuki » figé faisait répondre « je suis
    // Yuki » à `grolaf` dans son canal). C'est la fabrique `chatWriter` qui est
    // vérifiée ici, pas le texte du prompt.
    expect(INDEX_TS).toContain("chatWriter(\n      chatJudgeSystemPrompt({ botName: nomDuBot(botId) })");
    expect(INDEX_TS).toContain("chatWriter(\n        // ⚠️ IDENTITÉ + PERSONNALITÉ du bot PROPRIÉTAIRE du canal.");
    expect(INDEX_TS).toContain("promptSystemeDuCanal(conversationId, botRecu)");
  });

  it("l'appel du juge ne transmet AUCUNE réflexion : il hérite du `off` figé", () => {
    const debut = INDEX_TS.indexOf("const chatJudge: ChatReplyJudge");
    expect(debut).toBeGreaterThan(-1);
    const fin = INDEX_TS.indexOf("// Client MATTERMOST", debut);
    expect(fin).toBeGreaterThan(debut);
    const bloc = INDEX_TS.slice(debut, fin);
    expect(bloc).toContain("chatWriter(");
    expect(bloc).toContain("chatJudgeSystemPrompt({ botName: nomDuBot(botId) })");
    // ⚠️ Même quand `llm.heavy.thinking = "high"`, le juge ne le lit pas.
    expect(bloc).not.toContain("thinking:");
    expect(bloc).not.toContain("liveHeavyThinking");
    expect(bloc).not.toContain("liveLightThinking");
  });

  it("les AUTRES usages suivent la configuration — jamais un `off` figé", () => {
    // Worker + consolidation (références relues à chaque passage).
    expect(INDEX_TS).toContain("thinking: liveHeavyThinking");
    // Conversation.
    expect(INDEX_TS).toContain("thinking: lightThinking");
    // Extraction mémoire, libraire, récapitulatif : fonction lue à chaque appel.
    const relus = INDEX_TS.match(/thinking: \(\) =>/g) ?? [];
    expect(relus.length).toBeGreaterThanOrEqual(3);
    // Les fonctions choisissent bien lourd/léger selon la disponibilité.
    const lourds = INDEX_TS.match(/liveHeavyThinking\(\)/g) ?? [];
    const legers = INDEX_TS.match(/liveLightThinking\(\)/g) ?? [];
    expect(lourds.length).toBeGreaterThanOrEqual(3);
    expect(legers.length).toBeGreaterThanOrEqual(3);
  });
});

describe("repli — journal `llm.fallback` sans contenu ni clé", () => {
  function espion() {
    const appels: Array<{ message: string; fields?: Record<string, unknown> }> = [];
    return {
      appels,
      logger: {
        warn(message: string, fields?: Record<string, unknown>) {
          appels.push({ message, fields });
        },
      },
    };
  }

  it("émet `llm.fallback { usage, de, vers, raison }` quand le lourd manque", () => {
    const { appels, logger } = espion();
    const ref = memoryWriteModelReference({
      heavyAvailable: false,
      heavyRef: "llm-heavy/deepseek",
      lightRef: "llm-light/gemma",
      logger,
      usage: "synthese libraire",
    });
    expect(ref).toBe("llm-light/gemma");
    expect(appels).toHaveLength(1);
    expect(appels[0]?.message).toBe("llm.fallback");
    expect(appels[0]?.fields).toEqual({
      usage: "synthese libraire",
      de: "heavy",
      vers: "light",
      raison: "modèle de travail indisponible",
    });
  });

  it("ne journalise RIEN quand le lourd est disponible", () => {
    const { appels, logger } = espion();
    expect(
      memoryWriteModelReference({
        heavyAvailable: true,
        heavyRef: "llm-heavy/deepseek",
        lightRef: "llm-light/gemma",
        logger,
        usage: "extraction memoire",
      }),
    ).toBe("llm-heavy/deepseek");
    expect(appels).toEqual([]);
  });

  it("le journal ne reprend NI les références NI une valeur d'environnement", () => {
    const { appels, logger } = espion();
    memoryWriteModelReference({
      heavyAvailable: false,
      heavyRef: "llm-heavy/deepseek",
      lightRef: "llm-light/gemma",
      logger,
      usage: "recapitulatif",
    });
    const serialise = JSON.stringify(appels);
    expect(serialise).not.toContain("deepseek");
    expect(serialise).not.toContain("gemma");
    // Cinq clés FIXES, aucune valeur libre recopiée.
    expect(Object.keys(appels[0]?.fields ?? {}).sort()).toEqual([
      "de",
      "raison",
      "usage",
      "vers",
    ]);
  });

  it("le repli mémoire est CÂBLÉ dans `src/index.ts` (extraction, libraire, récap)", () => {
    const appels = INDEX_TS.match(/memoryWriteModelReference\(\{/g) ?? [];
    expect(appels.length).toBeGreaterThanOrEqual(3);
    // Le logger de l'application est transmis : sans lui, pas de journal.
    expect(INDEX_TS).toContain("logger,\n        usage: \"extraction memoire\"");
    expect(INDEX_TS).toContain("logger,\n            usage: \"synthese libraire\"");
    expect(INDEX_TS).toContain("logger,\n              usage: \"recapitulatif\"");
  });
});

describe("runbook — table unique des HUIT usages", () => {
  it("porte les 8 lignes, l'exception du juge et la consolidation sans repli", () => {
    for (const usage of [
      "conversation (interface)",
      "juge du mode `auto`",
      "rédacteur de canal",
      "worker (tâche déléguée)",
      "extraction mémoire",
      "consolidation hebdo de la mémoire",
      "synthèse du libraire",
      "récapitulatif",
    ]) {
      expect(RUNBOOK).toContain(usage);
    }
    expect(RUNBOOK).toContain("`off` figé — exception assumée");
    expect(RUNBOOK).toContain("aucun — lourd imposé");
    expect(RUNBOOK).toContain("`llm.fallback { usage, de, vers, raison }`");
  });
});
