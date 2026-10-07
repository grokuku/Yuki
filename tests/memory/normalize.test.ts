/**
 * Normalisation (Lot 12) — repli accents/casse (base de la recherche) et
 * construction de requêtes FTS5 sûres.
 */

import { describe, expect, it } from "vitest";

import { buildMatchQuery, fingerprint, foldText } from "../../src/memory/index.js";

describe("foldText", () => {
  it("retire accents et casse, réduit les espaces", () => {
    expect(foldText("  Crêpes  au   Café ")).toBe("crepes au cafe");
    expect(foldText("ÉÀÎÖÜ")).toBe("eaiou");
  });
});

describe("fingerprint", () => {
  it("est stable et insensible à la casse/accents/espaces (dédup)", () => {
    expect(fingerprint("Yuki aime les crêpes")).toBe(fingerprint("  yuki  aime les  CREPES "));
    expect(fingerprint("a")).not.toBe(fingerprint("b"));
  });
});

describe("buildMatchQuery", () => {
  it("met chaque terme entre guillemets et joint par OR", () => {
    expect(buildMatchQuery("crêpes café")).toBe('"crepes" OR "cafe"');
  });

  it("déduplique, ignore les termes trop courts et borne le nombre de termes", () => {
    expect(buildMatchQuery("a café café")).toBe('"cafe"');
    expect(buildMatchQuery("un deux trois quatre cinq six sept huit neuf dix")).toBe(
      '"un" OR "deux" OR "trois" OR "quatre" OR "cinq" OR "six" OR "sept" OR "huit"',
    );
  });

  it("neutralise toute syntaxe FTS5 (guillemets, crochets, opérateurs)", () => {
    expect(buildMatchQuery('""" [[ AND OR NOT')).toBe('"and" OR "or" OR "not"');
    expect(buildMatchQuery("!!!")).toBeNull();
    expect(buildMatchQuery("")).toBeNull();
  });
});
