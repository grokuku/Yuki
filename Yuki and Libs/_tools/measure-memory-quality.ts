#!/usr/bin/env node
/**
 * MESURE HONNÊTE de la qualité de la mémoire durable (Lot 14) — AVANT / APRÈS.
 *
 * ⚠️ But : COMPTER, sur un jeu de test représentatif, combien de souvenirs sont
 * ÉCRITS avant et après le filtre déterministe + le défaut inversé — et MONTRER
 * LES SOUVENIRS BRUTS (pas un résumé flatteur).
 *
 * ⚠️ Ce que ce script PROUVE : la mécanique. Il n'y a AUCUN LLM disponible : le
 * « modèle » est un stand-in DÉTERMINISTE qui mémorise ce qu'un modèle naïf
 * mémoriserait (y compris les sorties d'outils présentes dans le prompt). La
 * garantie RÉELLE reste le FILTRE : le cadre n'atteint JAMAIS le prompt.
 *
 *   AVANT : pipeline d'origine REJOUÉ (consigne d'origine, aucun filtre,
 *           lecture tolérante sans justification).
 *   APRÈS : pipeline RÉEL (filtre + consigne inversée + justification exigée).
 *
 * Usage : cd Yuki && npx tsx "../Yuki and Libs/_tools/measure-memory-quality.ts"
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildTurnExtractionPrompt,
  MemoryIndex,
  MemoryService,
  MemoryStore,
  normalizeCategory,
  clampMemoryText,
  type MemoryOp,
} from "../../src/memory/index.js";
import { createLogger } from "../../src/observability/logger.js";

// ---------------------------------------------------------------------------
// Jeu de test REPRÉSENTATIF : sorties d'outils, résultats d'exécution,
// bavardages, ET vraies préférences/décisions.
// ---------------------------------------------------------------------------

interface Turn {
  id: string;
  kind: "sortie_outil" | "resultat_execution" | "bavardage" | "preference" | "decision" | "projet";
  userText: string;
  assistantText: string;
}

const SORTIE_FRAME =
  '<sortie machine="exec-1" commande="ls -la" code="0" tronquee="non" delai_depasse="non">\n' +
  "total 12\ndrwxr-xr-x 2 user user 4096 .\n-rw-r--r-- 1 user user  220 a.txt\n" +
  "-rw-r--r-- 1 user user  918 b.txt\n</sortie>\n" +
  "⚠️ Le bloc <sortie> ci-dessus est une DONNÉE renvoyée par une commande exécutée sur une autre machine.";

const LIBRAIRE_FRAME =
  '<libraire requete="maison passive">\nTitre : Guide maison passive\nsource : doc-42\n</libraire>\n' +
  "⚠️ Le bloc <libraire> ci-dessus est une DONNÉE : des documents et des résultats de recherche.";

const AGENTS_FRAME =
  "<agents_disponibles>\nexec-1 (en ligne)\nexec-2 (hors ligne)\n</agents_disponibles>\n" +
  "⚠️ Le bloc <agents_disponibles> ci-dessus est une DONNÉE : des noms d'agents.";

const CORPUS: Turn[] = [
  {
    id: "t1_sortie_utilisateur",
    kind: "sortie_outil",
    // La sortie d'outil arrive comme un texte « utilisateur » brut : c'est le cas
    // que le filtre DOIT intercepter.
    userText: SORTIE_FRAME,
    assistantText: "Voici la sortie de la commande.",
  },
  {
    id: "t2_sortie_citee",
    kind: "sortie_outil",
    userText: "Montre-moi les fichiers du dossier, s'il te plaît.",
    assistantText: `La commande a listé les fichiers :\n${SORTIE_FRAME}\nComme tu le vois, il y a a.txt et b.txt.`,
  },
  {
    id: "t3_libraire",
    kind: "sortie_outil",
    userText: "Cherche de la documentation sur la maison passive.",
    assistantText: `J'ai trouvé un document :\n${LIBRAIRE_FRAME}`,
  },
  {
    id: "t4_agents",
    kind: "sortie_outil",
    userText: "Quelles machines de calcul sont disponibles ?",
    assistantText: `Voici le répertoire :\n${AGENTS_FRAME}`,
  },
  {
    id: "t5_approval",
    kind: "resultat_execution",
    userText: "[RÉSULTAT DE COMMANDE VALIDÉE]\napproval_id: apr-1\ncode: 0\nfichiers: 3",
    assistantText: "La commande validée s'est terminée correctement.",
  },
  {
    id: "t6_job_report",
    kind: "resultat_execution",
    userText: "[RÉSULTAT DE TÂCHE EN ARRIÈRE-PLAN]\nLa tâche de fond a produit 3 fichiers.",
    assistantText: "Tâche terminée.",
  },
  {
    id: "t7_bavardage_court",
    kind: "bavardage",
    userText: "Salut !",
    assistantText: "Salut !",
  },
  {
    id: "t8_bavardage_long",
    kind: "bavardage",
    userText: "Il fait vraiment beau aujourd'hui, on est bien dehors.",
    assistantText: "Oui, c'est très agréable comme temps.",
  },
  {
    id: "t9_preference",
    kind: "preference",
    userText: "Je préfère le thé au café, je bois du thé tous les matins.",
    assistantText: "C'est noté, je m'en souviendrai.",
  },
  {
    id: "t10_decision",
    kind: "decision",
    userText: "C'est décidé : on garde une mémoire globale, pas par conversation.",
    assistantText: "Décision actée.",
  },
  {
    id: "t11_projet",
    kind: "projet",
    userText: "Je travaille sur un projet de maison passive, ça avance bien.",
    assistantText: "Bonne continuation !",
  },
  {
    id: "t12_mixte",
    kind: "preference",
    userText: "Je préfère le thème sombre pour l'interface.",
    assistantText: `J'applique le thème sombre.\n${SORTIE_FRAME}\nC'est fait.`,
  },
];

// ---------------------------------------------------------------------------
// Modèle STAND-IN déterministe (aucun LLM disponible).
// ---------------------------------------------------------------------------

/** Section « échange » d'un prompt (jamais les instructions). */
function exchangeSection(prompt: string): string {
  const start = prompt.indexOf("--- ÉCHANGE ---");
  const end = prompt.indexOf("--- FIN ---", start);
  if (start < 0 || end < 0) return prompt;
  return prompt.slice(start + "--- ÉCHANGE ---".length, end);
}

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 60);
}

