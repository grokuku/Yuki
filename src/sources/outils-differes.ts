/**
 * OUTILS D'UN RUN DIFFÉRÉ — le DIAGNOSTIC qui NOMME les outils manquants.
 *
 * ⚠️ LE DÉFAUT QUE CE MODULE FERME (2026-11-16, signalé par le bot lui-même) :
 * une tâche PLANIFIÉE (« relève les prix de ces trois pages ») s'est réveillée
 * **sans les outils du libraire** (`recherche_libraire`, `lire_page_web`), donc
 * elle n'a rien pu vérifier et a rendu un rapport d'échec. Deux conséquences,
 * toutes deux corrigées ici :
 *
 *  1. le RAPPORT disait seulement « la tâche de fond n'a pas abouti » — le
 *     modèle a dû DEVINER la cause. Un échec doit NOMMER l'outil manquant ;
 *  2. la tâche elle-même ne savait pas ce qui lui manquait : le CONTEXTE du job
 *     porte désormais la phrase, donc le worker DIT « je n'ai pas
 *     `recherche_libraire` » au lieu d'inventer un prix ou une panne.
 *
 * ⚠️ PÉRIMÈTRE VOLONTAIREMENT ÉTROIT : seuls les outils de VÉRIFICATION DU MONDE
 * EXTÉRIEUR (le libraire et la lecture d'une page web, `LIBRARIAN_TOOLS`) sont
 * diagnostiqués. Ce sont les seuls dont l'absence produit un échec SILENCIEUX
 * et trompeur (« la page est inaccessible », « le prix n'est pas affiché »). Un
 * rapport qui listerait les vingt autres outils du profil lourd noierait la
 * cause au lieu de la nommer.
 *
 * ⚠️ AUCUNE ALLOWLIST N'EST FIGÉE ICI : l'appelant passe la liste RÉELLE du run
 * différé, calculée AU MOMENT DE L'EXÉCUTION (`toolAllowlist("light"|"heavy", …)`
 * côté câblage). Une capacité ajoutée au bot profite donc à la tâche SUIVANTE,
 * y compris pour une tâche créée avant cet ajout.
 *
 * Aucun import SDK/typebox.
 */

import type { CapaciteBot } from "../bots/registry.js";
import { LIBRARIAN_TOOLS, capaciteDeLOutil } from "../llm/tool-policy.js";

/**
 * Outils dont l'absence empêche une tâche de VÉRIFIER quoi que ce soit.
 *
 * ⚠️ La capture (`capture_libraire`) n'y figure pas : elle sert à vérifier un
 * RENDU, jamais à lire un fait, et elle n'appartient qu'au rôle léger.
 */
export const OUTILS_DE_VERIFICATION: readonly string[] = [...LIBRARIAN_TOOLS];

/** Diagnostic des outils de vérification d'un run différé. */
export interface DiagnosticOutilsDifferes {
  /** Outils de vérification ABSENTS de l'allowlist réelle du run. */
  readonly manquants: readonly string[];
  /** Capacités correspondantes (`libraire`, `web`), dans l'ordre de découverte. */
  readonly capacites: readonly CapaciteBot[];
  /**
   * Phrase française prête à publier/journaliser, ou `undefined` quand le run a
   * tous ses outils (aucun bruit dans un cas normal).
   */
  readonly phrase?: string;
}

/**
 * Diagnostic des outils de VÉRIFICATION d'un run différé.
 *
 * @param exposes  allowlist RÉELLE du run (celle que le worker va recevoir).
 * @param botId    propriétaire du run — NOMMÉ dans la phrase (on ne dit jamais
 *                 « le bot » sans dire lequel : c'est lui qu'il faut corriger).
 */
export function diagnostiquerOutilsDifferes(
  exposes: readonly string[],
  botId: string | undefined,
): DiagnosticOutilsDifferes {
  const presents = new Set(exposes);
  const manquants = OUTILS_DE_VERIFICATION.filter((outil) => !presents.has(outil));
  if (manquants.length === 0) return { manquants: [], capacites: [] };
  const capacites: CapaciteBot[] = [];
  for (const outil of manquants) {
    const capacite = capaciteDeLOutil(outil);
    if (capacite !== undefined && !capacites.includes(capacite)) capacites.push(capacite);
  }
  const bot = botId !== undefined && botId !== "" ? `le bot « ${botId} »` : "ce bot";
  const capaciteTexte =
    capacites.length === 0
      ? "la capacité du libraire"
      : capacites.length === 1
        ? `la capacité « ${capacites[0]} »`
        : `les capacités ${capacites.map((c) => `« ${c} »`).join(" / ")}`;
  const phrase =
    `Outils manquants : ${manquants.join(", ")} — ${bot} n'a pas (ou plus) ` +
    `${capaciteTexte}, ou le libraire n'est pas configuré (` + "`librarian.baseUrl`). " +
    "Rien n'a pu être vérifié en ligne : ce n'est PAS une panne du site consulté.";
  return { manquants, capacites, phrase };
}

/**
 * Bloc ajouté au CONTEXTE du job différé (donc lu par le worker).
 *
 * ⚠️ Il est écrit AVANT l'exécution : le modèle sait ce qu'il n'a pas, il ne
 * peut donc pas présenter une absence d'outil comme un fait observé sur le web.
 * `undefined` quand tout est là — un contexte qui parle d'outils absents alors
 * que tout va bien serait du bruit dans chaque tâche.
 */
export function blocOutilsManquants(diagnostic: DiagnosticOutilsDifferes): string | undefined {
  if (diagnostic.phrase === undefined) return undefined;
  return (
    "⚠️ OUTILS ABSENTS DE CETTE EXÉCUTION DIFFÉRÉE :\n" +
    `${diagnostic.phrase}\n` +
    "Si la demande exige de vérifier une page ou une source en ligne, réponds " +
    "EXACTEMENT ce qui manque (le nom des outils ci-dessus) et n'invente AUCUNE valeur."
  );
}

/**
 * Suffixe de raison d'échec (« … · Outils manquants : … »).
 *
 * ⚠️ Il s'ajoute aux raisons GÉNÉRIQUES (« la tâche de fond n'a pas abouti ») :
 * sans lui, la personne — et le bot lui-même — doivent deviner pourquoi la tâche
 * n'a rien pu faire.
 */
export function suffixeOutilsManquants(
  diagnostic: DiagnosticOutilsDifferes | undefined,
): string {
  if (diagnostic?.phrase === undefined) return "";
  return ` ${diagnostic.phrase}`;
}
