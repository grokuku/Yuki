/**
 * API des CONSIGNES DURABLES d'un bot — `node:http`, aucun framework.
 *
 * Routes (une seule forme, UN bot par requête) :
 *   GET /api/bots/<id>/consignes → listes + bornes + chemin réel
 *   PUT /api/bots/<id>/consignes → remplace UNE ou LES DEUX listes
 *
 * ⚠️ La route est PAR BOT parce que le FICHIER est par bot
 * (`<state>/bots/<id>/consignes.md`) : un identifiant inconnu est un refus 404
 * qui le nomme (jamais un repli silencieux sur un autre bot).
 *
 * ⚠️ RÉSERVÉE À L'UTILISATEUR : mêmes garde-fous que `/api/config`
 * (`requireWriteGuards` : en-tête `X-Yuki-Config: 1` + contrôle `Origin`/`Host`).
 * Le modèle, lui, écrit par ses outils (`memoriser_consigne`, …) — jamais par
 * cette API.
 *
 * ⚠️ Le PUT ne réécrit QUE les sections des listes fournies : les autres lignes
 * du fichier (titres, notes) sont conservées — le contenu humain n'est jamais
 * perdu. Les bornes (50 / 50 / 500 caractères) sont REFUSÉES explicitement
 * (422), jamais tronquées.
 */

import type { IncomingHttpHeaders } from "node:http";

import {
  MAX_CONSIGNES,
  MAX_ENTREE_CHARS,
  MAX_FAITS,
  MAX_INJECTION_CHARS,
  type ConsignesDocument,
  type NatureEntree,
  type PortConsignes,
} from "../../consignes/index.js";
import type { Logger } from "../../observability/logger.js";
import { requireWriteGuards } from "./config.js";

/** Ce qu'un bot apporte à la route : son port (chemin capturé) et son nom affiché. */
export interface ConsignesPourBot {
  readonly port: PortConsignes;
  readonly nom?: string;
}

export interface ConsignesApiDeps {
  logger: Logger;
  /** Port des consignes d'un bot ; `undefined` ⇒ ce bot n'existe pas (404). */
  pourBot: (botId: string) => ConsignesPourBot | undefined;
}

export interface ConsignesHttpResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface ConsignesRequestInput {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
  deps: ConsignesApiDeps;
}

const JSON_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function json(status: number, body: unknown): ConsignesHttpResponse {
  return { status, body, headers: JSON_HEADERS };
}

/** Vue publique : les deux listes, leurs bornes et le fichier RÉELLEMENT utilisé. */
function vueConsignes(botId: string, cible: ConsignesPourBot): Record<string, unknown> {
  const document = cible.port.lire();
  return {
    bot: botId,
    ...(cible.nom !== undefined ? { nom: cible.nom } : {}),
    consignes: [...document.consignes],
    faits: [...document.faits],
    maxConsignes: MAX_CONSIGNES,
    maxFaits: MAX_FAITS,
    maxEntreeChars: MAX_ENTREE_CHARS,
    maxInjectionChars: MAX_INJECTION_CHARS,
    path: cible.port.chemin(),
  };
}

/** `/api/bots/<id>/consignes` → identifiant de bot, ou `null`. */
export function botDeCheminConsignes(path: string): string | null {
  const match = /^\/api\/bots\/([^/]+)\/consignes$/u.exec(path);
  if (match === null) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/** Vrai si le chemin relève de l'API des consignes (toujours par bot). */
export function isConsignesPath(path: string): boolean {
  return botDeCheminConsignes(path) !== null;
}

function handleGet(cible: ConsignesPourBot, botId: string): ConsignesHttpResponse {
  return json(200, vueConsignes(botId, cible));
}

/** Liste reçue du corps, ou `undefined` si le champ est absent. */
function listeRecue(valeur: unknown): string[] | undefined {
  if (valeur === undefined || valeur === null) return undefined;
  if (!Array.isArray(valeur)) return undefined;
  return valeur.map((entree) => (typeof entree === "string" ? entree : String(entree)));
}

function handlePut(
  input: ConsignesRequestInput,
  cible: ConsignesPourBot,
  botId: string,
): ConsignesHttpResponse {
  const guard = requireWriteGuards(input.headers);
  if (guard) return { status: guard.status, body: guard.body, headers: guard.headers };

  let parsed: unknown;
  try {
    parsed = input.body.trim() === "" ? {} : JSON.parse(input.body);
  } catch {
    return json(400, {
      error: "invalid_json",
      code: "invalid_json",
      message: "Corps JSON invalide.",
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return json(400, {
      error: "invalid_body",
      code: "invalid_body",
      message: "Objet JSON attendu ({ consignes?: string[], faits?: string[] }).",
    });
  }
  const corps = parsed as { consignes?: unknown; faits?: unknown };
  const consignes = listeRecue(corps.consignes);
  const faits = listeRecue(corps.faits);
  if (consignes === undefined && faits === undefined) {
    return json(400, {
      error: "invalid_body",
      code: "invalid_body",
      message: "Fournissez « consignes » et/ou « faits » (tableaux de chaînes).",
    });
  }
  const natures: { nature: NatureEntree; liste: string[] }[] = [];
  if (consignes !== undefined) natures.push({ nature: "consigne", liste: consignes });
  if (faits !== undefined) natures.push({ nature: "fait", liste: faits });

  for (const { nature, liste } of natures) {
    const resultat = cible.port.remplacer(nature, liste);
    if (!resultat.ok) {
      // ⚠️ REFUS EXPLICITE : l'interface affiche le message tel quel, avec le
      // compteur réel — jamais une liste silencieusement tronquée.
      input.deps.logger.info("consignes.refus", {
        bot: botId,
        nature,
        refus: resultat.refus,
        demandees: liste.length,
      });
      return json(422, {
        error: resultat.refus,
        code: resultat.refus,
        message: resultat.message,
        ...(vueConsignes(botId, cible) as Record<string, unknown>),
      });
    }
    const document: ConsignesDocument = resultat.document;
    input.deps.logger.info("consignes.saved", {
      bot: botId,
      nature,
      consignes: document.consignes.length,
      faits: document.faits.length,
    });
  }
  return json(200, vueConsignes(botId, cible));
}

/** Traite une requête de consignes et renvoie la réponse HTTP. */
export function handleConsignesRequest(input: ConsignesRequestInput): ConsignesHttpResponse {
  const botId = botDeCheminConsignes(input.path);
  if (botId === null) return json(404, { error: "not_found", path: input.path });
  const cible = input.deps.pourBot(botId);
  if (cible === undefined) {
    return json(404, {
      error: "bot_inconnu",
      code: "bot_inconnu",
      message: `Le bot « ${botId} » n'existe pas : ses consignes ne peuvent pas être lues ni écrites.`,
    });
  }
  if (input.method === "GET" || input.method === "HEAD") return handleGet(cible, botId);
  if (input.method === "PUT") return handlePut(input, cible, botId);
  return json(405, { error: "method_not_allowed", method: input.method });
}
