/**
 * IMAGE GÉNÉRÉE → FICHIER DE LA CONVERSATION → lister → lire → déposer.
 *
 * ⚠️ LE TROU QUE CE FICHIER FERME : `generer_image` écrivait l'image UNIQUEMENT
 * dans le store des images générées (`/images/<id>.<ext>`, `src/comfy/images.ts`),
 * un store que `lister_fichiers`, `lire_fichier` et `deposer_fichier` ne résolvent
 * PAS (leurs identifiants sont ceux du store des fichiers, `/^[a-f0-9]{32}$/`).
 * Une image générée n'était donc ni listable, ni lisible, ni transférable :
 * `generer_image` → `deposer_fichier` ne fonctionnait pas.
 *
 * Ce que ce fichier prouve, maillon par maillon, sur les VRAIS stores (aucun
 * octet simulé) :
 *  1. après `generer_image`, l'image est un FICHIER de la conversation, rattaché
 *     à elle, avec un identifiant du store des fichiers ;
 *  2. `lister_fichiers` la montre, avec CET identifiant ;
 *  3. `lire_fichier` en rend un BLOC IMAGE (politique de vision partagée) ;
 *  4. `deposer_fichier` la TRANSFÈRE à une machine (agent simulé, pile mTLS
 *     réelle) — les octets reçus sont exactement ceux de l'image générée ;
 *  5. une copie REFUSÉE (plafond) ou une exception du stockage n'échoue JAMAIS la
 *     génération : l'image est générée et affichée, un AVERTISSEMENT le dit ;
 *  6. DÉDUPLICATION : une image déjà copiée n'est jamais recopiée ;
 *  7. RÉTENTION : la copie expire avec `files.retentionDays` (et la re-copie
 *     repart d'une copie expirée) ; la fiche du store d'images a la SIENNE.
 *
 * ⚠️ Ces tests ÉCHOUENT sur le code d'origine : le module de copie n'existe pas
 * (import en erreur), et à défaut, `lister_fichiers` ne voyait aucune image
 * générée ⇒ l'assertion « la liste contient l'identifiant » échoue.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { AgentFileTransferService, FILES_CAPABILITY } from "../../src/agents/transfer.js";
import { GeneratedImagesStore } from "../../src/comfy/images.js";
import type { ComfyImageView, GeneratedImage } from "../../src/comfy/index.js";
import { DAY_MS } from "../../src/files/retention.js";
import { createFilesService, type FilesService } from "../../src/files/service.js";
import { FilesStore } from "../../src/files/store.js";
import {
  createGeneratedImageFiles,
  type GeneratedImageFilesPort,
} from "../../src/files/generated.js";
import { createFileTransferTools } from "../../src/pi/sdk/execution-tools.js";
import { createImageTools } from "../../src/pi/sdk/image-tools.js";
import { createListFilesTool } from "../../src/pi/sdk/list-files-tool.js";
import { createReadFileTool } from "../../src/pi/sdk/read-file-tool.js";
import { createLogger } from "../../src/observability/logger.js";
import { startTestStack, type TestStack } from "../agents/stack.js";
import { gradientPng } from "../files/png-fixture.js";

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });

const SESSION = "conv-images-generees";
const AUTRE_SESSION = "conv-autre";

/** PNG 1024×1024 RÉEL : au-dessus du minimum lisible (700 px), sous 2 000 px. */
const PNG = gradientPng(1024, 1024);
const PNG_SHA = createHash("sha256").update(PNG).digest("hex");

