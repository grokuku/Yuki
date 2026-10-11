/**
 * Domaine « règles strictes » de Yuki — TYPES PUBLICS.
 *
 * Les règles sont un **texte Markdown** éditable UNIQUEMENT par l'utilisateur,
 * stocké dans un fichier DÉDIÉ du volume `state` (`rules.md`), SÉPARÉ de la
 * personnalité (`personality.md`). Elles sont injectées à CHAQUE tour comme
 * PREMIÈRE base du prompt (AVANT la personnalité, la mémoire, l'annuaire des
 * agents et le signal d'archive), et versionnées (historique + retour arrière).
 *
 * Aucun import SDK/typebox : l'injection dans la conversation est confinée à
 * `src/pi/sdk/**`.
 *
 * Le MÉCANISME (lecture/écriture/historique/journal/réversion) est le socle
 * partagé `TextDocumentStore` (`src/state/`) : ces types en réexportent les
 * formes sous les noms du domaine.
 */

import type {
  TextDocumentHistoryEntry,
  TextDocumentLogger,
  TextDocumentReadResult,
  TextDocumentSource,
  TextDocumentWriteResult,
} from "../state/text-document-store.js";

/** Source d'une écriture de règles (qui l'a produite). */
export type RulesSource = TextDocumentSource;

/** Lecture des règles (contenu effectif, borné). */
export type RulesDocument = TextDocumentReadResult;

/**
 * Port MINIMAL consommé par l'extension SDK : lire les règles à chaud, sans
 * jamais lever.
 */
export interface RulesPort {
  /** Lit les règles FRAÎCHES (le fichier est relu à chaque tour). */
  read(): RulesDocument;
}

/** Sous-ensemble du logger d'observabilité utilisé par le domaine. */
export type RulesLogger = TextDocumentLogger;

/** Version de l'historique (snapshot horodaté). */
export type RulesHistoryEntry = TextDocumentHistoryEntry;

/** Résultat d'une écriture (ou d'un retour arrière). */
export type RulesWriteResult = TextDocumentWriteResult;

/**
 * Port d'ADMINISTRATION (API `/api/self/rules`) : lecture + écriture atomique +
 * historique/réversion. Implémenté par `RulesStore`.
 *
 * ⚠️ Ce port n'est exposé QU'À l'INTERFACE (route HTTP gardée, réservée à
 * l'utilisateur) : AUCUN outil du modèle ni extension SDK ne l'utilise pour
 * écrire. L'extension SDK ne consomme que `RulesPort` (lecture seule).
 */
export interface RulesAdminPort extends RulesPort {
  /** Borne de caractères (points de code) appliquée aux écritures et lectures. */
  readonly maxChars: number;
  /** Écrit (atomique) + snapshot + journal. Tronque à la borne (signalé). */
  write(text: string, source: RulesSource): RulesWriteResult;
  /** Restaure la version précédente (la plus récente différente de l'actuelle). */
  revert(source: RulesSource): RulesWriteResult | null;
  /** Versions de l'historique, de la plus récente à la plus ancienne. */
  history(limit?: number): RulesHistoryEntry[];
}
