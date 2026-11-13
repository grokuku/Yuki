/**
 * Service de DISCUSSION — la façade que consomment l'API HTTP et le transport
 * temps réel (lot 18, lot 1).
 *
 * Il ne fait que trois choses :
 *  1. LIRE les INTERRUPTEURS de plateforme (`chat.<plateforme>.enabled`, `apply:
 *     hot`) et rendre l'adaptateur de la plateforme DEMANDÉE (⚠️ câblé, pas
 *     seulement déclaré) — le LOCAL n'est pas un interrupteur : il est toujours
 *     disponible ;
 *  2. rendre l'ÉTAT d'une plateforme (`{ etat, raison?, dernierContact? }`) et
 *     le MOTIF qui interdit de créer une conversation locale (toujours `null`
 *     depuis que le local n'est plus un mode qu'on quitte) ;
 *  3. donner accès au MIROIR en lecture seule.
 *
 * ⚠️ Aucun secret, aucun jeton, aucune URL d'API ne sort d'ici : le statut ne
 * porte que des mots et des états.
 */

import { ChatAdapterError, getAdapter } from "./adapter.js";
import { emptyChatMirror, type ChatMirror } from "./mirror.js";
import { DISCORD_NOT_CONFIGURED_REASON } from "./discord/adapter.js";
import {
  CHAT_MODES,
  type ChatAdapter,
  type ChatAdapterStatus,
  type ChatMode,
  type RemoteConversation,
  type RemoteMessage,
} from "./types.js";

export interface ChatServiceOptions {
  /**
   * Lit `chat.mode` dans la configuration (relu à CHAQUE appel : `apply: hot`).
   *
   * ⚠️ LEGACY (2026-11-10) : cette valeur n'est PLUS une décision. Les
   * plateformes sont indépendantes (`enabled`) et `local` n'est plus un choix.
   * Elle reste lue pour l'affichage de compatibilité (`status().mode`).
   */
  mode: () => string;
  /**
   * Lit l'INTERRUPTEUR d'une plateforme distante (`chat.<plateforme>.enabled`).
   *
   * ⚠️ C'est la SEULE décision d'activation : un jeton posé sans `on` n'ouvre
   * aucune connexion. Absent = aucune plateforme distante activée (le local
   * reste, lui, toujours disponible : il n'est pas un réglage).
   */
  enabled?: (plateforme: ChatPlatformId) => boolean;
  /**
   * Lit `chat.remoteAgents` (`desactive` | `actives`). Absent = `desactive` :
   * la sécurité est le DÉFAUT, jamais l'inverse.
   */
  remoteAgents?: () => string;
  /**
   * Lit `chat.remoteTools` (`desactive` | `actives`) — SECOND réglage, INDÉPENDANT
   * du précédent : image, libraire, archives. Absent = `desactive`.
   */
  remoteTools?: () => string;
  /** Miroir des canaux synchronisés. Absent = miroir VIDE (état du lot 1). */
  mirror?: ChatMirror;
}

/** Plateforme DISTANTE (le local n'est pas une plateforme : il est toujours là). */
export type ChatPlatformId = "mattermost" | "discord";

/** Plateformes distantes connues, dans l'ordre d'affichage. */
export const PLATEFORMES_DISTANTES: readonly ChatPlatformId[] = ["mattermost", "discord"];

/** Mode d'une capacité distante (agents ou outils). */
export type ChatRemoteCapability = "desactive" | "actives";

