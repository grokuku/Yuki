/**
 * GARDE STATIQUE — `scripts/ci-smoke.sh` contre le SCHÉMA de configuration.
 *
 * ⚠️ POURQUOI CE TEST EXISTE (régression du 2026-11-19, CI rouge) :
 * le lot B a RETIRÉ les seize réglages par rôle (`llm.light.*`, `llm.heavy.*`,
 * `llm.vision.*`) au profit du CATALOGUE (`llm.fournisseurs` / `llm.modeles` /
 * `llm.defaut.*`, la clé d'un fournisseur vivant au chemin secret
 * `llm.fournisseur.<id>.apiKey`). Le script `ci-smoke.sh`, lui, continuait à LIRE
 * et à ÉCRIRE les anciens chemins : `PUT /api/config` répondait donc `400
 * unknown_field`, les clés n'étaient jamais posées et `/health/ready` restait 503.
 *
 * ⚠️ Le script est du SHELL : il échappe à tous les tests unitaires qui exercent
 * l'API. On le teste donc STATIQUEMENT, comme un contrat : chaque chemin de
 * configuration qu'il cite doit encore exister dans `CONFIG_SCHEMA`. C'est la
 * garde qui manquait — sans elle, la prochaine suppression de champ casse la CI
 * sans qu'aucun `vitest` ne bronche.
 *
 * Périmètre des chemins extraits (assumé et vérifié ci-dessous : le test échoue si
 * l'extraction ne trouve plus rien) :
 *  - LUS dans la réponse : `.fields["…"]` / `$fields["…"]` ;
 *  - ÉCRITS dans un corps JSON : `"llm.x.y":`.
 * Les filtres `jq` NUS (`.gpu.source == "simulated"`) décrivent la RÉPONSE de
 * `/health`, pas la configuration : hors périmètre.
 * Les chemins DYNAMIQUES d'une famille réelle (`llm.fournisseur.<id>.apiKey`, dont
 * l'identifiant est lu dans `GET /api/config`) sont reconnus par leur PRÉFIXE, lui
 * aussi dérivé du code (`cheminCleFournisseur`) — jamais recopié à la main.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CLES_CONFIG_RETIREES,
  CONFIG_SCHEMA,
  descriptorOf,
  isSecretPath,
} from "../../src/config/schema.js";
import { cheminCleFournisseur } from "../../src/llm/catalogue.js";

const RACINE = process.cwd();
const CHEMIN_SCRIPT = "scripts/ci-smoke.sh";

/** Chemin de configuration cité par le script, avec sa ligne. */
interface CheminCite {
  readonly chemin: string;
  readonly ligne: number;
}

/** Préfixes de chemins du schéma (`llm`, `llm.defaut`…) : un chemin PARTIEL. */
const PREFIXES_SCHEMA: ReadonlySet<string> = (() => {
  const prefixes = new Set<string>();
  for (const chemin of Object.keys(CONFIG_SCHEMA)) {
    const segments = chemin.split(".");
    for (let i = 1; i < segments.length; i += 1) {
      prefixes.add(segments.slice(0, i).join("."));
    }
  }
  return prefixes;
})();

/**
 * Préfixe des chemins SECRETS DYNAMIQUES (une clé par fournisseur déclaré).
 *
 * ⚠️ Dérivé de `cheminCleFournisseur` (source de vérité du serveur) : le test ne
 * recopie pas la famille de chemins, il la demande au code qui la produit.
 */
const PREFIXE_DYNAMIQUE = cheminCleFournisseur("fournisseur-de-test").split(
  ".fournisseur-de-test.",
)[0] as string;

