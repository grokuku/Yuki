/**
 * Intégration — RÉSULTAT d'une commande VALIDÉE renvoyé AU MODÈLE, corrélé par
 * `approval_id` (transport WS réel, service réel, registre réel).
 *
 * Ce que l'on verrouille :
 *   - après « Valider », le modèle reçoit un rapport SYNTHÉTIQUE portant
 *     stdout, stderr et le code de sortie, avec l'`approval_id` EXACT ;
 *   - l'humain continue de recevoir la trame éphémère `approval_result` ;
 *   - deux commandes successives ⇒ deux rapports, chacun rattaché au BON id ;
 *   - une sortie tronquée est VISIBLE (`tronquee: oui`) ;
 *   - ÉPHÉMÉRITÉ : le rapport n'apparaît NI dans le rejeu, NI dans le snapshot,
 *     NI dans le transcript de l'UI (miroir du host réel).
 */

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { APPROVAL_RESULT_HEADER, ORIGIN_APPROVAL_RESULT } from "../../src/agents/approval-report.js";
import { REPORT_MAX_CHARS } from "../../src/delegation/report.js";
import { startTestStack, type TestStack } from "../agents/stack.js";
import { startHarness, TestClient, type Harness } from "../gateway/ws/harness.js";

const stacks: TestStack[] = [];
const harnesses: Harness[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  for (const h of harnesses.splice(0)) await h.close();
  for (const s of stacks.splice(0)) {
    await s.close();
    s.cleanup();
  }
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Report {
  sessionId: string;
  text: string;
  origin?: string;
}

interface Rig {
  stack: TestStack;
  client: TestClient;
  harness: Harness;
  cmds: Array<Record<string, unknown>>;
  reports: Report[];
  setResult(fn: (cmd: Record<string, unknown>) => Record<string, unknown>): void;
}

/** Monte la pile réelle + l'agent simulé (auto-ack) + le transport WS réel. */
async function startRig(): Promise<Rig> {
  const stack = await startTestStack();
  stacks.push(stack);
  const agentId = "agent-nuc00";
  stack.register(agentId);
  const cert = stack.ca.signClientCertificate(agentId);
  const cmds: Array<Record<string, unknown>> = [];
  let result: (cmd: Record<string, unknown>) => Record<string, unknown> = () => ({
    exit_code: 0,
    stdout: "",
    stderr: "",
    duration_ms: 1,
  });
  const ws = new WebSocket(`wss://127.0.0.1:${stack.port}/ws`, {
    cert: cert.certPem,
    key: cert.keyPem,
    ca: stack.ca.certificatePem,
    rejectUnauthorized: true,
  });
  sockets.push(ws);
  ws.on("message", (data: Buffer) => {
    const frame = JSON.parse(data.toString()) as Record<string, unknown>;
    if (frame["type"] !== "cmd") return;
    cmds.push(frame);
    const id = frame["cmd_id"] as string;
    ws.send(JSON.stringify({ proto_version: 1, type: "ack", cmd_id: id }));
    ws.send(JSON.stringify({ proto_version: 1, type: "result", cmd_id: id, ...result(frame) }));
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  while (!stack.hub.isOnline(agentId)) await delay(10);

  const harness = await startHarness({
    sessionId: "sess-1",
    approvals: stack.execution,
    agents: {
      list: () =>
        stack.store.list().map((record) => ({
          agentId: record.agentId,
          name: record.name !== "" ? record.name : record.agentId,
          level: record.level,
          revoked: record.revoked,
          online: stack.hub.isOnline(record.agentId),
        })),
      setEnabled: (id, enabled) => stack.store.setEnabled(id, enabled),
      setLevel: (id, level) => stack.store.setLevel(id, level),
      subscribe: (listener) => stack.store.subscribe(listener),
    },
  });
  harnesses.push(harness);
  const client = await TestClient.connect(harness.url);
  client.send({ type: "hello", clientVersion: "1" });
  await client.waitFor((f) => f.type === "welcome");
  await client.waitFor((f) => f.type === "snapshot");

  // Le WAKER est le host RÉEL du harnais : le rapport synthétique traverse donc
  // réellement le transport (et l'on peut prouver qu'il ne fuite pas).
  const reports: Report[] = [];
  stack.execution.setWaker({
    send: (sessionId, text, opts) => {
      reports.push({ sessionId, text, ...(opts?.origin !== undefined ? { origin: opts.origin } : {}) });
      return harness.host.send(sessionId, text, opts);
    },
  });

  return {
    stack,
    client,
    harness,
    cmds,
    reports,
    setResult: (fn) => {
      result = fn;
    },
  };
}

/** Demande + attend la trame d'approbation + clique « Valider ». */
async function approve(rig: Rig, command: string): Promise<string> {
  const out = await rig.stack.execution.execute({
    agentId: "agent-nuc00",
    command,
    sessionId: "sess-1",
    origin: "run_command",
  });
  expect(out.status).toBe("awaiting_validation");
  const approvalId = out.approvalId as string;
  expect(approvalId).toBeTruthy();
  await rig.client.waitFor((f) => f.type === "approval" && f.approval.id === approvalId, 2000);
  rig.client.send({ type: "approval_decision", id: approvalId, decision: "approve" });
  return approvalId;
}

describe("résultat de commande validée → modèle (corrélé par approval_id)", () => {
  it("succès : le modèle reçoit stdout + code de sortie, l'humain la trame éphémère", async () => {
    const rig = await startRig();
    rig.setResult(() => ({ exit_code: 0, stdout: "SORTIE-OK-UNIQUE\n", stderr: "", duration_ms: 4 }));
    const approvalId = await approve(rig, "rm -rf /srv/a");

    const frame = await rig.client.waitFor(
      (f) => f.type === "approval_result" && f.result.id === approvalId,
      3000,
    );
    if (frame.type !== "approval_result") throw new Error("trame résultat attendue");
    expect(frame.result.output).toContain("SORTIE-OK-UNIQUE");

    await delay(30);
    expect(rig.reports).toHaveLength(1);
    const report = rig.reports[0] as Report;
    expect(report.sessionId).toBe("sess-1");
    expect(report.origin).toBe(ORIGIN_APPROVAL_RESULT);
    expect(report.text.startsWith(APPROVAL_RESULT_HEADER)).toBe(true);
    expect(report.text).toContain(`approval_id: ${approvalId}`);
    expect(report.text).toContain("SORTIE-OK-UNIQUE");
    expect(report.text).toContain("code de sortie: 0");
    expect(report.text).toContain("tronquee: non");
  });

  it("échec (exit ≠ 0, stderr non vide) : le modèle voit le code ET le stderr", async () => {
    const rig = await startRig();
    rig.setResult(() => ({ exit_code: 3, stdout: "avant\n", stderr: "ERREUR-UNIQUE\n", duration_ms: 2 }));
    const approvalId = await approve(rig, "rm -rf /srv/b");

    await delay(40);
    expect(rig.reports).toHaveLength(1);
    const text = (rig.reports[0] as Report).text;
    expect(text).toContain(`approval_id: ${approvalId}`);
    expect(text).toContain("code de sortie: 3");
    expect(text).toContain("--- sortie standard ---");
    expect(text).toContain("avant");
    expect(text).toContain("--- sortie d'erreur ---");
    expect(text).toContain("ERREUR-UNIQUE");
  });

  it("sortie volumineuse : tronquée ET marqueur VISIBLE pour le modèle", async () => {
    const rig = await startRig();
    rig.setResult(() => ({
      exit_code: 0,
      stdout: "X".repeat(4000),
      stderr: "",
      duration_ms: 9,
      truncated: true,
      stdout_trunc: true,
    }));
    await approve(rig, "rm -rf /srv/volumineux");

    await delay(40);
    expect(rig.reports).toHaveLength(1);
    const text = (rig.reports[0] as Report).text;
    expect(text).toContain("tronquee: oui");
    expect(text).toMatch(/tronquee="oui"/);
  });

  it("deux commandes successives : chaque rapport porte le BON approval_id", async () => {
    const rig = await startRig();
    rig.setResult((cmd) => ({
      exit_code: 0,
      stdout: `MARQUEUR-${String(cmd["command"])}\n`,
      stderr: "",
      duration_ms: 1,
    }));

    const first = await approve(rig, "rm -rf /srv/one");
    await delay(30);
    const second = await approve(rig, "rm -rf /srv/two");
    await delay(40);

    expect(first).not.toBe(second);
    expect(rig.reports).toHaveLength(2);
    const [r1, r2] = rig.reports as [Report, Report];
    expect(r1.text).toContain(`approval_id: ${first}`);
    expect(r1.text).toContain("MARQUEUR-rm -rf /srv/one");
    expect(r2.text).toContain(`approval_id: ${second}`);
    expect(r2.text).toContain("MARQUEUR-rm -rf /srv/two");
    // Corrélation STROITE : le rapport #1 ne mentionne pas l'id du #2.
    expect(r1.text).not.toContain(second);
    expect(r2.text).not.toContain(first);
  });

  it("plafond côté MODÈLE seulement : l'humain reçoit la sortie COMPLÈTE", async () => {
    const rig = await startRig();
    // 60 000 caractères : bien au-delà du plafond d'INJECTION au modèle.
    const gros = "H".repeat(60_000);
    rig.setResult(() => ({ exit_code: 0, stdout: gros, stderr: "", duration_ms: 7 }));
    const approvalId = await approve(rig, "rm -rf /srv/gros");

    const frame = await rig.client.waitFor(
      (f) => f.type === "approval_result" && f.result.id === approvalId,
      3000,
    );
    if (frame.type !== "approval_result") throw new Error("trame résultat attendue");
    // HUMAIN : la sortie complète est bien là, non coupée par Yuki.
    expect(frame.result.output).toContain(gros);

    await delay(60);
    expect(rig.reports).toHaveLength(1);
    const text = (rig.reports[0] as Report).text;
    // MODÈLE : borné au même plafond que le report de job, mais l'id ET le code
    // de sortie survivent.
    expect(text.length).toBeLessThanOrEqual(REPORT_MAX_CHARS);
    expect(text).toContain(`approval_id: ${approvalId}`);
    expect(text).toContain("code de sortie: 0");
    // La coupe est EXPLICITEMENT attribuée à Yuki (pas à la machine).
    expect(text).toContain("troncature_contexte: oui");
  });

  it("ÉPHÉMÉRITÉ : le rapport n'est NI dans le rejeu NI dans le snapshot NI dans le transcript", async () => {
    const rig = await startRig();
    const marqueur = "FUITE-INTERDITE-9f3a";
    rig.setResult(() => ({ exit_code: 0, stdout: `${marqueur}\n`, stderr: "", duration_ms: 1 }));
    await approve(rig, "rm -rf /srv/fuite");

    // Le tour synthétique a bien eu lieu (origine marquée)…
    const runStarted = await rig.client.waitFor(
      (f) => f.type === "run_started" && f.origin === ORIGIN_APPROVAL_RESULT,
      3000,
    );
    if (runStarted.type !== "run_started") throw new Error("run_started attendu");
    // ⚠️ … et il ne diffuse PAS son texte : aucun `userText`.
    expect((runStarted as { userText?: string }).userText).toBeUndefined();

    await delay(40);
    // (a) aucune trame déjà reçue ne contient le marqueur, HORS la trame
    //     éphémère destinée à l'HUMAIN (`approval_result`).
    const leaked = rig.client.frames.filter(
      (f) => f.type !== "approval_result" && JSON.stringify(f).includes(marqueur),
    );
    expect(leaked).toEqual([]);

    // (b) transcript de l'hôte (source du snapshot) : aucune trace non plus.
    const transcript = JSON.stringify(rig.harness.host.getState("sess-1")?.transcript ?? []);
    expect(transcript).not.toContain(marqueur);

    // (c) REJEU : un client NEUF qui se reconnecte (fromSeq 0) ne reçoit ni le
    //     rapport ni le marqueur (ni dans le rejeu, ni dans un snapshot).
    const fresh = await TestClient.connect(rig.harness.url);
    fresh.send({ type: "hello", clientVersion: "1" });
    await fresh.waitFor((f) => f.type === "snapshot", 3000);
    fresh.send({ type: "resume", sessionId: "sess-1", fromSeq: 0 });
    await delay(50);
    const freshLeaked = fresh.frames.filter(
      (f) => f.type !== "approval_result" && JSON.stringify(f).includes(marqueur),
    );
    expect(freshLeaked).toEqual([]);
    await fresh.close();
  });
});
