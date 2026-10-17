/**
 * Rapport SYNTHÉTIQUE « secret enregistré » renvoyé AU MODÈLE (extension).
 *
 * ⚠️ Pourquoi ce module existe : l'outil `demander_secret` rend la main avec
 * `awaiting_secret` — l'humain saisit ensuite la valeur dans la fenêtre. Le
 * MODÈLE, lui, n'a aucun retour : son appel est terminé et il ne saurait jamais
 * que le secret est désormais disponible. Ce module construit le prompt
 * SYNTHÉTIQUE qui le réveille une fois la valeur rangée au coffre, **corrélé par
 * `request_id`**.
 *
 * ⚠️ Le prompt est SYNTHÉTIQUE : préfixé par `SECRET_STORED_HEADER`, il est EXCLU
 * du transcript de l'UI, du snapshot, du rejeu et de la mémoire (voir
 * `src/pi/synthetic.ts`). Il ne porte JAMAIS une valeur — seulement les NOMS.
 *
 * ⚠️ Aucun import SDK/typebox : module PUR.
 */

import { escapeOutputText } from "./output.js";

/**
 * En-tête du prompt synthétique. C'est AUSSI le préfixe reconnu par le filtre
 * des messages utilisateur synthétiques (`isSyntheticUserText`) : le prompt
 * commence EXACTEMENT par cette chaîne.
 */
export const SECRET_STORED_HEADER = "[SECRET ENREGISTRÉ]";

/**
 * Origine marquant ce prompt comme SYNTHÉTIQUE (jamais une bulle utilisateur).
 * Distincte de la trame WS `approval_result` : ici c'est une origine de run.
 */
export const ORIGIN_SECRET_STORED = "secret_stored";

/** Entrée du rapport (aucune donnée secrète ici). */
export interface SecretStoredInput {
  /** Identifiant de la demande, pour la CORRÉLATION. */
  requestId: string;
  /** Noms enregistrés (jamais les valeurs). */
  names: string[];
  /** « À quoi ça sert » (facultatif). */
  purpose?: string;
  /** Machine concernée (facultatif). */
  agentName?: string;
}

/**
 * Construit le prompt synthétique de confirmation. Ne contient QUE des NOMS et
 * un texte d'usage : aucune valeur ne peut y entrer (elle n'est pas passée).
 */
export function buildSecretStoredPrompt(input: SecretStoredInput): string {
  const lines = [
    SECRET_STORED_HEADER,
    "",
    "L'utilisateur a fourni les secrets demandés. Ils sont ENREGISTRÉS dans le " +
      "coffre chiffré de Yuki ; tu ne vois JAMAIS leur valeur.",
    "",
    "Secrets disponibles :",
  ];
  for (const name of input.names) lines.push(`- ${escapeOutputText(name)}`);
  if (input.agentName !== undefined && input.agentName.trim() !== "") {
    lines.push("", `Machine concernée : ${escapeOutputText(input.agentName.trim())}`);
  }
  if (input.purpose !== undefined && input.purpose.trim() !== "") {
    lines.push(`Raison : ${escapeOutputText(input.purpose.trim())}`);
  }
  lines.push(
    "",
    "Tu peux POURSUIVRE le travail : référence ces secrets par `${NOM}` dans une " +
      "commande `run_command` — leur valeur sera fournie par variable " +
      "d'environnement. ⚠️ Ne demande plus leur valeur et n'affirme pas la connaître.",
  );
  return lines.join("\n");
}
