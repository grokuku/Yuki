/**
 * DÉFAUTS DE PROMPT LIVRÉS (lot 48) — les NOUVEAUX textes sont les défauts du code.
 *
 * ⚠️ DÉCISION UTILISATEUR (2026-11-14) :
 *  - `config/pi/system-prompt.md` = le CADRE D'EXÉCUTION du modèle léger ;
 *  - `config/pi/system-prompt-heavy.md` = le prompt du WORKER LOURD ;
 *  - `config/pi/personnalite.md` n'est PAS touché : le texte personnel n'est pas
 *    un défaut de code, il appartient au champ `prompts.personnalite`.
 *
 * Ce qui est VERROUILLÉ :
 *  ① le défaut EFFECTIF du runtime (`prompts.light` / `prompts.heavy`) est le
 *    contenu des fichiers livrés, et il contient les marqueurs PROPRES aux deux
 *    nouveaux textes (sans eux, un ancien fichier passerait inaperçu) ;
 *  ② les sections RETIRÉES par cohérence ont disparu (ancienne liste d'outils
 *    figée, mention d'un nom de bot en dur) ;
 *  ③ la personnalité par défaut est INCHANGÉE : ce n'est ni l'un ni l'autre des
 *    deux prompts, et elle reste une identité (jamais un cadre d'exécution).
 *
 * ⚠️ Ces assertions ÉCHOUENT sur les fichiers d'origine : le léger s'intitulait
 * « Consignes de conversation », n'avait ni « ## Conversation (anti-bot) » ni
 * « ## Prudence », et le lourd citait `apt update && apt upgrade`.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadEnv } from "../../src/config/env.js";
import { createConfigRuntime } from "../../src/config/runtime.js";
import { ConfigStore } from "../../src/config/store.js";

const RACINE = process.cwd();
const FICHIER_LEGER = join(RACINE, "config", "pi", "system-prompt.md");
const FICHIER_LOURD = join(RACINE, "config", "pi", "system-prompt-heavy.md");
const FICHIER_PERSONNALITE = join(RACINE, "config", "pi", "personnalite.md");

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const leger = readFileSync(FICHIER_LEGER, "utf8");
const lourd = readFileSync(FICHIER_LOURD, "utf8");
const personnalite = readFileSync(FICHIER_PERSONNALITE, "utf8");

describe("① les défauts EFFECTIFS du runtime sont les nouveaux textes", () => {
  it("`prompts.light` / `prompts.heavy` valent le contenu des fichiers livrés", () => {
    const root = mkdtempSync(join(tmpdir(), "yuki-prompts-defauts-"));
    tempDirs.push(root);
    const storePath = join(root, "state", "config.json");
    const env = loadEnv({
      YUKI_MOUNT_STATE: join(root, "state"),
      YUKI_CONFIG_STORE_PATH: storePath,
      // ⚠️ Les fichiers LIVRÉS du dépôt : c'est EUX que `createConfigRuntime` lit
      // quand aucun `promptDefaults` n'est fourni.
      YUKI_PI_SYSTEM_PROMPT: FICHIER_LEGER,
      YUKI_PI_HEAVY_SYSTEM_PROMPT: FICHIER_LOURD,
      YUKI_PI_PERSONNALITE: FICHIER_PERSONNALITE,
    });
    const runtime = createConfigRuntime({
      env,
      store: new ConfigStore(storePath),
      processEnv: {},
    });

    expect(runtime.getString("prompts.light")).toBe(leger.trimEnd());
    expect(runtime.getString("prompts.heavy")).toBe(lourd.trimEnd());
    expect(runtime.originOf("prompts.light")).toBe("default");
    expect(runtime.originOf("prompts.heavy")).toBe("default");
  });
});

describe("② le prompt LÉGER porte les marqueurs de son nouveau texte", () => {
  it("titre, sections anti-bot et prudence", () => {
    expect(leger).toContain("# Règles de conversation");
    expect(leger).toContain("## Conversation (anti-bot)");
    expect(leger).toContain("## Prudence");
    expect(leger).toContain("Ne remplis pas le silence.");
    expect(leger).toContain("Ne présume jamais de la fin d'une conversation.");
    expect(leger).toContain("**Une idée par message** quand on discute.");
    expect(leger).toContain("**Tu n'es pas la voix de l'utilisateur**");
  });

  it("les capacités restent DÉCRITES (delegate, secrets, envoi programmé)", () => {
    expect(leger).toContain("`delegate(task, context?)`");
    expect(leger).toContain("demander_secret");
    expect(leger).toContain("lister_secrets()");
    expect(leger).toContain("programmer_envoi");
    expect(leger).toContain("rappelle-moi");
    expect(leger).toContain("steer_job(job_id, text)");
  });

  it("l'ancien titre a disparu", () => {
    expect(leger).not.toContain("# Consignes de conversation");
    expect(leger).not.toContain("conversation locale");
  });
});

describe("③ le prompt LOURD porte les marqueurs de son nouveau texte", () => {
  it("rapport intermédiaire, non-publication, images et commandes longues", () => {
    expect(lourd).toContain("# Worker lourd (arrière-plan)");
    expect(lourd).toContain("**TU NE PUBLIES JAMAIS DANS UN CANAL.**");
    expect(lourd).toContain("**une seule génération par demande**");
    expect(lourd).toContain("`timeout_ms` (jusqu'à **900000**, soit 15 min)");
    expect(lourd).toContain("Sois concis : le rapport sera résumé en une à trois phrases.");
    expect(lourd).toContain("NE T'ADRESSE JAMAIS À L'UTILISATEUR");
    expect(lourd).toContain("awaiting_secret");
  });

  it("l'exemple de commande figé (`apt update && apt upgrade`) a disparu", () => {
    expect(lourd).not.toContain("apt update && apt upgrade");
  });
});

describe("④ sections retirées par cohérence (bloc `<outils>` généré)", () => {
  it("les deux prompts renvoient au bloc généré, sans liste d'outils figée", () => {
    for (const [nom, texte] of [
      ["system-prompt.md", leger],
      ["system-prompt-heavy.md", lourd],
    ] as const) {
      expect(texte, nom).toContain("<outils>");
      expect(texte, nom).toContain("régénéré à chaque tour");
      expect(texte, nom).not.toContain("`read`, `ls`, `grep`, `find`");
    }
  });

  it("aucun nom de bot en dur dans les défauts", () => {
    for (const [nom, texte] of [
      ["system-prompt.md", leger],
      ["system-prompt-heavy.md", lourd],
      ["personnalite.md", personnalite],
    ] as const) {
      expect(texte, nom).not.toMatch(/\bYuki\b/);
    }
  });
});

describe("⑤ la personnalité par défaut est INCHANGÉE", () => {
  it("ce n'est ni le cadre d'exécution ni le prompt du worker", () => {
    expect(personnalite).not.toContain("Règles de conversation");
    expect(personnalite).not.toContain("## Conversation (anti-bot)");
    expect(personnalite).not.toContain("## Prudence");
    expect(personnalite).not.toContain("Worker lourd (arrière-plan)");
    expect(personnalite.trim().length).toBeGreaterThan(0);
  });

  it("elle reste une IDENTITÉ (début du texte livré) et `prompts.personnalite` la sert", () => {
    expect(personnalite).toContain(
      "Tu es un assistant conversationnel généraliste. Tu aides avec des questions, des",
    );
    expect(personnalite).toContain("## Comportement");
    const root = mkdtempSync(join(tmpdir(), "yuki-prompts-personnalite-"));
    tempDirs.push(root);
    const storePath = join(root, "state", "config.json");
    const env = loadEnv({
      YUKI_MOUNT_STATE: join(root, "state"),
      YUKI_CONFIG_STORE_PATH: storePath,
      YUKI_PI_SYSTEM_PROMPT: FICHIER_LEGER,
      YUKI_PI_HEAVY_SYSTEM_PROMPT: FICHIER_LOURD,
      YUKI_PI_PERSONNALITE: FICHIER_PERSONNALITE,
    });
    const runtime = createConfigRuntime({
      env,
      store: new ConfigStore(storePath),
      processEnv: {},
    });
    expect(runtime.getString("prompts.personnalite")).toBe(personnalite.trimEnd());
  });
});
