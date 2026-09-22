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
