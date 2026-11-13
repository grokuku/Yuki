/**
 * API des DISCUSSIONS (`node:http`, aucun framework).
 *
 * Routes (TOUTES gardées par l'en-tête maison `X-Yuki-Config: 1`, comme `/api/config` :
 * `requireWriteGuards`, qui contrôle aussi `Origin`/`Host` quand ils sont présents) :
 *   GET   /api/chat/status                  → mode, état, capacités, état des plateformes
 *   PUT   /api/chat/mattermost             → { baseUrl } : URL du serveur (ANCIEN paramètre,
 *                                            `chat-mirror.json` → `baseUrl`, surchargé par bot)
 *   PUT   /api/chat/discord                → { guildId?, maxUploadBytes? } : réglages scalaires
 *   POST  /api/chat/<plateforme>/jeton     → { jeton } : écrit le jeton dans le coffre,
 *                                            ⚠️ affiché UNE SEULE FOIS, jamais relu
 *   POST  /api/chat/<plateforme>/connexion → démarre la synchronisation
 *   DELETE /api/chat/<plateforme>/connexion → DÉBRANCHE : efface le jeton du coffre et
 *                                            ARRÊTE la synchronisation — ⚠️ le miroir
 *                                            RESTE (conversations lisibles, réversible)
 *   DELETE /api/chat/<plateforme>/miroir    → SUPPRIME : jeton ET miroir de CETTE
 *                                            plateforme. ⚠️ DESTRUCTIF, IRRÉVERSIBLE :
 *                                            exige `{"confirmation": true}` dans le corps
 *   PATCH /api/chat/conversations/<id>     → { replyMode?, replyStyle?, quoteAuthor? } par canal
 *                                            (`tout`/`auto`/`mention`, `fil`/`nouveau`, `oui`/`non`)
 *
 * ⚠️ POURQUOI LA LECTURE EST GARDÉE AUSSI : la réponse dit QUEL mode est actif, QUELLES
 * URL et canaux sont suivis, et POURQUOI une plateforme est éteinte. Ce n'est pas un
 * secret, mais c'est un état d'installation — une page tierce n'a aucune raison de
 * pouvoir le sonder, et l'interface same-origin pose l'en-tête sans effort.
 *
 * ⚠️ AUCUNE réponse ne porte un jeton : `jetonEnregistre` est un BOOLÉEN, jamais la
 * valeur, jamais un préfixe. Le jeton n'est accepté qu'en écriture, une fois.
 *
 * ⚠️ GÉNÉRIQUE PAR PLATEFORME (lot 21) : les routes Mattermost et Discord passent par le
 * MÊME code. Recopier ces handlers pour Discord aurait dupliqué la validation, la garde
 * d'écriture et le contrat « jamais de jeton en réponse » — trois choses qu'on ne veut
 * pas voir diverger.
 */

import type { IncomingHttpHeaders } from "node:http";

import type {
  ChatAdapterStatus,
  ChatQuoteAuthor,
  ChatReplyMode,
  ChatReplySettings,
  ChatReplySettingsPatch,
  ChatReplyStyle,
  ChatService,
  ChatStatusView,
  ChatSyncStatus,
} from "../../chat/index.js";
import type { ChatMirrorStats } from "../../chat/mirror/store.js";
import { CHAT_QUOTE_AUTHORS, CHAT_REPLY_MODES, CHAT_REPLY_STYLES } from "../../chat/types.js";
import type { ChatMode, RemotePlatform } from "../../chat/types.js";
import { requireWriteGuards } from "./config.js";

/** Canal suivi, tel que la page `/config` doit le montrer. */
export interface ChatPlatformChannelView {
  /** Identifiant Yuki (`mm-…` / `dc-…`). */
  id: string;
  /** Nom du canal. */
  titre: string;
  messageCount: number;
  replyMode?: ChatReplyMode;
  /** Comment Yuki répond (`fil` | `nouveau`) — valeur EFFECTIVE (défaut `fil`). */
  replyStyle?: ChatReplyStyle;
  /** Cite-t-elle l'auteur (`oui` | `non`) — valeur EFFECTIVE (défaut `non`). */
  quoteAuthor?: ChatQuoteAuthor;
  /** `true` quand le backfill initial a été effectué. */
  backfillFait: boolean;
  /** `true` quand la borne a été atteinte : historique antérieur non importé. */
  historiqueAnterieur: boolean;
}

