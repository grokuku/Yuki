/**
 * `SourcesInbox` — BOÎTE « Notifications » des messages de sources.
 *
 * ⚠️ DÉCISION UTILISATEUR : les messages de sources ne sont PAS des bulles dans
 * un fil. Ils s'empilent ici, avec leur ÉTAT (`recu` / `traite` / `echec`), et la
 * RÉPONSE de Yuki est attachée à la MÊME entrée. Aucun fil n'est créé tant que
 * l'utilisateur ne clique pas « Continuer dans une conversation ».
 *
 * Fichier JSON DÉDIÉ sur le volume `state` (`sources-inbox.json`), écriture
 * ATOMIQUE (`tmp` + `rename`) en mode 0600.
 *
 * ⚠️ La boîte est BORNÉE (`MAX_INBOX_ENTRIES`) : au-delà, l'ajout est REFUSÉ avec
 * `InboxFullError` — jamais une perte muette (on n'écrase pas la plus ancienne
 * entrée dans le dos de l'utilisateur).
 *
 * Le même fichier porte la MÉMOIRE D'IDEMPOTENCE `(source, id)` (7 jours) : un
 * renvoi du même identifiant ne redéclenche AUCUN tour. Les identifiants sont
 * hachés (aucun contenu conservé au-delà de la fenêtre).
 *
 * Aucun import SDK/typebox.
 */

import { createHash, randomBytes } from "node:crypto";
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
  MAX_INBOX_ENTRIES,
  MAX_REPLY_CHARS,
  SOURCE_DEDUPE_TTL_MS,
  type InboxEntry,
  type InboxEntryState,
} from "./types.js";

export const SOURCES_INBOX_SCHEMA_VERSION = 1;

interface SeenKey {
  cle: string;
  at: string;
}

interface InboxFile {
  schemaVersion: number;
  entries: InboxEntry[];
  vus: SeenKey[];
}

/** Journal minimal. */
export interface InboxLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
}

