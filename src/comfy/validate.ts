/**
 * Validation d'un workflow ComfyUI au FORMAT API + résolution des ÉTIQUETTES.
 *
 * ⚠️ Les nœuds sont retrouvés PAR LEUR TITRE (`_meta.title`), JAMAIS par leur
 * numéro : les identifiants changent dès qu'on retouche le graphe.
 *
 * Étiquettes reconnues (exactement, casse comprise) :
 *   YUKI_PROMPT   → prompt positif (OBLIGATOIRE)
 *   YUKI_NEGATIVE → prompt négatif (facultatif)
 *   YUKI_SEED     → graine
 *   YUKI_WIDTH    → largeur
 *   YUKI_HEIGHT   → hauteur
 *   YUKI_OUTPUT   → nœud qui produit l'IMAGE FINALE (facultatif)
 *
 * ⚠️ Les cinq premières désignent un CHAMP À ÉCRIRE ; `YUKI_OUTPUT` désigne un
 * NŒUD À LIRE (`outputs[<nœud>].images[]` dans l'historique) : il ne porte donc
 * aucun champ d'accueil. Absent, la première image produite est retenue (et
 * c'est DIT : journal + résultat de l'outil). Présent, SEULE son image est
 * retenue : si elle n'existe pas, c'est une ERREUR explicite — jamais de repli
 * silencieux sur un autre nœud.

 * Le champ d'accueil est résolu à l'IMPORT (et non au moment de générer) : un
 * graphe mal étiqueté est REFUSÉ tout de suite, avec les étiquettes trouvées et
 * manquantes. Aucune supposition au moment de générer.
 *
 * Module PUR (aucun accès disque, aucun réseau, aucun import SDK).
 */

/** Étiquettes reconnues, dans l'ordre d'affichage. */
export const YUKI_NODE_LABELS = [
  "YUKI_PROMPT",
  "YUKI_NEGATIVE",
  "YUKI_SEED",
  "YUKI_WIDTH",
  "YUKI_HEIGHT",
  "YUKI_OUTPUT",
] as const;

export type YukiNodeLabel = (typeof YUKI_NODE_LABELS)[number];

/** Seule étiquette EXIGÉE : sans elle, aucun prompt ne peut être injecté. */
export const YUKI_REQUIRED_LABEL: YukiNodeLabel = "YUKI_PROMPT";

/**
 * Étiquette du nœud qui produit l'IMAGE FINALE.
 *
 * ⚠️ Seule étiquette qui ne désigne AUCUN champ à écrire : elle désigne le nœud
 * dont on lit la sortie image. Elle reste FACULTATIVE (les workflows déjà
 * importés continuent de fonctionner à l'identique).
 */
export const YUKI_OUTPUT_LABEL: YukiNodeLabel = "YUKI_OUTPUT";

/**
 * Prompt négatif NEUTRE appliqué au nœud `YUKI_NEGATIVE`.
 *
 * ⚠️ Il ne décrit AUCUN style (pas de « manga », pas de « photo ») : uniquement
 * des DÉFAUTS techniques, pour ne pas entrer en conflit avec l'enhancer du
 * workflow de l'utilisateur. Absent du graphe ⇒ rien n'est injecté.
 */
export const YUKI_DEFAULT_NEGATIVE =
  "flou, basse résolution, artefacts de compression, déformation, texte illisible";

/** Nœud retenu pour une étiquette : identifiant, type et champ d'accueil. */
export interface WorkflowNodeRef {
  nodeId: string;
  classType: string;
  /**
   * Nom du champ d'entrée réellement écrit (`text`, `seed`, `width`…).
   * ⚠️ `undefined` pour `YUKI_OUTPUT` : cette étiquette ne désigne aucun champ.
   */
  field?: string;
}

export type WorkflowLabels = Partial<Record<YukiNodeLabel, WorkflowNodeRef>>;

export interface WorkflowCheckOk {
  ok: true;
  /** Graphe au format API, PRÊT à être envoyé (`prompt` du POST /prompt). */
  workflow: Record<string, unknown>;
  labels: WorkflowLabels;
  found: YukiNodeLabel[];
  missing: YukiNodeLabel[];
  /** Nombre de nœuds du graphe (affiché à l'import). */
  nodes: number;
}

