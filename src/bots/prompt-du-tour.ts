/**
 * PORT DU PROMPT DU TOUR — implémentation : RELIT les sources à chaque tour.
 *
 * ⚠️ CE QUE CE MODULE FERME (bug du 2026-11-14) : le prompt système était FIGÉ
 * au démarrage du host. Éditer la personnalité, un prompt ou les règles ne
 * changeait rien avant un redémarrage — le bot `grolaf` répondait « je suis là —
 * Yuki » alors que sa personnalité était saisie. Ici, chaque appel à `lire()`
 * RELIT la configuration, le fichier de personnalité et compose le prompt du
 * tour : le message SUIVANT porte donc le nouveau texte.
 *
 * ⚠️ CE QUI EST FIGÉ (et doit le rester) :
 *  - le NOM du bot (registre) : renommer un bot n'est pas un réglage de prompt ;
 *  - la liste d'outils (`allowlist` du host) : changer de politique d'outils
 *    redémarre le host — le bloc `<outils>` suit la politique réelle, jamais une
 *    liste relue à moitié ;
 *  - la consigne de VOIX (`tts.enabled`) : le réglage exige un redémarrage, et
 *    l'interface le dit. La faire suivre ici alors que le badge annonce un
 *    redémarrage serait un mensonge de plus.
 *
 * ⚠️ AUCUNE RELECTURE DU REGISTRE NI DU CATALOGUE DE CONFIG : on relit le petit
 * overlay du bot (un `reload()` borné) et un ou deux fichiers Markdown. Jamais
 * `bots.json`, jamais `CONFIG_SCHEMA`.
 *
 * ⚠️ UN ÉCHEC DE LECTURE NE CASSE RIEN : dernière valeur connue + journal
 * (`prompt.du_tour.relecture_echec`). Jamais un prompt vide, jamais d'exception.
 */

import type { ConfigRuntime } from "../config/runtime.js";
import { promptDuTour, type PortPromptDuTour } from "../llm/prompt-du-tour.js";
import type { RolePromptSysteme } from "../llm/prompt-systeme.js";

import {
  candidatsPersonnalite,
  resoudrePersonnaliteBot,
  type CandidatFichierPersonnalite,
} from "./personnalite-bot.js";

