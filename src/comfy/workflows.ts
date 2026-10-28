/**
 * STOCKAGE des workflows ComfyUI nommés (volume `state`, fichier SÉPARÉ).
 *
 * ⚠️ Décision de stockage : les workflows vivent dans
 * `${state}/comfy/workflows.json`, JAMAIS dans `config.json`. Raisons :
 *  - `PUT /api/config` attend un patch PLAT de champs SCALAIRES (`string|int|enum`) ;
 *  - un graphe pèse facilement des dizaines de Ko (parfois plusieurs Mo) et
 *    ferait grossir le fichier de configuration à chaque écriture ;
 *  - l'API de configuration ne renvoie donc JAMAIS un graphe par accident.
 *
 * Le fichier est écrit de façon ATOMIQUE (`tmp` + `rename`). Un fichier absent
 * ou illisible ne fait JAMAIS échouer le démarrage : on repart d'une liste vide
 * et on journalise la cause (le fichier est conservé tel quel).
 *
 * Chaque entrée porte son NOM D'USAGE (`manga`, `realiste`…), une DESCRIPTION
 * COURTE (choix par proximité), l'indicateur « par défaut » et une
 * DOCUMENTATION D'ÉCRITURE (facultative). Les étiquettes (`YUKI_PROMPT`…) sont
 * RE-RÉSOLUES au chargement : un graphe importé puis modifié à la main ne peut
 * pas passer pour valide.
 *
 * ⚠️ LA DOCUMENTATION EST POUR YUKI, PAS POUR COMFYUI : elle décrit COMMENT
 * ÉCRIRE la scène pour que CE workflow rende ce qu'elle veut. Elle n'est donc
 * JAMAIS recopiée dans une scène, JAMAIS écrite dans un graphe, et JAMAIS
 * injectée dans le prompt système (trop lourd à chaque tour) : elle est servie
 * À LA DEMANDE, par l'outil `consulter_workflow`. C'est pour cela que
 * `candidates()` ne la porte pas : ce qui part dans le prompt de chaque tour est
 * exactement ce que `candidates()` renvoie.
 *
 * BORNE : `MAX_COMFY_DOCUMENTATION_CHARS` (8 000). Au-delà, l'enregistrement est
 * REFUSÉ avec la longueur réelle (jamais une troncature silencieuse). Un fichier
 * retouché à la main qui dépasserait la borne est, lui, TRONQUÉ AU CHARGEMENT et
 * la coupe est JOURNALISÉE (un fichier abîmé ne doit pas empêcher le démarrage).
 */

import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import type { ComfyLogger } from "./types.js";
import {
  YUKI_NODE_LABELS,
  validateApiWorkflow,
  type WorkflowNodeRef,
  type YukiNodeLabel,
} from "./validate.js";
import type { WorkflowCandidate } from "./selection.js";

/** Version de schéma du fichier des workflows. */
export const COMFY_WORKFLOWS_SCHEMA_VERSION = 1;
/** Nombre maximal de workflows nommés. */
export const MAX_COMFY_WORKFLOWS = 20;
/** Taille maximale d'UN graphe sérialisé (octets). */
export const MAX_COMFY_WORKFLOW_BYTES = 2 * 1024 * 1024;
/** Taille maximale du fichier complet (garde-fou de volume). */
export const MAX_COMFY_WORKFLOWS_FILE_BYTES = 8 * 1024 * 1024;
/** Longueur maximale d'une description courte. */
export const MAX_COMFY_DESCRIPTION_CHARS = 200;
/**
 * Longueur maximale de la DOCUMENTATION d'écriture d'un workflow (caractères).
 *
 * ⚠️ 8 000 : la documentation d'un workflow peut être un VRAI CONTRAT (règles de
 * décision, structure imposée, interdits, portes de vérification) et elle n'est
 * JAMAIS dans le prompt système — seulement servie à la demande par
 * `consulter_workflow`. Son poids ne coûte donc rien aux tours normaux : la
 * borne ne protège plus la taille du contexte mais l'illisibilité.
 */
