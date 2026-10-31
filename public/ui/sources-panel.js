/**
 * Panneau « Sources » de la page `/config` — programmes autorisés à réveiller Yuki.
 *
 * Une source = un `nom` + un `jeton` (coffre). Trois réglages INDÉPENDANTS :
 *   - OÙ       « conversation » : un fil DÉSIGNÉ choisi dans la liste des
 *              conversations, le fil dédié de la source (`Source — <nom>`, créé au
 *              premier message), « nouvelle conversation à chaque fois », ou la
 *              conversation ouverte. ⚠️ Tant que RIEN n'est choisi (`aucune`), la
 *              source ne démarre aucun tour ;
 *   - TOUR     « lancer » (démarre un tour) ou « stocker » (boîte de notifications) ;
 *   - NOTIFIER « notifier » : Web Push vers l'appareil.
 * Plus une CONSIGNE libre (« si rien d'anormal, ne dis rien ») — c'est du TEXTE,
 * pas un mode codé.
 *
 * Routes utilisées (aucune dépendance nouvelle) :
 *   GET    /api/sources               → liste (aucun jeton, seulement « défini »)
 *   POST   /api/sources               → création            (garde `X-Yuki-Config: 1`)
 *   PATCH  /api/sources/<nom>         → réglages            (même garde)
 *   DELETE /api/sources/<nom>         → suppression + jeton (même garde)
 *   POST   /api/sources/<nom>/jeton   → jeton ⚠️ affiché UNE SEULE FOIS
 *
 * ⚠️ CSP stricte (`style-src 'self'`) : aucun `innerHTML`, aucun attribut `style`,
 * tout le CSS vit dans `config.css` ; le DOM est bâti avec `createElement`/`textContent`.
 */

/**
 * En-tête exigé par les routes des sources — en LECTURE comme en écriture (la
 * liste porte les consignes et les destinations de chaque programme branché).
 */
const JSON_HEADERS = { accept: "application/json", "x-yuki-config": "1" };
const WRITE_HEADERS = { "content-type": "application/json", "x-yuki-config": "1" };

/**
 * Les MODES de destination, avec leur libellé FR. La liste des CONVERSATIONS
 * existantes vient du serveur (`GET /api/sources` → `conversations`) et est
 * proposée AVANT ces modes : c'est la voie normale pour désigner un fil.
 */
const DESTINATIONS = [
  ["aucune", "— Choisir une destination —"],
  ["source", "Fil dédié à la source (créé au 1er message)"],
  ["nouvelle", "Nouvelle conversation à chaque fois"],
  ["courante", "Conversation ouverte au moment de l'envoi"],
];
const TOURS = [
  ["stocker", "Stocker (boîte de notifications)"],
  ["lancer", "Lancer un tour"],
];

function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = value;
    else if (key === "on" && typeof value === "function") el.addEventListener("click", value);
    else if (value === true) el.setAttribute(key, "");
    else if (value !== false && value !== undefined && value !== null) {
      el.setAttribute(key, String(value));
    }
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

function formatDate(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleString("fr-FR");
}

function apiMessage(error, fallback) {
  const data = error?.data ?? {};
  return data.message ?? data.error ?? error?.message ?? fallback;
}

function labelOf(pairs, value) {
  const found = pairs.find(([slug]) => slug === value);
  return found ? found[1] : String(value ?? "—");
}

/** Libellé d'une destination : un MODE, ou la conversation désignée (titre + date). */
export function destinationLabel(conversation, conversations = []) {
  if (conversation === undefined || conversation === null || conversation === "") {
    return "— Choisir une destination —";
  }
  const mode = DESTINATIONS.find(([slug]) => slug === conversation);
  if (mode) return mode[1];
  const found = conversations.find((entry) => entry.id === conversation);
  if (found) {
    return found.updatedAt
      ? `${found.titre} (${formatDate(found.updatedAt)})`
      : String(found.titre);
  }
  // La conversation désignée n'existe plus : on le DIT (elle sera remplacée — voir
  // la vérification à chaque réception côté serveur).
  return "conversation supprimée — à rechoisir";
}

/**
 * Formulaire d'une source (création ET édition) — DOM programmatique.
 *
 * `conversations` = liste des conversations EXISTANTES (serveur) : c'est elle qui
 * permet de DÉSIGNER un fil précis (« Envoyer dans : »).
 */
