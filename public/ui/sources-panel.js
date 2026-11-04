/**
 * Panneau « Sources » de la page `/config` — programmes autorisés à réveiller Yuki.
 *
 * Une source = un `nom` + un `jeton` (coffre) + un réglage CENTRAL :
 *   - VISIBILITÉ « visibilite » :
 *       · `silencieux` (DÉFAUT) — le contenu reçu n'apparaît NULLE PART (ni bulle,
 *         ni notification, ni pastille) ; si Yuki n'a rien à dire elle répond
 *         exactement `RIEN` et rien n'est publié ; sinon seul son RÉSULTAT
 *         apparaît dans le fil unique « Déclencheurs ». La destination et la
 *         notification sont alors SANS OBJET (masquées ici) ;
 *       · `visible` — le message part dans un fil choisi, comme au lot 17.
 *   - OÙ       « destination » (mode `visible` seulement) : un fil DÉSIGNÉ choisi
 *              dans la liste des conversations, le fil dédié de la source
 *              (`Source — <nom>`, créé au premier message), « nouvelle
 *              conversation à chaque fois », ou la conversation ouverte. ⚠️ Tant
 *              que RIEN n'est choisi (`aucune`), la source ne démarre aucun tour ;
 *   - TOUR     « lancer » ou « stocker » (mode `visible` seulement) ;
 *   - NOTIFIER « notifier » : Web Push (mode `visible` seulement ; forcé à `false`
 *              en silencieux).
 * Plus une CONSIGNE libre (« si rien d'anormal, ne dis rien ») — c'est du TEXTE,
 * pas un mode codé.
 *
 * ⚠️ LOT 2 — MOTEUR HORLOGE : le TYPE de déclencheur (`webhook` ou `planning`).
 * En `planning`, l'interface demande l'EXPRESSION CRON (5 champs), le FUSEAU du
 * déclencheur et affiche un APERÇU du prochain passage (route
 * `GET /api/sources/apercu`) : une expression fausse se voit tout de suite. S'y
 * ajoutent l'interrupteur `actif`, le chevauchement, le rattrapage, le plafond
 * d'exécution et le garde-fou quotidien. La liste montre l'expression, le
 * prochain passage et la raison d'une mise en veille.
 *
 * Routes utilisées (aucune dépendance nouvelle) :
 *   GET    /api/sources               → liste (aucun jeton, seulement « défini »)
 *   GET    /api/sources/journal?…     → journal BORNÉ (limite, type, source)
 *   GET    /api/sources/apercu?…      → aperçu cron (expression, fuseau)
 *   POST   /api/sources               → création            (garde `X-Yuki-Config: 1`)
 *   PATCH  /api/sources/<nom>         → réglages            (même garde)
 *   DELETE /api/sources/<nom>         → suppression + jeton (même garde)
 *   POST   /api/sources/<nom>/jeton   → jeton ⚠️ affiché UNE SEULE FOIS
 *
 * ⚠️ LOT 3 — LA PAGE DE GESTION (onglet `/config#declencheurs`) :
 *  ① TROIS sections — Permanents / Temporaires / En sommeil (voir
 *    `declencheurs-vue.js`, qui porte les RÈGLES et se teste sans navigateur) ;
 *  ② colonnes — nom · quand (expression + PROCHAIN passage) · ⚠️ DERNIER PASSAGE ·
 *    dernier résultat (résumé + lien journal) · état · pré-autorisations actives ·
 *    tours du jour / plafond · jetons cumulés ;
 *  ③ un 4ᵉ volet REPLIÉ, le JOURNAL : réceptions (contenu borné 8 000 côté
 *    serveur, 400 caractères à l'affichage), silences/publications, échecs,
 *    sauts, plafonds, désactivations, et — réservé au lot 4 — les
 *    pré-autorisations consommées (colonne et filtre DÉJÀ en place) ;
 *  ④ il vit dans l'onglet DÉDIÉ « Déclencheurs », avec l'ancre `#declencheurs`
 *    (`ANCRES_PROFONDES` de `config.js`) — c'était introuvable en bas de
 *    « Conversation ».
 *
 * ⚠️ CSP stricte (`style-src 'self'`) : aucun `innerHTML`, aucun attribut `style`,
 * tout le CSS vit dans `config.css` ; le DOM est bâti avec `createElement`/`textContent`.
 */

import { formatDateTimeFr } from "./horodatage.js";
import {
  ANCRE_ENVOIS_PROGRAMMES,
  ANCRE_JOURNAL,
  ANCRE_PREAUTORISATIONS,
  EVENEMENTS_JOURNAL,
  JOURNAL_LIMITE,
  JOURNAL_LIMITE_MAX,
  grouperParSection,
  lienJournal,
  resumerEvenement,
  texteDernierPassage,
  texteDernierResultat,
  texteEtat,
  texteJetons,
  texteJournalBorne,
  textePreAutorisations,
  texteQuand,
  texteTours,
  filtrerJournal,
  envoiAnnulable,
  libelleEtatEnvoi,
  texteCibleEnvoi,
  texteCompteEnvois,
  texteQuandEnvoi,
  texteResumeEnvoi,
  trierEnvois,
} from "./declencheurs-vue.js";
import {
  DUREE_DEFAUT_JOURS,
  DUREE_MAX_JOURS,
  MOTIF_PERSONNALISE,
  PORTEES,
  erreurMotif,
  expirationDepuis,
  expirationProche,
  libelleAgent,
  phraseRisque,
  texteCompteEtats,
  texteConsommations,
  texteCouverture,
  texteEcheance,
} from "./preautorisations-vue.js";

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
const VISIBILITES = [
  ["silencieux", "Silencieux — le contenu reçu n'apparaît pas, seul le résultat"],
  ["visible", "Visible — le message part dans un fil choisi"],
];

/**
 * TYPES de déclencheur (lot 2, moteur horloge).
 *  - `webhook` : un programme extérieur pousse un message (authentifié par jeton) ;
 *  - `planning` : l'HORLOGE de Yuki réveille le modèle selon une expression cron à
 *    5 champs, évaluée dans le fuseau DU DÉCLENCHEUR (`Europe/Paris` par défaut).
 */
const DECLENCHEURS = [
  ["webhook", "Programme extérieur (webhook, jeton)"],
  ["planning", "Planning (horloge, expression cron)"],
];

/** Que faire si un passage arrive pendant qu'un tour tourne encore. */
const CHEVAUCHEMENTS = [
  ["sauter", "Sauter le passage (défaut)"],
  ["remplacer", "Remplacer : abandonner le tour en cours"],
];

/** Que faire d'un passage manqué (processus arrêté…). */
const RATTRAPAGES = [
  ["rattraper", "Rattraper une seule fois si le retard < 1 h (défaut)"],
  ["sauter", "Ne jamais rattraper"],
];

/**
 * Minutes saisies → millisecondes. Une saisie vide ou illisible retombe sur le
 * DÉFAUT (10 min) : le serveur refuse de toute façon hors bornes, mais on ne lui
 * envoie pas « 0 » par accident.
 */
