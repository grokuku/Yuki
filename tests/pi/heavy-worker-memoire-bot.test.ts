/**
 * LE RUN LOURD A LA MÉMOIRE DE SON BOT — JAMAIS CELLE D'UN AUTRE (audit 2026-11-20).
 *
 * ⚠️ LE DÉFAUT VERROUILLÉ : la session éphémère du worker lourd n'enregistrait
 * AUCUNE extension de mémoire. Un run planifié se réveillait donc sans le moindre
 * souvenir de son bot — il ne savait pas ce que son bot avait appris.
 *
 * Ce fichier prouve :
 *  ① le worker branche l'extension de mémoire sur le port REÇU (`config.memoire`) ;
 *  ② le port est celui du BOT : `ServicesMemoireBots.pour(botId)` est adossé à SON
 *    `memory.jsonl` — le bloc de `grolaf` ne contient jamais le store de `yuki` ;
 *  ③ le rappel est fait AVANT le premier tour (le prompt système en porte la
 *    trace), et la question posée est le message du job.
 *
 * ⚠️ Échoue sur le code d'origine : `SdkHeavyWorkerConfig.memoire` n'existe pas,
 * `createSdkHeavyWorker` n'enregistre aucune extension de mémoire, et le prompt du
 * job ne contient donc aucun souvenir.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildModelsConfig, toolAllowlist } from "../../src/llm/index.js";
import { createLogger } from "../../src/observability/logger.js";
import { createSdkHeavyWorker } from "../../src/pi/index.js";
import { resolvePiPaths, seedSettingsFile, writeModelsFile } from "../../src/pi/config.js";
import type { EphemeralSession } from "../../src/pi/sdk/session-factory.js";
import { ServicesMemoireBots } from "../../src/memory/services-bot.js";
import type { MemoryPort, MemoryRecallResult } from "../../src/memory/types.js";
import type { StoresMemoireBot } from "../../src/memory/stores-bot.js";
import type { ConversationArchivePort } from "../../src/memory/conversation-archive.js";
import type { HeritagePort } from "../../src/memory/heritage.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });

interface ServiceFactice extends MemoryPort {
  start(): void;
  readonly fichier: string;
  readonly rappels: string[];
}

function serviceMemoire(fichier: string): ServiceFactice {
  const rappels: string[] = [];
  return {
    fichier,
    rappels,
    start(): void {},
    async recall(query: string): Promise<MemoryRecallResult> {
      rappels.push(query);
      const block = `Souvenir de ${fichier} : le NAS est joignable.`;
      return {
        block,
        enabled: true,
        entries: 1,
        chars: block.length,
        durationMs: 1,
      };
    },
    onTurnEnd(): void {},
    onBeforeCompact(): void {},
  };
}

function bancDeuxBots(): Map<string, ServiceFactice> {
  const chemins = new Map<string, StoresMemoireBot>([
    [
      "yuki",
      { fichier: "/state/bots/yuki/memory.jsonl", fichierIndex: "/state/bots/yuki/memory.index" } as unknown as StoresMemoireBot,
    ],
    [
      "grolaf",
      { fichier: "/state/bots/grolaf/memory.jsonl", fichierIndex: "/state/bots/grolaf/memory.index" } as unknown as StoresMemoireBot,
    ],
  ]);
  const services = new ServicesMemoireBots<ServiceFactice>({
    pile: "yuki",
    duRun: serviceMemoire("/state/bots/yuki/memory.jsonl"),
    storesDe: (botId) => {
      const storesBot = chemins.get(botId);
      if (storesBot === undefined) throw new Error(`stores absents pour ${botId}`);
      return storesBot;
    },
    creer: (_botId, stores) => serviceMemoire(stores.fichier),
    logger,
  });
  const parBot = new Map<string, ServiceFactice>();
  parBot.set("yuki", services.pour("yuki"));
  parBot.set("grolaf", services.pour("grolaf"));
  return parBot;
}

type Listener = (event: unknown) => void;

interface Seen {
  /** Prompt système VU par le modèle après la chaîne d'extensions. */
  systemPrompt?: string;
  /** Question transmise à `recall` (le message du job). */
  question?: string;
  /** Noms des outils custom RÉELLEMENT reçus par la session. */
  outils: string[];
}

/**
 * Session éphémère SIMULÉE : elle rejoue la chaîne `before_agent_start` comme le
 * SDK (`event.systemPrompt` remplacé par chaque extension), puis termine le job.
 */
