/**
 * API de configuration (Lot 11) — `node:http`, aucun framework.
 *
 * Routes (fonctionnent même en mode dégradé, sans clé, sans PiHost) :
 *   GET  /api/config          → valeurs effectives (jamais une clé en clair)
 *   PUT  /api/config          → patch partiel fusionnant
 *   POST /api/config/llm/test → test de connexion (endpoint OpenAI `/models`)
 *   GET  /api/config/password → mot de passe d'INSTANCE : « défini ou pas » (+ date)
 *   POST /api/config/password → définit / change le mot de passe d'instance
 *   DEL  /api/config/password → retire le mot de passe d'instance (si possible)
 *
 * Précédence : `défauts < store < env`. Un champ défini par l'environnement est
 * VERROUILLÉ : un `PUT` le visant est refusé (`locked_by_env`), jamais un no-op
 * silencieux.
 *
 * Précautions minimales (le durcissement complet est au Lot 9) : en-tête
 * personnalisé `X-Yuki-Config: 1` + contrôle `Origin`/`Host` sur les écritures,
 * journal d'audit sans valeur de secret.
 */

import type { IncomingHttpHeaders } from "node:http";

import {
  ConfigValidationError,
  LockedByEnvError,
  ScopedFieldError,
  type ConfigRuntime,
  type ConfigSnapshot,
} from "../../config/runtime.js";
import { botHistoriqueMono } from "../../bots/courant.js";
import {
  CAPACITES_BOT,
  type BotRecord,
  type CapaciteBot,
  type RegistreBots,
} from "../../bots/registry.js";
import type { EtatExecutionBot, ExecutionBots } from "../../bots/execution.js";
import {
  AdminBotError,
  RETENTION_ARCHIVES_JOURS,
  compterDonneesBot,
  compterSessionsPi,
  creerBot,
  definirActif,
  definirEchange,
  modifierBot,
  supprimerBot,
} from "../../bots/admin.js";
import {
  LibrarianClient,
  LIBRARIAN_ERROR_MESSAGES,
  isLibrarianError,
  type LibrarianErrorCode,
  type LibrarianStatus,
} from "../../librarian/index.js";
import { VOICE_SPEECH_INSTRUCTION } from "../../llm/prompts.js";
import { ConfigStoreWriteError } from "../../config/store.js";
import { describeWriteFailure } from "../../config/paths.js";
import type { Logger } from "../../observability/logger.js";
import {
  InstancePasswordError,
  INSTANCE_PASSWORD_MAX_LENGTH,
  INSTANCE_PASSWORD_MIN_LENGTH,
  type InstancePasswordStore,
} from "../../security/instance-password.js";
import { SENSITIVE_IDLE_TIMEOUT_MS } from "../../agents/lock.js";
import { CLE_PERSONNALITE } from "../../bots/personnalite-bot.js";

export const CONFIG_WRITE_HEADER = "x-yuki-config";
export const CONFIG_HEADER_VALUE = "1";
/**
 * En-tête OPTIONNEL : identifiant du FLUX UI à l'origine d'une écriture
 * (`engine-editor-save`, `declare-model`, `activate-engine`, `revert-…`).
 * Sert au DIAGNOSTIC en production (« quelle action a écrit cette
 * configuration ? »). Absent ⇒ `"unspecified"` : jamais exigé.
 */
export const CONFIG_FLOW_HEADER = "x-yuki-config-flow";
/** Jeton de flux accepté : borné, jamais un texte libre recopié tel quel. */
const FLOW_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
/** Valeur de repli quand l'en-tête de flux est absent ou invalide. */
export const UNSPECIFIED_FLOW = "unspecified";
/** Délai du test de connexion LLM. */
export const LLM_TEST_TIMEOUT_MS = 5_000;
/** Délai du test de connexion au libraire (Pi-Web). */
export const LIBRARIAN_TEST_TIMEOUT_MS = 8_000;
/** Taille maximale acceptée pour un corps de requête. */
export const MAX_CONFIG_BODY_BYTES = 1_000_000;

/**
 * Vue (LECTURE SEULE) de la personnalité EFFECTIVE d'un bot : ce que l'interface
 * peut AFFIRMER sans mentir.
 *
 * ⚠️ `provenance` est la même notion que `ProvenancePersonnalite`
 * (`src/personality/personality.ts`) : reprise ici en texte pour que l'API ne
 * dépende pas du domaine.
 */
export interface PersonnaliteEffectiveVue {
  /** Texte réellement composé dans le prompt du bot. */
  readonly texte: string;
  /** Nombre de points de code (le client ne recompte pas à sa façon). */
  readonly chars: number;
  /** `bot` | `fichier-bot` | `fichier-instance` | `defaut` | `aucune`. */
  readonly provenance: "bot" | "fichier-bot" | "fichier-instance" | "defaut" | "aucune";
  /** Chemin du fichier qui a servi, sinon `null`. */
  readonly chemin: string | null;
}

export interface ConfigApiDeps {
  runtime: ConfigRuntime;
  logger: Logger;
  /** Injectable pour les tests. Défaut : `fetch` global. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  /**
   * Mot de passe d'INSTANCE (haché scrypt, volume `state`). Absent ⇒ les routes
   * `/api/config/password` répondent `password_unavailable` (jamais un faux
   * succès : l'agent sensible resterait alors non déverrouillable).
   */
  password?: InstancePasswordStore;
  /**
   * Nombre d'agents déclarés « matériel sensible » : un mot de passe d'instance
   * ne peut PAS être retiré tant qu'il en existe (ces agents deviendraient
   * inutilisables pour toujours).
   */
  sensitiveAgentCount?: () => number;
  /**
   * Notification d'un mot de passe REÇU (jamais journalisé) : sert à l'ajouter à
   * la liste des valeurs à MASQUER, pour qu'une fuite accidentelle ultérieure
   * (log/audit) soit masquée elle aussi.
   */
  onSecretSeen?: (value: string) => void;
  /**
   * BOTS de l'instance : registre lu au démarrage + ADMINISTRATION (lot 35e).
   * `registre: null` = mode mono-bot historique (aucun `bots.json`) ⇒ la seule
   * route `/api/bots` répond la liste `yuki`, `/api/bots/yuki/config` fonctionne,
   * et la CRÉATION est refusée (`409 registre_absent`).
   * `stateDir` = volume `state` : racine de `bots/` et `bots-supprimes/` ; absent
   * ⇒ les routes d'administration répondent `503 bots_admin_indisponible`.
   */
  /**
   * ⚠️ OUTILS EFFECTIFS d'un bot (`toolAllowlistForChat`), en LECTURE SEULE : la
   * page « Personnalité » montre la liste que le prompt annonce réellement au
   * modèle. Absent ⇒ l'UI n'affiche aucune liste (jamais une liste inventée).
   */
  outilsEffectifs?: (botId: string) => readonly string[];
  /**
   * ⚠️ PERSONNALITÉ EFFECTIVE d'un bot (LECTURE SEULE) : le texte RÉELLEMENT
   * composé dans son prompt, avec sa PROVENANCE (`bot` = valeur enregistrée,
   * `fichier-bot` / `fichier-instance` = reprise d'un fichier d'amorçage,
   * `defaut` = défaut livré, `aucune`). Absent ⇒ l'interface n'affirme rien
   * (jamais un texte ni une origine inventés).
   */
  personnaliteEffective?: (botId: string) => PersonnaliteEffectiveVue | null;
  bots?: {
    registre?: RegistreBots | null;
    stateDir?: string;
    /**
     * Volume `pi` (lot 35i) : les SESSIONS d'un bot vivent sous
     * `<piSessionsDir>/<id>`. La suppression les ARCHIVE (copie + suppression)
     * et la confirmation les COMPTE — sans ce chemin, la route le dit
     * (`sessions: null` au lieu d'un zéro trompeur).
     */
    piSessionsDir?: string;
    /**
     * DÉTACHEMENT DES AGENTS (lot 35g, `src/bots/admin.ts`) : appelé avec
     * l'identifiant d'un bot SUPPRIMÉ, pour le retirer de la liste `bots` de
     * chaque agent. Renvoie le nombre d'agents modifiés (journalisé
     * `bot.agents.detached`). Les agents eux-mêmes ne sont jamais supprimés.
     */
    retirerDesListesDAgents?: (botId: string) => number | void;
    /**
     * ⚠️ LOT 36 (L8) — L'ÉTAT RÉEL, ET LE CYCLE DE VIE (`src/bots/execution.ts`).
     *
     * Absent ⇒ `GET /api/bots` n'ajoute AUCUN champ d'exécution et les routes
     * de démarrage/arrêt répondent `409 cycle_indisponible` : une instance qui
     * ne sait pas piloter ses bots ne prétend pas le faire.
     */
    execution?: ExecutionBots;
  };
}

