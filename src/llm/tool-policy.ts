/**
 * Politique d'outils par modèle (données pures, AUCUN import SDK/typebox).
 *
 * GARANTIE STRUCTURELLE — pas une consigne : à aucun moment les modèles ne
 * reçoivent d'outil d'écriture (`write`, `edit`) ni d'exécution LOCALE (`bash`,
 * `powershell`). Le sidecar isolé n'existe qu'au Lot 4 ; il ne faut donc
 * AUCUN outil d'exécution locale. Le lourd ne peut pas redéléguer.
 *
 * ⚠️ INVERSION DES RÔLES (2026-10-13) : **Yuki (léger) LIT et CONVERSE, le
 * worker LOURD EXÉCUTE** (comme Pi-Web). Les outils qui AGISSENT sur une machine
 * appairée (`run_command`, `capturer_ecran`) sont donc portés par le rôle
 * `heavy` ; le rôle `light` garde la lecture, la conversation, la délégation, la
 * consultation (annuaire, archive) et le libraire.
 *
 * La table est extensible par simple ajout d'entrées aux lots 4/5.
 */

import type { CapaciteBot } from "../bots/registry.js";
import type { LlmRole } from "./providers.js";

/** Outils builtins exposables (lecture seule au Lot 2). */
export type BuiltinToolName = "read" | "ls" | "grep" | "find";

/** Outils custom de délégation (fournis au léger uniquement). */
export type DelegateToolName =
  | "delegate"
  | "job_status"
  | "cancel_job"
  | "steer_job";

/**
 * Outils custom d'EXÉCUTION déléguée (Lot 4, B6bis). `run_command` permet au
 * modèle de lancer une commande sur un AGENT APPAIRÉ — jamais sur la machine de
 * Yuki. Le garde-fou (D118) s'applique côté agent, dans Yuki, AVANT l'envoi.
 */
export type ExecutionToolName = "run_command";

/**
 * Outil custom de CAPTURE D'ÉCRAN par l'agent (Lot 4, extension).
 * `capturer_ecran` demande une capture à une machine appairée ; l'image est
 * affichée à l'HUMAIN dans la conversation, jamais renvoyée au modèle (qui ne
 * reçoit que des métadonnées). Même garde-fou par agent que `run_command`.
 */
export type ScreenshotToolName = "capturer_ecran";

/**
 * Outils custom de CONSULTATION des agents appairés (Lot 4, extension).
 * `lister_agents` et `etat_agent` sont en **LECTURE SEULE** : ils n'exécutent ni
 * ne modifient rien. Activables indépendamment des outils d'exécution.
 */
export type AgentDirectoryToolName = "lister_agents" | "etat_agent";

/**
 * Outil custom de CONSULTATION des secrets du coffre. `lister_secrets` n'expose
 * que les NOMS (jamais une valeur) : il permet au modèle de savoir QUELLES
 * variables `${YUKI_SECRET_…}` référencer dans `run_command`.
 */
export type SecretToolName = "lister_secrets" | "demander_secret";

/**
 * Outils de CONSULTATION des secrets du coffre (NOMS seulement, jamais une
 * valeur) : `lister_secrets`. Exposés aux DEUX rôles (le lourd doit connaître
 * les NOMS pour écrire `${NOM}` dans ses commandes).
 */
export const SECRET_DIRECTORY_TOOLS: readonly SecretToolName[] = ["lister_secrets"];

/**
 * Outil de DEMANDE de secret par le modèle : `demander_secret` ouvre une fenêtre
 * de saisie DANS la conversation (la valeur va du navigateur au serveur, jamais
 * par le modèle). Porté par le LÉGER uniquement — c'est lui qui CONVERSE avec
 * l'utilisateur ; le lourd, lui, obtient un secret en référençant `${NOM}` dans
 * une commande (flux sur référence manquante).
 */
export const SECRET_REQUEST_TOOLS: readonly SecretToolName[] = ["demander_secret"];

/**
 * Outils custom de CONSULTATION de l'archive « vie antérieure » (Lot 13).
 * `archive_vie_anterieure` est en **LECTURE SEULE** : l'archive est séparée de la
 * mémoire courante et n'est jamais fusionnée. Activée indépendamment de tout le
 * reste (consulter n'est pas exécuter ni mémoriser).
 */
export type HeritageToolName = "archive_vie_anterieure";

/**
 * Outil custom de RECHERCHE dans l'archive des conversations MISES DE CÔTÉ.
 * `chercher_conversations_archivees` est en **LECTURE SEULE**, PLEIN TEXTE (FTS5) :
 * l'archive est séparée de la mémoire courante, jamais injectée, et consultée
 * uniquement sur demande EXPLICITE de l'utilisateur.
 */
export type ConversationArchiveToolName = "chercher_conversations_archivees";

/**
 * Outils custom du LIBRAIRE de Pi-Web (recherche documentaire + web). Les trois
 * premiers sont en LECTURE SEULE (`recherche_libraire`, `liste_libraire`,
 * `lire_libraire`) ; `archive_libraire` SOUMET un travail de fond (rend la main
 * immédiatement). ⚠️ AUCUN outil de fetch web générique : tout passe par le
 * libraire.
 */
export type LibrarianToolName =
  | "recherche_libraire"
  | "liste_libraire"
  | "lire_libraire"
  | "archive_libraire"
  | "lire_page_web"
  | "capture_libraire";

/**
 * Outils d'IMAGE portés par le LÉGER : `generer_image` (génération via
 * ComfyUI) et `consulter_workflow` (CONSIGNES D'ÉCRITURE du workflow retenu —
 * gratuit, instantané, aucun appel modèle).
 */
export type ImageToolName = "generer_image" | "consulter_workflow";

/**
 * Outil custom de PUBLICATION dans un AUTRE canal (`publier_dans_canal`).
 *
 * ⚠️ DÉCISION A (utilisateur, 2026-11-02) : l'outil existe, mais il est RESTREINT côté
 * serveur aux canaux SUIVIS (`chat-mirror.json`) et à la plateforme du run. Il ne touche
 * à aucune machine — publier un message n'exige donc AUCUNE approbation, ce qui le rend
 * utilisable dans un canal distant (contrairement à `run_command` :
 * `APPROVAL_REQUIRED_TOOLS`).
 */
export type ChannelPostToolName = "publier_dans_canal";

/**
 * Outil custom d'ENVOI de fichier par Yuki (`envoyer_fichier`). Il ne touche à
 * aucune machine : il rend CLIQUABLE et TÉLÉCHARGEABLE un fichier DÉJÀ présent
 * dans la conversation (fichier reçu, ou fichier déposé pour l'utilisateur).
 * Porté par le LÉGER uniquement — c'est lui qui converse.
 */
export type FilesToolName = "envoyer_fichier";

/**
 * Outil custom d'ENVOI DE MESSAGE dans la conversation COURANTE (`envoyer_message`).
 *
 * ⚠️ RÉPONSE EN PLUSIEURS MESSAGES (demande utilisateur du 2026-11-04 : « PI jusqu'à
 * la 20ᵉ décimale, une décimale par message ») : chaque appel publie un message
 * PENDANT le tour, sans minuteur ni second tour. Il ne touche à aucune machine — il
 * ne demande donc AUCUNE approbation et ne dépend d'aucun réglage d'accès distant.
 *
 * ⚠️ Contrairement à `publier_dans_canal` (capacité des RUNS DE CANAL), celui-ci est
 * aussi un outil du LÉGER LOCAL : le fil « Déclencheurs » est une session locale
 * (`src/sources/service.ts`), et une réponse étalée y serait sinon impossible.
 */
export type MessageToolName = "envoyer_message";

/**
 * Outil custom de TÂCHE PLANIFIÉE (`planifier_tache`, lot 31).
 *
 * ⚠️ DISTINCT de `programmer_envoi` : là-bas un texte FIGÉ part à l'heure dite, ici un
 * LLM est RÉVEILLÉ pour AGIR (image, commande via un agent, recherche…) et son résultat
 * est publié. C'est la différence entre « poste ce message » et « débrouille-toi ».
 *
 * ⚠️ Porté par le LÉGER seul : c'est lui qui converse, donc lui qui reçoit la demande.
 * Le LOURD ne l'a pas (`planifierTaches: []`) — une tâche de fond ne programme pas de
 * tâche de fond (même anti-enchaînement que `delegate`).
 *
 * ⚠️ Il ne touche à AUCUNE machine MAINTENANT (le travail se fait à l'heure dite, dans un
 * worker qui a ses propres garde-fous) : il est donc dans le groupe `toujours`.
 */
export type PlanifierTacheToolName = "planifier_tache";

/**
 * Outil custom d'ENVOI PROGRAMMÉ (`programmer_envoi`, lot 28).
 *
 * ⚠️ « Poste cette image à 16h10 » n'était pas réalisable : Yuki a répondu en
 * production qu'elle n'avait « pas de minuteur » (2026-11-04). C'est vrai POUR LE
 * MODÈLE et faux pour le système — le planificateur existe (lot 2) et cet outil est
 * son unique porte d'entrée côté conversation.
 *
 * ⚠️ Il ne touche à AUCUNE machine et n'appelle AUCUN modèle à l'heure dite (le texte
 * est FIGÉ) : il est donc dans le groupe `toujours` et ne dépend d'aucun réglage
 * d'accès distant. Le LOURD ne l'a pas (`envoisProgrammes: []`) : programmer une
 * publication est un acte de RÉDACTEUR (invariant « un seul rédacteur »).
 */
export type EnvoiProgrammeToolName = "programmer_envoi";

