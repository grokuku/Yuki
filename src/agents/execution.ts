/**
 * Service d'exécution côté Yuki (Lot 4, B6) — le cerveau du canal.
 *
 * Enchaîne : **garde-fou par agent (D118)** → **classement destructeur
 * (D126)** → **envoi de la commande (B6)** → **audit sans sortie (D127)** →
 * **balisage de la sortie (anti-injection)**.
 *
 * ⚠️ Ce module est **pur** (aucun import SDK/typebox) : c'est le port consommé
 * par l'outil `run_command` (`src/pi/sdk/execution-tools.ts`).
 *
 * ⚠️ **Hors ligne = rejet immédiat** (D124) : aucune mise en file.
 * ⚠️ **Déconnexion pendant une commande ⇒ `result_lost`** (D124) : la commande
 * va à son terme côté agent, mais son résultat est perdu.
 *
 * ⚠️ La demande de validation est RATTACHÉE à la conversation (`sessionId`) et
 * affichée dans la conversation ; `decideApproval` applique la décision et, en
 * cas d'approbation, **exécute la commande IMMÉDIATEMENT** (comportement isolé,
 * documenté dans `docs/lot4.md` §15).
 */

import type { ApprovalRegistry, PendingApproval } from "./approvals.js";
import type { AgentHub } from "./connection.js";
import { isChannelError } from "./errors.js";
import { destructiveLabels, evaluateDestructive } from "./destructive.js";
import { escapeOutputText, frameAgentDirectory, frameCommandOutput } from "./output.js";
import { buildApprovalResultPrompt, ORIGIN_APPROVAL_RESULT } from "./approval-report.js";
import { buildSecretStoredPrompt, ORIGIN_SECRET_STORED } from "./secret-report.js";
import type { AuditLog } from "./audit.js";
import type { AgentStore } from "./store.js";
import type { AgentRecord } from "./types.js";
import { redactText } from "../observability/logger.js";
import { resolveSecretReferences } from "../secrets/references.js";
import type {
  PendingSecretRequest,
  SecretRequestRegistry,
  SecretRequestEvent,
} from "../secrets/requests.js";
import { isReplayableSecretRequest } from "../secrets/requests.js";
import { VaultError } from "../secrets/vault.js";

export interface ExecutionLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** Statut terminal d'une demande d'exécution. */
export type ExecutionStatus =
  | "completed"
  | "failed"
  | "result_lost"
  | "timeout"
  | "refused"
  | "offline"
  | "awaiting_validation"
  | "awaiting_secret";

/** Demande d'exécution (portée par l'outil du modèle). */
export interface ExecutionRequest {
  agentId: string;
  command: string;
  shell?: string;
  cwd?: string;
  timeoutMs?: number;
  origin?: string;
  /**
   * Conversation d'où la demande est émise (session PiHost). Sert au ROUTAGE de
   * la demande de validation vers la bonne conversation. Optionnel : un appel
   * hors conversation (ex. test) reste accepté.
   */
  sessionId?: string;
}

/** Résultat d'exécution rendu à l'appelant (jamais la sortie brute non encadrée). */
export interface ExecutionOutcome {
  status: ExecutionStatus;
  /** Identifiant technique de l'agent (toujours renseigné si résolu). */
  agentId: string;
  /** Nom (alias) de l'agent résolu, `""` si aucun. */
  agentName?: string;
  command: string;
  destructive: boolean;
  destructiveIds: string[];
  exitCode: number | null;
  /**
   * Sortie ENCADRÉE (`<sortie …>`), présente UNIQUEMENT après exécution. C'est
   * la seule forme destinée au contexte du modèle.
   */
  framed?: string;
  /** Message court, lisible par le modèle. */
  message: string;
  /** Identifiant de la validation humaine (si `awaiting_validation`). */
  approvalId?: string;
  /**
   * Identifiant de la demande de SECRET (si `awaiting_secret`) : l'humain doit
   * fournir les NOMS listés dans `secretNames` (jamais la valeur ici).
   */
  secretRequestId?: string;
  /** Noms des secrets MANQUANTS à fournir (si `awaiting_secret`) — jamais une valeur. */
  secretNames?: string[];
  durationMs?: number;
  truncated?: boolean;
  timedOut?: boolean;
  /** Code applicatif de l'agent (si `failed`). */
  agentCode?: string;
}

/** Port consommé par l'outil `run_command`. */
export interface ExecutionServicePort {
  execute(request: ExecutionRequest): Promise<ExecutionOutcome>;
}

/**
 * Port de RÉVEIL du modèle : reçoit le prompt synthétique de résultat d'une
 * commande validée. Structurellement compatible avec `LightWaker`
 * (`src/delegation/ports.ts`) — le `PiHost` le satisfait tel quel.
 */
export interface ApprovalResultWaker {
  send(
    sessionId: string,
    text: string,
    opts?: { origin?: string; jobId?: string },
  ): unknown;
}

/** Port consommé par l'outil `capturer_ecran`. */
export interface ScreenshotServicePort {
  capture(request: ScreenshotRequest): Promise<ScreenshotOutcome>;
}

/**
 * Vue PUBLIQUE d'une demande de validation, destinée à l'interface (dans la
 * conversation). Jamais la sortie d'une commande ici : seulement de quoi
 * afficher la demande (machine, commande, motifs, échéance).
 */
export interface PendingApprovalView {
  id: string;
  sessionId?: string;
  agentId: string;
  agentName?: string;
  command: string;
  destructive: boolean;
  destructiveIds: string[];
  /** Libellés français des motifs destructeurs (explication à l'humain). */
  destructiveReasons: string[];
  createdAt: string;
  expiresAt: string;
  /**
   * DURÉE restante de validité (secondes entières, ≥ 0), calculée au moment de
   * l'ÉMISSION de la vue. C'est ce champ — et NON l'horodatage absolu
   * `expiresAt` — que l'interface utilise pour son compte à rebours : le client
   * compte à partir de la RÉCEPTION, sans jamais comparer une heure serveur à
   * l'horloge (potentiellement décalée) du navigateur. À la ré-affichage
   * (reconnexion/bascule), la durée est recalculée ⇒ toujours à jour.
   */
  ttlSeconds: number;
}

/** Issue d'une décision humaine. */
export type ApprovalDecisionOutcome =
  | {
      ok: true;
      decision: "approve";
      approval: PendingApprovalView;
      /** Résultat de l'exécution IMMÉDIATE déclenchée par l'approbation. */
      outcome: ExecutionOutcome;
    }
  | { ok: true; decision: "deny"; approval: PendingApprovalView }
  | { ok: false; code: string; message: string };

/**
 * Événement d'approbation VU par l'interface (l'agent a déjà été résolu en vue
 * PUBLIQUE : nom, motifs lisibles). Diffusé par le transport WebSocket.
 */
export type ApprovalViewEvent =
  | { kind: "requested"; approval: PendingApprovalView }
  | {
      kind: "decided";
      approval: PendingApprovalView;
      decision: "approve" | "deny";
    };

/**
 * Port consommé par le transport WebSocket pour afficher/traiter les demandes
 * de validation DANS la conversation. "AgentExecutionService" l'implémente ;
 * le transport n'en connaît que cette surface (aucun import de classe).
 */
