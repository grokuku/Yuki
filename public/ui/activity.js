// Activité de fond et état d'attente — logique PURE de l'interface.
//
// Aucun DOM, aucun réseau : ce module ne produit que des LIBELLÉS et des
// décisions d'affichage, testables hors navigateur (`tests/ui/activity.test.ts`).
// Le rendu (DOM) vit dans `app.js` ; l'interaction réelle est prouvée par
// `_tools/e2e-activity.mjs` (Chromium headless + CDP).
//
// ⚠️ Ces libellés sont des états d'INTERFACE : ils ne sont JAMAIS envoyés au
// moteur TTS, qui ne synthétise que les `delta` de canal `content` (voir
// `src/gateway/ws/server.ts` : `routeTtsEvent`). Ils ne sont donc jamais
// prononcés.

/** Libellé de l'indicateur d'attente affiché DÈS `run_started` (avant tout token). */
export const THINKING_LABEL = "Yuki réfléchit…";

/**
 * Titre du bloc de RÉFLEXION (canal `thinking`) inséré DANS le fil.
 * ⚠️ Libellé d'INTERFACE : jamais envoyé au moteur TTS.
 */
export const THINKING_BLOCK_LABEL = "Réflexion du modèle";

/**
 * Libellé accessible du bouton repli/dépli du bloc de réflexion.
 * @param {number} chars nombre de caractères de réflexion connus
 * @param {boolean} expanded état courant
 * @returns {string}
 */
export function thinkingToggleLabel(chars, expanded) {
  const n =
    typeof chars === "number" && Number.isFinite(chars) && chars > 0 ? Math.floor(chars) : 0;
  const unit = n === 1 ? "1 caractère" : `${n} caractères`;
  return `${THINKING_BLOCK_LABEL} — ${unit} — ${expanded ? "replier" : "déplier"}`;
}

/** Durée pendant laquelle un statut TERMINAL reste affiché avant effacement. */
export const JOB_FINISHED_HOLD_MS = 12_000;

/** Cadence de rafraîchissement du compteur de durée d'une tâche EN COURS. */
export const JOB_TICK_MS = 1_000;

/**
 * Statut d'un job de fond → libellé français + tonalité d'affichage.
 * ⚠️ Un statut INCONNU reste neutre : il n'est JAMAIS présenté comme un succès.
 * @param {string} status
 * @returns {{ key: string, label: string, tone: string }}
 */
export function jobStatusView(status) {
  switch (status) {
    case "running":
      return { key: "running", label: "en cours", tone: "active" };
    case "completed":
      return { key: "completed", label: "terminée (succès)", tone: "ok" };
    case "failed":
      return { key: "failed", label: "échouée", tone: "error" };
    case "cancelled":
      return { key: "cancelled", label: "annulée", tone: "muted" };
    case "interrupted":
      return { key: "interrupted", label: "interrompue", tone: "muted" };
    default:
      return { key: "unknown", label: "terminée", tone: "muted" };
  }
}

/** Durée lisible en français (jamais « NaN » ni valeur négative).
 * @param {number|undefined} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1).replace(".", ",")} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return `${minutes} min ${rest} s`;
}

/**
 * Décrit l'activité de fond à afficher. `jobs` = liste d'entrées
 * `{ task?, status, startedAt, durationMs? }` (la PLUS RÉCENTE en dernier),
 * `now` = instant courant (ms).
 *
 * ⚠️ Le TEXTE DE LA TÂCHE (`task`) n'apparaît JAMAIS ici : c'est le prompt
 * rédigé par Yuki pour le sous-agent (souvent long et multi-lignes). Il n'a sa
 * place que DANS le bloc repliable d'activité du sous-agent (`.subagent-activity`,
 * déplié à la demande) — l'afficher dans cet indicateur global le faisait
 * déborder à l'écran et apparaître EN DOUBLE quand le bloc était déplié.
 *
 * Renvoie `null` quand RIEN ne doit être affiché, sinon `{ text, timer, tone }` :
 *  - `text`  : libellé ACCESSIBLE (n'évolue qu'aux TRANSITIONS — pas de spam
 *              d'annonces pour un lecteur d'écran) ;
 *  - `timer` : compteur de durée d'une tâche EN COURS, rendu `aria-hidden`
 *              (il change chaque seconde, il ne doit pas être annoncé) ;
 *  - `tone`  : tonalité d'affichage (`active`/`ok`/`error`/`muted`).
 * @param {Array<{ task?: string, status: string, startedAt: number, durationMs?: number }>|null|undefined} jobs
 * @param {number} now
 * @returns {{ text: string, timer: string, tone: string } | null}
 */
