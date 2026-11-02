/**
 * ACCUSÉ DE RÉCEPTION — règle UNIQUE de déclenchement, de forme et de repli.
 *
 * ⚠️ QUI L'ÉCRIT : LE MODÈLE. L'accusé n'est plus un texte figé par le code :
 * c'est le PREMIER TEXTE du tour, écrit par le modèle lui-même (`text_delta`
 * avant l'appel d'outil, donc ZÉRO appel modèle supplémentaire et ZÉRO tour en
 * plus). Le code ne fait que RECONNAÎTRE ce texte quand l'action démarre :
 *  - il le RETIENT (il n'est pas émis comme contenu, donc jamais prononcé par
 *    la synthèse vocale et jamais mémorisé) ;
 *  - il le CONSERVE tel quel comme première ligne de la bulle (et le persiste
 *    pour qu'il survive au rechargement).
 * Sans texte du modèle (il appelle l'outil directement), le repli ci-dessous
 * prend la main — avec des VARIATIONS, pour ne pas répéter la même phrase.
 *
 * ⚠️ LE CRITÈRE EST L'ACTION, JAMAIS UNE PRÉDICTION DE DURÉE. Yuki n'a rien à
 * estimer (nombre de tokens, longueur probable, temps restant) : la décision est
 * un **test booléen** — « une action vient-elle de démarrer ? ».
 *
 * Trois déclencheurs, et trois seulement :
 *   1. une DÉLÉGATION démarre (`delegate`) ;
 *   2. une GÉNÉRATION D'IMAGE démarre (`generer_image`) ;
 *   3. une COMMANDE part sur un agent (`run_command`).
 *
 * Une question simple, une réponse immédiate, une lecture rapide : AUCUN accusé
 * (aucune action n'est lancée, donc le test est faux).
 *
 * ⚠️ L'accusé ne PROMET AUCUN RÉSULTAT : « je m'en occupe » dit qu'on prend la
 * demande en charge, pas qu'elle a réussi. Le badge anti-mensonge et le ticket
 * de délégation disent déjà le vrai état.
 */

/** Outils dont le DÉMARRAGE déclenche un accusé (liste fermée, verrouillée par test). */
export const ACK_TOOLS: readonly string[] = ["delegate", "generer_image", "run_command"];

/**
 * BORNE DURE de l'accusé, en points de code (une ligne, jamais un paragraphe).
 *
 * ⚠️ Ce n'est pas une préférence : c'est le CRITÈRE DE RECONNAISSANCE. Un texte
 * plus long que cette borne, ou réparti sur plusieurs lignes, n'est PAS un
 * accusé — c'est une réponse, et il part comme contenu. C'est ce qui empêche
 * qu'un long paragraphe du modèle (PIÈGE ⑥) se retrouve dans la ligne de statut.
 *
 * La consigne du prompt vise plus court (`ACK_RULE_MAX_CHARS`), la borne de
 * reconnaissance laisse une marge : un accusé un peu bavard reste un accusé.
 */
export const ACK_MAX_CHARS = 90;

/** Longueur conseillée par la consigne du prompt (plus stricte que la borne). */
export const ACK_RULE_MAX_CHARS = 60;

/**
 * REPLI EN DUR, avec VARIATIONS, par outil. Le premier élément est aussi le
 * libellé HISTORIQUE (sessions antérieures) : sa valeur ne doit donc pas changer.
 *
 * ⚠️ MÉCANISME DE VARIATION : ROTATION DÉTERMINISTE (index fourni par l'appelant,
 * incrémenté à chaque repli de la conversation).
 *  - Déterministe ⇒ reproductible en test (aucun aléa, aucun *flake*) et l'ordre
 *    des phrases est le même d'un redémarrage à l'autre ;
 *  - en rotation ⇒ deux replis consécutifs ne sont JAMAIS la même phrase (ce que
 *    `Math.random()` ne garantit pas) et toutes les variantes finissent par
 *    passer ;
 *  - `Math.random()` a été écarté : non reproductible en test, et rien ne
 *    garantit qu'il ne tire pas deux fois la même phrase de suite.
 */
