/**
 * LE `PiHost` PAR BOT (lot 36, morceau L3-d) — dernier morceau de L3.
 *
 * ⚠️ POURQUOI CE MODULE : jusqu'à L3-c, `main()` construisait UN seul `PiHost`,
 * avec l'`Env`, le prompt et les ports du bot de la PILE. Les bots à démarrer
 * (L1) avaient donc leur configuration (L3-a), leurs outils (L3-b) et leur pile
 * de sources (L3-c) — mais aucun host : leurs conversations n'existaient pas.
 *
 * Ce module construit la **Map `botId → PiHost`** des bots à DÉMARRER, avec
 * trois règles, et elles suffisent :
 *
 *  1. **Le host du BOT DU RUN est EXACTEMENT celui d'aujourd'hui.** Ses options
 *     sont l'objet que `main()` construisait déjà, passé TEL QUEL (`===`) : un
 *     seul bot ⇒ aucune option ne change (garde de non-régression : `tests/
 *     bots/hosts.test.ts` compare `sessionsDir`, `systemPrompt` et chaque port
 *     par IDENTITÉ avec les valeurs d'avant ce morceau).
 *  2. **Les hosts des AUTRES bots DÉRIVENT de ces options** : seuls ce qui est
 *     PROPRE à un bot est remplacé (`sessionsDir`, `systemPrompt`, les ports de
 *     SA pile / de SES outils, son `botId`). Tout le reste (modèles, outils,
 *     délégation, fichiers, images, libraire, secrets, logger…) est celui de
 *     l'INSTANCE — un second jeu d'objets serait un second écrivain.
 *  3. **Un port qui n'existe pas pour un bot est RETIRÉ, jamais emprunté.**
 *     ⚠️ LOT 36 (L11) : la MÉMOIRE est un *service* (`MemoryPort`), pas un store.
 *     Depuis L11, `main()` en fournit un PAR BOT (`ServicesMemoireBots`, adossé
 *     aux stores du bot) et il arrive par `ContexteHostBot.memoire`. S'il manque
 *     (bot sans stores, double de test), le port est RETIRÉ et l'absence est dite
 *     au journal (`bots.host.port_absent`) — jamais d'emprunt au bot du run.
 *
 * ⚠️ CE QUE CE MODULE NE FAIT PAS (L4) : router les messages vers le host d'un
 * bot secondaire. Les routes d'instance, `getSubsystems` et le transport WS
 * gardent le host du BOT DU RUN (`hosts.duRun`) : aucun appelant ne change.
 * Les autres hosts EXISTENT, DÉMARRENT et S'ARRÊTENT — c'est tout ce que L3-d
 * promet.
 *
 * ⚠️ `main()` n'est jamais exécuté par les tests (`src/index.ts` lance `main()`
 * au chargement) : tout ce qui décide de la forme d'un host vit donc ICI, et
 * `creer` est une couture (défaut : `createPiHost`). Le seul filet du câblage
 * lui-même reste la campagne E2E.
 *
 * Aucun import SDK/typebox.
 */

import { appendVoiceInstruction } from "../llm/prompts.js";
import { composerPromptSysteme } from "../llm/prompt-systeme.js";
import { HeritageStore } from "../memory/heritage-store.js";
import type { PiHostOptions } from "../pi/types.js";
import { isTtsEnabled } from "../tts/options.js";

import type { OutilsBot } from "./outils.js";
import {
  candidatsPersonnalite,
  resoudrePersonnaliteBot,
  type CandidatFichierPersonnalite,
} from "./personnalite-bot.js";
import { portReglesDuBot, type CandidatFichierRegles } from "../rules/regles-bot.js";
import { portConsignes } from "../consignes/index.js";
import type { Env } from "../config/env.js";
import type { ConfigRuntime } from "../config/runtime.js";
import type { PileSourcesBot } from "../sources/par-bot.js";

// ⚠️ Les DEMANDES sont dérivées de la façade (`PiHostOptions`) : ce module
// n'importe RIEN de `src/pi/sdk/**` (invariant 3 de `tests/pi/boundary.test.ts`).
type DemandeEnvoiProgramme = Parameters<
  NonNullable<PiHostOptions["envoisProgrammes"]>["programmer"]
>[0];
type DemandePlanification = Parameters<
  NonNullable<PiHostOptions["planifierTache"]>["planifier"]
>[0];

/** Journal minimal attendu (le `Logger` de l'application le satisfait). */
export interface HostsBotLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/**
 * Ce qu'il faut d'un host pour le cycle de vie : rien de plus.
 *
 * ⚠️ Contrainte VOLONTAIREMENT étroite (et non `PiHost`) : les tests injectent
 * un host factice sans reconstruire la façade entière, et ce module ne peut pas
 * appeler autre chose que `start`/`stop` sur un host secondaire (L4 ouvrira le
 * reste).
 */
