/**
 * BORNE DES IMAGES DANS LE CONTEXTE ENVOYÉ AU FOURNISSEUR.
 *
 * ⚠️ LE FAIT MESURÉ (2026-11-01) qui justifie ce fichier : le SDK renvoie à
 * CHAQUE requête TOUT l'historique de la session (`core/agent-loop.js` :
 * `messages = await config.transformContext(messages)` puis un unique appel
 * modèle avec ce contexte). Un bloc `{type:"image"}` produit par `lire_fichier`
 * ou `recuperer_fichier` est donc re-sérialisé à CHAQUE tour suivant, jusqu'à la
 * fin de la conversation : trois images vues = trois blocs de plusieurs centaines
 * de Ko dans chaque corps HTTP. C'est ce qui produit `500 « request entity too
 * large »` alors que le contexte TEXTE est petit (« redescendu à 23 k »).
 *
 * ⚠️ POURQUOI LA COMPACTION NE SAUVE RIEN : elle n'évalue une image qu'à
 * `ESTIMATED_IMAGE_CHARS = 4800` caractères (`core/compaction/compaction.js`),
 * soit ~1 200 jetons — très en dessous du poids réel sur le fil — et elle
 * CONSERVE tels quels les messages récents (`firstKeptEntryId`), blocs image
 * compris (`core/session-manager.js` : `buildContextEntries`).
 *
 * ⚠️ LA POLITIQUE RETENUE (image CONSOMMÉE UNE FOIS) : on ne touche PAS à
 * l'historique persisté (le JSONL reste complet, l'utilisateur peut rouvrir la
 * conversation, l'UI réaffiche tout). On ne touche QUE la COPIE envoyée au
 * modèle, au dernier moment, via l'événement `context` du SDK — « Fired before
 * each LLM call. Can modify messages » (`core/extensions/runner.js`,
 * `emitContext`, qui clone les messages avant l'appel).
 *
 * Règle : du plus RÉCENT au plus ANCIEN, on garde les images tant que le budget
 * d'octets TRANSMIS (base64) le permet ; au-delà, le bloc image est remplacé par
 * un bloc texte qui DIT la vérité (elle a été vue, elle n'est plus transmise, et
 * comment la revoir). L'image la plus récente — celle qu'un outil vient de
 * rendre, ou celle que l'utilisateur vient de joindre — est donc TOUJOURS vue.
 *
 * ⚠️ LA VISION RESTE ACTIVE : aucun outil n'est retiré, aucun réglage n'est
 * désactivé ; seule la RÉPÉTITION d'une même image dans les tours suivants est
 * supprimée.
 */

