/**
 * UN SERVICE D'EXÉCUTION D'AGENTS PAR BOT (lot 36, morceau L6).
 *
 * ⚠️ LE DÉFAUT QUE CE MODULE FERME : `AgentExecutionService` porte le filtre de
 * visibilité `AgentRecord.bots` par une FERMETURE figée au démarrage
 * (`botCourant`, `src/index.ts` : `const botDuRun = bots.bot?.id ?? "yuki"`).
 * En multi-bot, cette constante est fausse dès le deuxième bot : un run de
 * `kohai` filtrerait les agents avec l'identité de `yuki` — soit en refusant un
 * agent autorisé pour `kohai`, soit, pire, en ACCEPTANT un agent qui ne l'est
 * que pour le principal.
 *
 * La correction tient en une phrase : **un service par bot**, chacun avec SON
 * `botCourant`, et l'on choisit le service selon le bot du RUN.
 *
 * ⚠️ Ce qui reste PARTAGÉ, et ne doit jamais être dupliqué :
 *  - le `AgentStore` (un seul journal `agents.jsonl` — un second store
 *    réécrirait le registre) ;
 *  - le `AgentHub` (une seule connexion mTLS par agent) ;
 *  - l'`AuditLog` et l'`ApprovalRegistry` ;
 *  - le serveur TLS 9443 (`createAgentsServer`), qui sert TOUS les bots.
 *
 * ⚠️ Le contrôle `AgentRecord.bots` reste **PAR COMMANDE** : il n'est pas
 * déplacé au moment de la connexion ni du choix du service. Un agent partagé
 * entre deux bots voit sa commande refusée quand elle vient du bot non autorisé
 * (`agent_not_allowed`), et acceptée quand elle vient de l'autre.
 *
 * Aucun import SDK/typebox : la classe est GÉNÉRIQUE (`T` = le service réel), et
 * la couture `creer` est le seul endroit qui le construit (testable avec un
 * double, comme `HostsBots`).
 */

/** Journal minimal attendu (le `Logger` de l'application le satisfait). */
export interface ExecutionsBotsLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface OptionsExecutionsBots<T> {
  /** Bot de la PILE (`main()`) : son service est le PRINCIPAL, conservé tel quel. */
  readonly botDePile: string;
  /** Bots à DÉMARRER (L1) — les refusés du plafond n'ont pas de service. */
  readonly bots: readonly string[];
  /** Fabrique : reçoit le bot dont le service portera la visibilité. */
  readonly creer: (botId: string) => T;
  readonly logger: ExecutionsBotsLogger;
}

/**
 * Map `botId → service d'exécution`, un service par bot.
 *
 * ⚠️ Deux invariants :
 *  1. **un seul service par bot** (une Map, un identifiant construit une fois) ;
 *  2. **le principal n'est pas dérivé** : `principal` est le service rendu par
 *     `creer(botDePile)` et c'est celui que `main()` garde sous le nom
 *     `agentExecution` (outils du host principal, routes, `getSubsystems`).
 */
export class ExecutionsAgentsBots<T> {
  private readonly map = new Map<string, T>();
  /** Le service du bot de la PILE — EXACTEMENT celui d'avant L6. */
  readonly principal: T;

  constructor(options: OptionsExecutionsBots<T>) {
    this.principal = options.creer(options.botDePile);
    this.map.set(options.botDePile, this.principal);
    for (const botId of options.bots) {
      if (this.map.has(botId)) continue;
      this.map.set(botId, options.creer(botId));
    }
    // ⚠️ Diagnostic SANS contenu : des identifiants, jamais un nom d'agent.
    options.logger.info("agents.executions.bots", {
      pile: options.botDePile,
      nombre: this.map.size,
      ids: [...this.map.keys()].join(","),
    });
  }

  /** Service d'un bot, ou `undefined` (bot non démarré, jamais de repli). */
  pour(botId: string): T | undefined {
    return this.map.get(botId);
  }

  /** Identifiants couverts (principal d'abord). */
  ids(): string[] {
    return [...this.map.keys()];
  }

  /** Nombre de services. */
  get taille(): number {
    return this.map.size;
  }

  /**
   * Applique une action à CHAQUE service (branchements tardifs : `setWaker`,
   * `setPreAutorisations`). ⚠️ Sans cela, un bot secondaire n'aurait jamais de
   * réveil de modèle ni de pré-autorisations — ses approbations resteraient
   * muettes.
   */
  pourChacun(action: (execution: T, botId: string) => void): void {
    for (const [botId, execution] of this.map) action(execution, botId);
  }
}

/**
 * Bot du RUN : celui qui a demandé la commande.
 *
 * ⚠️ Une valeur ABSENTE retombe sur le bot de la pile — c'est le cas du mode
 * mono-bot historique (aucune trame ne nomme de bot), et c'est le seul repli
 * autorisé : il ne change rien au comportement d'avant L6.
 */
export function botDuRun(botId: string | undefined, botDePile: string): string {
  const valeur = typeof botId === "string" ? botId.trim() : "";
  return valeur === "" ? botDePile : valeur;
}
