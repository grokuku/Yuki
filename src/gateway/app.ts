/**
 * Application HTTP — `node:http` natif, zéro framework.
 *
 * Sert les routes de santé/version, l'API de configuration (`/api/config`,
 * Lot 11), l'UI statique de `public/ui`, et rien d'autre. Le transport temps
 * réel (WebSocket) n'est PAS géré ici : il est branché via le hook `upgrade` du
 * serveur HTTP.
 */

import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { resolve } from "node:path";

import { MAX_COMFY_WORKFLOW_BYTES } from "../comfy/index.js";
import { MAX_SOURCE_MESSAGE_BYTES } from "../sources/types.js";
import type { Env } from "../config/env.js";
import type { MountStatus } from "../config/paths.js";
import type { GpuReport } from "../types/gpu.js";
import {
  handleConfigRequest,
  isConfigPath,
  MAX_CONFIG_BODY_BYTES,
  type ConfigApiDeps,
} from "./routes/config.js";
import {
  handleAgentsRequest,
  isAgentsPath,
  type AgentsApiDeps,
} from "./routes/agents.js";
import {
  handleSecretsRequest,
  isSecretsPath,
  type SecretsApiDeps,
} from "./routes/secrets.js";
import {
  handlePersonalityRequest,
  isPersonalityPath,
  type PersonalityApiDeps,
} from "./routes/personality.js";
import {
  handleRulesRequest,
  isRulesPath,
  type RulesApiDeps,
} from "./routes/rules.js";
import {
  handleConsignesRequest,
  isConsignesPath,
  type ConsignesApiDeps,
} from "./routes/consignes.js";
import {
  handleMemoryRequest,
  isMemoryPath,
  type MemoryApiDeps,
} from "./routes/memory.js";
import {
  handleHeritageRequest,
  isHeritagePath,
  type HeritageApiDeps,
} from "./routes/heritage.js";
import {
  handleAdminRequest,
  isAdminPath,
  type AdminApiDeps,
} from "./routes/admin.js";
import {
  handlePushRequest,
  isPushPath,
  type PushApiDeps,
} from "./routes/push.js";
import {
  handleVoicesRequest,
  isVoicesPath,
  MAX_VOICE_BODY_BYTES,
  type VoiceApiDeps,
} from "./routes/voices.js";
import {
  handleTtsRequest,
  isTtsPath,
  type TtsApiDeps,
} from "./routes/tts.js";
import {
  healthFull,
  healthLive,
  healthReady,
  type SubsystemsSnapshot,
} from "./routes/health.js";
import { resolveStaticRequest } from "./routes/static.js";
import {
  handleImagesApiRequest,
  handleImagesServeRequest,
  isImagesApiPath,
  isImagesServePath,
  type ImagesApiDeps,
} from "./routes/images.js";
import {
  handleCapturesRequest,
  isCapturesPath,
  type CapturesApiDeps,
} from "./routes/captures.js";
import {
  handleSourcesRequest,
  isSourcesPath,
  type SourcesApiDeps,
} from "./routes/sources.js";
import { handleChatRequest, isChatApiPath, type ChatApiDeps } from "./routes/chat.js";
import {
  handleFilesApiRequest,
  handleFilesServeRequest,
  handleFilesUpload,
  isFilesApiPath,
  isFilesServePath,
  type FilesApiDeps,
} from "./routes/files.js";
import {
  FAVICON_FALLBACK_PATH,
  handleAvatarApiRequest,
  handleAvatarServeRequest,
  handleFaviconRequest,
  isAvatarApiPath,
  isAvatarServePath,
  isFaviconPath,
  type AvatarApiDeps,
} from "./routes/avatar.js";
import { AVATAR_MAX_BYTES } from "../identity/avatar.js";
import { versionInfo } from "./routes/version.js";

