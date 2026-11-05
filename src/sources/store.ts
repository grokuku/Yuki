/**
 * `SourcesStore` — registre des DÉCLENCHEURS (programmes autorisés à réveiller
 * Yuki). Modèle **v2** (`schemaVersion: 2`).
 *
 * ⚠️ Fichier JSON DÉDIÉ sur le volume `state` (`sources.json`), JAMAIS dans
 * `config.json` : `PUT /api/config` n'accepte qu'un patch PLAT de scalaires
 * (`src/config/schema.ts:660`), une liste de sources n'y a donc pas sa place.
 *
 * Écriture ATOMIQUE (`tmp` + `rename`) en mode 0600. ⚠️ Le JETON d'une source
 * n'est JAMAIS ici : il vit dans le COFFRE (`YUKI_SOURCE_<NOM>`) ; ce fichier ne
 * retient que la DATE de création (`jetonCree`).
 *
 * ## ⚠️ MIGRATION v1 → v2 (le fichier est en PRODUCTION)
 *  - lecture : un fichier `schemaVersion: 1` est CONVERTI en mémoire PUIS réécrit ;
 *  - **avant** toute réécriture, le texte d'origine est copié UNE SEULE FOIS dans
 *    `sources.json.v1.bak` (jamais écrasé : s'il existe, on n'y touche plus) ;
 *  - ⚠️ AUCUN enregistrement n'est perdu : un enregistrement inexploitable est
 *    conservé VERBATIM sous `invalides` et journalisé (`sources.store.migrate.*`) ;
 *  - tout enregistrement v1 (`tour`/`conversation`/`notifier`) devient
 *    `visibilite: "visible"` : on ne change JAMAIS le comportement existant sans
 *    le dire ;
 *  - relecture d'un fichier v2 : AUCUNE réécriture (idempotence totale).
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
  DEFAULT_FUSEAU,
  DEFAULT_MAX_TOURS_PAR_JOUR,
  DEFAULT_PLAFOND_MS,
  DEFAULT_SOURCE_CHEVAUCHEMENT,
  DEFAULT_SOURCE_DECLENCHEUR,
  DEFAULT_SOURCE_RATTRAPAGE,
  DEFAULT_SOURCE_VISIBILITE,
  isSourceChevauchement,
  isSourceDeclencheurPlanning,
  isSourceDeclencheurPonctuel,
  isSourceDeclencheurWebhook,
  isSourceDestination,
  isSourceRattrapage,
  isSourceSessionTarget,
  isSourceVisibilite,
  MAX_CONSIGNE_CHARS,
  MAX_ETAPES_CHAINE,
  MAX_FICHIERS_ETAPE,
  MAX_INSTRUCTION_TACHE_CHARS,
  MAX_OCCURRENCES,
  MAX_PLAFOND_MS,
  MAX_SOURCES,
  MAX_TACHES_PONCTUELLES,
  MAX_TEXTE_ETAPE_CHARS,
  MAX_TOURS_PAR_JOUR_LIMITE,
  MIN_ETAPES_CHAINE,
  MIN_OCCURRENCES,
  MIN_PLAFOND_MS,
  RESERVED_SOURCE_NAMES,
  SOURCE_NAME_PATTERN,
  type ResultatEtape,
  type SourceChaine,
  type SourceChevauchement,
  type SourceConversation,
  type SourceDeclencheur,
  type SourceRattrapage,
  type SourceRecord,
  type SourceSerieEchecs,
  type SourceSettingsInput,
  type SourceTurn,
  type SourceView,
  type SourceVisibilite,
} from "./types.js";
import { parseCron, validateFuseau } from "./cron.js";

/** Version courante du fichier (`v2` = `visibilite` + `declencheur`). */
export const SOURCES_STORE_SCHEMA_VERSION = 2;

/** Version historique (lot 17) : `conversation` + `tour` + `notifier` seulement. */
export const SOURCES_STORE_LEGACY_VERSION = 1;

/** Sauvegarde du fichier v1, écrite UNE SEULE FOIS, jamais écrasée. */
export const SOURCES_STORE_BACKUP_SUFFIX = ".v1.bak";

