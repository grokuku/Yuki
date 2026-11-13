/**
 * DÉLAI DES COMMANDES — le dépassement doit être DIT, et le délai BORNÉ.
 *
 * ⚠️ POURQUOI CES TESTS EXISTENT (production, 2026-11-02) : l'utilisateur a
 * demandé une mise à jour de Raspberry Pi (`apt update && apt upgrade -y`).
 * Yuki a répondu « la mise à jour n'a pas abouti : la tâche s'est interrompue
 * faute de réponse de la machine, sans jamais rendre la main ».
 *
 * Deux défauts sont verrouillés ici :
 *  ① le délai par défaut est de 60 s (`DEFAULT_COMMAND_TIMEOUT_MS`) alors qu'une
 *     montée de version dure 5 à 20 min : la commande était tuée au milieu, et
 *     le rapport ne disait RIEN de l'interruption (ni durée, ni « le système a
 *     peut-être été modifié ») ;
 *  ② le modèle pouvait demander n'importe quel délai (`timeout_ms`), sans
 *     plafond — 1 h par erreur monopolisait un worker.
 *
 * Ce que ces tests prouvent :
 *  - résultat avec `timed_out` ⇒ le bloc `<sortie>` ET le message disent
 *    « interrompue après X s » et que la machine a pu être modifiée ;
 *  - dépassement SANS résultat (borne côté Yuki) ⇒ message explicite : la
 *    commande AVAIT été transmise, son état final est inconnu ;
 *  - `timeout_ms` est CONFIGURABLE par appel et RAMENÉ dans ses bornes.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AgentChannelError,
  AgentExecutionService,
  AgentHub,
  AgentStore,
  ApprovalRegistry,
  AuditLog,
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_COMMAND_TIMEOUT_MS,
  MIN_COMMAND_TIMEOUT_MS,
  maxSizeBytesFromMb,
  resolveCommandTimeout,
} from "../../src/agents/index.js";
import type { OutboundCommand, ResultFrame } from "../../src/agents/protocol.js";
import { createLogger } from "../../src/observability/logger.js";

/** Bot EXPLICITE des constructions de store (aucun défaut implicite). */
const BOT_TEST = "yuki";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-exec-timeout-"));
  dirs.push(dir);
  return dir;
}

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });

/**
 * Hub FACTICE : enregistre ce qui PART réellement et rend le résultat (ou
 * l'erreur) que le test décide. Aucun réseau, aucun minuteur de 30 s.
 */
class ScriptedHub {
  readonly sent: Array<{ agentId: string; cmd: OutboundCommand }> = [];
  /** Résultat à rendre, ou l'erreur à lever. */
  outcome: { kind: "result"; result: Partial<ResultFrame> } | { kind: "error"; error: Error } = {
    kind: "result",
    result: {},
  };

  isOnline(): boolean {
    return true;
  }

  hasCapability(): boolean {
    return false;
  }

  get(): undefined {
    return undefined;
  }

  async sendCommand(agentId: string, cmd: OutboundCommand): Promise<ResultFrame> {
    this.sent.push({ agentId, cmd });
    if (this.outcome.kind === "error") throw this.outcome.error;
    return {
      cmdId: cmd.cmdId,
      exitCode: null,
      stdout: "",
      stderr: "",
      durationMs: 0,
      truncated: false,
      timedOut: false,
      stdoutTrunc: false,
      stderrTrunc: false,
      ...this.outcome.result,
    } as unknown as ResultFrame;
  }
}

interface Fixture {
  execution: AgentExecutionService;
  hub: ScriptedHub;
}

function fixture(): Fixture {
  const dir = tempDir();
  const store = AgentStore.open({
    path: join(dir, "agents.jsonl"),
    botCourant: () => BOT_TEST,
    defaults: { level: "never", privilege: "normal" },
    logger,
    canMarkSensitive: () => true,
  });
  const audit = AuditLog.open({
    path: join(dir, "audit.jsonl"),
    maxSizeBytes: maxSizeBytesFromMb(1),
    retentionDays: 30,
    logger,
  });
  const hub = new ScriptedHub();
  const execution = new AgentExecutionService({
    store,
    hub: hub as unknown as AgentHub,
    audit,
    approvals: new ApprovalRegistry({ logger }),
    logger,
  });
  store.markSeen("pi5");
  store.setLevel("pi5", "never");
  return { execution, hub };
}

