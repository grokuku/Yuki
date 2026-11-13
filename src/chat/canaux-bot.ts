/**
 * CANAUX PAR BOT (lot 36, morceau L5) — deux règles, et elles suffisent.
 *
 *  1. **Chaque bot ne voit QUE son miroir.** Jusqu'à L4, `canaux()` du port de
 *     publication lisait le miroir de l'INSTANCE (`src/index.ts`) : un bot
 *     secondaire qui publiait proposait donc les canaux d'un autre — et, pire,
 *     pouvait y écrire. Le miroir est pourtant un chemin PAR BOT
 *     (`chatMirrorPath` / `chatMirrorDir`, `src/bots/paths.ts`) : chaque bot a
 *     SES conversations (`mm-…` / `dc-…`), servies par SON adaptateur.
 *  2. **Un canal n'a qu'UN bot.** Deux bots abonnés au même canal répondraient
 *     deux fois au même message. La propriété est donc PERSISTÉE
 *     (`chat-canaux-proprietaires.json`, à la racine du volume `state` — c'est
 *     une propriété de l'INSTANCE, pas d'un bot) et vérifiée AVANT toute
 *     publication : le refus NOMME le propriétaire.
 *
 * ⚠️ La propriété se prend à la PREMIÈRE publication réussie d'un bot dans le
 * canal (`revendiquer`), pas à la synchronisation : un canal découvert par deux
 * bots reste libre jusqu'à ce que l'un d'eux y écrive. C'est la seule règle qui
 * ne dépend pas de l'ordre d'arrivée des messages, et elle est réversible
 * (`liberer`) — sans jamais réécrire un miroir.
 *
 * ⚠️ Un bot ARRÊTÉ (L9) garde ses canaux : les libérer ferait basculer
 * silencieusement ses conversations vers un autre bot au prochain démarrage.
 *
 * Aucun import SDK/typebox.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { ChannelPostChannel } from "../pi/index.js";

/** Nom du fichier de propriété, à la racine du volume `state`. */
export const FICHIER_PROPRIETAIRES_CANAUX = "chat-canaux-proprietaires.json";

/** Version du format persisté (une migration se verrait ici). */
export const PROPRIETAIRES_CANAUX_VERSION = 1;

/** Journal minimal attendu (le `Logger` de l'application le satisfait). */
export interface CanauxBotLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

/** Conversation telle qu'un miroir la rend (on n'a besoin que de trois champs). */
export interface ConversationMiroir {
  readonly id: string;
  readonly title: string;
  readonly platform: string;
}

/** Un miroir de canaux : ce que sait faire `ChatMirrorStore`. */
export interface MiroirCanaux {
  conversations(): readonly ConversationMiroir[];
}

/** Contenu persisté. */
interface FichierProprietaires {
  version: number;
  /** `conversationId` → `botId`. */
  canaux: Record<string, string>;
}

/** Message de refus : il NOMME le bot propriétaire (jamais un « non » sec). */
export function messageCanalAutreBot(
  conversationId: string,
  proprietaire: string,
  titre?: string,
): string {
  const canal = titre !== undefined && titre !== "" ? `« ${titre} »` : `« ${conversationId} »`;
  return (
    `Rien n'a été publié : le canal ${canal} appartient au bot « ${proprietaire} ». ` +
    "Un canal n'a qu'un seul bot (sinon deux réponses partent pour le même message) : " +
    `écris dans un canal de ton bot, ou retire ${conversationId} du bot « ${proprietaire} ».`
  );
}

