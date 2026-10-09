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
// ⚠️ Une demande de validation est une demande d'ACTION : ne pas la voir, c'est
// la PERDRE (et l'expiration la rend définitive). À l'apparition, la vue défile
// jusqu'au bloc si l'utilisateur était déjà en bas (même mécanisme que les
// messages) ; sinon elle n'impose AUCUN déplacement mais signale la demande par
// un indicateur cliquable (`onAttention`).
//
// ⚠️ L'échéance vient du serveur sous forme de DURÉE (`ttlSeconds`, TTL ~5 min),
// pas d'un horodatage à comparer à l'horloge du navigateur : le compte à rebours
// part de la RÉCEPTION et se retire à l'expiration, insensible à un décalage
// d'horloge du poste client. Le registre côté serveur reste la SEULE vérité
// d'expiration (un clic tardif échoue proprement).

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

/**
 * Échéance LOCALE (ms Unix) d'une demande : la DURÉE restante transmise par le
 * serveur (`ttlSeconds`, secondes) ajoutée à l'instant de RÉCEPTION côté client.
 *
 * ⚠️ On ne compare JAMAIS l'horodatage serveur (`expiresAt`) à l'horloge du
 * navigateur : une horloge cliente en avance ou en retard ne change donc pas le
 * délai restant. `ttlSeconds` illisible ⇒ `NaN` (échéance passée ⇒ bloc retiré).
 */
export function localDeadline(ttlSeconds, receivedAt) {
  const ttl = Number(ttlSeconds);
  if (!Number.isFinite(ttl)) return Number.NaN;
  return receivedAt + Math.max(0, ttl) * SECOND_MS;
}

/** `true` si l'échéance (ms Unix) est dépassée. Illisible ⇒ expirée. */
export function isExpired(deadline, now) {
  if (!Number.isFinite(deadline)) return true;
  return deadline <= now;
}

/** Millisecondes restantes avant l'échéance (ms Unix), bornées à ≥ 0. */
export function remainingMs(deadline, now) {
  if (!Number.isFinite(deadline)) return 0;
  return Math.max(0, deadline - now);
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
 * @param {() => boolean} [deps.isPinned] l'utilisateur est-il près du bas ?
 *   (injecté depuis `app.js` : MÊME mesure que l'auto-scroll des messages).
 * @param {() => void} [deps.scrollToEnd] ramène la vue en bas (MÊME mécanisme
 *   que l'auto-scroll des messages).
 * @param {(active: boolean) => void} [deps.onAttention] signale (true) / masque
 *   (false) l'indicateur « une validation est en attente ».
 * @returns {{ show(a: object): void, clear(id: string): void, showResult(r: object): void, reset(): void, resetBusy(): void, reveal(): void, acknowledge(): void }}
 */
export function createApprovalBlocks({
  container,
  onDecide,
  now = () => Date.now(),
  isPinned = () => true,
  scrollToEnd = () => {
    container.scrollTop = container.scrollHeight;
  },
  onAttention = () => undefined,
} = {}) {
  if (!container) throw new Error("createApprovalBlocks : conteneur absent");
  const decide = typeof onDecide === "function" ? onDecide : () => undefined;
  const clock = typeof now === "function" ? now : () => Date.now();
  const pinnedCheck = typeof isPinned === "function" ? isPinned : () => true;
  const goToEnd =
    typeof scrollToEnd === "function"
      ? scrollToEnd
      : () => {
          container.scrollTop = container.scrollHeight;
        };
  const attention = typeof onAttention === "function" ? onAttention : () => undefined;

  /** id → { el, timer, approve, deny, note, deadline } */
  const blocks = new Map();
  let attentionOn = false;

  /** Signale/masque l'indicateur UNIQUEMENT quand l'état change. */
  function setAttention(active) {
    const next = Boolean(active) && blocks.size > 0;
    if (next === attentionOn) return;
    attentionOn = next;
    attention(next);
  }

  function clear(id) {
    const entry = blocks.get(id);
    if (!entry) return;
    if (entry.timer !== null) clearInterval(entry.timer);
    entry.el.remove();
    blocks.delete(id);
    // Plus aucune demande en attente : l'indicateur n'a plus lieu d'être.
    if (blocks.size === 0) setAttention(false);
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

  /** Ramène la vue sur la demande en attente (action de l'indicateur). */
  function reveal() {
    if (blocks.size > 0) goToEnd();
    setAttention(false);
  }

  /** L'utilisateur a revu la demande : l'indicateur peut disparaître. */
  function acknowledge() {
    setAttention(false);
  }

  function expiryText(deadline) {
    return `Expire dans ${formatRemaining(
      remainingMs(deadline, clock()),
    )} — passé ce délai, il faudra relancer la commande.`;
  }

  function build(approval, receivedAt) {
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
    // ⚠️ Durée RELATIVE : échéance calculée depuis la réception, jamais depuis
    // l'horodatage serveur comparé à l'horloge cliente.
    const deadline = localDeadline(approval.ttlSeconds, receivedAt);

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
        h("p", { class: "approval__expiry", text: expiryText(deadline) }),
        h("div", { class: "approval__actions" }, [approve, deny, note]),
      ],
    );

    const entry = { el, timer: null, approve, deny, note, deadline };
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
    if (blocks.has(id)) clear(id);
    // ⚠️ Mesuré AVANT insertion : ajouter le bloc augmente la hauteur du fil, ce
    // qui ferait croire à tort que l'utilisateur n'était plus en bas.
    const pinned = pinnedCheck();
    const receivedAt = clock();
    const entry = build(approval, receivedAt);
    blocks.set(id, entry);
    container.appendChild(entry.el);

    // ⚠️ Demande d'ACTION : déjà en bas ⇒ on défile (MÊME mécanisme que les
    // messages) ; plus haut dans le fil ⇒ on ne déplace PAS la vue, mais on
    // signale la demande (indicateur cliquable) pour ne jamais la perdre.
    if (pinned) goToEnd();
    else setAttention(true);

    // Compte à rebours : rafraîchit le texte, puis retire le bloc à l'échéance.
    const tick = () => {
      if (!blocks.has(id)) return;
      const expiry = entry.el.querySelector(".approval__expiry");
      if (expiry) expiry.textContent = expiryText(entry.deadline);
      if (isExpired(entry.deadline, clock())) clear(id);
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

  return { show, clear, showResult, reset, resetBusy, reveal, acknowledge };
}
