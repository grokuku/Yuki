/**
 * Appairage Yuki ↔ agent (Lot 4, B3) — sessions à usage unique, TTL,
 * rate-limit et anti-rejeu. Réplique la logique de `agent/internal/pair`
 * (`session.go`) côté serveur, en l'adaptant au fait qu'un agent peut frapper
 * AVANT que l'utilisateur n'ait saisi le code (mode « premier contact »).
 *
 * Cycle de vie d'un code (D119) :
 *
 *   1. l'agent AFFICHE le code et envoie `pair_begin` (premier contact) ;
 *   2. Yuki ne peut pas encore vérifier (elle n'a pas `C`) ⇒ la trame est
 *      **mise en attente**, bornée (nombre + TTL) ;
 *   3. l'utilisateur recopie le code dans Yuki ⇒ une **session** est créée ;
 *   4. la session est confrontée aux trames en attente (sonde **sans**
 *      comptabiliser d'échec), puis le `pair_ok` chiffré est produit et
 *      récupéré par l'agent (scrutation) : **code consommé**.
 *
 * ⚠️ Le code lui-même n'est **jamais** journalisé (c'est un secret).
 */

import { randomBytes, randomUUID } from "node:crypto";

import type { AuditLog } from "./audit.js";
import type { CertificateAuthority, ClientCertificate } from "./ca.js";
import { PairError } from "./errors.js";
import type { AgentStore } from "./store.js";
import {
  codeKey,
  deriveKey,
  generateCode,
  normalizeCode,
  PAIR_CODE_MAX_ATTEMPTS,
  PAIR_CODE_TTL_MS,
  PAIR_NONCE_SIZE,
  seal,
  sealAad,
  verifyProof,
} from "./pair-crypto.js";
import {
  encodePairOk,
  marshalPayload,
  pairOkToJson,
  type PairBeginFrame,
  type PairPayload,
} from "./pair-protocol.js";

export interface PairingLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** Résultat chiffré d'un appairage réussi. */
export interface PairingOutcome {
  yukiNonce: Buffer;
  blob: Buffer;
  agentId: string;
}

/** Session d'appairage : un code, une durée de vie, `maxAttempts` essais. */
export interface PairingSessionOptions {
  ttlMs?: number;
  maxAttempts?: number;
  now?: () => number;
  randomSource?: (size: number) => Buffer;
}

export class PairingSession {
  readonly display: string;
  private readonly key: Buffer;
  private readonly createdAt: number;
  private readonly expiresAt: number;
  private readonly maxAttempts: number;
  private readonly now: () => number;
  private readonly randomSource: (size: number) => Buffer;
  private attempts = 0;
  private consumed = false;
  private invalidated = false;
  private readonly seen = new Set<string>();

  constructor(code: string, options: PairingSessionOptions = {}) {
    this.display = normalizeCode(code);
    this.key = codeKey(this.display);
    this.now = options.now ?? Date.now;
    this.randomSource = options.randomSource ?? randomBytes;
    this.maxAttempts = options.maxAttempts ?? PAIR_CODE_MAX_ATTEMPTS;
    this.createdAt = this.now();
    this.expiresAt = this.createdAt + (options.ttlMs ?? PAIR_CODE_TTL_MS);
  }

  get expiresAtMs(): number {
    return this.expiresAt;
  }

  get expiresAtIso(): string {
    return new Date(this.expiresAt).toISOString();
  }

  get attemptsUsed(): number {
    return this.attempts;
  }

  get isUsed(): boolean {
    return this.consumed;
  }

  get isInvalidated(): boolean {
    return this.invalidated;
  }

  /** `true` si la session est terminale (consommée, invalidée ou périmée). */
  isTerminal(now = this.now()): boolean {
    return this.consumed || this.invalidated || now >= this.expiresAt;
  }

  isExpired(now = this.now()): boolean {
    return now >= this.expiresAt;
  }

  /** L'erreur correspondant à l'état terminal (ou `null`). */
  terminalError(now = this.now()): PairError | null {
    if (this.consumed) return new PairError("pair_code_used", "code déjà utilisé (usage unique)");
    if (this.invalidated) return new PairError("pair_rate_limited", "code invalidé (trop de tentatives)");
    if (now >= this.expiresAt) return new PairError("pair_code_expired", "code d'appairage périmé");
    return null;
  }

