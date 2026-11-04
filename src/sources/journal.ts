/**
 * `DeclencheurJournal` — JOURNAL des DÉCLENCHEURS silencieux.
 *
 * Pourquoi un journal alors qu'il y a déjà `sources-inbox.json` ? Parce qu'un
 * déclencheur silencieux n'écrit RIEN dans l'interface de conversation : le
 * contenu reçu ne doit apparaître ni en bulle, ni en notification, ni en
 * pastille. Ce journal est donc la seule trace — et elle reste HORS de l'UI.
 *
 * Format : **JSONL append-only** (`declencheurs-journal.jsonl`, une ligne = un
 * événement), sur le volume `state`, écrit en 0600 — même doctrine que
 * `src/agents/audit.ts` et `src/jobs/store.ts`.
 *
 * Événements : `recu` (le contenu est arrivé), `silence` (Yuki a répondu `RIEN`,
 * rien n'est publié), `publie` (le résultat est parti dans le fil
 * « Déclencheurs »), `echec` (raison exacte), et — lot 2, moteur horloge —
 * `saut` (passage sauté), `plafond` (tour tué par le plafond), `desactive`
 * (déclencheur éteint), `refus` (déclenchement refusé). Le lot 3 réserve
 * `preautorisation` (outil pré-autorisé consommé, champ `preAutorisation`) pour
 * que la page de gestion puisse déjà le filtrer.
 *
 * Bornes :
 *  - ⚠️ **contenu borné à 8 000 caractères** (la troncature est DITE : `tronque`),
 *    on ne stocke jamais un message entier en clair dans un journal ;
 *  - ⚠️ **purge à 30 jours** (réécriture atomique, lignes illisibles conservées) ;
 *  - jamais un jeton, jamais une valeur de coffre.
 *
 * Aucun import SDK/typebox.
 */

import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/** Nom du fichier dans le volume `state`. */
export const DECLENCHEURS_JOURNAL_FILE = "declencheurs-journal.jsonl";

/** ⚠️ Borne du contenu recopié dans le journal (caractères). */
export const MAX_JOURNAL_CONTENT_CHARS = 8_000;

/** Rétention du journal (jours). */
export const JOURNAL_RETENTION_DAYS = 30;

/** Nature d'un événement journalisé. */
export type DeclencheurEvent =
  | "recu"
  | "silence"
  | "publie"
  | "echec"
  /** ⚠️ LOT 2 — passage SAUTÉ (rattrapage trop tardif, chevauchement, arrêt). */
  | "saut"
  /** ⚠️ LOT 2 — tour TUÉ par le plafond d'exécution (`plafondMs`). */
  | "plafond"
  /** ⚠️ LOT 2 — déclencheur ÉTEINT (marqueur « DÉSACTIVER » ou garde-fou). */
  | "desactive"
  /** ⚠️ LOT 2 — déclenchement REFUSÉ (un déclencheur ne peut pas en déclencher un autre). */
  | "refus"
  /**
   * ⚠️ LOT 4 (réservé ici) — PRÉ-AUTORISATION CONSOMMÉE par un tour de fond.
   * Le champ `preAutorisation` porte l'outil concerné. La valeur existe dès le
   * lot 3 pour que la page de gestion puisse la FILTRER sans nouvelle version.
   */
  | "preautorisation";

/** Tous les événements connus, dans l'ordre d'affichage de la page de gestion. */
export const DECLENCHEUR_EVENTS: readonly DeclencheurEvent[] = [
  "recu",
  "silence",
  "publie",
  "echec",
  "saut",
  "plafond",
  "desactive",
  "refus",
  "preautorisation",
];

/** Filtre de lecture du journal (⚠️ borné : jamais tout le fichier). */
export interface DeclencheurJournalFilter {
  /** Un ou plusieurs types d'événement (vide/absent ⇒ tous). */
  types?: readonly DeclencheurEvent[];
  /** Nom exact de la source concernée (absent ⇒ toutes). */
  source?: string;
}

/** Vrai si la valeur est un événement connu (filtre d'URL compris). */
export function isDeclencheurEvent(value: unknown): value is DeclencheurEvent {
  return typeof value === "string" && (DECLENCHEUR_EVENTS as readonly string[]).includes(value);
}

