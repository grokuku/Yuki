/**
 * Outils d'ACTION du worker lourd — RATTACHEMENT DE LA VALIDATION (piège ①).
 *
 * ⚠️ PIÈGE ① : une demande de validation est routée par `sessionId`. Le worker
 * tourne dans une session ÉPHÉMÈRE : si l'outil prenait l'ID de CETTE session,
 * la fenêtre de validation s'afficherait dans une conversation invisible (trou
 * de sécurité). On prouve ici que `buildHeavyActionTools` (utilisé par le vrai
 * worker) FORCE l'ID de la CONVERSATION propriétaire, et que l'ANCIEN
 * comportement (contexte seul) enverrait bien l'ID éphémère — ce que le test
 * NEUTRALISE en inversant l'assertion.
 */

import { describe, expect, it } from "vitest";

import type {
  ExecutionOutcome,
  ExecutionRequest,
  ExecutionServicePort,
  ScreenshotOutcome,
  ScreenshotRequest,
  ScreenshotServicePort,
} from "../../src/agents/execution.js";
import {
  createExecutionTools,
  createScreenshotTool,
} from "../../src/pi/sdk/execution-tools.js";
import { buildHeavyActionTools } from "../../src/pi/sdk/heavy-worker.js";
import type {
  LibrarianArchivePort,
  LibrarianPort,
  LibrarianReadPort,
} from "../../src/librarian/types.js";
import type {
  FileGetRequest,
  FilePutRequest,
  TransferOutcome,
  TransferServicePort,
} from "../../src/agents/transfer.js";
import type {
  FilesReadPort,
  StoredFileRecord,
  WireFile,
} from "../../src/files/types.js";

function stubTransfers(): { service: TransferServicePort; gets: FileGetRequest[]; puts: FilePutRequest[] } {
  const gets: FileGetRequest[] = [];
  const puts: FilePutRequest[] = [];
  const service: TransferServicePort = {
    get: async (request: FileGetRequest): Promise<TransferOutcome> => {
      gets.push(request);
      return {
        status: "completed",
        agentId: request.agentId,
        direction: "get",
        path: request.path,
        bytes: 1234,
        sha256: "e".repeat(64),
        message: "récupéré",
      };
    },
    put: async (request: FilePutRequest): Promise<TransferOutcome> => {
      puts.push(request);
      return {
        status: "completed",
        agentId: request.agentId,
        direction: "put",
        path: request.path,
        bytes: 42,
        sha256: "f".repeat(64),
        message: "déposé",
      };
    },
  };
  return { service, gets, puts };
}


/** Ports du libraire pour un job (client + archivage), avec journal d'appels. */
function stubLibrarian(): {
  client: LibrarianPort;
  archive: LibrarianArchivePort;
  read: LibrarianReadPort;
  calls: string[];
} {
  const calls: string[] = [];
  const client: LibrarianPort = {
    status: async () => ({}),
    search: async () => {
      calls.push("search");
      return { results: [] } as never;
    },
    library: async () => ({ library: [] }) as never,
    doc: async () => ({}) as never,
    archive: async () => ({ name: "x", version: "1", status: 201 }),
  };
  const archive: LibrarianArchivePort = {
    schedule: () => ({ status: "launched", job_id: "j1" }),
  };
  // ⚠️ PORT DE LECTURE D'UNE PAGE (`POST /read`) : c'est LUI qui donne
  // `lire_page_web` — celui qui manquait à la tâche planifiée du 2026-11-16.
  const read: LibrarianReadPort = {
    read: async (url: string) => {
      calls.push("read");
      return { url, text: "texte de la page", truncated: false } as never;
    },
  };
  return { client, archive, read, calls };
}

/** Session ÉPHÉMÈRE du worker : un ID DIFFÉRENT de la conversation. */
const EPHEMERAL = "ephemeral-session-xyz";
const CONVERSATION = "conv-utilisateur-42";

/** Contexte d'outil du SDK : renvoie l'ID de la session ÉPHÉMÈRE. */
const ephemeralCtx = {
  sessionManager: { getSessionId: () => EPHEMERAL },
} as never;

function stubExecution(): {
  service: ExecutionServicePort;
  calls: ExecutionRequest[];
} {
  const calls: ExecutionRequest[] = [];
  const service: ExecutionServicePort = {
    execute: async (request: ExecutionRequest): Promise<ExecutionOutcome> => {
      calls.push(request);
      return {
        status: "completed",
        agentId: request.agentId,
        command: request.command,
        destructive: false,
        destructiveIds: [],
        exitCode: 0,
        framed: "<sortie>ok</sortie>",
        message: "ok",
      };
    },
  };
  return { service, calls };
}

