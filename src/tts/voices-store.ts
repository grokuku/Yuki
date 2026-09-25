/**
 * Magasin des voix TTS (Lot 7, §10.1/§10.3).
 *
 * Persistance dans le volume dédié (`yuki-voices`, monté `/voices`) :
 *   - `voices.json`      : registre Yuki, **source de vérité** ;
 *   - `presets/<id>.wav` : voix prédéfinies (déposées à l'installation) ;
 *   - `cloned/<id>.wav`  : voix clonées (écrites par l'upload utilisateur).
 *
 * Invariants :
 *   - l'`id` est un **slug** dérivé du libellé (jamais le nom de fichier fourni
 *     par l'utilisateur) → aucune traversée de chemin possible ;
 *   - l'écriture est **atomique** (`tmp` + `rename`) : un lecteur ne voit jamais
 *     un fichier partiel ;
 *   - un `preset` n'est **pas** supprimable ;
 *   - les quotas (nombre de voix clonées, somme des octets) sont vérifiés à la
 *     création et refusés explicitement.
 *
 * Aucun service `tts` n'est requis : le registre est une fonctionnalité Yuki.
 */

import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import { validateVoiceSample } from "./wav.js";
import type { Voice } from "./types.js";

/**
 * Taille maximale d'un corps d'upload de voix (D20/D88, spec §10.4).
 *
 * **Cohérent avec `MAX_VOICE_DURATION_SECONDS = 30`** (`./wav.js`) : 30 s en
 * mono 16 bits 48 kHz ≈ 2,88 Mo, et en **stéréo** 16 bits 48 kHz ≈ 5,76 Mo —
 * les deux tiennent sous 6 Mo. Une limite plus basse rendrait la durée annoncée
 * **inatteignable** pour un WAV stéréo (d'où D88). Formats non couverts au-delà
 * (stéréo 24/32 bits, fréquence > 48 kHz) : convertir en mono 24 kHz.
 */
export const MAX_VOICE_BODY_BYTES = 6_000_000;
/** Nombre maximal de voix CLONÉES (quota, spec §10.3). */
export const DEFAULT_MAX_VOICES = 20;
/** Somme maximale des octets des voix CLONÉES (quota, spec §10.3). */
export const DEFAULT_MAX_VOICES_BYTES = 50_000_000;

/** Version de schéma du registre des voix. */
export const VOICES_REGISTRY_SCHEMA_VERSION = 1;

/** Erreur métier du magasin de voix : porte un statut HTTP exploitable. */
export class VoiceStoreError extends Error {
  override readonly name: string = "VoiceStoreError";
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * La voix déclare une référence audio (`refAudio`) dont le fichier est **absent**
 * du volume. Sans cette vérification, l'appel au moteur partirait avec un
 * `voice_ref` fantôme et échouerait **opaque** (« requires speaker reference
 * audio ») au lieu de nommer le fichier manquant.
 */
export class VoiceReferenceError extends VoiceStoreError {
  override readonly name = "VoiceReferenceError";
  constructor(
    readonly voiceId: string,
    /** Chemin attendu du WAV côté gateway (volume des voix). */
    readonly samplePath: string,
  ) {
    super(
      "voice_ref_missing",
      422,
      `Fichier de référence introuvable pour la voix « ${voiceId} » : ${samplePath}.`,
    );
  }
}

export interface VoiceStoreOptions {
  /** Répertoire racine (volume `yuki-voices`). */
  dir: string;
  maxVoices?: number;
  maxBytes?: number;
  now?: () => number;
}

export interface CreateVoiceInput {
  bytes: Buffer;
  label: string;
  lang?: string;
  refText?: string | null;
}

/** Libellé valide : non vide après trim, 1–80 caractères. */
const MAX_LABEL_LENGTH = 80;

/**
 * Slug URL-safe dérivé d'un libellé : minuscules, ASCII, `[a-z0-9-]`,
 * longueur 1–40. Jamais vide (« voix » en dernier recours).
 */
export function slugifyVoiceId(label: string): string {
  const base = label
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base.length > 0 ? base : "voix";
}

/** Résout un chemin sous `base`, ou `null` s'il en sort (anti-traversée). */
function resolveWithin(base: string, relative: string): string | null {
  const baseResolved = resolve(base);
  const target = resolve(baseResolved, relative);
  if (target === baseResolved) return null;
  if (!target.startsWith(baseResolved + sep)) return null;
  return target;
}

/** Écrit un fichier de façon atomique (`tmp` + `rename`), en créant le parent. */
function writeAtomic(path: string, data: Buffer | string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, data, { mode });
  renameSync(tmp, path);
}

function isVoiceCandidate(value: unknown): value is Voice {
  if (!value || typeof value !== "object") return false;
  const voice = value as Record<string, unknown>;
  return (
    typeof voice.id === "string" &&
    voice.id.length > 0 &&
    typeof voice.label === "string" &&
    (voice.kind === "preset" || voice.kind === "cloned") &&
    typeof voice.lang === "string" &&
    (voice.refAudio === null || typeof voice.refAudio === "string") &&
    (voice.refText === null || typeof voice.refText === "string") &&
    typeof voice.createdAt === "string" &&
    (voice.createdBy === "factory" || voice.createdBy === "user")
  );
}

