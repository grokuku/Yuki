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
 * ⚠️ Seul import : `./horodatage.js` (formatage des instants, fuseau `ui.timeZone`),
 * qui n'a lui-même aucune dépendance — le module reste chargeable par les tests.
 */
import { formatDateTimeFr } from "./horodatage.js";

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
  // ⚠️ LOT 28 — envois programmés (« poste cette image à 16h10 »).
  ["envoi_programme", "Envois programmés"],
  ["envoi_publie", "Envois publiés"],
  ["envoi_annule", "Envois annulés"],
  ["envoi_echec", "Envois échoués"],
];

/** Ancre du volet « journal » (lien depuis la colonne « dernier résultat »). */
export const ANCRE_JOURNAL = "journal-declencheurs";

/** Ancre du volet « pré-autorisations » (lot 4/4). */
export const ANCRE_PREAUTORISATIONS = "preautorisations-declencheurs";

/**
 * Ancre du volet « ENVOIS PROGRAMMÉS » (lot 28).
 *
 * ⚠️ C'est une SECTION À PART, et non une sous-partie de « Temporaires » : un envoi
 * programmé n'est pas un déclencheur (il ne réveille aucun modèle), il a ses propres
 * bornes, et c'est la SEULE liste où l'on clique « Annuler » — la mélanger aux
 * déclencheurs ferait croire qu'on peut aussi annuler un planning.
 */
export const ANCRE_ENVOIS_PROGRAMMES = "envois-programmes";

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
  // ⚠️ Fuseau `ui.timeZone` (défaut UTC), suffixé : l'instant d'un passage est le
  // MÊME que celui qu'affiche le canal distant (Mattermost, en UTC). La
  // PLANIFICATION, elle, garde le fuseau de chaque déclencheur (colonne « quand »).
  return formatDateTimeFr(date);
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

/**
 * `true` si le déclencheur est une TÂCHE PONCTUELLE (lot 31, `declencheur.type:
 * "ponctuel"`) : un rendez-vous UNIQUE qui s'éteint après son tir.
 *
 * ⚠️ À ne pas confondre avec `estPlanningPonctuel` (un cron dont la DATE ne revient
 * pas) : ici il n'y a AUCUNE expression, seulement un instant absolu.
 */
export function estTachePonctuelle(source) {
  return source?.declencheur?.type === "ponctuel";
}

