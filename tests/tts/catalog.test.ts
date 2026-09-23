/**
 * Tests unitaires — CATALOGUE fermé des modèles TTS (Lot 9, étape 2).
 *
 * Vérifie que chaque entrée est COHÉRENTE avec les listes fermées du moteur
 * (`tts.engine`, `family`, `task`, `mode`) et avec la politique de licence, et
 * que la résolution Hugging Face est bien « à la demande » (jamais figée).
 */

import { describe, expect, it } from "vitest";

import { CONFIG_SCHEMA } from "../../src/config/schema.js";
import {
  CATALOG_ALLOWED_LICENSES,
  CATALOG_ENTRIES,
  CATALOG_REJECTIONS,
  CatalogResolveError,
  DOWNLOAD_FILE_NAME,
  ENGINE_FAMILIES,
  ENGINE_TASK_TOKENS,
  downloadEnginePath,
  findCatalogEntry,
  isAllowedLicense,
  resolveCatalogPackage,
  type CatalogEntry,
} from "../../src/tts/index.js";

const ENGINE_ENUM = CONFIG_SCHEMA["tts.engine"]?.enum ?? [];

describe("catalogue — cohérence avec les listes fermées", () => {
  it("chaque `id` est une valeur EXACTE de l'enum `tts.engine`", () => {
    expect(CATALOG_ENTRIES.length).toBe(4);
    for (const entry of CATALOG_ENTRIES) {
      expect(ENGINE_ENUM, entry.id).toContain(entry.id);
    }
  });

  it("couvre les moteurs téléchargeables et documente les écartés", () => {
    const ids = CATALOG_ENTRIES.map((entry) => entry.id).sort();
    expect(ids).toEqual(["chatterbox", "cosyvoice3", "kokoro", "qwen3-tts"]);
    // `sanotts` n'est pas téléchargeable (licence GPL-3.0) mais reste SIGNALÉ.
    expect(ids).not.toContain("sanotts");
    const rejected = CATALOG_REJECTIONS.find((entry) => entry.id === "sanotts");
    expect(rejected).toBeDefined();
    expect(rejected?.license).toBe("GPL-3.0");
    expect(rejected?.reason).toBe("license_out_of_policy");
  });

  it("`family` est un nom MOTEUR (pas l'id) et `task`/`mode` sont valides", () => {
    for (const entry of CATALOG_ENTRIES) {
      expect(ENGINE_FAMILIES, entry.id).toContain(entry.family);
      expect(ENGINE_TASK_TOKENS, `${entry.id}.task`).toContain(entry.task);
      expect(entry.mode, entry.id).toBe("offline");
    }
    // Preuve de la distinction id ↔ family (D62/D64).
    expect(findCatalogEntry("qwen3-tts")?.family).toBe("qwen3_tts");
    expect(findCatalogEntry("kokoro")?.family).toBe("kokoro_tts");
  });

  it("ne retient que des licences MIT ou Apache-2.0", () => {
    for (const entry of CATALOG_ENTRIES) {
      expect(CATALOG_ALLOWED_LICENSES, entry.id).toContain(entry.license);
      expect(isAllowedLicense(entry.license)).toBe(true);
    }
    expect(isAllowedLicense("GPL-3.0")).toBe(false);
  });

  it("décrit un dépôt, un dossier et un fichier GGUF ; taille annoncée > 0", () => {
    for (const entry of CATALOG_ENTRIES) {
      expect(entry.repo.length, entry.id).toBeGreaterThan(0);
      expect(entry.dir.length, entry.id).toBeGreaterThan(0);
      expect(entry.recommendedFile.endsWith(".gguf"), entry.id).toBe(true);
      expect(entry.approxBytes, entry.id).toBeGreaterThan(0);
      expect(entry.sha256, entry.id).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("le chemin imposé est `/models/downloads/<id>/model.gguf`", () => {
    for (const entry of CATALOG_ENTRIES) {
      expect(downloadEnginePath(entry.id)).toBe(
        `/models/downloads/${entry.id}/${DOWNLOAD_FILE_NAME}`,
      );
    }
    expect(DOWNLOAD_FILE_NAME).toBe("model.gguf");
  });

  it("`findCatalogEntry` est insensible aux identifiants inconnus (undefined)", () => {
    expect(findCatalogEntry("chatterbox")?.id).toBe("chatterbox");
    expect(findCatalogEntry("inexistant")).toBeUndefined();
  });
});

/* ─── Résolution « à la demande » via l'API Hugging Face (simulée) ────────── */

const ENTRY: CatalogEntry = {
  id: "chatterbox",
  label: "Chatterbox",
  repo: "audio-cpp/audio.cpp-gguf",
  dir: "Chatterbox-GGUF",
  variant: "Q8_0",
  recommendedFile: "chatterbox-q8_0.gguf",
  family: "chatterbox",
  task: "clon",
  mode: "offline",
  license: "MIT",
  approxBytes: 10,
  sha256: "a".repeat(64),
  rationale: "test",
};

function treeResponse(payload: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch;
}

describe("resolveCatalogPackage — résolution à la demande", () => {
  it("choisit le fichier recommandé, sa taille et son SHA-256 (lfs.oid)", async () => {
    const fetchImpl = treeResponse([
      { type: "directory", path: "Chatterbox-GGUF/autre" },
      {
        type: "file",
        path: "Chatterbox-GGUF/chatterbox-q8_0.gguf",
        size: 100,
        lfs: { oid: "b".repeat(64), size: 2_088_393_668 },
      },
      {
        type: "file",
        path: "Chatterbox-GGUF/chatterbox-f16.gguf",
        lfs: { oid: "c".repeat(64), size: 3_744_360_386 },
      },
    ]);
    const outcome = await resolveCatalogPackage(ENTRY, { fetchImpl });
    expect(outcome.source).toBe("hf");
    expect(outcome.resolved.url).toBe(
      "https://huggingface.co/audio-cpp/audio.cpp-gguf/resolve/main/Chatterbox-GGUF/chatterbox-q8_0.gguf",
    );
    expect(outcome.resolved.bytes).toBe(2_088_393_668);
    expect(outcome.resolved.sha256).toBe("b".repeat(64));
  });

  it("repli DOCUMENTÉ si l'API HF est injoignable (SHA non prétendu vérifié)", async () => {
    const fetchImpl = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    const outcome = await resolveCatalogPackage(ENTRY, { fetchImpl });
    expect(outcome.source).toBe("fallback");
    expect(outcome.resolved.bytes).toBe(ENTRY.approxBytes);
    expect(outcome.resolved.sha256).toBeNull();
    expect(outcome.warning).toContain("injoignable");
  });

  it("utilise l'unique GGUF du dossier si le nom recommandé a changé (repli 1 fichier)", async () => {
    const fetchImpl = treeResponse([
      { type: "file", path: "Chatterbox-GGUF/chatterbox-v2.gguf", lfs: { oid: "d".repeat(64), size: 42 } },
    ]);
    const outcome = await resolveCatalogPackage(ENTRY, { fetchImpl });
    expect(outcome.source).toBe("hf");
    expect(outcome.resolved.fileName).toBe("chatterbox-v2.gguf");
    expect(outcome.resolved.bytes).toBe(42);
  });

  it("lève une erreur explicite si le nom recommandé est absent ET ambigu", async () => {
    const fetchImpl = treeResponse([
      { type: "file", path: "Chatterbox-GGUF/a.gguf", size: 1 },
      { type: "file", path: "Chatterbox-GGUF/b.gguf", size: 2 },
    ]);
    await expect(resolveCatalogPackage(ENTRY, { fetchImpl })).rejects.toBeInstanceOf(
      CatalogResolveError,
    );
  });
});