/** État d'une plateforme exposé à la page `/config` (jamais un jeton). */
export interface ChatPlatformView {
  /**
   * INTERRUPTEUR de la plateforme (`chat.<plateforme>.enabled === "on"`).
   *
   * ⚠️ Indépendant de `jetonEnregistre` : un jeton posé avec `active: false`
   * n'ouvre AUCUNE connexion (« jeton posé, plateforme désactivée »). Et `true`
   * sans jeton ne se connecte pas non plus : les deux sont nécessaires.
   */
  active: boolean;
  /** `true` si un jeton est au coffre. ⚠️ Jamais la valeur, jamais un préfixe. */
  jetonEnregistre: boolean;
  /** État de la plateforme (badge ●/◐/○ et raison lisible). */
  plateforme: ChatAdapterStatus;
  /** Avancement de la synchronisation (canaux, backfill, dernière erreur). */
  synchronisation: ChatSyncStatus;
  /**
   * Empreinte du miroir de CETTE plateforme (conversations, messages, octets).
   *
   * ⚠️ Affichée AVANT la confirmation de « Supprimer la connexion » : on ne demande pas
   * de confirmer une destruction sans en montrer l'ampleur.
   */
  miroir: ChatMirrorStats;
  /** Canaux suivis. */
  canaux: ChatPlatformChannelView[];
}

/** Alias historique (le lot 18 n'avait que Mattermost). */
export type ChatMattermostChannelView = ChatPlatformChannelView;

/** État Mattermost exposé à la page `/config` (jamais un jeton). */
export interface ChatMattermostView extends ChatPlatformView {
  /** URL du serveur enregistrée (chaîne vide si rien n'est configuré). */
  url: string;
}

/** État Discord exposé à la page `/config` (jamais un jeton). */
export interface ChatDiscordView extends ChatPlatformView {
  /**
   * Serveur suivi. Chaîne vide = **tous les serveurs où le bot est présent** (défaut).
   */
  guildId: string;
  /** Borne d'envoi par fichier (octets), appliquée avant tout appel réseau. */
  maxUploadBytes: number;
  /**
   * État de l'intent privilégié `MESSAGE_CONTENT`.
   *
   * ⚠️ `null` = pas encore lu (aucune connexion tentée, ou réponse illisible) : on ne
   * prétend jamais qu'il est actif. `false` = les contenus arriveront VIDES, et la page
   * doit le dire en gras avant que l'utilisateur ne cherche ailleurs.
   */
  intentMessageContent: boolean | null;
}

/**
 * Ce que TOUTE plateforme de discussion expose aux routes.
 *
 * ⚠️ Le transport HTTP ne connaît ni client REST, ni WebSocket, ni coffre : il demande, et
 * le câblage (`src/index.ts`) exécute. C'est ce qui garde ce fichier testable sans réseau.
 */
