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
 *                                  (+ `subfolder`, `type`). ⚠️ Le TEXTE d'un
 *                                  nœud d'AFFICHAGE est dans
 *                                  `outputs[<nœud>].text` (forme vérifiée dans
 *                                  `comfy_extras/nodes_preview_any.py` :
 *                                  `{"ui": {"text": (v,)}}`, donc un TABLEAU ;
 *                                  `ShowText`/`AIHToText` publient aussi une
 *                                  liste) — c'est ce que lit `YUKI_FINAL_PROMPT`.
 *  3. `GET  /view?filename=…&subfolder=…&type=…`
 *                                 → les OCTETS de l'image (`image/png`).
 *  4. `GET  /system_stats`       → `{ system: { comfyui_version, … }, devices: […] }`
 *                                  (bouton « Tester la connexion »).
 *  5. `GET  /queue`              → `{ queue_running: [...], queue_pending: [...] }`
 *                                  (SURVEILLANCE : le serveur DIT s'il travaille
 *                                  encore sur notre prompt). Chaque entrée est
 *                                  l'élément de file de ComfyUI ; le `prompt_id`
 *                                  est lu sur les DEUX formes connues (tableau
 *                                  `[number, prompt_id, …]` ou objet
 *                                  `{ prompt_id }`) — voir `promptIdsOfQueue`.
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
 *
 * ⚠️⚠️ L'ARRÊT NE SE DÉCIDE PAS SUR UN MINUTEUR, MAIS SUR L'ÉTAT DU SERVEUR
 * (2026-11-03). Un délai fixe est toujours faux : trop court, il coupe un calcul
 * LÉGITIME (une vidéo de dix minutes) ; trop long, il fait attendre sur un job
 * MORT. ComfyUI expose sa file (`GET /queue`) : on la LUI DEMANDE.
 *
 *  1. le travail est dans `queue_running` **ou** `queue_pending` ⇒ le serveur
 *     travaille POUR NOUS : aucun arrêt (seul le PLAFOND DE SÉCURITÉ,
 *     `generationTimeoutMs`, peut encore couper — il est très haut, réglable) ;
 *  2. le travail a DISPARU de la file ⇒ on vérifie `/history` :
 *     · présent ⇒ c'est fini (succès, ou `status_str = "error"` lu plus bas) ;
 *     · absent ⇒ il est mort sans résultat : on accorde une GRÂCE
 *       (`jobGraceMs`, 30 s — course connue de ComfyUI entre la sortie de file
 *       et l'écriture de l'historique), puis on ÉCHOUE en le disant ;
 *  3. `/queue` indisponible (proxy, version ancienne) ⇒ repli DOCUMENTÉ sur
 *     `/history` seul, borné par le plafond de sécurité — la surveillance ne
 *     peut pas être pire qu'avant, et le journal dit pourquoi.
 *
 * ⚠️ Le `prompt_id` rendu par `POST /prompt` est conservé de bout en bout : c'est
 * lui qui permet d'interroger `/queue` ET `/history` pour CE travail.
 */

import type {
  ComfyConfigProvider,
  ComfyErrorCode,
  ComfyFinalPromptResult,
  ComfyImageBytes,
  ComfyLogger,
} from "./types.js";
import { ComfyError } from "./types.js";

/** Délai d'UNE requête HTTP vers ComfyUI (soumise, file, historique, image). */
export const DEFAULT_COMFY_REQUEST_TIMEOUT_MS = 20_000;
/**
 * PLAFOND DE SÉCURITÉ d'une génération complète (ms) — 1 HEURE.
 *
 * ⚠️ Ce n'est PAS le mécanisme d'arrêt (voir le commentaire d'en-tête) : c'est le
 * filet de dernier recours, pour qu'un travail qui resterait EN FILE
 * ÉTERNELLEMENT (serveur bloqué, job orphelin) ne tienne pas une place
 * indéfiniment. Il est réglable (`images.timeoutMs`) et doit rester SOUS
 * `toolWatchdogMs` (dérivé : plafond + 60 s), SOUS la borne du tour de canal
 * (`CHAT_REPLY_TIMEOUT_MS` + plafond) et sous `delegation.totalTimeoutMs`
 * (`src/config/schema.ts`).
 */
