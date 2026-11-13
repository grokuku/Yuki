/**
 * Fragments de prompts (données pures, AUCUN import SDK/typebox).
 *
 * Les prompts effectifs vivent dans des fichiers de configuration
 * (`config/pi/system-prompt.md`, `config/pi/system-prompt-heavy.md`). Ce module
 * fournit des valeurs de repli et des marqueurs testables afin que le code et
 * la config ne divergent pas silencieusement.
 */

import { MUTE_BLOCK_LABEL } from "../tts/mute.js";
import { personnaliteDejaDansPrompt } from "./prompt-systeme.js";

/**
 * Marqueurs canoniques. Un test vérifie que les fichiers de config les
 * contiennent : si quelqu'un les supprime, la garantie « le lourd ne parle pas
 * à l'utilisateur » deviendrait invisible.
 */

/** Le prompt léger DOIT décrire l'outil `delegate`. */
export const DELEGATION_MARKER = "delegate";

/** Le prompt lourd DOIT interdire de s'adresser à l'utilisateur final. */
export const HEAVY_NO_USER_MARKER = "NE T'ADRESSE JAMAIS À L'UTILISATEUR";

/**
 * Le prompt LÉGER DOIT décrire la DEMANDE de secret (`demander_secret`) : c'est
 * ce qui fait que Yuki SAIT qu'elle peut afficher une fenêtre pour réclamer une
 * valeur. Sans ce marqueur, elle répondrait « non » (bug utilisateur).
 */
export const SECRET_REQUEST_MARKER = "demander_secret";

/** Le prompt LOURD DOIT décrire le flux sur référence manquante (`awaiting_secret`). */
export const HEAVY_SECRET_MARKER = "awaiting_secret";

/**
 * Le prompt LÉGER DOIT décrire l'ENVOI PROGRAMMÉ (`programmer_envoi`).
 *
 * ⚠️ Sans ce marqueur, Yuki affirme une incapacité qui est FAUSSE (« je n'ai pas de
 * minuteur, je ne peux pas programmer de rappel ») alors que l'outil est dans sa liste
 * — panne de production du 2026-11-04 : la même personne a vu, dans la même heure, un
 * refus sur l'interface web et un message publié à l'heure dite sur Mattermost.
 */
export const SCHEDULED_SEND_MARKER = "programmer_envoi";

/**
 * ⚠️ Le prompt LÉGER doit aussi rattacher le RAPPEL à cet outil (« rappelle-moi dans
 * 3 heures » est un envoi programmé). C'est la formulation réellement employée par la
 * personne — et celle sur laquelle Yuki a répondu « je ne peux pas programmer de
 * rappel, point final ».
 */
export const SCHEDULED_SEND_REMINDER_MARKER = "rappelle-moi";

/**
 * Le prompt effectif est-il PRIVÉ de la consigne d'envoi programmé ?
 *
 * ⚠️ `prompts.light` est ÉDITABLE dans Configuration et sa valeur ENREGISTRÉE l'emporte
 * sur le fichier livré (`src/config/runtime.ts`, défaut lu depuis
 * `config/pi/system-prompt.md`) : un prompt sauvegardé avant l'ajout de l'outil garde
 * donc l'ancienne consigne, et le modèle suit la plus ancienne. On le SIGNALE au
 * démarrage (jamais de réécriture silencieuse du texte de l'utilisateur).
 */
export function consigneEnvoiProgrammeAbsente(prompt: string): boolean {
  return prompt.trim() !== "" && !prompt.includes(SCHEDULED_SEND_MARKER);
}

/**
 * Le prompt effectif est-il VIDE ?
 *
 * ⚠️ Un prompt vide n'est pas « le défaut » : c'est un modèle SANS AUCUNE
 * consigne. Le gateway refuse `""` (`empty_value`, `src/config/schema.ts`) et
 * l'UI refuse d'enregistrer un champ vidé, mais le cas reste atteignable si le
 * FICHIER LIVRÉ est absent ou vide (`readTextFile` rend `""`,
 * `src/config/runtime.ts`) : on le SIGNALE au démarrage au lieu de laisser le
 * comportement se dégrader en silence.
 */
export function promptVide(prompt: string): boolean {
  return prompt.trim() === "";
}