export interface ChatPlatformPort {
  /** Un jeton est-il au coffre ? (jamais la valeur) */
  tokenConfigured(): boolean;
  /** Enregistre le jeton dans le coffre (chiffré). */
  saveToken(token: string): void;
  /** Démarre la synchronisation (identité, canaux, backfill, temps réel, rattrapage). */
  connect(): Promise<void>;
  /**
   * DÉBRANCHE : efface le jeton du coffre et ARRÊTE la synchronisation (WebSocket fermé,
   * balayeur arrêté).
   *
   * ⚠️ Le MIROIR n'est PAS touché : les conversations déjà importées restent lisibles.
   * C'est ce qui distingue « débrancher » (réversible : remettre le jeton) de
   * « supprimer » (`supprimerMiroir`), destructif et irréversible.
   */
  deconnecter(): Promise<void>;
  /** Empreinte du miroir de cette plateforme (ce qu'une suppression ferait perdre). */
  miroir(): ChatMirrorStats;
  /**
   * SUPPRIME le miroir de CETTE plateforme (index + fichiers `.jsonl`).
   *
   * ⚠️ Confiné : seules les conversations dont l'index dit `platform === <cette
   * plateforme>` sont effacées ; un identifiant `mm-…` n'emporte jamais un `dc-…`.
   */
  supprimerMiroir(): ChatMirrorStats;
  /** État complet (voir `ChatPlatformView`). */
  view(): ChatPlatformView;
  /** Réglages de réponse EFFECTIFS d'un canal (mode, style, citation), ou `undefined`. */
  replySettings(conversationId: string): ChatReplySettings | undefined;
  /**
   * Applique un SOUS-ENSEMBLE de réglages de réponse d'un canal (persisté).
   *
   * @returns `false` quand le canal n'est pas (encore) synchronisé.
   */
  applyReplySettings(conversationId: string, patch: ChatReplySettingsPatch): boolean;
}

/** Port Mattermost (URL de serveur en plus du contrat commun). */
export interface ChatMattermostPort extends ChatPlatformPort {
  /** URL EFFECTIVE (surcharge par bot `chat.mattermost.url`, sinon ANCIEN paramètre). */
  baseUrl(): string;
  /** Enregistre l'ANCIEN paramètre (`chat-mirror.json` → `baseUrl`, déjà validé). */
  saveBaseUrl(url: string): void;
  view(): ChatMattermostView;
}

/** Port Discord (réglages scalaires en plus du contrat commun). */
export interface ChatDiscordPort extends ChatPlatformPort {
  /** Serveur suivi (`""` = tous les serveurs du bot). */
  guildId(): string;
  /** Enregistre le serveur suivi (`""` = tous). */
  saveGuildId(guildId: string): void;
  /** Borne d'envoi par fichier (octets). */
  maxUploadBytes(): number;
  /** Enregistre la borne d'envoi (bornée par le schéma, jamais devinée). */
  saveMaxUploadBytes(bytes: number): void;
  view(): ChatDiscordView;
}