export interface HostDemarrable {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Les ports PROPRES à un bot. Chaque type est repris de `PiHostOptions` (jamais
 * recopié) : un port qui changerait de forme dans la façade casserait ici.
 */export interface PortsHostBot {
  /** Répertoire des sessions JSONL de CE bot (`<pi>/agent/sessions/<id>`). */
  readonly sessionsDir: string;
  /**
   * ⚠️ LOT 36 (L11) : la MÉMOIRE de CE bot — un service adossé à SON
   * `memory.jsonl` (`ServicesMemoireBots`). Absent ⇒ port RETIRÉ (le host du bot
   * n'aurait aucune mémoire, ce qui est dit au journal).
   */
  readonly memory?: PiHostOptions["memory"];
  /**
   * Prompt système de CE bot : identité (son NOM) + personnalité + `prompts.light`
   * de SON overlay + liste d'outils GÉNÉRÉE depuis SON allowlist
   * (`src/llm/prompt-systeme.ts`), puis la consigne de voix.
   */
  readonly systemPrompt: string;
  /**
   * ALLOWLIST FINALE de CE bot (`toolAllowlistForChat`). Elle est posée telle
   * quelle sur le host : le prompt et la politique d'outils sont donc la MÊME
   * liste (aucun texte ne peut annoncer un outil absent). Absente ⇒ la politique
   * héritée du bot du run est conservée (jamais inventée).
   */
  readonly tools?: readonly string[];
  /** Drain des notifications de SA pile de sources (L3-c). */
  readonly sources?: PiHostOptions["sources"];
  /** Envois programmés de CE bot (son `envois-programmes.json`). */
  readonly envoisProgrammes?: PiHostOptions["envoisProgrammes"];
  /** Tâches planifiées de CE bot (son `sources.json`). */
  readonly planifierTache?: PiHostOptions["planifierTache"];
  readonly rules?: PiHostOptions["rules"];
  /**
   * ⚠️ CONSIGNES DURABLES de CE bot (`<state>/bots/<id>/consignes.md`) : le port
   * est construit avec SON chemin, donc les blocs injectés et les outils
   * d'écriture ne peuvent pas viser le fichier d'un autre bot.
   */
  readonly consignes?: PiHostOptions["consignes"];
  readonly reactions?: PiHostOptions["reactions"];
  /** Archive des conversations de CE bot (L3-b). */
  readonly conversationArchive?: PiHostOptions["conversationArchive"];
  /** Archive « vie antérieure » de CE bot (lecture seule). */
  readonly heritage?: PiHostOptions["heritage"];
  /**
   * ⚠️ LOT 36 (L6) : le service d'EXÉCUTION DE CE BOT. Même `AgentStore`, même
   * `AgentHub`, même TLS 9443 que les autres — seule la VISIBILITÉ des agents
   * change (`AgentRecord.bots` est contrôlé par commande avec le bot du run).
   * Absent ⇒ le port est RETIRÉ du host du bot : hériter celui du bot du run
   * ferait exécuter une commande avec la visibilité d'un autre bot.
   */
  readonly execution?: PiHostOptions["execution"];
  /** Capture d'écran DE CE BOT (même service que `execution`, port distinct). */
  readonly screenshots?: PiHostOptions["screenshots"];
  /**
   * ⚠️ LOT 36 (L11) : le port de DÉLÉGATION de CE BOT (`portDelegationBot`).
   * Absent ⇒ aucun outil `delegate` pour ce host (jamais celui du bot du run).
   */
  readonly delegation?: PiHostOptions["delegation"];
  /**
   * ⚠️ LOT 36 (L11) : la source d'ÉVÉNEMENTS de CE BOT (`evenementsDuBot`) —
   * seuls les jobs de ce bot sont relayés sur son bus.
   */
  readonly eventSource?: PiHostOptions["eventSource"];
}

/** Ce qu'un bot apporte à la construction de son host (jamais celui d'un autre). */
export interface ContexteHostBot {
  readonly botId: string;
  /**
   * ⚠️ NOM AFFICHÉ du bot (registre) : c'est l'identité injectée dans SON prompt.
   * Absent ⇒ l'identifiant sert de nom (jamais un nom d'un autre bot).
   */
  readonly nom?: string;
  /**
   * ⚠️ ALLOWLIST FINALE de ce bot : contenu du bloc `<outils>` de son prompt ET
   * politique d'outils de son host. Absente ⇒ aucun bloc d'outils (un appelant
   * qui ne connaît pas sa politique n'annonce rien plutôt que de mentir).
   */
  readonly outilsAutorises?: readonly string[];
  /** `Env` RÉSOLU de ce bot (une seule résolution, L3-b/L3-c). */
  readonly env: Env;
  /** Configuration DE CE BOT (L3-a). Absente ⇒ pas de prompt ⇒ pas de host. */
  readonly config?: ConfigRuntime;
  /** Outils DE CE BOT (L3-b). Absents ⇒ les ports correspondants sont retirés. */
  readonly outils?: OutilsBot;
  /**
   * ⚠️ FICHIER D'AMORÇAGE HISTORIQUE DE L'INSTANCE (`<state>/personality.md`) :
   * l'ancien emplacement mono-bot. Il n'est PAS lu à la place du fichier du bot,
   * il vient APRÈS (le plus spécifique gagne) — mais s'il est absent de la
   * résolution, une instance dont le texte vit encore là retombe sur le DÉFAUT
   * LIVRÉ (régression du 2026-11-14). Absent ⇒ seul le fichier du bot est lu.
   */
  readonly personnaliteInstance?: CandidatFichierPersonnalite;
  /**
   * ⚠️ FICHIER D'INSTANCE HISTORIQUE DES RÈGLES (`<state>/rules.md`). Les règles
   * sont résolues comme la personnalité : fichier DU BOT
   * (`<state>/bots/<id>/rules.md`) puis ce fichier-ci, puis RIEN. Absent ⇒ seul
   * le fichier du bot est lu.
   */
  readonly reglesInstance?: CandidatFichierRegles;
  /** Pile sources DE CE BOT (L3-c). Absente ⇒ pas de drain, pas de tâches. */
  readonly pile?: PileSourcesBot;
  /**
   * ⚠️ LOT 36 (L11) : le SERVICE de mémoire de CE BOT (`ServicesMemoireBots`),
   * adossé à ses stores (L3-b). Absent ⇒ le port `memory` est retiré du host.
   */
  readonly memoire?: PiHostOptions["memory"];
  /**
   * ⚠️ LOT 36 (L11) : le port de DÉLÉGATION de CE BOT (`portDelegationBot`) —
   * le même service, mais chaque job créé porte SON `botId`. Absent ⇒ aucun
   * outil `delegate` pour ce host (jamais celui du bot du run : un job sans
   * `botId` serait attribué au mauvais bot).
   */
  readonly delegation?: PiHostOptions["delegation"];
  /**
   * ⚠️ LOT 36 (L11) : la source d'événements de CE BOT (`evenementsDuBot`) —
   * seuls les jobs de ce bot sont relayés. Absente ⇒ aucun événement de job.
   */
  readonly eventSource?: PiHostOptions["eventSource"];
  /** Service d'exécution DE CE BOT (L6). Absent ⇒ port `execution` retiré. */
  readonly execution?: PiHostOptions["execution"];
  /** Capture d'écran DE CE BOT (L6). Absent ⇒ port `screenshots` retiré. */
  readonly screenshots?: PiHostOptions["screenshots"];
}

/**
 * Les ports d'UN bot, dérivés de son contexte.
 *
 * Rend `undefined` quand la configuration du bot manque : sans elle, il n'y a
 * pas de prompt système, donc pas de host honnête (emprunter celui du bot du run
 * ferait parler un bot avec le prompt d'un autre). L'appelant le DIT au journal.
 */
export function portsHostBot(
  contexte: ContexteHostBot,
  logger?: HostsBotLogger,
): PortsHostBot | undefined {
  const config = contexte.config;
  if (config === undefined) return undefined;

  const outils = contexte.outils;
  const pile = contexte.pile;
  const envois = pile?.envois;
  const absent: string[] = [];
  if (outils === undefined) absent.push("outils");
  if (pile === undefined) absent.push("sources");
  // ⚠️ La MÉMOIRE est un service (`MemoryPort`), pas un store : depuis L11 il
  // arrive par le contexte (`ServicesMemoireBots`). S'il manque, on le DIT (une
  // ligne) au lieu de laisser croire que le host a une mémoire.
  if (contexte.memoire === undefined) absent.push("memory");
  if (absent.length > 0) {
    logger?.info("bots.host.port_absent", { bot: contexte.botId, ports: absent.join(",") });
  }

  return {
    sessionsDir: contexte.env.piSessionsDir,
    ...(contexte.memoire !== undefined ? { memory: contexte.memoire } : {}),
    // ⚠️ MÊME calcul que `main()` pour la pile (`promptLeger` + consigne de voix),
    // mais avec la configuration DE CE BOT : `prompts.light` et `tts.enabled` sont
    // des réglages MIXTES — la surcharge du bot l'emporte, sinon l'instance.
    // ⚠️ POINT D'ASSEMBLAGE UNIQUE (`src/llm/prompt-systeme.ts`) : identité (nom du
    // bot) + personnalité (`prompts.personnalite` de SON overlay) + prompt léger +
    // liste d'outils GÉNÉRÉE depuis SON allowlist. Éditer l'un ne touche jamais
    // l'autre, et un outil ajouté/retiré suit sans réédition.
    // ⚠️ UNE SEULE PERSONNALITÉ (2026-11-14) : elle est RÉSOLUE ici par
    // `resoudrePersonnaliteBot` (champ renseigné > fichier d'amorçage > défaut
    // livré), et composée UNE fois. Le fichier `personality.md` n'est plus
    // concaténé à la fin du prompt par une extension (c'était la seconde source).
    systemPrompt: appendVoiceInstruction(
      composerPromptSysteme({
        nom: contexte.nom ?? contexte.botId,
        personnalite: resoudrePersonnaliteBot({
          botId: contexte.botId,
          config,
          // ⚠️ DEUX fichiers candidats, du PLUS SPÉCIFIQUE au plus général :
          // le fichier DU BOT (`outils.personnalite`, chemin du bot), puis le
          // fichier HISTORIQUE de l'instance. Aucun `botId` n'est à part.
          fichiers: candidatsPersonnalite(
            contexte.outils !== undefined
              ? {
                  portee: "bot",
                  chemin: contexte.outils.chemins.personalityPath,
                  store: contexte.outils.personnalite,
                }
              : undefined,
            contexte.personnaliteInstance,
          ),
          ...(logger !== undefined ? { logger } : {}),
        }).texte,
        prompt: config.getString("prompts.light"),
        ...(contexte.outilsAutorises !== undefined
          ? { outils: contexte.outilsAutorises }
          : {}),
      }),
      isTtsEnabled(config),
    ),
    ...(contexte.outilsAutorises !== undefined
      ? { tools: contexte.outilsAutorises }
      : {}),
    // ⚠️ RÈGLES : MÊME résolution que la personnalité — fichier DU BOT, puis
    // fichier d'INSTANCE, puis rien. Le port relit à CHAQUE tour (à chaud) : il
    // n'y a donc pas de copie figée. Le fichier du bot manquait pour le bot de la
    // pile (il lisait le fichier d'instance, déplacé par la migration) : les
    // règles n'étaient jamais injectées.
    rules: portReglesDuBot({
      botId: contexte.botId,
      cheminBot: outils?.chemins.rulesPath ?? contexte.env.rulesPath,
      ...(contexte.reglesInstance !== undefined
        ? { cheminInstance: contexte.reglesInstance.chemin }
        : {}),
      ...(logger !== undefined ? { logger } : {}),
    }),
    // ⚠️ CONSIGNES DURABLES : UN fichier par bot (`consignes.md`), relu à CHAQUE
    // tour par l'extension et écrit par les quatre outils. Aucune résolution en
    // cascade (contrairement aux règles) : ce fichier n'a jamais existé ailleurs,
    // et un bot ne doit pas hériter des consignes d'un autre.
    consignes: portConsignes({
      botId: contexte.botId,
      chemin: outils?.chemins.consignesPath ?? contexte.env.consignesPath,
      ...(logger !== undefined ? { logger } : {}),
    }),
    ...(pile !== undefined ? { sources: pile.service } : {}),
    ...(envois !== undefined
      ? {
          // ⚠️ `async` : le port rend une PROMESSE (le service, lui, répond en
          // synchrone) — même forme que le port de `main()` pour la pile.
          envoisProgrammes: {
            programmer: async (request: DemandeEnvoiProgramme) => envois.programmer(request),
          },
        }
      : {}),
    ...(pile !== undefined
      ? {
          planifierTache: {
            planifier: async (request: DemandePlanification) =>
              pile.service.planifierTache(request),
          },
        }
      : {}),
    ...(contexte.execution !== undefined ? { execution: contexte.execution } : {}),
    ...(contexte.screenshots !== undefined ? { screenshots: contexte.screenshots } : {}),
    ...(contexte.delegation !== undefined ? { delegation: contexte.delegation } : {}),
    ...(contexte.eventSource !== undefined ? { eventSource: contexte.eventSource } : {}),
    ...(outils !== undefined
      ? {
          // ⚠️ PAS de `personality` ni de `rules` ICI : la personnalité est
          // composée dans `systemPrompt` et les règles passent par le port
          // résolu ci-dessus (fichier du bot → fichier d'instance). Les stores
          // `outils.personnalite` / `outils.regles` ne sont donc plus injectés
          // tels quels : un store ouvert sur le fichier d'INSTANCE n'est PAS le
          // fichier du bot (c'est la panne corrigée ici).
          reactions: outils.reactions,
          conversationArchive: outils.archive,
          // Archive « vie antérieure » : le dossier est celui du bot. La
          // construction est PURE (aucune écriture — `ensureLayout` n'est pas
          // appelé) et l'outil qui la lit est en LECTURE SEULE.
          heritage: new HeritageStore({
            dir: outils.env.heritageDir,
            ...(logger !== undefined ? { logger } : {}),
          }),
        }
      : {}),
  };
}

/**
 * Options du host d'un AUTRE bot : celles du bot du run, moins ce qui appartient
 * au bot du run.
 *
 * ⚠️ Le retrait est aussi important que le remplacement : `memory`, `heritage`,
 * `conversationArchive`, `rules`, `reactions`, `sources`, `envoisProgrammes` et
 * `planifierTache` désignent des FICHIERS. Hériter de ceux du bot du run ferait
 * lire/écrire les fichiers d'un autre bot — exactement ce que « un seul
 * rédacteur » interdit.
 */
export function optionsHostBot(
  botId: string,
  optionsPile: PiHostOptions,
  ports: PortsHostBot,
): PiHostOptions {
  // Copie SURFACE : les valeurs partagées (modèles, outils, délégation, logger…)
  // restent les MÊMES objets (`===`), donc les mêmes services.
  const options: PiHostOptions = {
    ...optionsPile,
    sessionsDir: ports.sessionsDir,
    systemPrompt: ports.systemPrompt,
    // ⚠️ Chaque host SAIT à quel bot il appartient (journalisation, diagnostic) :
    // c'est le seul champ ajouté par ce morceau à la façade.
    botId,
  };
  // ⚠️ POLITIQUE D'OUTILS PAR BOT : quand le contexte a fourni SON allowlist, elle
  // remplace celle du bot du run — sinon le host d'un bot secondaire tournerait
  // avec les outils d'un autre (et son prompt, lui, annoncerait les siens).
  if (ports.tools !== undefined) options.tools = [...ports.tools];
  poserSinonRetirer(options, "sources", ports.sources);
  poserSinonRetirer(options, "envoisProgrammes", ports.envoisProgrammes);
  poserSinonRetirer(options, "planifierTache", ports.planifierTache);
  poserSinonRetirer(options, "rules", ports.rules);
  // ⚠️ Les consignes sont un FICHIER PAR BOT : hériter de celles du bot du run
  // ferait écrire le bot secondaire dans le fichier d'un autre.
  poserSinonRetirer(options, "consignes", ports.consignes);
  poserSinonRetirer(options, "reactions", ports.reactions);
  poserSinonRetirer(options, "conversationArchive", ports.conversationArchive);
  poserSinonRetirer(options, "heritage", ports.heritage);
  // ⚠️ LOT 36 (L6) : l'exécution d'un bot n'est JAMAIS celle du bot du run (la
  // visibilité des agents y est figée) — posée si elle existe, retirée sinon.
  poserSinonRetirer(options, "execution", ports.execution);
  poserSinonRetirer(options, "screenshots", ports.screenshots);
  // ⚠️ LOT 36 (L11) : la mémoire est CELLE DU BOT (son service, ses stores) ; si
  // le contexte n'en fournit pas, elle est RETIRÉE plutôt qu'empruntée au
  // bot du run (`delete` explicite : la copie de surface l'a héritée).
  poserSinonRetirer(options, "memory", ports.memory);
  // ⚠️ LOT 36 (L11) — LA DÉLÉGATION AUSSI EST PAR BOT : le port du bot du run crée
  // des jobs SANS `botId` (donc attribués à lui). Un host secondaire reçoit le
  // sien, ou aucun outil `delegate` — jamais celui d'un autre.
  poserSinonRetirer(options, "delegation", ports.delegation);
  poserSinonRetirer(options, "eventSource", ports.eventSource);
  return options;
}

/** Pose le port s'il existe, sinon RETIRE la valeur héritée du bot du run. */
function poserSinonRetirer<K extends keyof PiHostOptions>(
  options: PiHostOptions,
  cle: K,
  port: PiHostOptions[K] | undefined,
): void {
  if (port !== undefined) {
    options[cle] = port;
    return;
  }
  delete options[cle];
}

export interface OptionsHostsBots<THost extends HostDemarrable> {
  /** Bot de la PILE (`main()`) : son host est le PRINCIPAL, jamais reconstruit. */
  readonly pile: string;
  /** Bots à DÉMARRER (L1, `ResolutionDemarrageBots.aDemarrer`) — les refusés n'y sont pas. */
  readonly bots: readonly string[];
  /** Options EXACTES du host du bot du run (celles d'avant L3-d). */
  readonly optionsPile: PiHostOptions;
  /** Fabrique de host (défaut côté `main()` : `createPiHost`). */
  readonly creer: (options: PiHostOptions) => THost;
  /** Contexte d'un bot (son `Env`, sa configuration, ses outils, sa pile). */
  readonly contexte: (botId: string) => ContexteHostBot | undefined;
  readonly logger: HostsBotLogger;
}

/** Ce que le démarrage a réellement fait (journal + diagnostic). */
export interface BilanDemarrageHosts {
  /** Bots dont le host a démarré. */
  readonly demarres: readonly string[];
  /** Bots dont le host a REFUSÉ de démarrer (nommés, jamais tus). */
  readonly echecs: readonly string[];
  /**
   * ⚠️ POURQUOI CHAQUE ÉCHEC (lot 38) : un identifiant dans `echecs` ne dit pas
   * à l'utilisateur quoi corriger. Cette table porte le message RÉEL (config
   * absente, dossier de sessions partagé, exception de `host.start()`), que
   * `main()` confie à `ExecutionBots` pour que `GET /api/bots` l'affiche.
   */
  readonly raisons: Readonly<Record<string, string>>;
}

/**
 * Map `botId → PiHost` des bots à démarrer, le PRINCIPAL compris.
 *
 * ⚠️ Deux invariants :
 *  1. **un seul host par bot** (une Map, un identifiant construit une fois) ;
 *  2. **le bot du run n'est jamais dérivé** : il est construit avec
 *     `optionsPile`, tel quel, et rendu par `duRun` — c'est le host que
 *     `main()` garde sous le nom `host` (routes d'instance, `getSubsystems`,
 *     transport WS).
 */
export class HostsBots<THost extends HostDemarrable> {
  private readonly options: OptionsHostsBots<THost>;
  private readonly map = new Map<string, THost>();
  private readonly demarres = new Set<string>();
  /**
   * Raisons des hosts qui n'ont PAS pu être construits (lot 38) : elles sont
   * rendues au démarrage pour être affichées, au lieu de ne vivre que dans le
   * journal — c'est ce qui laissait « arrêtée (erreur au démarrage) » sans
   * explication.
   */
  private readonly refus = new Map<string, string>();
  /** Le host du bot de la PILE — EXACTEMENT celui d'avant L3-d. */
  readonly duRun: THost;

