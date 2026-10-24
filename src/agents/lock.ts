/**
 * VERROU des agents « matériel sensible » — état ÉPHÉMÈRE, EN MÉMOIRE.
 *
 * ## Décisions utilisateur appliquées (2026-10-24)
 *
 * 1. **UN SEUL mot de passe pour l'INSTANCE** (pas un par agent) : il est stocké
 *    haché dans `src/security/instance-password.ts` et vérifié ici.
 * 2. **ÉTAT SÉPARÉ du niveau de garde-fou** : ce module ne touche JAMAIS
 *    `AgentStore` — le reverrouillage n'écrit RIEN dans `agents.jsonl` (ni
 *    « Désactivé », ni autre chose). Le niveau configuré survit intact.
 * 3. **Inactivité GLISSANTE de 15 min** : le compte repart à ZÉRO à chaque
 *    ACTIVITÉ réelle (pas 15 min après le déverrouillage).
 * 4. **Verrouillé + le modèle en a besoin ⇒ un MESSAGE** : aucune demande de mot
 *    de passe déclenchée par le modèle ; c'est l'utilisateur qui déverrouille
 *    depuis l'interface.
 *
 * ## Définition d'« ACTIVITÉ »
 *
 * Remet le compteur à zéro :
 *  - **une commande RÉELLEMENT TRANSMISE** à cet agent (`run_command`),
 *  - **une capture d'écran réellement transmise** (`capturer_ecran`) — c'est
 *    aussi une action exécutée SUR la machine sensible,
 *  - **le déverrouillage lui-même** (l'utilisateur vient d'agir).
 *
 * Ne remet PAS le compteur à zéro :
 *  - un REFUS (verrouillé, hors ligne, niveau `disabled`, validation refusée) :
 *    rien n'a été transmis ;
 *  - une entrée/sortie de connexion de l'agent (au contraire : une RECONNEXION
 *    REVERROUILLE — c'est un redémarrage côté machine, donc un nouveau cycle) ;
 *  - un ping/heartbeat, la consultation de la fiche (`lister_agents`,
 *    `etat_agent`) ou n'importe quelle lecture d'état.
 *
 * ## Cycle de vie
 *
 * - Un agent **sensible** est VERROUILLÉ **au démarrage** (la table des
 *   déverrouillages est vide) et **à chaque reconnexion** de l'agent
 *   (`attachHub`).
 * - Il se déverrouille avec le mot de passe d'instance, puis se **reverrouille
 *   tout seul** après `SENSITIVE_IDLE_TIMEOUT_MS` sans activité.
 * - Une commande EN VOL au moment du reverrouillage va à son terme (on ne tue
 *   rien) ; c'est la commande SUIVANTE qui est refusée.
 * - Un agent NON sensible n'est jamais verrouillé : ce module ne le concerne pas.
 */

import type { AgentStore } from "./store.js";

/**
 * Délai d'INACTIVITÉ (glissante) au-delà duquel un agent sensible se
 * reverrouille. 15 minutes, valeur demandée par l'utilisateur.
 */
export const SENSITIVE_IDLE_TIMEOUT_MS = 15 * 60_000;

/**
 * Période du balayage qui rend le reverrouillage VISIBLE (diffusion de la trame
 * `agents`) sans attendre une requête. Un balayage n'ÉTEND jamais un
 * déverrouillage : il ne fait que constater l'expiration.
 */
export const LOCK_SWEEP_INTERVAL_MS = 30_000;

export interface LockLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

/** Port MINIMAL consommé par l'exécution (aucun couplage de classe). */
export interface AgentLockPort {
  /** `true` si l'agent est sensible ET actuellement verrouillé. */
  isLocked(agentId: string): boolean;
  /** Activité RÉELLE transmise à l'agent : remet à zéro le compte d'inactivité. */
  touch(agentId: string): void;
}

/** Vérificateur de mot de passe (structurellement `InstancePasswordStore`). */
export interface InstancePasswordPort {
  isConfigured(): boolean;
  verify(password: unknown): boolean;
}

/** État d'un agent vis-à-vis du verrou (VUE, jamais un secret). */
export interface AgentLockStatus {
  /** L'agent est-il déclaré « matériel sensible » (réglage persisté) ? */
  sensitive: boolean;
  /** Est-il actuellement verrouillé (exécution refusée) ? */
  locked: boolean;
  /** Temps restant avant reverrouillage (ms), si déverrouillé. */
  remainingMs?: number;
}

export type AgentUnlockOutcome =
  | { ok: true; agentId: string; remainingMs: number }
  | { ok: false; code: string; message: string };