export interface AppContext {
  env: Env;
  report: GpuReport;
  gatePassed: boolean;
  startedAt: number;
  volumes: MountStatus[];
  /** Répertoire des assets de l'UI (`public/ui`). */
  publicDir?: string;
  /** Fournisseur de l'état des sous-systèmes (Pi, transport). */
  getSubsystems?: () => SubsystemsSnapshot;
  /** API de configuration (Lot 11). Absente ⇒ `/api/config` → 404. */
  config?: ConfigApiDeps;
  /** API d'administration (redémarrage). Absente ⇒ `/api/admin/**` → 404. */
  admin?: AdminApiDeps;
  /**
   * API des notifications (PWA + Web Push). Absente ⇒ `/api/push/**` → 404.
   * Fonctionne même en mode dégradé (aucun PiHost requis) : l'utilisateur peut
   * gérer ses appareils et consulter l'état.
   */
  push?: PushApiDeps;
  /** API de gestion des voix TTS (Lot 7). Absente ⇒ `/api/voices*` → 404. */
  voices?: VoiceApiDeps;
  /** Diagnostic TTS (Lot 8). Absent ⇒ `/api/tts/**` → 404. */
  tts?: TtsApiDeps;
  /** API des agents d'exécution (Lot 4). Absente ⇒ `/api/agents*` → 404. */
  agents?: AgentsApiDeps;
  /**
   * API des SOURCES (réveil générique par un programme extérieur) et de la boîte
   * « Notifications ». Absente ⇒ `/api/sources*` → 404.
   */
  sources?: SourcesApiDeps;
  /**
   * API des DISCUSSIONS externes (lot 18) : mode courant et état de la
   * plateforme, sans secret. Absente ⇒ `/api/chat*` → 404.
   */
  chat?: ChatApiDeps;
  /**
   * API de gestion du coffre de secrets. Absente ⇒ `/api/secrets*` → 404.
   * ⚠️ Ne renvoie JAMAIS la valeur d'un secret (noms + libellés seulement).
   */
  secrets?: SecretsApiDeps;
  /** API de la personnalité. Absente ⇒ `/api/self/personality*` → 404. */
  personality?: PersonalityApiDeps;
  /**
   * API des règles strictes. Absente ⇒ `/api/self/rules*` → 404. ⚠️ Interface
   * uniquement (réservée à l'utilisateur ; le modèle ne peut pas les écrire).
   */
  rules?: RulesApiDeps;
  /**
   * API des CONSIGNES DURABLES, PAR BOT (`/api/bots/<id>/consignes`). Absente ⇒
   * ces routes → 404. ⚠️ Le fichier édité est celui du BOT demandé
   * (`<state>/bots/<id>/consignes.md`) : un identifiant inconnu est un 404.
   */
  consignes?: ConsignesApiDeps;
  /** API d'administration de la mémoire. Absente ⇒ `/api/memory*` → 404. */
  memory?: MemoryApiDeps;
  /**
   * API d'administration de l'archive « vie antérieure ». Absente ⇒
   * `/api/self/heritage*` → 404. ⚠️ Interface uniquement (jamais le modèle).
   */
  heritage?: HeritageApiDeps;
  /**
   * Service SAME-ORIGIN des captures de pages web (`/captures/<id>.<ext>`).
   * Absent ⇒ `/captures/*` → 404.
   */
  captures?: CapturesApiDeps;
  /**
   * Fichiers échangés : dépôt (`POST /api/files`), liste, suppression et SERVICE
   * same-origin (`/fichiers/<id>.<ext>`). Absent ⇒ ces routes → 404.
   */
  files?: FilesApiDeps;
  /**
   * AVATAR de Yuki : image PERSISTANTE (`/avatar`, `/favicon.ico`) et API
   * (`/api/avatar`). Absent ⇒ ces routes → 404 et l'UI garde le flocon.
   */
  avatar?: AvatarApiDeps;
  /**
   * Images générées via ComfyUI : import des workflows (`POST /api/images/…`),
   * bouton de test et SERVICE same-origin (`/images/<id>.<ext>`). Absent ⇒ ces
   * routes → 404.
   */
  images?: ImagesApiDeps;
}

interface RouteResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const JSON_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function normalizePath(rawUrl: string | undefined): string {
  const url = new URL(rawUrl ?? "/", "http://localhost");
  const path = url.pathname.replace(/\/+$/, "");
  return path === "" ? "/" : path;
}

/**
 * Chaîne de requête BRUTE d'une URL (`"?a=1&b=2"`, ou `""`).
 *
 * ⚠️ `normalizePath` rend le CHEMIN : la chaîne de requête y est donc perdue. Or
 * les routes des sources en dépendent ENTIÈREMENT (`?bot=<id>` du lot 35j,
 * `?expression=` de l'aperçu cron, `?limite=` / `?type=` / `?source=` du journal).
 * Sans cette restitution, le paramètre n'arrivait jamais au gestionnaire et la
 * page retombait silencieusement sur le bot actif et sur les valeurs par défaut.
 */
function chaineDeRequete(rawUrl: string | undefined): string {
  if (typeof rawUrl !== "string") return "";
  const at = rawUrl.indexOf("?");
  return at < 0 ? "" : rawUrl.slice(at);
}

