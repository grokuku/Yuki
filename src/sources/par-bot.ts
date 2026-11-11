/**
 * SOURCES / DÉCLENCHEURS / ENVOIS / PRÉ-AUTORISATIONS **PAR BOT** (lot 35j).
 *
 * ⚠️ LE PROBLÈME RÉSOLU — la résolution par le NOM était une collision :
 * `POST /api/sources/<nom>/messages` authentifiait le `Bearer` contre le secret
 * `YUKI_SOURCE_<NOM>` (`src/sources/types.ts`, `sourceTokenName`). Ce nom ne
 * disait pas À QUEL BOT appartenait le déclencheur : deux bots déclarant chacun
 * `news` écrivaient la MÊME entrée de coffre, et le webhook réveillait **le
 * premier bot portant ce nom**, avec SA mémoire et SES outils. Le porteur du
 * jeton du bot A pouvait donc faire travailler le bot B.
 *
 * ⚠️ LA RÈGLE — le JETON décide, le nom ne décide plus :
 *
 *     jeton → entrée du coffre → botId PROPRIÉTAIRE → sources.json DE CE BOT → nom
 *
 * Le nom de secret porte désormais le propriétaire
 * (`YUKI_SOURCE_<BOT>__<NOM>`, {@link nomSecretSource}). L'ancien nom
 * (`YUKI_SOURCE_<NOM>`) reste **accepté pour le bot historique `yuki`** : les
 * webhooks déjà distribués continuent de fonctionner, et AUCUN secret existant
 * n'est réécrit (aucune migration de coffre).
 *
 * ⚠️ REFUS EXPLICITES, jamais de réveil silencieux du mauvais bot :
 *  - jeton d'un bot → nom inconnu CHEZ CE BOT ⇒ **404 qui nomme le bot** ;
 *  - bot propriétaire INACTIF ⇒ **403 qui nomme le bot** ;
 *  - jeton inconnu ⇒ 401 (aucun bot nommé : on ne révèle pas l'annuaire).
 *
 * ⚠️ UN SEUL BALAYEUR : {@link SourcesParBot.ciblesBalayage} rend la liste des
 * bots à balayer à CET instant. Le balayeur (`BalayeurBots`,
 * `src/sources/scheduler.ts`) garde UN `setInterval` et itère sur cette liste —
 * un bot n'obtient jamais son propre minuteur. Un bot SANS capacité pertinente
 * (`workerLourdAutorise`, `src/bots/profils.ts`) n'y figure pas : ses sources ne
 * tirent pas, parce qu'il ne pourrait rien en faire.
 *
 * ⚠️ PRÉ-AUTORISATIONS : le fichier est déjà par bot (`paths.ts`), donc la clé
 * `(bot, déclencheur)` est STRUCTURELLE — chaque pile a SON
 * `PreAutorisationStore`, et {@link portPreAutorisations} ne consulte que la pile
 * du **bot du run** (jamais un identifiant reçu d'un client).
 *
 * Aucun import SDK/typebox.
 */

import type { Env } from "../config/env.js";
import {
  BOT_YUKI,
  CAPACITES_BOT,
  estIdBot,
  type BotRecord,
  type RegistreBots,
} from "../bots/registry.js";
import { workerLourdAutorise } from "../bots/profils.js";
import type { PreAutorisationStore } from "../agents/preautorisations.js";
import type { OutilsBot } from "../bots/outils.js";
import type { ConfigRuntime } from "../config/runtime.js";
import type { EnvoisProgrammesService } from "../chat/envois/index.js";
import type { DeclencheurJournal } from "./journal.js";
import type { SourcesInbox } from "./inbox.js";
import type { BalayeurStore, CibleBalayage } from "./scheduler.js";
import {
  ORIGINE_HORLOGE,
  SourceApiError,
  tokensMatch,
  type SourcesLogger,
  type SourcesService,
  type SourcesTokenVault,
} from "./service.js";
import { SOURCE_TOKEN_PREFIX, sourceTokenName, type SourceDelivery } from "./types.js";

/** Mode de résolution des chemins (miroir de `ResultatPreparationBots["mode"]`). */
export type ModeBots = "mono" | "multi";

