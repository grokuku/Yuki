// Yuki — FENÊTRE FLOTTANTE de VALIDATION HUMAINE (D118).
//
// ⚠️ Une demande de validation est une demande d'ACTION : elle REMPLACE le bloc
// qui vivait DANS le fil. Elle s'affiche AU-DESSUS de l'interface (position
// `fixed`), quelle que soit la page (`/` comme `/config`), pour que l'humain la
// voie PARTOUT où il se trouve.
//
// Propriétés tenues par ce module :
//   - NON bloquante : AUCUN voile/overlay. Le conteneur est en
//     `pointer-events: none`, seule la fenêtre l'est (`auto`) ⇒ on continue
//     d'utiliser le site dessous (le clic passe au travers ailleurs) ;
//   - elle NE se ferme PAS au clic à côté : aucun écouteur de clic extérieur ;
//   - elle est DÉPLAÇABLE : glisser la barre de titre déplace la fenêtre ;
//   - elle reste affichée jusqu'à décision ou expiration (compte à rebours).
//
// ⚠️ CSP (`default-src 'none'; style-src 'self'`) : AUCUN `<style>` ni attribut
// de style en ligne dans le markup, AUCUNE injection HTML directe. Le DOM est
// construit par `createElement`. Le déplacement POSITIONNE la fenêtre par CSSOM
// (`el.style.left/top`) — exactement la TECHNIQUE déjà utilisée par le menu
// contextuel (`sessions-panel.js:266`) et par la brique `HolafModal`
// (`vendor/holaf/holaf-modal.js:1089`) : modifier l'objet `style` en script
// n'est PAS un attribut interprété depuis le markup, la CSP ne le bloque donc
// pas (seuls les `<style>` et les attributs de style littéraux le sont).
//
// ⚠️ Échéance : DURÉE (`ttlSeconds`, TTL ~5 min) comptée depuis la RÉCEPTION,
// jamais l'horodatage serveur comparé à l'horloge du poste (un décalage
// d'horloge client ne doit PAS faire disparaître la demande). Le registre
// serveur reste la SEULE vérité d'expiration.

const SECOND_MS = 1000;
/** Marge minimale (px) entre la fenêtre et le bord du viewport. */
const EDGE = 16;
/** Décalage (px) en cascade quand plusieurs demandes sont en attente. */
const CASCADE = 28;
/** Clé de persistance de la dernière position déplacée (localStorage). */
export const POSITION_KEY = "yuki.approval.position";

/**
 * Échéance LOCALE (ms Unix) d'une demande : la DURÉE restante transmise par le
 * serveur (`ttlSeconds`, secondes) ajoutée à l'instant de RÉCEPTION côté client.
 *
 * ⚠️ On ne compare JAMAIS l'horodatage serveur (`expiresAt`) à l'horloge du
 * navigateur : une horloge cliente en avance ou en retard ne change donc pas le
 * délai restant. `ttlSeconds` illisible ⇒ `NaN` (échéance passée).
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

/** Constructeur DOM (attributs + enfants), sans injection HTML. */
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

/** Taille LUE (px) d'un élément déjà monté, avec repli sûr (mesure tardive). */
function sizeOf(el, fallback) {
  const width = el.offsetWidth || el.getBoundingClientRect?.().width || fallback.width;
  const height = el.offsetHeight || el.getBoundingClientRect?.().height || fallback.height;
  return { width, height };
}

/**
 * Gère la couche de fenêtres flottantes (`document.body`), partagée par la page
 * de discussion et la page `/config`.
 *
 * @param {object} deps
 * @param {(id: string, decision: "approve" | "deny") => void} deps.onDecide
 * @param {() => number} [deps.now] horloge (injectable pour les tests).
 * @param {Document} [deps.doc]
 * @param {Window} [deps.win]
 * @param {{ get(k: string): string | null, set(k: string, v: string): void }} [deps.store]
 * @returns {{
 *   show(a: object): void,
 *   clear(id: string): void,
 *   showResult(r: object): void,
 *   reset(): void,
 *   resetBusy(): void,
 *   element: HTMLElement,
 * }}
 */