/** Une ligne du journal (⚠️ jamais de jeton, jamais de secret). */
export interface DeclencheurJournalRecord {
  /** Instant ISO de l'événement. */
  ts: string;
  event: DeclencheurEvent;
  /** Nom de la source (déclencheur) concernée. */
  source: string;
  /** Contenu BORNÉ (`recu` : ce qui est arrivé · `publie` : ce qui est publié). */
  texte?: string;
  /** `true` quand `texte` a été tronqué à `MAX_JOURNAL_CONTENT_CHARS`. */
  tronque?: boolean;
  /** Taille RÉELLE du contenu reçu (octets UTF-8), avant troncature. */
  octets?: number;
  /** Raison exacte d'un `echec` (jamais un succès inventé). */
  raison?: string;
  /** Fil concerné (identifiant du host) — jamais un contenu. */
  sessionId?: string;
  /**
   * ⚠️ Outil PRÉ-AUTORISÉ consommé (`event: "preautorisation"`, lot 4). Le champ
   * est lu dès le lot 3 pour que la page de gestion offre sa colonne et son filtre.
   */
  preAutorisation?: string;
}

/** Journal minimal (le logger d'observabilité le satisfait). */
export interface DeclencheurJournalLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface DeclencheurJournalOptions {
  /** Chemin du fichier (`/data/state/declencheurs-journal.jsonl`). */
  path: string;
  logger?: DeclencheurJournalLogger;
  now?: () => number;
  /** Rétention (jours). Défaut : `JOURNAL_RETENTION_DAYS`. */
  retentionDays?: number;
  /** Borne du contenu (caractères). Défaut : `MAX_JOURNAL_CONTENT_CHARS`. */
  maxContentChars?: number;
}

/** Taille maximale relue depuis la fin du journal (`recent()`). */
const TAIL_BYTES = 256 * 1_024;

/** Cadence minimale de purge automatique (1 heure). */
const PURGE_INTERVAL_MS = 60 * 60 * 1000;

const DAY_MS = 86_400_000;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Réduit un contenu à la borne du journal (la troncature est DITE). */
export function boundJournalContent(
  texte: string,
  maxChars: number = MAX_JOURNAL_CONTENT_CHARS,
): { texte: string; tronque?: boolean } {
  const bound = Math.max(0, Math.trunc(maxChars));
  if (texte.length <= bound) return { texte };
  return { texte: texte.slice(0, bound), tronque: true };
}

/**
 * Journal append-only des déclencheurs. Chargé à la demande (`recent`), jamais
 * tenu en mémoire pour l'affichage : l'UI de conversation ne le lit pas.
 */
export class DeclencheurJournal {
  readonly path: string;
  private readonly logger?: DeclencheurJournalLogger;
  private readonly now: () => number;
  private readonly retentionDays: number;
  private readonly maxContentChars: number;
  private lastPurgeAt = 0;

  private constructor(options: DeclencheurJournalOptions) {
    this.path = options.path;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.retentionDays = Math.max(0, Math.trunc(options.retentionDays ?? JOURNAL_RETENTION_DAYS));
    this.maxContentChars = Math.max(
      0,
      Math.trunc(options.maxContentChars ?? MAX_JOURNAL_CONTENT_CHARS),
    );
  }

  /** Ouvre le journal (crée le dossier, purge les lignes périmées). */
  static open(options: DeclencheurJournalOptions): DeclencheurJournal {
    const journal = new DeclencheurJournal(options);
    try {
      mkdirSync(dirname(journal.path), { recursive: true });
    } catch (error) {
      journal.logger?.warn("declencheurs.journal.open_failed", {
        path: journal.path,
        error: messageOf(error),
      });
    }
    journal.purge();
    return journal;
  }

  get filePath(): string {
    return this.path;
  }