/**
 * Séparateur du nom de secret entre le PROPRIÉTAIRE et le nom de la source.
 *
 * ⚠️ `__` (deux soulignés) : impossible dans un slug de bot créé depuis
 * l'interface (`SLUG_BOT_PATTERN`, `src/bots/registry.ts`) et assez rare dans un
 * nom de source pour rester lisible dans le coffre.
 */
export const SEPARATEUR_SECRET_BOT = "__";

/**
 * Nom de secret d'une source PROPRE À UN BOT :
 * `YUKI_SOURCE_<BOT>__<NOM>` (`NOM` et `BOT` en MAJUSCULES, `-` → `_`).
 *
 * ⚠️ C'est ce nom — et lui seul — qui dit à quel bot appartient le jeton. Deux
 * bots peuvent donc déclarer chacun `news` sans jamais écrire la même entrée.
 */
export function nomSecretSource(botId: string, nom: string): string {
  const proprietaire = String(botId).toUpperCase().replace(/-/g, "_");
  return `${SOURCE_TOKEN_PREFIX}${proprietaire}${SEPARATEUR_SECRET_BOT}${String(nom)
    .toUpperCase()
    .replace(/-/g, "_")}`;
}

/**
 * Noms de secret ACCEPTÉS pour la source `nom` du bot `botId`, le PREMIER étant
 * celui d'un nouveau jeton.
 *
 * ⚠️ Le bot historique `yuki` accepte EN PLUS l'ancien nom
 * `YUKI_SOURCE_<NOM>` : c'est la compatibilité assumée du lot 35j (webhooks déjà
 * distribués). Aucun autre bot n'a d'ancien nom — un jeton historique ne peut
 * donc jamais réveiller un autre bot.
 */
export function nomsSecretsSource(botId: string, nom: string): string[] {
  const noms = [nomSecretSource(botId, nom)];
  if (botId === BOT_YUKI) {
    const historique = sourceTokenName(nom);
    if (!noms.includes(historique)) noms.push(historique);
  }
  return noms;
}

/**
 * Bot SYNTHÉTIQUE du mode mono-bot historique (`state/bots.json` absent) : un seul
 * bot `yuki`, actif, avec toutes les capacités — exactement le comportement
 * d'avant le lot 35a.
 */
function botMono(): BotRecord {
  return {
    id: BOT_YUKI,
    nom: BOT_YUKI,
    capacites: [...CAPACITES_BOT],
    actif: true,
    ordre: 0,
    creeLe: "",
    plateformes: {},
  };
}

