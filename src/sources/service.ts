/**
 * `SourcesService` — CŒUR du chantier « sources » : réception authentifiée,
 * idempotence, drain GROUPÉ vers le modèle, boîte de notifications, réponse
 * attachée à l'entrée, fil de source créé quand « lancer » l'exige.
 *
 * ## Ce que ce service ne fait JAMAIS
 *  - il ne crée JAMAIS un fil SANS destination configurée : `aucune` ⇒ aucun fil,
 *    aucune supposition, une raison actionnable et le message conservé ; en mode
 *    `stocker`, aucun fil n'est créé non plus ;
 *  - il ne cache JAMAIS un fil : celui qu'il crée (`source`, `nouvelle`) est un fil
 *    NORMAL, VISIBLE dans la liste des conversations (`Source — <nom>`) ;
 *  - il n'injecte JAMAIS de contenu dans un tour EN COURS : le drain des entrées
 *    en attente se fait au DÉBUT du tour suivant, en UN SEUL envoi (protection du
 *    TTFT) ;
 *  - il ne journalise jamais un contenu ni un jeton (source, identifiant, état,
 *    raison seulement) ;
 *  - il ne SUPPRIME jamais une source quand un fil disparaît : il la réaffecte et
 *    le DIT (entrée d'alerte dans la boîte).
 *
 * ## Modèle d'exécution du « drain groupé »
 * Les entrées `stocker` (ou les `lancer` qui n'ont pas pu partir : `PI_NOT_READY`,
 * `LLM_UNAVAILABLE`, aucune conversation ouverte) restent `enAttente`. Le host Pi
 * appelle `takePending(runId)` au DÉBUT de chaque tour : le service renvoie UN
 * bloc `<sources>` contenant TOUTES les entrées en attente et retient `runId →
 * [ids]`. À `run_finished`, la réponse du tour est attachée à ces entrées
 * (`etat: "traite"` + `reponse`), jamais dans un fil.
 *
 * Aucun import SDK/typebox : le host est décrit structurellement (port étroit).
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { frameSources, ORIGIN_SOURCE } from "./frame.js";
import { InboxFullError, SourcesInbox } from "./inbox.js";
import { SourcesStore } from "./store.js";
import {
  isSourceDestination,
  MAX_REPLY_CHARS,
  MAX_TITRE_CHARS,
  SOURCE_MESSAGE_ID_PATTERN,
  SOURCE_RATE_LIMIT_PER_MINUTE,
  sourceTokenName,
  type InboxEntry,
  type SourceConversation,
  type SourceConversationView,
  type SourceDelivery,
  type SourceMessageInput,
  type SourceRecord,
  type SourceView,
} from "./types.js";

/** Journal minimal (le logger d'observabilité le satisfait). */
export interface SourcesLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** Erreur portant le STATUT HTTP attendu (message en français, jamais un secret). */
export class SourceApiError extends Error {
  override readonly name = "SourceApiError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** Événement de host dont le service a besoin (forme structurelle, sans SDK). */
export type SourcesHostEvent =
  | { type: "delta"; sessionId: string; runId: string; channel: string; text: string }
  | { type: "run_finished"; sessionId: string; runId: string; reason: string; errorMessage?: string }
  | { type: string; runId?: string };

/** Port étroit vers le host Pi (le `PiHost` réel le satisfait). */
export interface SourcesWaker {
  currentSessionId(): string | undefined;
  send(
    sessionId: string,
    text: string,
    opts?: { origin?: string },
  ): { runId: string; sessionId: string };
  subscribeAll(listener: (event: SourcesHostEvent) => void): () => void;
  newSession(): Promise<{ sessionId: string }>;
  renameSession?(id: string, title: string): Promise<void>;
  resume(sessionFile: string): Promise<{ sessionId: string }>;
  /**
   * Chemin du fichier d'une conversation. Optionnel : un host qui ne sait pas le
   * retrouver ne permet PAS de conclure qu'un fil a disparu (voir `sessionAlive`).
   */
  sessionFileFor?(id: string): Promise<string | undefined>;
  /**
   * Conversations EXISTANTES (sélecteur « Envoyer dans : » de `/config`, et
   * vérification « ce fil existe-t-il encore ? » à chaque réception).
   * Optionnel : un host qui ne sait pas lister ne permet aucune vérification (on
   * ne devine alors JAMAIS qu'un fil a disparu).
   */
  listSessions?(): Promise<
    Array<{ sessionId: string; title?: string; name?: string; updatedAt?: string }>
  >;
}

/** Port étroit vers le COFFRE (les jetons n'en sortent que par `lookup`). */
export interface SourcesTokenVault {
  isConfigured(): boolean;
  lookup(name: string): string | undefined;
  has(name: string): boolean;
  set(name: string, value: string, label?: string): unknown;
  delete(name: string): boolean;
}

export interface SourcesServiceOptions {
  store: SourcesStore;
  inbox: SourcesInbox;
  logger: SourcesLogger;
  /** Coffre des jetons. Absent ⇒ aucun message ne peut être authentifié. */
  tokens?: SourcesTokenVault;
  /** Injection au modèle. Absent ⇒ tout est stocké (raison exacte rendue). */
  waker?: SourcesWaker;
  /** Borne d'injection au modèle, relue à chaud (`sources.promptTotalChars`). */
  promptTotalChars: () => number;
  /** Notification de l'appareil (Web Push). Jamais bloquant, jamais fatal. */
  notify?: (event: { source: string; titre: string; entree: InboxEntry }) => void;
  now?: () => number;
}

/** Réponse de `openConversation`. */
export interface SourceOpenResult {
  entree: InboxEntry;
  sessionId: string;
  /** `true` si la conversation vient d'être CRÉÉE par ce clic. */
  created: boolean;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Code d'erreur du host (`PI_NOT_READY`, `LLM_UNAVAILABLE`…) s'il est connu. */
function errorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return undefined;
}

/**
 * Raison EXACTE d'un message laissé dans la boîte. On ne devine pas : on nomme
 * le code rendu par le host quand il en fournit un.
 */
export function describeWakeFailure(error: unknown): string {
  const code = errorCode(error);
  if (code === "PI_NOT_READY") {
    return (
      "Yuki n'est pas prête (host Pi non démarré) : le message est conservé et sera " +
      "transmis au début du prochain tour."
    );
  }
  if (code === "LLM_UNAVAILABLE") {
    return (
      "Aucun modèle n'est configuré pour le rôle chat (clé absente ou modèle non " +
      "défini) : le message est conservé et sera transmis au début du prochain tour."
    );
  }
  if (code === "PI_SESSION_ERROR") {
    return (
      "La conversation visée n'est plus ouverte : le message est conservé et sera " +
      "transmis au début du prochain tour."
    );
  }
  return `Le tour n'a pas pu démarrer (${code ?? "cause inconnue"} : ${messageOf(error)}) : le message est conservé.`;
}

/** Comparaison à TEMPS CONSTANT de deux jetons (longueurs différentes incluses). */
export function tokensMatch(expected: string | undefined, provided: string): boolean {
  if (typeof expected !== "string" || expected.length === 0) return false;
  if (typeof provided !== "string" || provided.length === 0) return false;
  // On compare des EMPREINTES de taille fixe : la durée ne dépend donc ni de la
  // longueur ni de la position du premier octet différent.
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(provided).digest();
  return timingSafeEqual(a, b);
}

/** Valide le corps d'un message de source. Lève `SourceApiError(400)`. */
export function validateMessage(body: unknown): SourceMessageInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new SourceApiError(400, "invalid_body", "Objet JSON attendu.");
  }
  const raw = body as Record<string, unknown>;
  const id = typeof raw["id"] === "string" ? raw["id"].trim() : "";
  if (!SOURCE_MESSAGE_ID_PATTERN.test(id)) {
    throw new SourceApiError(
      400,
      "invalid_id",
      "Champ « id » requis : 1 à 128 caractères parmi « A-Z », « a-z », « 0-9 », « . », « _ », « : » et « - ».",
    );
  }
  if (typeof raw["texte"] !== "string") {
    throw new SourceApiError(400, "invalid_texte", "Champ « texte » (chaîne) requis.");
  }
  const texte = raw["texte"];
  if (texte.trim().length === 0) {
    throw new SourceApiError(400, "empty_texte", "Le champ « texte » est vide.");
  }
  const titre = typeof raw["titre"] === "string" ? raw["titre"].trim().slice(0, MAX_TITRE_CHARS) : "";
  const tour = raw["tour"];
  if (tour !== undefined && tour !== "lancer" && tour !== "stocker") {
    throw new SourceApiError(400, "invalid_tour", 'Champ « tour » : "lancer" ou "stocker" attendu.');
  }
  const conversation = raw["conversation"];
  // ⚠️ Un client EXTERNE ne peut envoyer qu'un MODE : jamais un identifiant de
  // conversation (la destination d'une source est une décision de l'utilisateur,
  // prise dans `/config`).
  if (
    conversation !== undefined &&
    conversation !== "source" &&
    conversation !== "nouvelle" &&
    conversation !== "courante" &&
    conversation !== "aucune"
  ) {
    throw new SourceApiError(
      400,
      "invalid_conversation",
      'Champ « conversation » : "aucune", "source", "nouvelle" ou "courante" attendu ' +
        "(un identifiant de conversation ne s'envoie jamais en clair).",
    );
  }
  const notifier = raw["notifier"];
  if (notifier !== undefined && typeof notifier !== "boolean") {
    throw new SourceApiError(400, "invalid_notifier", "Champ « notifier » : booléen attendu.");
  }
  return {
    id,
    texte,
    ...(titre !== "" ? { titre } : {}),
    ...(tour !== undefined ? { tour } : {}),
    ...(notifier !== undefined ? { notifier } : {}),
    ...(conversation !== undefined ? { conversation } : {}),
  };
}

