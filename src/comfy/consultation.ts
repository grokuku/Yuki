/**
 * MESURE de la consultation : pour CHAQUE génération, le style a-t-il été
 * consulté AVANT (`consulter_workflow`) ?
 *
 * ⚠️ POURQUOI CE COMPTEUR EXISTE : la consigne « consulte d'abord les consignes
 * du style » n'est PAS un garde-fou (décision utilisateur : on ne refuse jamais
 * une génération demandée). Ce compteur sert à DÉCIDER, plus tard et sur des
 * chiffres RÉELS de production : si le taux de consultation préalable est haut
 * (> 90 %), la consigne suffit ; s'il est bas (~30 %), il faudra un garde-fou.
 *
 * ⚠️ AUCUN TAUX N'EST FABRIQUÉ ICI : ce module ne fait que COMPTER des faits
 * observés (une consultation a-t-elle eu lieu pour cette session et ce workflow
 * avant la génération ?). Le taux réel n'est observable qu'en production.
 *
 * Module PUR : aucune I/O, aucun import SDK. Horloge et borne d'état injectables,
 * donc testable sans réseau ni modèle.
 */

/** Ce qu'on sait des consultations d'UNE conversation. */
interface SessionConsultations {
  /** Nom d'usage du workflow → date (ms) de la dernière consultation. */
  readonly consulted: Map<string, number>;
}

export interface WorkflowConsultation {
  /** Vrai si CE workflow a été consulté AVANT, dans CETTE conversation. */
  consultedBefore: boolean;
  /** Nombre total de générations observées (toutes conversations). */
  readonly generations: number;
  /** Nombre total de générations précédées d'une consultation du bon workflow. */
  readonly consultedBeforeCount: number;
  /** Nombre de conversations suivies (borne de mémoire). */
  readonly sessions: number;
}

export interface WorkflowConsultationTrackerOptions {
  /**
   * Nombre maximal de conversations suivies. Au-delà, la plus ancienne est
   * oubliée : le compteur ne doit jamais devenir un puits de mémoire (une
   * instance vit des semaines).
   */
  maxSessions?: number;
  now?: () => number;
}

/** Borne par défaut : largement au-delà d'un usage humain normal. */
export const MAX_TRACKED_SESSIONS = 200;

/**
 * Suivi des consultations, PAR CONVERSATION et PAR WORKFLOW.
 *
 * ⚠️ Clé de conversation : les outils sont PARTAGÉS entre les conversations d'un
 * même hôte (ils sont construits une fois), donc l'état ne peut pas vivre dans
 * une variable d'instance unique — sans la clé, une consultation faite dans un
 * fil compterait pour un autre.
 */
export class WorkflowConsultationTracker {
  private readonly sessions = new Map<string, SessionConsultations>();
  private readonly maxSessions: number;
  private readonly now: () => number;
  private generations = 0;
  private consultedBeforeCount = 0;

  constructor(options: WorkflowConsultationTrackerOptions = {}) {
    this.maxSessions = Math.max(1, options.maxSessions ?? MAX_TRACKED_SESSIONS);
    this.now = options.now ?? Date.now;
  }

  /** Conversation inconnue = clé stable (`""`), jamais `undefined`. */
  private sessionFor(sessionId: string | undefined): SessionConsultations {
    const key = sessionId ?? "";
    const existing = this.sessions.get(key);
    if (existing) return existing;
    // Éviction de la plus ancienne entrée (ordre d'insertion du `Map`).
    while (this.sessions.size >= this.maxSessions) {
      const oldest = this.sessions.keys().next();
      if (oldest.done) break;
      this.sessions.delete(oldest.value);
    }
    const created: SessionConsultations = { consulted: new Map() };
    this.sessions.set(key, created);
    return created;
  }

  /** Enregistre qu'un workflow vient d'être consulté (dans cette conversation). */
  markConsulted(sessionId: string | undefined, workflow: string): void {
    if (workflow === "") return;
    this.sessionFor(sessionId).consulted.set(workflow, this.now());
  }

  /** Vrai si CE workflow a déjà été consulté dans CETTE conversation. */
  wasConsulted(sessionId: string | undefined, workflow: string): boolean {
    const key = sessionId ?? "";
    return this.sessions.get(key)?.consulted.has(workflow) === true;
  }

  /**
   * Observe UNE génération : renvoie si le workflow retenu avait été consulté
   * avant, et les compteurs à jour (à journaliser / exposer).
   *
   * ⚠️ C'est le SEUL point d'incrément : une génération = un fait compté, qu'il
   * y ait eu consultation préalable ou non.
   */
  observe(sessionId: string | undefined, workflow: string): WorkflowConsultation {
    // La conversation est SUIVIE dès la première génération observée (même sans
    // consultation) : `sessions` compte donc les conversations réellement vues.
    const session = this.sessionFor(sessionId);
    const consultedBefore = session.consulted.has(workflow);
    this.generations += 1;
    if (consultedBefore) this.consultedBeforeCount += 1;
    return {
      consultedBefore,
      generations: this.generations,
      consultedBeforeCount: this.consultedBeforeCount,
      sessions: this.sessions.size,
    };
  }

  /** Instantané des compteurs (diagnostic / tests) — aucun taux inventé. */
  stats(): { generations: number; consultedBeforeCount: number; sessions: number } {
    return {
      generations: this.generations,
      consultedBeforeCount: this.consultedBeforeCount,
      sessions: this.sessions.size,
    };
  }
}
