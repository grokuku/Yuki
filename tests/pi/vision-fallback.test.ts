/**
 * VISION DE REPLI (`vision.fallback.model`) — modèle qui DÉCRIT l'image quand
 * le modèle actif ne la voit pas.
 *
 * ⚠️ LE DÉFAUT QUE CE FICHIER VERROUILLE : jusqu'ici, un modèle déclaré sans
 * vision (`llm.<rôle>.vision = non`) ne pouvait QUE refuser l'image. Demande
 * utilisateur du 2026-11-16 : « est-ce que c'est possible d'ajouter dans les
 * paramètres généraux la config d'un modèle de vision de repli quand le modèle
 * utilisé (léger ou lourd) ne possède pas la vision ».
 *
 * Ce que ce fichier prouve, SANS réseau (session éphémère INJECTÉE, `models.json`
 * réel écrit dans un dossier temporaire) :
 *  ① clé `vision.fallback.model` : PORTÉE `instance`, DÉFAUT vide, `apply: hot` ;
 *  ② modèle sans vision + image + repli configuré ⇒ le repli est appelé UNE fois
 *    et sa description est celle qui est injectée (le test CENTRAL) ;
 *  ③ modèle AVEC vision ⇒ le repli n'est JAMAIS appelé (aucun coût) ;
 *  ④ aucun repli configuré ⇒ `not_configured`, aucune invention ;
 *  ⑤ repli en ÉCHEC (modèle introuvable, sans vision, délai/exception, réponse
 *    vide) ⇒ résultat nommé, jamais une exception qui perdrait le tour ;
 *  ⑥ une seule description par image (appel suivant = cache, aucun appel) ;
 *  ⑦ réglage À CHAUD (la référence est relue à chaque usage) ;
 *  ⑧ le PROMPT de description est factuel (libellés, chiffres — pas d'interprétation).
 *
 * ⚠️ Échoue sur l'arbre d'origine : la clé, le module et le port n'existent pas.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CONFIG_SCHEMA } from "../../src/config/schema.js";
import {
  blocDescriptionVision,
  blocEchecVisionRepli,
  planVision,
  VISION_DESCRIPTION_PROMPT,
  type VisionDescriptionOutcome,
} from "../../src/files/vision-fallback.js";
import {
  buildModelsConfigFrom,
  DEFAULT_EFFECTIVE_LLM_CONFIG,
  resolveModelsFrom,
  type EffectiveLlmConfig,
} from "../../src/llm/index.js";
import { createLogger } from "../../src/observability/logger.js";
import { createSdkVisionDescriber } from "../../src/pi/index.js";
import { resolvePiPaths, seedSettingsFile, writeModelsFile } from "../../src/pi/config.js";
import type { EphemeralSession } from "../../src/pi/sdk/session-factory.js";

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });

/** Config effective où le LÉGER est déclaré SANS vision, le LOURD avec. */
const EFFECTIVE_SANS_VISION_LEGERE: EffectiveLlmConfig = {
  light: { ...DEFAULT_EFFECTIVE_LLM_CONFIG.light, vision: false },
  heavy: { ...DEFAULT_EFFECTIVE_LLM_CONFIG.heavy, vision: true },
};
const MODELES = resolveModelsFrom(EFFECTIVE_SANS_VISION_LEGERE);

/** Image 1×1 PNG (base64), telle que la politique de vision la produit. */
const IMAGE = {
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
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
  /** Modèle résolu passé à la session (référence de repli effectivement utilisée). */
  model?: unknown;
}

/** Session double : enregistre les images du tour et rend le texte scripté. */
function scriptedSession(
  capture: Capture,
  options: { texte?: string; echoue?: string } = {},
) {
  return async (sessionOptions: {
    systemPrompt?: string;
    model?: unknown;
  }): Promise<EphemeralSession> => {
    capture.appels += 1;
    capture.systemPrompt = sessionOptions.systemPrompt;
    capture.model = sessionOptions.model;
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

function makeDescriber(
  capture: Capture,
  modelReference: () => string,
  options: { texte?: string; echoue?: string } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "yuki-vision-repli-"));
  tempDirs.push(root);
  const paths = resolvePiPaths({
    agentDir: join(root, "agent"),
    cwd: join(root, "workspace"),
    home: join(root, "home"),
    sessionsDir: join(root, "agent", "sessions"),
    settingsSeedPath: "config/pi/settings.json",
  });
  seedSettingsFile(paths, logger);
  writeModelsFile(paths, buildModelsConfigFrom(EFFECTIVE_SANS_VISION_LEGERE), logger);
  return createSdkVisionDescriber({
    cwd: paths.cwd,
    agentDir: paths.agentDir,
    authPath: join(paths.agentDir, "auth.json"),
    modelsPath: paths.modelsPath,
    modelReference,
    timeoutMs: () => 5_000,
    logger,
    createSession: scriptedSession(capture, options) as never,
  });
}

