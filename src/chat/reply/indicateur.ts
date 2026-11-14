/**
 * INDICATEUR « le bot est en train d'écrire » (demande utilisateur du 2026-11-14).
 *
 * Il couvre la totalité d'un tour de réponse : de la RÉCEPTION du message (avant le
 * juge, avant le modèle) jusqu'à l'ENVOI DU DERNIER message du tour. Chaque plateforme
 * a son propre signal, et sa propre durée de vie :
 *
 *  - **Discord** : `POST /channels/{id}/typing` — l'indicateur expire au bout de
 *    ~10 s ⇒ réémission toutes les ~8 s (`INDICATEUR_INTERVALLE_DISCORD_MS`) ;
 *  - **Mattermost** : événement WebSocket `user_typing` — il expire au bout de ~5 s
 *    ⇒ réémission toutes les ~3 s (`INDICATEUR_INTERVALLE_MATTERMOST_MS`).
 *
 * ⚠️ CE MODULE NE CONNAÎT AUCUNE PLATEFORME : il ne sait qu'appeler `emettre()` à
 * intervalle. L'émission réelle (REST Discord, trame WebSocket Mattermost) est fournie
 * par l'adaptateur, qui seul connaît ses identifiants et son transport.
 *
 * ⚠️ BEST-EFFORT, NON NÉGOCIABLE : un échec de l'indicateur ne doit JAMAIS empêcher ni
 * retarder la réponse. L'émission est donc lancée sans être attendue (`void`), son
 * erreur est avalée — mais journalisée UNE SEULE FOIS (`chat.indicateur.echec`), pas à
 * chaque rafraîchissement.
 *
 * ⚠️ UNE SEULE BOUCLE PAR CANAL (`IndicateursEcriture`) : deux messages reçus pendant
 * une même réponse partagent la boucle existante (compteur de références). Sans cela,
 * deux minuteurs émettraient en parallèle et l'arrêt de l'un couperait l'indicateur de
 * l'autre.
 *
 * ⚠️ PLAFOND DUR (`INDICATEUR_PLAFOND_MS`, 2 min) : chaque PRISE porte son propre
 * minuteur de plafond. Un tour anormalement long (ou un `finally` oublié) ne laisse
 * donc jamais un indicateur tourner indéfiniment — et il n'y a pas de boucle infinie,
 * puisque la boucle s'arrête quand plus aucune prise n'est active.
 */

/** Raison d'arrêt d'un indicateur (code STABLE, journalisé). */
export type RaisonArretIndicateur =
  /** Le dernier message du tour est parti (ou tout a déjà été publié). */
  | "envoye"
  /** Le bot a décidé de ne PAS répondre (juge = non, pas de mention, anti-boucle…). */
  | "refus"
  /** Erreur, annulation ou déconnexion : jamais d'indicateur orphelin. */
  | "erreur"
  /** Le plafond dur est atteint : arrêt automatique. */
  | "plafond";

/** Journal minimal (le logger d'observabilité le satisfait). */
export interface IndicateurLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  /** Facultatif : sans lui, l'échec reste silencieux (mais la réponse part quand même). */
  warn?(message: string, fields?: Record<string, unknown>): void;
}

/** Prise rendue à l'appelant : arrête l'indicateur (idempotent). */
export interface IndicateurEcriture {
  /**
   * Arrête le rafraîchissement. Idempotent : un second appel (le `finally` après un
   * arrêt explicite) ne fait rien et ne journalise rien.
   */
  arreter(raison: RaisonArretIndicateur): void;
  /** `true` tant que la boucle de ce canal émet encore. */
  readonly actif: boolean;
  /** Nombre de FOIS où `emettre` a été appelé (mesure, tests). */
  readonly emissions: number;
}

/**
 * Durée de vie du signal Discord (~10 s côté plateforme) : on réémet à 8 s pour ne
 * jamais laisser un trou visible.
 */
export const INDICATEUR_INTERVALLE_DISCORD_MS = 8_000;

