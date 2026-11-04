/**
 * VUE des PRÉ-AUTORISATIONS — règles d'affichage PURES, sans DOM (lot 26, lot 4/4).
 *
 * Pourquoi un module à part : les décisions de cette partie de la page sont des
 * RÈGLES DE SÉCURITÉ (phrase de risque, état calculé, compteur de consommations,
 * refus d'un motif à joker) et une règle de sécurité doit être TESTABLE sans
 * navigateur. `sources-panel.js` ne fait que rendre ce que ce module décide, et
 * le SERVEUR reste l'autorité (il revalide tout).
 *
 * ⚠️ Le CATALOGUE des motifs proposés ne vit PAS ici : il vient du serveur
 * (`GET /api/sources/preautorisations` → `motifs`). Une seule copie, donc pas de
 * dérive entre ce que la page propose et ce que le serveur accepte.
 *
 * Aucun import, aucun accès à `document`.
 */

/** Durée de vie par défaut (jours) — la même valeur que le serveur. */
export const DUREE_DEFAUT_JOURS = 30;

/** Durée de vie maximale (jours) — au-delà, le serveur refuse. */
export const DUREE_MAX_JOURS = 90;

/** Longueur minimale d'un motif (la même que le serveur). */
export const LONGUEUR_MIN_MOTIF = 3;

/** Longueur minimale d'un motif en mode PRÉFIXE (la même que le serveur). */
export const LONGUEUR_MIN_PREFIXE = 8;

/**
 * Valeur du sélecteur de motif qui ouvre la SAISIE MANUELLE.
 *
 * ⚠️ La saisie libre existe (toutes les commandes utiles ne sont pas dans le
 * catalogue) mais elle est un choix EXPLICITEMENT différent : on ne tombe jamais
 * dessus par défaut, et la phrase de risque y insiste.
 */
export const MOTIF_PERSONNALISE = "personnalise";

/** Portées proposées (l'ordre est celui du sélecteur). */
export const PORTEES = [
  ["exacte", "Commande EXACTE (rien à ajouter, rien à retirer)"],
  ["prefixe", "PRÉFIXE déclaré (toute commande qui commence par ce texte)"],
];

/** Libellés des états calculés par le serveur. */
export const ETATS_PREAUTORISATION = [
  ["active", "active"],
  ["consommee", "consommée"],
  ["expiree", "expirée"],
  ["revoquee", "révoquée"],
];

/** Libellé d'un état (slug inconnu ⇒ rendu tel quel, jamais une case vide). */
export function libelleEtat(etat) {
  const found = ETATS_PREAUTORISATION.find(([slug]) => slug === etat);
  return found ? found[1] : String(etat ?? "?");
}

/** Instant lisible en français (jamais une exception sur une date illisible). */
export function dateHeureFr(iso) {
  if (iso === undefined || iso === null || iso === "") return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleString("fr-FR");
}

/**
 * `true` si un motif est REFUSÉ côté page (le serveur refusera aussi).
 * Renvoie le message d'erreur, ou `""` si le motif est acceptable.
 *
 * ⚠️ Le joker `*` est refusé ICI AUSSI : mettre un `*` dans un champ de sécurité
 * est une erreur qu'on ne rattrape pas, et il vaut mieux la voir à la saisie.
 */
export function erreurMotif(motif, portee) {
  if (typeof motif !== "string" || motif.trim() === "") return "Renseignez la commande à autoriser.";
  const net = motif.trim();
  if (net.includes("*")) {
    return "Un joker « * » n'est JAMAIS accepté : indiquez une commande exacte ou un préfixe explicite.";
  }
  if (/[\u0000-\u001f\u007f]/.test(net)) {
    return "Le motif ne peut pas contenir de caractère de contrôle.";
  }
  const minimum = portee === "prefixe" ? LONGUEUR_MIN_PREFIXE : LONGUEUR_MIN_MOTIF;
  if (net.length < minimum) {
    return `Motif trop court (${net.length} caractère(s), minimum ${minimum} pour cette portée).`;
  }
  return "";
}

/**
 * PHRASE DE RISQUE — elle doit être impossible à mal lire : QUELLES commandes,
 * sur QUELLE machine, SANS validation, jusqu'à QUAND.
 *
 * @param {{declencheur: string, agentNom: string, motif: string, portee: string,
 *          destructifAutorise: boolean, expireA?: string, maintenant?: number}} input
 * @returns {string}
 */
export function phraseRisque(input) {
  const declencheur =
    typeof input?.declencheur === "string" && input.declencheur !== ""
      ? `« ${input.declencheur} »`
      : "(déclencheur non choisi)";
  const agentNom =
    typeof input?.agentNom === "string" && input.agentNom !== ""
      ? `« ${input.agentNom} »`
      : "(machine non choisie)";
  const motif = typeof input?.motif === "string" ? input.motif.trim() : "";
  const portee = input?.portee === "prefixe" ? "prefixe" : "exacte";
  const couverture =
    motif === ""
      ? "LES COMMANDES QUE VOUS N'AVEZ PAS ENCORE CHOISIES"
      : portee === "prefixe"
        ? `TOUTES les commandes commençant par « ${motif} »`
        : `LA COMMANDE EXACTE « ${motif} »`;
  const destructif =
    input?.destructifAutorise === true
      ? " Y COMPRIS les commandes classées DESTRUCTRICES."
      : " Les commandes classées destructrices resteront refusées.";
  const echeance =
    typeof input?.expireA === "string" && input.expireA !== ""
      ? ` jusqu'au ${dateHeureFr(input.expireA)}`
      : ` pendant ${DUREE_DEFAUT_JOURS} jours`;
  return (
    `⚠️ Cette tâche de fond ${declencheur} pourra exécuter ${couverture} sur cette ` +
    `machine ${agentNom}, SANS VALIDATION humaine${echeance}.${destructif} ` +
    "Une seule exécution sera autorisée (la pré-autorisation est consommée ensuite). " +
    "Révocable à tout moment depuis cette page."
  );
}

