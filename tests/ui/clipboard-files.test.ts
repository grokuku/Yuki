/**
 * FICHIERS COLLÉS (presse-papiers) — logique PURE, sans DOM.
 *
 * Le collage d'une capture d'écran ou d'un fichier copié arrive SANS nom dans
 * `clipboardData` : sans nom PORTEUR D'EXTENSION, le serveur classerait l'image
 * en « format inconnu » (ni aperçu, ni traitement) — c'est la raison d'être de
 * `namePastedFile`.
 *
 * Les interactions réelles (Ctrl+V dans le champ, puce d'attente, carte dans le
 * fil) sont prouvées par l'E2E `_tools/e2e-files.mjs` ; ici on épingle la logique
 * avec des objets injectés (aucun navigateur).
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  filesFromClipboard,
  namePastedFile,
} from "../../public/ui/clipboard-files.js";
import { DEFAULT_TIME_ZONE, setTimeZone } from "../../public/ui/horodatage.js";

/**
 * Instant FIGÉ, exprimé en UTC : `2026-10-29T15:04:06Z` ⇒ le nom doit porter
 * `20261029-150406` **quel que soit le fuseau du process**.
 *
 * ⚠️ ÉCRIT EN UTC ET NON `new Date(2026, 9, 29, 15, 4, 6)` : le constructeur à
 * composantes est LOCAL, donc l'ancien test passait sous n'importe quel `TZ` et
 * ne prouvait rien (il construisait l'instant avec le même fuseau que le code
 * fautif).
 */
const NOW = new Date("2026-10-29T15:04:06.000Z");

afterEach(() => {
  // Le fuseau est un état de MODULE de `horodatage.js` : on le remet au défaut.
  setTimeZone(DEFAULT_TIME_ZONE);
});

/** Faux fichier minimal (le module ne lit que `name`, `type`, `size`…). */
function fakeFile(name: string, type: string, size = 12): File {
  return new File([new Uint8Array(size)], name, { type });
}

/** Faux `DataTransfer` : seuls `items` et `files` sont lus. */
function fakeTransfer(items: any[] | undefined, files: File[] = []) {
  return { items, files };
}

describe("nom d'un fichier collé", () => {
  it("fabrique un nom DATÉ et accentué quand l'image n'a pas de nom", () => {
    // Un collage de capture d'écran : `File` au nom vide.
    expect(namePastedFile(fakeFile("", "image/png"), { now: NOW })).toBe(
      "collé-20261029-150406.png",
    );
  });

  it("déduit l'EXTENSION du type MIME (aucune invention)", () => {
    const cases = [
      ["image/png", "png"],
      ["image/jpeg", "jpg"],
      ["image/gif", "gif"],
      ["image/webp", "webp"],
      ["application/pdf", "pdf"],
      // Type muet ou exotique : repli honnête, jamais un faux « .png ».
      ["application/octet-stream", "bin"],
      ["", "bin"],
    ];
    for (const [type, ext] of cases) {
      expect(namePastedFile(fakeFile("", type), { now: NOW }), type).toBe(
        `collé-20261029-150406.${ext}`,
      );
    }
  });

  it("GARDE le nom d'origine quand il porte déjà une extension", () => {
    const file = fakeFile("photo de vacances.jpg", "image/jpeg");
    expect(namePastedFile(file, { now: NOW })).toBe("photo de vacances.jpg");
  });

  it("renomme un nom SANS extension (sinon le fichier serait « inconnu »)", () => {
    expect(namePastedFile(fakeFile("capture", "image/png"), { now: NOW })).toBe(
      "collé-20261029-150406.png",
    );
    expect(namePastedFile(fakeFile(".cache", "image/png"), { now: NOW })).toBe(
      "collé-20261029-150406.png",
    );
  });

  it("horodate en UTC sur deux chiffres (nom triable)", () => {
    // Instant fixe écrit en UTC : 03:04:05 UTC, jamais « 03:04:05 local ».
    const tôt = new Date("2026-01-02T03:04:05.000Z");
    expect(namePastedFile(fakeFile("", "image/png"), { now: tôt })).toBe(
      "collé-20260102-030405.png",
    );
    // Un instant invalide ne produit pas « collé-NaN… ».
    expect(namePastedFile(fakeFile("", "image/png"), { now: Number.NaN })).toBe(
      "collé-00000000-000000.png",
    );
  });

  it("suit le fuseau RÉGLÉ (`ui.timeZone`) sans changer de format", () => {
    // Même instant, fuseau d'affichage à Paris : 16:04 (CET, l'heure d'été a pris
    // fin le 25 octobre 2026).
    setTimeZone("Europe/Paris");
    expect(namePastedFile(fakeFile("", "image/png"), { now: NOW })).toBe(
      "collé-20261029-160406.png",
    );
    // Préfixe, séparateur et extension inchangés : seul le fuseau a bougé.
    expect(namePastedFile(fakeFile("", "image/png"), { now: NOW })).toMatch(
      /^collé-\d{8}-\d{6}\.png$/,
    );
  });
});