  /**
   * Sonde NON comptabilisante : la preuve correspond-elle à ce code ?
   * Utilisée pour retrouver la session visée par une trame en attente, sans
   * consommer d'essai (sinon un attaquant pourrait épuiser le code de
   * l'utilisateur en inondant de fausses trames).
   */
  probe(begin: PairBeginFrame): boolean {
    if (begin.agentNonce.length !== PAIR_NONCE_SIZE) return false;
    return verifyProof(
      this.key,
      Buffer.from(begin.yukiFpClaimed, "utf8"),
      begin.agentNonce,
      begin.proof,
    );
  }

  /**
   * Vérifie une `pair_begin` et produit, si elle est valide, le `pair_ok`
   * chiffré. Miroir de `Session.Authorize` (Go) : mêmes codes d'erreur.
   */
  authorize(begin: PairBeginFrame, material: PairMaterial): PairingOutcome {
    if (begin.agentNonce.length !== PAIR_NONCE_SIZE) {
      this.registerFailure();
      throw new PairError(
        "malformed_message",
        "agent_nonce de taille invalide (32 octets attendus)",
      );
    }
    const nonceHex = begin.agentNonce.toString("hex");
    if (this.seen.has(nonceHex)) {
      throw new PairError("pair_replay", "pair_begin déjà reçue (nonce agent rejoué)");
    }
    this.seen.add(nonceHex);

    const terminal = this.terminalError();
    if (terminal) throw terminal;
    if (this.attempts >= this.maxAttempts) {
      this.invalidated = true;
      throw new PairError("pair_rate_limited", "code invalidé (trop de tentatives)");
    }

    if (
      !verifyProof(
        this.key,
        Buffer.from(begin.yukiFpClaimed, "utf8"),
        begin.agentNonce,
        begin.proof,
      )
    ) {
      this.registerFailure();
      throw new PairError("proof_invalid", "preuve HMAC invalide");
    }

    const yukiNonce = this.randomSource(PAIR_NONCE_SIZE);
    const key = deriveKey(this.key, begin.agentNonce, yukiNonce);
    const plaintext = marshalPayload(material);
    const blob = seal(key, plaintext, sealAad(begin.agentNonce, yukiNonce));
    this.consumed = true;
    return { yukiNonce, blob, agentId: material.agentId };
  }

  /** Comptabilise un échec ; invalide au terme des tentatives autorisées. */
  private registerFailure(): void {
    this.attempts += 1;
    if (this.attempts >= this.maxAttempts) this.invalidated = true;
  }
}

/** Contenu transmis à l'agent dans le `pair_ok` (CA + cert client + identité). */
export type PairMaterial = PairPayload;

/** Trame en attente (arrivée avant la saisie du code). */
interface PendingBegin {
  pairId: string;
  begin: PairBeginFrame;
  ip: string;
  createdAt: number;
  outcome?: PairingOutcome;
}

export interface PairingManagerOptions {
  ca: CertificateAuthority;
  store?: AgentStore;
  audit?: AuditLog;
  logger?: PairingLogger;
  now?: () => number;
  randomSource?: (size: number) => Buffer;
  ttlMs?: number;
  maxAttempts?: number;
  /** Nombre maximal de trames en attente (borne anti-saturation). */
  maxPending?: number;
  /** Durée de vie d'une trame en attente. */
  pendingTtlMs?: number;
  /** Limite globale par IP (fenêtre glissante). */
  perIp?: { max: number; windowMs: number };
  idFactory?: () => string;
}

export interface SubmitCodeResult {
  code: string;
  expiresAt: string;
  /**
   * `true` si une trame d'agent EN ATTENTE a été appariée à ce code : son
   * `pair_ok` est prêt et l'agent le récupérera à sa prochaine scrutation.
   * `false` ⇒ aucun agent n'attendait avec ce code (l'interface le dit).
   */
  matched: boolean;
}

export type BeginPairingResult =
  | { status: "ok"; outcome: PairingOutcome }
  | { status: "pending"; pairId: string; retryAfterMs: number };

export type PollPairingResult =
  | { status: "ok"; outcome: PairingOutcome }
  | { status: "pending"; retryAfterMs: number };

/** Délai conseillé avant la prochaine scrutation. */
const POLL_RETRY_MS = 1_000;

/**
 * Matériel factice utilisé UNIQUEMENT pour obtenir le code d'erreur exact d'une
 * trame qui ne correspond à AUCUNE session active (le chemin d'échec s'arrête
 * avant d'utiliser le matériel : `authorize` lève sur la preuve avant de le
 * sérialiser). Évite de signer un certificat inutile à chaque tentative ratée.
 */
const FAILURE_MATERIAL: PairMaterial = {
  caCert: "",
  clientCert: "",
  clientKey: "",
  agentId: "",
  caFingerprint: "",
};