function writeResponse(
  res: ServerResponse,
  response: RouteResponse,
  headOnly: boolean,
): void {
  if (Buffer.isBuffer(response.body) || typeof response.body === "string") {
    const body = response.body;
    res.writeHead(response.status, {
      ...(response.headers ?? JSON_HEADERS),
    });
    if (headOnly) {
      res.end();
    } else {
      res.end(body);
    }
    return;
  }
  const payload = JSON.stringify(response.body);
  res.writeHead(response.status, {
    ...JSON_HEADERS,
    ...(response.headers ?? {}),
    "content-length": Buffer.byteLength(payload).toString(),
  });
  if (headOnly) {
    res.end();
  } else {
    res.end(payload);
  }
}

/** Message d'erreur interne signalant un corps de requête au-delà de la limite. */
const BODY_TOO_LARGE = "body_too_large";

/** Erreur interne d'un corps dépassant la limite (porte la taille reçue). */
class BodyTooLargeError extends Error {
  override readonly name = "BodyTooLargeError";
  constructor(readonly receivedBytes: number) {
    super(BODY_TOO_LARGE);
  }
}

/** Lit le corps d'une requête en `Buffer` (borné). Rejette au-delà de la limite. */
function readBodyBinary(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        // On cesse d'accumuler mais on DRAINE la suite : la socket reste
        // vivante, ce qui permet de renvoyer un 413 explicite (un
        // `req.destroy()` immédiat empêcherait toute réponse).
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) reject(new BodyTooLargeError(size));
      else resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

/** Lit le corps d'une requête (borné à `MAX_CONFIG_BODY_BYTES`), en UTF-8. */
function readBody(req: IncomingMessage): Promise<string> {
  return readBodyBinary(req, MAX_CONFIG_BODY_BYTES).then((buffer) =>
    buffer.toString("utf8"),
  );
}

/** Traite une requête de configuration (asynchrone : lecture du corps). */
async function handleConfigHttp(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  headOnly: boolean,
  deps: ConfigApiDeps,
): Promise<void> {
  let body = "";
  if (method === "PUT" || method === "POST" || method === "PATCH") {
    body = await readBody(req).catch(() => "");
  }
  const response = await handleConfigRequest({
    method,
    path,
    headers: req.headers,
    body,
    deps,
  });
  writeResponse(
    res,
    { status: response.status, body: response.body, headers: response.headers },
    headOnly,
  );
}

/** Traite une requête de l'API des voix (corps binaire borné). */
async function handleVoicesHttp(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  headOnly: boolean,
  deps: VoiceApiDeps,
): Promise<void> {
  const needsBody = method === "POST" || method === "PATCH" || method === "PUT";
  let body: Buffer = Buffer.alloc(0);
  if (needsBody) {
    // L'upload de clonage reçoit un WAV binaire jusqu'à `MAX_VOICE_BODY_BYTES`
    // (D20) ; les autres corps (PATCH JSON) restent bornés à la limite config.
    const limit =
      path === "/api/voices/clone" ? MAX_VOICE_BODY_BYTES : MAX_CONFIG_BODY_BYTES;
    try {
      body = await readBodyBinary(req, limit);
    } catch (error) {
      const tooLarge = error instanceof BodyTooLargeError;
      const isCloneUpload = path === "/api/voices/clone";
      const limitMo = `${Number.isInteger(limit / 1_000_000) ? limit / 1_000_000 : (limit / 1_000_000).toFixed(1)} Mo`;
      writeResponse(
        res,
        {
          status: tooLarge ? 413 : 400,
          body: {
            error: tooLarge ? "body_too_large" : "invalid_body",
            code: tooLarge ? "body_too_large" : "invalid_body",
            message: tooLarge
              ? isCloneUpload
                ? `Échantillon trop volumineux : ${error.receivedBytes} octets reçus, maximum ${limit} octets (${limitMo}). Réduisez la durée (≤ 30 s) ou convertissez-le en mono 24 kHz 16 bits.`
                : `Corps trop volumineux : ${error.receivedBytes} octets reçus, maximum ${limit} octets.`
              : "Corps de requête illisible.",
          },
        },
        headOnly,
      );
      return;
    }
  }
  const response = await handleVoicesRequest({
    method,
    path,
    headers: req.headers,
    body,
    deps,
  });
  writeResponse(
    res,
    { status: response.status, body: response.body, headers: response.headers },
    headOnly,
  );
}

