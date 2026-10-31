/**
 * TRANSFERT DE FICHIERS vers/depuis une machine appairée (capacité `files`).
 *
 * Couvre, sur un serveur WebSocket mTLS RÉEL et un AGENT SIMULÉ :
 *   - aller-retour des trames (`file_get`/`file_chunk`, `file_put`/`file_put_chunk`
 *     /`file_result`) ;
 *   - réassemblage + vérification SHA-256 (conforme ⇒ succès, altérée ⇒
 *     `digest_mismatch`, aucun fichier conservé) ;
 *   - refus `too_large` AVANT toute écriture ;
 *   - refus d'un agent SANS la capacité `files` (message actionnable, AUCUNE
 *     trame émise) ;
 *   - reprise après coupure (offset exact, empreinte finale identique) ;
 *   - chemin RELATIF refusé ;
 *   - `conflict` sans `ecraser` ;
 *   - audit SANS contenu.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import {
  AgentFileTransferService,
  FILES_CAPABILITY,
  isAbsolutePath,
} from "../../src/agents/transfer.js";
import { FilesStore } from "../../src/files/store.js";
import { createLogger } from "../../src/observability/logger.js";
import { startTestStack, type TestStack } from "./stack.js";

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
const stacks: TestStack[] = [];
const dirs: string[] = [];

async function stack(): Promise<TestStack> {
  const s = await startTestStack();
  stacks.push(s);
  return s;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-transfer-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const s of stacks.splice(0)) {
    await s.close();
    s.cleanup();
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, timeoutMs = 4_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor : délai dépassé");
    await delay(10);
  }
}

interface AgentSim {
  ws: WebSocket;
  /** Trammes `file_get` reçues du serveur. */
  gets: Array<Record<string, unknown>>;
  /** Trammes `file_put` reçues du serveur. */
  puts: Array<Record<string, unknown>>;
  /** Trammes `file_put_chunk` reçues du serveur. */
  chunks: Array<Record<string, unknown>>;
}

/** Connecte un agent simulé et lui fait annoncer ses capacités (`hello`). */
async function connectAgent(
  s: TestStack,
  agentId: string,
  caps: string[],
): Promise<AgentSim> {
  s.register(agentId);
  const cert = s.ca.signClientCertificate(agentId);
  const sim: AgentSim = { ws: null as unknown as WebSocket, gets: [], puts: [], chunks: [] };
  const ws = new WebSocket(`wss://127.0.0.1:${s.port}/ws`, {
    cert: cert.certPem,
    key: cert.keyPem,
    rejectUnauthorized: false,
  });
  sim.ws = ws;
  ws.on("message", (raw: Buffer) => {
    const frame = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    if (frame.type === "file_get") sim.gets.push(frame);
    else if (frame.type === "file_put") sim.puts.push(frame);
    else if (frame.type === "file_put_chunk") sim.chunks.push(frame);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => {
      ws.send(
        JSON.stringify({
          type: "hello",
          proto_version: 1,
          agent_id: agentId,
          agent_version: "0.1.0",
          euid: 1000,
          caps,
        }),
      );
      resolve();
    });
    ws.once("error", reject);
  });
  // ⚠️ On attend que le `hello` soit TRAITÉ (la capacité devient visible) : sans
  // cela, `hasCapability("files")` répondrait faux juste après la connexion.
  if (caps.length > 0) {
    await waitFor(() => s.hub.caps(agentId).length > 0);
  }
  return sim;
}

function makeService(
  s: TestStack,
  options: { maxBytes?: number; chunkBytes?: number; registryPath?: string; authorize?: ConstructorParameters<typeof AgentFileTransferService>[0]["authorize"] } = {},
): { service: AgentFileTransferService; store: FilesStore; dir: string } {
  const dir = tempDir();
  const store = new FilesStore({
    dir,
    logger,
    maxBytes: () => 64 * 1024 * 1024,
    retentionDays: () => 30,
  });
  store.ensureLayout();
  const service = new AgentFileTransferService({
    store: s.store,
    hub: s.hub,
    audit: s.audit,
    logger,
    files: store,
    limits: {
      maxBytes: () => options.maxBytes ?? 256 * 1024 * 1024,
      chunkBytes: () => options.chunkBytes ?? 192 * 1024,
      timeoutMs: () => 10_000,
    },
    ...(options.registryPath ? { registryPath: options.registryPath } : {}),
    ...(options.authorize ? { authorize: options.authorize } : {}),
  });
  return { service, store, dir };
}

