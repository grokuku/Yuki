/**
 * ⚠️ LOT 36 (L11) — DÉLÉGATION PAR BOT.
 *
 * Ce que ces tests verrouillent : un job délégué par un bot SECONDAIRE lui
 * appartient. Il s'exécute avec SON worker, son rapport réveille SON host (et
 * pas celui du principal), la publication part chez lui avec SES fichiers, et
 * son origine de déclencheur se publie dans SON fil.
 *
 * ⚠️ Échoue sur le code d'origine : `JobRecord.botId`, `portDelegationBot`,
 * `heavyPour`/`wakerPour`/`declencheursPour` n'existent pas — le rapport d'un
 * job de `kohai` réveillait le host du principal.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDelegationService,
  evenementsDuBot,
  grouperParBot,
  portDelegationBot,
  type HeavyWorker,
  type LightWaker,
  type ModelAvailability,
} from "../../src/delegation/index.js";
import { JobQueue, JobStore } from "../../src/jobs/index.js";
import { createLogger } from "../../src/observability/logger.js";
import type { PiEvent } from "../../src/pi/types.js";
import { FakeHeavyWorker } from "./fake-heavy-worker.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });

interface Rapport {
  sessionId: string;
  text: string;
  fichiers?: readonly string[];
}

interface Banc {
  service: ReturnType<typeof createDelegationService>;
  store: JobStore;
  kohai: FakeHeavyWorker;
  yuki: FakeHeavyWorker;
  rapportsKohai: Rapport[];
  rapportsYuki: Rapport[];
  declencheursKohai: string[];
  declencheursYuki: string[];
  evenements: PiEvent[];
  flush: () => void;
}

/**
 * Banc : UN service (comme en production) et DEUX bots — `yuki` (la pile) et
 * `kohai` (secondaire). Chaque bot a SON worker et SON réveil.
 */
function banc(): Banc {
  const dir = mkdtempSync(join(tmpdir(), "yuki-deleg-bot-"));
  tempDirs.push(dir);
  const store = JobStore.open({ path: join(dir, "jobs.jsonl"), logger });
  const queue = new JobQueue({ maxConcurrent: 3, maxQueue: 10 });
  const yuki = new FakeHeavyWorker();
  const kohai = new FakeHeavyWorker();
  const rapportsKohai: Rapport[] = [];
  const rapportsYuki: Rapport[] = [];
  const declencheursKohai: string[] = [];
  const declencheursYuki: string[] = [];
  const evenements: PiEvent[] = [];

  const reveil = (rapports: Rapport[]): LightWaker => ({
    send: (sessionId, text, opts) => {
      rapports.push({
        sessionId,
        text,
        ...(opts?.fichiers !== undefined ? { fichiers: opts.fichiers } : {}),
      });
      return { runId: "run-report" };
    },
  });

  const availability: ModelAvailability = { isAvailable: () => true };
  const service = createDelegationService({
    store,
    queue,
    heavy: yuki,
    heavyPour: (botId) =>
      botId === undefined || botId === "yuki" ? (yuki as HeavyWorker) : (kohai as HeavyWorker),
    availability,
    logger,
    idleTimeoutMs: 120_000,
    totalTimeoutMs: 1_200_000,
    // Livraison immédiate : les lots de résultats ne sont pas le sujet ici.
    resultBatchWindowMs: 0,
  });
  service.subscribe((event) => evenements.push(event));
  const reveilYuki = reveil(rapportsYuki);
  service.setWaker(reveilYuki);
  service.setWakerPour((botId) =>
    botId === undefined || botId === "yuki" ? reveilYuki : reveil(rapportsKohai),
  );
  service.setDeclencheurs({
    recevoirResultat: (record) => {
      declencheursYuki.push(record.id);
    },
  });
  service.setDeclencheursPour((botId) =>
    botId === undefined || botId === "yuki"
      ? {
          recevoirResultat: (record) => {
            declencheursYuki.push(record.id);
          },
        }
      : {
          recevoirResultat: (record) => {
            declencheursKohai.push(record.id);
          },
        },
  );

  return {
    service,
    store,
    kohai,
    yuki,
    rapportsKohai,
    rapportsYuki,
    declencheursKohai,
    declencheursYuki,
    evenements,
    flush: () => (service as { flushPendingReports(): void }).flushPendingReports(),
  };
}

