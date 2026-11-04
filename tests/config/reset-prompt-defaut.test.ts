/**
 * « RÉINITIALISER AU DÉFAUT » ne doit JAMAIS vider un prompt.
 *
 * Défaut signalé (2026-11-04) : dans `/config`, cliquer « Réinitialiser au défaut »
 * sur « Prompt système — léger » laissait la zone de texte VIDE. Cause : le miroir
 * UI `FIELD_DEFAULTS` déclarait `"prompts.light": ""` alors que le défaut réel est
 * le CONTENU DU FICHIER LIVRÉ (`config/pi/system-prompt.md`) ; l'UI ne recevait
 * donc pas le vrai défaut et écrivait la chaîne vide. Un prompt vide = aucune
 * consigne pour le modèle, donc un comportement qui se dégrade EN SILENCE.
 *
 * Ces tests prouvent le contrat serveur dont l'UI dépend :
 *  1. `GET /api/config` sert le défaut RÉEL (`fields[...].default`) ;
 *  2. un prompt VIDE est REFUSÉ (jamais persisté) avec un message actionnable ;
 *  3. `null` EFFACE la surcharge → le fichier livré redevient effectif ;
 *  4. l'avertissement de démarrage se déclenche (prompt vide, prompt qui nie une
 *     capacité) et dit QUOI FAIRE.
 *
 * ⚠️ Ces tests ÉCHOUENT sur le code d'origine : `snapshot()` n'exposait aucun
 * `default` (assertion 1), `validateDescriptor` rendait un message générique
 * (assertion 2) et `consigneEnvoiProgrammeAbsente("")` valait `false`, donc un
 * prompt vide ne produisait AUCUN avertissement (assertion 4).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadEnv } from "../../src/config/env.js";
import {
  ConfigRuntime,
  ConfigValidationError,
  createConfigRuntime,
} from "../../src/config/runtime.js";
import { ConfigStore } from "../../src/config/store.js";
import { CONFIG_SCHEMA, validateField } from "../../src/config/schema.js";
import {
  avertirSiPromptLegerIncomplet,
  consigneEnvoiProgrammeAbsente,
  diagnostiquerPromptLeger,
  promptVide,
  PROMPT_LIGHT_RESET_HINT,
  SCHEDULED_SEND_MARKER,
} from "../../src/llm/prompts.js";

const PROMPT_LIVRE = "# Yuki — prompt livré\nTu utilises `programmer_envoi`.\n";
const PROMPT_LIVRE_LOURD = "# Yuki — worker lourd\n";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeRuntime(): { runtime: ConfigRuntime; storePath: string } {
  const root = mkdtempSync(join(tmpdir(), "yuki-reset-prompt-"));
  tempDirs.push(root);
  const storePath = join(root, "state", "config.json");
  const env = loadEnv({
    YUKI_MOUNT_STATE: join(root, "state"),
    YUKI_CONFIG_STORE_PATH: storePath,
    YUKI_PI_SYSTEM_PROMPT: join(root, "light.md"),
    YUKI_PI_HEAVY_SYSTEM_PROMPT: join(root, "heavy.md"),
  });
  const runtime = createConfigRuntime({
    env,
    store: new ConfigStore(storePath),
    processEnv: {},
    promptDefaults: { light: PROMPT_LIVRE, heavy: PROMPT_LIVRE_LOURD },
  });
  return { runtime, storePath };
}

describe("① le défaut RÉEL d'un prompt est le contenu du fichier livré", () => {
  it("le schéma porte la chaîne vide, le runtime la remplace par le fichier livré", () => {
    // Le défaut du SCHÉMA est vide : c'est pour ça que l'UI ne pouvait pas le deviner.
    expect(CONFIG_SCHEMA["prompts.light"].default).toBe("");
    const { runtime } = makeRuntime();
    // Le runtime lit le fichier livré : le défaut effectif n'est PAS vide.
    expect(runtime.get("prompts.light")).toBe(PROMPT_LIVRE);
    expect(runtime.originOf("prompts.light")).toBe("default");
  });

  it("l'instantané sert ce défaut, même quand une valeur ENREGISTRÉE l'emporte", () => {
    const { runtime } = makeRuntime();
    runtime.update({ "prompts.light": "prompt personnalisé" });

    const personnalise = runtime.snapshot().fields["prompts.light"];
    expect(personnalise).toMatchObject({
      value: "prompt personnalisé",
      origin: "store",
      // ⚠️ C'est CE champ qui manquait : sans lui, l'UI ne pouvait pas restaurer
      // le prompt livré et écrivait la chaîne vide.
      default: PROMPT_LIVRE,
    });

    // Sans surcharge : valeur = défaut, origine = default.
    runtime.update({ "prompts.light": null });
    expect(runtime.snapshot().fields["prompts.light"]).toMatchObject({
      value: PROMPT_LIVRE,
      origin: "default",
      default: PROMPT_LIVRE,
    });
  });

  it("TOUS les champs non secrets de l'instantané portent leur défaut", () => {
    const { runtime } = makeRuntime();
    const fields = runtime.snapshot().fields;
    for (const path of ["gpu.minDriver", "tts.speed", "prompts.heavy", "gpu.profile"]) {
      const entry = fields[path] as { default?: unknown };
      expect(entry.default, path).toBe(runtime.get(path));
    }
  });
});

describe("② un prompt VIDE n'est jamais persisté", () => {
  it("le gateway REFUSE la chaîne vide, avec un message qui dit quoi faire", () => {
    const { runtime, storePath } = makeRuntime();
    expect(() => runtime.update({ "prompts.light": "" })).toThrow(ConfigValidationError);
    // Rien n'a été écrit : le prompt livré reste effectif.
    expect(runtime.get("prompts.light")).toBe(PROMPT_LIVRE);
    expect(new ConfigStore(storePath).load().values["prompts.light"]).toBeUndefined();
  });

  it("le refus nomme le bouton à utiliser (pas de message générique)", () => {
    const result = validateField("prompts.light", "   ");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("empty_value");
    expect(result.message).toContain("Réinitialiser au défaut");
    expect(result.message).toContain("config/pi/system-prompt.md");
    // Le message générique d'avant ne parlait que de `null` (jargon d'API).
    expect(result.message).not.toContain("Utilisez null");
  });

  it("« Réinitialiser au défaut » (null) efface la surcharge : le fichier livré revient", () => {
    const { runtime, storePath } = makeRuntime();
    runtime.update({ "prompts.light": "ancienne consigne, sans aucune capacité" });
    expect(runtime.originOf("prompts.light")).toBe("store");

    const result = runtime.update({ "prompts.light": null });
    expect(result.changes).toEqual([
      expect.objectContaining({ path: "prompts.light", to: null }),
    ]);
    // Le défaut s'applique : ni la valeur enregistrée, ni une chaîne vide.
    expect(runtime.getString("prompts.light")).toBe(PROMPT_LIVRE);
    expect(runtime.originOf("prompts.light")).toBe("default");
    // La clé a bien DISPARU du store (pas recopiée, donc jamais périmée).
    expect(new ConfigStore(storePath).load().values["prompts.light"]).toBeUndefined();
  });

  it("un prompt vide déjà présent dans le store est ignoré au chargement", () => {
    const { runtime, storePath } = makeRuntime();
    // Écriture directe (contournement de la validation, comme un fichier édité à la main).
    new ConfigStore(storePath).write({ "prompts.light": "" });
    expect(runtime.get("prompts.light")).toBe(PROMPT_LIVRE);
    expect(runtime.originOf("prompts.light")).toBe("default");
  });
});

describe("④ l'avertissement de démarrage dit le problème ET l'action", () => {
  interface WarnLine {
    event: string;
    fields: Record<string, unknown>;
  }

  function captureWarner(): { logger: { warn: (m: string, f?: Record<string, unknown>) => void }; lines: WarnLine[] } {
    const lines: WarnLine[] = [];
    return {
      lines,
      logger: {
        warn: (event: string, fields?: Record<string, unknown>) => {
          lines.push({ event, fields: fields ?? {} });
        },
      },
    };
  }

  it("prompt VIDE ⇒ avertissement `pi.prompt.vide` (aucun sur le code d'origine)", () => {
    const { logger, lines } = captureWarner();
    const diagnostic = avertirSiPromptLegerIncomplet(logger, "   ", "store");
    expect(diagnostic).toBe("vide");
    expect(lines).toHaveLength(1);
    expect(lines[0].event).toBe("pi.prompt.vide");
    expect(lines[0].fields.champ).toBe("prompts.light");
    expect(lines[0].fields.origine).toBe("store");
    expect(String(lines[0].fields.action)).toContain(PROMPT_LIGHT_RESET_HINT);
  });

  it("prompt enregistré qui CONTREDIT la capacité ⇒ `pi.prompt.envois_programmes_absents`", () => {
    const { logger, lines } = captureWarner();
    const diagnostic = avertirSiPromptLegerIncomplet(
      logger,
      "Tu es Yuki, tu n'as pas de minuteur.",
      "store",
    );
    expect(diagnostic).toBe("sans_envoi_programme");
    expect(lines).toHaveLength(1);
    expect(lines[0].event).toBe("pi.prompt.envois_programmes_absents");
    expect(String(lines[0].fields.action)).toContain(SCHEDULED_SEND_MARKER);
  });

  it("prompt livré complet ⇒ AUCUN bruit", () => {
    const { logger, lines } = captureWarner();
    expect(avertirSiPromptLegerIncomplet(logger, PROMPT_LIVRE, "default")).toBeNull();
    expect(lines).toHaveLength(0);
  });

  it("les prédicats purs sont cohérents (prompt vide ≠ défaut)", () => {
    expect(promptVide("")).toBe(true);
    expect(promptVide("   ")).toBe(true);
    expect(promptVide(PROMPT_LIVRE)).toBe(false);
    expect(diagnostiquerPromptLeger("")).toBe("vide");
    expect(diagnostiquerPromptLeger(PROMPT_LIVRE)).toBeNull();
    // Un prompt VIDE ne « contredit » rien : c'est le diagnostic « vide » qui prime.
    expect(consigneEnvoiProgrammeAbsente("")).toBe(false);
  });
});