function stubScreenshot(): {
  service: ScreenshotServicePort;
  calls: ScreenshotRequest[];
} {
  const calls: ScreenshotRequest[] = [];
  const service: ScreenshotServicePort = {
    capture: async (request: ScreenshotRequest): Promise<ScreenshotOutcome> => {
      calls.push(request);
      return { status: "captured", agentId: request.agentId, message: "ok" };
    },
  };
  return { service, calls };
}

/**
 * Port des fichiers DOUBLE : une pièce jointe TEXTE de la CONVERSATION, et rien
 * d'autre. Sert à prouver que le worker LIT le contenu de la bonne conversation.
 */
const FILE_ID = "b".repeat(32);
/** Identifiant d'une pièce jointe IMAGE (repli de vision). */
const FILE_IMAGE_ID = "c".repeat(32);

function stubFiles(): FilesReadPort {
  const wire: WireFile = {
    id: FILE_ID,
    name: "notes.txt",
    mimeType: "text/plain",
    bytes: 11,
    kind: "text",
    readable: true,
    url: `/fichiers/${FILE_ID}.txt`,
    createdAt: "2026-11-01T10:00:00.000Z",
    expiresAt: "2026-12-01T10:00:00.000Z",
  };
  const record = {
    id: FILE_ID,
    name: wire.name,
    mimeType: wire.mimeType,
    ext: "txt",
    bytes: 11,
    createdAt: wire.createdAt,
    expiresAt: wire.expiresAt,
    origin: "user",
    sessionId: CONVERSATION,
    analysis: { kind: "text", readable: true, chars: 11 },
  } as StoredFileRecord;
  return {
    listForSession: (sessionId: string) => (sessionId === CONVERSATION ? [wire] : []),
    get: (id: string) => (id === FILE_ID ? record : null),
    readBytes: (id: string) => (id === FILE_ID ? Buffer.from("coucou toi\n") : null),
    prepareImages: async () => ({ ok: true, images: [] }),
  };
}

type AnyTool = { name: string; execute: (...args: unknown[]) => Promise<unknown> };

async function invoke(tool: AnyTool, params: Record<string, unknown>, ctx: unknown): Promise<void> {
  await tool.execute("call", params, undefined, undefined, ctx);
}

