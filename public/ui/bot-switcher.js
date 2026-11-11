/**
 * SÉLECTEUR DE BOTS DE LA BARRE DU HAUT — DOM (lot 37).
 *
 * ⚠️ LA DEMANDE INITIALE DU MULTI-BOT, ENFIN LIVRÉE : « dans la barre de titre il
 * y a écrit Yuki avec son avatar, on pourrait disposer de plusieurs bots à cet
 * endroit ». L'avatar de la barre du haut devient un BOUTON qui ouvre la LISTE
 * des bots — pas une page de paramètres.
 *
 * Ce que le panneau fait, et rien d'autre :
 *  ① il LISTE **tous** les bots (`GET /api/bots`), avec leur état d'EXÉCUTION
 *    réel (`execution.demarre` / `execution.erreur`) — un bot ARRÊTÉ est visible,
 *    avec un bouton « Démarrer » (c'était le blocage : impossible d'allumer un
 *    bot neuf sans passer par les paramètres) ;
 *  ② cliquer un bot DÉMARRÉ ouvre SA conversation (`?b=<slug>` : l'URL, le fil et
 *    le WebSocket suivent) ; cliquer un bot ARRÊTÉ le DÉMARRE d'abord, puis
 *    ouvre sa conversation ;
 *  ③ « Ajouter un bot » ouvre la modale EXISTANTE (`bots-admin.js`) ;
 *  ④ clic droit / appui long sur l'avatar d'une entrée : la BOUCLE entre bots
 *    (`echanges["a->b"].actif`), on/off, sans frein par paire.
 *
 * ⚠️ CSP INCHANGÉE : `textContent` partout, jamais `innerHTML`, aucun `.style.`
 * (le panneau est positionné par `styles.css`), aucune URL distante.
 * ⚠️ TÉLÉPHONE : la barre du haut est le SEUL endroit toujours visible ; le tap
 * ET l'appui long ouvrent le panneau (`long-press.js`, motif des listes).
 */

import { attachLongPress } from "./long-press.js";
import { ouvrirCreationBot, ouvrirSuppressionBot } from "./bots-admin.js";
import {
  PLAFOND_ACTIFS_DEFAUT,
  entreeListe,
  messageBandeauBot,
  nomBarreHaut,
  pairesEchange,
  resumeBots,
  urlConversationBot,
} from "./bot-switcher-modele.js";

/** En-têtes d'écriture (mêmes que la page de configuration). */
const ENTETES_ECRITURE = {
  "content-type": "application/json",
  "x-yuki-config": "1",
};

/** Durée d'affichage d'un message de statut (ms). */
const STATUT_MS = 6000;

/**
 * Construit un nœud DOM. ⚠️ Jamais de chaîne HTML : chaque texte passe par
 * `textContent` (CSP `style-src 'self'`, aucune injection).
 */
