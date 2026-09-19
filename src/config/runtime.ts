/**
 * Runtime de configuration (Lot 11).
 *
 * Combine **store** + **environnement** + **défauts du code** selon la
 * précédence `défauts < store < env`. L'environnement ne participe que s'il est
 * explicitement défini ET non vide ; dans ce cas le champ est **verrouillé**
 * (`origin: "env"`) et un `PUT` le visant est refusé (`locked_by_env`).
 *
 * Expose `get()` / `update(patch)` / `subscribe()`, le **pont des clés** vers
 * `process.env` (pour que le SDK résolve `$YUKI_LLM_*_API_KEY`) et les valeurs à
 * masquer pour le logger.
 *
 * Aucun import SDK/typebox.
 */

import { readFileSync } from "node:fs";

import { EnvError, type Env, readConfigEnvOverrides } from "./env.js";
import {
  CONFIG_PATHS,
  CONFIG_SCHEMA,
  descriptorOf,
  envNameOf,
  isSecretPath,
  validateField,
  type ApplyKind,
  type FieldDescriptor,
  type Origin,
} from "./schema.js";
import { ConfigStore } from "./store.js";

export type { ApplyKind, Origin } from "./schema.js";

/** Erreur d'un champ (message exploitable par l'UI, en français). */
export interface FieldError {
  path: string;
  code: string;
  message: string;
}

export class ConfigValidationError extends Error {
  override readonly name = "ConfigValidationError";
  constructor(readonly fields: FieldError[]) {
    super("Configuration invalide");
  }
}

export class LockedByEnvError extends Error {
  override readonly name = "LockedByEnvError";
  constructor(readonly locked: Array<{ path: string; variable: string }>) {
    super("Champ verrouillé par l'environnement");
  }
}

/** Feuille « valeur » (non secrète). */
export interface ValueFieldSnapshot {
  value: string | number;
  origin: Origin;
  apply: ApplyKind;
  lockedByEnv?: string;
}

/** Feuille « secret » : JAMAIS de valeur complète (uniquement un masque). */
export interface SecretFieldSnapshot {
  configured: boolean;
  source: Origin;
  masked: string | null;
  lockedByEnv?: string;
}

export type ConfigFieldSnapshot = ValueFieldSnapshot | SecretFieldSnapshot;

export interface ConfigSnapshot {
  fields: Record<string, ConfigFieldSnapshot>;
  status: { lightKey: boolean; heavyKey: boolean; ready: boolean };
}

export interface ConfigChange {
  path: string;
  secret: boolean;
  /** Ancienne valeur (masquée si secrète), ou `null` si absente. */
  from: string | null;
  /** Nouvelle valeur (masquée si secrète), ou `null` si effacée. */
  to: string | null;
}

export interface ConfigUpdateResult {
  fields: Record<string, ConfigFieldSnapshot>;
  status: { lightKey: boolean; heavyKey: boolean; ready: boolean };
  applied: { hot: string[]; restart: string[] };
  /** Détail pour le journal d'audit (jamais la valeur brute d'un secret). */
  changes: ConfigChange[];
}

export interface ConfigRuntimeOptions {
  env: Env;
  /** Store injectable (tests). Défaut : chemin résolu depuis `env`. */
  store?: ConfigStore;
  /** Environnement source (tests). Défaut : `process.env`. */
  processEnv?: NodeJS.ProcessEnv;
  /** Défauts des prompts (contenu des fichiers livrés). */
  promptDefaults?: { light: string; heavy: string };
}

/** Masque une valeur secrète : 4 derniers caractères précédés de `••••`. */
export function maskSecret(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 4) return "••••";
  return `••••${trimmed.slice(-4)}`;
}

