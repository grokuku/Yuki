/**
 * UN ADAPTATEUR DE PLATEFORME PAR BOT (lot 36, morceau L10, suite).
 *
 * ⚠️ CE QUE CE MODULE FERME : le registre d'adaptateurs (`registerAdapterProvider`,
 * `src/chat/adapter.ts`) est MONO-INSTANCE — un seul adaptateur Mattermost, un
 * seul Discord, donc un seul compte connecté. En multi-bot, chaque bot a SON
 * jeton (`src/chat/jetons-bot.ts`) : il lui faut SON adaptateur, avec SON miroir
 * et SA connexion temps réel, dans le MÊME processus.
 *
 * Trois règles :
 *  1. **un adaptateur par (bot, plateforme)** : la Map le garantit, et une
 *     seconde construction pour la même paire est refusée (deux connexions au
 *     même compte = deux réponses) ;
 *  2. **aucun adaptateur sans jeton** : la fabrique n'est appelée que pour une
 *     paire résolue par `resoudreJetonsChatBots` (un bot sans jeton n'a rien à
 *     connecter) ;
 *  3. **le bot de la PILE garde l'adaptateur d'avant** (`existants`) : c'est
 *     l'objet que les routes d'instance et `getAdapter` servent, par identité.
 *
 * ⚠️ `connect()` est idempotent par paire, et `arreter(botId)` ne touche QUE ce
 * bot (arrêt ciblé, L9) : le bot du run n'est jamais déconnecté par là (son
 * adaptateur suit l'instance).
 *
 * Aucun import SDK/typebox : `T` est l'adaptateur réel, `creer` la seule couture
 * — donc des fixtures suffisent à tester la règle, sans service externe.
 */

import type { JetonChat, PlateformeChat, ResolutionJetonsChat } from "./jetons-bot.js";

/** Journal minimal attendu (le `Logger` de l'application le satisfait). */
export interface AdaptateursChatLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

/** Ce qu'il faut d'un adaptateur pour le cycle de vie (rien de plus). */
export interface AdaptateurChatDemarrable {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

/** Clé d'une paire (bot, plateforme). */
export function cleAdaptateur(botId: string, plateforme: PlateformeChat): string {
  return `${botId}:${plateforme}`;
}

/** Entrée du registre : le jeton, l'adaptateur, et l'empreinte de connexion connue. */
interface EntreeAdaptateur<T> {
  readonly jeton: JetonChat;
  readonly adaptateur: T;
  /** Empreinte de la connexion (URL + jeton) — comparée, jamais journalisée. */
  empreinte?: string;
}

/** Message d'une erreur, sans jamais exposer autre chose que son texte. */
function messageDe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Empreinte demandée pour une plateforme, ou `undefined` si l'appelant n'en fournit pas. */
function empreinteDe(
  demande: DemandeRafraichissementBot,
  plateforme: PlateformeChat,
): string | undefined {
  try {
    return demande.empreinte?.(plateforme);
  } catch {
    return undefined;
  }
}

export interface OptionsAdaptateursChatBots<T extends AdaptateurChatDemarrable> {
  /** Bot de la PILE : son adaptateur est celui d'avant (`existants`). */
  readonly botDuRun: string;
  /** Jetons résolus (`resoudreJetonsChatBots`) : la SEULE source des connexions. */
  readonly resolution: ResolutionJetonsChat;
  /** Adaptateurs DÉJÀ construits (ceux de `main()`), réutilisés par identité. */
  readonly existants?: ReadonlyMap<string, T>;
  /** Fabrique : appelée UNIQUEMENT pour une paire qui a un jeton. */
  readonly creer: (jeton: JetonChat) => T;
  /**
   * Empreinte de connexion d'une paire, lue à la CONSTRUCTION (jamais journalisée).
   * ⚠️ Sans elle, le PREMIER rafraîchissement d'une paire préexistante ne saurait
   * pas si son URL/jeton a changé depuis le démarrage — et une plateforme déplacée
   * vers un autre serveur resterait connectée à l'ancien.
   */
  readonly empreinte?: (jeton: JetonChat) => string;
  readonly logger: AdaptateursChatLogger;
}

/** Bilan d'une connexion en masse. */
export interface BilanConnexionsChat {
  readonly connectes: string[];
  readonly echecs: { cle: string; error: string }[];
}

/**
 * Ce qu'il faut pour RECONCILIER à chaud les paires d'UN bot avec sa config.
 *
 * ⚠️ C'EST LA RÉPONSE AU BUG « plateforme activée, bot absent » : jusqu'ici la
 * seule création d'adaptateur avait lieu au démarrage (`main()`), donc allumer
 * `chat.mattermost.enabled` ensuite n'ouvrait AUCUNE connexion.
 */
export interface DemandeRafraichissementBot {
  /** Bot dont on réconcilie les plateformes. */
  readonly botId: string;
  /** Jetons résolus MAINTENANT pour ce bot (`resoudreJetonsChatBots`). */
  readonly jetons: ReadonlyMap<PlateformeChat, JetonChat>;
  /**
   * Empreinte de connexion d'une plateforme (URL + jeton) : une valeur DIFFÉRENTE
   * de celle enregistrée ⇒ la connexion est ROUVERTE (autre serveur, autre jeton).
   * ⚠️ Comparée seulement, JAMAIS journalisée : elle contient le jeton.
   */
  readonly empreinte?: (plateforme: PlateformeChat) => string;
}

/** Bilan d'une réconciliation : ce qui a été ouvert, rouvert, fermé — et refusé. */
export interface BilanRafraichissementChat {
  readonly connectes: string[];
  readonly reconnectes: string[];
  readonly deconnectes: string[];
  readonly echecs: { cle: string; error: string }[];
}

/**
 * Map `(bot, plateforme) → adaptateur`.
 *
 * ⚠️ Aucune connexion n'est ouverte au constructeur : c'est `connecterTout()`
 * qui le fait, une fois, au démarrage du gateway (ou `connecterBot` pour un bot
 * démarré à la main, L8).
 */
export class AdaptateursChatBots<T extends AdaptateurChatDemarrable> {
  private readonly options: OptionsAdaptateursChatBots<T>;
  private readonly map = new Map<string, EntreeAdaptateur<T>>();
  private readonly connectes = new Set<string>();

