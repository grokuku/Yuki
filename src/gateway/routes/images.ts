/**
 * Routes des IMAGES GÉNÉRÉES via ComfyUI.
 *
 *  - `GET    /api/images/workflows`              liste des workflows (résumés).
 *  - `POST   /api/images/workflows`              IMPORT d'un workflow (JSON API).
 *  - `PUT    /api/images/workflows/<nom>`        MÉTADONNÉES ÉDITABLES
 *                                                (`description`, `documentation`).
 *  - `DELETE /api/images/workflows/<nom>`        suppression.
 *  - `POST   /api/images/workflows/<nom>/defaut` marque « par défaut ».
 *  - `POST   /api/images/test`                   bouton « Tester la connexion ».
 *  - `GET    /images/<id>.<ext>`                 SERVICE same-origin de l'image.
 *
 * ⚠️ L'import VALIDE AVANT D'ÉCRIRE et REFUSE un graphe inutilisable en
 * affichant les étiquettes TROUVÉES et MANQUANTES (PIÈGE ⑦). Les commandes qui
 * écrivent exigent l'en-tête `x-yuki-config: 1` et une origine identique, comme
 * `/api/config`.
 *
 * ⚠️ L'API ne renvoie JAMAIS le graphe complet ni la CLÉ du serveur (PIÈGE ④) :
 * seulement des résumés (nom, description, documentation, défaut, taille,
 * étiquettes).
 *
 * ⚠️ Les MÉTADONNÉES ÉDITABLES (`PUT /api/images/workflows/<nom>`) sont la
 * DESCRIPTION COURTE (`description`, elle sert au choix par proximité) et les
 * CONSIGNES D'ÉCRITURE (`documentation`) : un texte POUR YUKI qui décrit comment
 * écrire la scène pour ce workflow. Ce texte est BORNÉ
 * (`MAX_COMFY_DOCUMENTATION_CHARS`) et REFUSÉ au-delà (`invalid_documentation`,
 * avec la longueur réelle) — jamais entré dans le graphe, jamais renvoyé à
 * ComfyUI, jamais injecté dans le prompt système.
 *
 * ⚠️ Le service `/images/…` suit le patron de `/captures/` : identifiant
 * aléatoire de 32 hexadécimaux, extension sur allowlist, en-têtes de sécurité.
 * La CSP n'est PAS élargie : `img-src 'self'` couvre déjà une image same-origin.
 */

import type { IncomingHttpHeaders } from "node:http";

import {
  ComfyWorkflowError,
  isComfyError,
  type ComfyImageClientPort,
  type ComfyWorkflowsPort,
  type GeneratedImagesPort,
} from "../../comfy/index.js";
import type { Logger } from "../../observability/logger.js";
import { requireWriteGuards, type ConfigHttpResponse } from "./config.js";
import { STATIC_SECURITY_HEADERS } from "./static.js";

/** Préfixe de l'espace des images générées servies. */
export const IMAGES_SERVE_PREFIX = "/images/";
/** Préfixe de l'API HTTP des images générées. */
export const IMAGES_API_PREFIX = "/api/images";
/** Délai du bouton « Tester la connexion » (jamais l'attente d'une génération). */
export const IMAGES_TEST_TIMEOUT_MS = 8_000;

export interface ImagesApiDeps {
  workflows: ComfyWorkflowsPort;
  images: GeneratedImagesPort;
  /**
   * Construit un client ComfyUI. Les valeurs NON ENREGISTRÉES fournies au test
   * (URL, clé) sont prioritaires : le bouton « Tester la connexion » vérifie ce
   * que l'utilisateur vient de taper, sans écrire quoi que ce soit.
   */
  clientFor: (override: ComfyServerOverride) => Pick<ComfyImageClientPort, "systemStats">;
  logger?: Logger;
}

/** Valeurs de test prioritaires sur la configuration enregistrée. */
export interface ComfyServerOverride {
  baseUrl?: string;
  apiKey?: string;
}

export interface ImagesServeResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer | string;
}

/** Vrai si le chemin relève du SERVICE same-origin (`/images/<id>.<ext>`). */
export function isImagesServePath(path: string): boolean {
  return path.startsWith(IMAGES_SERVE_PREFIX);
}

/** Vrai si le chemin relève de l'API (`/api/images…`). */
export function isImagesApiPath(path: string): boolean {
  return path === IMAGES_API_PREFIX || path.startsWith(`${IMAGES_API_PREFIX}/`);
}

