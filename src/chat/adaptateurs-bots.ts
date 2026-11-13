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

export interface OptionsAdaptateursChatBots<T extends AdaptateurChatDemarrable> {
  /** Bot de la PILE : son adaptateur est celui d'avant (`existants`). */
  readonly botDuRun: string;
  /** Jetons résolus (`resoudreJetonsChatBots`) : la SEULE source des connexions. */
  readonly resolution: ResolutionJetonsChat;
  /** Adaptateurs DÉJÀ construits (ceux de `main()`), réutilisés par identité. */
  readonly existants?: ReadonlyMap<string, T>;
  /** Fabrique : appelée UNIQUEMENT pour une paire qui a un jeton. */
  readonly creer: (jeton: JetonChat) => T;
  readonly logger: AdaptateursChatLogger;
}

/** Bilan d'une connexion en masse. */
export interface BilanConnexionsChat {
  readonly connectes: string[];
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
  private readonly map = new Map<string, { jeton: JetonChat; adaptateur: T }>();
  private readonly connectes = new Set<string>();

  constructor(options: OptionsAdaptateursChatBots<T>) {
    this.options = options;
    for (const [cle, adaptateur] of options.existants ?? []) {
      // ⚠️ Le jeton de la pile est connu (ou absent) : on l'enregistre pour que
      // `pour()` et `connecterBot()` se comportent comme pour les autres bots.
      const [botId, plateforme] = cle.split(":");
      if (botId === undefined || plateforme === undefined) continue;
      this.map.set(cle, {
        jeton: { botId, plateforme: plateforme as PlateformeChat, nom: "" },
        adaptateur,
      });
    }
    for (const [botId, parPlateforme] of options.resolution.jetons) {
      for (const [plateforme, jeton] of parPlateforme) {
        const cle = cleAdaptateur(botId, plateforme);
        if (this.map.has(cle)) continue;
        this.map.set(cle, { jeton, adaptateur: options.creer(jeton) });
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