export class SourcesService {
  private readonly store: SourcesStore;
  private readonly inbox: SourcesInbox;
  private readonly logger: SourcesLogger;
  private readonly tokens?: SourcesTokenVault;
  /**
   * Host Pi (moteur des tours). ⚠️ Posé APRÈS la création du service
   * (`setWaker`) : l'API des sources reste disponible en mode dégradé (gérer une
   * source et lire la boîte ne demande AUCUN modèle).
   */
  private waker?: SourcesWaker;
  private readonly promptTotalChars: () => number;
  private readonly notify?: SourcesServiceOptions["notify"];
  private readonly now: () => number;
  /** Fenêtres d'appels par source (glissantes sur 60 s) — mémoire seule. */
  private readonly calls = new Map<string, number[]>();
  /** Runs en cours de livraison : `runId → ids d'entrées à créditer`. */
  private readonly runs = new Map<string, { ids: string[]; text: string }>();
  private unsubscribe: (() => void) | undefined;

  constructor(options: SourcesServiceOptions) {
    this.store = options.store;
    this.inbox = options.inbox;
    this.logger = options.logger;
    this.tokens = options.tokens;
    this.waker = options.waker;
    this.promptTotalChars = options.promptTotalChars;
    this.notify = options.notify;
    this.now = options.now ?? Date.now;
  }