/**
 * Diagnostic ACTIONNABLE du prompt léger effectif : ce qui manque, et quoi faire.
 *
 * `null` = rien à signaler. Les deux cas connus :
 *  - `"vide"` : aucune consigne du tout ;
 *  - `"sans_envoi_programme"` : prompt enregistré qui CONTREDIT une capacité
 *    réelle (`programmer_envoi`) — le modèle nie savoir programmer un envoi.
 */
export type PromptLegerDiagnostic = "vide" | "sans_envoi_programme" | null;

export function diagnostiquerPromptLeger(prompt: string): PromptLegerDiagnostic {
  if (promptVide(prompt)) return "vide";
  if (consigneEnvoiProgrammeAbsente(prompt)) return "sans_envoi_programme";
  return null;
}

/**
 * Prompt système du lourd, utilisé si le fichier est absent/vide.
 *
 * ⚠️ Deux règles de forme, les mêmes que les fichiers livrés : AUCUN nom de bot
 * en dur (`<identite>` est injecté à la composition) et AUCUNE liste d'outils
 * figée (le bloc `<outils>` est GÉNÉRÉ depuis l'allowlist réelle).
 */
export const HEAVY_SYSTEM_PROMPT_FALLBACK = `# Worker lourd (arrière-plan)

Tu exécutes une tâche technique complexe en arrière-plan pour l'agent qui t'a
délégué la tâche. Ta sortie est un RAPPORT INTERMÉDIAIRE destiné à être résumé,
pas une réponse utilisateur.

## Règles

- NE T'ADRESSE JAMAIS À L'UTILISATEUR : tu ne parles pas à l'utilisateur final.
- Les outils disponibles à ce tour figurent dans le bloc \`<outils>\` de ce prompt :
  c'est lui qui fait foi, et il est régénéré à chaque tour. N'annonce jamais
  avoir modifié ou exécuté quoi que ce soit que le résultat ne confirme.
- Produis un rapport factuel : ce que tu as trouvé, ce que tu as fait, les
  limites, et une conclusion actionnable.
- Si la tâche est impossible ou ambiguë, explique-le explicitement dans le
  rapport plutôt que d'inventer.
- N'expose pas ta réflexion : seule la conclusion compte.
`;

/**
 * Consigne de délégation du léger. Documentaire : la version effective est
 * intégrée à `config/pi/system-prompt.md`.
 */
export const DELEGATION_INSTRUCTION = `Pour les tâches longues ou complexes
(recherches approfondies, analyses multi-étapes), tu peux confier le travail au
worker lourd en arrière-plan avec l'outil \`delegate\`. Le worker ne parle jamais
directement à l'utilisateur : il te rend un rapport que tu résumes. Utilise
\`job_status\` pour suivre un job et \`cancel_job\` pour l'interrompre.`;

/**
 * Bloc d'instruction ajouté au prompt système **léger** quand la voix est
 * active (`tts.enabled === "on"`). Il rappelle la convention du chat oral :
 * la réponse est **entendue**, mais elle doit **d'abord être écrite** — un
 * texte visible et complet, que l'on peut aussi lire à l'écran.
 *
 * ⚠️ **Historique (bug production)** : la version initiale se contentait de
 * « Ta réponse sera lue à voix haute » et décrivait surtout ce qui va dans le
 * bloc `muet`. Certains modèles en ont déduit qu'ils devaient **tout** mettre
 * dans le bloc muet (ou ne produire aucun texte) : la réponse devenait alors
 * **vide à l'écran** ET **muette**, alors que `TTFT`/tokens et la réflexion
 * fonctionnaient. Le texte ci-dessous pose donc UN invariant non ambigu : la
 * réponse est un texte visible ; le bloc muet est un **complément facultatif**,
 * jamais un substitut.
 *
 * ⚠️ Le filtre (`src/tts/markdown.ts`) et ce texte lisent la **même**
 * constante `MUTE_BLOCK_LABEL` : ils ne peuvent pas diverger.
 * ⚠️ Le bloc n'est JAMAIS ajouté quand la voix est inactive : le prompt reste
 * exactement celui fourni par l'utilisateur (voir `appendVoiceInstruction`).
 */