interface SourcesStoreFile {
  schemaVersion: number;
  sources: SourceRecord[];
  /**
   * ⚠️ Fil UNIQUE et partagé de tous les déclencheurs silencieux (créé au premier
   * résultat NON VIDE seulement). Persisté ici : il survit à un redémarrage.
   */
  declencheurs?: { sessionId?: string };
  /**
   * Enregistrements d'un `sources.json` antérieur qu'on n'a NI compris NI
   * supprimés : ils sont conservés VERBATIM (aucune perte lors d'une migration).
   */
  invalides?: unknown[];
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

/**
 * BORNE DES TÂCHES PONCTUELLES atteinte (lot 31).
 *
 * ⚠️ Erreur DISTINCTE de `SourcesFullError` : le message doit dire QUELLE borne est
 * atteinte, sinon l'utilisateur supprimerait un déclencheur durable sans effet.
 */
export class TachesPonctuellesFullError extends Error {
  override readonly name = "TachesPonctuellesFullError";
  constructor(readonly limit: number) {
    super(
      `Le nombre maximal de tâches ponctuelles est atteint (${limit}). Attends qu'une ` +
        "tâche s'exécute (elle s'éteint toute seule), ou supprime-en une dans " +
        "Configuration → Déclencheurs.",
    );
  }
}

/**
 * Création d'une CHAÎNE REFUSÉE faute de place (lot 33).
 *
 * ⚠️ Erreur DISTINCTE de `SourcesFullError` : le message doit dire COMBIEN de places il
 * reste et COMBIEN d'étapes ont été demandées, sinon on ne comprend pas pourquoi AUCUNE
 * étape n'a été créée (la création est atomique : tout ou rien).
 */
export class ChainesFullError extends Error {
  override readonly name = "ChainesFullError";
  constructor(
    readonly placesRestantes: number,
    readonly demandees: number,
  ) {
    super(
      `Chaîne refusée : il reste ${placesRestantes} place(s) de déclencheur et la chaîne ` +
        `en demande ${demandees}. Rien n'a été créé : supprime un déclencheur ou réduis la chaîne.`,
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
      `Le nom « ${nom} » est réservé par l'API (boîte de notifications, envois ` +
        "programmés). Choisissez-en un autre.",
    );
  }
  return nom;
}

function isTurn(value: unknown): value is SourceTurn {
  return value === "lancer" || value === "stocker";
}

/**
 * SLUG d'un libellé libre, utilisable comme nom de source (lot 31).
 *
 * ⚠️ POURQUOI UN SLUG PLUTÔT QUE LE LIBELLÉ BRUT : le `nom` sert d'identifiant stable
 * (URL `DELETE /api/sources/<nom>`, indexation des pré-autorisations, nom du secret de
 * coffre). Il doit donc être borné (`SOURCE_NAME_PATTERN`, 32 caractères) et ne pas
 * dépendre des accents ou de la ponctuation. Le libellé HUMAIN est conservé à côté
 * (`libelle`) et c'est lui que l'interface affiche.
 *
 * « Résumé du journal ! » ⇒ `resume-du-journal`. Un libellé entièrement composé de
 * caractères refusés rend `tache` (jamais un nom vide).
 */
export function slugifierNomTache(libelle: string): string {
  const base = (typeof libelle === "string" ? libelle : "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    // ⚠️ 24 caractères : il doit rester la place du suffixe de déduplication (`-12`).
    .slice(0, 24)
    .replace(/-+$/g, "");
  if (base === "") return "tache";
  // ⚠️ `inbox` et `envois` sont RÉSERVÉS par l'API : un libellé qui tombe dessus doit
  // être décalé, sinon la tâche serait impossible à créer (et l'erreur incompréhensible).
  if (RESERVED_SOURCE_NAMES.includes(base)) return `${base}-tache`;
  return base;
}

/**
 * Normalise un déclencheur RELU (fichier existant) — ⚠️ sans perdre une
 * planification : un `planning` valide est conservé tel quel ; un `planning`
 * illisible retombe sur `webhook` **et le dit** (jamais un déclencheur muet).
 *
 * ⚠️ LOT 31 : un `ponctuel` dont la date est illisible est traité de la même façon —
 * mais il est d'abord RAMENÉ À L'ÉTAT « éteint » par le balayeur (aucune tâche ne peut
 * tirer sans date).
 */
function storedDeclencheur(value: unknown, logger?: SourcesStoreLogger): SourceDeclencheur {
  if (isSourceDeclencheurWebhook(value)) return { type: "webhook" };
  if (isSourceDeclencheurPonctuel(value)) {
    const at = Date.parse(value.a);
    if (Number.isFinite(at)) {
      let fuseau = DEFAULT_FUSEAU;
      if (value.fuseau !== undefined) {
        try {
          fuseau = validateFuseau(value.fuseau, DEFAULT_FUSEAU);
        } catch {
          fuseau = DEFAULT_FUSEAU;
        }
      }
      return { type: "ponctuel", a: new Date(at).toISOString(), fuseau };
    }
    logger?.warn("sources.store.declencheur.invalid", { raison: "date ponctuelle illisible" });
    return { ...DEFAULT_SOURCE_DECLENCHEUR };
  }
  if (isSourceDeclencheurPlanning(value)) {
    try {
      const expression = parseCron(value.expression).source;
      const fuseau = validateFuseau(value.fuseau);
      return { type: "planning", expression, fuseau };
    } catch (error) {
      logger?.warn("sources.store.declencheur.invalid", {
        raison: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { ...DEFAULT_SOURCE_DECLENCHEUR };
}

/** Objet JSON simple (ni tableau, ni `null`). */
function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Normalise un enregistrement relu (v1 OU v2) — ⚠️ SANS RIEN PERDRE : les champs
 * inconnus (et les champs réservés au lot 2) sont recopiés tels quels.
 *
 * Renvoie `undefined` seulement si l'enregistrement n'a AUCUNE identité (pas de
 * `nom` exploitable) : l'appelant le conserve alors verbatim dans `invalides`.
 */
function normalizeRecord(
  raw: unknown,
  logger: SourcesStoreLogger | undefined,
): SourceRecord | undefined {
  const entry = asObject(raw);
  if (!entry) {
    logger?.warn("sources.store.migrate.entry_invalid", { raison: "enregistrement non objet" });
    return undefined;
  }
  const nom = typeof entry["nom"] === "string" ? entry["nom"] : "";
  if (nom.trim() === "") {
    logger?.warn("sources.store.migrate.entry_without_name", { raison: "nom absent" });
    return undefined;
  }
  if (!SOURCE_NAME_PATTERN.test(nom)) {
    // Le nom ne respecte pas la forme attendue : on le CONSERVE quand même (c'est
    // l'utilisateur qui devra le corriger), mais on le DIT.
    logger?.warn("sources.store.migrate.entry_name_unexpected", { nom });
  }
  // ⚠️ Règle de migration : un enregistrement écrit par le lot 17 porte
  // `conversation`, `tour` et/ou `notifier` ⇒ il était VISIBLE. On ne change
  // JAMAIS son comportement dans son dos.
  const legacyShape =
    entry["conversation"] !== undefined ||
    entry["destination"] !== undefined ||
    entry["tour"] !== undefined ||
    entry["notifier"] !== undefined;
  const visibilite: SourceVisibilite = isSourceVisibilite(entry["visibilite"])
    ? entry["visibilite"]
    : legacyShape
      ? "visible"
      : DEFAULT_SOURCE_VISIBILITE;
  const preAutorisations = Array.isArray(entry["preAutorisations"])
    ? entry["preAutorisations"].filter((value): value is string => typeof value === "string")
    : [];
  const next: Record<string, unknown> = { ...entry };
  // Le champ v1 n'a plus de sens en v2 (il a été converti en `destination`).
  delete next["conversation"];
  Object.assign(next, {
    nom,
    declencheur: storedDeclencheur(entry["declencheur"], logger),
    consigne: typeof entry["consigne"] === "string" ? entry["consigne"] : "",
    visibilite,
    destination: storedConversation(entry["destination"] ?? entry["conversation"]),
    tour: isTurn(entry["tour"]) ? entry["tour"] : "stocker",
    // ⚠️ Invariant du modèle : un déclencheur silencieux ne notifie JAMAIS.
    notifier: visibilite === "silencieux" ? false : entry["notifier"] !== false,
    preAutorisations,
    chevauchement: isSourceChevauchement(entry["chevauchement"])
      ? entry["chevauchement"]
      : DEFAULT_SOURCE_CHEVAUCHEMENT,
    rattrapage: isSourceRattrapage(entry["rattrapage"])
      ? entry["rattrapage"]
      : DEFAULT_SOURCE_RATTRAPAGE,
    plafondMs: storedPlafond(entry["plafondMs"]),
    maxToursParJour: storedMaxTours(entry["maxToursParJour"]),
    actif: entry["actif"] !== false,
    etat: entry["actif"] === false ? "suspendu" : "actif",
    ...(typeof entry["desactiveLe"] === "string" ? { desactiveLe: entry["desactiveLe"] } : {}),
    ...(storedJetons(entry["jetonsCumules"]) !== undefined
      ? { jetonsCumules: storedJetons(entry["jetonsCumules"]) }
      : {}),
    // ── LOT 31/32 : champs relus avec leur TYPE vérifié (jamais une chaîne dans un
    // compteur, jamais une série d'échecs à moitié lue).
    ...(storedOccurrences(entry["occurrencesFaites"]) !== undefined
      ? { occurrencesFaites: storedOccurrences(entry["occurrencesFaites"]) }
      : {}),
    ...(storedOccurrences(entry["occurrencesMax"]) !== undefined
      ? { occurrencesMax: storedOccurrences(entry["occurrencesMax"]) }
      : {}),
    ...(storedIso(entry["jusquAu"]) !== undefined ? { jusquAu: storedIso(entry["jusquAu"]) } : {}),
    ...(storedSerieEchecs(entry["serieEchecs"]) !== undefined
      ? { serieEchecs: storedSerieEchecs(entry["serieEchecs"]) }
      : {}),
    // ── LOT 33 : chaîne d'étapes + résultat conservé pour l'étape suivante.
    ...(storedChaine(entry["chaine"]) !== undefined ? { chaine: storedChaine(entry["chaine"]) } : {}),
    ...(storedResultatEtape(entry["resultatEtape"]) !== undefined
      ? { resultatEtape: storedResultatEtape(entry["resultatEtape"]) }
      : {}),
    ...(typeof entry["libelle"] === "string" && entry["libelle"].trim() !== ""
      ? { libelle: entry["libelle"].trim() }
      : {}),
    ...(entry["perso"] === true ? { perso: true } : {}),
    cree: typeof entry["cree"] === "string" ? entry["cree"] : "",
    maj: typeof entry["maj"] === "string" ? entry["maj"] : "",
  });
  return next as unknown as SourceRecord;
}

/** Entier positif relu d'un compteur (`occurrencesFaites`, `occurrencesMax`). */
function storedOccurrences(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.trunc(value));
}

/** Instant ISO relu (`jusquAu`), ou `undefined` s'il est illisible. */
function storedIso(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined;
}

/**
 * Chaîne relue : un `id` non vide et un rang d'étape entier ≥ 1, sinon `undefined`.
 *
 * ⚠️ Une appartenance à moitié lue (`{ id }` sans `etape`) est JETÉE : elle ferait
 * croire à une étape intermédiaire et l'affichage mentirait sur l'ordre.
 */
function storedChaine(value: unknown): SourceChaine | undefined {
  const raw = asObject(value);
  if (!raw) return undefined;
  const id = typeof raw["id"] === "string" ? raw["id"].trim() : "";
  const etape = raw["etape"];
  if (id === "" || typeof etape !== "number" || !Number.isInteger(etape) || etape < 1) {
    return undefined;
  }
  const apres = typeof raw["apres"] === "string" && raw["apres"].trim() !== "" ? raw["apres"].trim() : undefined;
  return { id, etape, ...(apres !== undefined ? { apres } : {}) };
}

/**
 * Résultat d'étape relu — et REBORNÉ à la lecture (un fichier écrit à la main ne doit pas
 * injecter 50 000 caractères dans le prompt de la tâche suivante).
 */
function storedResultatEtape(value: unknown): ResultatEtape | undefined {
  const raw = asObject(value);
  if (!raw) return undefined;
  const at = storedIso(raw["at"]);
  if (at === undefined) return undefined;
  const jobId = typeof raw["jobId"] === "string" ? raw["jobId"] : "";
  const texteBrut = typeof raw["texte"] === "string" ? raw["texte"] : "";
  const texte =
    texteBrut.length > MAX_TEXTE_ETAPE_CHARS ? texteBrut.slice(0, MAX_TEXTE_ETAPE_CHARS) : texteBrut;
  const fichiers = Array.isArray(raw["fichiers"])
    ? raw["fichiers"]
        .filter((id): id is string => typeof id === "string" && id.trim() !== "")
        .slice(0, MAX_FICHIERS_ETAPE)
    : [];
  return { jobId, texte, fichiers, at };
}

/** Série d'échecs relue : trois champs cohérents, sinon `undefined` (jamais à moitié). */
function storedSerieEchecs(value: unknown): SourceSerieEchecs | undefined {
  const raw = asObject(value);
  if (!raw) return undefined;
  const raison = raw["raison"];
  const debut = storedIso(raw["debut"]);
  const tentatives = storedOccurrences(raw["tentatives"]);
  if (typeof raison !== "string" || debut === undefined || tentatives === undefined) {
    return undefined;
  }
  return { raison, debut, tentatives: Math.max(1, tentatives) };
}

/**
 * Plafond RELU : une valeur hors bornes est ramenée dans les bornes (un fichier
 * écrit à la main ne doit pas rendre un déclencheur inarrêtable).
 */
function storedPlafond(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_PLAFOND_MS;
  return Math.min(MAX_PLAFOND_MS, Math.max(MIN_PLAFOND_MS, Math.trunc(value)));
}

/** Garde-fou quotidien RELU : ramené dans les bornes (jamais 0, jamais infini). */
function storedMaxTours(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_MAX_TOURS_PAR_JOUR;
  return Math.min(MAX_TOURS_PAR_JOUR_LIMITE, Math.max(1, Math.trunc(value)));
}

/**
 * Compteurs de JETONS relus : deux entiers positifs, sinon `undefined` (un fichier
 * abîmé ne doit pas injecter de chaîne dans un compteur).
 */
function storedJetons(value: unknown): { entree: number; sortie: number } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const entree = raw["entree"];
  const sortie = raw["sortie"];
  if (typeof entree !== "number" || typeof sortie !== "number") return undefined;
  if (!Number.isFinite(entree) || !Number.isFinite(sortie)) return undefined;
  return { entree: Math.max(0, Math.trunc(entree)), sortie: Math.max(0, Math.trunc(sortie)) };
}

/**
 * Valide un DÉCLENCHEUR fourni par l'API — ⚠️ REFUS explicite d'une expression
 * cron invalide (avec la raison) ou d'un fuseau inconnu : on ne stocke jamais un
 * déclencheur qui ne pourrait pas tirer.
 */
export function validateDeclencheur(value: unknown): SourceDeclencheur {
  if (isSourceDeclencheurWebhook(value)) return { type: "webhook" };
  if (isSourceDeclencheurPonctuel(value)) {
    const at = Date.parse(value.a);
    if (!Number.isFinite(at)) {
      throw new SourceValidationError(
        "invalid_declencheur",
        `Date de tâche ponctuelle illisible : « ${value.a} ». Un instant ISO est attendu.`,
      );
    }
    let fuseau = DEFAULT_FUSEAU;
    try {
      fuseau = validateFuseau(value.fuseau ?? DEFAULT_FUSEAU, DEFAULT_FUSEAU);
    } catch (error) {
      throw new SourceValidationError(
        "invalid_fuseau",
        error instanceof Error ? error.message : String(error),
      );
    }
    return { type: "ponctuel", a: new Date(at).toISOString(), fuseau };
  }
  if (!isSourceDeclencheurPlanning(value)) {
    throw new SourceValidationError(
      "invalid_declencheur",
      'Déclencheur invalide : « { type: "webhook" } », ' +
        '« { type: "planning", expression, fuseau } » ou ' +
        '« { type: "ponctuel", a } » attendu.',
    );
  }
  let expression: string;
  try {
    expression = parseCron(value.expression).source;
  } catch (error) {
    throw new SourceValidationError(
      "invalid_expression",
      error instanceof Error ? error.message : String(error),
    );
  }
  let fuseau: string;
  try {
    fuseau = validateFuseau(value.fuseau, DEFAULT_FUSEAU);
  } catch (error) {
    throw new SourceValidationError(
      "invalid_fuseau",
      error instanceof Error ? error.message : String(error),
    );
  }
  return { type: "planning", expression, fuseau };
}

/** Politique de chevauchement VALIDÉE (refus explicite d'une valeur inconnue). */
function validateChevauchement(value: unknown): SourceChevauchement {
  if (isSourceChevauchement(value)) return value;
  throw new SourceValidationError(
    "invalid_chevauchement",
    'Chevauchement invalide : "sauter" ou "remplacer" attendu.',
  );
}

/** Politique de rattrapage VALIDÉE (refus explicite d'une valeur inconnue). */
function validateRattrapage(value: unknown): SourceRattrapage {
  if (isSourceRattrapage(value)) return value;
  throw new SourceValidationError(
    "invalid_rattrapage",
    'Rattrapage invalide : "sauter" ou "rattraper" attendu.',
  );
}

/** Plafond d'exécution VALIDÉ (bornes 60 s – 2 h, refus hors bornes). */
function validatePlafond(value: unknown): number {
  const nombre = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(nombre) || !Number.isInteger(nombre)) {
    throw new SourceValidationError(
      "invalid_plafond",
      "Plafond invalide : nombre entier de millisecondes attendu.",
    );
  }
  if (nombre < MIN_PLAFOND_MS || nombre > MAX_PLAFOND_MS) {
    throw new SourceValidationError(
      "invalid_plafond",
      `Plafond hors bornes : ${nombre} ms (autorisé : ${MIN_PLAFOND_MS} à ${MAX_PLAFOND_MS} ms, ` +
        "soit 60 s à 2 h).",
    );
  }
  return nombre;
}

/** Garde-fou quotidien VALIDÉ (1 à 1 000). */
function validateMaxTours(value: unknown): number {
  const nombre = typeof value === "number" ? value : Number.NaN;
  if (!Number.isInteger(nombre) || nombre < 1 || nombre > MAX_TOURS_PAR_JOUR_LIMITE) {
    throw new SourceValidationError(
      "invalid_max_tours",
      `Nombre maximal de tours invalide : entier de 1 à ${MAX_TOURS_PAR_JOUR_LIMITE} attendu.`,
    );
  }
  return nombre;
}

/**
 * Fin de récurrence par NOMBRE de passages VALIDÉE (1 à 10 000, lot 32).
 *
 * ⚠️ `null` est REFUSÉ comme « valeur absente déguisée » : pour retirer une fin de
 * récurrence, l'appelant envoie une chaîne vide dans l'API (`PUT /api/sources/:nom`) et
 * c'est la route qui traduit.
 */
function validateOccurrencesMax(value: unknown): number {
  const nombre = typeof value === "number" ? value : Number.NaN;
  if (!Number.isInteger(nombre) || nombre < MIN_OCCURRENCES || nombre > MAX_OCCURRENCES) {
    throw new SourceValidationError(
      "invalid_occurrences_max",
      `Fin de récurrence invalide : nombre entier de ${MIN_OCCURRENCES} à ${MAX_OCCURRENCES} ` +
        "passages attendu.",
    );
  }
  return nombre;
}

/** Fin de récurrence par DATE validée (ISO, lot 32). */
function validateJusquAu(value: unknown): string {
  const texte = typeof value === "string" ? value.trim() : "";
  const at = texte === "" ? Number.NaN : Date.parse(texte);
  if (!Number.isFinite(at)) {
    throw new SourceValidationError(
      "invalid_jusqu_au",
      `Date de fin de récurrence illisible : « ${texte} ». Un instant ISO est attendu.`,
    );
  }
  return new Date(at).toISOString();
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

/**
 * Valide une consigne libre (texte borné, jamais un secret).
 *
 * ⚠️ La BORNE dépend du TYPE (lot 31) : une tâche ponctuelle porte une DEMANDE complète
 * (`MAX_INSTRUCTION_TACHE_CHARS`, 4 000), un déclencheur durable une consigne de
 * surveillance (`MAX_CONSIGNE_CHARS`, 2 000). Une seule fonction, deux bornes explicites.
 */
function validateConsigne(value: unknown, maxChars: number = MAX_CONSIGNE_CHARS): string {
  if (typeof value !== "string") {
    throw new SourceValidationError("invalid_consigne", "La consigne doit être un texte.");
  }
  const consigne = value.replace(/\r\n?/g, "\n").trim();
  if (consigne.length > maxChars) {
    throw new SourceValidationError(
      "consigne_too_long",
      `Consigne trop longue : ${consigne.length} caractères, maximum ${maxChars}.`,
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
  /** Enregistrements d'un fichier antérieur qu'on n'a pas su lire (jamais jetés). */
  private invalides: unknown[] = [];
  /** Fil unique et partagé des déclencheurs silencieux (voir `setDeclencheursSession`). */
  private declencheursSessionId: string | undefined;

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

  /**
   * Nombre de DÉCLENCHEURS DURABLES (`webhook` + `planning`) — ceux que borne
   * `MAX_SOURCES`.
   *
   * ⚠️ LOT 31 : une tâche PONCTUELLE ne se compte PAS ici ; elle s'éteint après son
   * tir et a sa propre borne (`MAX_TACHES_PONCTUELLES`).
   */
  get sourcesDurables(): number {
    return this.records.filter((record) => record.declencheur.type !== "ponctuel").length;
  }

  /** Nombre de tâches PONCTUELLES persistées (vivantes ou terminées non purgées). */
  get tachesPonctuelles(): number {
    return this.records.filter((record) => record.declencheur.type === "ponctuel").length;
  }

  /** Chemin de la sauvegarde v1 (écrite une seule fois, lors de la migration). */
  get backupPath(): string {
    return `${this.path}${SOURCES_STORE_BACKUP_SUFFIX}`;
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
    let parsed: Partial<SourcesStoreFile>;
    try {
      parsed = JSON.parse(text) as Partial<SourcesStoreFile>;
    } catch (error) {
      this.logger?.warn("sources.store.invalid", { path: this.path, error: messageOf(error) });
      return [];
    }
    if (!Array.isArray(parsed.sources)) {
      this.logger?.warn("sources.store.invalid", { path: this.path, reason: "schéma inattendu" });
      return [];
    }
    const version = typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : 0;
    const rawDeclencheurs = asObject(parsed.declencheurs);
    const sessionId = rawDeclencheurs?.["sessionId"];
    if (typeof sessionId === "string" && sessionId !== "") this.declencheursSessionId = sessionId;
    this.invalides = Array.isArray(parsed.invalides) ? parsed.invalides : [];

    const records: SourceRecord[] = [];
    for (const entry of parsed.sources) {
      const normalized = normalizeRecord(entry, this.logger);
      if (normalized) records.push(normalized);
      else this.invalides.push(entry);
    }

    if (version === SOURCES_STORE_SCHEMA_VERSION) {
      // ⚠️ IDEMPOTENCE : un fichier déjà en v2 n'est JAMAIS réécrit à la lecture.
      return records;
    }

    // ⚠️ MIGRATION v1 → v2 : sauvegarde d'abord, réécriture ensuite.
    this.backupLegacy(text);
    this.logger?.warn("sources.store.migrated", {
      path: this.path,
      from: version,
      to: SOURCES_STORE_SCHEMA_VERSION,
      sources: records.length,
      conservees_telles_quelles: this.invalides.length,
      backup: this.backupPath,
    });
    this.records = records;
    this.persist();
    return records;
  }

  /**
   * Copie le fichier d'origine dans `<path>.v1.bak` — ⚠️ UNE SEULE FOIS : si la
   * sauvegarde existe déjà, elle n'est jamais écrasée (elle est peut-être la
   * dernière trace d'un fichier que l'utilisateur veut récupérer).
   */
  private backupLegacy(text: string): void {
    const target = this.backupPath;
    if (existsSync(target)) return;
    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text, { mode: 0o600 });
      try {
        chmodSync(target, 0o600);
      } catch {
        // Meilleur effort.
      }
    } catch (error) {
      // ⚠️ Pas de sauvegarde, pas de migration : on préfère un fichier v1 intact
      // à une réécriture sans filet.
      this.logger?.warn("sources.store.backup.failed", { path: target, error: messageOf(error) });
      throw error;
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    const file: SourcesStoreFile = {
      schemaVersion: SOURCES_STORE_SCHEMA_VERSION,
      sources: this.records,
      ...(this.declencheursSessionId !== undefined
        ? { declencheurs: { sessionId: this.declencheursSessionId } }
        : {}),
      ...(this.invalides.length > 0 ? { invalides: this.invalides } : {}),
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

  /**
   * Fil UNIQUE et PARTAGÉ de tous les déclencheurs silencieux (`undefined` tant
   * qu'aucun résultat n'a été publié : on ne crée jamais un fil vide).
   */
  getDeclencheursSession(): string | undefined {
    return this.declencheursSessionId;
  }

  /** Mémorise (ou oublie) le fil « Déclencheurs » (⚠️ fil NORMAL, visible). */
  setDeclencheursSession(sessionId: string | undefined): void {
    if (sessionId === this.declencheursSessionId) return;
    if (sessionId === undefined || sessionId === "") delete this.declencheursSessionId;
    else this.declencheursSessionId = sessionId;
    this.persist();
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
   * Nom LIBRE dérivé d'un libellé : `resume-du-journal`, puis `resume-du-journal-2`,
   * `-3`… ⚠️ Jamais un écrasement : deux tâches demandées le même jour avec le même
   * libellé coexistent, chacune avec son nom.
   */
  nomLibrePour(libelle: string): string {
    const base = slugifierNomTache(libelle);
    if (!this.has(base)) return base;
    for (let rang = 2; rang < 1_000; rang += 1) {
      const suffixe = `-${rang}`;
      const candidat = `${base.slice(0, 32 - suffixe.length).replace(/-+$/g, "")}${suffixe}`;
      if (!this.has(candidat)) return candidat;
    }
    // ⚠️ Inatteignable en pratique (borne `MAX_TACHES_PONCTUELLES`), mais on ne renvoie
    // jamais un nom déjà pris : un nom horodaté est toujours libre.
    return `tache-${Date.now().toString(36)}`.slice(0, 32);
  }

  /**
   * Nom LIBRE dérivé d'un libellé, en tenant compte des noms DÉJÀ RÉSERVÉS dans le lot
   * en cours de construction (création d'une chaîne : deux étapes ne peuvent pas porter
   * le même nom).
   */
  private nomLibreParmi(libelle: string, pris: Set<string>): string {
    const base = slugifierNomTache(libelle);
    if (!this.has(base) && !pris.has(base)) return base;
    for (let rang = 2; rang < 1_000; rang += 1) {
      const suffixe = `-${rang}`;
      const candidat = `${base.slice(0, 32 - suffixe.length).replace(/-+$/g, "")}${suffixe}`;
      if (!this.has(candidat) && !pris.has(candidat)) return candidat;
    }
    return `tache-${Date.now().toString(36)}`.slice(0, 32);
  }

  /**
   * Crée une CHAÎNE D'ÉTAPES — **ATOMIQUE** : tout ou rien.
   *
   * ⚠️ POURQUOI ATOMIQUE : une chaîne à moitié créée (étape 1 présente, étape 3 refusée)
   * serait pire qu'aucune chaîne — l'étape 1 enverrait son résultat à personne et la
   * personne croirait la chaîne en place. Toutes les validations et le QUOTA sont donc
   * vérifiés AVANT la moindre écriture, puis les étapes sont poussées en UNE fois.
   *
   * ⚠️ Chaque étape est un `planning` NORMAL (cron + fuseau) : elle consomme une place de
   * `MAX_SOURCES`. Une chaîne de 3 étapes sur 1 place libre crée donc 0 étape.
   */
  createChaine(input: {
    id: string;
    libelle?: string;
    etapes: Array<{
      libelle: string;
      consigne: string;
      declencheur: SourceDeclencheur;
      occurrencesMax?: number;
      jusquAu?: string;
    }>;
  }): SourceRecord[] {
    const etapes = Array.isArray(input.etapes) ? input.etapes : [];
    if (etapes.length < MIN_ETAPES_CHAINE || etapes.length > MAX_ETAPES_CHAINE) {
      throw new SourceValidationError(
        "invalid_chaine",
        `Chaîne invalide : de ${MIN_ETAPES_CHAINE} à ${MAX_ETAPES_CHAINE} étapes attendues ` +
          `(reçu : ${etapes.length}).`,
      );
    }
    const id = typeof input.id === "string" ? input.id.trim() : "";
    if (id === "") {
      throw new SourceValidationError("invalid_chaine", "Chaîne invalide : identifiant manquant.");
    }
    // ① VALIDATION COMPLÈTE (déclencheur, consigne, bornes) — aucune écriture encore.
    const prepares = etapes.map((etape, index) => {
      const declencheur = validateDeclencheur(etape.declencheur);
      if (declencheur.type !== "planning") {
        throw new SourceValidationError(
          "invalid_chaine",
          `Étape ${index + 1} : un déclencheur « planning » (expression + fuseau) est attendu — ` +
            "une étape de chaîne a un HORAIRE.",
        );
      }
      const libelle = typeof etape.libelle === "string" ? etape.libelle.trim() : "";
      // La consigne d'une étape est bornée comme celle d'un déclencheur durable.
      const consigne = validateConsigne(etape.consigne, MAX_CONSIGNE_CHARS);
      const occurrencesMax =
        etape.occurrencesMax !== undefined ? validateOccurrencesMax(etape.occurrencesMax) : undefined;
      const jusquAu = etape.jusquAu !== undefined ? validateJusquAu(etape.jusquAu) : undefined;
      return { libelle, consigne, declencheur, occurrencesMax, jusquAu, index };
    });
    // ② QUOTA : les étapes sont des déclencheurs DURABLES.
    const places = Math.max(0, MAX_SOURCES - this.sourcesDurables);
    if (prepares.length > places) {
      throw new ChainesFullError(places, prepares.length);
    }
    // ③ NOMS : slugifiés, dédupliqués entre eux ET par rapport au registre existant.
    const pris = new Set<string>();
    const noms = prepares.map((etape) => {
      const nom = this.nomLibreParmi(etape.libelle, pris);
      pris.add(nom);
      return nom;
    });
    // ④ CONSTRUCTION en mémoire, puis UNE SEULE écriture (atomicité réelle).
    const at = new Date(this.now()).toISOString();
    const records = prepares.map((etape, index) =>
      this.construire(
        noms[index] as string,
        {
          declencheur: etape.declencheur,
          consigne: etape.consigne,
          // ⚠️ SILENCIEUX : c'est le RÉSULTAT qui est publié, jamais le contenu reçu.
          visibilite: "silencieux",
          ...(etape.libelle !== "" ? { libelle: etape.libelle } : {}),
          ...(etape.occurrencesMax !== undefined ? { occurrencesMax: etape.occurrencesMax } : {}),
          ...(etape.jusquAu !== undefined ? { jusquAu: etape.jusquAu } : {}),
          chaine: {
            id,
            etape: index + 1,
            ...(index > 0 ? { apres: noms[index - 1] as string } : {}),
          },
        },
        at,
      ),
    );
    this.records.push(...records);
    this.persist();
    return records.map((record) => ({ ...record }));
  }

  /** Étapes d'une chaîne, DANS L'ORDRE (rang croissant). */
  etapesDeChaine(id: string): SourceRecord[] {
    return this.records
      .filter((record) => record.chaine?.id === id)
      .sort((a, b) => (a.chaine?.etape ?? 0) - (b.chaine?.etape ?? 0));
  }

  /**
   * Écrit le RÉSULTAT d'une étape, conservé pour la suivante (lot 33) — BORNÉ.
   *
   * ⚠️ Appelé APRÈS la publication : le texte conservé est celui que la personne a lu
   * (hors marqueurs de fichiers), et les identifiants de fichiers sont ceux du store de
   * la conversation, que le worker suivant ouvre avec `lire_fichier`.
   */
  enregistrerResultatEtape(
    nom: string,
    resultat: { jobId: string; texte: string; fichiers: readonly string[]; at: string },
  ): SourceRecord | undefined {
    const record = this.records.find((entry) => entry.nom === nom);
    if (!record) return undefined;
    const texte = typeof resultat.texte === "string" ? resultat.texte : "";
    record.resultatEtape = {
      jobId: typeof resultat.jobId === "string" ? resultat.jobId : "",
      texte: texte.length > MAX_TEXTE_ETAPE_CHARS ? texte.slice(0, MAX_TEXTE_ETAPE_CHARS) : texte,
      fichiers: (resultat.fichiers ?? [])
        .filter((fichier) => typeof fichier === "string" && fichier.trim() !== "")
        .slice(0, MAX_FICHIERS_ETAPE),
      at: resultat.at,
    };
    this.persist();
    return { ...record };
  }

  /**
   * Purge les chaînes ENTIÈREMENT terminées dont la dernière modification est plus
   * ancienne que `jours` — et **jamais** une étape en attente.
   *
   * ⚠️ RÈGLE ABSOLUE : une étape `actif !== false` n'est JAMAIS purgée (elle doit
   * encore tirer), et une étape dont la chaîne compte encore une étape active non plus
   * (la purger rendrait la suivante orpheline). Une chaîne incomplète (étape supprimée à
   * la main) n'est pas purgée tant qu'une étape reste active.
   *
   * ⚠️ Aucun minuteur ne l'appelle automatiquement : une source éteinte reste listée
   * indéfiniment, c'est la règle d'affichage. Cette méthode existe pour une purger
   * EXPLICITE (exploitation, test) et n'efface que des chaînes mortes.
   */
  purgerChainesTerminees(jours = 30): string[] {
    const retard = Math.max(1, Math.trunc(jours)) * 86_400_000;
    const maintenant = this.now();
    const parChaine = new Map<string, SourceRecord[]>();
    for (const record of this.records) {
      if (record.chaine === undefined) continue;
      const liste = parChaine.get(record.chaine.id) ?? [];
      liste.push(record);
      parChaine.set(record.chaine.id, liste);
    }
    const retires: string[] = [];
    for (const etapes of parChaine.values()) {
      // ⚠️ Une seule étape encore armée ⇒ on ne touche à RIEN.
      if (etapes.some((etape) => etape.actif !== false)) continue;
      const plusRecent = Math.max(
        ...etapes.map((etape) => {
          const at = Date.parse(etape.maj);
          return Number.isFinite(at) ? at : maintenant;
        }),
      );
      if (maintenant - plusRecent < retard) continue;
      for (const etape of etapes) retires.push(etape.nom);
    }
    if (retires.length === 0) return [];
    this.records = this.records.filter((record) => !retires.includes(record.nom));
    this.persist();
    return retires;
  }

  /**
   * Crée une source. ⚠️ REFUS explicite au-delà de `MAX_SOURCES` (`SourcesFullError`)
   * et sur un nom déjà utilisé (`SourceValidationError`).
   *
   * ⚠️ LOT 31 : le QUOTA dépend du TYPE — les tâches ponctuelles ont leur propre borne
   * (`TachesPonctuellesFullError`), elles ne consomment pas une place de déclencheur
   * durable.
   */
  create(nom: string, settings: SourceSettingsInput = {}): SourceRecord {
    const name = validateSourceName(nom);
    if (this.has(name)) {
      throw new SourceValidationError(
        "source_exists",
        `Une source « ${name} » existe déjà. Modifiez-la plutôt que de la recréer.`,
      );
    }
    // ⚠️ Le déclencheur est validé AVANT le quota : c'est son TYPE qui choisit la borne.
    const declencheur =
      settings.declencheur !== undefined
        ? validateDeclencheur(settings.declencheur)
        : { ...DEFAULT_SOURCE_DECLENCHEUR };
    if (declencheur.type === "ponctuel") {
      if (this.tachesPonctuelles >= MAX_TACHES_PONCTUELLES) {
        throw new TachesPonctuellesFullError(MAX_TACHES_PONCTUELLES);
      }
    } else if (this.sourcesDurables >= MAX_SOURCES) {
      throw new SourcesFullError(MAX_SOURCES);
    }
    const at = new Date(this.now()).toISOString();
    const record = this.construire(name, settings, at);
    this.records.push(record);
    this.persist();
    return { ...record };
  }

  /**
   * Construit un enregistrement SANS le persister (création simple ou étape de chaîne).
   *
   * ⚠️ Extrait de `create` pour que `createChaine` puisse bâtir TOUTES ses étapes puis
   * les publier en UNE écriture : c'est ce qui rend la création d'une chaîne ATOMIQUE
   * (aucune étape à moitié créée si la dernière est refusée).
   */
  private construire(nom: string, settings: SourceSettingsInput, at: string): SourceRecord {
    // ⚠️ Même règle que la MIGRATION : si l'appelant fournit un réglage du modèle
    // v1 (`tour`, `destination`/`conversation`, `notifier`) SANS dire la
    // visibilité, la source reste VISIBLE — on ne change jamais son comportement
    // sans le dire. Sans aucun de ces champs : `silencieux` (défaut v2).
    const legacyShape =
      settings.tour !== undefined ||
      settings.destination !== undefined ||
      settings.notifier !== undefined;
    const visibilite: SourceVisibilite =
      settings.visibilite ?? (legacyShape ? "visible" : DEFAULT_SOURCE_VISIBILITE);
    if (!isSourceVisibilite(visibilite)) {
      throw new SourceValidationError(
        "invalid_visibilite",
        'Visibilité invalide : "silencieux" ou "visible" attendu.',
      );
    }
    const declencheur =
      settings.declencheur !== undefined
        ? validateDeclencheur(settings.declencheur)
        : { ...DEFAULT_SOURCE_DECLENCHEUR };
    const record: SourceRecord = {
      nom,
      declencheur,
      consigne:
        settings.consigne !== undefined
          ? validateConsigne(
              settings.consigne,
              declencheur.type === "ponctuel" ? MAX_INSTRUCTION_TACHE_CHARS : MAX_CONSIGNE_CHARS,
            )
          : "",
      visibilite,
      destination:
        settings.destination !== undefined ? validateConversation(settings.destination) : "aucune",
      tour: isTurn(settings.tour) ? settings.tour : "stocker",
      // ⚠️ Invariant : un déclencheur silencieux ne notifie JAMAIS (aucun Web Push).
      notifier: visibilite === "silencieux" ? false : settings.notifier !== false,
      // ⚠️ RÉSERVÉ : vide en L2 (le champ existe, il n'est pas câblé).
      preAutorisations: [],
      chevauchement:
        settings.chevauchement !== undefined
          ? validateChevauchement(settings.chevauchement)
          : DEFAULT_SOURCE_CHEVAUCHEMENT,
      rattrapage:
        settings.rattrapage !== undefined
          ? validateRattrapage(settings.rattrapage)
          : DEFAULT_SOURCE_RATTRAPAGE,
      plafondMs:
        settings.plafondMs !== undefined ? validatePlafond(settings.plafondMs) : DEFAULT_PLAFOND_MS,
      maxToursParJour:
        settings.maxToursParJour !== undefined
          ? validateMaxTours(settings.maxToursParJour)
          : DEFAULT_MAX_TOURS_PAR_JOUR,
      actif: settings.actif !== false,
      etat: settings.actif === false ? "suspendu" : "actif",
      ...(settings.libelle !== undefined && settings.libelle.trim() !== ""
        ? { libelle: settings.libelle.trim() }
        : {}),
      ...(settings.perso === true ? { perso: true } : {}),
      ...(settings.occurrencesMax !== undefined && settings.occurrencesMax !== null
        ? { occurrencesMax: validateOccurrencesMax(settings.occurrencesMax) }
        : {}),
      ...(settings.jusquAu !== undefined && settings.jusquAu !== null
        ? { jusquAu: validateJusquAu(settings.jusquAu) }
        : {}),
      ...(settings.occurrencesFaites !== undefined
        ? { occurrencesFaites: Math.max(0, Math.trunc(settings.occurrencesFaites)) }
        : {}),
      ...(settings.chaine !== undefined ? { chaine: settings.chaine } : {}),
      cree: at,
      maj: at,
    };
    return record;
  }

  /**
   * Modifie les réglages d'une source. ⚠️ Un champ absent n'est PAS modifié ;
   * un champ présent mais invalide est REFUSÉ (jamais un no-op silencieux).
   *
   * Changer `destination` EFFACE le fil dédié mémorisé (`sessionId`) : la nouvelle
   * destination ne doit jamais hériter de l'ancienne (sinon la source posterait
   * dans un fil que l'utilisateur vient de quitter).
   *
   * ⚠️ Invariant : `visibilite: "silencieux"` force `notifier: false`.
   */
  update(nom: string, settings: SourceSettingsInput): SourceRecord {
    const index = this.records.findIndex((record) => record.nom === nom);
    if (index < 0) {
      throw new SourceValidationError("unknown_source", `Source inconnue : « ${nom} ».`);
    }
    const record = this.records[index];
    // Validation AVANT toute écriture : un champ invalide ne doit jamais
    // laisser la source à moitié modifiée (aucun no-op silencieux).
    const destination =
      settings.destination !== undefined ? validateConversation(settings.destination) : undefined;
    if (settings.tour !== undefined && !isTurn(settings.tour)) {
      throw new SourceValidationError(
        "invalid_tour",
        'Tour invalide : "lancer" ou "stocker" attendu.',
      );
    }
    if (settings.visibilite !== undefined && !isSourceVisibilite(settings.visibilite)) {
      throw new SourceValidationError(
        "invalid_visibilite",
        'Visibilité invalide : "silencieux" ou "visible" attendu.',
      );
    }
    if (settings.actif !== undefined && typeof settings.actif !== "boolean") {
      throw new SourceValidationError(
        "invalid_actif",
        "Le champ « actif » doit être un booléen.",
      );
    }
    const visibilite: SourceVisibilite = settings.visibilite ?? record.visibilite;
    // ⚠️ Validation AVANT toute écriture des réglages de DÉCLENCHEMENT : une
    // expression cron refusée ne doit jamais laisser la source à moitié modifiée.
    const declencheur =
      settings.declencheur !== undefined ? validateDeclencheur(settings.declencheur) : undefined;
    const chevauchement =
      settings.chevauchement !== undefined
        ? validateChevauchement(settings.chevauchement)
        : undefined;
    const rattrapage =
      settings.rattrapage !== undefined ? validateRattrapage(settings.rattrapage) : undefined;
    const plafondMs =
      settings.plafondMs !== undefined ? validatePlafond(settings.plafondMs) : undefined;
    const maxToursParJour =
      settings.maxToursParJour !== undefined
        ? validateMaxTours(settings.maxToursParJour)
        : undefined;
    const changedTarget = destination !== undefined && destination !== record.destination;
    // ⚠️ Un changement d'expression ou de fuseau INVALIDE le passage calculé :
    // il sera recalculé (service) — jamais un prochain passage hérité de l'ancien.
    const declencheurChange =
      declencheur !== undefined &&
      (declencheur.type !== record.declencheur.type ||
        (declencheur.type === "planning" &&
          (record.declencheur.type !== "planning" ||
            declencheur.expression !== record.declencheur.expression ||
            declencheur.fuseau !== record.declencheur.fuseau)) ||
        (declencheur.type === "ponctuel" &&
          (record.declencheur.type !== "ponctuel" || declencheur.a !== record.declencheur.a)));
    const occurrencesMax =
      settings.occurrencesMax !== undefined && settings.occurrencesMax !== null
        ? validateOccurrencesMax(settings.occurrencesMax)
        : undefined;
    const jusquAu =
      settings.jusquAu !== undefined && settings.jusquAu !== null
        ? validateJusquAu(settings.jusquAu)
        : undefined;
    const next: SourceRecord = {
      ...record,
      ...(settings.consigne !== undefined
        ? {
            consigne: validateConsigne(
              settings.consigne,
              (declencheur ?? record.declencheur).type === "ponctuel"
                ? MAX_INSTRUCTION_TACHE_CHARS
                : MAX_CONSIGNE_CHARS,
            ),
          }
        : {}),
      ...(destination !== undefined ? { destination } : {}),
      ...(settings.tour !== undefined ? { tour: settings.tour } : {}),
      ...(settings.visibilite !== undefined ? { visibilite } : {}),
      ...(declencheur !== undefined ? { declencheur } : {}),
      ...(chevauchement !== undefined ? { chevauchement } : {}),
      ...(rattrapage !== undefined ? { rattrapage } : {}),
      ...(plafondMs !== undefined ? { plafondMs } : {}),
      ...(maxToursParJour !== undefined ? { maxToursParJour } : {}),
      ...(occurrencesMax !== undefined ? { occurrencesMax } : {}),
      ...(jusquAu !== undefined ? { jusquAu } : {}),
      ...(settings.libelle !== undefined && settings.libelle.trim() !== ""
        ? { libelle: settings.libelle.trim() }
        : {}),
      ...(settings.perso !== undefined ? { perso: settings.perso === true } : {}),
      notifier:
        visibilite === "silencieux" ? false : (settings.notifier ?? record.notifier) === true,
      maj: new Date(this.now()).toISOString(),
    };
    if (changedTarget) delete next.sessionId;
    // ⚠️ LOT 32 — `null` RETIRE la fin de récurrence (l'API traduit une chaîne vide en
    // `null`) : sans cette branche, on ne pourrait jamais revenir à « sans fin ».
    if (settings.occurrencesMax === null) delete next.occurrencesMax;
    if (settings.jusquAu === null) delete next.jusquAu;
    if (declencheurChange) {
      delete next.prochainPassage;
      // ⚠️ LOT 32 — LE COMPTEUR EST INVALIDÉ quand le DÉCLENCHEUR CHANGE : « 12/14
      // passages » décrit l'ancien programme, pas le nouveau. Le garder ferait croire
      // à une récurrence déjà presque terminée.
      delete next.occurrencesFaites;
      if (declencheur?.type !== "planning") delete next.toursDuJour;
    }
    // Réactivation : la raison de suspension est effacée et le passage réarmé.
    if (settings.actif !== undefined) {
      next.actif = settings.actif;
      next.etat = settings.actif ? "actif" : "suspendu";
      if (settings.actif) {
        delete next.raisonInactive;
        delete next.prochainPassage;
        delete next.toursDuJour;
      }
    }
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
   * Mémorise l'état de PLANIFICATION d'un déclencheur (⚠️ persistant : c'est lui
   * qui permet la reprise après redémarrage — jamais un état en mémoire seule).
   */
  markPlanification(
    nom: string,
    etat: { prochainPassage?: string; dernierPassage?: string },
  ): SourceRecord | undefined {
    const record = this.records.find((entry) => entry.nom === nom);
    if (!record) return undefined;
    if (etat.prochainPassage === undefined) delete record.prochainPassage;
    else record.prochainPassage = etat.prochainPassage;
    if (etat.dernierPassage !== undefined) record.dernierPassage = etat.dernierPassage;
    this.persist();
    return { ...record };
  }

  /**
   * Active ou suspend un déclencheur — avec une RAISON LISIBLE quand il est
   * suspendu (`DÉSACTIVER`, garde-fou quotidien, expression impossible…).
   */
  setActif(nom: string, actif: boolean, raison?: string): SourceRecord | undefined {
    const record = this.records.find((entry) => entry.nom === nom);
    if (!record) return undefined;
    record.actif = actif;
    record.etat = actif ? "actif" : "suspendu";
    const at = new Date(this.now()).toISOString();
    if (actif) {
      delete record.raisonInactive;
      delete record.prochainPassage;
      // ⚠️ Réactivé : il n'est plus « éteint le … » (la page de gestion ne doit pas
      // garder une date de mise en veille qui ne vaut plus).
      delete record.desactiveLe;
    } else {
      if (raison !== undefined && raison !== "") record.raisonInactive = raison;
      record.desactiveLe = at;
    }
    record.maj = at;
    this.persist();
    return { ...record };
  }

  /**
   * CUMULE les jetons consommés par un tour de fond du déclencheur.
   *
   * ⚠️ On n'invente aucun compteur : sans `usage` rapporté par le job, la fiche
   * reste sans `jetonsCumules` (la page affiche « — », pas « 0 »).
   */
  cumulerJetons(
    nom: string,
    usage: { input?: number; output?: number } | undefined,
  ): SourceRecord | undefined {
    const record = this.records.find((entry) => entry.nom === nom);
    if (!record) return undefined;
    if (!usage) return { ...record };
    const entree = Number.isFinite(usage.input) ? Math.max(0, Math.trunc(usage.input as number)) : 0;
    const sortie = Number.isFinite(usage.output)
      ? Math.max(0, Math.trunc(usage.output as number))
      : 0;
    if (entree === 0 && sortie === 0) return { ...record };
    const cumul = record.jetonsCumules ?? { entree: 0, sortie: 0 };
    record.jetonsCumules = { entree: cumul.entree + entree, sortie: cumul.sortie + sortie };
    this.persist();
    return { ...record };
  }

  /**
   * Compte un tour du JOUR LOCAL donné (`AAAA-MM-JJ`, fuseau du déclencheur) et
   * renvoie le compte à jour. ⚠️ Le compteur bascule à minuit LOCAL : il est
   * persisté (`toursDuJour`), donc il survit à un redémarrage.
   */
  incrementerTour(nom: string, jour: string): number {
    const record = this.records.find((entry) => entry.nom === nom);
    if (!record) return 0;
    const courant = record.toursDuJour;
    const compte = courant !== undefined && courant.jour === jour ? courant.compte + 1 : 1;
    record.toursDuJour = { jour, compte };
    this.persist();
    return compte;
  }

  /**
   * Compte un passage RÉELLEMENT TIRÉ (lot 32) et rend le total.
   *
   * ⚠️ Appelé UNIQUEMENT quand un tour a démarré : un SAUT (chevauchement, garde-fou,
   * rattrapage refusé) n'incrémente jamais ce compteur — sinon « 14/14 passages »
   * s'afficherait alors que Yuki n'a rien exécuté.
   *
   * ⚠️ Persisté AVANT l'exécution du tour (comme le réarmement) : un plantage pendant
   * le tour ne le fait pas repartir de zéro au redémarrage.
   */
  incrementerOccurrence(nom: string): number {
    const record = this.records.find((entry) => entry.nom === nom);
    if (!record) return 0;
    const compte = (record.occurrencesFaites ?? 0) + 1;
    record.occurrencesFaites = compte;
    this.persist();
    return compte;
  }

  /**
   * Note un ÉCHEC dans la série en cours (lot 31).
   *
   * ⚠️ Même raison que la série ⇒ `tentatives + 1` (aucune nouvelle ligne à publier) ;
   * raison DIFFÉRENTE, ou aucune série en cours ⇒ nouvelle série (elle, elle sera
   * publiée). Renvoie la série à jour ET `true` si c'est un NOUVEL échec distinct.
   */
  noterEchec(nom: string, raison: string): { serie: SourceSerieEchecs; nouveau: boolean } | undefined {
    const record = this.records.find((entry) => entry.nom === nom);
    if (!record) return undefined;
    const at = new Date(this.now()).toISOString();
    const courante = record.serieEchecs;
    if (courante !== undefined && courante.raison === raison) {
      courante.tentatives += 1;
      this.persist();
      return { serie: { ...courante }, nouveau: false };
    }
    const serie: SourceSerieEchecs = { raison, debut: at, tentatives: 1 };
    record.serieEchecs = serie;
    this.persist();
    return { serie: { ...serie }, nouveau: true };
  }

  /**
   * Efface la série d'échecs (retour à la NORMALE) et rend celle qui vient d'être
   * refermée — l'appelant la publie : un retour à la normale ne doit jamais être muet.
   */
  effacerEchecs(nom: string): SourceSerieEchecs | undefined {
    const record = this.records.find((entry) => entry.nom === nom);
    if (!record) return undefined;
    const serie = record.serieEchecs;
    if (serie === undefined) return undefined;
    delete record.serieEchecs;
    this.persist();
    return { ...serie };
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
   * mémorisé (mode `source`), ou la conversation désignée dans `destination`.
   * ⚠️ Un déclencheur SILENCIEUX n'a pas de destination effective (le fil
   * « Déclencheurs » n'appartient à aucune source en particulier).
   */
  forSession(sessionId: string): SourceRecord[] {
    if (sessionId === "") return [];
    return this.records
      .filter(
        (record) =>
          record.visibilite === "visible" &&
          ((!isSourceDestination(record.destination) && record.destination === sessionId) ||
            (record.destination === "source" && record.sessionId === sessionId)),
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
        record.visibilite === "visible" &&
        ((!isSourceDestination(record.destination) && record.destination === sessionId) ||
          (record.destination === "source" && record.sessionId === sessionId));
      if (!isTarget) continue;
      record.destination = "nouvelle";
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