export interface ConfigHttpResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface ConfigRequestInput {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
  deps: ConfigApiDeps;
}

const JSON_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function json(status: number, body: unknown): ConfigHttpResponse {
  return { status, body, headers: JSON_HEADERS };
}

/**
 * Lit un en-tête de façon insensible à la casse. `node:http` minuscule déjà les
 * noms, mais l'API est aussi appelée avec des en-têtes forgés (tests, proxies).
 */
function headerString(
  headers: IncomingHttpHeaders,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  for (const [key, raw] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue;
    if (typeof raw === "string") return raw;
    if (Array.isArray(raw)) return raw[0];
  }
  return undefined;
}

/**
 * Normalise un hôte (en-tête `Host` ou URL `Origin`) en `host[:port]` :
 * minuscules et port par défaut retiré. Le schéma est ignoré (couvre la
 * terminaison TLS derrière un reverse-proxy). Renvoie `null` si non analysable.
 */
function normalizeHost(value: string): string | null {
  try {
    const url = new URL(value.includes("://") ? value : `http://${value}`);
    const host = url.hostname.toLowerCase();
    return url.port === "" ? host : `${host}:${url.port}`;
  } catch {
    return null;
  }
}

/**
 * Contrôle `Origin`/`Host` : si un `Origin` est présent, son hôte doit
 * correspondre à celui de la requête (même origine).
 *
 * Couvre un accès légitime par IP LAN (`http://10.10.0.5:8083`), par nom
 * d'hôte (casse insensible) et derrière un reverse-proxy (port par défaut,
 * schéma TLS terminé en amont), SANS l'ouvrir à une origine étrangère.
 */
function sameOrigin(headers: IncomingHttpHeaders): boolean {
  const origin = headerString(headers, "origin");
  if (origin === undefined) return true; // pas d'Origin (ex. curl) : autorisé
  const host = headerString(headers, "host");
  if (host === undefined) return false;
  const originHost = normalizeHost(origin);
  const requestHost = normalizeHost(host);
  return originHost !== null && requestHost !== null && originHost === requestHost;
}

/**
 * Lit l'identifiant de flux UI déclaré dans l'en-tête, assaini et borné.
 * Valeur de repli (`"unspecified"`) : l'instrumentation n'exige JAMAIS sa
 * présence (compatibilité avec les clients qui ne l'envoient pas).
 */
export function configWriteFlow(headers: IncomingHttpHeaders): string {
  const raw = (headerString(headers, CONFIG_FLOW_HEADER) ?? "").trim();
  return FLOW_PATTERN.test(raw) ? raw : UNSPECIFIED_FLOW;
}

/** Applique les garde-fous des routes d'écriture. Renvoie une erreur ou `null`. */
export function requireWriteGuards(
  headers: IncomingHttpHeaders,
): ConfigHttpResponse | null {
  if (headerString(headers, CONFIG_WRITE_HEADER) !== CONFIG_HEADER_VALUE) {
    return json(403, {
      error: "forbidden",
      code: "missing_config_header",
      message: `En-tête ${CONFIG_WRITE_HEADER}: ${CONFIG_HEADER_VALUE} requis.`,
    });
  }
  if (!sameOrigin(headers)) {
    return json(403, {
      error: "forbidden",
      code: "bad_origin",
      message: "Origine de la requête refusée.",
    });
  }
  return null;
}

function guardWrite(input: ConfigRequestInput): ConfigHttpResponse | null {
  return requireWriteGuards(input.headers);
}

function audit(
  deps: ConfigApiDeps,
  changes: ReturnType<ConfigRuntime["update"]>["changes"],
  flow: string,
): void {
  const at = new Date((deps.now ?? Date.now)()).toISOString();
  for (const change of changes) {
    deps.logger.info("config.changed", {
      at,
      // Quelle action de l'UI a demandé l'écriture (diagnostic en production).
      flow,
      field: change.path,
      kind: change.secret ? "secret" : "value",
      from: change.from,
      to: change.to,
    });
  }
  if (changes.length === 0) {
    deps.logger.info("config.unchanged", { at, flow });
  }
}

function handleGet(deps: ConfigApiDeps): ConfigHttpResponse {
  const snapshot = deps.runtime.snapshot();
  return json(200, {
    fields: snapshot.fields,
    status: snapshot.status,
    // Texte d'instruction ajouté au prompt système quand la voix est active
    // (`tts.enabled === "on"`). Exposé pour que `/config` le montre en LECTURE
    // SEULE : l'utilisateur voit le texte réellement injecté, jamais une magie
    // invisible. Le texte est identique quelle que soit la valeur courante du
    // champ — c'est son APPLICATION qui est conditionnelle.
    voiceInstruction: VOICE_SPEECH_INSTRUCTION,
    // ⚠️ LISTE D'OUTILS RÉELLE du bot de la pile (lecture seule) : elle est GÉNÉRÉE
    // à chaque composition (`src/llm/prompt-systeme.ts`) et n'est éditable nulle
    // part. `null` = l'instance ne sait pas la calculer (aucune liste inventée).
    outilsGeneres: deps.outilsEffectifs?.(deps.runtime.botId) ?? null,
    // ⚠️ Personnalité EFFECTIVE du bot de la pile, avec sa provenance : l'écran
    // d'instance dit ainsi ce qui est RÉELLEMENT composé (le champ ci-dessus est la
    // valeur COMMUNE, qui n'est pas forcément celle d'un bot).
    personnaliteEffective: deps.personnaliteEffective?.(deps.runtime.botId) ?? null,
  });
}

function handlePut(input: ConfigRequestInput): ConfigHttpResponse {
  const guard = guardWrite(input);
  if (guard) return guard;
  const flow = configWriteFlow(input.headers);

  let patch: unknown;
  try {
    patch = input.body.trim() === "" ? {} : JSON.parse(input.body);
  } catch {
    return json(400, {
      error: "invalid_json",
      fields: [{ path: "", code: "invalid_json", message: "Corps JSON invalide." }],
    });
  }
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return json(400, {
      error: "invalid_body",
      fields: [
        {
          path: "",
          code: "invalid_body",
          message: "Objet JSON attendu (patch de champs).",
        },
      ],
    });
  }

  try {
    // ÉCRAN D'INSTANCE : les réglages d'instance ET le côté INSTANCE des clés
    // mixtes ; une clé propre à un bot est REFUSÉE (`bot_scoped_field`).
    const result = input.deps.runtime.update(patch as Record<string, unknown>, {
      portee: "instance",
      refuser: "bot",
    });
    audit(input.deps, result.changes, flow);
    return json(200, {
      fields: result.fields,
      status: result.status,
      applied: result.applied,
      voiceInstruction: VOICE_SPEECH_INSTRUCTION,
      outilsGeneres: input.deps.outilsEffectifs?.(input.deps.runtime.botId) ?? null,
      personnaliteEffective:
        input.deps.personnaliteEffective?.(input.deps.runtime.botId) ?? null,
    });
  } catch (error) {
    return configWriteError(input.deps, error);
  }
}

