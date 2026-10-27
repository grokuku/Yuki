/**
 * `ReactionStore` — RÉACTIONS de l'utilisateur aux messages de Yuki, persistées
 * À PART dans le volume `state` (`reactions.jsonl`, journal APPEND-ONLY).
 *
 * ⚠️ POURQUOI À PART : une réaction n'est PAS un message. Elle ne doit entrer
 * ni dans le JSONL de session (propriété du SDK Pi), ni dans le transcript, ni
 * dans la mémoire durable. Un fichier dédié rend les trois impossibles par
 * construction, tout en SURVIVANT au rechargement et à la reconnexion.
 *
 * ⚠️ CORRÉLATION — L'IDENTIFIANT EST CELUI DU MESSAGE, PAS UN SECOND IDENTIFIANT.
 * La clé est `(sessionId, entryId)` où `entryId` est l'identifiant d'entrée de
 * session (`parentId` des `yuki.run_metrics`, exposé par `TranscriptEntry.id`).
 * On n'invente AUCUN identifiant parallèle : c'est ce qui garantit qu'une
 * réaction reste attachée au BON message (le piège n°1 : une réaction posée sur
 * un autre message ferait apprendre au modèle le contraire).
 *
 * Journal (une ligne JSON par événement, jamais réécrit) :
 *   `{"v":1,"t":"set","sessionId":…,"entryId":…,"reaction":…,"at":…}`
 *   `{"v":1,"t":"clear","sessionId":…,"entryId":…,"at":…}`
 * La projection en mémoire ne garde que l'état COURANT (une réaction par
 * message) : un changement de réaction écrase, un retrait efface.
 *
 * Aucun import SDK ni `typebox`.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  isMemoryEligibleGroup,
  isReactionId,
  reactionById,
  REACTION_REGULARITY_MIN,
  type ReactionGroup,
  type ReactionRegularity,
  type ReactionsPort,
  type ReactionView,
} from "./types.js";

export interface ReactionStoreLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface ReactionStoreOptions {
  /** Chemin du journal JSONL (volume `state`). */
  path: string;
  logger?: ReactionStoreLogger;
  /** Horloge injectable (tests déterministes). */
  now?: () => number;
}

/** Événement du journal (format documenté ci-dessus). */
export type ReactionEvent =
  | { v: 1; t: "set"; sessionId: string; entryId: string; reaction: string; at: string }
  | { v: 1; t: "clear"; sessionId: string; entryId: string; at: string };

/** Taille maximale d'un `entryId`/`sessionId` accepté (garde anti-abus). */
const MAX_ID_CHARS = 256;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_ID_CHARS) return undefined;
  return trimmed;
}

/** Clé de projection d'une réaction (session + message). */
function keyOf(sessionId: string, entryId: string): string {
  // `\u0000` ne peut apparaître ni dans un identifiant de session ni dans un
  // identifiant d'entrée : la clé est donc non ambiguë.
  return `${sessionId}\u0000${entryId}`;
}

/**
 * Store des réactions. Toutes les mutations renvoient l'état RÉSULTANT (ou
 * `undefined` si rien n'a changé) ; `set` renvoie en plus la RÉGULARITÉ
 * éventuellement franchie, pour que l'appelant décide d'écrire un souvenir.
 */
export class ReactionStore implements ReactionsPort {
  private readonly path: string;
  private readonly logger?: ReactionStoreLogger;
  private readonly now: () => number;
  /** État COURANT par `(sessionId, entryId)`. */
  private readonly current = new Map<string, ReactionView>();
  /** Ordre chronologique des clés encore actives (la plus récemment posée en dernier). */
  private order: string[] = [];

  private constructor(options: ReactionStoreOptions) {
    this.path = options.path;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
  }

  /** Ouvre (ou crée) le journal et reconstruit la projection. */
  static open(options: ReactionStoreOptions): ReactionStore {
    const store = new ReactionStore(options);
    store.load();
    return store;
  }

  get filePath(): string {
    return this.path;
  }

  /** Nombre de messages portant une réaction (état courant). */
  get size(): number {
    return this.current.size;
  }

  /**
   * Réactions courantes d'une conversation : `entryId → reaction`.
   * C'est ce qui est fusionné dans le snapshot (rechargement / reconnexion).
   */
  forSession(sessionId: string): Map<string, string> {
    const result = new Map<string, string>();
    for (const view of this.current.values()) {
      if (view.sessionId === sessionId) result.set(view.entryId, view.reaction);
    }
    return result;
  }

  /** Réaction courante d'un message précis, ou `undefined`. */
  get(sessionId: string, entryId: string): string | undefined {
    return this.current.get(keyOf(sessionId, entryId))?.reaction;
  }

  /**
   * Les `limit` dernières réactions ENCORE posées (de la plus ancienne à la plus
   * récente), une par message par construction.
   */
  recent(limit: number): ReactionView[] {
    const max = Math.max(0, Math.floor(limit));
    if (max === 0) return [];
    const views: ReactionView[] = [];
    for (let index = this.order.length - 1; index >= 0 && views.length < max; index -= 1) {
      const view = this.current.get(this.order[index]);
      if (view) views.push(view);
    }
    return views.reverse();
  }