  /**
   * Branche le host Pi (réveil + suivi des réponses). Idempotent : le service
   * remplace simplement son port et ré-abonne son écouteur.
   */
  setWaker(waker: SourcesWaker): void {
    this.waker = waker;
    this.detach();
    this.attach();
  }

  /** Branche le suivi des réponses (un seul abonnement, idempotent). */
  attach(): void {
    if (this.unsubscribe || !this.waker) return;
    this.unsubscribe = this.waker.subscribeAll((event) => this.onEvent(event));
  }

  /** Débranche le suivi (arrêt gracieux). */
  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** Sources déclarées, avec « un jeton existe-t-il ? » (jamais sa valeur). */
  list(): SourceView[] {
    return this.store
      .list()
      .map((record) => this.store.view(record, this.hasToken(record.nom)));
  }

  /** Une source, ou `undefined`. */
  get(nom: string): SourceView | undefined {
    const record = this.store.get(nom);
    return record ? this.store.view(record, this.hasToken(nom)) : undefined;
  }

  /** Crée une source (aucun jeton : il se crée par `POST …/jeton`). */
  create(nom: string, settings: Parameters<SourcesStore["create"]>[1]): SourceView {
    const record = this.store.create(nom, settings);
    this.logger.info("sources.created", {
      source: record.nom,
      tour: record.tour,
      conversation: record.conversation,
    });
    return this.store.view(record, this.hasToken(record.nom));
  }

  /** Modifie les réglages d'une source. */
  update(nom: string, settings: Parameters<SourcesStore["update"]>[1]): SourceView {
    const record = this.store.update(nom, settings);
    this.logger.info("sources.updated", {
      source: record.nom,
      tour: record.tour,
      conversation: record.conversation,
    });
    return this.store.view(record, this.hasToken(record.nom));
  }

  /** Supprime une source ET son jeton de coffre. */
  remove(nom: string): boolean {
    const removed = this.store.remove(nom);
    if (!removed) return false;
    try {
      this.tokens?.delete(sourceTokenName(nom));
    } catch (error) {
      this.logger.warn("sources.token.delete_failed", { source: nom, error: messageOf(error) });
    }
    this.calls.delete(nom);
    this.logger.info("sources.removed", { source: nom });
    return true;
  }

  /**
   * Crée (ou REMPLACE) le jeton d'une source. ⚠️ La valeur n'est renvoyée qu'UNE
   * fois, ici ; elle n'est ni journalisée ni relue ensuite.
   */
  createToken(nom: string): string {
    const record = this.store.get(nom);
    if (!record) throw new SourceApiError(404, "unknown_source", `Source inconnue : « ${nom} ».`);
    const vault = this.tokens;
    if (!vault || !vault.isConfigured()) {
      throw new SourceApiError(
        503,
        "vault_locked",
        "Coffre de secrets indisponible (variable YUKI_VAULT_KEY absente) : " +
          "impossible d'enregistrer le jeton d'une source.",
      );
    }
    const token = randomBytes(32).toString("base64url");
    vault.set(sourceTokenName(nom), token, `Jeton de la source « ${nom} »`);
    this.store.markTokenCreated(nom);
    this.logger.info("sources.token.created", { source: nom });
    return token;
  }

  private hasToken(nom: string): boolean {
    try {
      return this.tokens?.has(sourceTokenName(nom)) === true;
    } catch {
      return false;
    }
  }

  // ── Réception d'un message ────────────────────────────────────────────────

