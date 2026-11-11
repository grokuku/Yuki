/**
 * ADMINISTRATION DES BOTS — MODALES (lot 35e) : AJOUTER, CLONER, SUPPRIMER.
 *
 * Deux modales, une seule brique (`HolafModal`), aucun style inline, aucun
 * nœud construit à partir d'une chaîne HTML :
 *
 *  - `ouvrirCreationBot` : LE NOM (et, facultativement, un avatar). Le slug est
 *    dérivé par le serveur ; les capacités partent VIDES et se règlent ensuite
 *    dans l'onglet « Général ». Le clonage reste accessible mais REPLIÉ (un
 *    second choix, « partir d'un bot existant »), jamais dans le premier écran :
 *    par défaut on crée un bot vide. Appelle `POST /api/bots` et rend le bot créé
 *    (le sélecteur bascule dessus).
 *  - `ouvrirSuppressionBot` : lit d'abord les COMPTEURS réels
 *    (`GET /api/bots/<id>/donnees`), puis demande une confirmation FORTE —
 *    compteurs affichés, case à cocher obligatoire (motif du lot 30) — et
 *    appelle `DELETE /api/bots/<id>`.
 *
 * ⚠️ La suppression N'EFFACE RIEN : le serveur déplace le dossier dans
 * `bots-supprimes/` et le conserve 3 mois. Le texte de la modale le dit.
 *
 * Les libellés, les défauts de clonage et les validations vivent dans
 * `config-pages.js` (module PUR, testé sans navigateur) : ce module ne fait que
 * le DOM, les événements et les appels HTTP.
 */

import { TAILLE_SORTIE, creerEtat, dessiner } from "./avatar-recadrage.js";
import {
  CLONE_ELEMENTS,
  MAX_BOTS_PAGE,
  NOM_BOT_MAX_PAGE,
  confirmationSuppressionBot,
  libelleTaille,
  modaleCreationBot,
  texteSuppressionBot,
  validerCreationBot,
} from "./config-pages.js";

/** En-têtes d'écriture (mêmes que la page de configuration). */
const ENTETES_ECRITURE = {
  "content-type": "application/json",
  "x-yuki-config": "1",
};

/** Dimension maximale acceptée pour une image d'avatar (borne serveur). */
const AVATAR_MAX_DIMENSION = 4096;

/** Construit un nœud (jamais de chaîne HTML). */
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

/** Message d'erreur d'une réponse d'API (jamais un code HTTP brut). */
function messageErreur(error, defaut) {
  const donnees = error?.data ?? {};
  return donnees.message ?? donnees.error ?? error?.message ?? defaut;
}

/**
 * Prépare l'avatar choisi : recadrage CARRÉ CENTRÉ à `TAILLE_SORTIE` px, encodé
 * en JPEG (compact : le corps de `POST /api/bots` reste petit).
 *
 * ⚠️ Géométrie fournie par `avatar-recadrage.js` (le module testé) : ce n'est
 * pas une seconde implémentation du recadrage.
 */
