/**
 * BORNE DURE des réponses simultanées d'un canal distant.
 *
 * ⚠️ CE QUE CE MODULE FERME : `reponsesEnCours` n'était qu'un COMPTEUR. En mode `tout`,
 * un canal actif lançait un run par message reçu, tous en parallèle, sans plafond — et un
 * premier backfill pouvait en lancer jusqu'à mille. Un compteur qui ne bloque rien ne
 * borne rien.
 *
 * ⚠️ DÉCISION TRANCHÉE : **file d'attente BORNÉE**, pas un refus sec au-delà de N.
 *  - un REFUS SEC perdrait la réponse à un message parfaitement légitime (trois personnes
 *    qui écrivent en même temps, et la troisième n'a jamais de réponse) : c'est un échec
 *    silencieux du point de vue de la personne qui a écrit ;
 *  - une file NON BORNÉE ne bornerait rien : elle stockerait mille réponses en attente,
 *    c'est-à-dire exactement le problème déplacé.
 *  Donc : `maxConcurrent` réponses EN COURS, `maxQueue` réponses EN ATTENTE, et au-delà de
 *  la file — un **refus EXPLICITE, journalisé**, jamais un message sans suite.
 *
 * ⚠️ Le module ne connaît ni plateforme ni réseau : il ne fait que sérialiser des tâches.
 * Il est partagé par les deux adaptateurs (Mattermost et Discord) pour que la borne soit
 * la MÊME des deux côtés et qu'elle ne puisse pas diverger.
 *
 * ⚠️ `run()` ne REJETTE jamais : une tâche défaillante est journalisée, la place est
 * rendue, la file avance. Un rejet non traité ferait tomber le processus.
 */

/** Réponses simultanées par défaut (un canal reste lisible : deux rédactions à la fois). */
export const REPLY_MAX_CONCURRENT = 2;

/** Réponses en attente par défaut (au-delà : refus explicite, journalisé). */
export const REPLY_MAX_QUEUE = 20;

/** Journal minimal (le logger d'observabilité le satisfait). */
export interface ReplyLimiterLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface ReplyLimiterOptions {
  /** Plateforme, pour le journal (`mattermost` / `discord`). */
  plateforme: string;
  /** Réponses simultanées (défaut `REPLY_MAX_CONCURRENT`). */
  maxConcurrent?: number;
  /** Réponses en attente (défaut `REPLY_MAX_QUEUE`). */
  maxQueue?: number;
  logger?: ReplyLimiterLogger;
}

export class ReplyLimiter {
  private readonly plateforme: string;
  private readonly maxConcurrent: number;
  private readonly maxQueue: number;
  private readonly logger: ReplyLimiterLogger | undefined;
  private actifs = 0;
  private readonly file: Array<() => void> = [];
  private refusees = 0;

  constructor(options: ReplyLimiterOptions) {
    this.plateforme = options.plateforme;
    this.maxConcurrent = Math.max(1, Math.trunc(options.maxConcurrent ?? REPLY_MAX_CONCURRENT));
    this.maxQueue = Math.max(0, Math.trunc(options.maxQueue ?? REPLY_MAX_QUEUE));
    this.logger = options.logger;
  }

  /** Réponses en cours de rédaction (mesure). */
  get enCours(): number {
    return this.actifs;
  }

  /** Réponses en attente d'une place (mesure). */
  get enAttente(): number {
    return this.file.length;
  }

  /** Réponses REFUSÉES faute de place (mesure : jamais silencieux). */
  get refuseesCount(): number {
    return this.refusees;
  }

  /**
   * Exécute `tache` dans la limite, ou la MET EN ATTENTE, ou la REFUSE.
   *
   * Rend une promesse résolue quand la tâche est terminée (ou immédiatement en cas de
   * refus) : l'appelant peut donc l'attendre sans se demander ce qui s'est passé.
   */
  async run(tache: () => Promise<void>): Promise<void> {
    if (this.actifs >= this.maxConcurrent) {
      if (this.file.length >= this.maxQueue) {
        this.refusees += 1;
        this.logger?.warn("chat.reply.refused", {
          plateforme: this.plateforme,
          raison: "file_pleine",
          enCours: this.actifs,
          enAttente: this.file.length,
        });
        return;
      }
      // On attend une PLACE ; le libérant nous la transmet (il incrémente `actifs`).
      await new Promise<void>((resolve) => {
        this.file.push(resolve);
      });
    } else {
      this.actifs += 1;
    }
    try {
      await tache();
    } catch (error) {
      this.logger?.warn("chat.reply.task_failed", {
        plateforme: this.plateforme,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.actifs -= 1;
      this.libererUnePlace();
    }
  }

  /** Transmet la place libérée au PREMIER message en attente (file FIFO). */
  private libererUnePlace(): void {
    const suivant = this.file.shift();
    if (!suivant) return;
    this.actifs += 1;
    suivant();
  }
}