  /**
   * Reçoit un message de source. Lève `SourceApiError` (401/404/400/429) ou
   * renvoie la livraison (`started` / `stored` / `duplicate`).
   */
  async receive(nom: string, token: string, body: unknown): Promise<SourceDelivery> {    const record = this.store.get(nom);
    if (!record) {
      // ⚠️ La source est vérifiée AVANT le jeton : une source inconnue est un 404
      // explicite (aucun jeton ne peut exister pour elle).
      throw new SourceApiError(404, "unknown_source", `Source inconnue : « ${nom} ».`);
    }
    let expected: string | undefined;
    try {
      expected = this.tokens?.lookup(sourceTokenName(nom));
    } catch (error) {
      this.logger.warn("sources.token.lookup_failed", { source: nom, error: messageOf(error) });
      expected = undefined;
    }
    if (!tokensMatch(expected, token)) {
      this.logger.warn("sources.message.unauthorized", { source: nom });
      throw new SourceApiError(
        401,
        "invalid_token",
        "Jeton invalide (ou absent) : il doit correspondre au jeton de CETTE source.",
      );
    }

    const message = validateMessage(body);
    const octets = Buffer.byteLength(message.texte, "utf8");
    // Idempotence : même `(source, id)` ⇒ aucun SECOND tour, réponse dédiée.
    if (this.inbox.hasSeen(nom, message.id)) {
      const previous = this.inbox
        .list()
        .find((entry) => entry.source === nom && entry.sourceId === message.id);
      this.logger.info("sources.message.duplicate", { source: nom, entry_id: previous?.id ?? null });
      // L'entrée peut avoir été supprimée par l'utilisateur : on répond quand même
      // « doublon », sans rien recréer (le message a DÉJÀ été traité une fois).
      return previous ? { outcome: "duplicate", entree: previous } : { outcome: "duplicate" };
    }

    this.enforceRateLimit(nom);

    // ④ À CHAQUE réception : le fil visé existe-t-il ENCORE ? S'il a disparu
    // (supprimé, mis de côté, écrasé par une autre instance), on bascule
    // PROPREMENT et on le DIT dans l'entrée — jamais un échec muet.
    const checked = await this.checkTarget(record);
    const current = checked.record;
    // ⚠️ `conversation` est relue APRÈS la vérification : une bascule de ④ doit
    // s'appliquer au message en cours, pas seulement au suivant.
    const tour = message.tour ?? current.tour;
    const conversation = message.conversation ?? current.conversation;
    const notifier = message.notifier ?? current.notifier;

    let entry: InboxEntry;
    try {
      entry = this.inbox.add({
        source: nom,
        texte: message.texte,
        ...(message.titre !== undefined ? { titre: message.titre } : {}),
        octets,
        enAttente: tour === "stocker",
        ...(checked.note !== undefined ? { note: checked.note } : {}),
        sourceId: message.id,
      });
    } catch (error) {
      if (error instanceof InboxFullError) {
        this.logger.warn("sources.inbox.full", { source: nom, limit: this.inbox.limit });
        throw new SourceApiError(429, "inbox_full", error.message, { limit: this.inbox.limit });
      }
      throw error;
    }
    this.inbox.markSeen(nom, message.id);
    this.store.markCall(nom);

    if (notifier) this.emitNotification(current, entry);

    if (tour === "stocker") {
      this.logger.info("sources.message.stored", {
        source: nom,
        entry_id: entry.id,
        tour,
        conversation: current.conversation,
      });
      return { outcome: "stored", entree: entry };
    }

    // `lancer` : il FAUT que le tour démarre. Le fil visé est résolu — et créé
    // (fil NORMAL, VISIBLE) s'il n'existe pas encore (voir `resolveTarget`).
    const target = await this.resolveTarget(current, conversation);
    if (target.raison !== undefined || target.sessionId === undefined) {
      const raison = target.raison ?? "Aucune conversation disponible : le message est conservé.";
      entry = this.inbox.update(entry.id, { enAttente: true, raison }) ?? entry;
      this.logger.info("sources.message.stored", {
        source: nom,
        entry_id: entry.id,
        tour,
        conversation: current.conversation,
        raison: "no_conversation",
      });
      return { outcome: "stored", entree: entry, raison };
    }

    // ⚠️ L'entrée n'est plus « en attente » AVANT l'envoi : le drain du tour qui
    // démarre (takePending) ne doit PAS la reprendre dans son propre bloc.
    this.inbox.update(entry.id, { enAttente: false });
    const framed = frameSources([this.frameInput(entry, current)], {
      promptTotalChars: this.promptTotalChars(),
    });
    if (framed === undefined) {
      const raison = "Contenu vide : aucun tour n'a été démarré.";
      entry = this.inbox.update(entry.id, { enAttente: true, raison }) ?? entry;
      return { outcome: "stored", entree: entry, raison };
    }
    try {
      const handle = this.waker?.send(target.sessionId, framed, { origin: ORIGIN_SOURCE });
      if (!handle) throw new Error("host Pi indisponible");
      this.trackRun(handle.runId, [entry.id]);
      entry = this.inbox.update(entry.id, { raison: "" }) ?? entry;
      this.logger.info("sources.message.started", {
        source: nom,
        entry_id: entry.id,
        session_id: handle.sessionId,
        conversation: current.conversation,
      });
      return { outcome: "started", entree: entry };
    } catch (error) {
      const raison = describeWakeFailure(error);
      entry = this.inbox.update(entry.id, { enAttente: true, raison }) ?? entry;
      this.logger.info("sources.message.stored", {
        source: nom,
        entry_id: entry.id,
        tour,
        conversation: current.conversation,
        code: errorCode(error) ?? "unknown",
      });
      return { outcome: "stored", entree: entry, raison };
    }
  }

  // ── Résolution du fil visé ─────────────────────────────────