export const MAX_COMFY_DOCUMENTATION_CHARS = 8_000;
/** Longueur maximale du nom d'usage. */
export const MAX_COMFY_NAME_CHARS = 40;

/** Nom d'usage : slug ASCII (aucun accent, espace ni séparateur de chemin). */
const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;

export type ComfyWorkflowErrorCode =
  | "invalid_name"
  | "invalid_description"
  | "invalid_documentation"
  | "invalid_workflow"
  | "unsupported_format"
  | "missing_required_label"
  | "duplicate_label"
  | "unsupported_label"
  | "workflow_too_large"
  | "too_many_workflows"
  | "not_found"
  | "storage_failed";

/** Refus EXPLICITE d'import (message déjà en français, actionnable). */
export class ComfyWorkflowError extends Error {
  override readonly name = "ComfyWorkflowError";
  constructor(
    readonly code: ComfyWorkflowErrorCode,
    message: string,
    readonly found: YukiNodeLabel[] = [],
    readonly missing: YukiNodeLabel[] = [...YUKI_NODE_LABELS],
    readonly causeError?: unknown,
  ) {
    super(message, causeError !== undefined ? { cause: causeError } : {});
  }
}

/** Résumé d'un workflow (ce que l'API expose : jamais le graphe entier). */
export interface ComfyWorkflowSummary {
  name: string;
  description: string;
  /**
   * Consignes d'écriture POUR YUKI (`""` si aucune). ⚠️ Jamais injectée dans le
   * prompt système : servie uniquement par l'outil `consulter_workflow`.
   */
  documentation: string;
  isDefault: boolean;
  addedAt: string;
  /** Taille du graphe sérialisé (octets). */
  bytes: number;
  /** Nombre de nœuds. */
  nodes: number;
  /** Étiquettes trouvées / manquantes (affichées à l'import). */
  found: YukiNodeLabel[];
  missing: YukiNodeLabel[];
}

/** Entrée complète (usage interne : le graphe reste sur le serveur). */
export interface ComfyWorkflowEntry extends ComfyWorkflowSummary {
  workflow: Record<string, unknown>;
  labels: Partial<Record<YukiNodeLabel, WorkflowNodeRef>>;
}

/** Port consommé par le générateur et par l'API de configuration. */
export interface ComfyWorkflowsPort {
  list(): ComfyWorkflowSummary[];
  candidates(): WorkflowCandidate[];
  get(name: string): ComfyWorkflowEntry | null;
  importWorkflow(input: {
    name: string;
    description: string;
    /** Consignes d'écriture (facultatives, bornées) — jamais envoyées à ComfyUI. */
    documentation?: string;
    workflow: unknown;
    isDefault?: boolean;
  }): ComfyWorkflowSummary;
  /**
   * Enregistre les MÉTADONNÉES éditables d'un workflow : la DESCRIPTION COURTE
   * (`description`, elle sert au choix par proximité) et/ou les CONSIGNES
   * D'ÉCRITURE (`documentation`, texte POUR YUKI ; `""` efface).
   *
   * ⚠️ Les deux valeurs sont VALIDÉES AVANT la moindre écriture : un refus ne
   * laisse JAMAIS un enregistrement partiel. Renvoie le résumé à jour, ou
   * `null` si le workflow n'existe pas.
   *
   * ⚠️ Le NOM n'est pas modifiable : il sert de CLÉ (`PUT /workflows/<nom>`,
   * `consulter_workflow`, `generer_image`).
   */
  updateMetadata(
    name: string,
    patch: { description?: unknown; documentation?: unknown },
  ): ComfyWorkflowSummary | null;
  remove(name: string): boolean;
  setDefault(name: string): boolean;
}

interface StoredWorkflow {
  name: string;
  description: string;
  documentation: string;
  isDefault: boolean;
  addedAt: string;
  workflow: unknown;
}

export interface ComfyWorkflowStoreOptions {
  path: string;
  logger?: ComfyLogger;
  now?: () => number;
}