  constructor(options: OptionsHostsBots<THost>) {
    this.options = options;
    this.duRun = options.creer(options.optionsPile);
    this.map.set(options.pile, this.duRun);

    for (const botId of options.bots) {
      if (this.map.has(botId)) continue;
      this.construire(botId);
    }

    // ⚠️ Diagnostic SANS CONTENU : des identifiants et un compte, jamais un
    // prompt, un souvenir ou un texte de personnalité.
    options.logger.info("bots.hosts", {
      pile: options.pile,
      nombre: this.map.size,
      ids: [...this.map.keys()].join(","),
      secondaires: this.map.size - 1,
    });
  }

  /** Construit (ou refuse, en le DISANT et en le RETENANT) le host d'un bot secondaire. */
  private construire(botId: string): boolean {
    const options = this.options;
    let contexte: ContexteHostBot | undefined;
    try {
      contexte = options.contexte(botId);
    } catch (error) {
      // ⚠️ Le contexte peut LEVER (pile du bot illisible) : sa raison est plus
      // précise que tout message générique — on la garde telle quelle.
      this.refus.set(botId, `« ${botId} » n'a pas pu être préparé : ${messageOf(error)}`);
      options.logger.warn("bots.host.contexte_echec", { bot: botId, error: messageOf(error) });
      return false;
    }
    if (contexte === undefined) {
      this.refus.set(
        botId,
        `« ${botId} » n'a pas pu être préparé : ses fichiers ou sa configuration ` +
          "sont incomplets (voir le journal du gateway).",
      );
      options.logger.warn("bots.host.contexte_absent", { bot: botId });
      return false;
    }
    const ports = portsHostBot(contexte, options.logger);
    if (ports === undefined) {
      this.refus.set(
        botId,
        `« ${botId} » n'a pas pu démarrer : sa configuration est incomplète ` +
          "(le prompt du bot est absent).",
      );
      options.logger.warn("bots.host.config_absente", { bot: botId });
      return false;
    }
    // ⚠️ DEUX hosts sur le même `sessionsDir` se disputeraient les mêmes JSONL
    // (deux `SessionManager` sur un fichier) : on REFUSE le second host plutôt
    // que de corrompre les sessions. Symptôme d'un `Env` mal résolu, pas d'une
    // configuration utilisateur — mais la raison est DITE, avec le dossier.
    if (ports.sessionsDir === options.optionsPile.sessionsDir) {
      this.refus.set(
        botId,
        `« ${botId} » n'a pas pu démarrer : son dossier de sessions est celui du ` +
          `bot de l'instance (${ports.sessionsDir}). Deux bots ne peuvent pas ` +
          "partager ce dossier.",
      );
      options.logger.warn("bots.host.sessions_dir_partage", {
        bot: botId,
        sessions_dir: ports.sessionsDir,
      });
      return false;
    }
    this.map.set(botId, options.creer(optionsHostBot(botId, options.optionsPile, ports)));
    this.refus.delete(botId);
    options.logger.info("bots.host.construit", {
      bot: botId,
      sessions_dir: ports.sessionsDir,
    });
    return true;
  }