export interface ApprovalGatewayPort {
  /** S'abonne aux changements (demande / décision) — renvoie le désabonnement. */
  subscribeApprovals(listener: (event: ApprovalViewEvent) => void): () => void;
  /** Demandes EN ATTENTE rattachées à une conversation (ré-affichage). */
  pendingApprovals(sessionId: string): PendingApprovalView[];
  /** Décide une demande ; une approbation exécute la commande IMMÉDIATEMENT. */
  decideApproval(
    id: string,
    decision: "approve" | "deny",
  ): Promise<ApprovalDecisionOutcome>;
}

// ── Secrets du coffre : résolution + flux `awaiting_secret` ──────────────

/**
 * Port de RÉSOLUTION des secrets, consommé par le service d'exécution.
 *
 * ⚠️ Structurellement satisfait par `SecretStore` (`src/secrets/store.ts`), sans
 * que ce module importe la classe : le service ne connaît que ce contrat.
 */
export interface SecretLookupPort {
  /** `true` si la clé maître est présente (coffre utilisable). */
  isConfigured(): boolean;
  /** Valeur d'un secret, ou `undefined` (verrouillé/absent). */
  lookup(name: string): string | undefined;
  /** Toutes les valeurs déchiffrées (redaction de sortie). Jamais levée. */
  values(): string[];
  /** Range un secret (chiffré). Lève si le coffre est verrouillé. */
  set(name: string, value: string, label?: string): unknown;
}

/**
 * Vue PUBLIQUE d'une demande de secret, destinée à l'interface (fenêtre
 * flottante). ⚠️ Ne porte JAMAIS une valeur : seulement les NOMS à fournir, la
 * machine (si connue) et la commande EXACTE (avec ses références) pour une
 * demande sur RÉFÉRENCE MANQUANTE, ou la RAISON pour une demande DIRECTE.
 */
export interface PendingSecretView {
  id: string;
  sessionId?: string;
  /** Machine cible — absente pour une demande DIRECTE sans machine. */
  agentId?: string;
  agentName?: string;
  /** Commande EXACTE (références `${YUKI_SECRET_…}` incluses, jamais la valeur).
   * Absente pour une demande DIRECTE (rien à rejouer). */
  command?: string;
  /** « À quoi ça sert », en clair pour l'humain. Optionnel. */
  purpose?: string;
  /** Noms de secrets à fournir (ordre de première apparition). */
  names: string[];
  createdAt: string;
  expiresAt: string;
  /** Durée restante (secondes), calculée à l'ÉMISSION (comme les validations). */
  ttlSeconds: number;
}

/** Événement de demande de secret vu par l'interface. */
export type SecretRequestViewEvent =
  | { kind: "requested"; request: PendingSecretView }
  | {
      kind: "cleared";
      request: PendingSecretView;
      reason: "fulfilled" | "cancelled";
    };

/** Issue de la fourniture d'un secret par l'humain. */
export type SecretSubmitOutcome =
  | {
      ok: true;
      request: PendingSecretView;
      /**
       * Résultat de la commande REJOUÉE — présent UNIQUEMENT pour le flux sur
       * RÉFÉRENCE MANQUANTE. Absent pour une demande DIRECTE (rien à rejouer :
       * le secret est simplement enregistré).
       */
      outcome?: ExecutionOutcome;
    }
  | { ok: false; code: string; message: string };

/**
 * Entrée d'une demande DIRECTE de secret (outil `demander_secret`). Aucune
 * commande : on demande une valeur à l'humain pour l'ENREGISTRER au coffre.
 */
export interface DirectSecretRequestInput {
  /** Noms à demander (format `YUKI_SECRET_…`). */
  names: string[];
  /** « À quoi ça sert », montré à l'humain. */
  purpose: string;
  /** Machine concernée (libellé humain facultatif). */
  agentName?: string;
  /** Conversation où afficher la fenêtre (routage). */
  sessionId?: string;
  origin?: string;
}

/** Issue d'une demande DIRECTE de secret. */
export type SecretRequestToolOutcome =
  | { ok: true; request: PendingSecretView }
  | { ok: false; code: string; message: string };

/**
 * Port consommé par l'outil `demander_secret` (session LÉGÈRE qui CONVERSE).
 * « AgentExecutionService » l'implémente ; l'outil n'en connaît que cette
 * surface (aucun import de classe).
 */
export interface SecretRequestToolPort {
  /** Émet une demande DIRECTE de secret (aucune commande) et route la fenêtre. */
  requestSecret(input: DirectSecretRequestInput): SecretRequestToolOutcome;
}

/**
 * Port consommé par le transport WebSocket pour la fenêtre de SECRET.
 * « AgentExecutionService » l'implémente ; le transport n'en connaît que cette
 * surface (aucun import de classe).
 */
export interface SecretRequestGatewayPort {
  subscribeSecrets(listener: (event: SecretRequestViewEvent) => void): () => void;
  /** Demandes EN ATTENTE rattachées à une conversation (ré-affichage). */
  pendingSecrets(sessionId: string): PendingSecretView[];
  /** Fournit les valeurs ; les range au coffre puis REJOUE la commande. */
  submitSecret(id: string, values: Record<string, string>): Promise<SecretSubmitOutcome>;
}

// ── Capture d'écran par l'agent (image ÉPHÉMÈRE) ──────────────────────────

/**
 * Commande SYNTHÉTIQUE sous laquelle une capture d'écran est enregistrée dans
 * le registre de validation. Ce n'est PAS une commande shell : c'est\u2011elle qui
 * permet de réutiliser le MÊME mécanisme de validation (aucun second système).
 */
export const SCREENSHOT_COMMAND = "capture d'écran";

/**
 * Origine marquant une validation de capture d'écran (au lieu d'une commande).
 * Stockée dans `PendingApproval.origin` : c'est ce qui permet à
 * `decideApproval` de déclencher une CAPTURE (et non une commande shell).
 */
export const SCREENSHOT_ORIGIN = "capturer_ecran";

/** Capacité que l'agent doit avoir déclarée pour qu'une capture soit possible. */
export const SCREENSHOT_CAPABILITY = "screenshot";

/**
 * Capacité que l'agent doit avoir déclarée pour RECEVOIR des SECRETS par
 * variable d'environnement (champ `env` de la trame `cmd`, côté Go).
 *
 * ⚠️ Un agent ANTÉRIEUR à cette capacité IGNORE le champ `env` en silence : le
 * shell de l'enfant développerait alors `$YUKI_SECRET_…` en CHAÎNE VIDE, ce qui
 * peut rendre DESTRUCTRICE une commande anodine (`rm -rf /$YUKI_SECRET_DIR`
 * devient `rm -rf /`). Yuki REFUSE donc l'envoi au lieu d'exécuter à vide.
 *
 * ⚠️ Valeur ALIGNÉE sur la liste `capabilities` de l'agent Go
 * (`agent/internal/agent/hello.go`).
 */
export const ENV_CAPABILITY = "env";

/** Demande de capture d'écran (portée par l'outil du modèle). */
export interface ScreenshotRequest {
  agentId: string;
  sessionId?: string;
  origin?: string;
  timeoutMs?: number;
  maxEdge?: number;
  quality?: number;
}

