/**
 * Discussions EXTERNES — types du SOCLE (lot 18, lot 1).
 *
 * ⚠️ Périmètre de ce lot : les TYPES, le REGISTRE d'adaptateurs et le MODÈLE de
 * données. Aucun client Mattermost, aucune synchronisation : c'est le lot 2.
 *
 * Vocabulaire :
 *  - *commun*  = ce que Yuki fait de N'IMPORTE QUELLE plateforme (identifiant de
 *    conversation préfixé, idempotence `(platform, conversationId,
 *    remoteMessageId)`, curseur opaque, mapping auteur → rôle, bornes, stockage,
 *    interface) ;
 *  - *plateforme* = ce qui lui est propre (transport, authentification,
 *    pagination, formats, canal/fil).
 *
 * ⚠️ Un CANAL = UNE CONVERSATION : les messages d'un canal portent donc leur
 * PARENT (`threadRootId`). C'est ce qui permet d'afficher les FILS DÉPLIABLES
 * comme dans Mattermost, sans changer de modèle plus tard.
 */

import type { FileImageContent } from "../files/types.js";

/** Plateformes (et mode local) connus du registre. */
export const CHAT_MODES = ["local", "mattermost", "discord"] as const;
export type ChatMode = (typeof CHAT_MODES)[number];

/** Plateformes réellement DISTANTES (une conversation miroir en vient toujours). */
export const REMOTE_PLATFORMS = ["mattermost", "discord"] as const;
export type RemotePlatform = (typeof REMOTE_PLATFORMS)[number];

/**
 * Modes de RÉPONSE, **par canal** (choix utilisateur du 2026-11-01) :
 *  - `tout`    → Yuki répond à TOUS les messages du canal ;
 *  - `auto`    → elle répond quand le message lui est adressé (c'est le LLM qui
 *                juge) ;
 *  - `mention` → elle ne répond que si elle est CITÉE.
 *
 * ⚠️ Ce réglage est PERSISTÉ PAR CANAL dans un fichier JSON du volume `state`
 * (le schéma de `/config` n'accepte ni liste ni objet). Le lot 2 le consomme ;
 * il est défini ici pour que le modèle de données soit complet dès le lot 1.
 */
export const CHAT_REPLY_MODES = ["tout", "auto", "mention"] as const;
export type ChatReplyMode = (typeof CHAT_REPLY_MODES)[number];

/**
 * COMMENT répondre, **par canal** (choix utilisateur du 2026-11-01) :
 *  - `fil`     → la réponse part DANS le fil du message (comportement historique) ;
 *  - `nouveau` → la réponse est un NOUVEAU message à la racine du canal, même si le
 *                message d'origine était dans un fil.
 *
 * ⚠️ `fil` est le défaut : il reproduit exactement ce qui a été vu en production, et
 * on ne change pas un comportement observé sans le dire.
 */
export const CHAT_REPLY_STYLES = ["fil", "nouveau"] as const;
export type ChatReplyStyle = (typeof CHAT_REPLY_STYLES)[number];

/**
 * CITER l'auteur du message auquel on répond (`oui` / `non`, **par canal**).
 *
 * ⚠️ `non` est le défaut : le comportement observé en production ne citait personne.
 */
export const CHAT_QUOTE_AUTHORS = ["oui", "non"] as const;
export type ChatQuoteAuthor = (typeof CHAT_QUOTE_AUTHORS)[number];

/** Valeur de `replyStyle` quand le canal n'a rien choisi (comportement historique). */
export const DEFAULT_REPLY_STYLE: ChatReplyStyle = "fil";

/** Valeur de `quoteAuthor` quand le canal n'a rien choisi (aucune citation). */
export const DEFAULT_QUOTE_AUTHOR: ChatQuoteAuthor = "non";

/**
 * Réglages de RÉPONSE d'un canal, tels qu'ils sont RENDUS à l'interface.
 *
 * ⚠️ `replyStyle` et `quoteAuthor` sont TOUJOURS renseignés (valeurs effectives) :
 * l'interface n'a aucun défaut à deviner. `replyMode` reste absent quand rien n'a été
 * choisi (son défaut appartient au moteur de réponse, `DEFAULT_REPLY_MODE`).
 */
export interface ChatReplySettings {
  replyMode?: ChatReplyMode;
  replyStyle: ChatReplyStyle;
  quoteAuthor: ChatQuoteAuthor;
}

/**
 * Sous-ensemble de réglages à MODIFIER (`null` = revenir au défaut).
 *
 * ⚠️ Un champ ABSENT n'est pas touché : la route PATCH peut donc n'envoyer qu'un
 * seul réglage sans écraser les autres.
 */