  /** Raison pour laquelle ce bot n'a pas de host, ou `undefined`. */
  raisonRefus(botId: string): string | undefined {
    return this.refus.get(botId);
  }

  /** Tous les hosts, dans l'ordre de construction (bot du run d'abord). */
  hosts(): ReadonlyMap<string, THost> {
    return this.map;
  }

  /** Identifiants des bots qui ont un host (bot du run d'abord). */
  ids(): string[] {
    return [...this.map.keys()];
  }

  /** Nombre de hosts (le bot du run compte). */
  get taille(): number {
    return this.map.size;
  }

  /** Host d'un bot (bot du run inclus), ou `undefined`. */
  pour(botId: string): THost | undefined {
    return this.map.get(botId);
  }

  /**
   * ⚠️ LOT 36 (L11) — BOT PROPRIÉTAIRE d'un host (`BotHostsPort.botDe`).
   *
   * Parcours de la Map par IDENTITÉ : c'est le seul moyen sûr de nommer le bot
   * qui parle quand le transport ne reçoit qu'un host (TTS, journal). Un host
   * inconnu (double de test, host arrêté) rend `undefined` — jamais le bot du run
   * par défaut.
   */
  botDe(host: THost): string | undefined {
    for (const [botId, candidat] of this.map) {
      if (candidat === host) return botId;
    }
    return undefined;
  }

