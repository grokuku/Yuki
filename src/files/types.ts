/**
 * FICHIERS ÉCHANGÉS avec l'utilisateur — types et bornes.
 *
 * Deux sens :
 *  - l'utilisateur ENVOIE un fichier (bouton / glisser-déposer) → il est stocké
 *    sur disque, ANALYSÉ une fois, et son analyse est CONSERVÉE (30 jours par
 *    défaut) pour qu'elle serve de contexte aux tours suivants sans être refaite ;
 *  - Yuki ENVOIE un fichier (un fichier reçu, ou un fichier venu d'un agent) →
 *    il apparaît dans le fil, cliquable et téléchargeable.
 *
 * ⚠️ Le CONTENU d'un fichier est une DONNÉE, JAMAIS une instruction : il est
 * encadré par `<fichiers>` (voir `frame.ts`) avant d'atteindre le modèle.
 *
 * ⚠️ Aucun contenu ni extrait d'analyse n'est journalisé : seules des
 * MÉTADONNÉES (identifiant, nom assaini, taille, type, genre) le sont.
 */

/** Nature de l'analyse faite UNE fois à l'envoi. */
export type FileKind = "text" | "image" | "pdf" | "unknown";

/** Qui a déposé le fichier dans le stockage. */
export type FileOrigin = "user" | "yuki" | "externe";

/**
 * Résultat d'analyse CONSERVÉ avec le fichier.
 *
 * `readable` dit la VÉRITÉ sur ce que Yuki peut lire : un PDF (le libraire
 * n'expose aucune extraction de texte) ou un binaire ne sont PAS lisibles, et
 * `reason` le dit en une phrase (elle est transmise au modèle et affichée).
 */
export interface FileAnalysis {
  kind: FileKind;
  /** `true` si le TEXTE extrait est exploitable par le modèle. */
  readable: boolean;
  /** Raison HONNÊTE quand `readable` est faux (phrase française). */
  reason?: string;
  /** Nombre de caractères conservés pour l'analyse. */
  chars?: number;
  /** `true` si l'extraction a été coupée (fichier plus long que la borne). */
  truncated?: boolean;
  /** Octets réellement lus sur le disque pour produire l'analyse. */
  readBytes?: number;
  /** Dimensions d'une image, quand elles sont décodables sans dépendance. */
  width?: number;
  height?: number;
}

/** Fiche d'un fichier stocké (métadonnées seules, jamais le contenu). */
export interface StoredFileRecord {
  /** Identifiant ALÉATOIRE (hexadécimal 32) : jamais un nom fourni. */
  id: string;
  /** Nom d'affichage, ASSAINI (aucun `../`, aucun caractère de contrôle). */
  name: string;
  /** Type MIME normalisé (déclaré au dépôt, jamais déduit du contenu seul). */
  mimeType: string;
  /** Extension normalisée (`[a-z0-9]{1,10}`, sinon `bin`) : allowlist de service. */
  ext: string;
  bytes: number;
  /** Instant du dépôt (ISO 8601). */
  createdAt: string;
  /** Instant de suppression (ISO 8601) : fichier ET analyse. */
  expiresAt: string;
  origin: FileOrigin;
  /**
   * Conversation à laquelle le fichier est rattaché (posée à l'ENVOI du message,
   * jamais devinée). Absente tant que le fichier n'a pas été envoyé.
   */
  sessionId?: string;
  analysis: FileAnalysis;
}

/** Vue d'un fichier destinée au client (JSON de l'API et trame de contrôle). */
export interface WireFile {
  id: string;
  name: string;
  mimeType: string;
  bytes: number;
  kind: FileKind;
  readable: boolean;
  reason?: string;
  truncated?: boolean;
  /** Chemin SAME-ORIGIN de service (`/fichiers/<id>.<ext>`) — téléchargement. */
  url: string;
  /** Même chemin pour une image : affichable (`img-src 'self'`). */
  imageSrc?: string;
  createdAt: string;
  expiresAt: string;
}

/**
 * Dépôt refusé (jamais silencieux : le code porte la cause exacte).
 *
 * ⚠️ Les codes `digest_mismatch` et `interrupted` viennent du TRANSFERT depuis
 * une machine (`src/agents/transfer.ts`) : une empreinte fausse ou un flux coupé
 * supprime ce qui a été écrit — jamais un fichier partiel ou corrompu publié.
 */