/**
 * ⚠️ POURQUOI UN PROCESSUS SÉPARÉ : Node fige son fuseau au PREMIER usage de
 * `Date`/`Intl` ; écrire `process.env.TZ` au milieu d'un test n'a aucun effet.
 * On lance donc un vrai `node` avec `TZ=Asia/Tokyo` (même méthode que
 * `tests/pi/timestamp-utc.test.ts:86-100`) et on lit le nom produit.
 *
 * ⚠️ ÉCHEC SUR L'ORIGINE (mesuré) : l'ancien `stampOf` (`getFullYear()`,
 * `getHours()`…) rendait `20261030-000406` sous `TZ=Asia/Tokyo` — le nom d'image
 * contredisait de 9 h l'horodatage UTC affiché à côté.
 */
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const SCRIPT = `
const { namePastedFile } = await import(${JSON.stringify(`${ROOT}public/ui/clipboard-files.js`)});
const at = new Date("2026-10-29T15:04:06.000Z");
const name = namePastedFile({ name: "", type: "image/png" }, { now: at });
process.stdout.write(
  JSON.stringify({
    fuseauProcess: Intl.DateTimeFormat().resolvedOptions().timeZone,
    heureProcess: new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" }).format(at),
    name,
  }),
);
`;

interface ChildResult {
  fuseauProcess: string;
  heureProcess: string;
  name: string;
}

function runUnder(timeZone: string): ChildResult {
  const out = execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", SCRIPT],
    {
      cwd: ROOT,
      env: { ...process.env, TZ: timeZone },
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  return JSON.parse(out) as ChildResult;
}

describe("nom d'un fichier collé — indépendant du fuseau du PROCESS", () => {
  for (const tz of ["Asia/Tokyo", "America/New_York"]) {
    it(`porte la date/heure UTC de l'instant avec TZ=${tz}`, () => {
      const result = runUnder(tz);
      // Le fuseau du process a bien CHANGÉ : sans cela, le test ne prouverait rien.
      expect(result.fuseauProcess).toBe(tz);
      expect(result.heureProcess).not.toBe("15:04");
      // Même format, même instant, fuseau imposé par `ui.timeZone` (défaut UTC).
      expect(result.name).toBe("collé-20261029-150406.png");
      expect(result.name).toMatch(/^collé-\d{8}-\d{6}\.png$/);
    });
  }
});

describe("fichiers d'un presse-papiers", () => {
  it("garde les items `file` (image ET fichier), ignore le texte", () => {
    const image = fakeFile("", "image/png");
    const pdf = fakeFile("facture.pdf", "application/pdf");
    const found = filesFromClipboard(
      fakeTransfer([
        { kind: "file", getAsFile: () => image },
        { kind: "string", getAsFile: () => null },
        { kind: "file", getAsFile: () => pdf },
      ]),
      { now: NOW },
    );
    expect(found.map((file) => file.name)).toEqual([
      "collé-20261029-150406.png",
      "facture.pdf",
    ]);
  });

  it("FILTRE les `null` (presse-papiers vidé entre-temps)", () => {
    const found = filesFromClipboard(
      fakeTransfer([
        { kind: "file", getAsFile: () => null },
        { kind: "file" },
        { kind: "file", getAsFile: () => fakeFile("a.txt", "text/plain") },
      ]),
      { now: NOW },
    );
    expect(found.map((file) => file.name)).toEqual(["a.txt"]);
  });

  it("rend une liste VIDE pour un collage de texte (aucun envoi)", () => {
    expect(
      filesFromClipboard(
        fakeTransfer([
          { kind: "string", getAsFile: () => null },
          { kind: "string", getAsFile: () => null },
        ]),
        { now: NOW },
      ),
    ).toEqual([]);
    expect(filesFromClipboard(fakeTransfer([]), { now: NOW })).toEqual([]);
    expect(filesFromClipboard(null)).toEqual([]);
    expect(filesFromClipboard(undefined)).toEqual([]);
  });

  it("se rabat sur `files` quand `items` est absent", () => {
    const file = fakeFile("notes.txt", "text/plain");
    expect(
      filesFromClipboard(fakeTransfer(undefined, [file]), { now: NOW }).map(
        (found) => found.name,
      ),
    ).toEqual(["notes.txt"]);
  });

  it("conserve le TYPE du fichier renommé (le serveur classe sur le MIME)", () => {
    const [image] = filesFromClipboard(
      fakeTransfer([{ kind: "file", getAsFile: () => fakeFile("", "image/png") }]),
      { now: NOW },
    );
    expect(image.name).toBe("collé-20261029-150406.png");
    expect(image.type).toBe("image/png");
    expect(image.size).toBe(12);
  });
});
