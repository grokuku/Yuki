/**
 * LES DEUX PAGES DE CONFIGURATION (lot 35d, sous-lot 1b-4) — logique PURE,
 * sans DOM : testable sans navigateur.
 *
 * Depuis la scission Instance / Bot, la configuration se lit sur DEUX pages :
 *
 *  - **Instance** (`/config`) : ce qui est commun à toute l'installation
 *    (modèles, exécution, images, agents, secrets, système, maintenance) ;
 *  - **Bot** (`/bots?b=<slug>`) : ce qui est propre à UN bot (général,
 *    personnalité, voix, mémoire, plateformes, déclencheurs).
 *
 * ⚠️ LA RÈGLE EST LA PORTÉE, PAS LA PAGE. Chaque clé du schéma porte un
 * `scope` (`instance` | `bot` | `mixte`, `src/config/schema.ts`) servi par
 * `GET /api/config` et `GET /api/bots/<id>/config`. Une page ne rend QUE les
 * clés que sa portée autorise :
 *
 *  - Instance ⇒ `instance` + `mixte` (le côté INSTANCE d'une clé mixte) ;
 *  - Bot      ⇒ `bot` + `mixte` (le côté BOT d'une clé mixte).
 *
 * Une clé `mixte` est donc rendue sur LES DEUX pages, une seule fois par page :
 * c'est ce qui permet de régler la valeur commune (Instance) ET la surcharge du
 * bot (Bot) sans jamais écrire deux fois la même clé dans un même écran.
 *
 * Aucune injection de markup, aucun style inline : ce module ne touche pas au DOM.
 */

/**
 * @typedef {{ id: string, libelle: string }} Onglet
 * @typedef {{ instance?: string, bot?: string }} OngletsDuGroupe
 * @typedef {{ path: string, label: string }} ChampCatalogue
 * @typedef {{ texte: string, lien: { href: string, libelle: string } }} Renvoi
 * @typedef {{
 *   id: string,
 *   tabs: OngletsDuGroupe,
 *   fields: ReadonlyArray<ChampCatalogue>,
 *   renvoi?: object,
 * }} GroupeCatalogue
 */

/**
 * Onglets de chaque page, dans l'ordre d'affichage.
 *
 * ⚠️ L'ordre et les libellés sont VERROUILLÉS par des tests (7 onglets pour
 * l'Instance, 6 pour un Bot) : ce sont eux que lisent les utilisateurs et les
 * harnais E2E.
 */
/** @type {Record<string, { id: string, nom: string, scopes: string[], ligne: string, onglets: Onglet[] }>} */
export const PAGES = {
  instance: {
    id: "instance",
    /** Titre de la page (bandeau). */
    nom: "Instance",
    /** Portées rendues par cette page. */
    scopes: ["instance", "mixte"],
    /** Phrase affichée SOUS le titre : dit où est allé ce qui a déménagé. */
    ligne:
      "Restent communs : Modèles, Exécution, Images, Agents, Secrets, Système, " +
      "Maintenance. Ce qui est propre à un bot est dans Bot.",
    onglets: [
      { id: "modeles", libelle: "Modèles" },
      { id: "execution", libelle: "Exécution" },
      { id: "images", libelle: "Images" },
      { id: "agents", libelle: "Agents" },
      { id: "secrets", libelle: "Secrets" },
      { id: "systeme", libelle: "Système" },
      { id: "maintenance", libelle: "Maintenance" },
    ],
  },
  bot: {
    id: "bot",
    nom: "Bot",
    scopes: ["bot", "mixte"],
    ligne:
      "Ce qui est propre à un bot est dans Bot — les réglages communs à " +
      "l'instance sont dans Configuration.",
    onglets: [
      { id: "general", libelle: "Général" },
      { id: "personnalite", libelle: "Personnalité" },
      { id: "voix", libelle: "Voix" },
      { id: "memoire", libelle: "Mémoire" },
      { id: "plateformes", libelle: "Plateformes" },
      { id: "declencheurs", libelle: "Déclencheurs" },
    ],
  },
};

