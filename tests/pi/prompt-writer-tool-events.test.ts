/**
 * ÉCRIVAIN SDK — les ÉVÉNEMENTS D'OUTIL sortent (`tool_execution_start`/`_end`).
 *
 * ⚠️ LE DÉFAUT QUE CE FICHIER VERROUILLE : l'écrivain d'un run distant n'écoutait que
 * `text_delta` et `message_end` (`src/pi/sdk/prompt-writer.ts`) — le démarrage d'un
 * outil ne sortait JAMAIS. Un canal distant ne pouvait donc **rien dire avant la fin
 * du tour** : pas d'accusé avant une génération d'image, pas de ligne d'échec, pas de
 * rappel pour une action de trois minutes.
 *
 * Ce que ce fichier prouve, sans modèle ni réseau (session éphémère INJECTÉE) :
 *  1. `tool_execution_start` remonte en `{ phase: "start", tool }` ;
 *  2. `tool_execution_end` remonte en `{ phase: "end", tool, isError }` ;
 *  3. le texte DÉJÀ écrit avant l'appel remonte en `ackCandidat` — c'est ce qui permet
 *     de publier l'accusé AVANT l'action, sans second appel modèle ;
 *  4. ce candidat remonte **BRUT** (longueur non bornée) : c'est `ReplyProgress` qui
 *     tranche la FORME (`ackShapedText`), donc un texte long ou multiligne est encore
 *     transmis — mais il ne sera PAS publié comme accusé (§ tests de la progression) ;
 *  5. sans `onTool`, le comportement est INCHANGÉ (récapitulatif, juge, mémoire) ;
 *  6. un observateur qui lève ne casse pas le run.
 *
 * ⚠️ Échoue sur le code d'origine : `onTool` n'existe pas dans `SdkPromptWriterConfig`,
 * et l'abonnement ignorait les deux types d'événements d'outil.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildModelsConfig,
  DEFAULT_EFFECTIVE_LLM_CONFIG,
  resolveModelsFrom,
} from "../../src/llm/index.js";
import { createLogger } from "../../src/observability/logger.js";
import { ackRuleFor } from "../../src/pi/ack.js";
import { createSdkPromptWriter, type SdkToolEvent } from "../../src/pi/index.js";
import { ACK_EXTENSION_NAME, createAckExtensionFactory } from "../../src/pi/sdk/ack-extension.js";
import { resolvePiPaths, seedSettingsFile, writeModelsFile } from "../../src/pi/config.js";
import type { EphemeralSession } from "../../src/pi/sdk/session-factory.js";

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
const MODELS = buildModelsConfig();
const MODEL_REFERENCE = resolveModelsFrom(DEFAULT_EFFECTIVE_LLM_CONFIG).light.reference;

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Listener = (event: unknown) => void;

/** Session éphémère double : elle JOUE une suite d'événements SDK donnée. */
function scriptedSession(
  script: (emit: (event: unknown) => void) => void,
  capture?: (options: Record<string, unknown>) => void,
) {
  return async (options: Record<string, unknown> = {}): Promise<EphemeralSession> => {
    capture?.(options);
    const listeners: Listener[] = [];
    return {
      session: {
        subscribe(cb: Listener): () => void {
          listeners.push(cb);
          return () => undefined;
        },
        async prompt(): Promise<void> {
          script((event) => {
            for (const listener of listeners) listener(event);
          });
        },
        async abort(): Promise<void> {},
        dispose(): void {},
      },
      diagnostics: [],
    } as unknown as EphemeralSession;
  };
}

function makeWriter(
  script: (emit: (event: unknown) => void) => void,
  onTool?: (event: SdkToolEvent) => void,
  options: { captureSession?: (options: Record<string, unknown>) => void; extensionFactories?: () => readonly unknown[] } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "yuki-prompt-events-"));
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
    createSession: scriptedSession(script, options.captureSession) as never,
    ...(onTool ? { onTool } : {}),
    ...(options.extensionFactories ? { extensionFactories: options.extensionFactories } : {}),
  });
}

/** Début de message assistant, puis une phrase, puis l'appel d'outil. */
function debutDeTour(emit: (event: unknown) => void, phrase: string, outil: string): void {
  emit({ type: "message_start", message: { role: "assistant" } });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: phrase } });
  emit({ type: "tool_execution_start", toolName: outil });
}