/** Statut terminal d'une demande de capture. */
export type ScreenshotStatus =
  | "captured"
  | "refused"
  | "offline"
  | "unsupported"
  | "too_large"
  | "timeout"
  | "result_lost"
  | "failed"
  | "awaiting_validation";

/**
 * Résultat d'une capture rendu à l'appelant.
 *
 * ⚠️ ANTI-EXFILTRATION : ce résultat ne porte QUE des MÉTADONNÉES (dimensions,
 * taille, format). L'image elle-même voyage EXCLUSIVEMENT par la trame de
 * contrôle `screenshot` vers l'humain ; elle n'est JAMAIS renvoyée ici, donc
 * jamais au modèle.
 */
export interface ScreenshotOutcome {
  status: ScreenshotStatus;
  agentId: string;
  agentName?: string;
  format?: string;
  width?: number;
  height?: number;
  bytes?: number;
  message: string;
  approvalId?: string;
  durationMs?: number;
}

/**
 * Capture affichable par l'humain : porte le `data:` URL de l'image. ÉPHÉMÈRE —
 * jamais dans le transcript, le snapshot, la mémoire ou sur disque.
 */
export interface CapturedScreenshotView {
  agentId: string;
  agentName?: string;
  sessionId?: string;
  /** `data:image/jpeg;base64,…` — destiné à l'interface, jamais au modèle. */
  dataUrl: string;
  format: string;
  width: number;
  height: number;
  bytes: number;
  capturedAt: string;
  /**
   * Origine de la capture. Absent/`agent` = capture d'une MACHINE appairée
   * (image réservée à l'humain). `web` = capture d'une page web via Libry
   * (image transmise AUSSI au modèle, cf. `capture_libraire`).
   */
  source?: "agent" | "web";
  /** URL de la page capturée (`source: "web"` uniquement). */
  url?: string;
}

/** Événement de capture (diffusion temps réel vers les clients WS). */
export type ScreenshotViewEvent = { kind: "captured"; screenshot: CapturedScreenshotView };

/**
 * Port consommé par le transport WebSocket pour AFFICHER une capture DANS la
 * conversation (trame de contrôle, jamais bufferisée).
 */
export interface ScreenshotGatewayPort {
  subscribeScreenshots(listener: (event: ScreenshotViewEvent) => void): () => void;
}

export interface ExecutionServiceOptions {
  store: AgentStore;
  hub: AgentHub;
  audit: AuditLog;
  approvals: ApprovalRegistry;
  logger: ExecutionLogger;
  idFactory?: () => string;
  /**
   * Horloge (injectable pour les tests) servant à calculer la durée restante
   * (`ttlSeconds`) exposée dans les vues. Défaut : `Date.now`.
   */
  now?: () => number;
  /**
   * Réveil du modèle en fin de commande VALIDÉE (rapport `approval_id` +
   * stdout/stderr/code de sortie, éphémère). Optionnel : sans lui, aucun
   * rapport n'est envoyé (comportement inchangé).
   */
  waker?: ApprovalResultWaker;
  /**
   * Résolution des RÉFÉRENCES de secrets. Absent ⇒ les références `${YUKI_SECRET_…}`
   * ne sont PAS reconnues comme telles (comportement historique : la commande
   * part inchangée).
   */
  secrets?: SecretLookupPort;
  /**
   * Registre des demandes de secret (`awaiting_secret`). Absent ⇒ une référence
   * vers un secret ABSENT du coffre est REFUSÉE (jamais exécutée avec une valeur
   * vide implicite).
   */
  secretRequests?: SecretRequestRegistry;
}

/** Timeout par défaut d'une commande (ms). */
export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

/** Timeout par défaut d'une capture d'écran (ms). */
export const DEFAULT_SCREENSHOT_TIMEOUT_MS = 30_000;

/**
 * Décision du garde-fou PAR AGENT (D118), partagée par l'exécution de commande
 * et la capture d'écran : un SEUL chemin de validation, jamais deux.
 */
type GuardDecision =
  | { kind: "proceed" }
  | { kind: "refuse"; message: string }
  | { kind: "awaiting"; approval: PendingApproval };

let commandSeq = 0;

function defaultCommandId(): string {
  commandSeq += 1;
  return `cmd-${Date.now().toString(36)}-${commandSeq.toString(36)}`;
}

export class AgentExecutionService implements ExecutionServicePort {
  private readonly store: AgentStore;
  private readonly hub: AgentHub;
  private readonly audit: AuditLog;
  private readonly approvals: ApprovalRegistry;
  private readonly logger: ExecutionLogger;
  private readonly idFactory: () => string;
  private readonly now: () => number;
  private waker?: ApprovalResultWaker;
  private readonly secrets?: SecretLookupPort;
  private readonly secretRequests?: SecretRequestRegistry;

  constructor(options: ExecutionServiceOptions) {
    this.store = options.store;
    this.hub = options.hub;
    this.audit = options.audit;
    this.approvals = options.approvals;
    this.logger = options.logger;
    this.idFactory = options.idFactory ?? defaultCommandId;
    this.now = options.now ?? Date.now;
    this.waker = options.waker;
    this.secrets = options.secrets;
    this.secretRequests = options.secretRequests;
  }

  /**
   * Branche le réveil du modèle (renseigné après création du `PiHost`, comme
   * `DelegationService.setWaker`). Sans lui, aucune notification n'est émise.
   */
  setWaker(waker: ApprovalResultWaker): void {
    this.waker = waker;
  }

  async execute(request: ExecutionRequest): Promise<ExecutionOutcome> {
    return this.run(request, false);
  }