function json(status: number, body: unknown): ConfigHttpResponse {
  return {
    status,
    body,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  };
}

function notFound(): ImagesServeResponse {
  return {
    status: 404,
    headers: { ...STATIC_SECURITY_HEADERS, "content-type": "text/plain; charset=utf-8" },
    body: "Not Found\n",
  };
}

/** Sert une image générée (`GET/HEAD /images/<id>.<ext>`). */
export function handleImagesServeRequest(input: {
  method: string;
  path: string;
  deps: ImagesApiDeps;
}): ImagesServeResponse {
  const { method, path, deps } = input;
  if (method !== "GET" && method !== "HEAD") {
    return {
      status: 405,
      headers: { ...STATIC_SECURITY_HEADERS, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: "method_not_allowed", method }),
    };
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(path.slice(IMAGES_SERVE_PREFIX.length));
  } catch {
    return notFound();
  }
  if (decoded.includes("/") || decoded.includes("\\") || decoded.includes("..")) return notFound();
  const dot = decoded.lastIndexOf(".");
  if (dot <= 0) return notFound();
  const id = decoded.slice(0, dot);
  const ext = decoded.slice(dot + 1);

  const image = deps.images.read(id, ext);
  if (!image) {
    deps.logger?.warn("comfy.image.missing", { id });
    return notFound();
  }
  return {
    status: 200,
    headers: {
      ...STATIC_SECURITY_HEADERS,
      "content-type": image.mimeType,
      "content-length": String(image.bytes.byteLength),
    },
    body: image.bytes,
  };
}