/**
 * Outils custom de TRANSFERT DE FICHIERS vers/depuis une machine appairée
 * (capacité `files`). `recuperer_fichier` fait LIRE un fichier distant et le
 * dépose sur le DISQUE de Yuki ; `deposer_fichier` envoie un fichier de Yuki sur
 * la machine. ⚠️ Portés par le worker LOURD (c'est lui qui AGIT sur une machine)
 * et gardés par le MÊME garde-fou par agent que `run_command`. Capacité exigée
 * AVANT toute émission : un agent antérieur ignorerait les trames.
 */
export type FileTransferToolName = "recuperer_fichier" | "deposer_fichier";

/**
 * Outil de LISTAGE des pièces jointes d'une conversation (`lister_fichiers`),
 * en LECTURE SEULE : identifiant, nom, genre, taille, date. ⚠️ C'est le chaînon
 * manquant du worker lourd : `deposer_fichier` exige un IDENTIFIANT, et aucun
 * outil ne le rendait. Porté par le LOURD (celui qui agit) ; le léger, lui,
 * obtient les identifiants dans la liste de `envoyer_fichier`.
 */
export type FileListToolName = "lister_fichiers";

/**
 * Outil de LECTURE du CONTENU d'une pièce jointe (`lire_fichier`) : image ⇒
 * transmise au modèle (politique de vision partagée), texte ⇒ contenu décodé et
 * borné, binaire ⇒ refus. ⚠️ Porté par le LOURD seul : le léger reçoit déjà le
 * texte dans le bloc `<fichiers>` et les images en pièce jointe de son message —
 * lui ouvrir la lecture du store n'ajouterait qu'une surface, aucune capacité.
 * Le léger n'a d'ailleurs aucun outil de transfert (`fileTransfer: []`).
 */
export type FileReadToolName = "lire_fichier";

/**
 * Outils des CONSIGNES DURABLES du bot (`memoriser_consigne`, `ajouter_fait`,
 * `lister_consignes`, `oublier_consigne`).
 *
 * ⚠️ ÉCRITURE DIRECTE par le bot (décision utilisateur du 2026-11-14) : le bot
 * enregistre lui-même une consigne (« ne refais plus jamais ça ») ou un fait.
 * Le fichier reste LISIBLE et SUPPRIMABLE par l'humain (interface de la page du
 * bot, ou édition à la main) : ce n'est pas un canal caché.
 *
 * ⚠️ Le port est PAR BOT (le chemin est capturé à la construction) : ces outils
 * ne peuvent pas écrire dans le fichier d'un autre bot.
 *
 * ⚠️ Capacité `memoire` (ce sont des archives durables du bot, pas des
 * souvenirs recherchés).
 */
export type ConsigneToolName =
  | "memoriser_consigne"
  | "ajouter_fait"
  | "lister_consignes"
  | "oublier_consigne";

/** Tous les noms d'outils custom, par catégorie (garde-fou testable). */
export type CustomToolName =
  | DelegateToolName
  | ExecutionToolName
  | ScreenshotToolName
  | AgentDirectoryToolName
  | SecretToolName
  | HeritageToolName
  | ConversationArchiveToolName
  | LibrarianToolName
  | FilesToolName
  | ChannelPostToolName
  | MessageToolName
  | EnvoiProgrammeToolName
  | PlanifierTacheToolName
  | FileTransferToolName
  | FileListToolName
  | FileReadToolName
  | ImageToolName
  | ConsigneToolName;

export interface ToolPolicyEntry {
  readonly role: LlmRole;
  /** Builtins exposés (allowlist passée au SDK). */
  readonly builtins: readonly BuiltinToolName[];
  /** Outils custom exposés. */
  readonly custom: readonly DelegateToolName[];
  /** Outils d'exécution déléguée (Lot 4). */
  readonly execution: readonly ExecutionToolName[];
  /** Outils de capture d'écran par l'agent (Lot 4, extension). */
  readonly screenshots: readonly ScreenshotToolName[];
  /** Outils de consultation des agents (Lot 4, lecture seule). */
  readonly directory: readonly AgentDirectoryToolName[];
  /** Outils de consultation des secrets du coffre (NOMS seulement). */
  readonly secrets: readonly SecretToolName[];
  /** Outil de DEMANDE de secret (`demander_secret`, léger uniquement). */
  readonly secretRequests: readonly SecretToolName[];
  /** Outils de consultation de l'archive « vie antérieure » (Lot 13). */
  readonly heritage: readonly HeritageToolName[];
  /** Outil de recherche dans l'archive des conversations mises de côté. */
  readonly conversationArchive: readonly ConversationArchiveToolName[];
  /** Outils des CONSIGNES DURABLES du bot (consignes + faits, écriture directe). */
  readonly consignes: readonly ConsigneToolName[];
  /** Outils du libraire de Pi-Web (recherche documentaire + web). */
  readonly librarian: readonly LibrarianToolName[];
  /** Outil de CAPTURE de page web via Libry (`capture_libraire`). */
  readonly librarianCapture: readonly LibrarianToolName[];
  /** Outils d'ENVOI de fichier par Yuki (`envoyer_fichier`). */
  readonly files: readonly FilesToolName[];
  /** Outil d'ENVOI DE MESSAGE dans la conversation courante (`envoyer_message`). */
  readonly messages: readonly MessageToolName[];
  /** Outil d'ENVOI PROGRAMMÉ (`programmer_envoi`, lot 28). */
  readonly envoisProgrammes: readonly EnvoiProgrammeToolName[];
  /** Outil de TÂCHE PLANIFIÉE (`planifier_tache`, lot 31). */
  readonly planifierTaches: readonly PlanifierTacheToolName[];
  /** Outils de TRANSFERT de fichiers vers/depuis une machine (`files`). */
  readonly fileTransfer: readonly FileTransferToolName[];
  // ⚠️ AUCUNE CATÉGORIE DE PUBLICATION INTER-CANAL, À DESSEIN : dans un canal il n'y a
  // qu'UN rédacteur, le tour de Yuki (`docs/lot18-chat.md`). `publier_dans_canal` est
  // donc une capacité des RUNS DE CANAL (`REMOTE_SAFE_TOOLS`, plus bas), jamais un
  // droit de RÔLE : le worker lourd ne l'a pas et ne peut pas l'avoir.
  /** Outil de LISTAGE des pièces jointes (`lister_fichiers`, lecture seule). */
  readonly fileList: readonly FileListToolName[];
  /** Outil de LECTURE du contenu d'une pièce jointe (`lire_fichier`). */
  readonly fileRead: readonly FileReadToolName[];
  /** Outil de GÉNÉRATION d'image (`generer_image`, serveur ComfyUI). */
  readonly images: readonly ImageToolName[];
  /** Le rôle peut-il déléguer à un worker lourd ? */
  readonly canDelegate: boolean;
}

/** Outils de lecture seule partagés par les deux rôles. */
export const READ_ONLY_TOOLS: readonly BuiltinToolName[] = [
  "read",
  "ls",
  "grep",
  "find",
];

export const DELEGATE_TOOLS: readonly DelegateToolName[] = [
  "delegate",
  "job_status",
  "cancel_job",
  "steer_job",
];

/**
 * Outils d'exécution déléguée (Lot 4). Non exposés par défaut : le câblage les
 * active seulement quand un service d'exécution est disponible et que
 * l'utilisateur n'a pas désactivé l'outil.
 */
export const EXECUTION_TOOLS: readonly ExecutionToolName[] = ["run_command"];

/**
 * Outils de capture d'écran par l'agent (Lot 4, extension). Non exposés par
 * défaut : le câblage les active quand un service d'exécution existe. ⚠️ La
 * capture n'est PAS classée destructrice : au niveau 3, elle passe sans
 * validation ; un agent `disabled` la bloque comme toute exécution.
 */
export const SCREENSHOT_TOOLS: readonly ScreenshotToolName[] = ["capturer_ecran"];

/**
 * Outils de consultation des agents (Lot 4, extension). Non exposés par défaut
 * (comme l'exécution) : le câblage les active dès qu'un service de consultation
 * existe — **indépendamment** de l'activation de l'exécution (consulter n'est
 * pas exécuter).
 */
export const AGENT_DIRECTORY_TOOLS: readonly AgentDirectoryToolName[] = [
  "lister_agents",
  "etat_agent",
];

/**
 * Outils de consultation des secrets du coffre. Comme les autres outils de
 * consultation, exposés seulement si le câblage les active. ⚠️ NOMS seulement.
 * La DEMANDE de secret (`demander_secret`) est un outil SÉPARÉ, réservé au léger.
 */

/**
 * Outils de consultation de l'archive « vie antérieure » (Lot 13). Comme les
 * outils de consultation d'agents, ils ne sont exposés que si le câblage les
 * active (un port d'archive existe). **LECTURE SEULE.**
 */
export const HERITAGE_TOOLS: readonly HeritageToolName[] = [
  "archive_vie_anterieure",
];

/**
 * Outil de recherche dans l'archive des conversations mises de côté. LECTURE
 * SEULE, PLEIN TEXTE ; exposé seulement si le câblage fournit un port d'archive.
 * ⚠️ Le prompt de l'outil impose une demande EXPLICITE de l'utilisateur.
 */
export const CONVERSATION_ARCHIVE_TOOLS: readonly ConversationArchiveToolName[] = [
  "chercher_conversations_archivees",
];

/**
 * Outils des CONSIGNES DURABLES (écriture directe par le bot, fichier du bot).
 * ⚠️ Ils n'ont de sens qu'avec un port de consignes : le câblage les active
 * (`consignesEnabled`), et la capacité `memoire` les filtre ensuite.
 */
export const CONSIGNE_TOOLS: readonly ConsigneToolName[] = [
  "memoriser_consigne",
  "ajouter_fait",
  "lister_consignes",
  "oublier_consigne",
];

