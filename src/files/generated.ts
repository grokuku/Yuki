/**
 * COPIE d'une IMAGE GÉNÉRÉE dans le STORE DES FICHIERS de la conversation.
 *
 * ⚠️ POURQUOI CE MODULE EXISTE : `generer_image` écrit l'image dans le store des
 * images générées (`/images/<id>.<ext>`, `src/comfy/images.ts`) — un store que
 * `lister_fichiers`, `lire_fichier` et `deposer_fichier` ne savent pas résoudre
 * (ils n'acceptent que les identifiants du store des fichiers,
 * `src/files/store.ts:ID_RE`). Sans cette copie, une image générée n'était donc
 * **ni listable, ni lisible, ni transférable** : le parcours
 * `generer_image` → `deposer_fichier` restait cassé (décision utilisateur :
 * « j'en ai absolument besoin »).
 *
 * DÉCISION : on COPIE à la génération (et non un adaptateur de lecture). Une
 * image copiée survit à la purge de ComfyUI **et** à l'expiration de la copie
 * Comfy ; un adaptateur, lui, aurait laissé l'image « disparaître » — le pire
 * résultat pour un besoin affirmé. Coût assumé : deux copies sur disque et deux
 * enregistrements d'expiration, tous deux gouvernés par le MÊME réglage
 * (`files.retentionDays`) et la MÊME règle (`retention.ts`).
 *
 * ⚠️ CE QUE CE MODULE NE FAIT JAMAIS :
 *  - il n'échoue JAMAIS la génération : un refus de copie est une ISSUE
 *    (`ok: false` + message français), jamais une exception qui remonterait
 *    jusqu'à `generer_image` (l'image, elle, est bien générée et affichée) ;
 *  - il ne RECOPIE pas une image déjà copiée : la correspondance
 *    image → fichier est mémorisée dans les métadonnées de l'image
 *    (`GeneratedImagesStore.attachFile`), et une copie EXPIRÉE est refaite
 *    (l'identifiant mémorisé ne résout plus) ;
 *  - il ne journalise aucun octet : identifiants, tailles et types seulement.
 */

import type { FileRejectionCode, FilesPort, StoredFileRecord, WireFile } from "./types.js";
import type { FilesLogger } from "./store.js";

/** Correspondance type MIME → extension (alignée sur les types servis). */
const EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/jpg", "jpg"],
  ["image/webp", "webp"],
]);

/** Entrée d'une copie (appelée juste après une génération réussie). */
export interface GeneratedImageFileInput {
  /** Identifiant de l'image dans le store des IMAGES GÉNÉRÉES. */
  imageId: string;
  /** Octets de l'image (l'original conservé par le store des images). */
  data: Uint8Array;
  /** Type MIME réel de l'image. */
  mimeType: string;
  /** Conversation demandeuse : la copie y est rattachée (donc listable). */
  sessionId?: string;
}

/**
 * Issue d'une copie.
 *
 * `copied: false` sur succès ⇒ l'image était DÉJÀ copiée (déduplication) : le
 * fichier rendu est celui de la copie existante, aucun octet n'a été réécrit.
 */
export type GeneratedImageFileOutcome =
  | { ok: true; file: WireFile; copied: boolean }
  | { ok: false; code: FileRejectionCode | "unsupported_type" | "io_error"; message: string };

/** Port consommé par l'outil `generer_image` (jamais le disque, jamais le SDK). */
export interface GeneratedImageFilesPort {
  /**
   * Copie l'image dans le store des fichiers, rattachée à la conversation.
   * ⚠️ N'échoue jamais la génération : l'appelant transforme `ok: false` en
   * AVERTISSEMENT dans le résultat de l'outil.
   */
  archive(input: GeneratedImageFileInput): GeneratedImageFileOutcome;
}

/** Ce que la copie a besoin de savoir du store d'IMAGES (déduplication). */
export interface GeneratedImageLinkPort {
  /** Fiche de l'image (au moins la copie déjà faite, si elle existe). */
  get(id: string): { fileId?: string } | null;
  /** Mémorise le fichier qui porte la copie de cette image. */
  attachFile(id: string, fileId: string): unknown;
}

export interface GeneratedImageFilesOptions {
  /** Store des fichiers (dépôt en mémoire, résolution, vue client). */
  files: Pick<FilesPort, "saveBytes" | "get" | "toWire">;
  /** Store des images générées (lien image → fichier, pour la déduplication). */
  images: GeneratedImageLinkPort;
  logger?: FilesLogger;
}