  /**
   * Host d'un bot SEULEMENT s'il a démarré.
   *
   * ⚠️ C'est ce que doivent utiliser les réveils (sources, déclencheurs) : un
   * host construit mais dont `start()` a échoué ne peut rien exécuter. Le bot
   * du bot du run est toujours rendu (son démarrage est géré par `main()`).
   */
  pourDemarre(botId: string): THost | undefined {
    if (botId === this.options.pile) return this.duRun;
    return this.demarres.has(botId) ? this.map.get(botId) : undefined;
  }

  /**
   * Le bot a-t-il un host DÉMARRÉ ?
   *
   * ⚠️ Le bot de la PILE est toujours dit démarré : c'est `main()` qui l'a
   * démarré, pas cette fabrique (« un seul `stop` par host »). Un échec de SON
   * démarrage est journalisé (`pi.start.failed`) et porté par le statut `pi`,
   * pas par cette Map — sinon `GET /api/bots` annoncerait le bot du run
   * arrêté alors que l'instance tourne.
   */
  estDemarre(botId: string): boolean {
    if (botId === this.options.pile) return true;
    return this.demarres.has(botId);
  }

  /**
   * Démarre les hosts des bots AUTRES que le bot du run.
   *
   * ⚠️ Le bot du run n'est pas démarré ici : `main()` garde son `try/catch` (il
   * en tire `piStatus` et le compte de sessions). Chaque host secondaire a le
   * sien : un échec est JOURNALISÉ et n'empêche ni le bot du run de servir, ni
   * les autres bots de démarrer.
   */
  async demarrerAutres(): Promise<BilanDemarrageHosts> {
    const demarres: string[] = [];
    const echecs: string[] = [];
    const raisons: Record<string, string> = {};
    // ⚠️ Les bots dont le host a été REFUSÉ à la construction (config absente,
    // sessions partagées) ne sont pas dans `map` : sans ce report, leur échec
    // n'aurait AUCUNE raison affichable.
    for (const botId of this.options.bots) {
      if (botId === this.options.pile || this.map.has(botId)) continue;
      echecs.push(botId);
      raisons[botId] =
        this.refus.get(botId) ??
        `Le bot « ${botId} » n'a pas pu préparer sa conversation.`;
    }
    for (const [botId, host] of this.map) {
      if (botId === this.options.pile) continue;
      try {
        await host.start();
        this.demarres.add(botId);
        demarres.push(botId);
      } catch (error) {
        const raison = messageOf(error);
        echecs.push(botId);
        raisons[botId] = raison;
        this.options.logger.error("bots.host.start.failed", {
          bot: botId,
          error: raison,
        });
      }
    }
    this.options.logger.info("bots.hosts.demarres", {
      demarres: demarres.join(","),
      echecs: echecs.join(","),
      nombre: demarres.length,
    });
    return { demarres, echecs, raisons };
  }

