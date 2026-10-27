/**
 * Choix du WORKFLOW par PROXIMITÉ (libellé + description courte).
 *
 * ⚠️ Le style ne part JAMAIS dans le prompt : il ne sert QU'À choisir le
 * workflow. Si l'utilisateur n'a rien précisé, on choisit d'après la SCÈNE (en
 * lisant les descriptions). Si rien ne correspond, on retombe sur le workflow
 * PAR DÉFAUT ; s'il n'y en a aucun, on REFUSE honnêtement (jamais un choix au
 * hasard).
 *
 * Module PUR : aucune I/O, aucun import SDK. Le score est déterministe (égalité
 * ⇒ ordre alphabétique du nom d'usage), donc testable.
 */

/** Candidat tel que le store le résume. */
export interface WorkflowCandidate {
  /** Nom d'usage (`manga`, `realiste`, `infographie`…). */
  name: string;
  /** Description courte, écrite par l'utilisateur (sert au choix). */
  description: string;
  /** Vrai si ce workflow est marqué « par défaut ». */
  isDefault: boolean;
}

export type WorkflowChoiceReason =
  /** Une intention (style ou scène) a désigné le plus proche. */
  | "proximity"
  /** Rien ne correspondait : repli sur le workflow par défaut. */
  | "default"
  /** Un seul workflow importé : il est utilisé. */
  | "only";

export interface WorkflowChoice {
  name: string;
  reason: WorkflowChoiceReason;
  /** Score de proximité (0 pour un repli). */
  score: number;
}

/** Mots trop génériques pour départager deux descriptions. */
const STOPWORDS: ReadonlySet<string> = new Set([
  "les",
  "une",
  "des",
  "aux",
  "and",
  "the",
  "with",
  "pour",
  "avec",
  "dans",
  "sur",
  "sous",
  "est",
  "sont",
  "que",
  "qui",
  "quoi",
  "tres",
  "plus",
  "bien",
  "peu",
  "peut",
  "faire",
  "comme",
  "genre",
  "style",
  "truc",
  "chose",
  "sorte",
  "type",
  "image",
  "images",
  "rendu",
  "rendus",
  "cette",
  "cela",
  "fait",
  "tout",
  "toute",
  "aussi",
]);

/**
 * Petits équivalents d'usage courant (français → mots des descriptions).
 * ⚠️ Table COURTE et assumée : elle sert à comprendre « un truc style dessin
 * animé japonais » sans exiger le libellé exact. Poids VOLONTAIREMENT faible :
 * une correspondance littérale l'emporte toujours.
 */
const SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  japonais: ["anime", "manga"],
  japonaise: ["anime", "manga"],
  japan: ["anime"],
  anime: ["manga"],
  manga: ["anime"],
  bd: ["manga"],
  dessin: ["anime", "manga", "illustration"],
  croquis: ["anime", "manga"],
  photo: ["realiste", "photographie"],
  photographie: ["realiste", "photo"],
  photographique: ["realiste"],
  reel: ["realiste"],
  realiste: ["photo"],
  vectoriel: ["infographie", "aplats"],
  logo: ["infographie"],
  affiche: ["infographie"],
  diagramme: ["infographie"],
};

/** Minuscules sans accents (comparaison stable quelle que soit la saisie). */
export function foldText(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** Découpe en mots utiles (lettres/chiffres, longueur ≥ 3, hors mots vides). */
export function tokenize(input: string): string[] {
  const tokens = foldText(input)
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
  return [...new Set(tokens)];
}

/** Score de proximité d'UNE description pour une requête (0 = aucun rapport). */
function scoreCandidate(tokens: readonly string[], candidate: WorkflowCandidate): number {
  const haystackTokens = new Set(
    tokenize(`${candidate.name} ${candidate.description}`),
  );
  const haystack = foldText(`${candidate.name} ${candidate.description}`);
  let score = 0;
  for (const token of tokens) {
    if (haystackTokens.has(token)) {
      score += 4;
      continue;
    }
    let matched = false;
    for (const word of haystackTokens) {
      if (token.length >= 4 && (word.startsWith(token) || token.startsWith(word))) {
        score += 2;
        matched = true;
        break;
      }
      if (token.length >= 5 && (word.includes(token) || haystack.includes(token))) {
        score += 1;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    for (const synonym of SYNONYMS[token] ?? []) {
      if (haystackTokens.has(synonym)) {
        score += 1;
        break;
      }
    }
  }
  return score;
}

/**
 * Choisit le workflow le plus proche de `intent` (style fourni, sinon scène).
 *
 * @returns le choix, ou `null` si aucun workflow n'est importé, ou si rien ne
 * correspond ET qu'aucun workflow par défaut n'existe.
 */
export function chooseWorkflow(
  candidates: readonly WorkflowCandidate[],
  intent: string | undefined,
): WorkflowChoice | null {
  const available = [...candidates].sort((a, b) => a.name.localeCompare(b.name));
  if (available.length === 0) return null;

  const tokens = tokenize(intent ?? "");
  let best: { candidate: WorkflowCandidate; score: number } | null = null;
  for (const candidate of available) {
    const score = scoreCandidate(tokens, candidate);
    if (score > 0 && (best === null || score > best.score)) best = { candidate, score };
  }
  if (best) {
    return { name: best.candidate.name, reason: "proximity", score: best.score };
  }

  const fallback = available.find((candidate) => candidate.isDefault);
  if (fallback) return { name: fallback.name, reason: "default", score: 0 };
  if (available.length === 1) {
    return { name: available[0]!.name, reason: "only", score: 0 };
  }
  return null;
}