function sourceForm({ nom, consigne, conversation, tour, notifier, nomReadonly, conversations = [] }) {
  const nomInput = h("input", {
    class: "config-input",
    type: "text",
    id: "source-nom",
    autocomplete: "off",
    spellcheck: "false",
    placeholder: "ex. veille-matinale",
    value: nom ?? "",
    "aria-label": "Nom de la source",
    ...(nomReadonly ? { readonly: true } : {}),
  });
  const consigneInput = h("textarea", {
    class: "config-textarea",
    id: "source-consigne",
    rows: "4",
    spellcheck: "true",
    placeholder: "ex. si rien d'anormal, ne dis rien",
    "aria-label": "Consigne donnée à Yuki",
  });
  consigneInput.value = consigne ?? "";
  const conversationSelect = h("select", {
    class: "config-select",
    id: "source-conversation",
    "aria-label": "Où va le message",
  });
  const current = conversation ?? "aucune";
  // 1) Les CONVERSATIONS existantes (nom + date) : la voie normale pour désigner
  //    un fil précis. Rangées dans un groupe distinct des modes.
  const convGroup = h("optgroup", { label: "Conversations existantes" });
  for (const entry of conversations) {
    const text = entry.updatedAt
      ? `${entry.titre} — ${formatDate(entry.updatedAt)}`
      : String(entry.titre);
    const option = h("option", { value: entry.id, text });
    if (current === entry.id) option.selected = true;
    convGroup.append(option);
  }
  if (conversations.length > 0) conversationSelect.append(convGroup);
  // 2) Les MODES (fil dédié, nouvelle conversation, conversation ouverte).
  const modeGroup = h("optgroup", { label: "Autres destinations" });
  for (const [value, text] of DESTINATIONS) {
    const option = h("option", { value, text });
    if (current === value) option.selected = true;
    modeGroup.append(option);
  }
  conversationSelect.append(modeGroup);
  // 3) La destination configurée peut avoir DISPARU de la liste : on l'affiche
  //    quand même (aucune sélection muette sur une autre valeur).
  if (
    current !== "" &&
    !DESTINATIONS.some(([slug]) => slug === current) &&
    !conversations.some((entry) => entry.id === current)
  ) {
    const option = h("option", {
      value: current,
      text: "conversation supprimée — à rechoisir",
    });
    option.selected = true;
    conversationSelect.prepend(option);
  }
  const tourSelect = h("select", {
    class: "config-select",
    id: "source-tour",
    "aria-label": "Ce que le message déclenche",
  });
  for (const [value, text] of TOURS) {
    const option = h("option", { value, text });
    if ((tour ?? "stocker") === value) option.selected = true;
    tourSelect.append(option);
  }
  const notifierInput = h("input", {
    class: "config-checkbox",
    type: "checkbox",
    id: "source-notifier",
  });
  notifierInput.checked = notifier !== false;

  const form = h("form", { class: "source-form", id: "source-form" }, [
    h("label", { class: "config-label", for: "source-nom", text: "Nom (a-z, 0-9, « _ » et « - »)" }),
    nomInput,
    h("p", {
      class: "config-helper",
      text: nomReadonly
        ? "Le nom est la clé de la source : il ne se modifie pas. Supprimez-la et recréez-la si besoin."
        : "Ce nom servira dans l'adresse d'envoi : POST /api/sources/<nom>/messages.",
    }),
    h("label", {
      class: "config-label",
      for: "source-consigne",
      text: "Consigne (facultative — vos mots, pas un mode)",
    }),
    consigneInput,
    h("p", {
      class: "config-helper",
      text:
        "Exemple : « si rien d'anormal, ne dis rien ». C'est une CONSIGNE donnée à " +
        "Yuki, jointe à chaque message de cette source.",
    }),
    h("label", { class: "config-label", for: "source-conversation", text: "Envoyer dans :" }),
    conversationSelect,
    h("p", {
      class: "config-helper",
      text:
        "⚠️ Tant qu'aucune destination n'est choisie, la source ne démarre AUCUN tour : " +
        "ses messages attendent dans les notifications. « Fil dédié » crée un fil à son " +
        "nom (Source — …) au premier message ; « Nouvelle conversation à chaque fois » en " +
        "crée un neuf pour chaque message. Ces fils sont NORMAUX : ils apparaissent dans " +
        "la liste des conversations.",
    }),
    h("label", { class: "config-label", for: "source-tour", text: "Ce que le message déclenche" }),
    tourSelect,
    h("p", {
      class: "config-helper",
      text:
        "« Stocker » n'interrompt jamais Yuki : le message est transmis en UN SEUL bloc " +
        "au début de son prochain tour. « Lancer un tour » démarre une réponse TOUT DE " +
        "SUITE, dans la destination choisie ci-dessus (la réponse reste attachée à " +
        "l'entrée de la boîte de notifications).",
    }),
    h("label", { class: "config-label source-form__check" }, [
      notifierInput,
      h("span", { text: " Notifier cet appareil (Web Push) à chaque message" }),
    ]),
  ]);
  return {
    form,
    values: () => ({
      nom: nomInput.value.trim(),
      consigne: consigneInput.value,
      conversation: conversationSelect.value,
      tour: tourSelect.value,
      notifier: notifierInput.checked,
    }),
  };
}