export function createApprovalLayer({
  onDecide,
  now = () => Date.now(),
  doc = typeof document !== "undefined" ? document : undefined,
  win = typeof window !== "undefined" ? window : undefined,
  store,
} = {}) {
  if (!doc || !doc.body) throw new Error("createApprovalLayer : document requis");
  const decide = typeof onDecide === "function" ? onDecide : () => undefined;
  const clock = typeof now === "function" ? now : () => Date.now();
  const view = win ?? { innerWidth: 1024, innerHeight: 768 };
  const storage =
    store ??
    {
      get(key) {
        try {
          return view.localStorage ? view.localStorage.getItem(key) : null;
        } catch {
          return null;
        }
      },
      set(key, value) {
        try {
          view.localStorage?.setItem(key, value);
        } catch {
          /* stockage indisponible (navigation privée) : position non mémorisée. */
        }
      },
    };
  const setTimer =
    win && typeof win.setInterval === "function"
      ? win.setInterval.bind(win)
      : globalThis.setInterval;
  const clearTimer =
    win && typeof win.clearInterval === "function"
      ? win.clearInterval.bind(win)
      : globalThis.clearInterval;

  /** Conteneur plein écran, transparent aux clics (aucun voile bloquant). */
  const root = h("div", { class: "approval-layer" });
  doc.body.append(root);

  /** id → { el, timer, approve, deny, note, deadline, pos } */
  const requests = new Map();
  /** Fenêtres de RÉSULTAT (éphémères), retirées au reset / à la fermeture. */
  const results = new Set();

  function viewport() {
    const width = Number(view.innerWidth) > 0 ? view.innerWidth : 1024;
    const height = Number(view.innerHeight) > 0 ? view.innerHeight : 768;
    return { width, height };
  }

  /** Borne une position pour garder la fenêtre ENTIÈREMENT dans le viewport. */
  function clamp(left, top, width, height) {
    const vp = viewport();
    return {
      left: Math.max(0, Math.min(Math.max(0, vp.width - width), left)),
      top: Math.max(0, Math.min(Math.max(0, vp.height - height), top)),
    };
  }

  /** Dernière position mémorisée (localStorage), ou `null`. */
  function readStoredPosition() {
    try {
      const raw = storage.get(POSITION_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && Number.isFinite(parsed.left) && Number.isFinite(parsed.top)) {
        return { left: parsed.left, top: parsed.top };
      }
    } catch {
      /* valeur illisible : on repart de la position par défaut. */
    }
    return null;
  }

  function persist(position) {
    storage.set(
      POSITION_KEY,
      JSON.stringify({ left: Math.round(position.left), top: Math.round(position.top) }),
    );
  }

  /** Applique une position par CSSOM (jamais d'attribut de style dans le markup). */
  function place(el, left, top) {
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  }

  /**
   * Position d'apparition : la dernière position mémorisée (continuité entre
   * `/` et `/config`, deux pages séparées) sinon le coin bas-droit, plus une
   * CASCADE par demande en attente (aucune fenêtre superposée à l'autre).
   */
  function placeNew(el, index) {
    const { width, height } = sizeOf(el, { width: 380, height: 220 });
    const vp = viewport();
    const stored = readStoredPosition();
    const baseLeft = stored ? stored.left : vp.width - width - EDGE;
    const baseTop = stored ? stored.top : vp.height - height - EDGE;
    return clamp(baseLeft + index * CASCADE, baseTop + index * CASCADE, width, height);
  }

  /** Rend une fenêtre déplaçable par sa barre (glisser à la souris + flèches). */
  function makeDraggable(el, bar, pos) {
    bar.setAttribute("tabindex", "0");
    bar.setAttribute("aria-label", "Déplacer la fenêtre");
    let dragging = false;

    bar.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      // Ne pas démarrer un drag depuis un contrôle interne (bouton, code…).
      if (event.target?.closest?.("button, input, select, textarea, a")) return;
      if (typeof event.preventDefault === "function") event.preventDefault();
      dragging = true;
      const startX = event.clientX;
      const startY = event.clientY;
      const startLeft = pos.left;
      const startTop = pos.top;

      const onMove = (moveEvent) => {
        if (!dragging) return;
        const { width, height } = sizeOf(el, { width: 380, height: 220 });
        const next = clamp(
          startLeft + (moveEvent.clientX - startX),
          startTop + (moveEvent.clientY - startY),
          width,
          height,
        );
        pos.left = next.left;
        pos.top = next.top;
        place(el, next.left, next.top);
      };
      const onUp = () => {
        dragging = false;
        doc.removeEventListener("mousemove", onMove);
        doc.removeEventListener("mouseup", onUp);
        persist(pos);
      };
      doc.addEventListener("mousemove", onMove);
      doc.addEventListener("mouseup", onUp);
    });

    bar.addEventListener("keydown", (event) => {
      const step = event.shiftKey ? 40 : 16;
      const deltas = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };
      const delta = deltas[event.key];
      if (!delta) return;
      event.preventDefault();
      const { width, height } = sizeOf(el, { width: 380, height: 220 });
      const next = clamp(pos.left + delta[0], pos.top + delta[1], width, height);
      pos.left = next.left;
      pos.top = next.top;
      place(el, next.left, next.top);
      persist(pos);
    });
  }

  /** En-tête machine partagé (nom + identifiant repli), sans injection. */
  function machineNode(source) {
    const label = machineLabel(source);
    const children = [h("span", { class: "approval__name", text: label })];
    if (label !== String(source.agentId)) {
      children.push(h("span", { class: "approval__agent-id", text: `id ${source.agentId}` }));
    }
    return h("span", { class: "approval__machine" }, children);
  }

  /** Fenêtre nue (chrome + barre déplaçable), sans contenu. */
  function shell({ id, label, head }) {
    const grip = h("span", { class: "approval-window__grip", "aria-hidden": "true" });
    const bar = h("div", { class: "approval__head approval-window__bar" }, [grip, ...head]);
    const el = h(
      "div",
      {
        class: label.className,
        role: "dialog",
        "aria-modal": "false",
        "aria-label": label.ariaLabel,
        ...(id !== undefined ? { "data-approval-id": String(id) } : {}),
      },
      [bar],
    );
    const pos = { left: 0, top: 0 };
    makeDraggable(el, bar, pos);
    root.append(el);
    return { el, bar, pos };
  }

  function headWith(source, extra) {
    const badge = source.destructive
      ? h("span", { class: "approval__badge approval__badge--danger", text: "Destructrice" })
      : h("span", { class: "approval__badge", text: "Ordinaire" });
    return [
      h("span", { class: "approval__title", text: "Validation requise" }),
      machineNode(source),
      badge,
      ...extra,
    ];
  }

  function clearRequest(id) {
    const entry = requests.get(id);
    if (!entry) return;
    if (entry.timer !== null) clearTimer(entry.timer);
    entry.el.remove();
    requests.delete(id);
  }

  /** Retire la fenêtre d'une demande (décision, expiration ou mise à jour). */
  function clear(id) {
    clearRequest(id);
  }

  /** Retire TOUTES les fenêtres (le rendu est reconstruit depuis un snapshot). */
  function reset() {
    for (const id of [...requests.keys()]) clearRequest(id);
    for (const entry of results) {
      if (entry.timer !== null) clearTimer(entry.timer);
      entry.el.remove();
    }
    results.clear();
  }

  /** Réactive les boutons après un échec réseau (décision non partie). */
  function resetBusy() {
    for (const entry of requests.values()) {
      entry.approve.disabled = false;
      entry.deny.disabled = false;
      entry.note.textContent = "";
    }
  }

  function expiryText(deadline) {
    return `Expire dans ${formatRemaining(
      remainingMs(deadline, clock()),
    )} — passé ce délai, il faudra relancer la commande.`;
  }

  function onDecision(id, decision, entry) {
    // Anti double-clic immédiat ; réactivé par `resetBusy` si un échec survient.
    entry.approve.disabled = true;
    entry.deny.disabled = true;
    entry.note.textContent = decision === "approve" ? "Validation…" : "Refus…";
    decide(id, decision);
  }

  /** Affiche (ou met à jour) la fenêtre d'une demande de validation. */
  function show(approval) {
    if (!approval || approval.id === undefined || approval.id === null) return;
    const id = String(approval.id);
    if (requests.has(id)) clearRequest(id);

    const reasons =
      approval.destructive &&
      Array.isArray(approval.destructiveReasons) &&
      approval.destructiveReasons.length > 0
        ? approval.destructiveReasons.map((reason) => String(reason)).join(" · ")
        : "";

    const approve = h("button", {
      class: "button approval__btn",
      type: "button",
      text: "Valider",
    });
    const deny = h("button", {
      class: "button button--stop approval__btn",
      type: "button",
      text: "Refuser",
    });
    const note = h("span", { class: "approval__note", role: "status" });
    // ⚠️ Durée RELATIVE : échéance calculée depuis la RÉCEPTION, jamais depuis
    // l'horodatage serveur comparé à l'horloge cliente.
    const receivedAt = clock();
    const deadline = localDeadline(approval.ttlSeconds, receivedAt);

    const { el, pos } = shell({
      id,
      label: {
        className: "approval approval-window",
        ariaLabel: `Demande de validation — ${machineLabel(approval)}`,
      },
      head: headWith(approval, []),
    });
    el.append(
      h("code", { class: "approval__command", text: String(approval.command ?? "") }),
      reasons
        ? h("p", { class: "approval__reason" }, [
            "Pourquoi elle est classée destructrice : ",
            h("strong", { text: reasons }),
            ".",
          ])
        : null,
      h("p", { class: "approval__expiry", text: expiryText(deadline) }),
      h("div", { class: "approval__actions" }, [approve, deny, note]),
    );

    const entry = { el, timer: null, approve, deny, note, deadline, pos };
    requests.set(id, entry);
    const position = placeNew(el, requests.size - 1);
    pos.left = position.left;
    pos.top = position.top;
    place(el, position.left, position.top);

    approve.addEventListener("click", () => onDecision(id, "approve", entry));
    deny.addEventListener("click", () => onDecision(id, "deny", entry));

    const tick = () => {
      if (!requests.has(id)) return;
      const expiry = el.querySelector(".approval__expiry");
      if (expiry) expiry.textContent = expiryText(entry.deadline);
      if (isExpired(entry.deadline, clock())) clearRequest(id);
    };
    tick();
    if (requests.has(id)) {
      entry.timer = setTimer(tick, SECOND_MS);
    }
  }

  /** Affiche le RÉSULTAT (éphémère) d'une commande approuvée, en fenêtre. */
  function showResult(result) {
    if (!result) return;
    const close = h("button", {
      class: "button button--ghost button--small approval-window__close",
      type: "button",
      text: "Fermer",
    });
    const ok = Boolean(result.ok);
    const code =
      result.exitCode === null || result.exitCode === undefined
        ? "code inconnu"
        : `code de sortie ${result.exitCode}`;
    const badge = h("span", {
      class: ok ? "approval__badge approval__badge--ok" : "approval__badge approval__badge--danger",
      text: ok ? code : "non exécutée",
    });

    const entryRef = { el: null, timer: null };
    const { el } = shell({
      label: {
        className: "approval approval--result approval-window",
        ariaLabel: `Résultat de la commande — ${machineLabel(result)}`,
      },
      head: [
        h("span", { class: "approval__title", text: "Résultat de la commande" }),
        machineNode(result),
        badge,
        close,
      ],
    });
    el.append(h("code", { class: "approval__command", text: String(result.command ?? "") }));
    if (typeof result.output === "string" && result.output.length > 0) {
      el.append(h("pre", { class: "approval__output", text: result.output }));
    }
    if (result.message) {
      el.append(h("p", { class: "approval__message", text: String(result.message) }));
    }
    el.append(
      h("p", {
        class: "approval__note",
        text: "Résultat temporaire : il n'est pas conservé dans l'historique de la conversation.",
      }),
    );

    entryRef.el = el;
    results.add(entryRef);
    const position = placeNew(el, results.size - 1);
    place(el, position.left, position.top);
    close.addEventListener("click", () => {
      el.remove();
      results.delete(entryRef);
    });
  }

  return { show, clear, showResult, reset, resetBusy, element: root };
}