export const DEFAULT_COMFY_GENERATION_TIMEOUT_MS = 3_600_000;
/** Intervalle entre deux lectures de l'état (file + historique). */
export const DEFAULT_COMFY_POLL_INTERVAL_MS = 1_000;
/**
 * GRÂCE accordée après la DISPARITION du travail de la file, avant de conclure
 * qu'il est mort sans résultat (ms).
 *
 * ⚠️ POURQUOI 30 s : ComfyUI écrit l'entrée `/history` APRÈS avoir retiré le
 * travail de la file — l'ordre n'est pas garanti à la milliseconde. Sans cette
 * grâce, une génération RÉUSSIE serait déclarée morte entre les deux. 30 s est
 * très au-dessus de cette course, et très en dessous de ce qu'une personne
 * attend avant de renoncer : un job fantôme est détecté en 30 s, pas au plafond.
 */
export const DEFAULT_COMFY_JOB_GRACE_MS = 30_000;
/**
 * Échecs CONSÉCUTIFS de surveillance tolérés avant d'abandonner (serveur qui
 * hoquette, requête qui expire). Au-delà, l'erreur RÉELLE est remontée : jamais
 * un abandon silencieux, jamais une attente qui se prolonge sur un serveur mort.
 */
export const MAX_COMFY_MONITOR_FAILURES = 3;
/** Plafond des octets récupérés pour une image générée. */
export const MAX_COMFY_IMAGE_BYTES = 24 * 1024 * 1024;

/**
 * Plafond du TEXTE lu sur le nœud étiqueté `YUKI_FINAL_PROMPT` (caractères).
 *
 * ⚠️ Un prompt final peut être très long (un enhancer peut produire plusieurs
 * milliers de caractères, un nœud d'affichage peut publier un JSON entier) : on
 * BORNE ce qui voyage jusqu'à l'interface, et la coupe est TOUJOURS dite
 * (`truncated`/`totalChars`).
 */
export const MAX_FINAL_PROMPT_CHARS = 8_000;

/** État du travail tel que le SERVEUR le décrit (`GET /queue`). */
export type ComfyJobState =
  /** `queue_running` : le serveur l'exécute en ce moment. */
  | "running"
  /** `queue_pending` : accepté, en attente d'un emplacement. */
  | "pending"
  /** Ni dans `/queue` ni dans `/history` ⇒ mort sans résultat (après la grâce). */
  | "absent"
  /** `/queue` indisponible : l'état n'est pas observable (repli sur `/history`). */
  | "unknown";