/** Traite une requête de diagnostic TTS (GET sans corps, POST texte borné). */
async function handleTtsHttp(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  headOnly: boolean,
  deps: TtsApiDeps,
): Promise<void> {
  let body: Buffer = Buffer.alloc(0);
  if (method === "POST" || method === "PUT") {
    try {
      body = await readBodyBinary(req, MAX_CONFIG_BODY_BYTES);
    } catch (error) {
      const tooLarge = error instanceof BodyTooLargeError;
      writeResponse(
        res,
        {
          status: tooLarge ? 413 : 400,
          body: {
            error: tooLarge ? "body_too_large" : "invalid_body",
            code: tooLarge ? "body_too_large" : "invalid_body",
            message: tooLarge
              ? `Corps trop volumineux : ${error.receivedBytes} octets reçus, maximum ${MAX_CONFIG_BODY_BYTES} octets.`
              : "Corps de requête illisible.",
          },
        },
        headOnly,
      );
      return;
    }
  }
  const response = await handleTtsRequest({
    method,
    path,
    headers: req.headers,
    body,
    deps,
  });
  writeResponse(
    res,
    { status: response.status, body: response.body, headers: response.headers },
    headOnly,
  );
}

/**
 * Traite une requête de l'API des SOURCES (corps JSON borné à 64 Kio).
 *
 * ⚠️ C'est la SEULE route d'écriture de l'application qui n'exige PAS le jeton
 * d'interface : un programme extérieur s'authentifie par le JETON de SA source
 * (`Authorization: Bearer …`), vérifié en temps constant par le service.
 */
async function handleSourcesHttp(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  headOnly: boolean,
  deps: SourcesApiDeps,
): Promise<void> {
  let body = "";
  if (method === "POST" || method === "PATCH" || method === "PUT") {
    try {
      body = (await readBodyBinary(req, MAX_SOURCE_MESSAGE_BYTES)).toString("utf8");
    } catch (error) {
      const tooLarge = error instanceof BodyTooLargeError;
      writeResponse(
        res,
        {
          status: tooLarge ? 413 : 400,
          body: {
            error: tooLarge ? "body_too_large" : "invalid_body",
            code: tooLarge ? "body_too_large" : "invalid_body",
            message: tooLarge
              ? `Corps trop volumineux : ${error.receivedBytes} octets reçus, maximum ${MAX_SOURCE_MESSAGE_BYTES} octets (64 Kio).`
              : "Corps de requête illisible.",
          },
        },
        headOnly,
      );
      return;
    }
  }
  const response = await handleSourcesRequest({
    method,
    // ⚠️ CHEMIN NORMALISÉ + CHAÎNE DE REQUÊTE : `path` seul a perdu les paramètres
    // (`?bot=`, `?limite=`…), et les routes des sources les lisent.
    path: `${path}${chaineDeRequete(req.url)}`,
    headers: req.headers,
    body,
    deps,
  });
  writeResponse(
    res,
    { status: response.status, body: response.body, headers: response.headers },
    headOnly,
  );
}

/** Traite une requête de l'API des agents (corps JSON borné). */
async function handleAgentsHttp(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  headOnly: boolean,
  deps: AgentsApiDeps,
): Promise<void> {
  let body = "";
  if (method === "POST" || method === "PATCH" || method === "PUT") {
    body = await readBody(req).catch(() => "");
  }
  const ip = req.socket.remoteAddress ?? "unknown";
  const response = handleAgentsRequest({ method, path, headers: req.headers, body, ip, deps });
  writeResponse(
    res,
    { status: response.status, body: response.body, headers: response.headers },
    headOnly,
  );
}

/** Traite une requête de l'API des secrets (corps JSON borné). */
async function handleSecretsHttp(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  headOnly: boolean,
  deps: SecretsApiDeps,
): Promise<void> {
  let body = "";
  if (method === "POST" || method === "PUT") {
    body = await readBody(req).catch(() => "");
  }
  const response = await handleSecretsRequest({ method, path, headers: req.headers, body, deps });
  writeResponse(
    res,
    { status: response.status, body: response.body, headers: response.headers },
    headOnly,
  );
}

/** Traite une requête de l'API de personnalité (corps JSON borné). */
async function handlePersonalityHttp(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  headOnly: boolean,
  deps: PersonalityApiDeps,
): Promise<void> {
  let body = "";
  if (method === "PUT" || method === "POST") {
    body = await readBody(req).catch(() => "");
  }
  const response = handlePersonalityRequest({
    method,
    path,
    headers: req.headers,
    body,
    deps,
  });
  writeResponse(
    res,
    { status: response.status, body: response.body, headers: response.headers },
    headOnly,
  );
}

