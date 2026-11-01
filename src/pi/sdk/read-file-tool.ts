/**
 * Outil custom `lire_fichier` — LIRE le CONTENU d'une pièce jointe de la
 * conversation (worker lourd).
 *
 * ⚠️ POURQUOI CET OUTIL EXISTE : `lister_fichiers` rend l'identifiant et les
 * métadonnées, `deposer_fichier` exige l'identifiant — mais le worker ne pouvait
 * lire AUCUN octet. Il savait qu'une image existait, il en avait l'identifiant,
 * et il ne pouvait rien en faire (et pour un fichier texte du store, `read` ne
 * l'atteint pas : ce n'est pas un chemin de son espace de travail). Sans
 * `lire_fichier`, la boucle « lister → lire → décider → déposer » restait ouverte,
 * donc l'utilisateur devait rester dans la boucle.
 *
 * CE QUE L'OUTIL REND, SELON LE GENRE (et rien d'autre) :
 *  - IMAGE  ⇒ un bloc `{ type: "image", data, mimeType }` (exactement le format de
 *    `generer_image`, `src/pi/sdk/image-tools.ts`), après la politique de VISION
 *    partagée (`src/files/vision.ts` : côté max 2 000 px, min 700 px, réduction
 *    ÉPHÉMÈRE, original intact, refus `file_image_illegible`). ⚠️ Si le modèle
 *    résolu ne reçoit pas les images (`sdkModelSupportsImages`), AUCUN bloc image
 *    n'est joint et le texte LE DIT — jamais « tu la vois » quand elle est jetée ;
 *  - TEXTE  ⇒ le contenu DÉCODÉ (`decodeTextSample` : UTF-16 LE/BE et UTF-8, y
 *    compris sans BOM — c'est un chantier déjà livré, on ne le régresse pas),
 *    encadré comme DONNÉE (`frameFiles`, échappement anti-injection), BORNÉ par
 *    appel. Au-delà : refus explicite ET proposition de plage (`debut`), jamais
 *    une troncature muette ;
 *  - PDF ou BINAIRE ⇒ refus propre et motivé : aucun binaire n'entre dans un
 *    prompt.
 *
 * ⚠️ PÉRIMÈTRE : la conversation est FORCÉE (`lightSessionId`, comme
 * `lister_fichiers`) ; un identifiant d'une AUTRE conversation est REFUSÉ avant
 * toute lecture. Un identifiant n'est jamais un chemin : aucune traversée de
 * répertoire n'est possible.
 *
 * ⚠️ AUDIT : l'ouverture est journalisée (identifiant, genre, octets, mode) —
 * JAMAIS le contenu, comme les transferts de fichiers.
 */

import {
  defineTool,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  MAX_ANALYSIS_READ_BYTES,
  decodeTextSample,
  frameFiles,
  humanBytes,
  isTextDeclaration,
  looksBinary,
  UNREADABLE_REASONS,
  type FileKind,
  type FilesReadPort,
  type WireFile,
} from "../../files/index.js";

/**
 * Plafond de caractères rendus par APPEL pour un fichier texte.
 *
 * 20 000 caractères ≈ 5 000 jetons : assez pour un fichier de configuration, un
 * début de journal ou un extrait de code, sans noyer le contexte du tour. MÊME
 * borne que l'analyse conservée (`MAX_STORED_ANALYSIS_CHARS`) : ce que l'outil
 * rend ne peut pas être plus gros que ce que le stockage a déjà jugé utile.
 *
 * ⚠️ AU-DELÀ, on REFUSE et on propose une plage (`debut`) : une coupe silencieuse
 * ferait croire au worker qu'il a lu tout le fichier.
 */
export const MAX_READ_TEXT_CHARS = 20_000;

export interface ReadFileToolOptions {
  /**
   * Conversation FORCÉE (worker lourd : la conversation propriétaire — la
   * session du worker est éphémère et ne désigne aucun fichier).
   */
  sessionId?: () => string | undefined;
  /** Plafond de caractères par appel (défaut `MAX_READ_TEXT_CHARS`). */
  maxChars?: number;
  /**
   * Le modèle RÉSOLU reçoit-il les images (`model.input`) ? `false` ⇒ aucun bloc
   * image n'est joint et le résultat le dit. Absent ⇒ capacité supposée acquise
   * (même défaut que `generer_image`).
   */
  imagesSupported?: boolean;
  /** Référence `provider/modelId` du modèle (message honnête en cas de refus). */
  modelLabel?: string;
  /** Journal d'AUDIT (métadonnées seules, jamais le contenu). */
  logger?: { info(message: string, fields?: Record<string, unknown>): void };
}

