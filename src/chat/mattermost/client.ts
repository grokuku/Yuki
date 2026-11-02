/**
 * Client REST Mattermost v4 (lot 18, lot 2).
 *
 * Ce que ce client garantit, et qui n'est PAS négociable :
 *  1. **Aucune troncature muette.** `per_page` n'est JAMAIS demandé au-delà de
 *     `MM_MAX_PER_PAGE` (200 : au-delà, le serveur tronque sans le dire), et la
 *     lecture pagine jusqu'à la fin RÉELLE (`has_next`, sinon comparaison avec la
 *     taille demandée). Un résultat partiel est SIGNALÉ (`hasNext`), jamais tu.
 *  2. **Débit maîtrisé.** Une requête toutes les `MM_MIN_REQUEST_INTERVAL_MS`
 *     (250 ms). Un `429` déclenche un backoff borné (`Retry-After` s'il est
 *     fourni, sinon exponentiel) et allume le statut « ralenti », VISIBLE par
 *     l'interface.
 *  3. **Le jeton ne sort jamais d'ici.** Il n'apparaît ni dans une URL, ni dans
 *     un message d'erreur, ni dans une ligne de journal : il n'est posé que dans
 *     l'en-tête `Authorization` de la requête montante.
 *  4. **Aucune URL secrète.** Le statut ne publie que le chemin (`/users/me`), et
 *     une erreur ne recopie jamais l'URL complète demandée.
 *
 * Le client ne décide RIEN du sens des messages : il transporte des posts bruts.
 * La conversion en modèle commun est le travail de `src/chat/mirror/ingest.ts`.
 */

import {
  isMattermostPost,
  messageOf,
  MM_MAX_DOWNLOAD_BYTES,
  MM_MAX_PER_PAGE,
  MM_MAX_RETRIES,
  MM_MAX_UPLOAD_BYTES,
  MM_MIN_REQUEST_INTERVAL_MS,
  MM_SINCE_MAX_POSTS,
  MM_SLOW_WINDOW_MS,
  type MattermostChannel,
  type MattermostFileInfo,
  type MattermostFileUploadResponse,
  type MattermostPost,
  type MattermostPostList,
  type MattermostTeam,
  type MattermostUser,
} from "./types.js";

/** Journal minimal (le logger d'observabilité le satisfait). */
export interface MattermostClientLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
}

/** Codes d'échec STABLES (jamais un message à analyser). */
export type MattermostApiErrorCode =
  | "not_configured"
  | "bad_base_url"
  | "network"
  | "http"
  | "rate_limited"
  | "bad_response"
  /** Fichier trop lourd pour NOTRE borne (avant tout appel réseau), ou refusé (413). */
  | "too_large";

