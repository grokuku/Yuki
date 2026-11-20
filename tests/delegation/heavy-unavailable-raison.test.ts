/**
 * `heavy_unavailable` N'EST PLUS MUET (audit 2026-11-20, défaut ②).
 *
 * ⚠️ LE DÉFAUT VERROUILLÉ : quand aucun worker n'était disponible pour un bot,
 * `delegate` répondait `{ status: "unavailable", reason: "heavy_unavailable" }`
 * — sans aucune phrase. Le modèle inventait alors une cause (« le worker est en
 * panne ») ou répétait l'échec sans comprendre.
 *
 * Ce fichier prouve que la raison du registre de workers (`refusLisible`) est
 * TRANSMISE au modèle dans `note`, et qu'aucun job n'est créé.
 *
 * ⚠️ Échoue sur le code d'origine : `DelegationServiceOptions.workerRefus`
 * n'existe pas et `DelegateUnavailable` n'a pas de champ `note`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDelegationService,
  portDelegationBot,
  type ModelAvailability,
} from "../../src/delegation/index.js";
import { JobQueue, JobStore } from "../../src/jobs/index.js";
import { createLogger } from "../../src/observability/logger.js";
import { FakeHeavyWorker } from "./fake-heavy-worker.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function service(workerRefus: (botId: string | undefined) => string | undefined) {
  const dir = mkdtempSync(join(tmpdir(), "yuki-heavy-raison-"));
  tempDirs.push(dir);
  const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
  const store = JobStore.open({ path: join(dir, "jobs.jsonl"), logger });
  const availability: ModelAvailability = { isAvailable: () => true };
  return {
    store,
    service: createDelegationService({
      store,
      queue: new JobQueue({ maxConcurrent: 3, maxQueue: 10 }),
      heavy: new FakeHeavyWorker() as never,
      // Aucun worker pour le bot demandeur.
      heavyPour: () => undefined,
      workerRefus,
      availability,
      logger,
      idleTimeoutMs: 120_000,
      totalTimeoutMs: 1_200_000,
    }),
  };
}

describe("un worker indisponible est DIT au modèle", () => {
  it("la note du registre arrive dans la réponse, aucun job n'est créé", async () => {
    const banc = service(
      (botId) =>
        `tous les workers lourds sont occupés : plafond de 2 atteint (yuki, b2) — bot « ${botId} ».`,
    );
    const outcome = await portDelegationBot(banc.service, "b3").delegate({
      task: "tâche",
      lightSessionId: "sess-1",
    });
    expect(outcome.status).toBe("unavailable");
    expect(outcome).toMatchObject({
      status: "unavailable",
      reason: "heavy_unavailable",
      note: expect.stringContaining("tous les workers lourds sont occupés"),
    });
    expect(banc.store.size).toBe(0);
  });

  it("sans port de raison, la réponse reste explicite (jamais une chaîne vide)", async () => {
    const banc = service(() => undefined);
    const outcome = await portDelegationBot(banc.service, "b3").delegate({
      task: "tâche",
      lightSessionId: "sess-1",
    });
    expect(outcome).toMatchObject({
      status: "unavailable",
      reason: "heavy_unavailable",
      note: "aucun worker lourd n'est disponible pour ce bot.",
    });
  });
});
