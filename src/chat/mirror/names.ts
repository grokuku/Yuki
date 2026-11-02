/**
 * ANNUAIRE DES NOMS D'AUTEURS (correction du 2026-11-02).
 *
 * ⚠️ LE DÉFAUT QUE CE MODULE CORRIGE : un message temps réel (`posted`) était ingéré
 * SANS que l'identifiant de son auteur soit résolu (`src/chat/mattermost/adapter.ts`,
 * `onSocketEvent` → `ingestContext` ne portait aucune table d'utilisateurs). Le miroir
 * enregistrait donc `author.nom = "g68pqnp8pykm89pj3eqn1khhe"`, et l'interface affichait
 * cet identifiant BRUT au milieu d'une phrase.
 *
 * ⚠️ POURQUOI UN ANNUAIRE SÉPARÉ, ET PAS UNE RÉÉCRITURE DU `.jsonl` : le miroir est
 * APPEND-ONLY (`store.ts`) et une entrée déjà écrite porte l'identifiant nu. Réécrire
 * les fichiers à chaque démarrage exposerait tout le miroir à une perte sur une coupure
 * au mauvais moment, pour une information qui n'est qu'un NOM. On tient donc une table
 * `(plateforme, id) → nom`, PERSISTÉE à part, consultée à la LECTURE : les entrées
 * anciennes deviennent lisibles sans qu'une seule ligne de miroir soit réécrite.
 *
 * ⚠️ Ce module ne fait AUCUN appel réseau : il stocke ce qu'on lui apprend. La
 * résolution (`POST /users/ids`) appartient à l'adaptateur, qui la borne et la met en
 * cache là où vit le client HTTP.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { RemotePlatform } from "../types.js";

/** Taille d'un LOT de résolution d'identifiants (`POST /users/ids`). */
export const AUTHOR_NAME_BATCH_SIZE = 50;

/** Nombre maximal de noms conservés (borne mémoire ET fichier : 2 000 auteurs). */
export const AUTHOR_NAMES_MAX = 2_000;

/** Nombre de caractères d'un identifiant conservés dans la forme courte. */
export const AUTHOR_NAME_SHORT_CHARS = 6;

/** Longueur à partir de laquelle un identifiant est jugé « illisible en clair ». */
const AUTHOR_ID_READABLE_MAX = 12;

/**
 * Forme COURTE et LISIBLE d'un identifiant d'auteur NON résolu.
 *
 * ⚠️ Un identifiant Mattermost fait 26 caractères, un identifiant Discord 18 chiffres :
 * les afficher tels quels casse la lecture d'un fil. On rend une forme courte et
 * EXPLICITE (« membre inconnu (g68pqn…) ») : la personne voit qu'il s'agit d'un membre
 * dont le nom n'a pas pu être obtenu, pas d'un nom bizarre.
 */
export function formeCourteAuteur(id: string): string {
  const trimmed = (id ?? "").trim();
  if (trimmed === "" || trimmed === "inconnu") return "membre inconnu";
  if (trimmed.length <= AUTHOR_ID_READABLE_MAX) return trimmed;
  return `membre inconnu (${trimmed.slice(0, AUTHOR_NAME_SHORT_CHARS)}…)`;
}

/**
 * Nom à AFFICHER pour un auteur : le nom s'il est connu, sinon la forme courte.
 *
 * ⚠️ Le repli n'est pas « l'identifiant par défaut » : `authorOf` (`ingest.ts`) écrit
 * l'identifiant dans `nom` quand la résolution échoue — c'est ce marqueur (`nom === id`)
 * qui distingue « pas encore résolu » de « nom égal à l'identifiant par hasard ».
 */
export function auteurAffichable(author: { id: string; nom?: string }): string {
  const id = typeof author.id === "string" ? author.id.trim() : "";
  const nom = typeof author.nom === "string" ? author.nom.trim() : "";
  if (nom !== "" && nom !== id) return nom;
  return formeCourteAuteur(id);
}

/** Journal minimal (le logger d'observabilité le satisfait). */
export interface AuthorDirectoryLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
}

/** Contenu du fichier `author-names.json` (une entrée par PLATEFORME). */
interface AuthorNamesFile {
  schemaVersion?: number;
  /** `plateforme` → `{ <id>: <nom> }`. */
  noms?: Record<string, Record<string, string>>;
}

export interface AuthorDirectoryOptions {
  /** Chemin du fichier (`<state>/chat-mirror/author-names.json`). */
  path: string;
  logger?: AuthorDirectoryLogger;
  /** Nombre maximal de noms conservés (défaut `AUTHOR_NAMES_MAX`). */
  max?: number;
}

