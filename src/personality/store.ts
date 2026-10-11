/**
 * `PersonalityStore` — personnalité de Yuki : fichier + historique + journal.
 *
 * PROMESSES UTILISATEUR : la personnalité est un fichier Markdown LISIBLE et
 * CORRIGEABLE À LA MAIN (`personality.md`), chaque écriture est VERSIONNÉE
 * (snapshots horodatés, 20 conservés) et JOURNALISÉE (avant/après, source,
 * horodatage). L'écriture est ATOMIQUE (aucun fichier à moitié écrit).
 *
 * Le MÉCANISME (lecture tolérante, borne signalée, historique, journal,
 * réversion) est le SOCLE PARTAGÉ `TextDocumentStore` (`src/state/`), que les
 * règles strictes réutilisent à l'identique. Cette classe ne fait que fixer la
 * nature du document (label de journalisation, bornes).
 *
 * Aucun import SDK/typebox.
 */

import { TextDocumentStore } from "../state/text-document-store.js";

import { PERSONALITY_HISTORY_MAX, PERSONALITY_MAX_CHARS } from "./personality.js";
import type {
  PersonalityAdminPort,
  PersonalityLogger,
} from "./types.js";

export interface PersonalityStoreOptions {
  /** Fichier de personnalité (ex. `/data/state/personality.md`). */
  path: string;
  /** Dossier des snapshots (défaut : `<dir(path)>/personality-history`). */
  historyDir?: string;
  /** Journal (défaut : `<dir(path)>/personality-journal.jsonl`). */
  journalPath?: string;
  logger?: PersonalityLogger;
  now?: () => number;
  /** Valeurs secrètes à masquer dans le journal (défaut : `collectSecretValues()`). */
  secretValues?: string[];
  /** Nombre de versions conservées (défaut : `PERSONALITY_HISTORY_MAX`). */
  historyMax?: number;
  /** Borne de caractères (défaut : `PERSONALITY_MAX_CHARS`). */
  maxChars?: number;
}

/**
 * Store de personnalité. Implémente `PersonalityPort` (extension SDK) et
 * `PersonalityAdminPort` (API `/api/self/personality`).
 */
export class PersonalityStore
  extends TextDocumentStore
  implements PersonalityAdminPort
{
  constructor(options: PersonalityStoreOptions) {
    super({
      path: options.path,
      ...(options.historyDir !== undefined ? { historyDir: options.historyDir } : {}),
      ...(options.journalPath !== undefined ? { journalPath: options.journalPath } : {}),
      ...(options.logger !== undefined ? { logger: options.logger } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.secretValues !== undefined
        ? { secretValues: options.secretValues }
        : {}),
      historyMax: options.historyMax ?? PERSONALITY_HISTORY_MAX,
      maxChars: options.maxChars ?? PERSONALITY_MAX_CHARS,
      label: "personality",
    });
  }
}