/** Journal minimal de la route (le logger d'observabilité le satisfait). */
export interface ChatApiLogger {
  error(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  /** Débranchement / suppression : une TRACE est due, sans aucun secret. */
  info(message: string, fields?: Record<string, unknown>): void;
}

export interface ChatApiDeps {
  service: ChatService;
  /** Absent ⇒ Mattermost n'est pas câblé dans ce processus (routes dédiées : 503). */
  mattermost?: ChatMattermostPort;
  /** Absent ⇒ Discord n'est pas câblé dans ce processus (routes dédiées : 503). */
  discord?: ChatDiscordPort;
  /** Journal des échecs d'écriture HTTP (jamais un jeton, jamais une URL complète). */
  logger?: ChatApiLogger;
  /**
   * Écrit `chat.mode` (clé LEGACY, `apply: hot`).
   *
   * ⚠️ Appelé APRÈS la suppression d'un miroir quand la valeur legacy désignait la
   * plateforme supprimée. ⚠️ Depuis 2026-11-10 cette retombée n'a plus d'effet
   * d'AFFICHAGE (aucun mode n'est filtré) : elle est conservée pour que la valeur
   * héritée ne pointe pas sur une plateforme vidée.
   */
  saveMode?: (mode: ChatMode) => void;
  /**
   * ⚠️ LOT 45 — RÉGLAGES D'UN CANAL DU BOT AFFICHÉ.
   *
   * DÉFAUT CORRIGÉ : `PATCH /api/chat/conversations/<id>` écrivait toujours dans le
   * miroir du bot COURANT du gateway (`chatMirror`, `<state>/chat-mirror.json`).
   * Un canal d'un autre bot (`<state>/bots/<id>/chat-mirror.json`) était donc réglé
   * dans le mauvais fichier : le réglage disparaissait au rafraîchissement de la
   * liste, et le bot continuait de répondre selon son ancien mode.
   *
   * Le client joint le bot AFFICHÉ (`bot` dans le corps PATCH) ; cette fabrique rend
   * son miroir, ou `undefined` si le bot est inconnu — auquel cas la route REFUSE
   * (`bot_inconnu`) au lieu de retomber sur un autre bot.
   */
  reglagesCanalDeBot?: (botId: string) => ChatCanalReglages | undefined;
}

/**
 * Réglages par canal d'UN bot (son miroir, jamais celui d'un autre).
 *
 * ⚠️ Contrat VOLONTAIREMENT étroit : deux opérations, aucune vue d'ensemble — la
 * route PATCH n'a besoin que de ça, et un contrat large ferait du miroir d'un bot
 * une seconde source de vérité pour l'API.
 */
export interface ChatCanalReglages {
  /** Réglages EFFECTIFS du canal, ou `null` s'il n'est pas dans ce miroir. */
  reglages(conversationId: string): ChatReplySettings | null;
  /** `true` quand le canal appartient à ce miroir (écriture effectuée). */
  ecrire(conversationId: string, patch: ChatReplySettingsPatch): boolean;
}

export interface ChatHttpResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface ChatRequestInput {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  /** Corps BRUT (chaîne UTF-8) — déjà borné par l'appelant. */
  body?: string;
  deps: ChatApiDeps;
}

/** Réponses JSON systématiquement non mises en cache (état vivant). */
const JSON_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function json(status: number, body: unknown): ChatHttpResponse {
  return { status, body, headers: JSON_HEADERS };
}

/** Toute l'API de discussion vit sous ce préfixe. */
export function isChatApiPath(path: string): boolean {
  return path === "/api/chat" || path.startsWith("/api/chat/");
}

/** Corps JSON validé (un corps illisible rend `null`, jamais une exception). */
function parseBody(body: string | undefined): Record<string, unknown> | null {
  if (typeof body !== "string" || body.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Vue complète servie par `GET /api/chat/status`. */
export interface ChatStatusResponse extends ChatStatusView {
  /** État Mattermost (absent quand la plateforme n'est pas câblée). */
  mattermost?: ChatMattermostView;
  /** État Discord (absent quand la plateforme n'est pas câblée). */
  discord?: ChatDiscordView;
}

/** Port d'une plateforme, ou `undefined` si elle n'est pas câblée ici. */
function portOf(deps: ChatApiDeps, platform: RemotePlatform): ChatPlatformPort | undefined {
  return platform === "mattermost" ? deps.mattermost : deps.discord;
}

/** Préfixe d'identifiant de conversation ⇒ plateforme (`mm-…`, `dc-…`). */
function platformOfConversation(conversationId: string): RemotePlatform | undefined {
  if (conversationId.startsWith("mm-")) return "mattermost";
  if (conversationId.startsWith("dc-")) return "discord";
  return undefined;
}

/**
 * Traite une requête de l'API des discussions.
 *
 * @returns la réponse à écrire ; `404` pour tout chemin inconnu.
 */
export async function handleChatRequest(input: ChatRequestInput): Promise<ChatHttpResponse> {
  const { method, path, headers, deps } = input;
  const verb = method.toUpperCase();

  // Garde de LECTURE : même en-tête que les écritures de configuration.
  const refused = requireWriteGuards(headers);
  if (refused) return { status: refused.status, body: refused.body, headers: JSON_HEADERS };

  if (path === "/api/chat/status") {
    if (verb !== "GET" && verb !== "HEAD") {
      return json(405, {
        error: "method_not_allowed",
        message: "Seule la lecture est disponible sur cette route.",
      });
    }
    const view: ChatStatusResponse = deps.service.status();
    if (deps.mattermost) view.mattermost = deps.mattermost.view();
    if (deps.discord) view.discord = deps.discord.view();
    return json(200, view);
  }

  // ─── Routes par plateforme ───────────────────────────────────────────────
  if (path === "/api/chat/mattermost" || path === "/api/chat/discord") {
    const platform: RemotePlatform = path.endsWith("/discord") ? "discord" : "mattermost";
    if (verb !== "PUT") {
      return json(405, {
        error: "method_not_allowed",
        message:
          platform === "discord"
            ? "Utilisez PUT pour enregistrer les réglages Discord (serveur, borne d'envoi)."
            : "Utilisez PUT pour enregistrer l'URL du serveur Mattermost.",
      });
    }
    const port = portOf(deps, platform);
    if (!port) return notWired(platform);
    const body = parseBody(input.body);
    if (!body) {
      return json(400, {
        error: "bad_request",
        message:
          platform === "discord"
            ? 'Indiquez les réglages Discord (`{"guildId": "123…", "maxUploadBytes": 8388608}`).'
            : 'Indiquez l\'URL du serveur Mattermost (`{"baseUrl": "https://…"}`).',
      });
    }
    if (platform === "mattermost") {
      const mattermost = port as ChatMattermostPort;
      if (typeof body.baseUrl !== "string") {
        return json(400, {
          error: "bad_request",
          message: 'Indiquez l\'URL du serveur Mattermost (`{"baseUrl": "https://…"}`).',
        });
      }
      const raw = body.baseUrl.trim();
      if (raw !== "") {
        const invalid = validateHttpUrl(raw, "l'URL du serveur Mattermost");
        if (invalid !== null) return invalid;
      }
      mattermost.saveBaseUrl(raw);
      return json(200, { ok: true, mattermost: mattermost.view() });
    }
    const discord = port as ChatDiscordPort;
    if (body.guildId !== undefined && typeof body.guildId !== "string") {
      return json(400, {
        error: "bad_request",
        message: "L'identifiant de serveur Discord doit être une chaîne (vide = tous les serveurs).",
      });
    }
    if (body.guildId !== undefined) {
      const guildId = body.guildId.trim();
      // Un identifiant Discord est un flocon : des chiffres uniquement (jamais un nom).
      if (guildId !== "" && !/^\d{1,20}$/.test(guildId)) {
        return json(400, {
          error: "bad_guild_id",
          message:
            "Un identifiant de serveur Discord ne contient que des chiffres (clic droit sur " +
            "le serveur → Copier l'identifiant du serveur). Laissez vide pour suivre tous " +
            "les serveurs du bot.",
        });
      }
      try {
        discord.saveGuildId(guildId);
      } catch (error) {
        return json(400, {
          error: "bad_request",
          message: `Le serveur Discord n'a pas pu être enregistré : ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    }
    if (body.maxUploadBytes !== undefined) {
      const value = body.maxUploadBytes;
      if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
        return json(400, {
          error: "bad_request",
          message: "La borne d'envoi Discord doit être un nombre d'octets positif.",
        });
      }
      try {
        discord.saveMaxUploadBytes(Math.trunc(value));
      } catch (error) {
        return json(400, {
          error: "bad_request",
          message: `La borne d'envoi Discord n'a pas pu être enregistrée : ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    }
    return json(200, { ok: true, discord: discord.view() });
  }

  const tokenMatch = /^\/api\/chat\/(mattermost|discord)\/jeton$/.exec(path);
  if (tokenMatch) {
    if (verb !== "POST") {
      return json(405, {
        error: "method_not_allowed",
        message: "Utilisez POST pour enregistrer le jeton du bot.",
      });
    }
    const platform = tokenMatch[1] as RemotePlatform;
    const port = portOf(deps, platform);
    if (!port) return notWired(platform);
    const body = parseBody(input.body);
    const token = body && typeof body.jeton === "string" ? body.jeton.trim() : "";
    if (token === "") {
      return json(400, {
        error: "bad_request",
        message:
          platform === "discord"
            ? "Le jeton du bot est vide : copiez-le depuis le portail développeur Discord."
            : "Le jeton du bot est vide : copiez-le depuis Mattermost.",
      });
    }
    port.saveToken(token);
    // ⚠️ La réponse ne renvoie JAMAIS le jeton : il est enregistré, c'est tout. La page
    // affiche « jeton enregistré » et n'a plus aucun moyen de le relire.
    return json(200, { ok: true, jetonEnregistre: true });
  }

  const connectMatch = /^\/api\/chat\/(mattermost|discord)\/connexion$/.exec(path);
  if (connectMatch) {
    const platform = connectMatch[1] as RemotePlatform;
    const port = portOf(deps, platform);
    if (!port) return notWired(platform);

    // ─── DÉBRANCHER (DELETE) ─────────────────────────────────────────────
    // ⚠️ EFFACE le jeton et ARRÊTE la synchronisation. ⚠️ Le miroir RESTE : les
    // conversations déjà importées demeurent lisibles, et remettre le jeton suffit à
    // repartir. C'est l'action NON destructive — « supprimer » est juste en dessous.
    if (verb === "DELETE") {
      try {
        await port.deconnecter();
      } catch (error) {
        return json(502, {
          error: "deconnexion_impossible",
          message:
            `La déconnexion de ${platform === "discord" ? "Discord" : "Mattermost"} a ` +
            `échoué : ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      const miroir = port.miroir();
      // Journal SANS secret : la plateforme, et ce qui reste dans le miroir.
      deps.logger?.info("chat.platform_disconnected", {
        plateforme: platform,
        conversationsConservees: miroir.conversations,
        messagesConserves: miroir.messages,
      });
      return json(200, {
        ok: true,
        deconnecte: true,
        miroirConserve: miroir,
        ...(platform === "discord"
          ? { discord: (port as ChatDiscordPort).view() }
          : { mattermost: (port as ChatMattermostPort).view() }),
      });
    }

    if (verb !== "POST") {
      return json(405, {
        error: "method_not_allowed",
        message:
          "Utilisez POST pour lancer la connexion à la plateforme, ou DELETE pour la " +
          "débrancher (le jeton est effacé, le miroir est conservé).",
      });
    }
    const body = parseBody(input.body);
    // L'URL (Mattermost) peut être fournie dans le même geste (bouton « Se connecter »).
    // ⚠️ Elle est VALIDÉE ici aussi : elle part dans l'ANCIEN paramètre
    // (`chat-mirror.json` → `baseUrl`), et un `ftp://` ou un texte libre y aurait
    // dormi jusqu'à l'échec de connexion, sans dire pourquoi. Refus explicite (400).
    if (
      platform === "mattermost" &&
      body &&
      typeof body.baseUrl === "string" &&
      body.baseUrl.trim() !== ""
    ) {
      const raw = body.baseUrl.trim();
      const invalid = validateHttpUrl(raw, "l'URL du serveur Mattermost");
      if (invalid !== null) return invalid;
      (port as ChatMattermostPort).saveBaseUrl(raw);
    }
    if (body && typeof body.jeton === "string" && body.jeton.trim() !== "") {
      port.saveToken(body.jeton.trim());
    }
    if (!port.tokenConfigured()) {
      return json(400, {
        error: "jeton_absent",
        message:
          platform === "discord"
            ? "Aucun jeton Discord n'est enregistré : saisissez-le une fois (il n'est plus " +
              "jamais réaffiché) avant de vous connecter."
            : "Aucun jeton Mattermost n'est enregistré : saisissez-le une fois (il n'est " +
              "plus jamais réaffiché) avant de vous connecter.",
      });
    }
    if (platform === "mattermost" && (port as ChatMattermostPort).baseUrl() === "") {
      return json(400, {
        error: "url_absente",
        message: "L'URL du serveur Mattermost n'est pas renseignée.",
      });
    }
    try {
      await port.connect();
    } catch (error) {
      return json(502, {
        error: "connexion_impossible",
        message:
          `La connexion à ${platform === "discord" ? "Discord" : "Mattermost"} a échoué : ` +
          (error instanceof Error ? error.message : String(error)),
      });
    }
    return json(200, {
      ok: true,
      ...(platform === "discord"
        ? { discord: (port as ChatDiscordPort).view() }
        : { mattermost: (port as ChatMattermostPort).view() }),
    });
  }

  // ─── SUPPRIMER la connexion (jeton ET miroir) ────────────────────────────
  const mirrorMatch = /^\/api\/chat\/(mattermost|discord)\/miroir$/.exec(path);
  if (mirrorMatch) {
    if (verb !== "DELETE") {
      return json(405, {
        error: "method_not_allowed",
        message:
          "Utilisez DELETE pour supprimer le miroir d'une plateforme (action destructive).",
      });
    }
    const platform = mirrorMatch[1] as RemotePlatform;
    const port = portOf(deps, platform);
    if (!port) return notWired(platform);
    // ⚠️ CONFIRMATION OBLIGATOIRE : `{"confirmation": true}`. Un corps absent, vide ou
    // portant autre chose est un REFUS — jamais une supposition (« il a cliqué, donc il
    // veut tout perdre »). L'interface envoie ce champ après une case cochée ET le
    // décompte de ce qui sera perdu.
    const body = parseBody(input.body);
    if (!body || body.confirmation !== true) {
      return json(400, {
        error: "confirmation_requise",
        message:
          "Supprimer une connexion est IRRÉVERSIBLE : renvoyez `{\"confirmation\": true}` " +
          "après avoir coché la case de confirmation. Les conversations miroir et le " +
          "jeton de cette plateforme seront effacés définitivement.",
      });
    }
    const avant = port.miroir();
    let supprime: ChatMirrorStats;
    try {
      // ⚠️ Le jeton d'abord (sinon la synchro pourrait réécrire un miroir qu'on efface),
      // puis le miroir. `deconnecter` est idempotent : l'appeler sur une plateforme déjà
      // débranchée ne fait rien de plus.
      await port.deconnecter();
      supprime = port.supprimerMiroir();
    } catch (error) {
      return json(500, {
        error: "suppression_impossible",
        message:
          `La suppression du miroir ${platform === "discord" ? "Discord" : "Mattermost"} ` +
          `a échoué : ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    // ⚠️ RETOMBÉE LEGACY : si `chat.mode` désignait la plateforme qu'on vient de vider,
    // la valeur héritée ne doit pas pointer sur une plateforme morte.
    const modeCourant = deps.service.status().mode;
    const bascule = modeCourant === platform && deps.saveMode !== undefined;
    if (bascule) deps.saveMode?.("local");
    deps.logger?.info("chat.platform_removed", {
      plateforme: platform,
      conversations: supprime.conversations,
      messages: supprime.messages,
      octets: supprime.octets,
      modeAvant: modeCourant,
      modeApres: bascule ? "local" : modeCourant,
    });
    return json(200, {
      ok: true,
      supprime,
      avant,
      mode: bascule ? "local" : modeCourant,
      ...(platform === "discord"
        ? { discord: (port as ChatDiscordPort).view() }
        : { mattermost: (port as ChatMattermostPort).view() }),
    });
  }

  const conversationMatch = /^\/api\/chat\/conversations\/([^/]+)$/.exec(path);
  if (conversationMatch) {
    if (verb !== "PATCH") {
      return json(405, {
        error: "method_not_allowed",
        message: "Utilisez PATCH pour changer le mode de réponse d'un canal.",
      });
    }
    const conversationId = decodeURIComponent(conversationMatch[1] ?? "");
    const platform = platformOfConversation(conversationId);
    const body = parseBody(input.body);
    const patch = body === null ? null : parseReplySettings(body);
    if (patch === null) {
      // ⚠️ REFUS EXPLICITE, valeur par valeur : rien n'est deviné ni ignoré en silence.
      return json(400, {
        error: "bad_request",
        message:
          "Réglage inconnu. Valeurs acceptées : `replyMode` (« tout », « auto », « mention », " +
          "ou `null` pour le défaut), `replyStyle` (« fil », « nouveau », ou `null`), " +
          "`quoteAuthor` (« oui », « non », ou `null`).",
      });
    }
    // ⚠️ BOT AFFICHÉ : un canal appartient à UN bot, ses réglages vont dans SON
    // miroir. Un bot annoncé mais inconnu est REFUSÉ (jamais un repli silencieux
    // vers un autre bot : on écrirait un réglage qui ne s'applique à rien).
    const bot = typeof body?.bot === "string" ? body.bot.trim() : "";
    let cible: ChatCanalReglages | undefined;
    if (bot !== "") {
      cible = deps.reglagesCanalDeBot?.(bot);
      if (cible === undefined) {
        return json(400, {
          error: "bot_inconnu",
          message: `Le bot « ${bot} » est inconnu : ses canaux ne peuvent pas être réglés depuis ici.`,
        });
      }
    }
    // ⚠️ Le port de la plateforme n'est REQUIS que pour le miroir d'instance : un
    // canal du bot affiché se règle par SON miroir (`cible`), sans passer par
    // l'adaptateur du bot courant.
    const port = platform === undefined ? undefined : portOf(deps, platform);
    if (!port && !cible) return notWired(platform);
    const applied = cible
      ? cible.ecrire(conversationId, patch)
      : port!.applyReplySettings(conversationId, patch);
    if (!applied) {
      return json(404, {
        error: "conversation_inconnue",
        message:
          "Ce canal n'est pas (encore) synchronisé : ses réglages de réponse sont sans objet.",
      });
    }
    return json(200, {
      ok: true,
      conversationId,
      ...(bot !== "" ? { bot } : {}),
      reglages: cible ? cible.reglages(conversationId) : port!.replySettings(conversationId),
      // La vue d'instance n'est ajoutée que si son port existe : un canal du bot
      // affiché n'en dépend pas.
      ...(port
        ? platform === "discord"
          ? { discord: (port as ChatDiscordPort).view() }
          : { mattermost: (port as ChatMattermostPort).view() }
        : {}),
    });
  }

  return json(404, {
    error: "not_found",
    message: "Route de discussion inconnue.",
  });
}

/**
 * Réglages de réponse lus dans un corps PATCH — ou `null` si UNE valeur est inconnue.
 *
 * ⚠️ Un corps VIDE est un refus (il n'y aurait rien à appliquer) ; un champ ABSENT
 * n'est pas touché ; `null` remet le réglage à son défaut.
 */
function parseReplySettings(body: Record<string, unknown>): ChatReplySettingsPatch | null {
  const patch: ChatReplySettingsPatch = {};
  let fourni = 0;
  for (const key of ["replyMode", "replyStyle", "quoteAuthor"] as const) {
    const value = body[key];
    if (value === undefined) continue;
    fourni += 1;
    if (value === null) {
      patch[key] = null;
      continue;
    }
    if (typeof value !== "string") return null;
    if (key === "replyMode") {
      if (!(CHAT_REPLY_MODES as readonly string[]).includes(value)) return null;
      patch.replyMode = value as ChatReplyMode;
    } else if (key === "replyStyle") {
      if (!(CHAT_REPLY_STYLES as readonly string[]).includes(value)) return null;
      patch.replyStyle = value as ChatReplyStyle;
    } else {
      if (!(CHAT_QUOTE_AUTHORS as readonly string[]).includes(value)) return null;
      patch.quoteAuthor = value as ChatQuoteAuthor;
    }
  }
  return fourni === 0 ? null : patch;
}

/** Une URL http(s) valide, ou la réponse 400 à renvoyer. */
function validateHttpUrl(raw: string, quoi: string): ChatHttpResponse | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return json(400, {
      error: "bad_base_url",
      message: `${quoi} n'est pas une URL valide. Exemple attendu : https://mattermost.exemple.fr`,
    });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return json(400, {
      error: "bad_base_url",
      message: `${quoi} doit commencer par http:// ou https://.`,
    });
  }
  return null;
}

/** Réponse quand une plateforme n'est pas câblée dans ce processus. */
function notWired(platform: RemotePlatform | undefined): ChatHttpResponse {
  const nom = platform === "discord" ? "Discord" : "Mattermost";
  return json(503, {
    error: "chat_unavailable",
    message: `La connexion ${nom} n'est pas câblée dans ce processus : redémarrez Yuki.`,
  });
}