export interface ChatReplySettingsPatch {
  replyMode?: ChatReplyMode | null;
  replyStyle?: ChatReplyStyle | null;
  quoteAuthor?: ChatQuoteAuthor | null;
}

/** État d'une plateforme, lu par l'interface (badge ● / ◐ / ○). */
export type ChatStateCode = "on" | "connexion" | "off";

/** État d'une plateforme : jamais un booléen nu (il faut pouvoir dire POURQUOI). */
export interface ChatAdapterStatus {
  etat: ChatStateCode;
  /** Raison LISIBLE (affichée en `title` du badge). Jamais un secret, jamais un jeton. */
  raison?: string;
  /** Dernier contact RÉUSSI avec la plateforme (ISO). Absent = aucun contact connu. */
  dernierContact?: string;
}

/**
 * Conversation DISTANTE telle que Yuki la voit (miroir).
 *
 * ⚠️ `id` est l'identifiant Yuki, PRÉFIXÉ par plateforme (`mm-<channelId>`,
 * `dc-<channelId>`) : une conversation miroir ne peut donc jamais entrer en
 * collision avec un identifiant de session Pi.
 */
export interface RemoteConversation {
  /** Identifiant Yuki (préfixé) — c'est lui que manipule l'interface. */
  id: string;
  platform: RemotePlatform;
  /** Identifiant d'origine chez la plateforme (canal, guilde…). */
  remoteId: string;
  /** Titre affichable — jamais vide (repli côté adaptateur). */
  title: string;
  /** Dernière activité connue (ISO), si la plateforme la donne. */
  updatedAt?: string;
  messageCount: number;
  /**
   * ⚠️ SENS RESTREINT, à ne pas confondre avec `canRun` : `readOnly` dit
   * seulement **« on ne crée pas de conversation et on n'écrit pas depuis
   * l'interface web »** — la liste vient de la plateforme, la saisie web n'y
   * ajoute rien. Il ne dit **JAMAIS** « aucun run ».
   *
   * Toujours `true` pour un miroir : côté interface web, un canal distant est un
   * affichage, pas un composeur.
   */
  readOnly: boolean;
  /**
   * Mode de RÉPONSE choisi pour CE canal (`tout` | `auto` | `mention`).
   * Absent = non choisi (le lot 2 applique alors le défaut configuré). Le choix
   * se fait par clic droit sur le canal, comme demandé.
   */
  replyMode?: ChatReplyMode;
  /**
   * COMMENT répondre dans ce canal (`fil` | `nouveau`). **Toujours** renseigné
   * (défaut `fil` appliqué à la lecture) : l'interface coche ainsi l'option
   * réellement active, sans état local qui divergerait du serveur.
   */
  replyStyle?: ChatReplyStyle;
  /**
   * Citer l'auteur du message auquel on répond (`oui` | `non`). **Toujours**
   * renseigné (défaut `non`), pour la même raison que `replyStyle`.
   */
  quoteAuthor?: ChatQuoteAuthor;
  /**
   * ⚠️ `true` : la conversation PEUT produire un RUN côté Yuki (elle répond aux
   * messages reçus, donc elle peut appeler des outils et demander des
   * approbations). Sans ce champ, `readOnly` laisserait croire qu'un miroir est
   * inerte — c'est faux dès le lot 2.
   */
  canRun: boolean;
}

/** Auteur d'un message distant (identité minimale, jamais un objet opaque). */
export interface RemoteAuthor {
  /** Identifiant chez la plateforme. */
  id: string;
  /** Nom affichable (repli : l'identifiant). */
  nom: string;
  /** `true` si l'auteur est un robot (dont Yuki elle-même). */
  estBot: boolean;
}

/** Pièce jointe d'un message distant (métadonnées seules).
 *
 * ⚠️ Aucun octet ici : le CONTENU n'est téléchargé qu'À LA DEMANDE, jamais pendant la
 * synchronisation (un backfill de 1 000 messages déclencherait des milliers d'appels).
 */
