/**
 * Tests unitaires — logique PURE de la page `/config` (`public/ui/config-patch.js`).
 *
 * Vérifie deux points :
 *  1. le TYPE des valeurs du patch envoyé à `PUT /api/config` (nombres pour
 *     `number`/`range`, chaînes pour `text`/`select`, `null` pour les resets) ;
 *  2. la présentation des erreurs : la cause RÉELLE (code + message + champ) est
 *     toujours exposée, jamais un texte générique.
 */

import { describe, expect, it } from "vitest";

import {
  buildConfigPatch,
  coerceFieldValue,
  engineFieldState,
  engineSupportsEmotion,
  engineSupportsSpeed,
  presentConfigSaveError,
  presentRestartRefusal,
} from "../../public/ui/config-patch.js";
import {
  engineSupportsEmotion as adapterSupportsEmotion,
  engineSupportsSpeed as adapterSupportsSpeed,
} from "../../src/tts/audio-cpp.js";

type AnyRecord = Record<string, unknown>;

interface FakeState {
  fields: AnyRecord;
  secretState: Map<string, AnyRecord>;
  pendingResets: Set<string>;
  inputs: Map<string, { value: string }>;
  initial: Map<string, unknown>;
}

function makeState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    fields: {},
    secretState: new Map(),
    pendingResets: new Set(),
    inputs: new Map(),
    initial: new Map(),
    ...overrides,
  };
}

const NUMBER_FIELD = { path: "tts.speed", kind: "number" };
const RANGE_FIELD = { path: "tts.exaggeration", kind: "range" };
const SELECT_FIELD = { path: "tts.emotion", kind: "select" };
const TEXT_FIELD = { path: "tts.voice", kind: "text" };
const TEXTAREA_FIELD = { path: "prompts.light", kind: "textarea" };
const SECRET_FIELD = { path: "llm.light.apiKey", kind: "secret" };