function minutesDe(valeur) {
  const minutes = Number(valeur);
  return Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60000) : 600000;
}

/** Entier saisi (repli sur le défaut quand la saisie est vide ou illisible). */
function entierDe(valeur, defaut) {
  const nombre = Number(valeur);
  return Number.isFinite(nombre) && nombre > 0 ? Math.round(nombre) : defaut;
}

/** Vrai si la visibilité cache la destination et la notification. */
function estSilencieux(visibilite) {
  return (visibilite ?? "silencieux") !== "visible";
}

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

/** Horodatage lisible — fuseau `ui.timeZone` (défaut UTC), suffixé, jamais celui du navigateur. */
function formatDate(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return formatDateTimeFr(date);
}

function apiMessage(error, fallback) {
  const data = error?.data ?? {};
  return data.message ?? data.error ?? error?.message ?? fallback;
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
function sourceForm({
  nom,
  consigne,
  visibilite,
  destination,
  tour,
  notifier,
  nomReadonly,
  conversations = [],
  declencheur,
  chevauchement,
  rattrapage,
  plafondMs,
  maxToursParJour,
  actif,
  onApercu,
}) {
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
  const current = destination ?? "aucune";
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

  // ── VISIBILITÉ : le réglage qui COMMANDE tout le reste ──────────────────
  const visibiliteSelect = h("select", {
    class: "config-select",
    id: "source-visibilite",
    "aria-label": "Visibilité de la sortie",
  });
  const visibiliteCourante = visibilite ?? "silencieux";
  for (const [value, text] of VISIBILITES) {
    const option = h("option", { value, text });
    if (visibiliteCourante === value) option.selected = true;
    visibiliteSelect.append(option);
  }
  const visibiliteLabel = h("label", {
    class: "config-label",
    for: "source-visibilite",
    text: "Visibilité de la sortie",
  });
  const visibiliteHelper = h("p", {
    class: "config-helper",
    text:
      "« Silencieux » : le contenu reçu n'apparaît NULLE PART (ni bulle, ni notification, " +
      "ni pastille). Si Yuki n'a rien à dire, elle répond exactement RIEN et rien n'est " +
      "publié ; sinon seul son RÉSULTAT apparaît dans le fil unique « Déclencheurs ». " +
      "« Visible » : le message part dans un fil que VOUS choisissez (comportement " +
      "historique), avec notification si vous l'avez cochée.",
  });

  // Les réglages de DESTINATION / TOUR / NOTIFICATION n'ont de sens qu'en mode
  // VISIBLE : en silencieux ils sont masqués ET désactivés (aucune valeur trompeuse).
  const destinationFieldLabel = h("label", {
    class: "config-label",
    for: "source-conversation",
    text: "Envoyer dans :",
  });
  const destinationHelper = h("p", {
    class: "config-helper",
    text:
      "⚠️ Tant qu'aucune destination n'est choisie, la source ne démarre AUCUN tour : " +
      "ses messages attendent dans les notifications. « Fil dédié » crée un fil à son " +
      "nom (Source — …) au premier message ; « Nouvelle conversation à chaque fois » en " +
      "crée un neuf pour chaque message. Ces fils sont NORMAUX : ils apparaissent dans " +
      "la liste des conversations.",
  });
  const tourLabel = h("label", {
    class: "config-label",
    for: "source-tour",
    text: "Ce que le message déclenche",
  });
  const tourHelper = h("p", {
    class: "config-helper",
    text:
      "« Stocker » n'interrompt jamais Yuki : le message est transmis en UN SEUL bloc " +
      "au début de son prochain tour. « Lancer un tour » démarre une réponse TOUT DE " +
      "SUITE, dans la destination choisie ci-dessus (la réponse reste attachée à " +
      "l'entrée de la boîte de notifications).",
  });
  const notifierLabel = h("label", { class: "config-label source-form__check" }, [
    notifierInput,
    h("span", { text: " Notifier cet appareil (Web Push) à chaque message" }),
  ]);
  const reglagesVisibles = [
    destinationFieldLabel,
    destinationHelper,
    tourLabel,
    tourHelper,
    notifierLabel,
  ];

  /** Masque/désactive les réglages sans objet quand la sortie est SILENCIEUSE. */
  function syncVisibilite() {
    const silencieux = estSilencieux(visibiliteSelect.value);
    for (const el of reglagesVisibles) el.hidden = silencieux;
    // Le sélecteur lui-même est hors de `reglagesVisibles` (il est inséré entre
    // son libellé et son aide) : on le masque explicitement.
    conversationSelect.hidden = silencieux;
    conversationSelect.disabled = silencieux;
    tourSelect.disabled = silencieux;
    notifierInput.disabled = silencieux;
  }
  visibiliteSelect.addEventListener("change", syncVisibilite);

  // ── MOTEUR HORLOGE : type de déclencheur + expression cron + fuseau ─────
  const declencheurCourant = declencheur ?? { type: "webhook" };
  const declencheurSelect = h("select", {
    class: "config-select",
    id: "source-declencheur",
    "aria-label": "Type de déclencheur",
  });
  for (const [value, text] of DECLENCHEURS) {
    const option = h("option", { value, text });
    if (declencheurCourant.type === value) option.selected = true;
    declencheurSelect.append(option);
  }
  const declencheurLabel = h("label", {
    class: "config-label",
    for: "source-declencheur",
    text: "Type de déclencheur",
  });
  const declencheurHelper = h("p", {
    class: "config-helper",
    text:
      "« Programme extérieur » : le programme pousse un message authentifié par son " +
      "jeton. « Planning » : c'est Yuki qui se réveille toute seule, selon l'expression " +
      "cron ci-dessous.",
  });

  const expressionInput = h("input", {
    class: "config-input",
    type: "text",
    id: "source-expression",
    autocomplete: "off",
    spellcheck: "false",
    placeholder: "ex. 0 9 * * 1-5",
    value: declencheurCourant.expression ?? "",
    "aria-label": "Expression cron (5 champs)",
  });
  const expressionLabel = h("label", {
    class: "config-label",
    for: "source-expression",
    text: "Expression cron (5 champs : minute heure jour-du-mois mois jour-de-semaine)",
  });
  const expressionHelper = h("p", {
    class: "config-helper",
    text:
      "« * », « a », « a-b », « a-b/n », « */n » et les listes « a,b,c ». Exemple " +
      "« 0 9 * * 1-5 » = 9 h du lundi au vendredi. ⚠️ Un jour-du-mois ET un " +
      "jour-de-semaine donnés ENSEMBLE se combinent en OU (comme cron). « L », « # », " +
      "« ? » et « @reboot » ne sont pas supportés.",
  });
  const fuseauInput = h("input", {
    class: "config-input",
    type: "text",
    id: "source-fuseau",
    autocomplete: "off",
    spellcheck: "false",
    placeholder: "Europe/Paris",
    value: declencheurCourant.fuseau ?? "Europe/Paris",
    "aria-label": "Fuseau horaire du déclencheur",
  });
  const fuseauLabel = h("label", {
    class: "config-label",
    for: "source-fuseau",
    text: "Fuseau horaire (nom IANA)",
  });
  const fuseauHelper = h("p", {
    class: "config-helper",
    text:
      "L'expression est évaluée dans CE fuseau, jamais celui du serveur (un conteneur " +
      "est en UTC : « 0 9 * * * » en Europe/Paris tire à 9 h à Paris, pas à 9 h UTC).",
  });
  const apercuEl = h("p", {
    class: "config-helper",
    id: "source-apercu",
    role: "status",
    text: "Aperçu : renseignez l'expression, puis cliquez sur « Aperçu du prochain passage ».",
  });
  const apercuBtn = h("button", {
    class: "button button--ghost button--small",
    type: "button",
    text: "Aperçu du prochain passage",
    on: () => void rafraichirApercu(),
  });
  const apercuActions = h("div", { class: "config-actions" }, [apercuBtn]);

  /** Demande l'aperçu au serveur : une expression fausse se voit TOUT DE SUITE. */
  async function rafraichirApercu() {
    if (typeof onApercu !== "function") return;
    apercuEl.textContent = "Calcul en cours…";
    try {
      const data = await onApercu(expressionInput.value, fuseauInput.value);
      if (Array.isArray(data?.passages) && data.passages.length > 0) {
        const dates = data.passages.map((iso) => formatDate(iso)).join(" · ");
        apercuEl.textContent = `Prochains passages (${data.fuseau}) : ${dates}`;
      } else {
        apercuEl.textContent = data?.raison ?? "Aucun prochain passage calculable.";
      }
    } catch (error) {
      apercuEl.textContent = apiMessage(error, "Impossible de calculer le prochain passage.");
    }
  }

  const actifInput = h("input", {
    class: "config-checkbox",
    type: "checkbox",
    id: "source-actif",
  });
  actifInput.checked = actif !== false;
  const actifLabel = h("label", { class: "config-label source-form__check" }, [
    actifInput,
    h("span", { text: " Déclencheur actif (décochez pour le mettre en veille)" }),
  ]);

  const chevauchementSelect = h("select", {
    class: "config-select",
    id: "source-chevauchement",
    "aria-label": "Conduite en cas de chevauchement",
  });
  for (const [value, text] of CHEVAUCHEMENTS) {
    const option = h("option", { value, text });
    if ((chevauchement ?? "sauter") === value) option.selected = true;
    chevauchementSelect.append(option);
  }
  const chevauchementLabel = h("label", {
    class: "config-label",
    for: "source-chevauchement",
    text: "Si un passage arrive pendant qu'un tour tourne encore",
  });

  const rattrapageSelect = h("select", {
    class: "config-select",
    id: "source-rattrapage",
    "aria-label": "Conduite sur un passage manqué",
  });
  for (const [value, text] of RATTRAPAGES) {
    const option = h("option", { value, text });
    if ((rattrapage ?? "rattraper") === value) option.selected = true;
    rattrapageSelect.append(option);
  }
  const rattrapageLabel = h("label", {
    class: "config-label",
    for: "source-rattrapage",
    text: "Passage manqué (arrêt, redémarrage)",
  });
  const rattrapageHelper = h("p", {
    class: "config-helper",
    text:
      "Au-delà d'une heure de retard, le passage est SAUTÉ et journalisé (un " +
      "rattrapage tardif n'aurait plus de sens).",
  });

  const plafondInput = h("input", {
    class: "config-input",
    type: "number",
    id: "source-plafond",
    min: "1",
    max: "120",
    step: "1",
    value: String(Math.round((plafondMs ?? 600000) / 60000)),
    "aria-label": "Plafond d'exécution d'un tour (minutes)",
  });
  const plafondLabel = h("label", {
    class: "config-label",
    for: "source-plafond",
    text: "Plafond d'exécution d'un tour (minutes, 1 à 120)",
  });
  const plafondHelper = h("p", {
    class: "config-helper",
    text:
      "Au-delà, le tour est ARRÊTÉ et l'événement est journalisé : c'est ce plafond " +
      "qui protège des blocages, pas le chevauchement.",
  });

  const maxToursInput = h("input", {
    class: "config-input",
    type: "number",
    id: "source-max-tours",
    min: "1",
    max: "1000",
    step: "1",
    value: String(maxToursParJour ?? 200),
    "aria-label": "Nombre maximal de tours par jour",
  });
  const maxToursLabel = h("label", {
    class: "config-label",
    for: "source-max-tours",
    text: "Nombre maximal de tours par jour (garde-fou)",
  });
  const maxToursHelper = h("p", {
    class: "config-helper",
    text:
      "Au-delà, le déclencheur est MIS EN VEILLE avec une raison visible : une " +
      "expression trop large ne peut pas emballer la machine.",
  });

  const reglagesPlanning = [
    expressionLabel,
    expressionInput,
    expressionHelper,
    fuseauLabel,
    fuseauInput,
    fuseauHelper,
    apercuActions,
    apercuEl,
    actifLabel,
    chevauchementLabel,
    chevauchementSelect,
    rattrapageLabel,
    rattrapageSelect,
    rattrapageHelper,
    plafondLabel,
    plafondInput,
    plafondHelper,
    maxToursLabel,
    maxToursInput,
    maxToursHelper,
  ];

  /** Masque/désactive les réglages d'horloge quand le type est `webhook`. */
  function syncDeclencheur() {
    const planifie = declencheurSelect.value === "planning";
    for (const el of reglagesPlanning) el.hidden = !planifie;
  }
  declencheurSelect.addEventListener("change", syncDeclencheur);

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
        "Yuki, jointe à chaque message de cette source. En mode silencieux, c'est elle " +
        "qui décide de ce qui mérite d'être publié.",
    }),
    visibiliteLabel,
    visibiliteSelect,
    visibiliteHelper,
    ...reglagesVisibles.slice(0, 1),
    conversationSelect,
    ...reglagesVisibles.slice(1),
    declencheurLabel,
    declencheurSelect,
    declencheurHelper,
    ...reglagesPlanning,
  ]);
  syncVisibilite();
  syncDeclencheur();
  return {
    form,
    values: () => ({
      nom: nomInput.value.trim(),
      consigne: consigneInput.value,
      visibilite: visibiliteSelect.value,
      destination: conversationSelect.value,
      tour: tourSelect.value,
      notifier: notifierInput.checked,
      // ⚠️ Le type de déclencheur est TOUJOURS envoyé (jamais déduit du silence) :
      // le serveur valide l'expression et le fuseau, et refuse avec la raison.
      declencheur:
        declencheurSelect.value === "planning"
          ? {
              type: "planning",
              expression: expressionInput.value.trim(),
              fuseau: fuseauInput.value.trim(),
            }
          : { type: "webhook" },
      chevauchement: chevauchementSelect.value,
      rattrapage: rattrapageSelect.value,
      plafondMs: minutesDe(plafondInput.value),
      maxToursParJour: entierDe(maxToursInput.value, 200),
      actif: actifInput.checked,
    }),
  };
}

