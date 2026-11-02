/**
 * WORKER LOURD et IMAGES (lot 23) — `generer_image` dans un JOB, et le fichier qui
 * REMONTE jusqu'au rapport.
 *
 * ⚠️ LE DÉFAUT QUE CE FICHIER VERROUILLE (2026-11-02) : le worker lourd n'avait
 * aucun outil d'image (`images: []`, `src/llm/tool-policy.ts`), et
 * `buildHeavyActionTools` n'avait aucun destinataire pour un fichier produit. Une
 * génération déléguée aurait donc été soit impossible, soit invisible : l'image
 * générée dans le store n'aurait été publiée nulle part.
 *
 * Ce que ce fichier prouve :
 *  1. le lourd REÇOIT `generer_image` et `consulter_workflow` (noms vérifiés) ;
 *  2. aucun outil à approbation n'est ajouté (`APPROVAL_REQUIRED_TOOLS`) ;
 *  3. l'outil travaille sur la CONVERSATION PROPRIÉTAIRE (la session du job est
 *     éphémère) : la copie de l'image est rattachée à la conversation du canal ;
 *  4. l'identifiant du fichier REMONTE dans `HeavyRunResult.fichiers` — c'est ce
 *     que le réveil publie ensuite dans le canal.
 *
 * ⚠️ Échoue sur le code d'origine : `buildHeavyActionTools` n'acceptait pas de port
 * `images`, `SdkHeavyWorkerConfig.images` n'existait pas, et `HeavyRunResult`
 * n'avait aucun champ `fichiers`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { GeneratedImage } from "../../src/comfy/index.js";
import { createLogger } from "../../src/observability/logger.js";
import { buildModelsConfig } from "../../src/llm/index.js";
import { APPROVAL_REQUIRED_TOOLS, toolAllowlist } from "../../src/llm/tool-policy.js";
import { createSdkHeavyWorker } from "../../src/pi/index.js";
import { resolvePiPaths, seedSettingsFile, writeModelsFile } from "../../src/pi/config.js";
import type { EphemeralSession } from "../../src/pi/sdk/session-factory.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const CONVERSATION = "mm-canal-42";
const EPHEMERAL = "session-ephemere-du-job";
const FICHIER = "0123456789abcdef0123456789abcdef";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });

type AnyTool = {
  name: string;
  execute: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text?: string }> }>;
};

/** Ce que la session éphémère a reçu (politique + définitions). */
interface Recu {
  tools?: readonly string[];
  noms: string[];
  /** Conversation transmise à la copie de l'image. */
  sessionArchive?: string | undefined;
}

/**
 * Session éphémère SIMULÉE : elle appelle RÉELLEMENT `generer_image` reçu, comme le
 * ferait le modèle. Le contexte porte l'identifiant ÉPHÉMÈRE (jetable) : c'est bien
 * la conversation FORCÉE qui doit gagner.
 */
function modeleSimule(recu: Recu, scene: string) {
  return async (options: {
    tools?: readonly string[];
    customTools?: readonly unknown[];
  }): Promise<EphemeralSession> => {
    recu.tools = options.tools;
    const tools = (options.customTools ?? []) as readonly AnyTool[];
    recu.noms = tools.map((tool) => tool.name);
    type Listener = (event: unknown) => void;
    const listeners: Listener[] = [];
    return {
      session: {
        sessionId: EPHEMERAL,
        subscribe(cb: Listener): () => void {
          listeners.push(cb);
          return () => undefined;
        },
        async prompt(): Promise<void> {
          const generer = tools.find((tool) => tool.name === "generer_image");
          if (!generer) throw new Error("aucun outil `generer_image` reçu par le worker");
          const ctx = { sessionManager: { getSessionId: () => EPHEMERAL } };
          await generer.execute("appel-1", { scene }, undefined, undefined, ctx);
          for (const listener of listeners) {
            listener({
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "L'image est prête." }],
              },
            });
          }
        },
        async abort(): Promise<void> {},
        dispose(): void {},
        async steer(): Promise<void> {},
      },
      diagnostics: [],
    } as unknown as EphemeralSession;
  };
}

