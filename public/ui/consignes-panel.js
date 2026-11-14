/**
 * Panneau « Consignes durables » de la page d'un bot — vanilla, sans build.
 *
 * Deux listes, un fichier Markdown par bot (`<state>/bots/<id>/consignes.md`) :
 *
 *  - **Consignes** — instructions IMPÉRATIVES (« ne refais plus jamais ça ») ;
 *  - **Faits** — informations DÉCLARATIVES (« mon NAS est à 10.0.0.5 »).
 *
 * ⚠️ CE N'EST PAS LA MÉMOIRE : ces entrées sont **TOUJOURS** injectées à chaque
 * tour, alors qu'un souvenir est **recherché** (rappel pertinent). Le texte
 * d'aide le dit, sinon l'utilisateur écrit une consigne dans la mémoire et
 * s'étonne qu'elle ne soit pas respectée.
 *
 * ⚠️ L'utilisateur peut TOUT corriger ou supprimer ici — et le fichier reste
 * éditable à la main (une ligne = une entrée, puces `- `).
 *
 * ⚠️ Le bot affiché est passé à l'initialisation (`botId`) : les routes sont
 * `/api/bots/<id>/consignes`. Aucun panneau n'est conditionné à un bot
 * particulier : la page est IDENTIQUE pour tous.
 *
 * CSP (`style-src 'self'`) : bâti en DOM programmatique (`textContent`), aucun
 * attribut de style — tout le CSS vit dans `config.css`.
 */

const JSON_HEADERS = { accept: "application/json" };
const WRITE_HEADERS = { "x-yuki-config": "1", "content-type": "application/json" };

/** Petit helper DOM (aucun `style=` : uniquement des attributs et du texte). */
function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = value;
    else if (key === "on") el.addEventListener("click", value);
    else if (key === "oninput") el.addEventListener("input", value);
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

/** Une entrée par ligne non vide (l'utilisateur édite une liste, pas du JSON). */
export function entreesDeTexte(texte) {
  return String(texte ?? "")
    .split(/\r?\n/u)
    .map((ligne) => ligne.replace(/^\s*[-*+]\s+/u, "").trim())
    .filter((ligne) => ligne !== "");
}

/** Compteur affiché (« 3 / 50 consignes ») — jamais un compteur silencieux. */
export function libelleCompteur(nombre, maximum, nature) {
  return `${nombre} / ${maximum} ${nature}`;
}

/** Message d'erreur lisible à partir d'une `HolafFetchError`. */
function apiErrorMessage(error) {
  const data = error?.data ?? {};
  return data.message || (error instanceof Error ? error.message : String(error));
}

/**
 * Monte le panneau dans `root`.
 *
 * @param {{ root: Element, HolafFetch: any, HolafModal: any, botId: string, botNom?: string }} options
 */