async function preparerAvatar(fichier) {
  if (!fichier) return "";
  const url = URL.createObjectURL(fichier);
  try {
    const image = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Image illisible."));
      img.src = url;
    });
    if (image.naturalWidth > AVATAR_MAX_DIMENSION || image.naturalHeight > AVATAR_MAX_DIMENSION) {
      throw new Error(
        `Image refusée : ${image.naturalWidth}×${image.naturalHeight} px, ` +
          `plafond de ${AVATAR_MAX_DIMENSION}×${AVATAR_MAX_DIMENSION} px.`,
      );
    }
    const canevas = document.createElement("canvas");
    canevas.width = TAILLE_SORTIE;
    canevas.height = TAILLE_SORTIE;
    const contexte = canevas.getContext("2d");
    if (!contexte) throw new Error("Le navigateur n'a pas pu préparer l'image.");
    const etat = creerEtat({
      largeurImage: image.naturalWidth,
      hauteurImage: image.naturalHeight,
      diametre: TAILLE_SORTIE,
    });
    dessiner(contexte, image, etat, TAILLE_SORTIE);
    return canevas.toDataURL("image/jpeg", 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Ouvre la modale d'AJOUT et crée le bot.
 *
 * @returns le bot créé (`{ id, nom, capacites, actif, ordre }`) ou `null` si
 * l'utilisateur annule.
 */
export function ouvrirCreationBot({ HolafModal, bots = [] }) {
  const spec = modaleCreationBot({ bots, maxBots: MAX_BOTS_PAGE });

  const erreur = h("p", { class: "config-error", role: "alert", hidden: true });
  const champNom = h("input", {
    class: "config-input",
    type: "text",
    id: "bot-creation-nom",
    maxlength: String(NOM_BOT_MAX_PAGE),
    autocomplete: "off",
    required: true,
  });
  const champAvatar = h("input", {
    class: "config-input",
    type: "file",
    id: "bot-creation-avatar",
    accept: "image/png,image/jpeg,image/webp",
  });
  const apercuAvatar = h("img", {
    class: "bot-avatar",
    alt: "Aperçu de l'avatar du nouveau bot",
    width: "64",
    height: "64",
    hidden: true,
  });
  let avatar = "";

  champAvatar.addEventListener("change", () => {
    void (async () => {
      const fichier = champAvatar.files?.[0] ?? null;
      if (!fichier) {
        avatar = "";
        apercuAvatar.hidden = true;
        return;
      }
      try {
        avatar = await preparerAvatar(fichier);
        apercuAvatar.src = avatar;
        apercuAvatar.hidden = false;
      } catch (error) {
        avatar = "";
        apercuAvatar.hidden = true;
        erreur.textContent = error instanceof Error ? error.message : String(error);
        erreur.hidden = false;
      }
    })();
  });

  // ⚠️ SECOND ÉCRAN : « partir d'un bot existant » est REPLIÉ et décoché par
  // défaut (bot vide). La création ne demande que le nom.
  const partirExistant = h("input", {
    type: "checkbox",
    id: "bot-creation-partir-existant",
  });
  const choixDepart = h(
    "select",
    { class: "config-select", id: "bot-creation-depart", disabled: true },
    [
      h("option", { value: "", text: "De zéro (aucune donnée copiée)" }),
      ...spec.cloneables.map((bot) =>
        h("option", { value: bot.id, text: `Copier les éléments de ${bot.libelle}` }),
      ),
    ],
  );
  const cases = new Map();
  const blocClone = h("fieldset", { class: "config-group" }, [
    h("legend", { class: "config-group__title", text: "Que copier du bot cloné ?" }),
  ]);
  for (const element of CLONE_ELEMENTS) {
    const id = `bot-clone-${element.id}`;
    const laCase = h("input", {
      type: "checkbox",
      id,
      ...(element.defaut ? { checked: true } : {}),
      ...(element.indisponible ? { disabled: true } : {}),
    });
    cases.set(element.id, laCase);
    blocClone.append(
      h("div", { class: "config-row" }, [
        h("label", { class: "config-label", for: id }, [laCase, ` ${element.libelle}`]),
        h("span", { class: "config-helper", text: element.aide }),
      ]),
    );
  }
  blocClone.hidden = true;
  const majBlocClone = () => {
    const actif = partirExistant.checked === true && choixDepart.value !== "";
    blocClone.hidden = !actif;
  };
  partirExistant.addEventListener("change", () => {
    choixDepart.disabled = partirExistant.checked !== true;
    if (partirExistant.checked !== true) choixDepart.value = "";
    majBlocClone();
  });
  choixDepart.addEventListener("change", majBlocClone);

  const corps = h("div", { class: "bot-creation" }, [
    h("p", { class: "holaf-modal-message", text: spec.message }),
    h("div", { class: "config-row" }, [
      h("label", { class: "config-label", for: "bot-creation-nom", text: "Nom affiché" }),
      champNom,
    ]),
    h("div", { class: "config-row" }, [
      h("label", { class: "config-label", for: "bot-creation-avatar", text: "Avatar (facultatif)" }),
      champAvatar,
      apercuAvatar,
    ]),
    h("div", { class: "config-row" }, [
      h(
        "label",
        { class: "config-label", for: "bot-creation-partir-existant" },
        [partirExistant, " Partir d'un bot existant (facultatif)"],
      ),
      choixDepart,
      h("span", {
        class: "config-helper",
        text:
          "Par défaut, le nouveau bot est VIDE : ni mémoire, ni déclencheurs, et " +
          "aucune capacité. Cochez cette case pour copier tout ou partie d'un bot existant.",
      }),
    ]),
    blocClone,
    h("p", { class: "config-helper", text: spec.limite }),
    erreur,
  ]);

  return new Promise((resolve) => {
    let ctrl = null;
    ctrl = HolafModal.open({
      title: spec.titre,
      size: "md",
      content: corps,
      closeOnOverlay: false,
      actions: [
        {
          label: "Annuler",
          type: "cancel",
          value: null,
          onClick: () => null,
        },
        {
          label: "Créer le bot",
          type: "primary",
          autoFocus: true,
          close: false,
          onClick: () => {
            void (async () => {
              erreur.hidden = true;
              const validation = validerCreationBot({ nom: champNom.value });
              if (!validation.ok) {
                erreur.textContent = Object.values(validation.champs).join(" ");
                erreur.hidden = false;
                return;
              }
              const elements = {};
              for (const [id, laCase] of cases) elements[id] = laCase.checked === true;
              ctrl.setBusy(true, "Création du bot…");
              try {
                const reponse = await fetch("/api/bots", {
                  method: "POST",
                  headers: ENTETES_ECRITURE,
                  body: JSON.stringify({
                    nom: champNom.value.trim(),
                    ...(avatar === "" ? {} : { avatar }),
                    ...(choixDepart.value === ""
                      ? {}
                      : { cloneDe: choixDepart.value, elements }),
                  }),
                });
                const donnees = await reponse.json().catch(() => ({}));
                if (!reponse.ok) {
                  throw Object.assign(new Error(donnees.message ?? "Création impossible."), {
                    data: donnees,
                  });
                }
                ctrl.setBusy(false);
                ctrl.close();
                resolve(donnees.bot ?? { nom: champNom.value.trim(), capacites: [] });
              } catch (error) {
                ctrl.setBusy(false);
                erreur.textContent = messageErreur(error, "Le bot n'a pas pu être créé.");
                erreur.hidden = false;
              }
            })();
          },
        },
      ],
      // Une fermeture sans création (✕, Échap, « Annuler ») rend `null` : rien
      // n'a été créé, et l'appelant ne change pas de bot.
      _onResolve: (valeur) => resolve(valeur ?? null),
    });
  });
}

/**
 * Ouvre la confirmation de SUPPRESSION d'un bot (compteurs réels + case à
 * cocher obligatoire) puis appelle `DELETE /api/bots/<id>`.
 *
 * @returns la réponse du serveur (`{ bots, archive, botActifSuivant,
 * rechargementRequis }`) ou `null` si l'utilisateur renonce ou si l'appel échoue.
 */
export async function ouvrirSuppressionBot({ HolafModal, bot, fetchImpl }) {
  const doFetch = fetchImpl ?? ((url, init) => fetch(url, init));
  const chemin = `/api/bots/${encodeURIComponent(String(bot.id))}`;

  // Compteurs RÉELS : la confirmation doit dire ce qui sera archivé.
  let compteurs = {};
  let retentionJours;
  try {
    const reponse = await doFetch(`${chemin}/donnees`, {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    const donnees = await reponse.json();
    compteurs = donnees?.compteurs ?? {};
    retentionJours = donnees?.retentionJours;
  } catch {
    // Sans compteurs, on le DIT dans le texte plutôt que d'inventer des zéros.
    compteurs = {};
  }

  const texte = texteSuppressionBot({ bot, compteurs, retentionJours });
  const idCase = `bot-suppression-${bot.id}`;
  const laCase = h("input", { type: "checkbox", id: idCase });
  const erreur = h("p", { class: "config-error", role: "alert", hidden: true });
  const corps = h("div", { class: "bot-danger" }, [
    h("p", { class: "holaf-modal-message", text: texte }),
    h("p", {
      class: "config-helper",
      text:
        `Taille du dossier : ${libelleTaille(compteurs.octets)}. ` +
        "Les fichiers restent lisibles dans les archives de l'instance jusqu'à la purge.",
    }),
    h("label", { class: "config-label", for: idCase }, [laCase, ` ${confirmationSuppressionBot()}`]),
    erreur,
  ]);

  return new Promise((resolve) => {
    let termine = null;
    let regle = false;
    /** Résout UNE seule fois (fermeture de modale et réponse serveur). */
    const conclure = (valeur) => {
      if (regle) return;
      regle = true;
      resolve(valeur ?? null);
    };
    let ctrl = null;
    ctrl = HolafModal.open({
      title: `Supprimer « ${bot.nom ?? bot.id} »`,
      size: "sm",
      content: corps,
      closeOnOverlay: false,
      actions: [
        { label: "Annuler", type: "cancel", value: null, onClick: () => null },
        {
          label: "Supprimer le bot",
          type: "danger",
          close: false,
          onClick: () => {
            void (async () => {
              if (laCase.checked !== true) {
                erreur.textContent = "Cochez la case de confirmation pour activer la suppression.";
                erreur.hidden = false;
                return;
              }
              erreur.hidden = true;
              try {
                const reponse = await doFetch(chemin, {
                  method: "DELETE",
                  headers: { ...ENTETES_ECRITURE, accept: "application/json" },
                });
                const donnees = await reponse.json().catch(() => ({}));
                if (!reponse.ok) {
                  throw Object.assign(new Error(donnees.message ?? "Suppression impossible."), {
                    data: donnees,
                  });
                }
                termine = donnees;
                ctrl?.close(donnees);
                conclure(donnees);
              } catch (error) {
                erreur.textContent = messageErreur(error, "Le bot n'a pas pu être supprimé.");
                erreur.hidden = false;
              }
            })();
          },
        },
      ],
      onOpen: (instance) => {
        const bouton = instance?.footer?.querySelector?.(".holaf-modal-btn-danger") ?? null;
        if (!bouton) return;
        bouton.disabled = true;
        laCase.addEventListener("change", () => {
          bouton.disabled = laCase.checked !== true;
        });
      },
      // Fermeture sans suppression (✕, Échap, « Annuler ») : `null`, sauf si la
      // suppression a bien eu lieu et que le serveur a déjà répondu.
      _onResolve: (valeur) => conclure(valeur ?? termine ?? null),
    });
  });
}
