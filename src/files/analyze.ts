/**
 * ANALYSE d'un fichier envoyé — faite UNE fois, puis CONSERVÉE avec le fichier
 * (pour ne pas la refaire à chaque tour, et pour qu'elle disparaisse avec lui).
 *
 * ⚠️ HONNÊTETÉ (PIÈGE ⑦) : on ne prétend JAMAIS avoir lu ce qu'on n'a pas lu.
 *  - `text`  : le texte est extrait et conservé (borné) ;
 *  - `image` : l'image n'a pas de TEXTE à extraire, mais elle est TRANSMISE AU
 *              MODÈLE EN TANT QU'IMAGE (`ImageContent`, voir
 *              `prepareImages` du service) → `readable: false` et une `reason`
 *              qui dit la vérité ;
 *  - `pdf`   : le libraire (Libry) n'expose AUCUNE route d'extraction de texte
 *              PDF (vérifié : `/status`, `/search`, `/library`, `/doc/:name`,
 *              `/archive`, `/screenshot`, `/shot/:id.png`) → `readable: false` ;
 *  - `unknown` : le fichier est stocké et téléchargeable, mais non lu.
 *
 * Zéro dépendance : détection par extension + premiers octets, décodages UTF-8
 * et UTF-16 fournis par Node, dimensions d'image lues dans les en-têtes binaires.
 *
 * ⚠️ ENCODAGE (PIÈGE ⑧) : un fichier UTF-16 contient un octet NUL sur deux. Lu
 * tel quel, il serait déclaré « binaire » alors que c'est du TEXTE (cas réel
 * d'un `…EvokoHome.msi.log` en UTF-16LE livré par un installeur Windows). Le
 * décodage est donc fait AVANT `looksBinary()`, et la détection binaire porte
 * ensuite sur le TEXTE DÉCODÉ — jamais sur les octets bruts. Le décodage ne
 * s'applique QU'À une déclaration textuelle (extension d'allowlist ou type MIME
 * texte) : un format inconnu garde ses octets bruts, donc un vrai binaire reste
 * refusé.
 *
 * ⚠️ Aucun extrait n'est journalisé : l'analyse ne sert qu'au disque (volume
 * `state`, même sort que la session) et au bloc transmis au modèle.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";

import {
  MAX_ANALYSIS_READ_BYTES,
  MAX_STORED_ANALYSIS_CHARS,
  type FileAnalysis,
  type FileKind,
} from "./types.js";

/** Extensions LISIBLES comme du texte (allowlist explicite). */
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  "txt", "text", "md", "markdown", "rst", "adoc", "org",
  "csv", "tsv", "json", "jsonl", "ndjson", "yaml", "yml", "toml", "ini", "cfg",
  "conf", "env", "properties", "log", "diff", "patch", "srt", "vtt", "geojson",
  "xml", "html", "htm", "xhtml", "svg", "css", "scss", "sass", "less",
  "js", "mjs", "cjs", "jsx", "ts", "tsx", "mts", "cts", "vue", "svelte", "astro",
  "py", "rb", "go", "rs", "java", "kt", "kts", "swift", "c", "h", "cc", "cpp",
  "hpp", "cs", "php", "pl", "lua", "r", "scala", "dart", "ex", "exs", "erl",
  "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd", "sql", "graphql", "gql",
  "dockerfile", "makefile", "gradle", "lock",
]);

/** Extensions d'IMAGE (affichables en same-origin : `img-src 'self'`). */
const IMAGE_MIME_BY_EXT: ReadonlyMap<string, string> = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["bmp", "image/bmp"],
]);

/** Types MIME d'IMAGE servis INLINE (jamais SVG : script embarqué). */
export const INLINE_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set(
  IMAGE_MIME_BY_EXT.values(),
);

/**
 * Types d'image qu'un modèle de VISION accepte (formats des fournisseurs
 * compatibles OpenAI). Un BMP est affichable mais PAS transmissible : on le
 * refuse explicitement plutôt que d'envoyer une partie que le fournisseur
 * rejetterait par une erreur opaque.
 */
