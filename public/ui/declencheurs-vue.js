/**
 * VUE de la page de gestion des DÉCLENCHEURS — fonctions PURES, sans DOM.
 *
 * Pourquoi un module à part ? Parce que les décisions d'AFFICHAGE de cette page
 * sont des règles (trois sections, « dernier passage », fenêtre de 7 jours du
 * temporaire éteint, filtre du journal) et qu'une règle doit être TESTABLE sans
 * navigateur. `sources-panel.js` ne fait que rendre ce que ce module décide.
 *
 * ⚠️ LA RAISON D'ÊTRE DE LA PAGE : sans la colonne « dernier passage », une
 * source MUETTE depuis trois jours est INDISTINGUABLE d'une source qui travaille.
 * C'est pourquoi `texteDernierPassage` répond « jamais » plutôt que « — ».
 *
 * Trois sections (demande explicite) :
 *   ① « Permanents »  — `webhook` (toujours) et `planning` sans fin prévue ;
 *   ② « Temporaires » — planning PONCTUEL, ou auto-terminant (`DÉSACTIVER`,
 *      `maxToursParJour` atteint). ⚠️ Un temporaire ÉTEINT reste listé 7 jours :
 *      sinon on ne sait plus qu'il a existé ;
 *   ③ « En sommeil »  — `actif: false` (raison LISIBLE : `DÉSACTIVER`, plafond,
 *      destination supprimée…). ⚠️ AUCUNE disparition silencieuse : une source
 *      éteinte reste listée ici, indéfiniment.
 *
 * Aucun import, aucun accès à `document` : ce module est chargé aussi bien par
 * la page `/config` que par les tests.
 */

/** Nombre de jours pendant lesquels un déclencheur TEMPORAIRE éteint reste listé. */
export const JOURS_VISIBILITE_TEMPORAIRE = 7;

/** Les trois sections, dans l'ordre d'affichage. */
export const SECTIONS_DECLENCHEURS = [
  {
    id: "permanents",
    titre: "Permanents",
    aide:
      "Programme extérieur (webhook) ou planning sans fin prévue : ces déclencheurs " +
      "restent armés tant que vous ne les éteignez pas.",
  },
  {
    id: "temporaires",
    titre: "Temporaires",
    aide:
      "Planning ponctuel, ou déclencheur auto-terminant (il s'éteint lui-même par " +
      "DÉSACTIVER ou parce qu'il a atteint son nombre de tours quotidiens). Un " +
      "temporaire éteint reste listé 7 jours : on ne l'efface jamais en silence.",
  },
  {
    id: "sommeil",
    titre: "En sommeil",
    aide:
      "Déclencheurs éteints (actif décoché, DÉSACTIVER, garde-fou quotidien, " +
      "destination supprimée…). La raison est écrite à côté de l'état : rien ne " +
      "disparaît sans explication.",
  },
];

/** Slugs des trois sections (garde-fou : jamais une valeur hors de cette liste). */
export const SECTIONS_IDS = SECTIONS_DECLENCHEURS.map((section) => section.id);

/**
 * Libellés des événements du journal (⚠️ l'ordre est celui du sélecteur de filtre).
 * `preautorisation` est écrit par le lot 4 : il est DÉJÀ filtrable ici.
 */
export const EVENEMENTS_JOURNAL = [
  ["tous", "Tous les événements"],
  ["recu", "Réceptions"],
  ["publie", "Publications"],
  ["silence", "Silences (RIEN)"],
  ["echec", "Échecs"],
  ["saut", "Sauts de chevauchement / rattrapage ignoré"],
  ["plafond", "Plafonds atteints"],
  ["desactive", "Désactivations"],
  ["refus", "Refus de déclenchement"],
  ["preautorisation", "Pré-autorisations consommées"],
];

/** Ancre du volet « journal » (lien depuis la colonne « dernier résultat »). */
export const ANCRE_JOURNAL = "journal-declencheurs";

/** Ancre du volet « pré-autorisations » (lot 4/4). */
export const ANCRE_PREAUTORISATIONS = "preautorisations-declencheurs";

/**
 * Bornes du volet journal. ⚠️ Le journal n'est JAMAIS chargé en entier : on
 * demande les N dernières entrées (route `GET /api/sources/journal`).
 */
