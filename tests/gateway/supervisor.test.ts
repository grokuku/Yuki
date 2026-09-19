/**
 * Superviseur interne (`infra/gateway/supervisor.mjs`).
 *
 * Testé en lançant un **faux enfant** (`tests/fixtures/supervisor/fake-child.mjs`)
 * plutôt qu'en tuant le processus de test :
 *  - relance sur le code convenu 75 (`EX_TEMPFAIL`, « redémarrage demandé ») ;
 *  - PAS de relance sur un autre code + propagation de ce code (panne visible) ;
 *  - relais de `SIGTERM` à l'enfant puis sortie propre ;
 *  - garde-fou anti-boucle (abandon après N relances rapprochées).
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SUPERVISOR = fileURLToPath(
  new URL("../../infra/gateway/supervisor.mjs", import.meta.url),
);
const FAKE_CHILD = fileURLToPath(
  new URL("../fixtures/supervisor/fake-child.mjs", import.meta.url),
);

interface SupervisorResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
}

interface RunOptions {
  /** Envoie SIGTERM au superviseur dès que N enfants ont démarré. */
  stopAfterRuns?: number;
  /** Filet de sécurité : SIGKILL le superviseur après ce délai. */
  killAfterMs?: number;
}

function runSupervisor(
  env: Record<string, string>,
  options: RunOptions = {},
): Promise<SupervisorResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SUPERVISOR, FAKE_CHILD], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stopSent = false;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const runs = (stdout.match(/fake-child run/g) ?? []).length;
      if (!stopSent && options.stopAfterRuns && runs >= options.stopAfterRuns) {
        stopSent = true;
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", () => {});
    const killer = setTimeout(() => {
      stopSent = true;
      child.kill("SIGKILL");
    }, options.killAfterMs ?? 10_000);
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      clearTimeout(killer);
      resolve({ code, signal, stdout });
    });
  });
}

const runsIn = (stdout: string): number =>
  (stdout.match(/fake-child run/g) ?? []).length;

describe("superviseur interne — relance, propagation, signaux, anti-boucle", () => {
  it("relance l'enfant quand il sort avec le code 75 (redémarrage demandé)", async () => {
    // L'enfant vit plus longtemps que le seuil « rapproché » : chaque sortie 75
    // est vue comme volontaire (pas d'anti-boucle). On envoie SIGTERM pendant
    // que le 2e enfant tourne (fenêtre large) → sortie propre déterministe.
    const result = await runSupervisor(
      {
        FAKE_EXIT_CODE: "75",
        FAKE_DELAY_MS: "400",
        YUKI_SUPERVISOR_RAPID_MS: "300",
      },
      { stopAfterRuns: 2 },
    );
    expect(runsIn(result.stdout)).toBeGreaterThanOrEqual(2);
    expect(result.stdout).toContain("redémarrage demandé (code 75)");
    expect(result.code).toBe(0); // arrêt volontaire (SIGTERM relayé)
  });

  it("ne relance PAS sur un autre code et propage ce code", async () => {
    const result = await runSupervisor({ FAKE_EXIT_CODE: "1", FAKE_DELAY_MS: "0" });
    expect(runsIn(result.stdout)).toBe(1);
    expect(result.stdout).toContain("pas de relance (panne)");
    expect(result.code).toBe(1);
  });

  it("propage un code 0 (sortie normale) sans relancer", async () => {
    const result = await runSupervisor({ FAKE_EXIT_CODE: "0", FAKE_DELAY_MS: "0" });
    expect(runsIn(result.stdout)).toBe(1);
    expect(result.code).toBe(0);
  });

  it("relaie SIGTERM à l'enfant puis termine proprement", async () => {
    const result = await runSupervisor(
      { FAKE_EXIT_CODE: "0", FAKE_DELAY_MS: "60000" },
      { stopAfterRuns: 1 },
    );
    expect(result.stdout).toContain("fake-child SIGTERM");
    expect(result.stdout).toContain("sortie du superviseur");
    expect(result.code).toBe(0);
  });

  it("garde-fou anti-boucle : abandonne après N relances rapprochées", async () => {
    const result = await runSupervisor({
      FAKE_EXIT_CODE: "75",
      FAKE_DELAY_MS: "0",
      YUKI_SUPERVISOR_RAPID_MS: "60000", // toute relance est « rapprochée »
      YUKI_SUPERVISOR_MAX_RESTARTS: "2",
    });
    expect(result.stdout).toContain("boucle détectée");
    expect(runsIn(result.stdout)).toBe(3); // 2 relances autorisées puis abandon
    expect(result.code).toBe(1);
  });
});