  constructor(options: OptionsAdaptateursChatBots<T>) {
    this.options = options;
    for (const [cle, adaptateur] of options.existants ?? []) {
      // ⚠️ Le jeton de la pile est connu (ou absent) : on l'enregistre pour que
      // `pour()` et `connecterBot()` se comportent comme pour les autres bots.
      const [botId, plateforme] = cle.split(":");
      if (botId === undefined || plateforme === undefined) continue;
      this.enregistrer(cle, {
        botId,
        plateforme: plateforme as PlateformeChat,
        nom: "",
      }, adaptateur);
    }
    for (const [botId, parPlateforme] of options.resolution.jetons) {
      for (const [plateforme, jeton] of parPlateforme) {
        const cle = cleAdaptateur(botId, plateforme);
        if (this.map.has(cle)) continue;
        this.enregistrer(cle, jeton, options.creer(jeton));
      }
    }
    options.logger.info("chat.adaptateurs.bots", {
      nombre: this.map.size,
      paires: [...this.map.keys()].join(","),
      conflits: options.resolution.conflits.length,
    });
  }

  /** Adaptateur d'un bot pour une plateforme, ou `undefined`. */
  pour(botId: string, plateforme: PlateformeChat): T | undefined {
    return this.map.get(cleAdaptateur(botId, plateforme))?.adaptateur;
  }

  /** Enregistre une paire en LISANT son empreinte à la construction (voir `empreinte`). */
  private enregistrer(cle: string, jeton: JetonChat, adaptateur: T): void {
    let empreinte: string | undefined;
    try {
      empreinte = this.options.empreinte?.(jeton);
    } catch {
      // Une empreinte indisponible n'empêche aucune connexion : elle rend
      // seulement la comparaison impossible pour cette paire.
      empreinte = undefined;
    }
    this.map.set(cle, { jeton, adaptateur, ...(empreinte !== undefined ? { empreinte } : {}) });
  }

  /** Paires (bot, plateforme) qui ont un adaptateur. */
  paires(): { botId: string; plateforme: PlateformeChat }[] {
    return [...this.map.values()].map(({ jeton }) => ({
      botId: jeton.botId,
      plateforme: jeton.plateforme,
    }));
  }

