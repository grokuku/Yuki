/**
 * RÉFÉRENCE D'UN FICHIER À DÉPOSER : IDENTIFIANT, jamais un nom.
 *
 * Le transfert lui-même (trames, empreinte, atomicité, reprise) est couvert par
 * `tests/agents/transfer.test.ts` — ⚠️ ces tests-là ne sont PAS touchés ici.
 *
 * Ce fichier verrouille l'ÉCART entre ce que le modèle LIT et ce que le code
 * FAIT réellement :
 *   1. la DESCRIPTION de l'outil `deposer_fichier` doit exiger l'IDENTIFIANT
 *      (le stockage refuse tout ce qui n'est pas 32 hexadécimaux :
 *      `src/files/store.ts`, `ID_RE`), et ne doit plus proposer un nom ;
 *   2. le message d'erreur d'une référence invalide doit DIRE QUOI PASSER, et,
 *      si plusieurs fichiers portent le même nom, le dire explicitement sans
 *      jamais choisir à la place du modèle.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AgentFileTransferService,
  FILES_CAPABILITY,
  looksLikeFileId,
  unknownFileReferenceMessage,
} from "../../src/agents/transfer.js";
import { FilesStore } from "../../src/files/store.js";
import type { TransferServicePort } from "../../src/agents/transfer.js";
import { createLogger } from "../../src/observability/logger.js";
import { createFileTransferTools } from "../../src/pi/sdk/execution-tools.js";
import { startTestStack, type TestStack } from "./stack.js";
import { WebSocket } from "ws";

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
const stacks: TestStack[] = [];
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-transfer-ref-"));
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

const CONVERSATION = "ses-reference";

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

/** Agent simulé qui annonce la capacité `files` (aucune trame de fichier ici). */
async function connectAgent(s: TestStack, agentId: string, caps: string[]): Promise<void> {
  s.register(agentId);
  const cert = s.ca.signClientCertificate(agentId);
  const ws = new WebSocket(`wss://127.0.0.1:${s.port}/ws`, {
    cert: cert.certPem,
    key: cert.keyPem,
    rejectUnauthorized: false,
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
  await waitFor(() => s.hub.caps(agentId).length > 0);
}

interface PutHarness {
  service: AgentFileTransferService;
  store: FilesStore;
}

function makeService(s: TestStack): PutHarness {
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
      maxBytes: () => 256 * 1024 * 1024,
      chunkBytes: () => 192 * 1024,
      timeoutMs: () => 10_000,
    },
  });
  return { service, store };
}

/** Dépose un fichier dans le stockage, rattaché à une conversation. */
function seedFile(store: FilesStore, name: string, sessionId: string): string {
  const saved = store.saveBytes(Buffer.from("temoin"), {
    name,
    mimeType: "text/plain",
    origin: "user",
    sessionId,
  });
  if (!saved.ok) throw new Error("dépôt de test refusé");
  return saved.record.id;
}

// ── 1. Ce que le MODÈLE lit (description de l'outil) ────────────────────────

type SchemaNode = {
  description?: string;
  properties?: Record<string, SchemaNode>;
};

type AnyTool = {
  name: string;
  description?: string;
  promptSnippet?: string;
  parameters?: SchemaNode;
};

function transferTools(): AnyTool[] {
  const stub: TransferServicePort = {
    get: async (request) => ({
      status: "refused",
      agentId: request.agentId,
      direction: "get",
      path: request.path,
      message: "stub",
    }),
    put: async (request) => ({
      status: "refused",
      agentId: request.agentId,
      direction: "put",
      path: request.path,
      message: "stub",
    }),
  };
  return createFileTransferTools(stub) as unknown as AnyTool[];
}

describe("description de l'outil `deposer_fichier` — IDENTIFIANT STRICT", () => {
  it("la description dit IDENTIFIANT, « PAS son nom », et ne propose PLUS un nom", () => {
    const put = transferTools().find((tool) => tool.name === "deposer_fichier");
    expect(put).toBeDefined();
    const description = put?.description ?? "";
    // Ce que le code fait réellement (`FilesPort.get` ⇒ `ID_RE`) : l'identifiant.
    expect(description).toContain("IDENTIFIANT");
    // Décision utilisateur : le nom est explicitement écarté, et c'est dit.
    expect(description).toContain("PAS son nom");
    // ⚠️ Le texte d'origine annonçait « identifiant ou nom fourni par l'utilisateur ».
    expect(description).not.toMatch(/identifiant ou nom/i);
    expect(description).not.toMatch(/ou nom EXACT/i);
  });

  it("la description dit OÙ trouver l'identifiant (marqueur, file_id, URL)", () => {
    const put = transferTools().find((tool) => tool.name === "deposer_fichier");
    const description = put?.description ?? "";
    expect(description).toContain("[fichier] <identifiant>");
    expect(description).toContain("file_id");
    expect(description).toContain("/fichiers/<identifiant>");
  });

  it("le paramètre `fichier` dit IDENTIFIANT, « PAS son nom », et comment l'obtenir", () => {
    const put = transferTools().find((tool) => tool.name === "deposer_fichier");
    const fichier = put?.parameters?.properties?.fichier;
    expect(fichier).toBeDefined();
    const description = fichier?.description ?? "";
    expect(description).toContain("IDENTIFIANT");
    expect(description).toContain("PAS son nom");
    expect(description).toContain("file_id");
    // Aucune équivalence « identifiant OU nom » : le nom est explicitement refusé.
    expect(description).not.toMatch(/\bou nom\b/i);
    expect(description).toMatch(/refus/i);
  });

  it("le promptSnippet de `deposer_fichier` porte lui aussi l'exigence", () => {
    const put = transferTools().find((tool) => tool.name === "deposer_fichier");
    expect(put?.promptSnippet ?? "").toContain("IDENTIFIANT");
    expect(put?.promptSnippet ?? "").toContain("PAS son nom");
  });

  it("`recuperer_fichier` accepte bien le NOM ou l'identifiant de la MACHINE", () => {
    // ⚠️ Symétrie vérifiée : la machine, elle, se résout par nom (`AgentStore.resolve`).
    // La description doit donc continuer à le dire — aucune régression.
    const get = transferTools().find((tool) => tool.name === "recuperer_fichier");
    expect(get?.description ?? "").toMatch(/NOM ou son identifiant/);
  });
});

