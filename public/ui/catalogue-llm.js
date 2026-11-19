/**
 * CATALOGUE DE FOURNISSEURS ET DE MODÈLES — interface de `/config` (lot A, 2026-11-19).
 *
 * Deux listes persistées dans la configuration d'INSTANCE :
 *  - `llm.fournisseurs` : `{ id, nom, baseUrl, api }` (+ clé d'API dans le chemin
 *    SECRET `llm.fournisseur.<id>.apiKey`, jamais relue en clair) ;
 *  - `llm.modeles` : `{ id, nom, fournisseurId, contexte, vision, thinking }`.
 *
 * ⚠️ AUCUN APPEL RÉSEAU vers un fournisseur ici : ce lot ne teste pas de
 * connexion et ne demande aucune liste de modèles distante. Les deux listes sont
 * éditées localement, puis enregistrées par le bouton « Enregistrer » de la page
 * (`patch` rendu par ce module, fusionné avec les champs ordinaires).
 *
 * ⚠️ CSP STRICTE : `textContent` uniquement (aucune injection de balisage),
 * aucune écriture de style en ligne. Les formulaires sont des `HolafModal`
 * (jamais la boîte de confirmation native du navigateur) : la confirmation de
 * suppression est une vraie modale, et elle DIT ce qui va être supprimé.
 *
 * ⚠️ DEPUIS LE LOT B, LE CATALOGUE EST LA SOURCE DE L'EXÉCUTION : les rôles
 * (`light` / `heavy` / `vision`) ne référencent plus qu'un `modeleId`
 * (`llm.defaut.*` pour l'installation, `llm.bot.*` par bot). Ce module SIGNALE
 * donc quels modèles sont RÉELLEMENT utilisés, et dit ce qui se passe si on les
 * supprime : le rôle passe en mode dégradé explicite (« modèle introuvable »),
 * il n'est jamais remplacé par un modèle d'à côté.
 */

/** Niveaux de réflexion (miroir de `THINKING_LEVELS`, `src/config/schema.ts`). */
const NIVEAUX_REFLEXION = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Dialectes d'API acceptés (miroir de `API_FOURNISSEUR`, `src/llm/catalogue.ts`). */
const API_FOURNISSEUR = ["openai-completions"];

/**
 * Rôles d'exécution, avec leur libellé et les DEUX chemins de sélection
 * (défaut d'instance et surcharge de bot) : un modèle est « utilisé » dès qu'un
 * de ces chemins porte son `modeleId`.
 */
