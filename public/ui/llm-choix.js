/**
 * CHOIX DES MODÈLES PAR RÔLE — listes déroulantes alimentées par le CATALOGUE
 * (lot B, 2026-11-19).
 *
 * Trois menus, jamais un champ libre : la valeur est un `modeleId` de
 * `llm.modeles`, et tout le reste (fournisseur, adresse, clé, contexte, VISION,
 * RÉFLEXION) en est DÉRIVÉ côté serveur (`src/llm/execution.ts`).
 *
 *  - `/config` → onglet « Modèles » : les TROIS DÉFAUTS D'INSTANCE
 *    (`llm.defaut.*`, portée `instance`) ;
 *  - page d'un bot → onglet « Général » : les TROIS SURCHARGES DU BOT
 *    (`llm.bot.*`, portée `bot`). Valeur vide = « (défaut de l'instance) ».
 *
 * ⚠️ POURQUOI « Modèles » ET PAS « Catalogue » DANS `/config` : « Catalogue »
 * édite ce qui EXISTE (fournisseurs + modèles, par modales), « Modèles » choisit
 * ce qui SERT. Mélanger les deux remettrait un choix de rôle à côté des
 * définitions, et la page Bot doit pouvoir afficher exactement la même chose en
 * version surchargée.
 *
 * ⚠️ SOUS CHAQUE MENU, CE QUI EST RÉELLEMENT UTILISÉ (« effectif : … ») : sans
 * cette ligne, on ne sait pas si un défaut s'applique. Un modèle sans vision
 * choisi comme modèle de discussion n'est PAS une erreur (le repli vision
 * existe) mais il est SIGNALÉ (« ne voit pas les images »).
 *
 * ⚠️ CSP STRICTE : `textContent` uniquement, aucune écriture de style en ligne,
 * aucun appel réseau (aucun test de connexion dans ce lot).
 */

import { MODELE_DISCUSSION_INTRO } from "./modeles-aide.js";

/** Rôles proposés, dans l'ordre d'affichage (mêmes identifiants que le serveur). */
const ROLES = [
  {
    id: "light",
    libelle: "Modèle de discussion",
    aide: MODELE_DISCUSSION_INTRO,
    visionSeulement: false,
  },
  {
    id: "heavy",
    libelle: "Modèle d'exécution (tâches de fond, délégations)",
    aide:
      "Le modèle d'exécution fait le travail long : tâches planifiées, étapes de " +
      "chaîne, délégations, consolidation de la mémoire. Il tourne en arrière-plan, " +
      "il ne parle pas dans la conversation.",
    visionSeulement: false,
  },
  {
    id: "vision",
    libelle: "Modèle de vision (repli)",
    aide:
      "Utilisé UNIQUEMENT pour décrire une image quand le modèle actif ne voit pas " +
      "les images. Seuls les modèles déclarés « Reçoit les images » sont proposés. " +
      "Aucun modèle choisi ⇒ pas de repli : l'image est refusée et c'est dit.",
    visionSeulement: true,
  },
];

function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = value;
    else if (key === "on") for (const [evenement, geste] of Object.entries(value)) el.addEventListener(evenement, geste);
    else if (value === true) el.setAttribute(key, "");
    else if (value !== false) el.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** Liste lue depuis une valeur de configuration (JSON canonique ou vide). */
function lireListe(brut) {
  if (typeof brut !== "string" || brut.trim() === "") return [];
  try {
    const parsed = JSON.parse(brut);
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === "object") : [];
  } catch {
    return [];
  }
}

/** `modeleId` → libellé lisible (`nom · fournisseur`), ou `null` si introuvable. */
export function libelleModele(modeles, fournisseurs, id) {
  const modele = modeles.find((candidat) => String(candidat.id) === id);
  if (!modele) return null;
  const fournisseur = fournisseurs.find((candidat) => candidat.id === modele.fournisseurId);
  const nom = String(modele.nom ?? "");
  return fournisseur ? `${nom} · ${fournisseur.nom}` : nom;
}