export type FileRejectionCode =
  | "too_large"
  | "empty"
  | "empty_name"
  | "io_error"
  | "digest_mismatch"
  | "interrupted";

export type FileSaveResult =
  | { ok: true; record: StoredFileRecord }
  | { ok: false; code: FileRejectionCode; receivedBytes: number; limitBytes: number };

/**
 * Écrivain borné d'un fichier reçu par morceaux.
 *
 * ⚠️ Aucune publication avant `commit()` : la destination finale n'existe
 * qu'une fois le flux complet (et son empreinte, vérifiée par l'appelant).
 */
export interface FileSink {
  /** Écrit un morceau ; `ok: false` (avec code) si le plafond est dépassé. */
  write(chunk: Uint8Array): { ok: true } | { ok: false; code: FileRejectionCode; receivedBytes: number; limitBytes: number };
  /** Octets déjà écrits. */
  readonly receivedBytes: number;
  /**
   * Publie le fichier (`<id>.bin` + métadonnées + analyse). ⚠️ Refuse un flux
   * vide (`empty`).
   */
  commit(): FileSaveResult;
  /** Supprime le fichier partiel (idempotent). */
  abort(): void;
}

/** Entrée d'un dépôt (le flux d'octets arrive par le corps HTTP). */
export interface FileSaveInput {
  /** Nom fourni par le client — ASSAINI par le stockage. */
  name: string;
  /** Type MIME déclaré (`application/octet-stream` si inconnu). */
  mimeType: string;
  origin: FileOrigin;
  /** Conversation déjà connue au dépôt (facultative : posée à l'envoi sinon). */
  sessionId?: string;
}

/**
 * Port de stockage des fichiers, consommé par les routes HTTP, le transport WS
 * et l'outil d'envoi. Découplé du disque : les tests fournissent un double.
 */
export interface FilesPort {
  /** Enregistre un flux d'octets (borné) et son analyse. */
  saveStream(
    source: AsyncIterable<Uint8Array>,
    input: FileSaveInput,
  ): Promise<FileSaveResult>;
  /** Enregistre des octets déjà en mémoire (outil, tests, déposant externe). */
  saveBytes(data: Uint8Array, input: FileSaveInput): FileSaveResult;
  get(id: string): StoredFileRecord | null;
  /** Octets bruts (service) — `null` si absent ou expiré. */
  readBytes(id: string): Buffer | null;
  /** Texte d'analyse conservé — `null` s'il n'y en a pas. */
  readAnalysis(id: string): string | null;
  list(filter?: { sessionId?: string }): StoredFileRecord[];
  /** Rattache un fichier à une conversation (posé à l'envoi du message). */
  attach(id: string, sessionId: string): StoredFileRecord | null;
  /** Supprime le fichier ET son analyse. Renvoie `true` s'il existait. */
  remove(id: string): boolean;
  /** Purge tout ce qui a expiré. Renvoie le nombre de fichiers supprimés. */
  purgeExpired(): number;
  /** Convertit une fiche en vue client (aucun contenu). */
  toWire(record: StoredFileRecord): WireFile;
  /**
   * Ouvre un ÉCRIVAIN BORNÉ pour un flux d'octets ARRIVANT PAR MORCEAUX (ex.
   * transfert depuis une machine). ⚠️ Les octets vont dans `<id>.bin.part` ;
   * seul `commit()` publie le fichier final (`rename`) et produit la fiche.
   * `abort()` supprime le partiel : un transfert refusé n'occupe JAMAIS le
   * disque. Le plafond `maxBytes` est vérifié À CHAQUE morceau.
   */
  createSink(input: FileSaveInput): FileSink;
}

/**
 * Image d'un message utilisateur, dans la FORME que le modèle attend
 * (`ImageContent` du SDK) : base64 + type MIME. ⚠️ Type LOCAL : la façade `src/pi`
 * ne dépend jamais du SDK, c'est `sdk-host.ts` qui projette cette forme sur le
 * type du SDK.
 */
export interface FileImageContent {
  /** Octets de l'image en base64 (jamais journalisé, jamais dans une trame). */
  data: string;
  mimeType: string;
}

/**
 * Issue de la préparation des images d'un message.
 *
 * ⚠️ Un refus n'est JAMAIS partiel : `ok: false` ⇒ l'image fautive est nommée
 * et le message entier n'est pas envoyé (patron `files_unavailable`).
 */
export type FileImagesOutcome =
  | { ok: true; images: FileImageContent[] }
  | { ok: false; code: string; message: string };

