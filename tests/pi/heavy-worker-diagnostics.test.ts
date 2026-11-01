/**
 * Tests — DIAGNOSTIC du worker lourd : la cause RÉELLE doit parler.
 *
 * ⚠️ POURQUOI CES TESTS EXISTENT (régression en usage réel, 2026-11-01) : la
 * délégation lourde échouait et l'utilisateur recevait TOUJOURS la même phrase
 *
 *   « Le fournisseur du modèle est momentanément indisponible ou injoignable. »
 *
 * alors que le fournisseur répondait parfaitement à la session LÉGÈRE. Deux
 * défauts distincts produisaient ce mensonge :
 *
 *  ① `describeModelError` (src/pi/errors.ts) rangeait les échecs INTERNES du SDK
 *     — « The configured model is unavailable in this process » — dans la famille
 *     « indisponibilité fournisseur » (le mot « unavailable » suffisait) ;
 *  ② le worker lourd ne JOURNALISAIT PAS la cause brute d'un message en erreur
 *     (`message_end`), ni ne la reprenait dans le rapport de job : impossible de
 *     savoir QUELLE cause avait été traduite.
 *
 * Ces tests verrouillent : l'échec interne est nommé INTERNE, la cause brute est
 * journalisée, et les échecs de démarrage (runtime / session) portent leur cause.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildModelsConfig } from "../../src/llm/index.js";
import { createLogger } from "../../src/observability/logger.js";
import { createSdkHeavyWorker, truncateCause } from "../../src/pi/index.js";
import { resolvePiPaths, seedSettingsFile, writeModelsFile } from "../../src/pi/config.js";
import type { EphemeralSession } from "../../src/pi/sdk/session-factory.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Cause INTERNE telle que le SDK la produit (registre de session incomplet). */
const SDK_INTERNAL_RAW = "The configured model is unavailable in this process";

/** Journal en mémoire : on vérifie ce qui est RÉELLEMENT écrit. */
interface CapturedLog {
  level: string;
  message: string;
  fields: Record<string, unknown>;
}

function captureLogger(logs: CapturedLog[]) {
  return createLogger({
    level: "warn",
    secretValues: [],
    sink: (line) => {
      const record = JSON.parse(line) as Record<string, unknown>;
      const { ts: _ts, level, msg, ...fields } = record;
      logs.push({ level: String(level), message: String(msg), fields });
    },
  });
}

interface Env {
  worker: ReturnType<typeof createSdkHeavyWorker>;
  logs: CapturedLog[];
  cwd: string;
  agentDir: string;
  modelsPath: string;
  authPath: string;
}

function makeEnv(createSession: unknown, logs: CapturedLog[]): Env {
  const root = mkdtempSync(join(tmpdir(), "yuki-heavy-diag-"));
  tempDirs.push(root);
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  const home = join(root, "home");
  const paths = resolvePiPaths({
    agentDir,
    cwd,
    home,
    sessionsDir: join(agentDir, "sessions"),
    settingsSeedPath: "config/pi/settings.json",
  });
  const logger = captureLogger(logs);
  seedSettingsFile(paths, logger);
  writeModelsFile(paths, buildModelsConfig(), logger);
  const worker = createSdkHeavyWorker({
    cwd: paths.cwd,
    agentDir: paths.agentDir,
    authPath: join(paths.agentDir, "auth.json"),
    modelsPath: paths.modelsPath,
    systemPrompt: "Tu es le worker lourd de test.",
    modelReference: "llm-heavy/deepseek-v4.1-flash",
    thinking: "off",
    tools: [],
    createSession: createSession as never,
    idleTimeoutMs: 5_000,
    totalTimeoutMs: 10_000,
    logger,
  });
  return {
    worker,
    logs,
    cwd: paths.cwd,
    agentDir: paths.agentDir,
    modelsPath: paths.modelsPath,
    authPath: join(paths.agentDir, "auth.json"),
  };
}

/** Session éphémère en double : joue un message assistant en ERREUR. */
function sessionEndingInError(raw: string) {
  type Listener = (event: unknown) => void;
  return async (): Promise<EphemeralSession> => {
    let listener: Listener | undefined;
    const session = {
      sessionId: "ephemeral-heavy-diag",
      subscribe(cb: Listener): () => void {
        listener = cb;
        return () => {
          listener = undefined;
        };
      },
      async prompt(): Promise<void> {
        listener?.({
          type: "message_end",
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: raw,
          },
        });
      },
      async abort(): Promise<void> {},
      dispose(): void {},
      async steer(): Promise<void> {},
    };
    return { session, diagnostics: [] } as unknown as EphemeralSession;
  };
}

describe("worker lourd — le diagnostic dit la VRAIE cause", () => {
  it("un échec INTERNE du SDK n'est jamais rapporté comme une panne de fournisseur", async () => {
    const logs: CapturedLog[] = [];
    const env = makeEnv(sessionEndingInError(SDK_INTERNAL_RAW), logs);
    const result = await env.worker
      .run({ jobId: "job-diag-1", task: "Tâche.", lightSessionId: "sess-1" } as never)
      .promise;

    expect(result.status).toBe("failed");
    const message = result.status === "failed" ? result.error : "";
    expect(message).toContain("Échec INTERNE");
    expect(message).not.toContain("indisponible");
    expect(message).not.toContain("injoignable");
    // La cause d'origine n'est pas effacée : elle est citée.
    expect(message).toContain("unavailable in this process");
  });

  it("la cause BRUTE du fournisseur est JOURNALISÉE (sinon la traduction est indiagnosticable)", async () => {
    const logs: CapturedLog[] = [];
    const env = makeEnv(sessionEndingInError("503: Service Unavailable"), logs);
    const result = await env.worker
      .run({ jobId: "job-diag-2", task: "Tâche.", lightSessionId: "sess-1" } as never)
      .promise;

    expect(result.status).toBe("failed");
    const entry = logs.find((log) => log.message === "heavy.prompt.error");
    expect(entry).toBeDefined();
    expect(entry?.fields["job_id"]).toBe("job-diag-2");
    expect(String(entry?.fields["error"])).toContain("503");
    expect(String(entry?.fields["error"])).toContain("Service Unavailable");
  });

  it("un échec de CRÉATION de session porte sa cause dans le rapport (plus de « voir les journaux » muet)", async () => {
    const logs: CapturedLog[] = [];
    const env = makeEnv(async () => {
      throw new Error("models.json illisible (volume en lecture seule)");
    }, logs);
    const result = await env.worker
      .run({ jobId: "job-diag-3", task: "Tâche.", lightSessionId: "sess-1" } as never)
      .promise;

    expect(result.status).toBe("failed");
    const message = result.status === "failed" ? result.error : "";
    expect(message).toContain("n'a pas pu être créée");
    expect(message).toContain("models.json illisible");
    // ⚠️ Assainie : la RÉFÉRENCE d'environnement reste visible, jamais une valeur.
    const logged = logs.find((log) => log.message === "heavy.session.failed");
    expect(String(logged?.fields["error"])).toContain("models.json illisible");
  });

  it("truncateCause borne la cause sans la vider", () => {
    expect(truncateCause("   ")).toBe("(aucun détail)");
    expect(truncateCause("a\n\nb")).toBe("a b");
    const long = truncateCause("x".repeat(1_000));
    expect(long.length).toBeLessThanOrEqual(300);
    expect(long.endsWith("…")).toBe(true);
  });
});