/** Erreur de résolution PAR BOT (code stable, message français). */
export class SourcesParBotError extends Error {
  override readonly name = "SourcesParBotError";
  constructor(
    readonly code: "bot_inconnu" | "bot_non_construit" | "id_invalide" | "bot_refuse",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Ce que le DÉMARRAGE a décidé (lot 36, L1) : qui doit tourner, et qui le
 * plafond a refusé.
 *
 * ⚠️ C'est la SEULE source de vérité du balayeur : un bot `actif: true` mais
 * REFUSÉ par `bots.maxActifs` n'a ni pile ni déclencheur — allumer un bot dans
 * l'interface ne le fait pas tourner avant le redémarrage (`demarrageRequis`,
 * `src/bots/admin.ts`).
 */
export interface ResolutionDemarrage {
  /** Bots à DÉMARRER, dans l'ordre du démarrage. */
  readonly aDemarrer: readonly string[];
  /** Bots `actif: true` REFUSÉS par le plafond (aucune pile, aucun tir). */
  readonly refuses: readonly string[];
}

/**
 * PILE d'un bot : tout ce que les déclencheurs, les envois et les
 * pré-autorisations de CE bot touchent. Chaque champ pointe un fichier situé sous
 * `<state>/bots/<botId>/` (résolu par `pathsForBot`), jamais celui d'un autre.
 */
export interface PileSourcesBot {
  readonly botId: string;
  /** `Env` résolu du bot (ses chemins pointent sous SA racine). */
  readonly env: Env;
  /**
   * Configuration DE CE BOT (lot 36, L3-a). `undefined` pour une pile construite
   * à la main (tests, mode mono sans runtime par bot) : la pile lit alors les
   * bornes de la configuration d'instance, exactement comme avant L3-c.
   */
  readonly config?: ConfigRuntime;
  /**
   * Outils DE CE BOT (lot 36, L3-b : mémoire, archive, avatar, personnalité,
   * règles, épingles, réactions).
   *
   * ⚠️ Lecture PARESSEUSE assumée : la Map des outils est construite APRÈS la
   * pile du bot actif (elle réutilise ses objets). L3-d y branchera le `PiHost`
   * du bot ; d'ici là ce champ n'est qu'un point d'accroche.
   */
  readonly outils?: OutilsBot;
  /** `sources.json` DU BOT (satisfait le port `BalayeurStore`). */
  readonly store: BalayeurStore;
  readonly inbox: SourcesInbox;
  readonly journal: DeclencheurJournal;
  readonly preAutorisations: PreAutorisationStore;
  readonly service: SourcesService;
  /** Envois programmés de CE bot (absent ⇒ aucun envoi exécuté pour lui). */
  readonly envois?: EnvoisProgrammesService;
  /** Libère ce que la pile a ouvert (arrêt gracieux). */
  fermer(): void;
}

export interface OptionsSourcesParBot {
  /** `Env` de l'INSTANCE (jamais un `Env` déjà résolu par bot, cf. `pathsForBot`). */
  envInstance: Env;
  mode: ModeBots;
  /**
   * Registre des bots, RELU à chaque résolution (un bot créé ou désactivé depuis
   * l'interface est pris en compte au webhook suivant).
   */
  registre: () => RegistreBots | null;
  /** Coffre des jetons. Absent ⇒ aucune authentification possible (401). */
  coffre?: SourcesTokenVault;
  logger: SourcesLogger;
  /**
   * Décision de DÉMARRAGE (L1) : qui doit tourner, qui le plafond a refusé.
   *
   * ⚠️ Omise (tests, mode mono-bot) ⇒ comportement du lot 35j : tous les bots
   * `actif: true` du registre sont balayés. Fournie (démarrage réel), le balayeur
   * ne voit QUE les bots à démarrer — jamais un bot du registre refusé.
   */
  demarrage?: () => ResolutionDemarrage;
  /** Horloge injectable (tests). */
  now?: () => number;
}

/** Dépendances d'API d'UN bot (`?bot=<id>` sur les routes d'administration). */
export interface DepsSourcesBot {
  service: SourcesService;
  journal: DeclencheurJournal;
  preAutorisations: PreAutorisationStore;
  envois?: EnvoisProgrammesService;
}

/** Résultat de la résolution d'un jeton. */
export interface JetonResolu {
  botId: string;
  nom: string;
  /** Entrée de coffre RÉELLEMENT comparée (format courant ou historique). */
  secret: string;
}

/**
 * RÉSOLUTION PAR BOT des déclencheurs, des envois et des pré-autorisations.
 *
 * ⚠️ Une seule instance par processus. Elle ne construit PAS les piles toute
 * seule : le démarrage fournit la fabrique (`setOuvrir`) et, quand la pile du bot
 * actif existe déjà (elle est construite très tôt pour les autres services), il
 * l'enregistre avec `setPileActive` — il n'y a donc jamais deux `SourcesService`
 * pour le même fichier.
 */
export class SourcesParBot {
  private readonly options: OptionsSourcesParBot;
  private readonly pilesOuvertes = new Map<string, PileSourcesBot>();
  /** Bots démarrés à la MAIN (L8) : leur refus de démarrage est levé. */
  private readonly autorisesMaintenant = new Set<string>();
  private ouvrir?: (input: { botId: string; env: Env }) => PileSourcesBot;
  private pileActive?: PileSourcesBot;

  constructor(options: OptionsSourcesParBot) {
    this.options = options;
  }

  /** Branche la fabrique des piles (appelée une fois par le démarrage). */
  setOuvrir(ouvrir: (input: { botId: string; env: Env }) => PileSourcesBot): void {
    this.ouvrir = ouvrir;
  }

  /**
   * Enregistre la pile DÉJÀ construite du bot actif (construite tôt, avant la
   * délégation et le host). Idempotent : la seconde inscription gagne.
   */
  setPileActive(pile: PileSourcesBot): void {
    this.pileActive = pile;
    this.pilesOuvertes.set(pile.botId, pile);
  }

