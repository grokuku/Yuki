/**
 * ÉTAT RÉEL D'UN BOT, ET DÉMARRAGE / ARRÊT PAR BOT (lot 36, morceau L8).
 *
 * ⚠️ CE QUE CE MODULE FERME : `GET /api/bots` lisait le champ `actif` du
 * REGISTRE (`state/bots.json`). Ce champ dit ce que le bot **doit** faire, pas
 * ce qu'il fait : un bot allumé mais dont le host a échoué au démarrage
 * s'affichait « actif », et un bot éteint dont la pile tournait encore
 * s'affichait « inactif ». **`actif` mentait.** L'état d'exécution, lui, vient
 * des objets qui tournent : host démarré, erreur de démarrage, sessions
 * réellement présentes, worker lourd construit.
 *
 * ⚠️ DÉMARRER **CRÉE** la pile puis le host s'ils n'existent pas (sinon le
 * bouton ne fait rien, ce qui était exactement le défaut à corriger), et
 * ARRÊTER les **DÉTRUIT** (host retiré de la Map, pile fermée, mémoire drainée,
 * TTS arrêté, run interrompu — `src/bots/arret.ts`).
 *
 * ⚠️ Le bot du run de l'instance n'est ni démarré ni arrêté par ces routes :
 * il tourne avec le gateway. Le refus le DIT (il n'est pas silencieux).
 *
 * Aucun import SDK/typebox : tout passe par des PORTS injectés, donc testable
 * sans `main()`.
 */

import { arreterBotProprement, type ArretBotLogger, type BilanArretBot } from "./arret.js";

/** État d'exécution d'un bot — ce qui TOURNE, jamais ce qui est écrit. */
export interface EtatExecutionBot {
  /** Host démarré (le bot peut recevoir des messages). */
  readonly demarre: boolean;
  /** Dernière erreur de démarrage/arrêt, si elle n'a pas été effacée par un succès. */
  readonly erreur?: string;
  /** Sessions réellement présentes pour ce bot (`sessionsDir`). */
  readonly sessions: number;
  /** Un worker lourd est-il construit POUR CE BOT ? (0/1, jamais un total). */
  readonly workers: number;
}

/** Port des hosts (réduit au cycle de vie : `HostsBots` le satisfait). */
export interface HostsCyclePort {
  estConstruit(botId: string): boolean;
  estDemarre(botId: string): boolean;
  demarrerBot(botId: string): Promise<{ ok: boolean; inchange: boolean; erreur?: string }>;
  arreterBot(botId: string): Promise<{ ok: boolean; inchange: boolean; erreur?: string }>;
}

export interface OptionsExecutionBots {
  /** Bot de la PILE : l'instance. Ni démarrable ni arrêtable par ces routes. */
  readonly botDuRun: string;
  readonly hosts: HostsCyclePort;
  /** Ouvre (ou crée) la pile de sources d'un bot — idempotent. */
  readonly ouvrirPile: (botId: string) => unknown;
  /** Ferme la pile de sources d'un bot. */
  readonly fermerPile?: (botId: string) => unknown;
  /** Compte les sessions d'un bot. */
  readonly sessions: (botId: string) => number;
  /** Worker lourd d'un bot (registre L7). */
  readonly workers: { a(botId: string): boolean };
  /**
   * Branche les PLATEFORMES d'un bot qu'on vient de démarrer (L10) : sa
   * connexion Mattermost/Discord reprend avec SES jetons. Absent ⇒ rien (mode
   * local). Un échec est journalisé et n'annule PAS le démarrage du host : le
   * bot répond quand même dans ses conversations locales.
   */
  readonly connecterPlateformes?: (botId: string) => Promise<void>;
  /** Étapes d'arrêt PROPRES à un bot (host, mémoire, TTS, run, plateforme). */
  readonly etapesArret?: (botId: string) => {
    run?: () => Promise<void> | void;
    sources?: () => Promise<void> | void;
    host?: () => Promise<void> | void;
    memory?: () => Promise<void> | void;
    pile?: () => Promise<void> | void;
    tts?: () => Promise<void> | void;
    plateforme?: () => Promise<void> | void;
  };
  readonly logger: ArretBotLogger;
}

/** Résultat d'un démarrage demandé par l'interface. */
export interface IssueDemarrageBot {
  readonly ok: boolean;
  /** `true` = le bot tournait déjà : rien n'a été fait. */
  readonly inchange: boolean;
  readonly botId: string;
  readonly etat: EtatExecutionBot;
  readonly raison?: string;
}

/** Résultat d'un arrêt demandé par l'interface. */
export interface IssueArretBot {
  readonly ok: boolean;
  readonly inchange: boolean;
  readonly botId: string;
  readonly etat: EtatExecutionBot;
  readonly bilan?: BilanArretBot;
  readonly raison?: string;
}

/**
 * Cycle de vie des bots : état, démarrage, arrêt.
 *
 * ⚠️ L'état est celui de l'EXÉCUTION : `hosts.estDemarre(botId)` et les compteurs
 * injectés. Le registre (`actif`) n'est jamais lu ici — c'est le point du lot.
 */
export class ExecutionBots {
  private readonly options: OptionsExecutionBots;
  /** Erreurs d'exécution en mémoire (effacées par un succès). */
  private readonly erreurs = new Map<string, string>();

  constructor(options: OptionsExecutionBots) {
    this.options = options;
  }

