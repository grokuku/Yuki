/**
 * Normalisation de texte pour la mémoire (Lot 12) — fonctions PURES.
 *
 * Deux usages :
 *  - `foldText` : forme canonique (minuscules, sans accents, espaces réduits)
 *    servant à la fois à l'INDEX (colonne FTS) et aux REQUÊTES. En indexant et en
 *    interrogeant la MÊME forme, la recherche est **insensible aux accents**
 *    (« crepes » trouve « crêpes »). `unicode61 remove_diacritics 2` du tokenizer
 *    FTS5 est conservé en ceinture-bretelles, mais le contrat repose sur
 *    `foldText` (testable, déterministe).
 *  - `fingerprint` : empreinte stable d'un souvenir, base de l'IDEMPOTENCE de
 *    l'écriture (rejouer la même extraction ne duplique pas).
 *
 * Aucun import SDK/typebox.
 */

import { createHash } from "node:crypto";

/** Forme canonique : NFKD → suppression des diacritiques → minuscules → espaces. */
export function foldText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Empreinte stable (16 caractères hex) d'un souvenir, pour la déduplication. */
export function fingerprint(text: string): string {
  return createHash("sha1").update(foldText(text)).digest("hex").slice(0, 16);
}

/**
 * Construit une requête `MATCH` FTS5 sûre à partir d'un texte libre.
 *
 * - découpe sur tout ce qui n'est pas lettre/chiffre Unicode ;
 * - ne garde que les termes d'au moins 2 caractères, dédupliqués ;
 * - borne le nombre de termes (`maxTerms`) : requête rapide, jamais géante ;
 * - chaque terme est mis entre guillemets (aucune syntaxe FTS5 interprétable) ;
 * - les termes sont joints par `OR` (rappel privilégié, bm25 classe ensuite).
 *
 * Renvoie `null` si aucun terme exploitable (⇒ pas de recherche, pas d'erreur).
 */
export function buildMatchQuery(query: string, maxTerms = 8): string | null {
  const terms: string[] = [];
  for (const raw of foldText(query).split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2) continue;
    if (terms.includes(raw)) continue;
    terms.push(raw);
    if (terms.length >= maxTerms) break;
  }
  if (terms.length === 0) return null;
  return terms.map((term) => `"${term}"`).join(" OR ");
}