/** Chemin du fichier de propriété pour un volume `state`. */
export function cheminProprietairesCanaux(stateDir: string): string {
  return `${stateDir.replace(/\/+$/u, "")}/${FICHIER_PROPRIETAIRES_CANAUX}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * PROPRIÉTÉ DES CANAUX — persistée, relue à chaque démarrage.
 *
 * ⚠️ Un fichier illisible n'empêche pas le démarrage : il est SIGNALÉ et
 * considéré comme vide (les canaux seront revendiqués au premier envoi). Un
 * refus de démarrer sur un fichier de confort serait disproportionné — alors
 * qu'une propriété perdue ne peut produire qu'un doublon VISIBLE, jamais une
 * perte de données.
 */
export class ProprietairesCanaux {
  readonly path: string;
  private readonly logger?: CanauxBotLogger;
  private canaux: Record<string, string> = {};

  private constructor(options: { path: string; logger?: CanauxBotLogger }) {
    this.path = options.path;
    this.logger = options.logger;
  }

  /** Ouvre (et crée au premier enregistrement) le fichier de propriété. */
  static open(options: { path: string; logger?: CanauxBotLogger }): ProprietairesCanaux {
    const store = new ProprietairesCanaux(options);
    store.charger();
    return store;
  }

  /** Construit un registre EN MÉMOIRE (tests : aucun accès disque). */
  static enMemoire(
    canaux: Record<string, string> = {},
    options: { logger?: CanauxBotLogger } = {},
  ): ProprietairesCanaux {
    const store = new ProprietairesCanaux({
      path: "",
      ...(options.logger !== undefined ? { logger: options.logger } : {}),
    });
    store.canaux = { ...canaux };
    return store;
  }

  private charger(): void {
    if (this.path === "" || !existsSync(this.path)) return;
    try {
      const brut = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      const canaux = (brut as { canaux?: unknown }).canaux;
      if (!canaux || typeof canaux !== "object" || Array.isArray(canaux)) {
        this.logger?.warn("chat.canaux.proprietaires.invalide", { path: this.path });
        return;
      }
      const propres: Record<string, string> = {};
      for (const [id, bot] of Object.entries(canaux as Record<string, unknown>)) {
        if (typeof bot === "string" && bot.trim() !== "") propres[id] = bot;
      }
      this.canaux = propres;
    } catch (error) {
      this.logger?.warn("chat.canaux.proprietaires.illisible", {
        path: this.path,
        error: messageOf(error),
      });
    }
  }

  /** Bot propriétaire d'un canal, ou `undefined` (canal libre). */
  proprietaire(conversationId: string): string | undefined {
    return this.canaux[conversationId];
  }

  /** Canaux d'un bot (copie défensive). */
  canauxDe(botId: string): string[] {
    return Object.entries(this.canaux)
      .filter(([, proprietaire]) => proprietaire === botId)
      .map(([id]) => id);
  }

  /** Vue complète (`conversationId` → `botId`), pour le diagnostic et les routes. */
  tout(): Record<string, string> {
    return { ...this.canaux };
  }

  /**
   * Revendique un canal pour un bot.
   *
   * - canal LIBRE ⇒ écrit (persisté) et rend `{ ok: true, nouveau: true }` ;
   * - canal déjà AU MÊME bot ⇒ `{ ok: true, nouveau: false }`, aucune écriture ;
   * - canal d'un AUTRE bot ⇒ refus qui le NOMME (aucune écriture).
   */
  revendiquer(
    conversationId: string,
    botId: string,
  ):
    | { ok: true; nouveau: boolean }
    | { ok: false; proprietaire: string; raison: string } {
    const id = conversationId.trim();
    const bot = botId.trim();
    if (id === "" || bot === "") {
      throw new Error("Revendication de canal : identifiant et bot sont obligatoires.");
    }
    const proprietaire = this.canaux[id];
    if (proprietaire === bot) return { ok: true, nouveau: false };
    if (proprietaire !== undefined) {
      return {
        ok: false,
        proprietaire,
        raison: messageCanalAutreBot(id, proprietaire),
      };
    }
    this.canaux = { ...this.canaux, [id]: bot };
    this.persist();
    this.logger?.info("chat.canal.proprietaire", { canal: id, bot });
    return { ok: true, nouveau: true };
  }

  /** Libère un canal (retour `true` si une propriété a été retirée). */
  liberer(conversationId: string): boolean {
    if (this.canaux[conversationId] === undefined) return false;
    const suivant = { ...this.canaux };
    delete suivant[conversationId];
    this.canaux = suivant;
    this.persist();
    return true;
  }

  private persist(): void {
    if (this.path === "") return;
    const fichier: FichierProprietaires = {
      version: PROPRIETAIRES_CANAUX_VERSION,
      canaux: this.canaux,
    };
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const temporaire = `${this.path}.tmp`;
      writeFileSync(temporaire, `${JSON.stringify(fichier, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporaire, this.path);
      chmodSync(this.path, 0o600);
    } catch (error) {
      // ⚠️ La propriété n'est PAS perdue en mémoire : le prochain enregistrement
      // réessaiera. On le DIT, sans faire échouer la publication en cours.
      this.logger?.warn("chat.canaux.proprietaires.ecriture_echouee", {
        path: this.path,
        error: messageOf(error),
      });
    }
  }
}