  /**
   * Corps réel de l'exécution. `guardAlreadySatisfied` = `true` quand la commande
   * a DÉJÀ franchi le garde-fou D118 au moment où la demande de secret a été
   * créée : le rejeu `awaiting_secret` ne revalide donc PAS (sinon une commande
   * déjà approuvée exigerait une SECONDE validation).
   */
  private async run(
    request: ExecutionRequest,
    guardAlreadySatisfied: boolean,
  ): Promise<ExecutionOutcome> {
    const requested = request.agentId;
    const command = request.command;
    const verdict = evaluateDestructive(command);

    // 0. Résolution : le modèle peut désigner l'agent par son ID OU par son NOM
    // (alias lisible). ⚠️ L'ID reste PRIORITAIRE et toujours accepté.
    const record = this.store.resolve(requested);
    if (!record) {
      return this.refuse(
        requested,
        undefined,
        command,
        verdict,
        this.unknownAgentMessage(requested),
      );
    }
    const agentId = record.agentId;
    const agentName = record.name;

    // 1. Garde-fous de configuration + validation humaine (D118), via le MÊME
    //    chemin que toute exécution (aucun second mécanisme). ⚠️ SAUF lors du
    //    rejeu post-secret : la validation a déjà été franchie.
    if (!guardAlreadySatisfied) {
      const decision = this.authorize(record, command, verdict, request);
      if (decision.kind === "refuse") {
        return this.refuse(agentId, agentName, command, verdict, decision.message);
      }
      if (decision.kind === "awaiting") {
        return {
          status: "awaiting_validation",
          agentId,
          agentName,
          command,
          destructive: verdict.destructive,
          destructiveIds: verdict.ids,
          exitCode: null,
          approvalId: decision.approval.id,
          message:
            "Validation humaine requise : la commande n'a PAS été exécutée. " +
            "Une demande d'approbation s'affiche dans la conversation : un humain doit " +
            "valider ou refuser. Une fois validée, la commande s'exécute automatiquement.",
        };
      }
    }

    // 3. Hors ligne = rejet immédiat (D124) : pas de file d'attente.
    if (!this.hub.isOnline(agentId)) {
      return {
        status: "offline",
        agentId,
        agentName,
        command,
        destructive: verdict.destructive,
        destructiveIds: verdict.ids,
        exitCode: null,
        message: "Agent hors ligne : exécution refusée (aucune mise en file, D124).",
      };
    }

    // 3bis. RÉSOLUTION des références de secrets (décision utilisateur :
    // INJECTION PAR VARIABLE D'ENVIRONNEMENT, jamais de substitution textuelle).
    // La commande n'est JAMAIS réécrite : le shell développe `$NOM` depuis l'env.
    let env: Record<string, string> | undefined;
    if (this.secrets) {
      const resolution = resolveSecretReferences(command, (name) =>
        this.secrets?.lookup(name),
      );
      if (resolution.found.length > 0 || resolution.missing.length > 0) {
        // ⚠️ AGRÉGAT NÉGOCIÉ : un agent qui n'a pas déclaré la capacité « env »
        // ignore le champ `env` de la trame `cmd`. Le shell développerait alors
        // la variable en CHAÎNE VIDE — potentiellement destructeur. On REFUSE
        // AVANT toute demande de secret (inutile de réclamer une valeur à
        // l'humain si elle ne peut pas être transmise).
        if (!this.hub.hasCapability(agentId, ENV_CAPABILITY)) {
          this.logger.warn("agents.exec.env_non_supporte", {
            agent_id: agentId,
            agent_name: agentName || null,
            agent_version: this.hub.get(agentId)?.helloInfo?.agentVersion ?? null,
            names: resolution.found.concat(resolution.missing).join(","),
          });
          this.audit.append({
            event: "command",
            agentId,
            command,
            exitCode: null,
            meta: {
              status: "refused",
              agent_name: agentName || null,
              destructive: verdict.destructive,
              destructive_ids: verdict.ids,
              reason: "env_unsupported",
            },
          });
          return this.refuse(
            agentId,
            agentName,
            command,
            verdict,
            "Commande refusée : elle référence un secret (${YUKI_SECRET_…}) mais cet " +
              "agent n'a pas déclaré la capacité « env » (celle qui lui permet de recevoir " +
              "la valeur par variable d'environnement). " +
              "Ton agent est TROP ANCIEN : mets-le à jour sur la machine " +
              "(`yuki-agent version` puis mise à jour du binaire, cf. docs/runbook.md §12.4), " +
              "puis réessaie. ⚠️ La commande n'a PAS été exécutée : sans la valeur, " +
              "le shell l'aurait développée en chaîne vide (comportement " +
              "potentiellement destructeur).",
          );
        }
        if (!this.secrets.isConfigured()) {
          // ⚠️ REFUS : jamais de repli en clair, jamais d'exécution avec une
          // variable d'environnement vide implicite.
          return this.refuse(
            agentId,
            agentName,
            command,
            verdict,
            "Commande refusée : elle référence un secret (${YUKI_SECRET_…}) mais le " +
              "coffre est VERROUILLÉ (variable d'environnement YUKI_VAULT_KEY absente). " +
              "Aucun repli en clair : fournissez la clé maître hors bande.",
          );
        }
        if (resolution.missing.length > 0) {
          return this.awaitSecret(record, verdict, request, resolution.missing);
        }
        env = resolution.env;
      }
    }

    // 4. Envoi (au plus une fois) et attente du résultat.
    const cmdId = this.idFactory();
    const timeoutMs = request.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.logger.info("agents.exec.sent", {
      agent_id: agentId,
      agent_name: agentName || null,
      cmd_id: cmdId,
      destructive: verdict.destructive,
      origin: request.origin ?? null,
    });

    try {
      const result = await this.hub.sendCommand(agentId, {
        cmdId,
        command,
        ...(request.shell ? { shell: request.shell } : {}),
        ...(request.cwd ? { cwd: request.cwd } : {}),
        timeoutMs,
        ...(request.origin ? { origin: request.origin } : {}),
        destructive: verdict.destructive,
        // ⚠️ Les valeurs passent EN ENVIRONNEMENT, jamais dans `command`.
        ...(env ? { env } : {}),
      });

      this.audit.append({
        event: "command",
        agentId,
        command,
        exitCode: result.exitCode,
        meta: {
          status: "completed",
          // Le NOM pour l'humain, l'ID (champ `agent_id`) pour la traçabilité.
          agent_name: agentName || null,
          destructive: verdict.destructive,
          destructive_ids: verdict.ids,
          duration_ms: result.durationMs,
          truncated: result.truncated,
          timed_out: result.timedOut,
          ...(request.origin ? { origin: request.origin } : {}),
        },
      });

      // ⚠️ MASQUAGE À LA SOURCE : on redige stdout/stderr AVANT l'encadrement ET
      // AVANT l'échappement. C'est le seul point sûr : `outcome.framed` alimente
      // AUSSI BIEN le résultat d'outil que le rapport post-validation — masquer
      // ici les couvre tous les deux (sinon le secret fuit par DEUX chemins).
      const secretValues = this.redactionValues(env);
      const framed = frameCommandOutput({
        machine: agentId,
        command,
        exitCode: result.exitCode,
        stdout: redactText(result.stdout, secretValues),
        stderr: redactText(result.stderr, secretValues),
        truncatedStdout: result.stdoutTrunc,
        truncatedStderr: result.stderrTrunc,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
      });

      return {
        status: "completed",
        agentId,
        agentName,
        command,
        destructive: verdict.destructive,
        destructiveIds: verdict.ids,
        exitCode: result.exitCode,
        framed,
        message: `Commande exécutée (code de sortie ${result.exitCode}).`,
        durationMs: result.durationMs,
        truncated: result.truncated,
        timedOut: result.timedOut,
      };
    } catch (error) {
      return this.onChannelFailure(agentId, agentName, command, verdict, error);
    }
  }

  // ── Secrets : demande `awaiting_secret` + fourniture ─────────────────────

  /**
   * Valeurs à masquer dans une sortie : TOUS les secrets du coffre + celles
   * réellement injectées. Union par prudence (un secret lu depuis le disque par
   * la commande, non référencé, doit être masqué lui aussi).
   */
  private redactionValues(env?: Record<string, string>): string[] {
    const values = new Set<string>();
    if (this.secrets) for (const value of this.secrets.values()) values.add(value);
    if (env) for (const value of Object.values(env)) values.add(value);
    return [...values];
  }