  /**
   * Ajoute UNE ligne. ⚠️ Ne lève jamais : un journal indisponible ne doit pas
   * empêcher un déclencheur de fonctionner (on le DIT dans les logs).
   */
  append(
    input: {
      event: DeclencheurEvent;
      source: string;
      texte?: string;
      octets?: number;
      raison?: string;
      sessionId?: string;
      preAutorisation?: string;
      ts?: string;
    },
  ): DeclencheurJournalRecord {
    const record: DeclencheurJournalRecord = {
      ts: input.ts ?? new Date(this.now()).toISOString(),
      event: input.event,
      source: input.source,
      ...(input.texte !== undefined ? boundJournalContent(input.texte, this.maxContentChars) : {}),
      ...(input.octets !== undefined ? { octets: Math.max(0, Math.trunc(input.octets)) } : {}),
      ...(input.raison !== undefined && input.raison !== "" ? { raison: input.raison } : {}),
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      ...(input.preAutorisation !== undefined && input.preAutorisation !== ""
        ? { preAutorisation: input.preAutorisation }
        : {}),
    };
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      this.logger?.warn("declencheurs.journal.append_failed", {
        path: this.path,
        error: messageOf(error),
      });
      return record;
    }
    this.purgeIfDue();
    return record;
  }

  /** Purge au plus une fois par heure (jamais à chaque ligne). */
  private purgeIfDue(): void {
    const at = this.now();
    if (at - this.lastPurgeAt < PURGE_INTERVAL_MS) return;
    this.purge();
  }

  /**
   * Retire les lignes plus anciennes que la rétention. Réécriture ATOMIQUE
   * (`tmp` + `rename`) : une ligne illisible est CONSERVÉE (on ne détruit jamais
   * une trace qu'on n'a pas comprise). Renvoie le nombre de lignes retirées.
   */
  purge(): number {
    this.lastPurgeAt = this.now();
    if (!existsSync(this.path)) return 0;
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      this.logger?.warn("declencheurs.journal.unreadable", {
        path: this.path,
        error: messageOf(error),
      });
      return 0;
    }
    const cutoff = this.now() - this.retentionDays * DAY_MS;
    const kept: string[] = [];
    let dropped = 0;
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      const ts = parseTimestamp(line);
      if (ts !== undefined && ts < cutoff) {
        dropped += 1;
        continue;
      }
      kept.push(line);
    }
    if (dropped === 0) return 0;
    try {
      this.rewrite(kept);
    } catch (error) {
      this.logger?.warn("declencheurs.journal.purge_failed", {
        path: this.path,
        error: messageOf(error),
      });
      return 0;
    }
    return dropped;
  }

  private rewrite(lines: readonly string[]): void {
    const tmp = `${this.path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    writeFileSync(tmp, lines.length > 0 ? `${lines.join("\n")}\n` : "", { mode: 0o600 });
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

  /**
   * Derniers événements (les plus récents D'ABORD), lus depuis la FIN du fichier
   * (lecture bornée : le journal peut être long).
   *
   * ⚠️ Le FILTRE s'applique AVANT la borne : `recent(50, {types:["echec"]})` rend
   * jusqu'à 50 échecs, pas les échecs des 50 dernières lignes (sinon la page de
   * gestion afficherait « aucun échec » alors qu'il y en a).
   */
  recent(limit = 50, filter: DeclencheurJournalFilter = {}): DeclencheurJournalRecord[] {
    if (!existsSync(this.path)) return [];
    const wanted = Math.max(1, Math.trunc(limit));
    let text: string;
    try {
      const size = statSync(this.path).size;
      const length = Math.min(size, TAIL_BYTES);
      if (length <= 0) return [];
      const fd = openSync(this.path, "r");
      try {
        const buffer = Buffer.alloc(length);
        readSync(fd, buffer, 0, length, size - length);
        text = buffer.toString("utf8");
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      this.logger?.warn("declencheurs.journal.read_failed", {
        path: this.path,
        error: messageOf(error),
      });
      return [];
    }
    const types = filter.types && filter.types.length > 0 ? new Set(filter.types) : undefined;
    const source = typeof filter.source === "string" && filter.source !== "" ? filter.source : undefined;
    const records: DeclencheurJournalRecord[] = [];
    for (const line of text.split("\n")) {
      const record = parseRecord(line);
      if (!record) continue;
      if (types && !types.has(record.event)) continue;
      if (source !== undefined && record.source !== source) continue;
      records.push(record);
    }
    return records.slice(-wanted).reverse();
  }
}

/** Instant d'une ligne (borné : `undefined` si illisible). */
function parseTimestamp(line: string): number | undefined {
  const record = parseRecord(line);
  if (!record) return undefined;
  const at = Date.parse(record.ts);
  return Number.isFinite(at) ? at : undefined;
}

/** Une ligne JSON valide et typée, ou `undefined`. */
function parseRecord(line: string): DeclencheurJournalRecord | undefined {
  const trimmed = line.trim();
  if (trimmed === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const raw = parsed as Record<string, unknown>;
  if (typeof raw["ts"] !== "string" || typeof raw["event"] !== "string") return undefined;
  if (typeof raw["source"] !== "string") return undefined;
  const event = raw["event"];
  if (
    event !== "recu" &&
    event !== "silence" &&
    event !== "publie" &&
    event !== "echec" &&
    event !== "saut" &&
    event !== "plafond" &&
    event !== "desactive" &&
    event !== "refus" &&
    event !== "preautorisation"
  ) {
    return undefined;
  }
  return {
    ts: raw["ts"],
    event,
    source: raw["source"],
    ...(typeof raw["texte"] === "string" ? { texte: raw["texte"] } : {}),
    ...(raw["tronque"] === true ? { tronque: true } : {}),
    ...(typeof raw["octets"] === "number" ? { octets: raw["octets"] } : {}),
    ...(typeof raw["raison"] === "string" ? { raison: raw["raison"] } : {}),
    ...(typeof raw["sessionId"] === "string" ? { sessionId: raw["sessionId"] } : {}),
    ...(typeof raw["preAutorisation"] === "string"
      ? { preAutorisation: raw["preAutorisation"] }
      : {}),
  };
}