  /** Bots connectés (au moins une plateforme). */
  botsConnectes(): string[] {
    return [...new Set([...this.connectes].map((cle) => cle.split(":")[0] as string))];
  }

  /** La paire est-elle connectée ? */
  estConnecte(botId: string, plateforme: PlateformeChat): boolean {
    return this.connectes.has(cleAdaptateur(botId, plateforme));
  }

  /**
   * Connecte TOUTES les paires qui ont un jeton, sauf le bot de la pile si
   * `sansPile` (son adaptateur est connecté par `main()`, comme avant L10).
   */
  async connecterTout(options: { sansPile?: boolean } = {}): Promise<BilanConnexionsChat> {
    const connectes: string[] = [];
    const echecs: { cle: string; error: string }[] = [];
    for (const [cle, { jeton, adaptateur }] of this.map) {
      if (options.sansPile === true && jeton.botId === this.options.botDuRun) continue;
      try {
        await adaptateur.connect();
        this.connectes.add(cle);
        connectes.push(cle);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        echecs.push({ cle, error: message });
        this.options.logger.warn("chat.adaptateur.connect_failed", { paire: cle, error: message });
      }
    }
    this.options.logger.info("chat.adaptateurs.connectes", {
      connectes: connectes.join(","),
      echecs: echecs.length,
    });
    return { connectes, echecs };
  }

  /** Connecte les plateformes d'UN bot (démarrage ciblé, L8). */
  async connecterBot(botId: string): Promise<BilanConnexionsChat> {
    const connectes: string[] = [];
    const echecs: { cle: string; error: string }[] = [];
    for (const [cle, { jeton, adaptateur }] of this.map) {
      if (jeton.botId !== botId) continue;
      if (this.connectes.has(cle)) continue;
      try {
        await adaptateur.connect();
        this.connectes.add(cle);
        connectes.push(cle);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        echecs.push({ cle, error: message });
        this.options.logger.warn("chat.adaptateur.connect_failed", { paire: cle, error: message });
      }
    }
    return { connectes, echecs };
  }

