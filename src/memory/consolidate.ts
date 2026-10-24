/**
 * Préparation des messages soumis à une passe de CONSOLIDATION (compaction ou
 * mise de côté) — fonctions PURES.
 *
 * Deux responsabilités, volontairement sorties de `./service.ts` pour être
 * TESTÉES en isolation :
 *  1. `sanitizeConsolidationMessages` : le FILTRE DÉTERMINISTE en amont (cadrages
 *     de données techniques retirés, prompts synthétiques écartés, contenu
 *     « vie antérieure » écarté). Aucune passe ne voit ce que le filtre exclut.
 *  2. `chunkMessages` : le DÉCOUPAGE BORNÉ. Une passe sur une conversation
 *     ENTIÈRE peut être longue : on borne (a) la taille d'UN appel et (b) le
 *     NOMBRE d'appels. Ce qui ne tient pas est signalé (`truncated`), jamais
 *     silencieux.
 *
 * Aucun import SDK/typebox.
 */

import { sanitizeMemoryText } from "./filter.js";
import { looksLikeHeritage } from "./heritage.js";
import type { ConsolidateMessage } from "./types.js";

/**
 * Borne de texte d'UN message dans un prompt de consolidation. Un message
 * assistant de 20 000 caractères ne doit pas, à lui seul, saturer l'entrée :
 * on garde le début (là où le fait durable est énoncé) et on marque la coupe.
 */
export const CONSOLIDATE_MESSAGE_MAX_CHARS = 1_500;

/** Message minimal accepté par une passe (rôle + texte). */
export interface RawConsolidateMessage {
  role: string;
  text: string;
}

/**
 * Applique le FILTRE DÉTERMINISTE à une conversation avant toute construction de
 * prompt :
 *  - blocs encadrés (`<sortie>`, `<libraire>`, `<agents_disponibles>`,
 *    `<regles>`, `<personnalite>`, `<vie_anterieure>`, `<conversations_archivees>`…)
 *    et leurs rappels de sécurité retirés ;
 *  - prompts synthétiques (rapport de tâche, résultat de commande) écartés ;
 *  - contenu se présentant comme une archive « vie antérieure » écarté ;
 *  - messages vides écartés.
 *
 * ⚠️ Les TÂCHES restent : la conversation est une DONNÉE, jamais une instruction.
 */
export function sanitizeConsolidationMessages(
  messages: readonly RawConsolidateMessage[],
): ConsolidateMessage[] {
  const cleaned: ConsolidateMessage[] = [];
  for (const message of messages) {
    const text = sanitizeMemoryText(message.text);
    if (text.length === 0) continue;
    if (looksLikeHeritage(text)) continue;
    cleaned.push({ role: message.role, text });
  }
  return cleaned;
}

/** Résultat du découpage : les morceaux + l'honnêteté sur ce qui a été borné. */
export interface ChunkedMessages {
  chunks: ConsolidateMessage[][];
  /** `true` si une partie de la conversation n'a pas été soumise (bornes). */
  truncated: boolean;
  /** Nombre de morceaux qui AURAIENT été nécessaires sans borne de nombre. */
  requiredChunks: number;
  /** Caractères effectivement soumis (tous morceaux confondus). */
  submittedChars: number;
}

export interface ChunkOptions {
  /** Taille maximale d'UN morceau (caractères de transcription). */
  maxChars: number;
  /** Nombre maximal de morceaux (donc d'appels au modèle) par passe. */
  maxChunks: number;
  /** Borne de texte d'un message (défaut `CONSOLIDATE_MESSAGE_MAX_CHARS`). */
  maxMessageChars?: number;
}

/** Tronque un message à la borne, avec un marqueur VISIBLE (jamais silencieux). */
function clampMessage(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)} …[message tronqué]` : trimmed;
}

/**
 * Découpe une conversation en morceaux de taille bornée.
 *
 *  - CHAQUE message est d'abord borné (`maxMessageChars`) ;
 *  - la conversation est répartie en morceaux de taille ~égale, au plus
 *    `maxChunks` ;
 *  - si la conversation exige PLUS de morceaux que `maxChunks`, on garde le
 *    PREMIER (le contexte, les faits posés au début) et les DERNIERS (l'état
 *    récent) : `truncated` vaut alors `true` et le milieu est signalé.
 *
 * Le découpage suit l'ordre chronologique et ne coupe jamais un message.
 */
export function chunkMessages(
  messages: readonly ConsolidateMessage[],
  options: ChunkOptions,
): ChunkedMessages {
  const maxChars = Math.max(1, options.maxChars);
  const maxChunks = Math.max(0, options.maxChunks);
  const maxMessageChars = Math.max(1, options.maxMessageChars ?? CONSOLIDATE_MESSAGE_MAX_CHARS);
  const prepared: ConsolidateMessage[] = [];
  for (const message of messages) {
    const text = clampMessage(message.text, maxMessageChars);
    if (text.length === 0) continue;
    prepared.push({ role: message.role, text });
  }
  if (prepared.length === 0 || maxChunks === 0) {
    return { chunks: [], truncated: prepared.length > 0, requiredChunks: 0, submittedChars: 0 };
  }
  const total = prepared.reduce((sum, message) => sum + message.text.length, 0);
  const requiredChunks = Math.max(1, Math.ceil(total / maxChars));
  // Tout tient ⇒ on RÉPARTIT équitablement (lecture intégrale) ; sinon chaque
  // morceau garde la borne `maxChars` et on ne garde qu'une sélection.
  const count = Math.min(requiredChunks, maxChunks);
  const targetChars =
    requiredChunks <= maxChunks ? Math.ceil(total / count) : maxChars;
  const all: ConsolidateMessage[][] = [];
  let current: ConsolidateMessage[] = [];
  let used = 0;
  for (const message of prepared) {
    if (current.length > 0 && used + message.text.length > targetChars) {
      all.push(current);
      current = [];
      used = 0;
    }
    current.push(message);
    used += message.text.length;
  }
  if (current.length > 0) all.push(current);
  // Garde : premier morceau + derniers morceaux (l'état récent est le plus utile).
  const kept =
    all.length <= maxChunks ? all : [all[0]!, ...all.slice(all.length - (maxChunks - 1))];
  const chunks = kept.filter((chunk) => chunk.length > 0);
  const submittedChars = chunks.reduce(
    (sum, chunk) => sum + chunk.reduce((inner, message) => inner + message.text.length, 0),
    0,
  );
  return {
    chunks,
    truncated: chunks.length < all.length,
    requiredChunks,
    submittedChars,
  };
}