/**
 * Durée de vie du signal Mattermost (~5 s côté plateforme) : on réémet à 3 s.
 */
export const INDICATEUR_INTERVALLE_MATTERMOST_MS = 3_000;

/**
 * Plafond DUR d'un indicateur : au-delà, arrêt automatique (raison `plafond`).
 * Une réponse légitime tient largement dans deux minutes ; au-delà, c'est un défaut
 * (« jamais d'indicateur infini »).
 */
export const INDICATEUR_PLAFOND_MS = 120_000;

/** Minuteurs injectables (tests : horloge simulée). */
export type SetIndicateurTimer = (callback: () => void, ms: number) => unknown;
export type ClearIndicateurTimer = (handle: unknown) => void;

const setTimerParDefaut: SetIndicateurTimer = (callback, ms) => {
  const handle = setTimeout(callback, ms);
  if (typeof (handle as { unref?: () => void }).unref === "function") {
    (handle as { unref: () => void }).unref();
  }
  return handle;
};

const clearTimerParDefaut: ClearIndicateurTimer = (handle) => {
  if (handle !== null && handle !== undefined) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
};

/** Fabrique une prise qui ne fait rien (plateforme sans indicateur, test). */
export const INDICATEUR_INACTIF: IndicateurEcriture = {
  arreter: () => undefined,
  actif: false,
  emissions: 0,
};

/** Boucle d'émission d'UN canal (partagée par toutes les prises de ce canal). */
class BoucleIndicateur {
  private readonly canal: string;
  private readonly conversation: string | undefined;
  private readonly emettre: () => void | Promise<void>;
  private readonly intervalMs: number;
  private readonly logger: IndicateurLogger | undefined;
  private readonly setTimer: SetIndicateurTimer;
  private readonly clearTimer: ClearIndicateurTimer;
  private readonly now: () => number;
  private minuteur: unknown = null;
  private arretee = false;
  private enVol = false;
  private defaillanceJournalisee = false;
  private compteEmissions = 0;
  private readonly debut: number;

  constructor(options: {
    canal: string;
    conversation?: string;
    emettre: () => void | Promise<void>;
    intervalMs: number;
    logger?: IndicateurLogger;
    setTimer?: SetIndicateurTimer;
    clearTimer?: ClearIndicateurTimer;
    now?: () => number;
  }) {
    this.canal = options.canal;
    this.conversation = options.conversation;
    this.emettre = options.emettre;
    this.intervalMs = Math.max(1, Math.trunc(options.intervalMs));
    this.logger = options.logger;
    this.setTimer = options.setTimer ?? setTimerParDefaut;
    this.clearTimer = options.clearTimer ?? clearTimerParDefaut;
    this.now = options.now ?? Date.now;
    this.debut = this.now();
  }

  get emissions(): number {
    return this.compteEmissions;
  }

  /** Démarre la boucle : PREMIÈRE émission IMMÉDIATE, sans être attendue. */
  demarrer(): void {
    this.logger?.info("chat.indicateur.debut", {
      canal: this.canal,
      ...(this.conversation !== undefined ? { conversation: this.conversation } : {}),
      intervalMs: this.intervalMs,
    });
    this.emettreMaintenant();
    if (this.arretee) return;
    this.planifier();
  }

  /** Arrêt idempotent : journalise la raison UNE fois. */
  arreter(raison: RaisonArretIndicateur): void {
    if (this.arretee) return;
    this.arretee = true;
    if (this.minuteur !== null) {
      this.clearTimer(this.minuteur);
      this.minuteur = null;
    }
    this.logger?.info("chat.indicateur.fin", {
      canal: this.canal,
      ...(this.conversation !== undefined ? { conversation: this.conversation } : {}),
      raison,
      dureeMs: Math.max(0, this.now() - this.debut),
      emissions: this.compteEmissions,
    });
  }

  private planifier(): void {
    if (this.arretee) return;
    this.minuteur = this.setTimer(() => {
      this.minuteur = null;
      if (this.arretee) return;
      this.emettreMaintenant();
      this.planifier();
    }, this.intervalMs);
  }

