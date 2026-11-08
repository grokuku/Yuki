/**
 * Choix du COMPTE modèle pour l'ÉCRITURE mémoire de fond (extraction de fin de
 * tour + consolidation avant compaction).
 *
 * Décision 2026-10-11 : l'écriture de fond bascule sur le compte LOURD (déclaré
 * multi-slots) pour LIBÉRER le compte léger (déclaré mono-slot) — le run de
 * conversation suivant ne subit plus l'attente de l'écriture de fond (« ça
 * mouline » sans indicateur). Repli sur le léger si le lourd n'est pas
 * disponible (clé absente) : on ne perd JAMAIS la mémoire.
 *
 * ⚠️ Le rappel (`recall`) n'est PAS concerné : il reste LOCAL (index FTS5),
 * borné à quelques centaines de ms, sans appel modèle.
 */

/** Références et disponibilité des deux comptes modèle. */
export interface MemoryWriteModelRoles {
  /** Le compte lourd est-il disponible (clé présente) au démarrage ? */
  heavyAvailable: boolean;
  /** Référence `provider/modelId` du compte lourd. */
  heavyRef: string;
  /** Référence `provider/modelId` du compte léger (repli). */
  lightRef: string;
  /** Logger pour journaliser un repli (optionnel). */
  logger?: {
    warn(message: string, fields?: Record<string, unknown>): void;
    info?(message: string, fields?: Record<string, unknown>): void;
  };
  /** Nom de l'usage déclenchant ce repli (pour le journal). */
  usage?: string;
}

/**
 * Référence modèle à utiliser pour l'écriture mémoire de fond.
 * Le lourd est préféré dès qu'il est disponible, sinon on retombe sur le léger.
 */
export function memoryWriteModelReference(roles: MemoryWriteModelRoles): string {
  if (roles.heavyAvailable) return roles.heavyRef;
  const log = roles.logger?.warn ?? roles.logger?.info;
  if (log) {
    log("llm.fallback", {
      usage: roles.usage ?? "travail-de-fond",
      de: "heavy",
      vers: "light",
      raison: "modèle de travail indisponible",
    });
  }
  return roles.lightRef;
}
