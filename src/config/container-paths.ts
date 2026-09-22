/**
 * Chemins INTERNES canoniques au conteneur (cibles de montage des composes).
 *
 * SOURCE UNIQUE DE VÉRITÉ : ces constantes sont à la fois (a) les DÉFAUTS du
 * code (`src/config/env.ts`) et (b) les CIBLES des `volumes:` des composes. Un
 * test garde-fou (`tests/config/container-paths.test.ts`) compare les deux :
 * impossible de les désynchroniser par accident.
 *
 * ⚠️ Surchargeables par variable d'environnement (rétro-compatibilité des
 * déploiements existants, `deploy/minimal`, CI), mais JAMAIS définis dans les
 * composes : le compose reste MUET sur les chemins internes et n'explicite que
 * ses montages (`target:`). Voir `docs/lot9.md` (D61).
 *
 * Ne contient AUCUN chemin relatif ni chemin d'image (`/app/...`) : ces derniers
 * se dérivent du `configDir` (défaut `./config`, résolu depuis le WORKDIR `/app`
 * de l'image) et ne sont pas des cibles de montage.
 */

/** Cibles de montage internes, une constante par montage. */
export const CONTAINER_PATHS = {
  /** Volume `pi` (état du SDK Pi) — `/data/pi`. */
  pi: "/data/pi",
  /** Volume `workspace` (répertoire de travail de l'agent) — `/workspace`. */
  workspace: "/workspace",
  /** Volume des modèles GGUF — `/models` (gateway `rw`, moteur `ro`). */
  models: "/models",
  /** Volume d'état (`config.json`, `jobs.jsonl`) — `/data/state`. */
  state: "/data/state",
  /** Volume des voix TTS (registre + WAV) — `/voices`. */
  voices: "/voices",
  /** Dossier de config du moteur, VU PAR LE GATEWAY (bind `rw`) — `/data/tts-config`. */
  ttsConfigDir: "/data/tts-config",
  /** Dossier de config du moteur, VU PAR LE MOTEUR (monté `ro`) — `/config`. */
  ttsEngineConfigDir: "/config",
} as const;

/**
 * Sous-dossier (CONVENTION d'organisation, pas une barrière) où le gateway range
 * les téléchargements : `<models>/downloads`. Dérivé du montage `models`, jamais
 * configurable.
 */
export const MODELS_DOWNLOADS_SUBDIR = "downloads";