describe("événements d'outil — ils SORTENT de l'écrivain", () => {
  it("`tool_execution_start` remonte en phase `start`, avec l'accusé du modèle", async () => {
    const recus: SdkToolEvent[] = [];
    const writer = makeWriter(
      (emit) => {
        debutDeTour(emit, "Deux secondes.", "generer_image");
        emit({ type: "tool_execution_end", toolName: "generer_image", isError: false });
        emit({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Deux secondes.\n\nVoilà l'image." }],
          },
        });
      },
      (event) => recus.push(event),
    );

    expect(await writer("prompt")).toBe("Deux secondes.\n\nVoilà l'image.");
    expect(recus).toEqual([
      { phase: "start", tool: "generer_image", ackCandidat: "Deux secondes." },
      { phase: "end", tool: "generer_image" },
    ]);
  });

  it("`tool_execution_end` remonte `isError: true` quand l'outil a échoué", async () => {
    const recus: SdkToolEvent[] = [];
    const writer = makeWriter(
      (emit) => {
        emit({ type: "tool_execution_start", toolName: "lire_fichier" });
        emit({ type: "tool_execution_end", toolName: "lire_fichier", isError: true });
      },
      (event) => recus.push(event),
    );
    await writer("prompt");

    expect(recus).toEqual([{ phase: "start", tool: "lire_fichier" }, { phase: "end", tool: "lire_fichier", isError: true }]);
  });

  it("un texte TROP LONG remonte BRUT : la forme se décide dans `ReplyProgress`, pas ici", async () => {
    const recus: SdkToolEvent[] = [];
    const writer = makeWriter(
      (emit) => {
        debutDeTour(emit, "a".repeat(200), "generer_image");
        emit({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "a".repeat(200) }] },
        });
      },
      (event) => recus.push(event),
    );
    await writer("prompt");

    // ⚠️ L'écrivain ne FILTRE plus : s'il taisait ce texte, l'appelant ne pourrait pas
    // distinguer « le modèle est muet » (⇒ repli autorisé) de « le modèle a écrit une
    // réponse » (⇒ aucun accusé ne doit s'y ajouter).
    expect(recus).toEqual([
      { phase: "start", tool: "generer_image", ackCandidat: "a".repeat(200) },
    ]);
  });

  it("un texte MULTILIGNE remonte aussi brut (c'est du contenu, pas un accusé)", async () => {
    const recus: SdkToolEvent[] = [];
    const writer = makeWriter(
      (emit) => {
        debutDeTour(emit, "Deux secondes.\nJe lance ça.", "generer_image");
        emit({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Deux secondes.\nJe lance ça." }],
          },
        });
      },
      (event) => recus.push(event),
    );
    await writer("prompt");

    expect(recus).toEqual([
      { phase: "start", tool: "generer_image", ackCandidat: "Deux secondes.\nJe lance ça." },
    ]);
  });

  it("un outil de LECTURE ne consomme pas l'accusé retenu (il reste disponible)", async () => {
    const recus: SdkToolEvent[] = [];
    const writer = makeWriter(
      (emit) => {
        debutDeTour(emit, "Je vérifie.", "lire_fichier");
        emit({ type: "tool_execution_end", toolName: "lire_fichier" });
        // Message suivant : l'accusé est encore retenu pour l'action longue qui suit.
        emit({ type: "message_start", message: { role: "assistant" } });
        emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Je m'en occupe." } });
        emit({ type: "tool_execution_start", toolName: "generer_image" });
      },
      (event) => recus.push(event),
    );
    await writer("prompt");

    const actionLongue = recus.find(
      (event) => event.phase === "start" && event.tool === "generer_image",
    );
    expect(actionLongue?.ackCandidat).toBe("Je m'en occupe.");
  });

  it("sans `onTool`, le run est INCHANGÉ (récapitulatif, juge, mémoire)", async () => {
    const writer = makeWriter((emit) => {
      debutDeTour(emit, "Deux secondes.", "generer_image");
      emit({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "Voilà." }] },
      });
    });
    expect(await writer("prompt")).toBe("Voilà.");
  });

  it("un observateur qui LÈVE ne casse pas le run", async () => {
    const writer = makeWriter(
      (emit) => {
        debutDeTour(emit, "Deux secondes.", "generer_image");
        emit({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "Voilà." }] },
        });
      },
      () => {
        throw new Error("journal cassé");
      },
    );
    expect(await writer("prompt")).toBe("Voilà.");
  });
});

describe("extensions du run — la consigne d'accusé entre dans la session", () => {
  it("transmet `extensionFactories` à la session éphémère (mécanisme du host local)", async () => {
    const vues: Record<string, unknown>[] = [];
    const writer = makeWriter(
      (emit) => {
        emit({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "Voilà." }] },
        });
      },
      undefined,
      {
        captureSession: (options) => vues.push(options),
        // ⚠️ La consigne d'un run de CANAL : `ackRuleFor` sur SON allowlist, jamais
        // `ACK_RULE` (qui cite `run_command`, absent d'un canal).
        extensionFactories: () => [createAckExtensionFactory(ackRuleFor(["generer_image"]))],
      },
    );
    await writer("prompt");

    const extensions = vues[0]?.["extensionFactories"] as
      | ReadonlyArray<{ name?: string }>
      | undefined;
    expect(extensions).toHaveLength(1);
    expect(extensions?.[0]?.name).toBe(ACK_EXTENSION_NAME);
    // ⚠️ Aucune extension ⇒ la clé est ABSENTE (récapitulatif, juge, mémoire inchangés).
    const sans: Record<string, unknown>[] = [];
    const nu = makeWriter(
      (emit) => {
        emit({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "Voilà." }] },
        });
      },
      undefined,
      { captureSession: (options) => sans.push(options) },
    );
    await nu("prompt");
    expect("extensionFactories" in (sans[0] ?? {})).toBe(false);
  });
});
