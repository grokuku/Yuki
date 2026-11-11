/**
 * PRÉ-AUTORISATIONS de tâches de fond (lot 26, lot 4/4) — module PUR.
 *
 * LE PROBLÈME QU'ELLES RÉSOLVENT : un déclencheur qui se réveille à 3 h du matin
 * ne peut demander à PERSONNE. Sans pré-autorisation, `run_command` tombe dans
 * `awaiting_validation`, la demande expire en 5 minutes (`src/agents/approvals.ts`)
 * et l'action n'a pas lieu — proprement, mais inutilement.
 *
 * LE MODÈLE — une autorisation est TOUJOURS bornée :
 *   - à UN déclencheur (`declencheur`),
 *   - à UN agent (`agentId`),
 *   - à UNE commande EXACTE ou à un PRÉFIXE explicitement déclaré (`motif` +
 *     `portee`),
 *   - dans le temps (`expireA`, 30 jours par défaut),
 *   - à UNE exécution (une consommation = une exécution, `consommeeLe`).
 *
 * ⚠️ JAMAIS DE JOKER : un `*` dans un champ de sécurité est une erreur qu'on ne
 * rattrape pas. Un motif qui en contient est REFUSÉ à la création, et aucune
 * correspondance n'est jamais tentée par expression régulière ou par glob.
 *
 * ⚠️ DOUTE ⇒ REFUS : une autorisation existe pour ce déclencheur mais elle est
 * expirée, révoquée, prévue pour un AUTRE agent ou ne couvre pas la commande
 * exacte ⇒ on n'exécute pas (voir `consommer`). L'absence TOTALE d'autorisation,
 * elle, laisse le comportement historique (attente d'une validation humaine,
 * qui expirera) — c'est ce que raconte le message du garde-fou.
 *
 * ⚠️ Persistance : un fichier JSON DÉDIÉ sur le volume `state`
 * (`preautorisations.json`), JAMAIS `config.json` (qui n'accepte qu'un patch plat
 * de scalaires) et JAMAIS `sources.json` (les deux ont des cycles de vie
 * différents : supprimer un déclencheur ne doit pas effacer l'historique de ses
 * autorisations, et une autorisation doit pouvoir être révoquée seule).
 *
 * ⚠️ Aucun import SDK/typebox : ce module est du domaine, il est aussi lu par la
 * page de gestion (via l'API) et par les tests.
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

import { formatDateTimeFr } from "../pi/timestamp.js";

/** Version du fichier (`preautorisations.json`). */
export const PREAUTORISATION_SCHEMA_VERSION = 1;

/** Durée de vie par défaut d'une autorisation (jours). */
export const DUREE_DEFAUT_JOURS = 30;

/** Durée de vie MAXIMALE acceptée (jours) — au-delà, on refuse de créer. */
export const DUREE_MAX_JOURS = 90;

/** Nombre maximal d'autorisations conservées (refus explicite au-delà). */
export const MAX_PREAUTORISATIONS = 200;

/** Longueur minimale d'un motif (une commande vide n'autorise rien). */
export const LONGUEUR_MIN_MOTIF = 3;

/**
 * Longueur minimale d'un motif en mode PRÉFIXE.
 *
 * ⚠️ 8 caractères : `sudo` (4) ou `rm ` (3) comme préfixe ouvriraient la porte à
 * presque tout. Un préfixe utile (`systemctl restart `, `rsync -a `) est plus long.
 */
export const LONGUEUR_MIN_PREFIXE = 8;

/** Longueur maximale d'un motif (au-delà, ce n'est plus une commande). */
export const LONGUEUR_MAX_MOTIF = 2_000;

/**
 * Préfixe de l'ORIGINE d'un job de déclencheur (`declencheur:<nom>`).
 *
 * ⚠️ Le NOM est indispensable : sans lui, le garde-fou ne saurait pas QUELLE
 * autorisation s'applique. La forme courte `declencheur` (sans nom) reste
 * reconnue comme « origine déclencheur » mais ne peut RIEN consommer.
 */
export const ORIGINE_DECLENCHEUR = "declencheur";

/** Compose l'origine transmise du job jusqu'au garde-fou. */
export function origineDeclencheur(nom: string): string {
  return `${ORIGINE_DECLENCHEUR}:${nom}`;
}

