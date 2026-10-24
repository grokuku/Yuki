/**
 * API du mot de passe d'INSTANCE et du DÉVERROUILLAGE des agents sensibles.
 *
 * Ce que ces tests prouvent :
 *  - le mot de passe n'est JAMAIS renvoyé (ni par `GET /api/config/password`, ni
 *    par `GET /api/agents`), JAMAIS journalisé, JAMAIS audité — assertions sur
 *    les OCTETS des sorties RÉELLES (lignes de log du sink, fichier d'audit) ;
 *  - mauvais mot de passe ⇒ refus (403) ; bon ⇒ déverrouillé ;
 *  - changer le mot de passe exige l'ANCIEN ;
 *  - la coche « matériel sensible » est REFUSÉE (409) tant qu'aucun mot de passe
 *    n'est défini, et ACCEPTÉE ensuite ;
 *  - retirer le mot de passe est REFUSÉ tant qu'un agent sensible existe ;
 *  - les garde-fous d'écriture (en-têtes) restent appliqués.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AgentLockService,
  AgentStore,
  AuditLog,
  maxSizeBytesFromMb,
} from "../../src/agents/index.js";
import type { AgentsApiDeps } from "../../src/gateway/routes/agents.js";
import {
  handleAgentsRequest,
} from "../../src/gateway/routes/agents.js";
import { handleConfigRequest } from "../../src/gateway/routes/config.js";
import { InstancePasswordStore } from "../../src/security/instance-password.js";
import { createLogger } from "../../src/observability/logger.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-password-api-"));
  dirs.push(dir);
  return dir;
}

const PASSWORD = "mot-de-passe-instance-42";
const NEW_PASSWORD = "mot-de-passe-instance-43";

interface Harness {
  dir: string;
  store: AgentStore;
  lock: AgentLockService;
  password: InstancePasswordStore;
  audit: AuditLog;
  agentsDeps: AgentsApiDeps;
  configDeps: Record<string, unknown>;
  logLines: string[];
  /** Valeurs reçues par l'API et mémorisées pour le masquage (comme en prod). */
  secretsSeen: string[];
}

function harness(): Harness {
  const dir = tempDir();
  const logLines: string[] = [];
  // ⚠️ Comme en production (`src/index.ts`) : liste MUTABLE partagée par le
  // logger ET l'audit. Une valeur reçue par l'API y est ajoutée, donc toute
  // fuite accidentelle ultérieure est MASQUÉE.
  const secretValues: string[] = [];
  const secretsSeen: string[] = [];
  const onSecretSeen = (value: string): void => {
    if (value.length < 6) return;
    if (!secretValues.includes(value)) secretValues.push(value);
    secretsSeen.push(value);
  };
  const logger = createLogger({
    level: "info",
    sink: (line) => logLines.push(line),
    secretValues,
  });
  const password = InstancePasswordStore.open({ path: join(dir, "instance-password.json") });
  const store = AgentStore.open({
    path: join(dir, "agents.jsonl"),
    defaults: { level: "destructive", privilege: "normal" },
    logger,
    canMarkSensitive: () => password.isConfigured(),
  });
  const audit = AuditLog.open({
    path: join(dir, "audit.jsonl"),
    maxSizeBytes: maxSizeBytesFromMb(1),
    retentionDays: 30,
    secretValues,
    logger,
  });
  const lock = new AgentLockService({ store, password, logger });
  const agentsDeps: AgentsApiDeps = {
    pairing: { activeSessionCount: () => 0, submitCode: () => ({}) } as never,
    store,
    logger,
    audit,
    lock,
    onSecretSeen,
  };
  const configDeps = {
    runtime: {} as never,
    logger,
    password,
    sensitiveAgentCount: () =>
      store.list().filter((record) => record.sensitive === true && !record.revoked).length,
    onSecretSeen,
  };
  return {
    dir,
    store,
    lock,
    password,
    audit,
    agentsDeps,
    configDeps,
    logLines,
    secretsSeen,
  };
}

/** Écrit une ligne de log contenant une valeur (sink partagé du harnais). */
function loggerProbe(h: Harness, message: string): void {
  (h.configDeps as unknown as { logger: { info(m: string): void } }).logger.info(message);
}

const AGENTS_HEADERS = { "x-yuki-agents": "1" };
const CONFIG_HEADERS = { "x-yuki-config": "1" };

async function config(
  h: Harness,
  method: string,
  body: unknown = "",
  headers: Record<string, string> = CONFIG_HEADERS,
) {
  return handleConfigRequest({
    method,
    path: "/api/config/password",
    headers,
    body: body === "" ? "" : JSON.stringify(body),
    deps: h.configDeps as never,
  });
}

