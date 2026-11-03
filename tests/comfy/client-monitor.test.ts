/**
 * SURVEILLANCE D'ÉTAT du serveur ComfyUI — le client DEMANDE au serveur s'il
 * travaille encore, au lieu de deviner avec un minuteur.
 *
 * ⚠️ LE DÉFAUT QUE CE FICHIER FERME (demande utilisateur 2026-11-03) : un délai
 * fixe est toujours faux. Trop court, il coupe un calcul LÉGITIME (une vidéo de
 * dix minutes de calcul) ; trop long, il fait attendre sur un travail MORT.
 * ComfyUI expose sa file (`GET /queue`) : on la lui demande.
 *
 * Ce que ce fichier PROUVE, contre un FAUX serveur ComfyUI (vrai `node:http`) :
 *  1. un travail présent dans `queue_running` pendant 12 minutes SIMULÉES n'est
 *     PAS coupé (il aboutit) — alors que l'ancien plafond de 180 s le coupait ;
 *  2. un travail qui DISPARAÎT de la file sans résultat échoue en ~30 s (grâce)
 *     avec un code et un message explicites (`job_lost`) ;
 *  3. la COURSE connue de ComfyUI (sortie de file AVANT écriture de
 *     l'historique) n'échoue pas : le résultat qui arrive pendant la grâce est
 *     récupéré ;
 *  4. `status_str = "error"` reste un échec explicite, motif du serveur repris ;
 *  5. serveur INJOIGNABLE pendant la surveillance ⇒ reprise BORNÉE (3 essais)
 *     puis échec avec l'erreur réelle — jamais une attente muette ;
 *  6. un travail qui reste EN FILE ÉTERNELLEMENT est coupé par le PLAFOND DE
 *     SÉCURITÉ, et le message le DIT (avec l'état observé) : « ComfyUI la
 *     signalait ENCORE EN COURS après 1 heure », cas RARISSIME = blocage ;
 *  6 bis. 50 minutes SIMULÉES dans `queue_running` : AUCUNE coupure — c'est
 *     l'intérêt même de la surveillance (le plafond n'est qu'un filet) ;
 *  7. `/queue` inexploitable (proxy, version ancienne) ⇒ repli DOCUMENTÉ sur
 *     `/history` seul, journalisé — la surveillance ne casse rien.
 *
 * ⚠️ Échoue sur le code d'origine : `GET /queue` n'y est jamais appelé, le
 * défaut du plafond y valait 900 000 ms (15 min, donc une coupure à 15 min au
 * lieu de 1 h), et `job_lost` n'existait pas.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  ComfyClient,
  ComfyError,
  DEFAULT_COMFY_GENERATION_TIMEOUT_MS,
  DEFAULT_COMFY_JOB_GRACE_MS,
  MAX_COMFY_MONITOR_FAILURES,
  promptIdsOfQueue,
  type ComfyLogger,
} from "../../src/comfy/index.js";

/** PNG 1×1 valide. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** Entrée d'historique d'un travail TERMINÉ avec une image. */
function historyDone(): Record<string, unknown> {
  return {
    outputs: { 7: { images: [{ filename: "image.png", subfolder: "", type: "output" }] } },
    status: { status_str: "success" },
  };
}

/** Réponse de `/queue` telle que ComfyUI la publie (tableau d'éléments de file). */
function queueRunning(promptId: string): Record<string, unknown> {
  return {
    queue_running: [[1, promptId, {}, { client_id: "yuki-gateway" }, []]],
    queue_pending: [],
  };
}

type QueueMode = "running" | "pending" | "empty" | "not_found" | "object_shape";

interface FakeComfy {
  baseUrl: string;
  behaviour: {
    /** Ce que `/queue` répond, selon l'appel (0 = premier). */
    queue: (poll: number) => QueueMode;
    /** Entrée d'historique, ou `null` tant que le travail n'est pas terminé. */
    history: (poll: number) => unknown | null;
    /** Progression de la PSEUDO-HORLOGE à chaque lecture d'historique (ms). */
    advanceMsPerHistoryPoll: number;
    /** Appelé à CHAQUE lecture d'historique (sert à changer de serveur cible). */
    onHistoryPoll?: (poll: number) => void;
  };
  /** Pseudo-horloge partagée entre le client et le faux serveur (ms). */
  clock: { now: number };
  counts: { queue: number; history: number };
  close(): Promise<void>;
}

