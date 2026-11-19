/**
 * VISION DE REPLI — MODÈLE DÉDIÉ qui DÉCRIT l'image quand le modèle actif ne la
 * voit pas.
 *
 * ⚠️ LE DÉFAUT QUE CE FICHIER VERROUILLE : le premier jet offrait un SÉLECTEUR
 * parmi les deux modèles existants (`vision.fallback.model`). Insuffisant : si
 * ni le léger ni le lourd ne voit les images, un choix entre ces deux-là ne sert
 * à rien (demande utilisateur du 2026-11-16 : « j'aimerais pouvoir définir un
 * modèle dédié, pas utiliser ceux déjà définis »). Le réglage est donc un
 * TROISIÈME emplacement de modèle, calqué sur `llm.heavy.*` :
 * `llm.vision.baseUrl` + `llm.vision.model` + `llm.vision.thinking` +
 * `llm.vision.apiKey` (variable `YUKI_LLM_VISION_API_KEY`).
 *
 * Ce que ce fichier prouve, SANS réseau (session éphémère INJECTÉE, `models.json`
 * réel écrit dans un dossier temporaire) :
 *  ① les quatre clés `llm.vision.*` (portée `instance`, défauts VIDES, hot) et
 *    la DISPARITION de `vision.fallback.model` ;
 *  ② `models.json` : provider `llm-vision` écrit SEULEMENT si le modèle est
 *    configuré, avec SON adresse, SON modèle et SA clé — et `input` contient
 *    toujours « image » (le repli existe pour VOIR) ;
 *  ③ le test CENTRAL : l'image est décrite par le modèle DÉDIÉ — assertions sur
 *    l'URL et le NOM de modèle réellement passés à la session (pas un des deux
 *    modèles de conversation/travail) ;
 *  ④ ce modèle n'est PAS sélectionnable comme modèle de discussion ou de
 *    travail, même si son nom est celui d'un modèle existant ;
 *  ⑤ modèle avec vision ⇒ repli JAMAIS appelé (aucun coût) ; tout vide ⇒
 *    `not_configured`, aucune invention ;
 *  ⑥ échecs nommés (modèle introuvable, exception, réponse vide) : jamais une
 *    exception qui perdrait le tour ;
 *  ⑦ une seule description par image (cache) ;
 *  ⑧ À CHAUD : changer le modèle de vision prend effet à l'usage suivant, sans
 *    redémarrage (référence relue + `models.json` réécrit, runtime rafraîchi) ;
 *  ⑨ le texte injecté dit la VÉRITÉ (modèle ET utilisateur).
 *
 * ⚠️ Échoue sur l'arbre d'origine : les clés `llm.vision.*`, le provider
 * `llm-vision` et la source dédiée du describer n'existent pas.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CONFIG_SCHEMA, descriptorOf } from "../../src/config/schema.js";
import {
  blocDescriptionVision,
  blocEchecVisionRepli,
  messageSansVisionSansRepli,
  planVision,
  VISION_DESCRIPTION_PROMPT,
  type VisionDescriptionOutcome,
} from "../../src/files/vision-fallback.js";
import {
  buildModelsConfig,
  buildModelsConfigFrom,
  DEFAULT_EFFECTIVE_LLM_CONFIG,
  LLM_ROLES,
  MODELS,
  resolveModelsFrom,
  type EffectiveLlmConfig,
  type ThinkingLevelName,
} from "../../src/llm/index.js";
import { createLogger } from "../../src/observability/logger.js";
import { createSdkVisionDescriber } from "../../src/pi/index.js";
import { resolvePiPaths, seedSettingsFile, writeModelsFile } from "../../src/pi/config.js";
import { refreshSharedModelRuntime } from "../../src/pi/sdk/model-runtime.js";
import type { EphemeralSession } from "../../src/pi/sdk/session-factory.js";

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });

/** Modèle de vision DÉDIÉ du banc : adresse, nom et réflexion PROPRES. */
const VISION = {
  baseUrl: "https://vision.exemple/v1",
  model: "qwen2.5-vl-7b",
  thinking: "off" as ThinkingLevelName,
};

