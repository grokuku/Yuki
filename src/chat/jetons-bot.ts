/**
 * JETONS DE PLATEFORME PAR BOT (lot 36, morceau L10).
 *
 * ⚠️ CE QUE CE MODULE FERME : jusqu'ici le jeton Mattermost/Discord était
 * UNIQUE (`YUKI_CHAT_MATTERMOST`, `YUKI_CHAT_DISCORD`) et l'adaptateur aussi.
 * Deux bots ne pouvaient donc pas être connectés à la même plateforme en même
 * temps — et s'ils l'étaient par accident (même jeton recopié), les deux
 * répondraient au MÊME message : deux réponses, un seul auteur attendu.
 *
 * Trois règles :
 *  1. **un nom par bot** : `YUKI_CHAT_<BOT>__MATTERMOST` (et `__DISCORD`), même
 *     convention que les jetons de sources (`YUKI_SOURCE_<BOT>__<NOM>`,
 *     `src/sources/par-bot.ts`). Le bot `yuki` accepte EN PLUS l'ancien nom
 *     (`YUKI_CHAT_MATTERMOST`) : les installations existantes continuent de
 *     marcher sans réécrire un secret ;
 *  2. **refus du même jeton pour deux bots** : deux bots qui résolvent la MÊME
 *     valeur sont REFUSÉS ensemble, en les NOMMANT (le second ne se connecte
 *     pas) — jamais deux réponses pour un message ;
 *  3. **résolution du bot par le jeton** : `botDuJetonChat`, comme les webhooks
 *     de sources. Le bot vient du jeton reçu, jamais d'un champ de requête.
 *
 * ⚠️ Ce module ne connaît AUCUN adaptateur : il ne fait que nommer et résoudre.
 * La construction d'un adaptateur par bot est le morceau suivant
 * (`adaptateurs-bots.ts`), et c'est ce qui rend l'ensemble testable avec des
 * fixtures, sans vrai service externe.
 *
 * Aucun import SDK/typebox.
 */

import { BOT_YUKI } from "../bots/registry.js";

/** Préfixe commun des jetons de discussion. */
export const PREFIXE_SECRET_CHAT = "YUKI_CHAT";

/** Séparateur propriétaire/nom : impossible dans un slug de bot (`__`). */
export const SEPARATEUR_SECRET_CHAT = "__";

/** Plateformes distantes qui portent un jeton par bot. */
export const PLATEFORMES_CHAT = ["mattermost", "discord"] as const;
export type PlateformeChat = (typeof PLATEFORMES_CHAT)[number];

/**
 * Noms HISTORIQUES (jeton unique de l'instance), acceptés pour le bot `yuki`
 * seulement. ⚠️ Aucun autre bot n'a d'ancien nom : un jeton historique ne peut
 * donc jamais connecter un autre bot.
 */
export const SECRETS_CHAT_HISTORIQUES: Record<PlateformeChat, string> = {
  mattermost: "YUKI_CHAT_MATTERMOST",
  discord: "YUKI_CHAT_DISCORD",
};

/** Nom de secret du jeton d'un bot pour une plateforme. */
export function nomSecretChat(botId: string, plateforme: PlateformeChat): string {
  const proprietaire = String(botId).toUpperCase().replace(/-/g, "_");
  return (
    `${PREFIXE_SECRET_CHAT}_${proprietaire}` +
    `${SEPARATEUR_SECRET_CHAT}${plateforme.toUpperCase()}`
  );
}

/** Noms ACCEPTÉS pour le jeton d'un bot (le premier est celui d'un nouveau jeton). */
export function nomsSecretsChat(botId: string, plateforme: PlateformeChat): string[] {
  const noms = [nomSecretChat(botId, plateforme)];
  if (botId === BOT_YUKI) {
    const historique = SECRETS_CHAT_HISTORIQUES[plateforme];
    if (!noms.includes(historique)) noms.push(historique);
  }
  return noms;
}

/** Jeton RÉSOLU pour un bot et une plateforme. */
export interface JetonChat {
  readonly botId: string;
  readonly plateforme: PlateformeChat;
  /** Nom du secret qui a fourni la valeur (jamais la valeur au journal). */
  readonly nom: string;
}

/** Deux bots qui résolvent le MÊME jeton : refus qui nomme les deux. */
export interface ConflitJetonChat {
  readonly plateforme: PlateformeChat;
  readonly bots: readonly string[];
  readonly noms: readonly string[];
  readonly raison: string;
}

/** Résultat de la résolution des jetons de tous les bots. */
export interface ResolutionJetonsChat {
  /** `botId` → plateforme → jeton résolu (les bots en conflit sont ABSENTS). */
  readonly jetons: Map<string, Map<PlateformeChat, JetonChat>>;
  /** Conflits détectés (les bots concernés ne se connectent PAS). */
  readonly conflits: readonly ConflitJetonChat[];
}

