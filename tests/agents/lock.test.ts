/**
 * VERROU « matériel sensible » — état SÉPARÉ du niveau de garde-fou.
 *
 * Ce que ces tests prouvent (exigences explicites de l'utilisateur) :
 *  - un agent sensible est VERROUILLÉ au démarrage et à chaque RECONNEXION ;
 *  - le déverrouillage exige le bon mot de passe d'instance (le mauvais est
 *    refusé, et l'agent reste verrouillé) ;
 *  - le reverrouillage suit une INACTIVITÉ GLISSANTE de 15 min : une commande
 *    RÉELLEMENT TRANSMISE remet le compte à zéro (horloge injectée, aucune
 *    attente réelle) ;
 *  - le NIVEAU de garde-fou N'EST PAS MODIFIÉ par un reverrouillage : assertion
 *    sur les OCTETS de `agents.jsonl` ;
 *  - un agent NON sensible n'est jamais verrouillé (aucune régression).
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AgentLockService,
  AgentStore,
  SENSITIVE_IDLE_TIMEOUT_MS,
  lockedAgentMessage,
  type AgentLockStatus,
} from "../../src/agents/index.js";
import {
  InstancePasswordStore,
} from "../../src/security/instance-password.js";
import { createLogger } from "../../src/observability/logger.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-lock-"));
  dirs.push(dir);
  return dir;
}

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
const PASSWORD = "mot-de-passe-instance-42";

interface Fixture {
  dir: string;
  store: AgentStore;
  password: InstancePasswordStore;
  lock: AgentLockService;
  clock: { now: number };
  advance(ms: number): void;
}

/**
 * Monte store + mot de passe d'instance + verrou avec une HORLOGE INJECTÉE.
 * Aucun test n'attend réellement 15 minutes.
 */
function fixture(options: { idleTimeoutMs?: number } = {}): Fixture {
  const dir = tempDir();
  const clock = { now: Date.parse("2026-10-24T10:00:00.000Z") };
  const password = InstancePasswordStore.open({ path: join(dir, "instance-password.json") });
  const store = AgentStore.open({
    path: join(dir, "agents.jsonl"),
    defaults: { level: "destructive", privilege: "normal" },
    logger,
    now: () => clock.now,
    canMarkSensitive: () => password.isConfigured(),
  });
  const lock = new AgentLockService({
    store,
    password,
    logger,
    now: () => clock.now,
    ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
  });
  return {
    dir,
    store,
    password,
    lock,
    clock,
    advance: (ms: number) => {
      clock.now += ms;
    },
  };
}

describe("AgentLockService — coche « matériel sensible »", () => {
  it("la coche est REFUSÉE sans mot de passe d'instance (agent sinon inutilisable)", () => {
    const f = fixture();
    f.store.markSeen("agent-1");
    expect(() => f.store.setSensitive("agent-1", true)).toThrowError(
      /aucun mot de passe d'instance/i,
    );
    // Vraie cause exposée côté code applicatif (pas un refus muet).
    try {
      f.store.setSensitive("agent-1", true);
    } catch (error) {
      expect((error as { code?: string }).code).toBe("SENSITIVE_REQUIRES_PASSWORD");
    }
    expect(f.store.get("agent-1")?.sensitive).toBe(false);
  });

  it("la coche est ACCEPTÉE quand un mot de passe d'instance existe, et PERSISTÉE", () => {
    const f = fixture();
    f.password.set(PASSWORD);
    f.store.markSeen("agent-1");
    expect(f.store.setSensitive("agent-1", true).sensitive).toBe(true);
    const journal = readFileSync(f.store.filePath, "utf8");
    expect(journal).toContain('"sensitive":true');
    // Le journal ne contient JAMAIS le mot de passe (il n'est pas haché ici).
    expect(journal).not.toContain(PASSWORD);
  });

  it("un enregistrement ANTÉRIEUR (sans le champ) rejoue à `sensitive: false`", () => {
    const dir = tempDir();
    const path = join(dir, "agents.jsonl");
    rmSync(path, { force: true });
    const store = AgentStore.open({
      path,
      defaults: { level: "destructive", privilege: "normal" },
      logger,
    });
    store.markSeen("agent-legacy");
    expect(store.get("agent-legacy")?.sensitive).toBe(false);
    // Et aucune coche n'est possible sans prédicat (défaut = refus).
    expect(() => store.setSensitive("agent-legacy", true)).toThrowError(
      /mot de passe d'instance/i,
    );
  });
});

