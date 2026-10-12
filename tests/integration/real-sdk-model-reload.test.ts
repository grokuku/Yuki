/**
 * SDK Pi RÉEL — rechargement de modèle À CHAUD — opt-in uniquement.
 *
 * Sans `YUKI_TEST_REAL_PI=1`, ce fichier est entièrement ignoré. Il vérifie sur
 * le VRAI SDK que `PiHost.applyLlmConfig` re-cible une session persistée sur un
 * nouveau modèle SANS redémarrage :
 *   - `models.json` est réécrit (`pi.models.written`) ;
 *   - le runtime de modèles PARTAGÉ est rafraîchi et la nouvelle référence est
 *     résolue (`pi.model.reloaded` avec `model-b`) ;
 *   - la session reçoit le nouveau modèle par `setModel` — accepté par le SDK
 *     (`pi.model.switched`), donc le PROCHAIN tour partira avec `model-b`.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildModelsConfigFrom, type EffectiveLlmConfig } from "../../src/llm/index.js";
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
  const root = mkdtempSync(join(tmpdir(), "yuki-real-model-"));
  tempDirs.push(root);
  return {
    agentDir: join(root, "agent"),
    home: join(root, "home"),
    cwd: join(root, "workspace"),
    sessionsDir: join(root, "agent", "sessions"),
  };
}

function effective(model: string): EffectiveLlmConfig {
  const role = {
    api: "openai-completions",
    baseUrl: "https://ollama.com/v1",
    model,
    thinking: "off" as const,
  };
  return { light: role, heavy: role };
}

beforeEach(() => {
  // `setModel` exige une authentification configurée pour le provider : on pose
  // une clé factice (aucun appel réseau n'est effectué par `applyLlmConfig`).
  process.env["YUKI_LLM_LIGHT_API_KEY"] = "sk-test-hot-reload-123456";
  process.env["YUKI_LLM_HEAVY_API_KEY"] = "sk-test-hot-reload-123456";
});

afterEach(() => {
  delete process.env["YUKI_LLM_LIGHT_API_KEY"];
  delete process.env["YUKI_LLM_HEAVY_API_KEY"];
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe.skipIf(!ENABLED)("SDK Pi réel — rechargement de modèle à chaud", () => {
  it("re-cible la session sur le nouveau modèle SANS redémarrer le host", async () => {
    const dirs = makeDirs();
    const lines: string[] = [];
    const logger = createLogger({
      level: "info",
      sink: (line: string) => lines.push(line),
      secretValues: [],
    });
    const host = createPiHost({
      agentDir: dirs.agentDir,
      cwd: dirs.cwd,
      home: dirs.home,
      sessionsDir: dirs.sessionsDir,
      systemPrompt: "prompt système de test",
      settingsSeedPath: "config/pi/settings.json",
      modelsConfig: buildModelsConfigFrom(effective("model-a")),
      model: "llm-light/model-a",
      thinking: "off",
      logger,
    });

    try {
      await host.start();
      const sessionId = host.currentSessionId();
      expect(sessionId).toEqual(expect.any(String));

      // Au démarrage : la session pointe sur `model-a` (aucune bascule encore).
      expect(lines.some((l) => l.includes("pi.model.switched"))).toBe(false);

      // Rechargement À CHAUD vers `model-b` (comme un « Enregistrer » de /config).
      expect(host.applyLlmConfig).toBeTypeOf("function");
      await host.applyLlmConfig!({
        modelsConfig: buildModelsConfigFrom(effective("model-b")),
        conversationModel: "llm-light/model-b",
        conversationThinking: "off",
      });

      // 1) `models.json` réécrit avec le nouveau modèle, SANS redémarrage.
      const models = readFileSync(join(dirs.agentDir, "models.json"), "utf8");
      expect(models).toContain("\"model-b\"");
      expect(models).not.toContain("\"model-a\"");

      // 2) Le nouveau modèle est résolu (runtime rafraîchi) et POUSSÉ à la
      //    session par le VRAI SDK (`setModel` accepté) : la prochaine requête
      //    de cette conversation partira donc avec `model-b`.
      expect(
        lines.some(
          (l) => l.includes("pi.model.reloaded") && l.includes("llm-light/model-b"),
        ),
      ).toBe(true);
      expect(
        lines.some(
          (l) =>
            l.includes("pi.model.switched") && l.includes("llm-light/model-b"),
        ),
      ).toBe(true);
      expect(lines.some((l) => l.includes("pi.model.switch.failed"))).toBe(false);
    } finally {
      await host.stop();
    }
  });
});
