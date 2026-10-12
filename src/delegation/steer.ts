/**
 * STEER — consigne de l'ORCHESTRATEUR (Yuki léger) vers un SOUS-AGENT (job lourd).
 *
 * ⚠️ NE PAS CONFONDRE avec le steer UTILISATEUR (`src/pi/sdk-host.ts`) : un
 * message de l'utilisateur pendant un run est un VRAI message (affiché,
 * transcripté, mémorisable). Ici, il s'agit d'une consigne INTERNE de
 * l'orchestrateur vers son sous-agent : elle est ÉPHÉMÈRE côté conversation de
 * l'orchestrateur (jamais un message utilisateur, jamais prononcée).
 *
 * ⚠️ PIÈGE N°1 — LA CONSIGNE PERDUE EN SILENCE : tant que le job n'a pas
 * réellement démarré (en file, ou session en cours de création), un `steer` du
 * SDK serait différé. Les consignes arrivées dans cette fenêtre sont donc
 * TAMPONNÉES puis INTÉGRÉES au PREMIER message du sous-agent (aucune perte,
 * jamais d'ignoré silencieux). Le tampon est BORNÉ : au-delà, on REFUSE
 * HONNÊTEMENT (`buffer_full`) plutôt que de grossir sans limite.
 */

/**
 * Nombre maximal de consignes tamponnées par job. Repris de Pi-Web
 * (`MAX_PENDING_STEERS = 10`). Justification : le tampon ne vit que pendant la
 * fenêtre « en file → premier prompt » ; 10 consignes représentent déjà une
 * rafale d'orchestration inhabituelle. Au-delà, on refuse honnêtement au lieu de
 * jeter en silence (contrairement à Pi-Web) ou de laisser croître le contexte du
 * premier message.
 */
export const MAX_PENDING_STEERS = 10;

/**
 * Cadrage explicite de la consigne : le sous-agent doit comprendre qu'elle vient
 * de l'ORCHESTRATEUR et non de l'utilisateur.
 */
export const ORCHESTRATOR_STEER_HEADER =
  "Consignes du coordinateur (orchestrateur) — à intégrer à cette tâche. " +
  "Ce ne sont PAS des messages de l'utilisateur.";

/**
 * Bloc lisible regroupant des consignes de l'orchestrateur (une puce par
 * consigne). Chaîne vide s'il n'y a rien à dire.
 */
export function orchestratorSteerBlock(steers: readonly string[]): string {
  if (steers.length === 0) return "";
  const lines = steers.map((steer) => `- ${steer}`);
  return `${ORCHESTRATOR_STEER_HEADER}\n${lines.join("\n")}`;
}

/**
 * Compose le PREMIER message du sous-agent : les consignes tamponnées sont
 * placées AVANT la tâche initiale, sous un cadrage explicite. Sans consigne, la
 * tâche est renvoyée telle quelle (comportement inchangé).
 */
export function composeFirstPrompt(
  task: string,
  steers: readonly string[],
): string {
  if (steers.length === 0) return task;
  return `${orchestratorSteerBlock(steers)}\n\nTâche initiale :\n${task}`;
}