  /**
   * Conversation visée par un message `lancer` — et création du fil dédié quand il
   * manque.
   *
   * Ordre de résolution (aucune supposition) :
   *  1. fil DÉSIGNÉ dans la configuration (identifiant de conversation choisi par
   *     l'utilisateur dans `/config`) ;
   *  2. mode `source` avec fil mémorisé ⇒ ce fil ;
   *  3. mode `source` sans fil, ou mode `nouvelle` ⇒ **créer un fil de source
   *     NORMAL et VISIBLE** (`Source — <nom>`) puis lancer dedans ;
   *  4. mode `courante` ⇒ la conversation OUVERTE du host (raison exacte sinon) ;
   *  5. mode `aucune` ⇒ ⚠️ AUCUN fil, AUCUN tour : la source n'a pas de destination
   *     configurée, et c'est à l'utilisateur de la choisir (raison actionnable).
   */
  private async resolveTarget(
    record: SourceRecord,
    conversation: SourceConversation,
  ): Promise<{ sessionId?: string; raison?: string }> {
    const waker = this.waker;
    if (!waker) {
      return { raison: "Aucun modèle n'est câblé sur cette instance : le message est conservé." };
    }
    // 1) Fil DÉSIGNÉ par l'utilisateur dans `/config` (jamais par le client).
    if (!isSourceDestination(conversation)) return { sessionId: conversation };
    // 2) Fil dédié DÉJÀ mémorisé.
    if (conversation === "source" && record.sessionId !== undefined && record.sessionId !== "") {
      return { sessionId: record.sessionId };
    }
    // 3) Création d'un fil de source VISIBLE, puis lancement dedans.
    if (conversation === "source" || conversation === "nouvelle") {
      return this.createSourceSession(record, conversation);
    }
    // 4) Conversation ouverte.
    if (conversation === "courante") {
      const current = waker.currentSessionId();
      if (current === undefined || current.length === 0) {
        return {
          raison:
            "Aucune conversation n'est ouverte : le message est conservé et sera transmis " +
            "au début du prochain tour.",
        };
      }
      return { sessionId: current };
    }
    // 5) ⚠️ Règle « C » : pas de destination configurée ⇒ on ne devine pas.
    return { raison: NO_DESTINATION_REASON };
  }

  /**
   * Crée la conversation de la source — un fil NORMAL, **VISIBLE dans la liste**.
   *
   * ⚠️ `newSession()` VOLE le focus (`src/gateway/ws/server.ts:1494-1520` : le
   * `previousFocus` est relevé AVANT, puis rendu `:1527-1537`). On le rend pour ne
   * pas arracher l'utilisateur à ce qu'il est en train d'écrire — mais on ne cache
   * RIEN : le fil apparaît dans la liste des conversations.
   *
   * Le mode `source` MÉMORISE le fil (les messages suivants y retournent) ; le mode
   * `nouvelle` ne le mémorise pas (chaque message crée le sien).
   */
  private async createSourceSession(
    record: SourceRecord,
    mode: "source" | "nouvelle",
  ): Promise<{ sessionId?: string; raison?: string }> {
    const waker = this.waker;
    if (!waker) {
      return { raison: "Aucun modèle n'est câblé sur cette instance : le message est conservé." };
    }
    const previousFocus = waker.currentSessionId();
    let created: { sessionId: string };
    try {
      created = await waker.newSession();
    } catch (error) {
      this.logger.warn("sources.session.create_failed", {
        source: record.nom,
        code: errorCode(error) ?? "unknown",
      });
      return { raison: describeWakeFailure(error) };
    }
    try {
      await waker.renameSession?.(created.sessionId, sourceSessionTitle(record.nom));
    } catch (error) {
      this.logger.warn("sources.session.rename_failed", {
        source: record.nom,
        error: messageOf(error),
      });
    }
    await this.restoreFocus(previousFocus, created.sessionId);
    if (mode === "source") this.store.setSession(record.nom, created.sessionId);
    this.logger.info("sources.session.created", {
      source: record.nom,
      session_id: created.sessionId,
      mode,
    });
    return { sessionId: created.sessionId };
  }

  /** Rend le focus à la conversation d'origine après une création (`newSession` le vole). */
  private async restoreFocus(previous: string | undefined, created: string): Promise<void> {
    const waker = this.waker;
    if (!waker || previous === undefined || previous === created) return;
    const file = await waker.sessionFileFor?.(previous).catch(() => undefined);
    if (!file) return;
    await waker.resume(file).catch((error: unknown) => {
      this.logger.warn("sources.session.focus.failed", { error: messageOf(error) });
    });
  }

  /**
   * ④ Vérifie que le fil visé existe TOUJOURS ; sinon bascule proprement.
   *
   * Renvoie l'enregistrement à jour et, le cas échéant, la NOTE lisible attachée
   * à l'entrée (« la conversation a disparu : la source passe en … »).
   *
   * ⚠️ On ne devine jamais : si le host ne sait pas répondre (`undefined`), on
   * garde la destination telle quelle (le `send` dira la vérité).
   */
  private async checkTarget(
    record: SourceRecord,
  ): Promise<{ record: SourceRecord; note?: string }> {
    // Fil DÉSIGNÉ (identifiant de conversation) : s'il a disparu, la source repasse
    // en « nouvelle conversation à chaque fois » — jamais un échec muet, jamais un
    // fil désigné par erreur.
    if (!isSourceDestination(record.conversation)) {
      const alive = await this.sessionAlive(record.conversation);
      if (alive !== false) return { record };
      const updated = this.store.update(record.nom, { conversation: "nouvelle" });
      this.logger.warn("sources.session.vanished", {
        source: record.nom,
        kind: "designee",
      });
      return {
        record: updated,
        note:
          "La conversation choisie pour cette source n'existe plus : elle passe en " +
          "« nouvelle conversation à chaque fois ». Le message n'est pas perdu.",
      };
    }
    // Fil DÉDIÉ mémorisé : oublié s'il a disparu (`resolveTarget` en recréera un,
    // VISIBLE dans la liste).
    if (record.conversation === "source" && record.sessionId !== undefined) {
      const alive = await this.sessionAlive(record.sessionId);
      if (alive !== false) return { record };
      this.store.setSession(record.nom, undefined);
      this.logger.warn("sources.session.vanished", { source: record.nom, kind: "dedie" });
      return {
        record: this.store.get(record.nom) ?? record,
        note:
          "Le fil dédié de cette source n'existe plus : un nouveau fil de source va être " +
          "créé (il apparaîtra dans la liste des conversations).",
      };
    }
    return { record };
  }

