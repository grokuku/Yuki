/**
 * PORTS DE PLANIFICATION **PAR BOT** — `planifier_tache` et `programmer_envoi`.
 *
 * ⚠️ LE DÉFAUT FERMÉ ICI (audit 2026-11-20, ①).
 *
 * Un tour né dans le canal d'un bot SECONDAIRE (`grolaf`) recevait les ports de la
 * **PILE** (`src/index.ts`, `portEnvoisProgrammes` / `portPlanificationTache`). Deux
 * conséquences, toutes deux silencieuses du point de vue du modèle :
 *
 *  - `planifier_tache` écrivait la tâche dans le `sources.json` du **bot du run** :
 *    elle était donc exécutée et publiée par LUI, dans SON fil, alors qu'elle avait
 *    été demandée depuis le canal d'un autre ;
 *  - `programmer_envoi` **refusait** le canal de `grolaf` : les canaux suivis sont
 *    ceux du miroir de la pile (`EnvoisProgrammesService.resoudreCible`), et le canal
 *    d'un autre bot n'y est pas.
 *
 * ⚠️ LA RÈGLE : le service est celui du bot **qui a reçu le message** — le `botId`
 * de l'adaptateur, déjà connu du tour distant (`botDuTourDistant`). C'est la même
 * règle que `optionsHostBot` (`src/bots/hosts.ts`), qui construit les options d'un
 * host PAR BOT : ici, on construit les PORTS par bot.
 *
 * ⚠️ BOT NON RÉSOLU ⇒ REFUS **NOMMÉ** (`bot_inconnu`) : jamais un repli silencieux
 * sur la pile. Un repli écrirait la tâche d'un bot inconnu chez le bot du run —
 * exactement ce que ce module interdit, et le refus est rendu au modèle, qui ne peut
 * donc pas promettre une programmation qui n'a pas eu lieu.
 *
 * ⚠️ Le run **LOCAL** (interface web) ne passe pas par ici : son host est celui du
 * bot affiché et reçoit SES ports (`optionsHostBot` → `PortsHostBot`). Rien ne change
 * pour lui.
 *
 * Aucun import SDK/typebox : ces ports sont ceux des outils, pas les outils.
 */

import type { ProgrammationInput, ProgrammationOutcome } from "../chat/envois/index.js";
import { SourcesParBotError, type SourcesParBot } from "./par-bot.js";
import type { PlanificationTacheInput } from "./taches.js";
import type { PlanificationTacheOutcome } from "./service.js";

/**
 * Message de REFUS quand le bot demandeur ne résout aucun service.
 *
 * ⚠️ Le code (`bot_inconnu`) est écrit EN TÊTE : c'est lui que lisent les tests et
 * les journaux, et il dit pourquoi rien n'a été programmé — un message générique
 * laisserait croire à une panne passagère.
 */
export function refusPlanificationBot(botId: string, error?: unknown): string {
  const code = error instanceof SourcesParBotError ? error.code : "bot_inconnu";
  const detail =
    error instanceof Error && error.message !== "" ? ` (${error.message})` : "";
  return (
    `Rien n'a été programmé : ${code} — le bot « ${botId} » qui a reçu ce message ` +
    `n'a pas de services de planification accessibles. Aucun repli sur un autre bot.${detail}`
  );
}

/** Port de `programmer_envoi` du bot `botId` (résolu À L'APPEL, jamais à la construction). */
export function portEnvoisPourBot(
  parBot: SourcesParBot,
  botId: string,
): { programmer: (request: ProgrammationInput) => Promise<ProgrammationOutcome> } {
  return {
    programmer: async (request) => {
      let envois;
      try {
        envois = parBot.pourBot(botId).envois;
      } catch (error) {
        return { ok: false, raison: refusPlanificationBot(botId, error) };
      }
      if (envois === undefined) {
        // ⚠️ Une pile construite à la main (tests) peut ne pas porter d'envois : on
        // le DIT, on ne programme pas chez un autre bot.
        return { ok: false, raison: refusPlanificationBot(botId) };
      }
      return envois.programmer(request);
    },
  };
}

/** Port de `planifier_tache` du bot `botId` (résolu À L'APPEL, jamais à la construction). */
export function portPlanificationPourBot(
  parBot: SourcesParBot,
  botId: string,
): { planifier: (request: PlanificationTacheInput) => Promise<PlanificationTacheOutcome> } {
  return {
    planifier: async (request) => {
      try {
        // ⚠️ `pourBot` lève `bot_inconnu` (bot absent du registre), `id_invalide`
        // ou `bot_non_construit` : les trois sont des REFUS, jamais des replis.
        return parBot.pourBot(botId).service.planifierTache(request);
      } catch (error) {
        return { ok: false, raison: refusPlanificationBot(botId, error) };
      }
    },
  };
}