/**
 * Outils du libraire (recherche documentaire + web). Comme les outils de
 * consultation d'agents/archive, ils ne sont exposés que si le câblage les active
 * (URL de base du libraire renseignée au démarrage). ⚠️ `archive_libraire` rend la
 * main immédiatement (travail de fond).
 *
 * ⚠️ `lire_page_web` (LECTURE du TEXTE d'une page, `POST /read`) fait partie de
 * ce groupe : il sert à LIRE, pas à capturer. `capture_libraire` reste séparé
 * (`LIBRARIAN_CAPTURE_TOOLS`) et réservé à la VÉRIFICATION D'UN RENDU.
 */
export const LIBRARIAN_TOOLS: readonly LibrarianToolName[] = [
  "recherche_libraire",
  "liste_libraire",
  "lire_libraire",
  "lire_page_web",
  "archive_libraire",
];

/**
 * Outils d'IMAGE : `generer_image` (génération via un serveur ComfyUI) et
 * `consulter_workflow` (CONSIGNES D'ÉCRITURE du workflow retenu).
 *
 * ⚠️ `consulter_workflow` est GRATUIT et INSTANTANÉ (lecture locale, aucun appel
 * modèle) et il n'est PAS un accusé de réception : c'est pour cela qu'il est
 * exposé avec la génération sans figurer dans `ACK_TOOLS`.
 *
 * `generer_image` est exposé quand le générateur est câblé (toujours, dans le
 * gateway) : l'outil REFUSE explicitement tant qu'aucune URL de serveur n'est
 * configurée, avec la marche à suivre — aucun redémarrage n'est donc nécessaire
 * pour l'activer.
 */
export const IMAGE_TOOLS: readonly ImageToolName[] = ["generer_image", "consulter_workflow"];

/**
 * Outils de publication inter-canal (décision A). ⚠️ Restreints aux canaux SUIVIS par
 * le port (`src/chat/reply/channel-post.ts`) : la liste déclarée ici ne dit que
 * « l'outil a le droit d'être construit », jamais « n'importe quel canal ».
 */
export const CHANNEL_POST_TOOLS: readonly ChannelPostToolName[] = ["publier_dans_canal"];

/**
 * Outil de CAPTURE de page web via Libry (`capture_libraire`). Exposé quand le
 * libraire est configuré ET que `librarian.screenshot` est `on` au démarrage
 * (même contrainte que l'URL de base).
 */
export const LIBRARIAN_CAPTURE_TOOLS: readonly LibrarianToolName[] = [
  "capture_libraire",
];

/**
 * Outil d'ENVOI de fichier (`envoyer_fichier`). Exposé quand le stockage des
 * fichiers existe. ⚠️ Il n'ouvre AUCUN accès disque au modèle : il ne peut
 * envoyer qu'un fichier DÉJÀ rattaché à la conversation courante.
 */
export const FILES_TOOLS: readonly FilesToolName[] = ["envoyer_fichier"];

/**
 * Outil d'ENVOI DE MESSAGE (`envoyer_message`).
 *
 * ⚠️ Publié dans la conversation COURANTE, par le chemin de publication ordinaire
 * (`ReplyProgress` en canal, `PiHost.publierMessage` en local) : aucun second chemin.
 * ⚠️ Le LOURD ne l'a pas (`TOOL_POLICY.heavy.messages`) : la publication d'un message
 * est celle de Yuki, et l'invariant « un seul rédacteur » reste intact.
 */
export const MESSAGE_TOOLS: readonly MessageToolName[] = ["envoyer_message"];

/**
 * Outil d'ENVOI PROGRAMMÉ (`programmer_envoi`). Porté par le LÉGER seul — c'est lui qui
 * converse, donc lui qui sait qu'on lui a demandé « plus tard ». Le worker lourd ne
 * l'a pas : il exécute, il ne publie pas (invariant « un seul rédacteur »).
 */
export const ENVOI_PROGRAMME_TOOLS: readonly EnvoiProgrammeToolName[] = ["programmer_envoi"];

/**
 * Outil de TÂCHE PLANIFIÉE (`planifier_tache`, lot 31). Porté par le LÉGER seul — le
 * worker lourd EXÉCUTE, il ne programme rien.
 */
export const PLANIFIER_TACHE_TOOLS: readonly PlanifierTacheToolName[] = ["planifier_tache"];

/**
 * Outils de TRANSFERT de fichiers (capacité `files`). Exposés quand le service
 * de transfert existe et que l'exécution n'est pas désactivée. ⚠️ Le lourd les
 * porte ; le léger, non (il converse, il n'agit pas sur une machine).
 */
export const FILE_TRANSFER_TOOLS: readonly FileTransferToolName[] = [
  "recuperer_fichier",
  "deposer_fichier",
];

/**
 * Outil de LISTAGE des pièces jointes. ⚠️ LECTURE SEULE : il ne transfère rien
 * et n'élargit donc PAS le périmètre d'action du rôle. Porté par le worker
 * LOURD uniquement (« le léger liste via `envoyer_fichier`, le lourd agit »).
 */
export const FILE_LIST_TOOLS: readonly FileListToolName[] = ["lister_fichiers"];

/**
 * Outil de LECTURE du contenu d'une pièce jointe. ⚠️ Le worker lourd en a besoin
 * pour FERMER la boucle `lister_fichiers` → `lire_fichier` → `deposer_fichier` :
 * sans lui, il connaît l'identifiant d'une image et ne peut pas la voir.
 */
export const FILE_READ_TOOLS: readonly FileReadToolName[] = ["lire_fichier"];

/**
 * CAPACITÉS D'UN BOT (lot 35h) — CE QUE CHAQUE FAMILLE D'OUTILS OUVRE.
 *
 * ⚠️ RÈGLE UNIQUE, ÉCRITE ICI ET NULLE PART AILLEURS :
 *
 *     allowlistFinale = toolAllowlist(rôle, options) ∩ OUTILS_DES_CAPACITES(capacites)
 *
 * Une capacité ne peut que **RETIRER** des outils, JAMAIS en AJOUTER. C'est la
 * raison d'être de l'intersection : le câblage (`src/index.ts`) décide de ce qui
 * est POSSIBLE (un port absent ⇒ outil absent, un réglage `desactive` ⇒ groupe
 * fermé) ; les capacités décident seulement de ce qui est PERMIS AU BOT. Sans
 * l'intersection, une capacité rouvrirait ce que le câblage a fermé (ex.
 * `chat.remoteAgents = desactive` ⇒ `delegate` de retour).
 *
 * ⚠️ UN BOT NEUF N'A AUCUNE CAPACITÉ (`[]`) : son allowlist est VIDE — aucun
 * builtin, aucun outil custom. Il peut toujours RÉPONDRE (ce n'est pas un outil :
 * c'est le tour de conversation lui-même), et c'est tout.
 *
 * ⚠️ `undefined` = « aucun filtrage » : c'est le cas d'un appel qui ne connaît pas
 * de bot (mono-bot historique, tests de la politique du rôle). Un bot du registre
 * a TOUJOURS une liste (le registre normalise : champ absent ⇒ toutes les
 * capacités).
 *
 * ⚠️ `execution` et `delegation` sont les DEUX capacités STRUCTURELLES : sans
 * l'une des deux, le worker lourd n'est pas instancié (`src/bots/profils.ts`) et
 * `run_command` ne peut donc pas exister, même par un job importé ou une tâche
 * planifiée. Les autoriser ici ne suffit pas à les obtenir : il faut le worker.
 *
 * ⚠️ Chaque outil custom appartient à UNE SEULE capacité (partition vérifiée par
 * test) : deux capacités qui se recouvriraient rendraient le réglage ambigu.
 */
export interface CapaciteOutils {
  /** Builtins exposés par la capacité (allowlist SDK). */
  readonly builtins: readonly BuiltinToolName[];
  /** Outils custom ouverts par la capacité (sous-ensemble de `CustomToolName`). */
  readonly custom: readonly CustomToolName[];
}

/**
 * TABLE DES CAPACITÉS (⚠️ `Record<CapaciteBot, …>` : une capacité qui n'est pas
 * décrite ici ne compile pas — la liste des clés vit dans le registre,
 * `CAPACITES_BOT`, `src/bots/registry.ts`).
 */
export const OUTILS_DES_CAPACITES: Readonly<Record<CapaciteBot, CapaciteOutils>> = {
  /** Pièces jointes de la conversation : lister, lire, récupérer, déposer. */
  fichiers: {
    builtins: [],
    custom: [...FILE_LIST_TOOLS, ...FILE_READ_TOOLS, ...FILE_TRANSFER_TOOLS],
  },
  /** Parler : message dans la conversation, fichier envoyé, publication en canal. */
  envoi: {
    builtins: [],
    custom: [...MESSAGE_TOOLS, ...FILES_TOOLS, ...CHANNEL_POST_TOOLS],
  },
  /** Bibliothèque documentaire (recherche, lecture, archivage, capture). */
  libraire: {
    builtins: [],
    custom: [
      "recherche_libraire",
      "liste_libraire",
      "lire_libraire",
      "archive_libraire",
      ...LIBRARIAN_CAPTURE_TOOLS,
    ],
  },
  /** Lecture d'une page web par le libraire (`lire_page_web`). */
  web: {
    builtins: [],
    custom: ["lire_page_web"],
  },
  /** Images générées (ComfyUI) et consignes de workflow. */
  images: {
    builtins: [],
    custom: [...IMAGE_TOOLS],
  },
  /** Annuaire des machines appairées (lecture seule). */
  agents: {
    builtins: [],
    custom: [...AGENT_DIRECTORY_TOOLS],
  },
  /** Exécution sur une machine appairée : commande et capture d'écran. */
  execution: {
    builtins: [],
    custom: [...EXECUTION_TOOLS, ...SCREENSHOT_TOOLS],
  },
  /** Délégation au worker lourd : déléguer et suivre le job. */
  delegation: {
    builtins: [],
    custom: [...DELEGATE_TOOLS],
  },
  /** Coffre de secrets : lister les NOMS, demander une saisie. */
  secrets: {
    builtins: [],
    custom: [...SECRET_DIRECTORY_TOOLS, ...SECRET_REQUEST_TOOLS],
  },
  /** Prendre la parole plus tard : envoi programmé et tâche planifiée. */
  programmation: {
    builtins: [],
    custom: [...ENVOI_PROGRAMME_TOOLS, ...PLANIFIER_TACHE_TOOLS],
  },
  /** Archives consultables : vie antérieure et conversations mises de côté. */
  memoire: {
    builtins: [],
    custom: [...HERITAGE_TOOLS, ...CONVERSATION_ARCHIVE_TOOLS, ...CONSIGNE_TOOLS],
  },
  /**
   * Builtins de l'agent de développement (`read`, `ls`, `grep`, `find`).
   * ⚠️ Ils donnent accès au VOLUME DE TRAVAIL (code, secrets éventuels) : c'est
   * pourquoi ils forment une capacité À PART, décochée comme les autres.
   */
  builtins: {
    builtins: [...READ_ONLY_TOOLS],
    custom: [],
  },
};

