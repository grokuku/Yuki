/**
 * COMPOSITION DU PROMPT SYSTÈME — le point UNIQUE d'assemblage (défaut du
 * 2026-11-13).
 *
 * Un tour reçoit UN prompt système, mais il est fait de blocs de NATURES
 * DIFFÉRENTES, et c'est ce qui manquait :
 *
 *  1. **l'identité** — le NOM du bot, injecté depuis le registre. Un nom écrit
 *     en dur dans un prompt (« tu es Yuki ») est faux pour tout autre bot : même
 *     famille de bug que les replis vers le bot historique qu'on a retirés ;
 *  2. **la personnalité** — un bloc SÉPARÉ (`prompts.personnalite`), édité par
 *     l'utilisateur. La composer à part fait qu'éditer la personnalité ne touche
 *     JAMAIS le prompt système (ni la liste d'outils) ;
 *  3. **le prompt système** du rôle (`prompts.light` / `prompts.heavy`), éditable
 *     lui aussi : consignes d'exécution ;
 *  4. **la liste d'outils** — GÉNÉRÉE à chaque composition depuis
 *     l'`allowlistFinale` RÉELLE du bot (`toolAllowlist`/`toolAllowlistForChat`,
 *     `src/llm/tool-policy.ts`). Elle n'est donc jamais figée dans un texte : un
 *     outil ajouté apparaît, un outil retiré disparaît, sans réédition.
 *
 * ⚠️ ORDRE : identité, personnalité, prompt système, outils. Le prompt système
 * peut donc parler de « la personnalité » (avant lui) et du bloc `<outils>`
 * (après lui) sans ambiguïté.
 *
 * ⚠️ Aucun import SDK/typebox : données pures, testable sans SDK.
 */

/** Balise du bloc d'identité (nom du bot). */
export const IDENTITY_TAG = "identite";
/** Balise du bloc de personnalité (texte édité par l'utilisateur). */
export const PERSONALITY_TAG = "personnalite";
/** Balise du bloc d'outils (liste GÉNÉRÉE). */
export const TOOLS_TAG = "outils";

/**
 * PHRASE de chaque outil — ce que la liste générée annonce.
 *
 * ⚠️ Une phrase, pas seulement un nom : un nom seul n'apprend rien au modèle et
 * c'est la phrase qui décide de l'usage. ⚠️ Un outil AJOUTÉ sans phrase ne
 * disparaît pas pour autant : `phraseOutil` rend un repli explicite (voir
 * `PHRASE_OUTIL_INCONNU`), sinon un nouvel outil serait invisible — exactement le
 * défaut qu'on ferme.
 */
export const PHRASES_OUTILS: Readonly<Record<string, string>> = {
  // Lecture du volume de travail (builtins)
  read: "Lire le contenu d'un fichier du volume de travail.",
  ls: "Lister le contenu d'un dossier du volume de travail.",
  grep: "Chercher un motif dans les fichiers du volume de travail.",
  find: "Trouver des fichiers par leur nom dans le volume de travail.",
  // Délégation au worker lourd
  delegate:
    "Confier une tâche longue (ou toute action sur une machine) à un worker lourd, en arrière-plan.",
  job_status: "Consulter l'avancement d'un job délégué.",
  cancel_job: "Interrompre un job délégué.",
  steer_job: "Transmettre une consigne à un job déjà lancé, sans l'interrompre.",
  // Action sur les machines appairées (worker lourd)
  run_command: "Exécuter une commande shell sur une machine appairée.",
  capturer_ecran: "Prendre une capture d'écran d'une machine appairée.",
  // Annuaire et coffre
  lister_agents: "Lister les agents (machines appairées) accessibles.",
  etat_agent: "Donner l'état d'un agent appairé (en ligne, hors ligne).",
  lister_secrets: "Lister les NOMS des secrets du coffre (jamais les valeurs).",
  demander_secret:
    "Demander une valeur secrète à l'utilisateur par une fenêtre de saisie (la valeur ne passe jamais par toi).",
  // Archives et libraire
  archive_vie_anterieure: "Consulter l'archive « vie antérieure » (lecture seule).",
  chercher_conversations_archivees:
    "Chercher dans les conversations mises de côté (plein texte, lecture seule).",
  recherche_libraire: "Chercher dans la bibliothèque documentaire et sur le web.",
  liste_libraire: "Lister les documents disponibles dans le libraire.",
  lire_libraire: "Lire un document du libraire.",
  archive_libraire: "Faire archiver un document ou une page par le libraire.",
  lire_page_web: "Lire le TEXTE d'une page web (jamais une capture).",
  capture_libraire: "Capturer le rendu visuel d'une page web.",
  // Images
  generer_image: "Générer une image à partir d'une description (serveur ComfyUI).",
  consulter_workflow: "Lire les consignes d'écriture du workflow d'image retenu.",
  // Conversation et envois
  publier_dans_canal: "Publier un message (et des fichiers) dans un autre canal suivi.",
  envoyer_fichier: "Envoyer un fichier de la conversation à l'utilisateur.",
  envoyer_message: "Publier un message tout de suite, avant la fin de la réponse.",
  programmer_envoi: "Programmer un envoi ou un RAPPEL à une heure dite.",
  planifier_tache: "Planifier une tâche qui réveillera un agent plus tard.",
  // Fichiers des machines appairées
  recuperer_fichier: "Récupérer un fichier depuis une machine appairée.",
  deposer_fichier: "Déposer un fichier sur une machine appairée.",
  lister_fichiers: "Lister les pièces jointes de la conversation (identifiants compris).",
  lire_fichier: "Lire le contenu d'une pièce jointe.",
};

