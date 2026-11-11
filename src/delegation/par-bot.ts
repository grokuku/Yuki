/**
 * DÉLÉGATION PAR BOT (lot 36, morceau L11) — les ports d'UN bot.
 *
 * ⚠️ LE DÉFAUT QUE CE MODULE FERME : le service de délégation, la file et le
 * réveil étaient UNIQUES. Un job délégué par un bot secondaire était donc
 * indiscernable d'un job du principal :
 *  - son rapport réveillait le host du PRINCIPAL (le léger de `yuki` lisait le
 *    résultat de `kohai`, et `kohai` n'était jamais réveillé) ;
 *  - la publication d'un rapport de canal partait avec le jeton du principal ;
 *  - les pré-autorisations étaient consommées au nom du bot de la pile.
 *
 * ⚠️ CE QUI RESTE D'INSTANCE, ET NE DOIT PAS CHANGER : le `JobStore` (un seul
 * journal `jobs.jsonl`), la `JobQueue` (donc `delegation.maxConcurrent` et
 * `delegation.maxQueue`), la disponibilité des modèles et les délais par défaut.
 * Un service PAR BOT aurait dupliqué la file et l'admission : deux plafonds pour
 * une seule machine.
 *
 * ⚠️ CE QUI DEVIENT PAR BOT : l'identité du job (`JobRecord.botId`) et, à partir
 * d'elle, le worker lourd, le réveil, le port des déclencheurs et le flux
 * d'événements relayé au host.
 *
 * Aucun import SDK/typebox.
 */

import type { PiEvent, PiEventSource } from "../pi/types.js";

import type {
  CancelOutcome,
  DelegateOutcome,
  DelegateRequest,
  DelegateServicePort,
  SteerOutcome,
} from "./ports.js";
import type { JobRecord } from "../jobs/types.js";

/**
 * Port de délégation d'UN bot : le MÊME service, mais chaque job créé porte
 * `botId`.
 *
 * ⚠️ C'est le seul endroit qui pose l'identité du demandeur. Le modèle (donc le
 * client, donc le réseau) ne peut pas la choisir : l'outil `delegate` d'un host
 * appelle toujours ce port-là.
 *
 * Les autres méthodes (lecture, annulation, consigne) sont celles du service,
 * inchangées : elles travaillent sur l'identifiant du job, jamais sur un bot
 * deviné.
 */
export function portDelegationBot(
  service: DelegateServicePort,
  botId: string,
): DelegateServicePort {
  return {
    delegate: (request: DelegateRequest): Promise<DelegateOutcome> =>
      service.delegate({ ...request, botId }),
    jobStatus: (jobId: string): JobRecord | undefined => service.jobStatus(jobId),
    cancelJob: (jobId: string): Promise<CancelOutcome> => service.cancelJob(jobId),
    steerJob: (jobId: string, text: string): Promise<SteerOutcome> =>
      service.steerJob(jobId, text),
    hasPendingWork: (sessionId: string): boolean => service.hasPendingWork(sessionId),
    pendingJobs: (sessionId: string) => service.pendingJobs(sessionId),
  };
}

/**
 * Source d'événements d'un bot : ne relaie QUE les événements des jobs de CE bot.
 *
 * ⚠️ Sans ce filtre, le host d'un bot relayerait les événements de jobs d'un
 * AUTRE bot : le transport les rangerait dans le flux du host émetteur (donc
 * sous le mauvais registre, avec le mauvais `seq`), et le panneau d'activité
 * d'une conversation montrerait le travail d'une autre.
 *
 * ⚠️ Un événement dont le job est INCONNU (journal purgé, redémarrage) est
 * écarté : mieux vaut pas d'activité qu'une activité attribuée au hasard.
 */
export function evenementsDuBot(
  source: PiEventSource,
  service: DelegateServicePort,
  botId: string,
): PiEventSource {
  const duBot = (jobId: string | undefined): boolean =>
    jobId !== undefined && service.jobStatus(jobId)?.botId === botId;
  return {
    subscribe: (listener: (event: PiEvent) => void) =>
      source.subscribe((event) => {
        if (!evenementDuBot(event, duBot)) return;
        listener(event);
      }),
  };
}

/** Prédicat d'un événement : appartient-il au bot ? (exporté pour les tests) */
function evenementDuBot(
  event: PiEvent,
  duBot: (jobId: string | undefined) => boolean,
): boolean {
  switch (event.type) {
    case "job_started":
    case "job_finished":
    case "job_report":
    case "job_activity":
      return duBot(event.jobId);
    case "phase":
      // Les étapes d'instrumentation portent le `jobId` quand elles en ont un
      // (étages de job) ; les autres sont celles du run léger du bot, et le
      // `job_report`/`job_started` a déjà dit à qui elles appartiennent.
      return event.jobId === undefined ? false : duBot(event.jobId);
    default:
      return false;
  }
}