/** Vue d'état consommée par l'interface (`GET /api/chat/status`). */
export interface ChatStatusView {
  /**
   * ⚠️ LEGACY : dernière valeur écrite de `chat.mode`. Ne décide PLUS rien (ni
   * affichage, ni connexion) — conservé pour les clients existants.
   */
  mode: ChatMode;
  /**
   * INTERRUPTEURS des plateformes distantes (`chat.<plateforme>.enabled`).
   *
   * ⚠️ Le LOCAL n'y figure pas : il n'est pas activable/désactivable, il est
   * TOUJOURS disponible. Une plateforme `true` sans jeton ne se connecte pas
   * (`mattermost`/`discord` disent `jetonEnregistre`).
   */
  plateformes: { mattermost: boolean; discord: boolean };
  /** État de la plateforme interrogée (compatibilité de l'ancien badge). */
  plateforme: ChatAdapterStatus;
  /**
   * Capacités des conversations DISTANTES — lues dans la configuration, jamais
   * devinées. Sert à l'interface pour DIRE ce qui est actif (et pas seulement à
   * le cacher).
   *
   * ⚠️ Il n'y a PLUS de `memoire` ici : la mémoire durable d'un canal n'est pas
   * branchée, et `chat.remoteMemory` a été RETIRÉ (réglage sans consommateur =
   * mensonge d'interface). Un champ d'état qui afficherait « désactivée » sans
   * que rien ne puisse l'activer serait le même mensonge, une couche plus bas.
   * ⚠️ DEUX RÉGLAGES INDÉPENDANTS depuis le 2026-11-02 : `agents` (délégation,
   * annuaire, coffre — tout ce qui ATTEINT une machine appairée) et `outils`
   * (image, libraire, archives — rien qui touche une machine). Les fondre en un
   * seul champ obligerait l'interface à DEVINER, et « image oui / agents non »
   * était impossible avant ce découpage.
   */
  distant: { agents: ChatRemoteCapability; outils: ChatRemoteCapability };
  /**
   * Création d'une conversation LOCALE.
   *
   * ⚠️ TOUJOURS `autorisee: true` depuis 2026-11-10 : le local n'est plus un
   * mode qu'on peut quitter, donc plus rien ne le refuse. Le champ est CONSERVÉ
   * parce que le transport et l'interface le lisent (`creationRefusal`) — un
   * refus calculé ici reste la seule autorité si un jour une raison revient.
   */
  creation: { autorisee: boolean; raison?: string };
}

/**
 * Motif affiché quand aucun adaptateur n'est câblé pour le mode courant.
 *
 * ⚠️ Mattermost EST livré (lot 2) : ce motif ne doit apparaître que si le serveur
 * n'a pas enregistré son fournisseur d'adaptateur (démarrage incomplet). Il dit donc
 * quoi FAIRE, il ne promet pas un lot futur.
 */
const MISSING_ADAPTER_REASON =
  "La connexion à Mattermost n'est pas active : renseignez l'URL du serveur et le " +
  "jeton du bot dans /config → Conversation → « Discussions — Mattermost », puis " +
  "cliquez sur « Se connecter ».";

/** Normalise une valeur brute de configuration en mode connu. */
function normalizeMode(raw: string): ChatMode {
  const value = raw.trim();
  return (CHAT_MODES as readonly string[]).includes(value) ? (value as ChatMode) : "local";
}

export class ChatService {
  private readonly readMode: () => string;
  private readonly readEnabled: (plateforme: ChatPlatformId) => boolean;
  private readonly readRemoteAgents: () => string;
  private readonly readRemoteTools: () => string;
  private readonly mirror: ChatMirror;

  constructor(options: ChatServiceOptions) {
    this.readMode = options.mode;
    this.readEnabled = options.enabled ?? (() => false);
    this.readRemoteAgents = options.remoteAgents ?? (() => "desactive");
    this.readRemoteTools = options.remoteTools ?? (() => "desactive");
    this.mirror = options.mirror ?? emptyChatMirror();
  }

  /**
   * Plateforme distante ACTIVÉE ? (`chat.<plateforme>.enabled === "on"`).
   *
   * ⚠️ Le LOCAL n'est pas ici : il n'est pas un réglage, il est toujours
   * disponible — c'est exactement ce que la régression « choisir une des trois
   * plateformes » avait cassé.
   */
  estActive(plateforme: ChatPlatformId): boolean {
    return this.readEnabled(plateforme) === true;
  }

  /** Plateformes distantes activées, dans l'ordre d'affichage (0, 1 ou 2). */
  plateformesActives(): ChatPlatformId[] {
    return PLATEFORMES_DISTANTES.filter((plateforme) => this.estActive(plateforme));
  }

  /** `chat.remoteAgents` : les agents sont-ils autorisés sur une conversation distante ? */
  remoteAgents(): ChatRemoteCapability {
    return this.readRemoteAgents() === "actives" ? "actives" : "desactive";
  }

  /** `chat.remoteTools` : les outils (image, libraire, archives) sont-ils ouverts ? */
  remoteTools(): ChatRemoteCapability {
    return this.readRemoteTools() === "actives" ? "actives" : "desactive";
  }

  /** Mode courant (relu à chaque appel). ⚠️ LEGACY : ne décide plus rien. */
  mode(): ChatMode {
    return normalizeMode(this.readMode());
  }