/** `true` si le déclencheur est TEMPORAIRE (ponctuel ou auto-terminant). */
export function estTemporaire(source) {
  return estPlanningPonctuel(source) || estTachePonctuelle(source) || estAutoTerminant(source);
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

// ── CHAÎNES D'ÉTAPES (lot 33) ───────────────────────────────────────────────

/**
 * Regroupe les fiches en CHAÎNES et en déclencheurs ISOLÉS.
 *
 * ⚠️ Une carte par chaîne, étapes DANS L'ORDRE (`chaine.etape`). Les noms d'étapes sont
 * affichés par le panneau : c'est eux qui portent les pré-autorisations, les cacher
 * rendrait la page incapable de dire quelle autorisation s'applique à quel horaire.
 *
 * ⚠️ Fonction PURE, à côté de `grouperParSection` : les trois sections historiques
 * gardent leur sémantique (un temporaire éteint reste 7 jours, etc.) ; la chaîne est une
 * vue ORTHOGONALE — une étape éteinte reste une étape de sa chaîne, jamais une ligne
 * orpheline.
 *
 * @param {any[]} sources fiches renvoyées par `GET /api/sources`
 * @returns {{chaines: Array<{id: string, titre: string, etapes: any[]}>, isolees: any[]}}
 */
export function grouperParChaine(sources) {
  const liste = Array.isArray(sources) ? sources.filter((source) => source && source.nom) : [];
  const groupes = new Map();
  const isolees = [];
  for (const source of liste) {
    const chaine = source.chaine;
    if (!chaine || typeof chaine.id !== "string" || chaine.id === "") {
      isolees.push(source);
      continue;
    }
    let groupe = groupes.get(chaine.id);
    if (groupe === undefined) {
      groupe = { id: chaine.id, titre: "", etapes: [] };
      groupes.set(chaine.id, groupe);
    }
    groupe.etapes.push(source);
  }
  const chaines = [...groupes.values()];
  for (const groupe of chaines) {
    groupe.etapes.sort(
      (a, b) => (Number(a.chaine?.etape) || 0) - (Number(b.chaine?.etape) || 0),
    );
    const premiere = groupe.etapes[0];
    // Le titre vient de la PREMIÈRE étape : c'est ce que la personne a nommé.
    groupe.titre =
      premiere !== undefined
        ? String(premiere.libelle ?? premiere.nom ?? groupe.id)
        : groupe.id;
  }
  chaines.sort((a, b) => a.titre.localeCompare(b.titre, "fr"));
  return { chaines, isolees };
}

/**
 * État d'une étape de chaîne : « faite », « en attente », « annulée : … ».
 *
 * ⚠️ L'état vient du STORE (compteur/résultat/raison), jamais d'une déduction sur
 * l'heure : une étape qui a tiré mais dont le résultat a été supprimé reste « en
 * attente » — c'est la vérité de ce que la suivante pourra relire.
 */
export function etatEtape(source) {
  if (!source?.chaine) return "hors chaîne";
  if (source.actif === false) {
    const raison =
      typeof source.raisonInactive === "string" && source.raisonInactive !== ""
        ? source.raisonInactive
        : "éteinte";
    return raison;
  }
  const at = source?.resultatEtape?.at;
  if (typeof at === "string" && at !== "") return `faite le ${dateHeureFr(at)}`;
  return "en attente";
}

/** Résumé BORNÉ du résultat d'une étape (texte + nombre de fichiers), jamais inventé. */
export function texteResultatEtape(source, max = 140) {
  const resultat = source?.resultatEtape;
  if (!resultat || typeof resultat !== "object") return "";
  const texte =
    typeof resultat.texte === "string" ? resultat.texte.replace(/\s+/gu, " ").trim() : "";
  const fichiers = Array.isArray(resultat.fichiers) ? resultat.fichiers.length : 0;
  const morceaux = [];
  if (texte !== "") {
    morceaux.push(texte.length > max ? `${texte.slice(0, max)}…` : texte);
  }
  if (fichiers > 0) morceaux.push(`${fichiers} fichier(s)`);
  return morceaux.join(" · ");
}

// ── Colonnes ────────────────────────────────────────────────────────────────

/**
 * ⚠️ LOT 32 — FIN DE RÉCURRENCE affichée (« reste 6/14 », « jusqu'au … »).
 *
 * ⚠️ Deux formes, indépendantes : `occurrencesMax` (compteur de passages RÉELLEMENT
 * tirés, persisté) et `jusquAu` (date). Le compteur ne compte JAMAIS un saut — c'est
 * pourquoi la page relit `occurrencesFaites` au lieu de déduire d'un horaire.
 *
 * @param {any} source fiche renvoyée par `GET /api/sources`
 * @returns {string} texte court, ou chaîne vide quand aucune fin n'est prévue
 */
export function texteOccurrences(source) {
  const max = entierPositif(source?.occurrencesMax);
  if (max > 0) {
    const faites = entierPositif(source?.occurrencesFaites);
    const reste = Math.max(0, max - faites);
    if (reste === 0) return `terminée (${faites}/${max} passages)`;
    return `reste ${reste}/${max}`;
  }
  const jusquAu = source?.jusquAu;
  if (typeof jusquAu === "string" && jusquAu !== "") {
    return `fin prévue le ${dateHeureFr(jusquAu)}`;
  }
  return "";
}

/** « Quand » : type + expression lisible ET le PROCHAIN passage. */
export function texteQuand(source) {
  const base = texteQuandBase(source);
  const suites = [
    texteOccurrences(source),
    // ⚠️ LOT 33 — une étape de chaîne dit son rang ET son nom complet reste visible
    // (c'est le nom qui porte les pré-autorisations).
    typeof source?.chaine?.etape === "number"
      ? `chaîne « ${source.chaine.id} », étape ${source.chaine.etape}`
      : "",
  ].filter((morceau) => morceau !== "");
  return suites.length === 0 ? base : `${base} · ${suites.join(" · ")}`;
}

function texteQuandBase(source) {
  const declencheur = source?.declencheur ?? { type: "webhook" };
  // ⚠️ LOT 31 — TÂCHE PONCTUELLE : un instant ABSOLU, aucune expression cron. Dire
  // « webhook » ici serait faux, et ferait croire qu'un programme extérieur l'appelle.
  if (declencheur.type === "ponctuel") {
    const quand = dateHeureFr(declencheur.a);
    return source?.actif === false
      ? `tâche ponctuelle — ${quand} (exécutée)`
      : `tâche ponctuelle — ${quand}`;
  }
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
  if (source?.declencheur?.type === "ponctuel") {
    if (source?.actif === false) return "aucun (tâche exécutée)";
    const quand = source?.declencheur?.a;
    return typeof quand === "string" && quand !== "" ? dateHeureFr(quand) : "non calculé";
  }
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

// ── ENVOIS PROGRAMMÉS (lot 28) ──────────────────────────────────────────────

/**
 * Libellés d'état d'un envoi programmé.
 *
 * ⚠️ « parti » et « échoué » ne sont jamais fondus dans un « terminé » : la personne
 * doit pouvoir constater qu'un message EST parti (ou qu'il n'est PAS parti) avant de
 * reprogrammer. Un échec porte toujours sa raison à côté.
 */
export const ETATS_ENVOI = [
  ["en_attente", "en attente"],
  ["en_cours", "en cours d'envoi"],
  ["envoye", "envoyé"],
  ["echoue", "échoué"],
  ["annule", "annulé"],
];

/** Libellé lisible d'un état d'envoi (slug inconnu ⇒ rendu tel quel). */
export function libelleEtatEnvoi(etat) {
  const trouve = ETATS_ENVOI.find(([slug]) => slug === etat);
  return trouve ? trouve[1] : String(etat ?? "?");
}

/** `true` si l'envoi peut encore être ANNULÉ (bouton proposé). */
export function envoiAnnulable(envoi) {
  return envoi?.etat === "en_attente";
}

/**
 * Quand l'envoi partira (ou est parti) — ⚠️ l'instant EFFECTIF est affiché tel que le
 * serveur l'a calculé (`quandLisible`, fuseau compris), jamais recalculé par le
 * navigateur : le fuseau du navigateur n'est pas celui de Yuki.
 */
export function texteQuandEnvoi(envoi) {
  const quand = typeof envoi?.quandLisible === "string" ? envoi.quandLisible : "";
  const heure = typeof envoi?.quand === "string" ? envoi.quand : "";
  const base = quand !== "" ? quand : dateHeureFr(heure);
  if (envoi?.etat === "envoye" && typeof envoi?.envoyeLe === "string" && envoi.envoyeLe !== "") {
    return `${base} — parti le ${dateHeureFr(envoi.envoyeLe)}`;
  }
  if (envoi?.etat === "echoue") return `${base} — n'est PAS parti`;
  if (envoi?.etat === "annule") return `${base} — annulé avant l'envoi`;
  return base;
}

/** Destination lisible d'un envoi (canal ou conversation locale). */
export function texteCibleEnvoi(envoi) {
  const cible = envoi?.cible;
  if (!cible || typeof cible !== "object") return "?";
  if (typeof cible.libelle === "string" && cible.libelle !== "") return cible.libelle;
  if (cible.type === "canal") return String(cible.conversationId ?? "canal inconnu");
  return "conversation locale";
}

/** Résumé BORNÉ du texte, avec la troncature DITE (jamais un texte coupé en silence). */
export function texteResumeEnvoi(envoi, max = 140) {
  const texte = typeof envoi?.texte === "string" ? envoi.texte.replace(/\s+/gu, " ").trim() : "";
  if (texte === "") return "(texte vide)";
  const coupe = texte.length > max ? `${texte.slice(0, max)}…` : texte;
  return envoi?.texteTronque === true ? `${coupe} (résumé borné par le serveur)` : coupe;
}

/**
 * Compteur affiché en tête du volet : « 2 en attente · maximum 20 · horizon 30 jours ».
 *
 * ⚠️ Le plafond est TOUJOURS affiché (même à 0 en attente) : sans lui, une personne qui
 * programme son 20ᵉ envoi ne comprend pas le refus du modèle.
 */
export function texteCompteEnvois(donnees) {
  const enAttente = entierPositif(donnees?.enAttente);
  const maximum = entierPositif(donnees?.maximumEnAttente);
  const horizon = entierPositif(donnees?.horizonJours);
  const minimum = entierPositif(donnees?.delaiMinSecondes);
  const morceaux = [`${enAttente} en attente`];
  if (maximum > 0) morceaux.push(`maximum ${maximum}`);
  if (horizon > 0) morceaux.push(`horizon ${horizon} jours`);
  if (minimum > 0) morceaux.push(`au moins ${minimum} s d'avance`);
  return morceaux.join(" · ");
}

/**
 * Envois à AFFICHER : les en attente d'abord (les plus proches en tête), puis les
 * terminés (les plus récents d'abord). ⚠️ Rien n'est masqué : un envoi échoué ou annulé
 * reste listé, avec sa raison — la rétention de 7 jours côté serveur fait la place.
 */
export function trierEnvois(envois) {
  const liste = Array.isArray(envois) ? envois.filter((envoi) => envoi && envoi.id) : [];
  const attente = liste
    .filter((envoi) => envoi.etat === "en_attente" || envoi.etat === "en_cours")
    .sort((a, b) => Date.parse(a.quand) - Date.parse(b.quand));
  const termines = liste
    .filter((envoi) => envoi.etat !== "en_attente" && envoi.etat !== "en_cours")
    .sort(
      (a, b) =>
        Date.parse(b.envoyeLe ?? b.quand ?? 0) - Date.parse(a.envoyeLe ?? a.quand ?? 0),
    );
  return [...attente, ...termines];
}

/** Lien vers le volet journal, filtré sur une source (ancre + `data-source`). */
export function lienJournal(source) {
  return { href: `#${ANCRE_JOURNAL}`, source: typeof source === "string" ? source : "" };
}