/** `true` si l'origine vient d'un DÉCLENCHEUR (forme courte ou nommée). */
export function estOrigineDeclencheur(origine: string | undefined): boolean {
  if (typeof origine !== "string") return false;
  return origine === ORIGINE_DECLENCHEUR || origine.startsWith(`${ORIGINE_DECLENCHEUR}:`);
}

/**
 * Nom du déclencheur porté par l'origine (`undefined` si l'origine n'en porte
 * pas : forme courte, origine humaine, origine absente).
 */
export function declencheurDeLOrigine(origine: string | undefined): string | undefined {
  if (typeof origine !== "string") return undefined;
  const prefixe = `${ORIGINE_DECLENCHEUR}:`;
  if (!origine.startsWith(prefixe)) return undefined;
  const nom = origine.slice(prefixe.length).trim();
  return nom === "" ? undefined : nom;
}

/** Portée du motif : égalité STRICTE, ou préfixe explicitement déclaré. */
export type PorteeMotif = "exacte" | "prefixe";

/** États calculés (jamais persistés : ils se déduisent des dates). */
export type EtatPreAutorisation = "active" | "consommee" | "expiree" | "revoquee";

/** Une pré-autorisation persistée. */
export interface PreAutorisation {
  id: string;
  /** Nom EXACT du déclencheur autorisé. */
  declencheur: string;
  /** Identifiant TECHNIQUE de l'agent autorisé (jamais un nom lisible). */
  agentId: string;
  /** Commande exacte, ou préfixe de commande (voir `portee`). */
  motif: string;
  portee: PorteeMotif;
  /** Autorise-t-on en plus une commande classée DESTRUCTRICE ? */
  destructifAutorise: boolean;
  /** Instant ISO d'expiration. */
  expireA: string;
  creeLe: string;
  /** Instant ISO de la consommation (une consommation = une exécution). */
  consommeeLe?: string;
  /** Nombre de consommations (0 ou 1 aujourd'hui, compteur affiché tel quel). */
  consommations: number;
  /** Instant ISO de la révocation + raison lisible. */
  revoqueeLe?: string;
  revoqueeRaison?: string;
}

/** Fichier persisté. */
interface PreAutorisationFile {
  schemaVersion: number;
  preAutorisations: PreAutorisation[];
}

/** Erreur de validation (code stable pour l'API, message en français). */
export class PreAutorisationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PreAutorisationError";
    this.code = code;
  }
}

/** Journal minimal accepté (le journal des déclencheurs le satisfait). */
export interface PreAutorisationJournal {
  append(input: {
    event: "preautorisation" | "refus";
    source: string;
    texte?: string;
    raison?: string;
    preAutorisation?: string;
  }): unknown;
}

export interface PreAutorisationLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

/** Motif PROPOSÉ par l'interface (on ne fait pas taper n'importe quoi). */
export interface MotifPropose {
  id: string;
  libelle: string;
  motif: string;
  portee: PorteeMotif;
  /** La commande est-elle classée DESTRUCTRICE (case à cocher obligatoire) ? */
  destructif: boolean;
  /** Explication courte montrée à côté du choix. */
  aide: string;
}

/**
 * CATALOGUE des motifs proposés dans la page de gestion.
 *
 * ⚠️ C'est une LISTE (pas un champ libre) : l'utilisateur choisit une action
 * connue, avec son libellé et sa portée. La commande personnalisée reste possible
 * mais elle est un choix EXPLICITE, signalé comme tel.
 */
