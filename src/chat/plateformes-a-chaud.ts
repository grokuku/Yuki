/**
 * APPLICATION À CHAUD DES PLATEFORMES (bug du 2026-11-14 : « j'active Mattermost,
 * le bot reste absent et aucun canal n'apparaît »).
 *
 * ⚠️ CE QUE CE MODULE FERME : les adaptateurs de discussion n'étaient construits
 * qu'UNE fois, au démarrage (`src/index.ts`). L'interrupteur
 * `chat.<plateforme>.enabled` et l'adresse `chat.mattermost.url` portaient
 * pourtant `apply: "hot"` — l'interface affichait donc « à chaud » alors que
 * RIEN ne se connectait avant un redémarrage. C'était un mensonge de l'interface
 * doublé d'un silence.
 *
 * Ce module ne contient AUCUNE implémentation : il définit le PORT que les routes
 * HTTP consomment (`config.ts`, `secrets.ts`, `chat.ts`) et la règle PURE qui
 * retrouve le bot propriétaire d'un nom de secret. L'implémentation vit dans
 * `src/index.ts`, à côté du registre d'adaptateurs (`AdaptateursChatBots`).
 *
 * Aucun import SDK/typebox.
 */

import {
  PLATEFORMES_CHAT,
  PREFIXE_SECRET_CHAT,
  SEPARATEUR_SECRET_CHAT,
  type PlateformeChat,
} from "./jetons-bot.js";

/** État d'UNE plateforme d'un bot, tel que l'interface peut le MONTRER. */
export interface EtatPlateformeAChaud {
  /** Interrupteur `chat.<plateforme>.enabled` (l'intention de l'utilisateur). */
  readonly active: boolean;
  /** Jeton présent au coffre (jamais la valeur). */
  readonly jetonEnregistre: boolean;
  /** L'adaptateur existe-t-il dans ce processus ? */
  readonly adaptateur: boolean;
  /** `on` (connecté), `connexion` (en cours), `off` (pas configuré), `erreur`. */
  readonly etat: string;
  /** Pourquoi ce n'est pas connecté — en français, jamais un jeton. */
  readonly raison?: string;
  /** Canaux suivis dans le miroir de CE bot. */
  readonly canaux: number;
  /** Message d'HISTORIQUE non importé (bandeau), s'il y en a un. */
  readonly historiqueAnterieur?: boolean;
  /** Dernière synchronisation réussie (ISO), si connue. */
  readonly dernierContact?: string;
}

/** Bilan d'une réconciliation, tel qu'il est renvoyé à l'appelant HTTP. */
export interface BilanPlateformesAChaud {
  readonly bot: string;
  readonly connectes: string[];
  readonly reconnectes: string[];
  readonly deconnectes: string[];
  readonly echecs: { cle: string; error: string }[];
}

/**
 * PORT consommé par les routes HTTP.
 *
 * ⚠️ Toutes les méthodes sont ASYNCHRONES et ne lèvent jamais : un échec de
 * connexion est un RÉSULTAT (`echecs`), pas une exception qui rendrait une
 * écriture de configuration « ratée » alors qu'elle est bien enregistrée.
 */
export interface PlateformesAChaudPort {
  /**
   * Réconcilie les plateformes d'UN bot avec sa configuration FRAÎCHE : allume ce
   * qui vient d'être activé, éteint ce qui vient d'être désactivé, reconnecte ce
   * dont l'URL ou le jeton a changé.
   */
  rafraichir(botId: string): Promise<BilanPlateformesAChaud>;
  /** État lisible des plateformes d'un bot (`null` = bot inconnu de ce processus). */
  etat(botId: string): Record<PlateformeChat, EtatPlateformeAChaud> | null;
  /**
   * Resynchronise la DÉCOUVERTE des canaux d'un bot (canal ajouté récemment).
   * `null` = aucune plateforme connectée pour ce bot.
   */
  resynchroniser(botId: string): Promise<{ canaux: number } | null>;
  /**
   * Réconcilie le bot PROPRIÉTAIRE d'un nom de secret qui vient d'être écrit ou
   * supprimé (`YUKI_CHAT_<BOT>__<PLATEFORME>`) : c'est ce qui rend « je colle un
   * jeton » réellement instantané.
   */
  rafraichirPourSecret(nom: string): Promise<BilanPlateformesAChaud | null>;
}

/**
 * Bot PROPRIÉTAIRE d'un nom de secret de discussion, ou `null`.
 *
 * Règle inverse EXACTE de `nomSecretChat` (`src/chat/jetons-bot.ts`) : préfixe
 * `YUKI_CHAT`, séparateur `__`, propriétaire en majuscules avec `_` à la place
 * des `-`. Les anciens noms d'instance (`YUKI_CHAT_MATTERMOST`, sans `__`) ne
 * désignent AUCUN bot ici : ils ne disent pas à qui ils appartiennent, et la
 * réconciliation se fait alors sur le bot de la pile (appelant).
 */
export function botDeSecretChat(nom: string): { botId: string; plateforme: PlateformeChat } | null {
  if (typeof nom !== "string") return null;
  const prefixe = `${PREFIXE_SECRET_CHAT}_`;
  if (!nom.startsWith(prefixe)) return null;
  const reste = nom.slice(prefixe.length);
  const separateur = reste.indexOf(SEPARATEUR_SECRET_CHAT);
  if (separateur <= 0) return null;
  const proprietaire = reste.slice(0, separateur);
  const suffixe = reste.slice(separateur + SEPARATEUR_SECRET_CHAT.length).toLowerCase();
  const plateforme = PLATEFORMES_CHAT.find((candidate) => candidate === suffixe);
  if (plateforme === undefined) return null;
  // Le nom de secret ne peut pas porter d'identifiant de bot hors de ce motif :
  // un nom inattendu ne désigne aucun bot (aucune reconnexion inventée).
  if (!/^[A-Z][A-Z0-9_]*$/.test(proprietaire)) return null;
  return { botId: proprietaire.toLowerCase().replace(/_/g, "-"), plateforme };
}