/** Journal minimal (le `Logger` de l'application en est un sur-ensemble). */
export interface LoggerPromptDuTour {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface OptionsPortPromptDuTour {
  /** Bot concerné (journalisation, diagnostic). */
  readonly botId: string;
  /** Nom AFFICHÉ du bot — FIGÉ (registre non relu à chaque tour). */
  readonly nom?: string;
  /** `light` (conversation) ou `heavy` (worker). Défaut : `light`. */
  readonly role?: RolePromptSysteme;
  /** Allowlist FINALE du bot — FIGÉE (elle décrit sa politique d'outils). */
  readonly outils?: readonly string[];
  /**
   * Configuration DE CE BOT. Relue sur le disque à chaque tour (`reload()`) :
   * le cache mémoire d'un `ConfigRuntime` de bot NON-pile est figé au démarrage,
   * une relecture à chaud verrait donc l'ANCIENNE valeur.
   */
  readonly config?: ConfigRuntime;
  /** Fichiers d'amorçage de la personnalité (du plus spécifique au plus général). */
  readonly fichiersPersonnalite?: readonly CandidatFichierPersonnalite[];
  /**
   * Source de personnalité DÉJÀ branchée (tests, appelants qui résolvent
   * autrement). Fournie ⇒ `fichiersPersonnalite` et `config` ne servent pas à la
   * personnalité.
   */
  readonly personnalite?: () => string;
  /** Consigne de voix (`tts.enabled` lu AU DÉMARRAGE — voir l'en-tête). */
  readonly voix?: boolean;
  /**
   * ⚠️ NOMS des AUTRES bots du registre (capturés au démarrage, jamais relus) :
   * une personnalité qui cite un autre bot est SIGNALÉE
   * (`personnalite.nom_autre_bot`) — avertissement, jamais blocage : citer un
   * autre bot peut être légitime.
   */
  readonly autresBots?: readonly string[];
  /** Prompt du host (valeur INITIALE) : secours si la première relecture échoue. */
  readonly valeurInitiale?: string;
  readonly logger?: LoggerPromptDuTour;
}

/** Échappe une chaîne pour l'utiliser dans une expression régulière. */
function echapper(texte: string): string {
  return texte.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Le texte MENTIONNE-t-il ce nom, comme un mot ? (insensible à la casse)
 *
 * ⚠️ Bornes de part et d'autre : « Yuki » ne doit pas matcher « Yukiteru ».
 */
export function mentionneNom(texte: string, nom: string): boolean {
  const valeur = nom.trim();
  if (valeur === "" || texte.trim() === "") return false;
  const motif = new RegExp(
    `(^|[^\\p{L}\\p{N}])${echapper(valeur)}($|[^\\p{L}\\p{N}])`,
    "iu",
  );
  return motif.test(texte);
}

/** Journal qui ne répète pas la MÊME ligne à chaque tour (un tour, pas un flot). */
function journalDedouble(
  logger: LoggerPromptDuTour | undefined,
  memoire: Map<string, string>,
): LoggerPromptDuTour | undefined {
  if (logger === undefined) return undefined;
  const pousser = (
    nature: "info" | "warn",
    message: string,
    fields?: Record<string, unknown>,
  ): void => {
    const empreinte = `${nature}|${JSON.stringify(fields ?? {})}`;
    if (memoire.get(message) === empreinte) return;
    memoire.set(message, empreinte);
    logger[nature](message, fields);
  };
  return {
    info: (message, fields) => pousser("info", message, fields),
    warn: (message, fields) => pousser("warn", message, fields),
  };
}

/**
 * Construit le port du prompt du tour d'un bot.
 *
 * ⚠️ Toutes les sources sont des FONCTIONS ou des valeurs figées : `lire()` ne
 * garde aucun texte d'un tour sur l'autre, sauf en secours (`derniere`).
 */
export function creerPortPromptDuTour(options: OptionsPortPromptDuTour): PortPromptDuTour {
  const role: RolePromptSysteme = options.role ?? "light";
  const clePrompt = role === "heavy" ? "prompts.heavy" : "prompts.light";
  const memoireJournal = new Map<string, string>();
  const journal = journalDedouble(options.logger, memoireJournal);
  const mentionsSignalees = new Set<string>();
  let derniere: string | undefined;

  /** Personnalité du bot, RÉSOLUE (champ → fichier du bot → fichier d'instance → défaut). */
  const personnalite = (): string => {
    if (options.personnalite !== undefined) return options.personnalite();
    return resoudrePersonnaliteBot({
      botId: options.botId,
      config: options.config,
      ...(options.fichiersPersonnalite !== undefined
        ? { fichiers: candidatsPersonnalite(...options.fichiersPersonnalite) }
        : {}),
      ...(journal !== undefined ? { logger: journal } : {}),
    }).texte;
  };

  /**
   * ⚠️ GARDE DE FOND : un prompt composé ne doit jamais FAIRE CROIRE qu'un bot
   * est un autre. Si la personnalité cite un autre bot du registre, on le DIT
   * (une fois par nom) ; on ne bloque rien et on ne réécrit aucun texte.
   */
  const signalerAutresBots = (texte: string): void => {
    if (journal === undefined) return;
    for (const autre of options.autresBots ?? []) {
      const nom = autre.trim();
      if (nom === "" || mentionsSignalees.has(nom)) continue;
      if (options.nom !== undefined && nom.toLowerCase() === options.nom.trim().toLowerCase()) {
        continue;
      }
      if (!mentionneNom(texte, nom)) continue;
      mentionsSignalees.add(nom);
      journal.warn("personnalite.nom_autre_bot", {
        bot: options.botId,
        autre_bot: nom,
        consequence:
          "la personnalité de ce bot cite le nom d'un AUTRE bot du registre ; le prompt composé le répète donc",
        action:
          "vérifiez que c'est voulu : si ce bot doit parler de lui-même, remplacez ce nom par le sien",
      });
    }
  };

  return {
    derniereLue(): string | undefined {
      return derniere;
    },
    lire(): string {
      try {
        const config = options.config;
        // ⚠️ RELECTURE DISQUE (bornée : le store commun + l'overlay de CE bot).
        // Sans elle, un bot NON-pile garde le cache figé de son démarrage et
        // l'édition de sa personnalité resterait sans effet.
        config?.reload();
        const textePersonnalite = personnalite();
        const prompt = config === undefined ? "" : config.getString(clePrompt);
        const compose = promptDuTour({
          ...(options.nom !== undefined ? { nom: options.nom } : {}),
          personnalite: textePersonnalite,
          prompt,
          ...(options.outils !== undefined ? { outils: options.outils } : {}),
          role,
          voix: options.voix === true,
        });
        if (compose.trim() === "") throw new Error("composition vide");
        signalerAutresBots(textePersonnalite);
        derniere = compose;
        return compose;
      } catch (error) {
        options.logger?.warn("prompt.du_tour.relecture_echec", {
          bot: options.botId,
          role,
          error: error instanceof Error ? error.message : String(error),
          consequence:
            "la DERNIÈRE valeur connue du prompt est conservée : le tour n'est pas interrompu et aucun prompt vide n'est envoyé",
        });
        // ⚠️ Jamais un prompt vide : dernière valeur connue, sinon la valeur
        // initiale du host (celle du démarrage).
        return derniere ?? options.valeurInitiale ?? "";
      }
    },
  };
}
