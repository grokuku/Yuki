/**
 * Types du domaine TTS (Lot 7 — socle serveur).
 *
 * Une **voix** est une entité **Yuki** (§10.1) : presets et voix clonées
 * partagent la même abstraction, seule la provenance (`kind`/`createdBy`)
 * change. Le chemin physique de l'échantillon (`refAudio`) est **interne** au
 * volume des voix : il n'est jamais exposé tel quel par l'API (qui manipule des
 * `id`).
 *
 * Aucun import SDK/typebox : données pures, sérialisables.
 */

/** Provenance d'une voix. */
export type VoiceKind = "preset" | "cloned";

/** Qui a créé la voix (les presets « factory » ne sont pas supprimables). */
export type VoiceCreator = "factory" | "user";

/**
 * Voix telle que stockée dans le registre `voices.json` (source de vérité).
 *
 * `refAudio` est un chemin **relatif** au répertoire des voix
 * (`cloned/<id>.wav`, `presets/<id>.wav`), jamais un chemin absolu fourni par
 * l'utilisateur — c'est ce qui empêche toute traversée de chemin.
 */
export interface Voice {
  /** Slug stable, unique, URL-safe (`[a-z0-9-]{1,40}`). */
  id: string;
  /** Libellé affiché dans l'UI. */
  label: string;
  kind: VoiceKind;
  /** Langue de la voix (référence + synthèse). */
  lang: string;
  /** Chemin relatif du WAV de référence DANS le volume voix, ou `null`. */
  refAudio: string | null;
  /** Transcription de l'échantillon (optionnel). */
  refText: string | null;
  /** Date de création ISO-8601. */
  createdAt: string;
  createdBy: VoiceCreator;
}

/** Projection publique d'une voix (jamais de chemin). */
export interface VoicePublic {
  id: string;
  label: string;
  kind: VoiceKind;
  lang: string;
  createdAt: string;
  /** `true` si un extrait de démonstration est disponible pour cette voix. */
  demoAvailable: boolean;
}

/**
 * Nature d'une trame binaire `YTA1` (§4.5) :
 *   - `tts_audio`  : bloc PCM ;
 *   - `tts_end`    : fin de run (tous les segments émis) ;
 *   - `tts_cancel` : purge barge-in (vider le buffer client).
 */
export type TtsFrameType = "tts_audio" | "tts_end" | "tts_cancel";

/** Crant d'émotion exposé à l'utilisateur (§9.1, §10.7). */
export type TtsEmotion =
  | "neutre"
  | "expressive"
  | "dramatique"
  | "personnalisee";

/** Options EFFECTIVES de synthèse (déjà résolues depuis la config). */
export interface TtsOptions {
  /** Langue de synthèse (`fr` en v1). */
  language: string;
  /** Cran d'émotion (option simple). */
  emotion: TtsEmotion;
  /** `exaggeration` en POUR-MILLE (0–1500) ; réel = valeur / 1000. */
  exaggeration: number;
  /** `cfg` en POUR-MILLE (0–1500) ; réel = valeur / 1000. */
  cfg: number;
  /** Débit en % (50–200). */
  speed: number;
}

/** Convertit une voix interne en projection publique. */
export function toPublicVoice(
  voice: Voice,
  options: { demoAvailable: boolean },
): VoicePublic {
  return {
    id: voice.id,
    label: voice.label,
    kind: voice.kind,
    lang: voice.lang,
    createdAt: voice.createdAt,
    demoAvailable: options.demoAvailable,
  };
}
