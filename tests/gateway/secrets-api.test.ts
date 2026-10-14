/**
 * API de gestion des secrets (`/api/secrets`).
 *
 * Prouve : la LISTE ne contient jamais une valeur ; l'ajout ne la renvoie pas
 * non plus ; les écritures sont protégées (en-tête) ; un coffre verrouillé
 * (clé absente) répond honnêtement sans repli en clair.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { handleSecretsRequest } from "../../src/gateway/routes/secrets.js";
import { createLogger } from "../../src/observability/logger.js";
import { SecretStore } from "../../src/secrets/store.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-secrets-api-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SECRET_VALUE = "SUPER-SECRET-NAS-0123456789";
const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });

function storeIn(dir: string): SecretStore {
  return new SecretStore({ path: join(dir, "secrets.vault.json"), key: "cle-maitre", env: {} });
}

const WRITE_HEADERS = { "x-yuki-config": "1" };

describe("API secrets — la valeur ne sort JAMAIS", () => {
  it("ajoute puis liste : noms seulement, aucune valeur dans les réponses", () => {
    const store = storeIn(tempDir());
    const deps = { store, logger };
    const added = handleSecretsRequest({
      method: "POST",
      path: "/api/secrets",
      headers: WRITE_HEADERS,
      body: JSON.stringify({ name: "YUKI_SECRET_NAS", value: SECRET_VALUE, label: "accès NAS" }),
      deps,
    });
    expect(added.status).toBe(200);
    expect(JSON.stringify(added.body)).not.toContain(SECRET_VALUE);

    const listed = handleSecretsRequest({
      method: "GET",
      path: "/api/secrets",
      headers: {},
      body: "",
      deps,
    });
    expect(listed.status).toBe(200);
    const body = listed.body as { configured: boolean; entries: Array<{ name: string; label?: string }> };
    expect(body.configured).toBe(true);
    expect(body.entries).toEqual([
      expect.objectContaining({ name: "YUKI_SECRET_NAS", label: "accès NAS" }),
    ]);
    // ⚠️ LA PREUVE : la valeur n'apparaît nulle part dans la réponse.
    expect(JSON.stringify(listed.body)).not.toContain(SECRET_VALUE);
  });

  it("supprime un secret (DELETE /api/secrets/<nom>)", () => {
    const store = storeIn(tempDir());
    store.set("YUKI_SECRET_A", "valeur-secrete-A");
    const deps = { store, logger };
    const removed = handleSecretsRequest({
      method: "DELETE",
      path: "/api/secrets/YUKI_SECRET_A",
      headers: WRITE_HEADERS,
      body: "",
      deps,
    });
    expect(removed.status).toBe(200);
    expect(store.has("YUKI_SECRET_A")).toBe(false);
  });

  it("refuse une écriture sans l'en-tête d'écriture (CSRF)", () => {
    const store = storeIn(tempDir());
    const deps = { store, logger };
    const res = handleSecretsRequest({
      method: "POST",
      path: "/api/secrets",
      headers: {},
      body: JSON.stringify({ name: "YUKI_SECRET_A", value: SECRET_VALUE }),
      deps,
    });
    expect(res.status).toBe(403);
    expect(store.has("YUKI_SECRET_A")).toBe(false);
  });
});

describe("API secrets — coffre verrouillé (jamais de repli en clair)", () => {
  it("GET répond configured:false ; POST répond 503", () => {
    const path = join(tempDir(), "secrets.vault.json");
    const store = new SecretStore({ path, key: "", env: {} });
    const deps = { store, logger };
    const listed = handleSecretsRequest({
      method: "GET",
      path: "/api/secrets",
      headers: {},
      body: "",
      deps,
    });
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({ configured: false, entries: [] });

    const added = handleSecretsRequest({
      method: "POST",
      path: "/api/secrets",
      headers: WRITE_HEADERS,
      body: JSON.stringify({ name: "YUKI_SECRET_A", value: SECRET_VALUE }),
      deps,
    });
    expect(added.status).toBe(503);
    expect(JSON.stringify(added.body)).not.toContain(SECRET_VALUE);
  });
});
