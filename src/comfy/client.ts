/**
 * Client HTTP du serveur ComfyUI (aucune dépendance : `fetch` natif).
 *
 * Routes RÉELLEMENT utilisées (vérifiées dans le code de ComfyUI, `server.py` :
 * `@routes.get("/system_stats")`, `@routes.post("/prompt")`,
 * `@routes.get("/history/{prompt_id}")`, `@routes.get("/view")`) :
 *
 *  1. `POST /prompt`             → soumet le graphe (format API) ; répond
 *                                  `{ prompt_id, number, node_errors }`
 *                                  ou `{ error, node_errors }` (HTTP 400) ;
 *  2. `GET  /history/{id}`       → `{}` tant que le prompt n'est pas terminé,
 *                                  puis `{ [id]: { prompt, outputs, status } }`.
 *                                  ⚠️ Le NOM DE FICHIER de l'image produite est
 *                                  dans `outputs[<nœud>].images[].filename`
 *                                  (+ `subfolder`, `type`).
 *  3. `GET  /view?filename=…&subfolder=…&type=…`
 *                                 → les OCTETS de l'image (`image/png`).
 *  4. `GET  /system_stats`       → `{ system: { comfyui_version, … }, devices: […] }`
 *                                  (bouton « Tester la connexion »).
 *
 * ⚠️ `SaveImage` ET `PreviewImage` renvoient la MÊME forme d'historique
 * (`nodes.py` : `PreviewImage(SaveImage)` réutilise `save_images`, qui renvoie
 * `{"ui": {"images": [{filename, subfolder, type}]}}`) — seule la DESTINATION
 * change : `SaveImage` écrit dans `output/` (`type: "output"`), `PreviewImage`
 * écrit dans `temp/` (`type: "temp"`), que `/view?type=temp` sert aussi
 * (`server.py`, `folder_paths.get_directory_by_type`). ⚠️ Un aperçu reste un
 * VRAI fichier écrit sur le disque du serveur — et il peut être PURGÉ (dossier
 * `temp`), donc on le télécharge IMMÉDIATEMENT après la fin du prompt.
 *
 * ⚠️ Toute attente est BORNÉE (une requête a son propre délai, la génération
 * complète a le sien) : aucune attente infinie. Les échecs rapportent la cause
 * RÉELLEMENT observée (statut HTTP, message du serveur, code réseau), traduite
 * en français — jamais une cause inventée.
 */

import type {
  ComfyConfigProvider,
  ComfyErrorCode,
  ComfyImageBytes,
  ComfyLogger,
} from "./types.js";
import { ComfyError } from "./types.js";

/** Délai d'UNE requête HTTP vers ComfyUI (soumise, historique, image). */
export const DEFAULT_COMFY_REQUEST_TIMEOUT_MS = 20_000;
/** Délai MAXIMAL d'une génération complète (10 s à 3 min en pratique). */
export const DEFAULT_COMFY_GENERATION_TIMEOUT_MS = 180_000;
/** Intervalle entre deux lectures de l'historique. */
export const DEFAULT_COMFY_POLL_INTERVAL_MS = 1_000;
/** Plafond des octets récupérés pour une image générée. */
export const MAX_COMFY_IMAGE_BYTES = 24 * 1024 * 1024;

/** Étape observée d'une génération (progression rapportée à l'outil). */
export interface ComfyProgress {
  phase: "submitted" | "waiting" | "downloading";
  promptId: string;
  elapsedMs: number;
}

/** Référence d'une image produite (ce que `outputs[…]` porte réellement). */
export interface ComfyImageRef {
  /** Nœud qui a produit cette image (`outputs[<nœud>]`). */
  nodeId: string;
  filename: string;
  subfolder: string;
  /** `output` (SaveImage) ou `temp` (PreviewImage). */
  type: string;
}

/** Réponse exploitable de `GET /system_stats`. */
export interface ComfySystemStats {
  version?: string;
  devices: string[];
}

/**
 * Port consommé par le générateur (doublé dans les tests : aucun réseau).
 *
 * ⚠️ Il ne porte QUE ce dont la génération a besoin : soumettre un graphe
 * (délai borné, sondage de l'historique) et interroger le serveur pour le bouton
 * « Tester la connexion ».
 */