/** Ajout REFUSÉ : la boîte est pleine (refus explicite, jamais de perte muette). */
export class InboxFullError extends Error {
  override readonly name = "InboxFullError";
  constructor(readonly limit: number) {
    super(
      `La boîte de notifications est pleine (${limit} entrées). Supprimez des ` +
        "entrées avant de continuer : aucun message n'a été perdu ni écrasé.",
    );
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Clé d'idempotence : hachée, bornée, sans contenu. */
export function dedupeKey(source: string, sourceId: string): string {
  return createHash("sha256").update(`${source}\u0000${sourceId}`).digest("hex").slice(0, 32);
}

/** Identifiant d'entrée STABLE attribué par Yuki. */
function newEntryId(now: number): string {
  return `src-${now.toString(36)}-${randomBytes(4).toString("hex")}`;
}

export interface SourcesInboxOptions {
  path: string;
  logger?: InboxLogger;
  now?: () => number;
  /** Borne d'entrées (défaut : `MAX_INBOX_ENTRIES`). */
  maxEntries?: number;
}

/** Entrée à ajouter (l'identifiant d'entrée est attribué ici). */
export interface InboxAddInput {
  source: string;
  texte: string;
  titre?: string;
  octets: number;
  recu?: string;
  enAttente: boolean;
  raison?: string;
  note?: string;
  sourceId?: string;
  /**
   * État initial. Défaut `recu`. `alerte` = AVIS DE YUKI (fil supprimé, source
   * rebasculée…) : jamais un message reçu, et jamais remis au modèle.
   */
  etat?: InboxEntryState;
}

export class SourcesInbox {
  readonly path: string;
  private readonly logger?: InboxLogger;
  private readonly now: () => number;
  private readonly maxEntries: number;
  private entries: InboxEntry[] = [];
  private seen: SeenKey[] = [];

  constructor(options: SourcesInboxOptions) {
    this.path = options.path;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.maxEntries = Math.max(1, Math.trunc(options.maxEntries ?? MAX_INBOX_ENTRIES));
    const loaded = this.load();
    this.entries = loaded.entries;
    this.seen = loaded.vus;
    this.pruneSeen();
  }

  /** Nombre d'entrées conservées. */
  get size(): number {
    return this.entries.length;
  }

  /** Borne appliquée (exposée pour l'interface : « x / 200 »). */
  get limit(): number {
    return this.maxEntries;
  }

  private load(): InboxFile {
    const empty: InboxFile = {
      schemaVersion: SOURCES_INBOX_SCHEMA_VERSION,
      entries: [],
      vus: [],
    };
    if (!existsSync(this.path)) return empty;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<InboxFile>;
      if (parsed.schemaVersion !== SOURCES_INBOX_SCHEMA_VERSION) {
        this.logger?.warn("sources.inbox.invalid", { path: this.path, reason: "schéma inattendu" });
        return empty;
      }
      const entries = Array.isArray(parsed.entries)
        ? parsed.entries.filter(
            (entry): entry is InboxEntry =>
              Boolean(entry && typeof entry.id === "string" && typeof entry.source === "string"),
          )
        : [];
      const vus = Array.isArray(parsed.vus)
        ? parsed.vus.filter(
            (entry): entry is SeenKey =>
              Boolean(entry && typeof entry.cle === "string" && typeof entry.at === "string"),
          )
        : [];
      return { schemaVersion: SOURCES_INBOX_SCHEMA_VERSION, entries, vus };
    } catch (error) {
      this.logger?.warn("sources.inbox.invalid", { path: this.path, error: messageOf(error) });
      return empty;
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    const file: InboxFile = {
      schemaVersion: SOURCES_INBOX_SCHEMA_VERSION,
      entries: this.entries,
      vus: this.seen,
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

  /** Entrées, de la plus RÉCENTE à la plus ancienne (copie défensive). */
  list(): InboxEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  /** Une entrée par son identifiant. */
  get(id: string): InboxEntry | undefined {
    const found = this.entries.find((entry) => entry.id === id);
    return found ? { ...found } : undefined;
  }

  /** Nombre d'entrées NON LUES (compteur de l'en-tête). */
  unreadCount(): number {
    return this.entries.filter((entry) => !entry.lu).length;
  }

  /**
   * Ajoute une entrée en TÊTE. ⚠️ REFUS explicite si la boîte est pleine
   * (`InboxFullError`) : aucune entrée existante n'est écrasée.
   */
  add(input: InboxAddInput): InboxEntry {
    if (this.entries.length >= this.maxEntries) throw new InboxFullError(this.maxEntries);
    const at = this.now();
    const entry: InboxEntry = {
      id: newEntryId(at),
      source: input.source,
      recu: input.recu ?? new Date(at).toISOString(),
      titre: (input.titre ?? "").trim(),
      texte: input.texte,
      octets: Math.max(0, Math.trunc(input.octets)),
      etat: input.etat ?? "recu",
      lu: false,
      enAttente: input.etat === "alerte" ? false : input.enAttente,
      ...(input.raison !== undefined ? { raison: input.raison } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.sourceId !== undefined ? { sourceId: input.sourceId } : {}),
    };
    this.entries = [entry, ...this.entries];
    this.persist();
    return { ...entry };
  }

  /** Marque une entrée LUE. Renvoie l'entrée mise à jour, ou `undefined`. */
  markRead(id: string): InboxEntry | undefined {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (!entry) return undefined;
    if (entry.lu) return { ...entry };
    entry.lu = true;
    this.persist();
    return { ...entry };
  }

  /** Marque TOUTES les entrées lues (compteur remis à zéro). Renvoie le nombre. */
  markAllRead(): number {
    let changed = 0;
    for (const entry of this.entries) {
      if (entry.lu) continue;
      entry.lu = true;
      changed += 1;
    }
    if (changed > 0) this.persist();
    return changed;
  }

  /**
   * Supprime une entrée. Renvoie l'entrée retirée, ou `undefined` si inconnue.
   * ⚠️ L'utilisateur peut retirer une entrée NON LUE : c'est un choix explicite
   * (bouton « Supprimer »), jamais une perte muette.
   */
  remove(id: string): InboxEntry | undefined {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (!entry) return undefined;
    this.entries = this.entries.filter((candidate) => candidate.id !== id);
    this.persist();
    return { ...entry };
  }

  /**
   * Entrées en attente de transmission au modèle (drain groupé), dans l'ordre
   * CHRONOLOGIQUE de réception (le plus ancien d'abord : on raconte l'histoire
   * dans l'ordre où elle est arrivée).
   */
  pending(): InboxEntry[] {
    // `entries` est rangé du plus récent au plus ancien : l'ordre CHRONOLOGIQUE
    // est donc son inverse. On trie malgré tout sur `recu` (une source peut
    // fournir un horodatage explicite), avec l'ordre de stockage en départage
    // pour rester DÉTERMINISTE quand deux entrées partagent le même instant.
    return this.entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.enAttente && entry.etat === "recu")
      .sort((a, b) => a.entry.recu.localeCompare(b.entry.recu) || b.index - a.index)
      .map(({ entry }) => ({ ...entry }));
  }

  /**
   * Met à jour une entrée (état, réponse, raison, attente, conversation ouverte).
   * Ne lève jamais sur un identifiant inconnu : renvoie `undefined`.
   */
  update(
    id: string,
    patch: {
      etat?: InboxEntryState;
      reponse?: string | undefined;
      raison?: string | undefined;
      note?: string | undefined;
      enAttente?: boolean;
      conversationOuverte?: boolean;
      lu?: boolean;
    },
  ): InboxEntry | undefined {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (!entry) return undefined;
    if (patch.etat !== undefined) entry.etat = patch.etat;
    if (patch.enAttente !== undefined) entry.enAttente = patch.enAttente;
    if (patch.lu !== undefined) entry.lu = patch.lu;
    if (patch.conversationOuverte !== undefined) {
      entry.conversationOuverte = patch.conversationOuverte;
    }
    if (patch.raison !== undefined) {
      if (patch.raison === "") delete entry.raison;
      else entry.raison = patch.raison;
    }
    if (patch.note !== undefined) {
      if (patch.note === "") delete entry.note;
      else entry.note = patch.note;
    }
    if (patch.reponse !== undefined) {
      const trimmed = patch.reponse.trim();
      if (trimmed === "") delete entry.reponse;
      else if (trimmed.length > MAX_REPLY_CHARS) {
        entry.reponse = `${trimmed.slice(0, MAX_REPLY_CHARS)}… [réponse tronquée : ${trimmed.length} caractères]`;
      } else entry.reponse = trimmed;
    }
    this.persist();
    return { ...entry };
  }

  /**
   * Marque un LOT d'entrées comme remises au modèle (drain groupé), en UNE
   * écriture. Renvoie le nombre d'entrées effectivement mises à jour.
   */
  markDelivered(ids: readonly string[]): number {
    const wanted = new Set(ids);
    let changed = 0;
    for (const entry of this.entries) {
      if (!wanted.has(entry.id) || !entry.enAttente) continue;
      entry.enAttente = false;
      changed += 1;
    }
    if (changed > 0) this.persist();
    return changed;
  }

  /** Le couple `(source, id)` a-t-il déjà été reçu dans la fenêtre d'idempotence ? */
  hasSeen(source: string, sourceId: string): boolean {
    const cle = dedupeKey(source, sourceId);
    return this.seen.some((entry) => entry.cle === cle);
  }

  /** Mémorise `(source, id)` (fenêtre de 7 jours). */
  markSeen(source: string, sourceId: string): void {
    const cle = dedupeKey(source, sourceId);
    this.seen = [
      { cle, at: new Date(this.now()).toISOString() },
      ...this.seen.filter((entry) => entry.cle !== cle),
    ];
    this.pruneSeen();
    this.persist();
  }

  /** Purge les clés d'idempotence plus vieilles que la fenêtre (7 jours). */
  private pruneSeen(): void {
    const limit = this.now() - SOURCE_DEDUPE_TTL_MS;
    this.seen = this.seen.filter((entry) => {
      const at = Date.parse(entry.at);
      return Number.isFinite(at) && at >= limit;
    });
  }
}