/** Ce que le transport reçoit quand Yuki envoie un fichier (trame de contrôle). */
export interface FilesGatewayPort {
  /**
   * Résout et RATTACHE les fichiers d'un message utilisateur, puis renvoie le
   * texte à afficher (marqueurs) et le bloc DONNÉE borné destiné au modèle.
   * Ids inconnus/expirés : écartés (jamais une erreur silencieuse — la liste
   * des écartés est renvoyée).
   */
  attach(
    sessionId: string,
    ids: readonly string[],
  ): { files: WireFile[]; markers: string[]; block?: string; missing: string[] };
  /** S'abonne aux fichiers ENVOYÉS PAR YUKI. Renvoie le désabonnement. */
  subscribeSent(listener: (view: WireFile & { sessionId: string }) => void): () => void;
  /**
   * Prépare les IMAGES d'un message pour le modèle (`ImageContent` : base64 +
   * type MIME).
   *
   * ⚠️ Les fichiers d'un autre genre sont ignorés : leur contenu part dans le
   * bloc `<fichiers>`, jamais en pièce jointe.
   *
   * ⚠️ RÉDUCTION À LA VOLÉE : une image trop lourde ou trop définie est réduite
   * ICI, au moment de construire le message — la version réduite est ÉPHÉMÈRE
   * (aucune écriture, aucun cache) et l'original stocké n'est jamais modifié.
   *
   * ⚠️ GARDE-FOU ULTIME `files.imageMaxBytes` (poids du FICHIER) **et**
   * `files.imageMaxWireBytes` (poids TRANSMIS, base64 ×1,33 — celui que voit le
   * fournisseur) : si la réduction n'aboutit pas (ou rendrait l'image illisible),
   * `ok: false` avec un message français nommant le fichier — l'appelant n'envoie
   * alors RIEN (jamais de troncature silencieuse), et ce refus arrive **AVANT**
   * l'appel au fournisseur.
   */
  prepareImages(files: readonly WireFile[]): Promise<FileImagesOutcome>;
}

/**
 * Consultation en LECTURE SEULE des fichiers d'une conversation (métadonnées
 * seules, jamais le contenu). Sert à deux usages distincts :
 *  - `envoyer_fichier` (léger) : savoir ce qu'il peut renvoyer à l'utilisateur ;
 *  - `lister_fichiers` + liste automatique du worker lourd : connaître les
 *    IDENTIFIANTS des pièces jointes (indispensable pour `deposer_fichier`).
 */
export interface FilesListPort {
  /** Fichiers d'une conversation, du plus ancien au plus récent. */
  listForSession(sessionId: string): WireFile[];
}

/**
 * LECTURE du CONTENU d'une pièce jointe (worker lourd).
 *
 * ⚠️ POURQUOI CE PORT EXISTE : `lister_fichiers` ne rend que des MÉTADONNÉES
 * (identifiant, nom, genre, taille). Le worker savait donc qu'une image existait,
 * sans jamais pouvoir en lire un OCTET — il ne pouvait ni la voir, ni lire un
 * fichier texte du store (ce fichier n'est PAS sur un chemin que `read` atteint).
 * `lire_fichier` comble ce trou, et ce port lui donne les octets, l'analyse
 * conservée et la politique de VISION partagée (`prepareImages`), sans exposer
 * le disque.
 *
 * ⚠️ `FilesService` (`src/files/service.ts`) satisfait cette interface tel quel :
 * le câblage n'ajoute aucune pièce, il ouvre la lecture.
 */
export interface FilesReadPort extends FilesListPort {
  /** Fiche d'un fichier (métadonnées + analyse), `null` si absent ou expiré. */
  get(id: string): StoredFileRecord | null;
  /** Octets bruts, `null` si absent ou expiré. Jamais journalisés. */
  readBytes(id: string): Buffer | null;
  /**
   * Politique de VISION partagée (bornes, réduction éphémère, refus explicite).
   * ⚠️ C'est la MÊME que celle des pièces jointes d'un message : un seul chemin,
   * donc une seule vérité sur ce que le modèle reçoit.
   */
  prepareImages(files: readonly WireFile[]): Promise<FileImagesOutcome>;
}

/** Consommation de l'outil `envoyer_fichier` (léger) : envoi par Yuki. */
export interface FilesSendPort extends FilesListPort {
  /**
   * Envoie un fichier de la conversation à l'utilisateur (identifiant OU nom
   * exact). Renvoie la vue, ou `null` si aucun fichier ne correspond.
   */
  send(sessionId: string, reference: string): WireFile | null;
}