/**
 * Magasin de voix : API CRUD au-dessus du volume, sans dépendance au service
 * `tts`.
 */
export class VoiceStore {
  readonly dir: string;
  private readonly maxVoices: number;
  private readonly maxBytes: number;
  private readonly now: () => number;

  constructor(options: VoiceStoreOptions) {
    this.dir = resolve(options.dir);
    this.maxVoices = options.maxVoices ?? DEFAULT_MAX_VOICES;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_VOICES_BYTES;
    this.now = options.now ?? Date.now;
  }

  get registryPath(): string {
    return join(this.dir, "voices.json");
  }

  /** Lit le registre (tolérant : fichier absent/invalide ⇒ liste vide). */
  private read(): Voice[] {
    if (!existsSync(this.registryPath)) return [];
    let root: unknown;
    try {
      root = JSON.parse(readFileSync(this.registryPath, "utf8"));
    } catch {
      return [];
    }
    if (!root || typeof root !== "object") return [];
    const record = root as Record<string, unknown>;
    if (!Array.isArray(record.voices)) return [];
    return record.voices.filter(isVoiceCandidate);
  }

  private write(voices: Voice[]): void {
    const payload = `${JSON.stringify(
      { schemaVersion: VOICES_REGISTRY_SCHEMA_VERSION, voices },
      null,
      2,
    )}\n`;
    writeAtomic(this.registryPath, payload, 0o600);
  }