export interface WorkflowCheckKo {
  ok: false;
  /** Code stable (tests, messages) : `invalid_workflow`, `unsupported_format`… */
  code: string;
  message: string;
  labels: WorkflowLabels;
  found: YukiNodeLabel[];
  missing: YukiNodeLabel[];
  nodes: number;
}

export type WorkflowCheck = WorkflowCheckOk | WorkflowCheckKo;

type NodeMap = Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Déballe une enveloppe `{ prompt: {…} }` (certains exports) ; renvoie le graphe
 * tel quel sinon. `null` si la forme n'est pas un objet.
 */
function unwrapWorkflow(raw: unknown): NodeMap | null {
  if (!isPlainObject(raw)) return null;
  const prompt = raw.prompt;
  if (isPlainObject(prompt) && !("class_type" in raw)) {
    return prompt;
  }
  return raw;
}

/** Ordre STABLE des nœuds : numérique quand possible, sinon lexical. */
function sortedNodeIds(nodes: NodeMap): string[] {
  return Object.keys(nodes).sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    if (Number.isFinite(na)) return -1;
    if (Number.isFinite(nb)) return 1;
    return a.localeCompare(b);
  });
}

/** Titre déclaré par le nœud (`_meta.title`), chaîne vide s'il est absent. */
function nodeTitle(node: Record<string, unknown>): string {
  const meta = node._meta;
  if (!isPlainObject(meta)) return "";
  const title = meta.title;
  return typeof title === "string" ? title.trim() : "";
}

/** Champ TEXTE d'un nœud : `text`, puis `prompt`, puis le 1er champ texte. */
function pickTextField(inputs: Record<string, unknown>): string | undefined {
  for (const name of ["text", "prompt"]) {
    if (typeof inputs[name] === "string") return name;
  }
  for (const [name, value] of Object.entries(inputs)) {
    if (typeof value === "string") return name;
  }
  return undefined;
}

/**
 * Champ ENTIER d'un nœud : les noms préférés d'abord, puis le premier champ
 * entier STRICTEMENT (jamais un flottant : `strength`, `denoise`… sont exclus).
 */
function pickIntField(
  inputs: Record<string, unknown>,
  preferred: readonly string[],
): string | undefined {
  for (const name of preferred) {
    const value = inputs[name];
    if (typeof value === "number" && Number.isInteger(value)) return name;
  }
  for (const name of preferred) {
    const value = inputs[name];
    if (typeof value === "number" && Number.isFinite(value)) return name;
  }
  for (const [name, value] of Object.entries(inputs)) {
    if (typeof value === "number" && Number.isInteger(value)) return name;
  }
  return undefined;
}

/**
 * Résout le champ d'accueil d'une étiquette, ou `undefined` si impossible.
 *
 * ⚠️ `YUKI_OUTPUT` n'a JAMAIS de champ d'accueil : c'est un nœud qu'on LIT, pas
 * un champ qu'on écrit (`null` = « aucun champ attendu », distinct de
 * `undefined` = « champ introuvable »).
 */
function resolveField(
  label: YukiNodeLabel,
  inputs: Record<string, unknown>,
): string | null | undefined {
  switch (label) {
    case "YUKI_PROMPT":
    case "YUKI_NEGATIVE":
      return pickTextField(inputs);
    case "YUKI_SEED":
      return pickIntField(inputs, ["seed", "noise_seed"]);
    case "YUKI_WIDTH":
      return pickIntField(inputs, ["width"]);
    case "YUKI_HEIGHT":
      return pickIntField(inputs, ["height"]);
    case "YUKI_OUTPUT":
      return null;
  }
}

/**
 * Valide un graphe au format API et résout les six étiquettes.
 *
 * Règles :
 *  - objet racine (une enveloppe `{ prompt }` est acceptée) ;
 *  - chaque nœud : `{ class_type: string, inputs: objet }` ;
 *  - chaque titre d'étiquette : UN SEUL nœud (un doublon est ambigu ⇒ refus) ;
 *  - `YUKI_PROMPT` présent ET son nœud doit avoir un champ texte inscriptible ;
 *  - les autres étiquettes sont FACULTATIVES ; si présentes, leur champ doit
 *    être résoluble (sinon refus explicite, plutôt qu'une écriture au hasard) ;
 *  - `YUKI_OUTPUT` ne demande AUCUN champ (elle désigne le nœud de sortie) :
 *    n'importe quel nœud peut la porter, c'est la génération qui vérifiera
 *    qu'il produit bien une image.
 */