async function attendre(predicat: () => boolean, ms = 2_000): Promise<void> {
  const debut = Date.now();
  while (!predicat()) {
    if (Date.now() - debut > ms) throw new Error("timeout en attendant le job");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe("délégation par bot (lot 36, L11)", () => {
  it("un job de `kohai` ne réveille PAS `yuki` : il réveille SON host", async () => {
    const b = banc();
    const portKohai = portDelegationBot(b.service, "kohai");

    const issue = await portKohai.delegate({ task: "résume", lightSessionId: "sess-kohai" });
    expect(issue.status).toBe("dispatched");
    const jobId = (issue as { job_id: string }).job_id;

    // ⚠️ L'identité du DEMANDEUR est JOURNALISÉE avec le job (source de vérité).
    expect(b.store.get(jobId)?.botId).toBe("kohai");
    // Le worker de `kohai` a exécuté la tâche ; celui de `yuki` n'a rien vu.
    await attendre(() => b.rapportsKohai.length > 0);
    expect(b.kohai.runs).toHaveLength(1);
    expect(b.yuki.runs).toHaveLength(0);

    // ⚠️ TEST CENTRAL : le rapport est chez `kohai`, et le principal est MUET.
    expect(b.rapportsKohai[0]?.sessionId).toBe("sess-kohai");
    expect(b.rapportsYuki).toEqual([]);
  });

  it("les FICHIERS du job sont publiés avec le rapport du bot demandeur", async () => {
    const b = banc();
    b.kohai.push({ result: { status: "completed", text: "image prête", fichiers: ["f-1"] } });

    await portDelegationBot(b.service, "kohai").delegate({
      task: "génère une image",
      lightSessionId: "sess-kohai",
    });

    await attendre(() => b.rapportsKohai.length > 0);
    expect(b.rapportsKohai[0]?.fichiers).toEqual(["f-1"]);
    expect(b.rapportsYuki).toEqual([]);
  });

  it("le résultat d'un DÉCLENCHEUR se publie dans le fil du bot du job", async () => {
    const b = banc();
    b.kohai.push({ result: { status: "completed", text: "résultat planifié" } });

    await portDelegationBot(b.service, "kohai").delegate({
      task: "tâche planifiée",
      lightSessionId: "fils-declencheurs-kohai",
      origin: "declencheur:hebdo",
    });

    await attendre(() => b.declencheursKohai.length > 0);
    // ⚠️ Un job de déclencheur ne réveille PERSONNE, et ne publie pas chez yuki.
    expect(b.declencheursKohai).toHaveLength(1);
    expect(b.declencheursYuki).toEqual([]);
    expect(b.rapportsKohai).toEqual([]);
    expect(b.rapportsYuki).toEqual([]);
  });

  it("le PRINCIPAL est inchangé : job sans botId ou port du principal ⇒ son réveil, son worker", async () => {
    const b = banc();

    // ① Port HISTORIQUE : aucune identité posée (comme avant L11).
    await b.service.delegate({ task: "tâche du principal", lightSessionId: "sess-yuki" });
    await attendre(() => b.rapportsYuki.length > 0);
    const historique = b.store.list()[0];
    expect(historique?.botId).toBeUndefined();
    expect(historique?.lightSessionId).toBe("sess-yuki");

    // ② Port DU PRINCIPAL (nommé) : même réveil, même worker, identité posée.
    const portYuki = portDelegationBot(b.service, "yuki");
    const issue = await portYuki.delegate({
      task: "tâche nommée du principal",
      lightSessionId: "sess-yuki-2",
    });
    const jobId = (issue as { job_id: string }).job_id;
    expect(b.store.get(jobId)?.botId).toBe("yuki");
    await attendre(() => b.rapportsYuki.length >= 2);

    // Un seul bot a travaillé et réveillé : `yuki`.
    expect(b.yuki.runs).toHaveLength(2);
    expect(b.kohai.runs).toHaveLength(0);
    expect(b.rapportsKohai).toEqual([]);
  });

  it("les ÉVÉNEMENTS d'un job portent son bot, et la source filtrée ne relaie que les siens", async () => {
    const b = banc();
    const sourceKohai = evenementsDuBot(b.service, b.service, "kohai");
    const recus: PiEvent[] = [];
    sourceKohai.subscribe((event) => recus.push(event));

    await portDelegationBot(b.service, "kohai").delegate({
      task: "tâche de kohai",
      lightSessionId: "sess-kohai",
    });
    await b.service.delegate({ task: "tâche de yuki", lightSessionId: "sess-yuki" });
    await attendre(() => recus.some((event) => event.type === "job_report"));

    // Les événements de job émis portent leur bot (un par job).
    const debut = b.evenements.filter((event) => event.type === "job_started");
    expect(debut.map((event) => (event as { botId?: string }).botId)).toEqual([
      "kohai",
      undefined,
    ]);
    // La source de `kohai` ne relaie QUE son job.
    expect(
      recus.every(
        (event) =>
          "jobId" in event &&
          b.store.get(String((event as { jobId?: string }).jobId))?.botId === "kohai",
      ),
    ).toBe(true);
    expect(recus.some((event) => event.type === "job_report")).toBe(true);
  });

  it("grouperParBot isole les jobs de deux bots (un lot = un réveil par bot)", async () => {
    const b = banc();
    await portDelegationBot(b.service, "kohai").delegate({ task: "k", lightSessionId: "s-k" });
    await b.service.delegate({ task: "y", lightSessionId: "s-y" });
    await attendre(() => b.rapportsYuki.length >= 1 && b.rapportsKohai.length >= 1);

    const groupes = grouperParBot(b.store.list());
    expect(groupes.map(([botId]) => botId).sort()).toEqual(["kohai", undefined] as never);
  });
});

/**
 * ⚠️ GARDE DE CÂBLAGE (source) : `main()` n'est pas importable (`src/index.ts`
 * exécute `main()` au chargement), donc ce que le démarrage BRANCHE est vérifié
 * ici, sur le texte du fichier — même précédent que
 * `tests/pi/sdk-host-programmer-envoi.test.ts`.
 *
 * Elle prouve que les trois porteurs par bot sont réellement branchés : sans
 * cela, les modules seraient corrects et le produit inchangé (le défaut de L11).
 */
describe("câblage du démarrage (garde de source, lot 36 L11)", () => {
  const index = readFileSync(join(process.cwd(), "src", "index.ts"), "utf8");

  it("le réveil, le worker et les déclencheurs sont résolus PAR BOT", () => {
    expect(index).toContain("delegation?.setWakerPour(reveilDuBot)");
    expect(index).toContain("heavyPour: (botId) =>");
    expect(index).toContain("delegation?.setDeclencheursPour(");
    // Le job d'un déclencheur porte le bot de SA pile.
    const port = index.slice(index.indexOf("const portsDeclencheurPour = ("));
    expect(port.slice(0, 1_400)).toContain("botId,");
  });

  it("le host d'un bot reçoit SA mémoire, SON port de délégation et SES événements", () => {
    expect(index).toContain("servicesMemoire?.pour(botId)");
    expect(index).toContain("const portDelegation = delegationPourBot(botId);");
    expect(index).toContain("const sourceEvenements = evenementsDuBotPour(botId);");
    // ⚠️ L'ancien branchement (UN port de pré-autorisations pour tous) a disparu.
    expect(index).not.toContain(
      "pourChacun((execution) => execution.setPreAutorisations(portPreAutos))",
    );
    expect(index).toContain("brancherPreAutorisationsParBot(executionsAgents");
  });

  it("le TTS lit la configuration DU BOT qui parle", () => {
    expect(index).toContain("configPour: (botId) => {");
    expect(index).toContain("const cfg = botId === undefined ? config : (configsBots.get(botId) ?? config);");
  });
});
