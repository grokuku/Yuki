// Yuki — classement PARTAGÉ des messages navigateur collectés via CDP par les
// harnais E2E JETABLES de `_tools`.
//
// POURQUOI CE MODULE : chaque harnais filtrait les « violations » avec le motif
// évasif `/refused|content security policy|csp/i`. Or « refused » apparaît AUSSI
// dans un échec de connexion réseau
// (`WebSocket … net::ERR_CONNECTION_REFUSED`), qui n'est PAS une violation CSP :
// un serveur pas encore prêt ou déjà arrêté produit ce message. Les confondre
// gonfle le compteur CSP (faux positif) ET, à terme, banalise le signal ⇒ une
// VRAIE violation CSP « noyée » dans le bruit ne serait plus vue. Ce module
// sépare donc deux familles distinctes :
//
//   - VIOLATION CSP  : une ressource interdite par la politique. Le message cite
//     « Content Security Policy » (Chrome y inclut toujours cette phrase), ou
//     arrive par le canal DÉDIÉ `Log.source === "security"` ⇒ À BLOQUER.
//   - ERREUR DE CONNEXION : échec réseau `net::ERR_…` (connexion refusée,
//     réinitialisée, nom non résolu…). Ce n'est pas une violation CSP ; c'est un
//     artefact d'indisponibilité (démarrage/arrêt du serveur) ⇒ compté À PART,
//     et doit rester à ZÉRO pendant la phase de test (serveur disponible).

/** Phrase présente dans TOUTE violation CSP émise par Chromium. */
const CSP_TEXT = /content security policy|\bcsp\b/i;

/** Échecs réseau (couche transport) — jamais des violations CSP. */
const CONNECTION_TEXT = /net::ERR_|ERR_CONNECTION_|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_ADDRESS_UNREACHABLE/;

/** `true` si le texte décrit une violation de Content Security Policy. */
export function isCspViolationText(text) {
  return typeof text === "string" && CSP_TEXT.test(text);
}

/** `true` si le texte décrit un échec de connexion réseau (couche transport). */
export function isConnectionErrorText(text) {
  return typeof text === "string" && CONNECTION_TEXT.test(text);
}

/**
 * Classe les messages collectés en deux listes disjointes.
 *
 * @param {Array<{type?: string, text?: string}>} consoleMessages messages de
 *   `Runtime.consoleAPICalled`.
 * @param {Array<{source?: string, level?: string, text?: string}>} logEntries
 *   entrées de `Log.entryAdded`.
 * @returns {{ cspViolations: Array<{source: string, text: string}>,
 *             connectionErrors: Array<{source: string, text: string}> }}
 */
export function collectViolations(consoleMessages = [], logEntries = []) {
  const cspViolations = [];
  const connectionErrors = [];

  for (const m of consoleMessages) {
    const text = m?.text ?? "";
    if (isCspViolationText(text)) cspViolations.push({ source: m?.type ?? "console", text });
    else if (isConnectionErrorText(text)) connectionErrors.push({ source: m?.type ?? "console", text });
  }

  for (const e of logEntries) {
    const text = e?.text ?? "";
    const source = e?.source ?? "log";
    // Le texte prime : un échec réseau sur le canal `security` reste un échec
    // réseau, pas une violation de politique.
    if (isCspViolationText(text)) cspViolations.push({ source, text });
    else if (isConnectionErrorText(text)) connectionErrors.push({ source, text });
    else if (source === "security") cspViolations.push({ source, text });
  }

  return { cspViolations, connectionErrors };
}

/**
 * Attend que le gateway RÉPONDE réellement (`GET /health/ready`) avant de charger
 * la page : c'est un ÉTAT constaté, pas un `sleep` arbitraire (un délai fixe
 * déplace la course, il ne la supprime pas). `startServer` des harnais résout
 * déjà sur la ligne `READY` émise dans le callback `listen` ; cette sonde est un
 * garde-fou supplémentaire (indépendant du format des journaux du serveur).
 *
 * @param {string} base URL de base `http://127.0.0.1:<port>`.
 * @param {{ timeoutMs?: number, intervalMs?: number }} [options]
 * @returns {Promise<void>} résout dès que le gateway répond ; rejette sinon.
 */
export async function waitForGateway(base, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  let lastError = "inconnue";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/health/ready`);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`gateway indisponible (${lastError}) sur ${base}/health/ready`);
}