/** Cause système traduite (jamais un échec muet). */
function writeReason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case "EACCES":
    case "EPERM":
      return "permission refusée";
    case "EROFS":
      return "système de fichiers en lecture seule";
    case "ENOSPC":
      return "disque plein";
    case "ENOENT":
      return "dossier parent introuvable";
    default:
      return error instanceof Error ? error.message : String(error);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Valide et normalise le nom d'usage. */
export function normalizeWorkflowName(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new ComfyWorkflowError("invalid_name", "Le nom d'usage doit être un texte.");
  }
  const name = raw.trim().toLowerCase();
  if (name === "" || name.length > MAX_COMFY_NAME_CHARS) {
    throw new ComfyWorkflowError(
      "invalid_name",
      `Le nom d'usage doit faire de 1 à ${MAX_COMFY_NAME_CHARS} caractères.`,
    );
  }
  if (!NAME_PATTERN.test(name)) {
    throw new ComfyWorkflowError(
      "invalid_name",
      "Le nom d'usage n'accepte que des lettres non accentuées, des chiffres, " +
        "« - » et « _ » (ex. « manga », « realiste », « infographie »).",
    );
  }
  return name;
}

/** Valide la description courte (obligatoire : elle sert au choix). */
export function normalizeWorkflowDescription(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new ComfyWorkflowError(
      "invalid_description",
      "La description courte doit être un texte.",
    );
  }
  const description = raw.trim().replace(/\s+/g, " ");
  if (description === "") {
    throw new ComfyWorkflowError(
      "invalid_description",
      "La description courte est OBLIGATOIRE : c'est elle qui permet de choisir " +
        "ce workflow par proximité (ex. « Manga / anime — traits marqués, trames »).",
    );
  }
  if (description.length > MAX_COMFY_DESCRIPTION_CHARS) {
    throw new ComfyWorkflowError(
      "invalid_description",
      `La description courte est trop longue (${description.length} caractères, ` +
        `maximum ${MAX_COMFY_DESCRIPTION_CHARS}).`,
    );
  }
  return description;
}

/**
 * Coupe un texte à `limit` caractères SANS séparer une paire de substitution
 * (un emoji tronqué devient illisible).
 */
function cutText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let cut = limit;
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return text.slice(0, cut);
}

/**
 * Valide la DOCUMENTATION d'écriture (facultative).
 *
 * ⚠️ REFUS au-delà de la borne, avec la longueur RÉELLE : on ne tronque jamais
 * en silence un texte que Yuki devra suivre.
 */
export function normalizeWorkflowDocumentation(raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") {
    throw new ComfyWorkflowError(
      "invalid_documentation",
      "Les consignes d'écriture doivent être un texte.",
    );
  }
  const documentation = raw.trim();
  if (documentation.length > MAX_COMFY_DOCUMENTATION_CHARS) {
    throw new ComfyWorkflowError(
      "invalid_documentation",
      `Les consignes d'écriture font ${documentation.length} caractères : la ` +
        `limite est de ${MAX_COMFY_DOCUMENTATION_CHARS}. Raccourcis-les puis ` +
        "enregistre à nouveau (rien n'est tronqué en silence).",
    );
  }
  return documentation;
}

/** Résumé à partir des champs bruts d'un graphe validé. */
function summarize(
  name: string,
  description: string,
  documentation: string,
  isDefault: boolean,
  addedAt: string,
  workflow: Record<string, unknown>,
  bytes: number,
): Omit<ComfyWorkflowEntry, "workflow" | "labels"> {
  const check = validateApiWorkflow(workflow);
  const found = check.ok ? check.found : [];
  const missing = check.ok ? check.missing : [...YUKI_NODE_LABELS];
  return {
    name,
    description,
    documentation,
    isDefault,
    addedAt,
    bytes,
    nodes: Object.keys(workflow).length,
    found,
    missing,
  };
}