describe("Délai de commande — bornes (option B : choix par appel + plafond dur)", () => {
  it("absent / non numérique ⇒ DÉFAUT de 60 s", () => {
    expect(resolveCommandTimeout(undefined)).toEqual({
      timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
      clamped: false,
    });
    expect(resolveCommandTimeout("900000").timeoutMs).toBe(DEFAULT_COMMAND_TIMEOUT_MS);
    expect(resolveCommandTimeout(Number.NaN).timeoutMs).toBe(DEFAULT_COMMAND_TIMEOUT_MS);
  });

  it("une action LONGUE est possible : 900000 ms est transmis tel quel", async () => {
    const f = fixture();
    const outcome = await f.execution.execute({
      agentId: "pi5",
      command: "apt update && apt upgrade -y",
      timeoutMs: MAX_COMMAND_TIMEOUT_MS,
    });
    expect(outcome.status).toBe("completed");
    // ⚠️ LA preuve : le délai DEMANDÉ est bien celui qui part vers la machine.
    expect(f.hub.sent[0]?.cmd.timeoutMs).toBe(MAX_COMMAND_TIMEOUT_MS);
  });

  it("au-delà du plafond ⇒ RAMENÉ au plafond (jamais 1 h)", async () => {
    const f = fixture();
    await f.execution.execute({ agentId: "pi5", command: "sleep 3600", timeoutMs: 3_600_000 });
    expect(f.hub.sent[0]?.cmd.timeoutMs).toBe(MAX_COMMAND_TIMEOUT_MS);
  });

  it("sous le plancher ⇒ RAMENÉ au plancher (jamais 0)", async () => {
    const f = fixture();
    await f.execution.execute({ agentId: "pi5", command: "true", timeoutMs: 5 });
    expect(f.hub.sent[0]?.cmd.timeoutMs).toBe(MIN_COMMAND_TIMEOUT_MS);
  });
});

describe("Délai de commande — le rapport DIT l'interruption", () => {
  it("commande TUÉE à l'expiration ⇒ « interrompue après X s » + système peut-être modifié", async () => {
    const f = fixture();
    f.hub.outcome = {
      kind: "result",
      result: {
        // ⚠️ `-1` et non `null` : `ResultFrame.exitCode` est un ENTIER sur le fil
        // (l'agent Go rend `128 + signal` pour un processus tué — 143 pour SIGTERM,
        // 137 pour SIGKILL — et `-1` quand l'état n'est pas connu,
        // `agent/internal/exec/proc_linux.go`). `null` n'existe que côté Yuki, où
        // aucune sortie n'a été reçue (`CommandOutcome.exitCode`).
        exitCode: -1,
        stdout: "Reading package lists...\n",
        timedOut: true,
        durationMs: 60_000,
      },
    };
    const outcome = await f.execution.execute({
      agentId: "pi5",
      command: "apt update && apt upgrade -y",
      timeoutMs: 60_000,
    });
    expect(outcome.status).toBe("completed");
    expect(outcome.timedOut).toBe(true);
    // ⚠️ Le bloc destiné au MODÈLE porte la phrase, pas seulement un attribut.
    expect(outcome.framed).toContain("COMMANDE INTERROMPUE après 60 s");
    expect(outcome.framed).toContain("peut-être déjà modifié le système");
    expect(outcome.framed).toContain('delai_depasse="oui"');
    // Le message court (rapport post-validation, résumés) le dit aussi.
    expect(outcome.message).toContain("INTERROMPUE après 60 s");
    expect(outcome.message).toContain("modifié le système");
  });

  it("dépassement SANS résultat ⇒ la commande était PARTIE, l'état final est inconnu", async () => {
    const f = fixture();
    f.hub.outcome = {
      kind: "error",
      error: new AgentChannelError("command_timeout", "Délai dépassé sans résultat.", {
        agentId: "pi5",
      }),
    };
    const outcome = await f.execution.execute({
      agentId: "pi5",
      command: "apt update && apt upgrade -y",
      timeoutMs: 600_000,
    });
    expect(outcome.status).toBe("timeout");
    // ⚠️ Le message brut du transport ne suffit PAS : il ne dit ni la durée, ni
    // que la commande est partie, ni qu'elle tourne peut-être encore.
    expect(outcome.message).not.toBe("Délai dépassé sans résultat.");
    expect(outcome.message).toContain("600 s");
    expect(outcome.message).toContain("AVAIT été transmise");
    expect(outcome.message).toContain("peut-être encore en cours");
    expect(outcome.message).toContain("modifié le système");
  });

  it("le bloc <sortie> d'une commande ORDINAIRE ne change pas", async () => {
    const f = fixture();
    f.hub.outcome = { kind: "result", result: { exitCode: 0, stdout: "ok\n" } };
    const outcome = await f.execution.execute({ agentId: "pi5", command: "echo ok" });
    expect(outcome.framed).toContain('delai_depasse="non"');
    expect(outcome.framed).not.toContain("INTERROMPUE");
    expect(outcome.message).toBe("Commande exécutée (code de sortie 0).");
  });
});