export interface RemoteAttachment {
  /** Identifiant chez la plateforme (`file_id` Mattermost) — sert au téléchargement. */
  id: string;
  /**
   * Nom d'affichage.
   *
   * ⚠️ Un post Mattermost ne transporte QUE des identifiants (`file_ids`) : le nom
   * n'est pas connu à l'ingestion. Il vaut donc l'identifiant, puis il est renseigné
   * à la DEMANDE (`GET /files/<id>/info`) — jamais pendant la synchronisation, qui ne
   * doit pas déclencher un appel par fichier.
   */
  nom: string;
  /** Taille en octets, si la plateforme la donne. */
  taille?: number;
  /** Type MIME, si la plateforme le donne. */
  mime?: string;
  /**
   * URL de CONTENU fournie par la plateforme (Discord), quand elle en donne une.
   *
   * ⚠️ Chez Discord elle est SIGNÉE et EXPIRANTE. Elle n'est jamais demandée à
   * l'appelant : elle est relue dans le MIROIR, et seul un fichier déjà référencé par un
   * message d'un canal SUIVI peut être téléchargé. Une URL fournie de l'extérieur ne
   * déclenche AUCUNE requête (garde d'appartenance).
   *
   * ⚠️ Absente pour Mattermost : un post n'y transporte que des `file_ids`.
   */
  url?: string;
}

/**
 * Message d'une conversation miroir.
 *
 * ⚠️ `threadRootId` est OBLIGATOIRE DÈS MAINTENANT (même s'il est absent sur un
 * message racine) : l'utilisateur veut des FILS DÉPLIABLES comme Mattermost,
 * donc le parent voyage avec le message dès le premier lot qui les modélise.
 * Ajouter un champ après coup obligerait à re-synchroniser tout le miroir.
 */
export interface RemoteMessage {
  /** Identifiant chez la plateforme (clé d'idempotence avec la conversation). */
  remoteId: string;
  /** Conversation Yuki (préfixée) à laquelle ce message appartient. */
  conversationId: string;
  /** Message PARENT quand celui-ci est une réponse de fil ; absent sinon. */
  threadRootId?: string;
  author: RemoteAuthor;
  /** Rôle tel que Yuki l'affiche : un humain ou un autre robot = `user`. */
  role: "user" | "assistant";
  text: string;
  /** Instant d'envoi (ISO) — jamais deviné : fourni par la plateforme. */
  sentAt: string;
  /** Instant d'édition (ISO), si le message a été modifié. */
  editedAt?: string;
  /** `true` si le message a été supprimé chez la plateforme (texte conservé). */
  deleted?: boolean;
  attachments?: RemoteAttachment[];
}

/**
 * ORIGINE d'un run : d'où il a été DÉCLENCHÉ. Sert à relayer une demande
 * d'approbation **là où le run est né** (interface web ET/OU plateforme).
 *
 * ⚠️ Réservé au lot 1, BRANCHÉ au lot 3 : aucun champ `any`, aucune refonte à
 * prévoir quand le relais arrivera.
 */
export type ChatRunOrigin =
  | { kind: "local" }
  | {
      kind: "remote";
      platform: RemotePlatform;
      /** Conversation Yuki (préfixée) — c'est LÀ que l'approbation doit revenir. */
      conversationId: string;
      /** Fil d'origine, si le message déclencheur était une réponse de fil. */
      threadRootId?: string;
    };

/** Option proposée dans une demande d'approbation relayée sur une plateforme. */
export interface ChatApprovalOption {
  /** Identifiant stable de l'option (`approuver`, `refuser`, `approuver_toujours`…). */
  id: string;
  /** Libellé affiché sur la plateforme. */
  label: string;
  /** `true` pour l'option destructrice (affichage distinct côté plateforme). */
  destructif?: boolean;
}

/**
 * Demande d'approbation telle qu'elle sera RELAYÉE sur une plateforme (lot 3).
 *
 * ⚠️ Ne porte JAMAIS un secret : seulement de quoi décider (commande exacte,
 * machine, portée). Le lot 1 réserve la forme ; rien n'est envoyé.
 */
export interface ChatApprovalRequest {
  /** Identifiant de la demande (corrélation avec la décision reçue). */
  id: string;
  /** Titre court (« Exécuter une commande », « Déposer un fichier »). */
  titre: string;
  /** Détail exact de ce qui sera fait (commande, chemin, cible). */
  detail: string;
  /** Machine concernée, si l'action en vise une. */
  machine?: string;
  /** Options proposées (au moins « approuver » et « refuser »). */
  options: readonly ChatApprovalOption[];
  /** Instant d'expiration (ISO), si la demande en a un. */
  expireAt?: string;
}

/**
 * Message SORTANT vers une plateforme.
 *
 * ⚠️ `send` n'accepte pas « du texte ou n'importe quoi » : l'union est TYPÉE,
 * pour que le relais d'approbations (lot 3) n'invente pas un second canal.
 */