  /**
   * Déconnecte les plateformes d'UN bot (arrêt ciblé, L9).
   * ⚠️ Refuse le bot de la PILE : son adaptateur est celui de l'instance.
   */
  async deconnecterBot(botId: string): Promise<boolean> {
    if (botId === this.options.botDuRun) return false;
    let fait = false;
    for (const [cle, { jeton, adaptateur }] of this.map) {
      if (jeton.botId !== botId) continue;
      if (!this.connectes.has(cle)) continue;
      try {
        await adaptateur.disconnect();
        fait = true;
      } catch (error) {
        this.options.logger.warn("chat.adaptateur.disconnect_failed", {
          paire: cle,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.connectes.delete(cle);
    }
    if (fait) this.options.logger.info("chat.adaptateurs.deconnectes", { bot: botId });
    return fait;
  }

  /**
   * RÉCONCILIE À CHAUD les plateformes d'UN bot avec une résolution FRAÎCHE.
   *
   * Trois cas, et trois seulement :
   *  1. une paire DEMANDÉE qui n'existait pas ⇒ l'adaptateur est CRÉÉ et CONNECTÉ
   *     (c'est « j'active Mattermost et le bot se connecte, sans redémarrage ») ;
   *  2. une paire connue dont l'EMPREINTE a changé (URL ou jeton) ⇒ l'ancienne
   *     connexion est FERMÉE puis rouverte : deux bots, deux serveurs — un bot
   *     déplacé ne reste jamais branché à l'ancien ;
   *  3. une paire connue qui n'est PLUS demandée (interrupteur éteint, jeton
   *     effacé) ⇒ `disconnect()` puis oubli de l'adaptateur.
   *
   * ⚠️ Aucune exception ne remonte : chaque paire a son échec nommé (journal +
   * bilan), pour que l'interface puisse DIRE pourquoi le bot est absent.
   * ⚠️ Le bot de la PILE est traité comme les autres : allumer ou éteindre sa
   * plateforme depuis l'interface est exactement le même geste.
   */
  async rafraichirBot(demande: DemandeRafraichissementBot): Promise<BilanRafraichissementChat> {
    const { botId } = demande;
    const connectes: string[] = [];
    const reconnectes: string[] = [];
    const deconnectes: string[] = [];
    const echecs: { cle: string; error: string }[] = [];

    // ① ÉTEINDRE ce que la résolution fraîche ne contient plus.
    for (const [cle, entree] of [...this.map]) {
      if (entree.jeton.botId !== botId) continue;
      if (demande.jetons.has(entree.jeton.plateforme)) continue;
      if (this.connectes.has(cle)) {
        try {
          await entree.adaptateur.disconnect();
        } catch (error) {
          echecs.push({ cle, error: messageDe(error) });
          this.options.logger.warn("chat.adaptateur.disconnect_failed", {
            paire: cle,
            error: messageDe(error),
          });
        }
        this.connectes.delete(cle);
        deconnectes.push(cle);
      }
      this.map.delete(cle);
      this.options.logger.info("chat.adaptateur.eteint", { paire: cle });
    }

    // ② ALLUMER ou RECONNECTER ce qui est demandé.
    for (const [plateforme, jeton] of demande.jetons) {
      const cle = cleAdaptateur(botId, plateforme);
      const voulue = empreinteDe(demande, plateforme);
      const connue = this.map.get(cle);

      if (connue === undefined) {
        let adaptateur: T;
        try {
          adaptateur = this.options.creer(jeton);
        } catch (error) {
          const message = messageDe(error);
          echecs.push({ cle, error: message });
          this.options.logger.warn("chat.adaptateur.creation_failed", { paire: cle, error: message });
          continue;
        }
        this.map.set(cle, { jeton, adaptateur, ...(voulue !== undefined ? { empreinte: voulue } : {}) });
        try {
          await adaptateur.connect();
          this.connectes.add(cle);
          connectes.push(cle);
          this.options.logger.info("chat.adaptateur.cree", { paire: cle });
        } catch (error) {
          const message = messageDe(error);
          echecs.push({ cle, error: message });
          this.options.logger.warn("chat.adaptateur.connect_failed", { paire: cle, error: message });
        }
        continue;
      }

      // ② bis La connexion a-t-elle changé de DESTINATION (URL) ou de JETON ?
      const deplacee =
        voulue !== undefined && connue.empreinte !== undefined && connue.empreinte !== voulue;
      if (voulue !== undefined) connue.empreinte = voulue;
      if (deplacee) {
        try {
          if (this.connectes.has(cle)) await connue.adaptateur.disconnect();
          await connue.adaptateur.connect();
          this.connectes.add(cle);
          reconnectes.push(cle);
          this.options.logger.info("chat.adaptateur.reconnecte", { paire: cle });
        } catch (error) {
          const message = messageDe(error);
          this.connectes.delete(cle);
          echecs.push({ cle, error: message });
          this.options.logger.warn("chat.adaptateur.connect_failed", { paire: cle, error: message });
        }
        continue;
      }

      // ② ter Paire inchangée mais DÉCONNECTÉE (échec précédent) : on retente.
      if (this.connectes.has(cle)) continue;
      try {
        await connue.adaptateur.connect();
        this.connectes.add(cle);
        connectes.push(cle);
        this.options.logger.info("chat.adaptateur.cree", { paire: cle });
      } catch (error) {
        const message = messageDe(error);
        echecs.push({ cle, error: message });
        this.options.logger.warn("chat.adaptateur.connect_failed", { paire: cle, error: message });
      }
    }

    this.options.logger.info("chat.adaptateurs.rafraichis", {
      bot: botId,
      connectes: connectes.join(","),
      reconnectes: reconnectes.join(","),
      deconnectes: deconnectes.join(","),
      echecs: echecs.length,
    });
    return { connectes, reconnectes, deconnectes, echecs };
  }

  /**
   * Déconnecte TOUT (arrêt gracieux) — sauf le bot de la pile si `sansPile`
   * (son adaptateur est déconnecté par `main()`, comme avant L10).
   */
  async deconnecterTout(options: { sansPile?: boolean } = {}): Promise<void> {
    for (const [cle, { jeton, adaptateur }] of this.map) {
      if (options.sansPile === true && jeton.botId === this.options.botDuRun) continue;
      if (!this.connectes.has(cle)) continue;
      try {
        await adaptateur.disconnect();
      } catch {
        // Un arrêt gracieux ne lève jamais : chaque adaptateur a sa propre trace.
      }
      this.connectes.delete(cle);
    }
  }
}