  /** Bot actif enregistré (`undefined` avant le démarrage). */
  get actif(): PileSourcesBot | undefined {
    return this.pileActive;
  }

  /**
   * Piles DÉJÀ ouvertes, dans l'ordre d'ouverture — l'endroit où L3-d attachera le
   * `PiHost` de chaque bot. Ne construit rien (un bot jamais touché n'y figure pas).
   */
  piles(): PileSourcesBot[] {
    return [...this.pilesOuvertes.values()];
  }

  /** Registre courant (`null` en mode mono-bot historique). */
  registre(): RegistreBots | null {
    try {
      return this.options.registre();
    } catch {
      return null;
    }
  }

  /** Bots connus : le registre, ou le bot synthétique `yuki` en mode mono-bot. */
  bots(): BotRecord[] {
    const registre = this.registre();
    if (registre === null || registre.bots.length === 0) return [botMono()];
    return [...registre.bots];
  }

  /** Un bot du registre, ou `undefined`. */
  bot(botId: string): BotRecord | undefined {
    return this.bots().find((bot) => bot.id === botId);
  }

  /** Décision de démarrage (L1), relue à chaque appel (elle est figée au boot). */
  private resolutionDemarrage(): ResolutionDemarrage | undefined {
    try {
      return this.options.demarrage?.();
    } catch {
      return undefined;
    }
  }

  /** Ce bot a-t-il été REFUSÉ par le plafond au démarrage ? */
  estRefuse(botId: string): boolean {
    // ⚠️ LOT 36 (L8) : un bot DÉMARRÉ À LA MAIN (bouton « Démarrer ») lève le
    // refus du démarrage : le plafond a été vérifié par `definirActif`, et
    // refuser ici rendrait le bouton inopérant sur ses propres sources.
    if (this.autorisesMaintenant.has(botId)) return false;
    const demarrage = this.resolutionDemarrage();
    return demarrage?.refuses.includes(botId) ?? false;
  }

  /**
   * Autorise un bot DÉMARRÉ À LA MAIN (lot 36, L8) — sans toucher au registre ni
   * à la décision de démarrage (figée). Idempotent.
   */
  autoriser(botId: string): void {
    this.autorisesMaintenant.add(botId);
  }

  /**
   * Oublie un bot ARRÊTÉ (lot 36, L8/L9) : sa pile, son autorisation à la main.
   * ⚠️ La propriété de ses canaux n'est pas touchée (L5) : ils restent les siens.
   */
  oublier(botId: string): void {
    this.autorisesMaintenant.delete(botId);
    this.pilesOuvertes.delete(botId);
  }

  /**
   * Les bots qui TOURNENT : ceux que le démarrage a retenus, encore `actif: true`.
   *
   * ⚠️ Sans décision de démarrage (tests, mode mono-bot historique), c'est
   * l'ancienne règle du lot 35j : tout bot `actif: true` du registre.
   * ⚠️ Un bot `actif: true` mais REFUSÉ par le plafond n'y figure JAMAIS : il n'a
   * pas de pile, donc ses déclencheurs ne peuvent pas tirer.
   */
  botsActifs(): BotRecord[] {
    const tous = this.bots().filter((bot) => bot.actif === true);
    const demarrage = this.resolutionDemarrage();
    const registre = this.registre();
    // ⚠️ MODE MONO-BOT historique (aucun `state/bots.json`) : il n'y a rien à
    // filtrer — le bot synthétique `yuki` tourne, comme avant le lot 35a. Sans ce
    // garde, une décision de démarrage vide (`aDemarrer` = []) éteindrait le
    // balayeur d'une installation mono-bot.
    if (demarrage === undefined || registre === null || registre.bots.length === 0) {
      return tous;
    }
    const voulus = new Set(demarrage.aDemarrer);
    return tous.filter((bot) => voulus.has(bot.id));
  }

