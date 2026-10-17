/**
 * Exécution + SECRETS du coffre (flux `awaiting_secret`).
 *
 * ⚠️ LE TEST QUI COMPTE : une commande QUI ÉCHOUE en affichant le secret ⇒ le
 * secret n'apparaît NI dans le résultat rendu au modèle, NI dans l'audit, NI
 * dans la commande envoyée à l'agent (elle porte la RÉFÉRENCE, pas la valeur).
 * La valeur passe par l'ENVIRONNEMENT (`env` de la trame `cmd`).
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { startTestStack, type TestStack } from "./stack.js";
import { SecretStore } from "../../src/secrets/store.js";
import { SecretRequestRegistry } from "../../src/secrets/requests.js";

const stacks: TestStack[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const s of stacks.splice(0)) {
    await s.close();
    s.cleanup();
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-exec-secret-"));
  dirs.push(dir);
  return dir;
}

const SECRET_VALUE = "SUPER-SECRET-NAS-9876543210";

function secretStack(options: { configured?: boolean } = {}): {
  store: SecretStore;
  requests: SecretRequestRegistry;
} {
  const path = join(tempDir(), "secrets.vault.json");
  const store = new SecretStore({
    path,
    ...(options.configured === false ? { key: "" } : { key: "cle-maitre-test" }),
    env: {},
  });
  const requests = new SecretRequestRegistry({});
  return { store, requests };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, timeoutMs = 4_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor : délai dépassé");
    await delay(10);
  }
}

async function connectAgent(
  s: TestStack,
  agentId: string,
): Promise<{ ws: WebSocket; received: Array<Record<string, unknown>> }> {
  s.register(agentId);
  const cert = s.ca.signClientCertificate(agentId);
  const received: Array<Record<string, unknown>> = [];
  const ws = new WebSocket(`wss://127.0.0.1:${s.port}/ws`, {
    cert: cert.certPem,
    key: cert.keyPem,
    ca: s.ca.certificatePem,
    rejectUnauthorized: true,
  });
  ws.on("message", (data: Buffer) => {
    received.push(JSON.parse(data.toString()) as Record<string, unknown>);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  await waitFor(() => s.hub.isOnline(agentId));
  return { ws, received };
}

function send(ws: WebSocket, frame: Record<string, unknown>): void {
  ws.send(JSON.stringify({ proto_version: 1, ...frame }));
}

/** Agent simulé qui renvoie un résultat ÉCHOUE affichant le secret dans stderr. */
function failingAgentEchoingSecret(ws: WebSocket): void {
  ws.on("message", (data: Buffer) => {
    const frame = JSON.parse(data.toString()) as Record<string, unknown>;
    if (frame["type"] !== "cmd") return;
    const cmdId = frame["cmd_id"] as string;
    send(ws, { type: "ack", cmd_id: cmdId });
    send(ws, {
      type: "result",
      cmd_id: cmdId,
      exit_code: 1,
      stdout: "",
      stderr: `auth failed for token ${SECRET_VALUE}\n`,
      duration_ms: 3,
    });
  });
}

function readAudit(s: TestStack): string {
  return readFileSync(join(s.dir, "audit.jsonl"), "utf8");
}

describe("Secrets — injection par ENVIRONNEMENT (jamais dans la chaîne)", () => {
  it("envoie la RÉFÉRENCE dans la commande et la VALEUR dans `env`", async () => {
    const { store, requests } = secretStack();
    store.set("YUKI_SECRET_NAS", SECRET_VALUE);
    const s = await startTestStack({ secrets: store, secretRequests: requests });
    stacks.push(s);
    const agentId = "agent-secret";
    const { ws, received } = await connectAgent(s, agentId);
    ws.on("message", (data: Buffer) => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>;
      if (frame["type"] !== "cmd") return;
      const cmdId = frame["cmd_id"] as string;
      send(ws, { type: "ack", cmd_id: cmdId });
      send(ws, { type: "result", cmd_id: cmdId, exit_code: 0, stdout: "ok\n", stderr: "" });
    });

    const outcome = await s.execution.execute({
      agentId,
      command: "echo ${YUKI_SECRET_NAS}",
    });
    expect(outcome.status).toBe("completed");

    const cmd = received.find((f) => f["type"] === "cmd") as Record<string, unknown>;
    // ⚠️ La valeur n'est JAMAIS dans la chaîne de commande : on y trouve la RÉFÉRENCE.
    expect(cmd["command"]).toBe("echo ${YUKI_SECRET_NAS}");
    expect(String(cmd["command"])).not.toContain(SECRET_VALUE);
    // ⚠️ La valeur voyage par l'ENVIRONNEMENT.
    expect(cmd["env"]).toEqual({ YUKI_SECRET_NAS: SECRET_VALUE });
  });
});

