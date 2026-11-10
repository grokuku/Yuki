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
 * AJOUTER / SUPPRIMER UN BOT (lot 35e) — données et textes PURS, sans DOM.
 *
 * ⚠️ Ce module est la SEULE source des libellés, des défauts de clonage et des
 * messages de confirmation. Les tests les croisent avec le serveur
 * (`src/bots/admin.ts` : `MAX_BOTS`, `ELEMENTS_CLONE`, `RETENTION_ARCHIVES_JOURS`)
 * pour qu'interface et serveur ne divergent jamais.
 */

/** Nombre maximal de bots (copie de `MAX_BOTS`, vérifiée par un test). */
export const MAX_BOTS_PAGE = 6;

/** Longueur maximale du nom affiché (copie de `NOM_BOT_MAX`, vérifiée par test). */
export const NOM_BOT_MAX_PAGE = 40;

/**
 * Slug : `^[a-z0-9][a-z0-9-]{1,30}$` (copie de `SLUG_BOT_PATTERN`, vérifiée par
 * test). ⚠️ IMMUABLE : il nomme un dossier, il n'est jamais modifiable après
 * création.
 */
export const SLUG_BOT_PATTERN_PAGE = /^[a-z0-9][a-z0-9-]{1,30}$/;

/** Rétention des archives d'un bot supprimé (copie serveur, vérifiée par test). */
export const RETENTION_ARCHIVES_JOURS_PAGE = 90;

/**
 * Profils proposés à la création (ordre d'affichage) — ⚠️ avec ce que le profil
 * AUTORISE VRAIMENT (lot 35f).
 *
 * ⚠️ Avant ce lot, `profil` n'était qu'une ÉTIQUETTE : un bot `lecture` avait
 * exactement les mêmes pouvoirs qu'un bot `complet` (commande, capture d'écran,
 * agents, secrets, délégation). Ces phrases disent donc ce que l'interface ne
 * disait pas. Elles sont VÉRIFIÉES par test (`tests/ui/config-pages.test.ts`) :
 * un profil qui gagne un outil sans que sa phrase change fait échouer la garde.
 *
 * ⚠️ Aucune phrase ne doit promettre un pouvoir absent, ni taire un pouvoir
 * présent : c'est la seule règle de rédaction de ce bloc.
 */
export const PROFILS_BOT_PAGE = [
  {
    id: "complet",
    libelle: "Complet",
    capacites:
      "Tout ce que l'installation permet : lecture des fichiers (read, ls, grep, find), " +
      "agents et secrets, outils distants, libraire et pages web, images, délégation à un " +
      "worker lourd (commandes et captures d'écran), envois programmés et tâches planifiées.",
  },
  {
    id: "lecture",
    libelle: "Lecture",
    capacites:
      "Aucune action sur une machine, aucun fichier du système : ni commande, ni capture " +
      "d'écran, ni agents, ni secrets, ni délégation, ni envoi programmé, ni tâche " +
      "planifiée, ni archivage. Il lui reste : répondre, envoyer et lire les fichiers de " +
      "la conversation, publier dans un canal suivi, consulter le libraire et les pages " +
      "web, générer des images.",
  },
  {
    id: "accueil",
    libelle: "Accueil",
    capacites:
      "Répondre, envoyer et lire les fichiers de la conversation, publier dans un canal " +
      "suivi. Rien d'autre : ni commande, ni capture d'écran, ni agents, ni secrets, ni " +
      "délégation, ni libraire, ni images, ni envoi programmé, ni tâche planifiée.",
  },
];

/**
 * Entrée de profil correspondant à un identifiant, ou `null` si inconnu.
 *
 * ⚠️ Le serveur REFUSE un profil inconnu au registre (il ne peut donc pas en
 * arriver un ici) : `null` est le garde-fou d'affichage, pas une valeur métier.
 */
export function profilDePage(id) {
  const cle = typeof id === "string" ? id.trim() : "";
  return PROFILS_BOT_PAGE.find((profil) => profil.id === cle) ?? null;
}

/**
 * Éléments clonables — ⚠️ DÉFAUTS DÉCIDÉS PAR L'UTILISATEUR :
 * identité et capacités OUI ; mémoire, déclencheurs et agents NON.
 *
 * ⚠️ « Mémoire » décochée parce qu'un bot cloné AVEC la mémoire de l'original
 * croirait avoir vécu la même chose. « Agents » est affiché mais INACTIF : la
 * liste des bots autorisés par agent n'existe pas encore (rien n'est copié).
 */
export const CLONE_ELEMENTS = [
  {
    id: "identite",
    libelle: "Identité",
    aide: "Personnalité, règles et avatar.",
    defaut: true,
  },
  {
    id: "capacites",
    libelle: "Capacités",
    aide: "Profil du bot et réglages de configuration.",
    defaut: true,
  },
  {
    id: "memoire",
    libelle: "Mémoire",
    aide: "Souvenirs, archives et héritage — décoché : le clone croirait avoir vécu la même chose.",
    defaut: false,
  },
  {
    id: "declencheurs",
    libelle: "Déclencheurs",
    aide: "Sources, boîte de réception et journal — décoché : deux bots ne doivent pas tirer la même tâche.",
    defaut: false,
  },
  {
    id: "agents",
    libelle: "Agents autorisés",
    aide: "Pas encore disponible : la liste des bots autorisés par agent n'existe pas encore (rien n'est copié).",
    defaut: false,
    indisponible: true,
  },
];

