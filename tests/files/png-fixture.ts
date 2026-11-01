/**
 * Générateur de PNG RÉELS pour les tests — AUCUNE dépendance.
 *
 * ⚠️ Pourquoi : prouver qu'une image est réellement décodée, réduite puis
 * transmise demande de vrais octets PNG (un PNG bidon ne prouve rien). zlib est
 * fourni par Node, donc un encodeur minimal (IHDR/IDAT/IEND, RGB 8 bits, filtre
 * 0) suffit — et il est DÉTERMINISTE, ce qui rend les dimensions attendues
 * vérifiables.
 */

import { deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let c = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    c = CRC_TABLE[(c ^ buffer[i]!)! & 0xff]! ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Assemble un PNG truecolor 8 bits à partir de pixels RGB (sans alpha). */
function encodePng(width: number, height: number, pixels: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // profondeur 8 bits
  header[9] = 2; // truecolor RGB
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filtre « aucun »
    pixels.copy(raw, rowStart + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * PNG de BRUIT déterministe : compresse MAL (donc pèse lourd), ce qui permet de
 * franchir un plafond de poids avec une image de dimensions modestes.
 */
export function noisyPng(width: number, height: number, seed = 1): Buffer {
  const pixels = Buffer.alloc(width * height * 3);
  let state = seed >>> 0;
  for (let i = 0; i < pixels.length; i += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    pixels[i] = state >>> 24;
  }
  return encodePng(width, height, pixels);
}

/**
 * PNG de dégradé : compresse BIEN (donc léger) tout en restant une vraie image
 * décodable — utile pour franchir un plafond de DIMENSION sans plafond de poids.
 */
export function gradientPng(width: number, height: number): Buffer {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 3;
      pixels[index] = Math.floor((x * 255) / width);
      pixels[index + 1] = Math.floor((y * 255) / height);
      pixels[index + 2] = Math.floor(((x + y) * 127) / (width + height));
    }
  }
  return encodePng(width, height, pixels);
}

/**
 * PNG « capture d'écran détaillée » — reproduit une image RÉELLE de quelques Mo.
 *
 * ⚠️ Pourquoi un bruit par BLOCS 2×2 (et non par pixel) : une capture réelle garde
 * sa masse après sous-échantillonnage, alors qu'un bruit par pixel devient
 * incompressible après Lanczos (le PNG rééchantillonné grossit). C'est cette
 * propriété qui reproduit le cas de production : 2231×961 @ amplitude 8
 * ⇒ **3 120 Ko** au départ, dont le PNG rééchantillonné en 2000×861 pèse encore
 * ~2 400 Ko (mesuré) — donc un ré-encodage est indispensable.
 */
export function detailedScreenshotPng(width: number, height: number, amplitude = 8): Buffer {
  const pixels = Buffer.alloc(width * height * 3);
  let state = 31 >>> 0;
  for (let by = 0; by < height; by += 2) {
    for (let bx = 0; bx < width; bx += 2) {
      state = (state * 1664525 + 1013904223) >>> 0;
      const noise = (((state >>> 24) & 0xff) / 255) * amplitude - amplitude / 2;
      const yMax = Math.min(by + 2, height);
      const xMax = Math.min(bx + 2, width);
      for (let y = by; y < yMax; y += 1) {
        for (let x = bx; x < xMax; x += 1) {
          const index = (y * width + x) * 3;
          const r = 128 + 60 * Math.sin(x / 220) + 18 * Math.sin(y / 70);
          const g = 120 + 50 * Math.sin((x + y) / 260);
          const b = 140 + 45 * Math.cos(x / 160);
          pixels[index] = Math.min(255, Math.max(0, Math.round(r + noise)));
          pixels[index + 1] = Math.min(255, Math.max(0, Math.round(g + noise)));
          pixels[index + 2] = Math.min(255, Math.max(0, Math.round(b + noise)));
        }
      }
    }
  }
  return encodePng(width, height, pixels);
}
