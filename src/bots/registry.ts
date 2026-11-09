/**
 * REGISTRE DES BOTS — `state/bots.json` (lot 35a, multi-bot étape 1).
 *
 * ⚠️ Fichier JSON DÉDIÉ sur le volume `state`, JAMAIS dans `config.json` : le
 * schéma de `/config` n'accepte qu'un patch PLAT de scalaires
 * (`src/config/schema.ts`), une liste de bots n'y a pas sa place.
 *
 * Écriture ATOMIQUE (`tmp` + `rename`) en mode 0600, comme
 * `src/sources/store.ts:781-803`.
 *
 * ## Ce que ce lot pose (et ce qu'il ne fait PAS)
 *  - `bots` contient EXACTEMENT un bot (`yuki`) à la fin du lot 35a ;
 *  - les champs `profil`, `actif`, `ordre`, `plateformes` sont écrits DÈS
 *    MAINTENANT pour ne pas avoir à re-migrer le fichier plus tard ;
 *  - `echanges` (paires de bots) est VIDE : le garde-fou d'une paire est
 *    uniquement son bouton `actif` (aucun plafond, aucun frein) — il sera
 *    rempli au lot des canaux, pas ici ;
 *  - ⚠️ AUCUNE limite `MAX_BOTS` : elle n'existe pas encore (lot 1b, écran
 *    d'ajout). Ne pas l'inventer ici.
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
import { dirname, join } from "node:path";

/** Version du schéma du registre. Une seule version connue à ce jour. */
export const REGISTRE_BOTS_SCHEMA_VERSION = 1;

/** Nom du fichier, sous le volume `state`. */
export const REGISTRE_BOTS_FICHIER = "bots.json";

/** Identifiant du bot historique : c'est LUI qui est actif à la fin du lot 35a. */
export const BOT_YUKI = "yuki";

/**
 * Forme d'un identifiant de bot : minuscules, chiffres, `_` et `-`. Il sert de
 * NOM DE DOSSIER (`<state>/bots/<id>`, `<pi>/agent/sessions/<id>`) : un
 * identifiant libre permettrait `../` et ferait sortir de la racine du bot.
 */
export const ID_BOT_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

/** Profil d'un bot. Un seul profil à ce jour (« complet »). */
export type ProfilBot = "complet";

/** Enregistrement d'un bot dans le registre. */
export interface BotRecord {
  /** Identifiant STABLE, aussi utilisé comme nom de dossier. */
  id: string;
  /** Nom AFFICHÉ (libre, UTF-8). */
  nom: string;
  /** Profil fonctionnel (réservé : seul « complet » existe). */
  profil: ProfilBot;
  /** Bot actif : un seul bot aujourd'hui, mais le champ existe dès maintenant. */
  actif: boolean;
  /** Ordre d'affichage (entier ≥ 0), stable entre redémarrages. */
  ordre: number;
  /** Date de création (ISO 8601). */
  creeLe: string;
  /**
   * Plateformes de discussion rattachées (`mattermost`, `discord`…). VIDE à la
   * fin du lot 35a : le rattachement est le lot des canaux.
   */
  plateformes: Record<string, unknown>;
}

/**
 * Réglages d'un ÉCHANGE entre deux bots, indexé par `"<source>-><cible>"`.
 *
 * ⚠️ SEUL `actif` existe : c'est LE garde-fou (le bouton on/off de la paire).
 * Il n'y a AUCUN plafond d'échanges : un éventuel compteur sera purement
 * INFORMATIF (« N échanges cette heure ») et n'empêchera rien.
 */
export interface EchangeBots {
  actif: boolean;
}

/** Contenu de `state/bots.json`. */
export interface RegistreBots {
  schemaVersion: 1;
  bots: BotRecord[];
  /** Indexé par `"<source>-><cible>"`. Vide à la fin du lot 35a. */
  echanges: Record<string, EchangeBots>;
}

/** Code d'échec de lecture/écriture du registre. */
export type RegistreBotsCode = "ILLISIBLE" | "INVALIDE" | "ECRITURE";

/** Erreur EXPLICITE du registre : jamais un mode dégradé silencieux. */
export class RegistreBotsError extends Error {
  override readonly name = "RegistreBotsError";
  readonly code: RegistreBotsCode;
  readonly path: string;

