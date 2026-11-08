/**
 * AVATAR de Yuki — chargement, application aux emplacements, éditeur de recadrage.
 *
 * Trois responsabilités, aucune duplication :
 *   ① LIRE l'état (`GET /api/avatar`) et l'APPLIQUER aux trois emplacements :
 *      barre du haut (24 px, 22 px en téléphone), état vide (76 px), favicon.
 *   ② OUVRIR l'éditeur de recadrage (HolafModal) : molette = zoom, clic gauche
 *      glissé = déplacement, glisser/pincer au doigt, boutons +/−/Recentrer.
 *   ③ PRODUIRE la sortie : un carré 512×512 PNG dessiné par `canvas`
 *      (`toBlob` → corps binaire). L'aperçu est un `<canvas>`, jamais une URL
 *      d'objet du navigateur — la CSP `img-src 'self' data:` ne l'autoriserait
 *      pas.
 *
 * La GÉOMÉTRIE vit dans `avatar-recadrage.js` (fonctions pures, testées) : ce
 * module ne fait que le DOM, les événements et les appels HTTP.
 *
 * ⚠️ Aucun style inline (CSP `style-src 'self'`) : les tailles et le masque
 * circulaire vivent dans `styles.css` / `config.css`. Aucun nœud n'est construit
 * à partir d'une chaîne HTML.
 */

import {
  DIAMETRE_APERCU,
  TAILLE_SORTIE,
  creerEtat,
  deplacer,
  dessiner,
  recentrer,
  zoomer,
} from "./avatar-recadrage.js";

/** Service de l'image (same-origin, `img-src 'self'`). */
export const AVATAR_SERVICE_URL = "/avatar";
/** API de l'avatar (lecture / dépôt / retrait). */
export const AVATAR_API_URL = "/api/avatar";
/** Copie locale de la borne serveur (2 Mio) pour refuser AVANT l'envoi. */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
/** Dimension maximale acceptée (côté le plus long), comme le serveur. */
export const AVATAR_MAX_DIMENSION = 4096;

const ENTETES_ECRITURE = { "x-yuki-config": "1" };

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

function apiMessage(error, fallback) {
  const data = error?.data ?? {};
  return data.message ?? data.error ?? error?.message ?? fallback;
}

/**
 * URL servie pour l'avatar, ou `null` s'il n'y en a pas. Le `?v=<sha court>`
 * change l'URL à chaque nouvel avatar : c'est ce qui invalide le cache
 * « immutable » de `GET /avatar` sans toucher au contenu de la réponse.
 */
export function avatarSrc(meta) {
  if (!meta || meta.existe !== true) return null;
  const sha = typeof meta.sha256 === "string" ? meta.sha256.slice(0, 12) : "";
  return sha === "" ? AVATAR_SERVICE_URL : `${AVATAR_SERVICE_URL}?v=${sha}`;
}

/** Lit les métadonnées de l'avatar. `null` si l'API n'existe pas (404). */
export async function chargerAvatar(HolafFetch) {
  try {
    const meta = await HolafFetch.get(AVATAR_API_URL, {
      headers: { accept: "application/json" },
    });
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
    return meta;
  } catch {
    // Pas d'avatar (404) ou API absente : l'UI garde le flocon, sans erreur.
    return null;
  }
}

/**
 * Applique l'état de l'avatar au document : images marquées `data-avatar-image`
 * (barre du haut, état vide), classe `has-avatar` (révèle la marque en
 * téléphone) et favicon. Idempotent.
 */
export function appliquerAvatar(meta) {
  const existe = Boolean(meta && meta.existe === true);
  const src = avatarSrc(meta);
  for (const el of document.querySelectorAll("[data-avatar-image]")) {
    if (src) {
      el.setAttribute("src", src);
      el.removeAttribute("hidden");
    } else {
      el.removeAttribute("src");
      el.setAttribute("hidden", "");
    }
  }
  // Le REPLI (flocon) n'est visible que sans avatar : jamais les deux à la fois.
  for (const el of document.querySelectorAll("[data-avatar-fallback]")) {
    el.hidden = existe;
  }
  document.body.classList.toggle("has-avatar", existe);
  const favicon = document.getElementById("favicon");
  if (favicon) {
    favicon.setAttribute(
      "href",
      existe && typeof meta.sha256 === "string" && meta.sha256 !== ""
        ? `/favicon.ico?v=${meta.sha256.slice(0, 12)}`
        : "/favicon.ico",
    );
  }
  return existe;
}

