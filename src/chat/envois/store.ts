/**
 * STORE des ENVOIS PROGRAMMÉS — `envois-programmes.json`, écriture ATOMIQUE 0600.
 *
 * ⚠️ POURQUOI UN FICHIER DÉDIÉ (et pas `config.json` ni `sources.json`) :
 *  - `config.json` n'accepte qu'un patch PLAT de scalaires (`src/config/store.ts`) ;
 *  - `sources.json` porte des DÉCLENCHEURS (cycle de vie, jeton, cron) — un envoi
 *    programmé n'en est pas un : il n'a ni jeton ni consigne, et il DISPARAÎT de
 *    l'attente une fois parti.
 * Un fichier à part garde les deux modèles lisibles et permet de purger l'un sans
 * toucher l'autre.
 *
 * ⚠️ PERSISTÉ, JAMAIS EN MÉMOIRE SEULE : c'est ce qui fait survivre un envoi à un
 * redémarrage. Le fichier est relu au démarrage ; un `en_cours` retrouvé (arrêt brutal
 * pendant la publication) devient `echoue` — JAMAIS rejoué, parce qu'un doublon est
 * pire qu'un manque annoncé.
 *
 * Aucune dépendance SDK.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  ENVOIS_PROGRAMMES_SCHEMA_VERSION,
  RETENTION_TERMINES_MS,
  type CibleEnvoi,
  type EnvoiProgramme,
  type EnvoisProgrammesFile,
  type EtatEnvoi,
} from "./types.js";

/** Journal minimal accepté (le logger d'observabilité le satisfait). */
export interface EnvoisStoreLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface EnvoisProgrammesStoreOptions {
  /** Chemin du fichier (`/data/state/envois-programmes.json`). */
  path: string;
  logger?: EnvoisStoreLogger;
  /** Horloge injectable (purge des terminés). */
  now?: () => number;
}

/** Ce qu'il faut pour AJOUTER un envoi (l'`id` et les dates sont posés ici). */
export interface NouvelEnvoi {
  quand: string;
  texte: string;
  fichierIds?: readonly string[];
  cible: CibleEnvoi;
  source?: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Envois programmés persistés.
 *
 * ⚠️ Toute écriture passe par `persist()` (tmp + `rename` + `chmod 0600`) : un arrêt
 * au mauvais moment laisse l'ANCIEN fichier intact, jamais un JSON tronqué — sans quoi
 * la reprise après redémarrage perdrait TOUS les envois en attente.
 */
export class EnvoisProgrammesStore {
  readonly path: string;
  private readonly logger?: EnvoisStoreLogger;
  private readonly now: () => number;
  private envois: EnvoiProgramme[] = [];

  private constructor(options: EnvoisProgrammesStoreOptions) {
    this.path = options.path;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
  }

  /** Ouvre (crée le fichier au premier ajout) et CHARGE l'état persisté. */
  static open(options: EnvoisProgrammesStoreOptions): EnvoisProgrammesStore {
    const store = new EnvoisProgrammesStore(options);
    store.charger();
    return store;
  }

  /** Nombre d'envois EN ATTENTE (ceux qui comptent pour le plafond). */
  get enAttente(): number {
    return this.envois.filter((envoi) => envoi.etat === "en_attente").length;
  }

  /** Tous les envois, du plus proche au plus lointain (copie défensive). */
  list(): EnvoiProgramme[] {
    return this.envois
      .map((envoi) => ({ ...envoi, ...(envoi.fichierIds ? { fichierIds: [...envoi.fichierIds] } : {}) }))
      .sort((a, b) => Date.parse(a.quand) - Date.parse(b.quand));
  }

  /** Un envoi, ou `undefined`. */
  get(id: string): EnvoiProgramme | undefined {
    const trouve = this.envois.find((envoi) => envoi.id === id);
    return trouve === undefined ? undefined : { ...trouve };
  }

  /**
   * Envois DUS à cet instant (état `en_attente` et `quand` dépassé).
   *
   * ⚠️ Triés par échéance : l'ordre de publication suit l'ordre des heures demandées,
   * même si le serveur s'est arrêté entre-temps.
   */
  dus(maintenant: number): EnvoiProgramme[] {
    return this.list().filter(
      (envoi) => envoi.etat === "en_attente" && Date.parse(envoi.quand) <= maintenant,
    );
  }