/** Traite une requête de l'API des règles strictes (corps JSON borné). */
async function handleRulesHttp(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  headOnly: boolean,
  deps: RulesApiDeps,
): Promise<void> {
  let body = "";
  if (method === "PUT" || method === "POST") {
    body = await readBody(req).catch(() => "");
  }
  const response = handleRulesRequest({
    method,
    path,
    headers: req.headers,
    body,
    deps,
  });
  writeResponse(
    res,
    { status: response.status, body: response.body, headers: response.headers },
    headOnly,
  );
}

/** Traite une requête d'administration de la mémoire (corps JSON borné). */
async function handleMemoryHttp(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  headOnly: boolean,
  deps: MemoryApiDeps,
): Promise<void> {
  let body = "";
  if (method === "POST" || method === "PUT") {
    body = await readBody(req).catch(() => "");
  }
  const response = handleMemoryRequest({ method, path, headers: req.headers, body, deps });
  writeResponse(
    res,
    { status: response.status, body: response.body, headers: response.headers },
    headOnly,
  );
}

/** Traite une requête d'administration de l'archive (corps JSON borné). */
async function handleHeritageHttp(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  headOnly: boolean,
  deps: HeritageApiDeps,
): Promise<void> {
  let body = "";
  if (method === "POST" || method === "PUT") {
    body = await readBody(req).catch(() => "");
  }
  const response = handleHeritageRequest({ method, path, headers: req.headers, body, deps });
  writeResponse(
    res,
    { status: response.status, body: response.body, headers: response.headers },
    headOnly,
  );
}

/** Traite une requête de l'API des notifications (corps JSON borné). */
async function handlePushHttp(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  headOnly: boolean,
  deps: PushApiDeps,
): Promise<void> {
  let body = "";
  if (method === "POST" || method === "PUT") {
    body = await readBody(req).catch(() => "");
  }
  const response = handlePushRequest({ method, path, headers: req.headers, body, deps });
  writeResponse(
    res,
    { status: response.status, body: response.body, headers: response.headers },
    headOnly,
  );
}

/**
 * Traite une requête de l'API des IMAGES générées (asynchrone : corps + test).
 *
 * ⚠️ Le corps peut être un GRAPHE complet : la borne de lecture est celle du
 * workflow (`MAX_COMFY_WORKFLOW_BYTES`), pas celle de `/api/config` — un graphe
 * de 1,5 Mo est parfaitement légitime. Au-delà, le refus est EXPLICITE (413).
 */
async function handleImagesHttp(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  headOnly: boolean,
  deps: ImagesApiDeps,
): Promise<void> {
  let body = "";
  if (method === "POST" || method === "PUT" || method === "PATCH") {
    try {
      body = (
        await readBodyBinary(req, MAX_COMFY_WORKFLOW_BYTES + 64 * 1024)
      ).toString("utf8");
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        writeResponse(
          res,
          {
            status: 413,
            body: {
              error: "body_too_large",
              message:
                "Le corps de la requête dépasse la taille maximale d'un workflow " +
                `(${MAX_COMFY_WORKFLOW_BYTES} octets).`,
            },
          },
          headOnly,
        );
        return;
      }
      body = "";
    }
  }
  const response = await handleImagesApiRequest({
    method,
    path,
    headers: req.headers,
    body,
    deps,
  });
  writeResponse(
    res,
    { status: response.status, body: response.body, headers: response.headers },
    headOnly,
  );
}

