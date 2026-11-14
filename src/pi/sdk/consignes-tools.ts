/**
 * Outils des CONSIGNES DURABLES du bot (décision utilisateur du 2026-11-14).
 *
 * Quatre outils, deux natures :
 *
 *  - `memoriser_consigne(texte)` — enregistre une instruction IMPÉRATIVE
 *    (« ne refais plus jamais ça ») ;
 *  - `ajouter_fait(texte)` — enregistre une information DÉCLARATIVE
 *    (« mon NAS est à 10.0.0.5 ») ;
 *  - `lister_consignes()` — relit les deux listes (avec leurs compteurs) ;
 *  - `oublier_consigne(texte)` — supprime UNE entrée, **refusé si plusieurs
 *    correspondent** (retirer la mauvaise consigne serait pire que ne rien
 *    faire).
 *
 * ⚠️ ÉCRITURE DIRECTE par le bot : c'est le choix de l'utilisateur (« qu'il
 * puisse enregistrer l'instruction quelque part »). Le fichier reste LISIBLE et
 * ÉDITABLE à la main, et l'interface de la page du bot permet de tout supprimer.
 *
 * ⚠️ CE N'EST PAS LA MÉMOIRE : la mémoire est *recherchée* (rappel pertinent),
 * ces listes sont *toujours* injectées. Les outils le disent, sinon le modèle
 * enregistrerait indistinctement dans l'un ou l'autre.
 *
 * ⚠️ Le port est celui d'UN bot (chemin capturé) : ces outils ne peuvent pas
 * écrire dans le fichier d'un autre bot. Aucun `botId` n'apparaît ici.
 */

import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  MAX_CONSIGNES,
  MAX_ENTREE_CHARS,
  MAX_FAITS,
  type ConsignesDocument,
  type PortConsignes,
} from "../../consignes/index.js";

/** Détails structurés rendus à l'interface (jamais un contenu secret). */
interface DetailsConsignes {
  status: "enregistre" | "deja_present" | "refus" | "liste" | "supprime";
  nature?: "consigne" | "fait";
  consignes: number;
  faits: number;
  raison?: string;
}

/** Ligne de compteur affichée (elle rend les bornes visibles). */
function compteurs(document: ConsignesDocument): string {
  return `Consignes : ${document.consignes.length} / ${MAX_CONSIGNES} · Faits : ${document.faits.length} / ${MAX_FAITS}`;
}

/** Rendu d'une liste (vide ⇒ phrase honnête, jamais un titre orphelin). */
function renduListe(titre: string, entrees: readonly string[]): string {
  if (entrees.length === 0) return `${titre} : (aucune)`;
  return [titre, ...entrees.map((entree) => `- ${entree}`)].join("\n");
}

/** Texte de refus : il DIT le motif et l'action attendue. */
function texteRefus(message: string): string {
  return `Refusé — ${message}`;
}

/**
 * Construit les quatre outils. `consignes` est le port du bot PROPRIÉTAIRE de
 * ce host : l'écriture ne peut pas viser un autre fichier.
 */
