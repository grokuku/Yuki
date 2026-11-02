/**
 * Client REST Discord v10 (lot 21).
 *
 * Ce que ce client garantit, et qui n'est PAS négociable :
 *  1. **Le jeton ne sort jamais d'ici.** Il n'apparaît ni dans une URL, ni dans un
 *     message d'erreur, ni dans une ligne de journal ; il n'est posé que dans l'en-tête
 *     `Authorization: Bot <jeton>` des requêtes montantes. ⚠️ Il n'est JAMAIS envoyé au
 *     CDN (`cdn.discordapp.com`) : le téléchargement d'une pièce jointe se fait SANS
 *     en-tête d'authentification (sinon le jeton fuirait vers un autre hôte).
 *  2. **Pagination par ID, sans perte.** Discord n'a pas de `since` : on descend depuis
 *     le message le plus récent avec `before=<plus ancien vu>`. Le tri est par identifiant
 *     décroissant, et `limit` est borné à 100 par l'API. ⚠️ Une page COURTE n'est pas la
 *     preuve de la fin (des messages supprimés entre deux appels la raccourcissent) : on
 *     continue jusqu'à une page VIDE, ou jusqu'à la borne (14 jours / 1 000 messages), et
 *     dans ce dernier cas on le DIT (`hasNext`).
 *  3. **Débit respecté.** Espacement minimal (`DISCORD_MIN_REQUEST_INTERVAL_MS`), et
 *     surtout RESPECT du `retry_after` d'un `429` (jamais de nouvel essai aveugle). Les
 *     seaux (`X-RateLimit-Bucket`) sont mémorisés : quand un seau annonce
 *     `X-RateLimit-Remaining: 0`, on attend `X-RateLimit-Reset-After` AVANT d'émettre.
 *     Le ralentissement est VISIBLE par le statut de la plateforme.
 *  4. **Aucune URL secrète dans un statut** : on ne publie que le CHEMIN de la route
 *     (`/channels/<id>/messages`), jamais l'URL complète demandée.
 *
 * Le client ne décide RIEN du sens des messages : il transporte des messages bruts. La
 * conversion en modèle commun est le travail de `src/chat/mirror/ingest.ts`.
 */

import {
  DISCORD_API_BASE,
  DISCORD_CDN_HOSTS,
  DISCORD_MAX_DOWNLOAD_BYTES,
  DISCORD_MAX_PAGE,
  DISCORD_MAX_RETRIES,
  DISCORD_MAX_UPLOAD_BYTES,
  DISCORD_MIN_REQUEST_INTERVAL_MS,
  DISCORD_SLOW_WINDOW_MS,
  isDiscordMessage,
  messageOf,
  type DiscordApplication,
  type DiscordChannel,
  type DiscordGuild,
  type DiscordMessage,
  type DiscordUser,
} from "./types.js";

/** Journal minimal (le logger d'observabilité le satisfait). */
export interface DiscordClientLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
}

/** Codes d'échec STABLES (jamais un message à analyser). */
export type DiscordApiErrorCode =
  | "not_configured"
  | "network"
  | "http"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "bad_response"
  /** Fichier trop lourd pour NOTRE borne (avant tout appel réseau), ou refusé (413). */
  | "too_large"
  /** URL de pièce jointe hors des hôtes autorisés (jamais suivie). */
  | "bad_url";