export function describeActivity(jobs, now) {
  if (!Array.isArray(jobs) || jobs.length === 0) return null;
  const running = jobs.filter((job) => job.status === "running");
  if (running.length > 0) {
    const oldest = Math.min(...running.map((job) => job.startedAt));
    const elapsed = formatDuration(Math.max(0, now - oldest));
    const timer = elapsed ? ` (${elapsed})` : "";
    if (running.length === 1) {
      return { tone: "active", text: "Tâche de fond en cours…", timer };
    }
    return {
      tone: "active",
      text: `${running.length} tâches de fond en cours…`,
      timer,
    };
  }
  const last = jobs[jobs.length - 1];
  const view = jobStatusView(last.status);
  const duration =
    typeof last.durationMs === "number" ? ` — ${formatDuration(last.durationMs)}` : "";
  return {
    tone: view.tone,
    text: `Tâche de fond ${view.label}${duration}`,
    timer: "",
  };
}

/* ─── E3 — bloc d'ACTIVITÉ d'un sous-agent (DANS le fil) ─────────────────
 * Libellés PURS du bloc repliable : logique testable hors navigateur. Le rendu
 * (DOM) vit dans `subagent-activity.js`.
 *
 * ⚠️ Ces libellés ne sont JAMAIS prononcés : le bloc est alimenté par des
 * trames de CONTRÔLE `job_activity`, que le serveur n'achemine JAMAIS vers le
 * moteur TTS (`routeTtsEvent`).
 */

/** Titre du bloc d'activité d'un sous-agent. */
export const SUBAGENT_ACTIVITY_LABEL = "Activité du sous-agent";

/**
 * Libellé accessible du bouton repli/dépli (posé sur `aria-label`).
 * @param {number} count nombre d'étapes connues
 * @param {boolean} expanded état courant
 * @returns {string}
 */
export function subagentToggleLabel(count, expanded) {
  const n = typeof count === "number" && Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  const steps = n === 1 ? "1 étape" : `${n} étapes`;
  return `${SUBAGENT_ACTIVITY_LABEL} — ${steps} — ${expanded ? "replier" : "déplier"}`;
}

/**
 * Traduit une étape d'activité de sous-agent (trame `job_activity`) en ligne
 * lisible. `status` n'est interprété qu'à l'étape terminale ; un statut inconnu
 * reste NEUTRE (jamais présenté comme un succès).
 * @param {string} stage
 * @param {{ task?: string, detail?: string, status?: string }} [payload]
 * @returns {{ key: string, label: string, tone: string }}
 */
export function subagentStepView(stage, payload = {}) {
  switch (stage) {
    case "job_started":
      return {
        key: "started",
        label: payload.task ? `Tâche lancée : « ${payload.task} »` : "Tâche lancée",
        tone: "active",
      };
    case "job_first_token":
      return { key: "first_token", label: "Première réponse reçue", tone: "active" };
    case "job_progress": {
      const detail = typeof payload.detail === "string" ? payload.detail.trim() : "";
      return {
        key: "progress",
        label: detail ? `Progression : ${detail}` : "Progression",
        tone: "active",
      };
    }
    case "steer": {
      const detail = typeof payload.detail === "string" ? payload.detail.trim() : "";
      return {
        key: "steer",
        label: detail
          ? `Consigne de l'orchestrateur envoyée : ${detail}`
          : "Consigne de l'orchestrateur envoyée",
        tone: "active",
      };
    }
    case "job_finished": {
      const view = jobStatusView(payload.status);
      return { key: "finished", label: `Terminée — ${view.label}`, tone: view.tone };
    }
    default:
      return { key: "unknown", label: "Activité", tone: "muted" };
  }
}