describe("AgentLockService — verrouillage / déverrouillage", () => {
  it("un agent sensible est VERROUILLÉ au démarrage ; un agent ordinaire ne l'est jamais", () => {
    const f = fixture();
    f.password.set(PASSWORD);
    f.store.markSeen("sensible");
    f.store.setSensitive("sensible", true);
    f.store.markSeen("ordinaire");

    expect(f.lock.isLocked("sensible")).toBe(true);
    expect(f.lock.status("sensible")).toEqual({ sensitive: true, locked: true });
    expect(f.lock.isLocked("ordinaire")).toBe(false);
    expect(f.lock.status("ordinaire")).toEqual({ sensitive: false, locked: false });
  });

  it("mauvais mot de passe ⇒ REFUS (l'agent reste verrouillé) ; bon ⇒ déverrouillé", () => {
    const f = fixture();
    f.password.set(PASSWORD);
    f.store.markSeen("sensible");
    f.store.setSensitive("sensible", true);

    const wrong = f.lock.unlock("sensible", "mauvais-mot-de-passe");
    expect(wrong.ok).toBe(false);
    expect(wrong).toMatchObject({ code: "invalid_password" });
    expect(f.lock.isLocked("sensible")).toBe(true);

    const ok = f.lock.unlock("sensible", PASSWORD);
    expect(ok.ok).toBe(true);
    expect(f.lock.isLocked("sensible")).toBe(false);
    const status = f.lock.status("sensible") as AgentLockStatus;
    expect(status.locked).toBe(false);
    expect(status.remainingMs).toBe(SENSITIVE_IDLE_TIMEOUT_MS);
  });

  it("un agent NON sensible ne se déverrouille pas (cause RÉELLE, pas un faux succès)", () => {
    const f = fixture();
    f.password.set(PASSWORD);
    f.store.markSeen("ordinaire");
    const outcome = f.lock.unlock("ordinaire", PASSWORD);
    expect(outcome).toMatchObject({ ok: false, code: "agent_not_sensitive" });
  });

  it("INACTIVITÉ GLISSANTE : 15 min sans activité reverrouille, une activité remet à zéro", () => {
    const f = fixture();
    f.password.set(PASSWORD);
    f.store.markSeen("sensible");
    f.store.setSensitive("sensible", true);
    expect(f.lock.unlock("sensible", PASSWORD).ok).toBe(true);

    // 14 min : toujours déverrouillé.
    f.advance(14 * 60_000);
    expect(f.lock.isLocked("sensible")).toBe(false);

    // Une commande RÉELLEMENT TRANSMISE remet le compte à zéro…
    f.lock.touch("sensible");
    // … donc 14 min PLUS TARD (28 min après le déverrouillage) il est encore ouvert.
    f.advance(14 * 60_000);
    expect(f.lock.isLocked("sensible")).toBe(false);

    // 15 min pleines APRÈS la dernière activité ⇒ reverrouillé, TOUT SEUL.
    f.advance(60_000);
    expect(f.lock.isLocked("sensible")).toBe(true);
  });

  it("le temps restant est calculé sur l'activité (confort d'affichage)", () => {
    const f = fixture();
    f.password.set(PASSWORD);
    f.store.markSeen("sensible");
    f.store.setSensitive("sensible", true);
    f.lock.unlock("sensible", PASSWORD);
    f.advance(5 * 60_000);
    expect(f.lock.status("sensible").remainingMs).toBe(10 * 60_000);
    f.lock.touch("sensible");
    expect(f.lock.status("sensible").remainingMs).toBe(SENSITIVE_IDLE_TIMEOUT_MS);
  });

  it("un REFUS ne compte pas comme activité (touch sur un agent verrouillé est sans effet)", () => {
    const f = fixture();
    f.password.set(PASSWORD);
    f.store.markSeen("sensible");
    f.store.setSensitive("sensible", true);
    f.lock.unlock("sensible", PASSWORD);
    f.advance(SENSITIVE_IDLE_TIMEOUT_MS);
    expect(f.lock.isLocked("sensible")).toBe(true);
    f.lock.touch("sensible");
    f.advance(60_000);
    expect(f.lock.isLocked("sensible")).toBe(true);
  });

  it("RECONNEXION de l'agent ⇒ reverrouillé (nouveau cycle)", () => {
    const f = fixture();
    f.password.set(PASSWORD);
    f.store.markSeen("sensible");
    f.store.setSensitive("sensible", true);

    let online = ["sensible"];
    const listeners = new Set<() => void>();
    const hub = {
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      onlineIds: () => [...online],
    };
    f.lock.attachHub(hub);
    expect(f.lock.unlock("sensible", PASSWORD).ok).toBe(true);
    expect(f.lock.isLocked("sensible")).toBe(false);

    // Déconnexion puis reconnexion : le verrou doit se refermer.
    online = [];
    for (const listener of listeners) listener();
    online = ["sensible"];
    for (const listener of listeners) listener();
    expect(f.lock.isLocked("sensible")).toBe(true);
  });

  it("le NIVEAU de garde-fou est INCHANGÉ par le reverrouillage (octets du journal)", () => {
    const f = fixture();
    f.password.set(PASSWORD);
    f.store.markSeen("sensible");
    f.store.setLevel("sensible", "never");
    f.store.setSensitive("sensible", true);
    const before = readFileSync(f.store.filePath, "utf8");

    f.lock.unlock("sensible", PASSWORD);
    f.advance(SENSITIVE_IDLE_TIMEOUT_MS);
    expect(f.lock.isLocked("sensible")).toBe(true);
    f.lock.lockAll("test");

    const after = readFileSync(f.store.filePath, "utf8");
    // ⚠️ PIÈGE N°1 : aucun événement de NIVEAU n'a été écrit (« Désactivé »…).
    expect(after).toBe(before);
    expect(after).not.toContain('"disabled"');
    expect(f.store.get("sensible")?.level).toBe("never");
  });

  it("le balayage rend le reverrouillage visible et notifie les abonnés", () => {
    const f = fixture();
    f.password.set(PASSWORD);
    f.store.markSeen("sensible");
    f.store.setSensitive("sensible", true);
    let notifications = 0;
    f.lock.subscribe(() => {
      notifications += 1;
    });
    f.lock.unlock("sensible", PASSWORD);
    expect(notifications).toBe(1);
    f.advance(SENSITIVE_IDLE_TIMEOUT_MS);
    expect(f.lock.sweep()).toEqual(["sensible"]);
    expect(f.lock.isLocked("sensible")).toBe(true);
    expect(notifications).toBe(2);
  });

  it("le message de refus dit la VRAIE raison et n'invente rien", () => {
    const message = lockedAgentMessage("nuc00");
    expect(message).toContain("VERROUILLÉ");
    expect(message).toContain("n'a PAS été");
    expect(message).toContain("Déverrouiller");
    // ⚠️ Décision utilisateur n°4 : le modèle ne réclame JAMAIS de mot de passe.
    expect(message).toContain("Ne demande pas de mot de passe");
  });
});
