/**
 * RUN DISTANT — la POLITIQUE d'outils arrive bien jusqu'à la session du SDK.
 *
 * ⚠️ LE DÉFAUT QUE CE FICHIER VERROUILLE : l'écrivain de prompt ouvrait sa session
 * avec `tools: []` EN DUR (`src/pi/sdk/prompt-writer.ts:83` avant ce lot). Aucun run
 * venu de Mattermost n'appelait donc d'outil, et `generer_image` y était
 * inatteignable — alors que l'utilisateur l'a exigé.
 *
 * Ce que ce fichier prouve, sans modèle ni réseau (session éphémère INJECTÉE) :
 *  1. avec des outils fournis, la session reçoit l'ALLOWLIST **et** les DÉFINITIONS ;
 *  2. `chat.remoteAgents = desactive` ⇒ exactement les outils image/lecture ;
 *  3. `chat.remoteAgents = actives` ⇒ la politique locale complète (plus les outils
 *     sûrs qu'elle ne porte pas) ;
 *  4. un outil qui exige une approbation fait ÉCHOUER le run AVANT exécution, avec un
 *     message clair (« … ne peut pas être donnée depuis un canal distant ») ;
 *  5. SANS `tools`, aucun outil n'est exposé (récapitulatif, juge, extracteur de
 *     mémoire : comportement INCHANGÉ).
 *
 * ⚠️ Échoue sur le code d'origine : `tools`/`customTools` n'existent pas dans la
 * configuration de l'écrivain, et la session recevait `[]`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  approvalRequiredTools,
  buildModelsConfig,
  DEFAULT_EFFECTIVE_LLM_CONFIG,
  REMOTE_SAFE_TOOLS,
  resolveModelsFrom,
  toolAllowlist,
  toolAllowlistForChat,
} from "../../src/llm/index.js";
import { createLogger } from "../../src/observability/logger.js";
import {
  assertNoApprovalTool,
  createRemoteRunTools,
  createSdkPromptWriter,
  REMOTE_APPROVAL_REFUSAL,
} from "../../src/pi/index.js";
import { resolvePiPaths, seedSettingsFile, writeModelsFile } from "../../src/pi/config.js";
import type { EphemeralSession } from "../../src/pi/sdk/session-factory.js";

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
const MODELS = buildModelsConfig();
/** Référence `provider/modelId` du modèle léger (celle que le câblage résout). */
const MODEL_REFERENCE = resolveModelsFrom(DEFAULT_EFFECTIVE_LLM_CONFIG).light.reference;

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Options du host LOCAL telles que `lightToolOptions` les compose (tout activé). */
const LIGHT_OPTIONS = {
  delegationEnabled: true,
  directoryEnabled: true,
  secretsEnabled: true,
  secretRequestsEnabled: true,
  heritageEnabled: true,
  conversationArchiveEnabled: true,
  librarianEnabled: true,
  librarianCaptureEnabled: true,
  filesEnabled: true,
  imagesEnabled: true,
} as const;

/** Ce que la session éphémère a RÉELLEMENT reçu. */
interface SessionCapture {
  tools?: readonly string[];
  customTools?: readonly unknown[];
  prompted: string[];
}

/** Session éphémère double : enregistre ses options et rend un texte fixe. */
function capturingSession(capture: SessionCapture, texte = "Voilà.") {
  return async (options: {
    tools?: readonly string[];
    customTools?: readonly unknown[];
  }): Promise<EphemeralSession> => {
    capture.tools = options.tools;
    capture.customTools = options.customTools;
    type Listener = (event: unknown) => void;
    const listeners: Listener[] = [];
    return {
      session: {
        subscribe(cb: Listener): () => void {
          listeners.push(cb);
          return () => undefined;
        },
        async prompt(prompt: string): Promise<void> {
          capture.prompted.push(prompt);
          // Même forme d'événement que le SDK : le texte vient de `message_end`.
          for (const listener of listeners) {
            listener({
              type: "message_end",
              message: { role: "assistant", content: [{ type: "text", text: texte }] },
            });
          }
        },
        async abort(): Promise<void> {},
        dispose(): void {},
      },
      diagnostics: [],
    } as unknown as EphemeralSession;
  };
}

function makeWriter(
  capture: SessionCapture,
  run?: { tools: () => readonly string[]; customTools: () => readonly unknown[] },
) {
  const root = mkdtempSync(join(tmpdir(), "yuki-prompt-tools-"));
  tempDirs.push(root);
  const paths = resolvePiPaths({
    agentDir: join(root, "agent"),
    cwd: join(root, "workspace"),
    home: join(root, "home"),
    sessionsDir: join(root, "agent", "sessions"),
    settingsSeedPath: "config/pi/settings.json",
  });
  seedSettingsFile(paths, logger);
  writeModelsFile(paths, MODELS, logger);
  return createSdkPromptWriter({
    cwd: paths.cwd,
    agentDir: paths.agentDir,
    authPath: join(paths.agentDir, "auth.json"),
    modelsPath: paths.modelsPath,
    systemPrompt: "Tu rédiges une réponse de canal.",
    modelReference: MODEL_REFERENCE,
    thinking: "off",
    timeoutMs: () => 5_000,
    logger,
    label: "réponse",
    createSession: capturingSession(capture) as never,
    ...(run ? { tools: run.tools, customTools: run.customTools } : {}),
  });
}

