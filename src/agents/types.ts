/**
 * Types du domaine `agents` — store des agents appairés (Lot 4).
 *
 * AUCUN import du SDK Pi ni de typebox : JSON sérialisable.
 *
 * ⚠️ Ce store est DYNAMIQUE (des agents s'ajoutent/partent à chaud) : il vit
 * HORS de `CONFIG_SCHEMA` (comme le `JobStore`), persisté sur le volume `state`.
 * Les conventions de nommage suivent le projet (camelCase) ; la correspondance
 * avec les libellés de la spec est : `agentId` ↔ `agent_id`,
 * `lastSeen` ↔ `last_seen`.
 */

/** Niveaux de confirmation PAR AGENT (D118). */
export const AGENT_LEVELS = [
  "disabled",
  "always",
  "destructive",
  "never",
] as const;
export type AgentLevel = (typeof AGENT_LEVELS)[number];

/** Privilèges du processus de l'agent, PAR MACHINE (D120). */
export const AGENT_PRIVILEGES = ["root", "normal"] as const;
export type AgentPrivilege = (typeof AGENT_PRIVILEGES)[number];

/** Version de schéma des enregistrements d'agents. */
export const AGENT_SCHEMA_VERSION = 1 as const;

/**
 * Bots autorisés d'un agent CRÉÉ sans liste explicite (et d'un journal antérieur
 * au champ). ⚠️ C'est `yuki`, JAMAIS `[]` : une liste vide neutraliserait tous
 * les agents d'une installation existante du jour au lendemain.
 */
export const AGENT_BOT_PAR_DEFAUT = "yuki";

/**
 * Longueur maximale d'un nom personnalisé d'agent (alias lisible par l'humain).
 * Choisi volontairement court : un alias doit tenir sur une ligne d'interface.
 */
export const AGENT_NAME_MAX_LENGTH = 64;

/** Enregistrement d'un agent appairé. */
export interface AgentRecord {
  /** Identifiant stable (UUID fourni par Yuki au moment de l'appairage). */
  agentId: string;
  /**
   * Nom personnalisé (alias LISIBLE par l'humain), `""` si aucun. Ce n'est
   * JAMAIS la clé technique : `agentId` reste la référence de stockage.
   */
  name: string;
  /** Niveau de garde-fou (D118). */
  level: AgentLevel;
  /** Privilège du processus (D120). */
  privilege: AgentPrivilege;
  /** Dernière connexion (ISO 8601), `null` si jamais vue. */
  lastSeen: string | null;
  /** `true` si l'agent a été révoqué (dé-appairage). */
  revoked: boolean;
  /**
   * `true` si cette machine est déclarée « MATÉRIEL SENSIBLE ».
   *
   * ⚠️ C'est un RÉGLAGE (persisté, journal `agents.jsonl`), DISTINCT de l'état
   * « verrouillé/déverrouillé » qui vit EN MÉMOIRE (`src/agents/lock.ts`) : le
   * reverrouillage automatique n'écrit JAMAIS ici — il ne touche NI ce champ NI
   * `level`.
   *
   * Un agent sensible est VERROUILLÉ au démarrage et à chaque reconnexion :
   * aucune commande n'est transmise tant que l'utilisateur ne l'a pas
   * déverrouillée avec le mot de passe d'instance. Le niveau de garde-fou
   * (`level`) reste INCHANGÉ pendant tout ce cycle.
   */
  sensitive: boolean;
  /**
   * VISIBILITÉ (lot 35g) — liste des bots AUTORISÉS à utiliser cet agent.
   *
   * ⚠️ Les agents sont GLOBAUX (`agents.jsonl` commun à l'instance) : chaque
   * agent porte la LISTE des bots qui le voient, et non un bot unique. Un agent
   * ajouté est visible par les bots de sa liste ; un bot absent de la liste ne
   * le voit pas ET ne peut pas le joindre (`agent_not_allowed`).
   *
   * ⚠️ `[]` = agent NEUTRALISÉ : il reste LISTÉ (on ne perd pas la trace d'une
   * machine au rebut ou d'un agent compromis), mais plus aucun bot ne peut le
   * joindre. Ce n'est donc PAS un état muet : l'interface l'affiche comme tel.
   *
   * ⚠️ Un journal ANTÉRIEUR à ce champ rejoue à `["yuki"]` (jamais `[]`), sous
   * peine de couper l'installation existante (`src/agents/store.ts`).
   */
  bots: string[];
  /** Version de schéma (migration future). */
  schemaVersion: typeof AGENT_SCHEMA_VERSION;
}

/** Champs modifiables par un événement. */
export interface AgentPatch {
  /** Nouveau nom (déjà normalisé : espaces retirés, 1..64 caractères). */
  name?: string;
  level?: AgentLevel;
  privilege?: AgentPrivilege;
  lastSeen?: string;
  /** Déclaration « matériel sensible » (réglage persisté, pas l'état verrouillé). */
  sensitive?: boolean;
  /**
   * Liste des bots autorisés (visibilité, lot 35g). Même borne que la création
   * d'un bot (`MAX_BOTS`). `[]` NEUTRALISE l'agent (listé mais injoignable).
   */
  bots?: string[];
}

/** Nature d'un événement du journal d'agents. */
export type AgentEventKind = "upsert" | "revoked" | "restored" | "removed";

/** Événement append-only du journal d'agents. */
export interface AgentEvent {
  seq: number;
  ts: string;
  eventId: string;
  agentId: string;
  kind: AgentEventKind;
  patch?: AgentPatch;
}

/** Valeurs par défaut d'un agent découvert pour la première fois. */
export interface AgentDefaults {
  level: AgentLevel;
  privilege: AgentPrivilege;
}

export function isAgentLevel(value: unknown): value is AgentLevel {
  return typeof value === "string" && (AGENT_LEVELS as readonly string[]).includes(value);
}

export function isAgentPrivilege(value: unknown): value is AgentPrivilege {
  return (
    typeof value === "string" && (AGENT_PRIVILEGES as readonly string[]).includes(value)
  );
}

/**
 * L'agent est-il VISIBLE par ce bot (lot 35g) ?
 *
 * ⚠️ Fonction PURE, utilisée par les TROIS points de filtrage (`list`, `resolve`,
 * `authorize`) : une seule règle, donc aucune divergence possible. Un agent dont
 * la liste est `[]` n'est visible par AUCUN bot (état « neutralisé »).
 *
 * ⚠️ Un enregistrement SANS champ `bots` (journal antérieur, objet construit à
 * la main) est traité comme `["yuki"]` : le comportement historique (mono-bot)
 * reste identique, jamais une disparition silencieuse.
 */
export function agentAutorisePourBot(
  record: Pick<AgentRecord, "bots">,
  botId: string,
): boolean {
  const bots = Array.isArray(record.bots) ? record.bots : [AGENT_BOT_PAR_DEFAUT];
  return bots.includes(botId);
}

/**
 * `true` si `value` peut être stocké comme nom d'agent : chaîne, espaces de
 * bord retirés non vides, ≤ `AGENT_NAME_MAX_LENGTH`, sans caractère de
 * contrôle (nouveaux traits, etc.). La normalisation (trim) est faite par
 * `normalizeAgentName` (`store.ts`) ; ici on ne teste que la FORME.
 */
export function isValidAgentName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > AGENT_NAME_MAX_LENGTH) return false;
  // Caractères de contrôle interdits (C0 + DEL + C1).
  return !/[\u0000-\u001f\u007f-\u009f]/.test(trimmed);
}
