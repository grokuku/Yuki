/**
 * Types du LIBRAIRE de Pi-Web (recherche documentaire + web), AUCUN import
 * SDK/typebox.
 *
 * ⚠️ Les résultats de recherche peuvent venir du WEB : ce sont des DONNÉES NON
 * FIABLES. Les types restent volontairement tolérants (champs optionnels), car
 * le service peut enrichir sa réponse ; la lecture est défensive côté client.
 */

/** Configuration effective du libraire (lue à chaud depuis Yuki). */
export interface LibrarianConfig {
  /** URL de base (`http://pi-web:3000`, `http://<ip>:3005`, `https://pi.holaf.fr`). */
  baseUrl: string;
  /**
   * Jeton agent envoyé dans `Authorization: Bearer …`. ⚠️ FACULTATIF : vide, il
   * n'est pas envoyé (Libry n'a qu'UNE couche d'authentification).
   */
  agentToken: string;
  /** Clé libraire envoyée dans `X-API-Key` (`lib-…`) — champ de RÉFÉRENCE. */
  apiKey: string;
}

/** Fournisseur de configuration (lu à CHAQUE appel : bascule à chaud). */
export type LibrarianConfigProvider = () => LibrarianConfig;

/** Santé du libraire (`GET /api/librarian/status`). */
export interface LibrarianStatus {
  totalDocs?: number;
  lastUpdated?: string;
  lastScan?: string;
}

/**
 * Un résultat de recherche. `content` n'est présent QUE pour un document de la
 * bibliothèque LOCALE ; pour un résultat WEB, seuls `title`/`url`/`snippet`
 * existent (⚠️ `content` absent).
 */
export interface LibrarianSearchResult {
  title: string;
  url: string;
  snippet: string;
  content?: string;
}

/** Résultat de `POST /api/librarian/search`. */
export interface LibrarianSearchOutcome {
  results: LibrarianSearchResult[];
  archived?: boolean;
}

/** Entrée de la bibliothèque (`GET /api/librarian/library`). */
export interface LibrarianLibraryEntry {
  name: string;
  version: string;
  type?: string;
  description?: string;
  keywords?: string[];
  updatedAt?: string;
  sourceUrl?: string;
}

/** Bibliothèque complète (`GET /api/librarian/library`). */
export interface LibrarianLibrary {
  lastUpdated?: string;
  lastScan?: string;
  library: LibrarianLibraryEntry[];
}

/**
 * Document complet (`GET /api/librarian/doc/:name`). Champs connus extraits au
 * mieux + `raw` (objet brut renvoyé, jamais perdu).
 */
export interface LibrarianDoc {
  name?: string;
  version?: string;
  type?: string;
  sourceUrl?: string;
  updatedAt?: string;
  summary?: string;
  keyPoints?: string[];
  api?: string[];
  examples?: string[];
  breakingChanges?: string;
  rawContent?: string;
  /** Objet brut renvoyé par le libraire (repli d'affichage). */
  raw: unknown;
}

/**
 * Entrée d'API d'une fiche archivée (`api`), au format documenté par Pi-Web :
 * `{ signature, description }`.
 */
export interface LibrarianApiItem {
  signature: string;
  description?: string;
}

/**
 * Exemple d'usage d'une fiche archivée (`examples`), au format documenté par
 * Pi-Web : `{ title, code }`.
 */
export interface LibrarianExampleItem {
  title: string;
  code?: string;
}

/** Contenu structuré d'une archive (`POST /api/librarian/archive`). */
export interface LibrarianArchiveContent {
  summary: string;
  keyPoints: string[];
  api: LibrarianApiItem[];
  examples: LibrarianExampleItem[];
  breakingChanges?: string[];
  rawContent?: string;
}

/** Corps de `POST /api/librarian/archive`. */
export interface LibrarianArchivePayload {
  name: string;
  version: string;
  type?: string;
  sourceUrl?: string;
  content: LibrarianArchiveContent;
}

