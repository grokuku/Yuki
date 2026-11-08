/**
 * AVATAR de Yuki — stockage PERSISTANT, hors du magasin de fichiers.
 *
 * ⚠️ L'avatar n'est PAS un fichier échangé : le magasin `src/files/` applique
 * une rétention (30 jours par défaut) avec purge RÉELLE. Une image de marque
 * qui disparaît au bout d'un mois serait un défaut, pas une fonctionnalité.
 * L'avatar vit donc dans `state/avatar/` et ne connaît AUCUNE expiration :
 *
 *   state/avatar/avatar.png   (ou .jpg / .webp selon le format déposé)
 *   state/avatar/avatar.json  { sha256, bytes, updatedAt, largeur, hauteur, mime, fichier }
 *
 * Les deux écritures sont ATOMIQUES (fichier temporaire + `rename`, mode 0600)
 * et l'image est écrite AVANT les métadonnées : une coupure entre les deux
 * laisse une image orpheline, jamais des métadonnées qui mentent.
 *
 * ⚠️ Le format est déduit de la SIGNATURE BINAIRE (jamais du `Content-Type`
 * déclaré) : un `.txt` renommé `.png` est refusé. Les dimensions sont lues
 * dans l'en-tête du fichier et bornées (`AVATAR_MAX_DIMENSION`).
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** Corps maximal accepté pour un avatar (2 Mio). */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
/** Dimension maximale acceptée (côté le plus long). */
export const AVATAR_MAX_DIMENSION = 4096;

export type AvatarFormat = "png" | "jpeg" | "webp";

export interface AvatarImage {
  format: AvatarFormat;
  mime: string;
  largeur: number;
  hauteur: number;
}

export interface AvatarMeta {
  sha256: string;
  bytes: number;
  updatedAt: string;
  largeur: number;
  hauteur: number;
  mime: string;
  /** Nom du fichier image dans le dossier (jamais un chemin). */
  fichier: string;
}

/** Vue publique servie par `GET /api/avatar`. */
export interface AvatarStatus {
  existe: boolean;
  sha256?: string;
  updatedAt?: string;
  taille?: number;
  largeur?: number;
  hauteur?: number;
  mime?: string;
}

/** Refus explicite d'un dépôt (code stable + message actionnable). */
export class AvatarRefusal extends Error {
  override readonly name = "AvatarRefusal";
  constructor(
    readonly code: "too_large" | "unsupported_format" | "too_large_dimensions" | "truncated",
    message: string,
  ) {
    super(message);
  }
}

const SIGNAUX: Record<AvatarFormat, { mime: string; extension: string }> = {
  png: { mime: "image/png", extension: "png" },
  jpeg: { mime: "image/jpeg", extension: "jpg" },
  webp: { mime: "image/webp", extension: "webp" },
};