  /** Liste les voix (presets d'abord, puis par libellé). */
  list(): Voice[] {
    const voices = this.read();
    return [...voices].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "preset" ? -1 : 1;
      return a.label.localeCompare(b.label, "fr");
    });
  }

  get(id: string): Voice | undefined {
    if (!isValidVoiceId(id)) return undefined;
    return this.read().find((voice) => voice.id === id);
  }

  /**
   * Voix par défaut : premier **preset** du registre, sinon `null`. C'est la
   * voix appliquée quand `tts.voice` est vide *ou* inconnu (cf. `resolveVoice`).
   * `null` ⇒ aucune voix : l'adaptateur n'envoie alors **aucun** champ de voix
   * et le moteur (Chatterbox) refusera faute de référence — d'où l'intérêt
   * d'avoir toujours au moins un preset dans le registre.
   */
  defaultVoice(): Voice | null {
    return this.read().find((voice) => voice.kind === "preset") ?? null;
  }

  /**
   * Résout une voix par identifiant, avec **repli** sur la voix par défaut si
   * l'id est inconnu (§10.8 : on ne synthétise jamais sans voix de repli).
   */
  resolveVoice(id: string | null | undefined): {
    voice: Voice | null;
    fellBack: boolean;
  } {
    const trimmed = (id ?? "").trim();
    if (trimmed !== "") {
      const found = this.get(trimmed);
      if (found) return { voice: found, fellBack: false };
      return { voice: this.defaultVoice(), fellBack: true };
    }
    return { voice: this.defaultVoice(), fellBack: false };
  }

  /**
   * Chemin absolu (côté gateway) du WAV de référence d'une voix **déjà résolue**,
   * ou `null` si elle n'en déclare pas OU si le fichier est absent du volume.
   * Ne relit PAS le registre : bon marché, sûre sur un chemin chaud.
   */
  samplePathOf(voice: Voice): string | null {
    if (!voice.refAudio) return null;
    const path = resolveWithin(this.dir, voice.refAudio);
    if (!path || !existsSync(path)) return null;
    return path;
  }

  /** Chemin absolu (côté gateway) du WAV de référence, ou `null`. */
  samplePath(id: string): string | null {
    const voice = this.get(id);
    return voice ? this.samplePathOf(voice) : null;
  }

  /**
   * Vérifie que la référence audio d'une voix est **présente** dans le volume.
   * Lève `VoiceReferenceError` sinon (cf. cette classe). Un `null` ou une voix
   * sans `refAudio` ne lève pas : seul un `refAudio` déclaré mais introuvable
   * est une erreur (le registre est censé ne jamais pointer dans le vide).
   */
  assertSample(voice: Voice | null | undefined): void {
    if (voice?.refAudio && this.samplePathOf(voice) === null) {
      throw new VoiceReferenceError(voice.id, join(this.dir, voice.refAudio));
    }
  }

  /**
   * Chemin du WAV **tel que vu par le service `tts`** (volume monté), pour
   * `voice_ref`. `baseDir` est le chemin de montage DANS le conteneur `tts`
   * (`/voices`), jamais le chemin du gateway.
   */
  serviceSamplePath(voice: Voice, baseDir = "/voices"): string | null {
    if (!voice.refAudio) return null;
    return join(baseDir, voice.refAudio);
  }

  /** Crée une voix clonée à partir d'un échantillon uploadé. */
  createFromUpload(input: CreateVoiceInput): Voice {
    const label = input.label.trim();
    if (label.length === 0 || label.length > MAX_LABEL_LENGTH) {
      throw new VoiceStoreError(
        "invalid_label",
        400,
        `Libellé requis (1 à ${MAX_LABEL_LENGTH} caractères).`,
      );
    }
    const lang = (input.lang ?? "fr").trim();
    if (lang.length === 0) {
      throw new VoiceStoreError("invalid_lang", 400, "Langue requise.");
    }

    const validation = validateVoiceSample(input.bytes, {
      maxBytes: MAX_VOICE_BODY_BYTES,
    });
    if (!validation.ok) {
      throw new VoiceStoreError(validation.code, 422, validation.message);
    }

    const voices = this.read();
    const cloned = voices.filter((voice) => voice.kind === "cloned");
    if (cloned.length >= this.maxVoices) {
      throw new VoiceStoreError(
        "quota_voices",
        429,
        `Quota atteint : ${this.maxVoices} voix clonées maximum.`,
      );
    }
    const usedBytes = this.clonedBytes(cloned);
    if (usedBytes + input.bytes.length > this.maxBytes) {
      throw new VoiceStoreError(
        "quota_bytes",
        429,
        `Quota atteint : ${Math.round(this.maxBytes / 1_000_000)} Mo de voix clonées maximum.`,
      );
    }

    const id = uniqueVoiceId(slugifyVoiceId(label), voices);
    const relative = `cloned/${id}.wav`;
    const target = resolveWithin(this.dir, relative);
    if (!target) {
      throw new VoiceStoreError("invalid_path", 500, "Chemin de voix invalide.");
    }

    const voice: Voice = {
      id,
      label,
      kind: "cloned",
      lang,
      refAudio: relative,
      refText: input.refText?.trim() ? input.refText.trim() : null,
      createdAt: new Date(this.now()).toISOString(),
      createdBy: "user",
    };

    // Ordre : WAV d'abord, registre ensuite → au pire un WAV orphelin, jamais
    // une entrée pointant vers un fichier absent (§10.4).
    writeAtomic(target, input.bytes, 0o644);
    try {
      this.write([...voices, voice]);
    } catch (error) {
      try {
        unlinkSync(target);
      } catch {
        // Meilleur effort : le WAV orphelin est inoffensif.
      }
      throw error;
    }
    return voice;
  }

  /** Renomme une voix (libellé uniquement ; l'`id` reste stable). */
  rename(id: string, label: string): Voice {
    const trimmed = label.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_LABEL_LENGTH) {
      throw new VoiceStoreError(
        "invalid_label",
        400,
        `Libellé requis (1 à ${MAX_LABEL_LENGTH} caractères).`,
      );
    }
    const voices = this.read();
    const index = voices.findIndex((voice) => voice.id === id && isValidVoiceId(id));
    if (index < 0) {
      throw new VoiceStoreError("not_found", 404, `Voix inconnue : ${id}.`);
    }
    const updated: Voice = { ...(voices[index] as Voice), label: trimmed };
    voices[index] = updated;
    this.write(voices);
    return updated;
  }

  /** Supprime une voix clonée (un preset est refusé : `not_deletable`). */
  remove(id: string): Voice {
    const voices = this.read();
    const index = voices.findIndex((voice) => voice.id === id && isValidVoiceId(id));
    if (index < 0) {
      throw new VoiceStoreError("not_found", 404, `Voix inconnue : ${id}.`);
    }
    const voice = voices[index] as Voice;
    if (voice.kind === "preset") {
      throw new VoiceStoreError(
        "not_deletable",
        409,
        "Une voix prédéfinie ne peut pas être supprimée.",
      );
    }
    // Registre d'abord, fichier ensuite → au pire un WAV orphelin (inoffensif),
    // jamais une entrée pointant vers un fichier absent.
    voices.splice(index, 1);
    this.write(voices);
    const target = voice.refAudio
      ? resolveWithin(this.dir, voice.refAudio)
      : null;
    if (target) {
      try {
        unlinkSync(target);
      } catch {
        // Meilleur effort.
      }
    }
    return voice;
  }

  /** Somme des octets des WAV des voix clonées déjà enregistrées. */
  private clonedBytes(cloned: Voice[]): number {
    let total = 0;
    for (const voice of cloned) {
      if (!voice.refAudio) continue;
      const path = resolveWithin(this.dir, voice.refAudio);
      if (!path || !existsSync(path)) continue;
      try {
        total += readFileSync(path).byteLength;
      } catch {
        // Fichier illisible : on ne compte pas (best effort).
      }
    }
    return total;
  }
}

/** Un identifiant de voix est un slug : `[a-z0-9-]{1,40}`. */
export function isValidVoiceId(id: string): boolean {
  return /^[a-z0-9-]{1,40}$/.test(id);
}

/** Id unique : suffixe aléatoire court en cas de collision. */
function uniqueVoiceId(base: string, existing: Voice[]): string {
  const taken = new Set(existing.map((voice) => voice.id));
  if (!taken.has(base)) return base;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = `${base.slice(0, 35)}-${randomBytes(2).toString("hex")}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base.slice(0, 30)}-${randomBytes(4).toString("hex")}`;
}
