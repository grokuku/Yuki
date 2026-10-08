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
  | { type: "removed"; id: string }
  /**
   * Remise à zéro : toute la projection a été archivée puis vidée. L'index
   * DÉRIVÉ doit repartir VIDE (jamais de purge partielle entrée par entrée).
   */
  | { type: "reset" };

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

// ---------------------------------------------------------------------------
// Administration (API `/api/memory*`) — archivage récupérable, JAMAIS outil
// exposé au modèle (aucune politique de tool, aucun `run_command`).
// ---------------------------------------------------------------------------

/**
 * Résultat d'une remise à zéro de la mémoire.
 *
 * ⚠️ « Réinitialiser » = METTRE DE CÔTÉ, pas effacer : le journal de mémoire est
 * RENOMMÉ (horodaté) dans un dossier d'archive, l'index dérivé repart vide. Une
 * mémoire déjà vide n'entraîne AUCUNE création d'archive.
 */
export interface MemoryResetResult {
  /** `true` si un fichier de mémoire non vide a été archivé. */
  archived: boolean;
  /** Nombre d'entrées archivées (0 si rien à archiver). */
  entries: number;
  /**
   * Chemin ABSOLU de l'archive (fichier renommé), ou `null` si rien n'a été
   * archivé. Lisible par l'utilisateur pour retrouver ou restaurer sa mémoire.
   */
  archivePath: string | null;
  /** Taille en octets de l'archive (0 si rien). */
  bytes: number;
  /** Horodatage ISO-8601 de l'opération. */
  at: string;
}

/** État lisible de la mémoire (affiché dans `/config`, onglet Personnalité). */
export interface MemoryAdminInfo {
  /** Nombre d'entrées courantes. */
  entries: number;
  /** Dossier où seront déposées les archives (chemin absolu). */
  archiveDir: string;
}

/**
 * Port d'administration de la mémoire consommé par la route `/api/memory`.
 * ⚠️ Réservé à l'INTERFACE (jamais exposé au modèle).
 */
export interface MemoryAdminPort {
  /** Archive la mémoire courante puis repart d'une mémoire vide. */
  resetMemory(): MemoryResetResult;
  /** État lisible (nombre d'entrées + dossier d'archive). */
  info(): MemoryAdminInfo;
}