/** Store fichier des workflows nommés. */
export class ComfyWorkflowStore implements ComfyWorkflowsPort {
  private readonly path: string;
  private readonly logger: ComfyLogger | undefined;
  private readonly now: () => number;
  private readonly entries = new Map<string, ComfyWorkflowEntry>();

  constructor(options: ComfyWorkflowStoreOptions) {
    this.path = options.path;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.load();
  }

  get filePath(): string {
    return this.path;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Charge le fichier (tolérant : un contenu invalide ne bloque rien). */
  private load(): void {
    if (!existsSync(this.path)) return;
    let parsed: unknown;
    try {
      const text = readFileSync(this.path, "utf8");
      if (text.length > MAX_COMFY_WORKFLOWS_FILE_BYTES) {
        this.logger?.warn("comfy.workflows.too_large", {
          bytes: text.length,
          limit: MAX_COMFY_WORKFLOWS_FILE_BYTES,
        });
        return;
      }
      parsed = JSON.parse(text);
    } catch (error) {
      this.logger?.warn("comfy.workflows.unreadable", { error: messageOf(error) });
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      this.logger?.warn("comfy.workflows.invalid", { reason: "objet JSON attendu" });
      return;
    }
    const root = parsed as Record<string, unknown>;
    if (root.schemaVersion !== COMFY_WORKFLOWS_SCHEMA_VERSION) {
      this.logger?.warn("comfy.workflows.invalid", {
        reason: `schemaVersion inconnue (${JSON.stringify(root.schemaVersion)})`,
      });
      return;
    }
    const list = Array.isArray(root.workflows) ? root.workflows : [];
    for (const raw of list) {
      const stored = this.readStored(raw);
      if (!stored) continue;
      const check = validateApiWorkflow(stored.workflow);
      if (!check.ok) {
        this.logger?.warn("comfy.workflows.skipped", {
          name: stored.name,
          reason: check.message,
        });
        continue;
      }
      this.entries.set(stored.name, {
        ...summarize(
          stored.name,
          stored.description,
          stored.documentation,
          stored.isDefault,
          stored.addedAt,
          check.workflow,
          Buffer.byteLength(JSON.stringify(check.workflow), "utf8"),
        ),
        workflow: check.workflow,
        labels: check.labels,
      });
    }
    // Un seul « par défaut » : le premier rencontré gagne (fichier retouché).
    let sawDefault = false;
    for (const entry of this.entries.values()) {
      if (!entry.isDefault) continue;
      if (sawDefault) entry.isDefault = false;
      else sawDefault = true;
    }
    this.logger?.info("comfy.workflows.loaded", {
      path: this.path,
      workflows: this.entries.size,
    });
  }

  /**
   * Documentation relue d'un fichier : LENIENTE et bornée.
   *
   * ⚠️ Un fichier retouché à la main ne doit JAMAIS empêcher le démarrage : une
   * valeur non textuelle devient « aucune consigne », une valeur trop longue est
   * TRONQUÉE À LA BORNE — et la coupe est JOURNALISÉE (elle est donc dite).
   */
  private readDocumentation(raw: unknown, name: string): string {
    if (raw === undefined || raw === null) return "";
    if (typeof raw !== "string") {
      this.logger?.warn("comfy.workflow.documentation_invalid", {
        name,
        reason: "texte attendu",
      });
      return "";
    }
    const text = raw.trim();
    if (text.length <= MAX_COMFY_DOCUMENTATION_CHARS) return text;
    this.logger?.warn("comfy.workflow.documentation_truncated", {
      name,
      chars: text.length,
      limit: MAX_COMFY_DOCUMENTATION_CHARS,
    });
    return cutText(text, MAX_COMFY_DOCUMENTATION_CHARS);
  }

  /** Lit une entrée brute du fichier (forme défensive). */
  private readStored(raw: unknown): StoredWorkflow | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const entry = raw as Record<string, unknown>;
    try {
      const name = normalizeWorkflowName(entry.name);
      const description = normalizeWorkflowDescription(entry.description);
      return {
        name,
        description,
        documentation: this.readDocumentation(entry.documentation, name),
        isDefault: entry.isDefault === true,
        addedAt: typeof entry.addedAt === "string" ? entry.addedAt : new Date(0).toISOString(),
        workflow: entry.workflow,
      };
    } catch (error) {
      this.logger?.warn("comfy.workflows.entry_invalid", { error: messageOf(error) });
      return null;
    }
  }