export interface AgentLockServiceOptions {
  /** Registre des agents (lecture seule : ce module n'écrit JAMAIS dedans). */
  store: Pick<AgentStore, "get">;
  /** Mot de passe d'instance (haché). Absent ⇒ aucun déverrouillage possible. */
  password?: InstancePasswordPort;
  logger?: LockLogger;
  /** Horloge INJECTABLE (tests) — aucune attente réelle de 15 min. */
  now?: () => number;
  /** Délai d'inactivité (défaut `SENSITIVE_IDLE_TIMEOUT_MS`). */
  idleTimeoutMs?: number;
}

/** Déverrouillage en cours : dernier instant d'ACTIVITÉ connu. */
interface UnlockState {
  unlockedAt: number;
  lastActivityAt: number;
}

export class AgentLockService implements AgentLockPort {
  private readonly store: Pick<AgentStore, "get">;
  private readonly password?: InstancePasswordPort;
  private readonly logger?: LockLogger;
  private readonly now: () => number;
  private readonly idleTimeoutMs: number;
  /** État ÉPHÉMÈRE : jamais persisté, perdu au redémarrage (= verrouillé). */
  private readonly unlocked = new Map<string, UnlockState>();
  private readonly listeners = new Set<() => void>();

  constructor(options: AgentLockServiceOptions) {
    this.store = options.store;
    this.password = options.password;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.idleTimeoutMs =
      options.idleTimeoutMs !== undefined && options.idleTimeoutMs > 0
        ? options.idleTimeoutMs
        : SENSITIVE_IDLE_TIMEOUT_MS;
  }

  /** Délai d'inactivité appliqué (ms) — exposé pour l'affichage et les tests. */
  get idleMs(): number {
    return this.idleTimeoutMs;
  }

  /** S'abonne aux changements d'état (déverrouillage / reverrouillage). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** `true` si la machine est déclarée « matériel sensible ». */
  isSensitive(agentId: string): boolean {
    return this.store.get(agentId)?.sensitive === true;
  }

  /**
   * `true` si l'agent est sensible ET verrouillé. Un agent non sensible n'est
   * JAMAIS verrouillé. L'expiration est évaluée PARESSEUSEMENT (avec l'horloge
   * injectée) : pas besoin d'un timer pour refuser une commande tardive.
   */
  isLocked(agentId: string): boolean {
    if (!this.isSensitive(agentId)) return false;
    const state = this.unlocked.get(agentId);
    if (!state) return true;
    if (this.now() - state.lastActivityAt >= this.idleTimeoutMs) {
      this.unlocked.delete(agentId);
      this.logger?.info("agents.lock.expired", {
        agent_id: agentId,
        idle_ms: this.idleTimeoutMs,
      });
      this.notify();
      return true;
    }
    return false;
  }

  /** Vue complète (sensible ? verrouillé ? temps restant ?). */
  status(agentId: string): AgentLockStatus {
    const sensitive = this.isSensitive(agentId);
    if (!sensitive) return { sensitive: false, locked: false };
    const locked = this.isLocked(agentId);
    if (locked) return { sensitive: true, locked: true };
    const state = this.unlocked.get(agentId) as UnlockState;
    return {
      sensitive: true,
      locked: false,
      remainingMs: Math.max(0, this.idleTimeoutMs - (this.now() - state.lastActivityAt)),
    };
  }

  /**
   * Activité RÉELLE : remet le compte d'inactivité à zéro. N'ouvre JAMAIS un
   * verrou (seul `unlock` le fait) et ne fait rien pour un agent verrouillé ou
   * non sensible.
   */
  touch(agentId: string): void {
    if (!this.isSensitive(agentId)) return;
    if (this.isLocked(agentId)) return;
    const state = this.unlocked.get(agentId);
    if (!state) return;
    state.lastActivityAt = this.now();
  }

  /**
   * Déverrouille un agent sensible avec le mot de passe d'INSTANCE.
   *
   * ⚠️ Ne lève jamais : renvoie `{ ok: false, code, message }` avec une cause
   * RÉELLE (agent inconnu, agent non sensible, aucun mot de passe défini,
   * mauvais mot de passe). Aucune valeur n'est journalisée (ni reçue ni stockée).
   */
  unlock(agentId: string, password: string): AgentUnlockOutcome {
    const record = this.store.get(agentId);
    if (!record) {
      return { ok: false, code: "agent_not_found", message: `Agent inconnu : ${agentId}.` };
    }
    if (record.sensitive !== true) {
      return {
        ok: false,
        code: "agent_not_sensitive",
        message:
          "Cet agent n'est pas déclaré « matériel sensible » : il n'est jamais " +
          "verrouillé, aucun déverrouillage n'est nécessaire.",
      };
    }
    if (!this.password || !this.password.isConfigured()) {
      return {
        ok: false,
        code: "password_not_set",
        message:
          "Aucun mot de passe d'instance n'est défini : impossible de déverrouiller " +
          "cet agent. Définissez-en un dans « Mot de passe d'instance ».",
      };
    }
    if (typeof password !== "string" || password.length === 0) {
      return {
        ok: false,
        code: "password_missing",
        message: "Mot de passe d'instance requis pour déverrouiller cet agent.",
      };
    }
    if (!this.password.verify(password)) {
      // ⚠️ NOMBRE d'échecs seulement : jamais la valeur tentée.
      this.logger?.warn("agents.lock.unlock_refused", {
        agent_id: agentId,
        reason: "invalid_password",
      });
      return {
        ok: false,
        code: "invalid_password",
        message: "Mot de passe d'instance incorrect : l'agent reste verrouillé.",
      };
    }
    const at = this.now();
    this.unlocked.set(agentId, { unlockedAt: at, lastActivityAt: at });
    this.logger?.info("agents.lock.unlocked", {
      agent_id: agentId,
      idle_ms: this.idleTimeoutMs,
    });
    this.notify();
    return { ok: true, agentId, remainingMs: this.idleTimeoutMs };
  }