/**
 * Traduit une erreur d'écriture de configuration en réponse HTTP. Partagé par
 * les DEUX écrans (`/api/config` et `/api/bots/<id>/config`) : un même refus
 * doit se lire de la même façon.
 */
function configWriteError(
  deps: ConfigApiDeps,
  error: unknown,
): ConfigHttpResponse {
  if (error instanceof ScopedFieldError) {
    return json(400, {
      error: error.code,
      code: error.code,
      fields: error.fields,
      message: error.message,
    });
  }
  if (error instanceof LockedByEnvError) {
    const variable = error.locked[0]?.variable;
    return json(400, {
      error: "locked_by_env",
      code: "locked_by_env",
      ...(variable ? { variable } : {}),
      fields: error.locked.map((entry) => ({
        path: entry.path,
        code: "locked_by_env",
        message: `Champ verrouillé par l'environnement (${entry.variable}).`,
      })),
    });
  }
  if (error instanceof ConfigValidationError) {
    return json(400, { error: "invalid_config", fields: error.fields });
  }
  if (error instanceof ConfigStoreWriteError) {
    // Cause journalisée ET renvoyée : un 500 muet rendrait le diagnostic
    // impossible (volume `state` non inscriptible, disque plein…).
    deps.logger.error("config.store.write_failed", {
      field: "store",
      path: error.path,
      code: error.code,
      reason: error.reason,
      error: error.cause instanceof Error ? error.cause.message : String(error.cause),
    });
    return json(500, {
      error: "config_store_unwritable",
      code: "config_store_unwritable",
      path: error.path,
      // Le conseil dépend de la CAUSE RÉELLE (code système) : « :ro » pour
      // EROFS, permissions pour EACCES/EPERM, absent pour ENOENT, honnête
      // (avec le code brut) sinon. Jamais de `chown` quand le montage est ro.
      message: `${error.message} ${describeWriteFailure({
        volume: "state",
        path: error.path,
        code: error.code,
        service: "gateway",
      })}`,
    });
  }
  throw error;
}

async function handleLlmTest(input: ConfigRequestInput): Promise<ConfigHttpResponse> {
  const guard = guardWrite(input);
  if (guard) return guard;

  let body: Record<string, unknown>;
  try {
    const parsed = input.body.trim() === "" ? {} : JSON.parse(input.body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("objet attendu");
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return json(400, {
      error: "invalid_json",
      fields: [{ path: "", code: "invalid_json", message: "Corps JSON invalide." }],
    });
  }

  const role = body.role;
  if (role !== "light" && role !== "heavy") {
    return json(400, {
      error: "invalid_role",
      fields: [
        {
          path: "role",
          code: "invalid_role",
          message: 'Rôle attendu : "light" ou "heavy".',
        },
      ],
    });
  }

  const prefix = `llm.${role}`;
  const baseUrl = input.deps.runtime.getString(`${prefix}.baseUrl`).replace(/\/+$/, "");
  const provided =
    typeof body.apiKey === "string" && body.apiKey.trim() !== ""
      ? body.apiKey.trim()
      : undefined;
  const key = provided ?? input.deps.runtime.getString(`${prefix}.apiKey`).trim();
  if (key.length === 0) {
    return json(200, {
      ok: false,
      error: "Aucune clé fournie ni configurée pour ce rôle.",
    });
  }

  const url = `${baseUrl}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TEST_TIMEOUT_MS);
  timer.unref?.();
  try {
    const fetchImpl = input.deps.fetchImpl ?? fetch;
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      return json(200, {
        ok: false,
        status: response.status,
        error: `Le fournisseur a répondu ${response.status}.`,
      });
    }
    let models: string[] | undefined;
    try {
      const data = (await response.json()) as { data?: unknown };
      if (Array.isArray(data?.data)) {
        models = data.data
          .map((entry) => (entry as { id?: unknown } | null)?.id)
          .filter((id): id is string => typeof id === "string");
      }
    } catch {
      // Modèles indisponibles : le test reste OK.
    }
    return json(200, {
      ok: true,
      status: response.status,
      ...(models ? { models } : {}),
    });
  } catch (error) {
    const message =
      error instanceof Error && error.name === "AbortError"
        ? `Délai dépassé (${LLM_TEST_TIMEOUT_MS / 1000} s).`
        : error instanceof Error
          ? error.message
          : String(error);
    return json(200, { ok: false, error: message });
  } finally {
    clearTimeout(timer);
  }
}

/** Libellé de la COUCHE d'authentification en cause (message honnête, distinct). */
function librarianAuthLayer(code: LibrarianErrorCode): "token" | "key" | undefined {
  if (code === "unauthorized_key") return "key";
  if (code === "unauthorized_token") return "token";
  return undefined;
}

/**
 * Message d'échec RÉELLEMENT observé pour le test de connexion.
 *
 * ⚠️ Un 5xx sur `/status` ne permet pas de DEVINER quelle couche est en cause ;
 * on énonce donc le fait (le statut reçu) et on rapporte l'interprétation
 * DOCUMENTÉE du contrat d'API (5xx ⇒ moteurs de recherche web indisponibles),
 * sans jamais inventer de cause.
 */
function librarianFailureMessage(code: LibrarianErrorCode, status: number | undefined): string {
  if (status === 500 || status === 502) {
    return (
      `Le libraire a répondu une erreur serveur (${status}). D'après le contrat ` +
      "d'API, cela signifie que ses moteurs de recherche web sont indisponibles : " +
      "la bibliothèque locale peut rester consultable."
    );
  }
  return LIBRARIAN_ERROR_MESSAGES[code];
}

/** Compose le message de succès à partir de ce que `/status` a RÉELLEMENT renvoyé. */
function describeLibrarianStatus(status: LibrarianStatus): string {
  const docs =
    typeof status.totalDocs === "number"
      ? `${status.totalDocs} document(s)`
      : "nombre de documents inconnu";
  const parts = [`Libraire joignable — ${docs}`];
  if (status.lastUpdated) parts.push(`dernière mise à jour ${status.lastUpdated}`);
  if (status.lastScan) parts.push(`dernier scan ${status.lastScan}`);
  return `${parts.join(", ")}.`;
}

/**
 * `POST /api/config/librarian/test` — teste la connexion au libraire de Pi-Web
 * en appelant `GET {base}/api/librarian/status`.
 *
 * ⚠️ Le message renvoyé reflète STRICTEMENT ce qui a été observé (aucune cause
 * inventée) : joignable (avec le nombre de documents), authentification refusée
 * (401 = aucune clé valide parmi celles envoyées ; 403 = jeton agent refusé),
 * moteurs web indisponibles (502), trop de requêtes (429), ou le libraire
 * INJOIGNABLE depuis Yuki (réseau/délai). ⚠️ Libry n'a qu'UNE couche : la clé
 * libraire (X-API-Key) suffit ; le jeton agent (Authorization) est facultatif.
 * Des valeurs non enregistrées peuvent être testées en les fournissant dans le
 * corps ; elles ne sont ni écrites ni journalisées.
 */
