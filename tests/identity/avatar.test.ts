/**
 * AVATAR — stockage PERSISTANT, hors du magasin de fichiers.
 *
 * Prouve ce qui fait la décision ③ :
 *   - écriture ATOMIQUE 0600 (aucun fichier temporaire ne survit) ;
 *   - l'avatar SURVIT à un « redémarrage » (nouvelle instance sur le même
 *     dossier) et n'a AUCUNE rétention (à la différence de `src/files/`) ;
 *   - l'empreinte SHA-256 est stable (elle sert de jeton de cache) ;
 *   - le format vient des OCTETS : un `.txt` renommé `.png` est refusé ;
 *   - `DELETE` remet « aucun avatar ».
 */

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadEnv } from "../../src/config/env.js";
import {
  AVATAR_MAX_BYTES,
  AVATAR_MAX_DIMENSION,
  AvatarRefusal,
  AvatarStore,
  detecterImage,
  empreinte,
  versionCourte,
} from "../../src/identity/avatar.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-avatar-"));
  dirs.push(dir);
  return dir;
}

/** PNG minimal dont l'en-tête IHDR porte les dimensions demandées. */
function pngBytes(largeur: number, hauteur: number): Buffer {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8); // longueur du chunk IHDR
  buffer.write("IHDR", 12, "latin1");
  buffer.writeUInt32BE(largeur, 16);
  buffer.writeUInt32BE(hauteur, 20);
  buffer[24] = 8; // profondeur
  buffer[25] = 6; // RVB + alpha
  return buffer;
}

/** JPEG minimal : SOI, APP0 puis SOF0 (dimensions dans le SOF). */
function jpegBytes(largeur: number, hauteur: number): Buffer {
  // 20 (SOI + APP0) + 19 (SOF0 : 2 de longueur + 17 de données) = 39 octets.
  const buffer = Buffer.alloc(48);
  buffer[0] = 0xff;
  buffer[1] = 0xd8;
  buffer[2] = 0xff;
  buffer[3] = 0xe0;
  buffer.writeUInt16BE(16, 4); // longueur APP0
  buffer.write("JFIF", 6, "latin1");
  const sof = 20;
  buffer[sof] = 0xff;
  buffer[sof + 1] = 0xc0;
  buffer.writeUInt16BE(17, sof + 2);
  buffer[sof + 4] = 8; // précision
  buffer.writeUInt16BE(hauteur, sof + 5);
  buffer.writeUInt16BE(largeur, sof + 7);
  return buffer;
}

/** WebP « VP8 » (lossy) minimal : signature 9D 01 2A puis dimensions 14 bits. */
function webpBytes(largeur: number, hauteur: number): Buffer {
  const buffer = Buffer.alloc(40);
  buffer.write("RIFF", 0, "latin1");
  buffer.writeUInt32LE(32, 4);
  buffer.write("WEBP", 8, "latin1");
  buffer.write("VP8 ", 12, "latin1");
  buffer.writeUInt32LE(20, 16);
  buffer[23] = 0x9d;
  buffer[24] = 0x01;
  buffer[25] = 0x2a;
  buffer.writeUInt16LE(largeur, 26);
  buffer.writeUInt16LE(hauteur, 28);
  return buffer;
}

describe("détection du format par les OCTETS (jamais le Content-Type)", () => {
  it("reconnaît PNG, JPEG et WebP et lit leurs dimensions", () => {
    expect(detecterImage(pngBytes(512, 512))).toMatchObject({
      format: "png",
      mime: "image/png",
      largeur: 512,
      hauteur: 512,
    });
    expect(detecterImage(jpegBytes(640, 480))).toMatchObject({
      format: "jpeg",
      mime: "image/jpeg",
      largeur: 640,
      hauteur: 480,
    });
    expect(detecterImage(webpBytes(300, 200))).toMatchObject({
      format: "webp",
      mime: "image/webp",
      largeur: 300,
      hauteur: 200,
    });
  });

  it("refuse un texte renommé .png (signature absente)", () => {
    expect(detecterImage(Buffer.from("ceci n'est pas une image\n", "utf8"))).toBeNull();
  });
});

