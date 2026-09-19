/**
 * Test de frontière renforcé (Lot 2) — 3 invariants.
 *
 * 1. Tout import `@earendil-works/...` doit être dans une ALLOWLIST explicite.
 * 2. Aucun fichier de `src/llm/**`, `src/jobs/**`, `src/delegation/**`
 *    n'importe `@earendil-works/...` NI `typebox`.
 * 3. Aucun fichier hors `src/pi/**` n'importe depuis `src/pi/sdk/**`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

const SRC_DIR = join(process.cwd(), "src");

/** Allowlist explicite des fichiers pouvant importer le SDK Pi. */
const SDK_ALLOWLIST = [
  "src/pi/sdk-host.ts",
  "src/pi/sdk/model-runtime.ts",
  "src/pi/sdk/session-factory.ts",
  "src/pi/sdk/heavy-worker.ts",
  "src/pi/sdk/delegate-tools.ts",
].map((path) => path.split("/").join(sep));

const SDK_IMPORT =
  /(?:\bimport\b|\bexport\b)[^;]*?\bfrom\s*["']@earendil-works\/[^"']+["']|\bimport\s*\(\s*["']@earendil-works\/[^"']+["']\s*\)/;

const TYPEBOX_IMPORT =
  /(?:\bimport\b|\bexport\b)[^;]*?\bfrom\s*["']typebox["']|\bimport\s*\(\s*["']typebox["']\s*\)/;

const PI_SDK_IMPORT = /\bfrom\s*["'][^"']*pi\/sdk[^"']*["']/;

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

function rel(file: string): string {
  return relative(process.cwd(), file).split(sep).join("/");
}

function isUnder(file: string, domain: string): boolean {
  return rel(file).startsWith(`src/${domain}/`);
}

describe("frontière SDK Pi", () => {
  const files = listTsFiles(SRC_DIR);
  const allowlistAbs = new Set(
    SDK_ALLOWLIST.map((relativePath) => join(process.cwd(), relativePath)),
  );

  it("invariant 1 — tout import SDK est dans l'allowlist explicite", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (allowlistAbs.has(file)) continue;
      if (SDK_IMPORT.test(readFileSync(file, "utf8"))) {
        offenders.push(rel(file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("invariant 1 — chaque fichier de l'allowlist importe bien le SDK", () => {
    for (const relativePath of SDK_ALLOWLIST) {
      const abs = join(process.cwd(), relativePath);
      expect(SDK_IMPORT.test(readFileSync(abs, "utf8"))).toBe(true);
    }
  });

  it("invariant 2 — llm/jobs/delegation n'importent ni SDK ni typebox", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (
        !isUnder(file, "llm") &&
        !isUnder(file, "jobs") &&
        !isUnder(file, "delegation")
      ) {
        continue;
      }
      const content = readFileSync(file, "utf8");
      if (SDK_IMPORT.test(content) || TYPEBOX_IMPORT.test(content)) {
        offenders.push(rel(file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("invariant 2 bis — src/config n'importe ni SDK ni typebox", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (!isUnder(file, "config")) continue;
      const content = readFileSync(file, "utf8");
      if (SDK_IMPORT.test(content) || TYPEBOX_IMPORT.test(content)) {
        offenders.push(rel(file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("invariant 3 — rien hors src/pi n'importe depuis src/pi/sdk", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const relativePath = rel(file);
      if (relativePath.startsWith("src/pi/")) continue;
      if (PI_SDK_IMPORT.test(readFileSync(file, "utf8"))) {
        offenders.push(relativePath);
      }
    }
    expect(offenders).toEqual([]);
  });
});