/** Chemin lu dans un instantané de configuration (`.fields["…"]`). */
const MOTIF_LU = /(?:\.fields|\$fields)\[\s*"([^"]+)"\s*\]/g;
/** Chemin ÉCRIT comme clé JSON (`"llm.x.y":`). */
const MOTIF_ECRIT = /["']([a-z][a-z0-9]*(?:\.[a-z][a-zA-Z0-9-]*)+)["']\s*:/g;

/** Tous les chemins de configuration cités par un texte de script. */
function cheminsCites(texte: string): CheminCite[] {
  const cites: CheminCite[] = [];
  for (const [index, ligne] of texte.split("\n").entries()) {
    const vus = new Set<string>();
    for (const motif of [MOTIF_LU, MOTIF_ECRIT]) {
      motif.lastIndex = 0;
      for (const trouve of ligne.matchAll(motif)) {
        // Un chemin terminé par un point est une CONCATÉNATION (`"llm.defaut." + $role`) :
        // c'est un préfixe de famille, pas un chemin complet.
        const chemin = (trouve[1] ?? "").trim().replace(/\.+$/, "");
        if (chemin === "" || vus.has(chemin)) continue;
        vus.add(chemin);
        cites.push({ chemin, ligne: index + 1 });
      }
    }
  }
  return cites;
}

/**
 * Le chemin existe-t-il encore ?
 *
 *  - champ du schéma → oui ;
 *  - chemin PARTIEL qui préfixe des champs réels (`llm.defaut`) → oui : il désigne
 *    une famille, il ne peut pas être périmé ;
 *  - chemin dynamique d'un fournisseur (`llm.fournisseur[…]`) → oui, il est
 *    reconnu par `descriptorOf` (voir le test dédié).
 */
function cheminConnu(chemin: string): boolean {
  if (Object.hasOwn(CONFIG_SCHEMA, chemin)) return true;
  if (PREFIXES_SCHEMA.has(chemin)) return true;
  if (chemin === PREFIXE_DYNAMIQUE || chemin.startsWith(`${PREFIXE_DYNAMIQUE}.`)) {
    return true;
  }
  if (PREFIXE_DYNAMIQUE.startsWith(`${chemin}.`)) return true;
  return descriptorOf(chemin) !== undefined;
}

const texteScript = readFileSync(join(RACINE, CHEMIN_SCRIPT), "utf8");

describe("scripts/ci-smoke.sh ↔ schéma de configuration", () => {
  it("la famille de chemins DYNAMIQUES reconnue est réelle (sinon la garde serait vide)", () => {
    // ⚠️ Sans cette vérification, une faute de dérivation ferait « tout accepter ».
    const chemin = cheminCleFournisseur("fournisseur-de-test");
    expect(PREFIXE_DYNAMIQUE).not.toBe("");
    expect(descriptorOf(chemin)).toBeDefined();
    expect(isSecretPath(chemin)).toBe(true);
    expect(cheminConnu(chemin)).toBe(true);
  });

  it("l'extraction n'est pas vide (elle voit les chemins du catalogue)", () => {
    // ⚠️ Anti-régression de la GARDE elle-même : un script qui n'écrirait plus ses
    // chemins sous une forme reconnue rendrait le test ci-dessous silencieusement
    // inutile. On exige donc de voir les deux listes du catalogue.
    const chemins = cheminsCites(texteScript).map((cite) => cite.chemin);
    expect(chemins).toContain("llm.fournisseurs");
    expect(chemins).toContain("llm.modeles");
  });

  it("⚠️ ne cite AUCUN chemin de configuration disparu du schéma", () => {
    // Échec attendu si le script écrit encore un réglage retiré : le message nomme
    // le CHEMIN et la LIGNE, pour que le prochain rouge soit lisible.
    const inconnus = cheminsCites(texteScript)
      .filter((cite) => !cheminConnu(cite.chemin))
      .map((cite) => `${CHEMIN_SCRIPT}:${cite.ligne} → ${cite.chemin}`);
    expect(inconnus).toEqual([]);
  });

  it("⚠️ ne réintroduit AUCUN réglage par rôle retiré au lot B", () => {
    // Le lot B a retiré les seize réglages `llm.<rôle>.*` VOLONTAIREMENT : les
    // réintroduire dans le script (même dans un commentaire) ferait croire qu'ils
    // agissent encore.
    expect(texteScript).not.toMatch(/llm\.(light|heavy|vision)\./);
    const retires = cheminsCites(texteScript)
      .filter((cite) => cite.chemin in CLES_CONFIG_RETIREES)
      .map((cite) => `${CHEMIN_SCRIPT}:${cite.ligne} → ${cite.chemin}`);
    expect(retires).toEqual([]);
  });

  it("lit la clé du fournisseur au chemin SECRET du catalogue", () => {
    // La clé n'est plus un réglage de rôle : elle se pose au chemin secret du
    // fournisseur, construit UNE fois (`chemin_cle_fournisseur`). Le format du
    // script est comparé à celui du SERVEUR (`cheminCleFournisseur`) : les deux ne
    // peuvent pas diverger sans que ce test le dise.
    expect(texteScript).toContain("chemin_cle_fournisseur");
    const format = /chemin_cle_fournisseur\(\)[^\n]*\n\s*printf\s+'([^']*%s[^']*)'/.exec(
      texteScript,
    )?.[1];
    expect(format, "format printf du chemin de clé introuvable").toBeDefined();
    expect(String(format).replace("%s", "fournisseur-x")).toBe(
      cheminCleFournisseur("fournisseur-x"),
    );
  });
});
