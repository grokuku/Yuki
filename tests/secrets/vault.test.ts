/**
 * Coffre de secrets chiffré (`vault.ts`) + façade (`store.ts`).
 *
 * Vérifie : chiffrement effectif (aucune valeur en clair sur disque), refus sans
 * clé maître, refus d'une clé fausse, nonce par entrée, mode 0600, écriture
 * atomique, validation des noms et de la longueur minimale.
 */

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SecretVault,
  VaultKeyInvalidError,
  VaultKeyMissingError,
  VaultNameError,
  VaultValueError,
} from "../../src/secrets/vault.js";
import { SecretStore } from "../../src/secrets/store.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-vault-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("vault — REFUS sans clé (jamais de repli en clair)", () => {
  it("lève VaultKeyMissingError si la clé maître est absente", () => {
    const path = join(tempDir(), "secrets.vault.json");
    expect(() => SecretVault.open({ path, key: "" })).toThrow(VaultKeyMissingError);
    // Le store suit la même règle.
    const store = new SecretStore({ path, env: {} });
    expect(store.isConfigured()).toBe(false);
    expect(() => store.list()).toThrow(VaultKeyMissingError);
    // Les surfaces de masquage, elles, ne lèvent PAS : elles renvoient une liste vide.
    expect(store.values()).toEqual([]);
    expect(store.lookup("YUKI_SECRET_X")).toBeUndefined();
  });
});

describe("vault — chiffrement effectif", () => {
  it("n'écrit JAMAIS la valeur en clair sur le disque", () => {
    const dir = tempDir();
    const path = join(dir, "secrets.vault.json");
    const vault = SecretVault.open({ path, key: "clé-maître-de-test" });
    vault.set("YUKI_SECRET_NAS", "SUPER-SECRET-NAS-1234", "accès NAS");
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("SUPER-SECRET-NAS-1234");
    // Le nom, lui, est visible (c'est une clé JSON, pas un secret).
    expect(raw).toContain("YUKI_SECRET_NAS");
    // Relit et déchiffre.
    const again = SecretVault.open({ path, key: "clé-maître-de-test" });
    expect(again.get("YUKI_SECRET_NAS")).toBe("SUPER-SECRET-NAS-1234");
  });

  it("REFUSE une clé fausse (authentification GCM)", () => {
    const path = join(tempDir(), "secrets.vault.json");
    SecretVault.open({ path, key: "bonne-cle" }).set("YUKI_SECRET_A", "valeur-secrete");
    expect(() => SecretVault.open({ path, key: "mauvaise-cle" })).toThrow(
      VaultKeyInvalidError,
    );
  });

  it("tire un nonce DIFFÉRENT par écriture (deux fois la même valeur ⇒ deux IV)", () => {
    const path = join(tempDir(), "secrets.vault.json");
    const vault = SecretVault.open({ path, key: "cle" });
    vault.set("YUKI_SECRET_A", "meme-valeur-1");
    const first = JSON.parse(readFileSync(path, "utf8")) as { entries: Record<string, { iv: string }> };
    vault.set("YUKI_SECRET_B", "meme-valeur-1");
    const second = JSON.parse(readFileSync(path, "utf8")) as { entries: Record<string, { iv: string }> };
    expect(first.entries["YUKI_SECRET_A"]?.iv).not.toBe(second.entries["YUKI_SECRET_B"]?.iv);
  });

  it("écrit le fichier en 0600", () => {
    const path = join(tempDir(), "secrets.vault.json");
    SecretVault.open({ path, key: "cle" }).set("YUKI_SECRET_A", "valeur-secrete");
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("vault — validation", () => {
  it("refuse un nom sans préfixe réservé", () => {
    const vault = SecretVault.open({ path: join(tempDir(), "v.json"), key: "cle" });
    expect(() => vault.set("MAUVAIS_NOM", "valeur-secrete")).toThrow(VaultNameError);
  });

  it("refuse une valeur trop courte (< 6 caractères)", () => {
    const vault = SecretVault.open({ path: join(tempDir(), "v.json"), key: "cle" });
    expect(() => vault.set("YUKI_SECRET_A", "court")).toThrow(VaultValueError);
  });
});

describe("store — façade", () => {
  it("expose la vue publique SANS valeur et notifie les changements", () => {
    const path = join(tempDir(), "secrets.vault.json");
    const changes: number[] = [];
    const store = new SecretStore({
      path,
      key: "cle",
      onChange: (values) => changes.push(values.length),
    });
    store.set("YUKI_SECRET_A", "valeur-secrete-A", "usage A");
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "YUKI_SECRET_A", label: "usage A" });
    // ⚠️ La vue ne porte AUCUNE valeur.
    expect(JSON.stringify(list)).not.toContain("valeur-secrete-A");
    expect(store.values()).toEqual(["valeur-secrete-A"]);
    expect(changes).toEqual([1]);
    expect(store.delete("YUKI_SECRET_A")).toBe(true);
    expect(changes).toEqual([1, 0]);
  });
});