export function validateApiWorkflow(raw: unknown): WorkflowCheck {
  const emptyLabels: WorkflowLabels = {};
  const nodes = unwrapWorkflow(raw);
  if (!nodes) {
    return {
      ok: false,
      code: "invalid_workflow",
      message:
        "Un OBJET JSON est attendu : le workflow ComfyUI au format API " +
        "(une entrée par nœud).",
      labels: emptyLabels,
      found: [],
      missing: [...YUKI_NODE_LABELS],
      nodes: 0,
    };
  }

  // Format INTERFACE (celui de l'éditeur) : il contient `nodes` (tableau) et
  // `links`. On l'explique au lieu de le refuser sèchement.
  if (Array.isArray((nodes as NodeMap).nodes) || Array.isArray((nodes as NodeMap).links)) {
    return {
      ok: false,
      code: "unsupported_format",
      message:
        "Ce fichier est un workflow d'INTERFACE (« nodes »/« links »), pas un " +
        "workflow au FORMAT API. Dans ComfyUI, utilisez « Save (API Format) » " +
        "(ou l'export API) et importez ce fichier-là.",
      labels: emptyLabels,
      found: [],
      missing: [...YUKI_NODE_LABELS],
      nodes: 0,
    };
  }

  const ids = sortedNodeIds(nodes);
  if (ids.length === 0) {
    return {
      ok: false,
      code: "invalid_workflow",
      message: "Le workflow est VIDE : aucun nœud.",
      labels: emptyLabels,
      found: [],
      missing: [...YUKI_NODE_LABELS],
      nodes: 0,
    };
  }

  const labels: WorkflowLabels = {};
  const found: YukiNodeLabel[] = [];
  const missing: YukiNodeLabel[] = [];
  const problems: string[] = [];

  // 1) Forme de chaque nœud (refus net avant toute analyse d'étiquette).
  for (const id of ids) {
    const node = nodes[id];
    if (!isPlainObject(node)) {
      problems.push(`nœud ${id} : objet attendu.`);
      continue;
    }
    const classType = node.class_type;
    if (typeof classType !== "string" || classType.trim() === "") {
      problems.push(`nœud ${id} : « class_type » (texte) manquant.`);
      continue;
    }
    if (!isPlainObject(node.inputs)) {
      problems.push(`nœud ${id} (${classType}) : « inputs » (objet) manquant.`);
    }
  }
  if (problems.length > 0) {
    return {
      ok: false,
      code: "invalid_workflow",
      message:
        "Ce JSON n'est pas un workflow ComfyUI au format API : " +
        problems.slice(0, 3).join(" ") +
        (problems.length > 3 ? ` (${problems.length - 3} autre(s) problème(s).)` : ""),
      labels,
      found,
      missing: [...YUKI_NODE_LABELS],
      nodes: ids.length,
    };
  }

  // 2) Résolution des étiquettes PAR TITRE.
  for (const label of YUKI_NODE_LABELS) {
    const matching = ids.filter((id) => nodeTitle(nodes[id] as Record<string, unknown>) === label);
    if (matching.length === 0) {
      missing.push(label);
      continue;
    }
    if (matching.length > 1) {
      return {
        ok: false,
        code: "duplicate_label",
        message:
          `Le titre « ${label} » est porté par ${matching.length} nœuds ` +
          `(${matching.join(", ")}). Un titre d'étiquette doit désigner UN SEUL ` +
          "nœud : renommez les autres.",
        labels,
        found,
        missing,
        nodes: ids.length,
      };
    }
    const id = matching[0] as string;
    const node = nodes[id] as Record<string, unknown>;
    const classType = String(node.class_type);
    const inputs = node.inputs as Record<string, unknown>;
    const field = resolveField(label, inputs);
    if (field === null) {
      // `YUKI_OUTPUT` : le nœud est retenu, sans champ à écrire.
      labels[label] = { nodeId: id, classType };
      found.push(label);
      continue;
    }
    if (!field) {
      return {
        ok: false,
        code: "unsupported_label",
        message:
          `Le nœud « ${label} » (${classType}, id ${id}) n'a aucun champ ` +
          `inscriptible pour cette étiquette (${describeExpectedField(label)}). ` +
          "Placez l'étiquette sur le nœud qui PORTE la valeur.",
        labels,
        found,
        missing,
        nodes: ids.length,
      };
    }
    labels[label] = { nodeId: id, classType, field };
    found.push(label);
  }

  if (!labels[YUKI_REQUIRED_LABEL]) {
    return {
      ok: false,
      code: "missing_required_label",
      message:
        `L'étiquette OBLIGATOIRE « ${YUKI_REQUIRED_LABEL} » est absente : aucun ` +
        "nœud ne porte ce titre. Renommez le nœud qui reçoit le prompt positif " +
        `(son titre, dans ComfyUI, doit être exactement ${YUKI_REQUIRED_LABEL}).`,
      labels,
      found,
      missing,
      nodes: ids.length,
    };
  }

  return { ok: true, workflow: nodes, labels, found, missing, nodes: ids.length };
}