export const ACK_FALLBACK_TEXTS: Readonly<Record<string, readonly string[]>> = {
  delegate: [
    "Je m'en occupe.",
    "Deux secondes, je m'en occupe.",
    "Je prends ça en charge.",
    "Ok, je lance ça.",
    "Je m'y mets.",
  ],
  generer_image: [
    "C'est parti.",
    "Je lance la génération.",
    "Deux secondes, ça arrive.",
    // ⚠️ BORNE DÉCLARÉE (`images.timeoutMs` = 180 s) : sous `chat.remoteAgents =
    // desactive`, la génération s'exécute DANS le tour — la personne doit savoir
    // qu'elle attendra. Ce n'est pas une promesse de RÉSULTAT (le badge
    // anti-mensonge existe déjà), c'est la durée réelle de l'action.
    "Ça peut prendre jusqu'à trois minutes.",
    "Je m'en occupe.",
    "Ok, je génère ça.",
  ],
  run_command: [
    "C'est parti.",
    "Je transmets la commande.",
    "Deux secondes.",
    "Je lance ça.",
    "Je m'en occupe.",
  ],
};

/** Vrai si ce nom d'outil déclenche un accusé (liste fermée des actions longues). */
export function isAckTool(tool: string): boolean {
  return ACK_TOOLS.includes(tool);
}

/**
 * Déclencheurs d'accusé PARMI les outils RÉELLEMENT autorisés d'un run, dans
 * l'ordre canonique de `ACK_TOOLS` (dédupliqué).
 *
 * ⚠️ POURQUOI CETTE FONCTION EXISTE : un run DISTANT n'a pas les mêmes outils
 * qu'un run local (`run_command` y est structurellement absent : aucune commande
 * n'est validable depuis un canal). Une consigne qui cite un outil absent décrit
 * une action que le modèle ne peut pas lancer — au mieux inutile, au pire elle
 * l'incite à invoquer une capacité qu'il n'a pas.
 */
export function ackToolsOf(tools: readonly string[]): string[] {
  const autorises = new Set(tools);
  return ACK_TOOLS.filter((tool) => autorises.has(tool));
}

/**
 * Texte de repli pour un outil, à la `index`-ième position de la rotation.
 * `undefined` si l'outil n'est pas un déclencheur (⇒ aucun accusé, jamais un
 * accusé « au cas où »).
 */
export function ackFallbackText(tool: string, index = 0): string | undefined {
  const texts = ACK_FALLBACK_TEXTS[tool];
  if (!texts || texts.length === 0) return undefined;
  const safe = Number.isFinite(index) ? Math.trunc(index) : 0;
  const position = ((safe % texts.length) + texts.length) % texts.length;
  return texts[position];
}

/**
 * Libellé HISTORIQUE d'un outil (première variation). Sert uniquement à relire
 * une session écrite AVANT que l'accusé ne vienne du modèle (entrée `custom`
 * `yuki.run_ack` dont les données ne portent que le nom de l'outil).
 */
export function ackTextForTool(tool: string): string | undefined {
  return ackFallbackText(tool, 0);
}

/**
 * Normalise un texte candidat en accusé, ou renvoie `undefined` s'il n'en est
 * pas un : vide, PLUS LONG que `ACK_MAX_CHARS` (PIÈGE ⑥ : un pavé n'est pas un
 * accusé) ou réparti sur plusieurs lignes (une ligne de statut = une ligne).
 *
 * ⚠️ Aucune autre transformation : les mots du modèle sont conservés
 * verbatim (seuls les blancs de bord sont retirés).
 */
export function ackShapedText(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > ACK_MAX_CHARS) return undefined;
  if (/[\r\n]/.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Nom du PREMIER appel d'outil d'un message assistant qui déclenche un accusé.
 *
 * `content` est le contenu BRUT d'un message du SDK (tableau de blocs) : un appel
 * d'outil y est `{ type: "toolCall", name }`. Toute autre forme est ignorée.
 */
export function firstAckToolCall(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const record = block as Record<string, unknown>;
    if (record.type !== "toolCall") continue;
    const name = record.name;
    if (typeof name === "string" && isAckTool(name)) return name;
  }
  return undefined;
}

/**
 * CONSIGNE injectée au prompt système de CHAQUE tour (mécanisme non persisté :
 * voir `src/pi/sdk/ack-extension.ts`).
 *
 * ⚠️ Elle est BINDING et se lit comme un contrat : sans elle, le modèle appelle
 * l'outil sans rien dire et c'est le repli qui parle (mécanique, répétitif — le
 * défaut signalé par l'utilisateur).
 */
