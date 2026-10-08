/**
 * PREUVE D'INTEROPÉRABILITÉ Go ↔ TS (Lot 4) — le point le plus critique :
 * un désaccord de cadrage/HKDF/AAD casserait l'appairage EN SILENCE.
 *
 * Deux preuves :
 *   1. `vectors` : le Go et le TS calculent la MÊME matière de code, la MÊME
 *      preuve HMAC et la MÊME clé HKDF pour des entrées fixées ;
 *   2. `pair` : un VRAI client Go s'appaire contre le serveur TS, déchiffre le
 *      `pair_ok`, puis ouvre une connexion mTLS authentifiée avec le certificat
 *      client signé par l'autorité interne TS ;
 *   3. `pairflow` : le VRAI flux D119 — l'agent GÉNÈRE le code et l'écrit dans un
 *      fichier ; le harnais (jouant l'utilisateur) le recopie via `submitCode` ;
 *      l'agent récupère son `pair_ok` et se connecte en mTLS.
 *
 * ⚠️ Ces tests nécessitent Go dans l'environnement. Absent ⇒ ils sont SAUTÉS
 * (`describe.skipIf`) — l'aveu est explicite plutôt que masqué.
 */

import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
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

/** `true` si `127.0.0.2` est joignable (tout `127.0.0.0/8` local : Linux). */
async function canBindExtraLoopback(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.once("error", () => resolve(false));
    probe.listen(0, "127.0.0.2", () => probe.close(() => resolve(true)));
  });
}

const EXTRA_LOOPBACK = await canBindExtraLoopback();

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

/**
 * Lance `paircheck pairflow` en ARRIÈRE-PLAN : il génère un code, l'écrit dans
 * `codeFile`, envoie `pair_begin` puis scrute — sans que l'appelant connaisse le
 * code (c'est justement le sens de D119).
 */
function startGoPairFlow(args: string[]): {
  done: Promise<Record<string, unknown>>;
  kill(): void;
} {
  const proc = spawn("go", ["run", "./cmd/paircheck", "pairflow", ...args], {
    cwd: AGENT_DIR,
    env: { ...process.env, GOFLAGS: "-mod=mod" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (d: Buffer) => {
    stdout += d.toString();
  });
  proc.stderr.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  const done = new Promise<Record<string, unknown>>((resolve, reject) => {
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`paircheck pairflow a quitté (${code}) : ${stderr}`));
        return;
      }
      const last = stdout.trim().split("\n").pop() ?? "";
      try {
        resolve(JSON.parse(last) as Record<string, unknown>);
      } catch {
        reject(new Error(`sortie paircheck illisible : ${stdout} / ${stderr}`));
      }
    });
  });
  return { done, kill: () => proc.kill("SIGKILL") };
}

/** Attend l'apparition d'un fichier non vide (le code généré par l'agent). */
async function waitForFile(path: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(path)) {
      const value = readFileSync(path, "utf8").trim();
      if (value !== "") return value;
    }
    if (Date.now() > deadline) throw new Error(`fichier non écrit à temps : ${path}`);
    await new Promise((r) => setTimeout(r, 200));
  }
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

  it.skipIf(!EXTRA_LOOPBACK)(
    "SAN déclaré : l'agent qui VÉRIFIE 127.0.0.2 (adresse déclarée) réussit",
    async () => {
      // Yuki écoute sur toutes les interfaces ; l'opérateur DÉCLARE que ses
      // agents la joignent par `127.0.0.2` (substitut de l'IP LAN `10.10.0.5`).
      const s = await startTestStack({ bindHost: "0.0.0.0", serverName: "127.0.0.2" });
      stacks.push(s);
      const code = "ABCD-2345-6789";
      s.pairing.submitCode(code, { ip: "127.0.0.2" });

      // Le client Go fixe `ServerName` = hôte de l'URL et VÉRIFIE le certificat.
      // Sans le SAN déclaré, la poignée de main mTLS échouerait (bug réel).
      const baseURL = `https://127.0.0.2:${s.port}`;
      const go = await runGo(["pair", baseURL, code], 120_000);

      expect(go["ok"]).toBe(true);
      expect(go["whoami_agent_matches"]).toBe(true);
      expect(go["ca_fingerprint"]).toBe(s.ca.fingerprint);
    },
    120_000,
  );

  it("appairage D119 : l'agent GÉNÈRE le code, Yuki le valide (ordre réel)", async () => {
    const s = await startTestStack();
    stacks.push(s);
    const codeFile = join(s.dir, "pending-code.txt");

    // L'agent démarre SANS code : il en génère un, l'écrit puis attend.
    const flow = startGoPairFlow([s.url, codeFile]);
    let go: Record<string, unknown>;
    try {
      const code = await waitForFile(codeFile, 90_000);
      // Le code est conforme (XXXX-XXXX-XXXX, alphabet Crockford 30 symboles).
      expect(code).toMatch(/^[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/);
      // L'utilisateur le recopie dans Yuki : la trame en attente est appariée.
      const submitted = s.pairing.submitCode(code, { ip: "127.0.0.1" });
      expect(submitted.matched).toBe(true);
      go = await flow.done;
    } finally {
      flow.kill();
    }

    expect(go["ok"]).toBe(true);
    expect(go["client_cert_verified"]).toBe(true);
    expect(go["whoami_agent_matches"]).toBe(true);
    expect(go["ca_fingerprint"]).toBe(s.ca.fingerprint);
    // L'agent apparaît dans le store après l'appairage.
    expect(s.store.has(go["agent_id"] as string)).toBe(true);
  }, 120_000);
});
