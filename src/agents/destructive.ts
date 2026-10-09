/**
 * Classement des commandes **destructrices** côté Yuki (Lot 4, A5).
 *
 * ⚠️ **SOURCE UNIQUE.** Les motifs ne sont PAS recopiés ici : ils vivent dans
 * `agent/internal/exec/destructive_patterns.json`, embarqué côté Go
 * (`//go:embed`) et **lu à l'exécution** ici. Deux listes divergentes seraient
 * un trou de sécurité ; l'identité des deux sources est prouvée par le test
 * croisé `tests/agents/destructive-cross.test.ts` (même empreinte SHA-256 de
 * fichier + classement identique sur une batterie de commandes).
 *
 * ⚠️ **Ce que ce module N'EST PAS.** Une barrière : un classement (D126). Une
 * liste de motifs se contourne (obfuscation, variables, encodage) et une
 * commande anodine peut être destructrice selon le contexte. L'autorité de
 * décision reste Yuki ; l'agent **recompare et journalise les divergences**
 * (défense en profondeur, sans blocage).
 *
 * Le sous-ensemble de syntaxe utilisé est **commun à RE2 (Go) et RegExp (JS)** :
 * pas de lookaround ni de backreference.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Motif de classification, tel que déclaré dans le JSON. */
export interface DestructivePattern {
  id: string;
  label: string;
  regex: string;
  flags: string;
}

/** Document JSON complet des motifs. */
export interface DestructivePatternsDoc {
  version: number;
  description: string;
  limites: string[];
  patterns: DestructivePattern[];
}

/** Résultat du classement d'une commande. */
export interface DestructiveVerdict {
  /** `true` si AU MOINS un motif correspond. */
  destructive: boolean;
  /** Identifiants des motifs correspondants, dans l'ordre du fichier. */
  ids: string[];
}

/** Source des motifs telle que lue sur le disque (preuve d'unicité). */
export interface DestructivePatternsSource {
  /** Chemin absolu du fichier de motifs effectivement lu. */
  path: string;
  /** Octets bruts (pour l'empreinte SHA-256). */
  bytes: Buffer;
  /** Empreinte SHA-256 (hex minuscule) — doit égaler celle du Go. */
  sha256: string;
  /** Document analysé. */
  doc: DestructivePatternsDoc;
}

/**
 * Variable d'environnement de **surcharge** du chemin du fichier de motifs
 * (déploiements non standard). Vide ⇒ chemin par défaut.
 */
export const DESTRUCTIVE_PATTERNS_ENV = "YUKI_DESTRUCTIVE_PATTERNS";

/**
 * Chemin **par défaut** du fichier de motifs, résolu relativement à CE module.
 *
 * ⚠️ Le même chemin relatif `../../agent/…` fonctionne :
 *   - en développement (`src/agents/destructive.ts` → `<repo>/agent/…`) ;
 *   - en production compilée (`dist/agents/destructive.js` → `/app/agent/…`,
 *     car l'image copie le fichier sous `/app/agent/…`, voir
 *     `infra/gateway/Dockerfile`).
 */
export function resolveDestructivePatternsPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env[DESTRUCTIVE_PATTERNS_ENV];
  if (override && override.trim() !== "") {
    return override;
  }
  return fileURLToPath(
    new URL("../../agent/internal/exec/destructive_patterns.json", import.meta.url),
  );
}