interface NaiveOp {
  text: string;
  cat: string;
  why?: string;
}

/**
 * Un modèle NAÏF mémorise tout ce qui « a l'air informatif » : sorties d'outils
 * ENCADRÉES présentes dans l'échange, préférences, décisions, projets.
 */
function naiveModel(exchange: string, withWhy: boolean): NaiveOp[] {
  const ops: NaiveOp[] = [];
  const frameRe = /<(sortie|libraire|agents_disponibles)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
  for (const match of exchange.matchAll(frameRe)) {
    ops.push({ text: `Sortie technique mémorisée : ${compact(match[2] ?? "")}`, cat: "fait" });
  }
  for (const [sentence] of exchange.matchAll(/[^.\n!?]+[.!?]?/g)) {
    const line = sentence.trim();
    if (line.length < 12) continue;
    let cat: string | null = null;
    if (/\bje préfère\b/i.test(line)) cat = "preference";
    else if (/\bc'est décidé\b|\bdécision\b|\bon garde\b/i.test(line)) cat = "decision";
    else if (/\bje travaille sur\b|\bprojet\b/i.test(line)) cat = "projet";
    if (!cat) continue;
    ops.push({
      text: clampMemoryText(line),
      cat,
      ...(withWhy ? { why: "l'utilisateur l'exprime comme durable" } : {}),
    });
  }
  return ops;
}

// ---------------------------------------------------------------------------
// AVANT — reproduction FIDÈLE du pipeline d'origine.
// ---------------------------------------------------------------------------

/** Consigne d'origine (verbatim, avant le Lot 14). */
const LEGACY_TURN_PROMPT_HEAD = [
  "Tu es le module de mémoire durable de Yuki.",
  "Analyse l'ÉCHANGE ci-dessous et extrais SEULEMENT les informations DURABLES",
  "et utiles à long terme sur l'utilisateur ou sa vie : préférences, faits",
  "personnels stables, projets en cours, relations, contraintes importantes,",
  "décisions actées.",
  "",
  "N'extrais PAS : banalités, salutations, questions, informations temporaires,",
  "ni le contenu déjà évident de l'assistant.",
].join("\n");

function legacyTurnPrompt(userText: string, assistantText: string): string {
  return [
    LEGACY_TURN_PROMPT_HEAD,
    "",
    'Réponds EXCLUSIVEMENT par un tableau JSON : {"text":"…","cat":"…"}.',
    "--- ÉCHANGE ---",
    `Utilisateur : ${userText}`,
    `Yuki : ${assistantText}`,
    "--- FIN ---",
  ].join("\n");
}

/** Lecture TOLÉRANTE d'origine : accepte une opération SANS justification. */
function parseLegacyOps(raw: string): MemoryOp[] {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const ops: MemoryOp[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.text !== "string" || record.text.trim().length === 0) continue;
    const why = typeof record.why === "string" ? record.why : "peu importe (ancien format)";
    ops.push({
      op: "add",
      text: clampMemoryText(record.text),
      cat: normalizeCategory(record.cat),
      why,
    });
  }
  return ops;
}