  /** Ajoute un envoi en attente (l'identifiant est NEUF et unique). */
  ajouter(nouvel: NouvelEnvoi): EnvoiProgramme {
    const envoi: EnvoiProgramme = {
      id: randomBytes(8).toString("hex"),
      creeLe: new Date(this.now()).toISOString(),
      quand: nouvel.quand,
      texte: nouvel.texte,
      ...(nouvel.fichierIds !== undefined && nouvel.fichierIds.length > 0
        ? { fichierIds: [...nouvel.fichierIds] }
        : {}),
      cible: { ...nouvel.cible },
      etat: "en_attente",
      tentatives: 0,
      ...(nouvel.source !== undefined && nouvel.source !== "" ? { source: nouvel.source } : {}),
    };
    this.envois.push(envoi);
    this.persist();
    return { ...envoi };
  }

  /**
   * Change l'état d'un envoi et PERSISTE immédiatement.
   *
   * ⚠️ Appelé AVANT la publication (`en_cours`) puis après (`envoye`/`echoue`) : si le
   * processus meurt entre les deux, le rechargement voit `en_cours` et le marque
   * échoué — il ne le rejoue pas.
   */
  marquer(
    id: string,
    etat: EtatEnvoi,
    details: { raison?: string; envoyeLe?: string } = {},
  ): EnvoiProgramme | undefined {
    const envoi = this.envois.find((candidat) => candidat.id === id);
    if (!envoi) return undefined;
    envoi.etat = etat;
    if (etat === "en_cours") envoi.tentatives += 1;
    if (details.raison !== undefined && details.raison !== "") envoi.raison = details.raison;
    else if (etat === "envoye") delete envoi.raison;
    if (details.envoyeLe !== undefined) envoi.envoyeLe = details.envoyeLe;
    this.persist();
    return { ...envoi };
  }

  /**
   * Retire DÉFINITIVEMENT un envoi TERMINÉ (purge des plus anciens).
   *
   * ⚠️ Un envoi `en_attente` ou `en_cours` n'est jamais retiré ici : la seule façon de
   * sortir de l'attente est de partir ou d'être ANNULÉ (et l'annulation laisse une
   * trace, elle ne supprime pas la ligne).
   */
  oublier(id: string): void {
    const avant = this.envois.length;
    this.envois = this.envois.filter(
      (envoi) => !(envoi.id === id && envoi.etat !== "en_attente" && envoi.etat !== "en_cours"),
    );
    if (this.envois.length !== avant) this.persist();
  }

  /**
   * Purge les envois TERMINÉS plus anciens que la rétention (7 jours).
   *
   * ⚠️ Rien n'est purgé côté ATTENTE : un envoi futur reste listé jusqu'à son heure,
   * même si la personne ne l'a pas regardé.
   */
  purger(maintenant: number = this.now()): number {
    const avant = this.envois.length;
    this.envois = this.envois.filter((envoi) => {
      if (envoi.etat === "en_attente" || envoi.etat === "en_cours") return true;
      const reference = Date.parse(envoi.envoyeLe ?? envoi.quand);
      if (!Number.isFinite(reference)) return true;
      return maintenant - reference <= RETENTION_TERMINES_MS;
    });
    const retire = avant - this.envois.length;
    if (retire > 0) this.persist();
    return retire;
  }

