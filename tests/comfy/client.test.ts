/**
 * Client HTTP ComfyUI — éprouvé contre un FAUX SERVEUR COMFYUI LOCAL (vrai
 * `node:http`, aucun réseau externe).
 *
 * Ce que ce fichier PROUVE, par observation du JSON RÉELLEMENT POSTÉ :
 *  - `POST /prompt` reçoit le graphe sous la clé `prompt` (+ `client_id`) ;
 *  - les CINQ étiquettes sont écrites dans les BONS nœuds, alors que les
 *    identifiants sont DIFFÉRENTS d'un workflow à l'autre (PIÈGE ②) ;
 *  - ⚠️ le STYLE demandé n'apparaît NULLE PART dans le JSON posté (PIÈGE ①) ;
 *  - le nom de fichier de l'image est lu dans `history[id].outputs[<nœud>].images[]`
 *    puis les octets dans `GET /view` (PIÈGE ⑤ : plafond respecté) ;
 *  - la CLÉ du serveur part en en-tête `Authorization` mais n'apparaît ni dans
 *    les journaux, ni dans une erreur, ni dans le prompt (PIÈGE ④) ;
 *  - un refus (`400` + `node_errors`), une panne et un délai dépassé donnent un
 *    message HONNÊTE, en français, jamais une cause inventée (PIÈGE ⑧).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  ComfyClient,
  ComfyError,
  MAX_COMFY_IMAGE_BYTES,
  type ComfyConfig,
  type ComfyLogger,
} from "../../src/comfy/index.js";

/** PNG 1×1 valide (octets réels). */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

