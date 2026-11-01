/**
 * Outil custom `lister_fichiers` — liste les PIÈCES JOINTES d'une conversation.
 *
 * ⚠️ POURQUOI CET OUTIL EXISTE : `deposer_fichier` exige l'IDENTIFIANT du
 * fichier (`/^[a-f0-9]{32}$/`, `src/files/store.ts:76`), or AUCUN outil ne
 * rendait cet identifiant au worker lourd. Le worker recevait « dépose
 * l'image » sans pouvoir nommer quoi que ce soit. `lister_fichiers` est ce
 * chaînon manquant.
 *
 * ⚠️ LECTURE SEULE : l'outil liste des métadonnées (identifiant, nom, genre,
 * taille, date, lisibilité). Il n'envoie rien, n'écrit rien, ne lit aucun
 * contenu, et ne sort JAMAIS du périmètre d'UNE conversation.
 *
 * ⚠️ La conversation est celle de la session PROPRIÉTAIRE (`lightSessionId`),
 * forcée par le worker lourd : l'identifiant de la session éphémère ne
 * désignerait aucun fichier (même piège que la validation d'action, cf.
 * `buildHeavyActionTools`).
 */

import {
  defineTool,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  MAX_LISTED_ATTACHMENTS,
  formatAttachmentLine,
  type FilesListPort,
  type WireFile,
} from "../../files/index.js";

export interface ListFilesToolOptions {
  /** Conversation FORCÉE (worker lourd : la conversation propriétaire). */
  sessionId?: () => string | undefined;
  /** Plafond de lignes (défaut `MAX_LISTED_ATTACHMENTS`). */
  max?: number;
}

/** Détails structurés (rendu UI, jamais un contenu de fichier). */
interface ListFilesDetails {
  status: "listed" | "empty" | "unavailable";
  total?: number;
  shown?: number;
  omitted?: number;
  files?: Array<Pick<WireFile, "id" | "name" | "kind" | "bytes" | "createdAt">>;
}

/** Identifiant de la session courante, ou `undefined` (jamais une exception). */
function sessionIdFromContext(ctx: ExtensionContext | undefined): string | undefined {
  if (!ctx) return undefined;
  try {
    const id = ctx.sessionManager.getSessionId();
    return id && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Résout la conversation : l'ID FORCÉ prime, sinon celui du contexte de l'outil. */
function resolveSessionId(
  ctx: ExtensionContext | undefined,
  options: ListFilesToolOptions,
): string | undefined {
  const forced = options.sessionId?.();
  if (forced && forced.length > 0) return forced;
  return sessionIdFromContext(ctx);
}

/**
 * Construit l'outil `lister_fichiers`. Le port ne rend que des métadonnées ;
 * l'outil ne peut donc pas divulguer un contenu.
 */
export function createListFilesTool(
  files: FilesListPort,
  options: ListFilesToolOptions = {},
): ToolDefinition[] {
  const max = Math.max(0, Math.trunc(options.max ?? MAX_LISTED_ATTACHMENTS));

  const tool = defineTool({
    name: "lister_fichiers",
    label: "Lister les fichiers de la conversation",
    description:
      "Liste les PIÈCES JOINTES de la conversation (métadonnées SEULES : identifiant, " +
      "nom, genre, taille, date, lisibilité). Aucun contenu n'est lu ni transmis. " +
      "⚠️ L'IDENTIFIANT (32 caractères hexadécimaux) est ce qu'exigent `lire_fichier` " +
      "(LIRE le contenu : image vue, texte décodé) et `deposer_fichier` (transfert " +
      "vers une machine) : c'est ici qu'on le trouve. " +
      "La liste est BORNÉE et dit explicitement combien de fichiers ne sont pas " +
      "montrés — n'invente jamais un fichier absent de cette liste.",
    promptSnippet:
      "lister_fichiers() — pièces jointes de la conversation, avec leurs IDENTIFIANTS",
    parameters: Type.Object({}),
    execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
      const sessionId = resolveSessionId(ctx, options);
      if (!sessionId) {
        const details: ListFilesDetails = { status: "unavailable" };
        return {
          content: [
            {
              type: "text",
              text:
                "Liste impossible : aucune conversation n'est identifiée pour cet " +
                "appel. Rien n'a été listé — ne devine aucun identifiant de fichier.",
            },
          ],
          details,
        };
      }

      const listed = files.listForSession(sessionId);
      if (listed.length === 0) {
        const details: ListFilesDetails = { status: "empty", total: 0, shown: 0 };
        return {
          content: [
            {
              type: "text",
              text:
                "Aucune pièce jointe dans cette conversation. Tu ne peux donc " +
                "transférer aucun fichier d'ici — dis-le au lieu d'en inventer un.",
            },
          ],
          details,
        };
      }

      const shownFiles = listed.slice(0, Math.min(max, listed.length));
      const omitted = listed.length - shownFiles.length;
      const lines = [
        `Pièces jointes de cette conversation (identifiant, nom, genre, taille) — ` +
          `${shownFiles.length} montrée(s) sur ${listed.length} :`,
        "(Aucun contenu ici : utilise `lire_fichier` avec un identifiant pour lire " +
          "le contenu d'un de ces fichiers.)",
        ...shownFiles.map(formatAttachmentLine),
      ];
      if (omitted > 0) {
        lines.push(
          `⚠️ ${omitted} autre(s) pièce(s) jointe(s) non listée(s) (plafond de ${max}). ` +
            "La liste est bornée : dis-le si tu as besoin de celles qui manquent.",
        );
      }
      const details: ListFilesDetails = {
        status: "listed",
        total: listed.length,
        shown: shownFiles.length,
        omitted,
        files: shownFiles.map((file: WireFile) => ({
          id: file.id,
          name: file.name,
          kind: file.kind,
          bytes: file.bytes,
          createdAt: file.createdAt,
        })),
      };
      return { content: [{ type: "text", text: lines.join("\n") }], details };
    },
  });

  return [tool];
}