  constructor(code: RegistreBotsCode, path: string, message: string) {
    super(message);
    this.code = code;
    this.path = path;
  }
}

/** Chemin du registre pour un volume `state` donné. */
export function cheminRegistreBots(stateDir: string): string {
  return join(stateDir, REGISTRE_BOTS_FICHIER);
}

/** Vrai si l'identifiant est utilisable comme nom de dossier de bot. */
export function estIdBot(value: unknown): value is string {
  return typeof value === "string" && ID_BOT_PATTERN.test(value);
}

/** Registre initial : UN bot (`yuki`), aucune paire d'échanges. */
export function creerRegistreInitial(
  options: { botId?: string; nom?: string; creeLe?: string } = {},
): RegistreBots {
  const botId = options.botId ?? BOT_YUKI;
  if (!estIdBot(botId)) {
    throw new RegistreBotsError(
      "INVALIDE",
      "",
      `Identifiant de bot invalide : ${JSON.stringify(botId)}`,
    );
  }
  return {
    schemaVersion: REGISTRE_BOTS_SCHEMA_VERSION,
    bots: [
      {
        id: botId,
        nom: options.nom ?? "Yuki",
        profil: "complet",
        actif: true,
        ordre: 0,
        creeLe: options.creeLe ?? new Date().toISOString(),
        plateformes: {},
      },
    ],
    echanges: {},
  };
}

/**
 * Lit le registre. Renvoie `null` s'il est ABSENT : c'est le signal du **mode
 * mono-bot historique** (le produit se comporte exactement comme avant).
 *
 * ⚠️ Un fichier PRÉSENT mais invalide LÈVE : retomber en silence sur le mode
 * mono-bot ferait écrire le bot actif aux anciens chemins, à côté des nouvelles
 * données — exactement la désynchronisation que ce lot doit rendre impossible.
 */
export function lireRegistreBots(path: string): RegistreBots | null {
  let texte: string;
  try {
    texte = readFileSync(path, "utf8");
  } catch (error) {
    if (estAbsent(error)) return null;
    throw new RegistreBotsError(
      "ILLISIBLE",
      path,
      `Registre des bots illisible (${path}) : ${messageOf(error)}`,
    );
  }
  let brut: unknown;
  try {
    brut = JSON.parse(texte);
  } catch (error) {
    throw new RegistreBotsError(
      "INVALIDE",
      path,
      `Registre des bots invalide (${path}) : JSON illisible — ${messageOf(error)}`,
    );
  }
  return validerRegistre(brut, path);
}

/**
 * Écriture ATOMIQUE (`tmp` + `rename`) en mode 0600. ⚠️ Partagée avec le
 * journal de migration (`src/bots/migrate.ts`) : une seule implémentation dans
 * ce dossier, comme `src/sources/store.ts:781-803`.
 */
export function ecrireFichierAtomique0600(path: string, texte: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, texte, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // Meilleur effort (systèmes de fichiers sans mode POSIX).
  }
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Meilleur effort.
  }
}

/** Écrit le registre de façon ATOMIQUE et en 0600. */
export function ecrireRegistreBots(path: string, registre: RegistreBots): void {
  const valide = validerRegistre(registre, path);
  const texte = `${JSON.stringify(valide, null, 2)}\n`;
  try {
    ecrireFichierAtomique0600(path, texte);
  } catch (error) {
    throw new RegistreBotsError(
      "ECRITURE",
      path,
      `Écriture du registre des bots impossible (${path}) : ${messageOf(error)}`,
    );
  }
}

/** Bot à activer : `yuki` s'il existe, sinon le premier ACTIF par `ordre`. */
export function botActif(registre: RegistreBots): BotRecord | null {
  const yuki = registre.bots.find((bot) => bot.id === BOT_YUKI);
  if (yuki) return yuki;
  const actifs = registre.bots
    .filter((bot) => bot.actif)
    .sort((a, b) => a.ordre - b.ordre);
  return actifs[0] ?? null;
}

// --- Validation -----------------------------------------------------------