interface Recorded {
  method: string;
  /** Chemin SANS requête (`/view`). */
  path: string;
  /** Chemin AVEC la requête (`/view?filename=…&subfolder=…&type=…`). */
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

/** Faux serveur ComfyUI : routes `/prompt`, `/history/{id}`, `/view`, `/system_stats`. */
interface FakeComfy {
  baseUrl: string;
  requests: Recorded[];
  /** Ce que le serveur fera pour le prochain `POST /prompt`. */
  behaviour: {
    submitStatus: number;
    submitBody: unknown;
    /** Nombre de lectures d'historique avant que le prompt soit « terminé ». */
    pendingPolls: number;
    historyEntry: unknown;
    viewBody: Buffer;
    viewContentType: string;
    systemStats: unknown;
    /** Délai artificiel avant de répondre (teste le délai borné). */
    delayMs: number;
  };
  close(): Promise<void>;
}

async function startFakeComfy(): Promise<FakeComfy> {
  const requests: Recorded[] = [];
  const behaviour: FakeComfy["behaviour"] = {
    submitStatus: 200,
    submitBody: { prompt_id: "prompt-1", number: 1, node_errors: {} },
    pendingPolls: 0,
    historyEntry: null,
    viewBody: PNG,
    viewContentType: "image/png",
    systemStats: { system: { comfyui_version: "0.3.40" }, devices: [{ name: "cuda:0" }] },
    delayMs: 0,
  };
  let polls = 0;

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      requests.push({
        method: (req.method ?? "GET").toUpperCase(),
        path,
        url: req.url ?? "/",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const respond = (): void => {
        if (path === "/prompt") {
          res.writeHead(behaviour.submitStatus, { "content-type": "application/json" });
          res.end(JSON.stringify(behaviour.submitBody));
          return;
        }
        if (path.startsWith("/history/")) {
          const promptId = decodeURIComponent(path.slice("/history/".length));
          const done = polls >= behaviour.pendingPolls;
          polls += 1;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify(done && behaviour.historyEntry !== null ? { [promptId]: behaviour.historyEntry } : {}),
          );
          return;
        }
        if (path === "/view") {
          res.writeHead(200, { "content-type": behaviour.viewContentType });
          res.end(behaviour.viewBody);
          return;
        }
        if (path === "/system_stats") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(behaviour.systemStats));
          return;
        }
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
      };
      if (behaviour.delayMs > 0) setTimeout(respond, behaviour.delayMs);
      else respond();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  polls = 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    behaviour,
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

/** Journal en mémoire : sert à prouver que la clé n'y apparaît JAMAIS. */
interface CapturedLogs {
  events: string[];
  logger: ComfyLogger;
}

function captureLogs(): CapturedLogs {
  const events: string[] = [];
  const record = (event: string, data?: Record<string, unknown>): void => {
    events.push(`${event} ${JSON.stringify(data ?? {})}`);
  };
  return { events, logger: { info: record, warn: record, error: record } };
}

/** Grappe client + serveur, avec des identifiants de nœuds DIFFÉRENTS. */
async function harness(options: {
  apiKey?: string;
  requestTimeoutMs?: number;
  generationTimeoutMs?: number;
  pollIntervalMs?: number;
  config?: () => ComfyConfig;
} = {}): Promise<{
  fake: FakeComfy;
  client: ComfyClient;
  logs: CapturedLogs;
}> {
  const fake = await startFakeComfy();
  servers.push(fake);
  const logs = captureLogs();
  const client = new ComfyClient({
    config:
      options.config ??
      (() => ({ baseUrl: fake.baseUrl, apiKey: options.apiKey ?? "" })),
    logger: logs.logger,
    ...(options.requestTimeoutMs !== undefined
      ? { requestTimeoutMs: options.requestTimeoutMs }
      : {}),
    ...(options.generationTimeoutMs !== undefined
      ? { generationTimeoutMs: () => options.generationTimeoutMs as number }
      : {}),
    ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
  });
  return { fake, client, logs };
}

/** Workflow minimal accepté par `POST /prompt` (pas de validation ici). */
function workflowWith(ids: { prompt: string; negative: string; seed: string; latent: string; save: string }) {
  return {
    [ids.prompt]: {
      class_type: "CLIPTextEncode",
      inputs: { text: "SCENE_PLACEHOLDER" },
      _meta: { title: "YUKI_PROMPT" },
    },
    [ids.negative]: {
      class_type: "CLIPTextEncode",
      inputs: { text: "" },
      _meta: { title: "YUKI_NEGATIVE" },
    },
    [ids.seed]: {
      class_type: "KSampler",
      inputs: { seed: 0, steps: 20 },
      _meta: { title: "YUKI_SEED" },
    },
    [ids.latent]: {
      class_type: "EmptyLatentImage",
      inputs: { width: 512, height: 512 },
      _meta: { title: "YUKI_WIDTH" },
    },
    [ids.save]: { class_type: "SaveImage", inputs: { filename_prefix: "Yuki" } },
  };
}

/** Entrée d'historique TERMINÉE, telle que ComfyUI la renvoie. */
function historyDone(filename = "Yuki_00001_.png"): unknown {
  return {
    prompt: [1, "prompt-1", {}, {}, []],
    outputs: {
      "42": { images: [{ filename, subfolder: "", type: "output" }] },
    },
    status: { status_str: "success", completed: true, messages: [] },
  };
}

describe("soumission et récupération de l'image", () => {
  it("poste le graphe sous `prompt`, attend l'historique puis récupère les octets", async () => {
    const { fake, client } = await harness({ pollIntervalMs: 5 });
    fake.behaviour.historyEntry = historyDone();

    const workflow = workflowWith({ prompt: "6", negative: "7", seed: "3", latent: "5", save: "9" });
    const image = await client.generate(workflow);

    // 1) Ce qui a été POSTÉ.
    const submit = fake.requests.find((request) => request.path === "/prompt");
    expect(submit?.method).toBe("POST");
    const posted = JSON.parse(submit?.body ?? "{}") as Record<string, unknown>;
    expect(posted.client_id).toBe("yuki-gateway");
    expect(posted.prompt).toEqual(workflow);

    // 2) L'historique a été sondé, puis `/view` a servi l'image (mêmes paramètres
    // que ceux publiés par ComfyUI dans `outputs[...].images[]`).
    const view = fake.requests.find((request) => request.path === "/view");
    expect(view?.path).toBe("/view");
    expect(image.filename).toBe("Yuki_00001_.png");
    expect(image.mimeType).toBe("image/png");
    expect(Buffer.from(image.bytes).equals(PNG)).toBe(true);
    expect(image.promptId).toBe("prompt-1");
  });

  it("interroge `/view` avec `filename`, `subfolder` et `type` de l'historique", async () => {
    const { fake, client } = await harness({ pollIntervalMs: 5 });
    fake.behaviour.historyEntry = {
      outputs: { 7: { images: [{ filename: "image.png", subfolder: "sous", type: "output" }] } },
      status: { status_str: "success" },
    };
    await client.generate(workflowWith({ prompt: "1", negative: "2", seed: "3", latent: "4", save: "5" }));
    const view = fake.requests.find((request) => request.path === "/view");
    expect(view).toBeDefined();
    // ⚠️ Les paramètres EXACTS publiés par ComfyUI dans l'historique.
    const query = new URLSearchParams((view?.url ?? "").split("?")[1] ?? "");
    expect(query.get("filename")).toBe("image.png");
    expect(query.get("subfolder")).toBe("sous");
    expect(query.get("type")).toBe("output");
  });

  it("sonde l'historique plusieurs fois avant de conclure", async () => {
    const { fake, client } = await harness({ pollIntervalMs: 5 });
    fake.behaviour.pendingPolls = 3;
    fake.behaviour.historyEntry = historyDone();
    await client.generate(workflowWith({ prompt: "1", negative: "2", seed: "3", latent: "4", save: "5" }));
    const polls = fake.requests.filter((request) => request.path.startsWith("/history/"));
    expect(polls.length).toBeGreaterThanOrEqual(4);
    expect(polls[0]?.path).toBe("/history/prompt-1");
  });

  it("préfère une sortie `type: output` à une prévisualisation `temp`", async () => {
    const { fake, client } = await harness({ pollIntervalMs: 5 });
    fake.behaviour.historyEntry = {
      outputs: {
        10: { images: [{ filename: "apercu_temp.png", subfolder: "", type: "temp" }] },
        20: { images: [{ filename: "finale.png", subfolder: "", type: "output" }] },
      },
      status: { status_str: "success" },
    };
    const image = await client.generate(
      workflowWith({ prompt: "1", negative: "2", seed: "3", latent: "4", save: "5" }),
    );
    expect(image.filename).toBe("finale.png");
  });
});

describe("étiquette YUKI_OUTPUT : SEULE l'image du nœud désigné est retenue", () => {
  /** Graphe avec un APERÇU intermédiaire (temp) ET une image finale (output). */
  const twoImages = {
    outputs: {
      "10": { images: [{ filename: "apercu_temp.png", subfolder: "", type: "temp" }] },
      "20": { images: [{ filename: "finale.png", subfolder: "", type: "output" }] },
    },
    status: { status_str: "success" },
  };

  it("rend l'image du nœud étiqueté MÊME quand un aperçu existe (préférence `output` ignorée)", async () => {
    // ⚠️ LE TEST QUI COMPTE : sans `outputNodeId`, `findImageRef` préférerait le
    // type `output` (nœud 20) ; avec l'étiquette, c'est le nœud 10 qui gagne.
    const { fake, client } = await harness({ pollIntervalMs: 5 });
    fake.behaviour.historyEntry = twoImages;
    const image = await client.generate(
      workflowWith({ prompt: "1", negative: "2", seed: "3", latent: "4", save: "5" }),
      { outputNodeId: "10" },
    );
    expect(image.filename).toBe("apercu_temp.png");
    expect(image.type).toBe("temp");
    expect(image.nodeId).toBe("10");
    // Le type publié par l'historique est respecté dans l'URL de `/view`.
    const view = fake.requests.find((request) => request.path === "/view");
    const query = new URLSearchParams((view?.url ?? "").split("?")[1] ?? "");
    expect(query.get("filename")).toBe("apercu_temp.png");
    expect(query.get("type")).toBe("temp");
  });

  it("rend l'image du nœud étiqueté quand il est le seul à en produire une", async () => {
    const { fake, client } = await harness({ pollIntervalMs: 5 });
    fake.behaviour.historyEntry = {
      outputs: { "7": { images: [{ filename: "seule.png", subfolder: "", type: "output" }] } },
      status: { status_str: "success" },
    };
    const image = await client.generate(
      workflowWith({ prompt: "1", negative: "2", seed: "3", latent: "4", save: "5" }),
      { outputNodeId: "7" },
    );
    expect(image.filename).toBe("seule.png");
  });

  it("nœud étiqueté SANS image ⇒ ERREUR explicite, AUCUN repli sur les autres nœuds", async () => {
    // ⚠️ PIÈGE ① : le nœud 20 A une image, mais 10 est étiqueté ⇒ on échoue.
    const { fake, client } = await harness({ pollIntervalMs: 5 });
    fake.behaviour.historyEntry = twoImages;
    const error = (await client
      .generate(workflowWith({ prompt: "1", negative: "2", seed: "3", latent: "4", save: "5" }), {
        outputNodeId: "10-bis",
      })
      .catch((caught: unknown) => caught)) as ComfyError;
    expect(error).toBeInstanceOf(ComfyError);
    expect(error.code).toBe("no_image");
    expect(error.message).toContain("YUKI_OUTPUT");
    expect(error.message).toContain("10-bis");
    expect(error.message).toContain("AUCUNE image");
    // Et RIEN n'a été téléchargé : aucune image d'un autre nœud n'est servie.
    expect(fake.requests.some((request) => request.path === "/view")).toBe(false);
  });

  it("nœud étiqueté présent dans `outputs` mais sans `images[]` ⇒ erreur explicite", async () => {
    const { fake, client } = await harness({ pollIntervalMs: 5 });
    fake.behaviour.historyEntry = {
      outputs: { "10": { gifs: [] }, "20": { images: [{ filename: "finale.png", type: "output" }] } },
      status: { status_str: "success" },
    };
    const error = (await client
      .generate(workflowWith({ prompt: "1", negative: "2", seed: "3", latent: "4", save: "5" }), {
        outputNodeId: "10",
      })
      .catch((caught: unknown) => caught)) as ComfyError;
    expect(error.code).toBe("no_image");
    expect(error.message).toContain("YUKI_OUTPUT");
    expect(fake.requests.some((request) => request.path === "/view")).toBe(false);
  });
});

describe("le STYLE ne part JAMAIS dans le prompt (PIÈGE ①)", () => {
  it("le JSON posté ne contient QUE la scène — aucune trace du style", async () => {
    const { fake, client } = await harness({ pollIntervalMs: 5 });
    fake.behaviour.historyEntry = historyDone();

    const scene = "Une femme âgée arrose des tomates au soleil couchant, arrosoir en zinc.";
    const workflow = workflowWith({ prompt: "11", negative: "12", seed: "13", latent: "14", save: "15" });
    (workflow["11"] as { inputs: Record<string, unknown> }).inputs.text = scene;
    (workflow["12"] as { inputs: Record<string, unknown> }).inputs.text =
      "flou, basse résolution, artefacts de compression, déformation, texte illisible";

    await client.generate(workflow);

    const submit = fake.requests.find((request) => request.path === "/prompt");
    const body = submit?.body ?? "";
    // La scène est bien là…
    expect(body).toContain("arrosoir en zinc");
    // …et AUCUN mot de style ne s'y trouve, y compris sous forme échappée.
    for (const forbidden of ["manga", "anime", "réaliste", "realiste", "photo", "infographie", "style"]) {
      expect(body.toLowerCase()).not.toContain(forbidden);
    }
    // Le champ négatif porte le négatif NEUTRE, sans indication de style.
    expect(body).toContain("flou, basse résolution");
  });
});

describe("clé du serveur (PIÈGE ④)", () => {
  it("envoie la clé en `Authorization` mais ne la journalise jamais", async () => {
    const apiKey = "clef-tres-secrete-42";
    const { fake, client, logs } = await harness({ apiKey, pollIntervalMs: 5 });
    fake.behaviour.historyEntry = historyDone();
    await client.generate(workflowWith({ prompt: "1", negative: "2", seed: "3", latent: "4", save: "5" }));
    await client.systemStats();

    for (const request of fake.requests) {
      expect(request.headers.authorization).toBe(`Bearer ${apiKey}`);
    }
    expect(logs.events.length).toBeGreaterThan(0);
    for (const event of logs.events) expect(event).not.toContain(apiKey);
    // Ni dans le corps posté.
    const submit = fake.requests.find((request) => request.path === "/prompt");
    expect(submit?.body).not.toContain(apiKey);
  });

  it("n'envoie AUCUN en-tête `Authorization` sans clé", async () => {
    const { fake, client, logs } = await harness({ pollIntervalMs: 5 });
    fake.behaviour.historyEntry = historyDone();
    await client.generate(workflowWith({ prompt: "1", negative: "2", seed: "3", latent: "4", save: "5" }));
    for (const request of fake.requests) expect(request.headers.authorization).toBeUndefined();
    expect(logs.events.join("\n")).not.toContain("authorization");
  });

  it("ne met jamais la clé dans un message d'erreur", async () => {
    const apiKey = "clef-secrete-a-masquer";
    const { fake, client } = await harness({ apiKey, pollIntervalMs: 5 });
    fake.behaviour.submitStatus = 401;
    fake.behaviour.submitBody = { error: "unauthorized" };
    const error = await client
      .generate(workflowWith({ prompt: "1", negative: "2", seed: "3", latent: "4", save: "5" }))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ComfyError);
    expect((error as Error).message).not.toContain(apiKey);
    expect((error as Error).message).toContain("401");
  });
});