function readTextFile(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

/** Runtime de configuration : point d'accès unique aux valeurs effectives. */
export class ConfigRuntime {
  private readonly store: ConfigStore;
  private readonly processEnv: NodeJS.ProcessEnv;
  private readonly defaults: Record<string, string | number> = {};
  /** Surccharges d'environnement validées (chemin → valeur). */
  private readonly envValues: Record<string, string | number> = {};
  /** Valeurs stockées validées (sparse). */
  private values: Record<string, string | number> = {};
  private readonly listeners = new Set<() => void>();

  /** Replis rencontrés au chargement (journalisés après création du logger). */
  readonly warnings: string[] = [];

  constructor(options: ConfigRuntimeOptions) {
    this.store = options.store ?? new ConfigStore(options.env.configStorePath);
    this.processEnv = options.processEnv ?? process.env;

    // Défauts du code + affinage des prompts depuis les fichiers livrés.
    for (const [path, descriptor] of Object.entries(CONFIG_SCHEMA)) {
      this.defaults[path] = descriptor.default;
    }
    const light = options.promptDefaults?.light ?? readTextFile(options.env.piSystemPromptPath);
    const heavy = options.promptDefaults?.heavy ?? readTextFile(options.env.piHeavySystemPromptPath);
    if (light.length > 0) this.defaults["prompts.light"] = light;
    if (heavy.length > 0) this.defaults["prompts.heavy"] = heavy;

    // Surcharges d'environnement (validées strictement : erreur explicite).
    const rawEnv = readConfigEnvOverrides(this.processEnv);
    for (const [path, raw] of Object.entries(rawEnv)) {
      const result = validateField(path, raw);
      if (!result.ok) {
        const variable = envNameOf(path) ?? path;
        throw new EnvError(`Variable ${variable} invalide : ${result.message}`);
      }
      this.envValues[path] = result.value;
    }

    // Valeurs stockées (validées ; les valeurs invalides sont ignorées).
    const loaded = this.store.load();
    if (loaded.source === "invalid") {
      this.warnings.push(
        `store de configuration illisible (${loaded.error ?? "inconnu"}) — défauts utilisés, fichier conservé`,
      );
    }
    for (const [path, raw] of Object.entries(loaded.values)) {
      const descriptor = descriptorOf(path);
      if (!descriptor) {
        this.warnings.push(`champ de configuration inconnu ignoré : ${path}`);
        continue;
      }
      const result = validateField(path, raw);
      if (!result.ok) {
        this.warnings.push(`valeur stockée invalide pour ${path} (${result.message})`);
        continue;
      }
      this.values[path] = result.value;
    }
  }

  /** Valeur effective d'un champ. */
  get(path: string): string | number {
    if (path in this.envValues) return this.envValues[path] as string | number;
    if (path in this.values) return this.values[path] as string | number;
    return this.defaults[path] ?? "";
  }

  getString(path: string): string {
    return String(this.get(path));
  }

  getNumber(path: string): number {
    const value = this.get(path);
    return typeof value === "number" ? value : Number.parseInt(String(value), 10);
  }

  /** Origine effective d'un champ. */
  originOf(path: string): Origin {
    if (path in this.envValues) return "env";
    if (path in this.values) return "store";
    return "default";
  }

  isLockedByEnv(path: string): boolean {
    return path in this.envValues;
  }

  /** Valeurs secrètes effectives (pour la redaction du logger). */
  secretValues(): string[] {
    const out: string[] = [];
    for (const path of CONFIG_PATHS) {
      if (!isSecretPath(path)) continue;
      const value = this.get(path);
      if (typeof value === "string" && value.trim().length >= 6) out.push(value.trim());
    }
    return out;
  }

  /** Reflète les clés effectives dans `process.env` (références `$VAR` du SDK). */
  bridgeSecrets(): void {
    for (const path of CONFIG_PATHS) {
      const descriptor = descriptorOf(path);
      if (!descriptor?.secret || !descriptor.env) continue;
      if (path in this.envValues) continue; // fournie par l'environnement réel
      const value = this.getString(path).trim();
      if (value.length > 0) {
        this.processEnv[descriptor.env] = value;
      } else {
        delete this.processEnv[descriptor.env];
      }
    }
  }

  /** Le store ne contient-il aucune valeur saisie ? */
  isStoreEmpty(): boolean {
    return Object.keys(this.values).length === 0;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Un abonné défaillant ne doit pas casser une écriture.
      }
    }
  }

  /** Instantané exposé par `GET /api/config` (aucune clé en clair). */
  snapshot(): ConfigSnapshot {
    const fields: Record<string, ConfigFieldSnapshot> = {};
    for (const path of CONFIG_PATHS) {
      const descriptor = CONFIG_SCHEMA[path] as FieldDescriptor;
      const origin = this.originOf(path);
      const lockedByEnv = this.isLockedByEnv(path) ? envNameOf(path) : undefined;
      if (descriptor.secret) {
        const value = this.getString(path).trim();
        fields[path] = {
          configured: value.length > 0,
          source: origin,
          masked: value.length > 0 ? maskSecret(value) : null,
          ...(lockedByEnv ? { lockedByEnv } : {}),
        };
      } else {
        fields[path] = {
          value: this.get(path),
          origin,
          apply: descriptor.apply,
          ...(lockedByEnv ? { lockedByEnv } : {}),
        };
      }
    }
    const lightKey = (fields["llm.light.apiKey"] as SecretFieldSnapshot).configured;
    const heavyKey = (fields["llm.heavy.apiKey"] as SecretFieldSnapshot).configured;
    return { fields, status: { lightKey, heavyKey, ready: lightKey } };
  }

  /**
   * Applique un patch PARTIEL fusionnant.
   *  - champ omis = conserver ;
   *  - chaîne non vide = remplacer ;
   *  - `null` = effacer (retour au défaut) ;
   *  - chaîne vide/espaces = erreur de validation.
   */
  update(patch: Record<string, unknown>): ConfigUpdateResult {
    const locked: Array<{ path: string; variable: string }> = [];
    const errors: FieldError[] = [];
    const changes: ConfigChange[] = [];
    const next: Record<string, string | number> = { ...this.values };

    for (const [path, raw] of Object.entries(patch)) {
      const descriptor = descriptorOf(path);
      if (!descriptor) {
        errors.push({
          path,
          code: "unknown_field",
          message: `Champ inconnu : ${path}.`,
        });
        continue;
      }
      if (this.isLockedByEnv(path)) {
        locked.push({ path, variable: envNameOf(path) ?? path });
        continue;
      }

      if (raw === null) {
        if (path in next) {
          const before = this.effectiveValue(path);
          delete next[path];
          changes.push({
            path,
            secret: Boolean(descriptor.secret),
            from: this.auditValue(descriptor, before),
            to: null,
          });
        }
        continue;
      }

      const result = validateField(path, raw);
      if (!result.ok) {
        errors.push({ path, code: result.code, message: result.message });
        continue;
      }
      if (path in next && next[path] === result.value) continue;
      const before = this.effectiveValue(path);
      next[path] = result.value;
      changes.push({
        path,
        secret: Boolean(descriptor.secret),
        from: this.auditValue(descriptor, before),
        to: this.auditValue(descriptor, result.value),
      });
    }

    if (locked.length > 0) throw new LockedByEnvError(locked);
    if (errors.length > 0) throw new ConfigValidationError(errors);

    if (changes.length > 0) {
      this.store.write(next);
      this.values = next;
      this.bridgeSecrets();
      this.emit();
    }

    const applied = {
      hot: changes
        .filter((change) => descriptorOf(change.path)?.apply === "hot")
        .map((change) => change.path),
      restart: changes
        .filter((change) => descriptorOf(change.path)?.apply === "restart")
        .map((change) => change.path),
    };
    const snapshot = this.snapshot();
    return { fields: snapshot.fields, status: snapshot.status, applied, changes };
  }

  /**
   * Import UNIQUE (premier démarrage) : si le store est vide et qu'un
   * `models.json` existe sur le volume, récupère « au mieux » `baseUrl`/`api`/
   * modèle par provider. N'échoue jamais ; renvoie les champs importés.
   */
  importLegacyModels(parsed: unknown): string[] {
    if (!this.isStoreEmpty()) return [];
    const providers = (parsed as { providers?: unknown } | null)?.providers;
    if (!providers || typeof providers !== "object") return [];

    const mapping: Array<[providerId: string, prefix: string]> = [
      ["llm-light", "llm.light"],
      ["llm-heavy", "llm.heavy"],
    ];
    const next = { ...this.values };
    const imported: string[] = [];

    for (const [providerId, prefix] of mapping) {
      const provider = (providers as Record<string, unknown>)[providerId];
      if (!provider || typeof provider !== "object") continue;
      const record = provider as Record<string, unknown>;
      const candidates: Array<[string, unknown]> = [
        [`${prefix}.baseUrl`, record.baseUrl],
        [`${prefix}.api`, record.api],
        [`${prefix}.model`, Array.isArray(record.models)
          ? (record.models[0] as { id?: unknown } | undefined)?.id
          : undefined],
      ];
      for (const [path, value] of candidates) {
        if (typeof value !== "string") continue;
        if (this.isLockedByEnv(path)) continue;
        if (path in next) continue;
        const result = validateField(path, value);
        if (!result.ok) continue;
        next[path] = result.value;
        imported.push(path);
      }
    }

    if (imported.length === 0) return [];
    this.store.write(next);
    this.values = next;
    this.bridgeSecrets();
    this.emit();
    return imported;
  }

  private effectiveValue(path: string): string | number {
    if (path in this.envValues) return this.envValues[path] as string | number;
    if (path in this.values) return this.values[path] as string | number;
    return this.defaults[path] ?? "";
  }

  private auditValue(
    descriptor: FieldDescriptor,
    value: string | number,
  ): string | null {
    const text = typeof value === "number" ? String(value) : value;
    if (descriptor.secret) {
      return text.trim().length > 0 ? maskSecret(text) : null;
    }
    return text.length > 0 ? text : null;
  }
}

/** Fabrique du runtime de configuration. */
export function createConfigRuntime(options: ConfigRuntimeOptions): ConfigRuntime {
  return new ConfigRuntime(options);
}