  /**
   * Pile d'un bot (ouverte à la demande puis gardée).
   *
   * ⚠️ Un identifiant ABSENT du registre est refusé (`bot_inconnu`) : on
   * n'ouvre jamais le dossier d'un bot qui n'existe pas.
   */
  pourBot(botId: string): PileSourcesBot {
    if (!estIdBot(botId)) {
      throw new SourcesParBotError(
        "id_invalide",
        `Identifiant de bot invalide : « ${String(botId)} » (aucune source ouverte).`,
      );
    }
    const connu = this.pilesOuvertes.get(botId);
    if (connu) return connu;
    if (this.estRefuse(botId)) {
      // ⚠️ Un bot REFUSÉ par le plafond (`bots.maxActifs`) n'a pas de pile : il ne
      // tourne pas, rien ne doit ouvrir ses fichiers en son nom (ni le webhook, ni
      // le balayeur, ni une route d'administration).
      throw new SourcesParBotError(
        "bot_refuse",
        `Le bot « ${botId} » a été refusé au démarrage par le plafond de bots ` +
          "simultanés : il n'a pas de sources ouvertes. Éteignez un autre bot, puis redémarrez.",
      );
    }
    if (this.bot(botId) === undefined) {
      throw new SourcesParBotError(
        "bot_inconnu",
        `Bot inconnu : « ${botId} ». Aucune source ne peut lui appartenir.`,
      );
    }
    if (!this.ouvrir) {
      throw new SourcesParBotError(
        "bot_non_construit",
        `Les sources du bot « ${botId} » ne sont pas encore construites : le démarrage n'a pas fini.`,
      );
    }
    const pile = this.ouvrir({ botId, env: this.options.envInstance });
    this.pilesOuvertes.set(botId, pile);
    return pile;
  }

  /**
   * Résolution `jeton → (bot, nom, entrée de coffre)`.
   *
   * ⚠️ On n'invente rien : le jeton n'est comparé QUE contre les entrées de
   * sources RÉELLEMENT déclarées chez chaque bot (nom courant, plus l'ancien nom
   * pour `yuki`). Un jeton sans entrée ne résout aucun bot.
   *
   * ⚠️ Ambiguïté (deux bots portant le MÊME jeton — copie de secret) : on préfère
   * le bot ACTIF, puis l'ordre d'affichage. Ce cas est une erreur d'exploitation
   * (l'interface génère 32 octets aléatoires par jeton) ; il est journalisé.
   */
  resoudreJeton(jeton: string): JetonResolu | undefined {
    if (typeof jeton !== "string" || jeton === "") return undefined;
    const coffre = this.options.coffre;
    if (!coffre) return undefined;
    const botActif = this.bots().find((bot) => bot.actif === true)?.id;
    const bots = [...this.bots()].sort((a, b) => {
      if (a.id === botActif) return -1;
      if (b.id === botActif) return 1;
      return a.ordre - b.ordre;
    });
    const trouves: JetonResolu[] = [];
    for (const bot of bots) {
      let pile: PileSourcesBot;
      try {
        pile = this.pourBot(bot.id);
      } catch {
        // Pile non construite (démarrage) : ce bot ne peut pas authentifier.
        continue;
      }
      for (const record of pile.store.list()) {
        for (const secret of nomsSecretsSource(bot.id, record.nom)) {
          let attendu: string | undefined;
          try {
            attendu = coffre.lookup(secret);
          } catch {
            attendu = undefined;
          }
          if (tokensMatch(attendu, jeton)) trouves.push({ botId: bot.id, nom: record.nom, secret });
        }
      }
    }
    if (trouves.length === 0) return undefined;
    if (trouves.length > 1) {
      this.options.logger.warn("sources.jeton.ambigu", {
        entrees: trouves.map((trouve) => trouve.secret),
      });
    }
    return trouves[0];
  }

  /** Le nom est-il déclaré chez au moins UN bot ? (distingue 401 et 404) */
  private nomConnu(nom: string): boolean {
    for (const bot of this.bots()) {
      try {
        if (this.pourBot(bot.id).store.get(nom) !== undefined) return true;
      } catch {
        continue;
      }
    }
    return false;
  }