/**
 * Texte du COMPTEUR de consommations.
 *
 * ⚠️ Une pré-autorisation = UNE exécution : le compteur monte à 1, jamais plus.
 * On l'affiche quand même tel quel (« 0 » puis « 1 ») : c'est ce qui distingue
 * « pas encore utilisée » de « déjà utilisée », donc de « à recréer ».
 */
export function texteConsommations(pre) {
  const compte = Number(pre?.consommations);
  const n = Number.isFinite(compte) && compte > 0 ? Math.trunc(compte) : 0;
  if (n === 0) return "0 consommation (encore disponible)";
  const quand = dateHeureFr(pre?.consommeeLe);
  return quand === ""
    ? `${n} consommation (utilisée)`
    : `${n} consommation (utilisée le ${quand})`;
}

/** Échéance lisible, avec l'état entre parenthèses (« expirée », « révoquée »…). */
export function texteEcheance(pre, maintenant = Date.now()) {
  const etat = libelleEtat(pre?.etat);
  const date = dateHeureFr(pre?.expireA);
  if (date === "") return etat;
  return `${date} (${etat})`;
}

/** Couverture lisible d'une autorisation (motif + portée). */
export function texteCouverture(pre) {
  const motif = typeof pre?.motif === "string" ? pre.motif : "";
  if (pre?.portee === "prefixe") return `${motif}… (préfixe déclaré)`;
  return `${motif} (commande exacte)`;
}

/** Résumé d'UNE ligne (instantané lisible, sans DOM). */
export function resumerPreAutorisation(pre) {
  const declencheur = typeof pre?.declencheur === "string" ? pre.declencheur : "?";
  const agent = typeof pre?.agentNom === "string" ? pre.agentNom : pre?.agentId ?? "?";
  return (
    `${declencheur} → ${agent} : ${texteCouverture(pre)} · ` +
    `${libelleEtat(pre?.etat)} · ${texteConsommations(pre)}`
  );
}

/** `true` si l'autorisation expire dans la fenêtre (jours) — signalé à l'écran. */
export function expirationProche(pre, maintenant = Date.now(), jours = 7) {
  if (pre?.etat !== "active") return false;
  const at = Date.parse(pre?.expireA);
  if (!Number.isFinite(at)) return false;
  return at - maintenant <= jours * 86_400_000;
}

/**
 * Autorisations ACTIVES d'un déclencheur (ce que la colonne doit montrer).
 *
 * @param {any[]} liste autorisations renvoyées par le serveur
 * @param {string} nom nom du déclencheur
 * @returns {any[]}
 */
export function preAutorisationsDuDeclencheur(liste, nom) {
  const items = Array.isArray(liste) ? liste : [];
  if (typeof nom !== "string" || nom === "") return [];
  return items.filter((pre) => pre && pre.declencheur === nom && pre.etat === "active");
}

/** Compte par état (bandeau de la section : « 2 actives · 1 consommée »). */
export function compterParEtat(liste) {
  const compte = { active: 0, consommee: 0, expiree: 0, revoquee: 0 };
  for (const pre of Array.isArray(liste) ? liste : []) {
    const etat = pre && typeof pre.etat === "string" ? pre.etat : "";
    if (etat in compte) compte[etat] += 1;
  }
  return compte;
}

/** Bandeau lisible des états (jamais une liste vide muette). */
export function texteCompteEtats(liste) {
  const compte = compterParEtat(liste);
  const total = compte.active + compte.consommee + compte.expiree + compte.revoquee;
  if (total === 0) return "aucune pré-autorisation déclarée";
  return (
    `${total} pré-autorisation(s) : ${compte.active} active(s), ` +
    `${compte.consommee} consommée(s), ${compte.expiree} expirée(s), ` +
    `${compte.revoquee} révoquée(s)`
  );
}

/** Instant d'expiration calculé pour l'aperçu (durée en jours depuis maintenant). */
export function expirationDepuis(dureeJours, maintenant = Date.now()) {
  const jours = Number(dureeJours);
  const n = Number.isFinite(jours) && jours >= 1 ? Math.min(DUREE_MAX_JOURS, Math.trunc(jours)) : DUREE_DEFAUT_JOURS;
  return new Date(maintenant + n * 86_400_000).toISOString();
}

/** Libellé d'une machine proposée dans le sélecteur (nom + identifiant court). */
export function libelleAgent(agent) {
  if (!agent || typeof agent.agentId !== "string") return "?";
  const nom = typeof agent.name === "string" && agent.name !== "" ? agent.name : agent.agentId;
  const etat = agent.revoked === true ? " (révoqué)" : "";
  return `${nom} — ${agent.agentId}${etat}`;
}