const ROLES = [
  { role: "light", libelle: "léger", chemins: ["llm.defaut.light", "llm.bot.light"] },
  { role: "heavy", libelle: "lourd", chemins: ["llm.defaut.heavy", "llm.bot.heavy"] },
  { role: "vision", libelle: "vision", chemins: ["llm.defaut.vision", "llm.bot.vision"] },
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

function bouton(texte, geste, variante) {
  return h("button", {
    class: `button ${variante === "danger" ? "button--danger" : "button--ghost"} button--small`,
    type: "button",
    text: texte,
    on: { click: geste },
  });
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

/** Même règle d'identifiant que le serveur (slug, minuscules, tirets). */
function identifiantDepuis(libelle, pris) {
  const base =
    String(libelle)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48)
      .replace(/-+$/g, "") || "element";
  if (!pris.has(base)) return base;
  for (let suffixe = 2; ; suffixe += 1) {
    const candidat = `${base.slice(0, 60)}-${suffixe}`;
    if (!pris.has(candidat)) return candidat;
  }
}

/** `true` si l'adresse est une URL `http(s)` complète (même règle que le serveur). */
function adresseValide(texte) {
  try {
    const url = new URL(String(texte).trim());
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
  } catch {
    return false;
  }
}

function libelleFournisseur(fournisseurs, id) {
  return fournisseurs.find((fournisseur) => fournisseur.id === id)?.nom || `« ${id} » (introuvable)`;
}

/** Rôles d'exécution qui DÉSIGNENT ce modèle (comparaison sur le `modeleId`). */
function rolesDuModele(modele, fields) {
  const id = String(modele.id ?? "").trim();
  if (id === "") return [];
  return ROLES.filter((role) =>
    role.chemins.some((chemin) => String(fields[chemin]?.value ?? "").trim() === id),
  );
}

/**
 * Monte les deux sections du catalogue dans `root`.
 *
 * @param {object} options
 * @param {HTMLElement} options.root conteneur (`#catalogue-llm-root`)
 * @param {object} options.fields instantané `GET /api/config` (`fields`)
 * @param {object} options.HolafModal brique de modale (jamais la confirmation native)
 * @param {() => void} options.changed recalcul de l'état « modifications »
 * @returns {() => object} patch des champs modifiés (à fusionner avant envoi)
 */
export function initCatalogueLlm({ root, fields, HolafModal, changed }) {
  const fournisseurs = lireListe(fields["llm.fournisseurs"]?.value).map((fournisseur) => ({
    id: String(fournisseur.id ?? ""),
    nom: String(fournisseur.nom ?? ""),
    baseUrl: String(fournisseur.baseUrl ?? ""),
    api: String(fournisseur.api ?? API_FOURNISSEUR[0]),
  }));
  const modeles = lireListe(fields["llm.modeles"]?.value).map((modele) => ({
    id: String(modele.id ?? ""),
    nom: String(modele.nom ?? ""),
    fournisseurId: String(modele.fournisseurId ?? ""),
    contexte: Number(modele.contexte) || 0,
    vision: modele.vision === true,
    thinking: String(modele.thinking ?? "off"),
  }));
  const initial = JSON.stringify({ fournisseurs, modeles });
  /** Clés saisies ou effacées, par chemin (`llm.fournisseur.<id>.apiKey`). */
  const cles = {};
  const sections = [];

  /** État d'une clé de fournisseur : saisie locale > snapshot serveur. */
  function etatCle(id) {
    const chemin = `llm.fournisseur.${id}.apiKey`;
    if (Object.hasOwn(cles, chemin)) {
      return { chemin, saisie: cles[chemin] };
    }
    const serveur = fields[chemin];
    return { chemin, saisie: undefined, configuree: Boolean(serveur?.configured), masquee: serveur?.masked };
  }

  function marquer() {
    changed();
    dessiner();
  }

  // ── Modale d'un FOURNISSEUR ────────────────────────────────────────────────
  function modaleFournisseur(courant) {
    const nouveau = courant === null;
    const etat = nouveau ? { configuree: false } : etatCle(courant.id);
    const champNom = h("input", {
      class: "config-input",
      type: "text",
      value: nouveau ? "" : courant.nom,
      placeholder: "Mon fournisseur",
      autocomplete: "off",
    });
    const champUrl = h("input", {
      class: "config-input",
      type: "url",
      value: nouveau ? "" : courant.baseUrl,
      placeholder: "https://api.exemple.fr/v1",
      autocomplete: "off",
    });
    const champApi = h(
      "select",
      { class: "config-select" },
      API_FOURNISSEUR.map((api) => h("option", { value: api, text: api })),
    );
    champApi.value = nouveau ? API_FOURNISSEUR[0] : courant.api;
    const etatCleTexte = h("span", {
      class: "config-helper",
      text: etat.configuree ? "Clé enregistrée (jamais relue en clair)" : "Aucune clé enregistrée",
    });
    const champCle = h("input", {
      class: "config-input",
      type: "password",
      autocomplete: "off",
      placeholder: etat.configuree ? "Nouvelle clé (laisser vide pour conserver)" : "Clé d'API",
    });
    let effacee = false;
    // ⚠️ Le bouton « Effacer » n'est CRÉÉ que si une clé existe : pas de bouton
    // masqué par `hidden` (sous `/config`, `[hidden]` ne gagne pas toujours contre
    // la mise en page — un contrôle inutile resterait cliquable).
    const boutonEffacer = etat.configuree
      ? bouton("Effacer la clé", () => {
          effacee = true;
          champCle.value = "";
          etatCleTexte.textContent = "La clé sera effacée à l'enregistrement.";
        })
      : null;
    const erreur = h("p", { class: "config-error", hidden: true });

    const corps = h("div", {}, [
      h("label", { class: "config-row" }, [
        h("span", { class: "config-label", text: "Nom du fournisseur" }),
        champNom,
      ]),
      h("label", { class: "config-row" }, [
        h("span", { class: "config-label", text: "URL de base (compatible API OpenAI)" }),
        champUrl,
      ]),
      h("label", { class: "config-row" }, [
        h("span", { class: "config-label", text: "Type d'API" }),
        champApi,
      ]),
      h("div", { class: "config-row" }, [
        h("span", { class: "config-label", text: "Clé d'API" }),
        h("div", { class: "config-secret" }, boutonEffacer === null ? [etatCleTexte] : [etatCleTexte, boutonEffacer]),
        champCle,
      ]),
      erreur,
    ]);

    return new Promise((resolve) => {
      let ctrl = null;
      ctrl = HolafModal.open({
        title: nouveau ? "Ajouter un fournisseur" : "Modifier le fournisseur",
        size: "md",
        content: corps,
        closeOnOverlay: false,
        actions: [
          { label: "Annuler", type: "cancel", value: null },
          {
            label: "Enregistrer",
            type: "primary",
            autoFocus: true,
            close: false,
            onClick: () => {
              const nom = champNom.value.trim();
              const baseUrl = champUrl.value.trim();
              if (nom === "") {
                erreur.textContent = "Le nom du fournisseur est obligatoire.";
                erreur.hidden = false;
                return;
              }
              if (!adresseValide(baseUrl)) {
                erreur.textContent =
                  "Adresse invalide : une URL complète en http:// ou https:// est attendue.";
                erreur.hidden = false;
                return;
              }
              const api = champApi.value;
              const id = nouveau
                ? identifiantDepuis(nom, new Set(fournisseurs.map((f) => f.id)))
                : courant.id;
              const cle = effacee ? null : champCle.value.trim() === "" ? undefined : champCle.value.trim();
              ctrl.close({ id, nom, baseUrl, api, cle });
            },
          },
        ],
        _onResolve: (valeur) => resolve(valeur ?? null),
      });
    });
  }

  // ── Modale d'un MODÈLE ─────────────────────────────────────────────────────
  function modaleModele(courant) {
    if (fournisseurs.length === 0) {
      void HolafModal.alert(
        "Aucun fournisseur",
        "Ajoutez d'abord un fournisseur : un modèle appartient toujours à un fournisseur.",
        { okText: "Compris" },
      );
      return Promise.resolve(null);
    }
    const nouveau = courant === null;
    const champFournisseur = h(
      "select",
      { class: "config-select" },
      fournisseurs.map((fournisseur) => h("option", { value: fournisseur.id, text: fournisseur.nom })),
    );
    champFournisseur.value = nouveau ? fournisseurs[0].id : courant.fournisseurId;
    const champNom = h("input", {
      class: "config-input",
      type: "text",
      value: nouveau ? "" : courant.nom,
      placeholder: "Identifiant du modèle chez le fournisseur",
      autocomplete: "off",
    });
    const champContexte = h("input", {
      class: "config-input",
      type: "number",
      min: "1",
      step: "1",
      value: String(nouveau ? 131072 : courant.contexte),
    });
    const champVision = h("input", { type: "checkbox" });
    champVision.checked = nouveau ? false : courant.vision === true;
    const champReflexion = h(
      "select",
      { class: "config-select" },
      NIVEAUX_REFLEXION.map((niveau) => h("option", { value: niveau, text: niveau })),
    );
    champReflexion.value = nouveau ? "off" : courant.thinking;
    const erreur = h("p", { class: "config-error", hidden: true });

    const corps = h("div", {}, [
      h("label", { class: "config-row" }, [
        h("span", { class: "config-label", text: "Fournisseur" }),
        champFournisseur,
      ]),
      h("label", { class: "config-row" }, [
        h("span", { class: "config-label", text: "Nom du modèle" }),
        champNom,
      ]),
      h("label", { class: "config-row" }, [
        h("span", { class: "config-label", text: "Fenêtre de contexte (jetons)" }),
        champContexte,
      ]),
      h("label", { class: "config-row" }, [
        h("span", { class: "config-label", text: "Reçoit les images (vision)" }),
        champVision,
      ]),
      h("label", { class: "config-row" }, [
        h("span", { class: "config-label", text: "Réflexion" }),
        champReflexion,
      ]),
      h("p", {
        class: "config-helper",
        text:
          "La vision et la réflexion sont des propriétés du MODÈLE : elles le suivent " +
          "quel que soit le rôle qui l'utilise.",
      }),
      erreur,
    ]);

    return new Promise((resolve) => {
      let ctrl = null;
      ctrl = HolafModal.open({
        title: nouveau ? "Ajouter un modèle" : "Modifier le modèle",
        size: "md",
        content: corps,
        closeOnOverlay: false,
        actions: [
          { label: "Annuler", type: "cancel", value: null },
          {
            label: "Enregistrer",
            type: "primary",
            autoFocus: true,
            close: false,
            onClick: () => {
              const nom = champNom.value.trim();
              if (nom === "") {
                erreur.textContent = "Le nom du modèle est obligatoire.";
                erreur.hidden = false;
                return;
              }
              const contexte = Number.parseInt(String(champContexte.value).trim(), 10);
              if (!Number.isInteger(contexte) || contexte < 1) {
                erreur.textContent = "La fenêtre de contexte doit être un entier supérieur à 0.";
                erreur.hidden = false;
                return;
              }
              const id = nouveau
                ? identifiantDepuis(nom, new Set(modeles.map((m) => m.id)))
                : courant.id;
              ctrl.close({
                id,
                nom,
                fournisseurId: champFournisseur.value,
                contexte,
                vision: champVision.checked === true,
                thinking: champReflexion.value,
              });
            },
          },
        ],
        _onResolve: (valeur) => resolve(valeur ?? null),
      });
    });
  }

  // ── Sections ───────────────────────────────────────────────────────────────
  function section(titre, intro) {
    const noeud = h("section", { class: "config-group" }, [
      h("h2", { class: "config-group__title", text: titre }),
      h("p", { class: "config-helper config-group__intro", text: intro }),
    ]);
    root.append(noeud);
    sections.push(noeud);
    return noeud;
  }

  async function ajouterFournisseur() {
    const saisie = await modaleFournisseur(null);
    if (saisie === null) return;
    fournisseurs.push({ id: saisie.id, nom: saisie.nom, baseUrl: saisie.baseUrl, api: saisie.api });
    if (saisie.cle !== undefined) cles[`llm.fournisseur.${saisie.id}.apiKey`] = saisie.cle;
    marquer();
  }

  async function modifierFournisseur(fournisseur) {
    const saisie = await modaleFournisseur(fournisseur);
    if (saisie === null) return;
    fournisseur.nom = saisie.nom;
    fournisseur.baseUrl = saisie.baseUrl;
    fournisseur.api = saisie.api;
    if (saisie.cle !== undefined) cles[`llm.fournisseur.${fournisseur.id}.apiKey`] = saisie.cle;
    marquer();
  }

  async function supprimerFournisseur(fournisseur) {
    const utilises = modeles.filter((modele) => modele.fournisseurId === fournisseur.id);
    if (utilises.length > 0) {
      // ⚠️ REFUS explicite, côté interface ET côté serveur : supprimer en
      // cascade retirerait des modèles que l'utilisateur n'a pas demandé de
      // supprimer (et un modèle peut servir à un rôle d'exécution).
      const liste = utilises.map((modele) => `« ${modele.nom} »`).join(", ");
      void HolafModal.alert(
        "Suppression impossible",
        `Le fournisseur « ${fournisseur.nom} » est utilisé par ${utilises.length} modèle(s) ` +
          `(${liste}). Supprimez d'abord ${utilises.length > 1 ? "ces modèles" : "ce modèle"}.`,
        { okText: "Compris" },
      );
      return;
    }
    const confirme = await HolafModal.confirm(
      "Supprimer le fournisseur ?",
      `« ${fournisseur.nom} » (${fournisseur.baseUrl}) et sa clé d'API seront supprimés.`,
      { danger: true, confirmText: "Supprimer" },
    );
    if (!confirme) return;
    const index = fournisseurs.indexOf(fournisseur);
    if (index >= 0) fournisseurs.splice(index, 1);
    cles[`llm.fournisseur.${fournisseur.id}.apiKey`] = null;
    marquer();
  }

  async function ajouterModele() {
    const saisie = await modaleModele(null);
    if (saisie === null) return;
    modeles.push(saisie);
    marquer();
  }

  async function modifierModele(modele) {
    const saisie = await modaleModele(modele);
    if (saisie === null) return;
    modele.nom = saisie.nom;
    modele.fournisseurId = saisie.fournisseurId;
    modele.contexte = saisie.contexte;
    modele.vision = saisie.vision;
    modele.thinking = saisie.thinking;
    marquer();
  }

  async function supprimerModele(modele) {
    const roles = rolesDuModele(modele, fields);
    const avertissement =
      roles.length > 0
        ? ` ⚠️ Il est utilisé comme modèle ${roles.map((role) => role.libelle).join(" et ")} : ` +
          "ces rôles passeront en mode dégradé (« modèle introuvable ») jusqu'à ce " +
          "qu'un autre modèle soit choisi."
        : "";
    const confirme = await HolafModal.confirm(
      "Supprimer le modèle ?",
      `« ${modele.nom} » (${libelleFournisseur(fournisseurs, modele.fournisseurId)}) sera retiré du catalogue.${avertissement}`,
      { danger: true, confirmText: "Supprimer" },
    );
    if (!confirme) return;
    const index = modeles.indexOf(modele);
    if (index >= 0) modeles.splice(index, 1);
    marquer();
  }

  function ligneFournisseur(fournisseur) {
    const etat = etatCle(fournisseur.id);
    let cleTexte;
    if (etat.saisie === null) cleTexte = "Clé effacée à l'enregistrement";
    else if (typeof etat.saisie === "string") cleTexte = "Nouvelle clé à enregistrer";
    else if (etat.configuree) cleTexte = "Clé enregistrée (jamais relue en clair)";
    else cleTexte = "Aucune clé";
    return h("div", { class: "config-row" }, [
      h("span", { class: "config-label", text: fournisseur.nom }),
      h("span", { class: "config-helper", text: `${fournisseur.baseUrl} · ${fournisseur.api} · ${cleTexte}` }),
      h("div", { class: "config-secret" }, [
        bouton("Modifier", () => void modifierFournisseur(fournisseur)),
        bouton("Supprimer", () => void supprimerFournisseur(fournisseur), "danger"),
      ]),
    ]);
  }

  function ligneModele(modele) {
    const roles = rolesDuModele(modele, fields);
    const details = [
      libelleFournisseur(fournisseurs, modele.fournisseurId),
      `contexte ${modele.contexte.toLocaleString("fr-FR")} jetons`,
      `réflexion ${modele.thinking}`,
    ].join(" · ");
    const badges = [];
    if (modele.vision === true) badges.push(h("span", { class: "badge badge--hot", text: "vision" }));
    for (const role of roles) {
      badges.push(h("span", { class: "badge badge--origin-store", text: `utilisé : ${role.libelle}` }));
    }
    return h("div", { class: "config-row" }, [
      h("span", { class: "config-label" }, [modele.nom]),
      h("span", { class: "config-helper", text: details }),
      h("div", { class: "config-secret" }, [
        ...badges,
        bouton("Modifier", () => void modifierModele(modele)),
        bouton("Supprimer", () => void supprimerModele(modele), "danger"),
      ]),
    ]);
  }

  function dessiner() {
    for (const noeud of sections.splice(0)) noeud.remove();

    const listeFournisseurs = section(
      "Fournisseurs",
      "Les fournisseurs compatibles API OpenAI (adresse et clé d'API). La clé est " +
        "stockée masquée : elle n'est jamais relue en clair par cette page.",
    );
    if (fournisseurs.length === 0) {
      listeFournisseurs.append(
        h("p", {
          class: "config-helper",
          text: "Aucun fournisseur : ajoutez-en un pour pouvoir déclarer des modèles.",
        }),
      );
    } else {
      for (const fournisseur of fournisseurs) listeFournisseurs.append(ligneFournisseur(fournisseur));
    }
    listeFournisseurs.append(bouton("Ajouter un fournisseur", () => void ajouterFournisseur()));

    const listeModeles = section(
      "Modèles",
      "Chaque modèle appartient à un fournisseur et déclare sa fenêtre de contexte, " +
        "sa vision et son niveau de réflexion. Aucun appel réseau n'est fait vers le " +
        "fournisseur depuis cette page.",
    );
    if (modeles.length === 0) {
      listeModeles.append(
        h("p", {
          class: "config-helper",
          text: "Aucun modèle déclaré pour l'instant.",
        }),
      );
    } else {
      for (const modele of modeles) listeModeles.append(ligneModele(modele));
    }
    listeModeles.append(bouton("Ajouter un modèle", () => void ajouterModele()));
  }

  dessiner();

  return () => {
    const patch = {};
    if (JSON.stringify({ fournisseurs, modeles }) !== initial) {
      // On n'écrit QUE ce qui a bougé : un catalogue inchangé ne fait pas
      // clignoter `config.json`, et un ajout de fournisseur ne réécrit pas la
      // liste des modèles.
      const initiale = JSON.parse(initial);
      if (JSON.stringify(fournisseurs) !== JSON.stringify(initiale.fournisseurs)) {
        patch["llm.fournisseurs"] = JSON.stringify(fournisseurs);
      }
      if (JSON.stringify(modeles) !== JSON.stringify(initiale.modeles)) {
        patch["llm.modeles"] = JSON.stringify(modeles);
      }
    }
    for (const [chemin, valeur] of Object.entries(cles)) patch[chemin] = valeur;
    return patch;
  };
}
