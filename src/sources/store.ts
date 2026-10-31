/**
 * `SourcesStore` — registre des SOURCES (programmes autorisés à réveiller Yuki).
 *
 * ⚠️ Fichier JSON DÉDIÉ sur le volume `state` (`sources.json`), JAMAIS dans
 * `config.json` : `PUT /api/config` n'accepte qu'un patch PLAT de scalaires
 * (`src/config/schema.ts:660`), une liste de sources n'y a donc pas sa place.
 *
 * Écriture ATOMIQUE (`tmp` + `rename`) en mode 0600. ⚠️ Le JETON d'une source
 * n'est JAMAIS ici : il vit dans le COFFRE (`YUKI_SOURCE_<NOM>`) ; ce fichier ne
 * retient que la DATE de création (`jetonCree`).
 *
 * Aucun import SDK/typebox.
 */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import {
  isSourceDestination,
  isSourceSessionTarget,
  MAX_CONSIGNE_CHARS,
  MAX_SOURCES,
  RESERVED_SOURCE_NAMES,
  SOURCE_NAME_PATTERN,
  type SourceConversation,
  type SourceRecord,
  type SourceSettingsInput,
  type SourceTurn,
  type SourceView,
} from "./types.js";

export const SOURCES_STORE_SCHEMA_VERSION = 1;

interface SourcesStoreFile {
  schemaVersion: number;
  sources: SourceRecord[];
}

/** Journal minimal (le logger d'observabilité le satisfait). */
export interface SourcesStoreLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
}

