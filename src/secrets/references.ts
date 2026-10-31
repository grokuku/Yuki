/**
 * Références de secrets dans une commande — **module PUR** (aucun accès disque,
 * aucun import SDK/typebox).
 *
 * ⚠️ PRINCIPE (décision utilisateur n°1) : **PAS de substitution textuelle**.
 * Le modèle écrit une RÉFÉRENCE à une variable ; le serveur la DÉTECTE, récupère
 * la valeur dans le coffre, et la passe en VARIABLE D'ENVIRONNEMENT à l'agent.
 * Le texte de la commande n'est JAMAIS réécrit : il reste sûr à journaliser,
 * auditer et montrer au modèle.
 *
 * ## Syntaxe de référence (contrat du prompt)
 *
 * Une référence s'écrit `${NOM}` (forme recommandée, non ambiguë) ou `$NOM`.
 * `NOM` doit commencer par le préfixe RÉSERVÉ `YUKI_SECRET_` — c'est ce qui
 * distingue une référence de secret d'une variable shell ordinaire (`$PATH`,
 * `$HOME`, `$1`…). Le nom complet est celui stocké dans le coffre (ex.
 * `YUKI_SECRET_NAS`).
 *
 * Côté agent, le shell développe `$NOM` comme n'importe quelle variable
 * d'environnement : c'est le shell qui fait le travail, pas Yuki.
 */

/** Préfixe RÉSERVÉ de tout nom de secret du coffre. */
export const SECRET_NAME_PREFIX = "YUKI_SECRET_";

/**
 * Préfixe RÉSERVÉ du nom de secret portant le JETON d'une source
 * (`YUKI_SOURCE_<NOM>`, voir `src/sources/**`).
 *
 * ⚠️ Second préfixe réservé du coffre : le jeton d'une source est un secret à
 * part entière (chiffré, jamais réaffiché). Il n'est PAS référençable dans une
 * commande (`isSecretReferenceName` exige `YUKI_SECRET_`) : un jeton de source
 * n'a rien à faire dans une ligne de commande.
 */
export const SOURCE_TOKEN_NAME_PREFIX = "YUKI_SOURCE_";

/** Nom de secret valide : préfixe réservé + identifiant shell. */
const SECRET_NAME_PATTERN = /^(?:YUKI_SECRET_|YUKI_SOURCE_)[A-Za-z0-9_]+$/;

/**
 * Motif des références (`${NOM}` ou `$NOM`). On capture le nom SANS le `$` et
 * sans les accolades éventuelles. On exige un identifiant shell (lettre ou
 * `_`, puis alphanumériques/`_`) : `$1`, `$?`, `$@`… ne matchent donc pas.
 */
const REFERENCE_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/** Un nom est-il un nom de secret valide (préfixe réservé compris) ? */
export function isValidSecretName(name: string): boolean {
  return SECRET_NAME_PATTERN.test(name);
}

/**
 * Un nom est-il une RÉFÉRENCE de secret (candidat) ? C'est le préfixe réservé
 * qui marque l'INTENTION, même si le nom n'est pas (encore) dans le coffre —
 * c'est précisément le cas `awaiting_secret`.
 */
export function isSecretReferenceName(name: string): boolean {
  return name.startsWith(SECRET_NAME_PREFIX);
}

/**
 * Extrait les noms de secrets RÉFÉRENCÉS dans une commande, dans l'ordre de
 * première apparition, SANS DOUBLON. Ne touche PAS au texte.
 *
 * ⚠️ Ne renvoie QUE les noms reconnus comme références de secret (préfixe
 * réservé) : une variable shell ordinaire (`$PATH`) est ignorée.
 */
export function extractSecretReferences(command: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of command.matchAll(REFERENCE_PATTERN)) {
    const name = match[1] ?? match[2];
    if (name === undefined || !isSecretReferenceName(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** Résolution d'une commande : environnement à fournir + références absentes. */
export interface SecretResolution {
  /** Noms référencés et PRÉSENTS dans le coffre, ordre de première apparition. */
  found: string[];
  /** Références reconnues mais ABSENTES du coffre (à demander à l'humain). */
  missing: string[];
  /**
   * Variables d'environnement à passer à l'agent (`NOM → valeur`), SANS jamais
   * modifier la commande. Vide si aucune référence trouvée.
   */
  env: Record<string, string>;
}

/**
 * Résout les références d'une commande contre un coffre (via `lookup`).
 *
 * `lookup(name)` renvoie la valeur d'un secret, ou `undefined` s'il est absent.
 * Le texte de la commande n'est JAMAIS lu en sortie : seule la carte d'env est
 * produite.
 */
export function resolveSecretReferences(
  command: string,
  lookup: (name: string) => string | undefined,
): SecretResolution {
  const names = extractSecretReferences(command);
  const env: Record<string, string> = {};
  const found: string[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const value = lookup(name);
    if (value === undefined) {
      missing.push(name);
      continue;
    }
    found.push(name);
    env[name] = value;
  }
  return { found, missing, env };
}