/**
 * INTERSECTION d'une allowlist avec les capacités d'un bot.
 *
 * ⚠️ Le seul point de la règle `allowlistFinale = allowlist ∩ CAPACITÉS` : les
 * appelants ne filtrent JAMAIS eux-mêmes (deux filtrages divergeraient).
 * `undefined` rend la liste reçue, à l'identique (aucun bot en jeu).
 *
 * ⚠️ L'ordre de la liste reçue est CONSERVÉ (les tests comparent des tableaux).
 */
export function filtrerSelonCapacites(
  tools: readonly string[],
  capacites: readonly CapaciteBot[] | undefined,
): string[] {
  if (capacites === undefined) return [...tools];
  const autorises = new Set<string>();
  for (const capacite of capacites) {
    const entree: CapaciteOutils | undefined = OUTILS_DES_CAPACITES[capacite];
    // ⚠️ Une capacité inconnue n'ouvre RIEN (fail-closed) : le registre la refuse
    // à l'écriture (`src/bots/registry.ts`), elle ne peut donc pas venir d'un
    // fichier valide — mais on ne l'interprète jamais comme « tout ».
    if (entree === undefined) continue;
    for (const outil of entree.builtins) autorises.add(outil);
    for (const outil of entree.custom) autorises.add(outil);
  }
  return tools.filter((tool) => autorises.has(tool));
}

export const TOOL_POLICY: Readonly<Record<LlmRole, ToolPolicyEntry>> = {
  light: {
    role: "light",
    builtins: READ_ONLY_TOOLS,
    custom: DELEGATE_TOOLS,
    // ⚠️ INVERSION DES RÔLES : Yuki (léger) n'AGIT PLUS. Elle ne porte AUCUN
    // outil d'action (`run_command`, `capturer_ecran`) : ce qui agit sur une
    // machine se DÉLÈGUE au worker lourd.
    execution: [],
    screenshots: [],
    directory: AGENT_DIRECTORY_TOOLS,
    secrets: SECRET_DIRECTORY_TOOLS,
    secretRequests: SECRET_REQUEST_TOOLS,
    heritage: HERITAGE_TOOLS,
    conversationArchive: CONVERSATION_ARCHIVE_TOOLS,
    // ⚠️ CONSIGNES DURABLES : le léger (celui qui converse) porte l'écriture —
    // c'est lui qui reçoit « ne refais plus jamais ça ». Le fichier est celui
    // du bot, et l'humain peut tout supprimer.
    consignes: CONSIGNE_TOOLS,
    librarian: LIBRARIAN_TOOLS,
    librarianCapture: LIBRARIAN_CAPTURE_TOOLS,
    // Fichiers : Yuki peut RENVOYER un fichier de la conversation (le lourd
    // n'écrit qu'à l'utilisateur : il n'envoie pas de fichier).
    files: FILES_TOOLS,
    // ⚠️ ENVOI DE MESSAGE (`envoyer_message`) : le léger PORTE la publication, en local
    // comme en canal. C'est lui qui converse, donc lui qui décide de dire une chose en
    // un message ou en vingt. Le LOURD ne l'a pas (`messages: []` ci-dessous) :
    // invariant « un seul rédacteur » (`docs/lot18-chat.md`).
    messages: MESSAGE_TOOLS,
    // ⚠️ ENVOI PROGRAMMÉ (`programmer_envoi`, lot 28) : le léger seul. Programmer une
    // publication est un acte de RÉDACTEUR ; le lourd ne parle pas dans la
    // conversation, donc il ne programme rien (même invariant que `messages`).
    envoisProgrammes: ENVOI_PROGRAMME_TOOLS,
    // ⚠️ TÂCHE PLANIFIÉE (`planifier_tache`, lot 31) : le léger seul. Comme
    // `programmer_envoi`, c'est un acte de RÉDACTEUR ; à la différence de lui, la tâche
    // fait AGIR un worker à l'heure dite — mais ce worker est celui de la délégation, avec
    // ses propres garde-fous, et aucune pré-autorisation n'est transmise.
    planifierTaches: PLANIFIER_TACHE_TOOLS,
    // ⚠️ Le LÉGER ne transfère PAS de fichiers depuis/vers une machine : il
    // délègue au worker lourd.
    fileTransfer: [],
    // ⚠️ Pas de `lister_fichiers` au léger : `envoyer_fichier` (sans argument)
    // rend déjà la liste, désormais AVEC les identifiants. Un seul outil de
    // listage à maintenir pour lui.
    fileList: [],
    // ⚠️ Pas de `lire_fichier` au léger : il reçoit DÉJÀ le contenu — texte dans
    // le bloc `<fichiers>` (borné par `files.promptChars`), images en pièce
    // jointe du message (`prepareImages`). Lui ouvrir la lecture du store
    // n'ajouterait aucune capacité, seulement une surface d'accès aux octets.
    fileRead: [],
    // IMAGES : le léger garde la génération pour le mode LOCAL (il y bloque, ce
    // qui est acceptable). ⚠️ En CANAL, un tour borné ne peut pas la contenir :
    // c'est le job qui la porte (`heavy.images`, lot 23), et un appel inline y est
    // REFUSÉ par l'outil lui-même (`LONG_RUNNING_TOOLS`).
    images: IMAGE_TOOLS,
    canDelegate: true,
  },
  heavy: {
    role: "heavy",
    builtins: READ_ONLY_TOOLS,
    // Le worker lourd est l'EXÉCUTEUR : il porte les outils d'ACTION sur les
    // machines appairées, avec les MÊMES garde-fous par agent (niveaux, hors
    // ligne = refus, audit, plafond de sortie). Il ne redélègue PAS et n'a ni
    // annuaire ni archive ni libraire (il ne converse pas, il exécute).
    custom: [],
    execution: EXECUTION_TOOLS,
    screenshots: SCREENSHOT_TOOLS,
    directory: [],
    // Le worker lourd EXÉCUTE : il doit connaître les NOMS des secrets pour
    // écrire `${NOM}` dans ses commandes (jamais la valeur). Il ne DEMANDE pas
    // de secret : il n'a pas d'outil `demander_secret` (il ne converse pas),
    // il obtient la valeur par le flux sur référence manquante.
    secrets: SECRET_DIRECTORY_TOOLS,
    secretRequests: [],
    heritage: [],
    conversationArchive: [],
    // ⚠️ Le worker lourd ne converse pas : il n'écrit pas de consignes.
    consignes: [],
    librarian: [],
    librarianCapture: [],
    files: [],
    messages: [],
    // ⚠️ Le worker LOURD ne programme AUCUN envoi : publier est le fait du rédacteur.
    envoisProgrammes: [],
    // ⚠️ Et il ne programme AUCUNE tâche : une tâche de fond qui en programmerait une
    // autre ouvrirait une chaîne sans fin (même raison que `canDelegate: false`).
    planifierTaches: [],
    // ⚠️ Le worker lourd TRANFÈRE les fichiers : c'est lui qui agit sur une
    // machine. Mêmes garde-fous par agent que `run_command`.
    fileTransfer: FILE_TRANSFER_TOOLS,
    // ⚠️ Le worker lourd LISTE (avec identifiants) pour pouvoir DÉPOSER.
    fileList: FILE_LIST_TOOLS,
    // ⚠️ Le worker lourd LIT le contenu : sans `lire_fichier`, il savait qu'une image
    // existait sans pouvoir la voir (l'utilisateur restait dans la boucle).
    fileRead: FILE_READ_TOOLS,
    // ⚠️ AUCUN OUTIL DE PUBLICATION DE MESSAGE au worker lourd : il AGIT sur une
    // machine, il ne parle pas dans la conversation. Son résultat revient par le
    // rapport du job (`HeavyRunResult`), et c'est le tour de Yuki qui le publie.
    // ⚠️ IMAGES : le lourd PORTE la génération (lot 23).
    //
    // Pourquoi pas le léger ? Une génération prend jusqu'à `images.timeoutMs`
    // (1 h par défaut, `src/config/schema.ts`) alors qu'un run de CANAL est borné par
    // `CHAT_REPLY_TIMEOUT_MS` (90 s, `src/chat/reply/prompt.ts`) : l'image était
    // avortée en plein vol, sans message. Le job, lui, n'a pas de borne de tour.
    // Le léger GARDE ses outils d'image (`light.images` ci-dessus) pour le mode
    // LOCAL, où il bloque sans conséquence.
    //
    // ⚠️ Aucun outil à approbation n'entre ici : `generer_image` et
    // `consulter_workflow` n'en exigent aucune (`APPROVAL_REQUIRED_TOOLS` plus
    // bas) — un test le verrouille.
    images: IMAGE_TOOLS,
    canDelegate: false,
  },
};