describe("buildConfigPatch — typage des valeurs", () => {
  it("envoie un champ `number` modifié en NOMBRE (pas la chaîne du <input>)", () => {
    const state = makeState();
    state.inputs.set("tts.speed", { value: "150" });
    state.initial.set("tts.speed", 100);
    const patch = buildConfigPatch({ allFields: [NUMBER_FIELD], state });
    expect(patch).toEqual({ "tts.speed": 150 });
    expect(typeof patch["tts.speed"]).toBe("number");
  });

  it("envoie un champ `range` modifié en NOMBRE", () => {
    const state = makeState();
    state.inputs.set("tts.exaggeration", { value: "700" });
    state.initial.set("tts.exaggeration", 500);
    const patch = buildConfigPatch({ allFields: [RANGE_FIELD], state });
    expect(patch["tts.exaggeration"]).toBe(700);
    expect(typeof patch["tts.exaggeration"]).toBe("number");
  });

  it("envoie select / texte / textarea en CHAÎNE", () => {
    const state = makeState();
    state.inputs.set("tts.emotion", { value: "expressive" });
    state.initial.set("tts.emotion", "neutre");
    state.inputs.set("tts.voice", { value: "voix-1" });
    state.initial.set("tts.voice", "");
    state.inputs.set("prompts.light", { value: "P modifié" });
    state.initial.set("prompts.light", "P");
    const patch = buildConfigPatch({
      allFields: [SELECT_FIELD, TEXT_FIELD, TEXTAREA_FIELD],
      state,
    });
    expect(patch).toEqual({
      "tts.emotion": "expressive",
      "tts.voice": "voix-1",
      "prompts.light": "P modifié",
    });
  });

  it("n'inclut QUE les champs modifiés", () => {
    const state = makeState();
    state.inputs.set("tts.speed", { value: "100" });
    state.initial.set("tts.speed", 100); // inchangé
    state.inputs.set("tts.emotion", { value: "dramatique" });
    state.initial.set("tts.emotion", "neutre"); // changé
    const patch = buildConfigPatch({
      allFields: [NUMBER_FIELD, SELECT_FIELD],
      state,
    });
    expect(patch).toEqual({ "tts.emotion": "dramatique" });
  });

  it("laisse un nombre VIDE ou non entier en chaîne (le serveur rend l'erreur précise)", () => {
    expect(coerceFieldValue(NUMBER_FIELD, "")).toBe("");
    expect(coerceFieldValue(NUMBER_FIELD, "abc")).toBe("abc");
    expect(coerceFieldValue(NUMBER_FIELD, "150.5")).toBe("150.5");
    expect(coerceFieldValue(NUMBER_FIELD, "  151  ")).toBe(151);
  });

  it("gère les secrets : remplacement en chaîne, effacement en null, verrou ignoré", () => {
    const state = makeState();
    state.secretState.set("llm.light.apiKey", { mode: "replace", input: { value: " sk-abc " } });
    state.fields["llm.light.apiKey"] = {};
    state.secretState.set("llm.heavy.apiKey", { mode: "clear", input: null });
    state.fields["llm.heavy.apiKey"] = {};
    const HEAVY = { path: "llm.heavy.apiKey", kind: "secret" };
    const LOCKED = { path: "llm.missingKeyMode", kind: "select" };
    state.fields["llm.missingKeyMode"] = { lockedByEnv: "YUKI_LLM_MISSING_KEY_MODE" };
    state.inputs.set("llm.missingKeyMode", { value: "refuse" });
    state.initial.set("llm.missingKeyMode", "degrade");
    const patch = buildConfigPatch({
      allFields: [SECRET_FIELD, HEAVY, LOCKED],
      state,
    });
    expect(patch).toEqual({
      "llm.light.apiKey": "sk-abc",
      "llm.heavy.apiKey": null,
    });
  });

  it("envoie null pour un reset de textarea (Réinitialiser au défaut)", () => {
    const state = makeState();
    state.inputs.set("prompts.light", { value: "" });
    state.initial.set("prompts.light", "P");
    state.pendingResets.add("prompts.light");
    const patch = buildConfigPatch({ allFields: [TEXTAREA_FIELD], state });
    expect(patch).toEqual({ "prompts.light": null });
  });

  it("gpu.profile vidé : null seulement s'il y avait une valeur", () => {
    const GPU = { path: "gpu.profile", kind: "select" };
    const withValue = makeState();
    withValue.inputs.set("gpu.profile", { value: "" });
    withValue.initial.set("gpu.profile", "compact");
    expect(buildConfigPatch({ allFields: [GPU], state: withValue })).toEqual({
      "gpu.profile": null,
    });

    const alreadyEmpty = makeState();
    alreadyEmpty.inputs.set("gpu.profile", { value: "" });
    alreadyEmpty.initial.set("gpu.profile", "");
    expect(buildConfigPatch({ allFields: [GPU], state: alreadyEmpty })).toEqual({});
  });
});