async function agents(
  h: Harness,
  method: string,
  path: string,
  body: unknown = "",
  headers: unknown = AGENTS_HEADERS,
) {
  return handleAgentsRequest({
    method,
    path,
    headers: headers as never,
    body: body === "" ? "" : JSON.stringify(body),
    ip: "127.0.0.1",
    deps: h.agentsDeps,
  });
}

describe("API — mot de passe d'instance", () => {
  it("GET ne renvoie jamais le mot de passe ni son haché (octets)", async () => {
    const h = harness();
    await config(h, "POST", { password: PASSWORD });
    const response = await config(h, "GET");
    expect(response.status).toBe(200);
    const raw = JSON.stringify(response.body);
    expect(raw).not.toContain(PASSWORD);
    expect(raw).toContain('"configured":true');
    // Le haché du fichier n'est pas non plus recopié dans l'API.
    const file = JSON.parse(readFileSync(h.password.filePath, "utf8")) as { hash: string };
    expect(raw).not.toContain(file.hash);
    expect(raw).not.toContain("hash");
  });

  it("POST définit puis CHANGE avec l'ANCIEN mot de passe exigé", async () => {
    const h = harness();
    expect((await config(h, "POST", { password: PASSWORD })).status).toBe(200);
    expect(h.password.verify(PASSWORD)).toBe(true);

    // Sans ancien mot de passe : refus explicite.
    const noCurrent = await config(h, "POST", { password: NEW_PASSWORD });
    expect(noCurrent.status).toBe(403);
    expect(JSON.stringify(noCurrent.body)).toMatch(/ancien mot de passe/i);

    // Ancien faux : refus.
    const wrongCurrent = await config(h, "POST", {
      password: NEW_PASSWORD,
      currentPassword: "faux-mot-de-passe",
    });
    expect(wrongCurrent.status).toBe(403);

    // Ancien correct : accepté.
    expect(
      (await config(h, "POST", { password: NEW_PASSWORD, currentPassword: PASSWORD })).status,
    ).toBe(200);
    expect(h.password.verify(NEW_PASSWORD)).toBe(true);
    expect(h.password.verify(PASSWORD)).toBe(false);
  });

  it("POST refuse un mot de passe trop court (message honnête)", async () => {
    const h = harness();
    const response = await config(h, "POST", { password: "court" });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toMatch(/trop court/i);
  });

  it("DELETE est REFUSÉ tant qu'un agent sensible existe", async () => {
    const h = harness();
    await config(h, "POST", { password: PASSWORD });
    h.store.markSeen("agent-1");
    h.store.setSensitive("agent-1", true);

    const refused = await config(h, "DELETE");
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toMatch(/matériel sensible/i);
    expect(h.password.isConfigured()).toBe(true);

    h.store.setSensitive("agent-1", false);
    expect((await config(h, "DELETE")).status).toBe(200);
    expect(h.password.isConfigured()).toBe(false);
  });

  it("les garde-fous d'écriture restent appliqués (en-tête exigé)", async () => {
    const h = harness();
    const response = await config(h, "POST", { password: PASSWORD }, {});
    expect(response.status).toBe(403);
    expect(h.password.isConfigured()).toBe(false);
  });

  it("le mot de passe n'apparaît NI dans les logs NI dans l'audit (octets)", async () => {
    const h = harness();
    h.store.markSeen("agent-1");
    await config(h, "POST", { password: PASSWORD });
    h.store.setSensitive("agent-1", true);
    const unlock = await agents(h, "POST", "/api/agents/agent-1/unlock", { password: PASSWORD });
    expect(unlock.status).toBe(200);

    // Les valeurs reçues ont bien été mémorisées pour le MASQUAGE.
    expect(h.secretsSeen).toContain(PASSWORD);

    for (const line of h.logLines) expect(line).not.toContain(PASSWORD);

    // ⚠️ Preuve que le masquage EXISTANT couvre ce mot de passe : on écrit une
    // entrée d'audit et une ligne de log qui le CONTIENNENT — elles sortent
    // masquées. (La valeur est donc bien dans la liste des valeurs secrètes.)
    h.audit.append({ event: "command", agentId: "agent-1", command: `echo ${PASSWORD}` });
    loggerProbe(h, `valeur=${PASSWORD}`);
    const audit = readFileSync(join(h.dir, "audit.jsonl"), "utf8");
    expect(audit).not.toContain(PASSWORD);
    expect(audit).toContain("[REDACTED]");
    expect(h.logLines.join("\n")).not.toContain(PASSWORD);
    // Et l'API des agents (liste) ne la contient pas non plus.
    const list = await agents(h, "GET", "/api/agents");
    expect(JSON.stringify(list.body)).not.toContain(PASSWORD);
  });
});

