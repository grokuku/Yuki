/**
 * ENVOIS PROGRAMMÉS (lot 28) — « Yuki publie plus tard ».
 *
 * Un envoi programmé est un TEXTE FIGÉ (et d'éventuels fichiers du store) publié à un
 * instant donné dans une conversation précise. Aucun modèle n'est appelé à l'heure
 * dite, aucune machine n'est touchée, et le planificateur est celui des déclencheurs
 * (`src/sources/scheduler.ts`) : ce module n'ouvre AUCUN minuteur.
 */

export {
  analyserQuand,
  formaterInstantEnvoi,
  FUSEAU_ENVOIS,
  QUAND_FORMES_ATTENDUES,
  type AnalyseQuand,
} from "./quand.js";
export {
  EnvoisProgrammesStore,
  type EnvoisProgrammesStoreOptions,
  type EnvoisStoreLogger,
  type NouvelEnvoi,
} from "./store.js";
export {
  EnvoisProgrammesService,
  libelleCible,
  RAISON_DELAI_MIN,
  RAISON_FICHIERS_LOCAL,
  RAISON_HORIZON,
  RAISON_PASSEE,
  RAISON_PLAFOND,
  type EnvoiJournalEvent,
  type EnvoisJournalPort,
  type EnvoisLogger,
  type EnvoisProgrammesServiceOptions,
  type ProgrammationInput,
  type ProgrammationOutcome,
} from "./service.js";
export {
  DELAI_MIN_MS,
  ENVOIS_PROGRAMMES_FILE,
  ENVOIS_PROGRAMMES_SCHEMA_VERSION,
  HORIZON_MAX_MS,
  MAX_ENVOIS_EN_ATTENTE,
  RATTRAPAGE_MAX_ENVOI_MS,
  RETENTION_TERMINES_MS,
  type CibleEnvoi,
  type EnvoiProgramme,
  type EnvoisProgrammesFile,
  type EtatEnvoi,
} from "./types.js";