  /**
   * ⚠️ LE POINT D'ENTRÉE DU WEBHOOK — `POST /api/sources/<nom>/messages`.
   *
   * C'est ici que « le jeton du bot A ne réveille JAMAIS une source du bot B » se
   * décide, et nulle part ailleurs.
   */
  async recevoir(nom: string, jeton: string, body: unknown): Promise<SourceDelivery> {
    if (typeof jeton !== "string" || jeton === "") {
      throw new SourceApiError(
        401,
        "invalid_token",
        "Jeton absent : en-tête `Authorization: Bearer <jeton>` attendu.",
      );
    }
    const resolu = this.resoudreJeton(jeton);
    if (resolu === undefined) {
      // Aucune entrée de coffre ne porte ce jeton. Si le nom existe quelque part,
      // le refus est un 401 (et non un 404 trompeur) : le programme a un jeton,
      // mais pas le bon.
      if (this.nomConnu(nom)) {
        throw new SourceApiError(
          401,
          "invalid_token",
          "Jeton invalide : il doit correspondre au jeton de CETTE source.",
        );
      }
      throw new SourceApiError(404, "unknown_source", `Source inconnue : « ${nom} ».`);
    }
    const bot = this.bot(resolu.botId);
    if (bot !== undefined && bot.actif !== true) {
      // ⚠️ Un bot en veille ne travaille pas : son déclencheur ne peut pas être
      // réveillé, et on le DIT en nommant le bot (jamais un silence).
      throw new SourceApiError(
        403,
        "bot_inactif",
        `Le bot « ${resolu.botId} » est inactif : son déclencheur « ${resolu.nom} » ` +
          "ne peut pas être réveillé. Activez le bot dans la page des bots.",
        { bot: resolu.botId },
      );
    }
    if (nom !== resolu.nom) {
      // ⚠️ Le jeton désigne une AUTRE source du même bot : on ne la réveille pas et
      // on ne nomme PAS la source du jeton (rien à apprendre à un porteur de jeton).
      throw new SourceApiError(
        404,
        "unknown_source",
        `Source inconnue chez le bot « ${resolu.botId} » : « ${nom} ».`,
        { bot: resolu.botId },
      );
    }
    return this.pourBot(resolu.botId).service.receive(nom, jeton, body, resolu.secret);
  }

