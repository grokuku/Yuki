/**
 * Domaine « DÉCLENCHEURS » (ex-« sources ») — réveil GÉNÉRIQUE de Yuki par un
 * programme extérieur. Modèle **v2** (`sources.json` `schemaVersion: 2`).
 *
 * Un **déclencheur** est un programme (agrégateur de news, client de messagerie,
 * n'importe quoi) qui possède un `nom` et un `jeton`. Il pousse des messages
 * authentifiés sur `POST /api/sources/<nom>/messages`.
 *
 * Types PURS (aucun SDK, aucun I/O) : le store, la boîte, le service et l'API
 * HTTP les partagent.
 *
 * ⚠️ Le RÉGLAGE CENTRAL est la VISIBILITÉ de la sortie :
 *   - `visibilite: "silencieux"` (DÉFAUT) : le contenu REÇU n'apparaît NULLE
 *     PART dans l'interface de conversation (ni bulle, ni notification, ni
 *     pastille). Yuki décide : si elle n'a rien à dire, elle répond exactement
 *     `RIEN` et **rien n'est publié** (journal `silence`) ; sinon son RÉSULTAT
 *     est publié dans l'unique fil « Déclencheurs » (journal `publie`).
 *     ⚠️ `destination`, `tour` et `notifier` sont alors SANS EFFET (`notifier`
 *     est forcé à `false` : aucun Web Push).
 *   - `visibilite: "visible"` : comportement historique du lot 17 — la source
 *     écrit dans `destination` (`aucune`, `source`, `nouvelle`, `courante`, ou
 *     l'identifiant d'une conversation EXISTANTE choisie par l'utilisateur),
 *     selon `tour` (`lancer` | `stocker`), avec `notifier` (Web Push).
 *
 * ⚠️ Toute source issue de `schemaVersion: 1` est migrée en `visible` : on ne
 * change JAMAIS le comportement existant sans le dire (`store.ts`).
 *
 * ⚠️ Champs RÉSERVÉS au lot 2, **déclarés mais non câblés** :
 * `preAutorisations`, `chevauchement`, `rattrapage`, `plafondMs`, `actif`, `etat`.
 *
 * ⚠️ Le JETON n'est jamais dans ce module, ni dans `sources.json` : il vit dans
 * le COFFRE (`YUKI_SOURCE_<NOM>`) et n'est affiché qu'UNE fois, à sa création.
 */

// ── Bornes (garde-fous, pas des réglages cosmétiques) ───────────────────────

import { SOURCE_TOKEN_NAME_PREFIX } from "../secrets/references.js";

/** Nom de source acceptable : minuscules, chiffres, `_` et `-`, 1 à 32. */
export const SOURCE_NAME_PATTERN = /^[a-z0-9_-]{1,32}$/;

/**
 * Noms RÉSERVÉS par l'API : `/api/sources/inbox…` est la boîte de notifications,
 * une source ne peut donc pas s'appeler `inbox` (sinon collision de route).
 */
export const RESERVED_SOURCE_NAMES: readonly string[] = ["inbox"];

/** Nombre maximal de sources déclarées (au-delà : refus explicite). */
export const MAX_SOURCES = 20;

/** Plafond d'entrées de la boîte : au-delà, REFUS explicite (jamais de perte). */
export const MAX_INBOX_ENTRIES = 200;

/** Identifiant d'appel fourni par la source : opaque, borné, sans métacaractère. */
export const SOURCE_MESSAGE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** Taille maximale d'un corps de message poussé par une source (64 Kio). */
export const MAX_SOURCE_MESSAGE_BYTES = 64 * 1024;

/** Longueur maximale d'un titre d'entrée (caractères). */
export const MAX_TITRE_CHARS = 200;

/** Longueur maximale de la CONSIGNE libre d'une source (caractères). */
export const MAX_CONSIGNE_CHARS = 2_000;

/** Appels autorisés par minute ET par source (au-delà : 429 explicite). */
export const SOURCE_RATE_LIMIT_PER_MINUTE = 30;

/** Durée de l'idempotence `(source, id)` : 7 jours. */
export const SOURCE_DEDUPE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Longueur maximale de la réponse de Yuki attachée à une entrée. */
export const MAX_REPLY_CHARS = 8_000;

/**
 * Réponse EXACTE par laquelle Yuki dit « je n'ai rien à signaler » dans un
 * déclencheur SILENCIEUX. Normalisée (casse, guillemets, ponctuation) avant
 * comparaison : voir `isSilenceReply` (`service.ts`).
 */
export const SILENCE_REPLY = "RIEN";