  /** Écrit le fichier (atomique, 0600 : configuration privée). */
  private persist(): void {
    const workflows: StoredWorkflow[] = [...this.entries.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => ({
        name: entry.name,
        description: entry.description,
        documentation: entry.documentation,
        isDefault: entry.isDefault,
        addedAt: entry.addedAt,
        workflow: entry.workflow,
      }));
    const payload = `${JSON.stringify(
      { schemaVersion: COMFY_WORKFLOWS_SCHEMA_VERSION, workflows },
      null,
      2,
    )}\n`;
    if (Buffer.byteLength(payload, "utf8") > MAX_COMFY_WORKFLOWS_FILE_BYTES) {
      throw new ComfyWorkflowError(
        "too_many_workflows",
        "Les workflows enregistrés dépassent la taille maximale du fichier " +
          `(${MAX_COMFY_WORKFLOWS_FILE_BYTES} octets) : supprimez-en un.`,
      );
    }
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
      writeFileSync(tmp, payload, { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch (error) {
      const reason = writeReason(error);
      this.logger?.error("comfy.workflows.write_failed", { path: this.path, reason });
      throw new ComfyWorkflowError(
        "storage_failed",
        `Impossible d'enregistrer les workflows (${reason}) dans ${this.path}.`,
        [],
        [],
        error,
      );
    }
  }

  list(): ComfyWorkflowSummary[] {
    return [...this.entries.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ workflow: _workflow, labels: _labels, ...summary }) => ({ ...summary }));
  }

  candidates(): WorkflowCandidate[] {
    return [...this.entries.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => ({
        name: entry.name,
        description: entry.description,
        isDefault: entry.isDefault,
      }));
  }

  get(name: string): ComfyWorkflowEntry | null {
    let key: string;
    try {
      key = normalizeWorkflowName(name);
    } catch {
      return null;
    }
    return this.entries.get(key) ?? null;
  }

  /**
   * Importe (ou REMPLACE) un workflow nommé. ⚠️ Valide TOUT AVANT d'écrire :
   * un JSON invalide ne laisse jamais d'entrée à moitié enregistrée.
   */
  importWorkflow(input: {
    name: string;
    description: string;
    documentation?: string;
    workflow: unknown;
    isDefault?: boolean;
  }): ComfyWorkflowSummary {
    const name = normalizeWorkflowName(input.name);
    const description = normalizeWorkflowDescription(input.description);
    // ⚠️ La documentation est validée AVANT toute écriture, comme le reste :
    // un texte trop long ne laisse pas d'entrée à moitié enregistrée.
    const documentation = normalizeWorkflowDocumentation(
      input.documentation ?? this.entries.get(name)?.documentation ?? "",
    );
    const serialized = (() => {
      try {
        return JSON.stringify(input.workflow ?? null);
      } catch (error) {
        throw new ComfyWorkflowError(
          "invalid_workflow",
          `Le workflow n'est pas sérialisable en JSON : ${messageOf(error)}`,
        );
      }
    })();
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes > MAX_COMFY_WORKFLOW_BYTES) {
      throw new ComfyWorkflowError(
        "workflow_too_large",
        `Le workflow est trop volumineux (${bytes} octets, maximum ` +
          `${MAX_COMFY_WORKFLOW_BYTES}).`,
      );
    }
    const check = validateApiWorkflow(input.workflow);
    if (!check.ok) {
      const code: ComfyWorkflowErrorCode =
        check.code === "unsupported_format"
          ? "unsupported_format"
          : check.code === "missing_required_label"
            ? "missing_required_label"
            : check.code === "duplicate_label"
              ? "duplicate_label"
              : check.code === "unsupported_label"
                ? "unsupported_label"
                : "invalid_workflow";
      throw new ComfyWorkflowError(code, check.message, check.found, check.missing);
    }
    if (!this.entries.has(name) && this.entries.size >= MAX_COMFY_WORKFLOWS) {
      throw new ComfyWorkflowError(
        "too_many_workflows",
        `Le nombre maximal de workflows est atteint (${MAX_COMFY_WORKFLOWS}) : ` +
          "supprimez-en un avant d'en importer un autre.",
      );
    }

