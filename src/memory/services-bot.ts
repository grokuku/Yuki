/**
 * UN SERVICE DE MÉMOIRE PAR BOT (lot 36, morceau L11).
 *
 * ⚠️ LE DÉFAUT QUE CE MODULE FERME : le port `memory` du host était UN SEUL
 * service (`MemoryService`), adossé au `memory.jsonl` du bot de la pile. Les
 * hosts des autres bots n'en recevaient aucun — le port était RETIRÉ pour ne pas
 * leur faire lire la mémoire d'un autre. Résultat : un bot secondaire n'avait
 * **aucune mémoire** (ni rappel, ni écriture de fin de tour).
 *
 * La correction tient en une phrase : **un service par bot, adossé à SES stores**
 * (`FabriqueMemoireBots`, lot 35i/L3-b) — le store, l'index et le fichier sont
 * ceux du bot ; l'extracteur LLM, les bornes par défaut et le journal restent
 * ceux de l'INSTANCE.
 *
 * ⚠️ Trois invariants :
 *  1. **le service du bot de la PILE est celui de `main()`**, rendu par identité
 *     (`===`) : aucun comportement ne change pour lui ;
 *  2. **jamais deux services sur le même `memory.jsonl`** : la fabrique de
 *     stores rend le MÊME jeu d'objets pour un `botId` donné, et un service créé
 *     pour un bot n'est jamais réutilisé pour un autre ;
 *  3. **un bot sans stores ouverts les ouvre à sa PREMIÈRE demande** (paresseux),
 *     et le service n'est construit qu'à ce moment-là.
 *
 * ⚠️ Aucun import SDK/typebox : `T` est le service réel (`MemoryService`) et
 * `creer` est la seule couture, donc testable avec un double.
 */

import type { MemoryPort } from "./types.js";
import type { StoresMemoireBot } from "./stores-bot.js";

/** Journal minimal attendu (le `Logger` de l'application le satisfait). */
export interface ServicesMemoireLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

/** Un service de mémoire doit pouvoir être démarré et arrêté (`MemoryService`). */
export interface ServiceMemoireDemarrable extends MemoryPort {
  start(): void;
}

export interface OptionsServicesMemoire<T extends ServiceMemoireDemarrable> {
  /** Bot de la PILE (`main()`) : son service est le PRINCIPAL, jamais reconstruit. */
  readonly pile: string;
  /** Service du bot de la pile — celui que `main()` garde pour `/api/memory`. */
  readonly principal: T;
  /** Stores d'un bot (ouverte paresseuse, jamais deux jeux pour un bot). */
  readonly storesDe: (botId: string) => StoresMemoireBot;
  /** Fabrique : reçoit le bot et SES stores. Appelée une seule fois par bot. */
  readonly creer: (botId: string, stores: StoresMemoireBot) => T;
  readonly logger: ServicesMemoireLogger;
}

/**
 * Map `botId → service de mémoire`, construite à la demande.
 *
 * ⚠️ Aucun service n'est construit au démarrage par cette classe : elle ne fait
 * que SEMER celui de la pile. Un bot qui ne converse pas ne coûte donc rien.
 */
export class ServicesMemoireBots<T extends ServiceMemoireDemarrable> {
  private readonly options: OptionsServicesMemoire<T>;
  private readonly map = new Map<string, T>();

  constructor(options: OptionsServicesMemoire<T>) {
    this.options = options;
    this.map.set(options.pile, options.principal);
  }

  /**
   * Service de mémoire d'un bot.
   *
   * ⚠️ Le bot de la PILE rend le service de `main()` (identité `===`) : c'est ce
   * qui garantit que le bot principal se comporte EXACTEMENT comme avant L11.
   */
  pour(botId: string): T {
    if (botId === this.options.pile) return this.options.principal;
    const existant = this.map.get(botId);
    if (existant !== undefined) return existant;
    // ⚠️ Le service est adossé aux stores DU BOT : un seul `memory.jsonl` par
    // bot, donc aucune mémoire d'un autre ne peut être lue par ce service.
    const stores = this.options.storesDe(botId);
    const service = this.options.creer(botId, stores);
    service.start();
    this.map.set(botId, service);
    this.options.logger.info("memory.service.bot", {
      bot: botId,
      store: stores.fichier,
      index: stores.fichierIndex,
    });
    return service;
  }

  /** Le bot a-t-il un service CONSTRUIT (le principal compte) ? */
  a(botId: string): boolean {
    return this.map.has(botId);
  }

  /** Identifiants couverts (le principal d'abord). */
  ids(): string[] {
    return [...this.map.keys()];
  }

  /**
   * Oublie le service d'un bot ARRÊTÉ (L9) : ses stores sont fermés par la
   * fabrique (`fermerBot`), et un redémarrage reconstruit un service NEUF.
   *
   * ⚠️ Le service de la pile n'est jamais oublié (il vit avec l'instance).
   */
  oublier(botId: string): boolean {
    if (botId === this.options.pile) return false;
    return this.map.delete(botId);
  }
}
