/**
 * LE RUN PLANIFIÉ CONNAÎT SON BOT (audit 2026-11-20, défaut ①).
 *
 * ⚠️ LE DÉFAUT VERROUILLÉ : `composerPromptSysteme` excluait la personnalité
 * pour le rôle `heavy`, et le prompt du worker lourd ne contenait ni consignes,
 * ni faits, ni règles. Un run planifié de `grolaf` exécutait SA tâche sans savoir
 * qui il était.
 *
 * Ce fichier prouve, sur le texte FINAL :
 *  ① « Grolaf » (identité) ET sa personnalité sont présents ;
 *  ② ses consignes et ses faits sont présents — PAS ceux d'un autre bot ;
 *  ③ l'ordre est identité → personnalité → consignes/faits → prompt lourd →
 *    outils → RÈGLES en dernier ;
 *  ④ le prompt lourd livré n'est pas réécrit (il est contenu VERBATIM) ;
 *  ⑤ la garde des outils est conservée : ni publication, ni délégation, ni
 *    `capture_libraire` dans l'allowlist d'un run lourd.
 *
 * ⚠️ Échoue sur le code d'origine : `composerPromptLourd` n'existe pas, et
 * `composerPromptSysteme({ role: "heavy" })` n'inclut jamais la personnalité.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CAPACITES_BOT, cheminRegistreBots, ecrireRegistreBots } from "../../src/bots/registry.js";
import { composerPromptLourd } from "../../src/bots/prompt-lourd.js";
import { portReglesDuBot } from "../../src/rules/regles-bot.js";
import { portConsignes } from "../../src/consignes/index.js";
import { creerConfigsBots } from "../../src/config/bots.js";
import { loadEnv, type Env } from "../../src/config/env.js";
import { toolAllowlist } from "../../src/llm/tool-policy.js";
import type { ConfigRuntime } from "../../src/config/runtime.js";

const racines: string[] = [];

afterEach(() => {
  for (const racine of racines.splice(0)) rmSync(racine, { recursive: true, force: true });
});

const HEAVY = "Rapport d'exécution : tu accomplis la tâche demandée, sans publier.";
const PERSONNALITE_GROLAF = "Tu es Grolaf, le Cybergitan du 34, avec le bagout du sud.";
const PERSONNALITE_YUKI = "Tu es Yuki, une entité calme aux cheveux bleus.";

interface Banc {
  state: string;
  env: Env;
  configs: Map<string, ConfigRuntime>;
}

function banc(): Banc {
  const racine = mkdtempSync(join(tmpdir(), "yuki-prompt-lourd-"));
  racines.push(racine);
  const state = join(racine, "state");
  mkdirSync(state, { recursive: true });
  mkdirSync(join(racine, "pi", "agent", "sessions"), { recursive: true });
  const env = loadEnv({
    YUKI_MOUNT_STATE: state,
    YUKI_MOUNT_PI_AGENT: join(racine, "pi"),
    YUKI_CONFIG_STORE_PATH: join(state, "config.json"),
    YUKI_LOG_LEVEL: "error",
  });
  const bots = ["yuki", "grolaf"].map((id, ordre) => ({
    id,
    nom: id === "grolaf" ? "Grolaf" : "Yuki",
    capacites: [...CAPACITES_BOT],
    actif: ordre === 0,
    ordre,
    creeLe: "2026-01-01T00:00:00.000Z",
    plateformes: {},
  }));
  ecrireRegistreBots(cheminRegistreBots(state), { schemaVersion: 1, bots, echanges: {} });
  const configs = creerConfigsBots({
    env,
    bots: bots.map((entree) => entree.id),
    pile: "yuki",
    promptDefaults: { light: "prompt livré léger", heavy: HEAVY },
    processEnv: {},
  });
  configs.get("yuki")?.update({ "prompts.personnalite": PERSONNALITE_YUKI });
  configs.get("grolaf")?.update({ "prompts.personnalite": PERSONNALITE_GROLAF });
  return { state, env, configs };
}

/** Écrit `consignes.md` et `rules.md` DU BOT, puis rend les deux ports. */
function ecrireFichiersDuBot(b: Banc, botId: string, consigne: string, fait: string): {
  consignes: ReturnType<typeof portConsignes>;
  regles: ReturnType<typeof portReglesDuBot>;
  cheminConsignes: string;
} {
  const dossier = join(b.state, "bots", botId);
  mkdirSync(dossier, { recursive: true });
  const cheminConsignes = join(dossier, "consignes.md");
  const consignes = portConsignes({ botId, chemin: cheminConsignes });
  expect(consignes.ajouter("consigne", consigne).ok).toBe(true);
  expect(consignes.ajouter("fait", fait).ok).toBe(true);
  const cheminRegles = join(dossier, "rules.md");
  writeFileSync(cheminRegles, `Règle de ${botId} : ne jamais rien publier.`, "utf8");
  const regles = portReglesDuBot({ botId, cheminBot: cheminRegles });
  return { consignes, regles, cheminConsignes };
}

