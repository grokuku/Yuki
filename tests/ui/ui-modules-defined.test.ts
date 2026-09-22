/**
 * Garde-fou STATIQUE — les modules ES de l'UI (`public/ui/*.js`) ne doivent
 * référencer AUCUN symbole utilisé-mais-non-défini.
 *
 * Pourquoi ce test existe : `tsconfig.test.json` active `allowJs` mais PAS
 * `checkJs`, donc le typecheck n'émet aucun diagnostic SUR le JS. Une erreur
 * comme « `ENGINE_FORCE_OFFLINE_FAMILIES` utilisé sans être importé » passe
 * alors inaperçue jusqu'à l'exécution navigateur (elle a réellement eu lieu,
 * corrigée dans `public/ui/tts-assistant.js:30`). Ce test rejoue le compilateur
 * TypeScript en `checkJs` sur tous les JS de `public/ui/` et échoue si un
 * symbole n'est pas résolu (`TS2304`/`TS2552`) ou si un import ne l'est pas
 * (`TS2305`/`TS2307`/`TS2459`).
 *
 * Le second `it` est un AUTO-TEST du détecteur : il prouve qu'un symbole
 * réellement non défini est bien signalé, sinon le premier test pourrait être
 * silencieusement inopérant.
 */

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";

const UI_DIR = join(process.cwd(), "public", "ui");

/** Codes qui traduisent un nom/import NON résolu (le cœur de ce garde-fou). */
const NAME_RESOLUTION_CODES = new Set([2304, 2552, 2305, 2307, 2459]);

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function uiModuleFiles(): string[] {
  return readdirSync(UI_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => join(UI_DIR, entry.name))
    .sort();
}

/** Diagnostics de résolution de noms pour un lot de fichiers racines. */
function unresolvedNameDiagnostics(rootFiles: string[]): ts.Diagnostic[] {
  const program = ts.createProgram(rootFiles, {
    allowJs: true,
    checkJs: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    lib: ["lib.es2023.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
    strict: false,
    skipLibCheck: true,
    noUnusedLocals: false,
    noUnusedParameters: false,
    types: [],
  });
  return ts.getPreEmitDiagnostics(program).filter((d) => NAME_RESOLUTION_CODES.has(d.code));
}

function formatDiagnostic(diagnostic: ts.Diagnostic): string {
  const position =
    diagnostic.file && diagnostic.start !== undefined
      ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
      : null;
  const where = position
    ? `${diagnostic.file!.fileName}:${position.line + 1}:${position.character + 1}`
    : "";
  return `TS${diagnostic.code} ${where} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`.trim();
}

describe("modules ES de l'UI — symboles définis et imports résolus", () => {
  it("aucun symbole/import non résolu dans public/ui/*.js", () => {
    const files = uiModuleFiles();
    // Le lot n'a de sens que s'il inspecte réellement plusieurs modules.
    expect(files.length).toBeGreaterThan(5);
    const found = unresolvedNameDiagnostics(files).map(formatDiagnostic);
    expect(found).toEqual([]);
  });

  it("le détecteur signale bien un symbole réellement non défini (auto-test)", () => {
    const dir = mkdtempSync(join(tmpdir(), "yuki-ui-symbols-"));
    tempDirs.push(dir);
    const file = join(dir, "buggy-module.js");
    writeFileSync(
      file,
      "export function read() { return SYMBOLE_QUI_N_EXISTE_PAS; }\n",
    );
    const found = unresolvedNameDiagnostics([file]);
    expect(found.some((d) => d.code === 2304)).toBe(true);
  });
});