/** Titre de l'UNIQUE fil partagé par tous les déclencheurs silencieux. */
export const DECLENCHEURS_SESSION_TITLE = "Déclencheurs";

/**
 * Préfixe RÉSERVÉ du nom de secret portant le jeton d'une source dans le coffre :
 * `YUKI_SOURCE_<NOM>` (`NOM` en MAJUSCULES, `-` remplacé par `_`).
 *
 * ⚠️ Source UNIQUE : la constante est définie dans `src/secrets/references.ts`
 * (qui valide les noms acceptés par le coffre).
 */
export const SOURCE_TOKEN_PREFIX = SOURCE_TOKEN_NAME_PREFIX;

/** Nom du secret de coffre portant le jeton d'une source. */
export function sourceTokenName(nom: string): string {
  return `${SOURCE_TOKEN_PREFIX}${nom.toUpperCase().replace(/-/g, "_")}`;
}

/**
 * Les MODES de destination — les seules valeurs qu'un client extérieur peut
 * envoyer : il ne désigne JAMAIS un fil en clair.
 *
 * ⚠️ `aucune` est l'état d'une source NEUVE : aucune destination n'a encore été
 * choisie. Dans cet état, une source ne démarre AUCUN tour (règle « C ») — elle ne
 * peut pas décider à la place de l'utilisateur dans quel fil écrire.
 */
export type SourceDestination = "aucune" | "source" | "nouvelle" | "courante";

/**
 * Où le message doit atterrir, CÔTÉ YUKI :
 *  - un MODE (`SourceDestination`) ;
 *  - ou l'identifiant d'une conversation EXISTANTE, résolu **côté Yuki** depuis la
 *    configuration de la source (`/config` → Sources), choisi par l'UTILISATEUR.
 *
 * ⚠️ La route publique `POST /api/sources/<nom>/messages` n'accepte QUE les MODES :
 * un programme extérieur ne peut pas désigner un fil (ni le découvrir).
 */
export type SourceConversation = SourceDestination | string;

/**
 * Forme d'un identifiant de conversation accepté comme destination. Volontairement
 * STRICTE : ni espace, ni `/`, ni saut de ligne — la valeur vient d'un `select` de
 * `/config`, jamais d'un texte libre recopié tel quel.
 */
export const SOURCE_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Vrai si la valeur est l'un des MODES de destination. */
export function isSourceDestination(value: unknown): value is SourceDestination {
  return (
    value === "aucune" ||
    value === "source" ||
    value === "nouvelle" ||
    value === "courante"
  );
}

/** Vrai si la valeur est un identifiant de conversation acceptable. */
export function isSourceSessionTarget(value: unknown): value is string {
  return typeof value === "string" && SOURCE_SESSION_ID_PATTERN.test(value);
}

/** Ce que le message doit déclencher (⚠️ utilisé SEULEMENT si `visible`). */
export type SourceTurn = "lancer" | "stocker";

/**
 * VISIBILITÉ de la sortie d'un déclencheur.
 *
 *  - `silencieux` (défaut) : le contenu reçu ne s'affiche nulle part ; seul le
 *    RÉSULTAT (ou rien, si la réponse est `RIEN`) est publié dans le fil
 *    « Déclencheurs » ;
 *  - `visible` : comportement historique (destination + tour + notification).
 */
export type SourceVisibilite = "silencieux" | "visible";

/** Visibilité par défaut d'une source NEUVE : silencieuse. */
export const DEFAULT_SOURCE_VISIBILITE: SourceVisibilite = "silencieux";

/** Vrai si la valeur est une visibilité connue. */
export function isSourceVisibilite(value: unknown): value is SourceVisibilite {
  return value === "silencieux" || value === "visible";
}

/**
 * Déclencheur : comment la source réveille Yuki.
 *
 *  - `webhook` : un programme extérieur pousse un message
 *    (`POST /api/sources/<nom>/messages`) — le seul type du lot 1 ;
 *  - `planning` (lot 2) : **le moteur horloge** réveille Yuki selon une
 *    expression **cron à 5 champs** (`expression`) évaluée dans le fuseau du
 *    DÉCLENCHEUR (`fuseau`, `Europe/Paris` par défaut) — ⚠️ jamais celui du
 *    process (en conteneur c'est UTC).
 */
export type SourceDeclencheurType = "webhook" | "planning";

/** Déclencheur par PROGRAMME extérieur (poussée HTTP authentifiée). */
export interface SourceDeclencheurWebhook {
  type: "webhook";
}

