/**
 * Page « Configuration » — logique PURE, sans DOM.
 *
 * Extraite de `config.js` (module à effets de bord : `document`, thème, panneaux)
 * pour être **testable sans navigateur**, exactement comme `tts-player.js`. Elle
 * couvre deux responsabilités :
 *
 * 1. `buildConfigPatch()` : construit le patch envoyé à `PUT /api/config` à
 *    partir de l'état des contrôles. Les champs numériques (`kind: "number"` /
 *    `"range"`) sont envoyés en **nombres entiers**, les autres en chaînes —
 *    cohérent avec le schéma (`int` / `string` / `enum`). Le serveur tolère les
 *    chaînes numériques, mais le type correct évite toute dépendance à cette
 *    tolérance ;
 * 2. `presentConfigSaveError()` : traduit une erreur de l'API en présentation
 *    UI. **Le code et le message réels du serveur sont toujours montrés** ;
 *    `CONFIG_ERROR_HELP` n'ajoute qu'une piste lisible (jamais une cause
 *    inventée). Corrige le message « Échec de l'enregistrement. » générique.
 */

/**
 * Codes d'erreur de `PUT /api/config` (`src/gateway/routes/config.ts`) →
 * explication en français. Sert UNIQUEMENT de complément : le message brut du
 * serveur reste la source de vérité et n'est jamais remplacé.
 */
export const CONFIG_ERROR_HELP = {
  locked_by_env:
    "Le champ est imposé par une variable d'environnement : retirez-la (ou videz-la) puis redémarrez le gateway pour pouvoir le modifier ici.",
  invalid_config: "Le gateway a refusé une ou plusieurs valeurs du patch.",
  bad_origin:
    "L'origine de la requête ne correspond pas à l'hôte du gateway (accès par une autre adresse ou reverse-proxy).",
  missing_config_header:
    "L'en-tête d'écriture X-Yuki-Config est absent : rechargez la page puis réessayez.",
  forbidden: "Le gateway a refusé l'écriture.",
  config_store_unwritable:
    "Le gateway n'a pas pu écrire le fichier de configuration : la cause exacte (montage en lecture seule, permissions, dossier absent) est indiquée dans le message du serveur ci-dessus ; vérifiez le montage du volume « state ».",
  invalid_json: "Le corps de la requête n'est pas un JSON valide (bug client).",
  invalid_body: "Le corps de la requête n'est pas un objet JSON (patch de champs attendu).",
  internal_error: "Le gateway a rencontré une erreur interne : consultez ses journaux.",
  bot_scoped_field:
    "Ce réglage est propre à un bot : il se règle sur la page du bot (/bots), pas sur celle de l'instance.",
  instance_scoped_field:
    "Ce réglage appartient à l'instance : il se règle sur la page de configuration (/config), pas par bot.",
  bot_not_found: "Le bot demandé n'existe pas sur cette instance.",
};

/**
 * Capacités de MOTEUR par champ de la page `/config` — **miroir UI** de
 * `src/tts/audio-cpp.ts` (`engineSupportsSpeed` / `engineSupportsEmotion`).
 *
 * Un réglage « sans effet avec ce moteur » doit être **désactivé ET noté**
 * plutôt que laisser croire qu'il agit (`docs/lot8.md` §11.14/§11.16). Preuves
 * moteur :
 *   - débit : `app/server/runtime.cpp:2112-2124` (appliqué par `kokoro` /
 *     `sanotts` ; omis pour les autres) ;
 *   - émotion : `src/models/chatterbox/session.cpp:42-79` (lue par `chatterbox`
 *     seulement).
 *
 * Tenir cette table SYNCHRONISÉE avec `src/tts/audio-cpp.ts` (un test le
 * vérifie) : le gateway et l'UI doivent s'accorder sur ce qui « agit ».
 */
export const SPEED_CAPABLE_ENGINES = new Set(["kokoro", "kokoro_tts", "sanotts"]);
export const EMOTION_CAPABLE_ENGINES = new Set(["chatterbox"]);