  /**
   * ⚠️ `false` en PERMANENCE depuis 2026-11-10.
   *
   * Le local n'est plus un mode qu'on peut quitter : il est là même quand
   * Mattermost ET Discord sont activés (c'était le comportement d'avant la
   * régression). L'ancienne garde `CREATION_REFUSALS` est donc RETIRÉE — elle
   * n'avait de sens que parce que `chat.mode` était exclusif. La méthode et le
   * champ d'état restent (contrat du transport et de l'interface) : si une raison
   * de refuser réapparaissait, le calcul est déjà ici, à une seule source.
   */
  isRemote(): boolean {
    return false;
  }

  /** Adaptateur de la plateforme DEMANDÉE (ou du mode legacy si absent). */
  adapter(plateforme?: ChatPlatformId): ChatAdapter | null {
    try {
      return getAdapter(plateforme ?? this.mode());
    } catch (error) {
      if (error instanceof ChatAdapterError) return null;
      throw error;
    }
  }

  /** Motif du refus de créer une conversation locale ; `null` (jamais refusée ici). */
  creationRefusal(): string | null {
    return null;
  }

  /**
   * État de la plateforme interrogée.
   *
   * ⚠️ Plus de « mode courant » : on décrit une PLATEFORME. Sans argument, on
   * prend la première plateforme activée (compatibilité de l'ancien badge) — et
   * `local` quand aucune ne l'est, ce qui est un état normal, pas une panne.
   */
  platformStatus(plateforme?: ChatPlatformId): ChatAdapterStatus {
    const cible = plateforme ?? this.plateformesActives()[0];
    if (cible === undefined) {
      return { etat: "on", raison: "Conversations locales : aucune plateforme distante activée." };
    }
    const adapter = this.adapter(cible);
    const base: ChatAdapterStatus =
      adapter !== null
        ? adapter.status()
        : {
            etat: "off",
            raison:
              cible === "discord"
                ? DISCORD_NOT_CONFIGURED_REASON
                : MISSING_ADAPTER_REASON,
          };
    // `dernierContact` : la plus récente activité CONNUE du miroir pour cette
    // plateforme. Absent tant qu'aucun canal n'a jamais été synchronisé — jamais
    // une date inventée.
    const contact = this.lastContactOf(cible);
    return { ...base, ...(contact !== undefined ? { dernierContact: contact } : {}) };
  }

  /** Vue complète (`GET /api/chat/status`). */
  status(): ChatStatusView {
    return {
      mode: this.mode(),
      plateformes: {
        mattermost: this.estActive("mattermost"),
        discord: this.estActive("discord"),
      },
      plateforme: this.platformStatus(),
      // ⚠️ La création locale n'est JAMAIS refusée : le local est toujours là.
      creation: { autorisee: true },
      distant: { agents: this.remoteAgents(), outils: this.remoteTools() },
    };
  }

  /** Conversations MIROIR disponibles (toutes plateformes confondues). */
  conversations(): readonly RemoteConversation[] {
    return this.mirror.conversations();
  }

  /** Conversation miroir par identifiant Yuki (`mm-…`), ou `null`. */
  conversation(conversationId: string): RemoteConversation | null {
    return this.mirror.conversations().find((item) => item.id === conversationId) ?? null;
  }

  /** Messages d'une conversation miroir (ordre chronologique). */
  messages(conversationId: string): readonly RemoteMessage[] {
    return this.mirror.messages(conversationId);
  }

  /**
   * S'abonne aux changements du MIROIR (message ajouté, canal découvert, backfill
   * terminé). Rend le désabonnement, ou `undefined` si le miroir ne sait pas le faire
   * (miroir vide du lot 1).
   *
   * ⚠️ Aucun contenu de message ne circule ici : seule la NOTIFICATION « quelque chose
   * a changé dans cette conversation » — le transport relit lui-même ce qu'il doit
   * envoyer.
   */
  subscribe(listener: (conversationId?: string) => void): (() => void) | undefined {
    return this.mirror.onChange?.(listener);
  }

  /** Plus récente activité connue du miroir pour une plateforme (ISO). */
  private lastContactOf(plateforme: ChatPlatformId): string | undefined {
    let latest: string | undefined;
    for (const conversation of this.mirror.conversations()) {
      if (conversation.platform !== plateforme) continue;
      if (conversation.updatedAt === undefined) continue;
      if (latest === undefined || conversation.updatedAt > latest) latest = conversation.updatedAt;
    }
    return latest;
  }
}