  /** `true`/`false` si l'on peut CONCLURE, `undefined` si le host ne sait pas. */
  private async sessionAlive(sessionId: string): Promise<boolean | undefined> {
    const waker = this.waker;
    if (!waker) return undefined;
    try {
      if (typeof waker.listSessions === "function") {
        const list = await waker.listSessions();
        return list.some((info) => info.sessionId === sessionId);
      }
      if (typeof waker.sessionFileFor === "function") {
        const file = await waker.sessionFileFor(sessionId);
        return file !== undefined && file !== "";
      }
    } catch (error) {
      this.logger.warn("sources.session.check_failed", {
        error: messageOf(error),
      });
      return undefined;
    }
    return undefined;
  }

  // ── Drain GROUPÉ (protection du TTFT) ─────────────────────────────────────

  /**
   * Appelé par le host Pi au DÉBUT de chaque tour : renvoie UN seul bloc
   * `<sources>` contenant TOUTES les entrées en attente, ou `undefined`.
   *
   * ⚠️ Jamais pendant un tour : le host n'appelle cette méthode qu'au démarrage
   * d'un run, et le bloc est fusionné dans l'envoi de ce run (un seul `send`).
   */
  takePending(runId: string): string | undefined {
    const pending = this.inbox.pending();
    if (pending.length === 0) return undefined;
    const framed = frameSources(
      pending.map((entry) => this.frameInput(entry, this.store.get(entry.source))),
      { promptTotalChars: this.promptTotalChars() },
    );
    if (framed === undefined) return undefined;
    const ids = pending.map((entry) => entry.id);
    this.inbox.markDelivered(ids);
    this.trackRun(runId, ids);
    this.logger.info("sources.drain.delivered", { run_id: runId, entries: ids.length });
    return framed;
  }

  private frameInput(entry: InboxEntry, record: SourceRecord | undefined) {
    return {
      nom: entry.source,
      recu: entry.recu,
      ...(entry.titre !== "" ? { titre: entry.titre } : {}),
      ...(record && record.consigne !== "" ? { consigne: record.consigne } : {}),
      texte: entry.texte,
      octets: entry.octets,
    };
  }

  private trackRun(runId: string, ids: string[]): void {
    const existing = this.runs.get(runId);
    if (existing) existing.ids.push(...ids);
    else this.runs.set(runId, { ids: [...ids], text: "" });
  }

  /**
   * Suit les événements du host : accumule la réponse du run et l'ATTACHE aux
   * entrées livrées par ce run (`etat: "traite"`), ou marque l'échec.
   */
  private onEvent(event: SourcesHostEvent): void {
    if (event.type === "delta") {
      const delta = event as { runId?: unknown; channel?: unknown; text?: unknown };
      if (delta.channel !== "content") return;
      if (typeof delta.runId !== "string" || typeof delta.text !== "string") return;
      const run = this.runs.get(delta.runId);
      if (!run) return;
      if (run.text.length < MAX_REPLY_CHARS * 2) run.text += delta.text;
      return;
    }
    if (event.type !== "run_finished") return;
    const finished = event as { runId?: unknown; reason?: unknown; errorMessage?: unknown };
    if (typeof finished.runId !== "string") return;
    const run = this.runs.get(finished.runId);
    if (!run) return;
    this.runs.delete(finished.runId);
    const reason = typeof finished.reason === "string" ? finished.reason : "done";
    const reponse = run.text.trim();
    for (const id of run.ids) {
      if (reason === "done") {
        this.inbox.update(id, {
          etat: "traite",
          enAttente: false,
          ...(reponse !== "" ? { reponse } : {}),
          raison: reponse === "" ? "Le tour s'est terminé sans texte de réponse." : "",
        });
      } else {
        // ⚠️ Aucune perte : le contenu reste INTÉGRALEMENT dans la boîte, avec la
        // raison exacte. On ne le remet PAS automatiquement en attente (un tour
        // arrêté par l'utilisateur ne doit pas repartir contre son gré, et un
        // échec répété ne doit pas boucler) : l'utilisateur peut relancer la
        // conversation depuis l'entrée ou la supprimer.
        this.inbox.update(id, {
          etat: "echec",
          enAttente: false,
          raison:
            reason === "abort"
              ? "Le tour a été arrêté avant de produire une réponse (contenu conservé, aucune relance automatique)."
              : `Le tour a échoué : ${
                  typeof finished.errorMessage === "string" && finished.errorMessage !== ""
                    ? finished.errorMessage
                    : `raison « ${reason} »`
                } (contenu conservé, aucune relance automatique)`,
        });
      }
    }
    this.logger.info("sources.run.finished", {
      run_id: finished.runId,
      reason,
      entries: run.ids.length,
    });
  }

