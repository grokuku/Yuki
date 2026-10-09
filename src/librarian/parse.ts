/**
 * Lecture TOLÉRANTE des réponses du libraire (fonctions pures, aucun import SDK).
 *
 * ⚠️ Le service peut enrichir sa réponse : on n'exige jamais un champ. Un champ
 * absent ou d'un type inattendu est simplement ignoré — jamais une exception.
 */

import type {
  LibrarianDoc,
  LibrarianLibrary,
  LibrarianLibraryEntry,
  LibrarianSearchOutcome,
  LibrarianSearchResult,
  LibrarianStatus,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string") out.push(item);
  }
  return out;
}

/**
 * Convertit une liste de contenu (points clés, API, exemples) en LIGNES
 * affichables. Tolérant : un élément peut être une chaîne OU un objet — la forme
 * documentée par Pi-Web (`{signature, description}` pour `api`, `{title, code}`
 * pour `examples`). Un objet inconnu est rendu en JSON compact (borné plus tard).
 */
function toDisplayLines(value: unknown, max: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (out.length >= max) break;
    if (typeof item === "string") {
      const text = item.trim();
      if (text !== "") out.push(text);
      continue;
    }
    if (isRecord(item)) {
      const signature = asString(item.signature);
      const title = asString(item.title);
      const description = asString(item.description);
      const code = asString(item.code);
      if (signature !== undefined) {
        out.push(description ? `${signature} — ${description}` : signature);
        continue;
      }
      if (title !== undefined) {
        out.push(code ? `${title} — ${code}` : title);
        continue;
      }
      try {
        out.push(JSON.stringify(item));
      } catch {
        // Objet non sérialisable : ignoré (jamais d'exception).
      }
    }
  }
  return out;
}

/** Normalise un résultat de recherche (titre/URL/extrait + contenu local optionnel). */
function parseSearchResult(value: unknown): LibrarianSearchResult | null {
  if (!isRecord(value)) return null;
  const content = asString(value.content);
  return {
    title: asString(value.title) ?? "",
    url: asString(value.url) ?? "",
    snippet: asString(value.snippet) ?? "",
    ...(content !== undefined ? { content } : {}),
  };
}

/** Lit la réponse de `POST /api/librarian/search`. */
export function parseSearchOutcome(raw: unknown): LibrarianSearchOutcome {
  if (!isRecord(raw)) return { results: [] };
  const rawResults = Array.isArray(raw.results) ? raw.results : [];
  const results: LibrarianSearchResult[] = [];
  for (const item of rawResults) {
    const parsed = parseSearchResult(item);
    if (parsed) results.push(parsed);
  }
  const archived = typeof raw.archived === "boolean" ? raw.archived : undefined;
  return { results, ...(archived !== undefined ? { archived } : {}) };
}

/** Lit la réponse de `GET /api/librarian/status`. */
export function parseStatus(raw: unknown): LibrarianStatus {
  if (!isRecord(raw)) return {};
  const totalDocs = typeof raw.totalDocs === "number" ? raw.totalDocs : undefined;
  const lastUpdated = asString(raw.lastUpdated);
  const lastScan = asString(raw.lastScan);
  return {
    ...(totalDocs !== undefined ? { totalDocs } : {}),
    ...(lastUpdated !== undefined ? { lastUpdated } : {}),
    ...(lastScan !== undefined ? { lastScan } : {}),
  };
}

function parseLibraryEntry(value: unknown): LibrarianLibraryEntry | null {
  if (!isRecord(value)) return null;
  const name = asString(value.name);
  if (name === undefined || name.trim() === "") return null;
  const version = asString(value.version);
  const type = asString(value.type);
  const description = asString(value.description);
  const keywords = asStringArray(value.keywords);
  const updatedAt = asString(value.updatedAt);
  const sourceUrl = asString(value.sourceUrl);
  return {
    name,
    version: version ?? "",
    ...(type !== undefined ? { type } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(keywords !== undefined ? { keywords } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(sourceUrl !== undefined ? { sourceUrl } : {}),
  };
}

/** Lit la réponse de `GET /api/librarian/library`. */
export function parseLibrary(raw: unknown): LibrarianLibrary {
  if (!isRecord(raw)) return { library: [] };
  const rawLibrary = Array.isArray(raw.library) ? raw.library : [];
  const library: LibrarianLibraryEntry[] = [];
  for (const item of rawLibrary) {
    const parsed = parseLibraryEntry(item);
    if (parsed) library.push(parsed);
  }
  const lastUpdated = asString(raw.lastUpdated);
  const lastScan = asString(raw.lastScan);
  return {
    ...(lastUpdated !== undefined ? { lastUpdated } : {}),
    ...(lastScan !== undefined ? { lastScan } : {}),
    library,
  };
}

/**
 * Normalise le document complet (`GET /api/librarian/doc/:name`). Extrait les
 * champs connus du contenu d'archive, au mieux ; conserve toujours `raw`.
 */
export function parseDoc(raw: unknown): LibrarianDoc {
  if (!isRecord(raw)) return { raw };
  const name = asString(raw.name);
  const version = asString(raw.version);
  const type = asString(raw.type);
  const sourceUrl = asString(raw.sourceUrl);
  const updatedAt = asString(raw.updatedAt);
  // Le contenu d'archive peut être imbriqué (raw.content) ou à plat.
  const content = isRecord(raw.content) ? raw.content : raw;
  const summary = asString(content.summary);
  const keyPoints = toDisplayLines(content.keyPoints, 60);
  const api = toDisplayLines(content.api, 60);
  const examples = toDisplayLines(content.examples, 40);
  const rawContent = asString(content.rawContent);
  const breakingRaw = content.breakingChanges;
  const breakingChanges = Array.isArray(breakingRaw)
    ? toDisplayLines(breakingRaw, 20)?.join("\n")
    : asString(breakingRaw);
  return {
    ...(name !== undefined ? { name } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(type !== undefined ? { type } : {}),
    ...(sourceUrl !== undefined ? { sourceUrl } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(keyPoints !== undefined ? { keyPoints } : {}),
    ...(api !== undefined ? { api } : {}),
    ...(examples !== undefined ? { examples } : {}),
    ...(breakingChanges !== undefined ? { breakingChanges } : {}),
    ...(rawContent !== undefined ? { rawContent } : {}),
    raw,
  };
}
