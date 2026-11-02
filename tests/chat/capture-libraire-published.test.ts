/**
 * CAPTURES de `capture_libraire` PUBLIÉES dans le canal (Mattermost ET Discord).
 *
 * ⚠️ DÉFAUT DE PRODUCTION DU 2026-11-02 (capture Mattermost) : l'utilisateur a
 * demandé « une capture en 1920 », Yuki a répondu « Capture en 1920×1080 faite, et
 * elle s'affiche ici » — et AUCUNE image n'est arrivée. Deux causes distinctes :
 *  ① `capture_libraire` rendait un bloc image AU MODÈLE (`src/pi/sdk/librarian-tools.ts`)
 *     sans JAMAIS créer de fichier du store : l'adaptateur n'avait donc aucun
 *     identifiant à joindre au message (`onFileProduced` n'était câblé que pour
 *     `generer_image`) — il n'y avait rien à publier ;
 *  ② le modèle, qui VOIT la capture qu'on lui joint, affirmait qu'elle s'affichait
 *     chez l'utilisateur : le prompt ne lui disait pas que ces deux choses sont
 *     distinctes.
 *
 * Ce que ce fichier prouve, contre de VRAIS adaptateurs et de VRAIES fixtures HTTP
 * (multipart réellement reçu) :
 *  - ① la capture crée un FICHIER du store (identifiant 32 hex) rattaché à la
 *    CONVERSATION du canal (pas à la session éphémère du run) ;
 *  - ② ce fichier part dans le canal (`file_ids` Mattermost, multipart `files[0]`
 *    Discord) — la publication de fichiers est dans l'ABSTRACTION, donc les deux
 *    plateformes suivent le même chemin ;
 *  - ③ un échec de copie ne casse PAS la capture : l'image reste rendue au modèle
 *    et l'avertissement est écrit (jamais un silence) ;
 *  - ④ aucun DOUBLON : le fichier déjà publié n'est pas re-joint à la réponse
 *    finale ;
 *  - ⑤ le résultat de l'outil ne prétend plus que l'image « s'affiche » chez
 *    l'utilisateur (le prompt du canal porte la même consigne).
 *
 * ⚠️ Échoue sur le code d'origine : aucun fichier n'était créé, donc aucun post ne
 * portait de pièce jointe (et `details.file_id` n'existait pas).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DiscordChatAdapter } from "../../src/chat/discord/adapter.js";
import { MattermostChatAdapter } from "../../src/chat/mattermost/adapter.js";
import { conversationIdOfDiscordChannel, conversationIdOfChannel } from "../../src/chat/mirror/ingest.js";
import { ChatMirrorStore } from "../../src/chat/mirror/store.js";
import { CHAT_REPLY_SYSTEM_PROMPT, createRemoteReplyGenerator } from "../../src/chat/index.js";
import { createFilesService, createGeneratedImageFiles, FilesStore } from "../../src/files/index.js";
import type { GeneratedImageFilesPort } from "../../src/files/generated.js";
import type {
  LibrarianArchivePort,
  LibrarianPort,
  LibrarianScreenshot,
  LibrarianScreenshotPort,
} from "../../src/librarian/types.js";
import type {
  LibrarianShotImage,
  LibrarianShotInput,
  LibrarianShotRecord,
  LibrarianShotsPort,
} from "../../src/librarian/shots.js";
import type { ChatOriginMode } from "../../src/llm/tool-policy.js";
import { createLogger } from "../../src/observability/logger.js";
import { createLibrarianTools } from "../../src/pi/sdk/librarian-tools.js";
import { createRemoteRunTools } from "../../src/pi/index.js";
import {
  MM_CHANNEL,
  MM_TOKEN,
  openMmMirror,
  startMmFixture,
  waitFor,
} from "./mm-reply-fixture.js";
import {
  CHANNEL as DISCORD_CHANNEL,
  TOKEN as DISCORD_TOKEN,
  messageFixture,
  startDiscordFixture,
} from "./discord-fixture.js";

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });

/** PNG 1×1 valide (ce que Libry rend). */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** Identifiant de capture rendu par le stockage simulé (32 hex, comme en prod). */
const SHOT_ID = "b".repeat(32);

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(purpose: string): string {
  const dir = mkdtempSync(join(tmpdir(), `yuki-${purpose}-`));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Store RÉEL des fichiers + le VRAI archiveur (aucun double de la copie). */
function makeFiles(options: { maxBytes?: () => number } = {}) {
  const files = new FilesStore({
    dir: tempDir("capture-files"),
    logger,
    retentionDays: () => 30,
    ...(options.maxBytes ? { maxBytes: options.maxBytes } : {}),
  });
  files.ensureLayout();
  const service = createFilesService({ store: files, logger });
  // ⚠️ Pas d'`images` : une capture n'a aucune fiche image à relier (pas de
  // déduplication) — MÊME module que `generer_image`, chemin différent.
  const archive = createGeneratedImageFiles({ files, logger });
  return { files, service, archive };
}

/** Ports du LIBRAIRE : capture et stockage SIMULÉS (aucun réseau, aucune écriture disque). */
function librarianPorts(archive: GeneratedImageFilesPort | undefined) {
  const views: Array<{ id: string; sessionId?: string }> = [];
  const saved: LibrarianShotInput[] = [];
  const client: LibrarianPort = {
    status: async () => ({}),
    search: async () => ({ results: [] }),
    library: async () => ({ library: [] }),
    doc: async () => ({ raw: {} }),
    archive: async () => ({ name: "x", version: "1", status: 201 }),
  };
  const librarianArchive: LibrarianArchivePort = {
    schedule: () => ({ status: "launched", job_id: "j1" }),
  };
  const screenshot: LibrarianScreenshotPort = {
    screenshot: async (): Promise<LibrarianScreenshot> => ({
      id: "shot-1",
      mimeType: "image/png",
      width: 1920,
      height: 1080,
      bytes: PNG.byteLength,
      url: "https://example.com/",
    }),
    shot: async (): Promise<LibrarianShotImage> => ({
      bytes: new Uint8Array(PNG),
      mimeType: "image/png",
    }),
  };
  const shots: LibrarianShotsPort = {
    save: (input) => {
      saved.push(input);
      const record: LibrarianShotRecord = {
        id: SHOT_ID,
        file: `/tmp/${SHOT_ID}.png`,
        mimeType: input.mimeType,
        ext: "png",
        bytes: input.data.byteLength,
        pageUrl: input.pageUrl,
        ...(input.width !== undefined ? { width: input.width } : {}),
        ...(input.height !== undefined ? { height: input.height } : {}),
        imageSrc: `/captures/${SHOT_ID}.png`,
        capturedAt: "2026-11-02T00:00:00.000Z",
        expiresAt: "2026-12-02T00:00:00.000Z",
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      };
      return record;
    },
    read: () => null,
  };
  return {
    views,
    saved,
    ports: {
      client,
      archive: librarianArchive,
      screenshot,
      shots,
      onShot: (view: { id: string; sessionId?: string }) => views.push(view),
      captureEnabled: () => true,
      ...(archive ? { files: archive } : {}),
    },
  };
}

type AnyTool = {
  name: string;
  execute: (...args: unknown[]) => Promise<{
    content: Array<{ type: string; text?: string }>;
    details?: unknown;
  }>;
};

/** Résultat BRUT de `capture_libraire`, capturé pour les assertions. */
interface Captured {
  content?: Array<{ type: string; text?: string }>;
  text?: string;
  details?: Record<string, unknown>;
}

/**
 * Générateur de réponse d'un canal : le VRAI (`createRemoteReplyGenerator`), dont
 * l'écrivain est SIMULÉ — il appelle réellement `capture_libraire`, comme le ferait
 * le modèle, et rend un texte de réponse.
 */
function makeGenerator(options: {
  platform: ChatOriginMode;
  files: ReturnType<typeof makeFiles>;
  librarian: ReturnType<typeof librarianPorts>;
  captured: Captured;
}) {
  return createRemoteReplyGenerator({
    available: () => true,
    botName: () => "Yuki",
    runTools: (conversationId, onFileProduced) =>
      createRemoteRunTools({
        conversationId,
        chatMode: options.platform,
        remoteAgents: false,
        // ⚠️ Groupe `outils` OUVERT : c'est lui qui contient `capture_libraire`.
        remoteTools: true,
        lightOptions: () => ({ librarianEnabled: true, librarianCaptureEnabled: true }),
        librarian: options.librarian.ports,
        files: options.files.service,
        filesSend: options.files.service,
        onFileProduced,
        logger,
      }),
    createWriter: (run) => async () => {
      const tool = (run.customTools() as AnyTool[]).find(
        (candidate) => candidate.name === "capture_libraire",
      );
      if (!tool) throw new Error("le run n'a pas reçu `capture_libraire`");
      // ⚠️ Contexte de la SESSION ÉPHÉMÈRE : c'est la conversation du CANAL qui doit
      // gagner (forçage de `buildRemoteRunTools`), pas cet identifiant jetable.
      const result = await tool.execute(
        "appel-1",
        { url: "https://example.com/", width: 1920, height: 1080 },
        undefined,
        undefined,
        { sessionManager: { getSessionId: () => "session-ephemere-du-run" } },
      );
      options.captured.content = result.content;
      options.captured.text = result.content.map((part) => part.text ?? "").join("\n");
      options.captured.details = (result.details ?? {}) as Record<string, unknown>;
      return "Voilà la capture demandée.";
    },
    logger,
  });
}

describe("capture_libraire — Mattermost : fichier créé et PUBLIÉ", () => {
  it("run de canal : un fichier est créé (conversation du canal) et joint au post", async () => {
    const fixture = await startMmFixture(cleanups);
    const store = openMmMirror(cleanups);
    const files = makeFiles();
    const librarian = librarianPorts(files.archive);
    const captured: Captured = {};
    const conversation = conversationIdOfChannel(MM_CHANNEL);

    const adapter = new MattermostChatAdapter({
      baseUrl: () => fixture.baseUrl,
      token: () => MM_TOKEN,
      store,
      pollIntervalMs: 0,
      files: files.files,
      generateReply: makeGenerator({
        platform: "mattermost",
        files,
        librarian,
        captured,
      }),
    });
    cleanups.push(() => adapter.disconnect());
    await adapter.connect();
    await waitFor(() => adapter.status().etat === "on", "la connexion temps réel");
    store.setReplyMode(conversation, "tout");

    fixture.broadcast("posted", {
      id: "humain-capture",
      channel_id: MM_CHANNEL,
      user_id: "humain-1",
      message: "oui fait une capture en 1920 et poste la ici stp",
      create_at: 1_700_000_000_000,
    });
    // DEUX posts : l'IMAGE (avec `file_ids`) puis la RÉPONSE.
    await waitFor(() => fixture.created.length >= 2, "les deux posts du run");

    // ① Le FICHIER existe, rattaché à la CONVERSATION du canal (jamais à la session
    //    éphémère), avec un identifiant de 32 hex.
    const enregistres = files.files.list({ sessionId: conversation });
    expect(enregistres).toHaveLength(1);
    const fichier = enregistres[0]!;
    expect(fichier.id).toMatch(/^[a-f0-9]{32}$/u);
    expect(fichier.name).toBe(`capture-example.com-${SHOT_ID.slice(0, 8)}.png`);
    expect(fichier.mimeType).toBe("image/png");
    expect(captured.details?.file_id).toBe(fichier.id);

    // ② PUBLIÉE : un `POST /files` (multipart) puis un post qui porte `file_ids`.
    const [postImage, postReponse] = fixture.created;
    expect(postImage!.file_ids).toEqual(["fichier-1"]);
    expect(String(postImage!.message)).toContain("Voici l'image.");
    expect(fixture.requetes.some((requete) => requete.chemin === "/api/v4/files")).toBe(true);

    // ④ AUCUN DOUBLON : la capture n'est pas re-jointe à la réponse finale.
    expect(postReponse!.file_ids).toBeUndefined();
    expect(String(postReponse!.message)).toContain("Voilà la capture demandée.");
    expect(fixture.created).toHaveLength(2);

    // ⑤ Le résultat ne prétend pas que l'image « s'affiche » chez l'utilisateur.
    expect(captured.text).toContain("tu ne peux pas savoir si elle est AFFICHÉE");
    expect(captured.content?.some((part) => part.type === "image")).toBe(true);
  });
});

describe("capture_libraire — Discord : même comportement (multipart)", () => {
  it("run de salon : fichier créé et joint dans le MÊME appel (`files[0]`)", async () => {
    const fixture = await startDiscordFixture({ heartbeatIntervalMs: 5_000 });
    const store = openMirror("discord-capture");
    const files = makeFiles();
    const librarian = librarianPorts(files.archive);
    const captured: Captured = {};
    const conversation = conversationIdOfDiscordChannel(DISCORD_CHANNEL);

    const adapter = new DiscordChatAdapter({
      token: () => DISCORD_TOKEN,
      store,
      pollIntervalMs: 0,
      apiBase: fixture.apiBase,
      gatewayUrl: fixture.gatewayUrl,
      files: files.files,
      generateReply: makeGenerator({
        platform: "discord",
        files,
        librarian,
        captured,
      }),
    });
    cleanups.push(() => adapter.disconnect());
    await adapter.connect();
    await waitFor(() => adapter.status().etat === "on", "la session");
    await waitFor(() => store.conversations().length > 0, "les salons");
    store.setReplyMode(conversation, "tout");

    fixture.dispatch("MESSAGE_CREATE", messageFixture({ id: "111111111111111199" }), 2);
    await waitFor(() => fixture.posts.length >= 2, "les deux posts du run");

    // ① Le fichier est rattaché à la CONVERSATION du salon.
    const enregistres = files.files.list({ sessionId: conversation });
    expect(enregistres).toHaveLength(1);
    expect(enregistres[0]!.id).toMatch(/^[a-f0-9]{32}$/u);

    // ② PUBLIÉE dans le MÊME appel (multipart), la plateforme ne connaissant pas
    //    `POST /files` : c'est l'abstraction qui décide, pas un adaptateur.
    const [postImage, postReponse] = fixture.posts;
    expect(postImage?.contentType).toContain("multipart/form-data");
    expect(postImage?.body).toContain('name="files[0]"');
    expect(postImage?.body).toContain("Voici l'image.");

    // ④ La réponse finale, elle, ne porte AUCUNE pièce jointe (pas de doublon).
    expect(postReponse?.contentType ?? "").not.toContain("multipart/form-data");
    expect(postReponse?.body).not.toContain('name="files[0]"');
    expect(postReponse?.body).toContain("Voilà la capture demandée.");
    expect(fixture.posts).toHaveLength(2);
  });
});

/** Miroir RÉEL sur disque (les salons sont créés par la connexion de l'adaptateur). */
function openMirror(purpose: string): ChatMirrorStore {
  const root = tempDir(purpose);
  return ChatMirrorStore.open({
    indexPath: join(root, "chat-mirror.json"),
    messagesDir: join(root, "chat-mirror"),
  });
}

describe("capture_libraire — la copie dans les fichiers ne casse JAMAIS la capture", () => {
  /** Appelle l'outil SEUL (aucun canal) avec un archiveur donné. */
  async function capture(archive: GeneratedImageFilesPort | undefined) {
    const librarian = librarianPorts(archive);
    const tools = createLibrarianTools({
      client: librarian.ports.client,
      archive: librarian.ports.archive,
      screenshot: librarian.ports.screenshot,
      shots: librarian.ports.shots,
      onShot: librarian.ports.onShot,
      captureEnabled: () => true,
      ...(librarian.ports.files ? { files: librarian.ports.files } : {}),
    });
    const tool = tools.find((candidate) => candidate.name === "capture_libraire");
    if (!tool) throw new Error("outil absent");
    const execute = tool.execute as unknown as (
      id: string,
      params: unknown,
      signal: undefined,
      onUpdate: undefined,
      ctx: unknown,
    ) => Promise<{
      content: Array<{ type: string; text?: string }>;
      details: Record<string, unknown>;
    }>;
    const result = await execute(
      "appel-1",
      { url: "https://example.com/" },
      undefined,
      undefined,
      { sessionManager: { getSessionId: () => "conv-1" } },
    );
    return {
      content: result.content,
      text: result.content.map((part) => part.text ?? "").join("\n"),
      details: result.details,
    };
  }

  it("refus du store (plafond) : capture rendue au modèle + avertissement, aucun échec", async () => {
    // ⚠️ Le store RÉEL refuse l'écriture (plafond à 1 octet) : c'est le refus
    // « too_large » de production, pas une exception simulée.
    const files = makeFiles({ maxBytes: () => 1 });
    const result = await capture(files.archive);

    expect(result.content.some((part) => part.type === "image")).toBe(true);
    expect(result.text).toContain("n'a PAS pu être enregistrée comme fichier");
    expect(result.text).toContain("dépasse le plafond par fichier");
    expect(result.details).toMatchObject({ status: "ok", file_id: null, file_error: "too_large" });
  });

  it("exception du store : capture quand même rendue, avertissement explicite", async () => {
    const archive: GeneratedImageFilesPort = {
      archive: () => {
        throw new Error("disque plein");
      },
    };
    const result = await capture(archive);

    expect(result.content.some((part) => part.type === "image")).toBe(true);
    expect(result.text).toContain("n'a PAS pu être enregistrée comme fichier");
    expect(result.text).toContain("disque plein");
    expect(result.details).toMatchObject({ status: "ok", file_id: null, file_error: "io_error" });
  });
});

describe("le mensonge « elle s'affiche ici »", () => {
  it("le prompt du canal dit que le modèle ne peut pas savoir si l'image est affichée", () => {
    expect(CHAT_REPLY_SYSTEM_PROMPT).toContain("Tu ne peux PAS savoir si elle est affichée");
    expect(CHAT_REPLY_SYSTEM_PROMPT).toContain("ne l'affirme");
    // ⚠️ Et l'échec d'envoi doit être DIT (mécanisme existant : jamais silencieux).
    expect(CHAT_REPLY_SYSTEM_PROMPT).toContain("n'a pas pu être enregistré ou envoyé");
  });
});
