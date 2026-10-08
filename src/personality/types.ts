/**
 * Domaine « personnalité » de Yuki — TYPES PUBLICS.
 *
 * La personnalité est un **texte Markdown** éditable à la main, stocké dans un
 * fichier DÉDIÉ du volume `state` (`personality.md`), **séparé** du prompt
 * système de sûreté (`prompts.light`, `config/pi/system-prompt.md`). Elle est
 * injectée à CHAQUE tour comme BASE du prompt (avant la mémoire, l'annuaire des
 * agents et le signal d'archive), et versionnée (historique + retour arrière).
 *
 * Aucun import SDK/typebox : l'injection dans la conversation est confinée à
 * `src/pi/sdk/**`.
 */

/** Source d'une écriture de personnalité (qui l'a produite). */
export type PersonalitySource = "user" | "model";

/** Lecture de la personnalité (contenu effectif, borné). */
export interface PersonalityDocument {
  /** Contenu effectif (borné à `PersonalityAdminPort.maxChars`). */
  text: string;
  /** Nombre de caractères (points de code) du contenu effectif. */
  chars: number;
  /** `true` si le fichier dépassait la borne et a été tronqué à la lecture. */
  truncated: boolean;
  /** `false` si le fichier n'existe pas (alors `text` est vide). */
  exists: boolean;
}

/**
 * Port MINIMAL consommé par l'extension SDK : lire la personnalité à chaud,
 * sans jamais lever.
 */
export interface PersonalityPort {
  /** Lit la personnalité FRAÎCHE (le fichier est relu à chaque tour). */
  read(): PersonalityDocument;
}

/** Sous-ensemble du logger d'observabilité utilisé par le domaine. */
export interface PersonalityLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** Version de l'historique (snapshot horodaté). */
export interface PersonalityHistoryEntry {
  /** Identifiant du snapshot (horodatage contenu dans le nom de fichier). */
  at: string;
  /** Contenu de la version. */
  text: string;
  /** Nombre de caractères du contenu (borné). */
  chars: number;
}

/** Résultat d'une écriture (ou d'un retour arrière). */
export interface PersonalityWriteResult {
  /** `false` si le contenu était identique à l'actuel (aucune écriture). */
  changed: boolean;
  /** Contenu effectif après l'opération. */
  text: string;
  chars: number;
  /** `true` si le contenu fourni a été tronqué à la borne. */
  truncated: boolean;
  /** Nombre de caractères du contenu AVANT l'opération. */
  beforeChars: number;
}

/**
 * Entrée du journal (`personality-journal.jsonl`). `before`/`after` sont
 * REDACTÉS (aucun secret de l'environnement n'y apparaît).
 */
export interface PersonalityJournalEntry {
  v: 1;
  at: string;
  source: PersonalitySource;
  beforeChars: number;
  afterChars: number;
  truncated: boolean;
  before: string;
  after: string;
}

/**
 * Port d'ADMINISTRATION (API `/api/self/personality`) : lecture + écriture
 * atomique + historique/réversion. Implémenté par `PersonalityStore`.
 */
export interface PersonalityAdminPort extends PersonalityPort {
  /** Borne de caractères (points de code) appliquée aux écritures et lectures. */
  readonly maxChars: number;
  /** Écrit (atomique) + snapshot + journal. Tronque à la borne (signalé). */
  write(text: string, source: PersonalitySource): PersonalityWriteResult;
  /** Restaure la version précédente (la plus récente différente de l'actuelle). */
  revert(source: PersonalitySource): PersonalityWriteResult | null;
  /** Versions de l'historique, de la plus récente à la plus ancienne. */
  history(limit?: number): PersonalityHistoryEntry[];
}
