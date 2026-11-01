/**
 * Service de DISCUSSION — la façade que consomment l'API HTTP et le transport
 * temps réel (lot 18, lot 1).
 *
 * Il ne fait que trois choses :
 *  1. LIRE le mode (`chat.mode`, `apply: hot`) et rendre l'adaptateur qui y
 *     correspond (⚠️ câblé, pas seulement déclaré) ;
 *  2. rendre l'ÉTAT de la plateforme (`{ etat, raison?, dernierContact? }`) et
 *     le MOTIF qui interdit de créer une conversation locale dans ce mode ;
 *  3. donner accès au MIROIR en lecture seule (vide au lot 1).
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
  /** Lit `chat.mode` dans la configuration (relu à CHAQUE appel : `apply: hot`). */
  mode: () => string;
  /**
   * Lit `chat.remoteAgents` (`desactive` | `actives`). Absent = `desactive` :
   * la sécurité est le DÉFAUT, jamais l'inverse.
   */
  remoteAgents?: () => string;
  /**
   * Lit `chat.remoteMemory` (`desactive` | `actives`). Absent = `desactive`.
   * ⚠️ Réglage seul au lot 1 : la mémoire des conversations distantes n'est pas
   * branchée (lot 2/3).
   */
  remoteMemory?: () => string;
  /** Miroir des canaux synchronisés. Absent = miroir VIDE (état du lot 1). */
  mirror?: ChatMirror;
}

/** Mode d'une capacité distante (agents, mémoire). */
export type ChatRemoteCapability = "desactive" | "actives";

/** Vue d'état consommée par l'interface (`GET /api/chat/status`). */
export interface ChatStatusView {
  mode: ChatMode;
  plateforme: ChatAdapterStatus;
  /**
   * Capacités des conversations DISTANTES — lues dans la configuration, jamais
   * devinées. Sert à l'interface pour DIRE ce qui est actif (et pas seulement à
   * le cacher).
   */
  distant: { agents: ChatRemoteCapability; memoire: ChatRemoteCapability };
  /**
   * Création d'une conversation LOCALE.
   *
   * ⚠️ Le refus est calculé ICI, pas seulement masqué en CSS : le transport
   * refuse lui aussi un message `new` tant que le mode est distant (même
   * source de vérité).
   */
  creation: { autorisee: boolean; raison?: string };
}

/** Motif du refus de création, par mode distant. */
const CREATION_REFUSALS: Record<Exclude<ChatMode, "local">, string> = {
  mattermost:
    "En mode Mattermost, les conversations viennent des canaux synchronisés : " +
    "la création d'une conversation locale est désactivée. Écrivez dans un canal " +
    "Mattermost : Yuki y répondra selon le mode de réponse du canal.",
  discord:
    "Discord n'est pas encore configuré — ce mode ne fait rien pour l'instant : " +
    "la création d'une conversation locale est désactivée.",
};

/**
 * Motif affiché quand aucun adaptateur n'est câblé pour le mode courant.
 *
 * ⚠️ Mattermost EST livré (lot 2) : ce motif ne doit apparaître que si le serveur
 * n'a pas enregistré son fournisseur d'adaptateur (démarrage incomplet). Il dit donc
 * quoi FAIRE, il ne promet pas un lot futur.
 */
const MISSING_ADAPTER_REASON =
  "La connexion à Mattermost n'est pas active : renseignez l'URL du serveur et le " +
  "jeton du bot dans /config → Discussions, puis cliquez sur « Se connecter ».";

/** Normalise une valeur brute de configuration en mode connu. */
function normalizeMode(raw: string): ChatMode {
  const value = raw.trim();
  return (CHAT_MODES as readonly string[]).includes(value) ? (value as ChatMode) : "local";
}

export class ChatService {
  private readonly readMode: () => string;
  private readonly readRemoteAgents: () => string;
  private readonly readRemoteMemory: () => string;
  private readonly mirror: ChatMirror;

  constructor(options: ChatServiceOptions) {
    this.readMode = options.mode;
    this.readRemoteAgents = options.remoteAgents ?? (() => "desactive");
    this.readRemoteMemory = options.remoteMemory ?? (() => "desactive");
    this.mirror = options.mirror ?? emptyChatMirror();
  }

  /** `chat.remoteAgents` : les agents sont-ils autorisés sur une conversation distante ? */
  remoteAgents(): ChatRemoteCapability {
    return this.readRemoteAgents() === "actives" ? "actives" : "desactive";
  }

  /** `chat.remoteMemory` : la mémoire durable est-elle autorisée en mode distant ? */
  remoteMemory(): ChatRemoteCapability {
    return this.readRemoteMemory() === "actives" ? "actives" : "desactive";
  }

  /** Mode courant (relu à chaque appel : changement à chaud). */
  mode(): ChatMode {
    return normalizeMode(this.readMode());
  }

  /** `true` si le mode courant est DISTANT (la création locale est alors refusée). */
  isRemote(): boolean {
    return this.mode() !== "local";
  }

  /** Adaptateur du mode courant, ou `null` s'il n'est pas encore livré. */
  adapter(): ChatAdapter | null {
    try {
      return getAdapter(this.mode());
    } catch (error) {
      if (error instanceof ChatAdapterError) return null;
      throw error;
    }
  }

  /** Motif du refus de créer une conversation locale ; `null` en mode local. */
  creationRefusal(): string | null {
    const mode = this.mode();
    return mode === "local" ? null : CREATION_REFUSALS[mode];
  }

  /** État de la plateforme du mode courant. */
  platformStatus(): ChatAdapterStatus {
    const mode = this.mode();
    const adapter = this.adapter();
    const base: ChatAdapterStatus =
      adapter !== null
        ? adapter.status()
        : { etat: "off", raison: mode === "discord" ? DISCORD_NOT_CONFIGURED_REASON : MISSING_ADAPTER_REASON };
    // `dernierContact` : la plus récente activité CONNUE du miroir pour cette
    // plateforme. Absent tant qu'aucun canal n'a jamais été synchronisé — jamais
    // une date inventée.
    const contact = this.lastContactOf(mode);
    return { ...base, ...(contact !== undefined ? { dernierContact: contact } : {}) };
  }

  /** Vue complète (`GET /api/chat/status`). */
  status(): ChatStatusView {
    const refusal = this.creationRefusal();
    return {
      mode: this.mode(),
      plateforme: this.platformStatus(),
      creation: refusal === null ? { autorisee: true } : { autorisee: false, raison: refusal },
      distant: { agents: this.remoteAgents(), memoire: this.remoteMemory() },
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
  private lastContactOf(mode: ChatMode): string | undefined {
    if (mode === "local") return undefined;
    let latest: string | undefined;
    for (const conversation of this.mirror.conversations()) {
      if (conversation.platform !== mode) continue;
      if (conversation.updatedAt === undefined) continue;
      if (latest === undefined || conversation.updatedAt > latest) latest = conversation.updatedAt;
    }
    return latest;
  }
}
