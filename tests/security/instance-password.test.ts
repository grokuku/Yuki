/**
 * Mot de passe d'INSTANCE — stockage HACHÉ (scrypt + sel), fichier `0600`
 * atomique, réutilisable tel quel (nom neutre, aucun lien avec les agents).
 *
 * Ce que ces tests prouvent :
 *  - le fichier ne contient JAMAIS la valeur (assertions sur les OCTETS) ;
 *  - le haché est bien un scrypt avec SEL (KDF du coffre réutilisé) ;
 *  - un changement exige l'ANCIEN mot de passe (sinon n'importe quelle session
 *    ouverte pourrait remplacer le secret et rouvrir les agents sensibles) ;
 *  - la vérification est correcte (bon/mauvais), et un fichier illisible échoue
 *    FERMÉ (jamais « pas de mot de passe » silencieux).
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  hashInstancePassword,
  InstancePasswordError,
  InstancePasswordStore,
  INSTANCE_PASSWORD_MIN_LENGTH,
} from "../../src/security/instance-password.js";
import { deriveScryptKey } from "../../src/secrets/vault.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-instance-password-"));
  dirs.push(dir);
  return join(dir, "instance-password.json");
}

const PASSWORD = "Correct-Horse-Battery-42";

describe("InstancePasswordStore — stockage", () => {
  it("définit un mot de passe : fichier JSON, HACHÉ + sel, 0600, jamais la valeur", () => {
    const path = tempPath();
    const store = InstancePasswordStore.open({ path });
    expect(store.isConfigured()).toBe(false);
    expect(store.view()).toEqual({ configured: false });

    const view = store.set(PASSWORD);
    expect(view.configured).toBe(true);
    expect(view.updatedAt).toBeTruthy();

    const raw = readFileSync(path, "utf8");
    // ⚠️ ASSERTIONS SUR LES OCTETS : ni la valeur, ni une copie triviale.
    expect(raw).not.toContain(PASSWORD);
    expect(Buffer.from(raw, "utf8").includes(Buffer.from(PASSWORD, "utf8"))).toBe(false);

    const parsed = JSON.parse(raw) as {
      schemaVersion: number;
      algorithm: string;
      kdf: { salt: string; n: number; r: number; p: number };
      hash: string;
    };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.algorithm).toBe("scrypt");
    expect(parsed.kdf.salt.length).toBeGreaterThan(0);
    expect(parsed.kdf.n).toBeGreaterThan(1024);
    // Le haché est bien CELUI du KDF du coffre (source unique, aucun 2e KDF).
    expect(parsed.hash).toBe(hashInstancePassword(PASSWORD, parsed.kdf));
    expect(
      Buffer.from(parsed.hash, "base64").equals(
        deriveScryptKey(PASSWORD, parsed.kdf, 32),
      ),
    ).toBe(true);

    // Permissions 0600 (le fichier est lisible par le seul propriétaire).
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    // La vue PUBLIQUE ne porte jamais le haché.
    expect(JSON.stringify(store.view())).not.toContain(parsed.hash);
  });

  it("vérifie le bon mot de passe et refuse le mauvais", () => {
    const store = InstancePasswordStore.open({ path: tempPath() });
    store.set(PASSWORD);
    expect(store.verify(PASSWORD)).toBe(true);
    expect(store.verify("mauvais")).toBe(false);
    expect(store.verify("")).toBe(false);
    expect(store.verify(undefined)).toBe(false);
  });

  it("un sel DIFFÉRENT à chaque changement (même mot de passe ⇒ hachés distincts)", () => {
    const path1 = tempPath();
    const path2 = tempPath();
    const a = InstancePasswordStore.open({ path: path1 });
    const b = InstancePasswordStore.open({ path: path2 });
    a.set(PASSWORD);
    b.set(PASSWORD);
    const hashA = JSON.parse(readFileSync(path1, "utf8")).hash as string;
    const hashB = JSON.parse(readFileSync(path2, "utf8")).hash as string;
    expect(hashA).not.toBe(hashB);
  });

  it("CHANGER exige l'ANCIEN mot de passe (jamais un remplacement silencieux)", () => {
    const store = InstancePasswordStore.open({ path: tempPath() });
    store.set(PASSWORD);

    // Sans ancien mot de passe : refus explicite.
    expect(() => store.set("nouveau-mot-de-passe")).toThrowError(InstancePasswordError);
    // Ancien mot de passe faux : refus.
    expect(() => store.set("nouveau-mot-de-passe", { currentPassword: "faux" })).toThrowError(
      /Ancien mot de passe/i,
    );
    // L'ancien reste valable.
    expect(store.verify(PASSWORD)).toBe(true);

    store.set("nouveau-mot-de-passe", { currentPassword: PASSWORD });
    expect(store.verify(PASSWORD)).toBe(false);
    expect(store.verify("nouveau-mot-de-passe")).toBe(true);
  });

  it("refuse un mot de passe trop court (ou vide)", () => {
    const store = InstancePasswordStore.open({ path: tempPath() });
    expect(() => store.set("court")).toThrowError(/trop court/i);
    expect(() => store.set("")).toThrowError(InstancePasswordError);
    expect(INSTANCE_PASSWORD_MIN_LENGTH).toBeGreaterThanOrEqual(8);
    expect(store.isConfigured()).toBe(false);
  });

  it("relit le fichier (redémarrage) : le mot de passe survit, la valeur non", () => {
    const path = tempPath();
    InstancePasswordStore.open({ path }).set(PASSWORD);
    const reopened = InstancePasswordStore.open({ path });
    expect(reopened.isConfigured()).toBe(true);
    expect(reopened.verify(PASSWORD)).toBe(true);
  });

  it("un fichier CORROMPU échoue FERMÉ (jamais « pas de mot de passe » en silence)", () => {
    const path = tempPath();
    writeFileSync(path, "{ ceci n'est pas du JSON", "utf8");
    expect(() => InstancePasswordStore.open({ path })).toThrowError(/illisible/i);
    expect(() => InstancePasswordStore.open({ path })).toThrowError(InstancePasswordError);
  });

  it("`clear()` retire le fichier (aucun mot de passe ne ressuscite au redémarrage)", () => {
    const path = tempPath();
    const store = InstancePasswordStore.open({ path });
    store.set(PASSWORD);
    expect(store.clear()).toBe(true);
    expect(store.isConfigured()).toBe(false);
    expect(InstancePasswordStore.open({ path }).isConfigured()).toBe(false);
  });
});