export const MODEL_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** Déclaration MIME → type de contenu normalisé (jamais un type inventé). */
const MIME_BY_EXT: Readonly<Record<string, string>> = {
  txt: "text/plain", text: "text/plain", md: "text/markdown", markdown: "text/markdown",
  csv: "text/csv", tsv: "text/tab-separated-values", json: "application/json",
  jsonl: "application/x-ndjson", ndjson: "application/x-ndjson",
  yaml: "application/yaml", yml: "application/yaml", toml: "application/toml",
  xml: "application/xml", html: "text/html", htm: "text/html",
  css: "text/css", js: "text/javascript", mjs: "text/javascript",
  ts: "text/x-typescript", py: "text/x-python", sh: "text/x-shellscript",
  pdf: "application/pdf", zip: "application/zip", gz: "application/gzip",
  tar: "application/x-tar", "7z": "application/x-7z-compressed",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  epub: "application/epub+zip",
};

/**
 * Type MIME normalisé : la déclaration du client est PRÉFÉRÉE quand elle est
 * exploitable ; sinon on déduit de l'extension ; sinon `application/octet-stream`.
 */
export function normalizeMimeType(raw: string | undefined, ext: string): string {
  const declared = (raw ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (declared !== "" && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(declared)) {
    // Un type générique déclaré ne doit pas masquer un type déductible.
    if (declared !== "application/octet-stream" && declared !== "binary/octet-stream") {
      return declared;
    }
  }
  const imageMime = IMAGE_MIME_BY_EXT.get(ext);
  if (imageMime) return imageMime;
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/**
 * Type MIME à ANNONCER au modèle pour une image du stockage — `undefined` si le
 * format n'est pas un format de vision (ex. BMP, ou un type déclaré fantaisiste
 * qui n'est pas une image).
 *
 * ⚠️ On se fie d'abord à l'EXTENSION (assainie par le stockage), pas au type
 * DÉCLARÉ par le client : un PNG annoncé `text/plain` resterait une image.
 */
export function modelImageMimeType(
  ext: string,
  declaredMime: string,
): string | undefined {
  const byExt = IMAGE_MIME_BY_EXT.get(ext);
  const declared = (declaredMime.split(";")[0] ?? "").trim().toLowerCase();
  const candidate = byExt ?? declared;
  return MODEL_IMAGE_MIME_TYPES.has(candidate) ? candidate : undefined;
}

/**
 * Déclaration TEXTUELLE d'un fichier : extension d'allowlist OU type MIME texte.
 *
 * ⚠️ Sert UNIQUEMENT de garde au décodage UTF-16 : on ne devine jamais
 * l'encodage d'un format inconnu (un `.xyz` binaire doit rester refusé).
 */
export function isTextDeclaration(ext: string, mimeType: string): boolean {
  if (TEXT_EXTENSIONS.has(ext)) return true;
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/xml" ||
    mimeType.endsWith("+json") ||
    mimeType.endsWith("+xml") ||
    mimeType === "text/x-typescript" ||
    mimeType === "text/x-python"
  );
}

/** Encodage retenu pour lire un fichier (aucun autre n'est supposé). */
export type TextEncoding = "utf8" | "utf16le" | "utf16be";

/** Échantillon décodé : texte + encodage détecté (jamais deviné au hasard). */
export interface DecodedSample {
  /** Texte décodé — l'encodage est déjà résolu. */
  text: string;
  encoding: TextEncoding;
}

/** Octets examinés pour reconnaître un UTF-16 SANS BOM (motif des NUL). */
const UTF16_SNIFF_BYTES = 4096;

/** Proportion minimale d'octets NUL en positions IMPAIRES (UTF-16LE sans BOM). */
const UTF16_SNIFF_ODD_NUL_MIN = 0.3;

/** Proportion maximale d'octets NUL en positions PAIRES (sinon : pas « net »). */
const UTF16_SNIFF_EVEN_NUL_MAX = 0.1;

/**
 * Motif « UTF-16LE sans BOM » : les octets NUL tombent sur les positions
 * IMPAIRES (fin du code unit), et quasiment jamais sur les positions paires.
 * Un binaire aléatoire n'offre pas ce motif (≈ 0,4 % de NUL) : il n'est donc pas
 * pris pour du texte.
 */
function looksUtf16LeWithoutBom(sample: Buffer): boolean {
  const limit = Math.min(sample.length, UTF16_SNIFF_BYTES);
  const pairs = Math.floor(limit / 2);
  if (pairs < 2) return false;
  let oddNul = 0;
  let evenNul = 0;
  for (let i = 0; i < pairs * 2; i += 2) {
    if (sample[i] === 0) evenNul += 1;
    if (sample[i + 1] === 0) oddNul += 1;
  }
  return (
    oddNul / pairs > UTF16_SNIFF_ODD_NUL_MIN &&
    evenNul / pairs < UTF16_SNIFF_EVEN_NUL_MAX
  );
}

/** Inverse chaque paire d'octets (UTF-16BE → UTF-16LE) ; l'octet impair final est ignoré. */
function swapBytePairs(bytes: Buffer): Buffer {
  const length = bytes.length - (bytes.length % 2);
  const swapped = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i += 2) {
    swapped[i] = bytes[i + 1] as number;
    swapped[i + 1] = bytes[i] as number;
  }
  return swapped;
}