/** Déclencheur par HORLOGE (expression cron + fuseau du déclencheur). */
export interface SourceDeclencheurPlanning {
  type: "planning";
  /** Expression cron à 5 champs (`src/sources/cron.ts` la valide). */
  expression: string;
  /** Fuseau IANA de l'évaluation (`Europe/Paris` par défaut). */
  fuseau: string;
}

/** Forme du déclencheur persisté (union discriminée par `type`). */
export type SourceDeclencheur = SourceDeclencheurWebhook | SourceDeclencheurPlanning;

/** Fuseau par défaut d'un déclencheur planifié. */
export const DEFAULT_FUSEAU = "Europe/Paris";

/** Déclencheur par défaut d'une source neuve (programme extérieur). */
export const DEFAULT_SOURCE_DECLENCHEUR: SourceDeclencheur = { type: "webhook" };

/** Vrai si la valeur est un déclencheur `webhook` (objet `{ type: "webhook" }`). */
export function isSourceDeclencheurWebhook(value: unknown): value is SourceDeclencheurWebhook {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "webhook"
  );
}

/**
 * Vrai si la valeur a la FORME d'un déclencheur `planning`. ⚠️ La validité de
 * l'expression et du fuseau est vérifiée par `src/sources/cron.ts` (le store
 * refuse explicitement, il ne devine pas).
 */
export function isSourceDeclencheurPlanning(value: unknown): value is SourceDeclencheurPlanning {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "planning" &&
    typeof (value as { expression?: unknown }).expression === "string" &&
    typeof (value as { fuseau?: unknown }).fuseau === "string"
  );
}

/** Vrai si la valeur est un déclencheur connu (`webhook` ou `planning`). */
export function isSourceDeclencheur(value: unknown): value is SourceDeclencheur {
  return isSourceDeclencheurWebhook(value) || isSourceDeclencheurPlanning(value);
}

/**
 * Que faire si un passage planifié arrive pendant qu'un tour de la MÊME source
 * tourne encore.
 *
 *  - `sauter` (DÉFAUT) : le passage est SAUTÉ et journalisé — on ne superpose
 *    jamais deux tours d'un même déclencheur ;
 *  - `remplacer` : l'ancien tour est ABANDONNÉ (`abort`) et le nouveau démarre.
 */
export type SourceChevauchement = "sauter" | "remplacer";

export const DEFAULT_SOURCE_CHEVAUCHEMENT: SourceChevauchement = "sauter";

/** Vrai si la valeur est une politique de chevauchement connue. */
export function isSourceChevauchement(value: unknown): value is SourceChevauchement {
  return value === "sauter" || value === "remplacer";
}

/**
 * Que faire d'un passage MANQUÉ (processus arrêté, machine suspendue…).
 *
 *  - `rattraper` (DÉFAUT) : un passage manqué est rejoué **UNE SEULE FOIS** si le
 *    retard est **< 1 h** ; au-delà il est SAUTÉ et journalisé ;
 *  - `sauter` : aucun rattrapage — un passage manqué est toujours sauté.
 */
export type SourceRattrapage = "sauter" | "rattraper";

export const DEFAULT_SOURCE_RATTRAPAGE: SourceRattrapage = "rattraper";

/** ⚠️ Retard maximal rattrapable d'un passage manqué : 1 heure. */
export const RATTRAPAGE_MAX_MS = 60 * 60 * 1000;

/** Vrai si la valeur est une politique de rattrapage connue. */
export function isSourceRattrapage(value: unknown): value is SourceRattrapage {
  return value === "sauter" || value === "rattraper";
}

/** ⚠️ Plafond d'exécution par défaut d'un déclencheur : 10 minutes. */
export const DEFAULT_PLAFOND_MS = 10 * 60 * 1000;

/** Borne BASSE du plafond d'exécution : 60 s (en dessous, rien ne tient). */
export const MIN_PLAFOND_MS = 60 * 1000;

/** Borne HAUTE du plafond d'exécution : 2 h. */
export const MAX_PLAFOND_MS = 2 * 60 * 60 * 1000;

/** Nombre maximal de tours par jour et par déclencheur (défaut). */
export const DEFAULT_MAX_TOURS_PAR_JOUR = 200;

/** Borne HAUTE du garde-fou quotidien. */
export const MAX_TOURS_PAR_JOUR_LIMITE = 1_000;

/** ⚠️ État d'un déclencheur : `suspendu` = `actif: false` (la raison est persistée). */
export type SourceEtat = "actif" | "suspendu";

/** Jetons consommés par les tours de fond d'un déclencheur (`usage` cumulé). */
export interface SourceJetons {
  /** Jetons d'entrée cumulés. */
  entree: number;
  /** Jetons de sortie cumulés. */
  sortie: number;
}