export function initConsignesPanel({ root, HolafFetch, HolafModal, botId, botNom }) {
  let maximums = { consignes: 50, faits: 50, entree: 500 };
  let cheminFichier = "";

  root.textContent = "";

  const etat = h("span", { class: "config-helper", role: "status" });
  const aide = h("p", { class: "config-helper" });
  const chemin = h("p", { class: "config-helper config-consignes__chemin" });

  const zoneConsignes = h("textarea", {
    class: "config-textarea",
    rows: "6",
    spellcheck: "true",
    "aria-label": "Consignes durables",
  });
  const zoneFaits = h("textarea", {
    class: "config-textarea",
    rows: "6",
    spellcheck: "true",
    "aria-label": "Faits durables",
  });
  const compteurConsignes = h("span", { class: "config-helper" });
  const compteurFaits = h("span", { class: "config-helper" });

  const bouton = h("button", {
    class: "button button--small",
    type: "button",
    text: "Enregistrer les consignes",
  });

  const bloc = (titre, zone, compteur, aideTexte) =>
    h("div", { class: "config-consignes__bloc" }, [
      h("div", { class: "config-consignes__entete" }, [
        h("h3", { class: "config-consignes__titre", text: titre }),
        compteur,
      ]),
      zone,
      h("p", { class: "config-helper", text: aideTexte }),
    ]);

  const section = h("section", { class: "config-group config-consignes" }, [
    h("div", { class: "config-group__head" }, [
      h("h2", { class: "config-group__title", text: "Consignes durables et faits" }),
    ]),
    aide,
    chemin,
    bloc(
      "Consignes",
      zoneConsignes,
      compteurConsignes,
      "Instructions IMPÉRATIVES, une par ligne (ex. « ne refais plus jamais ça »). ",
    ),
    bloc(
      "Faits",
      zoneFaits,
      compteurFaits,
      "Informations DÉCLARATIVES, une par ligne (ex. « mon NAS est à 10.0.0.5 »).",
    ),
    h("div", { class: "config-actions" }, [bouton, etat]),
  ]);
  root.append(section);

  const rafraichirCompteurs = () => {
    const consignes = entreesDeTexte(zoneConsignes.value).length;
    const faits = entreesDeTexte(zoneFaits.value).length;
    compteurConsignes.textContent = libelleCompteur(
      consignes,
      maximums.consignes,
      "consignes",
    );
    compteurFaits.textContent = libelleCompteur(faits, maximums.faits, "faits");
  };
  zoneConsignes.addEventListener("input", rafraichirCompteurs);
  zoneFaits.addEventListener("input", rafraichirCompteurs);

  const appliquer = (donnees) => {
    maximums = {
      consignes: Number(donnees.maxConsignes) || maximums.consignes,
      faits: Number(donnees.maxFaits) || maximums.faits,
      entree: Number(donnees.maxEntreeChars) || maximums.entree,
    };
    cheminFichier = typeof donnees.path === "string" ? donnees.path : "";
    zoneConsignes.value = (donnees.consignes ?? []).join("\n");
    zoneFaits.value = (donnees.faits ?? []).join("\n");
    aide.textContent =
      `Ces listes sont injectées à CHAQUE tour dans le prompt de ${botNom || botId} : ` +
      "ce ne sont PAS des souvenirs (la mémoire, elle, est recherchée et résumée). " +
      `Une entrée par ligne, ${maximums.entree} caractères maximum par entrée. ` +
      "Supprimer une ligne suffit à la retirer ; le fichier reste aussi éditable à la main.";
    chemin.textContent = cheminFichier === "" ? "" : `Fichier : ${cheminFichier}`;
    rafraichirCompteurs();
  };

  const charger = async () => {
    etat.textContent = "";
    try {
      const donnees = await HolafFetch.get(`/api/bots/${encodeURIComponent(botId)}/consignes`, {
        headers: JSON_HEADERS,
        cache: "no-store",
      });
      appliquer(donnees);
    } catch (error) {
      etat.textContent = `Lecture impossible : ${apiErrorMessage(error)}`;
    }
  };

  const enregistrer = async () => {
    bouton.disabled = true;
    etat.textContent = "Enregistrement…";
    try {
      const donnees = await HolafFetch.put(`/api/bots/${encodeURIComponent(botId)}/consignes`, {
        headers: WRITE_HEADERS,
        body: JSON.stringify({
          consignes: entreesDeTexte(zoneConsignes.value),
          faits: entreesDeTexte(zoneFaits.value),
        }),
      });
      appliquer(donnees);
      etat.textContent = "Enregistré : les listes seront injectées au prochain tour.";
    } catch (error) {
      // ⚠️ Un refus serveur (trop d'entrées, entrée trop longue) est AFFICHÉ tel
      // quel : c'est le seul moyen pour l'utilisateur de savoir quoi réduire.
      const message = apiErrorMessage(error);
      etat.textContent = `Refusé : ${message}`;
      await HolafModal.alert("Consignes non enregistrées", message, { okText: "Compris" });
    } finally {
      bouton.disabled = false;
    }
  };
  bouton.addEventListener("click", () => void enregistrer());

  void charger();

  return {
    /** Relit le fichier (utile après un changement de bot). */
    recharger: charger,
  };
}