/** Accusé de réception d'une archive (201). */
export interface LibrarianArchiveReceipt {
  name: string;
  version: string;
  status: number;
}

/**
 * Port du libraire consommé par les outils du modèle. Implémenté par
 * `LibrarianClient` (HTTP) ; les tests fournissent un double.
 */
export interface LibrarianPort {
  status(signal?: AbortSignal): Promise<LibrarianStatus>;
  search(query: string, signal?: AbortSignal): Promise<LibrarianSearchOutcome>;
  library(signal?: AbortSignal): Promise<LibrarianLibrary>;
  doc(name: string, version?: string, signal?: AbortSignal): Promise<LibrarianDoc>;
  archive(payload: LibrarianArchivePayload, signal?: AbortSignal): Promise<LibrarianArchiveReceipt>;
}

/** Options d'une demande de capture (`POST /api/librarian/screenshot`). */
export interface LibrarianScreenshotOptions {
  /** Largeur du viewport (défaut Libry : 1440). */
  width?: number;
  /** Hauteur du viewport (défaut Libry : 900). */
  height?: number;
  /** Délai maximal de capture en ms (défaut Libry : 15000). */
  timeoutMs?: number;
  /** Demander les octets en ligne (défaut Libry : false). */
  inline?: boolean;
}

/** Réponse 200 de `POST /api/librarian/screenshot`. */
export interface LibrarianScreenshot {
  /** Identifiant opaque permettant de télécharger l'image via `shot(id)`. */
  id: string;
  /** Type MIME de l'image (ex. `image/png`). */
  mimeType: string;
  width?: number;
  height?: number;
  bytes?: number;
  /** URL effectivement capturée (normalisée par Libry). */
  url?: string;
  /** Origine de la capture (ex. `web`). */
  origin?: string;
}

/** Image binaire téléchargée (`GET /api/librarian/shot/:id.png`). */
export interface LibrarianShotImage {
  bytes: Uint8Array;
  mimeType: string;
}

/**
 * Port de CAPTURE de page web via Libry. Séparé de `LibrarianPort` pour ne pas
 * obliger les doubles des quatre outils existants à l'implémenter.
 */
export interface LibrarianScreenshotPort {
  screenshot(
    url: string,
    options?: LibrarianScreenshotOptions,
    signal?: AbortSignal,
  ): Promise<LibrarianScreenshot>;
  shot(id: string, signal?: AbortSignal): Promise<LibrarianShotImage>;
}

/** Port restreint de test de connexion (`GET /status`), pour la page /config. */
export interface LibrarianProbePort {
  status(signal?: AbortSignal): Promise<LibrarianStatus>;
}

/** Journalisation minimale (injectable ; jamais de secret). */
export interface LibrarianLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/**
 * Rédige la synthèse d'archivage à partir d'un prompt (appel de modèle ISOLÉ).
 * Implémenté côté SDK par une session éphémère ; les tests fournissent un double.
 * Renvoie la réponse BRUTE du modèle (chaîne vide en cas d'échec).
 */
export type LibrarianSynthesizer = (prompt: string) => Promise<string>;

/** Demande d'archivage soumise par l'outil (immédiate, jamais bloquante). */
export interface LibrarianArchiveInput {
  name: string;
  version: string;
  type?: string;
  sourceUrl?: string;
  /** Matière brute fournie par le modèle (conversation ou extrait de recherche). */
  material: string;
}

/** Issue de la SOUMISSION d'une archive en tâche de fond. */
export type LibrarianScheduleOutcome =
  | { status: "launched"; job_id: string }
  | { status: "already_pending"; job_id: string }
  | { status: "rejected"; reason: "queue_full" };

/**
 * Port de soumission d'archivage (tâche de fond). `schedule` rend la main
 * IMMÉDIATEMENT : il ne fait AUCUN appel réseau. Implémenté par
 * `LibrarianArchiveService`.
 */
export interface LibrarianArchivePort {
  schedule(
    input: LibrarianArchiveInput,
    options: { lightSessionId: string },
  ): LibrarianScheduleOutcome;
}