export const VOICE_SPEECH_INSTRUCTION = [
  "## Réponse parlée",
  "",
  "Ta réponse est lue à voix haute : l'utilisateur l'écoute. Cela ne change pas ce que tu dois dire.",
  "- Réponds TOUJOURS par un texte visible, complet et utile — c'est le cœur de ta réponse, à l'écran comme à l'oreille.",
  "- Écris des phrases naturelles, comme à l'oral.",
  "- Tout ce qui compte doit être dit avec des mots : commente naturellement ce que montre un tableau ou une image.",
  `- Le bloc « ${MUTE_BLOCK_LABEL} » (\`\`\`${MUTE_BLOCK_LABEL}) est un COMPLÉMENT facultatif, réservé aux annexes mal lues (tableau, données brutes, code) : il ne remplace JAMAIS la réponse.`,
  "- Ne place jamais la réponse entière dans un bloc muet, et ne renvoie jamais une réponse sans texte : elle serait vide à l'écran comme à l'oreille.",
].join("\n");

/**
 * Renvoie le prompt système à appliquer : le prompt fourni, éventuellement suivi
 * de `VOICE_SPEECH_INSTRUCTION` **si et seulement si** la voix est active.
 * Quand la voix est inactive, le prompt est renvoyé **inchangé** (identité).
 */
export function appendVoiceInstruction(
  systemPrompt: string,
  voiceEnabled: boolean,
): string {
  if (!voiceEnabled) return systemPrompt;
  const base = systemPrompt.trimEnd();
  return base.length > 0
    ? `${base}\n\n${VOICE_SPEECH_INSTRUCTION}`
    : VOICE_SPEECH_INSTRUCTION;
}

/** Journal minimal accepté par `avertirSiPromptLegerIncomplet` (testable sans logger). */
export interface PromptWarnerLike {
  warn(message: string, fields?: Record<string, unknown>): void;
}

/** Remède affiché dans l'avertissement : où cliquer, en français. */
export const PROMPT_LIGHT_RESET_HINT =
  "Bot · Personnalité → Prompt système — léger → « Réinitialiser au défaut »";

/**
 * Signale au DÉMARRAGE que le prompt léger effectif est inutilisable ou qu'il
 * CONTREDIT une capacité réelle. **Aucune réécriture** du texte de l'utilisateur :
 * on se contente de dire quoi faire (un avertissement sans action est du bruit).
 *
 * @param origine `config.originOf("prompts.light")` : `default` | `store` | `env`.
 * @returns le diagnostic émis (`null` = rien à signaler).
 */
export function avertirSiPromptLegerIncomplet(
  logger: PromptWarnerLike,
  prompt: string,
  origine: string,
): PromptLegerDiagnostic {
  const diagnostic = diagnostiquerPromptLeger(prompt);
  if (diagnostic === "vide") {
    logger.warn("pi.prompt.vide", {
      champ: "prompts.light",
      origine,
      consequence:
        "le modèle tourne SANS AUCUNE consigne (ni identité, ni outils, ni capacité d'envoi programmé)",
      action: `restaurer le prompt livré (${PROMPT_LIGHT_RESET_HINT}) puis vérifier que config/pi/system-prompt.md existe et n'est pas vide`,
    });
    return diagnostic;
  }
  if (diagnostic === "sans_envoi_programme") {
    logger.warn("pi.prompt.envois_programmes_absents", {
      champ: "prompts.light",
      origine,
      reference: "config/pi/system-prompt.md",
      consequence: "le modèle peut nier savoir programmer un envoi ou un rappel",
      action: `réinitialiser au défaut (${PROMPT_LIGHT_RESET_HINT}), ou ajouter la consigne « ${SCHEDULED_SEND_MARKER} » au prompt personnalisé`,
    });
    return diagnostic;
  }
  return null;
}

/**
 * Nom HISTORIQUE du bot de la disposition mono-bot.
 *
 * ⚠️ Sert UNIQUEMENT à la DÉTECTION : un prompt enregistré qui nomme encore le
 * bot en dur (« tu es Yuki ») est FAUX pour tout autre bot, et il est signalé au
 * démarrage. Ce nom n'est JAMAIS injecté : l'identité vient du registre, dans un
 * bloc dédié (`<identite>`, `src/llm/prompt-systeme.ts`).
 *
 * ⚠️ Comparaison SENSIBLE À LA CASSE : `YUKI_SECRET_NAS` (une référence de
 * secret, légitime) ne doit pas déclencher l'avertissement.
 */
export const NOM_HISTORIQUE_EN_DUR = "Yuki";