/** Note affichée sous un champ inopérant pour le moteur sélectionné. */
export const ENGINE_UNSUPPORTED_NOTE = "Sans effet avec ce moteur.";

/** `true` si le moteur applique réellement le débit (`tts.speed`). */
export function engineSupportsSpeed(engine) {
  return SPEED_CAPABLE_ENGINES.has(String(engine ?? "").trim().toLowerCase());
}

/** `true` si le moteur lit réellement les réglages d'émotion. */
export function engineSupportsEmotion(engine) {
  return EMOTION_CAPABLE_ENGINES.has(String(engine ?? "").trim().toLowerCase());
}

/**
 * État d'un champ vis-à-vis du moteur sélectionné : `{ disabled, note }`, ou
 * `null` si le champ n'a **aucune** dépendance moteur (ex. `tts.baseUrl`).
 * `disabled: true` ⇒ l'UI grise le contrôle et affiche `note`.
 */
export function engineFieldState(path, engine) {
  switch (path) {
    case "tts.speed":
      return engineSupportsSpeed(engine)
        ? { disabled: false, note: "" }
        : { disabled: true, note: ENGINE_UNSUPPORTED_NOTE };
    case "tts.exaggeration":
    case "tts.cfg":
      return engineSupportsEmotion(engine)
        ? { disabled: false, note: "" }
        : { disabled: true, note: ENGINE_UNSUPPORTED_NOTE };
    default:
      return null;
  }
}

/**
 * Convertit la valeur d'un contrôle au type attendu par le schéma.
 *
 * `<input>` renvoie **toujours une chaîne**. Les champs `number`/`range`
 * deviennent des **entiers** ; un contenu vide ou non entier est laissé tel quel
 * pour que le serveur rende l'erreur précise (`invalid_int`, bornes…).
 */
export function coerceFieldValue(field, value) {
  if (field.kind !== "number" && field.kind !== "range") return value;
  const trimmed = String(value).trim();
  if (trimmed === "") return value; // vide : laisser le serveur refuser explicitement
  const numeric = Number(trimmed);
  return Number.isInteger(numeric) ? numeric : value;
}

/**
 * Valeur à réécrire dans le contrôle lors d'un « Réinitialiser au défaut ».
 *
 * Ordre de priorité :
 *  1. `default` du snapshot servi par `GET /api/config` — SEULE source exacte :
 *     pour `prompts.light` / `prompts.heavy` le défaut est le CONTENU DU FICHIER
 *     LIVRÉ (`src/config/runtime.ts`, `readTextFile(env.piSystemPromptPath)`),
 *     que le navigateur ne peut pas deviner ;
 *  2. à défaut, le miroir `FIELD_DEFAULTS` (gateway ancien) — il ne contient
 *     VOLONTAIREMENT aucune entrée pour les prompts.
 *
 * ⚠️ `undefined` = défaut inconnu du client (jamais une chaîne vide par
 * défaut) : le bouton reste utile quand une surcharge existe, car il l'EFFACE
 * côté serveur (`null`) et le défaut s'applique alors sans être connu du client.
 */
export function resetValueFor(field, entry, mirror = {}) {
  if (entry && typeof entry === "object") {
    const served = entry.default;
    if (served !== undefined && served !== null) return served;
  }
  if (field && Object.prototype.hasOwnProperty.call(mirror, field.path)) {
    return mirror[field.path];
  }
  return undefined;
}

/**
 * Libellé d'ORIGINE (③) : ce qui est réellement actif pour ce champ.
 *
 * `null` = rien à affirmer (verrouillé par l'environnement : la valeur ne vient
 * ni du défaut ni d'une surcharge enregistrée ; ou origine inconnue).
 */
export function originLabel(entry) {
  if (!entry || entry.lockedByEnv) return null;
  if (entry.origin === "store") return "personnalisé";
  if (entry.origin === "default") return "valeur par défaut";
  return null;
}

