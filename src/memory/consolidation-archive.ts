/**
 * VERSIONNING des passes de consolidation hebdomadaire (lot 29, amendement ②).
 *
 * Chaque passe dépose son ARCHIVE dans un dossier dédié :
 *
 *     <state>/memory-archive/consolidation/<AAAA-MM-JJ_HHMM>/
 *       memory.jsonl      ← l'état de la mémoire AVANT la passe (restaurable)
 *       operations.json   ← les opérations réellement APPLIQUÉES
 *       rapport.json      ← la mesure et le résultat de la passe
 *
 * ⚠️ POURQUOI PAS UN `.bak` UNIQUE : un fichier écrasé à chaque passe ne permet
 * PAS de revenir à la mémoire d'il y a trois semaines. Ici chaque passe garde la
 * sienne, et la rétention (par défaut 12 ≈ 3 mois) est réglable.
 *
 * ⚠️ SÉCURITÉ : les noms de version sont VALIDÉS (regex stricte) ET confinés au
 * dossier d'archives (`resolve` + préfixe). Aucune traversée (`../`) possible,
 * même si un nom vient de l'extérieur (API).
 *
 * Le module ne touche JAMAIS au store vivant : il écrit/lit des fichiers. La
 * restauration rend le contenu et l'écrit de façon ATOMIQUE (tmp + rename) ;
 * c'est l'appelant qui recharge le store et reconstruit l'index.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, resolve, sep } from "node:path";

/** Fichier de l'état AVANT la passe (JSONL complet, restaurable tel quel). */
export const VERSION_MEMORY_FILE = "memory.jsonl";
/** Fichier des opérations appliquées. */
export const VERSION_OPERATIONS_FILE = "operations.json";
/** Fichier du rapport (mesure, compteurs, refus éventuel). */
export const VERSION_RAPPORT_FILE = "rapport.json";

/**
 * Format STRICT d'un nom de version : `AAAA-MM-JJ_HHMM` (+ suffixe de collision).
 * ⚠️ Les COMPOSANTES sont bornées (mois 01-12, jour 01-31, heure 00-23,
 * minute 00-59) : un nom comme `2026-13-99_9999` est refusé AVANT tout accès
 * disque — la regex n'est pas un simple filtre de forme.
 */
export const NOM_VERSION_REGEX =
  /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])_([01]\d|2[0-3])[0-5]\d(-\d+)?$/;

/** Rétention par défaut (12 passes ≈ 3 mois à une passe par semaine). */
export const RETENTION_DEFAUT = 12;

/** Journal minimal (le logger d'observabilité le satisfait). */
export interface ArchiveLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

/** Résumé lisible d'une version (liste de l'interface). */
export interface ConsolidationVersion {
  /** Nom du dossier (`AAAA-MM-JJ_HHMM`), identifiant stable. */
  nom: string;
  /** Horodatage ISO de la passe. */
  at: string;
  /** Nombre d'entrées en mémoire AVANT la passe. */
  entreesAvant: number;
  /** Nombre d'entrées APRÈS la passe. */
  entreesApres: number;
  /** Nombre d'opérations appliquées. */
  operations: number;
  /** `true` si la passe a réellement modifié la mémoire. */
  applique: boolean;
  /** Chemin du dossier d'archive (absolu). */
  chemin: string;
}

export interface SauvegardeInput {
  /** Instant de la passe (ms). */
  at: number;
  /** Fuseau du réglage (`memory.consolidation.timeZone`) pour nommer le dossier. */
  fuseau: string;
  /** Contenu du fichier de mémoire AVANT la passe (restaurable à l'octet). */
  memoireAvant: string;
  /** Opérations appliquées (tableau JSON sérialisable). */
  operations: unknown;
  /** Rapport de la passe (sérialisable). */
  rapport: unknown;
  /** Rétention (nombre de versions conservées). */
  retention: number;
}