/**
 * Table PERSISTANTE `(plateforme, id) → nom`.
 *
 * ⚠️ Écriture ATOMIQUE (`tmp` + `rename`) en mode 0600, et SEULEMENT quand un nom
 * nouveau (ou changé) est appris : un démarrage sans nouveauté ne touche pas le disque.
 */
export class AuthorDirectory {
  readonly path: string;
  private readonly logger: AuthorDirectoryLogger | undefined;
  private readonly max: number;
  /** `plateforme\u0000id` → nom (l'ordre d'insertion sert à évincer les plus anciens). */
  private readonly noms = new Map<string, string>();

  constructor(options: AuthorDirectoryOptions) {
    this.path = options.path;
    this.logger = options.logger;
    this.max = Math.max(1, Math.trunc(options.max ?? AUTHOR_NAMES_MAX));
    this.load();
  }

  /** Taille de l'annuaire (diagnostic). */
  get size(): number {
    return this.noms.size;
  }

  /** Nom connu d'un auteur, ou `undefined` (`id` vide ⇒ `undefined`). */
  name(platform: RemotePlatform, id: string): string | undefined {
    if (typeof id !== "string" || id === "") return undefined;
    const nom = this.noms.get(`${platform}\u0000${id}`);
    return nom !== undefined && nom.trim() !== "" ? nom : undefined;
  }

  /** Tous les noms connus d'une plateforme (copie : l'appelant ne peut pas la corrompre). */
  namesOf(platform: RemotePlatform): Map<string, string> {
    const out = new Map<string, string>();
    const prefix = `${platform}\u0000`;
    for (const [key, nom] of this.noms) {
      if (key.startsWith(prefix)) out.set(key.slice(prefix.length), nom);
    }
    return out;
  }

  /**
   * Apprend des noms ; rend le nombre d'entrées NOUVELLES ou CHANGÉES.
   *
   * Un nom vide et un nom égal à l'identifiant sont IGNORÉS : ils n'apprennent rien et
   * écraseraient un nom déjà connu par un marqueur d'échec.
   */
  remember(platform: RemotePlatform, entries: Iterable<readonly [string, string]>): number {
    let changes = 0;
    for (const [id, nom] of entries) {
      if (typeof id !== "string" || id === "" || id === "inconnu") continue;
      const value = typeof nom === "string" ? nom.trim() : "";
      if (value === "" || value === id) continue;
      const key = `${platform}\u0000${id}`;
      if (this.noms.get(key) === value) continue;
      this.noms.set(key, value);
      changes += 1;
    }
    if (changes === 0) return 0;
    this.evict();
    this.save();
    return changes;
  }

  /** Évince les entrées les plus anciennes au-delà de la borne (jamais d'erreur). */
  private evict(): void {
    while (this.noms.size > this.max) {
      const oldest = this.noms.keys().next();
      if (oldest.done === true) return;
      this.noms.delete(oldest.value);
    }
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (typeof parsed !== "object" || parsed === null) return;
      const noms = (parsed as AuthorNamesFile).noms;
      if (typeof noms !== "object" || noms === null) return;
      for (const [platform, table] of Object.entries(noms)) {
        if (typeof table !== "object" || table === null) continue;
        for (const [id, nom] of Object.entries(table)) {
          if (typeof nom !== "string" || id === "") continue;
          const value = nom.trim();
          if (value === "" || value === id) continue;
          this.noms.set(`${platform}\u0000${id}`, value);
        }
      }
      this.evict();
    } catch (error) {
      // Un annuaire illisible ne casse RIEN : les noms seront simplement re-résolus.
      this.logger?.warn("chat.mirror.author_names_unreadable", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private save(): void {
    const noms: Record<string, Record<string, string>> = {};
    for (const [key, nom] of this.noms) {
      const separator = key.indexOf("\u0000");
      if (separator <= 0) continue;
      const platform = key.slice(0, separator);
      const id = key.slice(separator + 1);
      noms[platform] = { ...(noms[platform] ?? {}), [id]: nom };
    }
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ schemaVersion: 1, noms }, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.path);
    } catch (error) {
      // ⚠️ Un disque plein ne doit pas faire échouer une réponse dans un canal : le nom
      // est déjà en MÉMOIRE (l'affichage est correct), seule la persistance manque.
      this.logger?.warn("chat.mirror.author_names_write_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