  /** État d'exécution d'un bot. */
  etat(botId: string): EtatExecutionBot {
    const erreur = this.erreurs.get(botId);
    return {
      demarre: this.options.hosts.estDemarre(botId),
      ...(erreur !== undefined ? { erreur } : {}),
      sessions: this.options.sessions(botId),
      workers: this.options.workers.a(botId) ? 1 : 0,
    };
  }

  /**
   * Enregistre les raisons d'échecs constatées au DÉMARRAGE de l'instance (lot 38).
   *
   * ⚠️ Sans cela, `hosts.demarrerAutres()` journalisait ses échecs mais l'état
   * d'exécution n'en savait rien : l'interface affichait « arrêté (erreur au
   * démarrage) » sans pouvoir dire POURQUOI. On garde le message RÉEL, tel quel.
   * Un succès ultérieur l'efface (comme `demarrer()`).
   */
  noterErreurs(raisons: Readonly<Record<string, string>> | undefined): void {
    if (raisons === undefined) return;
    for (const [botId, raison] of Object.entries(raisons)) {
      if (typeof raison === "string" && raison.trim() !== "") {
        this.erreurs.set(botId, raison);
      }
    }
  }

  /**
   * DÉMARRE un bot : ouvre sa pile (si absente) puis démarre son host (créé au
   * besoin). ⚠️ La pile AVANT le host : un host démarré sans pile n'aurait ni
   * sources ni envois programmés.
   */
  async demarrer(botId: string): Promise<IssueDemarrageBot> {
    if (botId === this.options.botDuRun) {
      return {
        ok: true,
        inchange: true,
        botId,
        etat: this.etat(botId),
        raison: "C'est le bot de l'instance : il tourne avec le gateway et ne s'arrête pas seul.",
      };
    }
    try {
      this.options.ouvrirPile(botId);
    } catch (error) {
      const raison = messageOf(error);
      this.erreurs.set(botId, raison);
      this.options.logger.warn("bots.demarrage.echec", { bot: botId, error: raison });
      return { ok: false, inchange: false, botId, etat: this.etat(botId), raison };
    }
    const issue = await this.options.hosts.demarrerBot(botId);
    if (!issue.ok) {
      const raison = issue.erreur ?? `Le bot « ${botId} » n'a pas pu démarrer.`;
      this.erreurs.set(botId, raison);
      this.options.logger.warn("bots.demarrage.echec", { bot: botId, error: raison });
      return { ok: false, inchange: false, botId, etat: this.etat(botId), raison };
    }
    this.erreurs.delete(botId);
    if (this.options.connecterPlateformes !== undefined) {
      try {
        await this.options.connecterPlateformes(botId);
      } catch (error) {
        this.options.logger.warn("bots.demarrage.plateforme_echec", {
          bot: botId,
          error: messageOf(error),
        });
      }
    }
    this.options.logger.info("bots.demarrage", { bot: botId, inchange: issue.inchange });
    return { ok: true, inchange: issue.inchange, botId, etat: this.etat(botId) };
  }

  /**
   * ARRÊTE un bot et DÉTRUIT ce qui tourne pour lui.
   *
   * ⚠️ Idempotent : un bot déjà arrêté rend `inchange: true` sans rien appeler
   * (aucune étape, aucun `stop` sur un host inexistant).
   */
  async arreter(botId: string): Promise<IssueArretBot> {
    if (botId === this.options.botDuRun) {
      return {
        ok: false,
        inchange: false,
        botId,
        etat: this.etat(botId),
        raison:
          `Le bot « ${botId} » est celui de l'instance : il ne s'arrête ` +
          "qu'avec le gateway.",
      };
    }
    const dejaArrete = !this.options.hosts.estConstruit(botId);
    const fournies = this.options.etapesArret?.(botId) ?? {};
    /**
     * ⚠️ ORDRE DE FERMETURE (L9) : d'abord ce qui PRODUIT (run, sources, host),
     * puis ce qui PERSISTE (mémoire), puis ce qui reste ouvert (pile, TTS,
     * plateforme). `host` et `pile` passent par les PORTS (ce module ne connaît
     * pas la Map des hosts) mais gardent leur place dans la séquence.
     */
    let issueHost: { ok: boolean; inchange: boolean; erreur?: string } = {
      ok: true,
      inchange: true,
    };
    const etapes = {
      ...(fournies.run !== undefined ? { run: fournies.run } : {}),
      ...(fournies.sources !== undefined ? { sources: fournies.sources } : {}),
      host: async (): Promise<void> => {
        issueHost = await this.options.hosts.arreterBot(botId);
        if (!issueHost.ok) throw new Error(issueHost.erreur ?? "arrêt du host impossible");
      },
      ...(fournies.memory !== undefined ? { memory: fournies.memory } : {}),
      ...(this.options.fermerPile !== undefined
        ? {
            pile: (): void => {
              this.options.fermerPile?.(botId);
            },
          }
        : {}),
      ...(fournies.tts !== undefined ? { tts: fournies.tts } : {}),
      ...(fournies.plateforme !== undefined ? { plateforme: fournies.plateforme } : {}),
    };
    const bilan = await arreterBotProprement({
      botId,
      dejaArrete,
      etapes,
      logger: this.options.logger,
    });
    if (bilan.ok) this.erreurs.delete(botId);
    else this.erreurs.set(botId, `Arrêt incomplet : ${bilan.echecs.map((e) => e.etape).join(", ")}`);
    return {
      ok: bilan.ok,
      inchange: dejaArrete && issueHost.inchange,
      botId,
      etat: this.etat(botId),
      bilan,
      ...(bilan.ok
        ? {}
        : { raison: `Arrêt incomplet : ${bilan.echecs.map((e) => e.etape).join(", ")}` }),
    };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