/**
 * Modèles PROPOSÉS pour un rôle (PUR, testable sans navigateur).
 *
 * ⚠️ La liste de VISION ne contient QUE les modèles déclarés `vision: true` :
 * proposer un modèle qui ne voit pas les images reviendrait à choisir un modèle
 * incapable de décrire, donc un repli qui échoue au premier envoi.
 */
export function modelesProposes(modeles, role) {
  return role.visionSeulement ? modeles.filter((modele) => modele.vision === true) : modeles;
}

/**
 * Texte de la ligne « effectif : … » — ce qui est RÉELLEMENT utilisé.
 *
 * ⚠️ Cette ligne est la seule façon de savoir si un DÉFAUT d'instance s'applique :
 * le menu d'un bot affiche « (défaut de l'instance) » sans dire lequel. Elle est
 * PURE (aucun DOM) pour être vérifiable : une formulation fausse ferait croire à
 * une surcharge qui n'existe pas.
 *
 * Rendus possibles :
 *  - `effectif : <modèle> · <fournisseur> (défaut de l'instance)` — bot sans surcharge ;
 *  - `effectif : <modèle> · <fournisseur>` — surcharge, ou page d'instance ;
 *  - `effectif : modèle introuvable (« <id> ») — …` — sélection cassée ;
 *  - `<rien de réglé>` — deux textes distincts selon la page.
 */
export function ligneEffective({ modeleId, surcharge, bot, modeles, fournisseurs }) {
  if (modeleId === "") {
    return bot
      ? "effectif : aucun modèle — ni surcharge, ni défaut d'instance : ce bot ne peut pas travailler."
      : "effectif : aucun défaut — chaque bot doit choisir son modèle.";
  }
  const libelle = libelleModele(modeles, fournisseurs, modeleId);
  if (libelle === null) {
    return `effectif : modèle introuvable (« ${modeleId} ») — choisissez un modèle du catalogue.`;
  }
  return bot && surcharge === ""
    ? `effectif : ${libelle} (défaut de l'instance)`
    : `effectif : ${libelle}`;
}

/**
 * Monte les trois menus dans `container`.
 *
 * @param {object} options
 * @param {HTMLElement} options.container conteneur de l'onglet
 * @param {object} options.fields instantané `GET /api/config` ou `/api/bots/<id>/config`
 * @param {boolean} options.bot page d'un bot (surcharges) ou instance (défauts)
 * @param {() => void} options.changed recalcul de l'état « modifications »
 * @returns {() => object} patch des champs modifiés
 */