/** Étape observée d'une génération (progression rapportée à l'outil). */
export interface ComfyProgress {
  phase: "submitted" | "waiting" | "downloading";
  promptId: string;
  elapsedMs: number;
  /** Ce que le SERVEUR dit du travail au moment du rapport (absent hors attente). */
  state?: ComfyJobState;
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
      /**
       * Nœud étiqueté `YUKI_FINAL_PROMPT` : on lit le TEXTE qu'il publie
       * (`outputs[<nœud>].text`). `undefined` ⇒ rien n'est lu.
       */
      finalPromptNodeId?: string;
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
  /**
   * PLAFOND DE SÉCURITÉ d'une génération (lu à chaud : réglable sans
   * redémarrage). ⚠️ Ce n'est pas le mécanisme d'arrêt : c'est `GET /queue` qui
   * dit si le serveur travaille encore (voir `generate`).
   */
  generationTimeoutMs?: () => number;
  pollIntervalMs?: number;
  /** Grâce après disparition de la file, avant de conclure à un échec (ms). */
  jobGraceMs?: number;
  now?: () => number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Durée LISIBLE par un humain (jamais « 3600000 ms » dans un message). */
export function durationText(ms: number): string {
  const value = Math.max(0, Math.round(ms));
  if (value < 1_000) return `${value} ms`;
  if (value < 60_000) return `${Math.round(value / 1_000)} s`;
  // ⚠️ Une HEURE PLEINE se dit « 1 heure », jamais « 60 min » : c'est la valeur
  // du plafond par défaut, et le message doit être lisible tel quel.
  if (value >= 3_600_000 && value % 60_000 === 0) {
    const minutes = value / 60_000;
    if (minutes % 60 === 0) {
      const heures = minutes / 60;
      return `${heures} heure${heures > 1 ? "s" : ""}`;
    }
  }
  const minutes = Math.round((value / 60_000) * 10) / 10;
  return `${minutes} min`;
}

/**
 * Identifiants de prompt d'une liste de `/queue` (`queue_running`/
 * `queue_pending`).
 *
 * ⚠️ DEUX FORMES CONNUES, aucune devinée : l'entrée de file de ComfyUI est un
 * TABLEAU `[number, prompt_id, prompt, extra_data, outputs_to_execute]`
 * (`QueueItem`, sérialisé en tableau JSON) ou, selon la version, un OBJET portant
 * `prompt_id`. Une entrée d'une autre forme est IGNORÉE (elle ne peut pas être
 * notre prompt) — jamais une exception : une forme inattendue ne doit pas faire
 * croire que le serveur a perdu le travail.
 */
export function promptIdsOfQueue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      if (item.trim() !== "") out.push(item.trim());
      continue;
    }
    if (Array.isArray(item)) {
      const second = item[1];
      if (typeof second === "string" && second.trim() !== "") out.push(second.trim());
      continue;
    }
    if (item && typeof item === "object") {
      const promptId = (item as Record<string, unknown>).prompt_id;
      if (typeof promptId === "string" && promptId.trim() !== "") out.push(promptId.trim());
    }
  }
  return out;
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
  private readonly jobGraceMs: number;
  private readonly now: () => number;

  constructor(options: ComfyClientOptions) {
    this.config = options.config;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_COMFY_REQUEST_TIMEOUT_MS;
    this.generationTimeoutMs =
      options.generationTimeoutMs ?? (() => DEFAULT_COMFY_GENERATION_TIMEOUT_MS);
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_COMFY_POLL_INTERVAL_MS;
    this.jobGraceMs = Math.max(0, Math.trunc(options.jobGraceMs ?? DEFAULT_COMFY_JOB_GRACE_MS));
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

  /**
   * Un échec de SURVEILLANCE doit-il être retenté ?
   *
   * ⚠️ RÈGLE TRANCHÉE : une erreur PASSAGÈRE (serveur injoignable, requête
   * expirée) est retentée `MAX_COMFY_MONITOR_FAILURES` fois CONSÉCUTIVES (elle
   * est journalisée à chaque fois) ; au-delà, l'erreur RÉELLE est remontée (une
   * image n'est jamais déclarée générée sur un serveur muet).
   *
   * ⚠️ Une annulation n'est JAMAIS retentée, et une erreur de configuration non
   * plus. Quand `allowUnsupported` est vrai (appel `/queue`), une réponse non
   * exploitable rend `"unsupported"` : l'appelant bascule sur `/history` seul
   * plutôt que d'échouer (le repli est journalisé).
   */
  private tolerateMonitorFailure(
    error: unknown,
    failures: number,
    promptId: string,
    allowUnsupported = false,
  ): number | "unsupported" {
    if (error instanceof ComfyError && error.code === "cancelled") throw error;
    const unsupported =
      error instanceof ComfyError &&
      (error.code === "http_error" || error.code === "invalid_response");
    if (allowUnsupported && unsupported) return "unsupported";
    const transient =
      !(error instanceof ComfyError) ||
      error.code === "unreachable" ||
      error.code === "timeout";
    const next = failures + 1;
    if (!transient || next >= MAX_COMFY_MONITOR_FAILURES) throw error;
    this.logger?.warn("comfy.monitor.retry", {
      promptId,
      failures: next,
      max: MAX_COMFY_MONITOR_FAILURES,
      error: messageOf(error),
    });
    return next;
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

  /**
   * `GET /queue` — l'état de la file, réduit aux IDENTIFIANTS de prompt.
   *
   * ⚠️ Forme de réponse (documentée, jamais devinée) :
   * `{ "queue_running": [ … ], "queue_pending": [ … ] }` — deux LISTES. Chaque
   * élément est l'entrée de file de ComfyUI ; selon la version c'est un TABLEAU
   * `[number, prompt_id, prompt, extra_data, outputs_to_execute]` ou un OBJET
   * portant `prompt_id`. Les deux formes sont lues (`promptIdsOfQueue`) : une
   * forme inconnue rend une liste VIDE, jamais une erreur de type.
   */
  async queue(
    signal?: AbortSignal,
  ): Promise<{ running: string[]; pending: string[] }> {
    const { base, headers } = this.endpoint();
    const url = `${base}/queue`;
    const response = await this.request(url, { method: "GET", headers }, signal, "application/json");
    if (!response.ok) throw await this.failure(response, url);
    const text = await response.text();
    const parsed = parseJsonOrNull(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ComfyError(
        "invalid_response",
        `La file de ComfyUI n'est pas un objet JSON (${url}). Réponse : ${text.slice(0, 120)}`,
        { status: response.status },
      );
    }
    const root = parsed as Record<string, unknown>;
    return {
      running: promptIdsOfQueue(root.queue_running),
      pending: promptIdsOfQueue(root.queue_pending),
    };
  }

  /**
   * Ce que le SERVEUR dit de NOTRE travail : en cours, en attente, ou absent.
   *
   * ⚠️ `absent` n'est PAS un échec en soi : c'est le signal qui déclenche la
   * fenêtre de grâce (l'historique peut se remplir juste après la sortie de file).
   */
  private async jobState(promptId: string, signal?: AbortSignal): Promise<ComfyJobState> {
    const queue = await this.queue(signal);
    if (queue.running.includes(promptId)) return "running";
    if (queue.pending.includes(promptId)) return "pending";
    return "absent";
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
   * Soumet, SURVEILLE l'ÉTAT du serveur jusqu'à la fin, puis récupère l'image.
   *
   * ⚠️ L'attente est découpée en requêtes COURTES (sondage) : aucune connexion
   * n'est tenue ouverte pendant des minutes, et l'annulation du tour interrompt
   * la boucle.
   *
   * ⚠️⚠️ L'ARRÊT SE DÉCIDE SUR L'ÉTAT, PAS SUR UN MINUTEUR (2026-11-03) :
   *  - le travail est dans `/queue` (`queue_running` ou `queue_pending`) ⇒ le
   *    serveur travaille POUR NOUS, aucune coupure (10 min de vidéo passent) ;
   *  - il en a DISPARU et `/history` ne le connaît pas encore ⇒ fenêtre de
   *    grâce (`jobGraceMs`, 30 s) puis échec explicite (`job_lost`) ;
   *  - il en a disparu ET `/history` le connaît ⇒ terminé (succès ou erreur) ;
   *  - `/queue` inexploitable ⇒ repli documenté sur `/history` seul, borné par
   *    le PLAFOND DE SÉCURITÉ (`generationTimeoutMs`) — jamais une attente
   *    infinie, jamais un arrêt silencieux.
   */
  async generate(
    workflow: Record<string, unknown>,
    options: {
      signal?: AbortSignal;
      onProgress?: (progress: ComfyProgress) => void;
      outputNodeId?: string;
      finalPromptNodeId?: string;
    } = {},
  ): Promise<ComfyImageBytes> {
    const startedAt = this.now();
    // ⚠️ PLAFOND DE SÉCURITÉ (et non mécanisme d'arrêt) : relu à CHAQUE
    // GÉNÉRATION (un changement dans `/config` s'applique donc à la suivante).
    const ceilingMs = Math.max(1_000, Math.trunc(this.generationTimeoutMs()));
    const promptId = await this.submit(workflow, options.signal);
    options.onProgress?.({ phase: "submitted", promptId, elapsedMs: this.now() - startedAt });

    let entry: unknown | null = null;
    /** Début de la fenêtre de GRÂCE après disparition de la file, ou `undefined`. */
    let missingSince: number | undefined;
    /** `/queue` inexploitable ⇒ on ne le redemande plus et on le DIT une fois. */
    let queueUnavailable = false;
    /** Échecs consécutifs de surveillance (requête expirée, serveur injoignable). */
    let failures = 0;
    let lastState: ComfyJobState = "unknown";

    for (;;) {
      if (options.signal?.aborted) {
        throw new ComfyError("cancelled", "Génération d'image annulée.");
      }

      // ① RÉSULTAT — la seule preuve d'une fin : ComfyUI a écrit l'historique.
      try {
        entry = await this.history(promptId, options.signal);
        failures = 0;
      } catch (error) {
        const outcome = this.tolerateMonitorFailure(error, failures, promptId);
        failures = outcome === "unsupported" ? failures : outcome;
        entry = null;
      }
      if (entry !== null) break;

      // ② ÉTAT — le serveur travaille-t-il ENCORE sur ce prompt ?
      if (!queueUnavailable) {
        try {
          lastState = await this.jobState(promptId, options.signal);
          failures = 0;
        } catch (error) {
          const reason = this.tolerateMonitorFailure(error, failures, promptId, true);
          if (reason === "unsupported") {
            // Repli DOCUMENTÉ : `/history` seul + plafond de sécurité (le
            // comportement d'avant), et le journal dit POURQUOI.
            queueUnavailable = true;
            this.logger?.warn("comfy.queue.unavailable", {
              promptId,
              reason:
                "GET /queue n'est pas exploitable sur ce serveur : la surveillance " +
                "se replie sur /history, bornée par le plafond de sécurité",
              error: messageOf(error),
            });
          } else {
            failures = reason;
          }
          lastState = "unknown";
        }
      }

      const now = this.now();
      if (lastState === "running" || lastState === "pending") {
        // ⚠️ PREUVE que le serveur travaille : la disparition est ANNULÉE (un
        // travail remis en file ne repart pas de zéro dans notre compte).
        if (missingSince !== undefined) {
          this.logger?.info("comfy.job.requeued", { promptId, state: lastState });
        }
        missingSince = undefined;
      } else if (lastState === "absent") {
        if (missingSince === undefined) {
          missingSince = now;
          this.logger?.warn("comfy.job.missing", {
            promptId,
            graceMs: this.jobGraceMs,
            reason:
              "le travail n'est plus dans la file et l'historique ne le connaît pas " +
              "encore : fenêtre de grâce avant de conclure à un échec",
          });
        } else if (now - missingSince >= this.jobGraceMs) {
          throw new ComfyError(
            "job_lost",
            `Le travail (prompt ${promptId}) a DISPARU de la file de ComfyUI sans laisser ` +
              `de résultat : ${durationText(this.jobGraceMs)} après sa disparition, ` +
              "l'historique ne le connaît toujours pas. Causes possibles : travail " +
              "annulé sur le serveur, ou serveur redémarré pendant le calcul. Rien n'a " +
              "été produit.",
          );
        }
      }

      // ③ PLAFOND DE SÉCURITÉ — filet de dernier recours, TOUJOURS annoncé.
      const elapsed = now - startedAt;
      if (elapsed >= ceilingMs) {
        throw new ComfyError(
          "timeout",
          lastState === "running" || lastState === "pending"
            ? `La génération a été arrêtée au PLAFOND DE SÉCURITÉ ` +
                `(${durationText(ceilingMs)}) : ComfyUI la signalait ENCORE EN COURS ` +
                `après ${durationText(ceilingMs)} (prompt ${promptId}). C'est un cas ` +
                "RARISSIME : une génération ordinaire prend quelques minutes, et elle " +
                "n'est JAMAIS coupée tant que le serveur la déclare dans sa file. Si ce " +
                "plafond coupe, c'est donc un BLOCAGE (travail orphelin, file figée), " +
                "pas une lenteur. Elle n'est pas perdue : le calcul continue peut-être " +
                "sur le serveur. Vérifiez la file du serveur, puis relancez. Relevez le " +
                "plafond (Paramètres → Images → délai maximal d'une génération) " +
                "seulement si ce travail doit légitimement durer plus longtemps."
            : `La génération n'a pas abouti en ${durationText(ceilingMs)} ` +
                `(prompt ${promptId}). Elle est peut-être encore en file sur ComfyUI : ` +
                "vérifiez la file du serveur avant de relancer.",
        );
      }
      options.onProgress?.({ phase: "waiting", promptId, elapsedMs: elapsed, state: lastState });
      // ⚠️ La pause est bornée par ce qui reste AVANT la première échéance
      // (plafond, ou fin de la grâce) : on ne dépasse pas de plusieurs secondes.
      const untilGrace =
        missingSince === undefined ? Number.POSITIVE_INFINITY : missingSince + this.jobGraceMs - now;
      const wait = Math.max(1, Math.min(this.pollIntervalMs, ceilingMs - elapsed, untilGrace));
      await sleep(wait, options.signal);
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
    // ⚠️ `YUKI_FINAL_PROMPT` : le texte est lu dans le MÊME historique, mais sur
    // le nœud de l'étiquette — jamais sur le nœud de l'image (PIÈGE ② : un nœud
    // peut publier `ui.text` ET `ui.images`, on ne confond pas les deux).
    const finalPromptNodeId = options.finalPromptNodeId?.trim() ?? "";
    const finalPrompt =
      finalPromptNodeId !== ""
        ? readFinalPrompt(parsed.outputs, finalPromptNodeId, this.logger, promptId)
        : undefined;
    this.logger?.info("comfy.image.fetched", {
      promptId,
      nodeId: ref.nodeId,
      type: ref.type,
      bytes: image.bytes.byteLength,
      mimeType: image.mimeType,
      elapsedMs: this.now() - startedAt,
    });
    return {
      ...image,
      promptId,
      ...(finalPrompt !== undefined ? { finalPrompt } : {}),
    };
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

/**
 * Texte publié par un nœud d'AFFICHAGE, lu dans `outputs[<nœud>].text`.
 *
 * ⚠️ Forme VÉRIFIÉE dans le code source (voir `ComfyFinalPromptText`) : les
 * nœuds d'affichage publient `ui.text` sous forme de TUPLE/LISTE (⇒ tableau JSON
 * `"text": ["…"]`) ; une CHAÎNE simple est aussi acceptée (nœud maison).
 *
 * ⚠️ On ne lit QUE cette clé : un nœud qui publie `ui.images` (ou `ui.prompt`)
 * n'est PAS un nœud d'affichage de texte, et on ne prend pas son image pour un
 * prompt (PIÈGE ②).
 */
export type FinalPromptRead =
  | { status: "found"; text: string; totalChars: number; truncated: boolean }
  | { status: "empty"; publishedKeys: string[] };

/** Texte brut publié par un nœud, ou `null` s'il n'en publie aucun. */
function textOfNode(output: unknown): string | null {
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const raw = (output as Record<string, unknown>).text;
  if (typeof raw === "string") return raw;
  if (!Array.isArray(raw)) return null;
  // `ui.text` est une liste : on garde les entrées TEXTE, dans l'ordre publié.
  return raw.filter((entry): entry is string => typeof entry === "string").join("\n");
}

/**
 * Coupe `text` à `limit` caractères SANS séparer une paire de substitution
 * (emoji) : une demi-paire serait affichée comme un caractère de remplacement.
 */
function sliceText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const last = text.charCodeAt(limit - 1);
  const cut = last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit;
  return text.slice(0, cut);
}

/**
 * Lit le prompt final publié par le nœud étiqueté `YUKI_FINAL_PROMPT`.
 *
 * ⚠️ Aucun repli sur un autre nœud : si celui-ci ne publie pas de texte, on
 * renvoie `status: "empty"` avec les clés RÉELLEMENT publiées, pour que
 * l'appelant le DISE (jamais un silence).
 */
export function findFinalPromptText(
  outputs: Record<string, unknown>,
  nodeId: string,
  maxChars: number = MAX_FINAL_PROMPT_CHARS,
): FinalPromptRead {
  const output = outputs[nodeId];
  const text = textOfNode(output);
  const trimmed = (text ?? "").trim();
  if (trimmed === "") {
    return {
      status: "empty",
      publishedKeys:
        output && typeof output === "object" && !Array.isArray(output)
          ? Object.keys(output as Record<string, unknown>).slice(0, 8)
          : [],
    };
  }
  const limit = Math.max(0, Math.trunc(maxChars));
  const bounded = sliceText(trimmed, limit);
  return {
    status: "found",
    text: bounded,
    totalChars: trimmed.length,
    truncated: bounded.length < trimmed.length,
  };
}

/** Lit le prompt final, JOURNALISE l'issue et l'emballe pour `ComfyImageBytes`. */
function readFinalPrompt(
  outputs: Record<string, unknown>,
  nodeId: string,
  logger: ComfyLogger | undefined,
  promptId: string,
): ComfyFinalPromptResult {
  const read = findFinalPromptText(outputs, nodeId);
  if (read.status === "empty") {
    logger?.warn("comfy.final_prompt.empty", {
      promptId,
      nodeId,
      publishedKeys: read.publishedKeys,
      reason:
        "le nœud étiqueté YUKI_FINAL_PROMPT n'a publié aucun texte " +
        "(la sortie d'un nœud d'affichage doit être dans `ui.text`)",
    });
    return { status: "empty", nodeId, publishedKeys: read.publishedKeys };
  }
  logger?.info("comfy.final_prompt.read", {
    promptId,
    nodeId,
    chars: read.text.length,
    totalChars: read.totalChars,
    truncated: read.truncated,
  });
  return {
    status: "found",
    prompt: {
      nodeId,
      text: read.text,
      totalChars: read.totalChars,
      truncated: read.truncated,
    },
  };
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