export interface ComfyImageClientPort {
  generate(
    workflow: Record<string, unknown>,
    options?: {
      signal?: AbortSignal;
      onProgress?: (progress: ComfyProgress) => void;
      /**
       * Nœud étiqueté `YUKI_OUTPUT` : SEUL sa sortie est lue. `undefined` ⇒
       * comportement historique (première image produite par le graphe).
       */
      outputNodeId?: string;
    },
  ): Promise<ComfyImageBytes>;
  systemStats(signal?: AbortSignal): Promise<ComfySystemStats>;
}

export interface ComfyClientOptions {
  config: ComfyConfigProvider;
  /** Injectable pour les tests. Défaut : `fetch` global. */
  fetchImpl?: typeof fetch;
  logger?: ComfyLogger;
  requestTimeoutMs?: number;
  /** Délai global d'une génération (lu à chaud : réglable sans redémarrage). */
  generationTimeoutMs?: () => number;
  pollIntervalMs?: number;
  now?: () => number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Code système d'une erreur réseau (undici : `error.cause.code`). */
function networkCode(error: unknown): string | undefined {
  const withCode = error as { code?: unknown; cause?: { code?: unknown } } | undefined;
  if (typeof withCode?.code === "string") return withCode.code;
  if (typeof withCode?.cause?.code === "string") return withCode.cause.code;
  return undefined;
}

/**
 * Normalise l'URL du serveur. ⚠️ Refus AVANT tout appel si le schéma n'est pas
 * http/https ou si l'URL est inexploitable (message actionnable).
 */
export function normalizeComfyBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new ComfyError(
      "not_configured",
      "Aucun serveur ComfyUI n'est configuré. Paramètres → Système → Images " +
        "générées : renseignez l'URL du serveur (ex. http://10.10.0.5:8188).",
    );
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ComfyError(
      "invalid_url",
      `L'URL du serveur ComfyUI est invalide : « ${trimmed} ». Attendu une URL ` +
        "complète (ex. http://10.10.0.5:8188).",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ComfyError(
      "invalid_url",
      `Le schéma « ${url.protocol.replace(":", "")} » n'est pas accepté : utilisez ` +
        "http:// ou https://.",
    );
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${pathname}`;
}

/** Traduit un échec de connexion en message français FIDÈLE au code observé. */
function networkFailure(error: unknown, url: string): ComfyError {
  if (error instanceof ComfyError) return error;
  const code = networkCode(error);
  const detail =
    code === "ECONNREFUSED"
      ? "connexion refusée (aucun service à cette adresse/port)"
      : code === "ENOTFOUND"
        ? "nom d'hôte introuvable (DNS)"
        : code === "EAI_AGAIN"
          ? "résolution DNS temporairement indisponible"
          : code === "ECONNRESET"
            ? "connexion réinitialisée par le serveur"
            : code === "ETIMEDOUT"
              ? "délai réseau dépassé"
              : code === "EHOSTUNREACH" || code === "ENETUNREACH"
                ? "réseau injoignable"
                : messageOf(error);
  return new ComfyError(
    "unreachable",
    `Serveur ComfyUI INJOIGNABLE à l'adresse ${url} : ${detail}. Vérifiez l'URL, ` +
      "le port et que le serveur est démarré.",
    { causeCode: code, cause: error },
  );
}

/** Combine le signal externe (annulation du tour) avec le délai de la requête. */
function combineSignals(
  external: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; timedOut: () => boolean; dispose: () => void } {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref?.();
  const onAbort = (): void => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      external?.removeEventListener("abort", onAbort);
    },
  };
}

/** Pause annulable (jamais un `setTimeout` orphelin). */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ComfyError("cancelled", "Génération d'image annulée."));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new ComfyError("cancelled", "Génération d'image annulée."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Extrait un message lisible du corps d'erreur renvoyé par ComfyUI. */
function serverErrorMessage(text: string): string | undefined {
  const bounded = text.slice(0, 2_000);
  try {
    const parsed = JSON.parse(bounded) as Record<string, unknown>;
    const error = parsed.error;
    if (typeof error === "string") return error;
    if (error && typeof error === "object") {
      const inner = error as Record<string, unknown>;
      const type = typeof inner.type === "string" ? inner.type : undefined;
      const message = typeof inner.message === "string" ? inner.message : undefined;
      if (type || message) return [type, message].filter(Boolean).join(" — ");
    }
    if (typeof parsed.message === "string") return parsed.message;
    return undefined;
  } catch {
    return bounded.trim() === "" ? undefined : bounded.trim();
  }
}

/** Liste des nœuds en erreur (`node_errors`) d'un refus de `POST /prompt`. */
function describeNodeErrors(root: unknown): string[] {
  if (!root || typeof root !== "object" || Array.isArray(root)) return [];
  const nodeErrors = (root as Record<string, unknown>).node_errors;
  if (!nodeErrors || typeof nodeErrors !== "object" || Array.isArray(nodeErrors)) return [];
  const out: string[] = [];
  for (const [nodeId, value] of Object.entries(nodeErrors as Record<string, unknown>)) {
    const classType =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>).class_type
        : undefined;
    out.push(
      `${nodeId}${typeof classType === "string" ? ` (${classType})` : ""}`,
    );
  }
  return out.slice(0, 5);
}

/** Extrait un message du corps d'erreur sans le perdre (JSON → texte). */
function parseJsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export class ComfyClient {
  private readonly config: ComfyConfigProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: ComfyLogger | undefined;
  private readonly requestTimeoutMs: number;
  private readonly generationTimeoutMs: () => number;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;

  constructor(options: ComfyClientOptions) {
    this.config = options.config;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_COMFY_REQUEST_TIMEOUT_MS;
    this.generationTimeoutMs =
      options.generationTimeoutMs ?? (() => DEFAULT_COMFY_GENERATION_TIMEOUT_MS);
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_COMFY_POLL_INTERVAL_MS;
    this.now = options.now ?? Date.now;
  }

  /** URL de base effective (validée) + en-têtes d'authentification. */
  private endpoint(): { base: string; headers: Record<string, string> } {
    const config = this.config();
    const base = normalizeComfyBaseUrl(config.baseUrl);
    const headers: Record<string, string> = { accept: "application/json" };
    // ⚠️ Le jeton n'est JAMAIS journalisé (ni dans une erreur, ni dans un log).
    if (config.apiKey.trim() !== "") headers.authorization = `Bearer ${config.apiKey.trim()}`;
    return { base, headers };
  }

  /** Requête HTTP bornée, avec traduction FIDÈLE des échecs. */
  private async request(
    url: string,
    init: RequestInit,
    signal: AbortSignal | undefined,
    accept: string,
  ): Promise<Response> {
    const combined = combineSignals(signal, this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), accept },
        signal: combined.signal,
      });
      return response;
    } catch (error) {
      if (combined.timedOut()) {
        throw new ComfyError(
          "timeout",
          `Le serveur ComfyUI n'a pas répondu en ${Math.round(this.requestTimeoutMs / 1000)} s ` +
            `(${url}).`,
          { cause: error },
        );
      }
      if (signal?.aborted) {
        throw new ComfyError("cancelled", "Génération d'image annulée.", { cause: error });
      }
      throw networkFailure(error, url);
    } finally {
      combined.dispose();
    }
  }

  /** Corps d'erreur lu UNE fois (borné) pour composer un message honnête. */
  private async failure(
    response: Response,
    url: string,
    code: ComfyErrorCode = "http_error",
  ): Promise<ComfyError> {
    let text = "";
    try {
      text = await response.text();
    } catch {
      // Corps illisible : on garde au moins le statut.
    }
    const serverMessage = serverErrorMessage(text);
    const nodeErrors = describeNodeErrors(parseJsonOrNull(text));
    const detail = serverMessage ? ` : ${serverMessage}` : "";
    const nodes =
      nodeErrors.length > 0 ? ` Nœuds en erreur : ${nodeErrors.join(", ")}.` : "";
    const effectiveCode: ComfyErrorCode =
      response.status === 400 && code === "http_error" ? "invalid_prompt" : code;
    const prefix =
      effectiveCode === "invalid_prompt"
        ? "ComfyUI a REFUSÉ le graphe"
        : "ComfyUI a répondu une erreur";
    return new ComfyError(
      effectiveCode,
      `${prefix} (HTTP ${response.status}) sur ${url}${detail}.${nodes}`,
      { status: response.status, serverMessage },
    );
  }

  /** `GET /system_stats` — sert au bouton « Tester la connexion ». */
  async systemStats(signal?: AbortSignal): Promise<ComfySystemStats> {
    const { base, headers } = this.endpoint();
    const url = `${base}/system_stats`;
    const response = await this.request(url, { method: "GET", headers }, signal, "application/json");
    if (!response.ok) throw await this.failure(response, url);
    const text = await response.text();
    const parsed = parseJsonOrNull(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ComfyError(
        "invalid_response",
        `Le serveur a répondu sur /system_stats mais pas au format attendu ` +
          `(JSON objet). Réponse : ${text.slice(0, 120)}`,
        { status: response.status },
      );
    }
    const root = parsed as Record<string, unknown>;
    const system =
      root.system && typeof root.system === "object" && !Array.isArray(root.system)
        ? (root.system as Record<string, unknown>)
        : {};
    const version =
      typeof system.comfyui_version === "string" ? system.comfyui_version : undefined;
    const devices = Array.isArray(root.devices)
      ? root.devices
          .map((device) =>
            device && typeof device === "object"
              ? (device as Record<string, unknown>).name
              : undefined,
          )
          .filter((name): name is string => typeof name === "string" && name !== "")
          .slice(0, 8)
      : [];
    return { ...(version !== undefined ? { version } : {}), devices };
  }

  /** `POST /prompt` — soumet le graphe, renvoie l'identifiant du prompt. */
  async submit(
    workflow: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string> {
    const { base, headers } = this.endpoint();
    const url = `${base}/prompt`;
    const response = await this.request(
      url,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        // ⚠️ `prompt` = le graphe LUI-MÊME. `client_id` identifie seulement le client.
        body: JSON.stringify({ prompt: workflow, client_id: "yuki-gateway" }),
      },
      signal,
      "application/json",
    );
    if (!response.ok) {
      throw await this.failure(response, url, response.status === 400 ? "invalid_prompt" : "http_error");
    }
    const text = await response.text();
    const parsed = parseJsonOrNull(text);
    const promptId =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).prompt_id
        : undefined;
    if (typeof promptId !== "string" || promptId.trim() === "") {
      throw new ComfyError(
        "invalid_response",
        "ComfyUI n'a pas renvoyé d'identifiant de prompt (`prompt_id`) : " +
          `réponse inattendue ${text.slice(0, 120)}`,
      );
    }
    this.logger?.info("comfy.prompt.submitted", { promptId });
    return promptId.trim();
  }

  /** `GET /history/{id}` — `null` tant que le prompt n'est pas terminé. */
  async history(promptId: string, signal?: AbortSignal): Promise<unknown | null> {
    const { base, headers } = this.endpoint();
    const url = `${base}/history/${encodeURIComponent(promptId)}`;
    const response = await this.request(url, { method: "GET", headers }, signal, "application/json");
    if (!response.ok) throw await this.failure(response, url);
    const text = await response.text();
    const parsed = parseJsonOrNull(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ComfyError(
        "invalid_response",
        `L'historique de ComfyUI n'est pas un objet JSON (${url}). Réponse : ` +
          text.slice(0, 120),
      );
    }
    const entry = (parsed as Record<string, unknown>)[promptId];
    return entry === undefined ? null : entry;
  }

  /** `GET /view` — octets de l'image produite. */
  async view(ref: ComfyImageRef, signal?: AbortSignal): Promise<ComfyImageBytes> {
    const { base, headers } = this.endpoint();
    const params = new URLSearchParams({
      filename: ref.filename,
      subfolder: ref.subfolder,
      type: ref.type,
    });
    const url = `${base}/view?${params.toString()}`;
    const response = await this.request(
      url,
      { method: "GET", headers },
      signal,
      "image/*",
    );
    if (!response.ok) throw await this.failure(response, url);
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (!contentType.startsWith("image/")) {
      throw new ComfyError(
        "invalid_response",
        `ComfyUI a renvoyé autre chose qu'une image (${contentType || "type inconnu"}) ` +
          `pour ${ref.filename}.`,
        { status: response.status },
      );
    }
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength === 0) {
      throw new ComfyError(
        "invalid_response",
        `L'image renvoyée par ComfyUI est vide (${ref.filename}).`,
      );
    }
    if (buffer.byteLength > MAX_COMFY_IMAGE_BYTES) {
      throw new ComfyError(
        "image_too_large",
        `L'image générée dépasse le plafond (${buffer.byteLength} octets, maximum ` +
          `${MAX_COMFY_IMAGE_BYTES}) : elle n'est pas conservée.`,
      );
    }
    return {
      bytes: buffer,
      mimeType: contentType.split(";")[0]?.trim() || "image/png",
      nodeId: ref.nodeId,
      filename: ref.filename,
      subfolder: ref.subfolder,
      type: ref.type,
      promptId: "",
    };
  }

  /**
   * Soumet, ATTEND (délai borné, sondage de l'historique) puis récupère l'image.
   *
   * ⚠️ L'attente est découpée en requêtes COURTES (sondage) : aucune connexion
   * n'est tenue ouverte pendant des minutes, et l'annulation du tour interrompt
   * la boucle.
   */
  async generate(
    workflow: Record<string, unknown>,
    options: {
      signal?: AbortSignal;
      onProgress?: (progress: ComfyProgress) => void;
      outputNodeId?: string;
    } = {},
  ): Promise<ComfyImageBytes> {
    const startedAt = this.now();
    const timeoutMs = Math.max(1_000, this.generationTimeoutMs());
    const promptId = await this.submit(workflow, options.signal);
    options.onProgress?.({ phase: "submitted", promptId, elapsedMs: this.now() - startedAt });

    let entry: unknown | null = null;
    for (;;) {
      if (options.signal?.aborted) {
        throw new ComfyError("cancelled", "Génération d'image annulée.");
      }
      entry = await this.history(promptId, options.signal);
      if (entry !== null) break;
      const elapsed = this.now() - startedAt;
      if (elapsed >= timeoutMs) {
        throw new ComfyError(
          "timeout",
          `La génération n'a pas abouti en ${Math.round(timeoutMs / 1000)} s ` +
            `(prompt ${promptId}). Elle est peut-être encore en file sur ComfyUI : ` +
            "vérifiez la file du serveur avant de relancer.",
        );
      }
      options.onProgress?.({ phase: "waiting", promptId, elapsedMs: elapsed });
      await sleep(Math.min(this.pollIntervalMs, Math.max(100, timeoutMs - elapsed)), options.signal);
    }

    const parsed = parseHistoryEntry(entry);
    if (parsed.statusStr === "error") {
      const detail =
        parsed.statusMessages.length > 0
          ? ` Messages du serveur : ${parsed.statusMessages.join(" | ")}.`
          : "";
      throw new ComfyError(
        "execution_failed",
        `L'exécution du workflow a ÉCHOUÉ côté ComfyUI (prompt ${promptId}).${detail}`,
        { serverMessage: parsed.statusMessages.join(" | ") || undefined },
      );
    }
    const outputNodeId = options.outputNodeId?.trim() ?? "";
    let ref: ComfyImageRef | null;
    if (outputNodeId !== "") {
      // ⚠️ PIÈGE ① : étiquette `YUKI_OUTPUT` PRÉSENTE ⇒ on ne lit QUE ce nœud.
      // Aucune image de sa part = ÉCHEC explicite, JAMAIS un repli silencieux
      // sur un autre nœud (ce serait rendre une image qu'on n'a pas choisie).
      ref = findImageRefForNode(parsed.outputs, outputNodeId);
      if (!ref) {
        const knownNodes = Object.keys(parsed.outputs);
        throw new ComfyError(
          "no_image",
          `Le nœud étiqueté « YUKI_OUTPUT » (id ${outputNodeId}) n'a produit ` +
            "AUCUNE image : rien n'est affiché, et Yuki ne prend PAS l'image d'un " +
            "autre nœud à sa place. Vérifiez que ce nœud est bien exécuté par le " +
            "graphe et qu'il produit une image (SaveImage ou PreviewImage)." +
            (knownNodes.length > 0
              ? ` Nœuds ayant produit une sortie : ${knownNodes.slice(0, 8).join(", ")}.`
              : " Aucun nœud n'a produit de sortie."),
        );
      }
    } else {
      // Comportement HISTORIQUE (aucune étiquette `YUKI_OUTPUT`) : première
      // image produite. C'est dit à l'appelant (journal + résultat de l'outil).
      ref = findImageRef(parsed.outputs);
      if (!ref) {
        throw new ComfyError(
          "no_image",
          "ComfyUI a terminé SANS produire d'image : le graphe n'a pas de nœud " +
            "« Save Image » (ou « Preview Image ») actif, ou il n'a rien " +
            "enregistré. Ajoutez-en un dans le workflow.",
        );
      }
    }
    options.onProgress?.({
      phase: "downloading",
      promptId,
      elapsedMs: this.now() - startedAt,
    });
    const image = await this.view(ref, options.signal);
    this.logger?.info("comfy.image.fetched", {
      promptId,
      nodeId: ref.nodeId,
      type: ref.type,
      bytes: image.bytes.byteLength,
      mimeType: image.mimeType,
      elapsedMs: this.now() - startedAt,
    });
    return { ...image, promptId };
  }
}