describe("Secrets — masquage À LA SOURCE (commande échouée qui affiche le secret)", () => {
  it("le secret n'apparaît NI dans le résultat rendu au modèle NI dans l'audit", async () => {
    const { store, requests } = secretStack();
    store.set("YUKI_SECRET_NAS", SECRET_VALUE);
    const s = await startTestStack({ secrets: store, secretRequests: requests });
    stacks.push(s);
    const agentId = "agent-leak";
    const { ws } = await connectAgent(s, agentId);
    failingAgentEchoingSecret(ws);

    const outcome = await s.execution.execute({
      agentId,
      command: "curl -H \"Authorization: Bearer ${YUKI_SECRET_NAS}\" https://nas",
    });

    // La commande a échoué (code 1) : le bloc <sortie> doit être présent…
    expect(outcome.status).toBe("completed");
    expect(outcome.exitCode).toBe(1);
    expect(outcome.framed).toBeDefined();
    // … et la stderr fautive est MASQUÉE à la source.
    expect(outcome.framed).not.toContain(SECRET_VALUE);
    expect(outcome.framed).toContain("[REDACTED]");
    // Le message global non plus.
    expect(outcome.message).not.toContain(SECRET_VALUE);

    // Audit : jamais la valeur, ni en clair.
    const audit = readAudit(s);
    expect(audit).not.toContain(SECRET_VALUE);
    // La commande journalisée porte la RÉFÉRENCE.
    expect(audit).toContain("${YUKI_SECRET_NAS}");
  });
});

describe("Secrets — `awaiting_secret` quand le secret manque (flux DÉDIÉ)", () => {
  it("demande le secret, puis l'exécute après fourniture", async () => {
    const { store, requests } = secretStack();
    // Le secret N'EST PAS dans le coffre au départ.
    const s = await startTestStack({ secrets: store, secretRequests: requests });
    stacks.push(s);
    const agentId = "agent-attente";
    const { ws, received } = await connectAgent(s, agentId);
    ws.on("message", (data: Buffer) => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>;
      if (frame["type"] !== "cmd") return;
      const cmdId = frame["cmd_id"] as string;
      send(ws, { type: "ack", cmd_id: cmdId });
      send(ws, { type: "result", cmd_id: cmdId, exit_code: 0, stdout: "ok\n", stderr: "" });
    });

    const first = await s.execution.execute({
      agentId,
      command: "mount -o ${YUKI_SECRET_NAS}",
    });
    // ⚠️ AUCUNE exécution : la commande n'a pas été envoyée.
    expect(first.status).toBe("awaiting_secret");
    expect(first.secretRequestId).toBeTruthy();
    expect(first.secretNames).toEqual(["YUKI_SECRET_NAS"]);
    expect(received.filter((f) => f["type"] === "cmd")).toHaveLength(0);
    // La demande est ÉPHÉMÈRE : dans le registre, jamais dans l'audit en clair.
    expect(requests.list()).toHaveLength(1);
    expect(requests.list()[0]?.names).toEqual(["YUKI_SECRET_NAS"]);

    // L'humain fournit la valeur.
    const result = await s.execution.submitSecret(first.secretRequestId as string, {
      YUKI_SECRET_NAS: SECRET_VALUE,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.outcome?.status).toBe("completed");
    }
    // La commande est rejouée AVEC la valeur en environnement, jamais dans la chaîne.
    const cmd = received.find((f) => f["type"] === "cmd") as Record<string, unknown>;
    expect(cmd["command"]).toBe("mount -o ${YUKI_SECRET_NAS}");
    expect(cmd["env"]).toEqual({ YUKI_SECRET_NAS: SECRET_VALUE });
    expect(String(cmd["command"])).not.toContain(SECRET_VALUE);
    // La valeur est désormais au coffre (chiffrée).
    expect(store.lookup("YUKI_SECRET_NAS")).toBe(SECRET_VALUE);
  });
});