  // ── Boîte de notifications ────────────────────────────────────────────────

  /** Entrées de la boîte (les plus récentes d'abord) + compteur de non-lus. */
  inboxView(): { entries: InboxEntry[]; nonLus: number; limite: number } {
    return {
      entries: this.inbox.list(),
      nonLus: this.inbox.unreadCount(),
      limite: this.inbox.limit,
    };
  }

  markRead(id: string): InboxEntry {
    const entry = this.inbox.markRead(id);
    if (!entry) throw new SourceApiError(404, "unknown_entry", `Entrée inconnue : « ${id} ».`);
    return entry;
  }

  markAllRead(): number {
    return this.inbox.markAllRead();
  }

  removeEntry(id: string): InboxEntry {
    const entry = this.inbox.remove(id);
    if (!entry) throw new SourceApiError(404, "unknown_entry", `Entrée inconnue : « ${id} ».`);
    this.logger.info("sources.inbox.removed", { entry_id: id, source: entry.source });
    return entry;
  }

  // ── Fils de source : suppression d'un fil qui reçoit des sources ─────────

  /**
   * Noms des sources dont la destination EFFECTIVE est ce fil (modale de
   * suppression d'une conversation, point ③).
   *
   * ⚠️ Les fils créés pour une source sont des fils NORMAUX, visibles : les
   * supprimer est une action comme une autre — mais elle est SIGNALÉE.
   */
  sourcesForSession(sessionId: string): string[] {
    return this.store.forSession(sessionId).map((record) => record.nom);
  }

  /**
   * ⚠️ SUPPRESSION d'un fil qui reçoit des sources : les sources ne sont JAMAIS
   * supprimées. Elles passent en « nouvelle conversation à chaque fois » et une
   * entrée d'ALERTE le dit dans la boîte (aucune suppression silencieuse).
   *
   * Renvoie les noms réaffectés.
   */
  detachSession(sessionId: string): string[] {
    const affected = this.store.detachSession(sessionId);
    const noms = affected.map((record) => record.nom);
    for (const record of affected) {
      const texte =
        `La conversation « ${sessionId} » vient d'être supprimée. La source « ${record.nom} », ` +
        "qui y postait, n'a PAS été supprimée : elle passera désormais par « nouvelle " +
        "conversation à chaque fois ». Ses messages déjà reçus restent dans cette boîte.";
      try {
        this.inbox.add({
          source: record.nom,
          titre: "Fil supprimé",
          texte,
          octets: Buffer.byteLength(texte, "utf8"),
          enAttente: false,
          etat: "alerte",
        });
      } catch (error) {
        // Boîte pleine : on ne peut pas écrire l'avis, mais on ne perd pas la
        // réaffectation (déjà persistée) et on le journalise.
        this.logger.warn("sources.inbox.alert_failed", {
          source: record.nom,
          error: messageOf(error),
        });
      }
    }
    this.logger.info("sources.session.detached", {
      session_id: sessionId,
      sources: noms.length,
    });
    return noms;
  }

  /**
   * Conversations EXISTANTES proposées au sélecteur « Envoyer dans : » de
   * `/config` (nom + date), y compris les fils créés pour une source : ce sont des
   * conversations comme les autres.
   *
   * ⚠️ Ne lève jamais : sans host (mode dégradé), la liste est vide et le
   * sélecteur n'offre que les modes.
   */
  async conversationList(): Promise<SourceConversationView[]> {
    const waker = this.waker;
    if (!waker || typeof waker.listSessions !== "function") return [];
    let list: Awaited<ReturnType<NonNullable<SourcesWaker["listSessions"]>>>;
    try {
      list = await waker.listSessions();
    } catch (error) {
      this.logger.warn("sources.sessions.list_failed", { error: messageOf(error) });
      return [];
    }
    return list
      .filter((info) => typeof info.sessionId === "string" && info.sessionId !== "")
      .map((info) => {
        const raw = info.title ?? info.name ?? "";
        const titre = raw.trim().slice(0, MAX_TITRE_CHARS);
        return {
          id: info.sessionId,
          titre: titre === "" ? "Conversation sans titre" : titre,
          ...(info.updatedAt ? { updatedAt: info.updatedAt } : {}),
        };
      });
  }

  /**
   * Un fil de source est-il encore JOIGNABLE ? Renvoie son identifiant (le host
   * l'a repris) ou `undefined` si son fichier a disparu — auquel cas un nouveau
   * fil sera créé par le clic de l'utilisateur.
   */
  private async reopenable(
    waker: SourcesWaker,
    sessionId: string,
  ): Promise<string | undefined> {
    const file = await waker.sessionFileFor?.(sessionId).catch(() => undefined);
    if (!file) return undefined;
    const state = await waker.resume(file).catch(() => undefined);
    return state?.sessionId;
  }