export interface ToolAllowlistOptions {
  /**
   * Force la présence/absence des outils de délégation. Par défaut, suit la
   * politique du rôle. Quand la clé lourde manque, la délégation est désactivée
   * STRUCTURELLEMENT (les outils ne sont pas exposés).
   */
  delegationEnabled?: boolean;
  /**
   * Active l'outil d'exécution déléguée `run_command` (Lot 4). DÉSACTIVÉ par
   * défaut : seul le câblage l'active, quand un service d'exécution existe.
   */
  executionEnabled?: boolean;
  /**
   * Active l'outil de capture d'écran `capturer_ecran` (Lot 4, extension).
   * DÉSACTIVÉ par défaut : seul le câblage l'active, quand un service d'exécution
   * existe (la capture passe par le même canal agent). ⚠️ Même garde-fou que
   * `run_command`, mais la capture n'est jamais destructrice.
   */
  screenshotsEnabled?: boolean;
  /**
   * Active les outils de consultation des agents `lister_agents`/`etat_agent`
   * (Lot 4, extension). DÉSACTIVÉ par défaut : seul le câblage les active, quand
   * un service de consultation existe. ⚠️ Indépendant de `executionEnabled` :
   * les deux peuvent être activés séparément (consulter n'est pas exécuter).
   */
  directoryEnabled?: boolean;
  /**
   * Active l'outil de consultation des secrets `lister_secrets` (NOMS seulement).
   * DÉSACTIVÉ par défaut : seul le câblage l'active, quand un coffre existe.
   */
  secretsEnabled?: boolean;
  /**
   * Active l'outil de DEMANDE de secret `demander_secret` (léger uniquement).
   * DÉSACTIVÉ par défaut : seul le câblage l'active, quand un service d'exécution
   * expose le port de demande (le coffre doit être utilisable).
   */
  secretRequestsEnabled?: boolean;
  /**
   * Active l'outil de consultation de l'archive « vie antérieure »
   * `archive_vie_anterieure` (Lot 13). DÉSACTIVÉ par défaut : seul le câblage
   * l'active, quand un port d'archive existe.
   */
  heritageEnabled?: boolean;
  /**
   * Active les quatre outils des CONSIGNES DURABLES (`memoriser_consigne`,
   * `ajouter_fait`, `lister_consignes`, `oublier_consigne`). DÉSACTIVÉ par
   * défaut : seul le câblage l'active, quand un port de consignes existe.
   */
  consignesEnabled?: boolean;
  /**
   * Active l'outil de RECHERCHE dans l'archive des conversations mises de côté
   * (`chercher_conversations_archivees`). DÉSACTIVÉ par défaut : seul le câblage
   * l'active, quand un port d'archive existe.
   */
  conversationArchiveEnabled?: boolean;
  /**
   * Active les quatre outils du libraire de Pi-Web. DÉSACTIVÉ par défaut : seul
   * le câblage les active, quand une URL de base est renseignée au démarrage.
   */
  librarianEnabled?: boolean;
  /**
   * Active l'outil de capture de page web `capture_libraire` (Libry). En plus de
   * `librarianEnabled`, il faut que `librarian.screenshot` soit `on`. Défaut :
   * désactivé.
   */
  librarianCaptureEnabled?: boolean;
  /**
   * Active l'outil d'ENVOI de fichier `envoyer_fichier`. DÉSACTIVÉ par défaut :
   * seul le câblage l'active, quand le stockage des fichiers existe.
   */
  filesEnabled?: boolean;
  /**
   * Active les outils de TRANSFERT de fichiers `recuperer_fichier`/`deposer_fichier`
   * (capacité `files`). DÉSACTIVÉ par défaut : seul le câblage l'active, quand un
   * service de transfert existe.
   */
  fileTransferEnabled?: boolean;
  /**
   * Active l'outil de LISTAGE des pièces jointes `lister_fichiers` (lecture
   * seule). DÉSACTIVÉ par défaut : seul le câblage l'active, quand le service
   * des fichiers existe.
   */
  fileListEnabled?: boolean;
  /**
   * Active l'outil de LECTURE du contenu `lire_fichier`. DÉSACTIVÉ par défaut :
   * seul le câblage l'active, quand le service des fichiers expose la lecture
   * des octets et la politique de vision.
   */
  fileReadEnabled?: boolean;
  /**
   * Active l'outil d'ENVOI DE MESSAGE `envoyer_message`. DÉSACTIVÉ par défaut : seul
   * le câblage l'active (le host local et les runs de canal le portent toujours ; un
   * worker lourd ne peut pas l'obtenir).
   */
  messagesEnabled?: boolean;
  /**
   * Active l'outil d'ENVOI PROGRAMMÉ `programmer_envoi` (lot 28). DÉSACTIVÉ par défaut :
   * seul le câblage l'active (le host local et les runs de canal le portent ; un worker
   * lourd ne peut pas l'obtenir).
   */
  envoisProgrammesEnabled?: boolean;
  /**
   * Active l'outil de TÂCHE PLANIFIÉE `planifier_tache` (lot 31). DÉSACTIVÉ par défaut :
   * seul le câblage l'active (le host local le porte ; un worker lourd ne peut pas
   * l'obtenir).
   */
  planifierTacheEnabled?: boolean;
  /**
   * Active l'outil de génération d'image `generer_image` (serveur ComfyUI).
   * DÉSACTIVÉ par défaut : seul le câblage l'active, quand le générateur existe.
   */
  imagesEnabled?: boolean;
  /**
   * CAPACITÉS DU BOT ACTIF (lot 35h) — ⚠️ elles ne peuvent que RETIRER des outils.
   *
   * `undefined` ⇒ aucun filtrage (appel qui ne connaît pas de bot : mono-bot
   * historique, tests de la politique du rôle). Un bot du registre a TOUJOURS une
   * liste : `[]` pour un bot neuf (allowlist VIDE), la liste complète pour un bot
   * hérité (champ absent ⇒ toutes, normalisé à la lecture du registre).
   *
   * Règle unique : `allowlistFinale = toolAllowlist(…) ∩ OUTILS_DES_CAPACITES`.
   *
   * ⚠️ La valeur vient TOUJOURS du bot du registre (`bots.bot?.capacites`,
   * `src/index.ts`), JAMAIS d'un corps de requête ou d'un message : un client ne
   * choisit pas ses propres pouvoirs.
   */
  capacites?: readonly CapaciteBot[];
}

/**
 * Allowlist effective passée au SDK pour un rôle : builtins + outils custom
 * activés. Le lourd n'a jamais d'outil de délégation ; en revanche il porte les
 * outils d'EXÉCUTION (inversion des rôles), le léger non.
 */
export function toolAllowlist(
  role: LlmRole,
  options: ToolAllowlistOptions = {},
): string[] {
  const entry = TOOL_POLICY[role];
  const delegationEnabled =
    options.delegationEnabled ?? entry.canDelegate;
  const executionEnabled = (options.executionEnabled ?? false) && entry.execution.length > 0;
  const screenshotsEnabled =
    (options.screenshotsEnabled ?? false) && entry.screenshots.length > 0;
  const directoryEnabled = (options.directoryEnabled ?? false) && entry.directory.length > 0;
  const secretsEnabled = (options.secretsEnabled ?? false) && entry.secrets.length > 0;
  const secretRequestsEnabled =
    (options.secretRequestsEnabled ?? false) && entry.secretRequests.length > 0;
  const heritageEnabled = (options.heritageEnabled ?? false) && entry.heritage.length > 0;
  const conversationArchiveEnabled =
    (options.conversationArchiveEnabled ?? false) && entry.conversationArchive.length > 0;
  const consignesEnabled =
    (options.consignesEnabled ?? false) && entry.consignes.length > 0;
  const librarianEnabled = (options.librarianEnabled ?? false) && entry.librarian.length > 0;
  const librarianCaptureEnabled =
    librarianEnabled &&
    (options.librarianCaptureEnabled ?? false) &&
    entry.librarianCapture.length > 0;
  const filesEnabled = (options.filesEnabled ?? false) && entry.files.length > 0;
  const messagesEnabled = (options.messagesEnabled ?? false) && entry.messages.length > 0;
  const envoisProgrammesEnabled =
    (options.envoisProgrammesEnabled ?? false) && entry.envoisProgrammes.length > 0;
  const planifierTacheEnabled =
    (options.planifierTacheEnabled ?? false) && entry.planifierTaches.length > 0;
  const fileTransferEnabled =
    (options.fileTransferEnabled ?? false) && entry.fileTransfer.length > 0;
  const fileListEnabled =
    (options.fileListEnabled ?? false) && entry.fileList.length > 0;
  const fileReadEnabled =
    (options.fileReadEnabled ?? false) && entry.fileRead.length > 0;
  const imagesEnabled = (options.imagesEnabled ?? false) && entry.images.length > 0;
  const tools: string[] = [...entry.builtins];
  if (entry.canDelegate && delegationEnabled) {
    tools.push(...entry.custom);
  }
  if (executionEnabled) {
    tools.push(...entry.execution);
  }
  if (screenshotsEnabled) {
    tools.push(...entry.screenshots);
  }
  if (directoryEnabled) {
    tools.push(...entry.directory);
  }
  if (secretsEnabled) {
    tools.push(...entry.secrets);
  }
  if (secretRequestsEnabled) {
    tools.push(...entry.secretRequests);
  }
  if (heritageEnabled) {
    tools.push(...entry.heritage);
  }
  if (conversationArchiveEnabled) {
    tools.push(...entry.conversationArchive);
  }
  if (consignesEnabled) {
    tools.push(...entry.consignes);
  }
  if (librarianEnabled) {
    tools.push(...entry.librarian);
  }
  if (librarianCaptureEnabled) {
    tools.push(...entry.librarianCapture);
  }
  if (filesEnabled) {
    tools.push(...entry.files);
  }
  if (messagesEnabled) {
    tools.push(...entry.messages);
  }
  if (envoisProgrammesEnabled) {
    tools.push(...entry.envoisProgrammes);
  }
  if (planifierTacheEnabled) {
    tools.push(...entry.planifierTaches);
  }
  if (fileTransferEnabled) {
    tools.push(...entry.fileTransfer);
  }
  if (fileListEnabled) {
    tools.push(...entry.fileList);
  }
  if (fileReadEnabled) {
    tools.push(...entry.fileRead);
  }
  if (imagesEnabled) {
    tools.push(...entry.images);
  }
  // ⚠️ DERNIER mot : les CAPACITÉS. Une seule règle (`allowlistFinale = allowlist
  // ∩ OUTILS_DES_CAPACITES`), un seul endroit. Une capacité ne peut que RETIRER :
  // tout ce qui n'est pas ouvert par les capacités du bot disparaît, y compris ce
  // que le câblage venait d'activer. `[]` (bot neuf) ⇒ liste VIDE.
  return filtrerSelonCapacites(tools, options.capacites);
}

