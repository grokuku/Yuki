// Yuki — bloc de VALIDATION HUMAINE affiché DANS la conversation.
//
// ⚠️ C'est un ÉTAT TEMPORAIRE de l'interface — jamais un message, jamais dans
// l'historique (ni transcript, ni session, ni mémoire). Le bloc apparaît dans
// la conversation où la commande a été demandée, offre Valider / Refuser sur
// place, et DISPARAÎT une fois décidée ou expirée.
//
// Rendu PUREMENT DOM (`createElement`), AUCUN attribut de style en ligne,
// aucune injection HTML directe (CSP `style-src 'self'`). Le CSS vit dans
// `styles.css`.
//
// L'échéance est transmise par le serveur (`expiresAt`, TTL ~5 min) : le bloc
// affiche un compte à rebours et se retire de lui-même à l'expiration, pour ne
// jamais laisser cliquer « dans le vide ».

const SECOND_MS = 1000;

/** Petit constructeur DOM (attributs + enfants), sans injection HTML. */
function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = value;
    else if (value !== undefined && value !== null && value !== false) {
      el.setAttribute(key, value === true ? "" : String(value));
    }
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** `true` si l'échéance est dépassée (date illisible ⇒ expirée). */
export function isExpired(expiresAt, now) {
  const at = Date.parse(expiresAt ?? "");
  if (!Number.isFinite(at)) return true;
  return at <= now;
}

/** Millisecondes restantes avant l'échéance, bornées à ≥ 0. */
export function remainingMs(expiresAt, now) {
  const at = Date.parse(expiresAt ?? "");
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, at - now);
}

/** Compte à rebours lisible : « 4 min 32 s », « 42 s ». */
export function formatRemaining(ms) {
  const total = Math.max(0, Math.ceil(ms / SECOND_MS));
  const min = Math.floor(total / 60);
  const sec = total % 60;
  if (min > 0) return `${min} min ${String(sec).padStart(2, "0")} s`;
  return `${sec} s`;
}

/** Nom affichable d'une machine : nom lisible, repli identifiant. */
export function machineLabel(approval) {
  const name = typeof approval?.agentName === "string" ? approval.agentName.trim() : "";
  return name !== "" ? name : String(approval?.agentId ?? "");
}

/**
 * Gère les blocs de validation d'UNE conversation (`container` = `#conversation`).
 *
 * @param {object} deps
 * @param {HTMLElement} deps.container   conteneur du fil.
 * @param {(id: string, decision: "approve" | "deny") => void} deps.onDecide
 * @param {() => number} [deps.now]       horloge (injectable pour les tests).
 * @returns {{ show(a: object): void, clear(id: string): void, showResult(r: object): void, reset(): void, resetBusy(): void }}
 */