export const JOURNAL_LIMITE = 50;
export const JOURNAL_LIMITE_MAX = 200;

/** Nombre maximal de caractères affichés d'un contenu du journal. */
export const JOURNAL_TEXTE_AFFICHE = 400;

function entierPositif(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/**
 * Instant lisible en français (⚠️ jamais une exception sur une date illisible).
 *
 * @param {string|undefined|null} iso instant ISO
 * @returns {string}
 */
export function dateHeureFr(iso) {
  if (iso === undefined || iso === null || iso === "") return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleString("fr-FR");
}

/** `true` si l'instant est dans la fenêtre (jours) qui précède `maintenant`. */
function dansLaFenetre(iso, maintenant, jours) {
  if (iso === undefined || iso === null || iso === "") return false;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return true; // date illisible ⇒ on ne cache rien
  return maintenant - at <= jours * 86_400_000;
}

/** Champs de l'expression cron (5 champs, ou tableau vide si illisible). */
function champsCron(expression) {
  if (typeof expression !== "string") return [];
  const champs = expression.trim().split(/\s+/);
  return champs.length === 5 ? champs : [];
}

/**
 * `true` si la DATE de l'expression est FIXE (jour-du-mois ET mois sans `*`) :
 * le planning ne peut donc tirer qu'un nombre fini de fois — c'est un planning
 * PONCTUEL (`0 9 3 5 *` = le 3 mai à 9 h).
 */
export function estPlanningPonctuel(source) {
  const declencheur = source?.declencheur;
  if (!declencheur || declencheur.type !== "planning") return false;
  const champs = champsCron(declencheur.expression);
  if (champs.length !== 5) return false;
  const jourDuMois = champs[2];
  const mois = champs[3];
  return !jourDuMois.includes("*") && !mois.includes("*");
}

/** `true` si le garde-fou quotidien est ATTEINT (tours du jour ≥ plafond). */
export function plafondQuotidienAtteint(source) {
  const compte = entierPositif(source?.toursDuJour?.compte);
  const plafond = entierPositif(source?.maxToursParJour);
  if (plafond === 0) return false;
  return compte >= plafond;
}

/**
 * `true` si le déclencheur PORTE une fin possible : il s'éteindra de lui-même
 * (`DÉSACTIVER`, garde-fou quotidien) ou sa date ne revient pas indéfiniment.
 */
export function estAutoTerminant(source) {
  if (source?.actif === false) return true;
  if (plafondQuotidienAtteint(source)) return true;
  return estPlanningPonctuel(source);
}

/** `true` si le déclencheur est TEMPORAIRE (ponctuel ou auto-terminant). */
export function estTemporaire(source) {
  return estPlanningPonctuel(source) || estAutoTerminant(source);
}

/** Instant de mise en veille connu (⚠️ repli sur `maj`, puis `undefined`). */
export function instantDesactivation(source) {
  const desactiveLe = source?.desactiveLe;
  if (typeof desactiveLe === "string" && desactiveLe !== "") return desactiveLe;
  if (typeof source?.maj === "string" && source.maj !== "") return source.maj;
  return undefined;
}

/** `true` si un temporaire éteint doit encore être listé (fenêtre de 7 jours). */
export function eteintRecemment(source, maintenant = Date.now()) {
  return dansLaFenetre(instantDesactivation(source), maintenant, JOURS_VISIBILITE_TEMPORAIRE);
}

/**
 * Section d'un déclencheur : `permanents`, `temporaires` ou `sommeil`.
 *
 * ⚠️ L'ordre des règles est la RÈGLE : un temporaire ÉTEINT reste en
 * « temporaires » (7 jours, avec la date d'extinction) ; ensuite il rejoint
 * « sommeil » — jamais la disparition pure.
 */
export function classerSource(source, options = {}) {
  const maintenant = Number.isFinite(options.maintenant) ? options.maintenant : Date.now();
  if (source?.actif === false) {
    if (estTemporaire(source) && eteintRecemment(source, maintenant)) return "temporaires";
    return "sommeil";
  }
  return estTemporaire(source) ? "temporaires" : "permanents";
}

/**
 * Regroupe les déclencheurs en trois sections (toujours les TROIS, même vides :
 * l'utilisateur voit qu'une catégorie existe et qu'elle est vide).
 *
 * @param {any[]} sources fiches renvoyées par `GET /api/sources`
 * @param {{maintenant?: number}} [options] horloge injectable (tests)
 * @returns {Array<{id: string, titre: string, aide: string, sources: any[]}>}
 */
export function grouperParSection(sources, options = {}) {
  const liste = Array.isArray(sources) ? sources.filter((source) => source && source.nom) : [];
  const groupes = SECTIONS_DECLENCHEURS.map((section) => ({
    ...section,
    sources: [],
  }));
  const parId = new Map(groupes.map((groupe) => [groupe.id, groupe]));
  for (const source of liste) {
    const section = classerSource(source, options);
    (parId.get(section) ?? parId.get("permanents")).sources.push(source);
  }
  for (const groupe of groupes) {
    groupe.sources.sort((a, b) => String(a.nom).localeCompare(String(b.nom), "fr"));
  }
  return groupes;
}

// ── Colonnes ────────────────────────────────────────────────────────────────

/** « Quand » : type + expression lisible ET le PROCHAIN passage. */
export function texteQuand(source) {
  const declencheur = source?.declencheur ?? { type: "webhook" };
  if (declencheur.type !== "planning") return "webhook (à chaque envoi du programme)";
  const expression = declencheur.expression ?? "";
  const fuseau = declencheur.fuseau ?? "Europe/Paris";
  if (source?.actif === false) {
    return `planning « ${expression} » (${fuseau}) — désarmé`;
  }
  return `planning « ${expression} » (${fuseau}) · prochain passage : ${texteProchainPassage(source)}`;
}

/** Prochain passage (⚠️ « aucun » quand il n'y en a pas, jamais une case vide). */
export function texteProchainPassage(source) {
  if (source?.actif === false) return "aucun (déclencheur éteint)";
  if (source?.declencheur?.type !== "planning") return "sans objet (webhook)";
  const prochain = source?.prochainPassage;
  if (typeof prochain !== "string" || prochain === "") return "non calculé";
  return dateHeureFr(prochain);
}

/**
 * ⚠️ LA COLONNE CRITIQUE : « dernier passage ».
 *
 * Un déclencheur PLANIFIÉ note son `dernierPassage` à chaque tir réel ; un
 * `webhook` note son `dernierAppel` à chaque réception. On affiche l'un OU
 * l'autre — et « jamais » quand il n'y en a aucun : c'est ce qui distingue une
 * source muette d'une source qui travaille.
 */
export function texteDernierPassage(source) {
  const planifie = source?.dernierPassage;
  if (typeof planifie === "string" && planifie !== "") {
    return `${dateHeureFr(planifie)} (passage planifié)`;
  }
  const appel = source?.dernierAppel;
  if (typeof appel === "string" && appel !== "") {
    return `${dateHeureFr(appel)} (message reçu)`;
  }
  return "jamais";
}

/** `true` si la source n'a JAMAIS tourné (aucun passage ni appel connu). */
export function jamaisPasse(source) {
  const planifie = source?.dernierPassage;
  const appel = source?.dernierAppel;
  return !(typeof planifie === "string" && planifie !== "") &&
    !(typeof appel === "string" && appel !== "");
}

/** Résumé du DERNIER RÉSULTAT connu (événement de journal) + son instant. */
export function texteDernierResultat(source) {
  const evenement = source?.dernierEvenement;
  if (!evenement || typeof evenement.event !== "string") return "aucun résultat enregistré";
  const libelle = libelleEvenement(evenement.event);
  const quand = dateHeureFr(evenement.ts);
  const detail =
    typeof evenement.resume === "string" && evenement.resume !== ""
      ? evenement.resume
      : typeof evenement.raison === "string" && evenement.raison !== ""
        ? evenement.raison
        : "";
  return detail === "" ? `${libelle} · ${quand}` : `${libelle} · ${quand} · ${detail}`;
}

/** Libellé lisible d'un type d'événement (slug inconnu ⇒ rendu tel quel). */
export function libelleEvenement(event) {
  const found = EVENEMENTS_JOURNAL.find(([slug]) => slug === event);
  if (!found || found[0] === "tous") return String(event ?? "?");
  return found[1];
}

/**
 * Pré-autorisations ACTIVES. ⚠️ Au lot 3 la liste est toujours vide (le moteur
 * les consomme au lot 4) : la colonne existe déjà et dit « aucune » — jamais une
 * case muette qui laisserait croire à un bug d'affichage.
 */
export function textePreAutorisations(source) {
  const liste = Array.isArray(source?.preAutorisations) ? source.preAutorisations : [];
  const actives = liste.filter((value) => typeof value === "string" && value.trim() !== "");
  if (actives.length === 0) return "aucune";
  return actives.join(", ");
}

/** Tours du jour / plafond (⚠️ le plafond est TOUJOURS affiché). */
export function texteTours(source) {
  const compte = entierPositif(source?.toursDuJour?.compte);
  const plafond = entierPositif(source?.maxToursParJour);
  if (plafond === 0) return `${compte} / —`;
  return `${compte} / ${plafond}`;
}

/** Jetons cumulés (⚠️ « — » quand aucun tour n'a encore rien rapporté). */
export function texteJetons(source) {
  const jetons = source?.jetonsCumules;
  if (!jetons) return "—";
  const entree = entierPositif(jetons.entree);
  const sortie = entierPositif(jetons.sortie);
  if (entree === 0 && sortie === 0) return "—";
  return `${entree.toLocaleString("fr-FR")} entrée · ${sortie.toLocaleString("fr-FR")} sortie`;
}

/** État + RAISON (jamais « éteint » tout court : on dit pourquoi). */
export function texteEtat(source) {
  if (source?.actif === false) {
    const raison =
      typeof source?.raisonInactive === "string" && source.raisonInactive !== ""
        ? ` : ${source.raisonInactive}`
        : "";
    const quand = instantDesactivation(source);
    const date = quand === undefined ? "" : ` (le ${dateHeureFr(quand)})`;
    return `en sommeil${raison}${date}`;
  }
  if (plafondQuotidienAtteint(source)) {
    return `garde-fou quotidien atteint (${texteTours(source)})`;
  }
  return "actif";
}

// ── Journal ─────────────────────────────────────────────────────────────────

/**
 * Filtre du journal (type et/ou source) — ⚠️ appliqué sur les événements DÉJÀ
 * bornés renvoyés par le serveur.
 *
 * @param {any[]} evenements lignes de `GET /api/sources/journal`
 * @param {{type?: string, source?: string}} [filtre] type (`tous` = aucun filtre)
 * @returns {any[]}
 */
export function filtrerJournal(evenements, filtre = {}) {
  const liste = Array.isArray(evenements) ? evenements : [];
  const type = typeof filtre.type === "string" && filtre.type !== "" ? filtre.type : "tous";
  const source = typeof filtre.source === "string" ? filtre.source.trim() : "";
  return liste.filter((evenement) => {
    if (!evenement || typeof evenement !== "object") return false;
    if (type !== "tous" && evenement.event !== type) return false;
    if (source !== "" && evenement.source !== source) return false;
    return true;
  });
}

/**
 * Texte d'un contenu journalisé, BORNÉ pour l'affichage (la troncature est DITE
 * quand le journal l'a lui-même tronqué, et quand on borne ici).
 */
export function texteJournalBorne(texte, max = JOURNAL_TEXTE_AFFICHE) {
  if (typeof texte !== "string" || texte === "") return "";
  if (texte.length <= max) return texte;
  return `${texte.slice(0, max)}… (tronqué à l'affichage)`;
}

/** Résumé d'une ligne de journal (instant + type + source + détail). */
export function resumerEvenement(evenement) {
  const type = libelleEvenement(evenement?.event);
  const source = typeof evenement?.source === "string" ? evenement.source : "?";
  const quand = dateHeureFr(evenement?.ts);
  const morceaux = [`${quand} · ${type} · ${source}`];
  if (typeof evenement?.preAutorisation === "string" && evenement.preAutorisation !== "") {
    morceaux.push(`pré-autorisation « ${evenement.preAutorisation} »`);
  }
  if (typeof evenement?.raison === "string" && evenement.raison !== "") {
    morceaux.push(evenement.raison);
  }
  if (typeof evenement?.octets === "number") morceaux.push(`${evenement.octets} octets`);
  return morceaux.join(" · ");
}

/** Lien vers le volet journal, filtré sur une source (ancre + `data-source`). */
export function lienJournal(source) {
  return { href: `#${ANCRE_JOURNAL}`, source: typeof source === "string" ? source : "" };
}