/**
 * POLITIQUE D'OUTILS PAR MODE DE DISCUSSION (lot 18).
 *
 * ⚠️ Dimension PROPRE, posée à côté des catégories existantes : un run né dans
 * une conversation DISTANTE (canal Mattermost/Discord) n'a pas les mêmes droits
 * qu'un run de la conversation locale. Ce n'est pas un booléen global : c'est un
 * jeu d'outils FERMÉ, énuméré.
 *
 * Exigence utilisateur (2026-11-01) : en mode distant, les AGENTS sont
 * désactivés PAR DÉFAUT (sécurité) — « pas de délégation, pas de transfert de
 * fichier, pas de commande » — mais **`generer_image` et l'ANALYSE D'IMAGE
 * doivent rester disponibles** (« je veux pouvoir générer et analyser des
 * images sur mattermost »).
 */
export type ChatOriginMode = "local" | "mattermost" | "discord";

/**
 * GROUPE d'accès d'un outil dans une conversation DISTANTE (canal).
 *
 * ⚠️ DEUX RÉGLAGES INDÉPENDANTS (demande utilisateur du 2026-11-02) :
 * l'utilisateur a voulu « images oui, agents non » et ne pouvait pas — un seul
 * interrupteur (`chat.remoteAgents`) décidait de TOUT. Chaque outil appartient
 * donc à EXACTEMENT UN groupe, et c'est le groupe qui décide quel réglage
 * l'ouvre :
 *  - `agents`   → `chat.remoteAgents` : tout ce qui ATTEINT une machine appairée
 *    (délégation, annuaire, coffre) ;
 *  - `outils`   → `chat.remoteTools` (NOUVEAU) : les capacités de Yuki qui ne
 *    touchent à aucune machine (image, libraire, archives) ;
 *  - `toujours` → AUCUN réglage : ce qui reste DANS la conversation (lister/lire
 *    une pièce jointe, publier un message dans un canal suivi, envoyer un
 *    fichier déjà rattaché) ;
 *  - `jamais`   → toujours REFUSÉ en distant : exige une approbation humaine (ou
 *    une saisie), qui ne peut pas être donnée depuis un canal.
 */
export type RemoteToolGroup = "agents" | "outils" | "toujours" | "jamais";

/**
 * CLASSEMENT EXHAUSTIF des outils custom : un outil = un groupe, JAMAIS deux.
 *
 * ⚠️ Le type `Record<CustomToolName, …>` est la garde de COMPILATION : ajouter un
 * outil à `CustomToolName` sans le classer ici ne compile plus. Un outil non
 * classé deviendrait sinon invisible (ou silencieusement disponible) dans tous
 * les runs distants — et personne ne s'en apercevrait.
 *
 * ⚠️ `lister_secrets` est dans `agents` — DÉCISION JUSTIFIÉE : il ne touche à
 * aucune machine (il lit des NOMS dans le coffre de Yuki, jamais une valeur),
 * mais son unique usage est de savoir QUEL `${NOM}` référencer dans une
 * commande déléguée : il n'a de sens QUE si la délégation est ouverte. Le mettre
 * avec `outils` l'ouvrirait à un run qui ne peut rien déléguer ; le classer
 * `jamais` retirerait une capacité déjà offerte au rôle léger (`TOOL_POLICY`).
 * Il reste donc derrière le réglage le plus SENSIBLE, sans exposer de valeur.
 *
 * ⚠️ `envoyer_fichier` est dans `toujours` — VÉRIFIÉ : il ne liste et n'envoie
 * que des fichiers DÉJÀ rattachés à la conversation courante
 * (`createSendFileTools`, `sessionId` FORCÉ) ; aucun accès disque, aucune
 * machine, aucune approbation. C'est le pendant exact de `lister_fichiers`.
 *
 * ⚠️ `publier_dans_canal` est dans `toujours` : un MESSAGE, pas une action sur
 * une machine (décision A, 2026-11-02). Le périmètre (canaux SUIVIS, même
 * plateforme) est tenu par le PORT, jamais par l'allowlist.
 *
 * ⚠️ `envoyer_message` est dans `toujours` pour la même raison (un message dans la
 * conversation COURANTE) : il ne sort pas du fil où Yuki répond, donc aucun réglage
 * d'accès distant n'a de sens pour lui.
 */
export const REMOTE_TOOL_GROUP_OF: Readonly<Record<CustomToolName, RemoteToolGroup>> = {
  // ── groupe AGENTS (`chat.remoteAgents`) ────────────────────────────────
  delegate: "agents",
  job_status: "agents",
  cancel_job: "agents",
  steer_job: "agents",
  lister_agents: "agents",
  etat_agent: "agents",
  lister_secrets: "agents",
  // ── groupe OUTILS (`chat.remoteTools`) ────────────────────────────────
  generer_image: "outils",
  consulter_workflow: "outils",
  recherche_libraire: "outils",
  liste_libraire: "outils",
  lire_libraire: "outils",
  lire_page_web: "outils",
  archive_libraire: "outils",
  capture_libraire: "outils",
  archive_vie_anterieure: "outils",
  chercher_conversations_archivees: "outils",
  // ⚠️ CONSIGNES DURABLES : elles n'ouvrent AUCUNE machine et n'écrivent que
  // dans le fichier du bot — un run de canal peut donc les porter sans réglage
  // d'accès distant (le fichier reste visible et supprimable par l'humain).
  memoriser_consigne: "toujours",
  ajouter_fait: "toujours",
  lister_consignes: "toujours",
  oublier_consigne: "toujours",
  // ── groupe TOUJOURS (aucun réglage) ───────────────────────────────────
  lister_fichiers: "toujours",
  lire_fichier: "toujours",
  publier_dans_canal: "toujours",
  envoyer_message: "toujours",
  // ⚠️ ENVOI PROGRAMMÉ (lot 28) : un MESSAGE qui partira plus tard, dans une
  // conversation que Yuki a déjà le droit d'écrire (canaux SUIVIS tenus par le PORT,
  // comme `publier_dans_canal`). Aucune machine, aucun modèle à l'heure dite ⇒ aucun
  // réglage d'accès distant n'a de sens pour lui.
  programmer_envoi: "toujours",
  // ⚠️ TÂCHE PLANIFIÉE (lot 31) : elle ne touche à rien MAINTENANT et le travail se fait
  // dans un worker qui a ses propres garde-fous (et aucune pré-autorisation transmise) ⇒
  // aucun réglage d'accès distant n'a de sens pour elle.
  planifier_tache: "toujours",
  envoyer_fichier: "toujours",
  // ── groupe JAMAIS (approbation impossible depuis un canal) ────────────
  run_command: "jamais",
  capturer_ecran: "jamais",
  recuperer_fichier: "jamais",
  deposer_fichier: "jamais",
  demander_secret: "jamais",
};

/** Noms classés dans `groupe`, dans l'ordre de la table (déterministe, testable). */
function nomsDuGroupe(groupe: RemoteToolGroup): CustomToolName[] {
  return (Object.keys(REMOTE_TOOL_GROUP_OF) as CustomToolName[]).filter(
    (nom) => REMOTE_TOOL_GROUP_OF[nom] === groupe,
  );
}

/** Groupe d'un outil distant, ou `undefined` si ce n'est pas un outil custom. */
export function remoteToolGroup(nom: string): RemoteToolGroup | undefined {
  return (REMOTE_TOOL_GROUP_OF as Record<string, RemoteToolGroup | undefined>)[nom];
}

/** Outils ouverts par `chat.remoteAgents` (tout ce qui atteint une machine). */
export const REMOTE_AGENTS_TOOLS: readonly CustomToolName[] = nomsDuGroupe("agents");

/** Outils ouverts par `chat.remoteTools` (image, libraire, archives). */
export const REMOTE_TOOLS: readonly CustomToolName[] = nomsDuGroupe("outils");

/** Outils d'une conversation distante, quel que soit le réglage. */
export const REMOTE_ALWAYS_TOOLS: readonly CustomToolName[] = nomsDuGroupe("toujours");

/** Outils JAMAIS offerts à une conversation distante (outils à approbation). */
export const REMOTE_NEVER_TOOLS: readonly CustomToolName[] = nomsDuGroupe("jamais");

/**
 * Ensemble des outils qu'un run distant peut atteindre, TOUS RÉGLAGES CONFONDUS
 * (`outils` puis `toujours`).
 *
 * ⚠️ Ce n'est PLUS la liste d'un run précis : un run n'obtient le groupe `outils`
 * que si `chat.remoteTools = actives`, et le groupe `agents` que si
 * `chat.remoteAgents = actives`. La liste reste exportée comme BORNE (un outil
 * hors d'elle ne peut jamais être atteint en distant) — c'est ce que vérifient
 * les tests de garde et les messages de refus.
 */