  /**
   * Les bots à balayer MAINTENANT — un bot INACTIF, REFUSÉ par le plafond, ou
   * sans capacité pertinente n'y figure pas.
   *
   * ⚠️ UNE cible par bot qui TOURNE (décision de démarrage, L1), jamais une par
   * bot du registre : un bot refusé n'a pas de pile, donc rien à balayer.
   *
   * ⚠️ Aucun minuteur n'est créé ici : le balayeur (`BalayeurBots`) possède
   * l'UNIQUE `setInterval` et appelle cette liste à chaque tick.
   */
  ciblesBalayage(): CibleBalayage[] {
    const cibles: CibleBalayage[] = [];
    const sansCapacite: string[] = [];
    for (const bot of this.botsActifs()) {
      if (!workerLourdAutorise(bot.capacites)) {
        sansCapacite.push(bot.id);
        continue;
      }
      let pile: PileSourcesBot;
      try {
        pile = this.pourBot(bot.id);
      } catch (error) {
        this.options.logger.warn("sources.balayeur.bot_indisponible", {
          bot: bot.id,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      const envois = pile.envois;
      cibles.push({
        botId: bot.id,
        store: pile.store,
        run: (nom, options) =>
          pile.service.declencher(nom, {
            origine: ORIGINE_HORLOGE,
            ...(options.planifie !== undefined ? { planifie: options.planifie } : {}),
            plafondMs: options.plafondMs,
            signal: options.signal,
            ...(options.desarmementPrealable === true ? { desarmementPrealable: true } : {}),
          }),
        ...(envois !== undefined
          ? { envoisProgrammes: { executerDus: (maintenant) => envois.executerDus(maintenant) } }
          : {}),
      });
    }
    // ⚠️ UN SEUL avertissement par tick, jamais un par source : un bot sans
    // capacité peut avoir dix déclencheurs en veille.
    if (sansCapacite.length > 0) {
      this.options.logger.warn("sources.balayeur.bots_sans_capacite", {
        bots: sansCapacite.join(","),
      });
    }
    return cibles;
  }

  /**
   * Dépendances d'API d'un bot (`?bot=<id>` sur les routes d'administration).
   * Un identifiant inconnu lève : la route répond alors 404 en nommant le bot.
   */
  depsPourBot(botId: string): DepsSourcesBot {
    const pile = this.pourBot(botId);
    return {
      service: pile.service,
      journal: pile.journal,
      preAutorisations: pile.preAutorisations,
      ...(pile.envois !== undefined ? { envois: pile.envois } : {}),
    };
  }

  /** Ferme toutes les piles ouvertes (arrêt gracieux). */
  fermer(): void {
    for (const pile of this.pilesOuvertes.values()) {
      try {
        pile.fermer();
      } catch {
        // Un arrêt gracieux ne lève jamais.
      }
    }
    this.pilesOuvertes.clear();
  }
}

/** Demande de consommation d'une pré-autorisation (forme du registre). */
type DemandeConsommation = Parameters<PreAutorisationStore["consommer"]>[0];
/** Issue d'une consommation (forme du registre). */
type ResultatConsommation = ReturnType<PreAutorisationStore["consommer"]>;

/**
 * PORT des pré-autorisations, PAR BOT DU RUN.
 *
 * ⚠️ Le bot vient de `botDuRun()` (valeur de DÉMARRAGE, `src/agents/execution.ts`),
 * JAMAIS d'un paramètre client : un appelant ne choisit pas la pile dont il
 * consomme l'autorisation. Conséquence testable : consommer pour le bot A ne
 * touche JAMAIS le fichier du bot B.
 */
export function portPreAutorisations(
  parBot: SourcesParBot,
  botDuRun: () => string,
): { consommer(demande: DemandeConsommation): ResultatConsommation } {
  return {
    consommer: (demande) => parBot.pourBot(botDuRun()).preAutorisations.consommer(demande),
  };
}

/**
 * ⚠️ LOT 36 (L11) — BRANCHEMENT DES PRÉ-AUTORISATIONS, UN PORT PAR BOT.
 *
 * Ce que ce module ferme : le démarrage branchait le MÊME port sur TOUS les
 * services d'exécution (`executionsAgents.pourChacun(setPreAutorisations)`). Or
 * ce port était lié à la fermeture `botDuRun` — figée sur le bot de la pile. Un
 * job de `kohai` consommait donc l'autorisation de `yuki` : ou rien (refus
 * silencieux), ou l'autorisation d'un autre nom.
 *
 * ⚠️ La consommation suit désormais le BOT DU SERVICE : chaque service reçoit le
 * port de SON registre (`portPour(botId)`), donc son fichier
 * `preautorisations.json` et son journal.
 */
export interface ExecutionsABrancher<T> {
  pourChacun(action: (execution: T, botId: string) => void): void;
}

/** Service qui accepte un port de pré-autorisations (`AgentExecutionService`). */
export interface ServicePreAutorisable {
  setPreAutorisations?(port: { consommer(demande: DemandeConsommation): ResultatConsommation }): void;
}

export function brancherPreAutorisationsParBot<T extends ServicePreAutorisable>(
  executions: ExecutionsABrancher<T>,
  portPour: (botId: string) => { consommer(demande: DemandeConsommation): ResultatConsommation },
): void {
  executions.pourChacun((execution, botId) => {
    if (typeof execution.setPreAutorisations !== "function") return;
    execution.setPreAutorisations(portPour(botId));
  });
}

/**
 * Prédicat « cet agent est-il visible pour CE bot ? » (`AgentRecord.bots`, lot 35g).
 *
 * ⚠️ Un enregistrement ABSENT de l'annuaire n'est pas filtré : il n'y a pas de
 * liste `bots` à respecter, et retirer toutes les autorisations d'un agent
 * disparu casserait une installation existante sans qu'aucun utilisateur ne l'ait
 * demandé. Un enregistrement PRÉSENT est filtré STRICTEMENT.
 */
export function filtreAgentVisible(
  annuaire: { get(agentId: string): { bots: string[] } | undefined } | undefined,
  botId: string,
  estVisible: (record: { bots: string[] }, botId: string) => boolean,
): (agentId: string) => boolean {
  return (agentId: string) => {
    const record = annuaire?.get(agentId);
    if (record === undefined) return true;
    return estVisible(record, botId);
  };
}
