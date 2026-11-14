/**
 * PROMPT DU TOUR — la partie du prompt qui est RELUE À CHAQUE TOUR.
 *
 * ⚠️ LE BUG CORRIGÉ (2026-11-14, capture à l'appui) : le `systemPrompt` était
 * FIGÉ au démarrage du host. Le bot `grolaf` avait sa personnalité saisie, et il
 * répondait quand même « je suis là — Yuki » dans un canal : éditer la
 * personnalité, un prompt ou les règles n'avait AUCUN effet sans redémarrer.
 *
 * ⚠️ CE QUI CHANGE : identité, personnalité, prompt léger/lourd et liste d'outils
 * sont COMPOSÉS À CHAQUE TOUR par une extension (`src/pi/sdk/prompt-du-tour-
 * extension.ts`), à partir d'un port étroit (`PortPromptDuTour`). Le prompt du
 * host n'est plus qu'une valeur INITIALE (secours) : une modification prend effet
 * au MESSAGE SUIVANT, sans redémarrage.
 *
 * ⚠️ ORDRE DES BLOCS INCHANGÉ : identité → personnalité → prompt du rôle →
 * `<outils>`, puis la consigne de voix. Les consignes/faits s'insèrent après la
 * personnalité (`src/consignes/injection.ts`) et `<regles>` reste EN DERNIER
 * (extension suivante). Ce module ne fait qu'appeler le point d'assemblage unique
 * (`composerPromptSysteme`) : il n'invente aucun ordre.
 *
 * ⚠️ LECTURE FRAÎCHE, JAMAIS UN PROMPT VIDE : un échec de relecture (fichier
 * illisible, exception) n'échoue JAMAIS le tour — le port rend la DERNIÈRE
 * valeur connue et le journal le DIT.
 *
 * Aucun import SDK/typebox : données pures, testable sans SDK.
 */

import { appendVoiceInstruction } from "./prompts.js";
import { composerPromptSysteme, type RolePromptSysteme } from "./prompt-systeme.js";

/** Sources d'un prompt de tour, DÉJÀ LUES par l'appelant (aucune lecture ici). */
export interface SourcesPromptDuTour {
  /** Nom AFFICHÉ du bot (registre). Vide ⇒ aucun bloc d'identité (jamais inventé). */
  readonly nom?: string;
  /** Personnalité résolue (`prompts.personnalite`, sinon fichier, sinon défaut). */
  readonly personnalite?: string;
  /** Prompt du rôle (`prompts.light` ou `prompts.heavy`). */
  readonly prompt: string;
  /** Allowlist FINALE du bot (la même que sa politique d'outils). */
  readonly outils?: readonly string[];
  readonly role?: RolePromptSysteme;
  /**
   * Consigne de voix (`tts.enabled`). ⚠️ LUE AU DÉMARRAGE : `tts.enabled` reste un
   * réglage qui exige un redémarrage — la composition ne doit donc pas laisser
   * croire qu'elle suit à chaud.
   */
  readonly voix?: boolean;
}

/**
 * Compose le prompt de base du tour : le point d'assemblage unique
 * (`composerPromptSysteme`) plus la consigne de voix.
 */
export function promptDuTour(sources: SourcesPromptDuTour): string {
  const compose = composerPromptSysteme({
    ...(sources.nom !== undefined ? { nom: sources.nom } : {}),
    ...(sources.personnalite !== undefined ? { personnalite: sources.personnalite } : {}),
    prompt: sources.prompt,
    ...(sources.outils !== undefined ? { outils: sources.outils } : {}),
    ...(sources.role !== undefined ? { role: sources.role } : {}),
  });
  return appendVoiceInstruction(compose, sources.voix === true);
}

/**
 * PORT ÉTROIT du prompt du tour (implémentation : `src/bots/prompt-du-tour.ts`).
 *
 * ⚠️ Un port, pas un texte : c'est ce qui permet à l'extension de RELIRE les
 * sources à chaque tour sans connaître la configuration, le registre ni les
 * fichiers — et de ne jamais relire le registre complet pour autant.
 */
export interface PortPromptDuTour {
  /**
   * Prompt de base du tour, ou `""` si RIEN n'a jamais pu être composé (le host
   * garde alors son prompt d'origine). Un échec de relecture rend la DERNIÈRE
   * valeur connue, jamais un prompt vide.
   */
  lire(): string;
  /** Dernière valeur composée avec SUCCÈS (`undefined` avant la première). */
  derniereLue(): string | undefined;
}