/** Un AUTRE modèle de vision (preuve du changement à chaud). */
const VISION_B = {
  baseUrl: "https://vision-b.exemple/v1",
  model: "llava-1.6-34b",
  thinking: "low" as ThinkingLevelName,
};

/** Config effective où le LÉGER est déclaré SANS vision, le LOURD avec. */
const EFFECTIVE: EffectiveLlmConfig = {
  light: { ...DEFAULT_EFFECTIVE_LLM_CONFIG.light, vision: false },
  heavy: { ...DEFAULT_EFFECTIVE_LLM_CONFIG.heavy, vision: true },
  vision: VISION,
};
const MODELES = resolveModelsFrom(EFFECTIVE);

/** Images 1×1 PNG distinctes (base64) : deux empreintes, donc deux descriptions. */
const IMAGE_1 = {
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  mimeType: "image/png",
};
const IMAGE_2 = {
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  mimeType: "image/png",
};

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Ce que la session éphémère a réellement reçu (aucun modèle, aucun réseau). */
interface Capture {
  systemPrompt?: string;
  prompted: string[];
  images: unknown[];
  appels: number;
  /** Modèle RÉSOLU passé à la session : `id`, `provider`, `baseUrl`, `input`. */
  model?: { id?: string; provider?: string; baseUrl?: string; input?: string[] };
  thinkingLevel?: unknown;
}