function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = value;
    else if (value === true) el.setAttribute(key, "");
    else if (value !== false && value !== undefined && value !== null) {
      el.setAttribute(key, String(value));
    }
  }
  for (const child of [].concat(children)) {
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** `true` si `noeud` est `racine` ou l'un de ses descendants. */
function contient(racine, noeud) {
  let courant = noeud;
  while (courant) {
    if (courant === racine) return true;
    courant = courant.parentNode ?? courant.parent ?? null;
  }
  return false;
}

/**
 * Monte le sélecteur de bots de la barre du haut.
 *
 * @param {object} options
 * @param {HTMLElement} options.button bouton de la barre du haut (l'avatar).
 * @param {HTMLElement} options.panel le panneau (`role="dialog"`, `hidden`).
 * @param {HTMLElement} options.list la liste (`<ul>`).
 * @param {HTMLElement} [options.plafondEl] la ligne de synthèse du panneau.
 * @param {HTMLElement} [options.statusEl] la zone de message (`role="status"`).
 * @param {HTMLElement} [options.addButton] « Ajouter un bot ».
 * @param {HTMLElement} [options.closeButton] « Fermer ».
 * @param {HTMLElement} [options.nomEl] nom affiché DANS le bouton de la barre du
 *   haut (`#bot-switcher-nom`) : il suit le bot AFFICHÉ, avec le slug entre
 *   parenthèses si deux bots portent le même nom.
 * @param {Function} [options.avantNaviguer] garde exécutée AVANT d'ouvrir une
 *   conversation (`async (id) => boolean`). `false` = ne pas naviguer (page de
 *   configuration : modifications non enregistrées).
 * @param {object} options.HolafModal brique de modale existante (ajout d'un bot).
 * @param {Function} [options.fetchImpl] remplaçant de `fetch` (tests).
 * @param {Function} [options.naviguer] remplaçant de `location.assign` (tests).
 * @param {Function} [options.recherche] remplaçant de `location.search` (tests).
 * @param {Function} [options.avatarPrincipal] src de l'avatar du bot principal.
 * @param {number} [options.statutMs] durée d'affichage d'un message (0 = collant,
 *   utilisé par les tests pour ne laisser aucun minuteur derrière eux).
 * @returns {{rafraichir: Function, ouvrir: Function, fermer: Function,
 *   basculer: Function, etat: Function, demarrer: Function}}
 */
export function initBotSwitcher(options) {
  const doFetch = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const naviguer =
    options.naviguer ??
    ((url) => {
      if (typeof location !== "undefined" && typeof location.assign === "function") {
        location.assign(url);
      }
    });
  const recherche = options.recherche ?? (() => globalThis.location?.search ?? "");
  const avatarPrincipal =
    typeof options.avatarPrincipal === "function"
      ? options.avatarPrincipal
      : () => null;

  const button = options.button;
  const panel = options.panel;
  const list = options.list;
  const plafondEl = options.plafondEl ?? null;
  const statusEl = options.statusEl ?? null;
  const addButton = options.addButton ?? null;
  const closeButton = options.closeButton ?? null;
  const nomEl = options.nomEl ?? null;
  const avantNaviguer =
    typeof options.avantNaviguer === "function" ? options.avantNaviguer : null;
  /**
   * URL à ouvrir pour un bot : la conversation par défaut, la page de SES
   * réglages sur `/bots` (`urlPour: (entree) => "/bots?b=…"`). Une seule règle
   * de sélection, deux destinations.
   */
  const urlPour =
    typeof options.urlPour === "function" ? options.urlPour : (entree) => entree.url;
  const HolafModal = options.HolafModal;
  const dureeStatut =
    Number.isFinite(options.statutMs) && options.statutMs >= 0
      ? options.statutMs
      : STATUT_MS;

  /** Liste de bots telle que le SERVEUR l'a rendue (source unique). */
  let bots = [];
  let plafond = PLAFOND_ACTIFS_DEFAUT;
  let principal = null;
  let echanges = {};
  /** Bots `actif` REFUSÉS au démarrage par le plafond (`bots.maxActifs`). */
  let refuses = [];
  /** Identifiant du bot dont le menu de boucle est ouvert, ou `null`. */
  let menuBotId = null;
  let ouvert = false;
  let statutTimer = null;
  /** `true` pendant un aller-retour d'écriture : les boutons sont neutralisés. */
  let occupe = false;

  function botCourant() {
    const valeur = new URLSearchParams(recherche()).get("b");
    return typeof valeur === "string" && valeur.trim() !== "" ? valeur.trim() : principal;
  }

  function direStatut(texte, { erreur = false } = {}) {
    if (!statusEl) return;
    if (statutTimer !== null) {
      clearTimeout(statutTimer);
      statutTimer = null;
    }
    statusEl.textContent = texte;
    statusEl.hidden = texte === "";
    statusEl.classList?.toggle?.("bot-switcher__status--erreur", erreur);
    if (texte !== "" && dureeStatut > 0) {
      statutTimer = setTimeout(() => {
        statutTimer = null;
        statusEl.textContent = "";
        statusEl.hidden = true;
      }, STATUT_MS);
    }
  }

  function messageErreur(donnees, defaut) {
    // ⚠️ Le message du SERVEUR est repris tel quel : il nomme le plafond réel
    // (`bots.maxActifs`), les bots déjà allumés, ou l'erreur de démarrage.
    if (donnees && typeof donnees.message === "string" && donnees.message !== "") {
      return donnees.message;
    }
    return defaut;
  }

  /** Lit la liste (et les trois informations que le panneau doit dire vrai). */
  async function rafraichir() {
    try {
      const response = await doFetch("/api/bots", {
        headers: { accept: "application/json", "x-yuki-config": "1" },
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const donnees = await response.json();
      const liste = Array.isArray(donnees?.bots) ? donnees.bots : [];
      if (liste.length === 0) throw new Error("liste vide");
      bots = liste;
      plafond =
        Number.isInteger(donnees?.plafond) && donnees.plafond > 0
          ? donnees.plafond
          : PLAFOND_ACTIFS_DEFAUT;
      principal = typeof donnees?.principal === "string" ? donnees.principal : null;
      refuses = Array.isArray(donnees?.refuses)
        ? donnees.refuses.filter((id) => typeof id === "string")
        : [];
      echanges =
        donnees?.echanges !== null && typeof donnees?.echanges === "object"
          ? donnees.echanges
          : {};
      // ⚠️ TÉLÉPHONE : la marque n'est révélée que si l'instance a PLUSIEURS
      // bots (`body.has-bot-switcher`) — une instance mono-bot sans avatar garde
      // exactement la barre du haut d'avant, comme le veut la garde du lot 34.
      document.body?.classList?.toggle?.("has-bot-switcher", bots.length > 1);
      rendre();
      return bots;
    } catch {
      // Jamais d'écran muet : on le dit, et on garde la liste précédente.
      direStatut(
        "La liste des bots n'a pas pu être lue (gateway injoignable). " +
          "Réessayez dans un instant.",
        { erreur: true },
      );
      rendre();
      return bots;
    }
  }

  /** Construit l'avatar d'une entrée : image du principal, sinon monogramme. */
  function avatarDe(entree) {
    const avatar = h("span", {
      class: `bot-switcher__avatar ${entree.avatarClasse}`,
      "aria-hidden": "true",
    });
    const src = entree.principal ? avatarPrincipal() : null;
    if (typeof src === "string" && src !== "") {
      avatar.append(h("img", { class: "avatar avatar--brand", src, alt: "" }));
    } else {
      avatar.textContent = entree.monogramme;
    }
    return avatar;
  }

  /**
   * Menu d'une ENTRÉE (clic droit / appui long sur son nom+avatar) :
   *  ① DÉMARRER / ARRÊTER le bot ;
   *  ② les BOUCLES entre bots (on/off, une par paire orientée) ;
   *  ③ le RETRAIT du bot (modale existante).
   *
   * ⚠️ Le retrait vit ICI (et pas à côté de « Démarrer ») : un bouton destructeur
   * au même niveau que le bouton qu'on utilise tous les jours finirait cliqué
   * par erreur. Le libellé est « Retirer ce bot… », jamais « Supprimer » : les
   * harnais E2E cliquent « Supprimer » au texte près, et un doublon masqué
   * détournerait leur clic (constaté : 3 échecs de `e2e-sources`).
   */
  function menuEntree(entree) {
    const paires = pairesEchange(entree.id, bots, echanges);
    const bloc = h("div", { class: "bot-switcher__menu", role: "menu" });
    bloc.append(
      h("p", {
        class: "bot-switcher__menu-titre",
        text: `Bot « ${entree.nomAffiche} »`,
      }),
    );
    // ① DÉMARRER / ARRÊTER — le bot PRINCIPAL suit le gateway : la ligne le dit
    // et reste inerte (le serveur refuserait), plutôt que de faire semblant.
    if (entree.principal) {
      bloc.append(
        h("button", {
          class: "bot-switcher__menu-item",
          type: "button",
          text: "Démarrer / Arrêter — bot principal : il suit le gateway",
          disabled: true,
        }),
      );
    } else if (entree.demarre) {
      const arreter = h("button", {
        class: "bot-switcher__menu-item",
        type: "button",
        text: `Arrêter « ${entree.nomAffiche} »`,
        "aria-label": `Arrêter le bot « ${entree.nomAffiche} »`,
      });
      arreter.addEventListener("click", () => {
        void arreterBot(entree);
      });
      bloc.append(arreter);
    } else {
      const demarrer = h("button", {
        class: "bot-switcher__menu-item",
        type: "button",
        text: `Démarrer « ${entree.nomAffiche} »`,
        "aria-label": `Démarrer le bot « ${entree.nomAffiche} »`,
      });
      demarrer.addEventListener("click", () => {
        void demarrer(entree);
      });
      bloc.append(demarrer);
    }
    bloc.append(
      h("p", {
        class: "bot-switcher__menu-titre",
        text: `Boucles depuis « ${entree.nomAffiche} »`,
      }),
    );
    if (paires.length === 0) {
      // ⚠️ On NE quitte PAS ici : l'entrée de RETRAIT doit rester atteignable,
      // même sur une instance à un seul bot (c'est là que le refus « dernier
      // bot » doit être lisible).
      bloc.append(
        h("p", {
          class: "bot-switcher__menu-aide",
          text: "Aucun autre bot sur cette instance : il n'y a aucune boucle à régler.",
        }),
      );
    } else {
      bloc.append(
        h("p", {
          class: "bot-switcher__menu-aide",
          text:
            "Un seul interrupteur par paire, orienté : « A vers B » n'allume pas " +
            "« B vers A ». Aucun plafond, aucun frein.",
        }),
      );
    }
    for (const paire of paires) {
      const bouton = h("button", {
        class: "bot-switcher__menu-item bot-switcher__menu-item--boucle",
        type: "button",
        text: `${paire.actif ? "Autoriser" : "Couper"} la boucle vers « ${paire.nom} » ` +
          `(actuellement : ${paire.libelle})`,
      });
      bouton.addEventListener("click", () => {
        void ecrireBoucle(paire);
      });
      bloc.append(bouton);
    }
    const retirer = h("button", {
      class: "bot-switcher__menu-item bot-switcher__menu-item--danger",
      type: "button",
      text: `Retirer ce bot…`,
      "aria-label": `Retirer « ${entree.nom} » de l'instance`,
    });
    retirer.addEventListener("click", () => {
      void retirerBot(entree);
    });
    bloc.append(
      h("p", {
        class: "bot-switcher__menu-aide",
        text:
          "Retirer un bot ne l'efface pas : son dossier est ARCHIVÉ (conversations, " +
          "souvenirs, déclencheurs, journaux) et conservé 3 mois (90 jours).",
      }),
      retirer,
    );
    return bloc;
  }

  function rendre() {
    if (!list) return;
    const courant = botCourant();
    const entrees = bots.map((bot) =>
      entreeListe(bot, { principal, courant, bots, refuses, plafond }),
    );
    list.replaceChildren();
    for (const entree of entrees) {
      const item = h("li", {
        class: `bot-switcher__item${entree.courant ? " bot-switcher__item--courant" : ""}`,
        "data-bot-id": entree.id,
      });
      const avatar = avatarDe(entree);
      // ⚠️ Clic droit (bureau) ET appui long (téléphone) : même menu de boucle.
      avatar.addEventListener("contextmenu", (event) => {
        event.preventDefault?.();
        menuBotId = menuBotId === entree.id ? null : entree.id;
        rendre();
      });
      attachLongPress(avatar, () => {
        menuBotId = menuBotId === entree.id ? null : entree.id;
        rendre();
      });

      const choix = h("button", {
        class: "bot-switcher__choix",
        type: "button",
        // L'état RÉEL est dans le libellé : un lecteur d'écran l'entend aussi.
        "aria-label": `Ouvrir la conversation de « ${entree.nomAffiche} » — ${entree.libelleEtat}`,
        ...(entree.courant ? { "aria-current": "true" } : {}),
      });
      // Nom PUIS état, l'un sous l'autre : la ligne reste tenable sur 390 px
      // (sinon le bouton « Démarrer » passait seul à la ligne).
      choix.append(
        avatar,
        h("span", { class: "bot-switcher__textes" }, [
          h("span", { class: "bot-switcher__nom", text: entree.nomAffiche }),
          h("span", {
            class: `bot-switcher__etat bot-switcher__etat--${entree.etat}`,
            text: entree.libelleEtat,
          }),
        ]),
      );
      choix.addEventListener("click", () => {
        void ouvrirConversation(entree);
      });
      item.append(choix);

      if (entree.demarrable) {
        const demarrer = h("button", {
          class: "button button--small bot-switcher__demarrer",
          type: "button",
          text: "Démarrer",
          "aria-label": `Démarrer « ${entree.nomAffiche} »`,
        });
        demarrer.addEventListener("click", () => {
          void ouvrirConversation({ ...entree, demarrable: true, demarre: false });
        });
        item.append(demarrer);
      }

      if (menuBotId === entree.id) item.append(menuEntree(entree));
      list.append(item);
    }
    if (plafondEl) plafondEl.textContent = resumeBots(bots, plafond, refuses);
    /**
     * ⚠️ LE NOM DE LA BARRE DU HAUT SUIT LE BOT AFFICHÉ. Il était écrit en dur
     * (« Yuki ») : avec trois bots en base, la barre annonçait « Yuki » quoi
     * qu'il arrive — c'est exactement le « je n'ai toujours que Yuki en haut ».
     */
    if (nomEl) {
      const libelle = nomBarreHaut(bots, botCourant());
      if (libelle !== "") nomEl.textContent = libelle;
    }
  }

  /** Ouvre un panneau déjà construit (aucune lecture réseau : elle est faite). */
  function ouvrir() {
    if (!panel) return;
    ouvert = true;
    panel.hidden = false;
    button?.setAttribute?.("aria-expanded", "true");
    rendre();
  }

  function fermer() {
    if (!panel) return;
    ouvert = false;
    menuBotId = null;
    panel.hidden = true;
    button?.setAttribute?.("aria-expanded", "false");
  }

  /**
   * Clic sur un bot : DÉMARRE-le s'il est arrêté, puis ouvre SA conversation.
   *
   * ⚠️ L'ordre est CRITIQUE : naviguer vers `?b=<slug>` d'un bot arrêté fait
   * refuser la connexion WebSocket (« ce bot est arrêté »). On démarre donc
   * d'abord, on attend la réponse du serveur, et on ne navigue qu'en cas de
   * succès — un échec laisse l'utilisateur SUR la page, avec la vraie cause.
   */
  async function ouvrirConversation(entree) {
    if (occupe) return;
    if (entree.demarrable) {
      const demarre = await demarrer(entree);
      if (!demarre) return;
    }
    // ⚠️ GARDE D'AVANT-NAVIGATION (page de configuration) : des modifications non
    // enregistrées ne doivent pas être jetées en silence par un changement de bot.
    if (avantNaviguer !== null) {
      const poursuivre = await avantNaviguer(entree.id);
      if (poursuivre === false) return;
    }
    naviguer(urlPour(entree));
  }

  /** Allume un bot (`PATCH { actif: true }`) — l'effet est immédiat (L8). */
  async function demarrer(entree) {
    if (occupe) return false;
    occupe = true;
    direStatut(`Démarrage de « ${entree.nomAffiche} »…`);
    try {
      const response = await doFetch(
        `/api/bots/${encodeURIComponent(entree.id)}/actif`,
        {
          method: "PATCH",
          headers: ENTETES_ECRITURE,
          body: JSON.stringify({ actif: true }),
        },
      );
      const donnees = await response.json().catch(() => ({}));
      if (!response.ok) {
        direStatut(messageErreur(donnees, "Ce bot n'a pas pu être démarré."), {
          erreur: true,
        });
        return false;
      }
      if (Array.isArray(donnees.bots)) bots = donnees.bots;
      if (donnees.echanges !== null && typeof donnees.echanges === "object") {
        echanges = donnees.echanges;
      }
      // Il n'est plus « refusé par le plafond » : il est allumé (ou en erreur).
      refuses = refuses.filter((id) => id !== entree.id);
      const ok = donnees?.applique?.ok !== false;
      if (!ok) {
        direStatut(
          messageErreur(
            { message: donnees?.applique?.raison },
            `« ${entree.nomAffiche} » n'a pas pu démarrer.`,
          ),
          { erreur: true },
        );
        rendre();
        return false;
      }
      direStatut(
        donnees.inchange === true
          ? `« ${entree.nomAffiche} » tourne déjà.`
          : `« ${entree.nomAffiche} » est démarré.`,
      );
      rendre();
      return true;
    } catch {
      direStatut(
        "Le gateway n'a pas répondu : le bot n'a pas pu être démarré.",
        { erreur: true },
      );
      return false;
    } finally {
      occupe = false;
    }
  }

  /**
   * ÉTEINT un bot (`PATCH { actif: false }`) — son host et sa pile sont détruits.
   *
   * ⚠️ Comme pour le démarrage, le MESSAGE DU SERVEUR est repris tel quel :
   * éteindre le dernier bot actif est refusé (`409 dernier_bot_actif`), et c'est
   * cette phrase qui doit s'afficher, pas un « échec » anonyme.
   */
  async function arreterBot(entree) {
    if (occupe) return false;
    occupe = true;
    direStatut(`Arrêt de « ${entree.nomAffiche} »…`);
    try {
      const response = await doFetch(
        `/api/bots/${encodeURIComponent(entree.id)}/actif`,
        {
          method: "PATCH",
          headers: ENTETES_ECRITURE,
          body: JSON.stringify({ actif: false }),
        },
      );
      const donnees = await response.json().catch(() => ({}));
      if (!response.ok) {
        direStatut(messageErreur(donnees, "Ce bot n'a pas pu être arrêté."), {
          erreur: true,
        });
        rendre();
        return false;
      }
      if (Array.isArray(donnees.bots)) bots = donnees.bots;
      refuses = refuses.filter((id) => id !== entree.id);
      const ok = donnees?.applique?.ok !== false;
      if (!ok) {
        direStatut(
          messageErreur(
            { message: donnees?.applique?.raison },
            `« ${entree.nomAffiche} » n'a pas pu être arrêté.`,
          ),
          { erreur: true },
        );
        rendre();
        return false;
      }
      direStatut(
        donnees.inchange === true
          ? `« ${entree.nomAffiche} » était déjà arrêté.`
          : `« ${entree.nomAffiche} » est arrêté.`,
      );
      rendre();
      return true;
    } catch {
      direStatut("Le gateway n'a pas répondu : le bot n'a pas pu être arrêté.", {
        erreur: true,
      });
      return false;
    } finally {
      occupe = false;
    }
  }

  /** Écrit le on/off d'une boucle entre deux bots (`PATCH /api/bots/echanges`). */
  async function ecrireBoucle(paire) {
    if (occupe) return;
    occupe = true;
    try {
      const response = await doFetch("/api/bots/echanges", {
        method: "PATCH",
        headers: ENTETES_ECRITURE,
        body: JSON.stringify({ de: paire.de, vers: paire.vers, actif: paire.actif }),
      });
      const donnees = await response.json().catch(() => ({}));
      if (!response.ok) {
        direStatut(
          messageErreur(donnees, "Cette boucle n'a pas pu être enregistrée."),
          { erreur: true },
        );
        return;
      }
      if (donnees.echanges !== null && typeof donnees.echanges === "object") {
        echanges = donnees.echanges;
      }
      direStatut(
        `Boucle « ${paire.de} » → « ${paire.vers} » : ` +
          `${paire.actif ? "autorisée" : "coupée"}.`,
      );
      rendre();
    } catch {
      direStatut("Le gateway n'a pas répondu : la boucle n'a pas été changée.", {
        erreur: true,
      });
    } finally {
      occupe = false;
    }
  }

  /** Alerte VISIBLE (HolafModal) ; repli sur le statut du panneau (tests). */
  async function alerter(titre, texte) {
    if (HolafModal && typeof HolafModal.alert === "function") {
      await HolafModal.alert(titre, texte, { okText: "Compris" });
      return;
    }
    direStatut(`${titre} — ${texte}`, { erreur: true });
  }

  /**
   * RETIRE un bot de l'instance — la modale EXISTANTE fait tout le travail
   * (compteurs réels, case à cocher obligatoire, `HolafModal`,
   * `public/ui/bots-admin.js:ouvrirSuppressionBot`). Ici, on ne fait que :
   *  ① refuser LISIBLEMENT le dernier bot (une instance sans bot ne démarre pas) ;
   *  ② rafraîchir la liste APRÈS la suppression ;
   *  ③ basculer la conversation si le bot retiré était celui qu'on regarde —
   *     jamais rester sur un bot qui n'existe plus.
   */
  async function retirerBot(entree) {
    if (occupe) return;
    if (bots.length <= 1) {
      await alerter(
        "Suppression impossible",
        `« ${entree.nom} » est le DERNIER bot de l'instance : une instance sans bot ` +
          "ne peut pas démarrer. Créez d'abord un autre bot (« + Ajouter un bot »), " +
          "puis retirez celui-ci.",
      );
      return;
    }
    if (typeof ouvrirSuppressionBot !== "function") return;
    const courantAvant = botCourant();
    occupe = true;
    try {
      const resultat = await ouvrirSuppressionBot({
        HolafModal,
        bot: { id: entree.id, nom: entree.nom },
        fetchImpl: doFetch,
      });
      if (!resultat) return;
      menuBotId = null;
      await rafraichir();
      const cible = resultat.botActifSuivant ?? bots[0]?.id ?? null;
      if (courantAvant === entree.id && cible !== null) {
        // ⚠️ Le bot de la page n'existe plus : on QUITTE sa conversation (sinon le
        // WebSocket refuserait chaque trame et l'écran resterait mort).
        naviguer(urlConversationBot(cible, principal));
        return;
      }
      direStatut(
        `« ${entree.nom} » est retiré. Son dossier est archivé et conservé ` +
          "3 mois (90 jours)" +
          (resultat.rechargementRequis === true
            ? " ; un redémarrage du gateway est nécessaire pour que l'instance " +
              "applique ce retrait."
            : "."),
      );
    } catch {
      direStatut("Le bot n'a pas pu être retiré.", { erreur: true });
    } finally {
      occupe = false;
    }
  }

  /** Bascule l'ouverture du panneau (le clic ET l'appui long l'ouvrent). */
  function basculer() {
    if (ouvert) {
      fermer();
      return;
    }
    ouvrir();
    direStatut("");
    void rafraichir();
  }

  /**
   * Clic droit (bureau) ou appui long (téléphone) sur le NOM+AVATAR de la barre
   * du haut : le panneau s'ouvre SUR le menu du bot affiché (Démarrer/Arrêter,
   * boucles, retrait). C'était le geste demandé et jamais câblé : le bouton ne
   * connaissait que le clic simple.
   */
  async function ouvrirMenuDuBotCourant() {
    ouvrir();
    direStatut("");
    await rafraichir();
    const id = botCourant();
    if (id === null) return;
    menuBotId = id;
    rendre();
  }

  // ─── Câblage (une seule fois, à l'init) ─────────────────────────────────
  button?.addEventListener?.("click", (event) => {
    event.preventDefault?.();
    basculer();
  });
  // ⚠️ Clic droit sur le bouton : même menu que les entrées du panneau.
  button?.addEventListener?.("contextmenu", (event) => {
    event.preventDefault?.();
    void ouvrirMenuDuBotCourant();
  });
  // ⚠️ Téléphone : l'appui long ouvre le MENU (le `click` qu'il déclenche est
  // absorbé par `long-press.js`), le clic simple bascule le panneau.
  if (button) attachLongPress(button, () => void ouvrirMenuDuBotCourant());

  closeButton?.addEventListener?.("click", () => fermer());

  addButton?.addEventListener?.("click", () => {
    void (async () => {
      if (typeof ouvrirCreationBot !== "function") return;
      const cree = await ouvrirCreationBot({ HolafModal, bots });
      if (!cree || typeof cree.id !== "string") return;
      await rafraichir();
      direStatut(
        `« ${cree.nom ?? cree.id} » est créé. Il est ARRÊTÉ : cliquez-le (ou ` +
          "« Démarrer ») pour lui parler.",
      );
    })();
  });

  if (typeof document !== "undefined" && document.addEventListener) {
    document.addEventListener("keydown", (event) => {
      if (!ouvert || event.key !== "Escape") return;
      fermer();
    });
    // Un clic hors du panneau et hors du bouton le referme (jamais un piège).
    document.addEventListener("click", (event) => {
      if (!ouvert) return;
      const cible = event.target;
      if (panel && contient(panel, cible)) return;
      if (button && contient(button, cible)) return;
      fermer();
    });
  }

  return {
    rafraichir,
    ouvrir,
    fermer,
    basculer,
    demarrer,
    arreter: arreterBot,
    etat: () => ({ bots, plafond, principal, echanges, refuses, ouvert }),
  };
}

/**
 * Bandeau d'honnêteté de la page `/bots` — réexporté pour que `config.js` n'ait
 * qu'un seul chemin vers la règle (le message vit dans le modèle pur, testé).
 */
export { messageBandeauBot };
