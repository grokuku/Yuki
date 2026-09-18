/**
 * Fragments de prompts (données pures, AUCUN import SDK/typebox).
 *
 * Les prompts effectifs vivent dans des fichiers de configuration
 * (`config/pi/system-prompt.md`, `config/pi/system-prompt-heavy.md`). Ce module
 * fournit des valeurs de repli et des marqueurs testables afin que le code et
 * la config ne divergent pas silencieusement.
 */

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
