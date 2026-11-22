/**
 * Outils custom de GESTION DES TÂCHES — `lister_taches`, `modifier_tache`,
 * `supprimer_tache` (2026-11-22).
 *
 * ⚠️ LA DEMANDE (utilisateur, 2026-11-22) : « fait en sorte que le LLM puisse
 * modifier/supprimer des tâches ». Jusqu'ici le modèle pouvait seulement CRÉER
 * (`planifier_tache`) : une heure changée obligeait à passer par l'interface, et une
 * tâche annulée ne pouvait pas l'être depuis la conversation.
 *
 * ⚠️ CE QUE CES OUTILS NE FONT PAS :
 *  - ils ne voient QUE les tâches **du modèle**, dans le `sources.json` de SON bot
 *    (`origineTache: "modele"`, service par bot) : un déclencheur créé dans l'interface,
 *    une étape de chaîne ou la tâche d'un AUTRE bot sont des identifiants INCONNUS ;
 *  - ils ne touchent PAS aux ENVOIS programmés (`programmer_envoi`) : ce sont des
 *    messages figés, pas des tâches — l'interface humaine sait déjà les annuler ;
 *  - ils ne créent aucune capacité : ils vivent dans le groupe `planifierTaches`
 *    (`src/llm/tool-policy.ts`), donc la MÊME capacité que `planifier_tache`.
 *
 * ⚠️ L'OUTIL NE DÉCIDE DE RIEN : périmètre, nom, bornes, recalcul du prochain passage et
 * invalidation du compteur sont tenus par le PORT (`SourcesService`).
 */

