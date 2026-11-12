/**
 * UN ANNUAIRE D'AGENTS PAR BOT (lot 40).
 *
 * ⚠️ LE DÉFAUT QUE CE MODULE FERME : `AgentDirectoryService` porte le filtre de
 * visibilité `AgentRecord.bots` par une fermeture figée au démarrage
 * (`botCourant`, `src/index.ts`). Tant qu'un SEUL annuaire est construit pour
 * tout le processus, `lister_agents`/`etat_agent` répondent avec la visibilité
 * du bot de la PILE — y compris quand le tour tourne pour un AUTRE bot : le
 * modèle d'un bot voit alors des machines qu'il n'a pas le droit d'utiliser.
 *
 * La correction tient en une phrase : **un annuaire par bot**, chacun avec SON
 * `botCourant`, et l'on choisit l'annuaire selon le bot du RUN (le propriétaire
 * du canal, ou le bot de la conversation locale).
 *
 * ⚠️ Ce qui reste PARTAGÉ et ne doit jamais être dupliqué : le `AgentStore` (un
 * seul journal `agents.jsonl`), le `AgentHub` (une seule connexion mTLS par
 * agent) et l'`AuditLog`. Seule la FERMETURE de visibilité change.
 *
 * ⚠️ Le refus côté exécution (`authorize` → `agent_not_allowed`) est INCHANGÉ :
 * un identifiant forgé ne passe pas, même si l'affichage laissait voir l'agent.
 * Cacher n'est pas protéger — les deux sont nécessaires.
 */

/** Journal minimal attendu (le `Logger` de l'application le satisfait). */
export interface DirectoriesBotsLogger {
  info(message: string, fields?: Record<string, unknown>): void;
}

export interface OptionsDirectoriesAgentsBots<T> {
  /** Bot de la PILE (`main()`) : son annuaire est le PRINCIPAL, conservé tel quel. */
  readonly botDePile: string;
  /** Bots à DÉMARRER (L1) : leurs annuaires sont construits d'emblée. */
  readonly bots?: readonly string[];
  /** Fabrique : reçoit le bot dont l'annuaire portera la visibilité. */
  readonly creer: (botId: string) => T;
  readonly logger?: DirectoriesBotsLogger;
}

/**
 * Map `botId → annuaire`, un annuaire par bot.
 *
 * ⚠️ Deux invariants :
 *  1. **un seul annuaire par bot** (une Map, un identifiant construit une fois) ;
 *  2. **`pour()` ne rend JAMAIS l'annuaire d'un autre bot** : un bot inconnu du
 *     démarrage (créé depuis l'interface) obtient le SIEN, à la demande — jamais
 *     un repli sur le principal, qui afficherait les agents d'un autre.
 */
export class DirectoriesAgentsBots<T> {
  private readonly map = new Map<string, T>();
  private readonly botDePile: string;
  private readonly creer: (botId: string) => T;
  /** L'annuaire du bot de la PILE — EXACTEMENT celui d'avant le lot 40. */
  readonly principal: T;

  constructor(options: OptionsDirectoriesAgentsBots<T>) {
    this.botDePile = options.botDePile;
    this.creer = options.creer;
    this.principal = options.creer(options.botDePile);
    this.map.set(options.botDePile, this.principal);
    for (const botId of options.bots ?? []) {
      if (this.map.has(botId)) continue;
      this.map.set(botId, options.creer(botId));
    }
    // ⚠️ Diagnostic SANS contenu : des identifiants de bot, jamais un nom d'agent.
    options.logger?.info("agents.annuaires.bots", {
      pile: options.botDePile,
      nombre: this.map.size,
      ids: [...this.map.keys()].join(","),
    });
  }

  /**
   * Annuaire d'un bot. Un identifiant absent/vide désigne le bot de la PILE
   * (mode mono-bot historique) ; un bot inconnu obtient le sien, créé à la
   * demande.
   */
  pour(botId: string): T {
    const valeur = typeof botId === "string" ? botId.trim() : "";
    const cle = valeur === "" ? this.botDePile : valeur;
    const connu = this.map.get(cle);
    if (connu !== undefined) return connu;
    const cree = this.creer(cle);
    this.map.set(cle, cree);
    return cree;
  }

  /** Identifiants couverts (principal d'abord). */
  ids(): string[] {
    return [...this.map.keys()];
  }

  /** Nombre d'annuaires construits. */
  get taille(): number {
    return this.map.size;
  }
}