describe("API — coche « matériel sensible » et déverrouillage", () => {
  it("la coche est REFUSÉE (409) sans mot de passe d'instance", async () => {
    const h = harness();
    h.store.markSeen("agent-1");
    const response = await agents(h, "PATCH", "/api/agents/agent-1", { sensitive: true });
    expect(response.status).toBe(409);
    const raw = JSON.stringify(response.body);
    expect(raw).toContain("SENSITIVE_REQUIRES_PASSWORD");
    expect(raw).toMatch(/mot de passe d'instance/i);
    expect(h.store.get("agent-1")?.sensitive).toBe(false);
  });

  it("la coche est ACCEPTÉE une fois le mot de passe défini, et la liste expose l'état", async () => {
    const h = harness();
    await config(h, "POST", { password: PASSWORD });
    h.store.markSeen("agent-1");
    const response = await agents(h, "PATCH", "/api/agents/agent-1", { sensitive: true });
    expect(response.status).toBe(200);
    expect(h.store.get("agent-1")?.sensitive).toBe(true);

    const list = await agents(h, "GET", "/api/agents");
    const listRaw = JSON.stringify(list.body);
    expect(listRaw).toContain('"sensitive":true');
    // ⚠️ L'agent est VERROUILLÉ au démarrage (aucun déverrouillage en mémoire).
    expect(listRaw).toContain('"locked":true');
    // Le NIVEAU n'a pas été touché par la coche.
    expect(h.store.get("agent-1")?.level).toBe("destructive");
  });

  it("mauvais mot de passe ⇒ 403 et l'agent reste verrouillé ; bon ⇒ 200 et déverrouillé", async () => {
    const h = harness();
    await config(h, "POST", { password: PASSWORD });
    h.store.markSeen("agent-1");
    h.store.setSensitive("agent-1", true);

    const wrong = await agents(h, "POST", "/api/agents/agent-1/unlock", { password: "faux-secret-42" });
    expect(wrong.status).toBe(403);
    expect(h.lock.isLocked("agent-1")).toBe(true);

    const ok = await agents(h, "POST", "/api/agents/agent-1/unlock", { password: PASSWORD });
    expect(ok.status).toBe(200);
    expect(h.lock.isLocked("agent-1")).toBe(false);
    const body = ok.body as { remainingMs?: number; agent?: { locked?: boolean } };
    expect(body.agent?.locked).toBe(false);
    expect(body.remainingMs).toBeGreaterThan(0);
  });

  it("l'agent NON sensible n'a pas de verrou et le déverrouillage dit la VRAIE raison", async () => {
    const h = harness();
    await config(h, "POST", { password: PASSWORD });
    h.store.markSeen("ordinaire");
    const list = JSON.stringify((await agents(h, "GET", "/api/agents")).body);
    expect(list).toContain('"sensitive":false');
    expect(list).toContain('"locked":false');

    const response = await agents(h, "POST", "/api/agents/ordinaire/unlock", { password: PASSWORD });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain("agent_not_sensitive");
  });

  it("reverrouiller explicitement remet l'agent sous verrou sans toucher au NIVEAU", async () => {
    const h = harness();
    await config(h, "POST", { password: PASSWORD });
    h.store.markSeen("agent-1");
    h.store.setLevel("agent-1", "always");
    h.store.setSensitive("agent-1", true);
    const journalBefore = readFileSync(h.store.filePath, "utf8");

    await agents(h, "POST", "/api/agents/agent-1/unlock", { password: PASSWORD });
    expect(h.lock.isLocked("agent-1")).toBe(false);
    const relock = await agents(h, "POST", "/api/agents/agent-1/lock");
    expect(relock.status).toBe(200);
    expect(h.lock.isLocked("agent-1")).toBe(true);

    // ⚠️ PIÈGE N°1 : le reverrouillage n'écrit RIEN (aucun « Désactivé »).
    expect(readFileSync(h.store.filePath, "utf8")).toBe(journalBefore);
    expect(h.store.get("agent-1")?.level).toBe("always");
  });

  it("le déverrouillage exige l'en-tête d'écriture", async () => {
    const h = harness();
    await config(h, "POST", { password: PASSWORD });
    h.store.markSeen("agent-1");
    h.store.setSensitive("agent-1", true);
    const response = await agents(h, "POST", "/api/agents/agent-1/unlock", { password: PASSWORD }, {});
    expect(response.status).toBe(403);
    expect(h.lock.isLocked("agent-1")).toBe(true);
  });
});