/** Charge une image (même origine ou data URL — les deux seules autorisées). */
function chargerImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image), { once: true });
    image.addEventListener(
      "error",
      () => reject(new Error("Cette image n'a pas pu être ouverte.")),
      { once: true },
    );
    image.src = src;
  });
}

function lireFichierEnDataUrl(fichier) {
  return new Promise((resolve, reject) => {
    const lecteur = new FileReader();
    lecteur.addEventListener("load", () => resolve(String(lecteur.result)), { once: true });
    lecteur.addEventListener(
      "error",
      () => reject(new Error("Ce fichier n'a pas pu être lu.")),
      { once: true },
    );
    lecteur.readAsDataURL(fichier);
  });
}

/** Facteur de zoom d'un cran de molette (zoom avant/arrière symétrique). */
function facteurMolette(deltaY) {
  return deltaY < 0 ? 1.12 : 1 / 1.12;
}

/**
 * Ouvre l'éditeur de recadrage dans une HolafModal.
 *
 * `onEnregistre` est appelé après un dépôt réussi (l'appelant rafraîchit son
 * aperçu). La modale reste ouverte pendant l'envoi (`setBusy`) et se ferme
 * seulement au succès : un échec ne fait jamais perdre le cadrage.
 */
export function ouvrirEditeurAvatar({ HolafModal, HolafFetch, meta, onEnregistre }) {
  let etat = null;
  let image = null;
  let derniereDistancePincement = 0;
  const pointeurs = new Map();

  const canvas = h("canvas", {
    class: "avatar-editor__canvas",
    width: String(DIAMETRE_APERCU),
    height: String(DIAMETRE_APERCU),
    tabindex: "0",
    role: "application",
    "aria-label":
      "Recadrage de l'avatar : flèches pour déplacer, + et − pour zoomer, " +
      "Origine pour recentrer",
  });
  const contexte = canvas.getContext("2d");
  const apercu = h("div", { class: "avatar-editor__apercu" }, [canvas]);

  const statut = h("p", { class: "avatar-editor__statut", role: "status" });
  const erreur = h("p", { class: "avatar-editor__erreur", role: "alert", hidden: true });
  const entree = h("input", {
    class: "avatar-editor__fichier",
    type: "file",
    accept: "image/png,image/jpeg,image/webp",
    "aria-label": "Choisir une image pour l'avatar",
    hidden: true,
  });

  function dessinerApercu() {
    if (!contexte) return;
    contexte.clearRect(0, 0, DIAMETRE_APERCU, DIAMETRE_APERCU);
    if (!image || !etat) return;
    dessiner(contexte, image, etat, DIAMETRE_APERCU);
  }

  function majBoutons() {
    const pret = Boolean(image && etat);
    boutonZoomMoins.disabled = !pret;
    boutonZoomPlus.disabled = !pret;
    boutonRecentrer.disabled = !pret;
    boutonChoisir.textContent = pret ? "Changer d'image" : "Choisir une image";
  }

  function pointRelatif(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    // Le canvas a une taille CSS = DIAMETRE_APERCU : le facteur vaut 1 sur les
    // navigateurs courants, mais on le calcule (zoom de page, DPI, etc.).
    const facteur = rect.width === 0 ? 1 : DIAMETRE_APERCU / rect.width;
    return {
      x: (clientX - rect.left) * facteur - DIAMETRE_APERCU / 2,
      y: (clientY - rect.top) * facteur - DIAMETRE_APERCU / 2,
    };
  }

  function zoom(facteur, point) {
    if (!etat) return;
    etat = zoomer(etat, facteur, point);
    dessinerApercu();
  }

  function bouger(dx, dy) {
    if (!etat) return;
    etat = deplacer(etat, dx, dy);
    dessinerApercu();
  }

  function recentrerImage() {
    if (!etat) return;
    etat = recentrer(etat);
    dessinerApercu();
  }

  async function adopterImage(src, nom) {
    erreur.hidden = true;
    statut.textContent = "";
    try {
      const chargee = await chargerImage(src);
      if (chargee.naturalWidth > AVATAR_MAX_DIMENSION || chargee.naturalHeight > AVATAR_MAX_DIMENSION) {
        throw new Error(
          `Image refusée : ${chargee.naturalWidth}×${chargee.naturalHeight} px, ` +
            `plafond de ${AVATAR_MAX_DIMENSION}×${AVATAR_MAX_DIMENSION} px.`,
        );
      }
      image = chargee;
      etat = creerEtat({
        largeurImage: chargee.naturalWidth,
        hauteurImage: chargee.naturalHeight,
        diametre: DIAMETRE_APERCU,
      });
      statut.textContent = nom
        ? `${nom} (${chargee.naturalWidth}×${chargee.naturalHeight} px) — recadrez puis enregistrez.`
        : "Recadrez puis enregistrez.";
      dessinerApercu();
      majBoutons();
    } catch (cause) {
      image = null;
      etat = null;
      erreur.textContent = cause instanceof Error ? cause.message : String(cause);
      erreur.hidden = false;
      statut.textContent = "";
      dessinerApercu();
      majBoutons();
    }
  }

  entree.addEventListener("change", () => {
    const fichier = entree.files && entree.files[0];
    if (!fichier) return;
    if (fichier.size > AVATAR_MAX_BYTES) {
      erreur.textContent = `Image refusée : ${fichier.size} octets, plafond de ${AVATAR_MAX_BYTES} octets.`;
      erreur.hidden = false;
      return;
    }
    void lireFichierEnDataUrl(fichier)
      .then((dataUrl) => adopterImage(dataUrl, fichier.name))
      .catch((cause) => {
        erreur.textContent = cause instanceof Error ? cause.message : String(cause);
        erreur.hidden = false;
      });
  });

  const boutonChoisir = h("button", {
    class: "button button--ghost",
    type: "button",
    text: "Choisir une image",
  });
  boutonChoisir.addEventListener("click", () => entree.click());

  const boutonZoomMoins = h("button", {
    class: "button button--ghost avatar-editor__zoom",
    type: "button",
    text: "−",
    "aria-label": "Réduire le zoom",
  });
  boutonZoomMoins.addEventListener("click", () => zoom(1 / 1.25));
  const boutonZoomPlus = h("button", {
    class: "button button--ghost avatar-editor__zoom",
    type: "button",
    text: "+",
    "aria-label": "Augmenter le zoom",
  });
  boutonZoomPlus.addEventListener("click", () => zoom(1.25));
  const boutonRecentrer = h("button", {
    class: "button button--ghost",
    type: "button",
    text: "Recentrer",
  });
  boutonRecentrer.addEventListener("click", () => recentrerImage());

  // ─── Molette = zoom (sous le curseur) ───────────────────────────────────
  canvas.addEventListener(
    "wheel",
    (event) => {
      if (!etat) return;
      event.preventDefault();
      zoom(facteurMolette(event.deltaY), pointRelatif(event.clientX, event.clientY));
    },
    { passive: false },
  );

  // ─── Pointeur : glisser = déplacer, pincer = zoom (souris ET doigt) ─────
  canvas.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (!etat) return;
    canvas.setPointerCapture?.(event.pointerId);
    pointeurs.set(event.pointerId, { x: event.clientX, y: event.clientY });
    derniereDistancePincement = 0;
  });

  canvas.addEventListener("pointermove", (event) => {
    const precedent = pointeurs.get(event.pointerId);
    if (!precedent) return;
    pointeurs.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointeurs.size >= 2) {
      const [a, b] = [...pointeurs.values()];
      const distance = Math.hypot(b.x - a.x, b.y - a.y);
      if (derniereDistancePincement > 0 && distance > 0) {
        const centre = pointRelatif((a.x + b.x) / 2, (a.y + b.y) / 2);
        zoom(distance / derniereDistancePincement, centre);
      }
      derniereDistancePincement = distance;
      return;
    }
    bouger(event.clientX - precedent.x, event.clientY - precedent.y);
  });

  function relacherPointeur(event) {
    pointeurs.delete(event.pointerId);
    if (pointeurs.size < 2) derniereDistancePincement = 0;
  }
  canvas.addEventListener("pointerup", relacherPointeur);
  canvas.addEventListener("pointercancel", relacherPointeur);

  // ─── Clavier : mêmes opérations, sans souris (accessibilité) ────────────
  canvas.addEventListener("keydown", (event) => {
    if (!etat) return;
    const pas = event.shiftKey ? 32 : 8;
    switch (event.key) {
      case "ArrowLeft":
        bouger(-pas, 0);
        break;
      case "ArrowRight":
        bouger(pas, 0);
        break;
      case "ArrowUp":
        bouger(0, -pas);
        break;
      case "ArrowDown":
        bouger(0, pas);
        break;
      case "+":
      case "=":
        zoom(1.25);
        break;
      case "-":
      case "_":
        zoom(1 / 1.25);
        break;
      case "0":
      case "Home":
        recentrerImage();
        break;
      default:
        return;
    }
    event.preventDefault();
  });

  const contenu = h("div", { class: "avatar-editor" }, [
    apercu,
    h("div", { class: "avatar-editor__actions" }, [
      boutonZoomMoins,
      boutonZoomPlus,
      boutonRecentrer,
    ]),
    h("p", {
      class: "avatar-editor__aide",
      text:
        "Molette = zoom · clic gauche glissé = déplacer · au doigt : glisser et " +
        "pincer. Le clavier fonctionne aussi (flèches, +, −, Origine).",
    }),
    h("div", { class: "avatar-editor__choix" }, [boutonChoisir, entree]),
    statut,
    erreur,
  ]);

  async function enregistrer(ctrl) {
    if (!image || !etat) {
      erreur.textContent = "Choisissez d'abord une image.";
      erreur.hidden = false;
      return;
    }
    erreur.hidden = true;
    const sortie = document.createElement("canvas");
    sortie.width = TAILLE_SORTIE;
    sortie.height = TAILLE_SORTIE;
    const contexteSortie = sortie.getContext("2d");
    if (!contexteSortie) {
      erreur.textContent = "Le navigateur n'a pas pu préparer l'image de sortie.";
      erreur.hidden = false;
      return;
    }
    dessiner(contexteSortie, image, etat, TAILLE_SORTIE);
    // ⚠️ `canvas.toBlob` → `arrayBuffer` → corps binaire. L'aperçu reste un
    // `<canvas>` : aucune URL d'objet du navigateur (interdite par
    // `img-src 'self' data:`).
    const blob = await new Promise((resolve) => sortie.toBlob(resolve, "image/png"));
    if (!blob) {
      erreur.textContent = "Le navigateur n'a pas pu encoder l'image en PNG.";
      erreur.hidden = false;
      return;
    }
    ctrl.setBusy(true, "Enregistrement…");
    try {
      const octets = await blob.arrayBuffer();
      await HolafFetch.post(AVATAR_API_URL, {
        body: octets,
        headers: { ...ENTETES_ECRITURE, "content-type": "image/png" },
      });
      ctrl.setBusy(false);
      ctrl.close(true);
      if (typeof onEnregistre === "function") onEnregistre();
    } catch (error) {
      ctrl.setBusy(false);
      erreur.textContent = apiMessage(error, "L'avatar n'a pas pu être enregistré.");
      erreur.hidden = false;
    }
  }

  const ctrl = HolafModal.open({
    title: "Recadrer l'avatar",
    size: "md",
    content: contenu,
    closeOnOverlay: false,
    actions: [
      { label: "Annuler", type: "cancel", value: false },
      {
        label: "Enregistrer",
        type: "primary",
        autoFocus: true,
        close: false,
        onClick: (instance) => {
          void enregistrer(instance);
        },
      },
    ],
  });

  majBoutons();
  const src = avatarSrc(meta);
  if (src) void adopterImage(src, "");
  return ctrl;
}