export const MOTIFS_PROPOSES: readonly MotifPropose[] = [
  {
    id: "etat-services",
    libelle: "État d'un service (systemd)",
    motif: "systemctl status ",
    portee: "prefixe",
    destructif: false,
    aide: "Lecture seule : ne modifie rien sur la machine.",
  },
  {
    id: "journal-service",
    libelle: "Journal d'un service (journalctl)",
    motif: "journalctl -u ",
    portee: "prefixe",
    destructif: false,
    aide: "Lecture seule : consulte les journaux.",
  },
  {
    id: "espace-disque",
    libelle: "Espace disque restant",
    motif: "df -h",
    portee: "exacte",
    destructif: false,
    aide: "Lecture seule.",
  },
  {
    id: "charge-memoire",
    libelle: "Charge et mémoire (uptime, free)",
    motif: "uptime && free -h",
    portee: "exacte",
    destructif: false,
    aide: "Lecture seule.",
  },
  {
    id: "redemarrer-service",
    libelle: "Redémarrer un service (systemd)",
    motif: "systemctl restart ",
    portee: "prefixe",
    destructif: true,
    aide: "⚠️ Interrompt le service le temps du redémarrage.",
  },
  {
    id: "maj-paquets",
    libelle: "Mettre à jour les paquets (apt)",
    motif: "apt-get update && apt-get -y upgrade",
    portee: "exacte",
    destructif: true,
    aide: "⚠️ Modifie les paquets installés ; peut demander un redémarrage.",
  },
  {
    id: "sauvegarde-rsync",
    libelle: "Copier un dossier vers une sauvegarde (rsync)",
    motif: "rsync -a ",
    portee: "prefixe",
    destructif: false,
    aide: "⚠️ Écrit à la destination indiquée dans la commande.",
  },
  {
    id: "script-perso",
    libelle: "Lancer un script du dossier personnel (~/scripts/)",
    motif: "~/scripts/",
    portee: "prefixe",
    destructif: true,
    aide: "⚠️ Exécute un script : son effet dépend entièrement du script.",
  },
];

/** Vrai si la valeur est une portée connue. */
export function isPorteeMotif(value: unknown): value is PorteeMotif {
  return value === "exacte" || value === "prefixe";
}

/** Vrai si le motif contient un caractère interdit (`*`, saut de ligne, NUL…). */
function motifInterdit(motif: string): string | undefined {
  if (motif.includes("*")) return "un joker « * » n'est JAMAIS accepté dans un motif";
  if (/[\u0000-\u001f\u007f]/.test(motif)) return "le motif ne peut pas contenir de caractère de contrôle";
  return undefined;
}

/**
 * Valide un motif (⚠️ joker refusé, longueur minimale selon la portée).
 * Renvoie le motif NETTOYÉ (espaces de bord retirés) ou lève `PreAutorisationError`.
 */
export function validerMotif(motif: unknown, portee: unknown): string {
  if (typeof motif !== "string") {
    throw new PreAutorisationError("invalid_motif", "Motif attendu : une commande (texte).");
  }
  const net = motif.trim();
  const interdit = motifInterdit(net);
  if (interdit !== undefined) {
    throw new PreAutorisationError("invalid_motif", `Motif refusé : ${interdit}.`);
  }
  if (!isPorteeMotif(portee)) {
    throw new PreAutorisationError(
      "invalid_portee",
      'Portée invalide : « exacte » (égalité stricte) ou « prefixe » attendue.',
    );
  }
  if (net.length > LONGUEUR_MAX_MOTIF) {
    throw new PreAutorisationError(
      "invalid_motif",
      `Motif trop long : ${net.length} caractères, maximum ${LONGUEUR_MAX_MOTIF}.`,
    );
  }
  const minimum = portee === "prefixe" ? LONGUEUR_MIN_PREFIXE : LONGUEUR_MIN_MOTIF;
  if (net.length < minimum) {
    throw new PreAutorisationError(
      "invalid_motif",
      `Motif trop court : ${net.length} caractère(s), minimum ${minimum} pour une portée « ${portee} ».`,
    );
  }
  return net;
}

/** `true` si la commande est couverte par le motif (égalité ou préfixe déclaré). */
export function motifCorrespond(
  pre: Pick<PreAutorisation, "motif" | "portee">,
  commande: string,
): boolean {
  if (typeof commande !== "string" || commande === "") return false;
  if (pre.portee === "prefixe") return commande.startsWith(pre.motif);
  return commande === pre.motif;
}

/** État calculé d'une autorisation (⚠️ l'ordre des règles est la règle). */
export function etatPreAutorisation(
  pre: Pick<PreAutorisation, "revoqueeLe" | "consommeeLe" | "expireA">,
  maintenant: number = Date.now(),
): EtatPreAutorisation {
  if (pre.revoqueeLe !== undefined && pre.revoqueeLe !== "") return "revoquee";
  if (pre.consommeeLe !== undefined && pre.consommeeLe !== "") return "consommee";
  const at = Date.parse(pre.expireA);
  if (Number.isFinite(at) && at <= maintenant) return "expiree";
  return "active";
}

