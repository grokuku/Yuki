/**
 * Fenêtre de saisie d'un MOT DE PASSE — `HolafModal` uniquement.
 *
 * ⚠️ On n'utilise PAS `window.prompt`/`window.confirm` (interdits dans ce
 * projet) et PAS `HolafModal.prompt` non plus : la brique crée un champ
 * `type="text"`, qui afficherait le mot de passe EN CLAIR à l'écran. On monte
 * donc une modale avec `HolafModal.open` et un vrai champ `type="password"`.
 *
 * ⚠️ La valeur saisie ne quitte que ce champ : elle va du NAVIGATEUR au
 * SERVEUR (route dédiée), JAMAIS au modèle, JAMAIS dans le DOM après coup
 * (le champ est détruit avec la modale) et JAMAIS dans un journal côté client.
 *
 * CSP stricte : aucun style en ligne, aucun `innerHTML` — DOM programmatique.
 */

/**
 * @param {object} deps
 * @param {{open: Function}} deps.HolafModal brique de modale (déjà configurée).
 * @param {string} deps.title titre de la fenêtre.
 * @param {string} deps.message explication (français, honnête).
 * @param {string} [deps.okText] libellé du bouton de validation.
 * @param {string} [deps.placeholder] indication du champ.
 * @returns {Promise<string|null>} la valeur saisie, ou `null` si annulé.
 */
export function promptSecret({ HolafModal, title, message, okText, placeholder }) {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "secret-prompt";
    if (message) {
      const text = document.createElement("p");
      text.className = "secret-prompt__message";
      text.textContent = message;
      wrap.append(text);
    }
    const input = document.createElement("input");
    input.className = "config-secret__input secret-prompt__input";
    input.type = "password";
    input.autocomplete = "current-password";
    input.spellcheck = false;
    if (placeholder) input.placeholder = placeholder;
    input.setAttribute("aria-label", "Mot de passe d'instance");
    wrap.append(input);

    const submit = () => {
      const value = input.value;
      // On referme avec une valeur NON vide seulement : un champ vide n'est pas
      // une saisie (l'appelant traiterait ça comme un refus silencieux).
      if (value === "") {
        input.focus();
        return;
      }
      ctrl.close(value);
    };

    const ctrl = HolafModal.open({
      title: title || "Mot de passe",
      size: "sm",
      content: wrap,
      closeOnOverlay: false,
      buttons: [
        { text: "Annuler", value: null, type: "cancel" },
        { text: okText || "Valider", type: "primary", onClick: submit },
      ],
      _onResolve: (value) => resolve(typeof value === "string" && value !== "" ? value : null),
    });

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submit();
      }
    });
    input.focus();
  });
}

/**
 * Demande un déverrouillage d'agent : saisie du mot de passe d'INSTANCE puis
 * appel de la route dédiée. Ne lève jamais ; renvoie un résultat exploitable.
 *
 * @param {object} deps
 * @param {object} deps.HolafModal
 * @param {string} deps.agentId
 * @param {string} deps.agentLabel nom lisible (jamais vide).
 * @param {(input: RequestInfo, init?: RequestInit) => Promise<Response>} [deps.fetchImpl]
 * @returns {Promise<{ok: boolean, cancelled?: boolean, message: string}>}
 */
export async function unlockAgentWithPassword({
  HolafModal,
  agentId,
  agentLabel,
  fetchImpl = typeof fetch === "function" ? fetch : undefined,
}) {
  const password = await promptSecret({
    HolafModal,
    title: "Déverrouiller l'agent",
    message:
      `L'agent « ${agentLabel} » est déclaré « matériel sensible » et il est ` +
      "VERROUILLÉ : aucune commande ne lui sera transmise tant qu'il n'est pas " +
      "déverrouillé. Saisissez le mot de passe d'instance. Il se reverrouillera " +
      "tout seul après 15 min sans activité.",
    okText: "Déverrouiller",
    placeholder: "Mot de passe d'instance",
  });
  if (password === null) return { ok: false, cancelled: true, message: "Déverrouillage annulé." };
  if (!fetchImpl) {
    return { ok: false, message: "Déverrouillage impossible : réseau indisponible." };
  }
  try {
    const response = await fetchImpl(`/api/agents/${encodeURIComponent(agentId)}/unlock`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-yuki-agents": "1" },
      body: JSON.stringify({ password }),
      cache: "no-store",
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      return {
        ok: false,
        message:
          (body && (body.message || body.error)) ||
          `Déverrouillage refusé (HTTP ${response.status}).`,
      };
    }
    return { ok: true, message: "Agent déverrouillé." };
  } catch (error) {
    return {
      ok: false,
      message: `Déverrouillage impossible : ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
