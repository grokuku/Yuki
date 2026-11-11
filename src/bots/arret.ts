/**
 * ARRÊT CIBLÉ D'UN BOT (lot 36, morceau L9).
 *
 * ⚠️ CE QUE CE MODULE FERME : l'arrêt gracieux de `main()` arrête TOUT (les hosts,
 * les piles, la mémoire, les adaptateurs) — il n'existe aucun moyen d'arrêter UN
 * bot. Or un bouton « Arrêter » qui ne ferait que décocher un drapeau laisserait
 * le host, la pile de sources, la mémoire et la connexion de plateforme du bot
 * vivants : la moitié de l'état affiché mentirait.
 *
 * ⚠️ TROIS RÈGLES, et elles suffisent :
 *  1. **IDEMPOTENT** : arrêter un bot déjà arrêté n'est pas une erreur
 *     (`dejaArrete: true`, aucune étape appelée) ;
 *  2. **ISOLÉ** : seules les étapes de CE bot sont appelées — jamais un arrêt
 *     global, jamais un `stop` sur le host d'un autre ;
 *  3. **UN ÉCHEC N'ARRÊTE PAS LES AUTRES ÉTAPES** : chaque étape est tentée,
 *     son erreur est COLLECTÉE et rendue ; l'arrêt se poursuit (une mémoire qui
 *     ne draine pas ne doit pas laisser un host debout).
 *
 * ⚠️ L'ordre est celui d'une fermeture sûre : d'abord ce qui PRODUIT (run en vol,
 * sources, host), puis ce qui PERSISTE (mémoire), puis ce qui reste ouvert
 * (pile, TTS). Un `stop` de host d'abord éviterait des écritures tardives dans
 * les fichiers qu'on va fermer.
 *
 * Aucun import SDK/typebox.
 */

/** Journal minimal attendu (le `Logger` de l'application le satisfait). */
export interface ArretBotLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

/** Les étapes d'arrêt d'UN bot. Toutes facultatives : un bot peut n'avoir rien. */
export interface EtapesArretBot {
  /** Run en vol (un tour de modèle en cours). */
  readonly run?: () => Promise<void> | void;
  /** Suivi des runs du bot (déclencheurs, sources). */
  readonly sources?: () => Promise<void> | void;
  /** Le host Pi du bot : c'est lui qui termine les sessions ouvertes. */
  readonly host?: () => Promise<void> | void;
  /** Dossiers de mémoire (drain avant fermeture : aucune écriture tardive). */
  readonly memory?: () => Promise<void> | void;
  /** Pile de sources du bot (fichiers ouverts). */
  readonly pile?: () => Promise<void> | void;
  /** Synthèse vocale (file de téléchargement, lecture en cours). */
  readonly tts?: () => Promise<void> | void;
  /** Connexion de plateforme DU BOT (Mattermost/Discord). */
  readonly plateforme?: () => Promise<void> | void;
}

/** Nom des étapes, dans l'ORDRE d'exécution. */
export const ETAPES_ARRET = [
  "run",
  "sources",
  "host",
  "memory",
  "pile",
  "tts",
  "plateforme",
] as const;

export type NomEtapeArret = (typeof ETAPES_ARRET)[number];

/** Une étape qui a échoué (le bilan la nomme, jamais un échec tu). */
export interface EchecEtapeArret {
  readonly etape: NomEtapeArret;
  readonly error: string;
}

/** Bilan d'un arrêt ciblé. */
export interface BilanArretBot {
  readonly botId: string;
  /** `true` = le bot était déjà arrêté, AUCUNE étape appelée. */
  readonly dejaArrete: boolean;
  /** Étapes réellement exécutées (dans l'ordre). */
  readonly etapes: NomEtapeArret[];
  /** Étapes en échec (elles n'ont pas interrompu les suivantes). */
  readonly echecs: EchecEtapeArret[];
  /** `true` si aucune étape n'a échoué. */
  readonly ok: boolean;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Arrête UN bot, étape par étape.
 *
 * @param dejaArrete dit si le bot était déjà arrêté — c'est l'appelant qui le
 *   sait (il lit l'état d'exécution, pas le registre) : ce module ne devine pas.
 */
export async function arreterBotProprement(options: {
  botId: string;
  dejaArrete?: boolean;
  etapes: EtapesArretBot;
  logger?: ArretBotLogger;
}): Promise<BilanArretBot> {
  const { botId, etapes } = options;
  if (options.dejaArrete === true) {
    options.logger?.info("bots.arret.deja_arrete", { bot: botId });
    return { botId, dejaArrete: true, etapes: [], echecs: [], ok: true };
  }

  const faites: NomEtapeArret[] = [];
  const echecs: EchecEtapeArret[] = [];
  for (const etape of ETAPES_ARRET) {
    const action = etapes[etape];
    if (action === undefined) continue;
    try {
      await action();
      faites.push(etape);
    } catch (error) {
      echecs.push({ etape, error: messageOf(error) });
      options.logger?.warn("bots.arret.etape_echouee", {
        bot: botId,
        etape,
        error: messageOf(error),
      });
    }
  }

  const bilan: BilanArretBot = {
    botId,
    dejaArrete: false,
    etapes: faites,
    echecs,
    ok: echecs.length === 0,
  };
  const champs = {
    bot: botId,
    etapes: faites.join(","),
    echecs: echecs.map((echec) => echec.etape).join(","),
  };
  if (bilan.ok) options.logger?.info("bots.arret", champs);
  else options.logger?.warn("bots.arret.incomplet", champs);
  return bilan;
}
