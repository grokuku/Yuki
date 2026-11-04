/**
 * ENVOIS PROGRAMMÉS — types et BORNES (lot 28, « publier plus tard »).
 *
 * ⚠️ LA DEMANDE (production, 2026-11-04) : « j'aimerais que tu fasses une image… et
 * que tu la postes à 16h10 dans l'Imagerie ». Yuki a répondu qu'elle n'avait « pas de
 * minuteur, une publication part au moment où je la fais ». C'était exact POUR ELLE :
 * le planificateur existe depuis le lot 2 (`src/sources/scheduler.ts`, balayeur 30 s,
 * état persisté), mais aucun outil ne lui permettait de s'en servir.
 *
 * ⚠️ CE QUE CE MODULE N'EST PAS : ce n'est ni un déclencheur (aucun modèle n'est
 * appelé, aucun tour n'est réveillé — le texte est FIGÉ) ni un job (aucune machine
 * n'est touchée). C'est un ENVOI : un texte (et d'éventuels fichiers du store) qui
 * partent à un instant donné, dans une conversation précise.
 *
 * ⚠️ Un envoi programmé INVISIBLE serait une bombe à retardement : tout est listé,
 * daté et ANNULABLE dans la page de gestion (onglet « Déclencheurs »).
 *
 * Aucun import ici : ce fichier est du vocabulaire pur, partagé par le store, le
 * service, l'outil et l'API.
 */

/** Nom du fichier de persistance, sur le volume `state`. */
export const ENVOIS_PROGRAMMES_FILE = "envois-programmes.json";

/** Version de schéma du fichier (une seule pour l'instant). */
export const ENVOIS_PROGRAMMES_SCHEMA_VERSION = 1;

/**
 * Nombre MAXIMAL d'envois EN ATTENTE (20).
 *
 * ⚠️ Vingt, comme la borne de messages d'un tour (`ENVOYER_MESSAGE_MAX_PAR_TOUR`) :
 * c'est déjà beaucoup de messages « en souffrance » dans une conversation, et au-delà
 * la page de gestion cesse d'être lisible — or c'est elle qui rend ces envois
 * annulables. Un envoi déjà parti (envoyé, annulé, échoué) ne compte PAS : seul
 * l'attente est bornée.
 */
export const MAX_ENVOIS_EN_ATTENTE = 20;

/**
 * HORIZON maximal d'une programmation (30 jours).
 *
 * ⚠️ Au-delà, ce n'est plus « publie ça à 16h10 » mais un calendrier éditorial : la
 * personne qui a demandé ne se souvient plus du message, et personne ne relit la page
 * de gestion. Le dépassement est REFUSÉ en le disant.
 */
export const HORIZON_MAX_MS = 30 * 86_400_000;

/**
 * DÉLAI MINIMAL entre la programmation et l'envoi (30 s).
 *
 * ⚠️ Sans ce plancher, « programme dans 1 s » serait un `envoyer_message` déguisé :
 * il échapperait à la file de publication du tour (donc à l'ordre), et laisserait une
 * ligne dans le fichier d'état pour rien. 30 s est aussi la période du balayeur : un
 * délai plus court serait de toute façon arrondi au balayage suivant.
 */
export const DELAI_MIN_MS = 30_000;

/**
 * Retard MAXIMAL rattrapé après un arrêt du serveur (1 h).
 *
 * ⚠️ DÉCISION, alignée sur le rattrapage des déclencheurs (`RATTRAPAGE_MAX_MS`,
 * `src/sources/types.ts`) : un envoi manqué de moins d'une heure est PUBLIÉ au
 * redémarrage (« ta photo de 16h10, partie à 16h40 ») ; au-delà il est marqué ÉCHOUÉ
 * avec sa raison. Justification : un message daté qui arrive avec trois heures de
 * retard n'est plus lu comme une publication programmée, il est du bruit — et le
 * supprimer en silence serait pire, d'où l'état « échoué » explicite et journalisé.
 */
export const RATTRAPAGE_MAX_ENVOI_MS = 3_600_000;

/** Rétention des envois TERMINÉS (7 jours) : l'historique reste lisible un moment. */
export const RETENTION_TERMINES_MS = 7 * 86_400_000;

/**
 * CIBLE d'un envoi programmé.
 *
 * ⚠️ Elle est RÉSOLUE à la programmation, jamais à l'exécution : à l'heure dite, il
 * n'y a plus de run, donc plus de « conversation courante ». Un canal est identifié
 * par son identifiant miroir (`mm-…`/`dc-…`), une conversation locale par son
 * identifiant de session.
 */
export type CibleEnvoi =
  | {
      type: "canal";
      /** Identifiant Yuki préfixé (`mm-…` / `dc-…`). */
      conversationId: string;
      /** Plateforme du canal : elle fixe la borne de caractères. */
      plateforme: "mattermost" | "discord";
      /** Titre affichable au moment de la programmation (jamais relu à l'envoi). */
      titre?: string;
    }
  | {
      type: "local";
      /** Session locale (fil de l'interface web). */
      sessionId: string;
      /** Titre du fil au moment de la programmation, si connu. */
      titre?: string;
    };

/**
 * État d'un envoi.
 *
 * `en_cours` n'est jamais rendu par la programmation : il n'existe que le temps de la
 * publication. S'il est retrouvé au CHARGEMENT, c'est qu'un arrêt brutal a eu lieu
 * pendant l'envoi — il devient alors `echoue` (« la publication a peut-être eu lieu »),
 * jamais rejoué : un doublon est pire qu'un manque annoncé.
 */
export type EtatEnvoi = "en_attente" | "en_cours" | "envoye" | "echoue" | "annule";

/** Un envoi programmé. */
export interface EnvoiProgramme {
  /** Identifiant (16 caractères hexadécimaux), rendu à l'outil pour l'annulation. */
  id: string;
  /** Instant de la programmation (ISO). */
  creeLe: string;
  /** Instant d'envoi VOULU (ISO, avec fuseau). */
  quand: string;
  /** Texte FIGÉ, déjà coupé aux bornes de la plateforme. */
  texte: string;
  /**
   * Identifiants du STORE des fichiers, validés à la programmation (appartenance à
   * la conversation source, plateforme, taille). Jamais un chemin, jamais un octet.
   */
  fichierIds?: string[];
  cible: CibleEnvoi;
  etat: EtatEnvoi;
  /** Instant de la publication effective (`etat: "envoye"`). */
  envoyeLe?: string;
  /** Raison LISIBLE d'un échec ou d'une annulation (jamais un silence). */
  raison?: string;
  /** Nombre de tentatives de publication (une seule en pratique). */
  tentatives: number;
  /** Conversation où Yuki se trouvait quand elle a programmé (traçabilité). */
  source?: string;
}

/** Fichier tel qu'écrit sur disque (⚠️ une enveloppe versionnée, jamais un tableau nu). */
export interface EnvoisProgrammesFile {
  schemaVersion: number;
  envois: EnvoiProgramme[];
}