/** Lecture défensive d'une entrée d'historique terminée. */
function parseHistoryEntry(entry: unknown): {
  outputs: Record<string, unknown>;
  statusStr: string | undefined;
  statusMessages: string[];
} {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { outputs: {}, statusStr: undefined, statusMessages: [] };
  }
  const root = entry as Record<string, unknown>;
  const outputs =
    root.outputs && typeof root.outputs === "object" && !Array.isArray(root.outputs)
      ? (root.outputs as Record<string, unknown>)
      : {};
  const status =
    root.status && typeof root.status === "object" && !Array.isArray(root.status)
      ? (root.status as Record<string, unknown>)
      : {};
  const statusStr = typeof status.status_str === "string" ? status.status_str : undefined;
  const messages: string[] = [];
  if (Array.isArray(status.messages)) {
    for (const raw of status.messages.slice(0, 5)) {
      // ComfyUI publie des paires [type, données] : on garde le texte utile.
      const text =
        Array.isArray(raw) && raw.length === 2
          ? `${String(raw[0])}: ${safeStringify(raw[1])}`
          : safeStringify(raw);
      if (text) messages.push(text.slice(0, 300));
    }
  }
  return { outputs, statusStr, statusMessages: messages };
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 300);
  if (value === undefined) return "";
  try {
    return JSON.stringify(value).slice(0, 300);
  } catch {
    return String(value).slice(0, 300);
  }
}