describe("Secrets — après une demande DIRECTE, le MODÈLE est réveillé (reprise)", () => {
  it("envoie un prompt SYNTHÉTIQUE ne portant que les NOMS (jamais la valeur)", async () => {
    const { store, requests } = secretStack();
    const s = await startTestStack({ secrets: store, secretRequests: requests });
    stacks.push(s);
    const sent: Array<{ sessionId: string; text: string; origin?: string }> = [];
    s.execution.setWaker({
      send: (sessionId, text, opts) => {
        sent.push({ sessionId, text, ...(opts?.origin !== undefined ? { origin: opts.origin } : {}) });
      },
    });

    const result = s.execution.requestSecret({
      names: ["YUKI_SECRET_NAS"],
      purpose: "sauvegarde nocturne",
      sessionId: "sess-reprise",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("demande refusée");
    await s.execution.submitSecret(result.request.id, { YUKI_SECRET_NAS: SECRET_VALUE });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.sessionId).toBe("sess-reprise");
    // Origine SYNTHÉTIQUE : jamais une bulle utilisateur, jamais mémorisé.
    expect(sent[0]?.origin).toBe("secret_stored");
    expect(sent[0]?.text.startsWith("[SECRET ENREGISTRÉ]")).toBe(true);
    expect(sent[0]?.text).toContain("YUKI_SECRET_NAS");
    expect(sent[0]?.text).toContain("sauvegarde nocturne");
    // ⚠️ La valeur n'est JAMAIS dans le prompt du modèle.
    expect(sent[0]?.text).not.toContain(SECRET_VALUE);
  });
});

describe("Secrets — coffre VERROUILLÉ (clé absente) ⇒ REFUS", () => {
  it("refuse d'exécuter une commande qui référence un secret, sans repli en clair", async () => {
    const { store, requests } = secretStack({ configured: false });
    const s = await startTestStack({ secrets: store, secretRequests: requests });
    stacks.push(s);
    const agentId = "agent-verrou";
    const { ws, received } = await connectAgent(s, agentId);
    ws.on("message", (data: Buffer) => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>;
      if (frame["type"] !== "cmd") return;
      send(ws, { type: "ack", cmd_id: frame["cmd_id"] as string });
    });

    const outcome = await s.execution.execute({
      agentId,
      command: "echo ${YUKI_SECRET_NAS}",
    });
    expect(outcome.status).toBe("refused");
    expect(outcome.message).toContain("VERROUILLÉ");
    // ⚠️ RIEN n'a été envoyé à l'agent.
    expect(received.filter((f) => f["type"] === "cmd")).toHaveLength(0);
  });

  it("une commande SANS référence à un secret n'est PAS affectée par le verrou", async () => {
    const { store, requests } = secretStack({ configured: false });
    const s = await startTestStack({ secrets: store, secretRequests: requests });
    stacks.push(s);
    const agentId = "agent-normal";
    const { ws } = await connectAgent(s, agentId);
    ws.on("message", (data: Buffer) => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>;
      if (frame["type"] !== "cmd") return;
      send(ws, { type: "ack", cmd_id: frame["cmd_id"] as string });
      send(ws, { type: "result", cmd_id: frame["cmd_id"] as string, exit_code: 0, stdout: "ok\n" });
    });
    const outcome = await s.execution.execute({ agentId, command: "echo bonjour" });
    expect(outcome.status).toBe("completed");
  });
});