/** Identifiants de page connus. */
export const IDS_DE_PAGE = Object.keys(PAGES);

/** `true` si `pageId` désigne une page connue. */
export function pageConnue(pageId) {
  return Object.prototype.hasOwnProperty.call(PAGES, pageId);
}

/** Définition d'une page, ou `null`. */
export function pageDe(pageId) {
  return pageConnue(pageId) ? PAGES[pageId] : null;
}

/**
 * Onglets d'une page (tableau vide si la page est inconnue).
 * @param {string} pageId
 * @returns {Onglet[]}
 */
export function ongletsDePage(pageId) {
  return pageDe(pageId)?.onglets ?? [];
}

/**
 * `true` si cette portée de clé est rendue par cette page.
 * @param {string} pageId
 * @param {string} scope
 * @returns {boolean}
 */
export function porteeRendue(pageId, scope) {
  const page = pageDe(pageId);
  if (!page) return false;
  return page.scopes.includes(scope);
}

/**
 * Identifiants d'onglets d'une page (pour valider une ancre ou un hash).
 * @param {string} pageId
 * @returns {string[]}
 */
export function idsOnglets(pageId) {
  return ongletsDePage(pageId).map((onglet) => onglet.id);
}

/**
 * Groupes de champs rendus par une page, dans l'ordre de la déclaration.
 * Un groupe se déclare `tabs: { instance: "systeme", bot: "voix" }` : l'absence
 * d'entrée pour une page signifie que le groupe n'y a AUCUN champ (toutes ses
 * clés sont d'une autre portée).
 */
/**
 * @param {string} pageId
 * @param {GroupeCatalogue[]} groups
 * @returns {GroupeCatalogue[]}
 */
export function groupesDePage(pageId, groups) {
  return (groups ?? []).filter((group) => typeof group?.tabs?.[pageId] === "string");
}

/**
 * Champs d'un groupe rendus par une page : ceux dont la portée est autorisée.
 *
 * ⚠️ `scopes` vient du SNAPSHOT du serveur (chemin → `"instance"|"bot"|"mixte"`),
 * jamais d'un miroir côté navigateur : le schéma est l'autorité unique.
 * Une portée inconnue (gateway antérieur au découpage) est rendue côté INSTANCE
 * seulement — c'est là que vivaient TOUS les réglages avant ce lot.
 */
/**
 * @param {string} pageId
 * @param {GroupeCatalogue} group
 * @param {Record<string, string>} [scopes]
 * @returns {ChampCatalogue[]}
 */
export function champsDePage(pageId, group, scopes = {}) {
  const champs = Array.isArray(group?.fields) ? group.fields : [];
  return champs.filter((field) => porteeRendue(pageId, scopeDeCle(scopes, field.path)));
}

/**
 * Portée effective d'une clé (repli documenté : `instance`).
 * @param {Record<string, string>} scopes
 * @param {string} path
 * @returns {string}
 */
export function scopeDeCle(scopes, path) {
  const scope = scopes?.[path];
  return scope === "bot" || scope === "mixte" ? scope : "instance";
}

/**
 * Onglets RÉELLEMENT utilisés par une page : `{ [ongletId]: [groupe, ...] }`.
 * Sert au rendu ET au contrôle de couverture (aucun groupe orphelin).
 */
/**
 * @param {string} pageId
 * @param {GroupeCatalogue[]} groups
 * @returns {Record<string, GroupeCatalogue[]>}
 */
export function groupesParOnglet(pageId, groups) {
  const parOnglet = {};
  for (const onglet of ongletsDePage(pageId)) parOnglet[onglet.id] = [];
  for (const group of groupesDePage(pageId, groups)) {
    const ongletId = group.tabs[pageId];
    if (!parOnglet[ongletId]) continue;
    parOnglet[ongletId].push(group);
  }
  return parOnglet;
}