function capture(): Capture {
  return { prompted: [], images: [], appels: 0 };
}

describe("① le réglage `vision.fallback.model`", () => {
  const descripteur = CONFIG_SCHEMA["vision.fallback.model"];

  it("existe, de PORTÉE `instance` (réglage général, pas par bot)", () => {
    expect(descripteur).toBeDefined();
    expect(descripteur?.scope).toBe("instance");
  });

  it("a pour défaut la chaîne VIDE (= aucun repli, comportement inchangé)", () => {
    expect(descripteur).toMatchObject({ type: "string", default: "" });
  });

  it("s'applique À CHAUD (relu à chaque image, sans redémarrage)", () => {
    expect(descripteur?.apply).toBe("hot");
  });
});

describe("② modèle sans vision + image + repli ⇒ DESCRIPTION fournie", () => {
  it("le repli est appelé UNE fois avec l'image, et rend une description", async () => {
    const seen = capture();
    const decrire = makeDescriber(seen, () => MODELES.heavy.reference, {
      texte: "Un bouton « Enregistrer », chiffre 12 en haut à droite.",
    });

    const issue = await decrire([IMAGE]);
    expect(issue.kind).toBe("described");
    if (issue.kind !== "described") return;
    expect(issue.modele).toBe(MODELES.heavy.reference);
    expect(issue.descriptions[0]?.texte).toContain("Enregistrer");
    // L'image est bien partie au modèle de REPLI (une seule fois).
    expect(seen.appels).toBe(1);
    expect(seen.images).toHaveLength(1);
    expect(seen.images[0]).toHaveLength(1);
  });

  it("le prompt de description est FACTUEL (libellés, chiffres — pas d'interprétation)", async () => {
    const seen = capture();
    const decrire = makeDescriber(seen, () => MODELES.heavy.reference);
    await decrire([IMAGE]);
    // ⚠️ Consigne système : on demande ce qui est LISIBLE et on interdit
    // l'interprétation — sans quoi le modèle actif prendrait une supposition
    // pour une observation (il ne voit pas l'image).
    expect(seen.systemPrompt).toBe(VISION_DESCRIPTION_PROMPT);
    expect(VISION_DESCRIPTION_PROMPT).toContain("texte lisible");
    expect(VISION_DESCRIPTION_PROMPT).toContain("CHIFFRES");
    expect(VISION_DESCRIPTION_PROMPT).toContain("aucune interprétation");
    expect(VISION_DESCRIPTION_PROMPT).toContain("peut manquer de détails");
  });
});

describe("③ modèle AVEC vision ⇒ le repli n'est JAMAIS appelé", () => {
  it("`planVision` garde les images (aucun appel, aucun coût)", () => {
    expect(
      planVision({ modeleVoitLesImages: true, nombreImages: 2, repliConfigure: true }),
    ).toBe("garder");
    // Aucune image : rien à décider, le repli n'a rien à faire.
    expect(
      planVision({ modeleVoitLesImages: false, nombreImages: 0, repliConfigure: true }),
    ).toBe("garder");
  });
});

describe("④ aucun repli configuré ⇒ honnête, aucune invention", () => {
  it("référence vide ⇒ `not_configured` et AUCUNE session ouverte", async () => {
    const seen = capture();
    const decrire = makeDescriber(seen, () => "");
    const issue = await decrire([IMAGE]);
    expect(issue).toEqual({ kind: "not_configured" });
    expect(seen.appels).toBe(0);
  });

  it("`planVision` refuse quand rien n'est configuré", () => {
    expect(
      planVision({ modeleVoitLesImages: false, nombreImages: 1, repliConfigure: false }),
    ).toBe("refuser");
  });
});

