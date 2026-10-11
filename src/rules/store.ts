/**
 * `RulesStore` — règles strictes de Yuki : fichier + historique + journal.
 *
 * ⚠️ Les règles sont éditées UNIQUEMENT par l'utilisateur (`rules.md`) : chaque
 * écriture est VERSIONNÉE (snapshots horodatés, 20 conservés) et JOURNALISÉE
 * (avant/après, source, horodatage). L'écriture est ATOMIQUE (aucun fichier à
 * moitié écrit).
 *
 * Le MÉCANISME (lecture tolérante, borne signalée, historique, journal,
 * réversion) est le SOCLE PARTAGÉ `TextDocumentStore` (`src/state/`), le MÊME
 * que la personnalité. Cette classe ne fait que fixer la nature du document
 * (label de journalisation, bornes).
 *
 * Aucun import SDK/typebox.
 */

import { TextDocumentStore } from "../state/text-document-store.js";

import { RULES_HISTORY_MAX, RULES_MAX_CHARS } from "./rules.js";
import type { RulesAdminPort, RulesLogger } from "./types.js";

export interface RulesStoreOptions {
  /** Fichier de règles (ex. `/data/state/rules.md`). */
  path: string;
  /** Dossier des snapshots (défaut : `<dir(path)>/rules-history`). */
  historyDir?: string;
  /** Journal (défaut : `<dir(path)>/rules-journal.jsonl`). */
  journalPath?: string;
  logger?: RulesLogger;
  now?: () => number;
  /** Valeurs secrètes à masquer dans le journal (défaut : `collectSecretValues()`). */
  secretValues?: string[];
  /** Nombre de versions conservées (défaut : `RULES_HISTORY_MAX`). */
  historyMax?: number;
  /** Borne de caractères (défaut : `RULES_MAX_CHARS`). */
  maxChars?: number;
}

/**
 * Store des règles strictes. Implémente `RulesPort` (extension SDK, LECTURE
 * SEULE côté modèle) et `RulesAdminPort` (API `/api/self/rules`, réservée à
 * l'interface utilisateur).
 */
export class RulesStore extends TextDocumentStore implements RulesAdminPort {
  constructor(options: RulesStoreOptions) {
    super({
      path: options.path,
      ...(options.historyDir !== undefined ? { historyDir: options.historyDir } : {}),
      ...(options.journalPath !== undefined ? { journalPath: options.journalPath } : {}),
      ...(options.logger !== undefined ? { logger: options.logger } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.secretValues !== undefined
        ? { secretValues: options.secretValues }
        : {}),
      historyMax: options.historyMax ?? RULES_HISTORY_MAX,
      maxChars: options.maxChars ?? RULES_MAX_CHARS,
      label: "rules",
    });
  }
}