/** Bloc de contenu tel que le SDK le transporte (`TextContent`/`ImageContent`). */
interface ContentBlock {
  type?: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

/** Message minimal : ce module n'importe PAS le SDK (types structurels). */
interface MessageLike {
  role?: string;
  content?: unknown;
}

/** Remplacement textuel d'une image retirée du contexte. */
export const REMOVED_IMAGE_TEXT =
  "[image retirée de ce tour : elle t'a déjà été montrée et n'est plus " +
  "transmise (sinon la requête dépasse la taille acceptée par le fournisseur). " +
  "Pour la revoir, relis-la avec `lire_fichier` (son identifiant est dans le " +
  "message ci-dessus) ou joins-la de nouveau.]";

export interface ContextImageBudget {
  /** Plafond du total des images TRANSMISES (base64), en octets. */
  budgetBytes: number;
}

export interface ContextImageStats {
  /** Blocs image conservés dans la copie envoyée. */
  kept: number;
  /** Blocs image remplacés par du texte. */
  dropped: number;
  /** Dont retirés parce qu'ils datent d'un TOUR PRÉCÉDENT. */
  stale: number;
  /** Dont retirés parce que le plafond de la requête était atteint. */
  overflow: number;
  /** Octets base64 conservés. */
  keptBytes: number;
  /** Octets base64 évités sur le fil. */
  droppedBytes: number;
}

export interface ContextImageResult<M extends MessageLike> {
  messages: M[];
  stats: ContextImageStats;
}

const EMPTY_STATS: ContextImageStats = {
  kept: 0,
  dropped: 0,
  stale: 0,
  overflow: 0,
  keptBytes: 0,
  droppedBytes: 0,
};

function isImageBlock(block: unknown): block is { type: "image"; data: string } {
  if (typeof block !== "object" || block === null) return false;
  const candidate = block as ContentBlock;
  return candidate.type === "image" && typeof candidate.data === "string";
}

/**
 * Applique la politique « image consommée une fois » à une COPIE des messages
 * destinée à UN appel modèle.
 *
 * - Ne modifie JAMAIS les objets reçus : les messages dont le contenu change
 *   sont recopiés (`{ ...message, content }`), les autres sont réutilisés.
 * - Budget non fini ou `<= 0` ⇒ aucune borne (comportement d'origine), ce qui
 *   permet de désactiver la politique sans redémarrer.
 * - Un message sans bloc image est rendu TEL QUEL (aucune allocation).
 *
 * ⚠️ DEUX CRITÈRES, dans cet ordre :
 * 1. l'ÂGE — toute image antérieure au DERNIER message `user` appartient à un
 *    tour DÉJÀ CONCLU : elle est retirée quoi qu'il arrive (c'est « l'image
 *    consommée une fois »). Le seul fait de garder « la plus récente dans le
 *    budget » ne suffirait pas : avec un plafond de deux images, l'image de
 *    l'avant-dernier tour resterait à jamais sur le fil ;
 * 2. le PLAFOND — dans le tour EN COURS (message `user` le plus récent et tout
 *    ce qui le suit : résultats d'outils, steers), les images sont gardées de la
 *    plus récente à la plus ancienne jusqu'à épuisement du budget. Une longue
 *    boucle d'outils qui lit trois images n'en transmet donc jamais plus que le
 *    plafond, et c'est la PLUS FRAÎCHE qui survit.
 */
export function limitContextImages<M extends MessageLike>(
  messages: readonly M[],
  budget: ContextImageBudget,
): ContextImageResult<M> {
  const budgetBytes = budget.budgetBytes;
  if (!Number.isFinite(budgetBytes) || budgetBytes <= 0) {
    return { messages: [...messages], stats: { ...EMPTY_STATS } };
  }

  const out = [...messages];
  const stats: ContextImageStats = { ...EMPTY_STATS };
  let remaining = budgetBytes;

  // Frontière du TOUR EN COURS : le dernier message `user`. Sans lui (fil vide
  // ou contexte purement synthétique), on ne retire rien au titre de l'âge —
  // on ne devine pas un tour qui n'existe pas.
  let boundary = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      boundary = index;
      break;
    }
  }

  // Du plus RÉCENT au plus ANCIEN : la dernière image vue survit toujours.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || !Array.isArray(message.content)) continue;
    const blocks = message.content as unknown[];
    let content: unknown[] | undefined;

    for (let position = blocks.length - 1; position >= 0; position -= 1) {
      const block = blocks[position];
      if (!isImageBlock(block)) continue;
      // La taille qui compte est celle du champ transmis (base64), pas les
      // octets du fichier : c'est ce que compte le fournisseur.
      const size = block.data.length;
      const isCurrentTurn = index >= boundary;
      if (isCurrentTurn && size <= remaining) {
        remaining -= size;
        stats.kept += 1;
        stats.keptBytes += size;
        continue;
      }
      content ??= [...blocks];
      content[position] = { type: "text", text: REMOVED_IMAGE_TEXT };
      stats.dropped += 1;
      if (isCurrentTurn) {
        stats.overflow += 1;
      } else {
        stats.stale += 1;
      }
      stats.droppedBytes += size;
    }

    if (content !== undefined) {
      out[index] = { ...message, content } as M;
    }
  }

  return { messages: out, stats };
}