function promptDe(b: Banc, botId: string, nom: string): string {
  const fichiers = ecrireFichiersDuBot(
    b,
    botId,
    `Consigne propre à ${botId}.`,
    `Fait propre à ${botId} : son NAS est à 10.0.0.${botId === "grolaf" ? "5" : "9"}.`,
  );
  const config = b.configs.get(botId);
  if (config === undefined) throw new Error(`configuration absente pour ${botId}`);
  return composerPromptLourd({
    botId,
    nom,
    config,
    fichiersPersonnalite: [],
    consignes: fichiers.consignes,
    regles: fichiers.regles,
    outils: ["read", "run_command", "recherche_libraire"],
  });
}

describe("① un run planifié de grolaf porte SON identité et SA personnalité", () => {
  it("le prompt contient « Grolaf » et le texte de sa personnalité", () => {
    const b = banc();
    const prompt = promptDe(b, "grolaf", "Grolaf");
    expect(prompt).toContain("<identite>");
    expect(prompt).toContain("Ton nom est Grolaf.");
    expect(prompt).toContain("<personnalite>");
    expect(prompt).toContain(PERSONNALITE_GROLAF);
    // ⚠️ Échoue sur l'origine : la personnalité était exclue du rôle lourd.
    expect(prompt).not.toContain(PERSONNALITE_YUKI);
  });
});

describe("② ses consignes et ses faits — jamais ceux d'un autre bot", () => {
  it("le prompt nomme les consignes/faits de grolaf, pas ceux de yuki", () => {
    const b = banc();
    const prompt = promptDe(b, "grolaf", "Grolaf");
    expect(prompt).toContain("<consignes>");
    expect(prompt).toContain("Consigne propre à grolaf.");
    expect(prompt).toContain("<faits>");
    expect(prompt).toContain("Fait propre à grolaf");
    expect(prompt).not.toContain("Consigne propre à yuki.");
    expect(prompt).not.toContain("Fait propre à yuki");
  });
});

describe("③ l'ordre des blocs reste celui de la conversation", () => {
  it("identité → personnalité → consignes/faits → prompt → outils → règles", () => {
    const b = banc();
    const prompt = promptDe(b, "grolaf", "Grolaf");
    const positions = [
      prompt.indexOf("<identite>"),
      prompt.indexOf("<personnalite>"),
      prompt.indexOf("<consignes>"),
      prompt.indexOf("<faits>"),
      prompt.indexOf(HEAVY),
      prompt.indexOf("<outils>"),
      prompt.indexOf("<regles>"),
    ];
    // Aucun bloc manquant…
    for (const [index, position] of positions.entries()) {
      expect(position, `bloc ${index}`).toBeGreaterThan(-1);
    }
    // … et chacun AVANT le suivant.
    expect([...positions].sort((a, c) => a - c)).toEqual(positions);
  });

  it("⚠️ le prompt lourd LIVRÉ n'est pas réécrit (contenu verbatim)", () => {
    const b = banc();
    const prompt = promptDe(b, "grolaf", "Grolaf");
    expect(prompt).toContain(HEAVY);
    expect(prompt.indexOf(HEAVY)).toBeLessThan(prompt.indexOf("<outils>"));
  });
});

describe("⑤ garde conservée : un run lourd ne publie pas et ne délègue pas", () => {
  it("ni publication, ni délégation, ni capture dans l'allowlist d'un run planifié", () => {
    const outils = toolAllowlist("heavy", {
      capacites: [...CAPACITES_BOT],
      executionEnabled: true,
      screenshotsEnabled: true,
      secretsEnabled: true,
      librarianEnabled: true,
      librarianCaptureEnabled: true,
      imagesEnabled: true,
    });
    for (const interdit of [
      "publier_dans_canal",
      "envoyer_message",
      "programmer_envoi",
      "planifier_tache",
      "delegate",
      "capture_libraire",
    ]) {
      expect(outils, interdit).not.toContain(interdit);
    }
  });
});
