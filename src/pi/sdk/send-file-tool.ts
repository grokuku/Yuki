/**
 * Outil custom `envoyer_fichier` — Yuki ENVOIE un fichier à l'utilisateur.
 *
 * Deux cas couverts, avec le MÊME outil :
 *  - CAS A : un fichier que l'utilisateur lui a ENVOYÉ (il est stocké, analysé et
 *    rattaché à cette conversation) — Yuki le renvoie ;
 *  - CAS B : un fichier venu d'un AGENT. ⚠️ L'agent Go ne sait PAS transférer de
 *    fichier (son protocole n'a que `stdout`/`stderr` et l'image de capture
 *    d'écran) : un tel fichier ne peut donc exister QUE s'il a été déposé dans le
 *    même stockage par le mécanisme d'entrée externe (chantier suivant). L'outil
 *    n'invente rien : sans fichier correspondant, il le DIT.
 *
 * ⚠️ L'envoi ne transmet AUCUN contenu au modèle : il rend le fichier CLIQUABLE
 * et TÉLÉCHARGEABLE dans le fil (chemin same-origin `/fichiers/<id>.<ext>`), et
 * le modèle apprend qu'il l'a envoyé (résultat de l'outil).
 *
 * ⚠️ Périmètre STRICT : seuls les fichiers DE CETTE conversation sont envoyables
 * (aucune fuite d'un fil à l'autre, aucun accès au répertoire par un chemin).
 */

import {
  defineTool,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { humanBytes, type FilesSendPort, type WireFile } from "../../files/index.js";

/** Détails structurés renvoyés par l'outil (rendu UI, jamais un contenu). */
interface SendFileDetails {
  status: "sent" | "unknown" | "unavailable";
  reference?: string;
  file?: WireFile;
  available?: string[];
}

/** Identifiant de la session (conversation) courante, ou `undefined`. */
function sessionIdFromContext(ctx: ExtensionContext | undefined): string | undefined {
  if (!ctx) return undefined;
  try {
    const id = ctx.sessionManager.getSessionId();
    return id && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Résumé d'un fichier envoyable (nom + taille + lisibilité), sans contenu. */
function describe(file: WireFile): string {
  const state = file.readable ? "lisible" : "non lisible";
  return `- « ${file.name} » (${humanBytes(file.bytes)}, ${state})`;
}

/**
 * Construit l'outil `envoyer_fichier`. Le port fournit la liste des fichiers de
 * la conversation et effectue l'envoi (diffusion vers l'interface).
 */
export function createSendFileTools(files: FilesSendPort): ToolDefinition[] {
  const tool = defineTool({
    name: "envoyer_fichier",
    label: "Envoyer un fichier à l'utilisateur",
    description:
      "Envoie à l'utilisateur un fichier DÉJÀ présent dans cette conversation : " +
      "un fichier qu'il t'a joint (tu le lui renvoies), ou un fichier déposé pour " +
      "lui (par exemple par un agent). Le fichier apparaît DANS le fil, cliquable " +
      "et téléchargeable — tu n'as PAS à en recopier le contenu. Sans argument, " +
      "liste les fichiers envoyables de cette conversation. Avec un identifiant " +
      "ou un nom EXACT, envoie ce fichier. ⚠️ Tu ne peux envoyer que les fichiers " +
      "de CETTE conversation : si aucun ne correspond, l'outil le dit (n'invente " +
      "jamais un fichier, ne promets jamais un envoi que tu ne peux pas faire).",
    promptSnippet:
      "envoyer_fichier(fichier?) — renvoie à l'utilisateur un fichier de cette conversation (liste si omis)",
    parameters: Type.Object({
      fichier: Type.Optional(
        Type.String({
          maxLength: 256,
          description:
            "Identifiant OU nom EXACT du fichier à envoyer. Omis ⇒ liste des " +
            "fichiers envoyables (sans contenu).",
        }),
      ),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const sessionId = sessionIdFromContext(ctx);
      if (!sessionId) {
        const payload: SendFileDetails = { status: "unavailable" };
        return {
          content: [
            {
              type: "text",
              text:
                "Envoi de fichier impossible : aucune conversation courante n'est " +
                "identifiée. Rien n'a été envoyé.",
            },
          ],
          details: payload,
        };
      }

      const requested = (params as { fichier?: unknown }).fichier;
      const reference =
        typeof requested === "string" && requested.trim().length > 0
          ? requested.trim()
          : undefined;
      const available = files.listForSession(sessionId);

      if (reference === undefined) {
        const text =
          available.length === 0
            ? "Aucun fichier envoyable dans cette conversation. Tu ne peux donc " +
              "envoyer aucun fichier pour l'instant — dis-le à l'utilisateur au " +
              "lieu d'en promettre un."
            : "Fichiers envoyables dans cette conversation (aucun contenu n'est " +
              "affiché) :\n" +
              available.map(describe).join("\n") +
              "\n\nPour en envoyer un, appelle `envoyer_fichier` avec son nom " +
              "EXACT ou son identifiant.";
        const details: SendFileDetails = {
          status: available.length === 0 ? "unknown" : "sent",
          available: available.map((file) => file.name),
        };
        return { content: [{ type: "text", text }], details };
      }

      const sent = files.send(sessionId, reference);
      if (!sent) {
        const names = available.map((file) => file.name);
        const payload: SendFileDetails = {
          status: "unknown",
          reference,
          available: names,
        };
        const text =
          `Aucun fichier nommé « ${reference} » dans cette conversation : rien n'a ` +
          "été envoyé. " +
          (names.length === 0
            ? "Aucun fichier n'est disponible ici."
            : "Fichiers envoyables : " + names.map((name) => `« ${name} »`).join(", ") + ".");
        return { content: [{ type: "text", text }], details: payload };
      }

      const details: SendFileDetails = { status: "sent", reference, file: sent };
      return {
        content: [
          {
            type: "text",
            text:
              `Fichier envoyé : « ${sent.name} » (${humanBytes(sent.bytes)}). ` +
              "Il est maintenant affiché DANS la conversation, cliquable et " +
              "téléchargeable par l'utilisateur — inutile d'en recopier le contenu. " +
              "Il reste disponible jusqu'à sa date d'expiration (rétention " +
              "configurée dans /config).",
          },
        ],
        details,
      };
    },
  });

  return [tool];
}
