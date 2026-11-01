/**
 * Types FILAIRES de l'API Mattermost v4 (lot 18, lot 2).
 *
 * ⚠️ Ce fichier ne contient QUE la forme des charges utiles HTTP/WebSocket,
 * telle que la documente l'API (base `/api/v4`) — aucune logique, aucun état.
 * Les conversions vers le modèle commun (`RemoteMessage`) vivent dans
 * `src/chat/mirror/ingest.ts`.
 *
 * Sources vérifiées (voir `docs/lot18-chat.md`, section « Sources ») :
 *  - `api/v4/source/introduction.yaml` — conventions (`per_page` max 200,
 *    tronqué EN SILENCE ; défaut 60), authentification, WebSocket
 *    (`authentication_challenge`, liste des événements) ;
 *  - `api/v4/source/posts.yaml` — `GET /api/v4/channels/{channel_id}/posts`
 *    (`since` NON combinable avec `page`/`per_page`, limité à 1000 posts, pas de
 *    garantie de continuité) et `POST /api/v4/posts` ;
 *  - `server/channels/app/post.go` — `data.post` d'un événement est une CHAÎNE
 *    JSON (double encodage), d'où le parse défensif plus bas.
 */

/**
 * Taille de page MAXIMALE acceptée par le serveur. ⚠️ Toute valeur supérieure est
 * tronquée SANS ERREUR par Mattermost : le client ne demande donc jamais plus,
 * et PAGINE au lieu de croire qu'il a tout reçu.
 */
export const MM_MAX_PER_PAGE = 200;

/** Espacement minimal entre deux requêtes HTTP (1 requête / 250 ms). */
export const MM_MIN_REQUEST_INTERVAL_MS = 250;

/** Nombre maximal de tentatives après un `429` (backoff borné). */
export const MM_MAX_RETRIES = 4;

/** Durée pendant laquelle le statut reste « ralenti » après un `429`. */
export const MM_SLOW_WINDOW_MS = 60_000;

/** Borne documentaire de `?since=` : au-delà, le serveur ne rend que 1000 posts. */
export const MM_SINCE_MAX_POSTS = 1_000;

/** Un post Mattermost (charge utile REST `Post`, champs utilisés seulement). */
export interface MattermostPost {
  id: string;
  /** Horodatage de création, en millisecondes Unix. */
  create_at?: number;
  /** Horodatage de dernière modification, en millisecondes Unix. */
  update_at?: number;
  /** Horodatage de la dernière ÉDITION, en millisecondes Unix. */
  edit_at?: number;
  /** Horodatage de SUPPRESSION (0 ou absent = vivant), en millisecondes Unix. */
  delete_at?: number;
  user_id?: string;
  channel_id?: string;
  /** Post RACINE quand celui-ci est une réponse de fil. */
  root_id?: string;
  /** Post immédiatement parent (égal à `root_id` sur un fil à un niveau). */
  parent_id?: string;
  message?: string;
  /** `""` = message normal ; `system_*` = message système (jamais répondu). */
  type?: string;
  file_ids?: string[];
}

/** Un utilisateur Mattermost (champs utilisés seulement). */
export interface MattermostUser {
  id: string;
  username?: string;
  nickname?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  /** `true` pour un compte bot. */
  is_bot?: boolean;
  /** Horodatage de désactivation (0 = actif). */
  delete_at?: number;
}

/** Une équipe Mattermost. */
export interface MattermostTeam {
  id: string;
  name?: string;
  display_name?: string;
  delete_at?: number;
}

/** Un canal Mattermost. */
export interface MattermostChannel {
  id: string;
  name?: string;
  display_name?: string;
  team_id?: string;
  /** `O` public, `P` privé, `D` direct, `G` groupe. */
  type?: string;
  delete_at?: number;
  /** Dernière activité connue (ms Unix). */
  last_post_at?: number;
}

/**
 * Réponse de `GET /api/v4/channels/{id}/posts`.
 *
 * ⚠️ `order` peut contenir MOINS d'entrées que `per_page` sans que ce soit la fin
 * (troncature silencieuse côté serveur) : c'est `has_next` qui tranche quand il
 * est présent, et à défaut la comparaison avec la taille RÉELLEMENT demandée.
 */
export interface MattermostPostList {
  order?: string[];
  posts?: Record<string, MattermostPost>;
  next_post_id?: string;
  prev_post_id?: string;
  has_next?: boolean;
}

/** Trame WebSocket reçue (réponse à une action OU événement). */
export interface MattermostWsFrame {
  event?: string;
  data?: Record<string, unknown>;
  broadcast?: Record<string, unknown>;
  seq?: number;
  status?: string;
  seq_reply?: number;
  error?: { id?: string; message?: string };
}

/** Événement de post RETENU par le client (les autres sont ignorés). */
export type MattermostPostEventKind = "posted" | "post_edited" | "post_deleted";

/** Événement de post normalisé : l'appelant ne voit jamais la trame brute. */
export interface MattermostPostEvent {
  kind: MattermostPostEventKind;
  post: MattermostPost;
}

/** Message lisible d'une valeur inconnue (jamais un objet sérialisé en vrac). */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `true` si la valeur a la forme d'un post exploitable (au moins un `id`). */
export function isMattermostPost(value: unknown): value is MattermostPost {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { id?: unknown };
  return typeof candidate.id === "string" && candidate.id.length > 0;
}

/**
 * Extrait le post d'un événement WebSocket.
 *
 * ⚠️ DÉFENSIF À DESSEIN : `data.post` est une CHAÎNE JSON dans les versions
 * actuelles du serveur (`post.ToJSON()` puis `Add("post", postJSON)`), mais rien
 * n'interdit à un serveur plus ancien — ou à un relais — d'envoyer un OBJET. Les
 * deux formes sont acceptées ; une charge illisible rend `null` (jamais une
 * exception qui tuerait la connexion).
 */
export function postOfEventData(data: Record<string, unknown> | undefined): MattermostPost | null {
  if (!data) return null;
  const raw = data.post;
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      return isMattermostPost(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return isMattermostPost(raw) ? raw : null;
}

/** Horodatage ms → ISO, ou `undefined` si la valeur n'est pas exploitable. */
export function isoOf(ms: number | undefined): string | undefined {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return undefined;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
