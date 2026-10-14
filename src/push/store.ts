/**
 * Store des ABONNEMENTS push (un enregistrement par APPAREIL).
 *
 * Fichier JSON unique sur le volume `state`, sparse, écrit de façon ATOMIQUE
 * (`tmp` + `rename`) en mode 0600. Aucun secret de connexion (le contenu est un
 * couple d'écoute : endpoint + clés du service de push), mais on le protège
 * quand même : ce sont des CAPACITÉS d'envoi vers un appareil.
 *
 * ⚠️ Ces données sont TECHNIQUES : elles ne doivent JAMAIS entrer dans le
 * transcript, la mémoire ou un rejeu — d'où un fichier séparé, jamais mêlé au
 * JSONL d'une session.
 */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import type { Logger } from "../observability/logger.js";
import type { PushSubscribeInput, PushSubscriptionRecord } from "./types.js";

export const PUSH_STORE_SCHEMA_VERSION = 1;

interface PushStoreFile {
  schemaVersion: number;
  subscriptions: PushSubscriptionRecord[];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Identifiant d'appareil acceptable : court, opaque, sans métacaractère. */
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{6,128}$/;

export function isValidDeviceId(value: unknown): value is string {
  return typeof value === "string" && DEVICE_ID_PATTERN.test(value);
}

export interface PushSubscriptionStoreOptions {
  path: string;
  logger?: Logger;
  now?: () => number;
}

/**
 * Registre des abonnements. Chargé une fois à la construction ; les mutations
 * réécrivent le fichier immédiatement (le volume est petit et les écritures
 * rares : abonnement/désabonnement/nettoyage d'un endpoint mort).
 */
export class PushSubscriptionStore {
  readonly path: string;
  private readonly logger?: Logger;
  private readonly now: () => number;
  private records: PushSubscriptionRecord[] = [];

  constructor(options: PushSubscriptionStoreOptions) {
    this.path = options.path;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.records = this.load();
  }

  /** Nombre d'appareils abonnés. */
  get size(): number {
    return this.records.length;
  }

  private load(): PushSubscriptionRecord[] {
    if (!existsSync(this.path)) return [];
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      this.logger?.warn("push.store.unreadable", { path: this.path, error: messageOf(error) });
      return [];
    }
    try {
      const parsed = JSON.parse(text) as Partial<PushStoreFile>;
      if (parsed.schemaVersion !== PUSH_STORE_SCHEMA_VERSION || !Array.isArray(parsed.subscriptions)) {
        this.logger?.warn("push.store.invalid", { path: this.path, reason: "schéma inattendu" });
        return [];
      }
      return parsed.subscriptions.filter(
        (entry): entry is PushSubscriptionRecord =>
          Boolean(
            entry &&
              typeof entry.deviceId === "string" &&
              typeof entry.endpoint === "string" &&
              typeof entry.p256dh === "string" &&
              typeof entry.auth === "string",
          ),
      );
    } catch (error) {
      this.logger?.warn("push.store.invalid", { path: this.path, error: messageOf(error) });
      return [];
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    const file: PushStoreFile = {
      schemaVersion: PUSH_STORE_SCHEMA_VERSION,
      subscriptions: this.records,
    };
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // Meilleur effort.
    }
    renameSync(tmp, this.path);
    try {
      chmodSync(this.path, 0o600);
    } catch {
      // Meilleur effort.
    }
  }

  /** Liste d'abonnements (copie défensive). */
  list(): PushSubscriptionRecord[] {
    return this.records.map((record) => ({ ...record }));
  }

  /** Abonnement d'un appareil, ou `undefined`. */
  get(deviceId: string): PushSubscriptionRecord | undefined {
    const found = this.records.find((record) => record.deviceId === deviceId);
    return found ? { ...found } : undefined;
  }

  /**
   * Enregistre (ou REMPLACE) l'abonnement d'un appareil. Un même endpoint
   * réutilisé par un autre `deviceId` est d'abord retiré : un endpoint ne doit
   * être enregistré qu'UNE fois (sinon double envoi).
   */
  upsert(input: PushSubscribeInput): PushSubscriptionRecord {
    const at = new Date(this.now()).toISOString();
    const existing = this.records.find((record) => record.deviceId === input.deviceId);
    this.records = this.records.filter(
      (record) => record.deviceId !== input.deviceId && record.endpoint !== input.endpoint,
    );
    const next: PushSubscriptionRecord = {
      deviceId: input.deviceId,
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
      ...(input.label ? { label: input.label } : {}),
    };
    this.records.push(next);
    this.persist();
    return { ...next };
  }

  /** Retire l'abonnement d'un appareil. Renvoie `true` s'il existait. */
  remove(deviceId: string): boolean {
    const before = this.records.length;
    this.records = this.records.filter((record) => record.deviceId !== deviceId);
    if (this.records.length === before) return false;
    this.persist();
    return true;
  }

  /**
   * Retire un abonnement MORT à partir de son endpoint (réponse 404/410 du
   * service de push). Renvoie le `deviceId` retiré, ou `undefined`.
   */
  removeByEndpoint(endpoint: string): string | undefined {
    const found = this.records.find((record) => record.endpoint === endpoint);
    if (!found) return undefined;
    this.records = this.records.filter((record) => record.endpoint !== endpoint);
    this.persist();
    return found.deviceId;
  }
}