const toolsDe = (customTools: readonly unknown[] | undefined): string[] =>
  (customTools ?? []).map((tool) => String((tool as { name?: unknown }).name));

describe("run distant — la politique atteint la session", () => {
  it("agents DÉSACTIVÉS : la session reçoit `REMOTE_SAFE_TOOLS` et ses définitions", async () => {
    const capture: SessionCapture = { prompted: [] };
    const run = createRemoteRunTools({
      conversationId: "mm-canal-1",
      chatMode: "mattermost",
      remoteAgents: false,
      remoteTools: true,
      lightOptions: () => LIGHT_OPTIONS,
    });
    const writer = makeWriter(capture, {
      tools: () => run.tools,
      customTools: () => run.customTools,
    });
    expect(await writer("prompt")).toBe("Voilà.");

    // ① L'allowlist passée au SDK est EXACTEMENT la politique de l'origine du run
    //    (comparaison TRIÉE : la composition compte, pas l'ordre).
    expect([...(capture.tools ?? [])].sort()).toEqual([...REMOTE_SAFE_TOOLS].sort());
    // ② Les DÉFINITIONS construites ne débordent JAMAIS de l'allowlist : le SDK ne
    //    registre que ce qu'elle autorise (parité politique ↔ implémentation, vérifiée
    //    outil par outil dans `tests/chat/mattermost-image-chain.test.ts`).
    for (const name of toolsDe(capture.customTools)) {
      expect(REMOTE_SAFE_TOOLS).toContain(name);
    }
  });

  it("agents ACTIVÉS : la politique locale complète (hors outils à approbation)", async () => {
    const capture: SessionCapture = { prompted: [] };
    const run = createRemoteRunTools({
      conversationId: "mm-canal-1",
      chatMode: "mattermost",
      remoteAgents: true,
      remoteTools: true,
      lightOptions: () => LIGHT_OPTIONS,
    });
    const writer = makeWriter(capture, {
      tools: () => run.tools,
      customTools: () => run.customTools,
    });
    await writer("prompt");

    const attendu = toolAllowlistForChat("light", LIGHT_OPTIONS, {
      chatMode: "mattermost",
      remoteAgents: true,
      remoteTools: true,
    });
    expect(capture.tools).toEqual(attendu);
    // Plus large que la liste sûre : la délégation et les outils de consultation reviennent.
    expect([...(capture.tools ?? [])]).toEqual(
      expect.arrayContaining(["delegate", "lister_agents", "lister_secrets"]),
    );
    for (const name of REMOTE_SAFE_TOOLS) expect(capture.tools).toContain(name);
    expect(approvalRequiredTools(capture.tools ?? [])).toEqual([]);
  });

  it("mode LOCAL : la politique du host est, élément pour élément, celle d'avant", () => {
    // Non-régression : le host local passe par le MÊME calcul, sans filtrage.
    expect(
      toolAllowlistForChat("light", LIGHT_OPTIONS, {
        chatMode: "local",
        remoteAgents: false,
        remoteTools: false,
      }),
    ).toEqual(toolAllowlist("light", LIGHT_OPTIONS));
  });

  it("SANS politique fournie : aucun outil (récapitulatif, juge, mémoire inchangés)", async () => {
    const capture: SessionCapture = { prompted: [] };
    const writer = makeWriter(capture);
    expect(await writer("prompt")).toBe("Voilà.");
    expect(capture.tools ?? []).toEqual([]);
    expect(toolsDe(capture.customTools)).toEqual([]);
  });

  it("un outil à approbation est REFUSÉ avant exécution, avec un message clair", async () => {
    // ⚠️ Second filet : la politique les retire déjà. Ici on vérifie qu'une liste
    // construite à la main (ou une politique contournée) ne peut pas passer.
    expect(() => assertNoApprovalTool(["run_command", "generer_image"])).toThrow(
      REMOTE_APPROVAL_REFUSAL,
    );
    expect(() => assertNoApprovalTool(["generer_image", "lire_fichier"])).not.toThrow();
    // Le message est en FRANÇAIS et dit ce qui se passe (aucune exécution).
    expect(REMOTE_APPROVAL_REFUSAL).toContain("ne peut pas être donnée depuis un canal");
    expect(() => assertNoApprovalTool(["run_command"])).toThrow(/run_command/);
    // Et la politique distante, elle, n'en contient jamais (les quatre combinaisons
    // des deux réglages, puisque les outils à approbation ne dépendent ni de l'un ni
    // de l'autre).
    for (const remoteAgents of [true, false]) {
      for (const remoteTools of [true, false]) {
        const run = createRemoteRunTools({
          conversationId: "mm-canal-1",
          chatMode: "mattermost",
          remoteAgents,
          remoteTools,
          lightOptions: () => LIGHT_OPTIONS,
        });
        expect(approvalRequiredTools(run.tools)).toEqual([]);
      }
    }
  });
});