/** Erreur d'API : porte un code, un statut HTTP et un message en français. */
export class DiscordApiError extends Error {
  override readonly name = "DiscordApiError";
  constructor(
    readonly code: DiscordApiErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface DiscordClientOptions {
  /**
   * Jeton du bot, RELU à chaque appel (il peut être saisi après le démarrage).
   * ⚠️ Jamais journalisé, jamais renvoyé, jamais dans une URL.
   */
  token: () => string | undefined;
  fetchImpl?: typeof fetch;
  logger?: DiscordClientLogger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Base de l'API (tests : serveur fixture). Défaut `DISCORD_API_BASE`. */
  apiBase?: string;
  /** Espacement minimal entre deux requêtes (défaut 250 ms). */
  minIntervalMs?: number;
  /** Nombre maximal de tentatives après un `429` (défaut 4). */
  maxRetries?: number;
  /**
   * Hôtes de CDN acceptés pour le téléchargement d'une pièce jointe.
   *
   * ⚠️ Paramètre de TEST uniquement : en production, la valeur par défaut
   * (`DISCORD_CDN_HOSTS`) est la seule admise — une URL d'un autre hôte ne déclenche
   * AUCUNE requête (sinon Yuki deviendrait un client HTTP arbitraire pour un tiers).
   */
  cdnHosts?: readonly string[];
  /** Autorise `http://` pour le CDN (tests avec un serveur local). Défaut `false`. */
  allowHttpCdn?: boolean;
}

/** État de DÉBIT du client, exposé au statut de la plateforme. */
export interface DiscordClientRateState {
  /** `true` si un `429` a été reçu dans la fenêtre récente, ou si un seau est épuisé. */
  ralenti: boolean;
  /** Raison LISIBLE (jamais un jeton, jamais une URL complète). */
  raison?: string;
}

/** Page de messages lue par le client (ordre CHRONOLOGIQUE : du plus ancien au plus récent). */
export interface DiscordMessagesPage {
  messages: DiscordMessage[];
  /**
   * `true` quand il RESTE des messages non lus (borne de date, de volume ou de pages).
   * ⚠️ Sert à afficher « historique antérieur non importé » : jamais un silence.
   */
  hasNext: boolean;
  /** Nombre de requêtes HTTP consommées (mesure). */
  requests: number;
}

/** Options de lecture d'un salon. */
export interface DiscordReadMessagesOptions {
  /** Instant ISO : ne rend que les messages POSTÉRIEURS (strictement). */
  since?: string;
  /** Nombre maximal de messages retenus (borne dure côté appelant). */
  maxMessages?: number;
  /** Nombre maximal de pages lues (garde-fou : défaut 50, soit 5 000 messages). */
  maxPages?: number;
  /**
   * Borne de date (ms Unix) : un message plus ANCIEN arrête la descente.
   *
   * ⚠️ Défaut = `since` : on ne descend jamais plus bas que la fenêtre demandée (14 jours
   * en pratique, voir `BACKFILL_DAYS`).
   */
  cutoffMs?: number;
}

/** Fichier à joindre à un message (octets déjà lus, jamais un chemin disque). */
export interface DiscordOutboundFile {
  filename: string;
  mimeType?: string;
  bytes: Uint8Array;
}

/** État d'un seau de débit (`X-RateLimit-Bucket`). */
interface BucketState {
  remaining: number;
  /** Instant (ms) où le seau se réinitialise. */
  resetAt: number;
}

export class DiscordClient {
  private readonly tokenFactory: () => string | undefined;
  private readonly doFetch: typeof fetch;
  private readonly logger: DiscordClientLogger | undefined;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly apiBase: string;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly cdnHosts: readonly string[];
  private readonly allowHttpCdn: boolean;
  private readonly buckets = new Map<string, BucketState>();
  private lastRequestAt = 0;
  private slowUntil = 0;
  private slowRaison: string | undefined;
  private requests = 0;

  constructor(options: DiscordClientOptions) {
    this.tokenFactory = options.token;
    this.doFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.logger = options.logger;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.apiBase = (options.apiBase ?? DISCORD_API_BASE).replace(/\/+$/, "");
    this.minIntervalMs = options.minIntervalMs ?? DISCORD_MIN_REQUEST_INTERVAL_MS;
    this.maxRetries = options.maxRetries ?? DISCORD_MAX_RETRIES;
    this.cdnHosts = options.cdnHosts ?? DISCORD_CDN_HOSTS;
    this.allowHttpCdn = options.allowHttpCdn === true;
  }

  /** Nombre total de requêtes HTTP émises (mesure ; jamais un secret). */
  get requestCount(): number {
    return this.requests;
  }

  /** État de DÉBIT (affiché par le statut de la plateforme). */
  rateState(): DiscordClientRateState {
    if (this.now() < this.slowUntil) {
      return {
        ralenti: true,
        raison:
          this.slowRaison ??
          "Discord limite le débit (429) : Yuki espace ses requêtes.",
      };
    }
    return { ralenti: false };
  }

  /** Jeton présent ? (aucun appel réseau) */
  isConfigured(): boolean {
    return (this.tokenFactory()?.trim() ?? "") !== "";
  }

  /** `GET /users/@me` — identité du bot (`botUserId`). */
  async me(): Promise<DiscordUser> {
    const user = await this.requestJson<DiscordUser>("GET", "/users/@me");
    if (typeof user?.id !== "string" || user.id === "") {
      throw new DiscordApiError(
        "bad_response",
        "La réponse de Discord ne contient pas l'identifiant du compte (`users/@me`).",
      );
    }
    return user;
  }

  /**
   * `GET /applications/@me` — application du bot, et donc l'état RÉEL de l'intent
   * `MESSAGE_CONTENT` (`flags` : `1 << 18` approuvé, `1 << 19` activé par la bascule).
   *
   * ⚠️ C'est la SEULE façon de savoir si l'intent privilégié est actif sans attendre un
   * `content` vide : `status()` s'en sert pour nommer la cause au lieu de laisser
   * l'utilisateur deviner.
   */
  async application(): Promise<DiscordApplication> {
    const app = await this.requestJson<DiscordApplication>("GET", "/applications/@me");
    if (typeof app?.id !== "string" || app.id === "") {
      throw new DiscordApiError(
        "bad_response",
        "Discord n'a pas renvoyé l'identifiant de l'application (`applications/@me`).",
      );
    }
    return app;
  }

  /** `GET /users/@me/guilds` — serveurs où le bot est présent. */
  async guilds(): Promise<DiscordGuild[]> {
    const guilds = await this.requestJson<DiscordGuild[]>("GET", "/users/@me/guilds");
    return Array.isArray(guilds) ? guilds.filter((guild) => typeof guild?.id === "string") : [];
  }

  /**
   * `GET /guilds/{id}/channels` — salons d'un serveur.
   *
   * ⚠️ Cet endpoint N'INCLUT PAS les fils (`resources/guild.mdx`) : un fil n'est donc
   * jamais listé comme conversation, ce qui est exactement le comportement voulu.
   */
  async guildChannels(guildId: string): Promise<DiscordChannel[]> {
    const channels = await this.requestJson<DiscordChannel[]>(
      "GET",
      `/guilds/${encodeURIComponent(guildId)}/channels`,
    );
    return Array.isArray(channels) ? channels.filter((channel) => typeof channel?.id === "string") : [];
  }

  /** `GET /channels/{id}` — un salon (sert à résoudre le PARENT d'un fil). */
  async channel(channelId: string): Promise<DiscordChannel> {
    const channel = await this.requestJson<DiscordChannel>(
      "GET",
      `/channels/${encodeURIComponent(channelId)}`,
    );
    if (typeof channel?.id !== "string" || channel.id === "") {
      throw new DiscordApiError("bad_response", "Discord n'a pas renvoyé ce salon.");
    }
    return channel;
  }

  /** `GET /channels/{id}/messages/{messageId}` — un message précis. */
  async message(channelId: string, messageId: string): Promise<DiscordMessage> {
    const message = await this.requestJson<DiscordMessage>(
      "GET",
      `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
    );
    if (!isDiscordMessage(message)) {
      throw new DiscordApiError("bad_response", "Discord n'a pas renvoyé ce message.");
    }
    return message;
  }

  /** UNE page de messages (`before`/`after` sont exclusifs, comme le veut l'API). */
  async messagesPage(
    channelId: string,
    options: { limit?: number; before?: string; after?: string } = {},
  ): Promise<DiscordMessage[]> {
    const limit = clampPageSize(options.limit ?? DISCORD_MAX_PAGE);
    const params: Record<string, string | number> = { limit };
    if (options.before !== undefined && options.after !== undefined) {
      throw new DiscordApiError(
        "bad_response",
        "`before` et `after` sont mutuellement exclusifs chez Discord : une seule borne à la fois.",
      );
    }
    if (options.before !== undefined) params.before = options.before;
    if (options.after !== undefined) params.after = options.after;
    const page = await this.requestJson<DiscordMessage[]>(
      "GET",
      `/channels/${encodeURIComponent(channelId)}/messages`,
      undefined,
      { params },
    );
    if (!Array.isArray(page)) return [];
    return page.filter(isDiscordMessage);
  }

  /**
   * Messages d'un salon depuis un instant (`since`), du plus récent vers le plus ancien.
   *
   * ⚠️ Discord n'a **pas** de `since` : on descend avec `before` jusqu'à rencontrer un
   * message antérieur ou égal à `since`, puis on s'arrête. Les bornes sont DITES :
   *  - `maxMessages` atteint ⇒ `hasNext: true` (« historique antérieur non importé ») ;
   *  - borne de date (`cutoffMs`, défaut 14 jours) atteinte ⇒ `hasNext: true` ;
   *  - garde-fou de pages atteint ⇒ `hasNext: true`.
   * Une page COURTE ne conclut rien : seule une page VIDE termine la boucle.
   */
  async channelMessagesSince(
    channelId: string,
    options: DiscordReadMessagesOptions = {},
  ): Promise<DiscordMessagesPage> {
    const sinceMs = options.since !== undefined ? Math.max(1, Date.parse(options.since) || 1) : 1;
    const cutoffMs = options.cutoffMs ?? sinceMs;
    const maxMessages = options.maxMessages ?? Number.POSITIVE_INFINITY;
    const maxPages = options.maxPages ?? 50;
    const collected: DiscordMessage[] = [];
    const seen = new Set<string>();
    let requests = 0;
    let before: string | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      const rows = await this.messagesPage(channelId, {
        limit: DISCORD_MAX_PAGE,
        ...(before !== undefined ? { before } : {}),
      });
      requests += 1;
      if (rows.length === 0) {
        // ⚠️ Seule une page VIDE prouve la fin (une page courte peut venir de
        // suppressions entre deux appels).
        return { messages: [...collected].reverse(), hasNext: false, requests };
      }
      let reachedOld = false;
      for (const message of rows) {
        // Les lignes arrivent du plus récent au plus ancien.
        const at = Date.parse(message.timestamp ?? "") || 0;
        if (at !== 0 && at <= sinceMs) {
          reachedOld = true;
          continue;
        }
        if (seen.has(message.id)) continue;
        seen.add(message.id);
        collected.push(message);
        if (collected.length >= maxMessages) {
          return { messages: [...collected].reverse(), hasNext: true, requests };
        }
      }
      const oldest = rows[rows.length - 1]?.id;
      if (reachedOld) return { messages: [...collected].reverse(), hasNext: false, requests };
      // Borne de date : un message plus vieux que la fenêtre arrête aussi la descente.
      const oldestAt = Date.parse(rows[rows.length - 1]?.timestamp ?? "") || 0;
      if (oldestAt !== 0 && oldestAt < cutoffMs) {
        return { messages: [...collected].reverse(), hasNext: true, requests };
      }
      if (oldest === undefined || oldest === before) {
        // Plus rien à demander (page pleine mais identifiant inchangé : anomalie).
        return { messages: [...collected].reverse(), hasNext: true, requests };
      }
      before = oldest;
    }
    return { messages: [...collected].reverse(), hasNext: true, requests };
  }

  /**
   * `POST /channels/{id}/messages` — publie un message.
   *
   * ⚠️ `message_reference` est FOURNI PAR L'APPELANT (seulement quand le canal est en
   * `replyStyle = "fil"`) avec `fail_if_not_exists: false` : si le message d'origine a
   * été supprimé entre-temps, la réponse part quand même au lieu d'échouer.
   *
   * ⚠️ FICHIERS : `multipart/form-data` avec `payload_json` ET `files[0]`, `files[1]`…
   * (noms uniques exigés par la doc). La borne d'octets est vérifiée AVANT l'appel.
   */
  async createMessage(input: {
    channelId: string;
    content: string;
    replyToMessageId?: string;
    files?: readonly DiscordOutboundFile[];
    maxFileBytes?: number;
    /** `true` (défaut) : neutralise TOUTE mention automatique du contenu publié. */
    suppressMentions?: boolean;
  }): Promise<DiscordMessage> {
    const files = input.files ?? [];
    const limite = Math.max(1, Math.trunc(input.maxFileBytes ?? DISCORD_MAX_UPLOAD_BYTES));
    for (const file of files) {
      if (file.bytes.length <= 0) {
        throw new DiscordApiError("too_large", "Un fichier à joindre est vide : rien n'est envoyé.");
      }
      if (file.bytes.length > limite) {
        throw new DiscordApiError(
          "too_large",
          `Le fichier « ${file.filename} » (${file.bytes.length} octets) dépasse la borne ` +
            `d'envoi (${limite} octets) : il n'est pas envoyé.`,
        );
      }
    }
    const payload: Record<string, unknown> = {
      content: input.content,
      ...(input.suppressMentions === false ? {} : { allowed_mentions: { parse: [] as string[] } }),
    };
    if (input.replyToMessageId !== undefined && input.replyToMessageId !== "") {
      payload.message_reference = {
        message_id: input.replyToMessageId,
        channel_id: input.channelId,
        // ⚠️ `false` : une réponse à un message supprimé part quand même, sans erreur.
        fail_if_not_exists: false,
      };
    }
    if (files.length === 0) {
      const created = await this.requestJson<DiscordMessage>(
        "POST",
        `/channels/${encodeURIComponent(input.channelId)}/messages`,
        payload,
      );
      if (!isDiscordMessage(created)) {
        throw new DiscordApiError(
          "bad_response",
          "Discord n'a pas renvoyé le message créé : l'envoi n'est donc pas confirmé.",
        );
      }
      return created;
    }

    // Multipart : `payload_json` porte tout le JSON, `files[n]` les octets.
    payload.attachments = files.map((file, index) => ({ id: index, filename: file.filename }));
    const created = await this.requestJson<DiscordMessage>(
      "POST",
      `/channels/${encodeURIComponent(input.channelId)}/messages`,
      undefined,
      {
        multipart: () => {
          const form = new FormData();
          form.append("payload_json", JSON.stringify(payload));
          files.forEach((file, index) => {
            const nom = (file.filename || `fichier-${index}`)
              .replace(/[\r\n"\\/]/g, "_")
              .slice(0, 200);
            form.append(
              `files[${index}]`,
              new Blob([file.bytes], { type: file.mimeType ?? "application/octet-stream" }),
              nom,
            );
          });
          // ⚠️ AUCUN `content-type` manuel : `fetch` pose lui-même la frontière.
          return form;
        },
      },
    );
    if (!isDiscordMessage(created)) {
      throw new DiscordApiError(
        "bad_response",
        "Discord n'a pas renvoyé le message créé : l'envoi n'est donc pas confirmé.",
      );
    }
    return created;
  }

  /**
   * Télécharge les octets d'une pièce jointe (URL de contenu fournie par Discord).
   *
   * ⚠️ DEUX GARDES :
   *  1. l'URL doit pointer vers un hôte de CDN Discord (`DISCORD_CDN_HOSTS`) en `https` :
   *     une URL forgée ne doit pas transformer Yuki en client HTTP arbitraire ;
   *  2. ⚠️ AUCUN en-tête `Authorization` : le CDN n'en a pas besoin, et l'envoyer
   *     livrerait le jeton du bot à un autre hôte.
   *
   * Lecture BORNÉE : dès que `maxBytes` est dépassé, la connexion est coupée.
   */
  async downloadAttachment(url: string, options: { maxBytes?: number } = {}): Promise<Buffer> {
    const limite = Math.max(1, Math.trunc(options.maxBytes ?? DISCORD_MAX_DOWNLOAD_BYTES));
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new DiscordApiError("bad_url", "L'adresse de cette pièce jointe n'est pas valide.");
    }
    const schemeOk = parsed.protocol === "https:" || (this.allowHttpCdn && parsed.protocol === "http:");
    if (!schemeOk || !this.cdnHosts.includes(parsed.hostname)) {
      throw new DiscordApiError(
        "bad_url",
        "Cette pièce jointe n'est pas servie par le CDN de Discord : elle n'est pas lue.",
      );
    }
    this.requests += 1;
    let response: Response;
    try {
      // ⚠️ Aucun en-tête d'authentification : le CDN de Discord est public et signé.
      response = await this.doFetch(parsed.toString(), { method: "GET" });
    } catch (error) {
      throw new DiscordApiError(
        "network",
        `Le CDN de Discord est injoignable (${messageOf(error)}).`,
      );
    }
    if (response.status === 403 || response.status === 404) {
      // Les URL signées expirent : le message d'erreur le DIT, l'appelant peut rafraîchir.
      void response.body?.cancel().catch(() => undefined);
      throw new DiscordApiError(
        "not_found",
        "Le lien de cette pièce jointe a expiré (les URL de Discord sont signées et " +
          "temporaires).",
        response.status,
      );
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new DiscordApiError(
        "http",
        `Le CDN de Discord a refusé le téléchargement (HTTP ${response.status}).`,
        response.status,
      );
    }
    const annonce = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(annonce) && annonce > limite) {
      void response.body?.cancel().catch(() => undefined);
      throw new DiscordApiError(
        "too_large",
        `Cette pièce jointe (${annonce} octets) dépasse la borne de téléchargement ` +
          `(${limite} octets) : elle n'est pas lue.`,
      );
    }
    const trop = () =>
      new DiscordApiError(
        "too_large",
        `Cette pièce jointe dépasse la borne de téléchargement (${limite} octets) : elle ` +
          "n'est pas lue.",
      );
    if (!response.body) {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > limite) throw trop();
      return buffer;
    }
    const reader = response.body.getReader();
    const morceaux: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > limite) {
        void reader.cancel().catch(() => undefined);
        throw trop();
      }
      morceaux.push(Buffer.from(value));
    }
    return Buffer.concat(morceaux, total);
  }

  // ─── Interne ─────────────────────────────────────────────────────────────

  /** Corps JSON d'une réponse déjà obtenue (vide ⇒ `undefined`, illisible ⇒ erreur). */
  private async parseJson<T>(method: string, path: string, response: Response): Promise<T | undefined> {
    const text = await response.text();
    if (text.trim() === "") return undefined;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new DiscordApiError(
        "bad_response",
        `Discord a renvoyé une réponse illisible (${method} ${path}).`,
      );
    }
  }

  /**
   * Requête authentifiée, débit maîtrisé, seaux respectés, `429` absorbé.
   *
   * @throws {DiscordApiError} `not_configured` (jeton absent), `network`, `http`,
   *   `unauthorized` (401 : jeton invalide), `forbidden` (403), `not_found` (404),
   *   `rate_limited` (backoff épuisé).
   */
  private async requestJson<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    options: {
      params?: Record<string, string | number>;
      multipart?: () => FormData;
    } = {},
  ): Promise<T> {
    const token = this.tokenFactory()?.trim() ?? "";
    if (token === "") {
      throw new DiscordApiError(
        "not_configured",
        "Le jeton du bot Discord n'est pas encore enregistré (page /config → Discussions).",
      );
    }
    const url = new URL(`${this.apiBase}${path}`);
    for (const [key, value] of Object.entries(options.params ?? {})) {
      url.searchParams.set(key, String(value));
    }
    // Clé de SEAU : la route sans identifiant, comme documenté (« top-level resources »).
    const routeKey = `${method} ${bucketKeyOf(path)}`;

    let lastError: DiscordApiError | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      await this.throttle(routeKey);
      this.requests += 1;
      let response: Response;
      try {
        response = await this.doFetch(url.toString(), {
          method,
          headers: {
            authorization: `Bot ${token}`,
            accept: "application/json",
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          ...(options.multipart !== undefined ? { body: options.multipart() } : {}),
        });
      } catch (error) {
        // ⚠️ On ne recopie QUE le message : l'URL complète et le jeton restent ici.
        throw new DiscordApiError(
          "network",
          `Discord est injoignable (${messageOf(error)}).`,
        );
      }
      this.lastRequestAt = this.now();
      this.rememberBucket(routeKey, response);

      if (response.status === 429) {
        const retryAfterMs = await this.retryAfterMs(response);
        this.slowUntil = this.now() + DISCORD_SLOW_WINDOW_MS;
        this.slowRaison =
          `Discord limite le débit (429) : Yuki espace ses requêtes ` +
          `(nouvel essai dans ${(retryAfterMs / 1000).toFixed(1)} s).`;
        lastError = new DiscordApiError(
          "rate_limited",
          "Discord limite le débit (429) : requête reportée.",
          429,
        );
        this.logger?.warn("chat.discord.rate_limited", {
          path,
          attempt,
          retryAfterMs,
        });
        if (attempt === this.maxRetries) break;
        void response.body?.cancel().catch(() => undefined);
        // ⚠️ On RESPECTE le délai annoncé : jamais de retry aveugle.
        await this.sleep(retryAfterMs);
        continue;
      }

      if (response.status === 401) {
        await this.drain(response);
        throw new DiscordApiError(
          "unauthorized",
          "Discord a refusé le jeton du bot (HTTP 401) : vérifiez le jeton dans " +
            "/config → Discussions, puis redémarrez la connexion.",
          401,
        );
      }
      if (response.status === 403) {
        const detail = await readErrorDetail(response);
        throw new DiscordApiError(
          "forbidden",
          `Discord a refusé l'accès (403)${detail} : vérifiez les permissions du bot sur ` +
            "ce salon (Lire l'historique, Envoyer des messages).",
          403,
        );
      }
      if (response.status === 404) {
        const detail = await readErrorDetail(response);
        throw new DiscordApiError(
          "not_found",
          `Discord n'a pas trouvé la ressource (${method} ${path}, 404)${detail}.`,
          404,
        );
      }
      if (!response.ok) {
        const detail = await readErrorDetail(response);
        throw new DiscordApiError(
          "http",
          `Discord a refusé la requête (${method} ${path} → HTTP ${response.status})${detail}.`,
          response.status,
        );
      }

      if (response.status === 204) {
        await this.drain(response);
        return undefined as T;
      }
      const payload = await this.parseJson<T>(method, path, response);
      return payload as T;
    }
    throw (
      lastError ??
      new DiscordApiError("rate_limited", "Discord limite le débit (429).", 429)
    );
  }

  /** Libère le corps d'une réponse dont on ne veut pas le contenu. */
  private async drain(response: Response): Promise<void> {
    try {
      await response.arrayBuffer();
    } catch {
      // Meilleur effort.
    }
  }

  /** Mémorise l'état d'un seau (respect du `Remaining`/`Reset-After` annoncés). */
  private rememberBucket(routeKey: string, response: Response): void {
    const bucket = response.headers.get("x-ratelimit-bucket");
    const key = bucket !== null && bucket !== "" ? `${routeKey}#${bucket}` : routeKey;
    const remaining = Number(response.headers.get("x-ratelimit-remaining") ?? "");
    const resetAfter = Number(response.headers.get("x-ratelimit-reset-after") ?? "");
    if (!Number.isFinite(remaining) || !Number.isFinite(resetAfter)) return;
    if (remaining > 0) {
      this.buckets.delete(key);
      return;
    }
    // `Reset-After` est en SECONDES (décimales), pas en millisecondes.
    this.buckets.set(key, {
      remaining,
      resetAt: this.now() + Math.max(0, Math.round(resetAfter * 1000)),
    });
  }

  /** Respecte l'espacement minimal ET l'état des seaux connus. */
  private async throttle(routeKey: string): Promise<void> {
    if (this.lastRequestAt !== 0) {
      const wait = this.minIntervalMs - (this.now() - this.lastRequestAt);
      if (wait > 0) await this.sleep(wait);
    }
    for (const [key, state] of this.buckets) {
      if (!key.startsWith(routeKey)) continue;
      if (state.remaining > 0) continue;
      const wait = state.resetAt - this.now();
      if (wait > 0) {
        // ⚠️ Un seau épuisé n'est pas un « 429 » : on attend sans allumer le badge.
        await this.sleep(wait);
      }
      this.buckets.delete(key);
    }
  }

  /** Délai demandé par un `429` : `retry_after` du corps, sinon `Retry-After`, sinon backoff. */
  private async retryAfterMs(response: Response): Promise<number> {
    const headerRaw = response.headers.get("retry-after");
    let bodySeconds: number | undefined;
    try {
      const text = await response.text();
      if (text.trim() !== "") {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed === "object" && parsed !== null) {
          const value = (parsed as { retry_after?: unknown }).retry_after;
          if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
            bodySeconds = value;
          }
        }
      }
    } catch {
      // Corps illisible : l'en-tête tranchera.
    }
    const seconds =
      bodySeconds ??
      (headerRaw !== null && headerRaw.trim() !== "" && Number.isFinite(Number(headerRaw))
        ? Number(headerRaw)
        : undefined);
    if (seconds !== undefined) {
      // ⚠️ Borne haute de sûreté (60 s) : on ne dort pas une heure sur un incident.
      return Math.min(60_000, Math.max(0, Math.round(seconds * 1000)));
    }
    const attempt = Math.max(0, this.requests % 5);
    return Math.min(8_000, this.minIntervalMs * 2 ** attempt);
  }
}

/** `limit` borné à la limite RÉELLE de l'API (100). */
function clampPageSize(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DISCORD_MAX_PAGE;
  return Math.min(DISCORD_MAX_PAGE, Math.floor(value));
}

/**
 * Clé de SEAU d'une route : `method + chemin` SANS identifiant de ressource.
 * `/channels/123/messages` ⇒ `/channels/{id}/messages` (les seaux sont par route).
 */
function bucketKeyOf(path: string): string {
  return path
    .split("/")
    .map((segment) => (/^\d{5,}$/.test(segment) ? "{id}" : segment))
    .join("/");
}

/** Détail lisible d'une erreur HTTP Discord (`message`), sans secret. */
async function readErrorDetail(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (text.trim() === "") return "";
    const parsed: unknown = JSON.parse(text);
    const message =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { message?: unknown }).message
        : undefined;
    return typeof message === "string" && message !== "" ? ` : ${message}` : "";
  } catch {
    return "";
  }
}