import {
  defineTool,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type {
  ModifierTacheOutcome,
  PlanifierTachePort,
  PlanifierTacheToolOptions,
  SupprimerTacheOutcome,
  TacheVue,
} from "./planifier-tache-tool.js";

/** Détails structurés rendus à l'interface (jamais un contenu secret). */
interface DetailsGestion {
  status: "liste" | "modifie" | "supprime" | "refus";
  taches?: string[];
  id?: string;
  raison?: string;
}

/** Ligne LISIBLE d'une tâche (une par tâche, jamais un dump JSON dans le prompt). */
export function ligneTache(tache: TacheVue): string {
  const morceaux = [
    `« ${tache.libelle} » (id : ${tache.nom})`,
    tache.genre === "recurrence" ? `récurrence ${tache.planification}` : tache.planification,
    `prochain : ${tache.prochaineLisible}`,
    `état : ${tache.etat === "actif" ? "active" : "éteinte"}`,
  ];
  if (tache.etat !== "actif" && typeof tache.raison === "string" && tache.raison !== "") {
    morceaux.push(`raison : ${tache.raison}`);
  }
  if (typeof tache.occurrencesMax === "number") {
    morceaux.push(
      `${typeof tache.occurrencesFaites === "number" ? tache.occurrencesFaites : 0}/${
        tache.occurrencesMax
      } passages`,
    );
  }
  if (typeof tache.jusquAu === "string" && tache.jusquAu !== "") {
    morceaux.push(`fin le ${tache.jusquAu}`);
  }
  morceaux.push(
    `résultat publié dans ${tache.cible === "conversation" ? "la conversation demandeuse" : "le fil « Déclencheurs »"}`,
  );
  return morceaux.join(" · ");
}

/** Message de refus uniforme : la raison du PORT, jamais un booléen muet. */
function refus(raison: string): {
  content: Array<{ type: "text"; text: string }>;
  details: DetailsGestion;
} {
  return {
    content: [{ type: "text", text: raison }],
    details: { status: "refus", raison },
  };
}

/**
 * Construit les TROIS outils de gestion.
 *
 * ⚠️ Construits SEULEMENT si le port les porte : un host de test qui ne fournit que
 * `planifier` n'annonce pas des outils sans définition (le modèle ne les appellerait
 * que pour rien).
 */
export function createGestionTachesTools(
  port: PlanifierTachePort,
  _options: PlanifierTacheToolOptions,
): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  const lister = port.lister?.bind(port);
  if (lister !== undefined) {
    tools.push(
      defineTool({
        name: "lister_taches",
        label: "Lister les tâches planifiées (les tiennes)",
        description:
          "Liste les TÂCHES que tu as programmées (`planifier_tache`) : identifiant, " +
          "libellé, horaire ou récurrence, prochain passage, état, et — quand elle est " +
          "éteinte — la RAISON de son extinction (fin de récurrence, plantage, " +
          "« DÉSACTIVER »). " +
          "⚠️ Seules TES tâches apparaissent : un déclencheur créé par la personne dans " +
          "Configuration → Déclencheurs n'est pas ici (il se modifie dans l'interface), " +
          "et les tâches d'un autre bot ne sont jamais visibles. " +
          "Les ENVOIS programmés (`programmer_envoi`) ne sont pas des tâches : ils ne " +
          "figurent pas dans cette liste.",
        promptSnippet:
          "lister_taches() — les tâches que TU as programmées (id, prochain passage, " +
          "état, raison d'extinction)",
        parameters: Type.Object({}),
        execute: async (_toolCallId, _params, _signal, _onUpdate, _ctx: ExtensionContext) => {
          let taches: TacheVue[];
          try {
            taches = await lister();
          } catch (error) {
            return refus(error instanceof Error ? error.message : String(error));
          }
          if (taches.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    "Aucune tâche programmée par toi pour l'instant. " +
                    "`planifier_tache` en crée une (ponctuelle ou récurrente).",
                },
              ],
              details: { status: "liste", taches: [] } satisfies DetailsGestion,
            };
          }
          const lignes = taches.map(ligneTache);
          return {
            content: [
              {
                type: "text",
                text: `${taches.length} tâche(s) :\n- ${lignes.join("\n- ")}`,
              },
            ],
            details: {
              status: "liste",
              taches: taches.map((tache) => tache.nom),
            } satisfies DetailsGestion,
          };
        },
      }),
    );
  }

  const modifier = port.modifier?.bind(port);
  if (modifier !== undefined) {
    tools.push(
      defineTool({
        name: "modifier_tache",
        label: "Modifier une tâche planifiée",
        description:
          "Change une tâche que TU as programmée : son heure/date (`quand`, tâche " +
          "ponctuelle), sa RÉCURRENCE (`recurrence`, mêmes formes que `planifier_tache`), " +
          "son instruction, son libellé, ou la FIN de sa récurrence (`occurrences_max`, " +
          "`jusqu_au`). " +
          "⚠️ `id` est celui rendu par `lister_taches` (ou par `planifier_tache`). Un id " +
          "inconnu — y compris la tâche d'un AUTRE bot, ou un déclencheur créé dans " +
          "l'interface — est REFUSÉ en le disant : rien n'est modifié en silence. " +
          "⚠️ Changer l'horaire ou la récurrence REMET LE COMPTEUR DE PASSAGES À ZÉRO et " +
          "recalcule le prochain passage. " +
          "Les envois programmés (`programmer_envoi`) ne se modifient pas : ils ne sont " +
          "pas des tâches.",
        promptSnippet:
          "modifier_tache(id, quand?|recurrence?|instruction?|nom?|occurrences_max?|" +
          "jusqu_au?) — change une tâche (le compteur est invalidé si l'horaire change)",
        parameters: Type.Object({
          id: Type.String({
            maxLength: 64,
            description: "Identifiant de la tâche (rendu par `lister_taches`).",
          }),
          quand: Type.Optional(
            Type.String({
              maxLength: 100,
              description:
                "Nouvelle date d'une tâche PONCTUELLE (mêmes formes que " +
                "`planifier_tache` : « dans 2 h », « demain à 8 h », ISO). Refusé pour " +
                "une récurrence : utilise `recurrence`.",
            }),
          ),
          recurrence: Type.Optional(
            Type.Object({
              type: Type.String({
                maxLength: 40,
                description:
                  "« tous_les_jours », « chaque_semaine », « toutes_les_heures » ou " +
                  "« tous_les_mois ».",
              }),
              heure: Type.Optional(
                Type.String({ maxLength: 10, description: "Heure « HH:MM »." }),
              ),
              jour: Type.Optional(
                Type.String({
                  maxLength: 20,
                  description: "Jour de la semaine (« lundi » … « dimanche »).",
                }),
              ),
              heures: Type.Optional(
                Type.Number({ description: "Écart en heures (1 à 24)." }),
              ),
              jourDuMois: Type.Optional(
                Type.Number({ description: "Jour du mois (1 à 31)." }),
              ),
            }),
          ),
          instruction: Type.Optional(
            Type.String({
              maxLength: 4_000,
              description: "Nouvelle instruction (ce que la tâche devra FAIRE).",
            }),
          ),
          nom: Type.Optional(
            Type.String({ maxLength: 80, description: "Nouveau libellé lisible." }),
          ),
          occurrences_max: Type.Optional(
            Type.Number({
              description:
                "Nouveau nombre maximal de passages (1 à 10 000). Omis ⇒ inchangé.",
            }),
          ),
          jusqu_au: Type.Optional(
            Type.String({
              maxLength: 40,
              description:
                "Nouvelle date de fin (ISO). Omise ⇒ inchangée ; l'outil ne retire pas " +
                "une fin existante.",
            }),
          ),
        }),
        execute: async (_toolCallId, params, _signal, _onUpdate, _ctx: ExtensionContext) => {
          const brut = params as Record<string, unknown>;
          const id = typeof brut["id"] === "string" ? brut["id"].trim() : "";
          const quand = typeof brut["quand"] === "string" ? brut["quand"].trim() : "";
          const instruction = typeof brut["instruction"] === "string" ? brut["instruction"] : "";
          const nom = typeof brut["nom"] === "string" ? brut["nom"].trim() : "";
          const jusquAu = typeof brut["jusqu_au"] === "string" ? brut["jusqu_au"].trim() : "";
          const occurrencesMaxBrut = brut["occurrences_max"];
          const occurrencesMax =
            typeof occurrencesMaxBrut === "number" && Number.isFinite(occurrencesMaxBrut)
              ? Math.trunc(occurrencesMaxBrut)
              : undefined;
          // ⚠️ La récurrence part BRUTE : le port la valide (formes, bornes, fuseau).
          const recurrence = brut["recurrence"];

          let issue: ModifierTacheOutcome;
          try {
            issue = await modifier({
              id,
              ...(nom !== "" ? { nom } : {}),
              ...(instruction !== "" ? { instruction } : {}),
              ...(quand !== "" ? { quand } : {}),
              ...(recurrence !== undefined && recurrence !== null ? { recurrence } : {}),
              ...(occurrencesMax !== undefined ? { occurrencesMax } : {}),
              ...(jusquAu !== "" ? { jusquAu } : {}),
            });
          } catch (error) {
            return refus(error instanceof Error ? error.message : String(error));
          }
          if (!issue.ok) return refus(issue.raison);
          const texte =
            `Tâche « ${issue.tache.libelle} » (id : ${issue.tache.nom}) modifiée. ` +
            `${issue.tache.genre === "recurrence" ? `Récurrence ${issue.tache.planification}` : issue.tache.planification}. ` +
            `Prochain passage : ${issue.prochaineLisible}. ` +
            (issue.compteurInvalide
              ? "Le compteur de passages repart de zéro (l'horaire ou la récurrence a changé). "
              : "") +
            `État : ${issue.tache.etat === "actif" ? "active" : "éteinte"}.`;
          return {
            content: [{ type: "text", text: texte }],
            details: { status: "modifie", id: issue.tache.nom } satisfies DetailsGestion,
          };
        },
      }),
    );
  }

  const supprimer = port.supprimer?.bind(port);
  if (supprimer !== undefined) {
    tools.push(
      defineTool({
        name: "supprimer_tache",
        label: "Supprimer une tâche planifiée",
        description:
          "SUPPRIME DÉFINITIVEMENT une tâche que TU as programmée (ponctuelle ou " +
          "récurrente) : elle ne tournera plus, et son identifiant disparaît. " +
          "⚠️ Un id inconnu — y compris la tâche d'un AUTRE bot, ou un déclencheur créé " +
          "dans l'interface — est REFUSÉ en le disant : aucune suppression silencieuse. " +
          "⚠️ Une ÉTAPE de chaîne est refusée : une chaîne se supprime en entier dans " +
          "Configuration → Déclencheurs (sinon les étapes suivantes resteraient " +
          "orphelines, sans que personne ne l'ait demandé). " +
          "Les envois programmés (`programmer_envoi`) ne sont pas des tâches : ils " +
          "s'annulent dans Configuration → Déclencheurs → « Envois programmés ».",
        promptSnippet:
          "supprimer_tache(id) — supprime définitivement une tâche que tu as créée",
        parameters: Type.Object({
          id: Type.String({
            maxLength: 64,
            description: "Identifiant de la tâche (rendu par `lister_taches`).",
          }),
        }),
        execute: async (_toolCallId, params, _signal, _onUpdate, _ctx: ExtensionContext) => {
          const idBrut = (params as { id?: unknown }).id;
          const id = typeof idBrut === "string" ? idBrut.trim() : "";
          let issue: SupprimerTacheOutcome;
          try {
            issue = await supprimer({ id });
          } catch (error) {
            return refus(error instanceof Error ? error.message : String(error));
          }
          if (!issue.ok) return refus(issue.raison);
          return {
            content: [
              {
                type: "text",
                text:
                  `Tâche « ${issue.libelle} » (id : ${issue.nom}) supprimée définitivement : ` +
                  "elle ne tournera plus.",
              },
            ],
            details: { status: "supprime", id: issue.nom } satisfies DetailsGestion,
          };
        },
      }),
    );
  }

  return tools;
}
