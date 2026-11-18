/**
 * RÉSILIENCE du TEMPS RÉEL des plateformes (bug du 2026-11-18 : « le bot Mattermost
 * passe en « absent » au bout de quelques heures et ne revient JAMAIS »).
 *
 * ⚠️ CE QUE CE MODULE FERME : les deux sockets (`mattermost/ws.ts`, `discord/ws.ts`)
 * portaient chacune son propre backoff, PLAFONNÉ EN NOMBRE D'ESSAIS (`maxAttempts` = 20).
 * Une coupure qui durait plus longtemps que la somme des 20 délais (~15 min une fois le
 * plafond de 60 s atteint) suffisait donc à épuiser le compteur : plus AUCUNE
 * reconnexion n'était programmée, et le bot restait hors ligne jusqu'au redémarrage du
 * processus. C'est exactement le symptôme « revenu jamais ».
 *
 * Règle désormais UNIQUE et PARTAGÉE : backoff exponentiel PLAFONNÉ en DÉLAI (jamais en
 * nombre d'essais), avec GIGUE — donc jamais d'abandon définitif, et deux bots ne
 * retentent pas à la même milliseconde.
 *
 * Décisions PURES : aucun réseau, aucune horloge, aucun import SDK. Testable sans
 * serveur (l'horloge est celle des tests qui appellent `delaiRelance`).
 */

/** Délai de la PREMIÈRE reconnexion (1 s). */
export const RELANCE_DELAI_BASE_MS = 1_000;
/** Délai MAXIMAL entre deux tentatives (60 s) : plus lent ne répare rien de plus. */
export const RELANCE_DELAI_MAX_MS = 60_000;
/** Gigue maximale ajoutée (250 ms). */
export const RELANCE_GIGUE_MS = 250;

/**
 * Nombre d'essais au-delà duquel le libellé passe de « essai N » à une DURÉE.
 *
 * ⚠️ Une panne de plusieurs heures (serveur Mattermost éteint la nuit : ~480 essais pour
 * 8 h au plafond de 60 s) rend « essai 480 » illisible et inquiétant. Passé ce seuil, on
 * affiche depuis COMBIEN DE TEMPS la reconnexion tourne — c'est l'information utile.
 * En deçà, « essai N » reste plus parlant (on voit que ça progresse).
 */
export const SEUIL_ESSAIS_DUREE = 10;
/**
 * Borne de l'exposant : au-delà de 2^30 le délai plafonne de toute façon. La borner
 * évite `Infinity` et garde un calcul exact et lisible, essai après essai.
 */
const EXPOSANT_MAX = 30;

export interface RelanceOptions {
  /** Numéro de l'essai à programmer (0 = la toute première reconnexion). */
  essai: number;
  /** Délai de base (défaut 1 s). */
  baseDelayMs?: number;
  /** Plafond du délai exponentiel (défaut 60 s). */
  maxDelayMs?: number;
  /** Gigue maximale (défaut 250 ms). */
  jitterMs?: number;
  /** Tirage aléatoire dans [0, 1) — injecté pour que les tests soient déterministes. */
  random: () => number;
}

/**
 * Délai avant la reconnexion de l'essai `essai` : `min(plafond, base × 2^essai) + gigue`.
 *
 * ⚠️ Le plafond porte sur la CROISSANCE, la gigue s'ajoute après : c'est voulu, sinon
 * tous les bots atteignant le plafond retenteraient exactement ensemble.
 */
export function delaiRelance(options: RelanceOptions): number {
  const base = Math.max(1, options.baseDelayMs ?? RELANCE_DELAI_BASE_MS);
  const max = Math.max(base, options.maxDelayMs ?? RELANCE_DELAI_MAX_MS);
  const jitter = Math.max(0, options.jitterMs ?? RELANCE_GIGUE_MS);
  const essai = Number.isFinite(options.essai) ? Math.max(0, Math.floor(options.essai)) : 0;
  const croissance = Math.min(max, base * 2 ** Math.min(essai, EXPOSANT_MAX));
  const tirage = Math.min(1, Math.max(0, options.random()));
  return croissance + Math.round(tirage * jitter);
}

