/**
 * OVERLAY de configuration d'un BOT (lot 35b, multi-bot étape 2).
 *
 * SECOND store, **jamais imbriqué** dans `config.json` : un fichier PLAT
 * `{ "clé": valeur }` (aucune enveloppe `schemaVersion`/`values`), écrit de
 * façon **atomique** en mode **0600**, à l'emplacement
 * `<state>/bots/<botId>/config.overlay.json` (voir
 * `src/config/paths.ts:resolveConfigOverlayPath`).
 *
 * ⚠️ POURQUOI UN FICHIER SÉPARÉ : le store commun (`config.json`) reste la
 * configuration de l'INSTANCE ; l'overlay porte les valeurs du bot ACTIF. Un
 * fichier plat et distinct rend le partage évident (`cat` suffit), ne mélange
 * jamais deux portées dans un même document, et permet de supprimer l'overlay
 * d'un bot sans toucher aux réglages d'instance.
 *
 * Repli silencieux, sans jamais écraser : fichier absent → aucune surcharge ;
 * JSON invalide ou non-objet → aucune surcharge + fichier CONSERVÉ tel quel (un
 * `EACCES` ne doit pas effacer un overlay). Le démarrage n'échoue JAMAIS à cause
 * de l'overlay ; en revanche une ÉCRITURE impossible lève la même
 * `ConfigStoreWriteError` explicite que le store commun.
 *
 * Aucun import SDK/typebox.
 */

import { existsSync, readFileSync } from "node:fs";

import { writeFileAtomic0600 } from "./store.js";

export type ConfigOverlaySource = "file" | "absent" | "invalid";

/**
 * Bot ACTIF par défaut — le seul bot existant à ce stade (lot 35b).
 * ⚠️ Doit rester égal à `BOT_YUKI` (`src/bots/registry.ts`) : un test de verrou
 * le compare, pour que le jour où le bot actif vient du registre
 * (`preparerMultiBot`), la valeur de repli ne dérive pas en silence.
 */
export const BOT_ID_DEFAUT = "yuki";

export interface ConfigOverlayLoad {
  /** Valeurs de l'overlay (vides si absent/invalide), NON validées. */
  values: Record<string, unknown>;
  source: ConfigOverlaySource;
  /** Motif du repli (fichier conservé) si `source === "invalid"`. */
  error?: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Accès fichier à l'overlay d'un bot. */
export class ConfigOverlayStore {
  constructor(readonly path: string) {}

  /** Le fichier existe-t-il ? */
  exists(): boolean {
    return existsSync(this.path);
  }

  /** Charge l'overlay. Ne lève jamais : replie sur « aucune surcharge ». */
  load(): ConfigOverlayLoad {
    if (!existsSync(this.path)) {
      return { values: {}, source: "absent" };
    }
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      return { values: {}, source: "invalid", error: messageOf(error) };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return { values: {}, source: "invalid", error: `JSON invalide : ${messageOf(error)}` };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { values: {}, source: "invalid", error: "objet JSON attendu" };
    }
    return { values: { ...(parsed as Record<string, unknown>) }, source: "file" };
  }

  /**
   * Écrit l'overlay (PLAT, atomique, 0600). Un objet vide écrit `{}` : le
   * fichier existe alors sans surcharge (état explicite, jamais un fichier
   * partiel).
   */
  write(values: Record<string, unknown>): void {
    writeFileAtomic0600(this.path, `${JSON.stringify(values, null, 2)}\n`);
  }
}