  /**
   * Reverrouille un agent (ou ne fait rien s'il l'était déjà). Utilisé pour une
   * action explicite de l'utilisateur, à la reconnexion de l'agent et au
   * balayage. ⚠️ N'ÉCRIT RIEN dans le store : le niveau de garde-fou est intact.
   */
  lock(agentId: string, reason = "manual"): void {
    if (!this.unlocked.delete(agentId)) return;
    this.logger?.info("agents.lock.locked", { agent_id: agentId, reason });
    this.notify();
  }

  /** Reverrouille TOUS les agents sensibles déverrouillés. */
  lockAll(reason = "manual"): void {
    for (const agentId of [...this.unlocked.keys()]) this.lock(agentId, reason);
  }

  /**
   * Verrouille dès maintenant les agents sensibles connectés, puis à chaque
   * NOUVELLE connexion (reconnexion = nouveau cycle ⇒ verrouillé).
   *
   * ⚠️ Ne dépend d'aucun détail du hub : seulement de `subscribe` et
   * `onlineIds` (facile à doubler dans un test).
   */
  attachHub(hub: {
    subscribe(listener: () => void): () => void;
    onlineIds(): string[];
  }): () => void {
    const known = new Set(hub.onlineIds());
    for (const agentId of known) this.lock(agentId, "startup");
    return hub.subscribe(() => {
      const online = hub.onlineIds();
      for (const agentId of online) {
        if (known.has(agentId)) continue;
        known.add(agentId);
        this.lock(agentId, "reconnect");
      }
      const onlineSet = new Set(online);
      for (const agentId of [...known]) {
        if (!onlineSet.has(agentId)) known.delete(agentId);
      }
    });
  }

  /**
   * Balayage : reverrouille les déverrouillages EXPIRÉS (les rend visibles dans
   * l'interface sans attendre une requête). Renvoie les agents reverrouillés.
   */
  sweep(): string[] {
    const expired: string[] = [];
    for (const agentId of [...this.unlocked.keys()]) {
      if (this.isLocked(agentId)) expired.push(agentId);
    }
    return expired;
  }

  /**
   * Démarre le balayage périodique (défaut `LOCK_SWEEP_INTERVAL_MS`). Renvoie la
   * fonction d'arrêt (à appeler à l'extinction).
   */
  startSweep(intervalMs: number = LOCK_SWEEP_INTERVAL_MS): () => void {
    const timer = setInterval(() => {
      try {
        this.sweep();
      } catch (error) {
        this.logger?.warn("agents.lock.sweep_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, Math.max(250, intervalMs));
    timer.unref?.();
    return () => clearInterval(timer);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        this.logger?.warn("agents.lock.listener_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

/**
 * Message rendu au MODÈLE quand une commande tombe sur un agent sensible
 * verrouillé. Il dit la VRAIE raison et ce que l'utilisateur doit faire :
 * ⚠️ aucune demande de mot de passe n'est déclenchée par le modèle (décision
 * utilisateur n°4), et aucune cause inventée (le projet a déjà payé ça).
 */
export function lockedAgentMessage(agentLabel: string): string {
  const label = agentLabel !== "" ? `« ${agentLabel} »` : "cet agent";
  return (
    `Agent ${label} VERROUILLÉ (matériel sensible) : la commande n'a PAS été ` +
    "transmise et rien n'a été exécuté. Le déverrouillage est une action de " +
    "l'UTILISATEUR dans les paramètres (« Déverrouiller » sur la fiche de l'agent, " +
    "onglet Agents) — il faut son mot de passe d'instance. ⚠️ Ne demande pas de mot " +
    "de passe et n'invente aucune autre cause : préviens l'utilisateur et attends " +
    "qu'il ait déverrouillé l'agent."
  );
}