/** Nom de dossier d'une version, dans le FUSEAU du réglage (jamais celui du process). */
export function nomVersion(at: number, fuseau: string): string {
  let parties: Intl.DateTimeFormatPart[];
  try {
    parties = new Intl.DateTimeFormat("fr-FR", {
      timeZone: fuseau,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(at));
  } catch {
    // Fuseau refusé par `Intl` (ne devrait pas arriver : le réglage est validé) :
    // on nomme en UTC, ce qui reste triable et sans ambiguïté.
    const iso = new Date(at).toISOString();
    return `${iso.slice(0, 10)}_${iso.slice(11, 13)}${iso.slice(14, 16)}`;
  }
  const valeur = (type: string): string =>
    parties.find((part) => part.type === type)?.value ?? "00";
  return `${valeur("year")}-${valeur("month")}-${valeur("day")}_${valeur("hour")}${valeur("minute")}`;
}

/** Vrai si le nom est un nom de version STRUCTURELLEMENT valide. */
export function nomVersionValide(nom: unknown): nom is string {
  return typeof nom === "string" && NOM_VERSION_REGEX.test(nom);
}

export interface ConsolidationArchiveOptions {
  /** Dossier des versions (`<state>/memory-archive/consolidation`). */
  dir: string;
  logger: ArchiveLogger;
}

export class ConsolidationArchiveStore {
  private readonly dir: string;
  private readonly logger: ArchiveLogger;

  constructor(options: ConsolidationArchiveOptions) {
    this.dir = options.dir;
    this.logger = options.logger;
  }

  get dirPath(): string {
    return this.dir;
  }

  /**
   * Chemin ABSOLU d'une version, ou `null` si le nom est invalide/hors dossier.
   * ⚠️ Double barrière : regex stricte ET confinement (`resolve` + préfixe).
   */
  cheminDe(nom: unknown): string | null {
    if (!nomVersionValide(nom)) return null;
    const base = resolve(this.dir);
    const cible = resolve(base, nom);
    if (cible !== join(base, nom)) return null;
    if (!cible.startsWith(`${base}${sep}`)) return null;
    return cible;
  }

  /** Liste les versions, de la PLUS RÉCENTE à la plus ancienne. */
  lister(): ConsolidationVersion[] {
    if (!existsSync(this.dir)) return [];
    let noms: string[];
    try {
      noms = readdirSync(this.dir).filter((nom) => nomVersionValide(nom));
    } catch (error) {
      this.logger.warn("memory.consolidation.list.failed", {
        dir: this.dir,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
    noms.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    const versions: ConsolidationVersion[] = [];
    for (const nom of noms) {
      const chemin = join(this.dir, nom);
      const rapport = this.lireRapport(nom);
      versions.push({
        nom,
        at: typeof rapport?.at === "string" ? rapport.at : horodatageDepuisNom(nom),
        entreesAvant: nombreDe(rapport?.entreesAvant),
        entreesApres: nombreDe(rapport?.entreesApres),
        operations: nombreDe(rapport?.operations),
        applique: rapport?.applique === true,
        chemin,
      });
    }
    return versions;
  }

  private lireRapport(nom: string): Record<string, unknown> | null {
    const contenu = this.lire(nom, VERSION_RAPPORT_FILE);
    if (contenu === null) return null;
    try {
      const parsed: unknown = JSON.parse(contenu);
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  /** Contenu d'un fichier d'une version, ou `null` (nom invalide, fichier absent). */
  lire(nom: unknown, fichier: string): string | null {
    const chemin = this.cheminDe(nom);
    if (!chemin || !FICHIERS_AUTORISES.includes(fichier)) return null;
    try {
      return readFileSync(join(chemin, fichier), "utf8");
    } catch {
      return null;
    }
  }

  /**
   * Dépose une version puis applique la RÉTENTION.
   * Une collision de nom (deux passes dans la même minute) est suffixée.
   */
  sauvegarder(input: SauvegardeInput): ConsolidationVersion {
    const base = nomVersion(input.at, input.fuseau);
    let nom = base;
    let suffixe = 1;
    while (existsSync(join(this.dir, nom))) {
      suffixe += 1;
      nom = `${base}-${suffixe}`;
    }
    const chemin = join(this.dir, nom);
    mkdirSync(chemin, { recursive: true });
    writeFileSync(join(chemin, VERSION_MEMORY_FILE), input.memoireAvant, {
      encoding: "utf8",
      mode: 0o600,
    });
    writeFileSync(
      join(chemin, VERSION_OPERATIONS_FILE),
      `${JSON.stringify(input.operations, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    writeFileSync(
      join(chemin, VERSION_RAPPORT_FILE),
      `${JSON.stringify(input.rapport, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    const rapport = this.lireRapport(nom);
    const version: ConsolidationVersion = {
      nom,
      at: typeof rapport?.at === "string" ? rapport.at : new Date(input.at).toISOString(),
      entreesAvant: nombreDe(rapport?.entreesAvant),
      entreesApres: nombreDe(rapport?.entreesApres),
      operations: nombreDe(rapport?.operations),
      applique: rapport?.applique === true,
      chemin: join(this.dir, nom),
    };
    this.logger.info("memory.consolidation.version.saved", {
      version: nom,
      dir: chemin,
      entrees_avant: version.entreesAvant,
      entrees_apres: version.entreesApres,
      operations: version.operations,
    });
    this.purger(input.retention);
    return version;
  }

  /**
   * Purge les versions au-delà de `retention` (les plus ANCIENNES d'abord).
   * ⚠️ Purge EXPLICITE et JOURNALISÉE : jamais une suppression silencieuse.
   */
  purger(retention: number): string[] {
    const garde = Math.max(0, Math.trunc(retention));
    const versions = this.lister();
    const aPurger = versions.slice(garde);
    const purgees: string[] = [];
    for (const version of aPurger) {
      try {
        rmSync(version.chemin, { recursive: true, force: true });
        purgees.push(version.nom);
        this.logger.info("memory.consolidation.version.purged", {
          version: version.nom,
          retention: garde,
        });
      } catch (error) {
        this.logger.warn("memory.consolidation.version.purge_failed", {
          version: version.nom,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return purgees;
  }

  /**
   * Restaure l'état d'une version dans `destination` (le fichier de mémoire),
   * de façon ATOMIQUE : écriture d'un temporaire dans le MÊME dossier puis
   * `renameSync` (un lecteur ne voit jamais un fichier à moitié écrit).
   *
   * `null` si le nom est invalide ou si l'archive n'a pas de `memory.jsonl`.
   */
  restaurer(nom: unknown, destination: string): { nom: string; bytes: number } | null {
    const contenu = this.lire(nom, VERSION_MEMORY_FILE);
    const chemin = this.cheminDe(nom);
    if (contenu === null || chemin === null) return null;
    const tmp = join(
      dirname(destination),
      `.${basename(destination)}.tmp-${randomBytes(4).toString("hex")}`,
    );
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(tmp, contenu, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, destination);
    const bytes = statSync(destination).size;
    this.logger.info("memory.consolidation.version.restored", {
      version: nom,
      destination,
      bytes,
    });
    return { nom: String(nom), bytes };
  }
}

/** Fichiers qu'une version expose (liste blanche anti-traversée de fichier). */
const FICHIERS_AUTORISES: readonly string[] = [
  VERSION_MEMORY_FILE,
  VERSION_OPERATIONS_FILE,
  VERSION_RAPPORT_FILE,
];

function nombreDe(valeur: unknown): number {
  return typeof valeur === "number" && Number.isFinite(valeur) ? valeur : 0;
}

/** Horodatage ISO reconstruit depuis un nom `AAAA-MM-JJ_HHMM` (repli d'affichage). */
function horodatageDepuisNom(nom: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})/.exec(nom);
  if (!match) return nom;
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00.000Z`;
}
