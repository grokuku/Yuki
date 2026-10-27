/**
 * Bloc de prompt : la LISTE DES STYLES (workflows) proposée au modèle.
 *
 * ⚠️ Le style ne part JAMAIS dans le prompt envoyé à ComfyUI : il ne sert qu'à
 * CHOISIR le workflow. Ce bloc ne fait que DONNER le choix — il ne transporte
 * aucune image et ne déclenche aucun tour.
 *
 * Il est relu À CHAQUE TOUR (les workflows peuvent être importés à chaud) et
 * BORNÉ (nombre de workflows, longueur d'une description) : un graphe importé
 * avec une description fleuve ne peut pas noyer le prompt système.
 *
 * Module PUR (aucune I/O, aucun import SDK).
 */

import type { WorkflowCandidate } from "./selection.js";

/** Balise du bloc (DONNÉE encadrée, comme les autres injections). */
export const IMAGE_STYLES_TAG = "styles_image";
/** Nombre maximal de workflows listés dans le prompt. */
export const IMAGE_STYLES_PROMPT_MAX = 20;
/** Longueur maximale d'une description dans le prompt. */
export const IMAGE_STYLES_DESCRIPTION_MAX = 200;

/** Échappe le texte d'une description (jamais de balise fermante possible). */
function sanitize(text: string): string {
  return text
    .replace(/[<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, IMAGE_STYLES_DESCRIPTION_MAX);
}

/**
 * Compose le bloc à injecter, ou `null` s'il n'y a rien à annoncer (aucun
 * workflow importé, ou serveur non configuré).
 */
export function formatImageStylesBlock(
  candidates: readonly WorkflowCandidate[],
  options: { enabled: boolean },
): string | null {
  if (!options.enabled) return null;
  const bounded = [...candidates].slice(0, IMAGE_STYLES_PROMPT_MAX);
  if (bounded.length === 0) return null;
  const hasDefault = bounded.some((candidate) => candidate.isDefault);
  const lines = bounded.map((candidate) => {
    const description = sanitize(candidate.description);
    const suffix = candidate.isDefault ? " (par défaut)" : "";
    return `- ${candidate.name} — ${description}${suffix}`;
  });
  return [
    `<${IMAGE_STYLES_TAG}>`,
    "Workflows d'images disponibles pour `generer_image`. Le paramètre `style` sert",
    "UNIQUEMENT à choisir le PLUS PROCHE (par son libellé et sa description) ; si",
    "rien n'est précisé, choisis d'après la SCÈNE ; si rien ne correspond, c'est le",
    `workflow par défaut qui s'applique${hasDefault ? "" : " (aucun n'est marqué par défaut : l'outil le dira)"}.`,
    "⚠️ Le style ne doit JAMAIS être recopié dans `scene`, et le style retenu ne doit",
    "JAMAIS être annoncé à l'utilisateur.",
    ...lines,
    `</${IMAGE_STYLES_TAG}>`,
  ].join("\n");
}