// ── Bornes (constantes, surchargées par la configuration) ──────────────────

/** Longueur maximale du nom d'affichage après assainissement. */
export const MAX_FILE_NAME_CHARS = 120;

/** Plafond de taille PAR FICHIER (2 Gio) — défaut de `files.maxFileBytes`. */
export const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;

/** Plafond de taille autorisé par la configuration (8 Gio). */
export const MAX_ALLOWED_FILE_BYTES = 8 * 1024 * 1024 * 1024;

/** Octets lus sur le disque pour produire l'analyse (jamais le fichier entier). */
export const MAX_ANALYSIS_READ_BYTES = 2 * 1024 * 1024;

/** Caractères d'analyse CONSERVÉS (au-delà, l'extrait est coupé et on le dit). */
export const MAX_STORED_ANALYSIS_CHARS = 20_000;

/** Nombre maximal de fichiers joints à UN message. */
export const DEFAULT_MAX_ATTACHMENTS = 5;

/** Caractères transmis au modèle PAR fichier — défaut de `files.promptChars`. */
export const DEFAULT_PROMPT_CHARS_PER_FILE = 12_000;

/** Caractères transmis au modèle pour TOUS les fichiers d'un message. */
export const DEFAULT_PROMPT_TOTAL_CHARS = 24_000;

/** Rétention par défaut (jours) — défaut de `files.retentionDays`. */
export const DEFAULT_RETENTION_DAYS = 30;

/**
 * Plafond en OCTETS BRUTS d'une image transmise au MODÈLE — défaut de
 * `files.imageMaxBytes`.
 *
 * ⚠️ C'est la bonne borne pour ce qu'on accepte de LIRE/RÉDUIRE, PAS pour ce
 * qu'on ÉMET : sur le fil, le base64 pèse ×1,33 (voir
 * `DEFAULT_IMAGE_MAX_WIRE_BYTES`).
 */
export const DEFAULT_IMAGE_MAX_BYTES = 3_500_000;

/**
 * Plafond en OCTETS TRANSMIS (base64, ce qui part réellement sur le fil) —
 * défaut de `files.imageMaxWireBytes`.
 *
 * ⚠️ POURQUOI CETTE BORNE EXISTE (incident mesuré du 2026-11-01) : une image de
 * 2 876 Ko / 2231×961 était bien RÉDUITE (côté 2 000 px), mais le plafond
 * `files.imageMaxBytes` raisonnait en octets d'ORIGINE : traduit en budget base64
 * (×4/3) il laissait partir jusqu'à **4 666 668 octets** sur le fil. Le
 * fournisseur a répondu `500 « request entity too large »` après 17 s et 0 jeton
 * produit — c'est-à-dire que la réduction était juste, mais son UNITÉ fausse.
 *
 * 700 000 octets base64 (~0,67 Mio) — la CIBLE est « quelques centaines de Ko »,
 * pas « sous les 5 Mo du fournisseur » :
 *  - le chemin qui FONCTIONNE (même image, même modèle, même fournisseur, envoyée
 *    par un client qui ré-encode) part à **479,5 Ko** sur 2000×861 : c'est la
 *    référence mesurée, pas une valeur inventée ;
 *  - 700 000 laisse à un JPEG qualité 80 en 2000 px la marge nécessaire pour
 *    rester sous ~1 Mo même sur une image très détaillée, et garde le corps HTTP
 *    du tour (texte + historique) loin des plafonds de proxys (~4 Mio) ;
 *  - un PNG qui tient sous ce budget est conservé (transparence préservée) ; sinon
 *    le SDK RÉ-ENCODE (JPEG q80 → q40), ce qui ne change pas les dimensions
 *    lisibles mais divise le poids par 5 à 15.
 *
 * ⚠️ Mesuré sur cette machine : image 2231×961 de 3 120 Ko, côté ramené à 2000 px —
 * avec l'ancien budget (4 666 668 base64) le SDK gardait le PNG et émettait
 * **3 208 Ko** ; avec 700 000 il ré-encode en JPEG et émet **208 Ko**, à
 * dimensions identiques (2000×861).
 *
 * ⚠️ Réglable dans `/config` : un fournisseur plus permissif peut le monter sans
 * redémarrage (`apply: hot`).
 */
export const DEFAULT_IMAGE_MAX_WIRE_BYTES = 700_000;