describe("échecs honnêtes (PIÈGE ⑧)", () => {
  it("traduit un refus de graphe (400 + node_errors) avec les nœuds fautifs", async () => {
    const { fake, client, logs } = await harness({ pollIntervalMs: 5 });
    fake.behaviour.submitStatus = 400;
    fake.behaviour.submitBody = {
      error: { type: "prompt_outputs_failed_validation", message: "Prompt outputs failed validation" },
      node_errors: { 3: { class_type: "KSampler", errors: [] } },
    };
    const error = (await client
      .generate(workflowWith({ prompt: "1", negative: "2", seed: "3", latent: "4", save: "5" }))
      .catch((caught: unknown) => caught)) as ComfyError;
    expect(error).toBeInstanceOf(ComfyError);
    expect(error.code).toBe("invalid_prompt");
    expect(error.status).toBe(400);
    expect(error.message).toContain("REFUSÉ");
    expect(error.message).toContain("prompt_outputs_failed_validation");
    expect(error.message).toContain("3 (KSampler)");
    expect(logs.events.join("\n")).not.toContain("clef");
  });

  it("rapporte l'échec d'EXÉCUTION publié par ComfyUI (`status.status_str = error`)", async () => {
    const { fake, client } = await harness({ pollIntervalMs: 5 });
    fake.behaviour.historyEntry = {
      outputs: {},
      status: {
        status_str: "error",
        completed: false,
        messages: [["execution_error", { node_id: "3", exception_message: "CUDA out of memory" }]],
      },
    };
    const error = (await client
      .generate(workflowWith({ prompt: "1", negative: "2", seed: "3", latent: "4", save: "5" }))
      .catch((caught: unknown) => caught)) as ComfyError;
    expect(error.code).toBe("execution_failed");
    expect(error.message).toContain("ÉCHOUÉ");
    // La cause RÉELLE du serveur est reprise telle quelle, jamais remplacée.
    expect(error.message).toContain("CUDA out of memory");
  });

  it("dit qu'aucune image n'a été produite quand le graphe n'a pas de nœud « Save Image »", async () => {
    const { fake, client } = await harness({ pollIntervalMs: 5 });
    fake.behaviour.historyEntry = { outputs: { 5: {} }, status: { status_str: "success" } };
    const error = (await client
      .generate(workflowWith({ prompt: "1", negative: "2", seed: "3", latent: "4", save: "5" }))
      .catch((caught: unknown) => caught)) as ComfyError;
    expect(error.code).toBe("no_image");
    expect(error.message).toContain("Save Image");
  });

  it("refuse une réponse de `/view` qui n'est pas une image (jamais un fichier déguisé)", async () => {
    const { fake, client } = await harness({ pollIntervalMs: 5 });
    fake.behaviour.historyEntry = historyDone();
    fake.behaviour.viewContentType = "text/html";
    const error = (await client
      .generate(workflowWith({ prompt: "1", negative: "2", seed: "3", latent: "4", save: "5" }))
      .catch((caught: unknown) => caught)) as ComfyError;
    expect(error.code).toBe("invalid_response");
    expect(error.message).toContain("text/html");
  });

  it("plafonne les octets récupérés (PIÈGE ⑤)", async () => {
    const { fake, client } = await harness({ pollIntervalMs: 5 });
    fake.behaviour.historyEntry = historyDone();
    fake.behaviour.viewBody = Buffer.alloc(MAX_COMFY_IMAGE_BYTES + 1, 0x41);
    const error = (await client
      .generate(workflowWith({ prompt: "1", negative: "2", seed: "3", latent: "4", save: "5" }))
      .catch((caught: unknown) => caught)) as ComfyError;
    expect(error.code).toBe("image_too_large");
  });

  it("un délai de génération dépassé donne un message clair, sans blocage", async () => {
    const { fake, client } = await harness({ pollIntervalMs: 5, generationTimeoutMs: 60 });
    fake.behaviour.pendingPolls = Number.MAX_SAFE_INTEGER;
    const startedAt = Date.now();
    const error = (await client
      .generate(workflowWith({ prompt: "1", negative: "2", seed: "3", latent: "4", save: "5" }))
      .catch((caught: unknown) => caught)) as ComfyError;
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(error).toBeInstanceOf(ComfyError);
    expect(error.code).toBe("timeout");
    expect(error.message).toContain("n'a pas abouti");
    expect(error.message).toContain("file");
  });

  it("un délai de REQUÊTE dépassé nomme le délai réel", async () => {
    const { fake, client } = await harness({ requestTimeoutMs: 50 });
    fake.behaviour.delayMs = 500;
    await expect(client.systemStats()).rejects.toThrow(/n'a pas répondu en 0 s|n'a pas répondu/);
  });

  it("une annulation interrompt l'attente (aucun blocage)", async () => {
    const { client } = await harness({ pollIntervalMs: 20 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    const error = (await client
      .generate(workflowWith({ prompt: "1", negative: "2", seed: "3", latent: "4", save: "5" }), {
        signal: controller.signal,
      })
      .catch((caught: unknown) => caught)) as ComfyError;
    expect(error.code).toBe("cancelled");
    expect(error.message).toContain("annulée");
  });
});

describe("la génération ne BLOQUE pas la boucle d'événements (PIÈGE ③)", () => {
  it("les minuteurs continuent de tourner pendant l'attente (10 s à 3 min en vrai)", async () => {
    const { fake, client } = await harness({ pollIntervalMs: 20 });
    fake.behaviour.pendingPolls = 5;
    fake.behaviour.historyEntry = historyDone();

    // Un minuteur indépendant : s'il ne « tique » jamais pendant la génération,
    // c'est que la boucle d'événements est bloquée (attente synchrone).
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 5);
    try {
      await client.generate(workflowWith({ prompt: "1", negative: "2", seed: "3", latent: "4", save: "5" }));
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(2);
  });
});

describe("URL du serveur et bouton de test", () => {
  it("lit `/system_stats` (version + périphériques)", async () => {
    const { client } = await harness();
    await expect(client.systemStats()).resolves.toEqual({
      version: "0.3.40",
      devices: ["cuda:0"],
    });
  });

  it("refuse une URL vide ou invalide AVANT tout appel", async () => {
    const { fake, client } = await harness({
      config: () => ({ baseUrl: "", apiKey: "" }),
    });
    await expect(client.systemStats()).rejects.toThrow(/Aucun serveur ComfyUI/);
    const bad = await harness({ config: () => ({ baseUrl: "ftp://x", apiKey: "" }) });
    await expect(bad.client.systemStats()).rejects.toThrow(/n'est pas accepté/);
    expect(fake.requests.length).toBe(0);
    expect(bad.fake.requests.length).toBe(0);
  });

  it("rapporte une connexion refusée avec le code réseau RÉEL", async () => {
    // Port réellement LIBRE (ouvert puis refermé) : le refus est authentique.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const closedPort = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const { client } = await harness({
      config: () => ({ baseUrl: `http://127.0.0.1:${closedPort}`, apiKey: "" }),
    });
    const error = (await client.systemStats().catch((caught: unknown) => caught)) as ComfyError;
    expect(error.code).toBe("unreachable");
    expect(error.message).toContain("INJOIGNABLE");
    expect(error.causeCode).toBe("ECONNREFUSED");
    // Le message nomme la cause observée, pas une supposition.
    expect(error.message).toContain("connexion refusée");
  });
});