  /**
   * « Continuer dans une conversation » — le clic qui ouvre le fil de la source.
   *
   * Idempotent : si la source a déjà une conversation ET qu'elle existe encore, on
   * réutilise la MÊME (aucun second fil). Sinon on en crée un, NORMAL et VISIBLE
   * (`Source — <nom>`) — comme le fait déjà un message `lancer` (règle « A »).
   */
  async openConversation(id: string): Promise<SourceOpenResult> {
    const entry = this.inbox.get(id);
    if (!entry) throw new SourceApiError(404, "unknown_entry", `Entrée inconnue : « ${id} ».`);
    const waker = this.waker;
    if (!waker) {
      throw new SourceApiError(
        503,
        "host_unavailable",
        "Le host Pi n'est pas disponible : aucune conversation ne peut être ouverte.",
      );
    }
    const record = this.store.get(entry.source);
    if (!record) {
      throw new SourceApiError(
        404,
        "unknown_source",
        `La source « ${entry.source} » n'existe plus : impossible d'ouvrir sa conversation.`,
      );
    }

    const previousFocus = waker.currentSessionId();
    let created = false;

    // 1) RÉUTILISER le fil de la source s'il existe ENCORE (aucune seconde
    //    conversation : un second clic ne crée rien).
    let sessionId =
      record.sessionId !== undefined
        ? await this.reopenable(waker, record.sessionId)
        : undefined;

    // 2) Sinon, CRÉER — ⚠️ uniquement parce que l'utilisateur a cliqué.
    if (sessionId === undefined) {
      const state = await waker.newSession();
      sessionId = state.sessionId;
      created = true;
      try {
        await waker.renameSession?.(sessionId, sourceSessionTitle(record.nom));
      } catch (error) {
        this.logger.warn("sources.conversation.rename_failed", {
          source: record.nom,
          error: messageOf(error),
        });
      }
      this.store.setSession(record.nom, sessionId);
    }

    // Le contenu de l'entrée entre dans le fil comme DONNÉE encadrée.
    const framed = frameSources([this.frameInput(entry, record)], {
      promptTotalChars: this.promptTotalChars(),
    });
    if (framed === undefined) {
      throw new SourceApiError(400, "empty_entry", "Cette entrée est vide : rien à transmettre.");
    }
    try {
      const handle = waker.send(sessionId, framed, { origin: ORIGIN_SOURCE });
      this.trackRun(handle.runId, [entry.id]);
    } catch (error) {
      throw new SourceApiError(503, errorCode(error) ?? "wake_failed", describeWakeFailure(error));
    }

    const updated = this.inbox.update(entry.id, {
      lu: true,
      enAttente: false,
      conversationOuverte: true,
      raison: "",
    });
    // ⚠️ `newSession()` VOLE le focus : on le rend à la conversation d'origine.
    // C'est le CLIENT qui décide d'afficher la nouvelle conversation (il reçoit
    // son identifiant et bascule explicitement).
    if (created && previousFocus !== undefined && previousFocus !== sessionId) {
      const file = await waker.sessionFileFor?.(previousFocus).catch(() => undefined);
      if (file) await waker.resume(file).catch(() => undefined);
    }
    this.logger.info("sources.conversation.opened", {
      source: record.nom,
      entry_id: entry.id,
      session_id: sessionId,
      created,
    });
    return { entree: updated ?? entry, sessionId, created };
  }

  // ── Limitation de débit ───────────────────────────────────────────────────

  /** 30 appels/minute/source ⇒ `429` explicite (fenêtre glissante, en mémoire). */
  private enforceRateLimit(nom: string): void {
    const now = this.now();
    const windowStart = now - 60_000;
    const recent = (this.calls.get(nom) ?? []).filter((at) => at > windowStart);
    if (recent.length >= SOURCE_RATE_LIMIT_PER_MINUTE) {
      const oldest = recent[0];
      const retryAfterS = Math.max(1, Math.ceil((oldest + 60_000 - now) / 1000));
      this.calls.set(nom, recent);
      this.logger.warn("sources.message.rate_limited", { source: nom, calls: recent.length });
      throw new SourceApiError(
        429,
        "rate_limited",
        `Trop d'appels pour cette source : ${SOURCE_RATE_LIMIT_PER_MINUTE} par minute au ` +
          `maximum. Réessayez dans ${retryAfterS} s.`,
        { retryAfterS },
      );
    }
    recent.push(now);
    this.calls.set(nom, recent);
  }

  /** Notification de l'appareil (Web Push) : jamais bloquante, jamais fatale. */
  private emitNotification(record: SourceRecord, entry: InboxEntry): void {
    if (!this.notify) return;
    try {
      this.notify({
        source: record.nom,
        titre: entry.titre !== "" ? entry.titre : `Message de « ${record.nom} »`,
        entree: entry,
      });
    } catch (error) {
      this.logger.warn("sources.notify.failed", { source: record.nom, error: messageOf(error) });
    }
  }
}

/**
 * Raison EXACTE et ACTIONNABLE quand une source n'a pas de destination configurée
 * (règle « C ») : on ne choisit pas un fil à sa place, et on ne perd pas le message.
 */
export const NO_DESTINATION_REASON =
  "Cette source n'a pas de destination configurée : choisissez un fil (ou « nouvelle " +
  "conversation à chaque fois ») dans Paramètres → Sources. Le message est conservé dans la " +
  "boîte de notifications.";

/** Titre LISIBLE du fil créé pour une source (`Source — veille-news`). */
export function sourceSessionTitle(nom: string): string {
  const base = `Source — ${nom}`;
  return base.length > 80 ? `${base.slice(0, 79)}…` : base;
}