/** Reconnexion PROGRAMMÉE, telle qu'elle doit être VISIBLE dans l'état de la plateforme. */
export interface ReconnexionEnCours {
  /** Numéro de la tentative programmée (1 = la première). */
  essai: number;
  /** Motif de la coupure, en français (jamais un jeton, jamais une URL complète). */
  motif: string;
  /** Délai avant cette tentative, en millisecondes. */
  dansMs: number;
  /**
   * Temps écoulé DEPUIS LE DÉBUT de la panne (première coupure), en millisecondes.
   *
   * ⚠️ C'est ce qui permet d'écrire « depuis 8 h 12 min » au lieu d'« essai 480 » quand le
   * serveur reste éteint des heures. Absent quand la panne vient de commencer.
   */
  depuisMs?: number;
}

/** Motif de coupure CLASSÉ : c'est lui qui décide du texte et du journal employés. */
export type MotifCoupure = "serveur_injoignable" | "authentification_refusee" | "autre";

/**
 * Texte affiché quand le SERVEUR est en cause (éteint, réseau coupé).
 *
 * ⚠️ Formulé pour ne JAMAIS laisser croire à un problème du bot : un serveur arrêté la
 * nuit est un cas NORMAL, la boucle de reconnexion n'a rien à réparer — elle attend.
 */
export const PHRASE_SERVEUR_INJOIGNABLE =
  "Serveur injoignable — le serveur est peut-être arrêté ; la reconnexion se poursuit toute seule.";

/** Motif de repli quand le serveur n'a transmis aucune raison de fermeture. */
export const MOTIF_COUPURE_INCONNUE =
  "la connexion temps réel a été interrompue sans motif transmis par le serveur.";

/** Signatures d'un SERVEUR en cause (éteint, réseau, proxy) — jamais une faute du bot. */
const SIGNATURES_SERVEUR_INJOIGNABLE =
  /injoignable|impossible de se connecter|connexion refus[ée]e|ECONNREFUSED|ECONNRESET|ECONNABORTED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|network error|getaddrinfo/i;

/** Signatures d'un REFUS D'AUTHENTIFICATION (jeton mort) — à dire clairement. */
const SIGNATURES_AUTH_REFUSEE =
  /authentification refus[ée]e|refus[ée]e? l'authentification|refus[ée]e? le jeton|jeton[^.]{0,40}(refus|invalide|expir|rejet)|(refus|invalide|expir|rejet)[^.]{0,40}jeton|authentication failed|invalid token|401\b|4004\b/i;

/**
 * Classe un motif de coupure : « serveur injoignable », « authentification refusée » ou
 * « autre ».
 *
 * ⚠️ Les deux premiers cas exigent des TEXTES et des JOURNAUX DIFFÉRENTS : un serveur
 * éteint est normal et se répare seul au retour du serveur ; un jeton mort ne se répare
 * JAMAIS en réessayant et doit être dit sans détour (on ne boucle pas en silence dessus).
 */
export function classifierMotif(motif: string | undefined): MotifCoupure {
  const texte = (motif ?? "").trim();
  if (texte === "") return "autre";
  // ⚠️ L'AUTHENTIFICATION est testée EN PREMIER : un refus de jeton peut citer le serveur
  // (« le serveur a refusé… ») sans que le serveur soit pour autant injoignable.
  if (SIGNATURES_AUTH_REFUSEE.test(texte)) return "authentification_refusee";
  if (SIGNATURES_SERVEUR_INJOIGNABLE.test(texte)) return "serveur_injoignable";
  return "autre";
}

/**
 * Motif AFFICHABLE à partir du texte technique de la coupure.
 *
 * ⚠️ Un serveur injoignable reçoit la phrase HONNÊTE (`PHRASE_SERVEUR_INJOIGNABLE`) : le
 * détail technique reste dans le journal, l'utilisateur lit une cause vraie et sans
 * reproche. Les autres motifs sont rendus tels quels (ils sont déjà en français).
 */
export function motifAffiche(motif: string | undefined): string {
  const texte = (motif ?? "").trim();
  if (texte === "") return MOTIF_COUPURE_INCONNUE;
  if (classifierMotif(texte) === "serveur_injoignable") return PHRASE_SERVEUR_INJOIGNABLE;
  return texte;
}