/** Décrit la couverture d'une autorisation, pour l'affichage et le journal. */
export function texteMotif(pre: Pick<PreAutorisation, "motif" | "portee">): string {
  return pre.portee === "prefixe" ? `${pre.motif}… (préfixe)` : pre.motif;
}

/**
 * Phrase de RISQUE affichée dans la page de gestion AVANT toute création.
 *
 * ⚠️ Elle doit être impossible à mal lire : QUELLES commandes, sur QUELLE
 * machine, et surtout SANS VALIDATION.
 */
export function texteRisque(input: {
  declencheur: string;
  agentNom: string;
  motif: string;
  portee: PorteeMotif;
  destructifAutorise: boolean;
  expireA: string;
  maintenant?: number;
}): string {
  const couverture =
    input.portee === "prefixe"
      ? `toutes les commandes commençant par « ${input.motif} »`
      : `la commande exacte « ${input.motif} »`;
  const destructif = input.destructifAutorise
    ? " Y COMPRIS les commandes classées DESTRUCTRICES."
    : " Les commandes classées destructrices resteront refusées.";
  const expiration = dateLisible(input.expireA, input.maintenant);
  return (
    `⚠️ Cette tâche de fond (« ${input.declencheur} ») pourra exécuter ${couverture} ` +
    `sur la machine « ${input.agentNom} », SANS VALIDATION humaine, jusqu'au ${expiration}.` +
    `${destructif} Une seule exécution sera autorisée : la pré-autorisation est consommée ` +
    "ensuite. Révocable à tout moment depuis cette page."
  );
}

/**
 * Instant lisible en français (jamais une exception sur une date illisible).
 *
 * ⚠️ Rendu par le POINT DE VÉRITÉ `src/pi/timestamp.ts`, donc dans le fuseau du
 * réglage `ui.timeZone` (défaut UTC) et TOUJOURS suffixé (`08/11/2026 15:39 UTC`) :
 * la même autorisation lue depuis l'interface et depuis un canal distant ne peut
 * pas afficher deux heures.
 */
function dateLisible(iso: string, maintenant?: number, timeZone?: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return iso;
  const d = new Date(at);
  const texte = formatDateTimeFr(d, timeZone);
  if (maintenant !== undefined && Number.isFinite(maintenant) && at <= maintenant) {
    return `${texte} (déjà expirée)`;
  }
  return texte;
}

/** Demande de consommation présentée par le garde-fou (`authorize`). */
export interface DemandeConsommation {
  declencheur: string;
  agentId: string;
  commande: string;
  destructif: boolean;
}

/** Issue d'une demande de consommation. */
export type ResultatConsommation =
  | { kind: "consommee"; id: string; motif: string; portee: PorteeMotif }
  | { kind: "refus"; raison: string }
  | { kind: "aucune" };

/** Port consommé par `AgentExecutionService.authorize`. */
export interface PreAutorisationPort {
  consommer(demande: DemandeConsommation): ResultatConsommation;
}

export interface PreAutorisationStoreOptions {
  /** Chemin du fichier (`/data/state/preautorisations.json`). */
  path: string;
  logger?: PreAutorisationLogger;
  now?: () => number;
  idFactory?: () => string;
  /** Journal des déclencheurs (facultatif) : trace des consommations et refus. */
  journal?: PreAutorisationJournal;
  /** Rétention des autorisations terminées (jours). Défaut : 90. */
  retentionJours?: number;
  /**
   * ⚠️ LOT 35j — BOT PROPRIÉTAIRE de ce registre.
   *
   * Le FICHIER est déjà par bot (`paths.ts` : `preautorisations.json` sous
   * `<state>/bots/<botId>/`), donc la clé `(bot, déclencheur)` est STRUCTURELLE.
   * Le champ ne sert qu'à deux choses : le journal et le filtre de visibilité des
   * agents. Il vient du DÉMARRAGE (bot de la pile), jamais d'une demande.
   */
  botId?: string;
  /**
   * ⚠️ LOT 35j — PORTÉE AGENT filtrée par `AgentRecord.bots` : un agent que CE bot
   * ne voit pas ne peut pas consommer l'autorisation, même si elle porte son
   * `agentId` (elle a pu être créée quand l'agent était encore visible).
   *
   * Absent ⇒ aucun filtrage (comportement historique, mono-bot et tests).
   */
  agentAutorise?: (agentId: string) => boolean;
}

