/**
 * RÉSOLUTION UNIQUE DU « BOT COURANT » (lot 45).
 *
 * ⚠️ IL N'Y A PLUS DE « BOT PRINCIPAL » : plus aucun identifiant n'est privilégié
 * (`yuki` pas plus qu'un autre). « Yuki » doit pouvoir être supprimée comme
 * n'importe quel bot — décision utilisateur du 2026-11-13 :
 * « j'aimerais que l'on ait plus cette notion de bot principal. C'est pas
 * impossible qu'un jour je supprime Yuki et ne garde que les autres. »
 *
 * LA RÈGLE, ET UNE SEULE, dans cet ordre :
 *  ① le bot **DEMANDÉ** (`?b=` de la page, `?bot=` du WebSocket, `?bot=` d'une
 *    route) **s'il existe** ;
 *  ② sinon **le PREMIER du registre par `ordre`** (puis par `id` en cas
 *    d'égalité : deux redémarrages ne peuvent pas élire deux bots différents) ;
 *  ③ sinon une **erreur explicite** (`BotCourantError`, code `aucun_bot`) :
 *    jamais un nom en dur.
 *
 * ⚠️ Un bot DEMANDÉ mais INCONNU n'est PAS une erreur de résolution : la règle ②
 * s'applique (on affiche le premier par `ordre`) — une URL partagée qui désigne
 * un bot supprimé reste utilisable, elle ne produit pas un écran mort. Ce sont les
 * ÉCRITURES et le TRANSPORT qui refusent un bot inconnu, en le NOMMANT (404
 * `bot_not_found`, refus de poignée de main WebSocket) : ils ne résolvent pas un
 * « bot courant », ils cherchent un bot PRÉCIS.
 *
 * ⚠️ DEUX NOTIONS VOISINES, À NE PAS CONFONDRE (et elles ne sont PAS fusionnées
 * ici) :
 *  - le **bot du RUN** (`botDuRun`, ex-« bot de la pile ») : celui dont le
 *    processus tient les objets d'instance (`agentExecution`, configuration
 *    d'instance, mémoire, host par défaut du transport). Il est décidé UNE fois
 *    au démarrage (`preparerMultiBot`) : c'est le PREMIER bot à démarrer ;
 *  - le **bot COURANT** (ce module) : celui qu'une DEMANDE désigne, résolu à
 *    chaque requête. C'est lui que l'interface affiche.
 * Les deux valent le même bot tant que personne ne demande autre chose — mais
 * seule cette fonction décide, et elle ne privilégie aucun identifiant.
 *
 * Aucun import SDK/typebox.
 */

import {
  BOT_YUKI,
  CAPACITES_BOT,
  type BotRecord,
  type RegistreBots,
} from "./registry.js";

/** Code d'échec de résolution (stable, jamais un message seul). */
export type CodeBotCourant = "aucun_bot";

/** Résolution IMPOSSIBLE : elle NOMME ce qui a été demandé et ce qui existe. */
export class BotCourantError extends Error {
  override readonly name = "BotCourantError";
  readonly code: CodeBotCourant;
  /** Identifiant demandé (`null` : aucune demande ⇒ c'est « aucun bot »). */
  readonly demande: string | null;
  /** Identifiants connus au moment de l'échec (jamais un 404 muet). */
  readonly connus: readonly string[];

  constructor(
    code: CodeBotCourant,
    demande: string | null,
    connus: readonly string[],
    message: string,
  ) {
    super(message);
    this.code = code;
    this.demande = demande;
    this.connus = connus;
  }
}

/**
 * Bot HISTORIQUE du mode **mono-bot** (`state/bots.json` absent).
 *
 * ⚠️ `BOT_YUKI` ne survit QUE pour ce mode et pour la migration du lot 35a :
 * une installation mono-bot EST Yuki (il n'existe aucun autre identifiant dans
 * cette disposition), et le registre — seule source d'identité en multi-bot —
 * n'existe pas encore. Ce n'est PAS une valeur par défaut du multi-bot : dès
 * qu'un registre existe, seuls SES bots sont résolus.
 */
