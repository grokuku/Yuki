/**
 * Adaptateur SDK de la réduction d'image pour la VISION (`resizeImage`, Photon).
 *
 * ⚠️ Pourquoi ici : `src/files/**` est un domaine SANS dépendance au SDK (le
 * test de frontière `tests/pi/boundary.test.ts` verrouille l'allowlist des
 * imports). La POLITIQUE de réduction vit donc dans `src/files/vision.ts`, et
 * l'IMPLÉMENTATION qui la réalise (le redimensionneur du SDK) est exposée par la
 * façade `src/pi/index.ts` à la composition root.
 *
 * ⚠️ Mesures faites sur cette machine (Node 22, Photon WASM présent) :
 *   - image déjà conforme : ~100 ms par appel (démarrage du worker + WASM) ⇒
 *     c'est pourquoi `prepareVisionImage` ne l'appelle QUE s'il y a à réduire ;
 *   - capture 2560×1440 (569 Ko) ramenée à 2000×1125 : ~1,8 s ;
 *   - image de 9 Mo ramenée sous 3,5 Mo : ~2,1 s (et ~3,8 s sous 1 Mo).
 * Ce coût est payé UNE fois, au moment d'envoyer le message (TTFT), et rien
 * n'est écrit sur le disque : la version réduite est éphémère.
 */

import { resizeImage } from "@earendil-works/pi-coding-agent";

import type { VisionImageResizer } from "../../files/vision.js";

/**
 * Redimensionneur par défaut : `resizeImage` du SDK 0.85.1.
 *
 * ⚠️ Renvoie `null` quand l'image ne peut pas tenir sous le budget demandé (ou
 * si Photon est indisponible) — la politique traduit alors ce `null` en refus
 * explicite, jamais en envoi silencieux d'une image démesurée.
 */
export const sdkVisionImageResizer: VisionImageResizer = (bytes, mimeType, options) =>
  resizeImage(bytes, mimeType, options);
