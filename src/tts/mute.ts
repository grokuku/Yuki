/**
 * Convention du bloc « muet » — SOURCE UNIQUE (chantier interface de chat).
 *
 * Une réponse n'est pas seulement lue : elle est aussi **entendue**. Or certains
 * constructs markdown n'ont aucun sens à l'oreille — un bloc de code, un
 * tableau de données, une image. Le TTS n'est **pas** un outil d'accessibilité
 * mais une **conversation naturelle** : ce qui compte doit être **dit avec des
 * mots** ; le visuel reste affiché à l'écran, mais **muet**.
 *
 * Il y a donc deux niveaux de « muet » :
 *   - les constructs **naturellement muets** au filtre (bloc de code, tableau,
 *     image) — le modèle n'a rien à faire de spécial ;
 *   - le bloc **`muet`**, construct EXPLICITE par lequel le modèle range ce qui
 *     ne doit pas être prononcé (tableau, données brutes, code) sans l'énoncer.
 *
 * Cette constante est le **seul endroit** où l'étiquette est définie. Elle est
 * consommée par :
 *   - le **filtre** (`./markdown.ts`), qui ignore ces blocs ;
 *   - le **prompt système** (`../llm/prompts.ts`), qui demande au modèle de
 *     l'employer.
 * Les deux **ne peuvent donc pas diverger** (un test de garde le vérifie).
 *
 * ⚠️ **Passe multilingue** — `MUTE_BLOCK_LABELS` est une **liste** : ajouter une
 * langue plus tard = ajouter son étiquette ici (ex. `"silent"`, `"mute"`). Le
 * filtre **et** le prompt lisent cette liste, donc aucun littéral n'est à
 * répercuter ailleurs.
 */

/**
 * Étiquettes d'info-string reconnues comme « muettes » (en minuscules).
 * Premier mot d'un bloc ` ```muet ` ; comparé sans tenir compte de la casse.
 */
export const MUTE_BLOCK_LABELS: readonly string[] = ["muet"];

/** Étiquette canonique (français), utilisée par le prompt et le filtre. */
export const MUTE_BLOCK_LABEL = MUTE_BLOCK_LABELS[0]!;

/**
 * `true` si l'info-string d'un bloc de code désigne un bloc muet.
 *
 * Seul le **premier mot** compte (`muet`, `muet json`…) et la **casse est
 * ignorée**. Une info-string vide ou inconnue renvoie `false` : le bloc reste un
 * bloc de code ordinaire (comportement actuel inchangé — repli défensif).
 */
export function isMuteInfoString(info: string): boolean {
  const first = info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return first.length > 0 && MUTE_BLOCK_LABELS.includes(first);
}
