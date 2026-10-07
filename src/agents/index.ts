/**
 * Domaine `agents` — agents appairés, journal d'audit et appairage mTLS (Lot 4).
 *
 * AUCUN import du SDK Pi ni de typebox. Le store est DYNAMIQUE (hors
 * `CONFIG_SCHEMA`) et persiste sur le volume `state`.
 *
 * B1 : `store.ts` (agents), `audit.ts` (journal), `types.ts`, `errors.ts`.
 * B2 : `x509.ts` (générateur X.509 minimal), `ca.ts` (autorité interne),
 *      `pair-crypto.ts` (parité crypto avec l'agent Go), `server.ts` (port
 *      machines mTLS + WebSocket), `pair-protocol.ts` (trames filaires).
 * B3 : `pairing.ts` (sessions d'appairage : TTL, usage unique, rate-limit).
 * A5 : `destructive.ts` (classement des commandes destructrices, source unique
 *      partagée avec l'agent Go).
 */

export { AgentError, PairError, pairCodeOf } from "./errors.js";
export type { AgentErrorCode, PairErrorCode } from "./errors.js";

export {
  AGENT_LEVELS,
  AGENT_PRIVILEGES,
  AGENT_SCHEMA_VERSION,
  isAgentLevel,
  isAgentPrivilege,
} from "./types.js";
export type {
  AgentDefaults,
  AgentEvent,
  AgentEventKind,
  AgentLevel,
  AgentPatch,
  AgentPrivilege,
  AgentRecord,
} from "./types.js";

export { AgentStore, applyAgentEvent } from "./store.js";
export type { AgentLogger, AgentStoreOptions } from "./store.js";

export { AuditLog, maxSizeBytesFromMb } from "./audit.js";
export type { AuditEntry, AuditLogger, AuditLogOptions } from "./audit.js";

export {
  bitString,
  createSelfSignedCertificate,
  createSignedCertificate,
  derFromPem,
  dnsNamesOf,
  fingerprintHex,
  generateEcKeyPair,
  ipv4ToBytes,
  KEY_USAGE,
  EKU_OID,
  parseCertificate,
  pemFromDer,
  privateKeyPkcs8Pem,
  publicKeySpkiDer,
  randomSerial,
} from "./x509.js";
export type { CertificateSpec, EcKeyPair } from "./x509.js";

export { CA_COMMON_NAME, caDirectoryIn, CertificateAuthority, CLIENT_CERT_VALIDITY_DAYS } from "./ca.js";
export type {
  CaLogger,
  CertificateAuthorityOptions,
  ClientCertificate,
  ServerCertificate,
} from "./ca.js";

export {
  CodeKey,
  codeKey,
  computeProof,
  DeriveKey,
  deriveKey,
  domainConcat,
  encodeBase30,
  formatCode,
  GCM_NONCE_SIZE,
  GCM_TAG_SIZE,
  generateCode,
  normalizeCode,
  NormalizeCode,
  Open,
  open,
  PAIR_CODE_ALPHABET,
  PAIR_CODE_BYTES,
  PAIR_CODE_LENGTH,
  PAIR_CODE_MAX_ATTEMPTS,
  PAIR_CODE_TTL_MS,
  PAIR_DERIVATION_INFO,
  PAIR_KEY_SIZE,
  PAIR_NONCE_SIZE,
  probeProof,
  Proof,
  Seal,
  seal,
  sealAad,
  VerifyProof,
  verifyProof,
} from "./pair-crypto.js";

export {
  decodePairBegin,
  encodePairOk,
  marshalPayload,
  PAIR_PROTO_VERSION,
  pairOkToJson,
  parsePairBegin,
  parsePayload,
} from "./pair-protocol.js";
export type { PairBeginFrame, PairOkFrame, PairPayload } from "./pair-protocol.js";

export { pairOkJson, PairingManager, PairingSession } from "./pairing.js";
export type {
  BeginPairingResult,
  PairingLogger,
  PairingManagerOptions,
  PairingOutcome,
  PairingSessionOptions,
  PollPairingResult,
  PairMaterial,
  SubmitCodeResult,
} from "./pairing.js";

export {
  AGENTS_PAIR_PATH,
  AGENTS_PAIR_PREFIX,
  AGENTS_RENEW_PATH,
  AGENTS_WHOAMI_PATH,
  AGENTS_WS_PATH,
  closeAgentsServer,
  createAgentsServer,
  MAX_AGENTS_BODY_BYTES,
  startAgentsServer,
} from "./server.js";
export type { AgentsServerLogger, AgentsServerOptions } from "./server.js";

export {
  DESTRUCTIVE_PATTERNS_ENV,
  destructivePatternIds,
  destructivePatternsSha256,
  evaluateDestructive,
  isDestructive,
  loadDestructivePatterns,
  loadDestructivePatternsSource,
  loadDestructivePatternsSourceCached,
  resetDestructiveCaches,
  resolveDestructivePatternsPath,
} from "./destructive.js";
export type {
  DestructivePattern,
  DestructivePatternsDoc,
  DestructivePatternsSource,
  DestructiveVerdict,
} from "./destructive.js";
