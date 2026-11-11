/**
 * LOT 36 (L1) — RÉSOLUTION DES BOTS AU DÉMARRAGE.
 *
 * ⚠️ DEUX NOTIONS DISTINCTES, et c'est TOUT l'objet de ce module :
 *  - le bot **PRINCIPAL** (`principal`) : celui dont l'identité sert de référence
 *    (c'est `botActif`, qui privilégie TOUJOURS `yuki`, `registry.ts:297-306`) ;
 *  - les bots qui **DOIVENT TOURNER** (`aDemarrer`) : tous ceux dont `actif` vaut
 *    `true`, triés par `ordre` puis par identifiant.
 *
 * Un bot principal peut donc ne pas tourner (l'utilisateur a éteint « yuki ») ;
 * et un bot qui tourne n'est pas forcément le principal. Les deux listes sont
 * rendues séparément plutôt que confondues : confondre les deux ferait d'un
 * bouton on/off un changement d'identité.
 *
 * ⚠️ PLAFOND : au-delà de `bots.maxActifs` (défaut 3), les bots actifs en trop
 * sont REFUSÉS — nommés un par un, jamais écartés en silence. Le plafond existe
 * parce que N piles vivent dans UN processus (N `PiHost`, N workers) : sans lui,
 * un registre édité à la main ferait tomber la machine sans prévenir.
 *
 * ⚠️ Ce module est PUR (aucune écriture, aucun démarrage) : il DÉCRIT ce que le
 * démarrage doit faire. Les tests le vérifient sans lancer de gateway.
 *
 * Aucun import SDK/typebox.
 */

import type { Env } from "../config/env.js";
import { lireValeurInstance } from "../config/runtime.js";

import {
  MAX_BOTS,
  botActif,
  type BotRecord,
  type RegistreBots,
} from "./registry.js";

/** Clé de configuration du plafond (portée `instance`). */
export const CLE_PLAFOND_ACTIFS = "bots.maxActifs";

/** Valeur par défaut du plafond (décision utilisateur : 3). */
export const MAX_ACTIFS_DEFAUT = 3;

/**
 * Normalise un plafond : entier dans `[1, MAX_BOTS]`.
 *
 * ⚠️ Une valeur absente, non numérique ou hors bornes retombe sur
 * `MAX_ACTIFS_DEFAUT` plutôt que de lever : le plafond est une PROTECTION, il ne
 * doit pas devenir une cause de démarrage impossible (`/config` peut contenir
 * une valeur héritée d'une version antérieure).
 */
export function normaliserPlafond(valeur: unknown): number {
  const nombre =
    typeof valeur === "number"
      ? valeur
      : typeof valeur === "string" && valeur.trim() !== ""
        ? Number(valeur)
        : Number.NaN;
  if (!Number.isFinite(nombre) || !Number.isInteger(nombre)) return MAX_ACTIFS_DEFAUT;
  if (nombre < 1) return 1;
  if (nombre > MAX_BOTS) return MAX_BOTS;
  return nombre;
}

/**
 * Plafond EFFECTIF lu depuis l'environnement (précédence de l'instance :
 * `défauts (code) < store (page web) < environnement`).
 *
 * ⚠️ Lecture DIRECTE et non lente du store d'instance : `preparerMultiBot` est
 * appelé AVANT `createConfigRuntime` (l'ordre du démarrage décide du `Env` du
 * bot). Un `ConfigStore.load()` ne lève jamais (repli sur les défauts), donc un
 * store illisible ne bloque pas le démarrage — il retombe simplement sur 3.
 */
export function lirePlafondActifs(
  env: Env,
  processEnv: NodeJS.ProcessEnv = process.env,
): number {
  return normaliserPlafond(lireValeurInstance(env, CLE_PLAFOND_ACTIFS, processEnv));
}

/**
 * Bots qui DOIVENT TOURNER : `actif === true`, triés par `ordre` puis par
 * identifiant (l'ordre doit être DÉTERMINISTE : deux redémarrages ne peuvent pas
 * élire deux bots différents selon l'ordre du fichier).
 */
export function botsAActiver(registre: RegistreBots): BotRecord[] {
  return registre.bots
    .filter((bot) => bot.actif === true)
    .sort((a, b) => (a.ordre === b.ordre ? a.id.localeCompare(b.id) : a.ordre - b.ordre));
}

/** Ce que le démarrage doit faire, calculé sans rien écrire. */
export interface ResolutionDemarrageBots {
  /** Bot d'IDENTITÉ (`botActif` privilégie `yuki`) — peut ne pas tourner. */
  readonly principal: BotRecord | null;
  /** Bots à démarrer, plafonnés, dans l'ordre. */
  readonly aDemarrer: readonly BotRecord[];
  /** Bots `actif` REFUSÉS par le plafond (nommés, jamais silencieux). */
  readonly refuses: readonly BotRecord[];
  /** Plafond appliqué (entier dans `[1, MAX_BOTS]`). */
  readonly plafond: number;
}

/**
 * Résout le démarrage. `maxActifs` absent ⇒ plafond par défaut (3).
 *
 * ⚠️ `aDemarrer` peut être VIDE (tous les bots éteints) : c'est un ÉTAT valide de
 * ce calcul, et c'est l'appelant qui refuse le démarrage avec un message clair
 * (`AUCUN_BOT_ACTIF`). Une fonction pure ne lève pas pour une configuration.
 */
export function resoudreDemarrageBots(
  registre: RegistreBots,
  options: { maxActifs?: unknown } = {},
): ResolutionDemarrageBots {
  const plafond = normaliserPlafond(options.maxActifs);
  const actifs = botsAActiver(registre);
  return {
    principal: botActif(registre),
    aDemarrer: actifs.slice(0, plafond),
    refuses: actifs.slice(plafond),
    plafond,
  };
}

/** Message d'avertissement (français) d'un bot REFUSÉ par le plafond. */
export function messageRefusPlafond(bot: BotRecord, plafond: number): string {
  return (
    `Le bot « ${bot.id} » devrait tourner mais n'a PAS démarré : la limite de ` +
    `${plafond} bot(s) en marche en même temps est atteinte (réglage ` +
    "`bots.maxActifs`). Éteignez un autre bot, puis réessayez."
  );
}