export function createConsignesTools(consignes: PortConsignes): ToolDefinition[] {
  const memoriser = defineTool({
    name: "memoriser_consigne",
    label: "Enregistrer une consigne durable",
    description:
      "Enregistre une CONSIGNE DURABLE : une instruction IMPÉRATIVE de " +
      "l'utilisateur qui s'appliquera à CHAQUE tour désormais (ex. « ne refais " +
      "plus jamais ça », « réponds toujours en tutoyant »). " +
      "⚠️ À utiliser quand l'utilisateur demande un changement DURABLE de " +
      "comportement. Ce n'est PAS la mémoire : la mémoire est recherchée au tour, " +
      "une consigne est TOUJOURS injectée. Pour une information factuelle " +
      "(« mon NAS est à 10.0.0.5 »), utilise `ajouter_fait`. " +
      `Une entrée est limitée à ${MAX_ENTREE_CHARS} caractères et la liste à ` +
      `${MAX_CONSIGNES} : au-delà, l'outil REFUSE et vous devez le dire à ` +
      "l'utilisateur (aucune troncature silencieuse). Un doublon n'est pas ajouté.",
    promptSnippet:
      "memoriser_consigne(texte) — enregistre une consigne impérative TOUJOURS injectée",
    parameters: Type.Object({
      texte: Type.String({
        minLength: 1,
        maxLength: MAX_ENTREE_CHARS,
        description: "La consigne, à l'impératif et en une phrase.",
      }),
    }),
    execute: async (_toolCallId, params) => {
      const texte = String((params as { texte?: unknown }).texte ?? "");
      const resultat = consignes.ajouter("consigne", texte);
      if (!resultat.ok) {
        const details: DetailsConsignes = {
          status: "refus",
          nature: "consigne",
          consignes: resultat.document.consignes.length,
          faits: resultat.document.faits.length,
          raison: resultat.refus,
        };
        return { content: [{ type: "text", text: texteRefus(resultat.message) }], details };
      }
      if (resultat.dejaPresent) {
        const details: DetailsConsignes = {
          status: "deja_present",
          nature: "consigne",
          consignes: resultat.document.consignes.length,
          faits: resultat.document.faits.length,
        };
        return {
          content: [
            {
              type: "text",
              text: `Cette consigne est DÉJÀ enregistrée (aucun doublon créé). ${compteurs(resultat.document)}`,
            },
          ],
          details,
        };
      }
      const details: DetailsConsignes = {
        status: "enregistre",
        nature: "consigne",
        consignes: resultat.document.consignes.length,
        faits: resultat.document.faits.length,
      };
      return {
        content: [
          {
            type: "text",
            text:
              `Consigne enregistrée : elle sera injectée à CHAQUE tour, dès le prochain. ${compteurs(resultat.document)}`,
          },
        ],
        details,
      };
    },
  });

  const ajouterFait = defineTool({
    name: "ajouter_fait",
    label: "Enregistrer un fait durable",
    description:
      "Enregistre un FAIT DURABLE : une information DÉCLARATIVE que tu devras " +
      "connaître à CHAQUE tour (ex. « mon NAS est à 10.0.0.5 », « le mot de passe " +
      "du Wi-Fi invité est affiché dans le salon », « je travaille de nuit »). " +
      "⚠️ Ce n'est PAS une consigne (pas une instruction à suivre) et ce n'est PAS " +
      "la mémoire (un fait est TOUJOURS injecté, un souvenir est recherché). Pour " +
      "une instruction impérative, utilise `memoriser_consigne`. " +
      `Une entrée est limitée à ${MAX_ENTREE_CHARS} caractères et la liste à ` +
      `${MAX_FAITS} : au-delà, l'outil REFUSE explicitement. Un doublon n'est pas ajouté.`,
    promptSnippet: "ajouter_fait(texte) — enregistre un fait TOUJOURS injecté",
    parameters: Type.Object({
      texte: Type.String({
        minLength: 1,
        maxLength: MAX_ENTREE_CHARS,
        description: "Le fait, en une phrase déclarative.",
      }),
    }),
    execute: async (_toolCallId, params) => {
      const texte = String((params as { texte?: unknown }).texte ?? "");
      const resultat = consignes.ajouter("fait", texte);
      if (!resultat.ok) {
        const details: DetailsConsignes = {
          status: "refus",
          nature: "fait",
          consignes: resultat.document.consignes.length,
          faits: resultat.document.faits.length,
          raison: resultat.refus,
        };
        return { content: [{ type: "text", text: texteRefus(resultat.message) }], details };
      }
      if (resultat.dejaPresent) {
        const details: DetailsConsignes = {
          status: "deja_present",
          nature: "fait",
          consignes: resultat.document.consignes.length,
          faits: resultat.document.faits.length,
        };
        return {
          content: [
            {
              type: "text",
              text: `Ce fait est DÉJÀ enregistré (aucun doublon créé). ${compteurs(resultat.document)}`,
            },
          ],
          details,
        };
      }
      const details: DetailsConsignes = {
        status: "enregistre",
        nature: "fait",
        consignes: resultat.document.consignes.length,
        faits: resultat.document.faits.length,
      };
      return {
        content: [
          {
            type: "text",
            text: `Fait enregistré : il sera rappelé à CHAQUE tour, dès le prochain. ${compteurs(resultat.document)}`,
          },
        ],
        details,
      };
    },
  });

  const lister = defineTool({
    name: "lister_consignes",
    label: "Lister les consignes et les faits durables",
    description:
      "Relit les CONSIGNES (instructions impératives) et les FAITS (informations " +
      "déclaratrices) enregistrés pour ce bot, avec leurs compteurs et leurs " +
      "bornes. À utiliser quand l'utilisateur demande « qu'est-ce que tu as " +
      "retenu ? », « quelles consignes as-tu ? », ou avant de supprimer une entrée " +
      "dont il faut connaître le texte EXACT. Lecture seule.",
    promptSnippet: "lister_consignes() — relit les consignes et les faits durables",
    parameters: Type.Object({}),
    execute: async () => {
      const document = consignes.lire();
      const details: DetailsConsignes = {
        status: "liste",
        consignes: document.consignes.length,
        faits: document.faits.length,
      };
      const text = [
        compteurs(document),
        "",
        renduListe("Consignes", document.consignes),
        "",
        renduListe("Faits", document.faits),
      ].join("\n");
      return { content: [{ type: "text", text }], details };
    },
  });

  const oublier = defineTool({
    name: "oublier_consigne",
    label: "Supprimer une consigne ou un fait durable",
    description:
      "Supprime UNE consigne (ou UN fait) enregistré. " +
      "⚠️ La correspondance doit être UNIQUE : si plusieurs entrées correspondent " +
      "au texte donné, l'outil REFUSE et vous demande de préciser (recopiez le " +
      "texte entier, tel que `lister_consignes` l'affiche). Aucune suppression " +
      "silencieuse, aucun retrait en masse. Utilisez `lister_consignes` d'abord " +
      "si vous n'êtes pas sûr du texte exact.",
    promptSnippet:
      "oublier_consigne(texte) — supprime UNE entrée (refus si la correspondance n'est pas unique)",
    parameters: Type.Object({
      texte: Type.String({
        minLength: 1,
        maxLength: MAX_ENTREE_CHARS,
        description: "Texte (ou fragment unique) de l'entrée à supprimer.",
      }),
    }),
    execute: async (_toolCallId, params) => {
      const texte = String((params as { texte?: unknown }).texte ?? "");
      // ⚠️ La nature est un INDICE : le port cherche dans l'autre liste si la
      // première est vide (le modèle n'a pas à deviner pour oublier).
      const resultat = consignes.retirer("consigne", texte);
      if (!resultat.ok) {
        const details: DetailsConsignes = {
          status: "refus",
          consignes: resultat.document.consignes.length,
          faits: resultat.document.faits.length,
          raison: resultat.refus,
        };
        return { content: [{ type: "text", text: texteRefus(resultat.message) }], details };
      }
      const details: DetailsConsignes = {
        status: "supprime",
        nature: resultat.nature,
        consignes: resultat.document.consignes.length,
        faits: resultat.document.faits.length,
      };
      return {
        content: [
          {
            type: "text",
            text:
              `Entrée supprimée (${resultat.nature === "consigne" ? "consigne" : "fait"}) : ` +
              `« ${resultat.retiree} ». ${compteurs(resultat.document)}`,
          },
        ],
        details,
      };
    },
  });

  return [memoriser, ajouterFait, lister, oublier];
}
