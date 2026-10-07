/**
 * Port « machines » mTLS (Lot 4, B2/B3). Couvre :
 *   - le mode « premier contact » (appairage SANS certificat) ;
 *   - le refus des routes protégées sans certificat, avec un agent inconnu,
 *     ou avec un agent révoqué ;
 *   - le renouvellement de certificat sur le canal mTLS ;
 *   - l'upgrade WebSocket réservé aux agents authentifiés.
 */

import { request as httpsRequest } from "node:https";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import {
  deriveKey,
  open,
  parsePayload,
  sealAad,
} from "../../src/agents/index.js";
import { agentBegin, pairBeginJson, startTestStack, type TestStack } from "./stack.js";

const stacks: TestStack[] = [];

async function stack(options: Parameters<typeof startTestStack>[0] = {}): Promise<TestStack> {
  const s = await startTestStack(options);
  stacks.push(s);
  return s;
}

afterEach(async () => {
  for (const s of stacks.splice(0)) {
    await s.close();
    s.cleanup();
  }
});

interface HttpResult {
  status: number;
  body: unknown;
  raw: string;
}

function request(
  url: string,
  path: string,
  options: {
    method?: string;
    body?: unknown | string;
    cert?: { cert: string; key: string };
    caPem?: string;
  } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(path, url);
    const req = httpsRequest(
      parsed,
      {
        method: options.method ?? "GET",
        headers: { "content-type": "application/json" },
        ...(options.cert ? { cert: options.cert.cert, key: options.cert.key } : {}),
        ...(options.caPem
          ? { ca: options.caPem, rejectUnauthorized: true }
          : { rejectUnauthorized: false }),
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          let body: unknown = null;
          try {
            body = data ? JSON.parse(data) : null;
          } catch {
            body = null;
          }
          resolve({ status: res.statusCode ?? 0, body, raw: data });
        });
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) {
      req.write(typeof options.body === "string" ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

describe("port machines — appairage (premier contact, sans certificat)", () => {
  it("accepte une pair_begin sans certificat, puis livre le pair_ok après saisie", async () => {
    const s = await stack();
    const begin = agentBegin("ABCD-2345-6789");
    const posted = await request(s.url, "/api/pair", {
      method: "POST",
      body: pairBeginJson(begin.frame),
    });
    expect(posted.status).toBe(202);
    const pending = posted.body as { status: string; pair_id: string };
    expect(pending.status).toBe("pending");

    s.pairing.submitCode("ABCD-2345-6789", { ip: "127.0.0.1" });
    const polled = await request(s.url, `/api/pair/${pending.pair_id}`);
    expect(polled.status).toBe(200);
    const ok = polled.body as { type: string; yuki_nonce: string; blob: string };
    expect(ok.type).toBe("pair_ok");

    // Le blob est déchiffrable par l'agent (cadrage/HKDF/AAD partagés).
    const yukiNonce = Buffer.from(ok.yuki_nonce, "base64");
    const blob = Buffer.from(ok.blob, "base64");
    const key = deriveKey(begin.key, begin.agentNonce, yukiNonce);
    const payload = parsePayload(open(key, blob, sealAad(begin.agentNonce, yukiNonce)));
    expect(payload.agentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(payload.caCert).toContain("BEGIN CERTIFICATE");
    expect(s.store.has(payload.agentId)).toBe(true);
  });

  it("répond directement si le code a déjà été soumis", async () => {
    const s = await stack();
    s.pairing.submitCode("ABCD-2345-6789", { ip: "127.0.0.1" });
    const begin = agentBegin("ABCD-2345-6789");
    const posted = await request(s.url, "/api/pair", {
      method: "POST",
      body: pairBeginJson(begin.frame),
    });
    expect(posted.status).toBe(200);
    expect((posted.body as { type: string }).type).toBe("pair_ok");
  });

  it("mauvais code ⇒ 401 proof_invalid", async () => {
    const s = await stack();
    s.pairing.submitCode("ABCD-2345-6789", { ip: "127.0.0.1" });
    const begin = agentBegin("ABCD-2345-6798");
    const posted = await request(s.url, "/api/pair", {
      method: "POST",
      body: pairBeginJson(begin.frame),
    });
    expect(posted.status).toBe(401);
    expect((posted.body as { code: string }).code).toBe("proof_invalid");
  });

  it("trame mal formée ⇒ 400 malformed_message", async () => {
    const s = await stack();
    const posted = await request(s.url, "/api/pair", { method: "POST", body: "{ pas du json" });
    expect(posted.status).toBe(400);
    expect((posted.body as { code: string }).code).toBe("invalid_json");
  });

  it("journalise l'appairage réussi SANS jamais écrire le code", async () => {
    const s = await stack();
    const code = "ABCD-2345-6789";
    s.pairing.submitCode(code, { ip: "127.0.0.1" });
    const posted = await request(s.url, "/api/pair", { method: "POST", body: pairBeginJson(agentBegin(code).frame) });
    expect(posted.status).toBe(200);
    const audit = readFileSync(join(s.dir, "audit.jsonl"), "utf8");
    expect(audit).toContain('"event":"pairing"');
    expect(audit).not.toContain(code);
    expect(audit).not.toContain("ABCD");
  });
});

describe("port machines — routes protégées (mTLS)", () => {
  it("refuse /api/agent/whoami sans certificat ⇒ 401", async () => {
    const s = await stack();
    const res = await request(s.url, "/api/agent/whoami");
    expect(res.status).toBe(401);
  });

  it("accepte un agent enregistré présentant un certificat valide", async () => {
    const s = await stack();
    const agentId = "11111111-2222-3333-4444-555555555555";
    s.register(agentId);
    const cert = s.ca.signClientCertificate(agentId);
    const res = await request(s.url, "/api/agent/whoami", {
      cert: { cert: cert.certPem, key: cert.keyPem },
      caPem: s.ca.certificatePem,
    });
    expect(res.status).toBe(200);
    expect((res.body as { agent_id: string }).agent_id).toBe(agentId);
  });

  it("refuse (403) un certificat valide d'un agent INCONNU du store", async () => {
    const s = await stack();
    const cert = s.ca.signClientCertificate("99999999-8888-7777-6666-555555555555");
    const res = await request(s.url, "/api/agent/whoami", {
      cert: { cert: cert.certPem, key: cert.keyPem },
      caPem: s.ca.certificatePem,
    });
    expect(res.status).toBe(403);
  });

  it("refuse (403) un agent révoqué", async () => {
    const s = await stack();
    const agentId = "22222222-3333-4444-5555-666666666666";
    s.register(agentId);
    s.store.revoke(agentId);
    const cert = s.ca.signClientCertificate(agentId);
    const res = await request(s.url, "/api/agent/whoami", {
      cert: { cert: cert.certPem, key: cert.keyPem },
      caPem: s.ca.certificatePem,
    });
    expect(res.status).toBe(403);
  });

  it("renouvelle le certificat sur le canal mTLS établi", async () => {
    const s = await stack();
    const agentId = "33333333-4444-5555-6666-777777777777";
    s.register(agentId);
    const cert = s.ca.signClientCertificate(agentId);
    const res = await request(s.url, "/api/agent/renew", {
      method: "POST",
      cert: { cert: cert.certPem, key: cert.keyPem },
      caPem: s.ca.certificatePem,
    });
    expect(res.status).toBe(200);
    const body = res.body as { client_cert: string; client_key: string; ca_fingerprint: string };
    expect(body.client_cert).toContain("BEGIN CERTIFICATE");
    expect(body.client_key).toContain("BEGIN PRIVATE KEY");
    expect(body.ca_fingerprint).toBe(s.ca.fingerprint);
    expect(body.client_cert).not.toBe(cert.certPem);
  });
});

describe("port machines — WebSocket (agents authentifiés seulement)", () => {
  it("refuse l'upgrade sans certificat", async () => {
    const s = await stack();
    const outcome = await new Promise<string>((resolve) => {
      const ws = new WebSocket(`wss://127.0.0.1:${s.port}/ws`, { rejectUnauthorized: false });
      ws.on("open", () => {
        ws.close();
        resolve("open");
      });
      ws.on("error", (error: Error) => resolve(`error:${error.message}`));
      ws.on("unexpected-response", (_req, res) => resolve(`http:${res.statusCode}`));
    });
    expect(outcome).not.toBe("open");
  });

  it("accepte un agent authentifié et l'enregistre dans le hub", async () => {
    const s = await stack();
    const agentId = "44444444-5555-6666-7777-888888888888";
    s.register(agentId);
    const cert = s.ca.signClientCertificate(agentId);
    const opened = await new Promise<boolean>((resolve, reject) => {
      const ws = new WebSocket(`wss://127.0.0.1:${s.port}/ws`, {
        cert: cert.certPem,
        key: cert.keyPem,
        ca: s.ca.certificatePem,
        rejectUnauthorized: true,
      });
      const timer = setTimeout(() => reject(new Error("délai")), 5_000);
      ws.on("open", () => {
        // L'agent se présente (`hello`) : le canal ne doit pas se fermer.
        ws.send(JSON.stringify({ type: "hello", proto_version: 1, euid: 1000, caps: ["exec"] }));
        setTimeout(() => {
          clearTimeout(timer);
          resolve(ws.readyState === WebSocket.OPEN);
          ws.close();
        }, 100);
      });
      ws.on("error", (error: Error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    expect(opened).toBe(true);
    expect(s.store.get(agentId)?.lastSeen).not.toBeNull();
  });
});
