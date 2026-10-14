/**
 * Trou de l'AUDIT : `AuditLog.open` ne recevait PAS la liste partagée des
 * secrets ⇒ une valeur secrète HORS environnement (clé de /config, secret du
 * coffre) était journalisée EN CLAIR. Ce test PROUVE le trou (avant) et le
 * correctif (liste partagée → masquage), exactement comme le câblage le fait
 * désormais dans `src/index.ts`.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AuditLog } from "../../src/agents/audit.js";
import { SecretStore } from "../../src/secrets/store.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-audit-hole-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const VAULT_SECRET = "CLE-CONFIG-SECRETE-0123456789";

describe("audit — trou comblé par la liste PARTAGÉE des secrets", () => {
  it("SANS la liste partagée, une valeur HORS environnement reste en clair (le trou)", () => {
    const dir = tempDir();
    const path = join(dir, "audit.jsonl");
    // `secretValues` non fourni ⇒ repli sur `process.env` seulement : la clé de
    // /config (ici simulée) n'y est pas ⇒ elle fuit.
    const audit = AuditLog.open({ path, maxSizeBytes: 1_000_000, retentionDays: 0 });
    audit.append({
      event: "command",
      agentId: "agent-1",
      command: `curl -H 'X-Key: ${VAULT_SECRET}' https://nas`,
    });
    expect(readFileSync(path, "utf8")).toContain(VAULT_SECRET);
  });

  it("AVEC la liste partagée (correctif), la même valeur est MASQUÉE", () => {
    const dir = tempDir();
    const path = join(dir, "audit.jsonl");
    const vaultPath = join(dir, "secrets.vault.json");
    const store = new SecretStore({ path: vaultPath, key: "cle-maitre-test", env: {} });
    store.set("YUKI_SECRET_NAS", VAULT_SECRET);

    // Reproduit EXACTEMENT la liste MUTABLE partagée de `src/index.ts` :
    // valeurs d'environnement + valeurs du coffre.
    const secretValues: string[] = [...store.values()];
    const audit = AuditLog.open({ path, maxSizeBytes: 1_000_000, retentionDays: 0, secretValues });
    audit.append({
      event: "command",
      agentId: "agent-1",
      command: `curl -H 'X-Key: ${VAULT_SECRET}' https://nas`,
      meta: { note: `valeur=${VAULT_SECRET}` },
    });
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain(VAULT_SECRET);
    expect(raw).toContain("[REDACTED]");
    // ⚠️ Le store ne renvoie JAMAIS la valeur par sa vue publique.
    expect(JSON.stringify(store.list())).not.toContain(VAULT_SECRET);
  });
});