async function handleLibrarianTest(
  input: ConfigRequestInput,
): Promise<ConfigHttpResponse> {
  const guard = guardWrite(input);
  if (guard) return guard;

  let body: Record<string, unknown>;
  try {
    const parsed = input.body.trim() === "" ? {} : JSON.parse(input.body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("objet attendu");
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return json(400, {
      error: "invalid_json",
      fields: [{ path: "", code: "invalid_json", message: "Corps JSON invalide." }],
    });
  }

  const runtime = input.deps.runtime;
  const provided = (key: string): string | undefined => {
    const raw = body[key];
    return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : undefined;
  };
  const baseUrl = provided("baseUrl") ?? runtime.getString("librarian.baseUrl").trim();
  const agentToken =
    provided("agentToken") ?? runtime.getString("librarian.agentToken").trim();
  const apiKey = provided("apiKey") ?? runtime.getString("librarian.apiKey").trim();

  const client = new LibrarianClient({
    config: () => ({ baseUrl, agentToken, apiKey }),
    ...(input.deps.fetchImpl ? { fetchImpl: input.deps.fetchImpl } : {}),
    timeoutMs: LIBRARIAN_TEST_TIMEOUT_MS,
  });

  try {
    const status = await client.status();
    return json(200, { ok: true, message: describeLibrarianStatus(status), info: status });
  } catch (error) {
    if (isLibrarianError(error)) {
      const layer = librarianAuthLayer(error.code);
      return json(200, {
        ok: false,
        code: error.code,
        ...(error.status !== undefined ? { status: error.status } : {}),
        ...(layer ? { layer } : {}),
        message: librarianFailureMessage(error.code, error.status),
      });
    }
    // Cause inattendue : on la NOMME (jamais de cause inventée, jamais un secret).
    return json(200, {
      ok: false,
      code: "internal_error",
      message: `Erreur inattendue lors du test du libraire : ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }
}

/** Vrai si le chemin relève de l'API de configuration (instance OU bot). */
export function isConfigPath(path: string): boolean {
  return (
    path === "/api/config" ||
    path.startsWith("/api/config/") ||
    path === "/api/bots" ||
    path.startsWith("/api/bots/")
  );
}

// ── BOTS : liste et configuration d'UN bot (lot 35b, sous-lot 1b-3) ─────────

/** Forme minimale d'un bot exposée par `GET /api/bots`. */
export interface BotListing {
  id: string;
  nom: string;
  /** CAPACITÉS du bot (familles d'outils) : `[]` = il ne peut que répondre. */
  capacites: CapaciteBot[];
  actif: boolean;
  ordre: number;
  /**
   * ⚠️ LOT 36 (L8) : ce qui TOURNE (`demarre`, `erreur`, `sessions`, `workers`).
   * `actif` dit ce que le bot DOIT faire ; ce champ dit ce qu'il FAIT. Absent
   * seulement si l'instance n'a pas de port d'exécution (tests, mode dégradé).
   */
  execution?: EtatExecutionBot;
}

/**
 * Bots connus de l'instance, triés par `ordre`. En mode mono-bot historique
 * (aucun `bots.json`), le seul bot est celui que le runtime applique déjà.
 */
function botsConnus(deps: ConfigApiDeps): BotListing[] {
  const registre = deps.bots?.registre;
  const entrees: BotRecord[] = registre ? [...registre.bots] : [];
  /**
   * ⚠️ LOT 36 (L8) : l'état d'EXÉCUTION est joint à chaque bot quand l'instance
   * sait le lire. C'est ce qui empêche `actif` de mentir : `actif` dit ce que le
   * bot DOIT faire, `execution.demarre` ce qu'il FAIT.
   */
  const etat = (botId: string): { execution?: EtatExecutionBot } => {
    const port = deps.bots?.execution;
    return port === undefined ? {} : { execution: port.etat(botId) };
  };
  if (entrees.length === 0) {
    const botId = deps.runtime.botId;
    // ⚠️ LOT 45 : plus de nom en dur pour un identifiant donné. En mode mono-bot,
    // il n'y a pas de registre : l'identité de cette disposition EST le bot
    // historique (`botHistoriqueMono`, seule source de son nom affiché). Un
    // identifiant inattendu garde son identifiant pour nom — rien n'est inventé.
    const mono = botHistoriqueMono();
    return [
      {
        id: botId,
        nom: botId === mono.id ? mono.nom : botId,
        // Mono-bot historique : le bot porte le produit entier, donc toutes les
        // capacités (aucune restriction n'a jamais existé dans ce mode).
        capacites: [...CAPACITES_BOT],
        actif: true,
        ordre: 0,
        ...etat(botId),
      },
    ];
  }
  return entrees
    .sort((a, b) => a.ordre - b.ordre)
    .map((bot) => ({
      id: bot.id,
      nom: bot.nom,
      capacites: [...bot.capacites],
      actif: bot.actif,
      ordre: bot.ordre,
      ...etat(bot.id),
    }));
}

/** Bot demandé, ou `null` s'il n'existe pas. */
function botDemande(deps: ConfigApiDeps, botId: string): BotListing | null {
  return botsConnus(deps).find((bot) => bot.id === botId) ?? null;
}

/** 404 qui NOMME l'identifiant refusé (jamais un 404 muet). */
function botInconnu(botId: string): ConfigHttpResponse {
  return json(404, {
    error: "bot_not_found",
    code: "bot_not_found",
    botId,
    message: `Bot inconnu : « ${botId} ».`,
  });
}

/**
 * `GET /api/bots` — liste des bots (`id`, `nom`, `capacites`, `actif`, `ordre`).
 * Sert au sélecteur de la page d'un bot et à la liste des cases de capacités.
 *
 * ⚠️ La réponse porte AUSSI ce que le sélecteur de la barre du haut doit dire
 * VRAI : `botDuRun` (le bot du RUN — son host sert les clients qui ne nomment
 * aucun bot ; ⚠️ LOT 45 : c'est le PREMIER par `ordre`, plus un « bot
 * principal » élu) et `echanges` (les boucles on/off entre bots).
 *
 * ⚠️ PLUS DE PLAFOND (décision utilisateur du 2026-11-13 : « retire le plafond ») :
 * la réponse ne porte plus `plafond` ni `refuses`. Un bot `actif` démarre toujours ;
 * s'il ne tourne pas, la cause est son `execution.erreur` (une VRAIE erreur).
 */
function handleBotsList(deps: ConfigApiDeps): ConfigHttpResponse {
  return json(200, {
    bots: botsConnus(deps),
    // ⚠️ LOT 45 : plus de « bot principal ». Ce champ nomme le bot du RUN (celui
    // dont le host sert une connexion SANS `?bot=`), résolu au démarrage comme le
    // premier bot par `ordre` — aucun identifiant n'est privilégié.
    botDuRun: deps.runtime.botId,
    echanges: { ...(deps.bots?.registre?.echanges ?? {}) },
  });
}

/**
 * `PATCH /api/bots/echanges` — ALLUME ou ÉTEINT la BOUCLE entre deux bots.
 *
 * Corps : `{ de, vers, actif }` — `echanges["de->vers"] = { actif }`.
 * ⚠️ Aucun frein par paire (décision utilisateur) : ce booléen est le SEUL
 * garde-fou, et la paire est ORIENTÉE.
 */
function handleBotEchange(input: ConfigRequestInput): ConfigHttpResponse {
  const guard = guardWrite(input);
  if (guard) return guard;
  const deps = input.deps;
  const registre = deps.bots?.registre ?? null;
  if (!registre) {
    return json(409, {
      error: "registre_absent",
      code: "registre_absent",
      message:
        "L'instance n'est pas en mode multi-bot (aucun `state/bots.json`) : " +
        "aucune boucle entre bots ne peut être réglée.",
    });
  }
  const stateDir = deps.bots?.stateDir;
  if (!stateDir) {
    return json(503, {
      error: "bots_admin_indisponible",
      code: "bots_admin_indisponible",
      message: "Administration des bots indisponible : volume `state` inconnu.",
    });
  }
  const corps = lireCorpsObjet(input.body);
  if (!corps.ok) return corps.response;
  const de = corps.value["de"];
  const vers = corps.value["vers"];
  if (typeof de !== "string" || typeof vers !== "string") {
    return json(400, {
      error: "echange_invalide",
      code: "echange_invalide",
      message: "Les champs « de » et « vers » doivent nommer deux bots.",
    });
  }
  try {
    const resultat = definirEchange({
      stateDir,
      registre,
      de,
      vers,
      actif: corps.value["actif"],
    });
    // ⚠️ Le registre EN MÉMOIRE suit l'écriture (c'est lui que lit `GET /api/bots`).
    if (deps.bots && !resultat.inchange) deps.bots.registre = resultat.registre;
    deps.logger.info("bots.echange", {
      cle: resultat.cle,
      actif: resultat.actif,
      inchange: resultat.inchange,
      flow: configWriteFlow(input.headers),
    });
    return json(200, {
      cle: resultat.cle,
      actif: resultat.actif,
      inchange: resultat.inchange,
      echanges: resultat.echanges,
    });
  } catch (error) {
    return adminBotError(deps, error);
  }
}

/**
 * ⚠️ VÉRITÉ DE L'INTERFACE (régression « personnalité disparue » du 2026-11-14) :
 * sur la page d'un BOT, le champ « Personnalité » montrait le défaut LIVRÉ alors
 * que le texte de l'utilisateur vivait dans un fichier d'amorçage.
 *
 * Quand aucune valeur n'a été enregistrée mais qu'un fichier porte le texte
 * (fichier DU BOT, ou fichier HISTORIQUE de l'instance), le champ affiche CE
 * texte avec sa provenance : l'utilisateur voit la personnalité réellement
 * composée, et s'il enregistre, la valeur devient la sienne (elle ne dépend plus
 * du fichier). Une valeur ENREGISTRÉE n'est jamais remplacée.
 */
function champsAvecPersonnaliteEffective(
  fields: ConfigSnapshot["fields"],
  botId: string,
  deps: ConfigApiDeps,
): ConfigSnapshot["fields"] {
  const effective = deps.personnaliteEffective?.(botId);
  if (effective === undefined || effective === null) return fields;
  if (effective.texte.trim() === "") return fields;
  if (
    effective.provenance !== "fichier-bot" &&
    effective.provenance !== "fichier-instance"
  ) {
    return fields;
  }
  const entree = fields[CLE_PERSONNALITE];
  if (entree === undefined || !("value" in entree) || entree.origin !== "default") {
    return fields;
  }
  return {
    ...fields,
    [CLE_PERSONNALITE]: {
      ...entree,
      value: effective.texte,
      provenance: effective.provenance,
      ...(effective.chemin !== null ? { fichier: effective.chemin } : {}),
    },
  };
}

/** `GET /api/bots/<id>/config` — valeurs effectives du bot demandé. */
function handleBotGet(deps: ConfigApiDeps, botId: string): ConfigHttpResponse {
  const snapshot = deps.runtime.snapshotPour(botId);
  return json(200, {
    bot: { id: botId },
    fields: champsAvecPersonnaliteEffective(snapshot.fields, botId, deps),
    status: snapshot.status,
    voiceInstruction: VOICE_SPEECH_INSTRUCTION,
    outilsGeneres: deps.outilsEffectifs?.(botId) ?? null,
    personnaliteEffective: deps.personnaliteEffective?.(botId) ?? null,
  });
}

/**
 * `PUT /api/bots/<id>/config` — écrit les réglages du bot demandé.
 *
 * ⚠️ REFUS CROISÉ : une clé `instance` est refusée (`instance_scoped_field`).
 * ⚠️ Une clé `mixte` écrit son côté BOT (`portee: "bot"`) — le côté instance
 * reste sur `PUT /api/config`.
 */
function handleBotPut(
  input: ConfigRequestInput,
  botId: string,
): ConfigHttpResponse {
  const guard = guardWrite(input);
  if (guard) return guard;
  const flow = configWriteFlow(input.headers);

  let patch: unknown;
  try {
    patch = input.body.trim() === "" ? {} : JSON.parse(input.body);
  } catch {
    return json(400, {
      error: "invalid_json",
      fields: [{ path: "", code: "invalid_json", message: "Corps JSON invalide." }],
    });
  }
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return json(400, {
      error: "invalid_body",
      fields: [
        {
          path: "",
          code: "invalid_body",
          message: "Objet JSON attendu (patch de champs).",
        },
      ],
    });
  }

  try {
    const result = input.deps.runtime.updatePour(
      botId,
      patch as Record<string, unknown>,
      { portee: "bot", refuser: "instance" },
    );
    audit(input.deps, result.changes, flow);
    return json(200, {
      bot: { id: botId },
      fields: champsAvecPersonnaliteEffective(result.fields, botId, input.deps),
      status: result.status,
      applied: result.applied,
      voiceInstruction: VOICE_SPEECH_INSTRUCTION,
      outilsGeneres: input.deps.outilsEffectifs?.(botId) ?? null,
      personnaliteEffective: input.deps.personnaliteEffective?.(botId) ?? null,
    });
  } catch (error) {
    return configWriteError(input.deps, error);
  }
}

/** Chemin `/api/bots/<id>/config` → identifiant de bot, ou `null`. */
function botIdOfPath(path: string): string | null {
  const match = /^\/api\/bots\/([^/]+)\/config$/.exec(path);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1] as string);
  } catch {
    return null;
  }
}

// ── BOTS : administration (lot 35e — ajouter / cloner / supprimer) ──────────

/** Corps JSON d'une requête d'administration : objet attendu, jamais un tableau. */
function lireCorpsObjet(
  body: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; response: ConfigHttpResponse } {
  let parsed: unknown;
  try {
    parsed = body.trim() === "" ? {} : JSON.parse(body);
  } catch {
    return {
      ok: false,
      response: json(400, {
        error: "invalid_json",
        code: "invalid_json",
        message: "Corps JSON invalide.",
      }),
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      response: json(400, {
        error: "invalid_body",
        code: "invalid_body",
        message: "Objet JSON attendu.",
      }),
    };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/** Refus d'administration → réponse HTTP (code stable + message français). */
function adminBotError(deps: ConfigApiDeps, error: unknown): ConfigHttpResponse {
  if (error instanceof AdminBotError) {
    deps.logger.info("bot.admin.refuse", { code: error.code, message: error.message });
    return json(error.status, { error: error.code, code: error.code, message: error.message });
  }
  throw error;
}

/**
 * `POST /api/bots` — CRÉE un bot (de zéro, ou par CLONE d'un bot existant).
 *
 * Corps : `{ nom, avatar?, cloneDe?, elements? }`.
 *
 * ⚠️ CRÉATION SIMPLE (décision utilisateur du 2026-11-10) : le corps ne porte que
 * le NOM (l'avatar est facultatif). Le SLUG est dérivé et dédupliqué par le
 * serveur, et les CAPACITÉS sont VIDES : un bot neuf ne peut que répondre tant
 * que l'utilisateur ne l'autorise pas dans l'onglet « Général » de `/bots`.
 *
 * ⚠️ `409 max_bots` au-delà de `MAX_BOTS` bots. ⚠️ La création exige
 * `X-Yuki-Config: 1` et la même origine (`requireWriteGuards`), comme toute
 * écriture de configuration.
 */
function handleBotsCreate(input: ConfigRequestInput): ConfigHttpResponse {
  const guard = guardWrite(input);
  if (guard) return guard;
  const deps = input.deps;
  const registre = deps.bots?.registre ?? null;
  if (!registre) {
    return json(409, {
      error: "registre_absent",
      code: "registre_absent",
      message:
        "L'instance n'est pas en mode multi-bot (aucun `state/bots.json`) : " +
        "la création d'un bot est impossible tant que le registre n'existe pas.",
    });
  }
  const stateDir = deps.bots?.stateDir;
  if (!stateDir) {
    return json(503, {
      error: "bots_admin_indisponible",
      code: "bots_admin_indisponible",
      message: "Administration des bots indisponible : volume `state` inconnu.",
    });
  }
  const corps = lireCorpsObjet(input.body);
  if (!corps.ok) return corps.response;
  try {
    const resultat = creerBot({
      stateDir,
      registre,
      nom: corps.value["nom"],
      cloneDe: corps.value["cloneDe"],
      avatar: corps.value["avatar"],
      ...(corps.value["elements"] !== undefined
        ? { elements: corps.value["elements"] as Record<string, unknown> }
        : {}),
    });
    // ⚠️ Le registre EN MÉMOIRE suit l'écriture : sans cela, `GET /api/bots`
    // continuerait d'ignorer le bot qu'on vient de créer.
    if (deps.bots) deps.bots.registre = resultat.registre;
    deps.logger.info("bot.cree", {
      bot: resultat.bot.id,
      nom: resultat.bot.nom,
      capacites: resultat.bot.capacites.join(","),
      clone_de: corps.value["cloneDe"] ?? null,
      elements: resultat.copies.join(","),
      flow: configWriteFlow(input.headers),
    });
    return json(201, { bot: listingDe(resultat.bot), bots: botsConnus(deps) });
  } catch (error) {
    return adminBotError(deps, error);
  }
}

/**
 * `PATCH /api/bots/<id>` — MODIFIE le NOM et/ou les CAPACITÉS d'un bot.
 *
 * Corps : `{ nom?, capacites? }`. Un champ ABSENT reste inchangé (c'est un
 * patch, pas un remplacement).
 *
 * ⚠️ Le SLUG n'est jamais modifiable : il nomme un dossier et des chemins.
 * ⚠️ Une capacité INCONNUE est refusée (`400 capacite_inconnue`) — jamais ignorée.
 * ⚠️ Le changement de capacités ne prend effet qu'au REDÉMARRAGE du gateway : le
 * processus en cours a lu les capacités du bot actif à son démarrage. La réponse
 * le dit (`rechargementRequis`) plutôt que de laisser croire à une application
 * immédiate.
 */
function handleBotPatch(input: ConfigRequestInput, botId: string): ConfigHttpResponse {
  const guard = guardWrite(input);
  if (guard) return guard;
  const deps = input.deps;
  const registre = deps.bots?.registre ?? null;
  if (!registre) {
    return json(409, {
      error: "registre_absent",
      code: "registre_absent",
      message:
        "L'instance n'est pas en mode multi-bot (aucun `state/bots.json`) : " +
        "les capacités d'un bot ne peuvent pas être enregistrées.",
    });
  }
  const stateDir = deps.bots?.stateDir;
  if (!stateDir) {
    return json(503, {
      error: "bots_admin_indisponible",
      code: "bots_admin_indisponible",
      message: "Administration des bots indisponible : volume `state` inconnu.",
    });
  }
  const corps = lireCorpsObjet(input.body);
  if (!corps.ok) return corps.response;
  try {
    const resultat = modifierBot({
      stateDir,
      registre,
      botId,
      ...(corps.value["nom"] !== undefined ? { nom: corps.value["nom"] } : {}),
      ...(corps.value["capacites"] !== undefined
        ? { capacites: corps.value["capacites"] }
        : {}),
    });
    if (deps.bots) deps.bots.registre = resultat.registre;
    const actif = registre.bots.find((bot) => bot.actif === true)?.id ?? null;
    const concerneBotActif = actif === null || actif === resultat.bot.id;
    deps.logger.info("bot.modifie", {
      bot: resultat.bot.id,
      nom: resultat.bot.nom,
      capacites: resultat.bot.capacites.join(","),
      bot_actif: concerneBotActif,
      flow: configWriteFlow(input.headers),
    });
    return json(200, {
      bot: listingDe(resultat.bot),
      bots: botsConnus(deps),
      // ⚠️ Le gateway en cours a lu les capacités du bot actif à son démarrage :
      // les changer pour CE bot exige un redémarrage pour être réellement actif.
      rechargementRequis: concerneBotActif,
    });
  } catch (error) {
    return adminBotError(deps, error);
  }
}

/**
 * `DELETE /api/bots/<id>` — SUPPRIME un bot (⚠️ **n'efface rien** : son dossier
 * est DÉPLACÉ dans `bots-supprimes/<slug>-<date>/`, même volume).
 *
 * ⚠️ Refus `409 last_bot` sur le dernier bot. ⚠️ Si le bot supprimé était le bot
 * ACTIF, le premier bot restant est promu et `rechargementRequis` est vrai : le
 * gateway en cours applique encore ses chemins. Les données restent 90 jours
 * (`bot.archive.purged` à l'échéance, par le balayeur existant).
 *
 * ⚠️ LOT 35i : les SESSIONS Pi du bot (`<pi>/agent/sessions/<id>`, AUTRE volume)
 * sont COPIÉES dans `<archive>/sessions-pi/` puis retirées de leur volume. Un
 * échec de copie ne supprime rien : `sessionsPi.etat = "echec"`, l'origine est
 * intacte, l'événement est journalisé (`bot.supprime.sessions_conservees`) et
 * l'interface le DIT — jamais une conversation perdue en silence.
 */
function handleBotsDelete(
  input: ConfigRequestInput,
  botId: string,
): ConfigHttpResponse {
  const guard = guardWrite(input);
  if (guard) return guard;
  const deps = input.deps;
  const registre = deps.bots?.registre ?? null;
  if (!registre) {
    return json(409, {
      error: "registre_absent",
      code: "registre_absent",
      message:
        "L'instance n'est pas en mode multi-bot (aucun `state/bots.json`) : " +
        "aucun bot ne peut être supprimé.",
    });
  }
  const stateDir = deps.bots?.stateDir;
  if (!stateDir) {
    return json(503, {
      error: "bots_admin_indisponible",
      code: "bots_admin_indisponible",
      message: "Administration des bots indisponible : volume `state` inconnu.",
    });
  }
  try {
    const resultat = supprimerBot({
      stateDir,
      registre,
      botId,
      logger: deps.logger,
      ...(deps.bots?.piSessionsDir ? { piSessionsDir: deps.bots.piSessionsDir } : {}),
      ...(deps.bots?.retirerDesListesDAgents
        ? { retirerDesListesDAgents: deps.bots.retirerDesListesDAgents }
        : {}),
    });
    if (deps.bots) deps.bots.registre = resultat.registre;
    deps.logger.info("bot.supprime", {
      bot: resultat.bot.id,
      archive: resultat.archive,
      bot_actif_suivant: resultat.botActifSuivant,
      retention_jours: RETENTION_ARCHIVES_JOURS,
      sessions_pi: resultat.sessionsPi.etat,
      flow: configWriteFlow(input.headers),
    });
    if (resultat.sessionsPi.etat === "echec") {
      // ⚠️ Une conversation qui n'a pas pu être archivée ne se tait pas :
      // l'utilisateur doit SAVOIR qu'elle survit sur le volume `pi`.
      deps.logger.warn("bot.supprime.sessions_conservees", {
        bot: resultat.bot.id,
        origine: resultat.sessionsPi.origine,
        erreur: resultat.sessionsPi.erreur,
      });
    }
    if (resultat.rechargementRequis) {
      // ⚠️ Le processus en cours applique ENCORE les chemins du bot supprimé :
      // c'est dit au journal (et renvoyé à l'UI), jamais passé sous silence.
      deps.logger.warn("bot.supprime.redemarrage_requis", {
        bot: resultat.bot.id,
        bot_actif_suivant: resultat.botActifSuivant,
      });
    }
    return json(200, {
      bots: botsConnus(deps),
      archive: resultat.archive,
      botActifSuivant: resultat.botActifSuivant,
      rechargementRequis: resultat.rechargementRequis,
      retentionJours: RETENTION_ARCHIVES_JOURS,
      // ⚠️ SESSIONS Pi (lot 35i) : l'interface DIT ce qu'il est advenu des
      // conversations. `echec` ⇒ elles sont restées sur le volume `pi`.
      sessionsPi: resultat.sessionsPi,
    });
  } catch (error) {
    return adminBotError(deps, error);
  }
}

/**
 * `PATCH /api/bots/<id>/actif` — ALLUME ou ÉTEINT un bot (lot 36, L2).
 *
 * Corps : `{ actif: true | false }` — « `actif` = ce bot DOIT tourner ».
 *
 * ⚠️ UN SEUL REFUS, rendu tel quel (`code` stable + message français) :
 * `409 dernier_bot_actif` (éteindre le dernier rendrait le démarrage suivant
 * impossible). ALLUMER n'est plus jamais refusé : le plafond `bots.maxActifs` et
 * son `409 plafond_actifs` ont été SUPPRIMÉS (décision utilisateur du
 * 2026-11-13 : « limiter c'est mal à mon sens »). Un autre cas n'est PAS une
 * erreur : `inchange`.
 *
 * ⚠️ L'effet est au REDÉMARRAGE du gateway (`redemarrageRequis`) : le processus en
 * cours a résolu ses bots à son démarrage. La réponse le DIT au lieu de laisser
 * croire à une application immédiate.
 */
async function handleBotActif(
  input: ConfigRequestInput,
  botId: string,
): Promise<ConfigHttpResponse> {
  const guard = guardWrite(input);
  if (guard) return guard;
  const deps = input.deps;
  const registre = deps.bots?.registre ?? null;
  if (!registre) {
    return json(409, {
      error: "registre_absent",
      code: "registre_absent",
      message:
        "L'instance n'est pas en mode multi-bot (aucun `state/bots.json`) : " +
        "l'état d'un bot ne peut pas être changé.",
    });
  }
  const stateDir = deps.bots?.stateDir;
  if (!stateDir) {
    return json(503, {
      error: "bots_admin_indisponible",
      code: "bots_admin_indisponible",
      message: "Administration des bots indisponible : volume `state` inconnu.",
    });
  }
  const corps = lireCorpsObjet(input.body);
  if (!corps.ok) return corps.response;
  try {
    const resultat = definirActif({
      stateDir,
      registre,
      botId,
      actif: corps.value["actif"],
    });
    // ⚠️ Le registre EN MÉMOIRE suit l'écriture : `GET /api/bots` et la
    // résolution des déclencheurs lisent CET objet, pas le fichier.
    if (deps.bots && !resultat.inchange) deps.bots.registre = resultat.registre;
    deps.logger.info("bot.actif", {
      bot: resultat.bot.id,
      actif: resultat.actif,
      inchange: resultat.inchange,
      actifs: resultat.actifs.join(","),
      flow: configWriteFlow(input.headers),
    });
    /**
     * ⚠️ LOT 36 (L8) — L'EFFET EST IMMÉDIAT QUAND L'INSTANCE SAIT LE FAIRE.
     * Sans port d'exécution, on retombe sur le comportement de L2 : le drapeau
     * est écrit, l'effet est au redémarrage (`redemarrageRequis`).
     */
    const port = deps.bots?.execution;
    const applique =
      port === undefined || resultat.inchange
        ? undefined
        : resultat.actif
          ? await port.demarrer(botId)
          : await port.arreter(botId);
    const demarrageRequis =
      port === undefined ? !resultat.inchange : applique !== undefined && !applique.ok;
    return json(200, {
      bot: listingDe(resultat.bot),
      bots: botsConnus(deps),
      actif: resultat.actif,
      inchange: resultat.inchange,
      actifs: resultat.actifs,
      // ⚠️ `true` seulement si l'effet n'est PAS appliqué (instance sans port
      // d'exécution, ou démarrage/arrêt en échec) : le message le dit.
      redemarrageRequis: demarrageRequis,
      ...(port !== undefined ? { execution: port.etat(botId) } : {}),
      ...(applique !== undefined
        ? {
            applique: {
              ok: applique.ok,
              inchange: applique.inchange,
              ...(applique.raison !== undefined ? { raison: applique.raison } : {}),
            },
          }
        : {}),
    });
  } catch (error) {
    return adminBotError(deps, error);
  }
}

/**
 * `GET /api/bots/<id>/donnees` — COMPTEURS RÉELS du bot (conversations,
 * souvenirs, déclencheurs, taille du dossier) : ce que montre la confirmation
 * de suppression. Aucun contenu n'est renvoyé, seulement des nombres.
 */
function handleBotDonnees(deps: ConfigApiDeps, botId: string): ConfigHttpResponse {
  const stateDir = deps.bots?.stateDir;
  if (!stateDir) {
    return json(503, {
      error: "bots_admin_indisponible",
      code: "bots_admin_indisponible",
      message: "Compteurs indisponibles : volume `state` inconnu.",
    });
  }
  const piSessionsDir = deps.bots?.piSessionsDir;
  return json(200, {
    bot: { id: botId },
    compteurs: {
      ...compterDonneesBot(stateDir, botId),
      // ⚠️ `null` quand le volume `pi` est inconnu : un 0 laisserait croire
      // qu'il n'y a aucune conversation, alors qu'on ne sait pas les compter.
      sessions: piSessionsDir ? compterSessionsPi(piSessionsDir, botId) : null,
    },
    retentionJours: RETENTION_ARCHIVES_JOURS,
  });
}

/** Vue d'un bot pour les réponses d'administration (même forme que la liste). */
function listingDe(bot: BotRecord): BotListing {
  return {
    id: bot.id,
    nom: bot.nom,
    capacites: [...bot.capacites],
    actif: bot.actif,
    ordre: bot.ordre,
  };
}

/** Chemin `/api/bots/<id>[/donnees|/actif]` → identifiant + suffixe, ou `null`. */
function botRacineOfPath(
  path: string,
): { botId: string; suffixe: "" | "donnees" | "actif" } | null {
  const match = /^\/api\/bots\/([^/]+)(\/(donnees|actif))?$/.exec(path);
  if (!match) return null;
  let botId: string;
  try {
    botId = decodeURIComponent(match[1] as string);
  } catch {
    return null;
  }
  const suffixe = match[3];
  return {
    botId,
    suffixe: suffixe === "donnees" ? "donnees" : suffixe === "actif" ? "actif" : "",
  };
}

// ── Mot de passe d'INSTANCE (déverrouillage des agents sensibles) ───────────

/**
 * `GET /api/config/password` — état du mot de passe d'instance.
 *
 * ⚠️ Ne renvoie JAMAIS un mot de passe ni son haché : seulement « défini ou
 * pas », la date du dernier changement, la longueur minimale et le délai
 * d'inactivité appliqué aux agents sensibles.
 */
function handlePasswordGet(deps: ConfigApiDeps): ConfigHttpResponse {
  if (!deps.password) {
    return json(503, {
      error: "password_unavailable",
      code: "password_unavailable",
      message: "Mot de passe d'instance indisponible sur cette instance.",
    });
  }
  const view = deps.password.view();
  return json(200, {
    ...view,
    minLength: INSTANCE_PASSWORD_MIN_LENGTH,
    maxLength: INSTANCE_PASSWORD_MAX_LENGTH,
    idleTimeoutMs: SENSITIVE_IDLE_TIMEOUT_MS,
    sensitiveAgents: deps.sensitiveAgentCount ? deps.sensitiveAgentCount() : 0,
  });
}

/**
 * `POST /api/config/password` — définit (ou CHANGE) le mot de passe d'instance.
 *
 * Le corps porte `{ password, currentPassword? }`. ⚠️ Un CHANGEMENT exige
 * l'ANCIEN mot de passe : sans cela, une page `/config` ouverte suffirait à
 * remplacer le mot de passe et à rouvrir tous les agents sensibles sans le
 * connaître. Aucune des deux valeurs n'est journalisée, auditée ni renvoyée.
 */
function handlePasswordSet(input: ConfigRequestInput): ConfigHttpResponse {
  const guard = guardWrite(input);
  if (guard) return guard;
  const store = input.deps.password;
  if (!store) {
    return json(503, {
      error: "password_unavailable",
      code: "password_unavailable",
      message: "Mot de passe d'instance indisponible sur cette instance.",
    });
  }
  let body: Record<string, unknown>;
  try {
    const parsed = input.body.trim() === "" ? {} : JSON.parse(input.body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("objet attendu");
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return json(400, {
      error: "invalid_json",
      code: "invalid_json",
      message: "Corps JSON invalide (objet attendu).",
    });
  }
  const password = body["password"];
  const currentPassword = body["currentPassword"];
  if (typeof password !== "string" || password.length === 0) {
    return json(400, {
      error: "password_missing",
      code: "password_missing",
      message: "Mot de passe d'instance requis.",
    });
  }
  if (typeof currentPassword === "string" && currentPassword.length > 0) {
    // Défensif : les deux valeurs reçues rejoignent la liste des valeurs à
    // masquer (logs + audit). Rien n'est écrit.
    input.deps.onSecretSeen?.(currentPassword);
  }
  input.deps.onSecretSeen?.(password);
  try {
    const view = store.set(
      password,
      typeof currentPassword === "string" ? { currentPassword } : {},
    );
    input.deps.logger.info("config.instance_password.set", {
      at: new Date((input.deps.now ?? Date.now)()).toISOString(),
      flow: configWriteFlow(input.headers),
    });
    return json(200, { ...view, minLength: INSTANCE_PASSWORD_MIN_LENGTH });
  } catch (error) {
    if (error instanceof InstancePasswordError) {
      const status = error.code === "password_mismatch" ? 403 : 400;
      return json(status, { error: error.code, code: error.code, message: error.message });
    }
    throw error;
  }
}

/**
 * `DELETE /api/config/password` — retire le mot de passe d'instance.
 *
 * ⚠️ REFUS tant qu'un agent « matériel sensible » existe : ces agents seraient
 * alors VERROUILLÉS POUR TOUJOURS (personne ne pourrait plus les déverrouiller).
 */
function handlePasswordClear(input: ConfigRequestInput): ConfigHttpResponse {
  const guard = guardWrite(input);
  if (guard) return guard;
  const store = input.deps.password;
  if (!store) {
    return json(503, {
      error: "password_unavailable",
      code: "password_unavailable",
      message: "Mot de passe d'instance indisponible sur cette instance.",
    });
  }
  const sensitive = input.deps.sensitiveAgentCount ? input.deps.sensitiveAgentCount() : 0;
  if (sensitive > 0) {
    return json(409, {
      error: "sensitive_agents_present",
      code: "sensitive_agents_present",
      message:
        `${sensitive} agent(s) sont déclarés « matériel sensible » : le mot de passe ` +
        "d'instance ne peut pas être retiré tant qu'il en existe un (ils deviendraient " +
        "impossible à déverrouiller). Décochez d'abord « matériel sensible » sur ces agents.",
    });
  }
  try {
    const cleared = store.clear();
    input.deps.logger.info("config.instance_password.cleared", {
      at: new Date((input.deps.now ?? Date.now)()).toISOString(),
      flow: configWriteFlow(input.headers),
      cleared,
    });
    return json(200, { configured: false, cleared });
  } catch (error) {
    if (error instanceof InstancePasswordError) {
      return json(500, { error: error.code, code: error.code, message: error.message });
    }
    throw error;
  }
}

/** Traite une requête de configuration et renvoie la réponse HTTP. */
export async function handleConfigRequest(
  input: ConfigRequestInput,
): Promise<ConfigHttpResponse> {
  const { method, path } = input;
  if (path === "/api/config") {
    if (method === "GET" || method === "HEAD") return handleGet(input.deps);
    if (method === "PUT") return handlePut(input);
    return json(405, { error: "method_not_allowed", method });
  }
  if (path === "/api/config/llm/test") {
    if (method === "POST") return handleLlmTest(input);
    return json(405, { error: "method_not_allowed", method });
  }
  if (path === "/api/config/librarian/test") {
    if (method === "POST") return handleLibrarianTest(input);
    return json(405, { error: "method_not_allowed", method });
  }
  if (path === "/api/config/password") {
    if (method === "GET" || method === "HEAD") return handlePasswordGet(input.deps);
    if (method === "POST") return handlePasswordSet(input);
    if (method === "DELETE") return handlePasswordClear(input);
    return json(405, { error: "method_not_allowed", method });
  }

  // ── BOTS (lot 35b, sous-lot 1b-3) ────────────────────────────────────────
  if (path === "/api/bots") {
    if (method === "GET" || method === "HEAD") return handleBotsList(input.deps);
    // ⚠️ CRÉATION (lot 35e) : dossier + entrée du registre (+ clone éventuel).
    if (method === "POST") return handleBotsCreate(input);
    return json(405, { error: "method_not_allowed", method });
  }
  // ⚠️ LOT 37 — ON/OFF DE LA BOUCLE ENTRE DEUX BOTS. Traité AVANT le routage
  // par bot : sinon `echanges` serait pris pour un IDENTIFIANT de bot (404).
  if (path === "/api/bots/echanges") {
    if (method === "PATCH" || method === "POST") return handleBotEchange(input);
    return json(405, { error: "method_not_allowed", method });
  }
  const racine = botRacineOfPath(path);
  if (racine !== null) {
    if (!botDemande(input.deps, racine.botId)) return botInconnu(racine.botId);
    if (racine.suffixe === "donnees") {
      if (method === "GET" || method === "HEAD") {
        return handleBotDonnees(input.deps, racine.botId);
      }
      return json(405, { error: "method_not_allowed", method });
    }
    // ⚠️ ON/OFF d'un bot (lot 36, L2) : `actif` = « doit tourner ».
    if (racine.suffixe === "actif") {
      if (method === "PATCH" || method === "POST") {
        return handleBotActif(input, racine.botId);
      }
      return json(405, { error: "method_not_allowed", method });
    }
    // ⚠️ MODIFICATION du nom et/ou des capacités (PATCH = champs absents intacts).
    if (method === "PATCH") return handleBotPatch(input, racine.botId);
    // ⚠️ SUPPRESSION : n'efface rien, DÉPLACE le dossier dans `bots-supprimes/`.
    if (method === "DELETE") return handleBotsDelete(input, racine.botId);
    return json(405, { error: "method_not_allowed", method });
  }
  const botId = botIdOfPath(path);
  if (botId !== null) {
    // ⚠️ Bot INCONNU ⇒ 404 qui NOMME l'identifiant (jamais une écriture dans un
    // dossier inventé, jamais un 404 muet).
    if (!botDemande(input.deps, botId)) return botInconnu(botId);
    if (method === "GET" || method === "HEAD") return handleBotGet(input.deps, botId);
    if (method === "PUT") return handleBotPut(input, botId);
    return json(405, { error: "method_not_allowed", method });
  }
  if (path.startsWith("/api/bots/")) {
    return json(404, { error: "not_found", path });
  }
  return json(404, { error: "not_found", path });
}