/**
 * ANCRES PROFONDES : id d'un CONTRÔLE → onglet qui le contient, PAR PAGE.
 *
 * ⚠️ `/bots?b=<slug>#chat-remote-agents` doit ouvrir « Plateformes » et défiler
 * jusqu'au réglage « Agents distants » ; `/bots?b=<slug>#declencheurs` ouvre la
 * page de gestion des sources. Ces ancres sont celles que nomment les messages
 * de refus et les liens de l'interface : sans elles, on ne trouve pas le
 * réglage.
 *
 * ⚠️ La correspondance se fait par ID D'ÉLÉMENT, jamais par GROUPE de champs.
 * Une ancre inconnue retombe sur le premier onglet de la page.
 */
/** @type {Record<string, Array<[string, string]>>} */
export const ANCRES_PROFONDES = {
  instance: [],
  bot: [
    // « Agents distants » / « Outils distants » (contrôles de `chat-panel.js`).
    ["chat-remote-agents", "plateformes"],
    ["chat-remote-tools", "plateformes"],
    // Page de gestion des déclencheurs : `#declencheurs` (lien de la boîte de
    // notifications), `#sources` (ancien lien, conservé) et
    // `#journal-declencheurs` (colonne « dernier résultat »).
    ["declencheurs", "declencheurs"],
    ["sources", "declencheurs"],
    ["journal-declencheurs", "declencheurs"],
  ],
};

/**
 * Identifiant d'onglet visé par un hash, sur une page donnée (`null` sinon).
 * @param {string} pageId
 * @param {string} hash
 * @returns {string | null}
 */
export function ongletDuHash(pageId, hash) {
  const raw = String(hash ?? "").replace(/^#/, "");
  if (raw === "") return null;
  if (idsOnglets(pageId).includes(raw)) return raw;
  const ancre = (ANCRES_PROFONDES[pageId] ?? []).find(([cle]) => cle === raw);
  return ancre ? ancre[1] : null;
}

/**
 * Ligne d'explication affichée SOUS le titre de la page : elle dit ce qui est
 * resté commun et où est allé le reste. Jamais un texte vide.
 * @param {string} pageId
 * @returns {string}
 */
export function ligneDePage(pageId) {
  return pageDe(pageId)?.ligne ?? "";
}

/**
 * Modale de CHANGEMENT DE BOT quand des modifications ne sont pas enregistrées.
 *
 * ⚠️ TROIS CHOIX explicites, aucun défaut : « Enregistrer » (écrit puis
 * change de bot), « Abandonner » (jette les saisies puis change de bot),
 * « Rester sur ce bot » (ne change rien). Jamais une confirmation native du
 * navigateur.
 *
 *   `null` quand rien n'est en attente : le changement se fait alors sans modale.
 * @param {{ sale?: boolean, botActuel?: string, botVise?: string }} [etat]
 * @returns {null | { titre: string, message: string, boutons: Array<{ text: string, value: string, type: string }> }}
 */
export function demandeChangementBot(etat = {}) {
  if (!etat.sale) return null;
  const vise = typeof etat.botVise === "string" && etat.botVise !== "" ? etat.botVise : "ce bot";
  return {
    titre: "Modifications non enregistrées",
    message:
      "Vous avez des modifications non enregistrées sur ce bot. Que faire avant " +
      `de passer à « ${vise} » ?`,
    boutons: [
      { text: "Enregistrer", value: "enregistrer", type: "primary" },
      { text: "Abandonner", value: "abandonner", type: "danger" },
      { text: "Rester sur ce bot", value: "rester", type: "cancel" },
    ],
  };
}

/**
 * Modale de l'écran d'AJOUT de bot (« ＋ »).
 *
 * ⚠️ L'écran d'ajout est un LOT ULTÉRIEUR : la modale le DIT, elle ne promet
 * rien et ne crée rien. Créer un bot à moitié (un nom sans dossiers, sans
 * chemins, sans migration) laisserait une instance incohérente.
 */
export function modaleAjoutBot() {
  return {
    titre: "Ajouter un bot — bientôt disponible",
    message:
      "La création d'un bot depuis cette page arrive dans un lot ultérieur : " +
      "elle doit préparer les dossiers, les chemins et la migration des données " +
      "du nouveau bot. En attendant, Yuki fonctionne avec ses bots déjà déclarés.",
    okText: "Compris",
  };
}