/** Message de refus d'un jeton partagé (il NOMME les deux bots). */
export function messageJetonPartage(
  plateforme: PlateformeChat,
  bots: readonly string[],
): string {
  return (
    `Deux bots résolvent le MÊME jeton ${plateforme} (${bots.join(", ")}) : ` +
    "les deux se connecteraient au même compte et répondraient DEUX FOIS au même " +
    "message. Aucun des deux ne se connecte tant que chaque bot n'a pas son propre " +
    `jeton (${bots.map((bot) => nomSecretChat(bot, plateforme)).join(", ")}).`
  );
}

export interface OptionsResolutionJetonsChat {
  /** Bots à connecter (L1 : `aDemarrer`), plus le bot de la pile. */
  readonly bots: readonly string[];
  /** Lecture du coffre (valeur ou `undefined`). Jamais journalisée. */
  readonly lookup: (nom: string) => string | undefined;
  readonly logger?: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  };
}

/**
 * Résout les jetons de TOUS les bots, plateforme par plateforme.
 *
 * ⚠️ Un conflit est détecté sur la VALEUR, pas sur le nom : deux bots qui
 * recopient le même jeton sous deux noms différents sont exactement le cas à
 * refuser. Les deux bots sont alors ÉCARTÉS (aucun ne se connecte) : en
 * connecter un seul serait un choix arbitraire qui ferait taire l'autre sans
 * que personne ne l'ait décidé.
 */
export function resoudreJetonsChatBots(
  options: OptionsResolutionJetonsChat,
): ResolutionJetonsChat {
  const jetons = new Map<string, Map<PlateformeChat, JetonChat>>();
  const conflits: ConflitJetonChat[] = [];

  for (const plateforme of PLATEFORMES_CHAT) {
    /** Valeur → bots qui l'ont résolue (l'ordre d'itération est déterministe). */
    const parValeur = new Map<string, { bots: string[]; noms: string[] }>();
    for (const botId of options.bots) {
      for (const nom of nomsSecretsChat(botId, plateforme)) {
        const valeur = options.lookup(nom);
        if (valeur === undefined || valeur.trim() === "") continue;
        const entree = parValeur.get(valeur) ?? { bots: [], noms: [] };
        if (!entree.bots.includes(botId)) {
          entree.bots.push(botId);
          entree.noms.push(nom);
        }
        parValeur.set(valeur, entree);
        break; // Le premier nom résolu gagne (nom du bot, sinon historique).
      }
    }

    const refuses = new Set<string>();
    for (const [, entree] of parValeur) {
      if (entree.bots.length < 2) continue;
      const conflit: ConflitJetonChat = {
        plateforme,
        bots: [...entree.bots],
        noms: [...entree.noms],
        raison: messageJetonPartage(plateforme, entree.bots),
      };
      conflits.push(conflit);
      for (const botId of entree.bots) refuses.add(botId);
      options.logger?.warn("chat.jetons.conflit", {
        plateforme,
        bots: entree.bots.join(","),
        noms: entree.noms.join(","),
      });
    }

    for (const botId of options.bots) {
      if (refuses.has(botId)) continue;
      for (const nom of nomsSecretsChat(botId, plateforme)) {
        const valeur = options.lookup(nom);
        if (valeur === undefined || valeur.trim() === "") continue;
        const parBot = jetons.get(botId) ?? new Map<PlateformeChat, JetonChat>();
        parBot.set(plateforme, { botId, plateforme, nom });
        jetons.set(botId, parBot);
        break;
      }
    }
  }

  options.logger?.info("chat.jetons.bots", {
    bots: [...jetons.keys()].join(","),
    conflits: conflits.length,
  });
  return { jetons, conflits };
}

/**
 * Bot propriétaire d'un jeton REÇU, ou `undefined`.
 *
 * ⚠️ La comparaison se fait à la demande via `lookup` : la VALEUR des jetons
 * n'est jamais conservée par la résolution (seuls les NOMS le sont) — un jeton
 * ne traîne donc pas en mémoire au-delà du coffre. Un bot en CONFLIT n'est pas
 * dans `resolution.jetons` : il ne peut donc jamais revendiquer un jeton.
 */
export function botDuJetonChat(options: {
  resolution: ResolutionJetonsChat;
  plateforme: PlateformeChat;
  valeur: string | undefined;
  lookup: (nom: string) => string | undefined;
}): string | undefined {
  const recu = options.valeur;
  if (typeof recu !== "string" || recu.trim() === "") return undefined;
  for (const [botId, parPlateforme] of options.resolution.jetons) {
    const jeton = parPlateforme.get(options.plateforme);
    if (jeton === undefined) continue;
    if (options.lookup(jeton.nom) === recu) return botId;
  }
  return undefined;
}