  /** Relit le fichier. Un fichier illisible est DIT (jamais un état vide silencieux). */
  private charger(): void {
    if (!existsSync(this.path)) return;
    let texte: string;
    try {
      texte = readFileSync(this.path, "utf8");
    } catch (error) {
      this.logger?.warn("envois.store.read_failed", { path: this.path, error: messageOf(error) });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(texte);
    } catch (error) {
      // ⚠️ On ne RÉÉCRIT pas : le fichier corrompu reste lisible à la main (c'est la
      // seule trace des envois qu'il contenait).
      this.logger?.warn("envois.store.invalid", { path: this.path, error: messageOf(error) });
      return;
    }
    const file = parsed as Partial<EnvoisProgrammesFile>;
    if (!Array.isArray(file.envois)) {
      this.logger?.warn("envois.store.invalid", { path: this.path, reason: "schéma inattendu" });
      return;
    }
    const retenus: EnvoiProgramme[] = [];
    for (const brut of file.envois) {
      const envoi = normaliser(brut);
      if (envoi) retenus.push(envoi);
      else this.logger?.warn("envois.store.entry_skipped", { path: this.path });
    }
    this.envois = retenus;
    // ⚠️ REPRISE : un `en_cours` retrouvé = arrêt brutal PENDANT la publication. On ne
    // rejoue jamais (doublon possible) : on le dit, et la page de gestion l'affiche.
    let rattrapes = 0;
    for (const envoi of this.envois) {
      if (envoi.etat !== "en_cours") continue;
      envoi.etat = "echoue";
      envoi.raison =
        "Envoi interrompu par un arrêt du serveur pendant la publication : il n'est " +
        "PAS rejoué (il a peut-être été publié). Vérifie le canal avant de reprogrammer.";
      rattrapes += 1;
    }
    if (rattrapes > 0) {
      this.logger?.warn("envois.store.interrupted", { path: this.path, envois: rattrapes });
      this.persist();
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    const file: EnvoisProgrammesFile = {
      schemaVersion: ENVOIS_PROGRAMMES_SCHEMA_VERSION,
      envois: this.envois,
    };
    try {
      writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
      try {
        chmodSync(tmp, 0o600);
      } catch {
        // Meilleur effort (systèmes de fichiers sans mode POSIX).
      }
      renameSync(tmp, this.path);
      try {
        chmodSync(this.path, 0o600);
      } catch {
        // Meilleur effort.
      }
    } catch (error) {
      // ⚠️ Un fichier temporaire orphelin ne doit pas s'accumuler.
      try {
        unlinkSync(tmp);
      } catch {
        // Rien à faire : le message d'erreur d'origine est plus utile.
      }
      throw error;
    }
  }
}

/** Normalise une entrée lue (⚠️ une entrée illisible est ÉCARTÉE, pas devinée). */
function normaliser(brut: unknown): EnvoiProgramme | undefined {
  if (brut === null || typeof brut !== "object") return undefined;
  const raw = brut as Record<string, unknown>;
  const id = typeof raw["id"] === "string" && raw["id"] !== "" ? raw["id"] : undefined;
  const quand = typeof raw["quand"] === "string" ? raw["quand"] : "";
  const creeLe = typeof raw["creeLe"] === "string" ? raw["creeLe"] : "";
  const texte = typeof raw["texte"] === "string" ? raw["texte"] : "";
  const etat = raw["etat"];
  if (id === undefined || texte === "") return undefined;
  if (!Number.isFinite(Date.parse(quand)) || !Number.isFinite(Date.parse(creeLe))) return undefined;
  if (
    etat !== "en_attente" &&
    etat !== "en_cours" &&
    etat !== "envoye" &&
    etat !== "echoue" &&
    etat !== "annule"
  ) {
    return undefined;
  }
  const cible = normaliserCible(raw["cible"]);
  if (cible === undefined) return undefined;
  const fichierIds = Array.isArray(raw["fichierIds"])
    ? raw["fichierIds"].filter((value): value is string => typeof value === "string" && value !== "")
    : [];
  return {
    id,
    creeLe,
    quand,
    texte,
    ...(fichierIds.length > 0 ? { fichierIds } : {}),
    cible,
    etat,
    tentatives:
      typeof raw["tentatives"] === "number" && Number.isFinite(raw["tentatives"])
        ? Math.max(0, Math.trunc(raw["tentatives"]))
        : 0,
    ...(typeof raw["envoyeLe"] === "string" ? { envoyeLe: raw["envoyeLe"] } : {}),
    ...(typeof raw["raison"] === "string" && raw["raison"] !== "" ? { raison: raw["raison"] } : {}),
    ...(typeof raw["source"] === "string" && raw["source"] !== "" ? { source: raw["source"] } : {}),
  };
}

function normaliserCible(brut: unknown): CibleEnvoi | undefined {
  if (brut === null || typeof brut !== "object") return undefined;
  const raw = brut as Record<string, unknown>;
  const titre = typeof raw["titre"] === "string" && raw["titre"] !== "" ? raw["titre"] : undefined;
  if (raw["type"] === "canal") {
    const conversationId = raw["conversationId"];
    const plateforme = raw["plateforme"];
    if (typeof conversationId !== "string" || conversationId === "") return undefined;
    if (plateforme !== "mattermost" && plateforme !== "discord") return undefined;
    return {
      type: "canal",
      conversationId,
      plateforme,
      ...(titre !== undefined ? { titre } : {}),
    };
  }
  if (raw["type"] === "local") {
    const sessionId = raw["sessionId"];
    if (typeof sessionId !== "string" || sessionId === "") return undefined;
    return { type: "local", sessionId, ...(titre !== undefined ? { titre } : {}) };
  }
  return undefined;
}