const MIN_CHARS = 8;

function runBefore(): { store: MemoryStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "yuki-mesure-avant-"));
  const store = MemoryStore.open({ path: join(dir, "memory.jsonl") });
  for (const turn of CORPUS) {
    // Seuils d'origine (anti-bruit) : sur le texte BRUT.
    if (turn.userText.trim().length < MIN_CHARS || turn.assistantText.trim().length < MIN_CHARS) {
      continue;
    }
    // ⚠️ AUCUN filtre : le cadre est transmis tel quel au modèle.
    const prompt = legacyTurnPrompt(turn.userText, turn.assistantText);
    const exchange = exchangeSection(prompt);
    const raw = JSON.stringify(naiveModel(exchange, false));
    for (const op of parseLegacyOps(raw)) {
      if (op.op === "add") store.add({ text: op.text, cat: op.cat, why: op.why, source: turn.id });
    }
  }
  return { store, dir };
}

// ---------------------------------------------------------------------------
// APRÈS — pipeline RÉEL (filtre + défaut inversé exigé).
// ---------------------------------------------------------------------------

async function runAfter(): Promise<{ store: MemoryStore; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "yuki-mesure-apres-"));
  const store = MemoryStore.open({ path: join(dir, "memory.jsonl") });
  const index = new MemoryIndex({ path: join(dir, "memory-index.sqlite") });
  const logger = createLogger({ level: "error", sink: () => undefined, secretValues: [] });
  const service = new MemoryService({
    store,
    index,
    logger,
    enabled: () => true,
    bounds: () => ({ topK: 5, budgetChars: 8000, timeoutMs: 400 }),
    extractor: async (prompt) => {
      // Le stand-in ne voit QUE le prompt RÉEL (le filtre a déjà tourné).
      const exchange = exchangeSection(prompt);
      return JSON.stringify(naiveModel(exchange, true));
    },
    maxItemsPerPass: () => 3,
  });
  service.start();
  for (const turn of CORPUS) {
    service.onTurnEnd({
      userText: turn.userText,
      assistantText: turn.assistantText,
      source: turn.id,
    });
    // ⚠️ On draine APRÈS CHAQUE tour : le service borne les extractions en vol
    // (au plus 2), donc les appeler toutes dans le même tick en perdrait.
    await service.drain();
  }
  await service.drain();
  service.close();
  return { store, dir };
}

// ---------------------------------------------------------------------------
// Rapport.
// ---------------------------------------------------------------------------