function parseDoc(text: string, path: string): DestructivePatternsDoc {
  let doc: DestructivePatternsDoc;
  try {
    doc = JSON.parse(text) as DestructivePatternsDoc;
  } catch (error) {
    throw new Error(
      `destructive : motifs illisibles (${path}) : ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!Array.isArray(doc.patterns) || doc.patterns.length === 0) {
    throw new Error(`destructive : aucun motif déclaré (${path})`);
  }
  const seen = new Set<string>();
  for (const pattern of doc.patterns) {
    if (!pattern.id) {
      throw new Error(`destructive : motif sans identifiant (${path})`);
    }
    if (seen.has(pattern.id)) {
      throw new Error(`destructive : identifiant de motif dupliqué ${pattern.id} (${path})`);
    }
    seen.add(pattern.id);
  }
  return doc;
}

/**
 * Lit et analyse le fichier de motifs (sans cache) — sert aussi de preuve
 * d'unicité de source (chemin + empreinte).
 */
export function loadDestructivePatternsSource(
  env: NodeJS.ProcessEnv = process.env,
): DestructivePatternsSource {
  const path = resolveDestructivePatternsPath(env);
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw new Error(
      `destructive : fichier de motifs introuvable (${path}) : ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const text = bytes.toString("utf8");
  const doc = parseDoc(text, path);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { path, bytes, sha256, doc };
}

interface Compiled {
  id: string;
  re: RegExp;
}

let compiledCache: Compiled[] | null = null;
let sourceCache: DestructivePatternsSource | null = null;

function compileAll(doc: DestructivePatternsDoc): Compiled[] {
  return doc.patterns.map((pattern) => {
    if (!/^[ims]*$/.test(pattern.flags ?? "")) {
      throw new Error(
        `destructive : drapeau de motif inattendu ${JSON.stringify(pattern.flags)} (${pattern.id})`,
      );
    }
    try {
      return { id: pattern.id, re: new RegExp(pattern.regex, pattern.flags ?? "") };
    } catch (error) {
      throw new Error(
        `destructive : motif ${pattern.id} : expression invalide : ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  });
}

/** Charge (avec cache) la source des motifs. */
export function loadDestructivePatternsSourceCached(
  env: NodeJS.ProcessEnv = process.env,
): DestructivePatternsSource {
  if (sourceCache === null) {
    sourceCache = loadDestructivePatternsSource(env);
  }
  return sourceCache;
}

/** Document des motifs (avec cache). */
export function loadDestructivePatterns(
  env: NodeJS.ProcessEnv = process.env,
): DestructivePatternsDoc {
  return loadDestructivePatternsSourceCached(env).doc;
}

/**
 * Classe une commande. **Pur** vis-à-vis du fichier embarqué : le résultat ne
 * dépend que de l'entrée et du fichier de motifs.
 */
export function evaluateDestructive(command: string): DestructiveVerdict {
  if (compiledCache === null) {
    compiledCache = compileAll(loadDestructivePatterns());
  }
  const ids: string[] = [];
  for (const { id, re } of compiledCache) {
    if (re.test(command)) {
      ids.push(id);
    }
  }
  return { destructive: ids.length > 0, ids };
}

/** Raccourci booléen. */
export function isDestructive(command: string): boolean {
  return evaluateDestructive(command).destructive;
}

/** Identifiants des motifs, dans l'ordre du fichier. */
export function destructivePatternIds(): string[] {
  return loadDestructivePatterns().patterns.map((pattern) => pattern.id);
}

/**
 * Libellés lisibles (français) des motifs désignés par leurs identifiants,
 * dans l'ordre fourni. Un identifiant inconnu est rendu tel quel (jamais
 * silencieusement perdu). Sert à EXPLIQUER à l'humain pourquoi une commande est
 * classée « destructrice ».
 */
export function destructiveLabels(ids: readonly string[]): string[] {
  const doc = loadDestructivePatterns();
  const byId = new Map(doc.patterns.map((pattern) => [pattern.id, pattern.label]));
  return ids.map((id) => byId.get(id) ?? id);
}

/** Empreinte SHA-256 (hex) du fichier de motifs lu. */
export function destructivePatternsSha256(): string {
  return loadDestructivePatternsSourceCached().sha256;
}

/** Réinitialise les caches (tests uniquement). */
export function resetDestructiveCaches(): void {
  compiledCache = null;
  sourceCache = null;
}
