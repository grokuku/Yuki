// Yuki — FICHIERS COLLÉS depuis le presse-papiers (module PUR, sans DOM).
//
// Un collage (`paste`) peut transporter des FICHIERS, pas seulement du texte :
//  - une capture d'écran copiée (« Copier l'image » du navigateur, outil de
//    capture du système) arrive en `image/png` SANS nom de fichier ;
//  - un fichier copié depuis le Finder / l'explorateur arrive avec son nom.
// ⚠️ Les deux passent par le MÊME item (`kind === "file"`) : un PDF copié n'est
// pas une pièce à part, il est un fichier comme un autre.
//
// ⚠️ POURQUOI GÉNÉRER UN NOM : le nom voyage en en-tête (`x-yuki-filename`,
// pourcent-encodé) et c'est son EXTENSION que le serveur lit pour classer le
// fichier. Une image collée sans nom tomberait donc sur « fichier » sans
// extension → « format inconnu » → aucun aperçu et aucun traitement d'image.
//
// Aucun DOM ici : les tests unitaires (`tests/ui/clipboard-files.test.ts`)
// importent ce module tel quel.

/** Extension déduite du type MIME (aucune invention : le repli est `bin`). */
const MIME_EXTENSIONS = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/jpg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
  ["image/avif", "avif"],
  ["image/bmp", "bmp"],
  ["application/pdf", "pdf"],
  ["text/plain", "txt"],
  ["text/markdown", "md"],
  ["application/json", "json"],
]);

/** Extension de repli quand le type MIME ne dit rien d'exploitable. */
const FALLBACK_EXTENSION = "bin";

/** Extension sûre pour un nom de fichier (`bin` si le MIME est muet). */
function extensionForType(type) {
  const mime = String(type ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const ext = MIME_EXTENSIONS.get(mime);
  return ext ?? FALLBACK_EXTENSION;
}

/**
 * Un nom de fichier EXPLOITABLE : non vide et porteur d'une extension
 * reconnaissable (`capture.png`). `.cache` ou `capture` n'en portent pas.
 */
function hasUsableName(name) {
  const base = String(name ?? "").trim();
  if (base === "") return false;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return false;
  return /^[a-z0-9]{1,10}$/i.test(base.slice(dot + 1));
}

/** Deux chiffres (`7` → `07`). */
function pad2(value) {
  return String(value).padStart(2, "0");
}

/**
 * Horodatage local compact `AAAAMMJJ-HHMMSS` (lisible tel quel par l'humain,
 * et trié dans l'ordre chronologique).
 *
 * @param {number|Date} now instant choisi (injecté : aucun test ne dépend de
 *   l'horloge réelle).
 */
function stampOf(now) {
  const at = now instanceof Date ? now : new Date(Number(now));
  if (Number.isNaN(at.getTime())) return "00000000-000000";
  return (
    `${at.getFullYear()}${pad2(at.getMonth() + 1)}${pad2(at.getDate())}` +
    `-${pad2(at.getHours())}${pad2(at.getMinutes())}${pad2(at.getSeconds())}`
  );
}

/**
 * Nom lisible d'un fichier collé : le nom d'origine est CONSERVÉ dès qu'il est
 * exploitable, sinon un nom daté est fabriqué (`collé-AAAAMMJJ-HHMMSS.<ext>`).
 *
 * ⚠️ Les ACCENTS sont conservés (« collé ») : l'envoi pourcent-encode le nom
 * (`encodeURIComponent`), le serveur le décode, rien n'est perdu.
 *
 * @param {File} file fichier collé.
 * @param {{ now?: number|Date }} [options] instant de référence (injectable).
 * @returns {string} nom à envoyer, jamais vide, toujours avec une extension.
 */
export function namePastedFile(file, { now = Date.now() } = {}) {
  const existing = String(file?.name ?? "").trim();
  if (hasUsableName(existing)) return existing;
  return `collé-${stampOf(now)}.${extensionForType(file?.type)}`;
}

/**
 * Fichiers contenus dans un presse-papiers (`ClipboardEvent.clipboardData`).
 *
 * ⚠️ On n'accepte QUE les items `kind === "file"` : un texte copié ou le
 * `text/html` d'un tableur ne doit JAMAIS être transformé en fichier joint.
 * ⚠️ `getAsFile()` peut renvoyer `null` (presse-papiers vidé entre-temps) : ces
 * items sont ignorés, jamais transmis tels quels.
 *
 * @param {DataTransfer|null|undefined} dataTransfer contenu du presse-papiers.
 * @param {{ now?: number|Date }} [options] instant de référence du nom généré.
 * @returns {File[]} fichiers prêts pour l'envoi (noms exploitables garantis).
 */
export function filesFromClipboard(dataTransfer, { now = Date.now() } = {}) {
  const items = dataTransfer?.items;
  /** Renomme seulement si nécessaire (un fichier déjà nommé reste INTACT). */
  const prepared = (file) => {
    if (!file) return null;
    const name = namePastedFile(file, { now });
    if (name === file.name) return file;
    try {
      return new File([file], name, { type: file.type, lastModified: file.lastModified });
    } catch {
      // Environnement sans constructeur `File` : on garde l'original (le nom
      // sera alors celui que le navigateur a bien voulu donner).
      return file;
    }
  };

  if (!items || typeof items.length !== "number" || items.length === 0) {
    // Repli : certains environnements ne peuplent que `files`.
    const files = dataTransfer?.files;
    if (!files || typeof files.length !== "number") return [];
    const fallback = [];
    for (let index = 0; index < files.length; index += 1) {
      const file = prepared(files[index]);
      if (file) fallback.push(file);
    }
    return fallback;
  }

  const found = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item || item.kind !== "file") continue;
    const raw =
      typeof item.getAsFile === "function" ? item.getAsFile() : null;
    const file = prepared(raw);
    if (file) found.push(file);
  }
  return found;
}