  /**
   * Émet UN signal. Jamais attendu : un appel lent (HTTP, socket) ne doit pas retarder
   * le tour, et un échec ne doit pas le faire échouer.
   *
   * ⚠️ `enVol` empêche deux émissions simultanées : une plateforme lente ne reçoit pas
   * une file de signaux en retard.
   */
  private emettreMaintenant(): void {
    if (this.arretee || this.enVol) return;
    this.enVol = true;
    this.compteEmissions += 1;
    const terminer = (): void => {
      this.enVol = false;
    };
    try {
      const resultat = this.emettre();
      if (resultat !== null && typeof resultat === "object" && typeof resultat.then === "function") {
        resultat.then(terminer, (error: unknown) => {
          this.journaliserEchec(error);
          terminer();
        });
        return;
      }
      terminer();
    } catch (error) {
      this.journaliserEchec(error);
      terminer();
    }
  }

  /** Échec journalisé UNE fois (pas à chaque rafraîchissement). */
  private journaliserEchec(error: unknown): void {
    if (this.defaillanceJournalisee) return;
    this.defaillanceJournalisee = true;
    this.logger?.warn?.("chat.indicateur.echec", {
      canal: this.canal,
      ...(this.conversation !== undefined ? { conversation: this.conversation } : {}),
      error: error instanceof Error ? error.message : String(error),
      consequence:
        "l'indicateur « en train d'écrire » n'a pas pu être émis ; la réponse n'en est pas affectée",
    });
  }
}

/** Ce dont `IndicateursEcriture` a besoin (une émission par canal). */
export interface IndicateursEcritureOptions {
  /**
   * Émet le signal de CE canal (REST Discord, trame WebSocket Mattermost…).
   * `canal` = identifiant du CANAL chez la plateforme (le salon du FIL pour Discord).
   */
  emettre: (canal: string, conversationId: string) => void | Promise<void>;
  /** Intervalle de réémission (défaut : 8 s, valeur Discord). */
  intervalMs?: number;
  /** Plafond dur PAR PRISE (défaut : `INDICATEUR_PLAFOND_MS`). */
  plafondMs?: number;
  logger?: IndicateurLogger;
  /** Minuteurs injectables (tests : horloge simulée). */
  setTimer?: SetIndicateurTimer;
  clearTimer?: ClearIndicateurTimer;
  now?: () => number;
}

/** Entrée de la table : la boucle du canal et son nombre de prises actives. */
interface EntreeIndicateur {
  boucle: BoucleIndicateur;
  refs: number;
}

/**
 * INDICATEURS d'écriture, **un seul minuteur par canal**.
 *
 * ⚠️ Deux messages consécutifs dans le même canal ne créent pas deux boucles : la
 * seconde prise partage la boucle existante (compteur de références), et l'indicateur
 * ne s'arrête qu'après la dernière prise rendue. C'est ce qui garantit à la fois
 * « une seule boucle » et « pas de trou entre deux réponses simultanées ».
 */
export class IndicateursEcriture {
  private readonly options: IndicateursEcritureOptions;
  private readonly entries = new Map<string, EntreeIndicateur>();

  constructor(options: IndicateursEcritureOptions) {
    this.options = options;
  }

  /** Nombre de canaux dont la boucle émet encore (mesure, tests). */
  get actives(): number {
    return this.entries.size;
  }

  /** Nombre d'émissions tentées pour un canal (mesure, tests). */
  emissionsDe(canalId: string): number {
    return this.entries.get(canalId)?.boucle.emissions ?? 0;
  }

  /** `true` si la boucle d'un canal émet encore. */
  boucleActive(canalId: string): boolean {
    return this.entries.has(canalId);
  }