/** Verdict d'appartenance d'un canal à un bot. */
export type VerdictCanal = { ok: true } | { ok: false; raison: string };

export interface OptionsCanauxBots<M extends MiroirCanaux> {
  /** Bot de la PILE : son miroir est celui que `main()` a déjà ouvert. */
  readonly botDuRun: string;
  /** Miroir d'un bot (mémoïsé par CETTE classe : la fabrique peut être coûteuse). */
  readonly miroir: (botId: string) => M | undefined;
  readonly proprietaires: ProprietairesCanaux;
  readonly logger?: CanauxBotLogger;
}

/**
 * Les canaux d'un bot — **son** miroir, et seulement ses canaux.
 *
 * ⚠️ Deux filtres, dans cet ordre :
 *  1. le miroir du bot (un fichier par bot) ;
 *  2. la propriété persistée : un canal d'un AUTRE bot n'est jamais proposé,
 *     même s'il apparaissait dans ce miroir (adaptateur mal configuré, miroir
 *     copié à la main). C'est ce qui garantit « un canal = un bot » côté LISTE,
 *     avant même le refus de publication.
 */
export class CanauxBots<M extends MiroirCanaux = MiroirCanaux> {
  private readonly options: OptionsCanauxBots<M>;
  private readonly miroirs = new Map<string, M | undefined>();

  constructor(options: OptionsCanauxBots<M>) {
    this.options = options;
  }

  /** Miroir d'un bot (construit au plus une fois, puis mémorisé). */
  miroirDe(botId: string): M | undefined {
    if (this.miroirs.has(botId)) return this.miroirs.get(botId);
    const miroir = this.options.miroir(botId);
    this.miroirs.set(botId, miroir);
    return miroir;
  }

  /** Bots dont le miroir a été construit (diagnostic, arrêt ciblé). */
  miroirsConstruits(): string[] {
    return [...this.miroirs.keys()];
  }

  /**
   * Canaux PROPOSABLES à ce bot : son miroir, moins les canaux d'un autre bot.
   *
   * `botId` absent du miroir (aucun `Env` résolvable) ⇒ liste VIDE : mieux vaut
   * un bot qui ne propose rien qu'un bot qui propose ceux d'un autre.
   */
  canaux(botId: string): ChannelPostChannel[] {
    const miroir = this.miroirDe(botId);
    if (miroir === undefined) return [];
    const sortie: ChannelPostChannel[] = [];
    for (const conversation of miroir.conversations()) {
      const proprietaire = this.options.proprietaires.proprietaire(conversation.id);
      if (proprietaire !== undefined && proprietaire !== botId) {
        this.options.logger?.warn("chat.canal.autre_bot_ignore", {
          bot: botId,
          canal: conversation.id,
          proprietaire,
        });
        continue;
      }
      sortie.push({
        conversationId: conversation.id,
        titre: conversation.title,
        plateforme: conversation.platform,
      });
    }
    return sortie;
  }

  /**
   * Ce bot peut-il publier dans ce canal ? (contrôle AVANT publication)
   *
   * ⚠️ Un canal LIBRE est revendiqué ici même : la première publication d'un
   * bot l'enregistre comme propriétaire. Le refus d'un canal déjà pris NOMME le
   * propriétaire — c'est le seul message qui empêche deux réponses.
   */
  revendiquerEtAutoriser(botId: string, conversationId: string): VerdictCanal {
    const verdict = this.options.proprietaires.revendiquer(conversationId, botId);
    if (verdict.ok) return { ok: true };
    this.options.logger?.warn("chat.canal.refuse", {
      bot: botId,
      canal: conversationId,
      proprietaire: verdict.proprietaire,
    });
    return { ok: false, raison: verdict.raison };
  }

  /** Contrôle SANS écrire (diagnostic, routes, tests). */
  autoriser(botId: string, conversationId: string): VerdictCanal {
    const proprietaire = this.options.proprietaires.proprietaire(conversationId);
    if (proprietaire === undefined || proprietaire === botId) return { ok: true };
    return { ok: false, raison: messageCanalAutreBot(conversationId, proprietaire) };
  }

  /**
   * Oublie le miroir d'un bot (arrêt ciblé, L9) : le prochain appel le rouvrira.
   * ⚠️ Les propriétés ne sont pas touchées : les canaux du bot restent les siens.
   */
  oublier(botId: string): boolean {
    if (botId === this.options.botDuRun) return false;
    return this.miroirs.delete(botId);
  }
}