export const REMOTE_SAFE_TOOLS: readonly CustomToolName[] = [
  ...REMOTE_TOOLS,
  ...REMOTE_ALWAYS_TOOLS,
];

export interface ChatToolPolicyOptions {
  /** Origine du run : le mode de discussion de la conversation déclencheuse. */
  chatMode: ChatOriginMode;
  /** `chat.remoteAgents` : `true` ⇒ groupe AGENTS ouvert (délégation, annuaire, coffre). */
  remoteAgents: boolean;
  /**
   * `chat.remoteTools` : `true` ⇒ groupe OUTILS ouvert (image, libraire, archives).
   *
   * ⚠️ INDÉPENDANT de `remoteAgents` : « agents non + outils oui » est une
   * configuration LÉGITIME (c'est même celle que l'utilisateur demandait le
   * 2026-11-02 : génération d'image dans le canal, aucune délégation).
   */
  remoteTools: boolean;
}

/**
 * OUTILS QUI EXIGENT UNE APPROBATION HUMAINE (ou une saisie humaine).
 *
 * ⚠️ POURQUOI CETTE LISTE EXISTE : l'approbation s'affiche dans l'interface
 * WEB (`ApprovalRegistry` → trame WS de la conversation qui a demandé) et la
 * saisie de `demander_secret` s'ouvre aussi dans l'interface web. Une personne
 * qui parle à Yuki depuis un canal Mattermost ne voit NI l'une NI l'autre : un
 * run distant qui exposerait un de ces outils resterait en attente d'une
 * décision que personne ne peut prendre **depuis ce canal**.
 *
 * Preuves, outil par outil :
 *  - `run_command` / `capturer_ecran` / `recuperer_fichier` / `deposer_fichier` :
 *    `AgentExecutionService.authorize` (`src/agents/execution.ts:1147-1175`) et
 *    `authorizeTransfer` (`src/agents/execution.ts:1084`) créent une demande dans
 *    `ApprovalRegistry` dès que le niveau de l'agent l'exige (niveau 2, ou
 *    niveau 3 pour une commande destructrice) ;
 *  - `demander_secret` : ouvre une fenêtre de saisie DANS la conversation web
 *    (`src/pi/sdk/execution-tools.ts`, `createSecretRequestTool`).
 *
 * ⚠️ Les outils de `REMOTE_SAFE_TOOLS` (`generer_image`, `consulter_workflow`,
 * `lister_fichiers`, `lire_fichier`, `publier_dans_canal`) n'y figurent pas et
 * n'en dépendent pas : ils ne demandent AUCUNE validation. Un test le vérifie
 * (`tests/llm/tool-policy.test.ts`) pour qu'un ajout futur ne passe pas
 * inaperçu.
 */
export const APPROVAL_REQUIRED_TOOLS: readonly string[] = [
  "run_command",
  "capturer_ecran",
  "recuperer_fichier",
  "deposer_fichier",
  "demander_secret",
];

/** Sous-ensemble d'une allowlist qui exige une approbation (jamais silencieux). */
export function approvalRequiredTools(tools: readonly string[]): string[] {
  return tools.filter((tool) => APPROVAL_REQUIRED_TOOLS.includes(tool));
}

/**
 * OUTIL LONG : borne DÉCLARÉE > 30 s ET résultat = un LIVRABLE (pas une entrée
 * du raisonnement).
 *
 * ⚠️ POURQUOI CETTE LISTE EXISTE (2026-11-02) : un run de CANAL est borné par
 * `CHAT_REPLY_TIMEOUT_MS` (90 s, `src/chat/reply/prompt.ts:72`) alors qu'une
 * génération d'image peut prendre 1 h (`images.timeoutMs`,
 * `src/config/schema.ts:970-977`) : l'appel était coupé EN PLEIN VOL, sans
 * message, et la personne du canal restait sans réponse. Un outil long appelé
 * INLINE dans un canal est donc REFUSÉ — mais SEULEMENT quand `delegate` existe
 * (`chat.remoteAgents = actives`) : sans délégation, refuser supprimerait la
 * capacité. Dans ce cas l'appel passe et c'est la BORNE DU TOUR qui est relevée
 * (`channelTurnTimeoutMs`), avec l'accusé qui prévient de la durée.
 *
 * ⚠️ Le mode LOCAL n'est PAS concerné : il n'a pas de borne de tour (il bloque),
 * et le bloquer davantage serait une régression. Le refus ne s'applique qu'aux
 * runs de canal (`src/pi/sdk/long-tool-guard.ts`).
 *
 * ⚠️ Chaque borne est MESURÉE, pas devinée : la source est citée à côté de la
 * valeur. Une entrée ajoutée ici sans sa source serait invérifiable.
 */
export interface LongRunningTool {
  readonly name: CustomToolName;
  /** Borne déclarée de l'action, en secondes. */
  readonly seconds: number;
  /** `fichier:ligne` de la borne mesurée (jamais une estimation). */
  readonly source: string;
}

export const LONG_RUNNING_TOOLS: readonly LongRunningTool[] = [
  // 3 600 s — PLAFOND de sécurité de `images.timeoutMs` (défaut 3 600 000 ms =
  // 1 h, max 7 200 000). ⚠️ Ce n'est pas un délai fixe de calcul : le client
  // ComfyUI surveille l'état du serveur (`GET /queue`) et attend tant que le
  // serveur dit qu'il travaille (`src/comfy/client.ts`) ; le plafond n'est que
  // le filet de dernier recours, pour un travail ORPHELIN (blocage, pas lenteur).
  // Une vidéo de ~10 min de calcul passe donc — et une génération de 50 min
  // aussi, tant que le serveur la dit en cours.
  {
    name: "generer_image",
    seconds: 3_600,
    source:
      "src/config/schema.ts:970-977 (images.timeoutMs = 3_600_000, max 7_200_000)",
  },
  // 60 s — délai d'une commande déléguée (DÉFAUT ; le modèle peut demander
  // jusqu'à `MAX_COMMAND_TIMEOUT_MS` = 900 s pour une action longue).
  // ⚠️ Cette borne ne sert qu'aux runs de CANAL, où `run_command` n'est jamais
  // exposé (`APPROVAL_REQUIRED_TOOLS`, retiré des allowlists de canal).
  {
    name: "run_command",
    seconds: 60,
    source:
      "src/agents/execution.ts:479 (DEFAULT_COMMAND_TIMEOUT_MS = 60_000 ; " +
      "MAX_COMMAND_TIMEOUT_MS = 900_000)",
  },
  // 120 s — délai INACTIF d'un transfert de fichier.
  {
    name: "recuperer_fichier",
    seconds: 120,
    source: "src/config/schema.ts:829-836 (files.agentTimeoutMs = 120_000)",
  },
  {
    name: "deposer_fichier",
    seconds: 120,
    source: "src/config/schema.ts:829-836 (files.agentTimeoutMs = 120_000)",
  },
  // 30 s — capture d'écran d'une machine appairée.
  {
    name: "capturer_ecran",
    seconds: 30,
    source: "src/agents/execution.ts:482 (DEFAULT_SCREENSHOT_TIMEOUT_MS = 30_000)",
  },
  // 30 s — capture d'une page web par Libry (Chromium headless côté libraire).
  // ⚠️ `recherche_libraire` partage la même borne (`DEFAULT_LIBRARIAN_SEARCH_TIMEOUT_MS`,
  // `src/librarian/client.ts:49`) mais son résultat est une ENTRÉE du raisonnement,
  // pas un livrable : il n'est donc PAS déclaré long (la règle de délégation
  // dit elle-même qu'une recherche libraire se fait soi-même).
  {
    name: "capture_libraire",
    seconds: 30,
    source: "src/librarian/client.ts:51 (DEFAULT_LIBRARIAN_SCREENSHOT_TIMEOUT_MS = 30_000)",
  },
];

/** Fiche de l'outil long nommé (`undefined` s'il n'est pas déclaré long). */
export function longRunningTool(name: string): LongRunningTool | undefined {
  return LONG_RUNNING_TOOLS.find((tool) => tool.name === name);
}

/**
 * Durée LISIBLE par une personne, à partir des secondes mesurées.
 *
 * ⚠️ POURQUOI : le refus est recopié par le modèle et lu par une personne du
 * canal. « peut prendre jusqu'à 3600 s » ne se lit pas ; « 1 heure » si.
 * Les durées courtes restent en secondes (« 30 s »), c'est leur unité naturelle.
 */
export function humanToolDuration(seconds: number): string {
  // ⚠️ Une HEURE PLEINE se dit en heures : « 60 minutes » se lit mal et le
  // plafond de génération vaut exactement 1 h (3 600 s).
  if (seconds >= 3_600 && seconds % 3_600 === 0) {
    const heures = seconds / 3_600;
    return `${heures} heure${heures > 1 ? "s" : ""}`;
  }
  if (seconds >= 120 && seconds % 60 === 0) return `${seconds / 60} minutes`;
  return `${seconds} s`;
}

/**
 * RÉGLAGE qui ouvre la délégation en canal — nommé EXACTEMENT comme dans
 * l'interface : page INSTANCE de la configuration (`/config`), ONGLET « Agents »,
 * contrôle « Agents distants » (`public/ui/config-fields.js`, groupe `acces-distant`).
 *
 * ⚠️ Le texte du refus pointe ce chemin : un message de refus qui dit « la
 * délégation est désactivée » sans dire OÙ l'activer ne laisse que la recherche
 * dans un fichier de configuration (défaut `desactive`, `src/config/schema.ts`).
 *
 * ⚠️ DÉFAUTS DE PRODUCTION CORRIGÉS SUCCESSIVEMENT (2026-11-02, puis classement des
 * réglages) : ce chemin a nommé un onglet « Discussions » qui n'existe pas, puis un
 * onglet « Conversation » disparu à la scission Instance/Bot. Le réglage est
 * maintenant une clé d'INSTANCE, à côté des réglages d'agents.
 */