/**
 * Consigne de l'accusé, pour une LISTE D'OUTILS DONNÉE (source unique du texte).
 *
 * ⚠️ Le host LOCAL l'appelle avec `ACK_TOOLS` (tous ses déclencheurs) ; un run
 * DISTANT l'appelle avec SON allowlist (`run.tools()`), qui ne contient pas
 * `run_command`. La règle ne cite donc que des outils que le modèle possède
 * réellement — c'est la seule façon d'avoir UNE consigne et ZÉRO mensonge.
 *
 * ⚠️ AUCUN déclencheur disponible ⇒ consigne INVERSE (pas d'accusé du tout) :
 * sans action longue, une ligne de statut serait du bruit pur.
 */
export function ackRuleFor(tools: readonly string[] = ACK_TOOLS): string {
  const cites = ackToolsOf(tools);
  if (cites.length === 0) {
    return [
      "## Accusé de réception d'une action longue (règle STRICTE, non optionnelle)",
      "",
      "Aucune action longue n'est disponible dans cet échange : tu ne délègues rien,",
      "tu ne génères aucune image et tu ne lances aucune commande.",
      "- N'écris donc AUCUN préambule du type « je m'en occupe » ou « deux secondes » :",
      "  ta réponse est directement le fond.",
      "- Annonce l'INTENTION, jamais la promesse d'un résultat : « je m'en occupe » est",
      "  sûr ; « je te génère ça tout de suite » est un engagement qui peut échouer.",
      "- Une SEULE réponse, en français, sans formule de politesse creuse.",
    ].join("\n");
  }

  const liste = cites.map((tool) => `\`${tool}\``).join(", ");
  /**
   * ⚠️ DURÉE DITE QUAND ELLE EST CONNUE, JAMAIS DEVINÉE : `generer_image` porte une
   * borne DÉCLARÉE (`images.timeoutMs`, 180 s par défaut,
   * `src/config/schema.ts:899-905`). Sous `chat.remoteAgents = desactive`, l'appel
   * s'exécute DANS le tour (la borne du tour est relevée) : la personne du canal
   * doit donc savoir qu'elle attendra jusqu'à trois minutes — annoncé en même temps
   * que l'action, pas après.
   */
  const dureeImage = cites.includes("generer_image")
    ? [
        "- Une GÉNÉRATION D'IMAGE peut durer jusqu'à trois minutes (`images.timeoutMs`) :",
        "  quand tu la lances toi-même, DIS-LE dans ton accusé (« ça peut prendre jusqu'à",
        "  trois minutes »). Ce n'est pas une estimation : c'est la borne déclarée.",
      ]
    : [];
  return [
    "## Accusé de réception d'une action longue (règle STRICTE, non optionnelle)",
    "",
    `Quand tu t'apprêtes à lancer une action LONGUE (${liste}), ta réponse COMMENCE`,
    "par UNE phrase courte d'accusé de réception, puis tu appelles l'outil DANS LE MÊME TOUR.",
    `- Une SEULE phrase, moins de ${ACK_RULE_MAX_CHARS} caractères, en français, ton humain`,
    "  et VARIÉ : « Je m'en occupe. », « Deux secondes. », « Je lance ça. »,",
    "  « C'est parti. », « Je m'y mets. »",
    "- Ne répète pas la même formule d'un tour à l'autre : VARIE.",
    ...dureeImage,
    "- Annonce l'INTENTION, jamais la promesse d'un résultat : « je m'en occupe » est",
    "  sûr ; « je te génère ça tout de suite » est un engagement qui peut échouer.",
    "- Cette phrase est MUETTE à l'oral (la synthèse vocale ne la lit pas) et ce n'est",
    "  PAS la réponse : le fond vient ensuite, dans la même bulle.",
    "- Un AUTRE outil (lecture, recherche, fichiers) ne prend JAMAIS d'accusé : la",
    "  règle ne vaut que pour les outils cités ci-dessus.",
    "- Si tu appelles l'outil sans rien écrire, un accusé de repli est utilisé à ta",
    "  place : c'est correct, mais moins naturel.",
  ].join("\n");
}

/**
 * Consigne HISTORIQUE du host LOCAL : exactement `ackRuleFor(ACK_TOOLS)`.
 *
 * ⚠️ C'est une VALEUR DÉRIVÉE, pas une seconde constante : la source du texte est
 * `ackRuleFor`, ce qui interdit aux deux variantes (locale et distante) de diverger.
 */
export const ACK_RULE = ackRuleFor(ACK_TOOLS);
