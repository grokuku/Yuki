/**
 * Préférence locale de lecture vocale + état d'affichage du bouton « voix »
 * (Lot 7, §9.3 / §10.5).
 *
 * Articulation retenue (voir `docs/lot7.md` §10.5) :
 *   - **activation serveur** `tts.enabled` : décidée sur la page `/config`
 *     (`apply: "restart"`, donc jamais pilotée par un bouton de topbar — un
 *     bascule locale instantanée serait trompeuse) ;
 *   - **sourdine locale** : préférence par navigateur (`localStorage`), coupe
 *     la lecture **instantanément**, sans aller-retour réseau.
 *
 * Le bouton de topbar reflète l'état **effectif** : il ne dit « voix active »
 * que si le serveur produit (`serverEnabled`) ET que l'utilisateur n'a pas mis
 * la sourdine. Sinon il affiche un état non ambigu (`off`/`muted`).
 *
 * Module pur (aucune dépendance DOM en dur : le stockage est injectable),
 * testable en Node.
 */

/** Clé de persistance de la sourdine locale. */
export const STORAGE_KEY = "yuki-tts-muted";

/** Sourdine par défaut : la voix est audible dès que le serveur la produit. */
export const DEFAULT_MUTED = false;

/** Renvoie `localStorage` si disponible, sinon `null` (mode privé, quota…). */
export function defaultStorage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Lit la sourdine persistée (`false` si absente/illisible). */
export function readMuted(storage = defaultStorage()) {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (raw === "1") return true;
    if (raw === "0") return false;
    return DEFAULT_MUTED;
  } catch {
    return DEFAULT_MUTED;
  }
}

/** Écrit la sourdine (best-effort : l'absence de stockage ne bloque rien). */
export function writeMuted(muted, storage = defaultStorage()) {
  try {
    storage?.setItem(STORAGE_KEY, muted ? "1" : "0");
  } catch {
    /* persistance best-effort */
  }
}

/**
 * Préférence locale mutable, adossée au stockage.
 * @param {Storage|null} [storage]
 */
export function createTtsPreference(storage = defaultStorage()) {
  let muted = readMuted(storage);
  return {
    get muted() {
      return muted;
    },
    setMuted(value) {
      muted = Boolean(value);
      writeMuted(muted, storage);
      return muted;
    },
    toggle() {
      return this.setMuted(!muted);
    },
  };
}

/**
 * État d'affichage cohérent du bouton.
 *
 * @param {{ serverEnabled: boolean, muted: boolean }} input
 * @returns {{ state: "off"|"muted"|"on", audible: boolean, pressed: boolean,
 *   icon: string, label: string, hint: string }}
 */
export function resolveSpeechState({ serverEnabled, muted }) {
  if (!serverEnabled) {
    return {
      state: "off",
      audible: false,
      pressed: false,
      icon: "🔇",
      label: "Voix désactivée (TTS serveur inactif)",
      hint: "Le TTS est désactivé côté serveur : activez-le dans la configuration, puis redémarrez Yuki.",
    };
  }
  if (muted) {
    return {
      state: "muted",
      audible: false,
      pressed: false,
      icon: "🔇",
      label: "Réactiver la voix",
      hint: "Voix en sourdine sur ce navigateur.",
    };
  }
  return {
    state: "on",
    audible: true,
    pressed: true,
    icon: "🔊",
    label: "Couper la voix",
    hint: "Voix active : la réponse est lue à voix haute.",
  };
}