export const REMOTE_AGENTS_SETTING_PATH =
  "Configuration → Agents → Agents distants";

/**
 * Texte de REFUS d'un appel INLINE d'un outil long dans un run de CANAL.
 *
 * ⚠️ Actionnable, jamais une plainte : il dit ce que l'action coûte, pourquoi le
 * tour ne peut pas la contenir, et QUEL outil utiliser à la place. `undefined`
 * si l'outil n'est pas long (l'appel passe).
 *
 * ⚠️ `delegationAvailable: false` (défaut de `chat.remoteAgents`, c'est-à-dire
 * `desactive`) ⇒ **AUCUN refus** (`undefined`) : sans `delegate`, refuser
 * reviendrait à SUPPRIMER la capacité (régression mesurée en production le
 * 2026-11-02 : « avant, une génération courte passait ; maintenant jamais »).
 * L'appel est alors AUTORISÉ inline, et c'est la BORNE DU TOUR qui est relevée
 * (`channelTurnTimeoutMs`) pour que l'action puisse aboutir.
 */
export function longToolInlineRefusal(
  name: string,
  options: { delegationAvailable?: boolean } = {},
): string | undefined {
  const info = longRunningTool(name);
  if (!info) return undefined;
  // ⚠️ RÈGLE : on ne refuse JAMAIS une action sans proposer d'autre voie.
  if ((options.delegationAvailable ?? true) === false) return undefined;
  /**
   * ⚠️ TEXTE DESTINÉ AU MODÈLE, mais LISIBLE PARTOUT : le modèle le RECOPIE (défaut de
   * production 2026-11-02 : « la génération directe depuis ce canal a été refusée par le
   * système (elle dépasse la borne d'un tour) »). Il ne contient donc AUCUN terme de
   * plomberie (« borne », « tour », « système », « worker », « délai maximal ») : si le
   * modèle le cite, la personne du canal lit une phrase qui a du sens.
   */
  return (
    `« ${info.name} » peut prendre jusqu'à ${humanToolDuration(info.seconds)} : c'est trop long pour être `
    + "fait pendant un échange dans un canal, où le travail serait interrompu en plein vol, "
    + "sans résultat ni message (c'est déjà arrivé). Rien n'a été lancé. "
    + "Relance-la avec l'outil `delegate` : le travail se fait en arrière-plan, sans "
    + "cette limite de durée, et son résultat — le fichier produit y compris — arrivera "
    + "dans ce canal. "
    + "À la personne, tu dis seulement que l'action est longue et combien de temps elle "
    + "prend, sans expliquer ce mécanisme. "
    + `(Le recours à \`delegate\` s'active dans ${REMOTE_AGENTS_SETTING_PATH}.)`
  );
}

/**
 * BORNE (ms) du tour d'un CANAL, quand des outils longs sont AUTORISÉS inline.
 *
 * ⚠️ POURQUOI ELLE EXISTE : `CHAT_REPLY_TIMEOUT_MS` (90 s,
 * `src/chat/reply/prompt.ts:72`) est PLUS COURT que `images.timeoutMs` (1 h,
 * `src/config/schema.ts:970-977`). Autoriser `generer_image` inline sans relever
 * la borne ne ferait que déplacer le défaut : l'appel serait coupé en plein vol.
 * ⚠️ Le câblage (`src/index.ts`) passe une base déjà dérivée du RÉGLAGE COURANT
 * (`CHAT_REPLY_TIMEOUT_MS + images.timeoutMs`) : la levée suit donc à chaud un
 * changement du plafond, et la valeur ci-dessous ne sert que de PLANCHER.
 *
 * Règle : `max(borne de base, borne des outils longs autorisés)`. Sous
 * `chat.remoteAgents = actives`, tous les outils longs sont refusés inline ⇒
 * aucune levée (la borne de base reste, strictement inchangée).
 */
export function channelTurnTimeoutMs(input: {
  /** Allowlist RÉELLE du run : seuls ces outils peuvent être appelés. */
  tools: readonly string[];
  /** `delegate` est-il disponible dans ce run ? */
  delegationAvailable: boolean;
  /** Borne de base du tour (rédaction + ce que le tour doit déjà couvrir). */
  baseMs: number;
}): number {
  const base = Math.max(1, Math.trunc(input.baseMs));
  if (input.delegationAvailable) return base;
  let secondes = 0;
  for (const name of input.tools) {
    const info = longRunningTool(name);
    if (info !== undefined && info.seconds > secondes) secondes = info.seconds;
  }
  return Math.max(base, secondes * 1000);
}

/**
 * Allowlist d'un run, selon l'ORIGINE du run et les DEUX réglages d'accès distant.
 *
 * - mode `local` (défaut) : politique du rôle, STRICTEMENT inchangée — c'est le
 *   même appel, donc la même liste, élément pour élément ;
 * - mode distant : seuls les outils dont le GROUPE est ouvert
 *   (`REMOTE_TOOL_GROUP_OF`) sont retenus, plus les outils `toujours` :
 *    · `chat.remoteAgents = actives` ⇒ groupe `agents` (machines appairées) et
 *      builtins de lecture du rôle (comportement d'avant, inchangé) ;
 *    · `chat.remoteTools = actives` ⇒ groupe `outils` (image, libraire,
 *      archives), tels que les OPTIONS du rôle les activent (un port absent ⇒
 *      outil absent : la liste ne promet rien qui ne soit câblé) ;
 *    · `toujours` ⇒ toujours présents (`lister_fichiers`, `lire_fichier`,
 *      `publier_dans_canal`, `envoyer_fichier`), même avec les deux réglages
 *      désactivés ;
 *    · `jamais` ⇒ jamais (outils à approbation) ;
 * - et dans TOUS les cas distants, `APPROVAL_REQUIRED_TOOLS` est RETIRÉ : une
 *   approbation s'affiche dans l'interface web et ne peut pas être donnée
 *   depuis un canal ⇒ refus AVANT exécution, jamais un run en attente.
 *
 * ⚠️ Aucun run LOURD ne naît d'une conversation distante : le worker lourd n'y
 * est jamais créé, sa politique n'a donc pas lieu d'être calculée ici.
 *
 * ⚠️ Le filtrage n'est pas une politesse : c'est le seul endroit qui décide de
 * ce qu'un run distant peut appeler. Le run distant (canal) passe par cette
 * fonction, jamais par une liste écrite sur place.
 *
 * ⚠️ `remoteAgents` et `remoteTools` sont LUS SÉPARÉMENT : « agents non +
 * outils oui » donne `generer_image` SANS `delegate` — c'est la demande
 * explicite de l'utilisateur du 2026-11-02, impossible avec un seul réglage.
 */
export function toolAllowlistForChat(
  role: LlmRole,
  options: ToolAllowlistOptions,
  chat: ChatToolPolicyOptions,
): string[] {
  if (chat.chatMode === "local") {
    return toolAllowlist(role, options);
  }
  if (role !== "light") return [];
  const autorises = new Set<string>();
  for (const tool of toolAllowlist(role, options)) {
    const groupe = remoteToolGroup(tool);
    // ⚠️ Builtins (`read`, `ls`, `grep`, `find`) : pas des outils CUSTOM, donc pas
    // dans la table des groupes. Ils restent ouverts par `chat.remoteAgents`,
    // exactement comme avant (la politique distante « complète » les portait).
    if (groupe === undefined) {
      if (chat.remoteAgents) autorises.add(tool);
      continue;
    }
    if (groupe === "agents" && !chat.remoteAgents) continue;
    if (groupe === "outils" && !chat.remoteTools) continue;
    if (groupe === "jamais") continue;
    autorises.add(tool);
  }
  // ⚠️ SOCLE `toujours` : poussé INDÉPENDAMMENT des options du rôle, parce que le
  // léger LOCAL ne porte ni `lister_fichiers` ni `lire_fichier` (il reçoit le
  // contenu dans son message) alors qu'un run de canal en a besoin pour voir une
  // pièce jointe. Un port absent est signalé par l'appelant, jamais deviné ici.
  for (const tool of REMOTE_ALWAYS_TOOLS) {
    // ⚠️ CONSIGNES DURABLES : le socle `toujours` ne garantit pas le PORT. Sans
    // `consignesEnabled` (aucun fichier de consignes pour ce run), l'outil serait
    // ANNONCÉ sans définition — le modèle l'appellerait pour rien. On ne pousse
    // donc que ce que la politique du rôle a réellement ouvert.
    if (
      !(options.consignesEnabled ?? false) &&
      (CONSIGNE_TOOLS as readonly string[]).includes(tool)
    ) {
      continue;
    }
    autorises.add(tool);
  }
  // ⚠️ INTERSECTION AVEC LES CAPACITÉS, APRÈS le socle `toujours` : le socle est
  // poussé SANS passer par les options du rôle, or deux de ses outils
  // (`programmer_envoi`, `planifier_tache`) ne sont ouverts que par la capacité
  // `programmation`. Filtrer seulement dans `toolAllowlist` les laisserait passer
  // par cette porte.
  return filtrerSelonCapacites(
    [...autorises].filter((tool) => !APPROVAL_REQUIRED_TOOLS.includes(tool)),
    options.capacites,
  );
}

/** Outils d'écriture/exécution explicitement interdits au Lot 2. */
export const FORBIDDEN_TOOLS: readonly string[] = [
  "write",
  "edit",
  "bash",
  "powershell",
];

/** Vrai si l'allowlist contient un outil interdit (garde-fou testable). */
export function containsForbiddenTool(tools: readonly string[]): boolean {
  return tools.some((tool) => FORBIDDEN_TOOLS.includes(tool));
}