function u16be(bytes: Buffer, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function u16le(bytes: Buffer, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function u24le(bytes: Buffer, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function u32be(bytes: Buffer, offset: number): number {
  return (
    (bytes[offset]! * 0x1000000) +
    ((bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!)
  );
}

/** Dimensions d'un PNG (signature + IHDR). `null` si tronqué/incohérent. */
function dimensionsPng(bytes: Buffer): { largeur: number; hauteur: number } | null {
  if (bytes.length < 24) return null;
  if (bytes.toString("latin1", 12, 16) !== "IHDR") return null;
  return { largeur: u32be(bytes, 16), hauteur: u32be(bytes, 20) };
}

/** Dimensions d'un JPEG : parcours des segments jusqu'au SOF. */
function dimensionsJpeg(bytes: Buffer): { largeur: number; hauteur: number } | null {
  let offset = 2; // après SOI (FF D8)
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marqueur = bytes[offset + 1]!;
    // Remplissage (FF FF …) et marqueurs sans longueur.
    if (marqueur === 0xff) {
      offset += 1;
      continue;
    }
    if (marqueur === 0xd8 || marqueur === 0x01 || (marqueur >= 0xd0 && marqueur <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marqueur === 0xd9 || marqueur === 0xda) return null; // fin / début des données
    const longueur = u16be(bytes, offset + 2);
    if (longueur < 2 || offset + 2 + longueur > bytes.length) return null;
    const estSof =
      (marqueur >= 0xc0 && marqueur <= 0xc3) ||
      (marqueur >= 0xc5 && marqueur <= 0xc7) ||
      (marqueur >= 0xc9 && marqueur <= 0xcb) ||
      (marqueur >= 0xcd && marqueur <= 0xcf);
    if (estSof) {
      if (longueur < 7) return null;
      return { hauteur: u16be(bytes, offset + 5), largeur: u16be(bytes, offset + 7) };
    }
    offset += 2 + longueur;
  }
  return null;
}

/** Dimensions d'un WebP : VP8 (lossy), VP8L (lossless) ou VP8X (étendu). */
function dimensionsWebp(bytes: Buffer): { largeur: number; hauteur: number } | null {
  if (bytes.length < 30) return null;
  const type = bytes.toString("latin1", 12, 16);
  if (type === "VP8 ") {
    // Signature 9D 01 2A à +3, puis largeur/hauteur 14 bits Little Endian.
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return { largeur: u16le(bytes, 26) & 0x3fff, hauteur: u16le(bytes, 28) & 0x3fff };
  }
  if (type === "VP8L") {
    if (bytes[20] !== 0x2f) return null;
    const bits = u32le(bytes, 21);
    return {
      largeur: (bits & 0x3fff) + 1,
      hauteur: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  if (type === "VP8X") {
    return { largeur: u24le(bytes, 24) + 1, hauteur: u24le(bytes, 27) + 1 };
  }
  return null;
}

function u32le(bytes: Buffer, offset: number): number {
  return (
    bytes[offset]! |
    (bytes[offset + 1]! << 8) |
    (bytes[offset + 2]! << 16) |
    (bytes[offset + 3]! << 24)
  ) >>> 0;
}

/**
 * Détecte le format RÉEL à partir des octets, puis lit les dimensions.
 * Renvoie `null` si la signature est inconnue ou le fichier inexploitable.
 */
export function detecterImage(bytes: Buffer): AvatarImage | null {
  if (bytes.length < 12) return null;
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    const dimensions = dimensionsPng(bytes);
    if (!dimensions) return null;
    return { format: "png", mime: SIGNAUX.png.mime, ...dimensions };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    const dimensions = dimensionsJpeg(bytes);
    if (!dimensions) return null;
    return { format: "jpeg", mime: SIGNAUX.jpeg.mime, ...dimensions };
  }
  if (
    bytes.toString("latin1", 0, 4) === "RIFF" &&
    bytes.toString("latin1", 8, 12) === "WEBP"
  ) {
    const dimensions = dimensionsWebp(bytes);
    if (!dimensions) return null;
    return { format: "webp", mime: SIGNAUX.webp.mime, ...dimensions };
  }
  return null;
}

/** Écriture ATOMIQUE (temp + rename) en 0600 — même convention que le reste. */
function ecrireAtomique(path: string, data: Buffer, mode = 0o600): void {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
  writeFileSync(tmp, data, { mode });
  renameSync(tmp, path);
  chmodSync(path, mode);
}

function fichierImage(format: AvatarFormat): string {
  return `avatar.${SIGNAUX[format].extension}`;
}

/** Parse et VALIDE les métadonnées relues du disque (jamais une confiance aveugle). */
function parseMeta(raw: string): AvatarMeta | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const value = parsed as Record<string, unknown>;
  const sha256 = value.sha256;
  const bytes = value.bytes;
  const updatedAt = value.updatedAt;
  const largeur = value.largeur;
  const hauteur = value.hauteur;
  const mime = value.mime;
  const fichier = value.fichier;
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes <= 0) return null;
  if (typeof updatedAt !== "string" || updatedAt === "") return null;
  if (typeof largeur !== "number" || !Number.isInteger(largeur) || largeur <= 0) return null;
  if (typeof hauteur !== "number" || !Number.isInteger(hauteur) || hauteur <= 0) return null;
  if (typeof mime !== "string" || !/^image\/(png|jpeg|webp)$/.test(mime)) return null;
  if (typeof fichier !== "string" || !/^avatar\.(png|jpg|webp)$/.test(fichier)) return null;
  return { sha256, bytes, updatedAt, largeur, hauteur, mime, fichier };
}

/** Empreinte SHA-256 en hexadécimal minuscule (sert aussi de jeton de cache). */
export function empreinte(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Version courte de l'empreinte (invalidation de cache côté navigateur). */
export function versionCourte(sha256: string): string {
  return sha256.slice(0, 12);
}

export interface AvatarStoreOptions {
  /** Dossier de persistance (volume `state`, ex. `/data/state/avatar`). */
  dir: string;
  /** Horloge injectable (tests). */
  now?: () => number;
}

/** Port utilisé par les routes (double de test possible sans disque). */
export interface AvatarStorePort {
  lire(): AvatarMeta | null;
  octets(): Buffer | null;
  ecrire(bytes: Buffer): AvatarMeta;
  supprimer(): boolean;
  statut(): AvatarStatus;
}

export class AvatarStore implements AvatarStorePort {
  private readonly dir: string;
  private readonly now: () => number;

  constructor(options: AvatarStoreOptions) {
    this.dir = options.dir;
    this.now = options.now ?? Date.now;
  }

  /** Chemin du fichier de métadonnées (utile aux tests et au diagnostic). */
  get metaPath(): string {
    return join(this.dir, "avatar.json");
  }

  /** Métadonnées courantes, ou `null` s'il n'y a aucun avatar lisible. */
  lire(): AvatarMeta | null {
    let raw: string;
    try {
      if (!existsSync(this.metaPath)) return null;
      raw = readFileSync(this.metaPath, "utf8");
    } catch {
      return null;
    }
    const meta = parseMeta(raw);
    if (!meta) return null;
    // Les métadonnées ne valent que si l'image qu'elles décrivent est là.
    try {
      const info = statSync(join(this.dir, meta.fichier));
      if (!info.isFile() || info.size !== meta.bytes) return null;
    } catch {
      return null;
    }
    return meta;
  }

  /** Octets de l'avatar, ou `null` s'il n'y en a pas. */
  octets(): Buffer | null {
    const meta = this.lire();
    if (!meta) return null;
    try {
      return readFileSync(join(this.dir, meta.fichier));
    } catch {
      return null;
    }
  }

  /**
   * Dépose un avatar. Le format vient des OCTETS (signature), les bornes sont
   * vérifiées AVANT la moindre écriture : un refus ne touche pas l'avatar
   * déjà en place.
   */
  ecrire(bytes: Buffer): AvatarMeta {
    if (bytes.byteLength === 0) {
      throw new AvatarRefusal("truncated", "Le corps de la requête est vide (0 octet).");
    }
    if (bytes.byteLength > AVATAR_MAX_BYTES) {
      throw new AvatarRefusal(
        "too_large",
        `Image refusée : ${bytes.byteLength} octets reçus, plafond de ${AVATAR_MAX_BYTES} octets.`,
      );
    }
    const image = detecterImage(bytes);
    if (!image) {
      throw new AvatarRefusal(
        "unsupported_format",
        "Image refusée : le contenu n'est pas un PNG, JPEG ou WebP valide " +
          "(le type est vérifié sur les octets, pas sur le Content-Type déclaré).",
      );
    }
    if (image.largeur > AVATAR_MAX_DIMENSION || image.hauteur > AVATAR_MAX_DIMENSION) {
      throw new AvatarRefusal(
        "too_large_dimensions",
        `Image refusée : ${image.largeur}×${image.hauteur} px, plafond de ` +
          `${AVATAR_MAX_DIMENSION}×${AVATAR_MAX_DIMENSION} px.`,
      );
    }
    if (image.largeur <= 0 || image.hauteur <= 0) {
      throw new AvatarRefusal("truncated", "Image refusée : dimensions illisibles.");
    }

    mkdirSync(this.dir, { recursive: true });
    const fichier = fichierImage(image.format);
    const meta: AvatarMeta = {
      sha256: empreinte(bytes),
      bytes: bytes.byteLength,
      updatedAt: new Date(this.now()).toISOString(),
      largeur: image.largeur,
      hauteur: image.hauteur,
      mime: image.mime,
      fichier,
    };
    // ⚠️ Image d'abord, métadonnées ensuite : une coupure laisse une image
    // orpheline (ignorée), jamais des métadonnées qui mentent.
    ecrireAtomique(join(this.dir, fichier), bytes);
    ecrireAtomique(
      this.metaPath,
      Buffer.from(`${JSON.stringify(meta, null, 2)}\n`, "utf8"),
    );
    // Un ancien format ne doit pas rester à côté (sinon deux images cohabitent).
    for (const format of Object.keys(SIGNAUX) as AvatarFormat[]) {
      const autre = fichierImage(format);
      if (autre === fichier) continue;
      try {
        rmSync(join(this.dir, autre), { force: true });
      } catch {
        /* ignoré : un reliquat ne gêne pas la lecture (pilotée par les métadonnées) */
      }
    }
    return meta;
  }

  /** Retire l'avatar (image + métadonnées). Vrai si quelque chose a été retiré. */
  supprimer(): boolean {
    const meta = this.lire();
    let retire = false;
    if (meta) {
      try {
        rmSync(join(this.dir, meta.fichier), { force: true });
        retire = true;
      } catch {
        /* ignoré : on tente quand même la suppression des métadonnées */
      }
    }
    try {
      if (existsSync(this.metaPath)) {
        rmSync(this.metaPath, { force: true });
        retire = true;
      }
    } catch {
      /* ignoré */
    }
    // Nettoyage des reliquats d'anciens formats, même sans métadonnées lisibles.
    for (const format of Object.keys(SIGNAUX) as AvatarFormat[]) {
      try {
        const chemin = join(this.dir, fichierImage(format));
        if (existsSync(chemin)) {
          rmSync(chemin, { force: true });
          retire = true;
        }
      } catch {
        /* ignoré */
      }
    }
    return retire;
  }

  /** Vue publique (aucun chemin de fichier exposé). */
  statut(): AvatarStatus {
    const meta = this.lire();
    if (!meta) return { existe: false };
    return {
      existe: true,
      sha256: meta.sha256,
      updatedAt: meta.updatedAt,
      taille: meta.bytes,
      largeur: meta.largeur,
      hauteur: meta.hauteur,
      mime: meta.mime,
    };
  }
}