/**
 * Refus EXPLICITE d'un champ TEXTE vidé alors qu'un défaut NON VIDE existe.
 *
 * ⚠️ Pourquoi côté client : le prompt système est un texte long ; le vider par
 * inadvertance (sélection + touche Retour arrière) puis enregistrer laissait le
 * modèle sans aucune consigne. Le gateway refuse déjà `""` (`empty_value`,
 * `src/config/schema.ts`) — on le dit AVANT l'envoi, avec l'action à faire, au
 * lieu d'un aller-retour réseau et d'un message sous le contrôle.
 *
 * Seuls les champs dont le défaut RÉEL est non vide sont concernés (`default`
 * servi par `GET /api/config`) : un champ dont le défaut est la chaîne vide
 * (`gpu.profile`, `librarian.baseUrl`, …) peut légitimement être vidé.
 *
 * @returns {Array<{ path: string, code: string, message: string }>}
 */
export function emptyValueRefusals({ allFields, state, labels = new Map() }) {
  const refusals = [];
  for (const field of allFields) {
    if (field.kind === "secret") continue;
    const entry = state.fields[field.path];
    if (!entry || entry.lockedByEnv) continue;
    if (state.pendingResets.has(field.path)) continue;
    const fallback = entry.default;
    if (typeof fallback !== "string" || fallback.trim() === "") continue;
    const control = state.inputs.get(field.path);
    if (!control) continue;
    if (String(control.value).trim() !== "") continue;
    const label = labels.get(field.path) ?? field.label ?? field.path;
    refusals.push({
      path: field.path,
      code: "empty_value",
      message: `« ${label} » ne peut pas être vide : sans valeur, le défaut livré ne s'applique pas. Cliquez sur « Réinitialiser au défaut » pour le restaurer.`,
    });
  }
  return refusals;
}

/**
 * Construit le patch des champs modifiés. `state` est l'état partagé de
 * `config.js` (`fields`, `secretState`, `pendingResets`, `inputs`, `initial`).
 * Seuls les champs **réellement modifiés** sont inclus ; un champ verrouillé par
 * l'environnement est ignoré.
 *
 * @returns {Record<string, unknown>}
 */
export function buildConfigPatch({ allFields, state }) {
  const patch = {};
  for (const field of allFields) {
    const entry = state.fields[field.path];
    if (entry && entry.lockedByEnv) continue;

    if (field.kind === "secret") {
      const secret = state.secretState.get(field.path);
      if (!secret) continue;
      if (secret.mode === "clear") {
        patch[field.path] = null;
        continue;
      }
      const value = secret.input ? secret.input.value.trim() : "";
      if (value !== "") patch[field.path] = value;
      continue;
    }

    if (state.pendingResets.has(field.path)) {
      patch[field.path] = null;
      continue;
    }
    const control = state.inputs.get(field.path);
    if (!control) continue;
    const value = control.value;
    const initial = state.initial.get(field.path);
    if (field.path === "gpu.profile" && value === "") {
      if (initial !== "") patch[field.path] = null;
      continue;
    }
    if (String(value) !== String(initial)) {
      patch[field.path] = coerceFieldValue(field, value);
    }
  }
  return patch;
}

/**
 * Découpe un patch de configuration en DEUX écritures (lot 35b, sous-lot 1b-3).
 *
 * Depuis le découpage Instance/Bot, un réglage a une PORTÉE (`scope` du
 * snapshot) et chaque écran n'a le droit d'écrire que la sienne :
 *  - `instance` : clés `instance` **et** `mixte` ⇒ `PUT /api/config` (le côté
 *    INSTANCE d'une clé mixte) ;
 *  - `bot` : clés propres au bot ⇒ `PUT /api/bots/<id>/config`.
 *
 * ⚠️ Une portée INCONNUE (snapshot d'un gateway antérieur au découpage) part
 * côté INSTANCE : c'est là que vivaient TOUS les réglages avant ce lot, donc le
 * seul repli qui ne perde pas une valeur en silence.
 *
 * @param {Record<string, unknown>} patch
 * @param {Record<string, string>} scopes  chemin → `"instance" | "bot" | "mixte"`
 * @returns {{ instance: Record<string, unknown>, bot: Record<string, unknown> }}
 */