/** Phrase de repli d'un outil sans description enregistrée (jamais muet). */
export const PHRASE_OUTIL_INCONNU =
  "Outil disponible dont la description n'est pas encore enregistrée.";

/** Phrase d'un outil (repli explicite si sa description manque). */
export function phraseOutil(nom: string): string {
  return PHRASES_OUTILS[nom] ?? PHRASE_OUTIL_INCONNU;
}

/** Rôle du prompt : le léger converse, le lourd exécute. */
export type RolePromptSysteme = "light" | "heavy";

export interface CompositionPromptSysteme {
  /** Nom AFFICHÉ du bot (registre). Vide ⇒ aucun bloc d'identité (jamais inventé). */
  readonly nom?: string;
  /** Texte de personnalité (`prompts.personnalite`). Vide ⇒ aucun bloc. */
  readonly personnalite?: string;
  /** Prompt système du rôle (`prompts.light` / `prompts.heavy`). */
  readonly prompt: string;
  /**
   * Allowlist FINALE du bot. `undefined` ⇒ aucun bloc d'outils : un appelant qui
   * ne connaît pas la politique n'annonce RIEN plutôt que d'inventer une liste.
   */
  readonly outils?: readonly string[];
  readonly role?: RolePromptSysteme;
}

/** Compacte un texte pour comparer des contenus (retours à la ligne, casse). */
function normaliser(texte: string): string {
  return texte.replace(/\s+/gu, " ").trim().toLowerCase();
}

/**
 * La personnalité est-elle DÉJÀ dans le prompt système ?
 *
 * ⚠️ Cas réel : une configuration ENREGISTRÉE avant la séparation contient
 * encore le paragraphe de personnalité dans `prompts.light`. On ne le duplique
 * pas (le prompt composé ne doit pas dire deux fois la même chose) — et le
 * démarrage le SIGNALE (`avertirSiPromptsASurveiller`), jamais de réécriture
 * silencieuse du texte de l'utilisateur.
 */
export function personnaliteDejaDansPrompt(prompt: string, personnalite: string): boolean {
  const a = normaliser(personnalite);
  if (a === "") return false;
  return normaliser(prompt).includes(a);
}

/** Bloc d'identité : le nom du bot, UNE seule source. */
export function blocIdentite(nom: string | undefined): string {
  const valeur = (nom ?? "").trim();
  if (valeur === "") return "";
  return [`<${IDENTITY_TAG}>`, `Ton nom est ${valeur}.`, `</${IDENTITY_TAG}>`].join("\n");
}

/** Bloc de personnalité (vide ⇒ aucun bloc, jamais un bloc vide). */
export function blocPersonnalite(personnalite: string | undefined): string {
  const texte = (personnalite ?? "").trim();
  if (texte === "") return "";
  return [`<${PERSONALITY_TAG}>`, texte, `</${PERSONALITY_TAG}>`].join("\n");
}

/**
 * Bloc d'outils GÉNÉRÉ depuis une allowlist.
 *
 * ⚠️ Liste VIDE : on le DIT franchement (un prompt muet laisserait le modèle
 * inventer des capacités). Le bloc est identique dans sa forme quel que soit le
 * bot — seul son CONTENU suit l'allowlist.
 */
export function blocOutils(outils: readonly string[]): string {
  if (outils.length === 0) {
    return [
      `<${TOOLS_TAG}>`,
      "Aucun outil n'est ouvert pour ce bot : tu ne peux ni lire, ni exécuter, ni envoyer quoi que ce soit. Dis-le franchement si on te demande une action.",
      `</${TOOLS_TAG}>`,
    ].join("\n");
  }
  const lignes = [
    `<${TOOLS_TAG}>`,
    "Outils disponibles à ce tour (liste générée depuis les capacités réelles du bot) :",
    ...outils.map((nom) => `- \`${nom}\` — ${phraseOutil(nom)}`),
    "⚠️ N'annonce jamais un outil absent de cette liste.",
    `</${TOOLS_TAG}>`,
  ];
  return lignes.join("\n");
}

/**
 * Compose le prompt système d'un tour.
 *
 * Blocs NON VIDES joints par une ligne vide, dans l'ordre identité →
 * personnalité → prompt système → outils. La personnalité n'est PAS composée
 * pour le rôle lourd : le worker n'est pas le bot qui converse, sa personnalité
 * n'a rien à y faire.
 */
export function composerPromptSysteme(options: CompositionPromptSysteme): string {
  const blocs: string[] = [];
  const identite = blocIdentite(options.nom);
  if (identite !== "") blocs.push(identite);

  const role = options.role ?? "light";
  const personnalite = (options.personnalite ?? "").trim();
  const prompt = options.prompt ?? "";
  if (
    role !== "heavy" &&
    personnalite !== "" &&
    !personnaliteDejaDansPrompt(prompt, personnalite)
  ) {
    const bloc = blocPersonnalite(personnalite);
    if (bloc !== "") blocs.push(bloc);
  }

  const promptTexte = prompt.trim();
  if (promptTexte !== "") blocs.push(promptTexte);

  if (options.outils !== undefined) blocs.push(blocOutils(options.outils));

  return blocs.join("\n\n");
}