  /**
   * Secret(s) manquant(s) : émet une demande de FOURNITURE (flux DÉDIÉ, qui
   * couvre donc les agents SANS validation) et rend la main au modèle avec le
   * statut `awaiting_secret`. ⚠️ La commande (avec ses références) et les NOMS
   * partent ; JAMAIS une valeur (elle n'existe pas encore).
   */
  private awaitSecret(
    record: AgentRecord,
    verdict: { destructive: boolean; ids: string[] },
    request: ExecutionRequest,
    missing: string[],
  ): ExecutionOutcome {
    if (!this.secretRequests) {
      return this.refuse(
        record.agentId,
        record.name || undefined,
        request.command,
        verdict,
        `Secret manquant (${missing.join(", ")}) et flux de fourniture indisponible : ` +
          "commande refusée.",
      );
    }
    const pending = this.secretRequests.request({
      agentId: record.agentId,
      ...(record.name ? { agentName: record.name } : {}),
      command: request.command,
      names: missing,
      ...(request.shell !== undefined ? { shell: request.shell } : {}),
      ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
      ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
      ...(request.origin !== undefined ? { origin: request.origin } : {}),
      ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
    });
    this.logger.info("agents.exec.awaiting_secret", {
      agent_id: record.agentId,
      request_id: pending.id,
      session_id: pending.sessionId ?? null,
      // ⚠️ NOMS seulement : jamais la valeur (qui n'existe pas encore).
      names: missing.join(","),
    });
    return {
      status: "awaiting_secret",
      agentId: record.agentId,
      ...(record.name ? { agentName: record.name } : {}),
      command: request.command,
      destructive: verdict.destructive,
      destructiveIds: verdict.ids,
      exitCode: null,
      secretRequestId: pending.id,
      secretNames: [...missing],
      message:
        "Secret manquant : la commande référence des secrets absents du coffre. " +
        "Elle n'a PAS été exécutée. Une fenêtre s'affiche dans la conversation pour " +
        "fournir la valeur ; la commande s'exécutera alors automatiquement.",
    };
  }

  /** S'abonne aux demandes de secret (délègue au registre). */
  subscribeSecrets(listener: (event: SecretRequestViewEvent) => void): () => void {
    if (!this.secretRequests) return () => undefined;
    return this.secretRequests.subscribe((event: SecretRequestEvent) => {
      if (event.kind === "requested") {
        listener({ kind: "requested", request: this.viewSecret(event.request) });
      } else {
        listener({
          kind: "cleared",
          request: this.viewSecret(event.request),
          reason: event.reason,
        });
      }
    });
  }

  /** Demandes de secret EN ATTENTE d'une conversation (ré-affichage). */
  pendingSecrets(sessionId: string): PendingSecretView[] {
    if (!this.secretRequests) return [];
    return this.secretRequests.listFor(sessionId).map((entry) => this.viewSecret(entry));
  }

  /**
   * Fournit les valeurs d'une demande de secret : les range au coffre (chiffrées),
   * puis REJOUE la commande — SANS repasser le garde-fou D118 (il a déjà été
   * franchi quand la demande a été créée). Réveille le modèle avec le résultat.
   *
   * ⚠️ Ne lève jamais : renvoie `{ ok: false }` avec un message honnête (demande
   * inconnue/expirée, valeur manquante, coffre verrouillé…).
   */
  async submitSecret(
    id: string,
    values: Record<string, string>,
  ): Promise<SecretSubmitOutcome> {
    const registry = this.secretRequests;
    if (!registry) {
      return {
        ok: false,
        code: "secret_unavailable",
        message: "Flux de fourniture de secret indisponible.",
      };
    }
    const entry = registry.get(id);
    if (!entry || entry.status !== "pending") {
      return {
        ok: false,
        code: "secret_request_not_found",
        message: "Cette demande de secret n'existe plus (déjà fournie ou expirée).",
      };
    }
    if (!this.secrets) {
      return {
        ok: false,
        code: "secret_unavailable",
        message: "Coffre de secrets indisponible.",
      };
    }
    const required = entry.names;
    const provided = new Map<string, string>();
    for (const name of required) {
      const value = values[name];
      if (typeof value !== "string" || value.length === 0) {
        return {
          ok: false,
          code: "secret_missing_value",
          message: `Valeur manquante pour « ${name} ».`,
        };
      }
      provided.set(name, value);
    }
    try {
      for (const name of required) this.secrets.set(name, provided.get(name) as string);
    } catch (error) {
      const code = error instanceof VaultError ? error.name : "secret_store_failed";
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn("agents.secrets.store_failed", { request_id: id, code });
      return { ok: false, code, message };
    }
    const fulfilled = registry.fulfill(id);
    // Flux sur RÉFÉRENCE MANQUANTE (commande + machine) : on REJOUE la commande
    // SANS repasser le garde-fou D118 (déjà franchi à la création) et on réveille
    // le modèle avec le résultat. Demande DIRECTE : rien à rejouer, on confirme
    // seulement l'enregistrement.
    if (isReplayableSecretRequest(fulfilled)) {
      const outcome = await this.run(
        {
          agentId: fulfilled.agentId as string,
          command: fulfilled.command as string,
          ...(fulfilled.shell !== undefined ? { shell: fulfilled.shell } : {}),
          ...(fulfilled.cwd !== undefined ? { cwd: fulfilled.cwd } : {}),
          ...(fulfilled.timeoutMs !== undefined ? { timeoutMs: fulfilled.timeoutMs } : {}),
          ...(fulfilled.origin !== undefined ? { origin: fulfilled.origin } : {}),
          ...(fulfilled.sessionId !== undefined ? { sessionId: fulfilled.sessionId } : {}),
        },
        true,
      );
      this.notifySecretResult(fulfilled, outcome);
      return { ok: true, request: this.viewSecret(fulfilled), outcome };
    }
    this.notifySecretStored(fulfilled);
    return { ok: true, request: this.viewSecret(fulfilled) };
  }

  /**
   * Émet une demande DIRECTE de secret (outil `demander_secret`) : aucune
   * commande, juste une valeur à demander à l'humain et à RANGER au coffre. La
   * fenêtre est routée vers la conversation (`sessionId`).
   *
   * ⚠️ Ne lève jamais : renvoie `{ ok: false }` avec un message honnête (flux
   * indisponible, coffre verrouillé…). Ne porte JAMAIS une valeur.
   */
  requestSecret(input: DirectSecretRequestInput): SecretRequestToolOutcome {
    const registry = this.secretRequests;
    if (!registry) {
      return {
        ok: false,
        code: "secret_unavailable",
        message: "Flux de fourniture de secret indisponible.",
      };
    }
    if (!this.secrets) {
      return { ok: false, code: "secret_unavailable", message: "Coffre de secrets indisponible." };
    }
    if (!this.secrets.isConfigured()) {
      // ⚠️ REFUS : jamais de repli en clair. On ne demande pas une valeur qu'on ne
      // pourrait pas ranger.
      return {
        ok: false,
        code: "vault_locked",
        message:
          "Coffre de secrets VERROUILLÉ (variable d'environnement YUKI_VAULT_KEY " +
          "absente) : impossible d'enregistrer un secret. Fournissez la clé maître hors bande.",
      };
    }
    const pending = registry.request({
      names: input.names,
      purpose: input.purpose,
      ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      ...(input.origin !== undefined ? { origin: input.origin } : {}),
    });
    // ⚠️ NOMS + RAISON seulement : jamais une valeur (elle n'existe pas encore).
    this.logger.info("agents.secrets.direct_requested", {
      request_id: pending.id,
      session_id: pending.sessionId ?? null,
      names: pending.names.join(","),
    });
    return { ok: true, request: this.viewSecret(pending) };
  }