/** Session double : enregistre le modèle, les images et rend le texte scripté. */
function scriptedSession(
  capture: Capture,
  options: { texte?: string; echoue?: string } = {},
) {
  return async (sessionOptions: {
    systemPrompt?: string;
    model?: Capture["model"];
    thinkingLevel?: unknown;
  }): Promise<EphemeralSession> => {
    capture.appels += 1;
    capture.systemPrompt = sessionOptions.systemPrompt;
    capture.model = sessionOptions.model;
    capture.thinkingLevel = sessionOptions.thinkingLevel;
    type Listener = (event: unknown) => void;
    const listeners: Listener[] = [];
    return {
      session: {
        subscribe(cb: Listener): () => void {
          listeners.push(cb);
          return () => undefined;
        },
        async prompt(prompt: string, promptOptions?: { images?: unknown[] }): Promise<void> {
          capture.prompted.push(prompt);
          capture.images.push(promptOptions?.images ?? []);
          if (options.echoue !== undefined) throw new Error(options.echoue);
          for (const listener of listeners) {
            listener({
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: options.texte ?? "Une image décrite." }],
              },
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

/** Répertoire Pi jetable + `models.json` réellement écrit depuis `effective`. */
function makePaths(effective: EffectiveLlmConfig) {
  const root = mkdtempSync(join(tmpdir(), "yuki-vision-dedie-"));
  tempDirs.push(root);
  const paths = resolvePiPaths({
    agentDir: join(root, "agent"),
    cwd: join(root, "workspace"),
    home: join(root, "home"),
    sessionsDir: join(root, "agent", "sessions"),
    settingsSeedPath: "config/pi/settings.json",
  });
  seedSettingsFile(paths, logger);
  writeModelsFile(paths, buildModelsConfigFrom(effective), logger);
  return paths;
}

function makeDescriber(
  capture: Capture,
  modelReference: () => string,
  options: {
    texte?: string;
    echoue?: string;
    effective?: EffectiveLlmConfig;
    thinking?: () => ThinkingLevelName;
  } = {},
) {
  const paths = makePaths(options.effective ?? EFFECTIVE);
  return {
    paths,
    decrire: createSdkVisionDescriber({
      cwd: paths.cwd,
      agentDir: paths.agentDir,
      authPath: join(paths.agentDir, "auth.json"),
      modelsPath: paths.modelsPath,
      modelReference,
      ...(options.thinking ? { thinking: options.thinking } : {}),
      timeoutMs: () => 5_000,
      logger,
      createSession: scriptedSession(capture, options) as never,
    }),
  };
}

function capture(): Capture {
  return { prompted: [], images: [], appels: 0 };
}

describe("① la SÉLECTION du modèle de vision (catalogue, plus de champs dédiés)", () => {
  /**
   * ⚠️ GARDE RÉVISÉE (2026-11-19, LOT B) : les quatre réglages `llm.vision.*`
   * (adresse, modèle, réflexion, clé) sont RETIRÉS au profit du CATALOGUE. Ce qui
   * est vérifié est inchangé sur le fond : « aucun modèle de vision sélectionné »
   * est le SEUL interrupteur (défaut VIDE), la sélection est à chaud, et la clé
   * reste SECRÈTE (celle du fournisseur du modèle choisi).
   */
  it("la sélection est un `modeleId` VIDE par défaut, à chaud, par instance et par bot", () => {
    for (const path of ["llm.defaut.vision", "llm.bot.vision"]) {
      const descripteur = CONFIG_SCHEMA[path];
      expect(descripteur, path).toBeDefined();
      expect(descripteur).toMatchObject({
        type: "string",
        default: "",
        allowEmpty: true,
        apply: "hot",
      });
    }
    expect(CONFIG_SCHEMA["llm.defaut.vision"]?.scope).toBe("instance");
    expect(CONFIG_SCHEMA["llm.bot.vision"]?.scope).toBe("bot");
    // ⚠️ Aucun booléen `enabled` : la sélection vide EST l'interrupteur.
    expect(CONFIG_SCHEMA["llm.vision.enabled"]).toBeUndefined();
    for (const chemin of [
      "llm.vision.baseUrl",
      "llm.vision.model",
      "llm.vision.thinking",
      "llm.vision.apiKey",
    ]) {
      expect(CONFIG_SCHEMA[chemin], chemin).toBeUndefined();
    }
  });

  it("la clé est celle du FOURNISSEUR du modèle de vision (chemin SECRET)", () => {
    const descripteur = descriptorOf("llm.fournisseur.local.apiKey");
    expect(descripteur).toMatchObject({ scope: "instance", secret: true, apply: "hot" });
  });

  it("⚠️ `vision.fallback.model` N'EXISTE PLUS (pas de cohabitation)", () => {
    expect(CONFIG_SCHEMA["vision.fallback.model"]).toBeUndefined();
  });
});

describe("② `models.json` : un TROISIÈME provider, écrit seulement si configuré", () => {
  it("configuré ⇒ provider `llm-vision` avec SON adresse, SON modèle, SA clé", () => {
    const provider = buildModelsConfigFrom(EFFECTIVE).providers["llm-vision"];
    expect(provider).toBeDefined();
    expect(provider?.baseUrl).toBe(VISION.baseUrl);
    expect(provider?.api).toBe("openai-completions");
    // ⚠️ La clé n'est jamais en clair : uniquement la RÉFÉRENCE d'environnement.
    expect(provider?.apiKey).toBe("$YUKI_LLM_VISION_API_KEY");
    expect(provider?.models[0]?.id).toBe(VISION.model);
    // ⚠️ Le repli existe pour VOIR : `image` est TOUJOURS déclarée (ce n'est pas
    // une déclaration d'utilisateur, c'est la définition de l'emplacement).
    expect(provider?.models[0]?.input).toContain("image");
  });

  it("⚠️ même si les DEUX modèles de conversation sont « sans vision »", () => {
    const sansVision: EffectiveLlmConfig = {
      light: { ...DEFAULT_EFFECTIVE_LLM_CONFIG.light, vision: false },
      heavy: { ...DEFAULT_EFFECTIVE_LLM_CONFIG.heavy, vision: false },
      vision: VISION,
    };
    const modelsConfig = buildModelsConfigFrom(sansVision);
    expect(modelsConfig.providers["llm-light"]?.models[0]?.input).toEqual(["text"]);
    expect(modelsConfig.providers["llm-heavy"]?.models[0]?.input).toEqual(["text"]);
    expect(modelsConfig.providers["llm-vision"]?.models[0]?.input).toContain("image");
  });

  it("tout vide (défaut livré) ⇒ AUCUN provider `llm-vision` (pas de repli)", () => {
    expect(buildModelsConfig().providers["llm-vision"]).toBeUndefined();
    // Une seule des deux valeurs ne suffit pas : il faut adresse ET modèle.
    const partiel: EffectiveLlmConfig = {
      ...DEFAULT_EFFECTIVE_LLM_CONFIG,
      vision: { baseUrl: VISION.baseUrl, model: "", thinking: "off" },
    };
    expect(buildModelsConfigFrom(partiel).providers["llm-vision"]).toBeUndefined();
  });
});

describe("③ ⚠️ TEST CENTRAL : c'est le modèle DÉDIÉ qui décrit (URL + nom réels)", () => {
  it("la session reçoit l'URL et le modèle de `llm.vision.*`, pas ceux des rôles", async () => {
    const seen = capture();
    const { decrire } = makeDescriber(seen, () => MODELES.vision.reference, {
      texte: "Un bouton « Enregistrer », chiffre 12 en haut à droite.",
    });

    const issue = await decrire([IMAGE_1]);
    expect(issue.kind).toBe("described");
    if (issue.kind !== "described") return;
    expect(issue.modele).toBe("llm-vision/qwen2.5-vl-7b");
    expect(issue.descriptions[0]?.texte).toContain("Enregistrer");

    // ⚠️ Ce qui est RÉELLEMENT appelé : l'URL du serveur de vision et le nom du
    // modèle de vision (aucun des deux modèles de conversation/travail).
    expect(seen.model?.baseUrl).toBe(VISION.baseUrl);
    expect(seen.model?.id).toBe(VISION.model);
    expect(seen.model?.provider).toBe("llm-vision");
    expect(seen.model?.input).toContain("image");
    expect(seen.model?.baseUrl).not.toBe(DEFAULT_EFFECTIVE_LLM_CONFIG.heavy.baseUrl);
    expect(seen.model?.id).not.toBe(DEFAULT_EFFECTIVE_LLM_CONFIG.heavy.model);
    expect(seen.model?.id).not.toBe(DEFAULT_EFFECTIVE_LLM_CONFIG.light.model);

    // L'image est bien partie au modèle de vision (une seule fois).
    expect(seen.appels).toBe(1);
    expect(seen.images).toHaveLength(1);
    expect(seen.images[0]).toHaveLength(1);
  });

  it("la réflexion vient de `llm.vision.thinking` (relue à chaque appel)", async () => {
    const seen = capture();
    let thinking: ThinkingLevelName = "off";
    const { decrire } = makeDescriber(seen, () => MODELES.vision.reference, {
      thinking: () => thinking,
    });
    await decrire([IMAGE_1]);
    expect(seen.thinkingLevel).toBe("off");
    thinking = "low";
    await decrire([IMAGE_2]);
    expect(seen.thinkingLevel).toBe("low");
  });

  it("le prompt de description est FACTUEL (libellés, chiffres — pas d'interprétation)", async () => {
    const seen = capture();
    const { decrire } = makeDescriber(seen, () => MODELES.vision.reference);
    await decrire([IMAGE_1]);
    expect(seen.systemPrompt).toBe(VISION_DESCRIPTION_PROMPT);
    expect(VISION_DESCRIPTION_PROMPT).toContain("texte lisible");
    expect(VISION_DESCRIPTION_PROMPT).toContain("CHIFFRES");
    expect(VISION_DESCRIPTION_PROMPT).toContain("aucune interprétation");
    expect(VISION_DESCRIPTION_PROMPT).toContain("peut manquer de détails");
  });
});

describe("④ ⚠️ jamais un modèle de discussion ou de travail", () => {
  it("les rôles restent `light`/`heavy` : aucun rôle `vision`", () => {
    expect([...LLM_ROLES]).toEqual(["light", "heavy"]);
    expect(Object.keys(MODELS).sort()).toEqual(["heavy", "light"]);
  });

  it("même nom de modèle ⇒ références DISTINCTES (aucune confusion possible)", () => {
    const piege: EffectiveLlmConfig = {
      ...EFFECTIVE,
      vision: { baseUrl: VISION.baseUrl, model: "gemma4:31b", thinking: "off" },
    };
    const modeles = resolveModelsFrom(piege);
    expect(modeles.light.reference).toBe("llm-light/gemma4:31b");
    expect(modeles.heavy.reference).toBe("llm-heavy/deepseek-v4.1-flash");
    // ⚠️ Le modèle de vision vit dans SON provider : il ne peut pas prendre la
    // place d'un modèle de conversation, ni être choisi pour l'un des deux.
    expect(modeles.vision.reference).toBe("llm-vision/gemma4:31b");
  });
});

describe("⑤ aucun repli configuré ⇒ honnête, aucune invention", () => {
  it("référence vide ⇒ `not_configured` et AUCUNE session ouverte", async () => {
    const seen = capture();
    const { decrire } = makeDescriber(seen, () => "");
    const issue = await decrire([IMAGE_1]);
    expect(issue).toEqual({ kind: "not_configured" });
    expect(seen.appels).toBe(0);
  });

  it("modèle AVEC vision ⇒ le repli n'est JAMAIS appelé (aucun coût)", () => {
    expect(
      planVision({ modeleVoitLesImages: true, nombreImages: 2, repliConfigure: true }),
    ).toBe("garder");
    // Aucune image : rien à décider.
    expect(
      planVision({ modeleVoitLesImages: false, nombreImages: 0, repliConfigure: true }),
    ).toBe("garder");
    // Sans modèle de vision configuré : refus, comme avant.
    expect(
      planVision({ modeleVoitLesImages: false, nombreImages: 1, repliConfigure: false }),
    ).toBe("refuser");
    // Avec : l'image est décrite.
    expect(
      planVision({ modeleVoitLesImages: false, nombreImages: 1, repliConfigure: true }),
    ).toBe("decrire");
  });

  it("le message d'absence nomme le NOUVEAU réglage (pas l'ancien sélecteur)", () => {
    const message = messageSansVisionSansRepli("llm-light/gemma4:31b");
    expect(message).toContain("Vision de repli");
    expect(message).toContain("Clé d'API");
  });
});

describe("⑥ échecs ⇒ résultat nommé, jamais une exception", () => {
  it("fournisseur introuvable ⇒ message explicite", async () => {
    const seen = capture();
    // ⚠️ Un ID de modèle inconnu chez un fournisseur CONNU est résolu par le SDK
    // (l'échec arrive alors à l'appel : cas suivant). C'est le FOURNISSEUR
    // inconnu qui ne résout rien — et qu'il faut donc nommer.
    const { decrire } = makeDescriber(seen, () => "fournisseur-inconnu/modele");
    const issue = await decrire([IMAGE_1]);
    expect(issue.kind).toBe("failed");
    if (issue.kind !== "failed") return;
    expect(issue.message).toContain("introuvable");
    expect(seen.appels).toBe(0);
  });

  it("exception du modèle ⇒ message d'échec, aucun rejet", async () => {
    const seen = capture();
    const { decrire } = makeDescriber(seen, () => MODELES.vision.reference, {
      echoue: "delai depasse",
    });
    const issue = await decrire([IMAGE_1]);
    expect(issue.kind).toBe("failed");
    if (issue.kind !== "failed") return;
    expect(issue.message).toContain("n'a pas répondu");
  });

  it("réponse vide ⇒ échec nommé (aucune description inventée)", async () => {
    const seen = capture();
    const { decrire } = makeDescriber(seen, () => MODELES.vision.reference, {
      texte: "   ",
    });
    const issue = await decrire([IMAGE_1]);
    expect(issue.kind).toBe("failed");
    if (issue.kind !== "failed") return;
    expect(issue.message).toContain("rien décrit");
  });
});

describe("⑦ une seule description par image", () => {
  it("la même image redemandée n'ouvre AUCUNE nouvelle session", async () => {
    const seen = capture();
    const { decrire } = makeDescriber(seen, () => MODELES.vision.reference);
    const premier = await decrire([IMAGE_1]);
    const second = await decrire([IMAGE_1]);
    expect(seen.appels).toBe(1);
    expect(second).toEqual(premier);
  });
});

describe("⑧ ⚠️ À CHAUD : changer le modèle de vision, sans redémarrage", () => {
  it("le modèle suivant est utilisé dès l'image suivante (models.json réécrit)", async () => {
    const seen = capture();
    const paths = makePaths(EFFECTIVE);
    let effective = EFFECTIVE;
    const decrire = createSdkVisionDescriber({
      cwd: paths.cwd,
      agentDir: paths.agentDir,
      authPath: join(paths.agentDir, "auth.json"),
      modelsPath: paths.modelsPath,
      // ⚠️ MÊME mécanique que le câblage : la référence est relue à chaque usage.
      modelReference: () => resolveModelsFrom(effective).vision.reference,
      timeoutMs: () => 5_000,
      logger,
      createSession: scriptedSession(seen) as never,
    });

    await decrire([IMAGE_1]);
    expect(seen.model?.baseUrl).toBe(VISION.baseUrl);
    expect(seen.model?.id).toBe(VISION.model);

    // Changement de modèle de vision (comme `applyLlmConfig` : réécriture de
    // `models.json` puis rafraîchissement du runtime PARTAGÉ, en place).
    effective = { ...EFFECTIVE, vision: VISION_B };
    writeModelsFile(paths, buildModelsConfigFrom(effective), logger);
    await refreshSharedModelRuntime({
      authPath: join(paths.agentDir, "auth.json"),
      modelsPath: paths.modelsPath,
    });

    await decrire([IMAGE_2]);
    expect(seen.appels).toBe(2);
    expect(seen.model?.baseUrl).toBe(VISION_B.baseUrl);
    expect(seen.model?.id).toBe(VISION_B.model);
  });
});

describe("⑨ le texte injecté dit la VÉRITÉ (modèle ET utilisateur)", () => {
  it("le bloc nomme le modèle de vision et prévient qu'une description manque de détails", () => {
    const bloc = blocDescriptionVision({
      modele: MODELES.vision.reference,
      descriptions: [{ nom: "capture.png", texte: "Une fenêtre avec un bouton « OK »." }],
    });
    expect(bloc).toContain("Description d'image par le modèle de vision de repli");
    expect(bloc).toContain(MODELES.vision.reference);
    expect(bloc).toContain("ne voit PAS les images");
    expect(bloc).toContain("peut manquer de détails");
    expect(bloc).toContain("capture.png");
    expect(bloc).toContain("bouton « OK »");
  });

  it("l'échec est DIT explicitement (le tour continue sans l'image)", () => {
    const bloc = blocEchecVisionRepli("le modèle de vision n'a pas répondu");
    expect(bloc).toContain("Impossible d'analyser l'image");
    expect(bloc).toContain("n'a pas répondu");
    expect(bloc).toContain("continue sans l'image");
  });
});

/** Typage : l'issue est bien celle que tous les chemins consomment. */
const _issue: VisionDescriptionOutcome = { kind: "not_configured" };
void _issue;