// ── 2. Ce que le MODÈLE reçoit en cas de référence invalide (message) ───────

describe("message d'erreur d'une référence de fichier invalide", () => {
  it("looksLikeFileId distingue un identifiant d'un nom", () => {
    expect(looksLikeFileId("9f2c0a7b1d4e6f8a0b1c2d3e4f5a6b7c")).toBe(true);
    expect(looksLikeFileId("temoin.txt")).toBe(false);
    expect(looksLikeFileId("/home/nico/temoin.txt")).toBe(false);
  });

  it("un NOM sans correspondance : refus qui dit quoi passer et où le trouver", () => {
    const message = unknownFileReferenceMessage("rapport.log");
    expect(message).toContain("n'est pas un identifiant");
    expect(message).toContain("IDENTIFIANT");
    // Où le trouver : les trois sources réelles.
    expect(message).toContain("[fichier] <identifiant>");
    expect(message).toContain("file_id");
    expect(message).toContain("/fichiers/<identifiant>");
  });

  it("un identifiant invalide : refus qui dit quoi passer ET reprend la valeur", () => {
    const bogus = "00000000000000000000000000000000";
    const message = unknownFileReferenceMessage(bogus);
    expect(message).toContain(bogus);
    expect(message).toContain("IDENTIFIANT");
    expect(message).toContain("recuperer_fichier");
  });

  it("plusieurs fichiers du MÊME nom : « utilisez l'IDENTIFIANT » et les candidats listés", () => {
    const message = unknownFileReferenceMessage("temoin.txt", [
      { id: "a".repeat(32), name: "temoin.txt" } as never,
      { id: "b".repeat(32), name: "temoin.txt" } as never,
    ]);
    expect(message).toContain("plusieurs fichiers");
    expect(message).toStrictEqual(expect.stringContaining("utilisez l'IDENTIFIANT"));
    expect(message).toContain("a".repeat(32));
    expect(message).toContain("b".repeat(32));
  });

  it("service.put avec un NOM UNIQUE : refus STRICT, message actionnable (aucune trame émise)", async () => {
    const s = await startTestStack();
    stacks.push(s);
    const { service, store } = makeService(s);
    await connectAgent(s, "agent-ref", ["exec", FILES_CAPABILITY]);
    // ⚠️ Le fichier EXISTE et son nom est UNIQUE : il est quand même refusé.
    const id = seedFile(store, "rapport.log", CONVERSATION);

    const outcome = await service.put({
      agentId: "agent-ref",
      fileId: "rapport.log",
      path: "/tmp/rapport.log",
      sessionId: CONVERSATION,
    });
    expect(outcome.status).toBe("not_found");
    // Décision utilisateur : IDENTIFIANT STRICT — aucun repli « nom unique ».
    expect(outcome.message).toMatch(/pas un identifiant/);
    expect(outcome.message).toContain("IDENTIFIANT");
    expect(outcome.message).toContain("PAS son nom");
    // Où l'obtenir, et QUELLE valeur passer.
    expect(outcome.message).toContain("file_id");
    expect(outcome.message).toContain(id);
    // Rien n'a été transféré.
    expect(outcome.bytes).toBeUndefined();
    expect(outcome.file).toBeUndefined();
  });

  it("service.put avec un IDENTIFIANT inconnu : not_found, le message dit quoi passer", async () => {
    const s = await startTestStack();
    stacks.push(s);
    const { service } = makeService(s);
    await connectAgent(s, "agent-ref2", ["exec", FILES_CAPABILITY]);
    const bogus = "f".repeat(32);

    const outcome = await service.put({
      agentId: "agent-ref2",
      fileId: bogus,
      path: "/tmp/temoin.txt",
      sessionId: CONVERSATION,
    });
    expect(outcome.status).toBe("not_found");
    expect(outcome.message).toContain(bogus);
    expect(outcome.message).toContain("IDENTIFIANT");
    expect(outcome.message).toContain("recuperer_fichier");
  });

  it("service.put avec deux homonymes : l'ambiguïté est DITE, le nom n'est jamais accepté", async () => {
    const s = await startTestStack();
    stacks.push(s);
    const { service, store } = makeService(s);
    await connectAgent(s, "agent-ref3", ["exec", FILES_CAPABILITY]);
    const first = seedFile(store, "temoin.txt", CONVERSATION);
    const second = seedFile(store, "temoin.txt", CONVERSATION);

    const outcome = await service.put({
      agentId: "agent-ref3",
      fileId: "temoin.txt",
      path: "/tmp/temoin.txt",
      sessionId: CONVERSATION,
    });
    expect(outcome.status).toBe("not_found");
    expect(outcome.message).toContain("plusieurs fichiers");
    expect(outcome.message).toContain("utilisez l'IDENTIFIANT");
    expect(outcome.message).toContain(first);
    expect(outcome.message).toContain(second);
  });
});