/** Défauts de clonage sous forme d'objet (`{ identite: true, memoire: false, … }`). */
export function defautsClone() {
  return Object.fromEntries(CLONE_ELEMENTS.map((element) => [element.id, element.defaut]));
}

/**
 * Valide le formulaire de création AVANT l'appel réseau.
 *
 * @param {{ nom?: string, slug?: string, existants?: string[] }} [formulaire]
 * @returns {{ ok: boolean, champs: Record<string, string>, slug: string }}
 */
export function validerCreationBot(formulaire = {}) {
  const champs = {};
  const nom = String(formulaire.nom ?? "").trim();
  const slug = String(formulaire.slug ?? "")
    .trim()
    .toLowerCase();
  if (nom === "") champs.nom = "Le nom du bot est obligatoire.";
  else if (nom.length > NOM_BOT_MAX_PAGE) {
    champs.nom = `Le nom est trop long (maximum ${NOM_BOT_MAX_PAGE} caractères).`;
  }
  if (!SLUG_BOT_PATTERN_PAGE.test(slug)) {
    champs.slug =
      "Slug invalide : 2 à 31 caractères, minuscules, chiffres et « - » uniquement " +
      "(exemple : kohai-2).";
  } else if ((formulaire.existants ?? []).includes(slug)) {
    champs.slug = `Le slug « ${slug} » est déjà utilisé par un autre bot.`;
  }
  return { ok: Object.keys(champs).length === 0, champs, slug };
}

/**
 * Spécification de la modale d'AJOUT (« ＋ ») — remplace l'ancienne modale
 * « bientôt disponible ». La création est VRAIE : elle appelle `POST /api/bots`.
 *
 * @param {{ bots?: Array<{ id: string, nom?: string }>, maxBots?: number }} [etat]
 */
export function modaleCreationBot(etat = {}) {
  const bots = Array.isArray(etat.bots) ? etat.bots : [];
  const maxBots = etat.maxBots ?? MAX_BOTS_PAGE;
  return {
    titre: "Ajouter un bot",
    message:
      "Le bot est créé immédiatement : son dossier et ses chemins sont préparés, " +
      "et son identifiant (slug) ne pourra plus changer.",
    maxBots,
    atteint: bots.length >= maxBots,
    limite:
      `Limite de ${maxBots} bots par instance : au-delà, supprimez un bot avant ` +
      "d'en ajouter un autre.",
    profils: PROFILS_BOT_PAGE,
    elements: defautsClone(),
    cloneables: bots.map((bot) => ({
      id: bot.id,
      libelle: bot.nom && bot.nom !== bot.id ? `${bot.nom} (${bot.id})` : bot.id,
    })),
  };
}

/** Taille lisible (« 12,3 ko », « 4,1 Mo ») — jamais un nombre d'octets brut. */
export function libelleTaille(octets) {
  const valeur = Number.isFinite(Number(octets)) ? Math.max(0, Number(octets)) : 0;
  if (valeur < 1024) return `${valeur} o`;
  if (valeur < 1024 * 1024) return `${(valeur / 1024).toFixed(1).replace(".", ",")} ko`;
  return `${(valeur / (1024 * 1024)).toFixed(1).replace(".", ",")} Mo`;
}

/** Phrase de la case à cocher EXPLICITE (motif du lot 30). */
export function confirmationSuppressionBot() {
  return "Je comprends que ce bot sera retiré et que ses données seront conservées 3 mois avant d'être effacées.";
}

/**
 * Texte RÉEL de la confirmation de suppression : compteurs mesurés + rétention.
 *
 * @param {{ bot?: { id?: string, nom?: string }, compteurs?: object, retentionJours?: number }} [etat]
 */
export function texteSuppressionBot(etat = {}) {
  const bot = etat.bot ?? {};
  const nom = bot.nom && bot.nom !== bot.id ? `${bot.nom} (${bot.id})` : bot.id ?? "ce bot";
  const compteurs = etat.compteurs ?? {};
  const nombre = (valeur) => (Number.isFinite(Number(valeur)) ? Number(valeur) : 0);
  const retention = etat.retentionJours ?? RETENTION_ARCHIVES_JOURS_PAGE;
  return (
    `« ${nom} » sera retiré de la liste des bots. Rien n'est effacé : son dossier est ` +
    "DÉPLACÉ dans les archives de l'instance, avec : " +
    `${nombre(compteurs.conversations)} conversation(s) archivée(s), ` +
    `${nombre(compteurs.souvenirs)} souvenir(s), ` +
    `${nombre(compteurs.declencheurs)} déclencheur(s), ` +
    `${libelleTaille(compteurs.octets)} de données. ` +
    `Ces données sont CONSERVÉES 3 mois (${retention} jours), puis effacées ` +
    "définitivement par le balayeur de l'instance."
  );
}