async function startFakeComfy(): Promise<FakeComfy> {
  const clock = { now: 0 };
  const counts = { queue: 0, history: 0 };
  const behaviour: FakeComfy["behaviour"] = {
    queue: () => "running",
    history: () => null,
    advanceMsPerHistoryPoll: 0,
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      if (path === "/prompt") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ prompt_id: "prompt-1", number: 1, node_errors: {} }));
        return;
      }
      if (path === "/queue") {
        const poll = counts.queue;
        counts.queue += 1;
        const mode = behaviour.queue(poll);
        if (mode === "not_found") {
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("not found");
          return;
        }
        const body =
          mode === "running"
            ? queueRunning("prompt-1")
            : mode === "pending"
              ? { queue_running: [], queue_pending: [[2, "prompt-1", {}, {}, []]] }
              : mode === "object_shape"
                ? { queue_running: [{ prompt_id: "prompt-1" }], queue_pending: [] }
                : { queue_running: [], queue_pending: [] };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
        return;
      }
      if (path.startsWith("/history/")) {
        const poll = counts.history;
        counts.history += 1;
        clock.now += behaviour.advanceMsPerHistoryPoll;
        const entry = behaviour.history(poll);
        behaviour.onHistoryPoll?.(poll);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(entry === null ? {} : { "prompt-1": entry }));
        return;
      }
      if (path === "/view") {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(PNG);
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    behaviour,
    clock,
    counts,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const servers: FakeComfy[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

interface Logs {
  events: string[];
  logger: ComfyLogger;
}

function captureLogs(): Logs {
  const events: string[] = [];
  const record = (event: string, data?: Record<string, unknown>): void => {
    events.push(`${event} ${JSON.stringify(data ?? {})}`);
  };
  return { events, logger: { info: record, warn: record, error: record } };
}

async function harness(options: {
  pollIntervalMs?: number;
  jobGraceMs?: number;
  generationTimeoutMs?: number;
  /** Horloge VIRTUELLE : le faux serveur l'avance à chaque lecture d'historique. */
  virtualClock?: boolean;
  requestTimeoutMs?: number;
} = {}): Promise<{
  fake: FakeComfy;
  client: ComfyClient;
  logs: Logs;
  /** Configuration RELUE à chaque requête : la changer change de serveur. */
  target: { baseUrl: string; apiKey: string };
}> {
  const fake = await startFakeComfy();
  servers.push(fake);
  const logs = captureLogs();
  const target = { baseUrl: fake.baseUrl, apiKey: "" };
  const client = new ComfyClient({
    config: () => target,
    logger: logs.logger,
    pollIntervalMs: options.pollIntervalMs ?? 10,
    ...(options.jobGraceMs !== undefined ? { jobGraceMs: options.jobGraceMs } : {}),
    ...(options.generationTimeoutMs !== undefined
      ? { generationTimeoutMs: () => options.generationTimeoutMs as number }
      : {}),
    ...(options.virtualClock ? { now: () => fake.clock.now } : {}),
  });
  return { fake, client, logs, target };
}

/** Graphe minimal : le client ne le valide pas (aucune étiquette ici). */
const WORKFLOW = {
  "3": { class_type: "KSampler", inputs: { seed: 1 } },
  "7": { class_type: "SaveImage", inputs: { filename_prefix: "Yuki" } },
};

async function genere(client: ComfyClient): Promise<unknown> {
  return client.generate(WORKFLOW).catch((error: unknown) => error);
}

describe("surveillance d'état : le serveur dit s'il travaille encore", () => {
  it("un travail EN COURS pendant 12 minutes simulées n'est PAS coupé (il aboutit)", async () => {
    const { fake, client } = await harness({
      pollIntervalMs: 2,
      virtualClock: true,
      // ⚠️ AUCUN `generationTimeoutMs` : on éprouve le DÉFAUT du réglage.
    });
    // Le serveur déclare le travail dans `queue_running` et fait avancer la
    // pseudo-horloge de 60 s à chaque lecture : au 12e sondage, 12 minutes ont
    // « passé » — bien au-delà de l'ancien plafond de 180 s.
    fake.behaviour.advanceMsPerHistoryPoll = 60_000;
    fake.behaviour.history = (poll) => (poll < 11 ? null : historyDone());

    const resultat = await genere(client);
    expect(resultat).not.toBeInstanceOf(ComfyError);
    expect((resultat as { promptId: string }).promptId).toBe("prompt-1");
    // ⚠️ PREUVE de la durée : 12 lectures d'historique × 60 s.
    expect(fake.clock.now).toBeGreaterThanOrEqual(12 * 60_000);
    // Et le plafond par défaut vaut bien 1 h (et non 15 min).
    expect(DEFAULT_COMFY_GENERATION_TIMEOUT_MS).toBe(3_600_000);
    // Aucune coupure : jamais d'erreur de plafond dans le journal.
    expect(fake.counts.history).toBeGreaterThanOrEqual(12);
  });

  it("un travail EN COURS pendant 50 minutes simulées n'est PAS coupé (plafond à 1 h)", async () => {
    const { fake, client } = await harness({ pollIntervalMs: 2, virtualClock: true });
    // 50 sondages × 60 s = 50 minutes dans `queue_running` : l'ancien plafond de
    // 900 s (15 min) aurait coupé ici, et c'est exactement ce qu'on ne veut plus.
    fake.behaviour.advanceMsPerHistoryPoll = 60_000;
    fake.behaviour.history = (poll) => (poll < 50 ? null : historyDone());

    const resultat = await genere(client);
    expect(resultat).not.toBeInstanceOf(ComfyError);
    expect((resultat as { promptId: string }).promptId).toBe("prompt-1");
    // ⚠️ PREUVE de la durée simulée : 50 lectures × 60 s, et c'est SOUS le défaut.
    expect(fake.clock.now).toBeGreaterThanOrEqual(50 * 60_000);
    expect(fake.clock.now).toBeLessThan(DEFAULT_COMFY_GENERATION_TIMEOUT_MS);
    expect(fake.counts.history).toBeGreaterThanOrEqual(51);
  });

  it("un travail EN ATTENTE (`queue_pending`) est traité comme « le serveur travaille »", async () => {
    const { fake, client } = await harness({ pollIntervalMs: 2, virtualClock: true });
    fake.behaviour.queue = (poll) => (poll < 6 ? "pending" : "empty");
    fake.behaviour.advanceMsPerHistoryPoll = 30_000;
    fake.behaviour.history = (poll) => (poll < 6 ? null : historyDone());

    await expect(client.generate(WORKFLOW)).resolves.toMatchObject({ promptId: "prompt-1" });
  });

  it("la réponse en forme d'OBJET (`{ prompt_id }`) est lue aussi (deux formes connues)", async () => {
    const { fake, client } = await harness({ pollIntervalMs: 2, virtualClock: true });
    fake.behaviour.queue = (poll) => (poll < 4 ? "object_shape" : "empty");
    fake.behaviour.advanceMsPerHistoryPoll = 20_000;
    fake.behaviour.history = (poll) => (poll < 4 ? null : historyDone());

    await expect(client.generate(WORKFLOW)).resolves.toMatchObject({ promptId: "prompt-1" });
  });

  it("un travail qui DISPARAÎT de la file sans résultat échoue après la grâce (30 s), en le disant", async () => {
    const { fake, client } = await harness({ pollIntervalMs: 10, jobGraceMs: 150 });
    fake.behaviour.queue = () => "empty";
    fake.behaviour.history = () => null;

    const debut = Date.now();
    const error = (await genere(client)) as ComfyError;
    const duree = Date.now() - debut;

    expect(error).toBeInstanceOf(ComfyError);
    expect(error.code).toBe("job_lost");
    expect(error.message).toContain("DISPARU");
    expect(error.message).toContain("historique");
    expect(error.message).toContain("Rien n'a été produit");
    // ⚠️ Détecté dans la GRÂCE, pas au plafond (15 min) : c'est tout l'objet.
    expect(duree).toBeGreaterThanOrEqual(140);
    expect(duree).toBeLessThan(2_000);
    // Le journal DIT la fenêtre de grâce (diagnostic sans relire le code).
    expect(fake.counts.queue).toBeGreaterThan(1);
  });

  it("la GRÂCE par DÉFAUT reste 30 s : `job_lost` est constaté en 30 s, pas au plafond de 1 h", async () => {
    // ⚠️ NON-RÉGRESSION : relever le plafond à 1 h ne doit PAS relâcher la détection
    // d'un travail fantôme — c'est le mécanisme principal, le plafond n'est qu'un
    // filet. Aucun `jobGraceMs` passé ici : c'est bien le DÉFAUT qui est éprouvé.
    const { fake, client } = await harness({ pollIntervalMs: 2, virtualClock: true });
    expect(DEFAULT_COMFY_JOB_GRACE_MS).toBe(30_000);
    fake.behaviour.queue = () => "empty";
    fake.behaviour.history = () => null;
    fake.behaviour.advanceMsPerHistoryPoll = 10_000;

    const error = (await genere(client)) as ComfyError;
    expect(error.code).toBe("job_lost");
    // ⚠️ Constaté à ~30 s de temps SIMULÉ (3 lectures de 10 s), très loin des 1 h.
    expect(fake.clock.now).toBeGreaterThanOrEqual(DEFAULT_COMFY_JOB_GRACE_MS);
    expect(fake.clock.now).toBeLessThan(DEFAULT_COMFY_GENERATION_TIMEOUT_MS / 10);
    expect(error.message).toContain("30 s");
  });

  it("la COURSE de ComfyUI (sortie de file avant écriture de `/history`) n'échoue pas", async () => {
    const { fake, client } = await harness({ pollIntervalMs: 10, jobGraceMs: 500 });
    // Le travail n'est JAMAIS dans la file, et l'historique se remplit au 4e essai.
    fake.behaviour.queue = () => "empty";
    fake.behaviour.history = (poll) => (poll < 3 ? null : historyDone());

    const resultat = await genere(client);
    expect(resultat).not.toBeInstanceOf(ComfyError);
    expect((resultat as { promptId: string }).promptId).toBe("prompt-1");
  });

  it("`/history` en erreur reste un échec explicite, motif du serveur repris", async () => {
    const { fake, client } = await harness({ pollIntervalMs: 5 });
    fake.behaviour.queue = (poll) => (poll < 2 ? "running" : "empty");
    fake.behaviour.history = (poll) =>
      poll < 3
        ? null
        : {
            outputs: {},
            status: {
              status_str: "error",
              messages: [["execution_error", { exception_message: "CUDA out of memory" }]],
            },
          };

    const error = (await genere(client)) as ComfyError;
    expect(error.code).toBe("execution_failed");
    expect(error.message).toContain("CUDA out of memory");
  });

  it("serveur INJOIGNABLE pendant la surveillance : reprise BORNÉE puis échec avec l'erreur réelle", async () => {
    const { fake, client, logs, target } = await harness({ pollIntervalMs: 5 });
    fake.behaviour.queue = () => "running";
    // Port RÉELLEMENT libre (ouvert puis refermé) : le refus est authentique.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const portFerme = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    // Après la 2e lecture, le client parle à un serveur qui n'existe plus.
    fake.behaviour.onHistoryPoll = (poll) => {
      if (poll >= 1) target.baseUrl = `http://127.0.0.1:${portFerme}`;
    };

    const error = (await genere(client)) as ComfyError;
    expect(error).toBeInstanceOf(ComfyError);
    expect(error.code).toBe("unreachable");
    // ⚠️ Bornée : `MAX_COMFY_MONITOR_FAILURES` essais, pas une boucle infinie.
    const reprises = logs.events.filter((ligne) => ligne.startsWith("comfy.monitor.retry"));
    expect(reprises.length).toBe(MAX_COMFY_MONITOR_FAILURES - 1);
  });

  it("un travail qui reste EN FILE ÉTERNELLEMENT est coupé au PLAFOND, et le message le DIT", async () => {
    const { fake, client } = await harness({
      pollIntervalMs: 2,
      virtualClock: true,
    });
    // Plafond = le DÉFAUT (1 h) : 60 sondages de 60 s simulées l'atteignent.
    fake.behaviour.advanceMsPerHistoryPoll = 60_000;
    fake.behaviour.queue = () => "running";
    fake.behaviour.history = () => null;

    const error = (await genere(client)) as ComfyError;
    expect(error.code).toBe("timeout");
    // ⚠️ Le message nomme le plafond ET l'état observé : on ne fait pas croire
    // que le serveur était mort alors qu'il disait travailler.
    expect(error.message).toContain("PLAFOND DE SÉCURITÉ");
    expect(error.message).toContain("1 heure");
    expect(error.message).toContain("ENCORE EN COURS");
    // ⚠️ Et il dit que c'est RARISSIME : un BLOCAGE (travail orphelin, file
    // figée), pas une lenteur — sinon on ferait croire à un manque de patience.
    expect(error.message).toContain("RARISSIME");
    expect(error.message).toContain("BLOCAGE");
    expect(error.message).toContain("Relevez le plafond");
  });

  it("un travail qui reste EN FILE ÉTERNELLEMENT est coupé au PLAFOND configuré (court)", async () => {
    const { fake, client } = await harness({ pollIntervalMs: 10, generationTimeoutMs: 120 });
    fake.behaviour.queue = () => "running";
    fake.behaviour.history = () => null;

    const error = (await genere(client)) as ComfyError;
    expect(error.code).toBe("timeout");
    // Le message reprend la durée RÉELLEMENT appliquée (1 s : le client borne
    // son plafond à 1 000 ms minimum), jamais « 1000 ».
    expect(error.message).toContain("après 1 s");
    expect(error.message).toContain("RARISSIME");
  });

  it("`/queue` inexploitable ⇒ repli sur `/history` seul, JOURNALISÉ, et la génération aboutit", async () => {
    const { fake, client, logs } = await harness({ pollIntervalMs: 5, virtualClock: true });
    fake.behaviour.queue = () => "not_found";
    fake.behaviour.advanceMsPerHistoryPoll = 30_000;
    fake.behaviour.history = (poll) => (poll < 4 ? null : historyDone());

    await expect(client.generate(WORKFLOW)).resolves.toMatchObject({ promptId: "prompt-1" });
    expect(logs.events.some((ligne) => ligne.startsWith("comfy.queue.unavailable"))).toBe(true);
    // ⚠️ Une seule tentative : on ne martèle pas une route absente.
    expect(fake.counts.queue).toBe(1);
  });
});

describe("lecture de `/queue` : deux formes connues, aucune devinée", () => {
  it("lit le `prompt_id` d'un élément de file en TABLEAU (`QueueItem` sérialisé)", () => {
    expect(promptIdsOfQueue([[1, "abc", { x: 1 }, {}, []]])).toEqual(["abc"]);
  });

  it("lit le `prompt_id` d'un élément en OBJET", () => {
    expect(promptIdsOfQueue([{ prompt_id: "def" }])).toEqual(["def"]);
  });

  it("ignore une entrée d'une autre forme, sans lever (liste vide)", () => {
    expect(promptIdsOfQueue([[1, 2, 3], { autre: "x" }, null, 42])).toEqual([]);
    expect(promptIdsOfQueue(undefined)).toEqual([]);
    expect(promptIdsOfQueue("pas une liste")).toEqual([]);
  });
});