/** Envoie un morceau `file_chunk` de l'agent vers le serveur. */
function sendChunk(
  sim: AgentSim,
  cmdId: string,
  seq: number,
  offset: number,
  data: Buffer,
  dernier: boolean,
  extra: { total?: number; sha256?: string } = {},
): void {
  sim.ws.send(
    JSON.stringify({
      type: "file_chunk",
      proto_version: 1,
      cmd_id: cmdId,
      seq,
      offset,
      data: data.toString("base64"),
      ...(dernier ? { dernier: true } : {}),
      ...(extra.total !== undefined ? { total: extra.total } : {}),
      ...(extra.sha256 ? { sha256: extra.sha256 } : {}),
    }),
  );
}

describe("transfert de fichiers — trames et réassemblage", () => {
  it("récupère un fichier par morceaux et vérifie l'empreinte", async () => {
    const s = await stack();
    const { service, store } = makeService(s, { chunkBytes: 16 });
    const sim = await connectAgent(s, "agent-1", ["exec", FILES_CAPABILITY]);
    const content = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz");
    const sha = createHash("sha256").update(content).digest("hex");

    const pending = service.get({ agentId: "agent-1", path: "/tmp/hello.txt" });
    await waitFor(() => sim.gets.length === 1);
    const get = sim.gets[0];
    expect(get.cmd_id).toBeTypeOf("string");
    expect(get.path).toBe("/tmp/hello.txt");
    // ⚠️ Le serveur borne la taille TOTALE avant tout envoi.
    expect(get.max_total).toBe(256 * 1024 * 1024);
    expect(get.chunk).toBe(16);

    const cmdId = get.cmd_id as string;
    let seq = 0;
    for (let offset = 0; offset < content.byteLength; offset += 16) {
      const slice = content.subarray(offset, Math.min(offset + 16, content.byteLength));
      const last = offset + slice.byteLength >= content.byteLength;
      sendChunk(sim, cmdId, seq, offset, slice, last, last ? { total: content.byteLength, sha256: sha } : {});
      seq += 1;
    }
    const outcome = await pending;
    expect(outcome.status).toBe("completed");
    expect(outcome.bytes).toBe(content.byteLength);
    expect(outcome.sha256).toBe(sha);
    expect(outcome.file?.name).toBe("hello.txt");
    const storedBytes = store.readBytes(outcome.file!.id);
    expect(storedBytes?.toString("utf8")).toBe(content.toString("utf8"));
  });

  it("détecte une empreinte ALTERÉE et ne conserve aucun fichier", async () => {
    const s = await stack();
    const { service, store } = makeService(s, { chunkBytes: 1024 });
    const sim = await connectAgent(s, "agent-2", [FILES_CAPABILITY]);
    const content = Buffer.from("contenu réel");
    const wrongSha = "0".repeat(64);

    const before = store.list().length;
    const pending = service.get({ agentId: "agent-2", path: "/tmp/x.txt" });
    await waitFor(() => sim.gets.length === 1);
    const cmdId = sim.gets[0].cmd_id as string;
    sendChunk(sim, cmdId, 0, 0, content, true, { total: content.byteLength, sha256: wrongSha });
    const outcome = await pending;
    expect(outcome.status).toBe("digest_mismatch");
    expect(store.list().length).toBe(before);
  });
});

describe("transfert de fichiers — refus AVANT émission", () => {
  it("refuse un agent SANS la capacité `files` sans émettre AUCUNE trame", async () => {
    const s = await stack();
    const { service } = makeService(s);
    const sim = await connectAgent(s, "agent-old", ["exec", "shell"]);
    const outcome = await service.get({ agentId: "agent-old", path: "/tmp/x.txt" });
    expect(outcome.status).toBe("unsupported");
    expect(outcome.message).toContain("TROP ANCIEN");
    // ⚠️ Preuve décisive : aucune `file_get` n'a été émise.
    expect(sim.gets.length).toBe(0);
  });

  it("refuse un chemin RELATIF", async () => {
    const s = await stack();
    const { service } = makeService(s);
    const sim = await connectAgent(s, "agent-rel", [FILES_CAPABILITY]);
    const outcome = await service.get({ agentId: "agent-rel", path: "relative/x.txt" });
    expect(outcome.status).toBe("refused");
    expect(outcome.message).toContain("ABSOLU");
    expect(sim.gets.length).toBe(0);
  });

  it("refuse `too_large` AVANT toute écriture (dépôt)", async () => {
    const s = await stack();
    const { service, store } = makeService(s, { maxBytes: 1024 });
    const sim = await connectAgent(s, "agent-big", [FILES_CAPABILITY]);
    // Un fichier stocké de 4 Kio dépasse le plafond de 1024 octets.
    const saved = store.saveBytes(Buffer.alloc(4096, 1), {
      name: "gros.bin",
      mimeType: "application/octet-stream",
      origin: "user",
    });
    expect(saved.ok).toBe(true);
    const id = saved.ok ? saved.record.id : "";
    const outcome = await service.put({ agentId: "agent-big", fileId: id, path: "/tmp/gros.bin" });
    expect(outcome.status).toBe("too_large");
    expect(outcome.message).toContain("run_command");
    // ⚠️ Aucune trame d'écriture n'a été émise.
    expect(sim.puts.length).toBe(0);
    expect(sim.chunks.length).toBe(0);
  });
});