function sessionQuiRejoueLesExtensions(seen: Seen) {
  return async (options: {
    systemPrompt: string;
    customTools?: readonly { name: string; execute: (...args: unknown[]) => unknown }[];
    extensionFactories?: readonly {
      factory(pi: { on(name: string, cb: (event: unknown) => unknown): void }): void;
    }[];
  }): Promise<EphemeralSession> => {
    const listeners: Listener[] = [];
    return {
      session: {
        sessionId: "session-ephemere",
        subscribe(cb: Listener): () => void {
          listeners.push(cb);
          return () => undefined;
        },
        async prompt(question: string): Promise<void> {
          seen.question = question;
          seen.outils = (options.customTools ?? []).map((outil) => outil.name);
          let systemPrompt = options.systemPrompt;
          for (const extension of options.extensionFactories ?? []) {
            const handlers = new Map<string, Array<(event: unknown) => unknown>>();
            extension.factory({
              on(name, cb) {
                const liste = handlers.get(name) ?? [];
                liste.push(cb);
                handlers.set(name, liste);
              },
            });
            for (const handler of handlers.get("before_agent_start") ?? []) {
              const result = (await handler({ prompt: question, systemPrompt })) as
                | { systemPrompt?: string }
                | undefined;
              if (typeof result?.systemPrompt === "string") systemPrompt = result.systemPrompt;
            }
          }
          seen.systemPrompt = systemPrompt;
          for (const listener of listeners) {
            listener({
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "Tâche terminée." }],
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

function makeWorker(
  memoire: () => MemoryPort,
  ports: {
    heritage?: () => HeritagePort;
    conversationArchive?: () => ConversationArchivePort;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "yuki-heavy-memoire-"));
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
  const seen: Seen = { outils: [] };
  const worker = createSdkHeavyWorker({
    cwd: paths.cwd,
    agentDir: paths.agentDir,
    authPath: join(paths.agentDir, "auth.json"),
    modelsPath: paths.modelsPath,
    systemPrompt: "Tu es le worker lourd de test.",
    modelReference: "llm-heavy/deepseek-v4.1-flash",
    thinking: "off",
    tools: toolAllowlist("heavy", {
      capacites: ["memoire"],
      heritageEnabled: true,
      conversationArchiveEnabled: true,
    }),
    memoire,
    ...(ports.heritage !== undefined ? { heritage: ports.heritage } : {}),
    ...(ports.conversationArchive !== undefined
      ? { conversationArchive: ports.conversationArchive }
      : {}),
    createSession: sessionQuiRejoueLesExtensions(seen) as never,
    idleTimeoutMs: 5_000,
    totalTimeoutMs: 10_000,
    logger,
  });
  return { worker, seen };
}

describe("la mémoire d'un run lourd est celle de SON bot", () => {
  it("⚠️ TEST CENTRAL : grolaf reçoit SON souvenir, jamais celui de yuki", async () => {
    const services = bancDeuxBots();
    const grolaf = makeWorker(() => services.get("grolaf") as MemoryPort);
    const yuki = makeWorker(() => services.get("yuki") as MemoryPort);

    await grolaf.worker
      .run({ jobId: "job-grolaf", task: "Résume la nuit.", lightSessionId: "mm-grolaf" } as never)
      .promise;
    await yuki.worker
      .run({ jobId: "job-yuki", task: "Résume le jour.", lightSessionId: "mm-yuki" } as never)
      .promise;

    expect(grolaf.seen.systemPrompt).toContain("/state/bots/grolaf/memory.jsonl");
    expect(grolaf.seen.systemPrompt).not.toContain("/state/bots/yuki/memory.jsonl");
    expect(yuki.seen.systemPrompt).toContain("/state/bots/yuki/memory.jsonl");
    expect(yuki.seen.systemPrompt).not.toContain("/state/bots/grolaf/memory.jsonl");

    // Le rappel interroge le MESSAGE du job, et il a bien été exécuté.
    expect(grolaf.seen.question).toBe("Résume la nuit.");
    expect(services.get("grolaf")?.rappels).toEqual(["Résume la nuit."]);
    expect(services.get("yuki")?.rappels).toEqual(["Résume le jour."]);
  });

  it("⚠️ il peut CHERCHER dans SES archives (vie antérieure, conversations mises de côté)", async () => {
    const services = bancDeuxBots();
    const heritageGrolaf: HeritagePort = {
      info: () => ({ present: true, entries: 1, manifest: null }),
      list: () => [
        {
          id: "h-grolaf",
          fichier: "grolaf.md",
          label: "archive",
          provenance: { machine: "Yuki-old", ere: "OpenClaw" },
          periode: "2024",
          categorie: "identite",
          titre: "Identité de Grolaf",
          texte: "Grolaf est le Cybergitan du 34.",
          importe_le: null,
        },
      ],
      read: () => undefined,
    };
    const archiveGrolaf: ConversationArchivePort = {
      archiveConversation: () => ({ ok: true, copied: false }) as never,
      search: () => [
        {
          conversationId: "conv-grolaf",
          title: "Nuit de grolaf",
          archivedAt: "2026-11-01T00:00:00.000Z",
          at: "2026-11-01T00:10:00.000Z",
          role: "user",
          text: "Souviens-toi du NAS de Grolaf.",
        },
      ],
      info: () => ({ present: true, conversations: 1, messages: 1, dir: "/state/bots/grolaf/archive" }),
    };
    const { worker, seen } = makeWorker(() => services.get("grolaf") as MemoryPort, {
      heritage: () => heritageGrolaf,
      conversationArchive: () => archiveGrolaf,
    });

    await worker
      .run({ jobId: "job-archives", task: "Retrouve ce qu'on sait.", lightSessionId: "mm-grolaf" } as never)
      .promise;

    expect(seen.outils).toContain("archive_vie_anterieure");
    expect(seen.outils).toContain("chercher_conversations_archivees");
  });
});