describe("presentConfigSaveError — cause réelle, jamais générique", () => {
  const LABELS = new Map<string, string>([
    ["tts.speed", "Débit (%)"],
    ["gpu.compatMode", "Mode de compatibilité"],
  ]);

  function httpError(status: number, data: AnyRecord): Error & { status: number; data: AnyRecord } {
    const error = new Error("erreur") as Error & { status: number; data: AnyRecord };
    error.status = status;
    error.data = data;
    return error;
  }

  it("invalid_config : montre le code, le champ et le message du serveur", () => {
    const { summary, fields } = presentConfigSaveError(
      httpError(400, {
        error: "invalid_config",
        fields: [
          { path: "tts.speed", code: "above_max", message: "Valeur trop grande (maximum 200)." },
        ],
      }),
      LABELS,
    );
    expect(summary).toContain("invalid_config");
    expect(summary).toContain("Champ « Débit (%) »");
    expect(summary).toContain("Valeur trop grande (maximum 200).");
    expect(fields).toEqual([
      { path: "tts.speed", code: "above_max", message: "Valeur trop grande (maximum 200)." },
    ]);
  });

  it("locked_by_env : cite la variable et explique", () => {
    const { summary, fields } = presentConfigSaveError(
      httpError(400, {
        error: "locked_by_env",
        code: "locked_by_env",
        variable: "YUKI_TTS_SPEED",
        fields: [
          {
            path: "tts.speed",
            code: "locked_by_env",
            message: "Champ verrouillé par l'environnement (YUKI_TTS_SPEED).",
          },
        ],
      }),
      LABELS,
    );
    expect(summary).toContain("locked_by_env");
    expect(summary).toContain("YUKI_TTS_SPEED");
    expect(summary).toContain("variable d'environnement");
    expect(fields[0]?.path).toBe("tts.speed");
  });

  it("bad_origin (sans champ) : reprend le message réel du serveur", () => {
    const { summary, fields } = presentConfigSaveError(
      httpError(403, {
        error: "forbidden",
        code: "bad_origin",
        message: "Origine de la requête refusée.",
      }),
      LABELS,
    );
    expect(summary).toContain("bad_origin");
    expect(summary).toContain("Origine de la requête refusée.");
    expect(fields[0]?.path).toBe("");
  });

  it("config_store_unwritable : reprend le message utile (volume state)", () => {
    const { summary } = presentConfigSaveError(
      httpError(500, {
        error: "config_store_unwritable",
        code: "config_store_unwritable",
        path: "/state/config.json",
        message:
          "Impossible d'écrire la configuration (/state/config.json). Le volume « state » est-il monté ET inscriptible par l'uid/gid du conteneur (bind mount : chown 1000:1000) ?",
      }),
      LABELS,
    );
    expect(summary).toContain("config_store_unwritable");
    expect(summary).toContain("/state/config.json");
    expect(summary).toContain("volume « state »");
  });

  it("erreur réseau : ne prétend pas connaître une cause serveur", () => {
    const error = new Error("timeout") as Error & { status: number };
    error.status = 0;
    const { summary } = presentConfigSaveError(error, LABELS);
    expect(summary).toContain("réseau");
    expect(summary).toContain("timeout");
  });

  it("code inconnu : montre quand même le message brut du serveur", () => {
    const { summary } = presentConfigSaveError(
      httpError(418, { error: "teapot", message: "Je suis une théière." }),
      LABELS,
    );
    expect(summary).toContain("teapot");
    expect(summary).toContain("Je suis une théière.");
  });
});

/**
 * `POST /api/admin/restart` refuse (409 `download_in_progress`) tant qu'un
 * téléchargement est actif (Lot 9, étape 2). Ce refus n'est PAS une panne : il
 * doit être présenté comme une information, avec le message exact du serveur.
 */
describe("presentRestartRefusal — le 409 download_in_progress n'est pas une panne", () => {
  function httpError(status: number, data: AnyRecord) {
    const error = new Error("erreur") as Error & { status: number; data: AnyRecord };
    error.status = status;
    error.data = data;
    return error;
  }

  it("409 download_in_progress → information, sans préfixe « Échec », message serveur repris", () => {
    const described = presentRestartRefusal(
      httpError(409, {
        code: "download_in_progress",
        message:
          "Un téléchargement de modèle est en cours : redémarrer maintenant l'interromprait. " +
          "Attendez la fin du téléchargement ou annulez-le, puis redémarrez.",
        activeDownload: "chatterbox",
      }),
    );
    expect(described.code).toBe("download_in_progress");
    expect(described.info).toBe(true);
    expect(described.message).not.toMatch(/Échec/);
    expect(described.message).toMatch(/annulez-le/);
  });

  it("409 sans message serveur → repli explicite, toujours informatif", () => {
    const described = presentRestartRefusal(httpError(409, { code: "download_in_progress" }));
    expect(described.info).toBe(true);
    expect(described.message).toMatch(/téléchargement/i);
    expect(described.message).not.toMatch(/Échec/);
  });

  it("autre erreur → échec classique avec le message brut", () => {
    const described = presentRestartRefusal(
      httpError(500, { code: "internal_error", message: "Boom." }),
    );
    expect(described.info).toBe(false);
    expect(described.message).toContain("Échec de la demande de redémarrage");
    expect(described.message).toContain("Boom.");
  });

  it("erreur réseau : échec classique, message typé", () => {
    const described = presentRestartRefusal(new Error("Failed to fetch"));
    expect(described.info).toBe(false);
    expect(described.message).toContain("Failed to fetch");
  });
});