export class PairingManager {
  private readonly ca: CertificateAuthority;
  private readonly store?: AgentStore;
  private readonly audit?: AuditLog;
  private readonly logger?: PairingLogger;
  private readonly now: () => number;
  private readonly randomSource?: (size: number) => Buffer;
  private readonly options: PairingSessionOptions;
  private readonly maxPending: number;
  private readonly pendingTtlMs: number;
  private readonly perIp: { max: number; windowMs: number };
  private readonly idFactory: () => string;

  private readonly sessions = new Map<string, PairingSession>();
  private readonly pending = new Map<string, PendingBegin>();
  private readonly ipHits = new Map<string, number[]>();

  constructor(options: PairingManagerOptions) {
    this.ca = options.ca;
    this.store = options.store;
    this.audit = options.audit;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.randomSource = options.randomSource;
    this.options = {
      ttlMs: options.ttlMs,
      maxAttempts: options.maxAttempts,
      now: this.now,
      ...(options.randomSource ? { randomSource: options.randomSource } : {}),
    };
    this.maxPending = options.maxPending ?? 64;
    this.pendingTtlMs = options.pendingTtlMs ?? 10 * 60_000;
    this.perIp = options.perIp ?? { max: 60, windowMs: 60_000 };
    this.idFactory = options.idFactory ?? (() => randomUUID());
  }

  /** Fabrique un code d'appairage (délègue à `generateCode`, injectable). */
  generateCode(): string {
    return generateCode(this.randomSource ?? randomBytes);
  }

  /**
   * Saisie du code par l'utilisateur : crée (ou retrouve) la session, puis
   * tente de résoudre les trames en attente. Ne consomme pas le code.
   */
  submitCode(code: string, meta: { ip: string } = { ip: "unknown" }): SubmitCodeResult {
    let display: string;
    try {
      display = normalizeCode(code);
    } catch (error) {
      this.auditPairing("failed", meta.ip, "pair_code_invalid");
      throw error;
    }

    const existing = this.sessions.get(display);
    if (existing) {
      const terminal = existing.terminalError();
      if (terminal) {
        this.auditPairing("failed", meta.ip, terminal.code);
        throw terminal;
      }
    } else {
      const session = new PairingSession(display, this.options);
      this.sessions.set(display, session);
      this.auditPairing("code_submitted", meta.ip, null);
    }

    const session = this.sessions.get(display) as PairingSession;
    const matched = this.resolvePending(session);
    return { code: display, expiresAt: session.expiresAtIso, matched };
  }

  /**
   * `pair_begin` d'un agent. Si une session active correspond à la preuve,
   * l'appairage aboutit ; sinon la trame est mise en attente (le code n'a
   * peut-être pas encore été saisi).
   */
  beginPairing(begin: PairBeginFrame, meta: { ip: string } = { ip: "unknown" }): BeginPairingResult {
    this.checkRate(meta.ip);
    this.prune();

    const active = [...this.sessions.values()].filter((s) => !s.isTerminal());
    if (active.length > 0) {
      const match = active.find((s) => s.probe(begin));
      try {
        if (match) {
          const outcome = match.authorize(begin, this.signMaterial());
          this.recordSuccess(outcome.agentId, meta.ip);
          return { status: "ok", outcome };
        }
        // Aucune preuve ne correspond : on fait porter l'échec à la première
        // session active pour renvoyer le code d'erreur exact (et comptabiliser
        // l'essai), comme le ferait une `Authorize` unique. Le matériel factice
        // n'est jamais sérialisé : `authorize` lève avant, sur la preuve.
        const first = active[0] as PairingSession;
        first.authorize(begin, FAILURE_MATERIAL);
        throw new PairError("internal_error", "appairage : état incohérent");
      } catch (error) {
        const code = error instanceof PairError ? error.code : "internal_error";
        this.auditPairing("failed", meta.ip, code);
        throw error;
      }
    }

    if (this.pending.size >= this.maxPending) {
      this.auditPairing("failed", meta.ip, "pair_rate_limited");
      throw new PairError(
        "pair_rate_limited",
        "trop de demandes d'appairage en attente",
      );
    }
    const pairId = this.idFactory();
    this.pending.set(pairId, {
      pairId,
      begin,
      ip: meta.ip,
      createdAt: this.now(),
    });
    this.auditPairing("pending", meta.ip, null);
    return { status: "pending", pairId, retryAfterMs: POLL_RETRY_MS };
  }