  /** Le bot a-t-il un host CONSTRUIT (démarré ou non) ? */
  estConstruit(botId: string): boolean {
    return this.map.has(botId);
  }

  /**
   * DÉMARRE un bot — et le CONSTRUIT s'il n'a pas encore de host (lot 36, L8).
   *
   * ⚠️ C'est ce qui fait qu'un bouton « Démarrer » fait quelque chose : sans
   * construction à la demande, allumer un bot créé APRÈS le démarrage du gateway
   * ne produirait qu'un `host` absent. La pile, elle, est ouverte par l'appelant
   * (`FabriquePilesSources.ouvrir`, idempotent) : un host sans pile n'aurait ni
   * sources ni envois.
   *
   * ⚠️ Le bot de la PILE n'est jamais démarré ici : `main()` l'a fait, et un
   * second `start()` sur le même host serait un double démarrage.
   */
  async demarrerBot(
    botId: string,
  ): Promise<{ ok: boolean; inchange: boolean; erreur?: string }> {
    if (botId === this.options.pile) return { ok: true, inchange: true };
    if (!this.map.has(botId)) {
      const construit = this.construire(botId);
      if (!construit) {
        return {
          ok: false,
          inchange: false,
          erreur:
            this.refus.get(botId) ??
            `Le bot « ${botId} » n'a pas pu préparer sa conversation.`,
        };
      }
    }
    if (this.demarres.has(botId)) return { ok: true, inchange: true };
    const host = this.map.get(botId);
    if (host === undefined) {
      return { ok: false, inchange: false, erreur: `Le bot « ${botId} » n'a pas de host.` };
    }
    try {
      await host.start();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.logger.error("bots.host.start.failed", { bot: botId, error: message });
      return { ok: false, inchange: false, erreur: message };
    }
    this.demarres.add(botId);
    this.options.logger.info("bots.host.demarre", { bot: botId });
    return { ok: true, inchange: false };
  }

