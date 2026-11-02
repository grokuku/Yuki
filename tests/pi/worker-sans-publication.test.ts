/**
 * LE WORKER LOURD N'A **AUCUN** OUTIL DE PUBLICATION — invariant « un seul rédacteur ».
 *
 * ⚠️ LE DÉFAUT QUE CE FICHIER VERROUILLE (production, 2026-11-02). Deux programmes
 * publiaient dans le même canal : le tour de Yuki, et le worker lourd — qui avait
 * reçu `publier_dans_canal` (`src/llm/tool-policy.ts`, politique `heavy`, port fourni
 * par `SdkHeavyWorkerConfig.channels`). Résultat observé : deux messages collés, deux
 * images générées, un ordre cassé.
 *
 * ⚠️ INVARIANT (exigence utilisateur rappelée dans `docs/lot18-chat.md`) : **dans un
 * canal, un seul rédacteur — le tour de Yuki**. Le worker REND un résultat
 * (`HeavyRunResult`), il ne parle jamais. `publier_dans_canal` reste au contraire
 * disponible dans le RUN DE CANAL (`REMOTE_SAFE_TOOLS`) : là, c'est Yuki qui écrit.
 *
 * Ce que ce fichier prouve :
 *  1. la POLITIQUE du rôle lourd ne contient aucun outil de publication ;
 *  2. ses DÉFINITIONS n'en construisent aucun — même pour une conversation de CANAL
 *     (l'ancien port `channels` n'existe plus) ;
 *  3. un job qui produit une image la REND au rapport (`fichiers`), sans rien poster ;
 *  4. NON-RÉGRESSION : le run de canal de Yuki garde l'outil.
 *
 * ⚠️ Échoue sur le code d'origine : `TOOL_POLICY.heavy.channelPost` valait
 * `CHANNEL_POST_TOOLS`, `buildHeavyActionTools` construisait `publier_dans_canal` et
 * `SdkHeavyWorkerConfig.channels` existait.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { GeneratedImage } from "../../src/comfy/index.js";
import { createLogger } from "../../src/observability/logger.js";
import { buildModelsConfig } from "../../src/llm/index.js";
import { TOOL_POLICY, toolAllowlist, toolAllowlistForChat } from "../../src/llm/tool-policy.js";
import { createRemoteRunTools, createSdkHeavyWorker } from "../../src/pi/index.js";
import {
  APPROVAL_REQUIRED_TOOLS,
  type ToolAllowlistOptions,
} from "../../src/llm/tool-policy.js";
import { buildHeavyActionTools } from "../../src/pi/sdk/heavy-worker.js";
import { resolvePiPaths, seedSettingsFile, writeModelsFile } from "../../src/pi/config.js";
import type { EphemeralSession } from "../../src/pi/sdk/session-factory.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** Canal de conversation : c'est LÀ que le worker avait (à tort) le droit d'écrire. */
const CONVERSATION = "mm-canal-general";
const EPHEMERAL = "session-ephemere-du-job";
const FICHIER = "0123456789abcdef0123456789abcdef";
const OUTIL_PUBLICATION = "publier_dans_canal";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });

/** TOUTES les options de politique activées : le pire cas, celui qui doit rester vide. */
const TOUT_ACTIVE: ToolAllowlistOptions = {
  delegationEnabled: true,
  executionEnabled: true,
  screenshotsEnabled: true,
  directoryEnabled: true,
  secretsEnabled: true,
  secretRequestsEnabled: true,
  heritageEnabled: true,
  conversationArchiveEnabled: true,
  librarianEnabled: true,
  librarianCaptureEnabled: true,
  filesEnabled: true,
  fileTransferEnabled: true,
  fileListEnabled: true,
  fileReadEnabled: true,
  imagesEnabled: true,
};

/**
 * ⚠️ ON PASSE AUSSI L'ANCIENNE OPTION (`channelPostEnabled`), exactement comme le
 * faisait le câblage avant le 2026-11-02 : même demandée EXPLICITEMENT, la publication
 * ne doit pas revenir au worker. Sans elle, ce test serait plus faible que le défaut
 * qu'il verrouille (l'option n'existe plus dans le type, mais un câblage ancien
 * pourrait encore la passer à l'exécution).
 */
const AVEC_ANCIENNE_OPTION = {
  ...TOUT_ACTIVE,
  channelPostEnabled: true,
} as ToolAllowlistOptions;

describe("① politique du worker lourd — aucun outil de publication", () => {
  it("`publier_dans_canal` n'est PAS dans l'allowlist du rôle lourd, même demandé", () => {
    // ⚠️ Toutes les capacités activées : aucune ne doit ouvrir la publication.
    expect(toolAllowlist("heavy", TOUT_ACTIVE)).not.toContain(OUTIL_PUBLICATION);
    expect(toolAllowlist("heavy", AVEC_ANCIENNE_OPTION)).not.toContain(OUTIL_PUBLICATION);
  });

  it("la politique lourde n'a même plus de catégorie de publication", () => {
    // Structurel : la catégorie elle-même a disparu de `ToolPolicyEntry`
    // (`src/llm/tool-policy.ts`), donc un futur câblage ne peut pas la réactiver
    // sans rouvrir ce test.
    expect(Object.prototype.hasOwnProperty.call(TOOL_POLICY.heavy, "channelPost")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(TOOL_POLICY.light, "channelPost")).toBe(false);
  });

  it("aucun outil à publication dans les DÉFINITIONS construites pour un canal", () => {
    const tools = buildHeavyActionTools(
      {
        images: {
          generate: async () => {
            throw new Error("jamais appelé");
          },
          workflows: { candidates: () => [], documentationOf: () => "" },
        },
      },
      CONVERSATION,
      { modelLabel: "test/modele", imagesSupported: true },
    );
    const noms = tools.map((tool) => tool.name);
    // Les outils d'ACTION sont bien là…
    expect(noms).toContain("generer_image");
    expect(noms).toContain("consulter_workflow");
    // …et la publication n'y est PLUS, même avec une conversation de canal.
    expect(noms).not.toContain(OUTIL_PUBLICATION);
  });
});