function validerRegistre(brut: unknown, path: string): RegistreBots {
  function invalide(message: string): never {
    throw new RegistreBotsError(
      "INVALIDE",
      path,
      `Registre des bots invalide (${path}) : ${message}`,
    );
  }
  if (typeof brut !== "object" || brut === null || Array.isArray(brut)) {
    invalide("objet JSON attendu");
  }
  const obj = brut as Record<string, unknown>;
  const version = obj["schemaVersion"];
  if (version !== REGISTRE_BOTS_SCHEMA_VERSION) {
    invalide(
      `schemaVersion attendue ${REGISTRE_BOTS_SCHEMA_VERSION}, reçue ${JSON.stringify(version)}`,
    );
  }
  const botsBruts = obj["bots"];
  if (!Array.isArray(botsBruts) || botsBruts.length === 0) {
    invalide("`bots` doit être une liste non vide");
  }
  const bots: BotRecord[] = [];
  const vus = new Set<string>();
  for (const [index, entree] of (botsBruts as unknown[]).entries()) {
    if (typeof entree !== "object" || entree === null || Array.isArray(entree)) {
      invalide(`bots[${index}] doit être un objet`);
    }
    const bot = entree as Record<string, unknown>;
    const id = bot["id"];
    if (!estIdBot(id)) {
      invalide(`bots[${index}].id invalide : ${JSON.stringify(id)}`);
    }
    if (vus.has(id)) invalide(`bots[${index}].id dupliqué : ${JSON.stringify(id)}`);
    vus.add(id);
    const nom = bot["nom"];
    if (typeof nom !== "string" || nom.trim() === "") {
      invalide(`bots[${index}].nom doit être une chaîne non vide`);
    }
    const profil = bot["profil"];
    if (profil !== "complet") {
      invalide(`bots[${index}].profil inconnu : ${JSON.stringify(profil)}`);
    }
    const actif = bot["actif"];
    if (typeof actif !== "boolean") {
      invalide(`bots[${index}].actif doit être un booléen`);
    }
    const ordre = bot["ordre"];
    if (typeof ordre !== "number" || !Number.isInteger(ordre) || ordre < 0) {
      invalide(`bots[${index}].ordre doit être un entier ≥ 0`);
    }
    const creeLe = bot["creeLe"];
    if (typeof creeLe !== "string" || Number.isNaN(Date.parse(creeLe))) {
      invalide(`bots[${index}].creeLe doit être une date ISO 8601`);
    }
    const plateformes = bot["plateformes"];
    if (
      typeof plateformes !== "object" ||
      plateformes === null ||
      Array.isArray(plateformes)
    ) {
      invalide(`bots[${index}].plateformes doit être un objet`);
    }
    bots.push({
      id,
      nom,
      profil: "complet",
      actif,
      ordre,
      creeLe,
      plateformes: { ...(plateformes as Record<string, unknown>) },
    });
  }
  const echangesBruts = obj["echanges"];
  if (
    echangesBruts === undefined
  ) {
    // Tolérance de lecture : un registre écrit avant l'ajout du champ reste
    // lisible ; il est réécrit avec `echanges: {}` à la première écriture.
  } else if (
    typeof echangesBruts !== "object" ||
    echangesBruts === null ||
    Array.isArray(echangesBruts)
  ) {
    invalide("`echanges` doit être un objet");
  }
  const echanges: Record<string, EchangeBots> = {};
  for (const [cle, valeur] of Object.entries(
    (echangesBruts ?? {}) as Record<string, unknown>,
  )) {
    if (typeof valeur !== "object" || valeur === null || Array.isArray(valeur)) {
      invalide(`echanges[${JSON.stringify(cle)}] doit être un objet`);
    }
    const paire = valeur as Record<string, unknown>;
    for (const champ of Object.keys(paire)) {
      if (champ !== "actif") {
        // ⚠️ Aucun plafond n'est accepté ici : seul le bouton `actif` est un
        // garde-fou (pas de frein par paire). Un champ inconnu est une ERREUR
        // de schéma, pas un réglage ignoré.
        invalide(`echanges[${JSON.stringify(cle)}] : champ inconnu ${JSON.stringify(champ)}`);
      }
    }
    const actif = paire["actif"];
    if (typeof actif !== "boolean") {
      invalide(`echanges[${JSON.stringify(cle)}].actif doit être un booléen`);
    }
    echanges[cle] = { actif };
  }
  return { schemaVersion: REGISTRE_BOTS_SCHEMA_VERSION, bots, echanges };
}

function estAbsent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Vrai si le registre existe sur le disque. */
export function registreBotsExiste(stateDir: string): boolean {
  return existsSync(cheminRegistreBots(stateDir));
}