/** Corps JSON borné, ou `null` s'il est invalide. */
function parseBody(body: string): Record<string, unknown> | null {
  if (body.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Refus d'import : message + étiquettes trouvées / manquantes. */
function importRefusal(error: ComfyWorkflowError): ConfigHttpResponse {
  return json(400, {
    error: "invalid_workflow",
    code: error.code,
    message: error.message,
    found: error.found,
    missing: error.missing,
  });
}

async function handleTest(input: {
  headers: IncomingHttpHeaders;
  body: string;
  deps: ImagesApiDeps;
}): Promise<ConfigHttpResponse> {
  const guard = requireWriteGuards(input.headers);
  if (guard) return guard;
  // ⚠️ Des valeurs NON ENREGISTRÉES peuvent être testées : elles ne sont ni
  // écrites ni journalisées (même convention que le test du libraire).
  const parsed = parseBody(input.body);
  if (parsed === null) {
    return json(400, { error: "invalid_json", message: "Corps JSON invalide." });
  }
  const override: ComfyServerOverride = {};
  if (typeof parsed.baseUrl === "string" && parsed.baseUrl.trim() !== "") {
    override.baseUrl = parsed.baseUrl.trim();
  }
  if (typeof parsed.apiKey === "string" && parsed.apiKey.trim() !== "") {
    override.apiKey = parsed.apiKey.trim();
  }
  try {
    const stats = await input.deps.clientFor(override).systemStats();
    return json(200, {
      ok: true,
      message:
        "Serveur ComfyUI joignable" +
        (stats.version ? ` (version ${stats.version})` : "") +
        (stats.devices.length > 0 ? ` — périphérique : ${stats.devices[0]}` : "") +
        ".",
      ...(stats.version ? { version: stats.version } : {}),
      devices: stats.devices,
    });
  } catch (error) {
    if (isComfyError(error)) {
      return json(200, {
        ok: false,
        code: error.code,
        ...(error.status !== undefined ? { status: error.status } : {}),
        message: error.message,
      });
    }
    // Cause INCONNUE : on ne l'invente pas, on la donne telle quelle.
    return json(200, {
      ok: false,
      code: "unknown",
      message: `Le test a échoué : ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

/**
 * Traite une requête de l'API des images. Synchrone sauf pour le test de
 * connexion (seul appel réseau).
 */
export function handleImagesApiRequest(input: {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
  deps: ImagesApiDeps;
}): ConfigHttpResponse | Promise<ConfigHttpResponse> {
  const { method, path, deps } = input;

  if (path === `${IMAGES_API_PREFIX}/test`) {
    if (method !== "POST") return json(405, { error: "method_not_allowed", method });
    return handleTest({
      headers: input.headers,
      body: input.body,
      deps,
    });
  }

  if (path === `${IMAGES_API_PREFIX}/workflows`) {
    if (method === "GET" || method === "HEAD") {
      return json(200, { workflows: deps.workflows.list() });
    }
    if (method === "POST") {
      const guard = requireWriteGuards(input.headers);
      if (guard) return guard;
      const body = parseBody(input.body);
      if (body === null) {
        return json(400, {
          error: "invalid_json",
          message:
            "Corps JSON invalide : attendu { name, description, workflow, isDefault? }.",
        });
      }
      try {
        // ⚠️ Le store VALIDE tout (nom, description, documentation, graphe) AVANT
        // d'écrire : `name`/`description` sont relus en tant qu'inconnus, jamais
        // convertis ici.
        const summary = deps.workflows.importWorkflow({
          name: body.name as string,
          description: body.description as string,
          ...(body.documentation !== undefined
            ? { documentation: body.documentation as string }
            : {}),
          workflow: body.workflow,
          ...(body.isDefault === true ? { isDefault: true } : {}),
        });
        deps.logger?.info("comfy.workflow.imported", {
          name: summary.name,
          nodes: summary.nodes,
          bytes: summary.bytes,
          found: summary.found,
          missing: summary.missing,
        });
        return json(200, { ok: true, workflow: summary });
      } catch (error) {
        if (error instanceof ComfyWorkflowError) return importRefusal(error);
        throw error;
      }
    }
    return json(405, { error: "method_not_allowed", method });
  }

  const workflowPrefix = `${IMAGES_API_PREFIX}/workflows/`;
  if (path.startsWith(workflowPrefix)) {
    let rest: string;
    try {
      rest = decodeURIComponent(path.slice(workflowPrefix.length));
    } catch {
      return json(400, { error: "invalid_name", message: "Nom de workflow illisible." });
    }
    const isDefaultRoute = rest.endsWith("/defaut");
    const name = isDefaultRoute ? rest.slice(0, -"/defaut".length) : rest;
    if (isDefaultRoute) {
      if (method !== "POST") return json(405, { error: "method_not_allowed", method });
      const guard = requireWriteGuards(input.headers);
      if (guard) return guard;
      if (!deps.workflows.setDefault(name)) {
        return json(404, {
          error: "not_found",
          message: `Aucun workflow nommé « ${name} ».`,
        });
      }
      return json(200, { ok: true, name, isDefault: true });
    }
    if (method !== "DELETE" && method !== "PUT") {
      return json(405, { error: "method_not_allowed", method });
    }
    const guard = requireWriteGuards(input.headers);
    if (guard) return guard;
    if (method === "PUT") {
      // ⚠️ MÉTADONNÉES du workflow : `documentation` (consignes d'écriture pour
      // Yuki) et/ou `description` (description courte, sert au choix par
      // proximité). Un corps qui ne porte AUCUNE de ces deux clés est refusé
      // (jamais un effacement accidentel) ; `""` efface, explicitement.
      const body = parseBody(input.body);
      const hasDocumentation = body !== null && "documentation" in body;
      const hasDescription = body !== null && "description" in body;
      if (body === null || (!hasDocumentation && !hasDescription)) {
        return json(400, {
          error: "invalid_body",
          message:
            'Corps JSON invalide : attendu { "documentation": "…" } et/ou ' +
            '{ "description": "…" }.',
        });
      }
      try {
        // ⚠️ Le store VALIDE les deux valeurs avant d'écrire : un refus ne
        // laisse jamais une métadonnée enregistrée à moitié.
        const summary = deps.workflows.updateMetadata(name, {
          ...(hasDescription ? { description: body.description } : {}),
          ...(hasDocumentation ? { documentation: body.documentation } : {}),
        });
        if (!summary) {
          return json(404, {
            error: "not_found",
            message: `Aucun workflow nommé « ${name} ».`,
          });
        }
        deps.logger?.info("comfy.workflow.updated", {
          name: summary.name,
          chars: summary.documentation.length,
          descriptionChars: summary.description.length,
        });
        return json(200, { ok: true, workflow: summary });
      } catch (error) {
        if (error instanceof ComfyWorkflowError) return importRefusal(error);
        throw error;
      }
    }
    if (!deps.workflows.remove(name)) {
      return json(404, { error: "not_found", message: `Aucun workflow nommé « ${name} ».` });
    }
    return json(200, { ok: true, removed: name });
  }

  return json(404, { error: "not_found", path });
}
