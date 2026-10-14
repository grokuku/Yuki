// Yuki — indicateur « message non lu » de la barre latérale.
//
// Logique PURE et testable (aucun accès DOM ni `window`) : elle décide CE QUI
// compte comme « un message » et compose les libellés accessibles. Le rendu
// visuel vit dans `sessions-panel.js` (pastille compteur) et `styles.css`.
//
// Ce que compte « un message » : la FIN D'UN TOUR ASSISTANT (`run_finished`) —
// jamais chaque delta de texte (sinon l'indicateur s'allumerait en permanence
// pendant le streaming), jamais un simple `run_started` (rien n'a encore été
// produit), jamais un événement de tâche de fond (`job_*` : activité, pas
// message). C'est le complément naturel des notifications push, qui alertent
// elles aussi à la fin d'un tour (`run_finished`/`job_report`) : la notification
// dit QUAND, l'indicateur dit OÙ REVENIR.
//
// Le REJEU est le piège n°1 : une trame rejouée (`resume`, reconnexion) porte
// un `seq` DÉJÀ vu pour ce fil ⇒ elle ne doit JAMAIS incrémenter le compteur.
// `shouldMarkUnread` s'en assure en comparant au `lastSeq` du store du fil.

/** Clé `localStorage` de l'état « non lu » (objet `{ <sessionId>: <compteur> }`). */
export const UNREAD_STORAGE_KEY = "yuki-unread";

/** Au-delà, la pastille affiche « 9+ » (le rail de 56 px est étroit). */
export const MAX_BADGE_COUNT = 9;

/** Raisons de fin de run qui livrent un VRAI message à l'utilisateur. */
const UNREAD_REASONS = new Set(["done", "error"]);

/** Compteur exploitable (entier positif), sinon 0. */
export function normalizeCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * `true` si `frame` est la fin d'un tour assistant livrant un message
 * (réponse terminée, ou erreur du modèle — dans les deux cas quelque chose
 * est arrivé). Un `abort`/`superseded` (interruption, remplacement) n'est PAS
 * un message : l'utilisateur est à l'origine de l'arrêt.
 */
export function isUnreadTurn(frame) {
  if (!frame || typeof frame !== "object") return false;
  if (frame.type !== "run_finished") return false;
  return UNREAD_REASONS.has(frame.reason);
}

/**
 * Décide si `frame` doit incrémenter le compteur de non-lus du fil.
 *
 * `store` porte `lastSeq` = plus haut `seq` DÉJÀ appliqué pour ce fil. Une trame
 * dont le `seq` n'avance pas (`seq <= lastSeq`) est un rejeu/duplicata : elle ne
 * compte pas. C'est la garde anti-rejeu (piège n°1).
 */
export function shouldMarkUnread(store, frame) {
  if (!isUnreadTurn(frame)) return false;
  const seq = typeof frame.seq === "number" ? frame.seq : 0;
  const last = store && typeof store.lastSeq === "number" ? store.lastSeq : 0;
  if (seq > 0 && seq <= last) return false;
  return true;
}

/** Texte de la pastille : compteur borné (« 9+ »), chaîne vide si aucun non-lu. */
export function formatUnreadBadge(count) {
  const n = normalizeCount(count);
  if (n <= 0) return "";
  return n > MAX_BADGE_COUNT ? `${MAX_BADGE_COUNT}+` : String(n);
}

/** Libellé accessible d'un nombre de non-lus (français, pluriel correct). */
export function unreadLabel(count) {
  const n = normalizeCount(count);
  if (n <= 0) return "";
  return `${n} message${n > 1 ? "s" : ""} non lu${n > 1 ? "s" : ""}`;
}

/**
 * Libellé accessible/tooltip d'une conversation : titre, puis « en cours »
 * (run d'arrière-plan), puis « N messages non lus ». Les deux états peuvent
 * coexister — ils sont DITS tous les deux, jamais confondus.
 */
export function composeConversationLabel(title, { busy = false, unread = 0 } = {}) {
  const parts = [];
  const clean = String(title ?? "").trim();
  if (clean) parts.push(clean);
  if (busy) parts.push("en cours");
  const label = unreadLabel(unread);
  if (label) parts.push(label);
  return parts.join(" — ");
}

/** Ajoute `by` non-lus à `id` (retourne un nouvel objet, l'entrée restant pure). */
export function addUnread(counts, id, by = 1) {
  const base = counts && typeof counts === "object" ? counts : {};
  if (typeof id !== "string" || id.length === 0) return base;
  const amount = normalizeCount(by) || 1;
  return { ...base, [id]: normalizeCount(base[id]) + amount };
}

/** Retire l'état non-lu de `id` (retourne le MÊME objet si rien à retirer). */
export function clearUnread(counts, id) {
  const base = counts && typeof counts === "object" ? counts : {};
  if (typeof id !== "string" || !(id in base)) return base;
  const next = { ...base };
  delete next[id];
  return next;
}

/** Ne conserve que les conversations encore LISTÉES (retourne le MÊME objet si rien à purger). */
export function pruneUnread(counts, keepIds) {
  const base = counts && typeof counts === "object" ? counts : {};
  const keep = new Set(Array.isArray(keepIds) ? keepIds : []);
  const next = {};
  let changed = false;
  for (const [id, value] of Object.entries(base)) {
    if (keep.has(id)) next[id] = value;
    else changed = true;
  }
  return changed ? next : base;
}

/** Désérialise l'état persité, en IGNORANT tout ce qui n'est pas exploitable. */
export function parseUnread(raw) {
  const out = {};
  if (typeof raw !== "string" || raw.length === 0) return out;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  for (const [id, value] of Object.entries(parsed)) {
    if (typeof id !== "string" || id.length === 0) continue;
    const n = normalizeCount(value);
    if (n > 0) out[id] = n;
  }
  return out;
}

/** Sérialise l'état pour `localStorage` (seules les entrées positives sont gardées). */
export function serializeUnread(counts) {
  const out = {};
  if (counts && typeof counts === "object") {
    for (const [id, value] of Object.entries(counts)) {
      const n = normalizeCount(value);
      if (typeof id === "string" && id.length > 0 && n > 0) out[id] = n;
    }
  }
  return JSON.stringify(out);
}
