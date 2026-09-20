/**
 * Passerelle de configuration → options de synthèse TTS (Lot 7).
 *
 * Isole la lecture des champs `tts.*` (schéma Lot 11) et la **table d'émotion**
 * (§10.7 : cran → couple `(exaggeration, cfg)`) de tout le reste du domaine.
 * Aucun import de `ConfigRuntime` : seule une interface minimale est requise,
 * ce qui rend le mapping testable sans store de configuration.
 */

import type { TtsEmotion, TtsOptions } from "./types.js";

/** Lecteur minimal de configuration (compatible `ConfigRuntime`). */
export interface TtsConfigReader {
  getString(path: string): string;
  getNumber(path: string): number;
}

/** Valeurs réelles (pour-mille) d'un cran d'émotion. */
export interface EmotionValues {
  /** `exaggeration` en pour-mille (0–1500). */
  exaggeration: number;
  /** `cfg` en pour-mille (0–1500). */
  cfg: number;
}

/**
 * Table d'émotion (§10.7). `personnalisee` renvoie les valeurs fines fournies ;
 * les trois autres imposent le couple recommandé par la spec.
 */
export function resolveEmotionValues(
  emotion: TtsEmotion,
  exaggeration: number,
  cfg: number,
): EmotionValues {
  switch (emotion) {
    case "expressive":
      return { exaggeration: 700, cfg: 400 };
    case "dramatique":
      return { exaggeration: 800, cfg: 300 };
    case "personnalisee":
      return { exaggeration, cfg };
    case "neutre":
    default:
      return { exaggeration: 500, cfg: 500 };
  }
}

const EMOTIONS: readonly TtsEmotion[] = [
  "neutre",
  "expressive",
  "dramatique",
  "personnalisee",
];

/** Lit les options effectives de synthèse depuis la configuration. */
export function readTtsOptions(config: TtsConfigReader): TtsOptions {
  const rawEmotion = config.getString("tts.emotion");
  const emotion = (EMOTIONS as readonly string[]).includes(rawEmotion)
    ? (rawEmotion as TtsEmotion)
    : "neutre";
  const language = config.getString("tts.language");
  return {
    language: language.length > 0 ? language : "fr",
    emotion,
    exaggeration: config.getNumber("tts.exaggeration"),
    cfg: config.getNumber("tts.cfg"),
    speed: config.getNumber("tts.speed"),
  };
}

/** `true` si le TTS est autorisé par la configuration (`tts.enabled === "on"`). */
export function isTtsEnabled(config: TtsConfigReader): boolean {
  return config.getString("tts.enabled") === "on";
}