/** Erreur d'API : porte un code, un statut HTTP et un message en français. */
export class MattermostApiError extends Error {
  override readonly name = "MattermostApiError";
  constructor(
    readonly code: MattermostApiErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface MattermostClientOptions {
  /** URL de base du serveur (`https://mattermost.exemple.fr`), RELUE à chaque appel. */
  baseUrl: () => string;
  /**
   * Jeton du bot, RELU à chaque appel (il peut être saisi après le démarrage).
   * ⚠️ Jamais journalisé, jamais renvoyé, jamais dans une URL.
   */
  token: () => string | undefined;
  fetchImpl?: typeof fetch;
  logger?: MattermostClientLogger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Espacement minimal entre deux requêtes (défaut 250 ms). */
  minIntervalMs?: number;
  /** Nombre maximal de tentatives après un 429 (défaut 4). */
  maxRetries?: number;
}

/** État de DÉBIT du client, exposé au statut de la plateforme. */
export interface MattermostClientRateState {
  /** `true` si un `429` a été reçu dans la fenêtre récente. */
  ralenti: boolean;
  /** Raison LISIBLE (jamais un jeton, jamais une URL complète). */
  raison?: string;
}

/** Page de posts lue par le client. */
export interface MattermostPostsPage {
  posts: MattermostPost[];
  /**
   * `true` quand il RESTE des posts non lus (pagination interrompue par une borne).
   * ⚠️ Sert à afficher « historique antérieur non importé » : jamais un silence.
   */
  hasNext: boolean;
  /** Nombre de requêtes HTTP consommées (utile aux tests et à la mesure). */
  requests: number;
}

/** Options de lecture d'un canal. */
export interface MattermostReadPostsOptions {
  /** Horodatage ms : ne rend que les posts CRÉÉS OU MODIFIÉS après lui. */
  since?: number;
  /** Nombre maximal de posts retenus (borne dure côté appelant). */
  maxPosts?: number;
}

/** Construit l'URL d'API à partir de l'URL de base (validée, sans secret). */
export function mattermostApiBase(rawBaseUrl: string): string {
  const trimmed = rawBaseUrl.trim();
  if (trimmed === "") {
    throw new MattermostApiError(
      "not_configured",
      "L'URL du serveur Mattermost n'est pas renseignée (page /config → Discussions).",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new MattermostApiError(
      "bad_base_url",
      "L'URL du serveur Mattermost n'est pas une adresse valide (attendu : https://mattermost.exemple.fr).",
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new MattermostApiError(
      "bad_base_url",
      "L'URL du serveur Mattermost doit commencer par http:// ou https://.",
    );
  }
  // On jette la requête et le fragment : ils n'ont aucun sens pour une base d'API.
  const base = `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
  // Une base déjà suffixée `/api/v4` est acceptée telle quelle (jamais doublée).
  return base.endsWith("/api/v4") ? base : `${base}/api/v4`;
}

/** URL du WebSocket dérivée de l'URL de base (`http`→`ws`, `https`→`wss`). */
export function mattermostWebSocketUrl(rawBaseUrl: string): string {
  const api = mattermostApiBase(rawBaseUrl);
  const parsed = new URL(api);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, "")}/websocket`;
  return parsed.toString();
}

export class MattermostClient {
  private readonly baseUrlFactory: () => string;
  private readonly tokenFactory: () => string | undefined;
  private readonly doFetch: typeof fetch;
  private readonly logger: MattermostClientLogger | undefined;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private lastRequestAt = 0;
  private slowUntil = 0;
  private slowRaison: string | undefined;
  private requests = 0;

  constructor(options: MattermostClientOptions) {
    this.baseUrlFactory = options.baseUrl;
    this.tokenFactory = options.token;
    this.doFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.logger = options.logger;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.minIntervalMs = options.minIntervalMs ?? MM_MIN_REQUEST_INTERVAL_MS;
    this.maxRetries = options.maxRetries ?? MM_MAX_RETRIES;
  }

  /** Nombre total de requêtes HTTP émises (mesure ; jamais un secret). */
  get requestCount(): number {
    return this.requests;
  }

  /** État de DÉBIT (affiché par le statut de la plateforme). */
  rateState(): MattermostClientRateState {
    if (this.now() < this.slowUntil) {
      return {
        ralenti: true,
        raison:
          this.slowRaison ??
          "Le serveur Mattermost a renvoyé un refus de débit (429) : Yuki ralentit ses requêtes.",
      };
    }
    return { ralenti: false };
  }

  /** Jeton présent ET URL valide ? (aucun appel réseau) */
  isConfigured(): boolean {
    const token = this.tokenFactory()?.trim() ?? "";
    if (token === "") return false;
    try {
      mattermostApiBase(this.baseUrlFactory());
      return true;
    } catch {
      return false;
    }
  }

  /** `GET /users/me` — identité du bot (`botUserId`). */
  async me(): Promise<MattermostUser> {
    const user = await this.request<MattermostUser>("GET", "/users/me");
    if (typeof user?.id !== "string" || user.id === "") {
      throw new MattermostApiError(
        "bad_response",
        "La réponse de Mattermost ne contient pas l'identifiant du compte (`users/me`).",
      );
    }
    return user;
  }

  /** `GET /users/me/teams` — équipes du compte. */
  async teams(): Promise<MattermostTeam[]> {
    const teams = await this.request<MattermostTeam[]>("GET", "/users/me/teams", undefined, {
      params: { per_page: MM_MAX_PER_PAGE },
    });
    return Array.isArray(teams) ? teams.filter((team) => typeof team?.id === "string") : [];
  }

  /**
   * Canaux d'une équipe dont le compte est MEMBRE
   * (`GET /users/me/teams/<team>/channels`).
   */
  async channelsForTeam(teamId: string): Promise<MattermostChannel[]> {
    const channels = await this.request<MattermostChannel[]>(
      "GET",
      `/users/me/teams/${encodeURIComponent(teamId)}/channels`,
    );
    return Array.isArray(channels)
      ? channels.filter(
          (channel) =>
            typeof channel?.id === "string" && (channel.delete_at ?? 0) === 0,
        )
      : [];
  }

  /**
   * Une PAGE de posts d'un canal (`GET /channels/<id>/posts`).
   *
   * ⚠️ `per_page` est borné ici (200) : demander plus serait tronqué sans erreur
   * par le serveur, et l'appelant croirait avoir tout lu.
   */
  async channelPostsPage(
    channelId: string,
    options: { page: number; perPage?: number },
  ): Promise<MattermostPostList> {
    const perPage = clampPerPage(options.perPage ?? MM_MAX_PER_PAGE);
    return this.request<MattermostPostList>(
      "GET",
      `/channels/${encodeURIComponent(channelId)}/posts`,
      undefined,
      { params: { page: options.page, per_page: perPage } },
    );
  }

  /**
   * Posts d'un canal depuis un horodatage (`?since=<ms>`).
   *
   * ⚠️ Contrat vérifié de l'API : `since` n'est PAS combinable avec `page`/
   * `per_page`, et le serveur ne rend au plus que 1000 posts **sans garantir la
   * continuité**. On ne pagine donc pas ; on DIT si la borne a été atteinte
   * (`hasNext`), pour que l'appelant affiche « historique antérieur non importé ».
   */
  async channelPostsSince(channelId: string, sinceMs: number): Promise<MattermostPostsPage> {
    const list = await this.request<MattermostPostList>(
      "GET",
      `/channels/${encodeURIComponent(channelId)}/posts`,
      undefined,
      { params: { since: Math.max(1, Math.floor(sinceMs)) } },
    );
    const posts = orderedPosts(list);
    return {
      posts,
      hasNext: posts.length >= MM_SINCE_MAX_POSTS,
      requests: 1,
    };
  }

  /**
   * TOUS les posts d'un canal, page après page, jusqu'à la fin RÉELLE.
   *
   * ⚠️ La boucle ne s'arrête jamais sur « moins de posts que demandé » quand
   * `has_next` est fourni : c'est le serveur qui décide. Elle s'arrête sur
   * `has_next === false`, sur une page VIDE, ou sur la borne `maxPosts` — et dans
   * ce dernier cas elle le DIT (`hasNext: true`).
   */
  async channelPostsAll(
    channelId: string,
    options: MattermostReadPostsOptions = {},
  ): Promise<MattermostPostsPage> {
    if (options.since !== undefined) return this.channelPostsSince(channelId, options.since);
    const perPage = MM_MAX_PER_PAGE;
    const maxPosts = options.maxPosts ?? Number.POSITIVE_INFINITY;
    const collected: MattermostPost[] = [];
    const seen = new Set<string>();
    let requests = 0;
    // ⚠️ Pas de page RÉELLEMENT rendu par le serveur. Mattermost peut plafonner
    // `per_page` (60 par défaut, 200 au maximum) SANS LE DIRE : une page plus courte que
    // demandé n'est donc PAS la preuve de la fin. On adapte le pas au plafond observé et
    // on interroge la page suivante — une requête de plus, aucune perte.
    let step = perPage;
    for (let page = 0; page < 1_000; page += 1) {
      const list = await this.channelPostsPage(channelId, { page, perPage: step });
      requests += 1;
      const pageOrder = Array.isArray(list.order) ? list.order : Object.keys(list.posts ?? {});
      if (pageOrder.length === 0) {
        return { posts: collected, hasNext: false, requests };
      }
      for (const post of orderedPosts(list)) {
        if (seen.has(post.id)) continue;
        seen.add(post.id);
        collected.push(post);
        if (collected.length >= maxPosts) {
          return { posts: collected, hasNext: true, requests };
        }
      }
      if (list.has_next === undefined && pageOrder.length < step) {
        // Troncature silencieuse POSSIBLE : on ne conclut pas, on règle le pas sur ce
        // que le serveur a bien voulu rendre.
        step = Math.max(1, pageOrder.length);
      }
      // `has_next` fait foi quand il est présent ; sinon une page PLEINE (au pas
      // observé) annonce une suite possible — la page suivante tranchera.
      const more = list.has_next ?? pageOrder.length >= step;
      if (!more) return { posts: collected, hasNext: false, requests };
    }
    return { posts: collected, hasNext: true, requests };
  }

  /** `POST /users/ids` — résolution des noms d'auteurs (ordre indifférent). */
  async usersByIds(ids: readonly string[]): Promise<MattermostUser[]> {
    const unique = [...new Set(ids.filter((id) => typeof id === "string" && id !== ""))];
    if (unique.length === 0) return [];
    // L'API accepte un lot ; on le borne pour ne pas dépasser une taille d'URL/JSON
    // raisonnable et pour garder des requêtes courtes.
    const out: MattermostUser[] = [];
    for (let index = 0; index < unique.length; index += 100) {
      const batch = unique.slice(index, index + 100);
      const users = await this.request<MattermostUser[]>("POST", "/users/ids", batch);
      if (Array.isArray(users)) out.push(...users.filter((user) => typeof user?.id === "string"));
    }
    return out;
  }

  /**
   * `POST /posts` — publie un message, éventuellement DANS UN FIL (`root_id`).
   *
   * ⚠️ `root_id` est indispensable : sans lui, une réponse à un fil atterrirait à
   * la racine du canal (et l'utilisateur perdrait le fil).
   */
  async createPost(input: {
    channelId: string;
    message: string;
    rootId?: string;
    /**
     * Identifiants de fichiers DÉJÀ TÉLÉVERSÉS (`POST /files`) à joindre au post.
     *
     * ⚠️ Un `file_id` n'appartient PAS à un canal tant qu'aucun post ne le porte :
     * l'ordre est donc TOUJOURS `POST /files` puis `POST /posts` avec `file_ids`.
     */
    fileIds?: readonly string[];
  }): Promise<MattermostPost> {
    const body: Record<string, unknown> = {
      channel_id: input.channelId,
      message: input.message,
    };
    if (input.rootId !== undefined && input.rootId !== "") body.root_id = input.rootId;
    const fileIds = (input.fileIds ?? []).filter((id) => typeof id === "string" && id !== "");
    if (fileIds.length > 0) body.file_ids = [...fileIds];
    const post = await this.request<MattermostPost>("POST", "/posts", body);
    if (!isMattermostPost(post)) {
      throw new MattermostApiError(
        "bad_response",
        "Mattermost n'a pas renvoyé le message créé : l'envoi n'est donc pas confirmé.",
      );
    }
    return post;
  }

  /**
   * `POST /files` — téléverse UN fichier dans un canal (multipart/form-data).
   *
   * ⚠️ Vérifié dans la doc archivée (`mattermost-upload-file`) : la requête est un
   * `multipart/form-data` portant `channel_id` et le fichier (`files`), et la réponse
   * rend `{ file_infos: [...] }`. Le fichier n'est rattaché à un message qu'à l'appel
   * suivant (`createPost` avec `file_ids`).
   *
   * ⚠️ BORNE AVANT RÉSEAU : au-delà de `maxBytes` (défaut `MM_MAX_UPLOAD_BYTES`, 100 Mo =
   * défaut Mattermost), on REFUSE explicitement — jamais une troncature, jamais un envoi
   * partiel. Un `413` du serveur (instance bridée) remonte comme `too_large`.
   */
  async uploadFile(input: {
    channelId: string;
    filename: string;
    mimeType?: string;
    bytes: Uint8Array;
    maxBytes?: number;
  }): Promise<MattermostFileInfo> {
    const limite = Math.max(1, Math.trunc(input.maxBytes ?? MM_MAX_UPLOAD_BYTES));
    const taille = input.bytes.length;
    if (taille <= 0) {
      throw new MattermostApiError("too_large", "Le fichier à joindre est vide : rien n'est envoyé.");
    }
    if (taille > limite) {
      throw new MattermostApiError(
        "too_large",
        `Le fichier « ${input.filename} » (${taille} octets) dépasse la borne d'envoi ` +
          `(${limite} octets) : il n'est pas envoyé.`,
      );
    }
    // ⚠️ Un nom de fichier vient d'ailleurs : on retire guillemets, retours à la ligne et
    // séparateurs de chemin, qui casseraient l'en-tête multipart.
    const nom = (input.filename || "fichier")
      .replace(/[\r\n"\\/]/g, "_")
      .slice(0, 200);
    const type = input.mimeType !== undefined && input.mimeType !== ""
      ? input.mimeType
      : "application/octet-stream";
    const response = await this.perform("POST", "/files", () => {
      const form = new FormData();
      form.append("channel_id", input.channelId);
      form.append("files", new Blob([input.bytes], { type }), nom);
      // ⚠️ AUCUN `content-type` manuel : `fetch` pose lui-même la frontière multipart.
      return { headers: { accept: "application/json" }, body: form };
    });
    const payload = (await this.parseJson<MattermostFileUploadResponse>("/files", response)) ?? {};
    const info = Array.isArray(payload.file_infos) ? payload.file_infos[0] : undefined;
    if (!info || typeof info.id !== "string" || info.id === "") {
      throw new MattermostApiError(
        "bad_response",
        "Mattermost n'a pas renvoyé l'identifiant du fichier téléversé : l'envoi n'est pas confirmé.",
      );
    }
    return info;
  }

  /** `GET /files/<id>/info` — métadonnées d'un fichier (jamais son contenu). */
  async fileInfo(fileId: string): Promise<MattermostFileInfo> {
    const info = await this.request<MattermostFileInfo>(
      "GET",
      `/files/${encodeURIComponent(fileId)}/info`,
    );
    if (typeof info?.id !== "string" || info.id === "") {
      throw new MattermostApiError(
        "bad_response",
        "Mattermost n'a pas renvoyé les métadonnées de ce fichier.",
      );
    }
    return info;
  }

  /**
   * `GET /files/<id>` — TÉLÉCHARGE les octets d'un fichier.
   *
   * ⚠️ Lecture BORNÉE : dès que `maxBytes` est dépassé (défaut
   * `MM_MAX_DOWNLOAD_BYTES`, 20 Mio), la connexion est coupée et l'appel LÈVE
   * `too_large`. Jamais d'accumulation sans plafond dans la mémoire du processus.
   */
  async downloadFile(fileId: string, options: { maxBytes?: number } = {}): Promise<Buffer> {
    const limite = Math.max(1, Math.trunc(options.maxBytes ?? MM_MAX_DOWNLOAD_BYTES));
    const path = `/files/${encodeURIComponent(fileId)}`;
    const response = await this.perform("GET", path, () => ({
      headers: { accept: "*/*" },
    }));
    const annonce = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(annonce) && annonce > limite) {
      void response.body?.cancel().catch(() => undefined);
      throw new MattermostApiError(
        "too_large",
        `Ce fichier (${annonce} octets) dépasse la borne de téléchargement (${limite} octets) : ` +
          "il n'est pas lu.",
      );
    }
    const trop = () =>
      new MattermostApiError(
        "too_large",
        `Ce fichier dépasse la borne de téléchargement (${limite} octets) : il n'est pas lu.`,
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

  /** Corps JSON d'une réponse déjà obtenue (vide ⇒ `undefined`, illisible ⇒ erreur). */
  private async parseJson<T>(path: string, response: Response): Promise<T | undefined> {
    const text = await response.text();
    if (text.trim() === "") return undefined;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new MattermostApiError(
        "bad_response",
        `Mattermost a renvoyé une réponse illisible (POST ${path}).`,
      );
    }
  }

  /**
   * Requête authentifiée, débit maîtrisé, `429` absorbé par un backoff borné.
   *
   * @throws {MattermostApiError} `not_configured` (jeton absent), `bad_base_url`,
   *   `network`, `http` (statut ≠ 2xx), `rate_limited` (backoff épuisé).
   */
  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    options: { params?: Record<string, string | number> } = {},
  ): Promise<T> {
    const response = await this.perform(
      method,
      path,
      () => ({
        headers: {
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
      options,
    );
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (text.trim() === "") return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new MattermostApiError(
        "bad_response",
        `Mattermost a renvoyé une réponse illisible (${method} ${path}).`,
      );
    }
  }

  /**
   * Exécute UNE requête (débit, `429`, erreurs HTTP) et rend la réponse BRUTE.
   *
   * ⚠️ Factorisé à dessein : l'upload multipart et le téléchargement binaire passent
   * ainsi par le MÊME débit, le MÊME backoff et la MÊME règle « le jeton ne quitte ce
   * module que dans l'en-tête `Authorization` ». Une seconde boucle aurait divergé.
   */
  private async perform(
    method: "GET" | "POST",
    path: string,
    build: () => { headers: Record<string, string>; body?: NonNullable<RequestInit["body"]> },
    options: { params?: Record<string, string | number> } = {},
  ): Promise<Response> {
    const token = this.tokenFactory()?.trim() ?? "";
    if (token === "") {
      throw new MattermostApiError(
        "not_configured",
        "Le jeton du bot Mattermost n'est pas encore enregistré (page /config → Discussions).",
      );
    }
    const base = mattermostApiBase(this.baseUrlFactory());
    const url = new URL(`${base}${path}`);
    for (const [key, value] of Object.entries(options.params ?? {})) {
      url.searchParams.set(key, String(value));
    }

    let lastError: MattermostApiError | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      await this.throttle();
      this.requests += 1;
      const built = build();
      let response: Response;
      try {
        response = await this.doFetch(url.toString(), {
          method,
          headers: { authorization: `Bearer ${token}`, ...built.headers },
          ...(built.body !== undefined ? { body: built.body } : {}),
        });
      } catch (error) {
        // ⚠️ On ne recopie QUE le message : l'URL complète et le jeton restent ici.
        throw new MattermostApiError(
          "network",
          `Le serveur Mattermost est injoignable (${messageOf(error)}).`,
        );
      }
      this.lastRequestAt = this.now();

      if (response.status === 429) {
        const retryAfterMs = this.retryAfterMs(response);
        this.slowUntil = this.now() + MM_SLOW_WINDOW_MS;
        this.slowRaison =
          `Mattermost limite le débit (429) : Yuki espace ses requêtes ` +
          `(nouvel essai dans ${Math.round(retryAfterMs / 1000)} s).`;
        lastError = new MattermostApiError(
          "rate_limited",
          "Le serveur Mattermost limite le débit (429) : requête reportée.",
          429,
        );
        this.logger?.warn("chat.mattermost.rate_limited", {
          path,
          attempt,
          retryAfterMs,
        });
        if (attempt === this.maxRetries) break;
        // ⚠️ La réponse précédente n'est pas lue : on la LIBÈRE (un téléchargement
        // abandonné ne doit pas garder la connexion ouverte).
        void response.body?.cancel().catch(() => undefined);
        await this.sleep(retryAfterMs);
        continue;
      }

      if (!response.ok) {
        const detail = await readErrorDetail(response);
        throw new MattermostApiError(
          "http",
          `Mattermost a refusé la requête (${method} ${path} → HTTP ${response.status})${detail}.`,
          response.status,
        );
      }

      // ⚠️ Le statut « ralenti » N'EST PAS effacé par un succès : il retombe tout seul
      // au bout de `MM_SLOW_WINDOW_MS`. Sinon, un aller-retour 429 puis 200 ferait
      // clignoter le badge et l'utilisateur ne verrait jamais le ralentissement.
      return response;
    }
    throw (
      lastError ??
      new MattermostApiError("rate_limited", "Le serveur Mattermost limite le débit (429).", 429)
    );
  }

  /** Respecte l'espacement minimal entre deux requêtes. */
  private async throttle(): Promise<void> {
    if (this.lastRequestAt === 0) return;
    const wait = this.minIntervalMs - (this.now() - this.lastRequestAt);
    if (wait > 0) await this.sleep(wait);
  }

  /** Délai demandé par un `429` (en-tête `Retry-After`), sinon backoff borné. */
  private retryAfterMs(response: Response): number {
    const raw = response.headers.get("retry-after");
    if (raw !== null && raw.trim() !== "") {
      const seconds = Number(raw);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(30_000, Math.max(this.minIntervalMs, Math.round(seconds * 1000)));
      }
      const date = Date.parse(raw);
      if (Number.isFinite(date)) {
        return Math.min(30_000, Math.max(this.minIntervalMs, date - this.now()));
      }
    }
    const attempt = Math.max(0, this.requests % 5);
    return Math.min(8_000, this.minIntervalMs * 2 ** attempt);
  }
}

/** `per_page` borné à la limite RÉELLE du serveur (200). */
function clampPerPage(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return MM_MAX_PER_PAGE;
  return Math.min(MM_MAX_PER_PAGE, Math.floor(value));
}

/** Posts d'une liste, dans l'ordre `order` (à défaut, ordre du dictionnaire). */
function orderedPosts(list: MattermostPostList | undefined): MattermostPost[] {
  if (!list || typeof list !== "object") return [];
  const byId = list.posts ?? {};
  const order = Array.isArray(list.order) && list.order.length > 0 ? list.order : Object.keys(byId);
  const out: MattermostPost[] = [];
  const seen = new Set<string>();
  for (const id of order) {
    if (typeof id !== "string" || seen.has(id)) continue;
    const post = byId[id];
    if (!isMattermostPost(post)) continue;
    seen.add(id);
    out.push(post);
  }
  return out;
}

/** Détail lisible d'une erreur HTTP Mattermost (`message`), sans secret. */
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
