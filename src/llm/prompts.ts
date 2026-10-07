/**
 * Fragments de prompts (données pures, AUCUN import SDK/typebox).
 *
 * Les prompts effectifs vivent dans des fichiers de configuration
 * (`config/pi/system-prompt.md`, `config/pi/system-prompt-heavy.md`). Ce module
 * fournit des valeurs de repli et des marqueurs testables afin que le code et
 * la config ne divergent pas silencieusement.
 */

import { MUTE_BLOCK_LABEL } from "../tts/mute.js";

/**
 * Marqueurs canoniques. Un test vérifie que les fichiers de config les
 * contiennent : si quelqu'un les supprime, la garantie « le lourd ne parle pas
 * à l'utilisateur » deviendrait invisible.
 */

/** Le prompt léger DOIT décrire l'outil `delegate`. */
export const DELEGATION_MARKER = "delegate";

/** Le prompt lourd DOIT interdire de s'adresser à l'utilisateur final. */
export const HEAVY_NO_USER_MARKER = "NE T'ADRESSE JAMAIS À L'UTILISATEUR";

/** Prompt système du lourd, utilisé si le fichier est absent/vide. */
export const HEAVY_SYSTEM_PROMPT_FALLBACK = `# Yuki — worker lourd

Tu exécutes une tâche technique complexe en arrière-plan pour un autre agent.
Ta sortie est un RAPPORT INTERMÉDIAIRE destiné à être résumé, pas une réponse
utilisateur.

## Règles

- NE T'ADRESSE JAMAIS À L'UTILISATEUR : tu ne parles pas à l'utilisateur final.
- Produis un rapport factuel : ce que tu as trouvé, ce que tu as fait, les
  limites, et une conclusion actionnable.
- Tu ne disposes que d'outils de LECTURE (read, ls, grep, find) : n'annonce
  jamais avoir modifié ou exécuté quoi que ce soit.
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
