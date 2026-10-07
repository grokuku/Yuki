/**
 * PREUVE D'INTEROPÉRABILITÉ Go ↔ TS (Lot 4) — le point le plus critique :
 * un désaccord de cadrage/HKDF/AAD casserait l'appairage EN SILENCE.
 *
 * Deux preuves :
 *   1. `vectors` : le Go et le TS calculent la MÊME matière de code, la MÊME
 *      preuve HMAC et la MÊME clé HKDF pour des entrées fixées ;
 *   2. `pair` : un VRAI client Go s'appaire contre le serveur TS, déchiffre le
 *      `pair_ok`, puis ouvre une connexion mTLS authentifiée avec le certificat
 *      client signé par l'autorité interne TS.
 *
 * ⚠️ Ces tests nécessitent Go dans l'environnement. Absent ⇒ ils sont SAUTÉS
 * (`describe.skipIf`) — l'aveu est explicite plutôt que masqué.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  codeKey,
  computeProof,
  deriveKey,
} from "../../src/agents/index.js";
import { startTestStack, type TestStack } from "./stack.js";

const AGENT_DIR = fileURLToPath(new URL("../../agent/", import.meta.url));
const execFileAsync = promisify(execFile);

async function goAvailable(): Promise<boolean> {
  try {
    await execFileAsync("go", ["version"]);
    return true;
  } catch {
    return false;
  }
}

const GO = await goAvailable();

/**
 * Exécute `paircheck` en ASYNCHRONE.
 *
 * ⚠️ `execFileSync` bloquerait la boucle d'événements Node : le serveur TS ne
 * pourrait alors PAS répondre au client Go (l'appairage échouerait en timeout).
 * On utilise donc `execFile` (promisifié).
 */
async function runGo(args: string[], timeoutMs: number): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync("go", ["run", "./cmd/paircheck", ...args], {
    cwd: AGENT_DIR,
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...process.env, GOFLAGS: "-mod=mod" },
  });
  const last = stdout.trim().split("\n").pop() as string;
  return JSON.parse(last) as Record<string, unknown>;
}

const stacks: TestStack[] = [];
afterEach(async () => {
  for (const s of stacks.splice(0)) {
    await s.close();
    s.cleanup();
  }
});

describe.skipIf(!GO)("interopérabilité Go ↔ TS", () => {
  it("vectors : matière de code, preuve HMAC et clé HKDF identiques", async () => {
    const code = "ABCD-2345-6789";
    const agentNonce = Buffer.alloc(32, 7);
    const yukiNonce = Buffer.alloc(32, 2);
    const fp = "aabbccdd";

    const go = await runGo(
      ["vectors", code, agentNonce.toString("hex"), yukiNonce.toString("hex"), fp],
      60_000,
    );
    const key = codeKey(code);
    expect(go["code_key"]).toBe(key.toString("hex"));
    expect(go["proof"]).toBe(computeProof(key, Buffer.from(fp, "utf8"), agentNonce).toString("hex"));
    expect(go["key"]).toBe(deriveKey(key, agentNonce, yukiNonce).toString("hex"));
  }, 60_000);

  it("appairage complet : client Go ↔ serveur TS, puis mTLS authentifié", async () => {
    const s = await startTestStack();
    stacks.push(s);
    const code = "ABCD-2345-6789";
    s.pairing.submitCode(code, { ip: "127.0.0.1" });

    const go = await runGo(["pair", s.url, code], 120_000);

    expect(go["ok"]).toBe(true);
    // Le client Go a déchiffré le pair_ok TS : cadrage, HKDF et AAD concordent.
    expect(go["agent_id"]).toBe(go["whoami_agent_id"]);
    expect(go["whoami_agent_matches"]).toBe(true);
    // Le CA transmis par Yuki correspond à l'empreinte du CA interne.
    expect(go["ca_fingerprint"]).toBe(s.ca.fingerprint);
    expect(go["ca_cert_present"]).toBe(true);
    expect(go["client_cert_present"]).toBe(true);
    expect(go["client_key_present"]).toBe(true);
    // Le vérificateur x509 STRICT de Go a validé le certificat client TS.
    expect(go["client_cert_verified"]).toBe(true);
    // L'agent a bien été enregistré dans le store Yuki par l'appairage.
    expect(s.store.has(go["agent_id"] as string)).toBe(true);
  }, 120_000);
});