  /**
   * Réveille le modèle avec le résultat de la commande rejouée après fourniture
   * du secret. Réutilise le canal synthétique existant (`ORIGIN_APPROVAL_RESULT`) :
   * le résultat reste ÉPHÉMÈRE (jamais dans le transcript, le snapshot, le rejeu
   * ni la mémoire). Jamais bloquant pour l'humain.
   */
  private notifySecretResult(entry: PendingSecretRequest, outcome: ExecutionOutcome): void {
    const sessionId = entry.sessionId;
    if (!sessionId || !this.waker) return;
    const prompt = buildApprovalResultPrompt({
      approvalId: entry.id,
      agentId: entry.agentId as string,
      ...(outcome.agentName ? { agentName: outcome.agentName } : {}),
      command: entry.command as string,
      outcome,
    });
    try {
      this.waker.send(sessionId, prompt, { origin: ORIGIN_APPROVAL_RESULT });
      this.logger.info("agents.secret.result_reported", {
        request_id: entry.id,
        agent_id: entry.agentId ?? null,
        session_id: sessionId,
        status: outcome.status,
      });
    } catch (error) {
      this.logger.warn("agents.secret.result_report_failed", {
        request_id: entry.id,
        session_id: sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Réveille le modèle après l'ENREGISTREMENT d'un secret (demande DIRECTE).
   * Prompt SYNTHÉTIQUE (`ORIGIN_SECRET_STORED`) : jamais dans le transcript, le
   * snapshot, le rejeu ni la mémoire. ⚠️ Ne porte que des NOMS, jamais la valeur.
   */
  private notifySecretStored(entry: PendingSecretRequest): void {
    const sessionId = entry.sessionId;
    if (!sessionId || !this.waker) return;
    const prompt = buildSecretStoredPrompt({
      requestId: entry.id,
      names: entry.names,
      ...(entry.purpose !== undefined ? { purpose: entry.purpose } : {}),
      ...(entry.agentName !== undefined ? { agentName: entry.agentName } : {}),
    });
    try {
      this.waker.send(sessionId, prompt, { origin: ORIGIN_SECRET_STORED });
      this.logger.info("agents.secret.stored_reported", {
        request_id: entry.id,
        session_id: sessionId,
      });
    } catch (error) {
      this.logger.warn("agents.secret.stored_report_failed", {
        request_id: entry.id,
        session_id: sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Convertit une demande de secret mémorisée en vue publique (pour l'interface). */
  private viewSecret(entry: PendingSecretRequest): PendingSecretView {
    const record = entry.agentId !== undefined ? this.store.get(entry.agentId) : undefined;
    const name = entry.agentName ?? record?.name;
    return {
      id: entry.id,
      ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
      ...(entry.agentId !== undefined ? { agentId: entry.agentId } : {}),
      ...(name ? { agentName: name } : {}),
      ...(entry.command !== undefined ? { command: entry.command } : {}),
      ...(entry.purpose !== undefined ? { purpose: entry.purpose } : {}),
      names: [...entry.names],
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
      ttlSeconds: Math.max(0, Math.round((Date.parse(entry.expiresAt) - this.now()) / 1000)),
    };
  }

  // ── Garde-fou partagé (commandes ET captures) ────────────────────────────

  /**
   * Applique le garde-fou PAR AGENT (D118) — le MÊME que pour toute commande :
   * agent révoqué refusé, agent `disabled` refusé, niveau 2 (`always`) ⇒
   * validation humaine, niveau 3 (`destructive`) ⇒ validation seulement si
   * l'action est classée destructrice. La capture d'écran, NON destructrice,
   * passe donc SANS validation au niveau 3.
   */
  private authorize(
    record: AgentRecord,
    command: string,
    verdict: { destructive: boolean; ids: string[] },
    request: {
      sessionId?: string;
      shell?: string;
      cwd?: string;
      timeoutMs?: number;
      origin?: string;
    },
  ): GuardDecision {
    if (record.revoked) {
      return { kind: "refuse", message: "Agent révoqué : exécution refusée." };
    }
    if (record.level === "disabled") {
      return { kind: "refuse", message: "Agent désactivé (niveau 1) : exécution refusée." };
    }
    const needsApproval =
      record.level === "always" || (record.level === "destructive" && verdict.destructive);
    if (needsApproval && !this.approvals.consume(record.agentId, command)) {
      const pending = this.approvals.request({
        agentId: record.agentId,
        command,
        destructive: verdict.destructive,
        destructiveIds: verdict.ids,
        ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
        ...(request.shell !== undefined ? { shell: request.shell } : {}),
        ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
        ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
        ...(request.origin !== undefined ? { origin: request.origin } : {}),
      });
      this.logger.info("agents.exec.awaiting_validation", {
        agent_id: record.agentId,
        agent_name: record.name || null,
        approval_id: pending.id,
        session_id: pending.sessionId ?? null,
        destructive: verdict.destructive,
        level: record.level,
      });
      return { kind: "awaiting", approval: pending };
    }
    return { kind: "proceed" };
  }

  // ── Capture d'écran (image ÉPHÉMÈRE, jamais dans l'historique) ──────────

  private readonly screenshotListeners = new Set<(event: ScreenshotViewEvent) => void>();

  /** S'abonne aux captures affichables (transport WS). Renvoie le désabonnement. */
  subscribeScreenshots(listener: (event: ScreenshotViewEvent) => void): () => void {
    this.screenshotListeners.add(listener);
    return () => {
      this.screenshotListeners.delete(listener);
    };
  }

  private emitScreenshot(event: ScreenshotViewEvent): void {
    for (const listener of this.screenshotListeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger.warn("agents.screenshot.listener_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Demande une capture d'écran à un agent.
   *
   * ⚠️ Le résultat rendu à l'appelant (donc au MODÈLE) ne contient QUE des
   * métadonnées : l'image part exclusivement vers l'interface humaine via
   * l'événement `captured` (trame de contrôle).
   */
  async capture(request: ScreenshotRequest): Promise<ScreenshotOutcome> {
    const requested = request.agentId;
    const record = this.store.resolve(requested);
    if (!record) {
      return this.screenshotRefused(requested, undefined, this.unknownAgentMessage(requested));
    }
    const agentId = record.agentId;
    const agentName = record.name;

    if (record.revoked) {
      return this.screenshotRefused(agentId, agentName, "Agent révoqué : capture refusée.");
    }
    if (record.level === "disabled") {
      return this.screenshotRefused(
        agentId,
        agentName,
        "Agent désactivé (niveau 1) : capture refusée.",
      );
    }
    // ⚠️ Hors ligne = rejet immédiat (D124).
    if (!this.hub.isOnline(agentId)) {
      this.audit.append({
        event: "screenshot",
        agentId,
        command: SCREENSHOT_COMMAND,
        exitCode: null,
        meta: { status: "offline", agent_name: agentName || null, origin: request.origin ?? null },
      });
      return {
        status: "offline",
        agentId,
        agentName,
        message: "Agent hors ligne : capture refusée (aucune mise en file, D124).",
      };
    }
    // ⚠️ Capacité RÉELLE exigée : une machine sans écran/outil refuse honnêtement.
    if (!this.hub.hasCapability(agentId, SCREENSHOT_CAPABILITY)) {
      this.logger.info("agents.screenshot.unsupported", {
        agent_id: agentId,
        agent_name: agentName || null,
      });
      this.audit.append({
        event: "screenshot",
        agentId,
        command: SCREENSHOT_COMMAND,
        exitCode: null,
        meta: {
          status: "unsupported",
          agent_name: agentName || null,
          origin: request.origin ?? null,
        },
      });
      return {
        status: "unsupported",
        agentId,
        agentName,
        message:
          "Capture d'écran impossible : cette machine n'a pas d'affichage ou " +
          "d'outil de capture (l'agent n'a pas déclaré la capacité « screenshot »).",
      };
    }

    // Garde-fou de niveau : MÊME contrôle que les commandes. La capture n'est
    // PAS destructrice ⇒ au niveau 3 elle passe sans validation.
    const verdict = { destructive: false, ids: [] as string[] };
    const decision = this.authorize(record, SCREENSHOT_COMMAND, verdict, {
      ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
      ...(request.origin !== undefined ? { origin: request.origin } : {}),
      ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
    });
    if (decision.kind === "refuse") {
      return this.screenshotRefused(agentId, agentName, decision.message);
    }
    if (decision.kind === "awaiting") {
      return {
        status: "awaiting_validation",
        agentId,
        agentName,
        approvalId: decision.approval.id,
        message:
          "Validation humaine requise : la capture n'a PAS été effectuée. Une " +
          "demande d'approbation s'affiche dans la conversation.",
      };
    }

    const cmdId = this.idFactory();
    const timeoutMs = request.timeoutMs ?? DEFAULT_SCREENSHOT_TIMEOUT_MS;
    this.logger.info("agents.screenshot.sent", {
      agent_id: agentId,
      agent_name: agentName || null,
      cmd_id: cmdId,
      origin: request.origin ?? null,
    });

    try {
      const frame = await this.hub.sendScreenshot(agentId, {
        cmdId,
        timeoutMs,
        ...(request.maxEdge !== undefined ? { maxEdge: request.maxEdge } : {}),
        ...(request.quality !== undefined ? { quality: request.quality } : {}),
      });
      const format = frame.format.length > 0 ? frame.format : "jpeg";
      const dataUrl = `data:image/${format};base64,${frame.data}`;
      // ⚠️ Audit SANS contenu d'image : uniquement des métadonnées.
      this.audit.append({
        event: "screenshot",
        agentId,
        command: SCREENSHOT_COMMAND,
        exitCode: null,
        meta: {
          status: "captured",
          agent_name: agentName || null,
          width: frame.width,
          height: frame.height,
          bytes: frame.bytes,
          format,
          duration_ms: frame.durationMs ?? null,
          origin: request.origin ?? null,
        },
      });
      // ⚠️ L'image part par l'interface (humain) — jamais dans le résultat.
      this.emitScreenshot({
        kind: "captured",
        screenshot: {
          agentId,
          ...(agentName ? { agentName } : {}),
          ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
          dataUrl,
          format,
          width: frame.width,
          height: frame.height,
          bytes: frame.bytes,
          capturedAt: new Date().toISOString(),
        },
      });
      this.logger.info("agents.screenshot.captured", {
        agent_id: agentId,
        width: frame.width,
        height: frame.height,
        bytes: frame.bytes,
        format,
      });
      const ko = Math.max(1, Math.round(frame.bytes / 1024));
      return {
        status: "captured",
        agentId,
        agentName,
        format,
        width: frame.width,
        height: frame.height,
        bytes: frame.bytes,
        ...(frame.durationMs !== undefined ? { durationMs: frame.durationMs } : {}),
        message:
          `Capture d'écran affichée dans la conversation (${frame.width}×${frame.height}, ` +
          `~${ko} Ko). L'image n'est pas conservée : elle n'entre ni dans ` +
          "l'historique ni dans la mémoire.",
      };
    } catch (error) {
      return this.onScreenshotFailure(agentId, agentName, request, error);
    }
  }

  /** Traduit un échec de canal en résultat terminal audité (jamais l'image). */
  private onScreenshotFailure(
    agentId: string,
    agentName: string,
    request: ScreenshotRequest,
    error: unknown,
  ): ScreenshotOutcome {
    const code = isChannelError(error) ? error.code : "send_failed";
    const agentCode = isChannelError(error) ? error.agentCode : undefined;
    const status: ScreenshotStatus =
      agentCode === "too_large"
        ? "too_large"
        : agentCode === "unsupported"
          ? "unsupported"
          : code === "result_lost"
            ? "result_lost"
            : code === "command_timeout"
              ? "timeout"
              : code === "agent_offline"
                ? "offline"
                : "failed";
    const message =
      status === "too_large"
        ? "Capture refusée : l'image reste trop lourde même après compression " +
          "(plafond dur 256 Kio)."
        : status === "unsupported"
          ? "Capture d'écran impossible : cette machine n'a pas d'affichage ou " +
            "d'outil de capture."
          : error instanceof Error
            ? error.message
            : String(error);

    this.audit.append({
      event: "screenshot",
      agentId,
      command: SCREENSHOT_COMMAND,
      exitCode: null,
      meta: {
        status,
        agent_name: agentName || null,
        code,
        agent_code: agentCode ?? null,
        origin: request.origin ?? null,
      },
    });
    this.logger.warn("agents.screenshot.failed", {
      agent_id: agentId,
      agent_name: agentName || null,
      status,
      code,
    });
    return { status, agentId, agentName, message };
  }

  /** Refus (garde-fou ou agent inconnu) : jamais d'image, jamais un mensonge. */
  private screenshotRefused(
    agentId: string,
    agentName: string | undefined,
    message: string,
  ): ScreenshotOutcome {
    this.logger.info("agents.screenshot.refused", {
      agent_id: agentId,
      ...(agentName ? { agent_name: agentName } : {}),
      reason: message,
    });
    // Audit de la DEMANDE et de l'ISSUE (jamais de contenu d'image).
    this.audit.append({
      event: "screenshot",
      agentId,
      command: SCREENSHOT_COMMAND,
      exitCode: null,
      meta: { status: "refused", agent_name: agentName || null, reason: message },
    });
    return {
      status: "refused",
      agentId,
      ...(agentName ? { agentName } : {}),
      message,
    };
  }

  // ── Demandes de validation (affichage/traitement dans la conversation) ──

  /** S'abonne aux événements d'approbation (délègue au registre). */
  subscribeApprovals(listener: (event: ApprovalViewEvent) => void): () => void {
    return this.approvals.subscribe((event) => {
      if (event.kind === "requested") {
        listener({ kind: "requested", approval: this.viewApproval(event.approval) });
      } else {
        listener({
          kind: "decided",
          approval: this.viewApproval(event.approval),
          decision: event.decision,
        });
      }
    });
  }

  /** Demandes EN ATTENTE rattachées à une conversation (ré-affichage). */
  pendingApprovals(sessionId: string): PendingApprovalView[] {
    return this.approvals
      .list()
      .filter((entry) => entry.sessionId === sessionId)
      .map((entry) => this.viewApproval(entry));
  }

  /**
   * Décide une demande de validation. **Approuver exécute la commande
   * IMMÉDIATEMENT** (au lieu d'attendre que le modèle la redemande) : le
   * résultat est renvoyé à l'appelant pour affichage dans la conversation.
   * Refuser ne déclenche AUCUNE exécution.
   *
   * ⚠️ Ne lève jamais : une demande inconnue/expirée/déjà décidée renvoie
   * `{ ok: false }` avec un message honnête (clic tardif).
   */
  async decideApproval(
    id: string,
    decision: "approve" | "deny",
  ): Promise<ApprovalDecisionOutcome> {
    const entry = this.approvals.get(id);
    if (!entry || entry.status !== "pending") {
      return {
        ok: false,
        code: "approval_not_found",
        message:
          "Cette demande de validation n'existe plus (déjà décidée ou expirée).",
      };
    }
    if (decision === "deny") {
      const denied = this.approvals.deny(id);
      return { ok: true, decision: "deny", approval: this.viewApproval(denied) };
    }
    // Approbation : la validation devient consommable UNE fois ; l'action la
    // consomme aussitôt (même agent, même commande synthétique).
    const approved = this.approvals.approve(id);
    // ⚠️ Une validation de CAPTURE (`origin` marqué) ne doit PAS exécuter la
    // commande synthétique dans un shell : elle déclenche la capture.
    if (approved.origin === SCREENSHOT_ORIGIN) {
      const shot = await this.capture({
        agentId: approved.agentId,
        origin: SCREENSHOT_ORIGIN,
        ...(approved.timeoutMs !== undefined ? { timeoutMs: approved.timeoutMs } : {}),
        ...(approved.sessionId !== undefined ? { sessionId: approved.sessionId } : {}),
      });
      return {
        ok: true,
        decision: "approve",
        approval: this.viewApproval(approved),
        outcome: {
          status: shot.status === "captured" ? "completed" : "refused",
          agentId: shot.agentId,
          ...(shot.agentName ? { agentName: shot.agentName } : {}),
          command: SCREENSHOT_COMMAND,
          // La capture n'est JAMAIS destructrice.
          destructive: false,
          destructiveIds: [],
          exitCode: null,
          message: shot.message,
        },
      };
    }
    const outcome = await this.execute({
      agentId: approved.agentId,
      command: approved.command,
      ...(approved.shell !== undefined ? { shell: approved.shell } : {}),
      ...(approved.cwd !== undefined ? { cwd: approved.cwd } : {}),
      ...(approved.timeoutMs !== undefined ? { timeoutMs: approved.timeoutMs } : {}),
      ...(approved.origin !== undefined ? { origin: approved.origin } : {}),
      ...(approved.sessionId !== undefined ? { sessionId: approved.sessionId } : {}),
    });
    // ⚠️ Le modèle n'avait aucun retour après validation : on le réveille avec
    // le résultat COMPLET (stdout/stderr/code de sortie), corrélé par
    // `approval_id`. Le prompt est SYNTHÉTIQUE : jamais dans le transcript, le
    // snapshot, le rejeu ni la mémoire (résultat toujours ÉPHÉMÈRE côté humain).
    this.notifyApprovalResult(approved, outcome);
    return {
      ok: true,
      decision: "approve",
      approval: this.viewApproval(approved),
      outcome,
    };
  }

  /**
   * Réveille le modèle avec le résultat d'une commande validée. Jamais bloquant
   * pour la décision humaine : toute erreur est journalisée, jamais propagée.
   * Sans `sessionId` (demande hors conversation) ou sans waker, rien n'est émis.
   */
  private notifyApprovalResult(approved: PendingApproval, outcome: ExecutionOutcome): void {
    const sessionId = approved.sessionId;
    if (!sessionId || !this.waker) return;
    const prompt = buildApprovalResultPrompt({
      approvalId: approved.id,
      agentId: approved.agentId,
      ...(outcome.agentName ? { agentName: outcome.agentName } : {}),
      command: approved.command,
      outcome,
    });
    try {
      this.waker.send(sessionId, prompt, { origin: ORIGIN_APPROVAL_RESULT });
      this.logger.info("agents.approval.result_reported", {
        approval_id: approved.id,
        agent_id: approved.agentId,
        session_id: sessionId,
        status: outcome.status,
      });
    } catch (error) {
      this.logger.warn("agents.approval.result_report_failed", {
        approval_id: approved.id,
        session_id: sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Convertit une demande mémorisée en vue publique (pour l'interface). */
  private viewApproval(entry: PendingApproval): PendingApprovalView {
    const record = this.store.get(entry.agentId);
    const name = record?.name;
    return {
      id: entry.id,
      ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
      agentId: entry.agentId,
      ...(name ? { agentName: name } : {}),
      command: entry.command,
      destructive: entry.destructive,
      destructiveIds: [...entry.destructiveIds],
      destructiveReasons: destructiveLabels(entry.destructiveIds),
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
      ttlSeconds: Math.max(0, Math.round((Date.parse(entry.expiresAt) - this.now()) / 1000)),
    };
  }

  /**
   * Message rendu au modèle quand NI l'ID ni le nom ne correspondent : liste
   * les agents disponibles dans un bloc DONNÉE (balisage anti-injection).
   */
  private unknownAgentMessage(requested: string): string {
    const entries = this.store
      .list()
      .filter((record) => !record.revoked)
      .map((record) => ({ name: record.name, agentId: record.agentId }));
    return (
      `Agent inconnu : « ${escapeOutputText(requested)} ». ` +
      "Désignez l'agent par son identifiant technique ou par son nom.\n" +
      frameAgentDirectory(entries)
    );
  }

  /** Traduit un échec de canal en résultat terminal audité (jamais la sortie). */
  private onChannelFailure(
    agentId: string,
    agentName: string,
    command: string,
    verdict: { destructive: boolean; ids: string[] },
    error: unknown,
  ): ExecutionOutcome {
    const code = isChannelError(error) ? error.code : "send_failed";
    const status: ExecutionStatus =
      code === "result_lost"
        ? "result_lost"
        : code === "command_timeout"
          ? "timeout"
          : code === "agent_offline"
            ? "offline"
            : "failed";
    const message = error instanceof Error ? error.message : String(error);

    this.audit.append({
      event: "command",
      agentId,
      command,
      exitCode: null,
      meta: {
        status,
        agent_name: agentName || null,
        destructive: verdict.destructive,
        destructive_ids: verdict.ids,
      },
    });
    this.logger.warn("agents.exec.failed", {
      agent_id: agentId,
      agent_name: agentName || null,
      status,
      code,
      error: message,
    });

    return {
      status,
      agentId,
      agentName,
      command,
      destructive: verdict.destructive,
      destructiveIds: verdict.ids,
      exitCode: null,
      message,
      ...(isChannelError(error) && error.agentCode ? { agentCode: error.agentCode } : {}),
    };
  }

  private refuse(
    agentId: string,
    agentName: string | undefined,
    command: string,
    verdict: { destructive: boolean; ids: string[] },
    message: string,
  ): ExecutionOutcome {
    this.logger.info("agents.exec.refused", {
      agent_id: agentId,
      ...(agentName ? { agent_name: agentName } : {}),
      reason: message,
    });
    return {
      status: "refused",
      agentId,
      ...(agentName ? { agentName } : {}),
      command,
      destructive: verdict.destructive,
      destructiveIds: verdict.ids,
      exitCode: null,
      message,
    };
  }
}