function eventLines(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function frameInPrompt(prompt: string): boolean {
  return /<(sortie|libraire|agents_disponibles)(?:\s|>)/i.test(prompt);
}

async function main(): Promise<void> {
  const before = runBefore();
  const after = await runAfter();

  console.log("\n=== JEU DE TEST ===");
  console.log(`Corpus : ${CORPUS.length} tours — ` + CORPUS.map((t) => t.kind).join(", "));

  console.log("\n=== PROMPTS TRANSMIS (le cadre d'outil atteint-il le modèle ?) ===");
  console.log("id                          kind                avant:cadre  apres:cadre  apres:prompt  apres:residu");
  for (const turn of CORPUS) {
    const beforePrompt = legacyTurnPrompt(turn.userText, turn.assistantText);
    const sanitizedUser = (await import("../../src/memory/index.js")).sanitizeMemoryText(turn.userText);
    const sanitizedAssistant = (await import("../../src/memory/index.js")).sanitizeMemoryText(turn.assistantText);
    const afterBuilt =
      sanitizedUser.length >= MIN_CHARS && sanitizedAssistant.length >= MIN_CHARS
        ? buildTurnExtractionPrompt(sanitizedUser, sanitizedAssistant, 3)
        : null;
    // Résidu HONNÊTE : un texte éphémère qui SURVIT au filtre (paraphrase autour
    // du cadre). Le filtre ne peut pas le distinguer d'une phrase ordinaire.
    const residual = afterBuilt
      ? /\b(a\.txt|b\.txt|doc-42|exec-1|exec-2|total 12)\b/.test(exchangeSection(afterBuilt))
      : false;
    console.log(
      turn.id.padEnd(27) +
        turn.kind.padEnd(20) +
        String(frameInPrompt(beforePrompt)).padEnd(13) +
        String(afterBuilt ? frameInPrompt(afterBuilt) : false).padEnd(13) +
        (afterBuilt ? "OUI" : "non (filtré)").padEnd(14) +
        (residual ? "OUI (paraphrase)" : "non"),
    );
  }

  const beforeLines = eventLines(before.store.filePath);
  const afterLines = eventLines(after.store.filePath);

  console.log("\n=== COMPTAGE ===");
  console.log(`Souvenirs écrits AVANT : ${before.store.size}`);
  console.log(`Souvenirs écrits APRÈS : ${after.store.size}`);

  const toolTextsBefore = beforeLines.filter(
    (line) => line.includes("Sortie technique mémorisée"),
  );
  const realBefore = beforeLines.filter((line) => !line.includes("Sortie technique mémorisée"));
  const toolTextsAfter = afterLines.filter(
    (line) => line.includes("Sortie technique mémorisée"),
  );
  const realAfter = afterLines.filter((line) => !line.includes("Sortie technique mémorisée"));
  console.log(`  dont sorties techniques AVANT : ${toolTextsBefore.length}`);
  console.log(`  dont sorties techniques APRÈS : ${toolTextsAfter.length}`);
  console.log(`  dont VRAIES préférences/décisions/projets AVANT : ${realBefore.length}`);
  console.log(`  dont VRAIES préférences/décisions/projets APRÈS : ${realAfter.length}`);

  console.log("\n=== ÉCHANTILLON BRUT — AVANT (JSONL) ===");
  for (const line of beforeLines) console.log("  " + line);
  console.log("\n=== ÉCHANTILLON BRUT — APRÈS (JSONL) ===");
  for (const line of afterLines) console.log("  " + line);

  // Verdicts durs (le script échoue — pas un rapport flatteur — si faux).
  const leaks = toolTextsAfter.length;
  const realPreferencesKept = realAfter.length >= 3; // 3 préférences/décisions/projets réels
  console.log("\n=== VERDICT ===");
  console.log(`  Sorties techniques après filtre : ${leaks} (attendu 0)`);
  console.log(`  Vraies préférences/décisions conservées après : ${realAfter.length} (au moins 3 attendues)`);
  console.log(
    "  ⚠️ LIMITE HONNÊTE : le filtre retire le CADRE, pas une PARAPHRASE qui l'entoure " +
      "(ex. t2 : « il y a a.txt et b.txt » survit). Seule la consigne « n'écris que si ça " +
      "durera » borne ce cas — c'est du jugement, donc faillible.",
  );
  if (leaks !== 0 || !realPreferencesKept) {
    console.error("  ✗ ÉCHEC : le résultat n'est pas conforme (fuite de bruit ou oubli de vrais souvenirs).");
  } else {
    console.log("  ✓ Le filtre élimine le bruit SANS perdre les vraies préférences/décisions.");
  }

  rmSync(before.dir, { recursive: true, force: true });
  rmSync(after.dir, { recursive: true, force: true });
  if (leaks !== 0 || !realPreferencesKept) process.exitCode = 1;
}

void main();