export function botHistoriqueMono(): BotRecord {
  return {
    id: BOT_YUKI,
    nom: "Yuki",
    capacites: [...CAPACITES_BOT],
    actif: true,
    ordre: 0,
    creeLe: "",
    plateformes: {},
  };
}

/**
 * Bots du registre, dans l'ordre DÉTERMINISTE d'affichage : `ordre`, puis `id`.
 * Ne modifie jamais le registre (copie triée).
 */
export function botsParOrdre(registre: RegistreBots | null): BotRecord[] {
  if (!registre) return [];
  return [...registre.bots].sort((a, b) =>
    a.ordre === b.ordre ? a.id.localeCompare(b.id) : a.ordre - b.ordre,
  );
}

/**
 * LE point de résolution du bot courant — le seul du produit.
 *
 * @param registre registre lu (`null` = mode mono-bot historique).
 * @param demande  identifiant DEMANDÉ (`?b=`, `?bot=`, trame WS) ; vide ou absent
 *                 ⇒ premier du registre par `ordre`.
 *
 * ⚠️ Lève `BotCourantError` (`aucun_bot`) s'il n'y a AUCUN bot à rendre. Une
 * demande inconnue retombe sur le premier par `ordre` (règle ②), jamais sur un
 * identifiant en dur.
 */
export function resoudreBotCourant(
  registre: RegistreBots | null,
  demande?: string | null,
): BotRecord {
  const ordonnes = botsParOrdre(registre);
  const demandeNette = typeof demande === "string" ? demande.trim() : "";

  if (demandeNette === "") {
    const premier = ordonnes[0];
    // ⚠️ Mode mono-bot : il n'y a pas de registre, et le bot de cette
    // disposition EST le bot historique. Aucune autre valeur n'est inventée.
    if (registre === null) return botHistoriqueMono();
    if (!premier) {
      throw new BotCourantError(
        "aucun_bot",
        null,
        [],
        "Aucun bot n'est disponible : le registre des bots est vide.",
      );
    }
    return premier;
  }

  const trouve = ordonnes.find((bot) => bot.id === demandeNette);
  if (trouve) return trouve;

  // ⚠️ Demande INCONNUE (bot supprimé, favori partagé, faute de frappe) : règle ②,
  // le premier par `ordre`. Aucun identifiant n'est inventé, et surtout pas
  // `yuki` : ce qui n'existe pas ne peut pas être « résolu ».
  const premier = ordonnes[0];
  if (!premier) {
    throw new BotCourantError(
      "aucun_bot",
      demandeNette,
      [],
      `Aucun bot n'est disponible pour « ${demandeNette} » : le registre des bots est vide.`,
    );
  }
  return premier;
}

/**
 * Variante NON LEVANTE de `resoudreBotCourant` (`null` quand rien ne peut être
 * résolu) : même règle, même ordre, AUCUN second algorithme — la seule
 * différence est qu'elle rend `null` au lieu de lever, pour les appelants qui
 * savent déjà dire l'absence (liste d'interface, décision de démarrage).
 *
 * ⚠️ Elle ne privilégie AUCUN identifiant : c'est l'ancien `botActif` de
 * `registry.ts`, qui plaçait `yuki` en tête. Ce privilège est SUPPRIMÉ.
 */
export function botActif(registre: RegistreBots | null): BotRecord | null {
  try {
    return resoudreBotCourant(registre);
  } catch {
    return null;
  }
}

/**
 * Valeur de repli INTERDITE : utilisée par les composants qui recevaient avant
 * ce lot un `yuki` en dur quand l'appelant ne disait pas pour quel bot il
 * travaillait. Elle lève en le nommant, plutôt que d'inventer une identité.
 */
export function botCourantRequis(origine: string): never {
  throw new BotCourantError(
    "aucun_bot",
    null,
    [],
    `${origine} : aucun bot courant fourni. Aucun bot n'est choisi par défaut ` +
      "(l'appelant doit dire POUR QUEL bot il travaille).",
  );
}
