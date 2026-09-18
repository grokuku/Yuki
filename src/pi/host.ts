/**
 * Façade `PiHost` : contrat public du domaine Pi embarqué.
 *
 * L'interface est volontairement agnostique du SDK : types JSON, méthodes
 * asynchrones, événements sérialisables. Elle reste compatible avec une
 * bascule ultérieure vers `pi --mode rpc` sans toucher au reste du projet.
 *
 * L'implémentation v1 in-process vit dans `./sdk-host.ts`, seul module autorisé
 * à importer le SDK. `createPiHost` s'y délègue.
 */

import { createSdkPiHost } from "./sdk-host.js";
import type {
  EnsureSessionOptions,
  PiEventListener,
  PiHostOptions,
  RunHandle,
  SendOptions,
  SessionInfo,
  SessionState,
} from "./types.js";

export interface PiHost {
  /** Construit le loader/runtime, ouvre la session initiale et pose l'abonnement. */
  start(): Promise<void>;
  /** `true` une fois l'abonnement posé (autorise `send`). */
  isReady(): boolean;
  /** Identifiant de la session courante (celle du client). */
  currentSessionId(): string | undefined;

  /** Ouvre ou crée une session (reprend la plus récente par défaut). */
  ensureSession(target?: EnsureSessionOptions): Promise<SessionState>;
  /** Remplace la session courante par une nouvelle session. */
  newSession(): Promise<SessionState>;
  /** Reprend la session la plus récente (ou en crée une si aucune). */
  continueRecent(): Promise<SessionState>;
  /** Reprend un fichier de session précis. */
  resume(sessionFile: string): Promise<SessionState>;

  /** Accepte un message et renvoie une poignée immédiate. */
  send(sessionId: string, text: string, opts?: SendOptions): RunHandle;
  /** Interrompt le run en vol (ou un run précis) et vide la file. Idempotent. */
  abort(sessionId: string, runId?: string): Promise<void>;

  /** S'abonne aux événements d'une session. Renvoie la fonction de désabonnement. */
  subscribe(sessionId: string, listener: PiEventListener): () => void;
  /** S'abonne à tous les événements, toutes sessions confondues (transport). */
  subscribeAll(listener: PiEventListener): () => void;

  /** État sérialisable d'une session (courante si omise). */
  getState(sessionId?: string): SessionState | undefined;
  /** Liste les sessions persistées. */
  listSessions(): Promise<SessionInfo[]>;

  /** Libère le runtime et les abonnements. */
  stop(): Promise<void>;
}

/** Construit le host embarqué v1 (in-process, SDK Pi). */
export function createPiHost(options: PiHostOptions): PiHost {
  return createSdkPiHost(options);
}

export type {
  EnsureSessionOptions,
  PiEventListener,
  PiHostOptions,
  RunHandle,
  SendOptions,
  SessionInfo,
  SessionState,
} from "./types.js";