describe("⑤ repli en ÉCHEC ⇒ résultat nommé, jamais une exception", () => {
  it("fournisseur introuvable ⇒ message explicite", async () => {
    const seen = capture();
    // ⚠️ Un ID de modèle inconnu chez un fournisseur CONNU est résolu par le SDK
    // (l'échec arrive alors à l'appel : cas suivant). C'est le FOURNISSEUR
    // inconnu qui ne résout rien — et qu'il faut donc nommer.
    const decrire = makeDescriber(seen, () => "fournisseur-inconnu/modele");
    const issue = await decrire([IMAGE]);
    expect(issue.kind).toBe("failed");
    if (issue.kind !== "failed") return;
    expect(issue.message).toContain("introuvable");
    expect(seen.appels).toBe(0);
  });

  it("repli déclaré SANS vision ⇒ refus explicite (on n'envoie pas l'image dans le vide)", async () => {
    const seen = capture();
    // Le LÉGER de ce `models.json` est déclaré `vision: false`.
    const decrire = makeDescriber(seen, () => MODELES.light.reference);
    const issue = await decrire([IMAGE]);
    expect(issue.kind).toBe("failed");
    if (issue.kind !== "failed") return;
    expect(issue.message).toContain("SANS vision");
    expect(seen.appels).toBe(0);
  });

  it("exception du modèle ⇒ message d'échec, aucun rejet", async () => {
    const seen = capture();
    const decrire = makeDescriber(seen, () => MODELES.heavy.reference, {
      echoue: "delai depasse",
    });
    const issue = await decrire([IMAGE]);
    expect(issue.kind).toBe("failed");
    if (issue.kind !== "failed") return;
    expect(issue.message).toContain("n'a pas répondu");
  });

  it("réponse vide ⇒ échec nommé (aucune description inventée)", async () => {
    const seen = capture();
    const decrire = makeDescriber(seen, () => MODELES.heavy.reference, { texte: "   " });
    const issue = await decrire([IMAGE]);
    expect(issue.kind).toBe("failed");
    if (issue.kind !== "failed") return;
    expect(issue.message).toContain("rien décrit");
  });
});

describe("⑥ une seule description par image", () => {
  it("la même image redemandée n'ouvre AUCUNE nouvelle session", async () => {
    const seen = capture();
    const decrire = makeDescriber(seen, () => MODELES.heavy.reference);
    const premier = await decrire([IMAGE]);
    const second = await decrire([IMAGE]);
    expect(seen.appels).toBe(1);
    expect(second).toEqual(premier);
  });
});

describe("⑦ réglage À CHAUD", () => {
  it("changer la référence prend effet au prochain usage, sans redémarrage", async () => {
    const seen = capture();
    let reference = "";
    const decrire = makeDescriber(seen, () => reference);
    expect((await decrire([IMAGE])).kind).toBe("not_configured");
    reference = MODELES.heavy.reference;
    const issue = await decrire([IMAGE]);
    expect(issue.kind).toBe("described");
    expect(seen.appels).toBe(1);
  });
});

describe("⑧ le texte injecté dit la VÉRITÉ (modèle ET utilisateur)", () => {
  it("le bloc nomme le modèle de repli et prévient qu'une description manque de détails", () => {
    const bloc = blocDescriptionVision({
      modele: MODELES.heavy.reference,
      descriptions: [{ nom: "capture.png", texte: "Une fenêtre avec un bouton « OK »." }],
    });
    expect(bloc).toContain("Description d'image par le modèle de vision de repli");
    expect(bloc).toContain(MODELES.heavy.reference);
    expect(bloc).toContain("ne voit PAS les images");
    expect(bloc).toContain("peut manquer de détails");
    expect(bloc).toContain("capture.png");
    expect(bloc).toContain("bouton « OK »");
  });

  it("l'échec est DIT explicitement (le tour continue sans l'image)", () => {
    const bloc = blocEchecVisionRepli("le modèle de repli n'a pas répondu");
    expect(bloc).toContain("Impossible d'analyser l'image");
    expect(bloc).toContain("n'a pas répondu");
    expect(bloc).toContain("continue sans l'image");
  });
});

/** Typage : l'issue est bien celle que tous les chemins consomment. */
const _issue: VisionDescriptionOutcome = { kind: "not_configured" };
void _issue;