export function createApprovalBlocks({ container, onDecide, now = () => Date.now() }) {
  if (!container) throw new Error("createApprovalBlocks : conteneur absent");
  const decide = typeof onDecide === "function" ? onDecide : () => undefined;
  const clock = typeof now === "function" ? now : () => Date.now();

  /** id → { el, timer, approve, deny, note, expiry } */
  const blocks = new Map();

  function clear(id) {
    const entry = blocks.get(id);
    if (!entry) return;
    if (entry.timer !== null) clearInterval(entry.timer);
    entry.el.remove();
    blocks.delete(id);
  }

  /** Retire TOUS les blocs (le fil est reconstruit depuis un snapshot). */
  function reset() {
    for (const id of [...blocks.keys()]) clear(id);
  }

  /** Réactive les boutons (échec réseau / décision refusée sans retrait). */
  function resetBusy() {
    for (const entry of blocks.values()) {
      entry.approve.disabled = false;
      entry.deny.disabled = false;
      entry.note.textContent = "";
    }
  }

  function expiryText(expiresAt) {
    const remaining = remainingMs(expiresAt, clock());
    const at = Date.parse(expiresAt ?? "");
    const when = Number.isFinite(at)
      ? ` (à ${new Intl.DateTimeFormat("fr-FR", {
          hour: "2-digit",
          minute: "2-digit",
        }).format(new Date(at))})`
      : "";
    return `Expire dans ${formatRemaining(remaining)}${when} — passé ce délai, il faudra relancer la commande.`;
  }

  function build(approval) {
    const id = String(approval.id);
    const label = machineLabel(approval);
    const machineChildren = [h("span", { class: "approval__name", text: label })];
    if (label !== String(approval.agentId)) {
      machineChildren.push(
        h("span", { class: "approval__agent-id", text: `id ${approval.agentId}` }),
      );
    }
    const head = h("div", { class: "approval__head" }, [
      h("span", { class: "approval__title", text: "Validation requise" }),
      h("span", { class: "approval__machine" }, machineChildren),
      approval.destructive
        ? h("span", { class: "approval__badge approval__badge--danger", text: "Destructrice" })
        : h("span", { class: "approval__badge", text: "Ordinaire" }),
    ]);

    const reasons =
      approval.destructive && Array.isArray(approval.destructiveReasons) &&
      approval.destructiveReasons.length > 0
        ? approval.destructiveReasons.map((reason) => String(reason)).join(" · ")
        : "";

    const approve = h("button", { class: "button approval__btn", type: "button", text: "Valider" });
    const deny = h("button", {
      class: "button button--stop approval__btn",
      type: "button",
      text: "Refuser",
    });
    const note = h("span", { class: "approval__note", role: "status" });

    const el = h(
      "div",
      {
        class: "approval",
        "data-approval-id": id,
        role: "group",
        "aria-label": "Validation humaine requise",
      },
      [
        head,
        h("code", { class: "approval__command", text: String(approval.command ?? "") }),
        reasons ? h("p", { class: "approval__reason" }, [
          "Pourquoi elle est classée destructrice : ",
          h("strong", { text: reasons }),
          ".",
        ]) : null,
        h("p", { class: "approval__expiry", text: expiryText(approval.expiresAt) }),
        h("div", { class: "approval__actions" }, [approve, deny, note]),
      ],
    );

    const entry = { el, timer: null, approve, deny, note };
    approve.addEventListener("click", () => onDecision(id, "approve", entry));
    deny.addEventListener("click", () => onDecision(id, "deny", entry));
    return entry;
  }

  function onDecision(id, decision, entry) {
    // Anti double-clic immédiat ; réactivé par `resetBusy` si un échec survient.
    entry.approve.disabled = true;
    entry.deny.disabled = true;
    entry.note.textContent = decision === "approve" ? "Validation…" : "Refus…";
    decide(id, decision);
  }

  /** Affiche (ou met à jour) le bloc d'une demande de validation. */
  function show(approval) {
    if (!approval || approval.id === undefined || approval.id === null) return;
    const id = String(approval.id);
    const existing = blocks.get(id);
    if (existing) clear(id);
    const entry = build(approval);
    blocks.set(id, entry);
    container.appendChild(entry.el);

    // Compte à rebours : rafraîchit le texte, puis retire le bloc à l'échéance.
    const tick = () => {
      if (!blocks.has(id)) return;
      const expiry = entry.el.querySelector(".approval__expiry");
      if (expiry) expiry.textContent = expiryText(approval.expiresAt);
      if (isExpired(approval.expiresAt, clock())) clear(id);
    };
    tick();
    if (blocks.has(id)) {
      entry.timer = setInterval(tick, SECOND_MS);
    }
  }

  /** Affiche le RÉSULTAT (éphémère) d'une commande approuvée. */
  function showResult(result) {
    if (!result) return;
    const label = machineLabel(result);
    const machineChildren = [h("span", { class: "approval__name", text: label })];
    if (label !== String(result.agentId)) {
      machineChildren.push(
        h("span", { class: "approval__agent-id", text: `id ${result.agentId}` }),
      );
    }
    const code =
      result.exitCode === null || result.exitCode === undefined
        ? "code inconnu"
        : `code de sortie ${result.exitCode}`;
    const children = [
      h("div", { class: "approval__head" }, [
        h("span", { class: "approval__title", text: "Résultat de la commande" }),
        h("span", { class: "approval__machine" }, machineChildren),
        h("span", {
          class: result.ok ? "approval__badge approval__badge--ok" : "approval__badge approval__badge--danger",
          text: result.ok ? code : "non exécutée",
        }),
      ]),
      h("code", { class: "approval__command", text: String(result.command ?? "") }),
    ];
    if (typeof result.output === "string" && result.output.length > 0) {
      children.push(h("pre", { class: "approval__output", text: result.output }));
    }
    if (result.message) {
      children.push(h("p", { class: "approval__message", text: String(result.message) }));
    }
    children.push(
      h("p", {
        class: "approval__note",
        text: "Résultat temporaire : il n'est pas conservé dans l'historique de la conversation.",
      }),
    );
    const el = h("div", { class: "approval approval--result" }, children);
    container.appendChild(el);
  }

  return { show, clear, showResult, reset, resetBusy };
}