  /**
   * Les `limit` dernières réactions d'UNE conversation (`ReactionsPort`).
   * ⚠️ On filtre par conversation AVANT de borner : sinon une autre
   * conversation très active pourrait vider la fenêtre de celle-ci.
   */
  recentFor(sessionId: string, limit: number): ReactionView[] {
    const max = Math.max(0, Math.floor(limit));
    if (max === 0) return [];
    const views: ReactionView[] = [];
    for (let index = this.order.length - 1; index >= 0 && views.length < max; index -= 1) {
      const view = this.current.get(this.order[index]);
      if (view && view.sessionId === sessionId) views.push(view);
    }
    return views.reverse();
  }

  /**
   * Pose (ou change) la réaction d'un message. Renvoie la RÉGULARITÉ franchie
   * (une réaction répétée sur `REACTION_REGULARITY_MIN` messages distincts,
   * puis à chaque multiple de ce seuil) ou `null`.
   *
   * ⚠️ Une réaction ISOLÉE ne produit jamais de régularité — donc jamais de
   * souvenir. Une réaction posée sur le MÊME message ne compte qu'une fois.
   */
  set(sessionId: string, entryId: string, reaction: string): ReactionRegularity | null {
    const cleanSession = cleanId(sessionId);
    const cleanEntry = cleanId(entryId);
    if (!cleanSession || !cleanEntry || !isReactionId(reaction)) return null;
    const key = keyOf(cleanSession, cleanEntry);
    const previous = this.current.get(key);
    const at = new Date(this.now()).toISOString();
    if (previous && previous.reaction === reaction) return null;
    this.current.set(key, {
      sessionId: cleanSession,
      entryId: cleanEntry,
      reaction,
      at,
    });
    this.touch(key);
    this.append({ v: 1, t: "set", sessionId: cleanSession, entryId: cleanEntry, reaction, at });
    return this.regularityOf(reaction);
  }

  /** Retire la réaction d'un message. `false` s'il n'y en avait pas. */
  clear(sessionId: string, entryId: string): boolean {
    const cleanSession = cleanId(sessionId);
    const cleanEntry = cleanId(entryId);
    if (!cleanSession || !cleanEntry) return false;
    const key = keyOf(cleanSession, cleanEntry);
    if (!this.current.delete(key)) return false;
    this.order = this.order.filter((item) => item !== key);
    this.append({
      v: 1,
      t: "clear",
      sessionId: cleanSession,
      entryId: cleanEntry,
      at: new Date(this.now()).toISOString(),
    });
    return true;
  }

  /**
   * Régularité d'une réaction DANS L'ÉTAT COURANT : nombre de messages DISTINCTS
   * qui la portent. `null` en dessous du seuil (une réaction isolée n'est pas un
   * souvenir), si l'on n'est pas sur un multiple exact du seuil (pas de
   * réécriture à chaque réaction : 3, 6, 9… seulement), ou si le REGISTRE est
   * exclu de la rétention durable.
   *
   * ⚠️ GRATITUDE (`merci`) : TOUJOURS `null`, même répétée dix fois. Ce n'est pas
   * un oubli — « l'utilisateur remercie souvent » n'apprend rien d'utile à Yuki.
   * Le ❤️ reste vu par le modèle au tour suivant (bloc de prompt) ; il ne devient
   * simplement jamais un souvenir (voir `MEMORY_EXCLUDED_GROUPS`).
   */
  regularityOf(reaction: string): ReactionRegularity | null {
    const def = reactionById(reaction);
    if (!def) return null;
    if (!isMemoryEligibleGroup(def.group)) return null;
    let count = 0;
    for (const view of this.current.values()) {
      if (view.reaction === reaction) count += 1;
    }
    if (count < REACTION_REGULARITY_MIN) return null;
    if (count % REACTION_REGULARITY_MIN !== 0) return null;
    return { reaction, group: def.group as ReactionGroup, count };
  }

  // --- interne --------------------------------------------------------------

  /** Déplace la clé en FIN d'ordre (la plus récemment posée). */
  private touch(key: string): void {
    const index = this.order.indexOf(key);
    if (index >= 0) this.order.splice(index, 1);
    this.order.push(key);
  }

  /**
   * Écrit une ligne. ⚠️ Un échec d'écriture est JOURNALISÉ et n'interrompt
   * jamais la conversation : la projection en mémoire reste cohérente pour la
   * session en cours.
   */
  private append(event: ReactionEvent): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, `${JSON.stringify(event)}\n`, { mode: 0o644 });
    } catch (error) {
      this.logger?.warn("reactions.persist.failed", {
        session_id: event.sessionId,
        entry_id: event.entryId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Reconstruit la projection depuis le journal. Lecture TOLÉRANTE : une ligne
   * illisible est ignorée (une réaction perdue ne casse jamais le démarrage).
   * Un fichier illisible en entier est mis DE CÔTÉ (horodaté) plutôt qu'écrasé :
   * rien n'est détruit en silence.
   */
  private load(): void {
    if (!existsSync(this.path)) return;
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (error) {
      this.logger?.warn("reactions.load.failed", {
        path: this.path,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!isObject(parsed)) continue;
      const sessionId = cleanId(parsed.sessionId);
      const entryId = cleanId(parsed.entryId);
      if (!sessionId || !entryId) continue;
      const at = typeof parsed.at === "string" ? parsed.at : new Date(this.now()).toISOString();
      const key = keyOf(sessionId, entryId);
      if (parsed.t === "clear") {
        this.current.delete(key);
        this.order = this.order.filter((item) => item !== key);
        continue;
      }
      if (parsed.t !== "set" || !isReactionId(parsed.reaction)) continue;
      this.current.set(key, { sessionId, entryId, reaction: parsed.reaction, at });
      this.touch(key);
    }
  }
}