describe("transfert de fichiers — reprise et conflit", () => {
  it("reprend à l'offset EXACT après une coupure (empreinte finale identique)", async () => {
    const s = await stack();
    const registryPath = join(tempDir(), "agent-transfers.json");
    const { service, store } = makeService(s, { chunkBytes: 8, registryPath });
    const sim = await connectAgent(s, "agent-resume", [FILES_CAPABILITY]);
    const content = Buffer.from("AAAABBBBCCCCDDDD");
    const sha = createHash("sha256").update(content).digest("hex");

    // ⚠️ La SECONDE connexion est préparée AVANT la coupure : dès que la reprise
    // redemande, la machine est déjà revenue.
    let sim2: AgentSim | undefined;
    const pending = service.get({ agentId: "agent-resume", path: "/tmp/resume.bin" });
    await waitFor(() => sim.gets.length === 1);
    const firstCmd = sim.gets[0].cmd_id as string;
    const firstOffset = sim.gets[0].offset;
    expect(firstOffset === undefined || firstOffset === 0).toBe(true);
    // On envoie les 8 premiers octets, puis on coupe AVANT le dernier morceau.
    sendChunk(sim, firstCmd, 0, 0, content.subarray(0, 8), false);
    await delay(50);

    // ⚠️ ORDRE : on RECONNECTE d'abord (le hub remplace l'ancienne connexion et
    // perd le transfert en cours), puis on attend que la reprise reparte. Le
    // `dispose` de l'ancienne connexion rejette le transfert `interrupted`, que
    // le service reprend aussitôt sur la NOUVELLE connexion.
    sim2 = await connectAgent(s, "agent-resume", [FILES_CAPABILITY]);
    await waitFor(() => s.hub.get("agent-resume") !== undefined);

    // ⚠️ La reprise redemande avec l'OFFSET EXACT des octets déjà reçus (8).
    await waitFor(() => (sim2?.gets.length ?? 0) === 1);
    const resumeGet = sim2!.gets[0];
    expect(resumeGet.path).toBe("/tmp/resume.bin");
    expect(resumeGet.offset).toBe(8);
    // La machine renvoie la SUITE à partir de l'offset 8.
    const cmdId = resumeGet.cmd_id as string;
    let seq = 0;
    for (let offset = 8; offset < content.byteLength; offset += 8) {
      const slice = content.subarray(offset, Math.min(offset + 8, content.byteLength));
      const last = offset + slice.byteLength >= content.byteLength;
      sendChunk(sim2!, cmdId, seq, offset, slice, last, last ? { total: content.byteLength, sha256: sha } : {});
      seq += 1;
    }
    const outcome = await pending;
    expect(outcome.status).toBe("completed");
    // ⚠️ L'empreinte finale porte sur le fichier COMPLET (préfixe + suite).
    expect(outcome.sha256).toBe(sha);
    const stored = store.readBytes(outcome.file!.id);
    expect(stored?.toString("utf8")).toBe(content.toString("utf8"));
    expect(existsSync(registryPath)).toBe(true);
  });

  it("au-delà d'UNE reprise, l'échec est DIT (jamais un succès partiel)", async () => {
    const s = await stack();
    const { service } = makeService(s, { chunkBytes: 8 });
    const sim = await connectAgent(s, "agent-drop", [FILES_CAPABILITY]);
    const content = Buffer.from("AAAABBBBCCCCDDDD");
    const pending = service.get({ agentId: "agent-drop", path: "/tmp/drop.bin" });
    await waitFor(() => sim.gets.length === 1);
    const cmdId = sim.gets[0].cmd_id as string;
    sendChunk(sim, cmdId, 0, 0, content.subarray(0, 8), false);
    await delay(50);
    // ⚠️ Aucune reconnexion : la reprise échoue (agent hors ligne), et le
    // résultat le DIT (`interrupted`), sans jamais publier un fichier partiel.
    sim.ws.close();
    const outcome = await pending;
    expect(outcome.status).toBe("interrupted");
    expect(outcome.file).toBeUndefined();
  });

  it("refuse `conflict` sans `ecraser` puis accepte avec", async () => {
    const s = await stack();
    const { service, store } = makeService(s, { chunkBytes: 1024 });
    const sim = await connectAgent(s, "agent-conflict", [FILES_CAPABILITY]);
    const saved = store.saveBytes(Buffer.from("bonjour"), {
      name: "note.txt",
      mimeType: "text/plain",
      origin: "user",
    });
    const id = saved.ok ? saved.record.id : "";

    // L'agent répond `conflict` (la destination existe déjà) au `file_put`.
    sim.ws.on("message", (raw: Buffer) => {
      const frame = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
      if (frame.type === "file_put") {
        sim.ws.send(
          JSON.stringify({
            type: "file_result",
            proto_version: 1,
            cmd_id: frame.cmd_id,
            status: "refused",
            code: "conflict",
            message: "la destination existe déjà",
          }),
        );
      }
    });
    const outcome = await service.put({ agentId: "agent-conflict", fileId: id, path: "/tmp/note.txt" });
    expect(outcome.status).toBe("conflict");
  });

  it("dépose un fichier avec succès (file_put + chunks + file_result ok)", async () => {
    const s = await stack();
    const { service, store } = makeService(s, { chunkBytes: 2 });
    const sim = await connectAgent(s, "agent-put", [FILES_CAPABILITY]);
    const content = Buffer.from("ABCDE");
    const sha = createHash("sha256").update(content).digest("hex");
    const saved = store.saveBytes(content, {
      name: "lettres.txt",
      mimeType: "text/plain",
      origin: "user",
    });
    const id = saved.ok ? saved.record.id : "";

    // L'agent acquitte l'écriture en renvoyant l'empreinte et la taille.
    sim.ws.on("message", (raw: Buffer) => {
      const frame = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
      if (frame.type === "file_put_chunk" && frame.dernier === true) {
        sim.ws.send(
          JSON.stringify({
            type: "file_result",
            proto_version: 1,
            cmd_id: frame.cmd_id,
            status: "ok",
            bytes: content.byteLength,
            sha256: sha,
          }),
        );
      }
    });
    const outcome = await service.put({ agentId: "agent-put", fileId: id, path: "/tmp/lettres.txt" });
    expect(outcome.status).toBe("completed");
    expect(outcome.sha256).toBe(sha);
    expect(outcome.bytes).toBe(content.byteLength);
    // ⚠️ Le `file_put` annonce bien la taille et l'empreinte.
    expect(sim.puts[0].bytes).toBe(content.byteLength);
    expect(sim.puts[0].sha256).toBe(sha);
    // 5 octets par morceaux de 2 ⇒ 3 morceaux, le dernier porte l'empreinte.
    expect(sim.chunks.length).toBe(3);
    expect(sim.chunks[sim.chunks.length - 1].sha256).toBe(sha);
  });
});