/** Rétention par défaut des autorisations terminées (consommées/révoquées/expirées). */
export const RETENTION_JOURS = 90;

const JOUR_MS = 86_400_000;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Normalise une entrée relue (⚠️ une entrée illisible est CONSERVÉE telle quelle). */
function normaliser(entry: unknown): PreAutorisation | undefined {
  const raw = asObject(entry);
  if (!raw) return undefined;
  const id = typeof raw["id"] === "string" ? raw["id"] : "";
  const declencheur = typeof raw["declencheur"] === "string" ? raw["declencheur"] : "";
  const agentId = typeof raw["agentId"] === "string" ? raw["agentId"] : "";
  const expireA = typeof raw["expireA"] === "string" ? raw["expireA"] : "";
  if (id === "" || declencheur === "" || agentId === "" || expireA === "") return undefined;
  let motif: string;
  let portee: PorteeMotif;
  try {
    portee = isPorteeMotif(raw["portee"]) ? raw["portee"] : "exacte";
    motif = validerMotif(raw["motif"], portee);
  } catch {
    return undefined;
  }
  return {
    id,
    declencheur,
    agentId,
    motif,
    portee,
    destructifAutorise: raw["destructifAutorise"] === true,
    expireA,
    creeLe: typeof raw["creeLe"] === "string" ? raw["creeLe"] : expireA,
    ...(typeof raw["consommeeLe"] === "string" ? { consommeeLe: raw["consommeeLe"] } : {}),
    consommations:
      typeof raw["consommations"] === "number" && Number.isFinite(raw["consommations"])
        ? Math.max(0, Math.trunc(raw["consommations"]))
        : 0,
    ...(typeof raw["revoqueeLe"] === "string" ? { revoqueeLe: raw["revoqueeLe"] } : {}),
    ...(typeof raw["revoqueeRaison"] === "string" ? { revoqueeRaison: raw["revoqueeRaison"] } : {}),
  };
}

/**
 * Registre des PRÉ-AUTORISATIONS (fichier JSON du volume `state`).
 *
 * Chargé une fois à la construction ; chaque mutation réécrit le fichier
 * immédiatement (écriture atomique `tmp` + `rename`, mode 0600).
 */
export class PreAutorisationStore implements PreAutorisationPort {
  readonly path: string;
  private readonly logger?: PreAutorisationLogger;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly journal?: PreAutorisationJournal;
  private readonly retentionJours: number;
  /** Bot propriétaire (diagnostic/journal) — jamais utilisé pour choisir un chemin. */
  private readonly botId?: string;
  /** Filtre de visibilité des agents pour CE bot (`AgentRecord.bots`). */
  private readonly agentAutorise?: (agentId: string) => boolean;
  private entries: PreAutorisation[] = [];
  /** Entrées d'un fichier antérieur qu'on n'a pas su lire (jamais jetées). */
  private invalides: unknown[] = [];

  constructor(options: PreAutorisationStoreOptions) {
    this.path = options.path;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.idFactory =
      options.idFactory ?? (() => `pre_${randomBytes(6).toString("hex")}`);
    this.journal = options.journal;
    this.retentionJours = Math.max(1, Math.trunc(options.retentionJours ?? RETENTION_JOURS));
    this.botId = options.botId;
    this.agentAutorise = options.agentAutorise;
    this.entries = this.charger();
  }

  /** Nombre d'autorisations conservées (tous états confondus). */
  get size(): number {
    return this.entries.length;
  }