  /** Scrutation : le `pair_ok` est-il prêt pour cette trame ? */
  pollPairing(pairId: string): PollPairingResult {
    this.prune();
    const entry = this.pending.get(pairId);
    if (!entry) {
      throw new PairError("pair_code_expired", "demande d'appairage inconnue ou expirée");
    }
    if (entry.outcome) return { status: "ok", outcome: entry.outcome };
    return { status: "pending", retryAfterMs: POLL_RETRY_MS };
  }

  /** Nombre de sessions actives (diagnostic/tests). */
  activeSessionCount(): number {
    return [...this.sessions.values()].filter((s) => !s.isTerminal()).length;
  }

  /** Nombre de trames en attente (diagnostic/tests). */
  pendingCount(): number {
    return this.pending.size;
  }

  /** Retire les sessions/trames périmées. */
  prune(): void {
    const now = this.now();
    for (const [code, session] of this.sessions) {
      if (session.isTerminal(now) && now - session.expiresAtMs > this.pendingTtlMs) {
        this.sessions.delete(code);
      }
    }
    for (const [id, entry] of this.pending) {
      if (now - entry.createdAt > this.pendingTtlMs) this.pending.delete(id);
    }
    for (const [ip, hits] of this.ipHits) {
      const kept = hits.filter((t) => now - t < this.perIp.windowMs);
      if (kept.length === 0) this.ipHits.delete(ip);
      else this.ipHits.set(ip, kept);
    }
  }

  /**
   * Résout, sans comptabiliser d'échec, les trames en attente compatibles.
   * Renvoie `true` si une trame a effectivement été appariée (sinon aucun agent
   * n'attendait avec ce code).
   */
  private resolvePending(session: PairingSession): boolean {
    for (const entry of this.pending.values()) {
      if (entry.outcome) continue;
      if (!session.probe(entry.begin)) continue;
      try {
        const outcome = session.authorize(entry.begin, this.signMaterial());
        entry.outcome = outcome;
        this.recordSuccess(outcome.agentId, entry.ip);
        this.logger?.info("agents.pair.pending_resolved", { pair_id: entry.pairId });
        // Le code est à usage unique : une seule trame peut être résolue.
        return true;
      } catch (error) {
        this.logger?.warn("agents.pair.pending_resolve_failed", {
          pair_id: entry.pairId,
          code: error instanceof PairError ? error.code : "internal_error",
        });
      }
    }
    return false;
  }

  /** Génère un certificat client neuf et son identité. */
  private signMaterial(): PairMaterial {
    const agentId = randomUUID();
    const cert: ClientCertificate = this.ca.signClientCertificate(agentId);
    return {
      caCert: this.ca.certificatePem,
      clientCert: cert.certPem,
      clientKey: cert.keyPem,
      agentId,
      caFingerprint: this.ca.fingerprint,
    };
  }

  private recordSuccess(agentId: string, ip: string): void {
    try {
      this.store?.markSeen(agentId);
    } catch (error) {
      this.logger?.warn("agents.pair.store_failed", {
        agent_id: agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.auditPairing("success", ip, null, agentId);
    this.logger?.info("agents.pair.success", { agent_id: agentId, ip });
  }

  /** Journalise un événement d'appairage (JAMAIS le code, jamais de secret). */
  private auditPairing(
    result: string,
    ip: string,
    errorCode: string | null,
    agentId?: string,
  ): void {
    if (!this.audit) return;
    try {
      this.audit.append({
        event: "pairing",
        agentId: agentId ?? "unpaired",
        meta: {
          result,
          ip,
          ...(errorCode ? { error_code: errorCode } : {}),
        },
      });
    } catch (error) {
      this.logger?.warn("agents.pair.audit_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Limite globale par IP (fenêtre glissante) sur les `pair_begin`. */
  private checkRate(ip: string): void {
    const now = this.now();
    const hits = (this.ipHits.get(ip) ?? []).filter((t) => now - t < this.perIp.windowMs);
    if (hits.length >= this.perIp.max) {
      this.ipHits.set(ip, hits);
      throw new PairError(
        "pair_rate_limited",
        `trop de demandes depuis ${ip} (limite ${this.perIp.max} par ${this.perIp.windowMs} ms)`,
      );
    }
    hits.push(now);
    this.ipHits.set(ip, hits);
  }
}

/** Sérialise une `pair_ok` pour la réponse (base64). */
export function pairOkJson(outcome: PairingOutcome): Record<string, unknown> {
  return pairOkToJson(encodePairOk({ yukiNonce: outcome.yukiNonce, blob: outcome.blob }));
}