const dirs: string[] = [];
const stacks: TestStack[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) {
    await stack.close();
    stack.cleanup();
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(purpose: string): string {
  const dir = mkdtempSync(join(tmpdir(), `yuki-${purpose}-`));
  dirs.push(dir);
  return dir;
}

interface Depot {
  images: GeneratedImagesStore;
  files: FilesStore;
  service: FilesService;
  archive: GeneratedImageFilesPort;
}

/** Vrais stores (sur disque, dans un dossier temporaire) — aucun double de stockage. */
function makeDepot(options: {
  clock?: () => number;
  fileRetentionDays?: () => number;
  imageRetentionDays?: () => number;
  fileMaxBytes?: () => number;
} = {}): Depot {
  const clock = options.clock ?? Date.now;
  const images = new GeneratedImagesStore({
    dir: tempDir("comfy-images"),
    logger,
    now: clock,
    retentionDays: options.imageRetentionDays ?? (() => 30),
  });
  images.ensureLayout();
  const files = new FilesStore({
    dir: tempDir("fichiers"),
    logger,
    now: clock,
    retentionDays: options.fileRetentionDays ?? (() => 30),
    ...(options.fileMaxBytes ? { maxBytes: options.fileMaxBytes } : {}),
  });
  files.ensureLayout();
  const service = createFilesService({ store: files, logger });
  const archive = createGeneratedImageFiles({ files, images, logger });
  return { images, files, service, archive };
}

type ContentBlock = { type: string; text?: string; data?: string; mimeType?: string };
type AnyTool = {
  name: string;
  execute: (...args: unknown[]) => Promise<{ content: ContentBlock[]; details?: unknown }>;
};

const CTX = { sessionManager: { getSessionId: () => SESSION } } as never;

interface GenerateHarness {
  tool: AnyTool;
  /** Vues émises vers l'interface (trame de contrôle `image`). */
  views: Array<{ id: string }>;
}

/**
 * Outil `generer_image` branché sur le VRAI store d'images et le VRAI archiveur.
 * `archiveOverride: null` ⇒ AUCUN archiveur (cas d'un host nu).
 */
function generateTool(
  depot: Depot,
  archiveOverride?: GeneratedImageFilesPort | null,
): GenerateHarness {
  const archive = archiveOverride === null ? undefined : (archiveOverride ?? depot.archive);
  const views: Array<{ id: string }> = [];
  const [tool] = createImageTools({
    async generate(): Promise<GeneratedImage> {
      // Exactement ce que fait le générateur réel : écrire l'image, rendre les octets.
      const record = depot.images.save({
        data: PNG,
        mimeType: "image/png",
        promptId: "prompt-1",
        width: 1024,
        height: 1024,
      });
      if (!record) throw new Error("image refusée par le store");
      return {
        record,
        bytes: PNG,
        promptId: "prompt-1",
        workflowName: "manga",
        elapsedMs: 4_000,
        outputLabeled: true,
        labels: ["YUKI_PROMPT"],
      };
    },
    workflows: {
      candidates: () => [{ name: "manga", description: "Manga", isDefault: true }],
      documentationOf: () => "",
    },
    // ⚠️ Type EXPLICITE, identique à `ImageToolPort.onImage`
    // (`src/pi/sdk/image-tools.ts:116`) : dès qu'une assertion (`as never`) ou une
    // construction qui casse le typage contextuel réapparaît, un paramètre nu
    // retombe en `any` implicite (TS7006) et casse `npm run typecheck`.
    onImage: (view: ComfyImageView) => {
      views.push({ id: view.id });
      // Même chaîne que le câblage réel : la vue rattache l'image à la conversation.
      depot.images.attach(view.id, SESSION);
    },
    ...(archive ? { archive } : {}),
  });
  return { tool: tool as unknown as AnyTool, views };
}

async function call(
  tool: AnyTool,
  params: Record<string, unknown>,
): Promise<{ content: ContentBlock[]; text: string; details: Record<string, unknown> }> {
  const result = await tool.execute("call", params, undefined, undefined, CTX);
  return {
    content: result.content,
    text: result.content.map((part) => part.text ?? "").join("\n"),
    details: (result.details ?? {}) as Record<string, unknown>,
  };
}

function listTool(depot: Depot, sessionId = SESSION): AnyTool {
  const [tool] = createListFilesTool(depot.service, { sessionId: () => sessionId });
  return tool as unknown as AnyTool;
}

function readTool(depot: Depot, sessionId = SESSION): AnyTool {
  const [tool] = createReadFileTool(depot.service, {
    sessionId: () => sessionId,
    imagesSupported: true,
    logger,
  });
  return tool as unknown as AnyTool;
}

async function waitFor(condition: () => boolean, timeoutMs = 4_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor : délai dépassé");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ── ① La génération produit un FICHIER de la conversation ──────────────────

describe("generer_image — l'image devient un FICHIER de la conversation", () => {
  it("copie l'image dans le store des fichiers, rattachée à la conversation", async () => {
    const depot = makeDepot();
    const harness = generateTool(depot);

    const result = await call(harness.tool, { scene: "un chat sur un toit" });

    expect(result.details.status).toBe("ok");
    // ⚠️ Identifiant du store des FICHIERS (32 hex) — c'est ce qu'exigent
    // `lire_fichier` et `deposer_fichier`.
    const fileId = result.details.file_id;
    expect(typeof fileId).toBe("string");
    expect(fileId).toMatch(/^[a-f0-9]{32}$/);
    expect(result.details.file_copied).toBe(true);
    expect(result.text).toContain(String(fileId));
    // L'image reste affichée (trame de contrôle inchangée)…
    expect(harness.views).toHaveLength(1);
    // …et le store d'images garde SA copie (le rendu `image-block.js` ne change pas).
    const image = depot.images.get(harness.views[0]!.id);
    expect(image).not.toBeNull();
    expect(image?.fileId).toBe(fileId);

    const record = depot.files.get(String(fileId));
    expect(record).not.toBeNull();
    expect(record?.sessionId).toBe(SESSION);
    expect(record?.mimeType).toBe("image/png");
    expect(record?.bytes).toBe(PNG.byteLength);
    expect(record?.analysis.kind).toBe("image");
    expect(record?.analysis.width).toBe(1024);
    // Les octets copiés sont EXACTEMENT ceux de l'image générée.
    expect(depot.files.readBytes(String(fileId))?.equals(PNG)).toBe(true);
  });
});

// ── ② lister → lire → déposer ───────────────────────────────────────────────

describe("chaîne complète — lister, lire, déposer", () => {
  it("`lister_fichiers` montre l'image générée avec l'identifiant du store FICHIERS", async () => {
    const depot = makeDepot();
    const harness = generateTool(depot);
    const generated = await call(harness.tool, { scene: "un chat sur un toit" });
    const fileId = String(generated.details.file_id);

    const listed = await call(listTool(depot), {});
    const details = listed.details as {
      status: string;
      files?: Array<{ id: string; kind: string; name: string }>;
    };
    expect(details.status).toBe("listed");
    expect(details.files?.[0]?.id).toBe(fileId);
    expect(details.files?.[0]?.kind).toBe("image");
    expect(listed.text).toContain(fileId);
  });

  it("`lire_fichier` rend un BLOC IMAGE (politique de vision partagée)", async () => {
    const depot = makeDepot();
    const harness = generateTool(depot);
    const generated = await call(harness.tool, { scene: "un chat sur un toit" });
    const fileId = String(generated.details.file_id);

    const read = await call(readTool(depot), { identifiant: fileId });
    const image = read.content.find((part) => part.type === "image");
    expect(image).toBeDefined();
    expect(image?.mimeType).toBe("image/png");
    expect(Buffer.from(String(image?.data), "base64").equals(PNG)).toBe(true);
    expect((read.details as { image_attached?: boolean }).image_attached).toBe(true);
  });

  it("`deposer_fichier` la TRANSFÈRE à une machine (agent simulé)", async () => {
    const stack = await startTestStack();
    stacks.push(stack);
    const depot = makeDepot();
    const harness = generateTool(depot);
    const generated = await call(harness.tool, { scene: "un chat sur un toit" });
    const fileId = String(generated.details.file_id);
    // ⚠️ La conversation du transfert est FORCÉE (comme dans le worker lourd).
    const service = new AgentFileTransferService({
      store: stack.store,
      hub: stack.hub,
      audit: stack.audit,
      logger,
      files: depot.files,
      limits: {
        maxBytes: () => 256 * 1024 * 1024,
        chunkBytes: () => 256 * 1024,
        timeoutMs: () => 10_000,
      },
    });

    // Agent SIMULÉ : il annonce la capacité `files` et acquitte l'écriture.
    stack.register("machine-1");
    const cert = stack.ca.signClientCertificate("machine-1");
    const received: Buffer[] = [];
    const ws = new WebSocket(`wss://127.0.0.1:${stack.port}/ws`, {
      cert: cert.certPem,
      key: cert.keyPem,
      rejectUnauthorized: false,
    });
    ws.on("message", (raw: Buffer) => {
      const frame = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
      if (frame.type !== "file_put_chunk") return;
      received.push(Buffer.from(String(frame.data), "base64"));
      if (frame.dernier === true) {
        ws.send(
          JSON.stringify({
            type: "file_result",
            proto_version: 1,
            cmd_id: frame.cmd_id,
            status: "ok",
            bytes: PNG.byteLength,
            sha256: PNG_SHA,
          }),
        );
      }
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => {
        ws.send(
          JSON.stringify({
            type: "hello",
            proto_version: 1,
            agent_id: "machine-1",
            agent_version: "0.1.0",
            euid: 1000,
            caps: [FILES_CAPABILITY],
          }),
        );
        resolve();
      });
      ws.once("error", reject);
    });
    await waitFor(() => stack.hub.caps("machine-1").length > 0);

    const deposer = createFileTransferTools(service, {
      approvalSessionId: () => SESSION,
    }).find((candidate) => candidate.name === "deposer_fichier");
    const outcome = await call(deposer as unknown as AnyTool, {
      agent: "machine-1",
      fichier: fileId,
      chemin_distant: "/home/nico/image-generee.png",
    });

    expect((outcome.details as { status: string }).status).toBe("completed");
    expect((outcome.details as { sha256?: string }).sha256).toBe(PNG_SHA);
    // ⚠️ La machine a reçu l'image ENTIÈRE, octet pour octet.
    expect(Buffer.concat(received).equals(PNG)).toBe(true);
    ws.close();
  });
});

// ── ③ La génération ne dépend JAMAIS du stockage ────────────────────────────

describe("copie impossible — la génération réussit quand même", () => {
  it("copie REFUSÉE (plafond) ⇒ génération réussie, avertissement explicite", async () => {
    // Le store des fichiers refuse tout : l'image ne peut pas être copiée.
    const depot = makeDepot({ fileMaxBytes: () => 16 });
    const harness = generateTool(depot);

    const result = await call(harness.tool, { scene: "un chat sur un toit" });

    expect(result.details.status).toBe("ok");
    expect(result.details.file_id).toBeNull();
    expect(result.details.file_copied).toBe(false);
    expect(result.details.file_error).toBe("too_large");
    expect(result.text).toContain("n'a PAS pu être enregistrée");
    expect(result.text).toContain("deposer_fichier");
    // ⚠️ L'image est TOUJOURS générée, affichée et conservée côté Comfy.
    expect(harness.views).toHaveLength(1);
    expect(depot.images.get(harness.views[0]!.id)).not.toBeNull();
    expect(depot.files.list({ sessionId: SESSION })).toHaveLength(0);
  });

  it("exception du stockage ⇒ génération réussie, avertissement explicite", async () => {
    const depot = makeDepot();
    const exploding: GeneratedImageFilesPort = {
      archive() {
        throw new Error("disque plein");
      },
    };
    const harness = generateTool(depot, exploding);

    const result = await call(harness.tool, { scene: "un chat sur un toit" });

    expect(result.details.status).toBe("ok");
    expect(result.details.file_error).toBe("io_error");
    expect(result.text).toContain("disque plein");
    expect(harness.views).toHaveLength(1);
  });

  it("sans archiveur branché, l'outil ne promet rien", async () => {
    const depot = makeDepot();
    const harness = generateTool(depot, null);

    const result = await call(harness.tool, { scene: "un chat sur un toit" });

    expect(result.details.status).toBe("ok");
    expect(result.details.file_id).toBeNull();
    expect(result.text).not.toContain("lister_fichiers");
    expect(depot.files.list({ sessionId: SESSION })).toHaveLength(0);
  });
});

// ── ④ Déduplication ────────────────────────────────────────────────────────

describe("déduplication — pas de double copie", () => {
  it("copier deux fois la MÊME image ne crée qu'un fichier", async () => {
    const depot = makeDepot();
    const harness = generateTool(depot);
    const generated = await call(harness.tool, { scene: "un chat sur un toit" });
    const imageId = harness.views[0]!.id;
    const firstId = String(generated.details.file_id);

    // Deuxième copie de la même image (reprise, double appel) : aucun octet réécrit.
    const second = depot.archive.archive({
      imageId,
      data: PNG,
      mimeType: "image/png",
      sessionId: SESSION,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.copied).toBe(false);
    expect(second.file.id).toBe(firstId);
    expect(depot.files.list({ sessionId: SESSION })).toHaveLength(1);
  });
});

// ── ⑤ Rétention ───────────────────────────────────────────────────────────

describe("rétention — la copie expire avec files.retentionDays", () => {
  it("expire la copie (1 jour) sans toucher l'image Comfy (30 jours), puis est refaite", async () => {
    const start = Date.parse("2026-11-01T10:00:00.000Z");
    let clock = start;
    const depot = makeDepot({
      clock: () => clock,
      fileRetentionDays: () => 1,
      imageRetentionDays: () => 30,
    });
    const harness = generateTool(depot);
    const generated = await call(harness.tool, { scene: "un chat sur un toit" });
    const fileId = String(generated.details.file_id);
    const imageId = harness.views[0]!.id;
    expect(depot.files.get(fileId)).not.toBeNull();

    // Deux jours plus tard : la COPIE du store des fichiers a expiré…
    clock = start + 2 * DAY_MS;
    expect(depot.files.purgeExpired()).toBe(1);
    expect(depot.files.get(fileId)).toBeNull();
    expect((await call(listTool(depot), {})).details.status).toBe("empty");
    // …alors que l'image du store Comfy (30 jours) est toujours là.
    expect(depot.images.get(imageId)).not.toBeNull();

    // Une copie expirée ne bloque pas la suivante : la déduplication ne retient
    // qu'une copie ENCORE VALABLE.
    const again = depot.archive.archive({
      imageId,
      data: PNG,
      mimeType: "image/png",
      sessionId: SESSION,
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.copied).toBe(true);
    expect(again.file.id).not.toBe(fileId);
    expect(depot.files.get(again.file.id)).not.toBeNull();
  });

  it("la copie d'une AUTRE conversation n'est pas visible par lister_fichiers", async () => {
    const depot = makeDepot();
    const harness = generateTool(depot);
    await call(harness.tool, { scene: "un chat sur un toit" });

    const other = await call(listTool(depot, AUTRE_SESSION), {});
    expect(other.details.status).toBe("empty");
  });
});