  /**
   * Démarre (ou rejoint) l'indicateur d'un CANAL et rend une PRISE.
   *
   * ⚠️ La clé est le CANAL de la plateforme (le salon du FIL pour Discord), pas la
   * conversation : deux messages consécutifs dans le même canal partagent donc la même
   * boucle, et un fil a la sienne.
   *
   * ⚠️ Rend une prise MÊME si le canal avait déjà une boucle : l'appelant doit toujours
   * l'arrêter (`finally`), sinon la boucle resterait active pour les autres prises.
   */
  demarrer(canalId: string, conversationId = canalId): IndicateurEcriture {
    const existante = this.entries.get(canalId);
    const entree =
      existante ??
      ({
        boucle: new BoucleIndicateur({
          canal: canalId,
          conversation: conversationId,
          emettre: () => this.options.emettre(canalId, conversationId),
          intervalMs: this.options.intervalMs ?? INDICATEUR_INTERVALLE_DISCORD_MS,
          ...(this.options.logger ? { logger: this.options.logger } : {}),
          ...(this.options.setTimer ? { setTimer: this.options.setTimer } : {}),
          ...(this.options.clearTimer ? { clearTimer: this.options.clearTimer } : {}),
          ...(this.options.now ? { now: this.options.now } : {}),
        }),
        refs: 0,
      } satisfies EntreeIndicateur);
    if (existante === undefined) {
      this.entries.set(canalId, entree);
      entree.boucle.demarrer();
    }
    entree.refs += 1;
    const prise = new PriseIndicateur(this, canalId, {
      setTimer: this.options.setTimer ?? setTimerParDefaut,
      clearTimer: this.options.clearTimer ?? clearTimerParDefaut,
      plafondMs: this.options.plafondMs ?? INDICATEUR_PLAFOND_MS,
    });
    return prise;
  }

  /** Arrête TOUTES les boucles (déconnexion de la plateforme). */
  arreterTout(raison: RaisonArretIndicateur = "erreur"): void {
    for (const [canalId, entree] of [...this.entries]) {
      entree.boucle.arreter(raison);
      this.entries.delete(canalId);
    }
  }

  /**
   * Rend une prise : décrémente son compteur, et arrête la boucle du canal quand plus
   * aucune prise n'est active.
   *
   * @internal — appelé uniquement par `PriseIndicateur`.
   */
  relacher(canalId: string, raison: RaisonArretIndicateur): void {
    const entree = this.entries.get(canalId);
    if (entree === undefined) return;
    entree.refs = Math.max(0, entree.refs - 1);
    if (entree.refs > 0) return;
    entree.boucle.arreter(raison);
    this.entries.delete(canalId);
  }
}

/** Prise d'un indicateur de canal. */
class PriseIndicateur implements IndicateurEcriture {
  private rendue = false;
  private minuteurPlafond: unknown = null;
  private readonly clearTimer: ClearIndicateurTimer;

  constructor(
    private readonly gestion: IndicateursEcriture,
    private readonly canalId: string,
    options: {
      setTimer: SetIndicateurTimer;
      clearTimer: ClearIndicateurTimer;
      plafondMs: number;
    },
  ) {
    // ⚠️ PLAFOND PAR PRISE : même si l'appelant oublie son `finally`, l'indicateur
    // s'arrête de lui-même au bout de `plafondMs`. Aucune boucle infinie possible.
    this.clearTimer = options.clearTimer;
    const plafond = Math.max(1, Math.trunc(options.plafondMs));
    this.minuteurPlafond = options.setTimer(() => {
      this.minuteurPlafond = null;
      this.arreter("plafond");
    }, plafond);
  }

  get actif(): boolean {
    return !this.rendue && this.gestion.boucleActive(this.canalId);
  }

  get emissions(): number {
    return this.gestion.emissionsDe(this.canalId);
  }

  arreter(raison: RaisonArretIndicateur): void {
    if (this.rendue) return;
    this.rendue = true;
    if (this.minuteurPlafond !== null) {
      this.clearTimer(this.minuteurPlafond);
      this.minuteurPlafond = null;
    }
    this.gestion.relacher(this.canalId, raison);
  }
}