/** Le texte nomme-t-il le bot en dur ? (détection, jamais une réécriture) */
export function promptNommeEnDur(
  texte: string,
  nom: string = NOM_HISTORIQUE_EN_DUR,
): boolean {
  return texte.includes(nom);
}

/** Les trois textes effectifs du prompt système (clés `mixte`, surcharge par bot). */
export interface PromptsEffectifs {
  readonly personnalite: string;
  readonly light: string;
  readonly heavy: string;
}

/** Origine de chaque texte (`config.originOf(…)`). */
export interface OriginesPrompts {
  readonly personnalite: string;
  readonly light: string;
  readonly heavy: string;
}

/**
 * Signale au DÉMARRAGE les prompts à surveiller — **aucune réécriture** du texte
 * de l'utilisateur, seulement un diagnostic actionnable :
 *
 *  1. **nom en dur** : le texte nomme encore le bot (`NOM_HISTORIQUE_EN_DUR`). Un
 *     prompt stocké avant la composition par blocs le fait, et il mentirait sur
 *     tout autre bot ;
 *  2. **personnalité dupliquée** : la personnalité est DÉJÀ dans `prompts.light`
 *     (configuration enregistrée avant la séparation). Elle n'est alors pas
 *     composée une seconde fois (`personnaliteDejaDansPrompt`) — on le dit, sinon
 *     l'utilisateur croirait que son champ Personnalité est ignoré.
 *
 * @param bot identifiant du bot concerné (mode multi-bot), omis pour la pile.
 * @returns les champs signalés (tableau vide = rien à signaler).
 */
export function avertirSiPromptsASurveiller(
  logger: PromptWarnerLike,
  prompts: PromptsEffectifs,
  origines: OriginesPrompts,
  bot?: string,
): string[] {
  const signales: string[] = [];
  const champs: ReadonlyArray<[keyof PromptsEffectifs, string]> = [
    ["personnalite", "prompts.personnalite"],
    ["light", "prompts.light"],
    ["heavy", "prompts.heavy"],
  ];
  for (const [cle, champ] of champs) {
    if (!promptNommeEnDur(prompts[cle])) continue;
    signales.push(champ);
    logger.warn("pi.prompt.nom_en_dur", {
      ...(bot !== undefined ? { bot } : {}),
      champ,
      origine: origines[cle],
      nom: NOM_HISTORIQUE_EN_DUR,
      consequence:
        "le prompt nomme le bot en dur ; il est faux pour tout autre bot (le nom est injecté depuis le registre)",
      action: `retirer « ${NOM_HISTORIQUE_EN_DUR} » de ce texte : le nom réel est fourni par la composition (bloc <identite>), ou cliquer sur « Réinitialiser au défaut »`,
    });
  }
  if (personnaliteDejaDansPrompt(prompts.light, prompts.personnalite)) {
    signales.push("prompts.light");
    logger.warn("pi.prompt.personnalite_dupliquee", {
      ...(bot !== undefined ? { bot } : {}),
      champ: "prompts.light",
      origine: origines.light,
      origine_personnalite: origines.personnalite,
      consequence:
        "la personnalité est déjà dans le prompt système : elle n'est PAS composée une seconde fois (aucun doublon silencieux)",
      action: `retirer ce paragraphe de « Prompt système — léger » (il vit dans le champ « Personnalité », ${PROMPT_LIGHT_RESET_HINT})`,
    });
  }
  return signales;
}

/**
 * PERSONNALITÉ de repli, utilisée si `config/pi/personnalite.md` est
 * absent/illisible (même rôle que `HEAVY_SYSTEM_PROMPT_FALLBACK`).
 *
 * ⚠️ Aucun nom de bot : l'identité est injectée à la composition
 * (`<identite>`, `src/llm/prompt-systeme.ts`), et aucune liste d'outils n'y est
 * figée non plus.
 */
export const PERSONNALITE_FALLBACK = `Tu es un assistant conversationnel généraliste. Tu aides avec des questions, des
explications, de la rédaction, de la synthèse et de la réflexion — pas uniquement
avec du code.

## Comportement

- Réponds dans la langue de l'utilisateur.
- Sois clair, direct et utile. Va à l'essentiel sans être sec.
- Si une question est ambiguë, pose une question de clarification courte.
- Si tu ne sais pas, dis-le. N'invente pas de faits, de sources ni de résultats.
- N'expose pas ta réflexion interne comme réponse : seule la réponse finale est
  destinée à l'utilisateur.
`;