describe("écriture atomique 0600 et persistance", () => {
  it("écrit l'image et les métadonnées en 0600, sans fichier temporaire", () => {
    const dir = makeDir();
    const store = new AvatarStore({ dir, now: () => Date.parse("2026-11-08T17:00:00.000Z") });
    const bytes = pngBytes(512, 512);
    const meta = store.ecrire(bytes);

    expect(meta.sha256).toBe(empreinte(bytes));
    expect(meta.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(meta.bytes).toBe(bytes.byteLength);
    expect(meta.updatedAt).toBe("2026-11-08T17:00:00.000Z");
    expect(meta.largeur).toBe(512);
    expect(meta.hauteur).toBe(512);
    expect(meta.mime).toBe("image/png");
    expect(meta.fichier).toBe("avatar.png");

    const fichiers = readdirSync(dir).sort();
    expect(fichiers).toEqual(["avatar.json", "avatar.png"]);
    for (const nom of fichiers) {
      const mode = statSync(join(dir, nom)).mode & 0o777;
      expect(mode).toBe(0o600);
    }
    // Aucun `.tmp-*` ne survit à l'écriture (renommage atomique).
    expect(fichiers.some((nom) => nom.includes(".tmp-"))).toBe(false);
  });

  it("SURVIT à un redémarrage (nouvelle instance, même dossier) et le sha est stable", () => {
    const dir = makeDir();
    const bytes = pngBytes(256, 128);
    const premier = new AvatarStore({ dir, now: () => Date.parse("2026-11-08T10:00:00.000Z") });
    const ecrit = premier.ecrire(bytes);

    const apresRedemarrage = new AvatarStore({ dir });
    const relu = apresRedemarrage.lire();
    expect(relu).toMatchObject({
      sha256: ecrit.sha256,
      bytes: ecrit.bytes,
      largeur: 256,
      hauteur: 128,
    });
    expect(apresRedemarrage.octets()?.equals(bytes)).toBe(true);
    // Réécrire les mêmes octets ne change PAS l'empreinte (cache navigateur).
    expect(apresRedemarrage.ecrire(bytes).sha256).toBe(ecrit.sha256);
    expect(versionCourte(ecrit.sha256)).toHaveLength(12);
  });

  it("le dossier `state/avatar` n'est PAS sous `state/files` (aucune purge 30 j)", () => {
    const dir = makeDir();
    const store = new AvatarStore({ dir });
    store.ecrire(pngBytes(64, 64));
    // Le magasin de fichiers n'a jamais entendu parler de cet avatar.
    expect(readdirSync(dir)).not.toContain("files");

    const env = loadEnv({ YUKI_LOG_LEVEL: "error", YUKI_MOUNT_STATE: join(dir, "state") });
    expect(env.avatarDir).toBe(join(dir, "state", "avatar"));
    expect(env.filesDir).toBe(join(dir, "state", "files"));
    expect(env.avatarDir.startsWith(`${env.filesDir}/`)).toBe(false);

    // Garde STATIQUE : le module d'avatar ne dépend pas du magasin de fichiers.
    const source = readFileSync(
      join(process.cwd(), "src", "identity", "avatar.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/from\s+"\.\.\/files\//);
    expect(source).not.toContain("retentionDays");
  });

  it("un avatar déposé survit à une purge du magasin de fichiers", async () => {
    // Deux dossiers frères, comme `state/files` et `state/avatar` : purger
    // l'un ne touche pas l'autre (aucune référence croisée).
    const racine = makeDir();
    const avatarDir = join(racine, "avatar");
    const filesDir = join(racine, "files");
    const store = new AvatarStore({ dir: avatarDir });
    store.ecrire(pngBytes(512, 512));
    mkdirSync(filesDir, { recursive: true });
    writeFileSync(join(filesDir, "tmp.txt"), "x");
    rmSync(filesDir, { recursive: true, force: true });

    expect(store.lire()?.largeur).toBe(512);
    expect(store.octets()).not.toBeNull();
  });
});

describe("refus explicites et retrait", () => {
  it("refuse un faux PNG (texte renommé) sans écrire quoi que ce soit", () => {
    const dir = makeDir();
    const store = new AvatarStore({ dir });
    expect(() => store.ecrire(Buffer.from("faux png", "utf8"))).toThrowError(AvatarRefusal);
    try {
      store.ecrire(Buffer.from("faux png", "utf8"));
    } catch (error) {
      expect((error as AvatarRefusal).code).toBe("unsupported_format");
    }
    expect(store.lire()).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuse au-delà de 2 Mio (code too_large)", () => {
    const store = new AvatarStore({ dir: makeDir() });
    const trop = Buffer.alloc(AVATAR_MAX_BYTES + 1, 0x00);
    expect(() => store.ecrire(trop)).toThrowError(/plafond de 2097152/);
    try {
      store.ecrire(trop);
    } catch (error) {
      expect((error as AvatarRefusal).code).toBe("too_large");
    }
  });

  it("refuse au-delà de 4096 px de côté (code too_large_dimensions)", () => {
    const store = new AvatarStore({ dir: makeDir() });
    const trop = pngBytes(AVATAR_MAX_DIMENSION + 1, 512);
    try {
      store.ecrire(trop);
      throw new Error("aurait dû refuser");
    } catch (error) {
      expect(error).toBeInstanceOf(AvatarRefusal);
      expect((error as AvatarRefusal).code).toBe("too_large_dimensions");
    }
  });

  it("un refus ne remplace PAS l'avatar déjà en place", () => {
    const store = new AvatarStore({ dir: makeDir() });
    const valide = pngBytes(200, 200);
    const meta = store.ecrire(valide);
    expect(() => store.ecrire(Buffer.from("n'importe quoi", "utf8"))).toThrowError(AvatarRefusal);
    expect(store.lire()?.sha256).toBe(meta.sha256);
    expect(store.octets()?.equals(valide)).toBe(true);
  });

  it("DELETE remet « aucun avatar » (métadonnées et image supprimées)", () => {
    const dir = makeDir();
    const store = new AvatarStore({ dir });
    store.ecrire(pngBytes(512, 512));
    expect(store.statut().existe).toBe(true);

    expect(store.supprimer()).toBe(true);
    expect(store.lire()).toBeNull();
    expect(store.octets()).toBeNull();
    expect(store.statut()).toEqual({ existe: false });
    expect(readdirSync(dir)).toEqual([]);
    // Idempotent : retirer un avatar absent ne lève pas et le dit.
    expect(store.supprimer()).toBe(false);
  });

  it("un changement de format ne laisse pas deux images cohabiter", () => {
    const dir = makeDir();
    const store = new AvatarStore({ dir });
    store.ecrire(pngBytes(512, 512));
    store.ecrire(jpegBytes(512, 512));
    expect(readdirSync(dir).sort()).toEqual(["avatar.jpg", "avatar.json"]);
    expect(store.lire()?.mime).toBe("image/jpeg");
  });
});