/** Message français d'un refus du stockage (jamais un code nu). */
function rejectionMessage(
  result: { code: FileRejectionCode; receivedBytes: number; limitBytes: number },
  name: string,
): string {
  switch (result.code) {
    case "too_large":
      return (
        `la copie de l'image (${result.receivedBytes} octets, « ${name} ») dépasse le ` +
        `plafond par fichier (${result.limitBytes} octets, réglage files.maxFileBytes)`
      );
    case "empty":
      return "les octets de l'image sont vides, la copie n'a rien à écrire";
    case "empty_name":
      return "le nom de la copie est vide après assainissement";
    case "digest_mismatch":
    case "interrupted":
      return "l'écriture de la copie a été interrompue";
    case "io_error":
    default:
      return "le stockage des fichiers a refusé l'écriture (erreur d'entrée/sortie)";
  }
}

/**
 * Fabrique le port de copie image → fichiers.
 *
 * ⚠️ Aucune dépendance au SDK ni au HTTP : `src/index.ts` le branche avec le
 * VRAI store des fichiers et le VRAI store des images ; les tests peuvent le
 * exercer sans réseau.
 */
export function createGeneratedImageFiles(
  options: GeneratedImageFilesOptions,
): GeneratedImageFilesPort {
  const { files, images } = options;
  const logger = options.logger;

  /** Copie déjà faite et ENCORE VALABLE (l'expirée ne compte pas). */
  function existingCopy(imageId: string): StoredFileRecord | null {
    let fileId: string | undefined;
    try {
      fileId = images.get(imageId)?.fileId;
    } catch (error) {
      logger?.warn("files.generated.link_failed", {
        image_id: imageId,
        reason: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    if (typeof fileId !== "string") return null;
    // `get` répond `null` pour un fichier EXPIRÉ (et le supprime) : on recopie
    // alors, sinon l'image n'aurait plus aucune trace dans la conversation.
    return files.get(fileId);
  }

  return {
    archive(input) {
      const mimeType = (input.mimeType.split(";")[0] ?? "").trim().toLowerCase();
      const ext = EXTENSIONS.get(mimeType);
      if (ext === undefined) {
        // Pas de copie « au hasard » d'un type qu'on ne sait pas servir : l'image
        // reste affichée, et l'avertissement dit pourquoi elle n'est pas un fichier.
        return {
          ok: false,
          code: "unsupported_type",
          message: `le format « ${input.mimeType} » n'est pas un format d'image servi par Yuki (png, jpeg, webp)`,
        };
      }

      const existing = existingCopy(input.imageId);
      if (existing) {
        logger?.info("files.generated.already_copied", {
          image_id: input.imageId,
          file_id: existing.id,
        });
        return { ok: true, file: files.toWire(existing), copied: false };
      }

      // ⚠️ Nom d'affichage DÉRIVÉ de l'identifiant de l'image (jamais le
      // `filename` renvoyé par ComfyUI, qui est une donnée externe) : l'extension
      // vient du type MIME, assainie par le stockage.
      const name = `image-generee-${input.imageId.slice(0, 8)}.${ext}`;
      let result;
      try {
        result = files.saveBytes(input.data, {
          name,
          mimeType,
          // Une image GÉNÉRÉE est produite par Yuki, pas déposée par l'utilisateur.
          origin: "yuki",
          ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        });
      } catch (error) {
        logger?.warn("files.generated.copy_failed", {
          image_id: input.imageId,
          reason: error instanceof Error ? error.message : String(error),
        });
        return {
          ok: false,
          code: "io_error",
          message: `le stockage des fichiers a levé une erreur (${
            error instanceof Error ? error.message : String(error)
          })`,
        };
      }
      if (!result.ok) {
        logger?.warn("files.generated.rejected", {
          image_id: input.imageId,
          code: result.code,
          bytes: result.receivedBytes,
          limit: result.limitBytes,
        });
        return { ok: false, code: result.code, message: rejectionMessage(result, name) };
      }

      // ⚠️ Le lien image → fichier sert la DÉDUPLICATION. Un échec d'écriture de ce
      // lien n'invalide PAS la copie (elle existe) : on le signale seulement.
      try {
        images.attachFile(input.imageId, result.record.id);
      } catch (error) {
        logger?.warn("files.generated.link_write_failed", {
          image_id: input.imageId,
          file_id: result.record.id,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      logger?.info("files.generated.copied", {
        image_id: input.imageId,
        file_id: result.record.id,
        name: result.record.name,
        bytes: result.record.bytes,
        mime_type: mimeType,
        session_id: input.sessionId ?? null,
        expires_at: result.record.expiresAt,
      });
      return { ok: true, file: files.toWire(result.record), copied: true };
    },
  };
}