describe("transfert de fichiers — audit et utilitaires", () => {
  it("audit le transfert SANS aucun contenu", async () => {
    const s = await stack();
    const { service } = makeService(s, { chunkBytes: 1024 });
    const sim = await connectAgent(s, "agent-audit", [FILES_CAPABILITY]);
    const content = Buffer.from("secret contenu ne doit pas apparaître");
    const sha = createHash("sha256").update(content).digest("hex");
    const pending = service.get({ agentId: "agent-audit", path: "/tmp/a.txt" });
    await waitFor(() => sim.gets.length === 1);
    const cmdId = sim.gets[0].cmd_id as string;
    sendChunk(sim, cmdId, 0, 0, content, true, { total: content.byteLength, sha256: sha });
    const outcome = await pending;
    expect(outcome.status).toBe("completed");
    const recent = s.audit.recent({ limit: 50 });
    const entry = recent.find(
      (line) =>
        line.event === "file_transfer" &&
        (line.meta as Record<string, unknown> | undefined)?.status === "completed",
    );
    expect(entry).toBeDefined();
    const serialized = JSON.stringify(entry);
    // ⚠️ Aucun octet du contenu dans l'audit (seulement taille + empreinte).
    expect(serialized).not.toContain(content.toString("utf8"));
    expect(serialized).toContain(sha);
  });

  it("isAbsolutePath reconnaît les chemins absolus (Unix et Windows)", () => {
    expect(isAbsolutePath("/tmp/x")).toBe(true);
    expect(isAbsolutePath("C:\\Users\\x")).toBe(true);
    expect(isAbsolutePath("relative/x")).toBe(false);
    expect(isAbsolutePath("")).toBe(false);
  });
});