/**
 * Construit la section « Avatar » de l'onglet Personnalité : aperçu 48 px,
 * « Changer l'avatar » (éditeur) et « Retirer » (confirmation HolafModal).
 * Renvoie `{ element, rafraichir }`.
 */
export function creerSectionAvatar({ HolafFetch, HolafModal }) {
  const etat = { meta: null };

  const apercu = h("img", {
    class: "avatar avatar--reglages",
    alt: "Avatar actuel de Yuki",
    hidden: true,
  });
  const glyphe = h("span", {
    class: "avatar-section__glyphe",
    "aria-hidden": "true",
    text: "❄️",
  });
  const statut = h("p", { class: "avatar-section__statut", role: "status" });
  const erreur = h("p", { class: "config-banner config-banner--warn", role: "alert", hidden: true });

  const boutonChanger = h("button", {
    class: "button",
    type: "button",
    text: "Changer l'avatar",
  });
  const boutonRetirer = h("button", {
    class: "button button--ghost",
    type: "button",
    text: "Retirer",
  });

  function appliquer() {
    const src = avatarSrc(etat.meta);
    if (src) {
      apercu.setAttribute("src", src);
      apercu.removeAttribute("hidden");
      glyphe.hidden = true;
      boutonRetirer.disabled = false;
      statut.textContent = "";
    } else {
      apercu.removeAttribute("src");
      apercu.setAttribute("hidden", "");
      glyphe.hidden = false;
      boutonRetirer.disabled = true;
      statut.textContent = "Aucun avatar : le flocon ❄️ est affiché dans l'application.";
    }
  }

  async function rafraichir() {
    erreur.hidden = true;
    etat.meta = await chargerAvatar(HolafFetch);
    appliquer();
    return etat.meta;
  }

  async function retirer() {
    const confirme = await HolafModal.confirm(
      "Retirer l'avatar",
      "L'avatar de Yuki sera supprimé : la barre du haut, l'état vide et le " +
        "favicon reviendront au flocon ❄️. Vous pourrez en déposer un autre à tout moment.",
      { danger: true, confirmText: "Retirer l'avatar" },
    );
    if (!confirme) return;
    try {
      await HolafFetch.delete(AVATAR_API_URL, { headers: ENTETES_ECRITURE });
      await rafraichir();
    } catch (error) {
      erreur.textContent = apiMessage(error, "L'avatar n'a pas pu être retiré.");
      erreur.hidden = false;
    }
  }

  boutonChanger.addEventListener("click", () => {
    ouvrirEditeurAvatar({
      HolafModal,
      HolafFetch,
      meta: etat.meta,
      onEnregistre: () => void rafraichir(),
    });
  });
  boutonRetirer.addEventListener("click", () => void retirer());

  const aide = h("p", {
    class: "config-helper",
    text:
      "L'avatar remplace le flocon ❄️ dans l'état vide et apparaît avant le nom " +
      "« Yuki » dans la barre du haut. Il sert aussi de favicon (icône d'onglet). " +
      "Il est conservé sans limite de durée, indépendamment des fichiers échangés.",
  });

  const element = h("section", { class: "config-group avatar-section" }, [
    h("div", { class: "config-group__head" }, [
      h("h2", { class: "config-group__title", text: "Avatar" }),
    ]),
    h("div", { class: "avatar-section__ligne" }, [
      h("div", { class: "avatar-section__apercu" }, [glyphe, apercu]),
      h("div", { class: "avatar-section__actions" }, [boutonChanger, boutonRetirer]),
    ]),
    aide,
    statut,
    erreur,
  ]);

  void rafraichir();
  return { element, rafraichir };
}

/**
 * Initialise l'avatar sur la page `/` : charge l'état puis l'applique aux
 * emplacements présents (barre du haut, état vide) et au favicon. Un échec
 * laisse le flocon, sans message d'erreur (l'absence d'avatar n'est pas une
 * erreur).
 */
export async function initAvatar({ HolafFetch }) {
  const meta = await chargerAvatar(HolafFetch);
  appliquerAvatar(meta);
  return { meta };
}
