/**
 * Magasin des voix — CRUD, slug, quotas, repli et anti-traversée (Lot 7 §10).
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  VoiceStore,
  VoiceStoreError,
  isValidVoiceId,
  slugifyVoiceId,
} from "../../src/tts/voices-store.js";
import { toAudioCppRequest, type ToAudioCppOptions } from "../../src/tts/audio-cpp.js";
import { makeWav } from "./wav-fixture.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-voices-"));
  tempDirs.push(dir);
  return dir;
}

function seedPreset(dir: string): void {
  mkdirSync(join(dir, "presets"), { recursive: true });
  writeFileSync(join(dir, "presets", "camille.wav"), makeWav());
  writeFileSync(
    join(dir, "voices.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      voices: [
        {
          id: "camille",
          label: "Camille",
          kind: "preset",
          lang: "fr",
          refAudio: "presets/camille.wav",
          refText: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          createdBy: "factory",
        },
      ],
    })}\n`,
  );
}

describe("slugifyVoiceId", () => {
  it("produit un slug URL-safe (accents, espaces, ponctuation)", () => {
    expect(slugifyVoiceId("Camille — Élodie !")).toBe("camille-elodie");
    expect(slugifyVoiceId("  Ma   Voix  ")).toBe("ma-voix");
  });

  it("jamais vide", () => {
    expect(slugifyVoiceId("###")).toBe("voix");
    expect(slugifyVoiceId("")).toBe("voix");
  });

  it("isValidVoiceId n'accepte que des slugs stricts", () => {
    expect(isValidVoiceId("camille")).toBe(true);
    expect(isValidVoiceId("clone-7f3a2b")).toBe(true);
    expect(isValidVoiceId("../etc/passwd")).toBe(false);
    expect(isValidVoiceId("Camille")).toBe(false);
    expect(isValidVoiceId("")).toBe(false);
  });
});

describe("VoiceStore.createFromUpload", () => {
  it("écrit le WAV et le registre, puis liste la voix", () => {
    const dir = tempDir();
    const store = new VoiceStore({ dir });
    const voice = store.createFromUpload({
      bytes: makeWav({ seconds: 2 }),
      label: "Ma Voix",
      lang: "fr",
      refText: "bonjour",
    });
    expect(voice.id).toBe("ma-voix");
    expect(voice.kind).toBe("cloned");
    expect(voice.refText).toBe("bonjour");
    expect(existsSync(join(dir, "cloned", "ma-voix.wav"))).toBe(true);
    expect(existsSync(join(dir, "voices.json"))).toBe(true);

    const list = store.list();
    expect(list.map((v) => v.id)).toEqual(["ma-voix"]);
    expect(store.samplePath("ma-voix")).toBe(join(dir, "cloned", "ma-voix.wav"));
    expect(store.serviceSamplePath(voice)).toBe("/voices/cloned/ma-voix.wav");
  });

  it("désambiguïse les libellés identiques (id unique)", () => {
    const dir = tempDir();
    const store = new VoiceStore({ dir });
    const first = store.createFromUpload({ bytes: makeWav(), label: "Voix" });
    const second = store.createFromUpload({ bytes: makeWav(), label: "Voix" });
    expect(first.id).toBe("voix");
    expect(second.id).not.toBe(first.id);
    expect(store.list()).toHaveLength(2);
  });

  it("refuse un échantillon non WAV (422 explicite)", () => {
    const dir = tempDir();
    const store = new VoiceStore({ dir });
    try {
      store.createFromUpload({ bytes: Buffer.from("pas un wav"), label: "X" });
      throw new Error("aurait dû échouer");
    } catch (error) {
      expect(error).toBeInstanceOf(VoiceStoreError);
      expect((error as VoiceStoreError).status).toBe(422);
      expect((error as VoiceStoreError).code).toBe("not_wav");
    }
  });

  it("refuse un libellé vide", () => {
    const dir = tempDir();
    const store = new VoiceStore({ dir });
    expect(() =>
      store.createFromUpload({ bytes: makeWav(), label: "   " }),
    ).toThrowError(VoiceStoreError);
  });

  it("applique le quota de nombre de voix clonées (429)", () => {
    const dir = tempDir();
    const store = new VoiceStore({ dir, maxVoices: 1 });
    store.createFromUpload({ bytes: makeWav(), label: "Une" });
    try {
      store.createFromUpload({ bytes: makeWav(), label: "Deux" });
      throw new Error("aurait dû échouer");
    } catch (error) {
      expect((error as VoiceStoreError).code).toBe("quota_voices");
      expect((error as VoiceStoreError).status).toBe(429);
    }
  });

  it("applique le quota d'octets (429)", () => {
    const dir = tempDir();
    const store = new VoiceStore({ dir, maxBytes: 1_000 });
    try {
      store.createFromUpload({ bytes: makeWav({ seconds: 1 }), label: "Grosse" });
      throw new Error("aurait dû échouer");
    } catch (error) {
      expect((error as VoiceStoreError).code).toBe("quota_bytes");
    }
  });
});

describe("VoiceStore.rename / remove", () => {
  it("renomme le libellé sans changer l'id", () => {
    const dir = tempDir();
    const store = new VoiceStore({ dir });
    const voice = store.createFromUpload({ bytes: makeWav(), label: "Avant" });
    const renamed = store.rename(voice.id, "Après");
    expect(renamed.id).toBe(voice.id);
    expect(store.get(voice.id)?.label).toBe("Après");
  });

  it("supprime une voix clonée (registre + fichier)", () => {
    const dir = tempDir();
    const store = new VoiceStore({ dir });
    const voice = store.createFromUpload({ bytes: makeWav(), label: "Jetée" });
    store.remove(voice.id);
    expect(store.get(voice.id)).toBeUndefined();
    expect(store.samplePath(voice.id)).toBeNull();
  });

  it("refuse de supprimer un preset (409)", () => {
    const dir = tempDir();
    seedPreset(dir);
    const store = new VoiceStore({ dir });
    try {
      store.remove("camille");
      throw new Error("aurait dû échouer");
    } catch (error) {
      expect((error as VoiceStoreError).code).toBe("not_deletable");
      expect((error as VoiceStoreError).status).toBe(409);
    }
  });

  it("404 sur une voix inconnue", () => {
    const store = new VoiceStore({ dir: tempDir() });
    expect(() => store.remove("inconnue")).toThrowError(VoiceStoreError);
  });
});

describe("VoiceStore.resolveVoice", () => {
  it("id vide → voix par défaut (preset) sans repli signalé", () => {
    const dir = tempDir();
    seedPreset(dir);
    const store = new VoiceStore({ dir });
    const resolved = store.resolveVoice("");
    expect(resolved.voice?.id).toBe("camille");
    expect(resolved.fellBack).toBe(false);
  });

  it("id inconnu → repli sur le défaut avec `fellBack: true`", () => {
    const dir = tempDir();
    seedPreset(dir);
    const store = new VoiceStore({ dir });
    const resolved = store.resolveVoice("disparue");
    expect(resolved.voice?.id).toBe("camille");
    expect(resolved.fellBack).toBe(true);
  });

  it("registre vide → pas de voix (le service applique son défaut)", () => {
    const store = new VoiceStore({ dir: tempDir() });
    expect(store.resolveVoice("x").voice).toBeNull();
    expect(store.defaultVoice()).toBeNull();
  });
});

describe("anti-traversée de chemin", () => {
  it("un id hors slug ne résout jamais de fichier", () => {
    const dir = tempDir();
    seedPreset(dir);
    const store = new VoiceStore({ dir });
    expect(store.get("../voices")).toBeUndefined();
    expect(store.samplePath("../../etc/passwd")).toBeNull();
  });
});

describe("chemin `voice_ref` envoyé au moteur (store + adaptateur)", () => {
  const options: ToAudioCppOptions = {
    language: "fr",
    emotion: "neutre",
    exaggeration: 500,
    cfg: 500,
    speed: 100,
    baseUrl: "http://tts:8081",
    engine: "chatterbox",
    voiceBaseDir: "/voices",
  };

  function voiceRefOf(store: VoiceStore, id: string): Record<string, unknown> {
    const { voice } = store.resolveVoice(id);
    return JSON.parse(toAudioCppRequest(voice, "x", options).body) as Record<string, unknown>;
  }

  it("id inconnu → voix par défaut (preset) → voice_ref du preset, absolu", () => {
    const dir = tempDir();
    seedPreset(dir);
    const store = new VoiceStore({ dir });
    const body = voiceRefOf(store, "disparue");
    expect(body.voice).toBe("camille");
    expect(body.voice_ref).toBe("/voices/presets/camille.wav");
  });

  it("registre vide → aucune voix → AUCUN champ de voix envoyé", () => {
    const store = new VoiceStore({ dir: tempDir() });
    const body = voiceRefOf(store, "x");
    expect(body.voice).toBeUndefined();
    expect(body.voice_ref).toBeUndefined();
  });

  it("clonée → voice_ref absolu sous le montage configuré", () => {
    const dir = tempDir();
    const store = new VoiceStore({ dir });
    const created = store.createFromUpload({ bytes: makeWav(), label: "Ma Voix" });
    const body = voiceRefOf(store, created.id);
    expect(body.voice_ref).toBe("/voices/cloned/ma-voix.wav");
  });
});