/** Décode un tampon UTF-16 déjà ramené en little-endian, sans BOM. */
function decodeUtf16Le(bytes: Buffer): string {
  // `toString('utf16le')` ignore un éventuel octet impair final.
  const text = bytes.toString("utf16le");
  // Coupe de lecture au milieu d'une paire de substitution : on retire le
  // demi-caractère orphelin plutôt que de conserver un caractère invalide.
  const last = text.charCodeAt(text.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) return text.slice(0, -1);
  return text;
}

/**
 * Décode un échantillon d'octets en TEXTE, en résolvant l'encodage UTF-16.
 *
 * Règles (et RIEN de plus) :
 *  1. BOM `FF FE` → UTF-16LE ; BOM `FE FF` → UTF-16BE (swap puis `utf16le`) ;
 *  2. sans BOM, POUR UNE DÉCLARATION TEXTUELLE seulement : motif net de NUL en
 *     positions impaires (> 30 % sur les 4 premiers Ko) → UTF-16LE ;
 *  3. tout le reste → UTF-8, octets inchangés (c'est la détection binaire qui
 *     tranchera : un vrai binaire reste refusé).
 *
 * ⚠️ Appelé AVANT `looksBinary()` : le NUL de l'UTF-16 ne doit plus déclencher
 * le rejet. ⚠️ Le décodage n'est jamais tenté sur un format inconnu.
 */
export function decodeTextSample(
  sample: Buffer,
  options: { textual: boolean },
): DecodedSample {
  if (!options.textual) return { text: sample.toString("utf8"), encoding: "utf8" };
  if (sample.length >= 2 && sample[0] === 0xff && sample[1] === 0xfe) {
    return { text: decodeUtf16Le(sample.subarray(2)), encoding: "utf16le" };
  }
  if (sample.length >= 2 && sample[0] === 0xfe && sample[1] === 0xff) {
    return { text: decodeUtf16Le(swapBytePairs(sample.subarray(2))), encoding: "utf16be" };
  }
  if (looksUtf16LeWithoutBom(sample)) {
    return { text: decodeUtf16Le(sample), encoding: "utf16le" };
  }
  return { text: sample.toString("utf8"), encoding: "utf8" };
}