describe("Secrets — demande DIRECTE par l'outil `demander_secret` (aucune commande)", () => {
  it("émet une demande routée vers la conversation, puis ENREGISTRE sans rien exécuter", async () => {
    const { store, requests } = secretStack();
    const s = await startTestStack({ secrets: store, secretRequests: requests });
    stacks.push(s);
    const agentId = "agent-direct";
    const { received } = await connectAgent(s, agentId);

    const result = s.execution.requestSecret({
      names: ["YUKI_SECRET_WIFI"],
      purpose: "se connecter au wifi du bureau",
      agentName: "nuc00",
      sessionId: "sess-conversation",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("demande refusée");
    // ⚠️ Aucune commande : rien à rejouer.
    expect(result.request.command).toBeUndefined();
    expect(result.request.purpose).toBe("se connecter au wifi du bureau");
    expect(result.request.sessionId).toBe("sess-conversation");
    // ⚠️ Routée vers la SEULE conversation concernée (piège de la session).
    expect(s.execution.pendingSecrets("sess-conversation")).toHaveLength(1);
    expect(s.execution.pendingSecrets("une-autre-conversation")).toHaveLength(0);

    // L'humain fournit la valeur : elle est rangée au coffre, RIEN n'est exécuté.
    const submitted = await s.execution.submitSecret(result.request.id, {
      YUKI_SECRET_WIFI: SECRET_VALUE,
    });
    expect(submitted.ok).toBe(true);
    if (submitted.ok) {
      // ⚠️ Pas de résultat d'exécution : il n'y avait pas de commande.
      expect(submitted.outcome).toBeUndefined();
    }
    expect(received.filter((f) => f["type"] === "cmd")).toHaveLength(0);
    expect(store.lookup("YUKI_SECRET_WIFI")).toBe(SECRET_VALUE);
    // La demande a disparu du registre (fournie).
    expect(s.execution.pendingSecrets("sess-conversation")).toHaveLength(0);
  });

  it("coffre VERROUILLÉ ⇒ refus honnête, aucune fenêtre", () => {
    const { store, requests } = secretStack({ configured: false });
    return startTestStack({ secrets: store, secretRequests: requests }).then((s) => {
      stacks.push(s);
      const result = s.execution.requestSecret({ names: ["YUKI_SECRET_X"], purpose: "test" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("vault_locked");
      expect(s.execution.pendingSecrets("sess")).toHaveLength(0);
    });
  });
});

describe("Secrets — agent SANS validation (`never`) : le flux DÉDIÉ le couvre", () => {
  it("une référence manquante demande le secret AU LIEU de refuser, puis rejoue la commande", async () => {
    const { store, requests } = secretStack();
    const s = await startTestStack({ secrets: store, secretRequests: requests });
    stacks.push(s);
    const agentId = "agent-sans-validation";
    const { ws, received } = await connectAgent(s, agentId);
    // ⚠️ Niveau `never` : AUCUNE validation humaine — c'est le cas que le flux
    // de secret DÉDIÉ doit couvrir (il ne dépend pas de la validation).
    s.store.setLevel(agentId, "never");
    ws.on("message", (data: Buffer) => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>;
      if (frame["type"] !== "cmd") return;
      send(ws, { type: "ack", cmd_id: frame["cmd_id"] as string });
      send(ws, { type: "result", cmd_id: frame["cmd_id"] as string, exit_code: 0, stdout: "ok\n" });
    });

    const first = await s.execution.execute({
      agentId,
      command: "sshpass -p ${YUKI_SECRET_NAS} ssh nas",
    });
    // ⚠️ Ni validation ni refus : une DEMANDE de secret.
    expect(first.status).toBe("awaiting_secret");
    expect(first.secretNames).toEqual(["YUKI_SECRET_NAS"]);
    expect(received.filter((f) => f["type"] === "cmd")).toHaveLength(0);

    const submitted = await s.execution.submitSecret(first.secretRequestId as string, {
      YUKI_SECRET_NAS: SECRET_VALUE,
    });
    expect(submitted.ok).toBe(true);
    if (submitted.ok) expect(submitted.outcome?.status).toBe("completed");
    const cmd = received.find((f) => f["type"] === "cmd") as Record<string, unknown>;
    expect(cmd["env"]).toEqual({ YUKI_SECRET_NAS: SECRET_VALUE });
    expect(String(cmd["command"])).not.toContain(SECRET_VALUE);
  });
});