    const isDefault = input.isDefault === true || this.entries.get(name)?.isDefault === true;
    if (isDefault) {
      for (const entry of this.entries.values()) entry.isDefault = false;
    }
    const entry: ComfyWorkflowEntry = {
      ...summarize(
        name,
        description,
        documentation,
        isDefault,
        this.entries.get(name)?.addedAt ?? new Date(this.now()).toISOString(),
        check.workflow,
        bytes,
      ),
      workflow: check.workflow,
      labels: check.labels,
    };
    this.entries.set(name, entry);
    this.persist();
    this.logger?.info("comfy.workflow.imported", {
      name,
      nodes: entry.nodes,
      bytes,
      found: entry.found,
      missing: entry.missing,
      isDefault,
    });
    const { workflow: _workflow, labels: _labels, ...summary } = entry;
    return { ...summary };
  }

  /**
   * Enregistre la DESCRIPTION COURTE et/ou les CONSIGNES D'ÉCRITURE d'un
   * workflow.
   *
   * ⚠️ VALIDATION D'ABORD, ÉCRITURE ENSUITE : les deux valeurs sont normalisées
   * (donc validées) AVANT de toucher l'entrée. Un refus (`invalid_documentation`,
   * `invalid_description`) laisse le workflow EXACTEMENT dans son état d'avant —
   * jamais de description enregistrée à moitié.
   * ⚠️ Le graphe lui-même n'est jamais remplacé : seules les métadonnées changent.
   */
  updateMetadata(
    name: string,
    patch: { description?: unknown; documentation?: unknown },
  ): ComfyWorkflowSummary | null {
    let key: string;
    try {
      key = normalizeWorkflowName(name);
    } catch {
      return null;
    }
    const entry = this.entries.get(key);
    if (!entry) return null;
    const source = patch ?? {};
    const hasDescription = Object.prototype.hasOwnProperty.call(source, "description");
    const hasDocumentation = Object.prototype.hasOwnProperty.call(source, "documentation");
    // ① Validation (aucune écriture tant que les deux ne sont pas validées).
    const nextDescription = hasDescription
      ? normalizeWorkflowDescription(source.description)
      : entry.description;
    const nextDocumentation = hasDocumentation
      ? normalizeWorkflowDocumentation(source.documentation)
      : entry.documentation;
    // ② Écriture (une seule persistance, et seulement si quelque chose change).
    const changed =
      nextDescription !== entry.description || nextDocumentation !== entry.documentation;
    entry.description = nextDescription;
    entry.documentation = nextDocumentation;
    if (changed) this.persist();
    this.logger?.info("comfy.workflow.metadata", {
      name: key,
      chars: nextDocumentation.length,
      cleared: nextDocumentation === "",
      descriptionChars: nextDescription.length,
      changed,
    });
    const { workflow: _workflow, labels: _labels, ...summary } = entry;
    return { ...summary };
  }

  remove(name: string): boolean {
    let key: string;
    try {
      key = normalizeWorkflowName(name);
    } catch {
      return false;
    }
    if (!this.entries.delete(key)) return false;
    this.persist();
    this.logger?.info("comfy.workflow.removed", { name: key });
    return true;
  }

  setDefault(name: string): boolean {
    let key: string;
    try {
      key = normalizeWorkflowName(name);
    } catch {
      return false;
    }
    if (!this.entries.has(key)) return false;
    for (const entry of this.entries.values()) entry.isDefault = entry.name === key;
    this.persist();
    this.logger?.info("comfy.workflow.default", { name: key });
    return true;
  }
}