/**
 * Durée LISIBLE (français) : « 12 s », « 45 min », « 8 h 12 min », « 3 j 4 h ».
 *
 * ⚠️ Deux unités au plus : au-delà, la précision n'aide plus et la phrase s'allonge.
 */
export function formatDuree(ms: number): string {
  const total = Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1_000)) : 0;
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} min`;
  const heures = Math.floor(minutes / 60);
  const resteMinutes = minutes % 60;
  if (heures < 24) return resteMinutes > 0 ? `${heures} h ${resteMinutes} min` : `${heures} h`;
  const jours = Math.floor(heures / 24);
  const resteHeures = heures % 24;
  return resteHeures > 0 ? `${jours} j ${resteHeures} h` : `${jours} j`;
}

/**
 * Phrase EXACTE montrée à l'utilisateur.
 *
 *  - premières tentatives : « Reconnexion en cours (essai N, dans X s) : motif » ;
 *  - après `SEUIL_ESSAIS_DUREE` essais : « Reconnexion en cours depuis 8 h 12 min — … ».
 *
 * ⚠️ Écrite UNE fois : les deux plateformes l'affichent telle quelle. Le motif est le
 * dernier motif CONNU de coupure ; sans lui, l'utilisateur ne verrait qu'« absent ».
 */
export function libelleReconnexion(reconnexion: ReconnexionEnCours): string {
  const motif = reconnexion.motif.trim();
  const classe = classifierMotif(motif);
  const depuis = reconnexion.depuisMs;
  if (
    reconnexion.essai >= SEUIL_ESSAIS_DUREE &&
    depuis !== undefined &&
    Number.isFinite(depuis)
  ) {
    const duree = formatDuree(Math.max(0, depuis));
    if (classe === "serveur_injoignable") {
      return `Reconnexion en cours depuis ${duree} — le serveur est peut-être arrêté`;
    }
    if (classe === "authentification_refusee") {
      return (
        `Reconnexion en cours depuis ${duree} — authentification refusée : ` +
        "le jeton du bot doit être corrigé"
      );
    }
    const suffixe = motif !== "" ? ` — ${motif}` : "";
    return `Reconnexion en cours depuis ${duree}${suffixe}`;
  }
  const secondes = Math.max(1, Math.round(reconnexion.dansMs / 1_000));
  const suffixe = motif !== "" ? ` : ${motif}` : "";
  return `Reconnexion en cours (essai ${reconnexion.essai}, dans ${secondes} s)${suffixe}`;
}

/**
 * Texte d'une RAISON de fermeture WebSocket.
 *
 * ⚠️ La bibliothèque `ws` transmet un `Buffer`, une doublure de test une `string` : sans
 * cette normalisation, la raison du serveur serait silencieusement perdue — et c'est
 * précisément le « motif de la dernière coupure » que l'interface doit afficher.
 */
export function texteRaisonFermeture(reason: unknown): string | undefined {
  if (typeof reason === "string") return reason.trim() === "" ? undefined : reason;
  if (reason instanceof Uint8Array) {
    const texte = Buffer.from(reason).toString("utf8").trim();
    return texte === "" ? undefined : texte;
  }
  return undefined;
}

/** Transition observée sur la connexion d'une plateforme. */
export type TransitionConnexion = "premiere" | "reprise" | "perte" | "stable";

/**
 * Suit les transitions de connexion pour ne réagir qu'aux VRAIES.
 *
 * ⚠️ Sert à relancer la synchronisation du miroir APRÈS une reconnexion (les messages
 * publiés pendant la coupure ne sont arrivés par aucun temps réel) sans la relancer à
 * chaque notification d'état — `onStateChange` est appelé bien plus souvent que la
 * connexion ne change.
 */
export class SuiviConnexion {
  private connecte = false;
  private aDejaConnecte = false;

  /** Observe l'état : rend `premiere`, `reprise`, `perte` ou `stable`. */
  observer(connecte: boolean): TransitionConnexion {
    const avant = this.connecte;
    this.connecte = connecte;
    if (connecte && !avant) {
      const premiere = !this.aDejaConnecte;
      this.aDejaConnecte = true;
      return premiere ? "premiere" : "reprise";
    }
    if (!connecte && avant) return "perte";
    return "stable";
  }
}