/** Nombre de jours pendant lesquels un déclencheur TEMPORAIRE éteint reste visible. */
export const JOURS_VISIBILITE_TEMPORAIRE = 7;

/**
 * État d'une entrée de la boîte.
 *
 * `alerte` est un AVIS DE YUKI (jamais un message reçu) : par exemple « ce fil a été
 * supprimé, la source qui y postait passe en nouvelle conversation ». Il n'est
 * jamais remis au modèle (`pending()` ne retient que `recu`).
 */
export type InboxEntryState = "recu" | "traite" | "echec" | "alerte";

/**
 * Enregistrement persisté d'une source (`sources.json`, `schemaVersion: 2`, sur le
 * volume `state`).
 */
export interface SourceRecord {
  nom: string;
  /** Déclencheur : `webhook` (poussée HTTP) ou `planning` (horloge cron). */
  declencheur: SourceDeclencheur;
  /** Consigne LIBRE écrite par l'utilisateur (donnée de prompt, jamais du code). */
  consigne: string;
  /**
   * VISIBILITÉ de la sortie : `silencieux` (défaut) ou `visible`.
   * ⚠️ `silencieux` rend `destination`, `tour` et `notifier` sans effet.
   */
  visibilite: SourceVisibilite;
  /**
   * Destination — ⚠️ utilisée SEULEMENT si `visibilite === "visible"` : un MODE,
   * ou l'identifiant d'une conversation existante choisie par l'utilisateur dans
   * `/config` (voir `SourceConversation`).
   */
  destination: SourceConversation;
  /** Tour — ⚠️ utilisé SEULEMENT si `visibilite === "visible"`. */
  tour: SourceTurn;
  /** Web Push — ⚠️ forcé à `false` quand `visibilite === "silencieux"`. */
  notifier: boolean;
  /**
   * ⚠️ RÉSERVÉ (lot 2) : liste d'outils pré-autorisés. Toujours `[]` en L2 — le
   * champ existe pour ne pas avoir à migrer `sources.json` une troisième fois.
   */
  preAutorisations: string[];
  /** Si un passage arrive pendant qu'un tour tourne encore (défaut `sauter`). */
  chevauchement?: SourceChevauchement;
  /** Que faire d'un passage manqué (défaut `rattraper`, < 1 h, une seule fois). */
  rattrapage?: SourceRattrapage;
  /** Plafond d'exécution d'un tour (ms, 60 s – 2 h, défaut 10 min). */
  plafondMs?: number;
  /** Nombre maximal de tours par jour local (défaut 200). */
  maxToursParJour?: number;
  /**
   * Interrupteur du déclencheur. `false` ⇒ aucun passage n'est lancé.
   * ⚠️ `DÉSACTIVER` en fin de réponse l'éteint lui-même (`raisonInactive`).
   */
  actif?: boolean;
  /** État persisté (miroir de `actif`, pour l'affichage et le diagnostic). */
  etat?: SourceEtat;
  /** Raison LISIBLE de la suspension (affichée dans `/config`), jamais muette. */
  raisonInactive?: string;
  /**
   * Instant ISO de la MISE EN VEILLE (`actif = false`).
   *
   * ⚠️ Il ne sert pas qu'à l'affichage : la page de gestion s'en sert pour garder
   * **7 jours** un déclencheur TEMPORAIRE éteint, avec la mention « éteint le … »
   * — sinon on ne sait plus qu'il a existé.
   */
  desactiveLe?: string;
  /**
   * Compteurs de JETONS cumulés des tours de fond de ce déclencheur (somme des
   * `usage` rapportés par chaque job). Absent ⇒ aucun tour n'a encore rendu de
   * compteur (on affiche « — », jamais « 0 »).
   */
  jetonsCumules?: SourceJetons;
  /** Instant ISO du prochain passage calculé (persisté ⇒ reprise après redémarrage). */
  prochainPassage?: string;
  /** Instant ISO du dernier passage PLANIFIÉ exécuté (ou sauté). */
  dernierPassage?: string;
  /** Compteur QUOTIDIEN des tours (clé = jour LOCAL du fuseau du déclencheur). */
  toursDuJour?: { jour: string; compte: number };
  /**
   * Conversation DÉDIÉE de la source (mode `source`). Créée par le clic
   * « Continuer dans une conversation » — ou par le premier message `lancer` :
   * ⚠️ ce fil-là est un fil NORMAL, VISIBLE dans la liste des conversations.
   */
  sessionId?: string;
  /** Instant ISO du dernier appel reçu (diagnostic, jamais un contenu). */
  dernierAppel?: string;
  /** Instant ISO de création du dernier jeton — jamais le jeton lui-même. */
  jetonCree?: string;
  /** Instant ISO de création de la source. */
  cree: string;
  /** Instant ISO de la dernière modification des réglages. */
  maj: string;
}

