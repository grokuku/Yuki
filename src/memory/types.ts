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
  "decision",
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
   * Justification COURTE (une ligne) : pourquoi ce souvenir DURERA. Optionnelle
   * (compatibilité : les souvenirs écrits AVANT le Lot 14 n'en ont pas). Les
   * NOUVELLES écritures l'exigent (voir `parseMemoryOps`).
   */
  why?: string;
  /**
   * Source : identifiant du message d'origine (`<entrée de session>`),
   * `compaction` pour une passe de consolidation avant compaction, ou
   * `mise-de-cote` pour la passe déclenchée par la mise de côté d'une
   * conversation. Jamais vide.
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
  /** Justification (une ligne), absente pour les entrées antérieures au Lot 14. */
  why?: string;
}

export interface MemoryUpdateEvent {
  v: 1;
  t: "update";
  id: string;
  at: string;
  text: string;
  source: string;
  cat: MemoryCategory;
  why?: string;
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
  | { op: "add"; text: string; cat: MemoryCategory; why: string }
  | { op: "update"; id: string; text: string; cat: MemoryCategory; why: string }
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
  /**
   * La mémoire est-elle ACTIVE (capacité) au moment du rappel ? ⚠️ Distinct de
   * `block` : vaut `true` même quand aucun souvenir ne remonte. Permet à
   * l'appelant d'annoncer HONNÊTEMENT la capacité (« mémoire activée, rien de
   * pertinent ») au lieu de laisser le modèle conclure à son absence.
   */
  enabled: boolean;
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
 * Message d'une conversation mise de côté (rôle + texte + horodatage).
 *
 * ⚠️ Sert à DEUX choses distinctes, jamais mêlées :
 *  - l'ARCHIVE complète (fichier du volume `state`, jamais dans le prompt) ;
 *  - la PASSE DE MÉMOIRE déclenchée par la mise de côté (mêmes règles que la
 *    consolidation avant compaction).
 */
export interface SetAsideMessage {
  role: string;
  text: string;
  /** Horodatage ISO-8601 de l'entrée de session (facultatif). */
  at?: string;
}

/**
 * Entrée de la passe de mémoire déclenchée par une MISE DE CÔTÉ : la
 * conversation ENTIÈRE (l'utilisateur a tranché : « tout revoir »).
 */
export interface SessionSetAsideInput {
  /** Identifiant de la conversation mise de côté (traçabilité, idempotence). */
  sessionId: string;
  /** Titre d'affichage au moment de la mise de côté. */
  title: string;
  messages: readonly SetAsideMessage[];
}

/**
 * Entrée de la PASSE DE REMPLISSAGE exécutée AVANT une compaction forcée : la
 * conversation ENTIÈRE, relue avant que le fil ne soit résumé (demande explicite
 * de l'utilisateur : « une passe de remplissage de mémoire avant de compresser »).
 *
 * ⚠️ MÊME matière que la mise de côté (messages complets + titre) : aucune
 * troisième lecture n'est inventée, et les mêmes filtres s'appliquent.
 */
export interface SessionMemoryPassInput extends SessionSetAsideInput {
  /**
   * Progression de la passe (1-based) : plusieurs appels modèle pour une
   * conversation volumineuse, donc une attente qui doit rester VISIBLE.
   */
  onProgress?: (part: number, parts: number) => void;
}

/** Pourquoi une passe de mémoire n'a pas écrit (jamais confondu avec « 0 ajout »). */
export type SessionMemoryPassReason =
  | "disabled"
  | "no_extractor"
  | "empty"
  | "failed";

/**
 * Résultat RÉEL d'une passe de mémoire ATTENDUE (compaction forcée).
 *
 * ⚠️ Il existe pour que l'interface puisse dire ce qui s'est VRAIMENT passé :
 * « 2 souvenirs écrits », « passe inactive », « la passe a échoué » ne sont pas
 * la même chose et ne doivent jamais être confondus avec un succès.
 */
export interface SessionMemoryPassResult {
  /** `true` si la passe a réellement tourné (appels modèle compris). */
  ran: boolean;
  /** Raison de l'absence de passe (absent si `ran`). */
  reason?: SessionMemoryPassReason;
  /** Détail d'échec (message du modèle), si `reason === "failed"`. */
  error?: string;
  added: number;
  updated: number;
  removed: number;
  skipped: number;
  /** Nombre d'appels (morceaux) réellement soumis au modèle. */
  chunks: number;
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
  /**
   * Déclenche la passe de SOLIDIFICATION sur la conversation ENTIÈRE au moment
   * où l'utilisateur la MET DE CÔTÉ (jamais bloquante, jamais bloquante pour la
   * mise de côté elle-même). Optionnel : un host sans mémoire n'en a pas besoin.
   */
  onSessionSetAside?(input: SessionSetAsideInput): void;
  /**
   * PASSE DE REMPLISSAGE sur la conversation ENTIÈRE, **ATTENDUE**, exécutée
   * AVANT une compaction forcée. Contrairement aux déclencheurs précédents, elle
   * rend un RÉSULTAT (ce qui a été écrit, ou pourquoi rien ne l'a été) : c'est
   * lui qui alimente le compte rendu honnête de l'interface.
   *
   * ⚠️ Ne lève JAMAIS : un échec est décrit dans le résultat (`reason:"failed"`)
   * pour que l'appelant PUISSE décider de poursuivre la compaction.
   */
  onSessionCompact?(input: SessionMemoryPassInput): Promise<SessionMemoryPassResult>;
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
  /** Aperçu des souvenirs RÉCENTS (du plus récent au plus ancien), borné. */
  list(limit: number): MemoryAdminEntry[];
  /** Met un souvenir DE CÔTÉ (archivé, jamais effacé) puis le retire du store. */
  setAside(id: string): MemorySetAsideResult;
}

/** Souvenir exposé à l'INTERFACE (aperçu, jamais au modèle). */
export interface MemoryAdminEntry {
  id: string;
  /** Date de création (ISO-8601). */
  at: string;
  cat: MemoryCategory;
  text: string;
  /** Justification éventuelle (Lot 14), absente pour les souvenirs antérieurs. */
  why?: string;
  /** Source d'origine (message/`compaction`). */
  source: string;
}

/**
 * Résultat d'une mise de côté d'UN souvenir. ⚠️ « Supprimer » = METTRE DE CÔTÉ :
 * le souvenir est d'abord copié dans le fichier de mise de côté (récupérable),
 * puis retiré du store via une ligne `delete` (journal append-only).
 */
export interface MemorySetAsideResult {
  /** `true` si un souvenir existant a été mis de côté. */
  setAside: boolean;
  /** Identifiant visé. */
  id: string;
  /**
   * Chemin ABSOLU du fichier de mise de côté (append-only), ou `null` si aucun
   * souvenir n'a été trouvé.
   */
  archivePath: string | null;
  /** Horodatage ISO-8601 de l'opération. */
  at: string;
  /** Texte du souvenir mis de côté (`""` si introuvable). */
  text: string;
}