/** Détails structurés (rendu UI / journal) : jamais un contenu de fichier. */
interface ReadFileDetails {
  status: "read" | "refused" | "unavailable";
  id?: string;
  name?: string;
  kind?: FileKind;
  mimeType?: string;
  bytes?: number;
  mode?: "image" | "texte";
  /** Caractères de la plage rendue (texte uniquement). */
  chars?: number;
  /** Plage effective (caractères, 0-indexée) et longueur totale décodée. */
  range?: { debut: number; fin: number; total: number };
  /** Octets réellement lus sur le disque (borné). */
  readBytes?: number;
  /** `true` ⇒ une version RÉDUITE éphémère a été jointe (jamais stockée). */
  resized?: boolean;
  image_attached?: boolean;
  /** Code exact d'un refus d'image (`file_image_illegible`, …) ou `model_without_vision`. */
  image_error?: string;
  /** Code exact d'un refus de lecture (`file_content_binary`, …). */
  code?: string;
}

/** Identifiant de session lu du contexte de l'outil, ou `undefined`. */
function sessionIdFromContext(ctx: ExtensionContext | undefined): string | undefined {
  if (!ctx) return undefined;
  try {
    const id = ctx.sessionManager.getSessionId();
    return id && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Résout la conversation : l'ID FORCÉ prime, sinon celui du contexte. */
function resolveSessionId(
  ctx: ExtensionContext | undefined,
  options: ReadFileToolOptions,
): string | undefined {
  const forced = options.sessionId?.();
  if (forced && forced.length > 0) return forced;
  return sessionIdFromContext(ctx);
}

/** Coerce une valeur LLM en entier positif ou nul (`undefined` si illisible). */
function coerceOffset(value: unknown): number | undefined {
  if (value === undefined || value === null) return 0;
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  return undefined;
}

/** Un bloc de contenu d'outil : texte, ou image (forme exacte du SDK). */
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

interface ToolResult {
  content: ContentBlock[];
  details: ReadFileDetails;
}

/** Refus : un seul bloc texte, jamais de contenu. */
function refused(text: string, details: ReadFileDetails): ToolResult {
  return { content: [{ type: "text", text }], details };
}

/**
 * Construit l'outil `lire_fichier`.
 *
 * Le port (`FilesReadPort`) rend les octets et l'analyse ; l'outil décide seul de
 * ce qui peut entrer dans un prompt (image, texte) et refuse le reste.
 */
export function createReadFileTool(
  files: FilesReadPort,
  options: ReadFileToolOptions = {},
): ToolDefinition[] {
  const maxChars = Math.max(1, Math.trunc(options.maxChars ?? MAX_READ_TEXT_CHARS));

  const tool = defineTool({
    name: "lire_fichier",
    label: "Lire un fichier de la conversation",
    description:
      "LIT le CONTENU d'une pièce jointe de cette conversation, désignée par son " +
      "IDENTIFIANT (32 caractères hexadécimaux, tel que le rend `lister_fichiers`). " +
      "Ce que tu reçois dépend du GENRE : une IMAGE t'est transmise comme image et " +
      "tu la VOIS (sauf si le résultat dit explicitement le contraire) ; un TEXTE " +
      "est rendu décodé, encadré comme DONNÉE, et BORNÉ par appel ; un PDF ou un " +
      "binaire est REFUSÉ (aucun binaire n'entre dans un prompt). ⚠️ Au-delà du " +
      "plafond de caractères, l'outil REFUSE et te dit quel `debut` demander ensuite " +
      "— il ne coupe jamais en silence. Seuls les fichiers de CETTE conversation " +
      "sont lisibles : un identifiant d'une autre conversation est refusé.",
    promptSnippet:
      "lire_fichier(identifiant, debut?) — lit le contenu d'une pièce jointe de la conversation (image vue, texte décodé et borné, binaire refusé)",
    parameters: Type.Object({
      identifiant: Type.String({
        minLength: 1,
        maxLength: 64,
        description:
          "IDENTIFIANT du fichier (32 caractères hexadécimaux), tel que le rend " +
          "`lister_fichiers` — jamais un nom, jamais un chemin.",
      }),
      debut: Type.Optional(
        Type.Union([Type.Number(), Type.String(), Type.Null()], {
          description:
            "Décalage en CARACTÈRES pour un fichier texte (défaut 0). Sert à lire " +
            "la suite quand l'outil a refusé la longueur totale.",
        }),
      ),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const input = params as { identifiant: string; debut?: unknown };
      const id = String(input.identifiant ?? "").trim().toLowerCase();

      const sessionId = resolveSessionId(ctx, options);
      if (!sessionId) {
        return refused(
          "Lecture impossible : aucune conversation n'est identifiée pour cet appel. " +
            "Rien n'a été lu — n'invente aucun contenu de fichier.",
          { status: "unavailable" },
        );
      }

      // ⚠️ PÉRIMÈTRE : on ne cherche QUE dans cette conversation. Un identifiant
      // d'un autre fil n'est jamais résolu, même valide ailleurs.
      const listed = files.listForSession(sessionId);
      const wire = listed.find((file: WireFile) => file.id === id);
      if (!wire) {
        const exists = files.get(id) !== null;
        if (exists) {
          return refused(
            `Lecture REFUSÉE : le fichier ${id} appartient à une AUTRE conversation. ` +
              "Tu ne peux lire que les pièces jointes de cette conversation-ci — " +
              "rien n'a été lu.",
            { status: "refused", id, code: "other_session" },
          );
        }
        return refused(
          `Lecture impossible : aucun fichier ${id} n'existe dans cette conversation ` +
            "(identifiant inconnu ou fichier expiré). Appelle `lister_fichiers` pour " +
            "obtenir les identifiants valides — n'invente ni identifiant ni contenu.",
          { status: "refused", id, code: "unknown_file" },
        );
      }

      const record = files.get(wire.id);
      if (!record) {
        return refused(
          `Lecture impossible : la fiche du fichier ${wire.id} n'a pas pu être relue ` +
            "(il a peut-être expiré). Rien n'a été lu.",
          { status: "unavailable", id: wire.id, code: "unknown_file" },
        );
      }

      const kind = record.analysis.kind;
      const base: Omit<ReadFileDetails, "status"> = {
        id: wire.id,
        name: wire.name,
        kind,
        mimeType: record.mimeType,
        bytes: record.bytes,
      };

      // ── IMAGE : la politique de VISION partagée décide (réduction éphémère,
      // refus explicite). Le modèle qui ne reçoit pas les images n'en reçoit pas.
      if (kind === "image") {
        if (options.imagesSupported === false) {
          options.logger?.info("files.read.opened", {
            sessionId,
            id: wire.id,
            kind,
            bytes: record.bytes,
            mode: "image",
            attached: false,
            reason: "model_without_vision",
          });
          return refused(
            `Le fichier « ${wire.name} » est bien une image, mais le modèle ` +
              `« ${options.modelLabel ?? "configuré"} » ne reçoit PAS les images ` +
              '(déclaration `input` = ["text"] dans models.json) : elle n\'est pas ' +
              "jointe ici et tu ne la vois pas. Ne prétends pas l'avoir vue. Pour la " +
              "voir : activer la vision du modèle dans /config (onglet « Modèles », " +
              "réglage « Reçoit les images »). En attendant, tu peux la DÉPOSER sur " +
              "une machine avec `deposer_fichier` (identifiant ci-dessus) : le " +
              "transfert ne passe pas par ta vision.",
            {
              ...base,
              status: "refused",
              mode: "image",
              image_attached: false,
              image_error: "model_without_vision",
              code: "model_without_vision",
            },
          );
        }

        let prepared;
        try {
          prepared = await files.prepareImages([wire]);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          options.logger?.info("files.read.opened", {
            sessionId,
            id: wire.id,
            kind,
            bytes: record.bytes,
            mode: "image",
            attached: false,
            reason: "read_failed",
          });
          return refused(
            `L'image « ${wire.name} » n'a pas pu être relue (${reason}) : elle n'est ` +
              "pas jointe ici et tu ne la vois pas. Rien n'a été lu.",
            { ...base, status: "refused", mode: "image", image_error: "file_image_unreadable" },
          );
        }

        const attached = prepared.ok ? prepared.images[0] : undefined;
        if (prepared.ok && attached !== undefined) {
          options.logger?.info("files.read.opened", {
            sessionId,
            id: wire.id,
            kind,
            bytes: record.bytes,
            mode: "image",
            attached: true,
            sentBytes: Buffer.byteLength(attached.data, "base64"),
            mimeType: attached.mimeType,
          });
          return {
            content: [
              {
                type: "text",
                text:
                  `Image « ${wire.name} » (${record.mimeType}, ` +
                  `${humanBytes(record.bytes)}) : elle t'est JOINte ci-dessous et tu ` +
                  "la VOIS. Si elle a dépassé les bornes de vision, une version " +
                  "réduite a été produite à la volée — l'original stocké, lui, n'est " +
                  "pas modifié (c'est celui que l'utilisateur télécharge).",
              },
              { type: "image", data: attached.data, mimeType: attached.mimeType },
            ],
            details: { ...base, status: "read", mode: "image", image_attached: true },
          };
        }

        // Refus de la politique de vision (trop petite, trop lourde, format non
        // transmissible) : aucun bloc image, la cause exacte est DITE.
        const code = prepared.ok ? "file_image_unreadable" : prepared.code;
        const message = prepared.ok
          ? `L'image « ${wire.name} » n'a pas pu être préparée : elle n'est pas jointe.`
          : prepared.message;
        options.logger?.info("files.read.opened", {
          sessionId,
          id: wire.id,
          kind,
          bytes: record.bytes,
          mode: "image",
          attached: false,
          reason: code,
        });
        return refused(
          `${message} ⚠️ Elle n'est donc PAS jointe ici : tu ne la vois pas — ne ` +
            "prétends pas le contraire. Le fichier reste téléchargeable dans la " +
            "conversation, et `deposer_fichier` peut le transférer tel quel.",
          { ...base, status: "refused", mode: "image", image_attached: false, image_error: code, code },
        );
      }

      // ── PDF : aucune extraction de texte n'existe (vérité mesurée du libraire).
      if (kind === "pdf") {
        return refused(
          `Lecture impossible : « ${wire.name} » est un PDF et ` +
            `${UNREADABLE_REASONS.pdf} Rien n'en est lu : utilise un autre chemin ` +
            "(conversion par l'utilisateur) ou dis-le dans ton rapport.",
          { ...base, status: "refused", code: "file_pdf_unreadable" },
        );
      }

      // ── GENRE INCONNU : ni texte ni image ⇒ refus, sans rien lire du tout.
      if (kind === "unknown") {
        return refused(
          `Lecture refusée : « ${wire.name} » n'est NI du texte NI une image (genre ` +
            "`inconnu`) : aucun binaire n'est envoyé dans un prompt. Le fichier reste " +
            "téléchargeable dans la conversation, et `deposer_fichier` peut le " +
            `transférer tel quel (identifiant ${wire.id}) — c'est le bon geste si la ` +
            "tâche est de l'envoyer sur une machine.",
          { ...base, status: "refused", code: "file_not_readable" },
        );
      }

      // ── BINAIRE / autre : refus propre, JAMAIS de binaire dans un prompt.
      if (kind === "text" && !record.analysis.readable) {
        return refused(
          `Lecture refusée : le contenu de « ${wire.name} » n'est pas du texte ` +
            `(${record.analysis.reason ?? UNREADABLE_REASONS.binary}) Rien n'en est lu ` +
            "et aucun octet binaire ne part dans ce prompt.",
          { ...base, status: "refused", code: "file_content_binary" },
        );
      }

      const bytes = files.readBytes(wire.id);
      if (!bytes || bytes.length === 0) {
        return refused(
          `Lecture impossible : les octets de « ${wire.name} » n'ont pas pu être relus ` +
            "sur le disque de Yuki. Rien n'a été lu.",
          { ...base, status: "unavailable", code: "file_unreadable" },
        );
      }

      // ⚠️ Lecture BORNÉE (jamais le fichier entier) puis décodage : l'UTF-16
      // contient un octet NUL sur deux et serait déclaré « binaire » s'il était
      // jugé sur ses octets bruts. On décode D'ABORD, on juge le texte ENSUITE.
      const readBytes = bytes.subarray(0, MAX_ANALYSIS_READ_BYTES);
      const textual = isTextDeclaration(record.ext, record.mimeType);
      const decoded = decodeTextSample(readBytes, { textual });
      const binary =
        decoded.encoding === "utf8"
          ? looksBinary(readBytes)
          : looksBinary(Buffer.from(decoded.text, "utf8"));
      if (binary) {
        return refused(
          `Lecture refusée : le contenu de « ${wire.name} » n'est pas du texte ` +
            `(${UNREADABLE_REASONS.binary}) Rien n'en est lu et aucun octet binaire ne ` +
            "part dans ce prompt. Tu peux en revanche le DÉPOSER sur une machine avec " +
            `\`deposer_fichier\` (identifiant ${wire.id}).`,
          { ...base, status: "refused", code: "file_content_binary", readBytes: readBytes.length },
        );
      }

      const text = decoded.text;
      const total = text.length;
      const debut = coerceOffset(input.debut);
      if (debut === undefined) {
        return refused(
          "Lecture refusée : `debut` doit être un entier positif ou nul (décalage en " +
            "CARACTÈRES). Rien n'a été lu.",
          { ...base, status: "refused", code: "invalid_offset" },
        );
      }
      if (debut > 0 && debut >= total) {
        const windowNote =
          readBytes.length < record.bytes
            ? ` dans les ${humanBytes(readBytes.length)} premiers octets`
            : "";
        return refused(
          `Lecture impossible : \`debut: ${debut}\` dépasse la fin du texte lu de ` +
            `« ${wire.name} » (${total} caractères décodés${windowNote}). ` +
            "Rien n'a été rendu : demande `debut: 0` pour repartir du début.",
          { ...base, status: "refused", code: "range_out_of_bounds", readBytes: readBytes.length },
        );
      }

      const window = total - debut;
      if (window > maxChars && debut === 0) {
        // ⚠️ JAMAIS de troncature muette : appel par DÉFAUT sur un fichier trop long
        // ⇒ on refuse et on donne la plage EXACTE à demander ensuite (un appel de
        // plus, pas un fichier amputé en silence). Une plage EXPLICITE (`debut` > 0),
        // elle, est servie et bornée — et le reste est ANNONCÉ (`debut` suivant).
        const note =
          readBytes.length < record.bytes
            ? ` ⚠️ Cet outil ne lit que les ${humanBytes(readBytes.length)} premiers octets ` +
              `du fichier (${humanBytes(record.bytes)}) : la suite au-delà n'est pas atteignable par lui.`
            : "";
        options.logger?.info("files.read.opened", {
          sessionId,
          id: wire.id,
          kind: "text",
          bytes: record.bytes,
          mode: "texte",
          readBytes: readBytes.length,
          totalChars: total,
          reason: "over_limit",
        });
        return refused(
          `Lecture REFUSÉE au-delà du plafond : le texte décodé de « ${wire.name} » ` +
            `fait ${total} caractères, pour un plafond de ${maxChars} caractères par ` +
            `appel. RIEN n'a été tronqué en silence : rappelle \`lire_fichier\` avec ` +
            `\`identifiant: "${wire.id}"\` et \`debut: ${maxChars}\` pour lire la suite ` +
            `(${maxChars} caractères par appel, jusqu'au caractère ${total}).` +
            note,
          {
            ...base,
            status: "refused",
            mode: "texte",
            code: "file_text_too_long",
            readBytes: readBytes.length,
            range: { debut, fin: Math.min(total, debut + maxChars), total },
          },
        );
      }

      const slice = text.slice(debut, debut + maxChars);
      const end = debut + slice.length;
      // ⚠️ Encadrement comme DONNÉE (échappement + rappel anti-injection) : un
      // fichier peut contenir « ignore tes consignes », ce n'est jamais un ordre.
      // Les bornes de `frameFiles` sont calées sur la plage EXACTE : aucune coupe
      // possible ici (elle a déjà été refusée plus haut, explicitement).
      const framed =
        frameFiles(
          [
            {
              name: wire.name,
              mimeType: record.mimeType,
              bytes: record.bytes,
              kind: "text",
              readable: true,
              text: slice,
              storedChars: slice.length,
            },
          ],
          { promptChars: slice.length, promptTotalChars: slice.length },
        ) ?? "";

      options.logger?.info("files.read.opened", {
        sessionId,
        id: wire.id,
        kind: "text",
        bytes: record.bytes,
        mode: "texte",
        readBytes: readBytes.length,
        chars: slice.length,
        from: debut,
        to: end,
        totalChars: total,
        encoding: decoded.encoding,
      });

      const header =
        `Texte de « ${wire.name} » (${record.mimeType}, ${humanBytes(record.bytes)}, ` +
        `encodage ${decoded.encoding}) — caractères ${debut} à ${end} sur ${total} ` +
        "décodés." +
        (readBytes.length < record.bytes
          ? ` ⚠️ Lecture bornée aux ${humanBytes(readBytes.length)} premiers octets du fichier.`
          : "") +
        (end < total
          ? ` Pour la suite : \`lire_fichier\` avec \`debut: ${end}\`.`
          : "");
      return {
        content: [{ type: "text", text: `${header}\n${framed}` }],
        details: {
          ...base,
          status: "read",
          mode: "texte",
          chars: slice.length,
          range: { debut, fin: end, total },
          readBytes: readBytes.length,
        },
      };
    },
  });

  return [tool];
}