/** Vue PUBLIQUE d'une source (aucun jeton, aucune valeur de coffre). */
export interface SourceView extends SourceRecord {
  /** `true` si un jeton existe dans le coffre (jamais sa valeur). */
  jetonDefini: boolean;
}

/**
 * Conversation EXISTANTE proposée au sélecteur « Envoyer dans : » de `/config`.
 *
 * ⚠️ C'est la SEULE voie par laquelle un fil peut être désigné : l'utilisateur le
 * choisit dans cette liste, la configuration de la source le retient, et le client
 * extérieur continue de n'envoyer que `source` / `nouvelle` / `courante`.
 */
export interface SourceConversationView {
  /** Identifiant de la conversation (celui du host Pi). */
  id: string;
  /** Titre prêt à l'emploi (jamais vide). */
  titre: string;
  /** Dernière activité (ISO), si connue. */
  updatedAt?: string;
}

/** Entrée de la boîte « Notifications » (`sources-inbox.json`). */
export interface InboxEntry {
  /** Identifiant d'entrée attribué par Yuki (stable, unique). */
  id: string;
  /** Source émettrice (nom). */
  source: string;
  /** Instant ISO de réception. */
  recu: string;
  /** Titre facultatif fourni par la source (affiché dans la liste). */
  titre: string;
  /** Contenu — DONNÉE, jamais une instruction (échappé dans le cadre). */
  texte: string;
  /** Taille du contenu en octets (UTF-8). */
  octets: number;
  etat: InboxEntryState;
  /** Réponse de Yuki attachée à CETTE entrée (jamais une bulle dans un fil). */
  reponse?: string;
  /** L'utilisateur a-t-il ouvert/lu l'entrée (compteur de non-lus) ? */
  lu: boolean;
  /**
   * `true` tant que l'entrée n'a pas été remise au modèle dans un tour (drain
   * groupé). ⚠️ Interne : sert au drain, jamais un contenu.
   */
  enAttente: boolean;
  /**
   * Raison EXACTE d'un stockage ou d'un échec (`LLM_UNAVAILABLE`, `PI_NOT_READY`,
   * « aucune conversation ouverte »…). Jamais un succès inventé.
   */
  raison?: string;
  /**
   * Ce qui s'est passé MALGRÉ TOUT et que l'utilisateur doit savoir : fil visé
   * disparu, bascule de destination… Contrairement à `raison` (stockage/échec),
   * cette note SURVIT à un tour réussi : c'est le récit honnête de l'entrée.
   */
  note?: string;
  /** Identifiant du message d'origine fourni par la source (idempotence). */
  sourceId?: string;
  /** `true` si l'utilisateur a demandé à continuer DANS une conversation. */
  conversationOuverte?: boolean;
}

/** Réglages reçus par l'API pour créer/modifier une source. */
export interface SourceSettingsInput {
  consigne?: string;
  visibilite?: SourceVisibilite;
  destination?: SourceConversation;
  tour?: SourceTurn;
  notifier?: boolean;
  /** Type de déclencheur (`webhook` ou `planning` + expression + fuseau). */
  declencheur?: SourceDeclencheur;
  chevauchement?: SourceChevauchement;
  rattrapage?: SourceRattrapage;
  plafondMs?: number;
  maxToursParJour?: number;
  actif?: boolean;
}

/** Message reçu d'une source (corps JSON validé). */
export interface SourceMessageInput {
  id: string;
  texte: string;
  titre?: string;
  /** ⚠️ Sans effet si la source est silencieuse. */
  tour?: SourceTurn;
  /** ⚠️ Sans effet si la source est silencieuse (aucun Web Push). */
  notifier?: boolean;
  /** ⚠️ Sans effet si la source est silencieuse (destination non utilisée). */
  destination?: SourceConversation;
}

/** Issue d'une réception : ce que la route HTTP doit répondre. */
export interface SourceDelivery {
  /**
   * `started` = un tour a démarré ; `stored` = l'entrée attend dans la boîte ;
   * `duplicate` = `(source, id)` déjà vu ; `failed` = rien n'a pu démarrer
   * (déclencheur silencieux : journalisé `echec`, aucune entrée dans la boîte).
   */
  outcome: "started" | "stored" | "duplicate" | "failed";
  /** Entrée concernée (absente d'un doublon dont l'entrée a été supprimée). */
  entree?: InboxEntry;
  /** Raison EXACTE du stockage (absente quand un tour a démarré). */
  raison?: string;
}