/** Construit l'écouteur HTTP de l'application. */
export function createApp(context: AppContext): RequestListener {
  const {
    env,
    report,
    gatePassed,
    startedAt,
    volumes,
    publicDir = resolve(process.cwd(), "public", "ui"),
    getSubsystems,
    config,
    admin,
    push,
    sources,
    chat,
    voices,
    tts,
    agents,
    secrets,
    personality,
    rules,
    consignes,
    memory,
    heritage,
    captures,
    files,
    avatar,
    images,
  } = context;

  return (req: IncomingMessage, res: ServerResponse): void => {
    const path = normalizePath(req.url);
    const method = (req.method ?? "GET").toUpperCase();
    const headOnly = method === "HEAD";

    // ⚠️ AVANT le bloc `/api/config` : `isConfigPath` réclame TOUT
    // `/api/bots/**` (c'est l'API de configuration d'un bot). Les consignes
    // durables sont un fichier PAR BOT servi par sa propre route : elles doivent
    // donc être aiguillées d'abord, sinon elles tomberaient en 404 générique.
    if (consignes && isConsignesPath(path)) {
      void (async () => {
        let body = "";
        if (method === "PUT") body = await readBody(req).catch(() => "");
        const response = handleConsignesRequest({
          method,
          path,
          headers: req.headers,
          body,
          deps: consignes,
        });
        writeResponse(
          res,
          { status: response.status, body: response.body, headers: response.headers },
          headOnly,
        );
      })().catch((error: unknown) => {
        consignes.logger.error("consignes.request.failed", {
          error: error instanceof Error ? error.message : String(error),
          path,
        });
        if (!res.headersSent) {
          writeResponse(res, { status: 500, body: { error: "internal_error" } }, headOnly);
        } else {
          res.end();
        }
      });
      return;
    }

    if (config && isConfigPath(path)) {
      void handleConfigHttp(req, res, path, method, headOnly, config).catch(
        (error: unknown) => {
          config.logger.error("config.request.failed", {
            error: error instanceof Error ? error.message : String(error),
            path,
          });
          if (!res.headersSent) {
            writeResponse(
              res,
              { status: 500, body: { error: "internal_error" } },
              headOnly,
            );
          } else {
            res.end();
          }
        },
      );
      return;
    }

    if (chat && isChatApiPath(path)) {
      // ⚠️ Certaines routes de discussion ÉCRIVENT puis ATTENDENT (connexion, backfill) :
      // la lecture du corps est bornée comme celle de `/api/config`, et l'échec est
      // journalisé sans laisser la réponse en suspens.
      void (async () => {
        const body = method === "GET" || method === "HEAD" ? "" : await readBody(req).catch(() => "");
        return handleChatRequest({ method, path, headers: req.headers, body, deps: chat });
      })()
        .then((response) => {
          writeResponse(
            res,
            { status: response.status, body: response.body, headers: response.headers },
            headOnly,
          );
        })
        .catch((error: unknown) => {
          chat.logger?.error("chat.request.failed", {
            error: error instanceof Error ? error.message : String(error),
            path,
          });
          if (!res.headersSent) {
            writeResponse(res, { status: 500, body: { error: "internal_error" } }, headOnly);
          } else {
            res.end();
          }
        });
      return;
    }

    if (sources && isSourcesPath(path)) {
      void handleSourcesHttp(req, res, path, method, headOnly, sources).catch(
        (error: unknown) => {
          sources.logger.error("sources.request.failed", {
            error: error instanceof Error ? error.message : String(error),
            path,
          });
          if (!res.headersSent) {
            writeResponse(
              res,
              { status: 500, body: { error: "internal_error" } },
              headOnly,
            );
          } else {
            res.end();
          }
        },
      );
      return;
    }

    if (agents && isAgentsPath(path)) {
      void handleAgentsHttp(req, res, path, method, headOnly, agents).catch(
        (error: unknown) => {
          agents.logger.error("agents.request.failed", {
            error: error instanceof Error ? error.message : String(error),
            path,
          });
          if (!res.headersSent) {
            writeResponse(
              res,
              { status: 500, body: { error: "internal_error" } },
              headOnly,
            );
          } else {
            res.end();
          }
        },
      );
      return;
    }

    if (secrets && isSecretsPath(path)) {
      void handleSecretsHttp(req, res, path, method, headOnly, secrets).catch(
        (error: unknown) => {
          secrets.logger.error("secrets.request.failed", {
            error: error instanceof Error ? error.message : String(error),
            path,
          });
          if (!res.headersSent) {
            writeResponse(
              res,
              { status: 500, body: { error: "internal_error" } },
              headOnly,
            );
          } else {
            res.end();
          }
        },
      );
      return;
    }

    if (rules && isRulesPath(path)) {
      void handleRulesHttp(req, res, path, method, headOnly, rules).catch(
        (error: unknown) => {
          rules.logger.error("rules.request.failed", {
            error: error instanceof Error ? error.message : String(error),
            path,
          });
          if (!res.headersSent) {
            writeResponse(
              res,
              { status: 500, body: { error: "internal_error" } },
              headOnly,
            );
          } else {
            res.end();
          }
        },
      );
      return;
    }

    if (personality && isPersonalityPath(path)) {
      void handlePersonalityHttp(req, res, path, method, headOnly, personality).catch(
        (error: unknown) => {
          personality.logger.error("personality.request.failed", {
            error: error instanceof Error ? error.message : String(error),
            path,
          });
          if (!res.headersSent) {
            writeResponse(
              res,
              { status: 500, body: { error: "internal_error" } },
              headOnly,
            );
          } else {
            res.end();
          }
        },
      );
      return;
    }

    if (memory && isMemoryPath(path)) {
      void handleMemoryHttp(req, res, path, method, headOnly, memory).catch(
        (error: unknown) => {
          memory.logger.error("memory.request.failed", {
            error: error instanceof Error ? error.message : String(error),
            path,
          });
          if (!res.headersSent) {
            writeResponse(
              res,
              { status: 500, body: { error: "internal_error" } },
              headOnly,
            );
          } else {
            res.end();
          }
        },
      );
      return;
    }

    if (heritage && isHeritagePath(path)) {
      void handleHeritageHttp(req, res, path, method, headOnly, heritage).catch(
        (error: unknown) => {
          heritage.logger.error("heritage.request.failed", {
            error: error instanceof Error ? error.message : String(error),
            path,
          });
          if (!res.headersSent) {
            writeResponse(
              res,
              { status: 500, body: { error: "internal_error" } },
              headOnly,
            );
          } else {
            res.end();
          }
        },
      );
      return;
    }

    if (voices && isVoicesPath(path)) {
      void handleVoicesHttp(req, res, path, method, headOnly, voices).catch(
        (error: unknown) => {
          voices.logger.error("voices.request.failed", {
            error: error instanceof Error ? error.message : String(error),
            path,
          });
          if (!res.headersSent) {
            writeResponse(
              res,
              { status: 500, body: { error: "internal_error" } },
              headOnly,
            );
          } else {
            res.end();
          }
        },
      );
      return;
    }

    if (tts && isTtsPath(path)) {
      void handleTtsHttp(req, res, path, method, headOnly, tts).catch(
        (error: unknown) => {
          tts.logger.error("tts.request.failed", {
            error: error instanceof Error ? error.message : String(error),
            path,
          });
          if (!res.headersSent) {
            writeResponse(
              res,
              { status: 500, body: { error: "internal_error" } },
              headOnly,
            );
          } else {
            res.end();
          }
        },
      );
      return;
    }

    if (images && isImagesServePath(path)) {
      // SERVICE same-origin des images générées : aucune CSP à élargir
      // (`img-src 'self'`), aucune donnée du serveur ComfyUI n'est exposée.
      const result = handleImagesServeRequest({ method, path, deps: images });
      writeResponse(
        res,
        { status: result.status, body: result.body, headers: result.headers },
        headOnly,
      );
      return;
    }

    if (images && isImagesApiPath(path)) {
      void handleImagesHttp(req, res, path, method, headOnly, images).catch(
        (error: unknown) => {
          images.logger?.error("images.request.failed", {
            error: error instanceof Error ? error.message : String(error),
            path,
          });
          if (!res.headersSent) {
            writeResponse(res, { status: 500, body: { error: "internal_error" } }, headOnly);
          } else {
            res.end();
          }
        },
      );
      return;
    }

    if (files && isFilesServePath(path)) {
      const result = handleFilesServeRequest({ method, path, deps: files });
      writeResponse(
        res,
        { status: result.status, body: result.body, headers: result.headers },
        headOnly,
      );
      return;
    }

    if (files && isFilesApiPath(path)) {
      if (method === "POST") {
        // ⚠️ Le corps est consommé EN FLUX : un fichier de 2 Gio ne passe jamais
        // en mémoire (le stockage écrit au fil de l'eau et refuse au-delà du
        // plafond, en supprimant le partiel).
        void handleFilesUpload({ headers: req.headers, stream: req, deps: files })
          .then((response) => {
            writeResponse(
              res,
              { status: response.status, body: response.body, headers: response.headers },
              headOnly,
            );
          })
          .catch((error: unknown) => {
            files.logger?.error("files.upload.failed", {
              error: error instanceof Error ? error.message : String(error),
            });
            if (!res.headersSent) {
              writeResponse(
                res,
                { status: 500, body: { error: "internal_error" } },
                headOnly,
              );
            } else {
              res.end();
            }
          });
        return;
      }
      writeResponse(
        res,
        handleFilesApiRequest({ method, path, headers: req.headers, deps: files }),
        headOnly,
      );
      return;
    }

    if (avatar && isAvatarServePath(path)) {
      // SERVICE same-origin de l'avatar : `img-src 'self'` le couvre déjà,
      // aucune directive CSP n'est élargie, aucun `blob:` n'est nécessaire.
      const result = handleAvatarServeRequest({ method, deps: avatar });
      writeResponse(
        res,
        { status: result.status, body: result.body, headers: result.headers },
        headOnly,
      );
      return;
    }

    if (avatar && isFaviconPath(path)) {
      // ⚠️ Beaucoup de navigateurs demandent `/favicon.ico` d'eux-mêmes : la
      // route existe même sans déclaration dans le HTML. Le repli est l'icône
      // PWA livrée, résolue par le service statique (garde-fou anti-traversée).
      const fallback = resolveStaticRequest({ publicDir }, FAVICON_FALLBACK_PATH);
      const result = handleFaviconRequest({
        method,
        deps: avatar,
        fallback: fallback ? { body: fallback.body, headers: fallback.headers } : null,
      });
      writeResponse(
        res,
        { status: result.status, body: result.body, headers: result.headers },
        headOnly,
      );
      return;
    }

    if (avatar && isAvatarApiPath(path)) {
      void (async () => {
        // `POST` reçoit les OCTETS BRUTS de l'image (aucun multipart).
        let body: Buffer = Buffer.alloc(0);
        if (method === "POST") {
          body = await readBodyBinary(req, AVATAR_MAX_BYTES);
        }
        return handleAvatarApiRequest({
          method,
          headers: req.headers,
          body,
          deps: avatar,
        });
      })()
        .then((response) => {
          writeResponse(
            res,
            { status: response.status, body: response.body, headers: response.headers },
            headOnly,
          );
        })
        .catch((error: unknown) => {
          if (error instanceof BodyTooLargeError) {
            writeResponse(
              res,
              {
                status: 413,
                body: {
                  error: "body_too_large",
                  code: "body_too_large",
                  message: `Image refusée : le corps dépasse la limite de ${AVATAR_MAX_BYTES} octets.`,
                },
              },
              headOnly,
            );
            return;
          }
          avatar.logger?.error("avatar.request.failed", {
            error: error instanceof Error ? error.message : String(error),
            path,
          });
          if (!res.headersSent) {
            writeResponse(res, { status: 500, body: { error: "internal_error" } }, headOnly);
          } else {
            res.end();
          }
        });
      return;
    }

    if (admin && isAdminPath(path)) {      writeResponse(
        res,
        handleAdminRequest({ method, path, headers: req.headers, deps: admin }),
        headOnly,
      );
      return;
    }

    if (push && isPushPath(path)) {
      void handlePushHttp(req, res, path, method, headOnly, push).catch(
        (error: unknown) => {
          push.logger.error("push.request.failed", {
            error: error instanceof Error ? error.message : String(error),
            path,
          });
          if (!res.headersSent) {
            writeResponse(
              res,
              { status: 500, body: { error: "internal_error" } },
              headOnly,
            );
          } else {
            res.end();
          }
        },
      );
      return;
    }

    if (method !== "GET" && method !== "HEAD") {
      writeResponse(
        res,
        { status: 405, body: { error: "method_not_allowed", method } },
        headOnly,
      );
      return;
    }

    let response: RouteResponse;

    if (path === "/health/live") {
      response = healthLive();
    } else if (path === "/health/ready") {
      response = healthReady({
        version: env.version,
        startedAt,
        report,
        gatePassed,
        volumes,
        ...(getSubsystems ? { subsystems: getSubsystems() } : {}),
      });
    } else if (path === "/health") {
      response = healthFull({
        version: env.version,
        startedAt,
        report,
        gatePassed,
        volumes,
        ...(getSubsystems ? { subsystems: getSubsystems() } : {}),
      });
    } else if (path === "/version") {
      response = versionInfo({ version: env.version, profile: report.resolvedProfile });
    } else if (captures && isCapturesPath(path)) {
      const result = handleCapturesRequest({ method, path, deps: captures });
      response = { status: result.status, body: result.body, headers: result.headers };
    } else {
      const staticResult = resolveStaticRequest({ publicDir }, path);
      if (staticResult) {
        response = {
          status: staticResult.status,
          body: staticResult.body,
          headers: staticResult.headers,
        };
      } else {
        response = { status: 404, body: { error: "not_found", path } };
      }
    }

    writeResponse(res, response, headOnly);
  };
}