describe("outils d'action du worker lourd — rattachement de la validation", () => {
  it("buildHeavyActionTools expose run_command ET capturer_ecran quand les services sont fournis", () => {
    const { service: execution } = stubExecution();
    const { service: screenshots } = stubScreenshot();
    const tools = buildHeavyActionTools({ execution, screenshots }, CONVERSATION);
    expect(tools.map((tool) => tool.name).sort()).toEqual(["capturer_ecran", "run_command"]);
  });

  it("buildHeavyActionTools expose recuperer_fichier/deposer_fichier quand le transfert existe", () => {
    const { service } = stubTransfers();
    const tools = buildHeavyActionTools({ transfers: service }, CONVERSATION);
    expect(tools.map((tool) => tool.name).sort()).toEqual(["deposer_fichier", "recuperer_fichier"]);
  });

  it("recuperer_fichier RATTACHE la validation à la CONVERSATION (jamais l'éphémère)", async () => {
    const { service, gets } = stubTransfers();
    const tools = buildHeavyActionTools({ transfers: service }, CONVERSATION);
    const get = tools.find((tool) => tool.name === "recuperer_fichier") as unknown as AnyTool;
    await invoke(get, { agent: "nuc00", chemin: "/home/x/a.txt" }, ephemeralCtx);
    expect(gets[0]?.sessionId).toBe(CONVERSATION);
    expect(gets[0]?.path).toBe("/home/x/a.txt");
  });

  it("deposer_fichier transmet `ecraser` SEULEMENT si demandé", async () => {
    const { service, puts } = stubTransfers();
    const tools = buildHeavyActionTools({ transfers: service }, CONVERSATION);
    const put = tools.find((tool) => tool.name === "deposer_fichier") as unknown as AnyTool;
    await invoke(put, { agent: "nuc00", fichier: "abc.txt", chemin_distant: "/tmp/x" }, ephemeralCtx);
    expect(puts[0]?.ecraser).toBeUndefined();
    await invoke(
      put,
      { agent: "nuc00", fichier: "abc.txt", chemin_distant: "/tmp/x", ecraser: true },
      ephemeralCtx,
    );
    expect(puts[1]?.ecraser).toBe(true);
  });

  it("buildHeavyActionTools n'expose RIEN sans service (worker sans exécution)", () => {
    expect(buildHeavyActionTools({}, CONVERSATION)).toEqual([]);
  });

  it("⚠️ buildHeavyActionTools expose le LIBRAIRE (une tâche différée peut vérifier le web)", () => {
    // ⚠️ Bug du 2026-11-16 : une tâche planifiée se réveillait SANS
    // `recherche_libraire` ni `lire_page_web` — elle rendait un échec muet.
    // Les outils du libraire sont désormais construits pour le run DIFFÉRÉ, avec
    // les MÊMES ports que la conversation, et JAMAIS la capture.
    const tools = buildHeavyActionTools({ librarian: () => stubLibrarian() }, CONVERSATION);
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "archive_libraire",
      "lire_libraire",
      "lire_page_web",
      "liste_libraire",
      "recherche_libraire",
    ]);
  });

  it("⚠️ les ports du libraire sont RELUS à chaque job (une capacité ajoutée profite aux tâches existantes)", () => {
    let ports: ReturnType<typeof stubLibrarian> | undefined;
    const config = { librarian: () => ports };
    expect(buildHeavyActionTools(config, CONVERSATION)).toEqual([]);
    ports = stubLibrarian();
    expect(buildHeavyActionTools(config, CONVERSATION).map((tool) => tool.name)).toContain(
      "recherche_libraire",
    );
  });

  it("le libraire du worker CHERCHE pour de vrai (port câblé, pas seulement annoncé)", async () => {
    const librarian = stubLibrarian();
    const tools = buildHeavyActionTools({ librarian: () => librarian }, CONVERSATION);
    const recherche = tools.find((tool) => tool.name === "recherche_libraire") as unknown as AnyTool;
    await recherche.execute("call", { query: "prix amazon" }, undefined, undefined, ephemeralCtx);
    expect(librarian.calls).toContain("search");
  });

  it("buildHeavyActionTools expose lister_fichiers ET lire_fichier (le worker LIT le contenu)", () => {
    const tools = buildHeavyActionTools({ files: stubFiles() }, CONVERSATION);
    // ⚠️ Avant `lire_fichier`, le worker recevait la liste et AUCUN contenu : il
    // savait qu'une image existait, en avait l'identifiant, et ne pouvait rien en
    // faire. Les deux outils sont maintenant attachés ensemble.
    expect(tools.map((tool) => tool.name).sort()).toEqual(["lire_fichier", "lister_fichiers"]);
  });

  it("lire_fichier lit la CONVERSATION propriétaire (jamais la session éphémère)", async () => {
    const tools = buildHeavyActionTools({ files: stubFiles() }, CONVERSATION);
    const read = tools.find((tool) => tool.name === "lire_fichier") as unknown as AnyTool;
    const result = (await read.execute("call", { identifiant: FILE_ID }, undefined, undefined, ephemeralCtx)) as {
      content: { type: string; text?: string }[];
    };
    expect(result.content.map((block) => block.text ?? "").join("")).toContain("coucou toi");
  });

  it("⚠️ VISION DE REPLI : le worker lourd (donc une TÂCHE PLANIFIÉE) fait DÉCRIRE l'image", async () => {
    // ⚠️ Une tâche planifiée / un déclencheur passe par CES outils
    // (`buildHeavyActionTools`). Quand le modèle lourd est déclaré sans vision,
    // `lire_fichier` ne refuse plus : le modèle de repli décrit l'image, et la
    // description remplace le bloc image (le worker voit une DESCRIPTION).
    const described: number[] = [];
    const tools = buildHeavyActionTools(
      {
        files: {
          listForSession: () => [
            {
              id: FILE_IMAGE_ID,
              name: "capture.png",
              mimeType: "image/png",
              bytes: 70,
              createdAt: "2026-11-16T00:00:00.000Z",
              expiresAt: "2026-12-16T00:00:00.000Z",
              url: `/api/files/${FILE_IMAGE_ID}`,
            } as unknown as WireFile,
          ],
          get: (id: string) =>
            id === FILE_IMAGE_ID
              ? ({
                  id: FILE_IMAGE_ID,
                  name: "capture.png",
                  mimeType: "image/png",
                  bytes: 70,
                  sha256: "a".repeat(64),
                  createdAt: "2026-11-16T00:00:00.000Z",
                  expiresAt: "2026-12-16T00:00:00.000Z",
                  origin: "user",
                  sessionId: CONVERSATION,
                  analysis: { kind: "image", readable: false },
                } as unknown as StoredFileRecord)
              : null,
          readBytes: () => null,
          prepareImages: async () => ({
            ok: true as const,
            images: [{ data: "AAAA", mimeType: "image/png" }],
          }),
        },
        visionFallback: async (images) => {
          described.push(images.length);
          return {
            kind: "described",
            modele: "llm-light/vision",
            descriptions: [{ texte: "Une capture avec un bouton « OK »." }],
            ignorees: [],
          };
        },
      },
      CONVERSATION,
      { modelLabel: "llm-heavy/texte-seul", imagesSupported: false },
    );
    const read = tools.find((tool) => tool.name === "lire_fichier") as unknown as AnyTool;
    const result = (await read.execute(
      "call",
      { identifiant: FILE_IMAGE_ID },
      undefined,
      undefined,
      ephemeralCtx,
    )) as { content: { type: string; text?: string }[] };

    expect(described).toEqual([1]);
    const texte = result.content.map((block) => block.text ?? "").join("");
    expect(result.content.every((block) => block.type === "text")).toBe(true);
    expect(texte).toContain("Description d'image par le modèle de vision de repli");
    expect(texte).toContain("bouton « OK »");
  });

  it("run_command RATTACHE la validation à la CONVERSATION, pas à la session éphémère", async () => {
    const { service, calls } = stubExecution();
    // Chemin RÉEL du worker : sessionId forcé à la conversation propriétaire.
    const tools = buildHeavyActionTools({ execution: service }, CONVERSATION);
    const runCommand = tools.find((tool) => tool.name === "run_command") as unknown as AnyTool;
    await invoke(runCommand, { agent_id: "nuc00", command: "echo hi" }, ephemeralCtx);
    expect(calls).toHaveLength(1);
    // ⚠️ L'ANCIEN comportement aurait mis l'ID éphémère ici : la fenêtre serait
    // apparue dans une conversation invisible. On exige la CONVERSATION.
    expect(calls[0]?.sessionId).toBe(CONVERSATION);
    expect(calls[0]?.sessionId).not.toBe(EPHEMERAL);
  });

  it("capturer_ecran RATTACHE aussi la validation à la CONVERSATION", async () => {
    const { service, calls } = stubScreenshot();
    const tools = buildHeavyActionTools({ screenshots: service }, CONVERSATION);
    const capture = tools.find((tool) => tool.name === "capturer_ecran") as unknown as AnyTool;
    await invoke(capture, { agent_id: "nuc00" }, ephemeralCtx);
    expect(calls[0]?.sessionId).toBe(CONVERSATION);
  });

  it("PROPAGE l'ORIGINE de la tâche de fond jusqu'au service d'exécution", async () => {
    // ⚠️ LOT 4/4 : sans ce NOM, le garde-fou ne saurait pas QUELLE
    // pré-autorisation s'applique — une tâche de fond ne pourrait jamais agir.
    const { service, calls } = stubExecution();
    const tools = buildHeavyActionTools({ execution: service }, CONVERSATION, undefined, undefined, "declencheur:veille");
    const runCommand = tools.find((tool) => tool.name === "run_command") as unknown as AnyTool;
    await invoke(runCommand, { agent_id: "nuc00", command: "df -h" }, ephemeralCtx);
    expect(calls[0]?.origin).toBe("declencheur:veille");

    // Un tour HUMAIN garde le nom de l'outil : la porte des pré-autorisations
    // reste fermée (l'origine n'est pas « declencheur »).
    const humain = buildHeavyActionTools({ execution: service }, CONVERSATION);
    const runHumain = humain.find((tool) => tool.name === "run_command") as unknown as AnyTool;
    await invoke(runHumain, { agent_id: "nuc00", command: "df -h" }, ephemeralCtx);
    expect(calls[1]?.origin).toBe("run_command");
  });

  it("DÉTECTION DE L'ANCIEN COMPORTEMENT : sans ID forcé, l'outil prend l'ID du contexte (éphémère)", async () => {
    const { service, calls } = stubExecution();
    // C'est EXACTEMENT ce que faisait l'ancien câblage (contexte seul) : le
    // test prouve que le nouveau chemin DIFFÈRE (sinon la garantie serait vide).
    const tools = createExecutionTools(service);
    const runCommand = tools[0] as unknown as AnyTool;
    await invoke(runCommand, { agent_id: "nuc00", command: "echo hi" }, ephemeralCtx);
    expect(calls[0]?.sessionId).toBe(EPHEMERAL);
    expect(calls[0]?.sessionId).not.toBe(CONVERSATION);

    // Même preuve pour la capture : sans override, c'est l'ID du contexte.
    const shots = stubScreenshot();
    const shotTools = createScreenshotTool(shots.service);
    await invoke(shotTools[0] as unknown as AnyTool, { agent_id: "nuc00" }, ephemeralCtx);
    expect(shots.calls[0]?.sessionId).toBe(EPHEMERAL);
  });
});
