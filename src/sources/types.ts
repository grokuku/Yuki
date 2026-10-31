/**
 * Domaine « SOURCES » — réveil GÉNÉRIQUE de Yuki par un programme extérieur.
 *
 * Une **source** est un programme (agrégateur de news, client de messagerie,
 * n'importe quoi) qui possède un `nom` et un `jeton`. Elle pousse des messages
 * authentifiés sur `POST /api/sources/<nom>/messages` ; Yuki les traite — soit
 * en démarrant un tour, soit en les empilant dans la boîte « Notifications ».
 *
 * Types PURS (aucun SDK, aucun I/O) : le store, la boîte, le service et l'API
 * HTTP les partagent.
 *
 * ⚠️ TROIS RÉGLAGES **INDÉPENDANTS** par source (aucun « mode » figé) :
 *   - OÙ       `conversation` : `aucune` (non configurée ⇒ rien ne part),
 *              `source` (fil dédié, créé s'il manque), `nouvelle` (un fil neuf à
 *              chaque fois), `courante` (la conversation ouverte), **ou
 *              l'identifiant d'une conversation EXISTANTE** choisie par
 *              l'utilisateur dans `/config` (⚠️ jamais par le client extérieur) ;
 *   - TOUR     `tour`         : `lancer` (démarre un tour) | `stocker` (boîte) ;
 *   - NOTIFIER `notifier`     : booléen (Web Push, à la demande de l'utilisateur).
 * Il n'existe AUCUN mode « répondre seulement si alerte » : ce comportement est
 * une CONSIGNE libre écrite par l'utilisateur (`consigne`), pas du code.
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

/** Ce que le message doit déclencher. */
export type SourceTurn = "lancer" | "stocker";

/**
 * État d'une entrée de la boîte.
 *
 * `alerte` est un AVIS DE YUKI (jamais un message reçu) : par exemple « ce fil a été
 * supprimé, la source qui y postait passe en nouvelle conversation ». Il n'est
 * jamais remis au modèle (`pending()` ne retient que `recu`).
 */
export type InboxEntryState = "recu" | "traite" | "echec" | "alerte";

/** Enregistrement persisté d'une source (`sources.json` sur le volume `state`). */
export interface SourceRecord {
  nom: string;
  /** Consigne LIBRE écrite par l'utilisateur (donnée de prompt, jamais du code). */
  consigne: string;
  /**
   * Destination : un MODE, ou l'identifiant d'une conversation existante choisie
   * par l'utilisateur dans `/config` (voir `SourceConversation`).
   */
  conversation: SourceConversation;
  tour: SourceTurn;
  notifier: boolean;
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
  conversation?: SourceConversation;
  tour?: SourceTurn;
  notifier?: boolean;
}

/** Message reçu d'une source (corps JSON validé). */
export interface SourceMessageInput {
  id: string;
  texte: string;
  titre?: string;
  tour?: SourceTurn;
  notifier?: boolean;
  conversation?: SourceConversation;
}

/** Issue d'une réception : ce que la route HTTP doit répondre. */
export interface SourceDelivery {
  /** `started` = un tour a démarré ; `stored` = l'entrée attend dans la boîte. */
  outcome: "started" | "stored" | "duplicate";
  /** Entrée concernée (absente d'un doublon dont l'entrée a été supprimée). */
  entree?: InboxEntry;
  /** Raison EXACTE du stockage (absente quand un tour a démarré). */
  raison?: string;
}