/** Lit les premiers octets d'un fichier (borné, jamais le fichier entier). */
function readHead(path: string, limit: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(Math.max(1, limit));
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/** `true` si les octets ressemblent à du BINAIRE (NUL, ou trop de contrôles). */
export function looksBinary(sample: Uint8Array): boolean {
  if (sample.length === 0) return false;
  let controls = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    // Contrôles hors tabulation / saut de ligne / retour chariot.
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) controls += 1;
  }
  return controls / sample.length > 0.1;
}

/**
 * Détection binaire sur le BON matériau : octets bruts tant qu'aucun décodage
 * n'a eu lieu, TEXTE DÉCODÉ dès qu'un UTF-16 a été résolu (sinon le NUL de
 * l'UTF-16 re-déclencherait le rejet).
 */
function isBinarySample(sample: Buffer, decoded: DecodedSample): boolean {
  if (decoded.encoding === "utf8") return looksBinary(sample);
  return looksBinary(Buffer.from(decoded.text, "utf8"));
}

/** Dimensions d'une image (lues dans les en-têtes, sans décodage). */
export function imageSize(
  head: Buffer,
): { width: number; height: number } | undefined {
  // PNG : signature + IHDR (largeur/hauteur big-endian).
  if (
    head.length >= 24 &&
    head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47
  ) {
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  }
  // GIF : écran logique (little-endian).
  if (head.length >= 10 && head.subarray(0, 3).toString("latin1") === "GIF") {
    return { width: head.readUInt16LE(6), height: head.readUInt16LE(8) };
  }
  // BMP : BITMAPINFOHEADER.
  if (head.length >= 26 && head[0] === 0x42 && head[1] === 0x4d) {
    return { width: head.readInt32LE(18), height: Math.abs(head.readInt32LE(22)) };
  }
  // WebP : VP8X (étendu), VP8L (sans perte), VP8 (avec perte).
  if (
    head.length >= 30 &&
    head.subarray(0, 4).toString("latin1") === "RIFF" &&
    head.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    const chunk = head.subarray(12, 16).toString("latin1");
    if (chunk === "VP8X") {
      const width = 1 + (head[24] | (head[25] << 8) | (head[26] << 16));
      const height = 1 + (head[27] | (head[28] << 8) | (head[29] << 16));
      return { width, height };
    }
    if (chunk === "VP8L" && head.length >= 25) {
      const bits = head.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8 " && head.length >= 30) {
      return {
        width: head.readUInt16LE(26) & 0x3fff,
        height: head.readUInt16LE(28) & 0x3fff,
      };
    }
  }
  // JPEG : parcours des segments jusqu'à un marqueur SOF.
  if (head.length >= 4 && head[0] === 0xff && head[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < head.length) {
      if (head[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = head[offset + 1] ?? 0;
      const length = head.readUInt16BE(offset + 2);
      const isFrame =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isFrame) {
        return {
          height: head.readUInt16BE(offset + 5),
          width: head.readUInt16BE(offset + 7),
        };
      }
      if (length <= 0) break;
      offset += 2 + length;
    }
  }
  return undefined;
}

/** Raisons HONNÊTES (phrases, jamais un code) des fichiers non lisibles. */
export const UNREADABLE_REASONS = {
  pdf:
    "Le libraire (Libry) n'expose aucune route d'extraction de texte PDF : " +
    "Yuki ne sait pas lire ce PDF. Le fichier est conservé et téléchargeable.",
  image:
    "Image jointe au message et transmise AU MODÈLE en tant qu'image : elle est " +
    "vue directement, aucun texte n'en est extrait.",
  binary:
    "Contenu binaire : rien n'en est lu (le fichier est conservé et " +
    "téléchargeable).",
  unknown:
    "Format non pris en charge par la lecture de Yuki : le fichier est conservé et " +
    "téléchargeable, mais son contenu n'est pas lu.",
} as const;

/**
 * Détermine le GENRE d'un fichier (extension + premiers octets). Aucune
 * promesse au-delà de ce qui est vérifiable.
 */
export function classifyFile(input: {
  ext: string;
  mimeType: string;
  head: Buffer;
}): FileKind {
  const { ext, mimeType, head } = input;
  if (ext === "pdf" || mimeType === "application/pdf") return "pdf";
  if (IMAGE_MIME_BY_EXT.has(ext) || INLINE_IMAGE_MIME_TYPES.has(mimeType)) {
    return "image";
  }
  // SVG est du texte (jamais servi inline) : il suit la branche texte.
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  if (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/xml" ||
    mimeType.endsWith("+json") ||
    mimeType.endsWith("+xml") ||
    mimeType === "text/x-typescript" ||
    mimeType === "text/x-python"
  ) {
    return "text";
  }
  // Format inconnu : on ne DEVINE pas un lecteur. Un contenu manifestement
  // textuel reste lisible (c'est le cas courant d'un `.log` ou d'un `.xyz`).
  if (head.length > 0 && !looksBinary(head)) return "text";
  return "unknown";
}

/** Résultat d'analyse : fiche + texte extrait (à conserver à part). */
export interface AnalysisOutcome {
  analysis: FileAnalysis;
  /** Texte extrait (déjà borné), absent pour un fichier non lisible. */
  text?: string;
}

/**
 * Analyse un fichier DÉJÀ écrit sur disque.
 *
 * @param path chemin absolu du fichier stocké.
 * @param input nom/type/ext + borne de caractères conservés.
 */
export function analyzeStoredFile(
  path: string,
  input: {
    name: string;
    ext: string;
    mimeType: string;
    /** Borne de caractères conservés (défaut `MAX_STORED_ANALYSIS_CHARS`). */
    maxChars?: number;
  },
): AnalysisOutcome {
  const maxChars = Math.max(1, Math.trunc(input.maxChars ?? MAX_STORED_ANALYSIS_CHARS));
  const textual = isTextDeclaration(input.ext, input.mimeType);
  const head = readHead(path, Math.min(MAX_ANALYSIS_READ_BYTES, 4096));
  // ⚠️ Le CLASSEMENT se fait sur le texte DÉCODÉ : un `.log` UTF-16 est du texte.
  const decodedHead = decodeTextSample(head, { textual });
  const kind = classifyFile({
    ext: input.ext,
    mimeType: input.mimeType,
    head: decodedHead.encoding === "utf8" ? head : Buffer.from(decodedHead.text, "utf8"),
  });

  if (kind === "pdf") {
    return { analysis: { kind, readable: false, reason: UNREADABLE_REASONS.pdf } };
  }
  if (kind === "image") {
    const size = imageSize(readHead(path, 65_536));
    return {
      analysis: {
        kind,
        readable: false,
        reason: UNREADABLE_REASONS.image,
        ...(size && size.width > 0 && size.height > 0
          ? { width: size.width, height: size.height }
          : {}),
      },
    };
  }
  if (kind === "unknown") {
    return { analysis: { kind, readable: false, reason: UNREADABLE_REASONS.unknown } };
  }

  // Texte : on lit BORNÉ (jamais le fichier entier, il peut être énorme).
  const total = statSync(path).size;
  const readBytes = Math.min(total, MAX_ANALYSIS_READ_BYTES);
  const raw = readHead(path, readBytes);
  const decodedSample = decodeTextSample(raw, { textual });
  // ⚠️ Détection binaire sur le TEXTE DÉCODÉ (le NUL de l'UTF-16 a disparu) :
  // un vrai binaire, lui, garde ses contrôles et reste refusé.
  if (isBinarySample(raw, decodedSample)) {
    return { analysis: { kind, readable: false, reason: UNREADABLE_REASONS.binary, readBytes } };
  }
  const decoded = decodedSample.text;
  const truncated = decoded.length > maxChars || readBytes < total;
  const text = decoded.slice(0, maxChars);
  return {
    analysis: {
      kind: "text",
      readable: true,
      chars: text.length,
      truncated,
      readBytes,
    },
    text,
  };
}