  private charger(): PreAutorisation[] {
    if (!existsSync(this.path)) return [];
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      this.logger?.warn("agents.preautorisation.unreadable", {
        path: this.path,
        error: messageOf(error),
      });
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      // ⚠️ Fichier illisible : on repart d'une liste VIDE mais on ne supprime
      // RIEN (le fichier reste sur disque, récupérable à la main).
      this.logger?.warn("agents.preautorisation.invalid", {
        path: this.path,
        error: messageOf(error),
      });
      return [];
    }
    const raw = asObject(parsed);
    const liste = Array.isArray(raw?.["preAutorisations"]) ? raw["preAutorisations"] : [];
    this.invalides = Array.isArray(raw?.["invalides"]) ? (raw["invalides"] as unknown[]) : [];
    const entries: PreAutorisation[] = [];
    for (const entry of liste) {
      const normalisee = normaliser(entry);
      if (normalisee) entries.push(normalisee);
      else this.invalides.push(entry);
    }
    return entries;
  }

  private persist(): void {
    const file: PreAutorisationFile & { invalides?: unknown[] } = {
      schemaVersion: PREAUTORISATION_SCHEMA_VERSION,
      preAutorisations: this.entries,
      ...(this.invalides.length > 0 ? { invalides: this.invalides } : {}),
    };
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
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

  /** Toutes les autorisations (copie : l'appelant ne peut pas muter l'état). */
  list(): PreAutorisation[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  /** Autorisations ACTIVES d'un déclencheur (pour l'affichage d'une ligne). */
  activesPour(declencheur: string): PreAutorisation[] {
    const at = this.now();
    return this.entries
      .filter((entry) => entry.declencheur === declencheur && etatPreAutorisation(entry, at) === "active")
      .map((entry) => ({ ...entry }));
  }

  get(id: string): PreAutorisation | undefined {
    const found = this.entries.find((entry) => entry.id === id);
    return found ? { ...found } : undefined;
  }

  /**
   * Crée une autorisation (⚠️ validée AVANT toute écriture : joker refusé,
   * longueurs bornées, déclencheur et agent non vides).
   */
  creer(input: {
    declencheur: unknown;
    agentId: unknown;
    motif: unknown;
    portee?: unknown;
    destructifAutorise?: unknown;
    dureeJours?: unknown;
  }): PreAutorisation {
    const declencheur = typeof input.declencheur === "string" ? input.declencheur.trim() : "";
    if (declencheur === "") {
      throw new PreAutorisationError("invalid_declencheur", "Déclencheur manquant.");
    }
    const agentId = typeof input.agentId === "string" ? input.agentId.trim() : "";
    if (agentId === "") {
      throw new PreAutorisationError("invalid_agent", "Agent manquant (identifiant technique).");
    }
    const portee: PorteeMotif = isPorteeMotif(input.portee) ? input.portee : "exacte";
    const motif = validerMotif(input.motif, portee);
    const dureeJours = bornerDuree(input.dureeJours);
    if (this.entries.length >= MAX_PREAUTORISATIONS) {
      throw new PreAutorisationError(
        "too_many_preautorisations",
        `Trop de pré-autorisations (${MAX_PREAUTORISATIONS}) : révoquez-en avant d'en créer une autre.`,
      );
    }
    const at = this.now();
    const record: PreAutorisation = {
      id: this.idFactory(),
      declencheur,
      agentId,
      motif,
      portee,
      destructifAutorise: input.destructifAutorise === true,
      expireA: new Date(at + dureeJours * JOUR_MS).toISOString(),
      creeLe: new Date(at).toISOString(),
      consommations: 0,
    };
    this.entries.push(record);
    this.purgerTerminees();
    this.persist();
    this.logger?.info("agents.preautorisation.created", {
      id: record.id,
      declencheur,
      agent_id: agentId,
      portee,
      destructif_autorise: record.destructifAutorise,
      expire_a: record.expireA,
    });
    return { ...record };
  }

  /** Révoque (⚠️ idempotent : une autorisation déjà révoquée n'est pas réécrite). */
  revoquer(id: string, raison = "révocation demandée depuis la page de gestion"): boolean {
    const entry = this.entries.find((item) => item.id === id);
    if (!entry) return false;
    if (entry.revoqueeLe !== undefined) return true;
    entry.revoqueeLe = new Date(this.now()).toISOString();
    entry.revoqueeRaison = raison;
    this.persist();
    this.logger?.info("agents.preautorisation.revoked", {
      id: entry.id,
      declencheur: entry.declencheur,
      agent_id: entry.agentId,
    });
    return true;
  }

  /** Supprime les autorisations TERMINÉES plus anciennes que la rétention. */
  purgerTerminees(): number {
    const at = this.now();
    const cutoff = at - this.retentionJours * JOUR_MS;
    const avant = this.entries.length;
    this.entries = this.entries.filter((entry) => {
      const etat = etatPreAutorisation(entry, at);
      if (etat === "active") return true;
      const terminee = entry.revoqueeLe ?? entry.consommeeLe ?? entry.expireA;
      const quand = Date.parse(terminee);
      if (!Number.isFinite(quand)) return true;
      return quand >= cutoff;
    });
    return avant - this.entries.length;
  }

  /**
   * CONSOMME une autorisation si elle couvre exactement la demande.
   *
   * Règles (l'ordre est la règle) :
   *  1. aucune autorisation pour ce DÉCLENCHEUR ⇒ `aucune` (comportement
   *     historique : la validation humaine est demandée, puis expire) ;
   *  2. aucune pour cet AGENT ⇒ REFUS (doute) ;
   *  3. toutes révoquées ⇒ REFUS ;
   *  4. toutes expirées ⇒ REFUS ;
   *  5. aucune ne couvre la COMMANDE ⇒ REFUS ;
   *  6. toutes déjà consommées ⇒ `aucune` (une seconde exécution redemande une
   *     approbation : une pré-autorisation = une exécution) ;
   *  7. commande destructrice sans `destructifAutorise` ⇒ REFUS ;
   *  8. sinon : JOURNAL, puis marque `consommeeLe` (⚠️ l'ordre compte : on
   *     n'écrit jamais une consommation que le journal n'a pas vue).
   */
  consommer(demande: DemandeConsommation): ResultatConsommation {
    const declencheur = typeof demande.declencheur === "string" ? demande.declencheur.trim() : "";
    const commande = typeof demande.commande === "string" ? demande.commande : "";
    const agentId = typeof demande.agentId === "string" ? demande.agentId : "";
    if (declencheur === "" || agentId === "") return { kind: "aucune" };
    const candidates = this.entries.filter((entry) => entry.declencheur === declencheur);
    if (candidates.length === 0) return { kind: "aucune" };
    const refus = (raison: string): ResultatConsommation => {
      this.journaliserRefus(declencheur, commande, raison);
      return { kind: "refus", raison };
    };

    const deLAgent = candidates.filter((entry) => entry.agentId === agentId);
    if (deLAgent.length === 0) {
      return refus(
        `Pré-autorisation REFUSÉE : le déclencheur « ${declencheur} » n'a aucune ` +
          `autorisation pour cet agent (${
            [...new Set(candidates.map((entry) => entry.agentId))].join(", ") || "aucun"
          }). Rien n'a été exécuté.`,
      );
    }
    // ⚠️ LOT 35j — PORTÉE AGENT : une autorisation destinée à un agent que CE bot ne
    // voit pas (`AgentRecord.bots`) ne s'applique pas ici. Le refus le DIT, sinon la
    // personne chercherait pourquoi une autorisation « active » ne sert à rien.
    if (this.agentAutorise !== undefined && !this.agentAutorise(agentId)) {
      return refus(
        `Pré-autorisation REFUSÉE : l'agent ${agentId} n'est pas autorisé pour ce bot` +
          `${this.botId !== undefined ? ` (${this.botId})` : ""}. Rien n'a été exécuté.`,
      );
    }
    const nonRevoquees = deLAgent.filter((entry) => entry.revoqueeLe === undefined);
    if (nonRevoquees.length === 0) {
      return refus(
        `Pré-autorisation REFUSÉE : elle a été RÉVOQUÉE pour le déclencheur ` +
          `« ${declencheur} » et cet agent. Rien n'a été exécuté.`,
      );
    }
    const at = this.now();
    const nonExpirees = nonRevoquees.filter((entry) => {
      const quand = Date.parse(entry.expireA);
      return !Number.isFinite(quand) ? false : quand > at;
    });
    if (nonExpirees.length === 0) {
      return refus(
        `Pré-autorisation REFUSÉE : elle est EXPIRÉE (elle aurait dû être utilisée avant ` +
          `le ${dateLisible(nonRevoquees[0]?.expireA ?? "", at)}). Rien n'a été exécuté.`,
      );
    }
    const couvrantes = nonExpirees.filter((entry) => motifCorrespond(entry, commande));
    if (couvrantes.length === 0) {
      return refus(
        `Pré-autorisation REFUSÉE : la commande ne correspond à AUCUN motif déclaré pour ` +
          `« ${declencheur} » (${nonExpirees.map((entry) => texteMotif(entry)).join(" · ")}). ` +
          "Le doute vaut refus : rien n'a été exécuté.",
      );
    }
    const disponibles = couvrantes.filter((entry) => entry.consommeeLe === undefined);
    if (disponibles.length === 0) {
      // ⚠️ Déjà consommée : ce n'est pas un refus SEC, c'est un retour au
      // comportement normal — une demande d'approbation humaine. Le message du
      // garde-fou explique qu'un tour de fond ne peut pas l'obtenir.
      return { kind: "aucune" };
    }
    const autorisees = demande.destructif
      ? disponibles.filter((entry) => entry.destructifAutorise)
      : disponibles;
    if (autorisees.length === 0) {
      return refus(
        `Pré-autorisation REFUSÉE : la commande est classée DESTRUCTRICE et aucune ` +
          `autorisation de « ${declencheur} » ne l'autorise explicitement. Rien n'a été exécuté.`,
      );
    }
    // ⚠️ La PLUS ANCIENNE d'abord : une autorisation ne reste pas en attente
    // indéfiniment pendant qu'une plus récente passerait devant.
    const choisie = autorisees.reduce((a, b) => (Date.parse(a.creeLe) <= Date.parse(b.creeLe) ? a : b));

    // ⚠️ JOURNAL D'ABORD : aucune consommation sans ligne de journal.
    try {
      this.journal?.append({
        event: "preautorisation",
        source: choisie.declencheur,
        preAutorisation: texteMotif(choisie),
        texte: commande,
        raison: `consommée pour l'agent ${choisie.agentId} (${
          demande.destructif ? "commande destructrice autorisée" : "commande non destructrice"
        })`,
      });
    } catch (error) {
      this.logger?.warn("agents.preautorisation.journal_failed", {
        id: choisie.id,
        error: messageOf(error),
      });
      return {
        kind: "refus",
        raison:
          "Pré-autorisation REFUSÉE : la consommation n'a pas pu être JOURNALISÉE. Sans " +
          "trace, elle n'est pas consommée et rien n'est exécuté.",
      };
    }

    choisie.consommeeLe = new Date(at).toISOString();
    choisie.consommations += 1;
    this.persist();
    this.logger?.info("agents.preautorisation.consommee", {
      id: choisie.id,
      declencheur: choisie.declencheur,
      agent_id: choisie.agentId,
      portee: choisie.portee,
      destructif: demande.destructif,
    });
    return {
      kind: "consommee",
      id: choisie.id,
      motif: choisie.motif,
      portee: choisie.portee,
    };
  }

  /** Trace un REFUS (le doute vaut refus : on le dit, on ne le tait pas). */
  private journaliserRefus(declencheur: string, commande: string, raison: string): void {
    try {
      this.journal?.append({
        event: "refus",
        source: declencheur,
        texte: commande,
        raison: `pré-autorisation : ${raison}`,
      });
    } catch (error) {
      this.logger?.warn("agents.preautorisation.journal_failed", { error: messageOf(error) });
    }
  }
}

/** Borne la durée de vie demandée (jours) — refuse au-delà du maximum. */
function bornerDuree(value: unknown): number {
  if (value === undefined || value === null || value === "") return DUREE_DEFAUT_JOURS;
  const nombre = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(nombre)) {
    throw new PreAutorisationError("invalid_duree", "Durée invalide : nombre de jours attendu.");
  }
  const jours = Math.trunc(nombre);
  if (jours < 1) {
    throw new PreAutorisationError(
      "invalid_duree",
      "Durée invalide : au moins 1 jour (une autorisation qui expire aussitôt n'autorise rien).",
    );
  }
  if (jours > DUREE_MAX_JOURS) {
    throw new PreAutorisationError(
      "invalid_duree",
      `Durée trop longue : ${jours} jours, maximum ${DUREE_MAX_JOURS}.`,
    );
  }
  return jours;
}
