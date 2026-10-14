#!/usr/bin/env node
/**
 * Générateur des icônes PWA de Yuki (aucune dépendance : `node:zlib`).
 *
 * Produit des PNG carrés : fond sombre arrondi + flocon stylisé. Les icônes
 * « maskable » couvrent tout le carré (Android rogne selon sa forme) ; les
 * icônes « any » portent des coins arrondis.
 *
 * Usage : node scripts/make-pwa-icons.mjs
 * Sortie : public/ui/icons/{icon-192,icon-512,icon-maskable-512}.png
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "ui", "icons");

const BG = [14, 17, 22];
const FG = [196, 220, 255];

/** Table CRC32 (PNG). */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filtre « none »
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8 bits/canal
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Distance d'un point au segment [a,b]. */
function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** Distance signée à un rectangle arrondi centré (négative à l'intérieur). */
function roundedRectDistance(x, y, half, radius) {
  const qx = Math.abs(x) - (half - radius);
  const qy = Math.abs(y) - (half - radius);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - radius;
}

const SPOKES = [0, 60, 120, 180, 240, 300].map((deg) => (deg * Math.PI) / 180);

/** Rendu RGBA d'une icône carrée, avec supersampling pour l'anticrénelage. */
function renderIcon(size, { maskable }) {
  const SS = 3; // facteur de supersampling
  const S = size * SS;
  const half = S / 2;
  const radius = maskable ? 0 : S * 0.22;
  const snowRadius = S * (maskable ? 0.3 : 0.33);
  const halfWidth = S * (maskable ? 0.024 : 0.027);
  const branchLength = snowRadius * 0.24;

  const out = Buffer.alloc(size * size * 4);
  const samples = SS * SS;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let accR = 0;
      let accG = 0;
      let accB = 0;
      let accA = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const px = x * SS + sx + 0.5;
          const py = y * SS + sy + 0.5;
          let r;
          let g;
          let b;
          let a = 0;
          const inside = roundedRectDistance(px - half, py - half, half, radius) <= 0;
          if (inside) {
            r = BG[0];
            g = BG[1];
            b = BG[2];
            a = 255;
            // Flocon : segments depuis le centre + petites branches.
            let onFlake = false;
            for (const angle of SPOKES) {
              const ex = half + Math.cos(angle) * snowRadius;
              const ey = half + Math.sin(angle) * snowRadius;
              if (distanceToSegment(px, py, half, half, ex, ey) <= halfWidth) {
                onFlake = true;
                break;
              }
              for (const sign of [-1, 1]) {
                for (const at of [0.58, 0.82]) {
                  const bx = half + Math.cos(angle) * snowRadius * at;
                  const by = half + Math.sin(angle) * snowRadius * at;
                  const ba = angle + (sign * Math.PI) / 3;
                  const tx = bx + Math.cos(ba) * branchLength;
                  const ty = by + Math.sin(ba) * branchLength;
                  if (distanceToSegment(px, py, bx, by, tx, ty) <= halfWidth * 0.85) {
                    onFlake = true;
                    break;
                  }
                }
                if (onFlake) break;
              }
              if (onFlake) break;
            }
            if (onFlake) {
              r = FG[0];
              g = FG[1];
              b = FG[2];
            }
          } else {
            r = 0;
            g = 0;
            b = 0;
          }
          accR += r * a;
          accG += g * a;
          accB += b * a;
          accA += a;
        }
      }
      const alpha = accA / samples;
      const index = (y * size + x) * 4;
      if (accA === 0) {
        out[index] = 0;
        out[index + 1] = 0;
        out[index + 2] = 0;
        out[index + 3] = 0;
      } else {
        out[index] = Math.round(accR / accA);
        out[index + 1] = Math.round(accG / accA);
        out[index + 2] = Math.round(accB / accA);
        out[index + 3] = Math.round(alpha);
      }
    }
  }
  return encodePng(size, size, out);
}

mkdirSync(OUT_DIR, { recursive: true });
const files = [
  ["icon-192.png", 192, { maskable: false }],
  ["icon-512.png", 512, { maskable: false }],
  ["icon-maskable-512.png", 512, { maskable: true }],
];
for (const [name, size, opts] of files) {
  const png = renderIcon(size, opts);
  writeFileSync(join(OUT_DIR, name), png);
  console.log(`${name} — ${size}x${size} — ${png.length} octets`);
}
