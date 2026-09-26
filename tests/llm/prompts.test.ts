/**
 * Instruction vocale du prompt système (chantier interface de chat, volet 1).
 *
 * Vérifie que le bloc n'est injecté que lorsque la voix est active, qu'il
 * référence la **même** constante que le filtre (`src/tts/mute.ts`) et que le
 * dispositif de délégation / prompt lourd n'est pas touché.
 */

import { describe, expect, it } from "vitest";

import {
  DELEGATION_INSTRUCTION,
  DELEGATION_MARKER,
  HEAVY_NO_USER_MARKER,
  HEAVY_SYSTEM_PROMPT_FALLBACK,
  VOICE_SPEECH_INSTRUCTION,
  appendVoiceInstruction,
} from "../../src/llm/prompts.js";
import { MUTE_BLOCK_LABEL } from "../../src/tts/mute.js";
import { isTtsEnabled } from "../../src/tts/options.js";

const USER_PROMPT = "# Yuki\n\nTu es un assistant. Utilise `delegate` pour les tâches longues.";

describe("appendVoiceInstruction — condition d'application", () => {
  it("n'ajoute RIEN quand la voix est désactivée (prompt inchangé, identité)", () => {
    expect(appendVoiceInstruction(USER_PROMPT, false)).toBe(USER_PROMPT);
    expect(appendVoiceInstruction(USER_PROMPT, false)).not.toContain(
      VOICE_SPEECH_INSTRUCTION,
    );
    expect(appendVoiceInstruction("", false)).toBe("");
  });

  it("ajoute le bloc quand la voix est active, sans toucher au prompt utilisateur", () => {
    const composed = appendVoiceInstruction(USER_PROMPT, true);
    expect(composed).toContain(VOICE_SPEECH_INSTRUCTION);
    // Le prompt d'origine est préservé, puis suivi du bloc (séparé par 2 sauts).
    expect(composed.startsWith(USER_PROMPT)).toBe(true);
    expect(composed).toBe(`${USER_PROMPT}\n\n${VOICE_SPEECH_INSTRUCTION}`);
  });

  it("fonctionne avec un prompt vide (l'instruction seule)", () => {
    expect(appendVoiceInstruction("", true)).toBe(VOICE_SPEECH_INSTRUCTION);
    expect(appendVoiceInstruction("   \n", true)).toBe(VOICE_SPEECH_INSTRUCTION);
  });
});

describe("VOICE_SPEECH_INSTRUCTION — convention du bloc muet", () => {
  it("référence la constante unique du filtre (anti-divergence)", () => {
    expect(VOICE_SPEECH_INSTRUCTION).toContain(MUTE_BLOCK_LABEL);
    // Le texte décrit bien la convention à l'oral.
    expect(VOICE_SPEECH_INSTRUCTION).toMatch(/lue à voix haute/);
  });
});

describe("condition réelle : `tts.enabled === \"on\"`", () => {
  const reader = (value: string) => ({ getString: () => value, getNumber: () => 0 });

  it("l'instruction n'est ajoutée que lorsque `tts.enabled` vaut `on`", () => {
    expect(isTtsEnabled(reader("on"))).toBe(true);
    expect(appendVoiceInstruction(USER_PROMPT, isTtsEnabled(reader("on")))).toBe(
      `${USER_PROMPT}\n\n${VOICE_SPEECH_INSTRUCTION}`,
    );
    for (const off of ["off", "", "true", "ON"]) {
      expect(isTtsEnabled(reader(off))).toBe(false);
      expect(appendVoiceInstruction(USER_PROMPT, isTtsEnabled(reader(off)))).toBe(
        USER_PROMPT,
      );
    }
  });
});

describe("dispositif de délégation / prompt lourd — non régressé", () => {
  it("l'ajout vocal ne modifie pas les marqueurs de délégation ni le lourd", () => {
    const composed = appendVoiceInstruction(USER_PROMPT, true);
    expect(composed).toContain(DELEGATION_MARKER);
    // Le repli du lourd reste intact (jamais touché par l'ajout vocal).
    expect(HEAVY_SYSTEM_PROMPT_FALLBACK).toContain(HEAVY_NO_USER_MARKER);
    // L'instruction vocale n'est PAS ajoutée au lourd : `appendVoiceInstruction`
    // n'est appelé que pour le prompt léger (voir `src/index.ts`).
    expect(VOICE_SPEECH_INSTRUCTION).not.toContain(HEAVY_NO_USER_MARKER);
  });

  it("les constantes documentaires restent définies", () => {
    expect(DELEGATION_INSTRUCTION).toContain(DELEGATION_MARKER);
  });
});