export function splitConfigPatchByScope(patch, scopes = {}) {
  const instance = {};
  const bot = {};
  for (const [path, value] of Object.entries(patch ?? {})) {
    if (scopes[path] === "bot") bot[path] = value;
    else instance[path] = value;
  }
  return { instance, bot };
}

/** Sélectionne la chaîne non vide parmi des candidats (sinon `null`). */
function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/**
 * Traduit une erreur (HolafFetchError du `PUT /api/config`) en présentation UI :
 * `{ summary, fields }`.
 *
 * - `summary` : une phrase contenant **le code HTTP/code métier réels** et, si
 *   présent, le message du serveur + le nom du champ fautif ;
 * - `fields` : les erreurs à afficher sous les contrôles (`{ path, code,
 *   message }`), directement exploitables par `showFieldErrors`.
 *
 * Aucune cause n'est inventée : si le serveur fournit un message, il est montré
 * tel quel ; l'explication par code (`CONFIG_ERROR_HELP`) ne fait que s'ajouter.
 *
 * @returns {{ summary: string, fields: Array<{ path: string, code: string, message: string }> }}
 */
export function presentConfigSaveError(error, labels = new Map()) {
  const data = (error && error.data) || {};
  const code = firstString(data.code, data.error);
  const status = error && typeof error.status === "number" ? error.status : null;
  const labelOf = (path) => (path ? labels.get(path) ?? path : "");

  const rawFields = Array.isArray(data.fields) ? data.fields : [];
  const fields =
    rawFields.length > 0
      ? rawFields.map((entry) => {
          const path = entry && typeof entry.path === "string" ? entry.path : "";
          const fieldCode = firstString(entry && entry.code, code) ?? "";
          const rawMessage = firstString(entry && entry.message);
          return {
            path,
            code: fieldCode,
            message:
              rawMessage ?? CONFIG_ERROR_HELP[fieldCode] ?? "Valeur refusée par le gateway.",
          };
        })
      : [
          {
            path: "",
            code: code ?? "",
            message:
              firstString(data.message) ??
              (error instanceof Error ? error.message : String(error)),
          },
        ];

  const transport = status !== null && status > 0 ? `HTTP ${status}` : "réseau";
  const headline = `Échec de l'enregistrement (${code ?? transport}).`;
  const help = code ? CONFIG_ERROR_HELP[code] ?? "" : "";
  const first = fields[0];
  const where = first && first.path ? `Champ « ${labelOf(first.path)} » : ` : "";
  const detail = first && first.message ? first.message : "";
  const summary = [headline, help, `${where}${detail}`.trim()]
    .filter(Boolean)
    .join(" ");

  return { summary, fields };
}

/**
 * Présente le résultat d'un `POST /api/admin/restart` refusé. Le cas NOTABLE est
 * le `409 download_in_progress` (Lot 9, étape 2) : le refus n'est **pas une
 * panne** mais une protection (le redémarrage tuerait le transfert). Il est donc
 * affiché comme une **information** (sans préfixe « Échec »), avec le message
 * exact du serveur. Tout autre code garde le préfixe d'échec historique.
 *
 * @returns {{ code: string|null, info: boolean, message: string }}
 */
export function presentRestartRefusal(error) {
  const data = (error && error.data) || {};
  const code = firstString(data.code, data.error);
  const serverMessage = firstString(data.message);
  if (code === "download_in_progress") {
    return {
      code,
      info: true,
      message:
        serverMessage ??
        "Un téléchargement de modèle est en cours : redémarrer maintenant l'interromprait. " +
          "Attendez la fin du téléchargement ou annulez-le, puis redémarrez.",
    };
  }
  const raw = serverMessage ?? (error instanceof Error ? error.message : String(error));
  return { code, info: false, message: `Échec de la demande de redémarrage : ${raw}` };
}