// ─── Bout en bout : session simulée, job né d'un canal ──────────────────────

interface Recu {
  tools?: readonly string[];
  noms: string[];
}

type AnyTool = {
  name: string;
  execute: (...args: unknown[]) => Promise<unknown>;
};

/**
 * Session éphémère SIMULÉE : elle tente d'appeler `publier_dans_canal` (comme le
 * ferait un modèle qui a appris l'outil) après une génération d'image. Le job doit
 * se terminer SANS aucune publication, l'image remontant par le rapport.
 */
function modeleSimule(recu: Recu) {
  return async (options: {
    tools?: readonly string[];
    customTools?: readonly unknown[];
  }): Promise<EphemeralSession> => {
    recu.tools = options.tools;
    const tools = (options.customTools ?? []) as AnyTool[];
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
          await generer.execute("appel-1", { scene: "Holaf" }, undefined, undefined, {
            sessionManager: { getSessionId: () => EPHEMERAL },
          });
          // ⚠️ Tentative de publication : elle DOIT échouer (outil absent).
          const publier = tools.find((tool) => tool.name === OUTIL_PUBLICATION);
          if (publier) {
            throw new Error("le worker ne doit recevoir AUCUN outil de publication");
          }
          for (const listener of listeners) {
            listener({
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "Image générée." }],
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

function makeWorker(createSession: unknown) {
  const root = mkdtempSync(join(tmpdir(), "yuki-worker-sans-publication-"));
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
      archive: () => ({
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
      }),
    },
    workflows: {
      candidates: () => [{ name: "manga", description: "Manga", isDefault: true }],
      documentationOf: () => "",
    },
  };

  return createSdkHeavyWorker({
    cwd: paths.cwd,
    agentDir: paths.agentDir,
    authPath: join(paths.agentDir, "auth.json"),
    modelsPath: paths.modelsPath,
    systemPrompt: "Tu es le worker lourd de test.",
    modelReference: "llm-heavy/deepseek-v4.1-flash",
    thinking: "off",
    // MÊME calcul de politique qu'en production (`src/index.ts`).
    tools: toolAllowlist("heavy", { imagesEnabled: true }),
    images,
    createSession: createSession as never,
    idleTimeoutMs: 5_000,
    totalTimeoutMs: 10_000,
    logger,
  });
}

describe("②③ worker né d'un CANAL — il rend son résultat, il ne publie pas", () => {
  it("le job se termine : image produite, AUCUNE publication, fichier rendu au rapport", async () => {
    const recu: Recu = { noms: [] };
    const worker = makeWorker(modeleSimule(recu));

    const result = await worker
      .run({
        jobId: "job-sans-publication",
        task: "Génère une figurine.",
        lightSessionId: CONVERSATION,
      } as never)
      .promise;

    // ② Le worker n'a reçu ni dans sa POLITIQUE ni dans ses DÉFINITIONS l'outil.
    expect(recu.tools ?? []).not.toContain(OUTIL_PUBLICATION);
    expect(recu.noms).not.toContain(OUTIL_PUBLICATION);
    // ③ Le job réussit (le modèle simulé lève si l'outil est présent)…
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.text).toBe("Image générée.");
    // …et son fichier sort par le RÉSULTAT : c'est Yuki, réveillée par le rapport,
    // qui décidera de le publier ici ou ailleurs.
    expect(result.fichiers).toEqual([FICHIER]);
    // ⚠️ Plus aucune phrase de repli de publication : le worker ne publie pas, donc
    // il n'a aucun échec de publication à annoncer.
    expect(result.repli).toBeUndefined();
  });
});

describe("④ non-régression — le RUN DE CANAL de Yuki garde la publication", () => {
  it("`publier_dans_canal` est toujours dans la politique DISTANTE de Yuki", () => {
    const outils = toolAllowlistForChat(
      "light",
      TOUT_ACTIVE,
      // ⚠️ Les DEUX réglages fermés : le socle dont `publier_dans_canal` fait partie
      // ne dépend d'aucun des deux.
      { chatMode: "mattermost", remoteAgents: false, remoteTools: false },
    );
    expect(outils).toContain(OUTIL_PUBLICATION);
    // Aucun outil à approbation n'entre dans un run distant.
    expect(outils.filter((outil) => APPROVAL_REQUIRED_TOOLS.includes(outil))).toEqual([]);
  });

  it("la définition de l'outil est bien construite par le run de canal", () => {
    const run = createRemoteRunTools({
      conversationId: CONVERSATION,
      chatMode: "mattermost",
      remoteAgents: false,
      remoteTools: false,
      lightOptions: () => ({}),
      channels: {
        canaux: () => [],
        publier: async () => ({
          ok: false as const,
          raison: "aucun canal suivi dans ce test",
        }),
      },
    });
    const noms = run.customTools.map((tool) => (tool as { name?: string }).name);
    expect(noms).toContain(OUTIL_PUBLICATION);
    expect(run.tools).toContain(OUTIL_PUBLICATION);
  });
});