export function initSourcesPanel({ root, HolafFetch, HolafModal }) {
  const state = { sources: [], conversations: [], error: "", status: "", busy: false };

  const errorEl = h("p", { class: "config-error", hidden: true, role: "alert" });
  const statusEl = h("p", { class: "config-save-status", role: "status" });
  const listEl = h("div", { class: "sources-list" });
  const tokenEl = h("div", { class: "source-token", hidden: true, role: "status" });

  /** Affiche le jeton UNE seule fois (jamais relu ensuite par l'API). */
  function showToken(nom, jeton) {
    tokenEl.textContent = "";
    const copy = h("button", {
      class: "button button--ghost button--small",
      type: "button",
      text: "Copier",
      on: () => {
        // `navigator.clipboard` peut être indisponible (contexte non sécurisé) :
        // on le dit, on n'échoue pas en silence.
        navigator.clipboard?.writeText(jeton).then(
          () => {
            copy.textContent = "Copié";
          },
          () => {
            copy.textContent = "Copie impossible — sélectionnez le texte";
          },
        );
      },
    });
    tokenEl.append(
      h("h3", { class: "source-token__title", text: `Jeton de « ${nom} »` }),
      h("p", {
        class: "config-helper",
        text:
          "Ce jeton ne sera plus jamais affiché. Envoyez-le à votre programme et gardez-le " +
          "secret : il autorise n'importe quel envoi vers cette source.",
      }),
      h("code", { class: "source-token__value", text: jeton }),
      h("div", { class: "config-actions" }, [
        copy,
        h("button", {
          class: "button button--ghost button--small",
          type: "button",
          text: "Masquer",
          on: () => {
            tokenEl.hidden = true;
            tokenEl.textContent = "";
          },
        }),
      ]),
    );
    tokenEl.hidden = false;
  }

  async function act(description, run) {
    if (state.busy) return;
    state.busy = true;
    statusEl.textContent = "";
    try {
      await run();
      statusEl.textContent = description;
      await load();
    } catch (error) {
      statusEl.textContent = apiMessage(error, "L'action a échoué.");
    } finally {
      state.busy = false;
    }
  }

  function openCreate() {
    const fields = sourceForm({ conversations: state.conversations });
    const ctrl = HolafModal.open({
      title: "Nouvelle source",
      size: "md",
      content: fields.form,
      actions: [
        { label: "Créer", form: "source-form" },
        { label: "Annuler", type: "cancel", guard: false },
      ],
    });
    fields.form.addEventListener("submit", (event) => {
      event.preventDefault();
      const values = fields.values();
      if (values.nom === "") {
        statusEl.textContent = "Renseignez un nom de source.";
        return;
      }
      void act(`Source « ${values.nom} » créée. Créez maintenant son jeton.`, async () => {
        await HolafFetch.post("/api/sources", { headers: WRITE_HEADERS, body: values });
        ctrl.close();
      });
    });
  }

  function openEdit(source) {
    const fields = sourceForm({
      nom: source.nom,
      consigne: source.consigne,
      conversation: source.conversation,
      tour: source.tour,
      notifier: source.notifier,
      nomReadonly: true,
      conversations: state.conversations,
    });
    const ctrl = HolafModal.open({
      title: `Source « ${source.nom} »`,
      size: "md",
      content: fields.form,
      actions: [
        { label: "Enregistrer", form: "source-form" },
        { label: "Annuler", type: "cancel", guard: false },
      ],
    });
    fields.form.addEventListener("submit", (event) => {
      event.preventDefault();
      const values = fields.values();
      void act(`Source « ${source.nom} » mise à jour.`, async () => {
        await HolafFetch.patch(`/api/sources/${encodeURIComponent(source.nom)}`, {
          headers: WRITE_HEADERS,
          body: {
            consigne: values.consigne,
            conversation: values.conversation,
            tour: values.tour,
            notifier: values.notifier,
          },
        });
        ctrl.close();
      });
    });
  }

  async function createToken(nom) {
    const confirmed = await HolafModal.confirm(
      `Créer un nouveau jeton pour « ${nom} » ?`,
      "L'ancien jeton cesse IMMÉDIATEMENT de fonctionner : tout programme qui l'utilise " +
        "sera refusé (401) jusqu'à ce que vous lui donniez le nouveau.",
      { danger: true, confirmText: "Créer le jeton" },
    );
    if (!confirmed) return;
    await act("Nouveau jeton créé — il n'est affiché qu'une fois.", async () => {
      const data = await HolafFetch.post(`/api/sources/${encodeURIComponent(nom)}/jeton`, {
        headers: WRITE_HEADERS,
      });
      if (typeof data?.jeton === "string") showToken(nom, data.jeton);
    });
  }

  async function removeSource(nom) {
    const confirmed = await HolafModal.confirm(
      `Supprimer la source « ${nom} » ?`,
      "Son jeton est retiré du coffre : le programme ne pourra plus rien envoyer. Les " +
        "notifications DÉJÀ reçues restent dans la boîte (aucune perte).",
      { danger: true, confirmText: "Supprimer" },
    );
    if (!confirmed) return;
    await act(`Source « ${nom} » supprimée.`, () =>
      HolafFetch.delete(`/api/sources/${encodeURIComponent(nom)}`, { headers: WRITE_HEADERS }),
    );
  }

  function buildRow(source) {
    return h("tr", { class: "sources-table__row" }, [
      h("th", { class: "sources-table__name", scope: "row", text: source.nom }),
      h("td", { text: destinationLabel(source.conversation, state.conversations) }),
      h("td", { text: labelOf(TOURS, source.tour) }),
      h("td", { text: source.notifier ? "oui" : "non" }),
      h("td", {
        text: source.jetonDefini ? "défini" : "aucun jeton",
        class: source.jetonDefini ? "" : "sources-table__warn",
      }),
      h("td", { text: formatDate(source.dernierAppel) }),
      h("td", { class: "sources-table__actions" }, [
        h("button", {
          class: "button button--ghost button--small",
          type: "button",
          text: "Réglages",
          on: () => openEdit(source),
        }),
        h("button", {
          class: "button button--ghost button--small",
          type: "button",
          text: source.jetonDefini ? "Nouveau jeton" : "Créer le jeton",
          on: () => void createToken(source.nom),
        }),
        h("button", {
          class: "button button--danger button--small",
          type: "button",
          text: "Supprimer",
          on: () => void removeSource(source.nom),
        }),
      ]),
    ]);
  }

  function renderList() {
    listEl.textContent = "";
    if (state.sources.length === 0) {
      listEl.append(
        h("p", {
          class: "config-helper",
          text:
            "Aucune source. Une source est un programme (agrégateur de news, client de " +
            "messagerie, script…) qui pourra réveiller Yuki avec un message authentifié.",
        }),
      );
      return;
    }
    listEl.append(
      h("table", { class: "sources-table" }, [
        h("thead", {}, [
          h("tr", {}, [
            h("th", { scope: "col", text: "Nom" }),
            h("th", { scope: "col", text: "Envoyer dans" }),
            h("th", { scope: "col", text: "Tour" }),
            h("th", { scope: "col", text: "Notifier" }),
            h("th", { scope: "col", text: "Jeton" }),
            h("th", { scope: "col", text: "Dernier appel" }),
            h("th", { scope: "col", text: "Actions" }),
          ]),
        ]),
        h("tbody", {}, state.sources.map(buildRow)),
      ]),
    );
  }

  async function load() {
    try {
      const data = await HolafFetch.get("/api/sources", { headers: JSON_HEADERS });
      state.sources = Array.isArray(data?.sources) ? data.sources : [];
      // Conversations proposables comme destination (vide en mode dégradé : le
      // sélecteur n'offre alors que les modes — on n'invente aucune conversation).
      state.conversations = Array.isArray(data?.conversations) ? data.conversations : [];
      state.error = "";
    } catch (error) {
      state.sources = [];
      state.error = apiMessage(error, "Impossible de lire les sources.");
    }
    errorEl.textContent = state.error;
    errorEl.hidden = state.error === "";
    renderList();
  }

  root.append(
    h("section", { class: "config-group" }, [
      h("div", { class: "config-group__head" }, [
        h("h2", { class: "config-group__title", text: "Sources (réveil par un programme)" }),
        h("button", {
          class: "button button--small",
          type: "button",
          text: "+ Nouvelle source",
          on: () => openCreate(),
        }),
      ]),
      h("p", {
        class: "config-helper",
        text:
          "N'importe quel programme peut réveiller Yuki : un agrégateur de news qui envoie " +
          "les infos du matin, un client de messagerie qui prévient d'un nouveau message… " +
          "Il pousse un message JSON authentifié sur POST /api/sources/<nom>/messages. " +
          "C'est VOUS qui décidez, ici, dans quel fil ses messages arrivent : un programme " +
          "extérieur ne peut jamais désigner un fil lui-même.",
      }),
      h("p", {
        class: "config-helper",
        text:
          "Les messages reçus n'apparaissent PAS dans une conversation : ils s'empilent " +
          "dans la section « Notifications » de la page de discussion, avec l'état " +
          "(reçu / traité / en échec), le contenu replié et la réponse de Yuki à côté.",
      }),
      errorEl,
      listEl,
      statusEl,
      tokenEl,
    ]),
  );

  void load();

  return { refresh: () => load() };
}