export function initSourcesPanel({ root, HolafFetch, HolafModal }) {
  const state = {
    sources: [],
    conversations: [],
    error: "",
    status: "",
    busy: false,
    /** Journal BORNÉ : jamais tout le fichier (limite ≤ `JOURNAL_LIMITE_MAX`). */
    journal: [],
    journalLimite: JOURNAL_LIMITE,
    journalFiltre: { type: "tous", source: "" },
    journalErreur: "",
    /** PRÉ-AUTORISATIONS (lot 4/4) : registre, catalogue de motifs, machines. */
    preAutorisations: [],
    preAutorisationsErreur: "",
    motifs: [],
    agents: [],
    /** ENVOIS PROGRAMMÉS (lot 28) : liste, bornes du serveur, erreur de lecture. */
    envois: [],
    envoisBornes: {},
    envoisErreur: "",
  };

  const errorEl = h("p", { class: "config-error", hidden: true, role: "alert" });
  const statusEl = h("p", { class: "config-save-status", role: "status" });
  /** Les TROIS sections (permanents / temporaires / sommeil). */
  const sectionsEl = h("div", { class: "declencheurs-sections" });
  /** Le 4ᵉ volet : le journal des déclencheurs, REPLIÉ par défaut. */
  const journalListeEl = h("div", { class: "declencheurs-journal__liste" });
  const journalEtatEl = h("p", { class: "config-helper", role: "status" });
  const tokenEl = h("div", { class: "source-token", hidden: true, role: "status" });

  /**
   * Aperçu du prochain passage (route gardée `GET /api/sources/apercu`).
   * ⚠️ C'est le garde-fou de saisie : une expression fausse (ou impossible, comme
   * « 0 0 31 2 * ») se voit tout de suite, avec la raison en français.
   */
  async function demanderApercu(expression, fuseau) {
    const params = new URLSearchParams({
      expression: String(expression ?? ""),
      fuseau: String(fuseau ?? ""),
    });
    return HolafFetch.get(`/api/sources/apercu?${params.toString()}`, { headers: JSON_HEADERS });
  }

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
    const fields = sourceForm({
      // ⚠️ Une source NEUVE est SILENCIEUSE par défaut (modèle v2).
      visibilite: "silencieux",
      conversations: state.conversations,
      onApercu: demanderApercu,
    });
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
      // ⚠️ Les réglages de sortie sont REPRIS tels quels : sans `visibilite` ni
      // `destination`, le formulaire afficherait « silencieux » pour une source
      // visible et le premier enregistrement la ferait changer de mode en silence.
      visibilite: source.visibilite,
      destination: source.destination,
      tour: source.tour,
      notifier: source.notifier,
      // MOTEUR HORLOGE (lot 2).
      declencheur: source.declencheur,
      chevauchement: source.chevauchement,
      rattrapage: source.rattrapage,
      plafondMs: source.plafondMs,
      maxToursParJour: source.maxToursParJour,
      actif: source.actif,
      nomReadonly: true,
      conversations: state.conversations,
      onApercu: demanderApercu,
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
            visibilite: values.visibilite,
            destination: values.destination,
            tour: values.tour,
            notifier: values.notifier,
            // ⚠️ MOTEUR HORLOGE : le type, l'expression et le fuseau sont envoyés
            // ensemble — le serveur refuse une expression invalide avec la raison.
            declencheur: values.declencheur,
            chevauchement: values.chevauchement,
            rattrapage: values.rattrapage,
            plafondMs: values.plafondMs,
            maxToursParJour: values.maxToursParJour,
            actif: values.actif,
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

  /** Résumé lisible des réglages de destination : sans objet en silencieux. */
  function destinationCell(source) {
    if (estSilencieux(source.visibilite)) {
      return "fil « Déclencheurs » (seul le résultat publié)";
    }
    return destinationLabel(source.destination, state.conversations);
  }

  /** Note sous le NOM : visibilité + destination (aucune colonne de plus). */
  function noteSousNom(source) {
    const visibilite = estSilencieux(source.visibilite) ? "silencieux" : "visible";
    return `${visibilite} · ${destinationCell(source)}`;
  }

  /** Ouvre le volet journal, filtré sur une source (lien « journal » d'une ligne). */
  function ouvrirJournal(source) {
    state.journalFiltre = { type: "tous", source: typeof source === "string" ? source : "" };
    if (journalTypeSelect) journalTypeSelect.value = "tous";
    journalSourceInput.value = state.journalFiltre.source;
    journalDetails.open = true;
    void loadJournal();
  }

  function buildRow(source) {
    return h("tr", { class: "sources-table__row declencheurs-row" }, [
      h("th", { class: "sources-table__name", scope: "row" }, [
        h("span", { class: "declencheurs-nom", text: source.nom }),
        h("span", { class: "declencheurs-nom__note", text: noteSousNom(source) }),
      ]),
      // « Quand » : expression lisible ET prochain passage (jamais l'un sans l'autre).
      h("td", { class: "declencheurs-quand", text: texteQuand(source) }),
      // ⚠️ LA colonne critique : sans elle, une source muette depuis 3 jours est
      // indistinguable d'une source qui travaille.
      h("td", { class: "declencheurs-dernier-passage", text: texteDernierPassage(source) }),
      h("td", { class: "declencheurs-resultat" }, [
        h("span", { class: "declencheurs-resultat__texte", text: texteDernierResultat(source) }),
        h(
          "a",
          {
            class: "declencheurs-resultat__lien",
            href: lienJournal(source.nom).href,
            text: "journal",
            on: () => ouvrirJournal(source.nom),
          },
          [],
        ),
      ]),
      h("td", { class: "declencheurs-etat", text: texteEtat(source) }),
      // ⚠️ Toujours présente : au lot 3 elle dit « aucune » (le moteur les consomme
      // au lot 4). Une case muette ferait croire à un défaut d'affichage.
      h("td", { class: "declencheurs-preauth", text: textePreAutorisations(source) }),
      h("td", { class: "declencheurs-tours", text: texteTours(source) }),
      h("td", { class: "declencheurs-jetons", text: texteJetons(source) }),
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

  /** En-tête du tableau — les COLONNES demandées, dans l'ordre demandé. */
  function enteteTableau() {
    return h("thead", {}, [
      h("tr", {}, [
        h("th", { scope: "col", text: "Nom" }),
        h("th", { scope: "col", text: "Quand (expression · prochain passage)" }),
        h("th", { scope: "col", text: "Dernier passage" }),
        h("th", { scope: "col", text: "Dernier résultat" }),
        h("th", { scope: "col", text: "État" }),
        h("th", { scope: "col", text: "Pré-autorisations actives" }),
        h("th", { scope: "col", text: "Tours aujourd'hui / plafond" }),
        h("th", { scope: "col", text: "Jetons cumulés" }),
        h("th", { scope: "col", text: "Actions" }),
      ]),
    ]);
  }

  /** Les TROIS sections — toujours rendues, même vides (aucune disparition muette). */
  function renderSections() {
    sectionsEl.textContent = "";
    for (const groupe of grouperParSection(state.sources)) {
      const section = h(
        "section",
        { class: `config-group declencheurs-section declencheurs-section--${groupe.id}` },
        [
          h("div", { class: "config-group__head" }, [
            h("h3", {
              class: "config-group__title declencheurs-section__title",
              text: `${groupe.titre} (${groupe.sources.length})`,
            }),
          ]),
          h("p", { class: "config-helper", text: groupe.aide }),
          groupe.sources.length === 0
            ? h("p", {
                class: "declencheurs-vide",
                text: "Aucun déclencheur dans cette section.",
              })
            : h("table", { class: `sources-table declencheurs-table declencheurs-table--${groupe.id}` }, [
                enteteTableau(),
                h("tbody", {}, groupe.sources.map(buildRow)),
              ]),
        ],
      );
      sectionsEl.append(section);
    }
  }

  /** Journal BORNÉ et FILTRABLE (⚠️ jamais tout le fichier d'un coup). */
  function renderJournal() {
    journalListeEl.textContent = "";
    const visibles = filtrerJournal(state.journal, state.journalFiltre);
    journalEtatEl.textContent =
      state.journalErreur !== ""
        ? state.journalErreur
        : `${visibles.length} événement(s) affiché(s) sur ${state.journal.length} lu(s) ` +
          `(les ${state.journalLimite} plus récents au maximum).`;
    if (visibles.length === 0) {
      journalListeEl.append(
        h("p", {
          class: "config-helper",
          text:
            "Aucun événement pour ce filtre. Le journal ne garde que 30 jours et ne " +
            "recopie jamais plus de 8 000 caractères d'un contenu reçu.",
        }),
      );
      return;
    }
    journalListeEl.append(
      h(
        "ul",
        { class: "declencheurs-journal__items" },
        visibles.map((evenement) =>
          h("li", { class: `declencheurs-journal__item declencheurs-journal__item--${evenement.event}` }, [
            h("span", { class: "declencheurs-journal__resume", text: resumerEvenement(evenement) }),
            ...(typeof evenement.texte === "string" && evenement.texte !== ""
              ? [
                  h("span", {
                    class: "declencheurs-journal__texte",
                    text: texteJournalBorne(evenement.texte),
                  }),
                ]
              : []),
            ...(evenement.tronque === true
              ? [
                  h("span", {
                    class: "declencheurs-journal__tronque",
                    text: "⚠️ contenu tronqué à 8 000 caractères dans le journal",
                  }),
                ]
              : []),
          ]),
        ),
      ),
    );
  }

  async function loadJournal() {
    const params = new URLSearchParams({ limite: String(state.journalLimite) });
    if (state.journalFiltre.type !== "tous") params.set("type", state.journalFiltre.type);
    if (state.journalFiltre.source !== "") params.set("source", state.journalFiltre.source);
    journalEtatEl.textContent = "Lecture du journal…";
    try {
      const data = await HolafFetch.get(`/api/sources/journal?${params.toString()}`, {
        headers: JSON_HEADERS,
      });
      state.journal = Array.isArray(data?.evenements) ? data.evenements : [];
      state.journalErreur = "";
    } catch (error) {
      state.journal = [];
      state.journalErreur = apiMessage(error, "Impossible de lire le journal des déclencheurs.");
    }
    renderJournal();
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
    renderSections();
    // Le volet journal ne se charge QUE s'il est ouvert (aucune requête inutile).
    if (journalDetails.open) await loadJournal();
    // Les PRÉ-AUTORISATIONS sont chargées d'office : leur bandeau d'état est
    // visible dans la section repliée, et une liste vide doit s'y lire.
    await chargerPreAutorisations();
    // ENVOIS PROGRAMMÉS : chargés d'office — le compteur « N en attente » est visible
    // dans la section repliée, et c'est lui qui prévient qu'un message va partir.
    await chargerEnvois();
  }

  // ── ⑤ PRÉ-AUTORISATIONS (lot 26, lot 4/4) ─────────────────────────────────
  //
  // ⚠️ CE QU'ON DÉCLARE ICI : « cette tâche de fond pourra exécuter CES
  // commandes sur CETTE machine, SANS validation ». C'est pourquoi la page
  // affiche une phrase de risque AVANT l'envoi, propose une LISTE de motifs (le
  // catalogue vient du serveur) et n'ouvre la saisie libre que sur un choix
  // explicite. Révocation et compteur de consommations sont sur chaque ligne.
  const preauthListeEl = h("div", { class: "declencheurs-journal__liste" });
  const preauthEtatEl = h("p", { class: "config-helper", role: "status" });

  async function chargerPreAutorisations() {
    try {
      const data = await HolafFetch.get("/api/sources/preautorisations", {
        headers: JSON_HEADERS,
      });
      state.preAutorisations = Array.isArray(data?.preAutorisations) ? data.preAutorisations : [];
      state.motifs = Array.isArray(data?.motifs) ? data.motifs : [];
      state.agents = Array.isArray(data?.agents) ? data.agents : [];
      state.preAutorisationsErreur = "";
    } catch (error) {
      state.preAutorisations = [];
      state.preAutorisationsErreur = apiMessage(
        error,
        "Impossible de lire les pré-autorisations.",
      );
    }
    renderPreAutorisations();
  }

  /** Tableau des autorisations : état, consommations, échéance, révocation. */
  function renderPreAutorisations() {
    preauthListeEl.textContent = "";
    preauthEtatEl.textContent =
      state.preAutorisationsErreur !== ""
        ? state.preAutorisationsErreur
        : texteCompteEtats(state.preAutorisations);
    if (state.preAutorisations.length === 0) {
      preauthListeEl.append(
        h("p", {
          class: "config-helper",
          text:
            "Aucune pré-autorisation. Sans elles, une commande demandée par un " +
            "déclencheur attend une validation humaine… qui n'arrive jamais à 3 h du " +
            "matin, et la demande expire en 5 minutes.",
        }),
      );
      return;
    }
    preauthListeEl.append(
      h("table", { class: "sources-table declencheurs-table preauth-table" }, [
        h("thead", {}, [
          h("tr", {}, [
            h("th", { scope: "col", text: "Déclencheur" }),
            h("th", { scope: "col", text: "Machine" }),
            h("th", { scope: "col", text: "Ce qui est autorisé" }),
            h("th", { scope: "col", text: "Destructeur" }),
            h("th", { scope: "col", text: "État" }),
            h("th", { scope: "col", text: "Consommations" }),
            h("th", { scope: "col", text: "Expire" }),
            h("th", { scope: "col", text: "Action" }),
          ]),
        ]),
        h(
          "tbody",
          {},
          state.preAutorisations.map((pre) =>
            h("tr", { class: `preauth-row preauth-row--${pre.etat}` }, [
              h("th", { class: "sources-table__name", scope: "row", text: pre.declencheur }),
              h("td", { text: pre.agentNom ?? pre.agentId }),
              h("td", { text: texteCouverture(pre) }),
              h("td", { text: pre.destructifAutorise === true ? "oui (assumé)" : "non" }),
              h("td", {
                text:
                  pre.etat === "active" && expirationProche(pre)
                    ? `${pre.etat} — expire bientôt`
                    : pre.etat,
              }),
              h("td", { text: texteConsommations(pre) }),
              h("td", { text: texteEcheance(pre) }),
              h("td", { class: "sources-table__actions" }, [
                ...(pre.etat === "active"
                  ? [
                      h("button", {
                        class: "button button--danger button--small",
                        type: "button",
                        text: "Révoquer",
                        on: () => void revoquerPreAutorisation(pre),
                      }),
                    ]
                  : []),
                ...(pre.etat === "active"
                  ? []
                  : [
                      h("span", {
                        class: "config-helper",
                        text:
                          pre.revoqueeRaison !== undefined
                            ? `révoquée : ${pre.revoqueeRaison}`
                            : "à recréer si la tâche doit encore agir",
                      }),
                    ]),
              ]),
            ]),
          ),
        ),
      ]),
    );
  }

  /** Révocation : confirmation EXPLICITE par `HolafModal` (jamais la boîte native). */
  async function revoquerPreAutorisation(pre) {
    const confirme = await HolafModal.confirm(
      `Révoquer la pré-autorisation de « ${pre.declencheur} » ?`,
      `La tâche de fond ne pourra plus exécuter ${texteCouverture(pre)} sur cette ` +
        "machine. Si elle essaie, la commande attendra une validation humaine et " +
        "expirera : elle ne sera pas exécutée.",
      { danger: true, confirmText: "Révoquer" },
    );
    if (!confirme) return;
    await act("Pré-autorisation révoquée.", async () => {
      await HolafFetch.delete(`/api/sources/preautorisations/${encodeURIComponent(pre.id)}`, {
        headers: WRITE_HEADERS,
      });
    });
  }

  /** Formulaire de création (liste de motifs proposée + risque affiché). */
  function ouvrirCreationPreAutorisation() {
    const sources = state.sources;
    const agents = state.agents.filter((agent) => agent.revoked !== true);

    const declencheurSelect = h("select", {
      class: "config-select",
      id: "preauth-declencheur",
      "aria-label": "Déclencheur concerné",
    });
    for (const source of sources) {
      declencheurSelect.append(h("option", { value: source.nom, text: source.nom }));
    }
    const agentSelect = h("select", {
      class: "config-select",
      id: "preauth-agent",
      "aria-label": "Machine concernée",
    });
    for (const agent of agents) {
      agentSelect.append(h("option", { value: agent.agentId, text: libelleAgent(agent) }));
    }
    const motifSelect = h("select", {
      class: "config-select",
      id: "preauth-motif",
      "aria-label": "Motif proposé",
    });
    for (const motif of state.motifs) {
      motifSelect.append(
        h("option", {
          value: motif.id,
          text: `${motif.libelle} — ${motif.motif}${motif.portee === "prefixe" ? "…" : ""}`,
        }),
      );
    }
    motifSelect.append(
      h("option", {
        value: MOTIF_PERSONNALISE,
        text: "Autre commande (saisie manuelle — à vos risques)",
      }),
    );
    const motifInput = h("input", {
      class: "config-input",
      type: "text",
      id: "preauth-motif-libre",
      autocomplete: "off",
      spellcheck: "false",
      placeholder: "ex. systemctl restart nginx",
      "aria-label": "Commande exacte ou préfixe",
    });
    const porteeSelect = h("select", {
      class: "config-select",
      id: "preauth-portee",
      "aria-label": "Portée du motif",
    });
    for (const [value, text] of PORTEES) {
      porteeSelect.append(h("option", { value, text }));
    }
    const destructifInput = h("input", {
      type: "checkbox",
      id: "preauth-destructif",
    });
    const dureeInput = h("input", {
      class: "config-input",
      type: "number",
      id: "preauth-duree",
      min: "1",
      max: String(DUREE_MAX_JOURS),
      step: "1",
      value: String(DUREE_DEFAUT_JOURS),
      "aria-label": "Durée de validité en jours",
    });
    const risqueEl = h("p", { class: "preauth-risque", role: "note" });
    const erreurEl = h("p", { class: "config-error", role: "alert" });
    erreurEl.hidden = true;

    const personnel = h("div", { class: "preauth-personnel", hidden: true }, [
      h("label", { class: "config-label", for: "preauth-motif-libre", text: "Commande à autoriser" }),
      motifInput,
      h("label", { class: "config-label", for: "preauth-portee", text: "Portée du motif" }),
      porteeSelect,
    ]);

    const motifCourant = () => {
      if (motifSelect.value !== MOTIF_PERSONNALISE) {
        const trouve = state.motifs.find((motif) => motif.id === motifSelect.value);
        if (trouve) return { motif: trouve.motif, portee: trouve.portee };
      }
      return { motif: motifInput.value.trim(), portee: porteeSelect.value };
    };

    const agentNom = () => {
      const trouve = agents.find((agent) => agent.agentId === agentSelect.value);
      return trouve ? (trouve.name ?? trouve.agentId) : "";
    };

    const rafraichir = () => {
      const { motif, portee } = motifCourant();
      risqueEl.textContent = phraseRisque({
        declencheur: declencheurSelect.value,
        agentNom: agentNom(),
        motif,
        portee,
        destructifAutorise: destructifInput.checked,
        expireA: expirationDepuis(dureeInput.value),
      });
      personnel.hidden = motifSelect.value !== MOTIF_PERSONNALISE;
    };

    motifSelect.addEventListener("change", () => {
      // Un motif du CATALOGUE porte sa portée ET son caractère destructeur : on
      // coche la case (elle reste décochable, mais le risque est dit).
      const trouve = state.motifs.find((motif) => motif.id === motifSelect.value);
      if (trouve) {
        porteeSelect.value = trouve.portee;
        destructifInput.checked = trouve.destructif === true;
      }
      rafraichir();
    });
    for (const element of [agentSelect, porteeSelect, destructifInput, dureeInput, motifInput]) {
      element.addEventListener("change", rafraichir);
      element.addEventListener("input", rafraichir);
    }
    rafraichir();
    if (state.motifs.length > 0) {
      motifSelect.value = state.motifs[0].id;
      destructifInput.checked = state.motifs[0].destructif === true;
      porteeSelect.value = state.motifs[0].portee;
      rafraichir();
    }

    const form = h("form", { class: "config-form", id: "preauth-form" }, [
      h("label", { class: "config-label", for: "preauth-declencheur", text: "Déclencheur concerné" }),
      declencheurSelect,
      h("label", { class: "config-label", for: "preauth-agent", text: "Machine concernée" }),
      agentSelect,
      h("label", { class: "config-label", for: "preauth-motif", text: "Ce que la tâche pourra exécuter" }),
      motifSelect,
      personnel,
      h("label", { class: "config-check" }, [
        destructifInput,
        h("span", {
          text:
            "Autoriser aussi les commandes classées DESTRUCTRICES (redémarrage, " +
            "mise à jour, script…)",
        }),
      ]),
      h("label", { class: "config-label", for: "preauth-duree", text: "Valable pendant (jours)" }),
      dureeInput,
      risqueEl,
      erreurEl,
    ]);

    const ctrl = HolafModal.open({
      title: "Nouvelle pré-autorisation",
      size: "md",
      content: form,
      actions: [
        { label: "Autoriser sans validation", form: "preauth-form", type: "danger" },
        { label: "Annuler", type: "cancel", guard: false },
      ],
    });

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const { motif, portee } = motifCourant();
      const erreur = erreurMotif(motif, portee);
      const probleme =
        erreur !== ""
          ? erreur
          : declencheurSelect.value === ""
            ? "Choisissez un déclencheur."
            : agentSelect.value === ""
              ? "Choisissez une machine appairée (aucune n'est disponible)."
              : "";
      if (probleme !== "") {
        erreurEl.textContent = probleme;
        erreurEl.hidden = false;
        return;
      }
      void act("Pré-autorisation créée.", async () => {
        await HolafFetch.post("/api/sources/preautorisations", {
          headers: WRITE_HEADERS,
          body: {
            declencheur: declencheurSelect.value,
            agentId: agentSelect.value,
            motif,
            portee,
            destructifAutorise: destructifInput.checked,
            dureeJours: Number(dureeInput.value),
          },
        });
        ctrl.close();
      });
    });
  }

  const preauthDetails = h(
    "details",
    { class: "config-group declencheurs-journal preauth-section", id: ANCRE_PREAUTORISATIONS },
    [
      h("summary", {
        class: "declencheurs-journal__summary",
        text: "Pré-autorisations (ce qu'une tâche de fond peut faire sans validation)",
      }),
      h("p", {
        class: "config-helper",
        text:
          "Un déclencheur qui se réveille à 3 h du matin ne peut demander à personne. " +
          "Sans pré-autorisation, une commande attend une validation humaine, puis " +
          "expire en 5 minutes : elle n'a pas lieu. Une pré-autorisation autorise une " +
          "commande PRÉCISE (ou un préfixe explicitement déclaré) sur une machine " +
          "PRÉCISE, pendant une durée limitée. Elle ne vaut qu'UNE exécution, et se " +
          "révoque d'un clic. Aucun joker n'est accepté.",
      }),
      h("div", { class: "config-actions" }, [
        h("button", {
          class: "button button--small",
          type: "button",
          text: "+ Nouvelle pré-autorisation",
          on: () => ouvrirCreationPreAutorisation(),
        }),
      ]),
      preauthEtatEl,
      preauthListeEl,
      h("p", {
        class: "config-helper",
        text:
          "Chaque consommation et chaque refus est écrit dans le journal des " +
          "déclencheurs (type « Pré-autorisations consommées » / « Refus de " +
          "déclenchement »). Aucune pré-autorisation n'est consommée sans ligne de " +
          "journal.",
      }),
    ],
  );

  // ── ⑥ ENVOIS PROGRAMMÉS (lot 28) ─────────────────────────────────────────
  //
  // ⚠️ POURQUOI CE VOLET EXISTE : un envoi programmé est un message qui partira
  // TOUT SEUL à une heure donnée. S'il n'est pas affiché, personne ne peut savoir
  // qu'un message va partir dans un canal — ni l'annuler. C'est la seule raison
  // d'être de cette liste, et c'est pour cela que « Annuler » y est toujours
  // proposé tant que l'heure n'est pas passée.
  const envoisListeEl = h("div", { class: "declencheurs-journal__liste" });
  const envoisEtatEl = h("p", { class: "config-helper", role: "status" });

  async function chargerEnvois() {
    try {
      const data = await HolafFetch.get("/api/sources/envois", { headers: JSON_HEADERS });
      state.envois = Array.isArray(data?.envois) ? data.envois : [];
      state.envoisBornes = {
        enAttente: data?.enAttente,
        maximumEnAttente: data?.maximumEnAttente,
        horizonJours: data?.horizonJours,
        delaiMinSecondes: data?.delaiMinSecondes,
      };
      state.envoisErreur = "";
    } catch (error) {
      state.envois = [];
      state.envoisBornes = {};
      state.envoisErreur = apiMessage(error, "Impossible de lire les envois programmés.");
    }
    renderEnvois();
  }

  function renderEnvois() {
    envoisListeEl.textContent = "";
    envoisEtatEl.textContent =
      state.envoisErreur !== ""
        ? state.envoisErreur
        : texteCompteEnvois({
            ...state.envoisBornes,
            enAttente:
              typeof state.envoisBornes.enAttente === "number"
                ? state.envoisBornes.enAttente
                : state.envois.filter((envoi) => envoi.etat === "en_attente").length,
          });
    const liste = trierEnvois(state.envois);
    if (liste.length === 0) {
      envoisListeEl.append(
        h("p", {
          class: "config-helper",
          text:
            "Aucun envoi programmé. Yuki en crée un quand on lui demande de publier " +
            "« plus tard » (« poste cette image à 16h10 ») : le texte est figé, aucun " +
            "modèle n'est appelé à l'heure dite.",
        }),
      );
      return;
    }
    envoisListeEl.append(
      h("table", { class: "sources-table declencheurs-table envois-table" }, [
        h("thead", {}, [
          h("tr", {}, [
            h("th", { scope: "col", text: "Quand" }),
            h("th", { scope: "col", text: "Message" }),
            h("th", { scope: "col", text: "Destination" }),
            h("th", { scope: "col", text: "État" }),
            h("th", { scope: "col", text: "Action" }),
          ]),
        ]),
        h(
          "tbody",
          {},
          liste.map((envoi) =>
            h("tr", { class: `envois-row envois-row--${envoi.etat}` }, [
              h("td", { class: "envois-quand", text: texteQuandEnvoi(envoi) }),
              h("td", { class: "envois-message" }, [
                h("span", { class: "envois-message__texte", text: texteResumeEnvoi(envoi) }),
                ...(typeof envoi.fichiers === "number" && envoi.fichiers > 0
                  ? [
                      h("span", {
                        class: "declencheurs-nom__note",
                        text: `${envoi.fichiers} pièce(s) jointe(s)`,
                      }),
                    ]
                  : []),
              ]),
              h("td", { text: texteCibleEnvoi(envoi) }),
              h("td", { class: "envois-etat" }, [
                h("span", { text: libelleEtatEnvoi(envoi.etat) }),
                ...(typeof envoi.raison === "string" && envoi.raison !== ""
                  ? [h("span", { class: "declencheurs-nom__note", text: envoi.raison })]
                  : []),
              ]),
              h("td", { class: "sources-table__actions" }, [
                ...(envoiAnnulable(envoi)
                  ? [
                      h("button", {
                        class: "button button--danger button--small",
                        type: "button",
                        text: "Annuler",
                        on: () => void annulerEnvoi(envoi),
                      }),
                    ]
                  : [h("span", { class: "config-helper", text: "—" })]),
              ]),
            ]),
          ),
        ),
      ]),
    );
  }

  /**
   * Annulation : confirmation EXPLICITE par `HolafModal` (jamais la boîte native).
   *
   * ⚠️ Le message de confirmation dit CE QUI ne partira pas : annuler un envoi est
   * irréversible (il n'y a pas de « reprogrammer » d'un clic), et une confirmation
   * vague ferait cliquer deux fois.
   */
  async function annulerEnvoi(envoi) {
    const confirme = await HolafModal.confirm(
      "Annuler cet envoi programmé ?",
      `Le message ne partira pas dans ${texteCibleEnvoi(envoi)} à l'heure prévue ` +
        `(${texteQuandEnvoi(envoi)}). Son texte restera dans le journal des ` +
        "déclencheurs, mais il n'est pas possible de le rétablir : il faut le " +
        "reprogrammer (en le demandant à Yuki) si le message est toujours d'actualité.",
      { danger: true, confirmText: "Annuler l'envoi" },
    );
    if (!confirme) return;
    await act("Envoi annulé : il ne partira pas.", async () => {
      await HolafFetch.delete(`/api/sources/envois/${encodeURIComponent(envoi.id)}`, {
        headers: WRITE_HEADERS,
      });
    });
    await chargerEnvois();
  }

  const envoisDetails = h(
    "details",
    { class: "config-group declencheurs-journal envois-section", id: ANCRE_ENVOIS_PROGRAMMES },
    [
      h("summary", {
        class: "declencheurs-journal__summary",
        text: "Envois programmés (messages qui partiront à une heure précise)",
      }),
      h("p", {
        class: "config-helper",
        text:
          "Quand vous demandez à Yuki de publier « plus tard » (« poste cette image à " +
          "16h10 »), elle programme un envoi : le texte est FIGÉ, aucun modèle n'est " +
          "appelé à l'heure dite, et la publication passe par le même chemin que ses " +
          "autres messages. Un envoi survit à un redémarrage ; s'il est manqué de plus " +
          "d'une heure, il est marqué ÉCHOUÉ au lieu d'être publié en retard, et sa " +
          "raison est écrite ici. L'historique est conservé 7 jours.",
      }),
      envoisEtatEl,
      envoisListeEl,
      h("div", { class: "config-actions" }, [
        h("button", {
          class: "button button--ghost button--small",
          type: "button",
          text: "Rafraîchir",
          on: () => void chargerEnvois(),
        }),
      ]),
    ],
  );
  envoisDetails.addEventListener("toggle", () => {
    if (envoisDetails.open) void chargerEnvois();
  });

  // ── ③ Le 4ᵉ volet, le JOURNAL (replié par défaut) ────────────────────────
  const journalTypeSelect = h("select", {
    class: "config-select",
    id: "journal-type",
    "aria-label": "Filtrer le journal par type d'événement",
  });
  for (const [value, text] of EVENEMENTS_JOURNAL) {
    journalTypeSelect.append(h("option", { value, text }));
  }
  journalTypeSelect.addEventListener("change", () => {
    state.journalFiltre = { ...state.journalFiltre, type: journalTypeSelect.value };
    void loadJournal();
  });
  const journalSourceInput = h("input", {
    class: "config-input",
    type: "text",
    id: "journal-source",
    autocomplete: "off",
    spellcheck: "false",
    placeholder: "nom du déclencheur (facultatif)",
    "aria-label": "Filtrer le journal par déclencheur",
  });
  journalSourceInput.addEventListener("change", () => {
    state.journalFiltre = { ...state.journalFiltre, source: journalSourceInput.value.trim() };
    void loadJournal();
  });
  /** « Charger plus » : on AUGMENTE la borne, jusqu'à `JOURNAL_LIMITE_MAX`. */
  const journalPlusBtn = h("button", {
    class: "button button--ghost button--small",
    type: "button",
    text: "Charger plus d'événements",
    on: () => {
      state.journalLimite = Math.min(JOURNAL_LIMITE_MAX, state.journalLimite + JOURNAL_LIMITE);
      void loadJournal();
    },
  });
  const journalDetails = h("details", { class: "config-group declencheurs-journal", id: ANCRE_JOURNAL }, [
    h("summary", {
      class: "declencheurs-journal__summary",
      text: "Journal des déclencheurs (réceptions, décisions, échecs, sauts, plafonds, désactivations)",
    }),
    h("p", {
      class: "config-helper",
      text:
        "Le contenu reçu n'est JAMAIS montré dans les conversations : ce journal est sa " +
        "seule trace, et il la garde hors de l'interface de discussion. Borné à 30 jours, " +
        "contenu recopié sur 8 000 caractères au plus, et seules les dernières entrées " +
        "sont lues — jamais tout le fichier. Les pré-autorisations consommées (lot 4) y " +
        "figurent déjà comme type filtrable.",
    }),
    h("div", { class: "declencheurs-journal__filtres" }, [
      h("label", { class: "config-label", for: "journal-type", text: "Type d'événement" }),
      journalTypeSelect,
      h("label", {
        class: "config-label",
        for: "journal-source",
        text: "Déclencheur (nom exact)",
      }),
      journalSourceInput,
      journalPlusBtn,
    ]),
    journalEtatEl,
    journalListeEl,
  ]);
  journalDetails.addEventListener("toggle", () => {
    if (journalDetails.open) void loadJournal();
  });

  root.append(
    h("section", { class: "config-group" }, [
      h("div", { class: "config-group__head" }, [
        h("h2", { class: "config-group__title", text: "Déclencheurs (réveil par un programme ou par l'horloge)" }),
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
          "Il pousse un message JSON authentifié sur POST /api/sources/<nom>/messages. Un " +
          "déclencheur PLANIFIÉ se réveille tout seul selon une expression cron, dans son " +
          "propre fuseau. C'est VOUS qui décidez, ici, dans quel fil ses messages arrivent.",
      }),
      h("p", {
        class: "config-helper",
        text:
          "⚠️ La colonne « Dernier passage » est la plus importante : une source muette " +
          "depuis trois jours y ressemble enfin à ce qu'elle est. « Jamais » veut dire " +
          "qu'aucun passage n'a encore eu lieu — ni message reçu, ni tir planifié.",
      }),
      h("p", {
        class: "config-helper",
        text:
          "En mode SILENCIEUX (le défaut), le contenu reçu n'apparaît nulle part : si Yuki " +
          "n'a rien à dire, rien n'est publié ; sinon seul son résultat apparaît dans le " +
          "fil unique « Déclencheurs ». En mode VISIBLE, les messages s'empilent dans la " +
          "section « Notifications » de la page de discussion (contenu replié, état, " +
          "réponse de Yuki à côté).",
      }),
      errorEl,
      sectionsEl,
      envoisDetails,
      preauthDetails,
      journalDetails,
      statusEl,
      tokenEl,
    ]),
  );

  void load();

  return { refresh: () => load(), refreshJournal: () => loadJournal() };
}