export type ChatOutboundMessage =
  | {
      kind: "texte";
      text: string;
      threadRootId?: string;
      /**
       * Identifiants de fichiers du STORE de Yuki à joindre au message.
       *
       * ⚠️ Ce sont des identifiants `src/files` (jamais des chemins) : la plateforme
       * lève les octets par son port de fichiers, sans lire le disque. Un fichier
       * refusé (absent, expiré, trop lourd) n'empêche PAS le texte de partir — il est
       * ANNONCÉ (journal + raison visible).
       */
      fichiers?: readonly string[];
      /**
       * Identifiants d'utilisateurs dont la MENTION NATIVE est autorisée.
       *
       * ⚠️ Discord neutralise les mentions d'un message de bot par défaut
       * (`allowed_mentions: { parse: [] }`) : sans cette liste, un `<@identifiant>` posé
       * dans le texte s'afficherait SANS notifier personne. La liste est BORNEÉE à ces
       * identifiants précis : ni `@everyone`, ni un rôle ne peuvent être déclenchés.
       *
       * Ignoré par les plateformes qui n'ont pas de neutralisation à lever (Mattermost).
       */
      mentionUserIds?: readonly string[];
    }
  | { kind: "approbation"; approval: ChatApprovalRequest; threadRootId?: string }
  | {
      /** Résultat d'une action approuvée (compte rendu lisible côté plateforme). */
      kind: "approbation_resultat";
      approvalId: string;
      resume: string;
      ok: boolean;
    };

/** Décision d'approbation prise DEPUIS une plateforme (lot 3 la branche). */
export interface ChatApprovalDecision {
  approvalId: string;
  /** Identifiant de l'option choisie (`ChatApprovalOption.id`). */
  optionId: string;
  /** Auteur de la décision chez la plateforme (audit ; jamais une valeur secrète). */
  authorId: string;
}

/** Options de lecture d'une page de messages (curseur OPAQUE, propre à la plateforme). */
export interface ChatFetchOptions {
  /** Curseur rendu par l'appel précédent. Absent = depuis le début. */
  cursor?: string;
  /** Nombre maximal de messages demandés (borne dure côté adaptateur). */
  limit?: number;
}

/** Une page de messages + le curseur à repasser la fois suivante. */
export interface ChatFetchPage {
  messages: RemoteMessage[];
  /** Absent = il n'y a plus rien à lire. */
  cursor?: string;
}

/**
 * Contrat d'une plateforme.
 *
 * ⚠️ Ce que l'adaptateur ne fait JAMAIS : décider du rôle de Yuki, écrire dans
 * la mémoire, alimenter le modèle (`waker.send`) ou déclencher un tour. Il
 * LIT une plateforme et rend des messages ; le commun s'occupe du reste.
 */
export interface ChatAdapter {
  /** Plateforme de cet adaptateur (`local` pour le mode historique). */
  readonly platform: ChatMode;
  /** Ouvre la connexion (idempotent). */
  connect(): Promise<void>;
  /** Ferme la connexion (idempotent). */
  disconnect(): Promise<void>;
  /** État courant — synchrone : l'interface interroge souvent, sans attente. */
  status(): ChatAdapterStatus;
  /** Conversations accessibles (vide si la plateforme n'est pas configurée). */
  listConversations(): Promise<RemoteConversation[]>;
  /** Page de messages d'une conversation (identifiant Yuki préfixé). */
  fetchMessages(conversationId: string, options?: ChatFetchOptions): Promise<ChatFetchPage>;
  /**
   * Envoi d'un message (texte, demande d'approbation, compte rendu) — ABSENT
   * quand la plateforme n'accepte aucune écriture (c'est le cas de TOUTES les
   * plateformes au lot 1).
   *
   * ⚠️ Le relais d'approbations n'est PAS implémenté au lot 1 : la signature est
   * typée dès maintenant pour qu'il n'y ait pas de refonte au lot 3.
   */
  send?(conversationId: string, message: ChatOutboundMessage): Promise<RemoteMessage>;
  /**
   * RÉVEIL du canal par un RAPPORT SYSTÈME (fin d'une tâche d'arrière-plan).
   *
   * ⚠️ INVARIANT (`docs/lot18-chat.md`) : **dans un canal, un seul rédacteur — le
   * tour de Yuki**. Cette méthode ne publie donc PAS le rapport : elle l'INJECTE
   * comme message déclencheur d'un tour de Yuki, et c'est la RÉPONSE de ce tour qui
   * est publiée (avec les fichiers du job).
   *
   * Lève quand le tour n'a pas pu avoir lieu (générateur absent, canal supprimé,
   * publication impossible) : c'est l'appelant (`src/chat/reply/channel-waker.ts`)
   * qui décide du REPLI (publier le rapport en texte, en le disant).
   *
   * Absent = la plateforme ne sait pas réveiller Yuki : le réveil retombe alors
   * sur le repli texte, jamais sur un silence.
   */
  wakeReport?(input: ChatWakeRequest): Promise<void>;
  /**
   * Décisions d'approbation prises DEPUIS la plateforme (« Approuver » cliqué
   * dans le canal). Absent = la plateforme ne sait pas le faire (état du lot 1).
   */
  subscribeApprovalDecisions?(
    conversationId: string,
    listener: (decision: ChatApprovalDecision) => void,
  ): () => void;
  /** Abonnement aux nouveaux messages d'une conversation ; rend le désabonnement. */
  subscribe(conversationId: string, listener: (message: RemoteMessage) => void): () => void;
  /** Abonnement aux CHANGEMENTS D'ÉTAT de la plateforme, si elle sait le faire. */
  subscribeState?(listener: (status: ChatAdapterStatus) => void): () => void;
}