export function renderChoixModeles({ container, fields, bot, changed }) {
  const fournisseurs = lireListe(fields["llm.fournisseurs"]?.value).map((fournisseur) => ({
    id: String(fournisseur.id ?? ""),
    nom: String(fournisseur.nom ?? fournisseur.id ?? ""),
  }));
  const modeles = lireListe(fields["llm.modeles"]?.value).map((modele) => ({
    id: String(modele.id ?? ""),
    nom: String(modele.nom ?? ""),
    fournisseurId: String(modele.fournisseurId ?? ""),
    vision: modele.vision === true,
    thinking: String(modele.thinking ?? "off"),
  }));
  /** Saisies en attente, par chemin (`""` = défaut de l'instance). */
  const saisies = {};
  const sections = [];

  const cheminDe = (role) => (bot ? `llm.bot.${role.id}` : `llm.defaut.${role.id}`);

  /** Valeur affichée dans le menu : saisie en attente, sinon valeur du snapshot. */
  function valeurAffichee(role) {
    const chemin = cheminDe(role);
    if (Object.hasOwn(saisies, chemin)) return saisies[chemin];
    return String(fields[chemin]?.value ?? "");
  }

  /** Valeur EFFECTIVE (ce que le serveur appliquera) pour ce rôle. */
  function valeurEffective(role) {
    const propre = valeurAffichee(role);
    if (!bot) return propre;
    if (propre !== "") return propre;
    return String(fields[`llm.defaut.${role.id}`]?.value ?? "");
  }

  function dessiner() {
    for (const noeud of sections.splice(0)) noeud.remove();
    /** Monte un nœud DANS L'ORDRE et le retient pour le prochain redessin. */
    const ajouter = (noeud) => {
      container.append(noeud);
      sections.push(noeud);
      return noeud;
    };
    const section = h("section", { class: "config-group" }, [
      h("h2", {
        class: "config-group__title",
        text: bot ? "Modèles de ce bot" : "Modèles par défaut de l'installation",
      }),
      h("p", {
        class: "config-helper config-group__intro",
        text: bot
          ? "Ce bot utilise les modèles par défaut de l'installation, sauf ceux que " +
            "vous choisissez ici. Les modèles eux-mêmes se déclarent dans " +
            "Configuration → Catalogue."
          : "Chaque bot utilise ces modèles, sauf s'il en choisit un autre. Les " +
            "modèles eux-mêmes (fournisseur, contexte, vision, réflexion) se " +
            "déclarent dans l'onglet « Catalogue ».",
      }),
    ]);
    ajouter(section);

    for (const role of ROLES) {
      const chemin = cheminDe(role);
      const valeur = valeurAffichee(role);
      const proposes = modelesProposes(modeles, role);
      const select = h("select", { class: "config-select" });
      const vide = bot ? "(défaut de l'instance)" : "(aucun défaut)";
      select.add(new Option(vide, ""));
      for (const modele of proposes) {
        const fournisseur = fournisseurs.find((candidat) => candidat.id === modele.fournisseurId);
        const libelle = fournisseur ? `${modele.nom} · ${fournisseur.nom}` : modele.nom;
        select.add(new Option(libelle, modele.id));
      }
      // ⚠️ Une sélection HORS LISTE (modèle supprimé, modèle devenu « sans
      // vision ») n'est jamais escamotée : elle reste visible en tête, avec sa
      // raison, pour qu'on puisse la remplacer en connaissance de cause.
      if (valeur !== "" && !proposes.some((modele) => modele.id === valeur)) {
        const libelle = libelleModele(modeles, fournisseurs, valeur);
        select.add(
          new Option(
            libelle === null
              ? `« ${valeur} » (introuvable)`
              : `${libelle} (ne voit pas les images)`,
            valeur,
          ),
        );
      }
      select.value = valeur;
      select.addEventListener("change", () => {
        saisies[chemin] = select.value;
        changed();
        dessiner();
      });

      const effectif = h("p", {
        class: "config-helper",
        text: ligneEffective({
          modeleId: valeurEffective(role),
          surcharge: valeurAffichee(role),
          bot,
          modeles,
          fournisseurs,
        }),
      });
      const badges = h("div", { class: "config-badges" });
      const modeleEffectif = modeles.find((modele) => modele.id === valeurEffective(role));
      if (role.visionSeulement === false && modeleEffectif && modeleEffectif.vision !== true) {
        // ⚠️ Ce n'est PAS une erreur : le repli vision existe. On le DIT quand même.
        badges.append(h("span", { class: "badge badge--origin-default", text: "ne voit pas les images" }));
      }
      if (modeleEffectif && role.visionSeulement === false) {
        badges.append(
          h("span", { class: "badge badge--origin-store", text: `réflexion ${modeleEffectif.thinking}` }),
        );
      }

      ajouter(
        h("div", { class: "config-row" }, [
          h("span", { class: "config-label", text: role.libelle }),
          select,
          h("p", { class: "config-helper", text: role.aide }),
          effectif,
          badges,
        ]),
      );
    }
  }

  dessiner();

  return () => {
    const patch = {};
    for (const [chemin, valeur] of Object.entries(saisies)) {
      if (valeur === String(fields[chemin]?.value ?? "")) continue;
      // `null` = revenir au défaut (le serveur efface la clé de l'overlay).
      patch[chemin] = valeur === "" ? null : valeur;
    }
    return patch;
  };
}
