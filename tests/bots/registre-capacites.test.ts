/**
 * REGISTRE DES BOTS — les CAPACITÉS (lot 35h).
 *
 * Ce que ce fichier verrouille :
 *  - ⚠️ TOLÉRANCE DE LECTURE : un `bots.json` écrit AVANT les capacités (champ
 *    absent, ou ancien champ `profil`) donne TOUTES les capacités — le bot
 *    existant ne perd rien du jour au lendemain ;
 *  - un fichier qui porte `capacites: []` donne `[]` (bot neuf, ne peut que
 *    répondre) ;
 *  - une capacité INCONNUE est REFUSÉE à la lecture comme à l'écriture (jamais
 *    ignorée en silence) ;
 *  - l'ordre canonique et le dédoublonnage sont appliqués à la lecture, et
 *    `profil` n'est plus jamais réécrit.
 *
 * ⚠️ Échoue sur le code d'origine : `capacites` n'existe pas (le champ `profil`
 * y est obligatoire et `[]` y est un registre INVALIDE).
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CAPACITES_BOT,
  RegistreBotsError,
  cheminRegistreBots,
  ecrireRegistreBots,
  lireRegistreBots,
  type RegistreBots,
} from "../../src/bots/registry.js";

const racines: string[] = [];

afterEach(() => {
  for (const racine of racines.splice(0)) rmSync(racine, { recursive: true, force: true });
});

function banc(): { stateDir: string; path: string } {
  const racine = mkdtempSync(join(tmpdir(), "yuki-registre-capacites-"));
  racines.push(racine);
  const stateDir = join(racine, "state");
  return { stateDir, path: cheminRegistreBots(stateDir) };
}

/** Écrit un registre BRUT (tel qu'un fichier d'une AUTRE version du produit). */
function ecrireBrut(path: string, bots: unknown[]): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({ schemaVersion: 1, bots, echanges: {} }, null, 2)}\n`,
    "utf8",
  );
}

const botBrut = (extra: Record<string, unknown>): Record<string, unknown> => ({
  id: "yuki",
  nom: "Yuki",
  actif: true,
  ordre: 0,
  creeLe: "2026-01-01T00:00:00.000Z",
  plateformes: {},
  ...extra,
});

describe("① tolerance de lecture — le bot existant garde TOUT", () => {
  it("`capacites` ABSENT (registre d'avant le lot) ⇒ toutes les capacités", () => {
    const { path } = banc();
    ecrireBrut(path, [botBrut({})]);
    const registre = lireRegistreBots(path);
    expect(registre?.bots[0]?.capacites).toEqual([...CAPACITES_BOT]);
  });

  it("ancien `profil` présent ⇒ toutes les capacités, et le profil est IGNORÉ", () => {
    const { path } = banc();
    // ⚠️ Même un ancien profil RESTREINT (`lecture`) donne toutes les capacités :
    // le concept a disparu, et un bot ne doit rien perdre d'un coup.
    ecrireBrut(path, [botBrut({ profil: "lecture" })]);
    const registre = lireRegistreBots(path);
    expect(registre?.bots[0]?.capacites).toEqual([...CAPACITES_BOT]);
    expect(registre?.bots[0]).not.toHaveProperty("profil");
  });

  it("`capacites: []` (bot neuf) ⇒ liste VIDE, conservée telle quelle", () => {
    const { path } = banc();
    ecrireBrut(path, [botBrut({ capacites: [] })]);
    expect(lireRegistreBots(path)?.bots[0]?.capacites).toEqual([]);
  });

  it("ordre canonique et doublons retirés", () => {
    const { path } = banc();
    ecrireBrut(path, [botBrut({ capacites: ["builtins", "envoi", "envoi"] })]);
    expect(lireRegistreBots(path)?.bots[0]?.capacites).toEqual(["envoi", "builtins"]);
  });
});

describe("② capacities invalides — refusées, jamais ignorées", () => {
  it("une capacité INCONNUE lève un registre INVALIDE (message qui la nomme)", () => {
    const { path } = banc();
    ecrireBrut(path, [botBrut({ capacites: ["tout"] })]);
    expect(() => lireRegistreBots(path)).toThrowError(RegistreBotsError);
    expect(() => lireRegistreBots(path)).toThrowError(/capacité inconnue "tout"/);
  });

  it("un NON-tableau lève", () => {
    const { path } = banc();
    ecrireBrut(path, [botBrut({ capacites: "envoi" })]);
    expect(() => lireRegistreBots(path)).toThrowError(/doit être une liste/);
  });

  it("l'ÉCRITURE valide aussi : une capacité inconnue n'atteint jamais le disque", () => {
    const { path } = banc();
    const registre = {
      schemaVersion: 1,
      bots: [botBrut({ capacites: ["inconnue"] })],
      echanges: {},
    } as unknown as RegistreBots;
    expect(() => ecrireRegistreBots(path, registre)).toThrowError(RegistreBotsError);
  });

  it("un bot écrit par `ecrireRegistreBots` ne porte JAMAIS `profil`", () => {
    const { stateDir, path } = banc();
    ecrireBrut(path, [botBrut({ profil: "complet", capacites: ["envoi"] })]);
    const registre = lireRegistreBots(path);
    expect(registre).not.toBeNull();
    if (!registre) return;
    ecrireRegistreBots(path, registre);
    const ecrit = JSON.parse(readFileSync(path, "utf8")) as {
      bots: Array<Record<string, unknown>>;
    };
    expect(ecrit.bots[0]).not.toHaveProperty("profil");
    expect(ecrit.bots[0]?.["capacites"]).toEqual(["envoi"]);
    // Le fichier reste lisible (aller-retour stable).
    expect(lireRegistreBots(cheminRegistreBots(stateDir))?.bots[0]?.capacites).toEqual(["envoi"]);
  });
});