/**
 * Honnêteté de l'UI sur le moteur : un champ sans effet doit être DÉSACTIVÉ et
 * NOTÉ, et l'état doit suivre le changement de `tts.engine`. La table UI doit
 * rester synchronisée avec l'adaptateur `src/tts/audio-cpp.ts`.
 */
describe("engineFieldState — débit et émotion selon `tts.engine`", () => {
  it("débit : désactivé + noté pour un moteur sans contrôle de vitesse", () => {
    for (const engine of ["chatterbox", "qwen3-tts", "cosyvoice3", "inconnu"]) {
      expect(engineFieldState("tts.speed", engine), engine).toEqual({
        disabled: true,
        note: "Sans effet avec ce moteur.",
      });
    }
  });

  it("débit : normal (non désactivé, sans note) pour kokoro / sanotts", () => {
    for (const engine of ["kokoro", "kokoro_tts", "sanotts"]) {
      expect(engineFieldState("tts.speed", engine), engine).toEqual({
        disabled: false,
        note: "",
      });
    }
  });

  it("émotion : lue seulement par chatterbox, inopérante ailleurs", () => {
    for (const path of ["tts.exaggeration", "tts.cfg"]) {
      expect(engineFieldState(path, "chatterbox")).toEqual({ disabled: false, note: "" });
      for (const engine of ["qwen3-tts", "cosyvoice3", "kokoro", "sanotts", "inconnu"]) {
        expect(engineFieldState(path, engine), `${path}/${engine}`).toEqual({
          disabled: true,
          note: "Sans effet avec ce moteur.",
        });
      }
    }
  });

  it("champ sans dépendance moteur : null (jamais touché par l'UI)", () => {
    expect(engineFieldState("tts.baseUrl", "chatterbox")).toBeNull();
    expect(engineFieldState("tts.voice", "kokoro")).toBeNull();
  });

  it("la table UI reste SYNCHRONISÉE avec l'adaptateur gateway", () => {
    const engines = ["chatterbox", "qwen3-tts", "cosyvoice3", "kokoro", "sanotts", "inconnu"];
    for (const engine of engines) {
      expect(engineSupportsSpeed(engine), `speed/${engine}`).toBe(adapterSupportsSpeed(engine));
      expect(engineSupportsEmotion(engine), `emotion/${engine}`).toBe(adapterSupportsEmotion(engine));
    }
  });

  it("un champ DÉSACTIVÉ garde sa valeur et reste enregistrable (patch non bloqué)", () => {
    // Le moteur par défaut (`chatterbox`) désactive « Débit (%) », mais le
    // patch d'enregistrement continue de porter la valeur modifiée : griser ne
    // doit jamais retirer le champ ni faire échouer le `PUT /api/config`.
    const disabled = engineFieldState("tts.speed", "chatterbox");
    expect(disabled?.disabled).toBe(true);
    const state = makeState();
    state.inputs.set("tts.speed", { value: "133" });
    state.initial.set("tts.speed", 100);
    const patch = buildConfigPatch({ allFields: [NUMBER_FIELD], state });
    expect(patch).toEqual({ "tts.speed": 133 });
  });
});
