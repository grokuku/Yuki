/**
 * Store de secrets de Yuki — FAÇADE au coffre chiffré (`vault.ts`).
 *
 * ## Rôle
 *
 * Le coffre (`SecretVault`) sait chiffrer/déchiffrer ; ce store lui ajoute :
 *   - une ouverture PARESSEUSE (le coffre n'est ouvert qu'au premier besoin) ;
 *   - une surface tolérante pour le MASQUAGE (`values()` ne lève jamais : un
 *     coffre verrouillé ne doit pas casser le logger ni l'audit) ;
 *   - le REFUS explicite dès qu'une opération exige le coffre alors que la clé
 *     maître manque (jamais de repli en clair) ;
 *   - une notification de CHANGEMENT (`onChange`) pour rafraîchir la liste
 *     PARTAGÉE des valeurs à masquer (logger + audit) quand un secret est
 *     ajouté/retiré à chaud.
 *
 * ⚠️ La valeur d'un secret ne sort JAMAIS d'ici que par `lookup()` (résolution
 * d'une commande) et `values()` (redaction de sortie). Ni l'API, ni l'audit, ni
 * le transcript ne la voient.
 */

import {
  SecretVault,
  VaultKeyInvalidError,
  VaultKeyMissingError,
  VAULT_KEY_ENV,
  type VaultEntryView,
} from "./vault.js";

export interface SecretStoreLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface SecretStoreOptions {
  /** Chemin du fichier de coffre (volume `state`, mode 0600). */
  path: string;
  /** Clé maître explicite (tests) ; sinon lue dans `env` (`YUKI_VAULT_KEY`). */
  key?: string;
  /** Environnement porteur de la clé (défaut : `process.env`). */
  env?: NodeJS.ProcessEnv;
  logger?: SecretStoreLogger;
  /**
   * Appelé à chaque MUTATION (ajout/suppression) avec les valeurs à jour. Sert
   * à rafraîchir la liste partagée de redaction sans redémarrer.
   */
  onChange?: (values: string[]) => void;
}

export class SecretStore {
  private readonly path: string;
  private readonly key?: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly logger?: SecretStoreLogger;
  private readonly onChange?: (values: string[]) => void;
  /** Coffre ouvert (mémoïsé). `undefined` tant que non ouvert OU non ouvrable. */
  private vault?: SecretVault;
  /** Erreur d'ouverture mémoïsée (clé fausse / fichier altéré), si ouverture tentée. */
  private openError?: unknown;

  constructor(options: SecretStoreOptions) {
    this.path = options.path;
    this.key = options.key;
    this.env = options.env ?? process.env;
    this.logger = options.logger;
    this.onChange = options.onChange;
  }

  /** Clé maître effective (variable d'environnement ou override). */
  private masterKey(): string {
    return this.key ?? this.env[VAULT_KEY_ENV] ?? "";
  }

  /** `true` si la clé maître est présente : le coffre est alors UTILISABLE. */
  isConfigured(): boolean {
    return this.masterKey().length > 0;
  }

  /** Chemin du fichier de coffre (diagnostic). */
  get filePath(): string {
    return this.path;
  }

  /**
   * Ouvre le coffre à la demande. Ne lève jamais : renvoie `undefined` si la
   * clé manque ou si le coffre est illisible.
   */
  private ensure(): SecretVault | undefined {
    if (this.vault) return this.vault;
    if (this.openError) return undefined;
    if (!this.isConfigured()) return undefined;
    try {
      this.vault = SecretVault.open({ path: this.path, key: this.masterKey() });
      return this.vault;
    } catch (error) {
      this.openError = error;
      this.logger?.error("secrets.vault.open_failed", {
        path: this.path,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /** Exige un coffre ouvert : lève l'erreur honnête sinon. */
  private require(): SecretVault {
    const vault = this.ensure();
    if (vault) return vault;
    if (!this.isConfigured()) throw new VaultKeyMissingError();
    throw this.openError instanceof Error
      ? this.openError
      : new VaultKeyInvalidError(this.openError);
  }

  /** Valeur déchiffrée d'un secret, ou `undefined` (verrouillé/absent/illisible). */
  lookup(name: string): string | undefined {
    return this.ensure()?.get(name);
  }

  /** Un secret de ce nom existe-t-il (coffre ouvert) ? Jamais levée. */
  has(name: string): boolean {
    return this.ensure()?.has(name) ?? false;
  }

  /**
   * Toutes les valeurs déchiffrées (pour la redaction). Jamais levée : `[]` si le
   * coffre est verrouillé, illisible ou vide.
   */
  values(): string[] {
    return this.ensure()?.values() ?? [];
  }

  /** Vue PUBLIQUE des entrées (nom + libellé + date), sans valeur. Lève si verrouillé. */
  list(): VaultEntryView[] {
    return this.require().list();
  }

  /** Ajoute ou remplace un secret, persiste, et notifie la redaction. Lève si verrouillé. */
  set(name: string, value: string, label?: string): VaultEntryView {
    const view = this.require().set(name, value, label);
    this.notifyChange();
    return view;
  }

  /** Supprime un secret. Renvoie `true` s'il existait. Lève si verrouillé. */
  delete(name: string): boolean {
    const removed = this.require().delete(name);
    if (removed) this.notifyChange();
    return removed;
  }

  private notifyChange(): void {
    if (!this.onChange) return;
    try {
      this.onChange(this.values());
    } catch (error) {
      this.logger?.warn("secrets.vault.onchange_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
