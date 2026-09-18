/**
 * Intégration avec le SDK Pi RÉEL — opt-in uniquement.
 *
 * Sans `YUKI_TEST_REAL_PI=1`, ce fichier est entièrement ignoré : aucun réseau,
 * aucun modèle, aucun coût. Il vérifie que la façade démarre réellement le SDK
 * (runtime + session persistée) dans des répertoires temporaires, avec l'état
 * redirigé hors du rootfs.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createPiHost } from "../../src/pi/host.js";
import { createLogger } from "../../src/observability/logger.js";

const ENABLED = process.env["YUKI_TEST_REAL_PI"] === "1";

const tempDirs: string[] = [];

function makeDirs(): {
  agentDir: string;
  home: string;
  cwd: string;
  sessionsDir: string;
} {
  const root = mkdtempSync(join(tmpdir(), "yuki-real-pi-"));
  tempDirs.push(root);
  return {
    agentDir: join(root, "agent"),
    home: join(root, "home"),
    cwd: join(root, "workspace"),
    sessionsDir: join(root, "agent", "sessions"),
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe.skipIf(!ENABLED)("SDK Pi réel (opt-in)", () => {
  it("démarre le runtime, ouvre une session et la persiste", async () => {
    const dirs = makeDirs();
    const systemPrompt = readFileSync("config/pi/system-prompt.md", "utf8");
    const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });

    const host = createPiHost({
      agentDir: dirs.agentDir,
      cwd: dirs.cwd,
      home: dirs.home,
      sessionsDir: dirs.sessionsDir,
      systemPrompt,
      settingsSeedPath: "config/pi/settings.json",
      logger,
    });

    try {
      await host.start();
      expect(host.isReady()).toBe(true);
      const sessionId = host.currentSessionId();
      expect(sessionId).toEqual(expect.any(String));

      const state = host.getState();
      expect(state?.sessionId).toBe(sessionId);
      expect(state?.state).toBe("idle");
      expect(state?.transcript).toEqual([]);

      const sessions = await host.listSessions();
      expect(Array.isArray(sessions)).toBe(true);

      // Le seed de settings.json a bien été copié sur le volume.
      const seeded = JSON.parse(
        readFileSync(join(dirs.agentDir, "settings.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(seeded.defaultProjectTrust).toBe("never");
    } finally {
      await host.stop();
    }
  });

  it("expose un abonnement et rejette send avant start()", async () => {
    const dirs = makeDirs();
    const systemPrompt = readFileSync("config/pi/system-prompt.md", "utf8");
    const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
    const host = createPiHost({
      agentDir: dirs.agentDir,
      cwd: dirs.cwd,
      home: dirs.home,
      sessionsDir: dirs.sessionsDir,
      systemPrompt,
      settingsSeedPath: "config/pi/settings.json",
      logger,
    });
    try {
      expect(host.isReady()).toBe(false);
      expect(() => host.send("nope", "bonjour")).toThrowError(/prêt|ready/i);
      await host.start();
      expect(host.isReady()).toBe(true);
      const off = host.subscribeAll(() => undefined);
      expect(typeof off).toBe("function");
      off();
    } finally {
      await host.stop();
    }
  });
});
