/**
 * DÉCISION « faut-il notifier ? » — FONCTION PURE, sans horloge ni I/O.
 *
 * C'est le CŒUR de la qualité : une notification pendant que l'utilisateur lit
 * est une nuisance. On ne notifie donc que ce qu'il ne peut PAS voir.
 *
 * ⚠️ « client connecté » ≠ « client qui regarde ». Un onglet laissé ouvert en
 * arrière-plan garde une connexion WebSocket : il est CONNECTÉ mais son
 * propriétaire ne voit rien. Le seul signal fiable est la PRÉSENCE déclarée par
 * le client (`visible` = onglet affiché, `focused` = fenêtre au premier plan).
 * On exige les DEUX : un onglet affiché mais recouvert par une autre
 * application (fenêtre non focalisée) n'est PAS « regardé ».
 *
 * Règle retenue (justifiée dans `docs`/le rapport) :
 *  - `approval` — la fenêtre de validation est GLOBALE (elle s'affiche par-dessus
 *    l'interface, quelle que soit la conversation). Dès qu'un client est
 *    visible ET focalisé, l'utilisateur la voit déjà ⇒ on SUPPRIME la
 *    notification, sinon double signalement.
 *  - `job_report` / `run_finished` — le résultat n'apparaît QUE dans sa
 *    conversation. On supprime si un client ACTIF regarde CETTE conversation
 *    (il voit le résultat arriver) ; sinon on notifie, même si l'utilisateur
 *    regarde une AUTRE conversation (c'est exactement le déclencheur
 *    « réponse prête sur une conversation non focalisée »).
 */

import type { NotifyEvent, PresenceView } from "./types.js";

/** Un client « regarde » la conversation `sessionId` s'il est actif sur elle. */
export function isWatching(viewer: PresenceView, sessionId: string | null | undefined): boolean {
  return (
    viewer.visible === true &&
    viewer.focused === true &&
    typeof sessionId === "string" &&
    sessionId.length > 0 &&
    viewer.sessionId === sessionId
  );
}

/**
 * Décide s'il faut émettre une notification pour `event` compte tenu des
 * clients connectés. PURE : même entrée ⇒ même sortie, aucun effet de bord.
 */
export function shouldNotify(event: NotifyEvent, viewers: readonly PresenceView[]): boolean {
  const active = viewers.filter((v) => v.visible === true && v.focused === true);

  if (event.kind === "approval") {
    // La fenêtre de validation est globale : un client actif la voit à l'écran.
    return active.length === 0;
  }

  // Aucune conversation concernée : on ne peut pas savoir ce que l'utilisateur
  // voit ⇒ on notifie (le doute profite à l'information, jamais au spam
  // silencieux : ces événements sont rares et attendus).
  if (typeof event.sessionId !== "string" || event.sessionId.length === 0) {
    return true;
  }

  return !active.some((viewer) => viewer.sessionId === event.sessionId);
}