/** Erreur de VALIDATION d'une source (nom, réglages) — message en français. */
export class SourceValidationError extends Error {
  override readonly name = "SourceValidationError";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Registre PLEIN : refus explicite (jamais un écrasement silencieux). */
export class SourcesFullError extends Error {
  override readonly name = "SourcesFullError";
  constructor(readonly limit: number) {
    super(
      `Le nombre maximal de sources est atteint (${limit}). Supprimez une source ` +
        "avant d'en ajouter une nouvelle.",
    );
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Un nom de source est-il acceptable (forme + non réservé) ? */
export function validateSourceName(value: unknown): string {
  const nom = typeof value === "string" ? value.trim() : "";
  if (!SOURCE_NAME_PATTERN.test(nom)) {
    throw new SourceValidationError(
      "invalid_source_name",
      "Nom de source invalide : 1 à 32 caractères parmi « a-z », « 0-9 », « _ » et « - ».",
    );
  }
  if (RESERVED_SOURCE_NAMES.includes(nom)) {
    throw new SourceValidationError(
      "reserved_source_name",
      `Le nom « ${nom} » est réservé par l'API (boîte de notifications). Choisissez-en un autre.`,
    );
  }
  return nom;
}

function isTurn(value: unknown): value is SourceTurn {
  return value === "lancer" || value === "stocker";
}

/**
 * Valide une DESTINATION. Trois modes acceptés, ou l'identifiant d'une conversation
 * existante (choisi par l'utilisateur dans `/config` : jamais un texte libre).
 *
 * ⚠️ Un champ PRÉSENT mais invalide est REFUSÉ (jamais un repli silencieux : la
 * source enverrait ailleurs que ce que l'utilisateur a demandé).
 */
export function validateConversation(value: unknown): SourceConversation {
  if (isSourceDestination(value)) return value;
  if (isSourceSessionTarget(value)) return value;
  throw new SourceValidationError(
    "invalid_conversation",
    'Destination invalide : "source", "nouvelle", "courante" ou l\'identifiant d\'une ' +
      "conversation existante attendu.",
  );
}

/**
 * Destination relue depuis le fichier : une valeur inconnue retombe sur `aucune`
 * (⚠️ jamais `courante` : une destination non configurée ne doit pas se mettre à
 * écrire dans la conversation ouverte par surprise).
 */
function storedConversation(value: unknown): SourceConversation {
  return isSourceDestination(value) || isSourceSessionTarget(value) ? value : "aucune";
}

/** Valide une consigne libre (texte borné, jamais un secret). */
function validateConsigne(value: unknown): string {
  if (typeof value !== "string") {
    throw new SourceValidationError("invalid_consigne", "La consigne doit être un texte.");
  }
  const consigne = value.replace(/\r\n?/g, "\n").trim();
  if (consigne.length > MAX_CONSIGNE_CHARS) {
    throw new SourceValidationError(
      "consigne_too_long",
      `Consigne trop longue : ${consigne.length} caractères, maximum ${MAX_CONSIGNE_CHARS}.`,
    );
  }
  return consigne;
}

export interface SourcesStoreOptions {
  /** Chemin du fichier (`/data/state/sources.json`). */
  path: string;
  logger?: SourcesStoreLogger;
  now?: () => number;
}

/**
 * Registre des sources. Chargé une fois à la construction ; chaque mutation
 * réécrit le fichier immédiatement (les écritures sont rares : créer une source,
 * changer ses réglages, enregistrer un appel).
 */
export class SourcesStore {
  readonly path: string;
  private readonly logger?: SourcesStoreLogger;
  private readonly now: () => number;
  private records: SourceRecord[] = [];

  constructor(options: SourcesStoreOptions) {
    this.path = options.path;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.records = this.load();
  }

  /** Nombre de sources déclarées. */
  get size(): number {
    return this.records.length;
  }

  private load(): SourceRecord[] {
    if (!existsSync(this.path)) return [];
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      this.logger?.warn("sources.store.unreadable", { path: this.path, error: messageOf(error) });
      return [];
    }
    try {
      const parsed = JSON.parse(text) as Partial<SourcesStoreFile>;
      if (parsed.schemaVersion !== SOURCES_STORE_SCHEMA_VERSION || !Array.isArray(parsed.sources)) {
        this.logger?.warn("sources.store.invalid", { path: this.path, reason: "schéma inattendu" });
        return [];
      }
      return parsed.sources
        .filter(
          (entry): entry is SourceRecord =>
            Boolean(entry && typeof entry.nom === "string" && typeof entry.cree === "string"),
        )
        .map((entry) => ({
          ...entry,
          consigne: typeof entry.consigne === "string" ? entry.consigne : "",
          conversation: storedConversation(entry.conversation),
          tour: isTurn(entry.tour) ? entry.tour : "stocker",
          notifier: entry.notifier !== false,
        }));
    } catch (error) {
      this.logger?.warn("sources.store.invalid", { path: this.path, error: messageOf(error) });
      return [];
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    const file: SourcesStoreFile = {
      schemaVersion: SOURCES_STORE_SCHEMA_VERSION,
      sources: this.records,
    };
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // Meilleur effort.
    }
    renameSync(tmp, this.path);
    try {
      chmodSync(this.path, 0o600);
    } catch {
      // Meilleur effort.
    }
  }

  /** Enregistrements (copie défensive). */
  list(): SourceRecord[] {
    return this.records.map((record) => ({ ...record }));
  }

  /** Une source, ou `undefined`. */
  get(nom: string): SourceRecord | undefined {
    const found = this.records.find((record) => record.nom === nom);
    return found ? { ...found } : undefined;
  }

  has(nom: string): boolean {
    return this.records.some((record) => record.nom === nom);
  }

  /**
   * Crée une source. ⚠️ REFUS explicite au-delà de `MAX_SOURCES` (`SourcesFullError`)
   * et sur un nom déjà utilisé (`SourceValidationError`).
   */
  create(nom: string, settings: SourceSettingsInput = {}): SourceRecord {
    const name = validateSourceName(nom);
    if (this.has(name)) {
      throw new SourceValidationError(
        "source_exists",
        `Une source « ${name} » existe déjà. Modifiez-la plutôt que de la recréer.`,
      );
    }
    if (this.records.length >= MAX_SOURCES) throw new SourcesFullError(MAX_SOURCES);
    const at = new Date(this.now()).toISOString();
    const record: SourceRecord = {
      nom: name,
      consigne: settings.consigne !== undefined ? validateConsigne(settings.consigne) : "",
      conversation:
        settings.conversation !== undefined ? validateConversation(settings.conversation) : "aucune",
      tour: isTurn(settings.tour) ? settings.tour : "stocker",
      notifier: settings.notifier !== false,
      cree: at,
      maj: at,
    };
    this.records.push(record);
    this.persist();
    return { ...record };
  }

  /**
   * Modifie les réglages d'une source. ⚠️ Un champ absent n'est PAS modifié ;
   * un champ présent mais invalide est REFUSÉ (jamais un no-op silencieux).
   *
   * Changer `conversation` EFFACE le fil dédié mémorisé (`sessionId`) : la nouvelle
   * destination ne doit jamais hériter de l'ancienne (sinon la source posterait
   * dans un fil que l'utilisateur vient de quitter).
   */
  update(nom: string, settings: SourceSettingsInput): SourceRecord {
    const index = this.records.findIndex((record) => record.nom === nom);
    if (index < 0) {
      throw new SourceValidationError("unknown_source", `Source inconnue : « ${nom} ».`);
    }
    const record = this.records[index];
    // Validation AVANT toute écriture : un champ invalide ne doit jamais
    // laisser la source à moitié modifiée (aucun no-op silencieux).
    const conversation =
      settings.conversation !== undefined ? validateConversation(settings.conversation) : undefined;
    if (settings.tour !== undefined && !isTurn(settings.tour)) {
      throw new SourceValidationError(
        "invalid_tour",
        'Tour invalide : "lancer" ou "stocker" attendu.',
      );
    }
    const changedTarget = conversation !== undefined && conversation !== record.conversation;
    const next: SourceRecord = {
      ...record,
      ...(settings.consigne !== undefined ? { consigne: validateConsigne(settings.consigne) } : {}),
      ...(conversation !== undefined ? { conversation } : {}),
      ...(settings.tour !== undefined ? { tour: settings.tour } : {}),
      ...(settings.notifier !== undefined ? { notifier: settings.notifier === true } : {}),
      maj: new Date(this.now()).toISOString(),
    };
    if (changedTarget) delete next.sessionId;
    this.records[index] = next;
    this.persist();
    return { ...next };
  }

  /** Supprime une source. Renvoie `true` si elle existait. */
  remove(nom: string): boolean {
    const before = this.records.length;
    this.records = this.records.filter((record) => record.nom !== nom);
    if (this.records.length === before) return false;
    this.persist();
    return true;
  }

  /** Note l'instant du dernier appel reçu (diagnostic, aucun contenu). */
  markCall(nom: string): void {
    const record = this.records.find((entry) => entry.nom === nom);
    if (!record) return;
    record.dernierAppel = new Date(this.now()).toISOString();
    this.persist();
  }

  /** Note la date de création d'un jeton (⚠️ jamais le jeton lui-même). */
  markTokenCreated(nom: string): SourceRecord | undefined {
    const record = this.records.find((entry) => entry.nom === nom);
    if (!record) return undefined;
    const at = new Date(this.now()).toISOString();
    record.jetonCree = at;
    record.maj = at;
    this.persist();
    return { ...record };
  }

  /**
   * Mémorise (ou oublie) la conversation DÉDIÉE de la source.
   * ⚠️ Aucun fil n'est « caché » : celui qu'on mémorise ici est un fil NORMAL,
   * visible dans la liste des conversations.
   */
  setSession(nom: string, sessionId: string | undefined): SourceRecord | undefined {
    const record = this.records.find((entry) => entry.nom === nom);
    if (!record) return undefined;
    if (sessionId === undefined) delete record.sessionId;
    else record.sessionId = sessionId;
    record.maj = new Date(this.now()).toISOString();
    this.persist();
    return { ...record };
  }

  /**
   * Sources dont la destination EFFECTIVE est cette conversation : le fil dédié
   * mémorisé (mode `source`), ou la conversation désignée dans `conversation`.
   */
  forSession(sessionId: string): SourceRecord[] {
    if (sessionId === "") return [];
    return this.records
      .filter(
        (record) =>
          (!isSourceDestination(record.conversation) && record.conversation === sessionId) ||
          (record.conversation === "source" && record.sessionId === sessionId),
      )
      .map((record) => ({ ...record }));
  }

  /**
   * ⚠️ Le fil vient d'être SUPPRIMÉ : les sources qui y postaient ne sont jamais
   * supprimées ni laissées à pointer dans le vide — elles passent en « nouvelle
   * conversation à chaque fois » et leur fil mémorisé est oublié.
   */
  detachSession(sessionId: string): SourceRecord[] {
    const affected = this.forSession(sessionId);
    if (affected.length === 0) return [];
    const at = new Date(this.now()).toISOString();
    for (const record of this.records) {
      const isTarget =
        (!isSourceDestination(record.conversation) && record.conversation === sessionId) ||
        (record.conversation === "source" && record.sessionId === sessionId);
      if (!isTarget) continue;
      record.conversation = "nouvelle";
      delete record.sessionId;
      record.maj = at;
    }
    this.persist();
    return affected.map((record) => this.get(record.nom)).filter((r): r is SourceRecord => r !== undefined);
  }

  /** Vue publique (aucun jeton : `jetonDefini` vient du COFFRE, jamais d'ici). */
  view(record: SourceRecord, jetonDefini: boolean): SourceView {
    return { ...record, jetonDefini };
  }
}