/** Environnement du worker : chemins réels, modèle résolu, session INJECTÉE. */
function makeEnv(createSession: unknown, recu: Recu, fichiersDemandes: string[]) {
  const root = mkdtempSync(join(tmpdir(), "yuki-heavy-images-"));
  tempDirs.push(root);
  const paths = resolvePiPaths({
    agentDir: join(root, "agent"),
    cwd: join(root, "workspace"),
    home: join(root, "home"),
    sessionsDir: join(root, "agent", "sessions"),
    settingsSeedPath: "config/pi/settings.json",
  });
  seedSettingsFile(paths, logger);
  writeModelsFile(paths, buildModelsConfig(), logger);

  const images = {
    async generate(): Promise<GeneratedImage> {
      fichiersDemandes.push("generate");
      return {
        record: {
          id: "img-1",
          file: join(root, "img-1.png"),
          mimeType: "image/png",
          ext: "png",
          bytes: PNG.length,
          imageSrc: "/images/img-1.png",
          createdAt: "2026-11-02T10:00:00.000Z",
          expiresAt: "2026-12-02T10:00:00.000Z",
          promptId: "prompt-1",
        },
        bytes: PNG,
        promptId: "prompt-1",
        workflowName: "manga",
        elapsedMs: 5,
        outputLabeled: true,
        labels: [],
      };
    },
    archive: {
      archive: (input: { sessionId?: string }) => {
        recu.sessionArchive = input.sessionId;
        return {
          ok: true as const,
          copied: true,
          file: {
            id: FICHIER,
            name: "image-generee.png",
            kind: "image" as const,
            mimeType: "image/png",
            bytes: PNG.length,
            readable: true,
            url: `/fichiers/${FICHIER}.png`,
            createdAt: "2026-11-02T10:00:00.000Z",
            expiresAt: "2026-12-02T10:00:00.000Z",
          },
        };
      },
    },
    workflows: {
      candidates: () => [{ name: "manga", description: "Manga", isDefault: true }],
      documentationOf: () => "",
    },
  };

  const worker = createSdkHeavyWorker({
    cwd: paths.cwd,
    agentDir: paths.agentDir,
    authPath: join(paths.agentDir, "auth.json"),
    modelsPath: paths.modelsPath,
    systemPrompt: "Tu es le worker lourd de test.",
    modelReference: "llm-heavy/deepseek-v4.1-flash",
    thinking: "off",
    // ⚠️ MÊME calcul de politique qu'en production (`src/index.ts`) : c'est lui
    // qui décide si `generer_image` est exposé au worker.
    tools: toolAllowlist("heavy", { imagesEnabled: true }),
    images,
    createSession: createSession as never,
    idleTimeoutMs: 5_000,
    totalTimeoutMs: 10_000,
    logger,
  });
  return { worker };
}

describe("worker lourd — images", () => {
  it("le lourd porte `generer_image` et `consulter_workflow`, sans aucun outil à approbation", async () => {
    const recu: Recu = { noms: [] };
    const env = makeEnv(modeleSimule(recu, "un chat roux"), recu, []);
    const result = await env.worker
      .run({ jobId: "job-img-1", task: "Génère une image.", lightSessionId: CONVERSATION } as never)
      .promise;

    expect(result.status).toBe("completed");
    // ① L'outil est bien là, sous son NOM (pas seulement dans l'allowlist).
    expect(recu.noms).toContain("generer_image");
    expect(recu.noms).toContain("consulter_workflow");
    expect(recu.tools).toContain("generer_image");
    // ② Aucun outil à approbation ajouté par les images.
    const approbations = recu.noms.filter((nom) => APPROVAL_REQUIRED_TOOLS.includes(nom));
    expect(approbations).toEqual([]);
  });

  it("l'image est copiée dans la conversation PROPRIÉTAIRE et le fichier remonte au rapport", async () => {
    const recu: Recu = { noms: [] };
    const demandes: string[] = [];
    const env = makeEnv(modeleSimule(recu, "un chat roux"), recu, demandes);
    const result = await env.worker
      .run({ jobId: "job-img-2", task: "Génère une image.", lightSessionId: CONVERSATION } as never)
      .promise;

    expect(result.status).toBe("completed");
    // ③ La génération a RÉELLEMENT tourné, et la copie vise le CANAL (jamais la
    // session éphémère du job, qui ne désigne aucun fil).
    expect(demandes).toEqual(["generate"]);
    expect(recu.sessionArchive).toBe(CONVERSATION);
    // ④ Le fichier produit REMONTE : c'est ce que le réveil publie dans le canal.
    expect(result.status === "completed" ? result.fichiers : undefined).toEqual([FICHIER]);
  });
});