/**
 * Images publiées par UN nœud (`outputs[nodeId].images[]`), ou `null` si ce
 * nœud n'a rien produit.
 *
 * ⚠️ Aucune image trouvée n'est PAS un prétexte pour regarder ailleurs :
 * l'appelant doit échouer explicitement (PIÈGE ①).
 */
export function findImageRefForNode(
  outputs: Record<string, unknown>,
  nodeId: string,
): ComfyImageRef | null {
  const found = imagesOfNode(outputs[nodeId]).map((ref) => ({ ...ref, nodeId }));
  const output = found.find((ref) => ref.type === "output");
  return output ?? found[0] ?? null;
}

/** Images publiées par la sortie d'un nœud (forme défensive : `images[]`). */
function imagesOfNode(output: unknown): Omit<ComfyImageRef, "nodeId">[] {
  const found: Omit<ComfyImageRef, "nodeId">[] = [];
  if (!output || typeof output !== "object" || Array.isArray(output)) return found;
  const images = (output as Record<string, unknown>).images;
  if (!Array.isArray(images)) return found;
  for (const image of images) {
    if (!image || typeof image !== "object" || Array.isArray(image)) continue;
    const entry = image as Record<string, unknown>;
    const filename = entry.filename;
    if (typeof filename !== "string" || filename.trim() === "") continue;
    found.push({
      filename: filename.trim(),
      subfolder: typeof entry.subfolder === "string" ? entry.subfolder : "",
      type: typeof entry.type === "string" && entry.type !== "" ? entry.type : "output",
    });
  }
  return found;
}

/**
 * Trouve la PREMIÈRE image dans `outputs` (⚠️ c'est là que ComfyUI met le nom
 * de fichier produit). On préfère `type: "output"` (nœud « Save Image ») à une
 * prévisualisation `temp`.
 *
 * ⚠️ Ce chemin n'est utilisé QUE si le workflow ne porte pas `YUKI_OUTPUT` :
 * il peut rendre l'image d'un APERÇU intermédiaire, et l'appelant doit le DIRE.
 */
export function findImageRef(outputs: Record<string, unknown>): ComfyImageRef | null {
  const found: ComfyImageRef[] = [];
  for (const [nodeId, output] of Object.entries(outputs)) {
    for (const ref of imagesOfNode(output)) found.push({ ...ref, nodeId });
  }
  const output = found.find((ref) => ref.type === "output");
  return output ?? found[0] ?? null;
}
