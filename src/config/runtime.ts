/**
 * Runtime de configuration (Lot 11).
 *
 * Combine **store commun** + **overlay du bot actif** + **environnement** +
 * **défauts du code** selon la précédence
 * `défauts < store commun < overlay du bot < env`. L'environnement ne participe
 * que s'il est explicitement défini ET non vide ; dans ce cas le champ est
 * **verrouillé** (`origin: "env"`) et un `PUT` le visant est refusé
 * (`locked_by_env`).
 *
 * ⚠️ MULTI-BOT (lot 35b) : le merge vit ICI et NULLE PART ailleurs. Tous les
 * appelants (225 références, 27 fichiers) passent par `get()` : il n'existe
 * aucun autre chemin de lecture de la configuration. Un appelant qui lirait le
 * store commun directement verrait une valeur FAUSSE (sans l'overlay du bot).
 *
 * Expose `get()` / `update(patch, options)` / `subscribe()`, le **pont des clés**
 * vers `process.env` (pour que le SDK résolve `$YUKI_LLM_*_API_KEY`) et les
 * valeurs à masquer pour le logger.
 *
 * Aucun import SDK/typebox.
 */

import { readFileSync } from "node:fs";

import { EnvError, type Env, readConfigEnvOverrides } from "./env.js";
import { BOT_ID_DEFAUT, ConfigOverlayStore } from "./overlay.js";
import { resolveConfigOverlayPath } from "./paths.js";
import {
  CONFIG_PATHS,
  CONFIG_SCHEMA,
  VARIABLES_ENV_RETIREES,
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
  /**
   * Valeur par DÉFAUT réellement appliquée si aucune surcharge n'était
   * enregistrée : pour `prompts.light` / `prompts.heavy`, c'est le CONTENU DU
   * FICHIER LIVRÉ (jamais `""` quand le fichier existe).
   *
   * ⚠️ Sans elle, l'UI ne pouvait deviner le défaut que par un miroir codé en
   * dur où les prompts valaient `""` : « Réinitialiser au défaut » vidait donc
   * la zone de texte au lieu de restaurer le prompt livré.
   */
  default: string | number;
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

/**
 * Valeurs de l'enum `off|on` (aucun booléen dans `FieldType`). Une clé `mixte`
 * de fusion `et` est TOUJOURS un enum `off|on` (vérifié par un test de verrou) :
 * la conjonction s'exprime donc sans conversion.
 */
const ACTIF = "on";
const INACTIF = "off";

export interface ConfigRuntimeOptions {
  env: Env;
  /** Store commun injectable (tests). Défaut : chemin résolu depuis `env`. */
  store?: ConfigStore;
  /**
   * Overlay du bot actif, injectable (tests). Défaut :
   * `<state>/bots/<botId>/config.overlay.json` (`resolveConfigOverlayPath`).
   */
  overlay?: ConfigOverlayStore;
  /** Identifiant du bot ACTIF (défaut `BOT_ID_DEFAUT`, soit `yuki`). */
  botId?: string;
  /** Environnement source (tests). Défaut : `process.env`. */
  processEnv?: NodeJS.ProcessEnv;
  /** Défauts des prompts (contenu des fichiers livrés). */
  promptDefaults?: { light: string; heavy: string };
}

/**
 * Portée d'ÉCRITURE d'un patch (lot 35b).
 *  - `"auto"` (défaut) : `scope: "bot"`/`"mixte"` → overlay du bot actif ;
 *    `scope: "instance"` → store commun. C'est la portée par DÉFAUT : elle ne
 *    change rien de visible (mêmes valeurs effectives qu'avant le lot).
 *  - `"instance"` : store commun, quelle que soit la portée du champ (réglage
 *    d'instance, écrit par l'écran d'instance ; c'est aussi le SEUL moyen
 *    d'écrire le côté « instance » d'une clé `mixte`).
 *  - `"bot"` : overlay du bot actif pour les clés `bot`/`mixte` ; une clé
 *    `instance` n'a AUCUN équivalent par bot et reste donc dans le store commun.
 */
export interface ConfigUpdateOptions {
  portee?: "auto" | "instance" | "bot";
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
  /** Overlay du BOT ACTIF (second store, jamais imbriqué dans `config.json`). */
  private readonly overlay: ConfigOverlayStore;
  /** Identifiant du bot actif dont l'overlay est appliqué. */
  readonly botId: string;
  private readonly processEnv: NodeJS.ProcessEnv;
  private readonly defaults: Record<string, string | number> = {};
  /** Surccharges d'environnement validées (chemin → valeur). */
  private readonly envValues: Record<string, string | number> = {};
  /** Valeurs du store COMMUN validées (sparse) — portée « instance ». */
  private values: Record<string, string | number> = {};
  /** Valeurs de l'OVERLAY du bot actif validées (sparse). */
  private overlayValues: Record<string, string | number> = {};
  private readonly listeners = new Set<() => void>();

  /** Replis rencontrés au chargement (journalisés après création du logger). */
  readonly warnings: string[] = [];

  constructor(options: ConfigRuntimeOptions) {
    this.store = options.store ?? new ConfigStore(options.env.configStorePath);
    this.botId = options.botId ?? BOT_ID_DEFAUT;
    this.overlay =
      options.overlay ??
      new ConfigOverlayStore(
        resolveConfigOverlayPath(options.env.mountPoints.state, this.botId),
      );
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
    // ⚠️ Les variables RETIRÉES au lot 35b n'agissent plus : on le DIT (une
    // variable d'environnement qui n'agit pas doit être annoncée, jamais
    // supprimée en silence).
    for (const [variable, path] of Object.entries(VARIABLES_ENV_RETIREES)) {
      const raw = this.processEnv[variable];
      if (typeof raw !== "string" || raw.trim() === "") continue;
      this.warnings.push(
        `variable d'environnement RETIRÉE (lot 35b, sans effet) : ${variable} ` +
          `— réglez « ${path} » depuis la page /config (ou l'overlay du bot) : ` +
          "une clé de bot ne peut pas être fixée par l'environnement.",
      );
    }
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

    // Overlay du BOT ACTIF (validé ; une entrée invalide est ignorée et DITE).
    // ⚠️ Un fichier d'overlay est CONSERVÉ tel quel quand il est illisible : un
    // refus de lecture (EACCES) ne doit jamais effacer la configuration du bot.
    const overlaid = this.overlay.load();
    if (overlaid.source === "invalid") {
      this.warnings.push(
        `overlay de configuration du bot « ${this.botId} » illisible ` +
          `(${overlaid.error ?? "inconnu"}) — aucune surcharge appliquée, fichier conservé`,
      );
    }
    for (const [path, raw] of Object.entries(overlaid.values)) {
      const descriptor = descriptorOf(path);
      if (!descriptor) {
        this.warnings.push(`champ d'overlay inconnu ignoré : ${path}`);
        continue;
      }
      if (descriptor.scope === "instance") {
        this.warnings.push(
          `champ d'INSTANCE présent dans l'overlay du bot « ${this.botId} » ignoré : ${path}` +
            " (un réglage d'instance se règle dans le store commun, pas par bot)",
        );
        continue;
      }
      const result = validateField(path, raw);
      if (!result.ok) {
        this.warnings.push(
          `valeur d'overlay invalide pour ${path} (${result.message})`,
        );
        continue;
      }
      this.overlayValues[path] = result.value;
    }
  }

  /** Chemin du fichier d'overlay du bot actif (journaux, diagnostic, tests). */
  get overlayPath(): string {
    return this.overlay.path;
  }

  /**
   * Valeur effective d'un champ — ⚠️ CHEMIN DE LECTURE UNIQUE du produit.
   *
   * Précédence : `env > overlay du bot > store commun > défaut`.
   *
   * Deux portées de fusion :
   *  - `bot` et `mixte`+`surcharge` : l'overlay PRIME, le store commun sert de
   *    valeur de repli (une valeur héritée d'avant le lot reste donc effective) ;
   *  - `mixte`+`et` : **conjonction** (restriction). Le côté EXPLICITEMENT
   *    renseigné doit valoir `on` : instance `off` ⇒ `off` même si le bot est
   *    `on`. Un côté ABSENT n'impose rien (neutre = `on`) — sans quoi une clé
   *    jamais réglée deviendrait `off` par accident, ou activer la voix depuis
   *    `/config` n'aurait plus d'effet (le côté instance restant au défaut).
   *    Les DEUX côtés absents ⇒ défaut du schéma (comportement d'avant le lot).
   */
  get(path: string): string | number {
    if (path in this.envValues) return this.envValues[path] as string | number;
    const descriptor = descriptorOf(path);
    if (!descriptor) return this.valeurCommune(path);
    if (descriptor.scope === "instance") return this.valeurCommune(path);
    if (descriptor.scope === "mixte" && descriptor.mixteMerge === "et") {
      return this.valeurConjonction(path);
    }
    return this.valeurBot(path);
  }

  getString(path: string): string {
    return String(this.get(path));
  }

  getNumber(path: string): number {
    const value = this.get(path);
    return typeof value === "number" ? value : Number.parseInt(String(value), 10);
  }

  /** Origine effective d'un champ (l'overlay du bot compte comme « store »). */
  originOf(path: string): Origin {
    if (path in this.envValues) return "env";
    const descriptor = descriptorOf(path);
    if (descriptor?.scope === "instance") {
      return path in this.values ? "store" : "default";
    }
    if (path in this.overlayValues || path in this.values) return "store";
    return "default";
  }

  /** Valeur du store COMMUN (côté « instance »), sans overlay ni env. */
  private valeurCommune(path: string): string | number {
    if (path in this.values) return this.values[path] as string | number;
    return this.defaults[path] ?? "";
  }

  /** Valeur d'une clé de BOT : overlay d'abord, store commun en repli. */
  private valeurBot(path: string): string | number {
    if (path in this.overlayValues) return this.overlayValues[path] as string | number;
    return this.valeurCommune(path);
  }

  /** Valeur d'une clé `mixte` + `mixteMerge: "et"` : CONJONCTION des deux côtés. */
  private valeurConjonction(path: string): string | number {
    const commun = path in this.values ? this.values[path] : undefined;
    const bot = path in this.overlayValues ? this.overlayValues[path] : undefined;
    if (commun === undefined && bot === undefined) return this.valeurCommune(path);
    const estActif = (valeur: string | number) => valeur === ACTIF;
    const instanceActive = commun === undefined ? true : estActif(commun);
    const botActif = bot === undefined ? true : estActif(bot);
    return instanceActive && botActif ? ACTIF : INACTIF;
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

  /**
   * Le store ne contient-il aucune valeur saisie ?
   *
   * ⚠️ On ne regarde QUE le store COMMUN : ce prédicat sert à l'import unique de
   * `models.json` (réglages d'INSTANCE). Un overlay de bot, même rempli, ne doit
   * pas empêcher cet import-là.
   */
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
          default: this.defaults[path] ?? "",
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
   *
   * ⚠️ MULTI-BOT (lot 35b) : l'écriture est AIGUILLÉE par la portée du champ
   * (`options.portee`, défaut `"auto"`). Une clé `bot`/`mixte` va dans l'overlay
   * du bot ACTIF ; une clé `instance` va dans le store COMMUN. Aucune clé n'est
   * jamais écrite dans les deux à la fois, et `config.json` ne reçoit jamais une
   * clé de bot.
   *
   * ⚠️ `null` sur une clé écrite en overlay efface AUSSI la même clé du store
   * commun quand elle y traînait (valeur héritée d'avant le lot, ou côté
   * « instance » d'une clé mixte) : « Réinitialiser au défaut » doit rendre le
   * DÉFAUT, pas la valeur stockée d'à côté.
   */
  update(
    patch: Record<string, unknown>,
    options: ConfigUpdateOptions = {},
  ): ConfigUpdateResult {
    const portee = options.portee ?? "auto";
    const locked: Array<{ path: string; variable: string }> = [];
    const errors: FieldError[] = [];
    const changes: ConfigChange[] = [];
    const nextCommon: Record<string, string | number> = { ...this.values };
    const nextOverlay: Record<string, string | number> = { ...this.overlayValues };

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

      const versOverlay = portee !== "instance" && descriptor.scope !== "instance";
      const cible = versOverlay ? nextOverlay : nextCommon;
      const before = this.get(path);

      if (raw === null) {
        let efface = false;
        if (path in cible) {
          delete cible[path];
          efface = true;
        }
        if (versOverlay && path in nextCommon) {
          delete nextCommon[path];
          efface = true;
        }
        if (efface) {
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
      if (path in cible && cible[path] === result.value) continue;
      cible[path] = result.value;
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
      // Chaque store n'est réécrit QUE s'il a changé : un patch de clés `bot`
      // ne fait pas clignoter `config.json`, et réciproquement.
      if (!memeContenu(nextCommon, this.values)) this.store.write(nextCommon);
      if (!memeContenu(nextOverlay, this.overlayValues)) this.overlay.write(nextOverlay);
      this.values = nextCommon;
      this.overlayValues = nextOverlay;
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

/** Deux magasins plats portent-ils EXACTEMENT le même contenu ? */
function memeContenu(
  a: Readonly<Record<string, string | number>>,
  b: Readonly<Record<string, string | number>>,
): boolean {
  const clesA = Object.keys(a);
  if (clesA.length !== Object.keys(b).length) return false;
  return clesA.every((cle) => cle in b && a[cle] === b[cle]);
}

/** Fabrique du runtime de configuration. */
export function createConfigRuntime(options: ConfigRuntimeOptions): ConfigRuntime {
  return new ConfigRuntime(options);
}