  /**
   * ARRÊTE un bot ET DÉTRUIT son host (lot 36, L8/L9).
   *
   * ⚠️ Le host est RETIRÉ de la Map : un « Démarrer » ultérieur reconstruit un
   * host NEUF (options re-dérivées de la configuration du moment). Le rendre
   * simplement « non démarré » laisserait un `PiHost` dont on ne sait pas s'il
   * est réutilisable — et l'état affiché mentirait sur ce qui existe.
   *
   * ⚠️ Le bot de la PILE est REFUSÉ : c'est l'instance elle-même (routes,
   * transport, `getSubsystems`). L'arrêter laisserait le gateway debout sans
   * conversation principale — l'arrêt de l'instance est `shutdown`, pas ceci.
   */
  async arreterBot(
    botId: string,
  ): Promise<{ ok: boolean; inchange: boolean; erreur?: string }> {
    if (botId === this.options.pile) {
      return {
        ok: false,
        inchange: false,
        erreur:
          `Le bot « ${botId} » est celui de l'instance : il ne s'arrête ` +
          "qu'avec le gateway.",
      };
    }
    const host = this.map.get(botId);
    if (host === undefined) return { ok: true, inchange: true };
    const demarre = this.demarres.delete(botId);
    if (demarre) {
      try {
        await host.stop();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.options.logger.warn("bots.host.stop.failed", { bot: botId, error: message });
        this.map.delete(botId);
        return { ok: false, inchange: false, erreur: message };
      }
    }
    this.map.delete(botId);
    this.options.logger.info("bots.host.detruit", { bot: botId, demarre });
    return { ok: true, inchange: !demarre };
  }

  /**
   * Arrête les hosts des bots AUTRES que le bot du run.
   *
   * ⚠️ Le bot du run est arrêté par `main()` (`await host?.stop()`), comme
   * avant : deux appels concurrents sur le même host seraient un arrêt double.
   */
  async arreter(): Promise<void> {
    const arretes: string[] = [];
    for (const botId of [...this.demarres]) {
      const host = this.map.get(botId);
      if (host === undefined) continue;
      try {
        await host.stop();
        arretes.push(botId);
      } catch (error) {
        this.options.logger.warn("bots.host.stop.failed", {
          bot: botId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.demarres.clear();
    if (arretes.length > 0) {
      this.options.logger.info("bots.hosts.arretes", { bots: arretes.join(",") });
    }
  }
}

/** Message d'une exception, sans jamais perdre l'information (lot 38). */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
