/**
 * Route d'administration — redémarrage du gateway (Lot 11+).
 *
 * `POST /api/admin/restart` : mêmes garde-fous que les écritures de
 * configuration (en-tête `X-Yuki-Config` + contrôle `Origin`/`Host`). Elle
 * **journalise**, **répond `200`**, puis **planifie l'arrêt gracieux** (fermeture
 * des sockets WebSocket puis `server.close()`), via le même chemin que
 * `SIGTERM`. À la différence des autres motifs d'arrêt, ce chemin se termine
 * par le **code de sortie `75`** (`EX_TEMPFAIL`) : le **superviseur interne à
 * l'image** (`infra/gateway/supervisor.mjs`) relance alors le programme
 * **dans le conteneur**, sans redémarrer le conteneur et sans accès au socket
 * Docker. Les autres sorties (erreur fatale, refus de démarrage, `SIGTERM`)
 * gardent leur code — c'est ce qui distingue un redémarrage demandé d'un échec.
 *
 * La fonction d'arrêt ET le planificateur sont injectables afin que les tests
 * vérifient « répond 200 ET demande l'arrêt » sans tuer le processus de test.
 */

import type { IncomingHttpHeaders } from "node:http";

import type { Logger } from "../../observability/logger.js";
import { requireWriteGuards, type ConfigHttpResponse } from "./config.js";

export const ADMIN_RESTART_PATH = "/api/admin/restart";
/**
 * Délai avant l'arrêt : laisse la réponse HTTP partir et la connexion se
 * fermer. L'arrêt gracieux sort ensuite en 75 et le superviseur interne relance
 * le programme dans le conteneur.
 */
export const RESTART_DELAY_MS = 300;

export interface AdminApiDeps {
  logger: Logger;
  /**
   * Déclenche l'arrêt gracieux. En production : la fonction renvoyée par
   * `installGracefulShutdown`. Injectable pour les tests (espion, pas de sortie).
   */
  requestShutdown: () => void;
  /** Injectable pour les tests. Défaut : `setTimeout`. */
  schedule?: (callback: () => void, delayMs: number) => void;
  now?: () => number;
  /**
   * Garde-fou de cohérence (Lot 9, étape 2) : refuse le redémarrage tant qu'un
   * téléchargement de modèle est en cours, sinon la tâche serait tuée sans
   * explication. Absent ⇒ comportement historique (redémarrage immédiat).
   */
  downloads?: AdminDownloadsGuard;
}

/** Garde-fou minimal exposé par le téléchargeur de modèles. */
export interface AdminDownloadsGuard {
  hasActive(): boolean;
  activeId(): string | null;
}

export interface AdminRequestInput {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  deps: AdminApiDeps;
}

const JSON_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function json(status: number, body: unknown): ConfigHttpResponse {
  return { status, body, headers: JSON_HEADERS };
}

/** Vrai si le chemin relève de l'API d'administration. */
export function isAdminPath(path: string): boolean {
  return path === ADMIN_RESTART_PATH;
}

function handleRestart(input: AdminRequestInput): ConfigHttpResponse {
  const guard = requireWriteGuards(input.headers);
  if (guard) return guard;

  // Cohérence avec le téléchargement des modèles (Lot 9, étape 2) : le
  // redémarrage TUE le processus (exit 75, relance par le superviseur). Tuer un
  // téléchargement en cours le laisserait en `downloading` sans explication ⇒
  // on REFUSE tant qu'une tâche est active. Aucun téléchargement actif ⇒
  // comportement INCHANGÉ.
  const downloads = input.deps.downloads;
  if (downloads?.hasActive()) {
    const activeDownload = downloads.activeId();
    input.deps.logger.warn("admin.restart_refused", {
      reason: "download_in_progress",
      active_download: activeDownload,
    });
    return json(409, {
      error: "download_in_progress",
      code: "download_in_progress",
      message:
        "Un téléchargement de modèle est en cours : redémarrer maintenant l'interromprait. " +
        "Attendez la fin du téléchargement ou annulez-le, puis redémarrez.",
      ...(activeDownload ? { activeDownload } : {}),
    });
  }

  const at = new Date((input.deps.now ?? Date.now)()).toISOString();
  input.deps.logger.info("admin.restart_requested", { at });

  const schedule =
    input.deps.schedule ??
    ((callback: () => void, delayMs: number): void => {
      setTimeout(callback, delayMs);
    });
  schedule(() => input.deps.requestShutdown(), RESTART_DELAY_MS);

  return json(200, {
    ok: true,
    restarting: true,
    message:
      "Redémarrage de Yuki en cours. Le superviseur interne relance le programme ; le conteneur reste en place.",
  });
}

/** Traite une requête d'administration et renvoie la réponse HTTP. */
export function handleAdminRequest(input: AdminRequestInput): ConfigHttpResponse {
  if (!isAdminPath(input.path)) {
    return json(404, { error: "not_found", path: input.path });
  }
  if (input.method !== "POST") {
    return json(405, { error: "method_not_allowed", method: input.method });
  }
  return handleRestart(input);
}