/** Ce que l'on attend d'un champ, en français (message d'import). */
function describeExpectedField(label: YukiNodeLabel): string {
  switch (label) {
    case "YUKI_PROMPT":
    case "YUKI_NEGATIVE":
      return "champ texte « text » (ou « prompt »)";
    case "YUKI_SEED":
      return "champ entier « seed » ou « noise_seed »";
    case "YUKI_WIDTH":
      return "champ entier « width »";
    case "YUKI_HEIGHT":
      return "champ entier « height »";
    case "YUKI_OUTPUT":
      // Jamais utilisée : `YUKI_OUTPUT` n'attend aucun champ (cf. `resolveField`).
      return "nœud produisant une image (aucun champ à écrire)";
  }
}

/** Valeurs injectées dans un graphe validé. */
export interface YukiInjectionValues {
  /** Scène (texte libre, AUCUN style). */
  prompt: string;
  /** Prompt négatif neutre (uniquement si le nœud `YUKI_NEGATIVE` existe). */
  negative?: string;
  seed?: number;
  width?: number;
  height?: number;
}

/** Une écriture effectivement réalisée (preuve pour les tests et les journaux). */
export interface YukiInjection {
  label: YukiNodeLabel;
  nodeId: string;
  field: string;
  /** Valeur écrite (jamais un secret : ici, uniquement scène/technique). */
  value: string | number;
}

/**
 * Clone le graphe et écrit les valeurs AUX CHAMPS résolus à l'import.
 *
 * ⚠️ `prompt` ne contient QUE la scène : le style n'est jamais passé ici (il ne
 * sert qu'à choisir le workflow). Lève une `Error` si les étiquettes ne
 * correspondent plus au graphe (cas impossible après `validateApiWorkflow`).
 */
export function applyYukiValues(
  workflow: Record<string, unknown>,
  labels: WorkflowLabels,
  values: YukiInjectionValues,
): { workflow: Record<string, unknown>; injected: YukiInjection[] } {
  const clone = JSON.parse(JSON.stringify(workflow)) as Record<string, unknown>;
  const injected: YukiInjection[] = [];

  const write = (label: YukiNodeLabel, value: string | number | undefined): void => {
    if (value === undefined) return;
    const ref = labels[label];
    if (!ref) return;
    const field = ref.field;
    if (field === undefined) {
      // Garde-fou : `YUKI_OUTPUT` désigne une SORTIE, jamais un champ à écrire.
      throw new Error(`L'étiquette « ${label} » ne désigne aucun champ à écrire.`);
    }
    const node = clone[ref.nodeId];
    if (!isPlainObject(node) || !isPlainObject(node.inputs)) {
      throw new Error(`Nœud « ${label} » introuvable dans le graphe (id ${ref.nodeId}).`);
    }
    (node.inputs as Record<string, unknown>)[field] = value;
    injected.push({ label, nodeId: ref.nodeId, field, value });
  };

  write("YUKI_PROMPT", values.prompt);
  write("YUKI_NEGATIVE", values.negative);
  write("YUKI_SEED", values.seed);
  write("YUKI_WIDTH", values.width);
  write("YUKI_HEIGHT", values.height);
  return { workflow: clone, injected };
}
