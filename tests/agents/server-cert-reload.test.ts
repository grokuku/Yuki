/**
 * Preuve RÉELLE du correctif SAN (Lot 4) : un client TLS qui VÉRIFIE le nom
 * d'hôte réussit lorsqu'il joint Yuki par une adresse DÉCLARÉE dans
 * `agents.serverName`, puis échoue sans elle — et le rechargement à chaud
 * (`server.setSecureContext`) répare la situation SANS redémarrer le serveur,
 * en laissant la clé du CA INCHANGÉE.
 *
 * On utilise `127.0.0.2` : le réseau `127.0.0.0/8` est entièrement local sur
 * Linux, donc l'adresse est joignable sans configuration réseau — c'est le
 * substitut déterministe de l'IP LAN (`10.10.0.5`) du cas réel.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";

import { afterEach, describe, expect, it } from "vitest";

import {
  installServerCertificateReload,
  type ServerNameConfigReader,
} from "../../src/agents/index.js";
import { loadEnv } from "../../src/config/env.js";
import { createConfigRuntime } from "../../src/config/runtime.js";
import { ConfigStore } from "../../src/config/store.js";
import { startTestStack, type TestStack } from "./stack.js";
/**
 * `127.0.0.2` n'existe que là où tout `127.0.0.0/8` est local (Linux).
 * Ailleurs (macOS/Windows), le test est SAUTÉ plutôt que faussement en échec.
 */
async function canBindExtraLoopback(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.once("error", () => resolve(false));
    probe.listen(0, "127.0.0.2", () => probe.close(() => resolve(true)));
  });
}

const EXTRA_LOOPBACK = await canBindExtraLoopback();

const stacks: TestStack[] = [];
const configDirs: string[] = [];
afterEach(async () => {
  for (const s of stacks.splice(0)) {
    await s.close();
    s.cleanup();
  }
  for (const dir of configDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Poignée de main TLS vérifiant le nom d'hôte contre `host` (ici une IP). */
function handshake(
  host: string,
  port: number,
  caPem: string,
): Promise<{ authorized: boolean; error?: string }> {
  return new Promise((resolve) => {
    const socket = tlsConnect(
      { host, port, ca: caPem, rejectUnauthorized: true, minVersion: "TLSv1.3" },
      () => {
        const authorized = socket.authorized;
        const error = socket.authorizationError
          ? String(socket.authorizationError)
          : undefined;
        socket.end();
        resolve({ authorized, error });
      },
    );
    socket.once("error", (error: Error) => {
      resolve({ authorized: false, error: error.message });
    });
  });
}

describe.skipIf(!EXTRA_LOOPBACK)("SAN déclaré + rechargement à chaud du certificat serveur", () => {
  it("un client qui vérifie 127.0.0.2 réussit quand l'adresse est déclarée", async () => {
    const s = await startTestStack({ bindHost: "0.0.0.0", serverName: "127.0.0.2" });
    stacks.push(s);

    const result = await handshake("127.0.0.2", s.port, s.ca.certificatePem);
    expect(result.error).toBeUndefined();
    expect(result.authorized).toBe(true);
  });

  it("SANS l'adresse déclarée, la vérification du nom d'hôte ÉCHOUE", async () => {
    const s = await startTestStack({ bindHost: "0.0.0.0", serverName: "" });
    stacks.push(s);

    const result = await handshake("127.0.0.2", s.port, s.ca.certificatePem);
    expect(result.authorized).toBe(false);
    // Le message reproduit la cause réelle : « is not in the cert's list ».
    expect(result.error ?? "").toMatch(/altnames|127\.0\.0\.2/i);
  });

  it("rechargement À CHAUD via le runtime de config : CA inchangé, sans redémarrage", async () => {
    const s = await startTestStack({ bindHost: "0.0.0.0", serverName: "" });
    stacks.push(s);
    const fingerprintBefore = s.ca.fingerprint;
    const caCertBefore = s.ca.certificatePem;

    // Faux runtime de configuration : `agents.serverName` modifiable + `emit`.
    let serverName = "";
    const listeners = new Set<() => void>();
    const config: ServerNameConfigReader = {
      getString: (path) => (path === "agents.serverName" ? serverName : ""),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const stop = installServerCertificateReload({
      server: s.server,
      bindHost: "0.0.0.0",
      ca: s.ca,
      config,
      logger: { info: () => {}, error: () => {} },
    });

    // Avant : le SAN ne couvre pas 127.0.0.2 ⇒ vérification du nom d'hôte refusée.
    expect((await handshake("127.0.0.2", s.port, s.ca.certificatePem)).authorized).toBe(false);

    // L'opérateur renseigne `agents.serverName = 127.0.0.2` via /config : le
    // runtime émet, le rechargement régénère le certificat + `setSecureContext`.
    serverName = "127.0.0.2";
    for (const listener of listeners) listener();

    // Après : les NOUVELLES connexions vérifient 127.0.0.2 et réussissent.
    const result = await handshake("127.0.0.2", s.port, s.ca.certificatePem);
    expect(result.error).toBeUndefined();
    expect(result.authorized).toBe(true);

    // ⚠️ Le CA (empreinte + certificat) est INCHANGÉ : aucun ré-appairage.
    expect(s.ca.fingerprint).toBe(fingerprintBefore);
    expect(s.ca.certificatePem).toBe(caCertBefore);

    // Un changement SANS effet sur les SAN (autre champ de config modifié) ne
    // casse rien : la connexion reste vérifiable.
    for (const listener of listeners) listener();
    expect((await handshake("127.0.0.2", s.port, s.ca.certificatePem)).authorized).toBe(
      true,
    );

    stop();
  });

  it("chemin PRODUIT : une écriture du runtime de config recharge le certificat à chaud", async () => {
    const s = await startTestStack({ bindHost: "0.0.0.0", serverName: "" });
    stacks.push(s);

    // VRAI `ConfigRuntime` (celui de PUT /api/config), store dans un dossier jetable.
    const root = mkdtempSync(join(tmpdir(), "yuki-cert-reload-cfg-"));
    configDirs.push(root);
    const storePath = join(root, "state", "config.json");
    const env = loadEnv({
      YUKI_MOUNT_STATE: join(root, "state"),
      YUKI_CONFIG_STORE_PATH: storePath,
    });
    const runtime = createConfigRuntime({
      env,
      store: new ConfigStore(storePath),
      processEnv: {},
      promptDefaults: { light: "", heavy: "" },
    });
    const fingerprintBefore = s.ca.fingerprint;
    const stop = installServerCertificateReload({
      server: s.server,
      bindHost: "0.0.0.0",
      ca: s.ca,
      config: runtime,
      logger: { info: () => {}, error: () => {} },
    });

    expect((await handshake("127.0.0.2", s.port, s.ca.certificatePem)).authorized).toBe(false);

    // Exactement ce que fait l'interface : une écriture du runtime.
    const result = runtime.update({ "agents.serverName": "127.0.0.2" });
    expect(result.applied.hot).toContain("agents.serverName");

    const after = await handshake("127.0.0.2", s.port, s.ca.certificatePem);
    expect(after.error).toBeUndefined();
    expect(after.authorized).toBe(true);
    // ⚠️ La clé/empreinte du CA reste INCHANGÉE : les agents appairés sont valables.
    expect(s.ca.fingerprint).toBe(fingerprintBefore);

    stop();
  });
});