/**
 * Générateur de RÉPONSE d'un canal distant : `transcript + message → texte`
 * (injecté par le câblage, jamais deviné par l'adaptateur).
 *
 * ⚠️ COMMUN aux plateformes : Mattermost et Discord reçoivent EXACTEMENT la même
 * fabrique (`createRemoteReplyGenerator`, `src/chat/reply/generate.ts`). Un générateur
 * par plateforme aurait dupliqué la politique d'outils et le prompt.
 *
 * ⚠️ Il peut aussi rendre des FICHIERS à joindre : un run distant peut GÉNÉRER UNE IMAGE
 * (`generer_image`), et cette image doit arriver dans le canal. Les identifiants sont
 * ceux du STORE de Yuki (jamais un chemin disque) : chaque adaptateur lève les octets par
 * son port de fichiers, puis les joint selon SA mécanique (Mattermost : `POST /files`
 * puis `file_ids` ; Discord : multipart dans le même appel).
 */
/**
 * Demande de RÉVEIL d'un canal par un rapport de tâche.
 *
 * ⚠️ `texte` est le message SYSTÈME complet, déjà encadré
 * (`frameRapportSysteme`, `src/chat/reply/job-report.ts`) : l'adaptateur ne le
 * réécrit pas, il le fait lire par Yuki.
 */
export interface ChatWakeRequest {
  /** Conversation Yuki du canal (`mm-…` / `dc-…`). */
  conversationId: string;
  /** Message système injecté (rapport encadré + identifiants de fichiers). */
  texte: string;
  /** Identifiant du job (traçabilité du tour, jamais affiché tel quel). */
  jobId?: string;
  /**
   * Fichiers produits par la tâche (identifiants du STORE, pas des chemins).
   * ⚠️ Ils sont joints à la réponse de Yuki SAUF s'ils ont été publiés ailleurs
   * dans le tour (`publier_dans_canal`) — aucun fichier ne part deux fois.
   */
  fichiers?: readonly string[];
}

export type ChatReplyGenerator = (input: {
  channelTitle: string;
  transcript: readonly RemoteMessage[];
  message: RemoteMessage;
  /**
   * IMAGES de pièces jointes du message (déjà bornées par la politique de vision).
   * ⚠️ Absent = message sans image, ou vision indisponible : le prompt reste du texte.
   */
  images?: readonly FileImageContent[];
  /**
   * Ce qui n'a PAS pu être joint (fichier non image, trop lourd, illisible) — phrases
   * françaises transmises au rédacteur pour qu'il réponde en connaissance de cause.
   */
  notes?: readonly string[];
  /**
   * Publication INTERMÉDIAIRE (accusé avant une action, image dès sa production,
   * ligne d'échec) dans le canal — déjà ancrée au bon fil par l'adaptateur.
   *
   * ⚠️ Absente ⇒ un seul message à la fin, comportement antérieur inchangé.
   */
  publier?: (message: { text: string; fichiers?: readonly string[] }) => Promise<void>;
  /**
   * ORIGINE du tour : `job` = le message déclencheur est un RAPPORT SYSTÈME.
   *
   * ⚠️ Un tour né d'un rapport ne DÉLÈGUE pas (aucune nouvelle tâche : c'est ce qui
   * rend la boucle de rédélégation structurellement impossible, pas seulement
   * déconseillée par le prompt).
   */
  origine?: "message" | "job";
  /** Fichiers produits par la tâche (identifiants du store de cette conversation). */
  fichiersDuJob?: readonly string[];
}) => Promise<string | { text: string; fichiers?: readonly string[] }>;
