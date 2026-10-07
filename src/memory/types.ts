/**
 * Domaine « mémoire durable » de Yuki (Lot 12) — TYPES PURS.
 *
 * ⚠️ Ce module (comme tout `src/memory/**`) n'importe NI le SDK Pi NI `typebox` :
 * c'est un domaine de données, testable en isolation. L'injection dans la
 * conversation est confinée à `src/pi/sdk/**` (extension SDK).
 *
 * La mémoire est une **donnée**, jamais une règle : aucun souvenir n'est
 * exécuté comme instruction.
 */

/** Sous-ensemble du logger d'observabilité utilisé par la mémoire. */
export interface MemoryLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** Catégories reconnues (toute autre valeur est ramenée à `autre`). */
export const MEMORY_CATEGORIES = [
  "preference",
  "fait",
  "projet",
  "relation",
  "autre",
] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

/** Entrée de mémoire COURANTE (projection des événements du store). */
export interface MemoryEntry {
  id: string;
  /** Date de création (ISO-8601). */
  at: string;
  /** Date de dernière mise à jour (ISO-8601), si l'entrée a été modifiée. */
  updatedAt?: string;
  /** Contenu du souvenir (français, une phrase). */
  text: string;
  /**
   * Source : identifiant du message d'origine (`<entrée de session>`) ou
   * `compaction` pour une passe de consolidation. Jamais vide.
   */
  source: string;
  cat: MemoryCategory;
}

// ---------------------------------------------------------------------------
// Journal append-only (une ligne JSON par événement) — FORMAT DOCUMENTÉ.
// ---------------------------------------------------------------------------

export interface MemoryAddEvent {
  v: 1;
  t: "add";
  id: string;
  at: string;
  text: string;
  source: string;
  cat: MemoryCategory;
}

export interface MemoryUpdateEvent {
  v: 1;
  t: "update";
  id: string;
  at: string;
  text: string;
  source: string;
  cat: MemoryCategory;
}

export interface MemoryDeleteEvent {
  v: 1;
  t: "delete";
  id: string;
  at: string;
}

/** Événement du journal de mémoire. */
export type MemoryEvent =
  | MemoryAddEvent
  | MemoryUpdateEvent
  | MemoryDeleteEvent;

/** Changement diffusé par le store (synchronisation de l'index). */
export type MemoryChange =
  | { type: "added"; entry: MemoryEntry }
  | { type: "updated"; entry: MemoryEntry }
  | { type: "removed"; id: string };

// ---------------------------------------------------------------------------
// Extraction (écriture automatique) — ports PURS.
// ---------------------------------------------------------------------------

/** Opération produite par une passe d'extraction ou de consolidation. */
export type MemoryOp =
  | { op: "add"; text: string; cat: MemoryCategory }
  | { op: "update"; id: string; text: string; cat: MemoryCategory }
  | { op: "delete"; id: string };

/**
 * Extractor : reçoit un prompt COMPLET (français) et renvoie la réponse brute du
 * modèle. L'implémentation SDK (session éphémère isolée) vit dans
 * `src/pi/sdk/memory-extractor.ts` ; les tests injectent un double.
 */
export type MemoryExtractor = (prompt: string) => Promise<string>;

// ---------------------------------------------------------------------------
// Port consommé par l'extension SDK (injection avant tour + déclencheurs).
// ---------------------------------------------------------------------------

/** Résultat borné d'un rappel. */
export interface MemoryRecallResult {
  /** Bloc à injecter (français), ou `null` si rien de pertinent / indisponible. */
  block: string | null;
  /** Nombre d'entrées retenues. */
  entries: number;
  /** Longueur en caractères du bloc (0 si `null`). */
  chars: number;
  /** Durée réelle de la recherche (ms). */
  durationMs: number;
}

/** Bornes dures du rappel (top-k, budget caractères, timeout). */
export interface MemoryBounds {
  topK: number;
  budgetChars: number;
  timeoutMs: number;
}

/** Entrée d'une extraction de fin de tour. */
export interface TurnEndInput {
  userText: string;
  assistantText: string;
  /** Identifiant du message utilisateur d'origine. */
  source: string;
}

/** Message structurel minimal pour la consolidation (aucun type SDK). */
export interface ConsolidateMessage {
  role: string;
  text: string;
}

/** Entrée d'une passe de consolidation (avant compaction). */
export interface BeforeCompactInput {
  messages: readonly ConsolidateMessage[];
  previousSummary?: string;
}

/**
 * Port de mémoire consommé par l'extension SDK. Contrat volontaires simple :
 * `recall` est borné et ne lève jamais ; les deux déclencheurs sont
 * asynchrones et ne bloquent JAMAIS l'appelant.
 */
export interface RecallBoundsProvider {
  (): MemoryBounds;
}

export interface MemoryPort {
  /** Recherche bornée des souvenirs pertinents pour `query`. */
  recall(query: string): Promise<MemoryRecallResult>;
  /** Déclenche l'extraction de fin de tour (jamais bloquante). */
  onTurnEnd(input: TurnEndInput): void;
  /** Déclenche la consolidation avant compaction (jamais bloquante). */
  onBeforeCompact(input: BeforeCompactInput): void;
}
