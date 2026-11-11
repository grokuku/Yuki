/**
 * CONSOLIDATION HEBDOMADAIRE **DE TOUS LES BOTS** (lot 35i) — ORDONNANCÉE.
 *
 * ⚠️ LE PROBLÈME RÉSOLU : depuis le lot 35a, chaque bot a SON `memory.jsonl`
 * (`pathsForBot`). Une seule passe par semaine ne consolidait donc que le bot
 * ACTIF, et lancer une passe par bot en parallèle aurait deux conséquences
 * fâcheuses :
 *   - N passes simultanées sur le même serveur LLM ⇒ N fois plus longues, et la
 *     dernière finirait APRÈS le réveil ;
 *   - aucune mémoire de ce qui a déjà été fait ⇒ un redémarrage en pleine
 *     séquence rejouerait les premiers bots.
 *
 * D'où cet ORDONNANCEUR :
 *  ① **une passe à la fois** (chaque `executerPasse()` est attendu avant de
 *     passer au bot suivant) ;
 *  ② **un curseur PERSISTÉ** (`dernierBotConsolide`) : le prochain cycle
 *     hebdomadaire commence APRÈS lui — jamais deux fois de suite le même bot ;
 *  ③ **reprise au tick suivant** : une séquence interrompue (échec, arrêt) est
 *     reprise pour les bots qui ne sont pas encore faits, sans refaire les
 *     précédents ;
 *  ④ un bot aux **capacités VIDES** ne consolide pas (il ne mémorise rien) et
 *     un bot dont la consolidation est éteinte de SON côté est sauté ;
 *  ⑤ les réglages de PLANIFICATION (cron, fuseau, budget, rétention) restent
 *     d'**INSTANCE** : il n'y a qu'un calendrier, donc qu'un rendez-vous.
 *
 * ⚠️ Aucun `setInterval` nouveau : l'ordonnanceur est appelé par le balayeur
 * EXISTANT (`src/sources/scheduler.ts`, port `passeHebdo`), comme la passe du
 * lot 29.
 *
 * Aucun import SDK/typebox.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

import { parseCron, prochainPassage } from "../sources/cron.js";

import type { RapportConsolidation } from "./consolidation-hebdo.js";
import { RATTRAPAGE_HEBDO_MAX_MS, VERROU_ORPHELIN_MS } from "./consolidation-hebdo.js";
import type { MemoryLogger } from "./types.js";

/** Nom du fichier d'état, sous le volume `state` (état d'INSTANCE). */
export const FICHIER_ETAT_CONSOLIDATION_BOTS = "memory-consolidation-bots.json";

/** Une passe de consolidation (celle d'UN bot). */
export interface PasseConsolidationBot {
  /** Exécute la passe COMPLÈTE du bot (mesure → modèle → application → archive). */
  executerPasse(): Promise<RapportConsolidation>;
}

/** Ce que l'ordonnanceur doit savoir d'un bot pour décider. */
export interface BotConsolidable {
  readonly id: string;
  /**
   * Capacités du bot (`BotRecord.capacites`). ⚠️ `[]` ⇒ le bot ne MÉMORISE
   * rien : sa consolidation est SAUTÉE (aucun appel au modèle lourd).
   */
  readonly capacites: readonly string[];
}

/** Réglages de PLANIFICATION — d'INSTANCE (un seul calendrier). */
export interface ReglagesConsolidationInstance {
  /** `memory.consolidation.enabled` côté instance (le côté bot est par bot). */
  enabled: boolean;
  cron: string;
  fuseau: string;
}

/** Séquence en cours (persistée : elle survit à un redémarrage). */
export interface SequenceConsolidation {
  /** Horodatage ISO du début de la séquence. */
  readonly demarree: string;
  /** Bots de CETTE séquence, dans l'ordre décidé au départ. */
  readonly ordre: readonly string[];
  /** Bots déjà TRAITÉS (succès ou échec) — jamais rejoués dans la séquence. */
  readonly faits: readonly string[];
}

/** État persisté de l'ordonnanceur. */
interface EtatConsolidationBots {
  version: 2;
  prochainPassage?: string;
  dernierPassage?: string;
  /** Dernier bot TRAITÉ (succès ou échec) : le prochain cycle commence après lui. */
  dernierBotConsolide?: string;
  sequence?: SequenceConsolidation;
  enCours?: boolean;
  enCoursDepuis?: string;
}

/** Vue exposée (journal, tests, diagnostic) — jamais un contenu de souvenir. */
export interface EtatConsolidationBotsVue {
  prochainPassage: string | null;
  dernierPassage: string | null;
  dernierBotConsolide: string | null;
  sequence: SequenceConsolidation | null;
  enCours: boolean;
  bots: string[];
}

export interface OptionsConsolidationBots {
  /** Bots connus, dans l'ordre d'affichage du registre (relu à chaque décision). */
  bots: () => readonly BotConsolidable[];
  /**
   * Passe d'UN bot (`undefined` quand elle n'est pas possible : consolidation
   * éteinte pour ce bot, volume illisible…). ⚠️ La fabrique est responsable de
   * la décision PAR BOT ; l'ordonnanceur ne devine rien.
   */
  passeDe: (botId: string) => PasseConsolidationBot | undefined;
  /** Fichier d'état (volume `state`, INSTANCE). */
  statePath: string;
  settings: () => ReglagesConsolidationInstance;
  logger: MemoryLogger;
  now?: () => number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ConsolidationBots {
  private readonly options: OptionsConsolidationBots;
  private readonly logger: MemoryLogger;
  private readonly statePath: string;
  private readonly now: () => number;
  /** Verrou EN MÉMOIRE (le persisté sert à survivre au redémarrage). */
  private enCours = false;
  private derniereSequence: Promise<void> | undefined;

  constructor(options: OptionsConsolidationBots) {
    this.options = options;
    this.logger = options.logger;
    this.statePath = options.statePath;
    this.now = options.now ?? Date.now;
  }

  /** Attend la séquence en cours (tests et arrêt gracieux). */
  async drain(): Promise<void> {
    await this.derniereSequence?.catch(() => undefined);
  }

  /** État courant (diagnostic/tests). */
  etat(): EtatConsolidationBotsVue {
    const etat = this.lireEtat();
    return {
      prochainPassage: etat.prochainPassage ?? null,
      dernierPassage: etat.dernierPassage ?? null,
      dernierBotConsolide: etat.dernierBotConsolide ?? null,
      sequence: etat.sequence ?? null,
      enCours: etat.enCours === true,
      bots: this.options.bots().map((bot) => bot.id),
    };
  }

  /**
   * Appelée par le balayeur à CHAQUE tick (30 s). ⚠️ Ne bloque jamais le
   * balayage : la séquence est longue, et le verrou empêche deux exécutions.
   */
  async executerSiDu(maintenant: number): Promise<void> {
    const reglages = this.options.settings();
    if (!reglages.enabled) return;
    const etat = this.lireEtat();

    if (etat.sequence !== undefined) {
      // ③ REPRISE : une séquence interrompue repart au tick suivant, sans
      // attendre le prochain rendez-vous hebdomadaire.
      if (this.verrouActif(etat)) return;
      this.demarrer(etat);
      await Promise.resolve();
      return;
    }

    let calendrier: ReturnType<typeof parseCron>;
    try {
      calendrier = parseCron(reglages.cron);
    } catch (error) {
      // Expression invalide : on le DIT une fois par tick, jamais un plantage.
      this.logger.warn("memory.consolidation.cron.invalide", {
        cron: reglages.cron,
        error: messageOf(error),
      });
      return;
    }
    const arme = typeof etat.prochainPassage === "string" ? Date.parse(etat.prochainPassage) : NaN;
    if (!Number.isFinite(arme)) {
      this.ecrireEtat({
        ...etat,
        prochainPassage: this.prochain(calendrier, reglages.fuseau, maintenant),
      });
      return;
    }
    if (maintenant < arme) return;
    const retard = maintenant - arme;
    // ⚠️ Réarmement PERSISTÉ AVANT l'exécution : un plantage en pleine séquence
    // ne provoque pas un second tir au redémarrage.
    const suivant = this.prochain(calendrier, reglages.fuseau, maintenant);
    if (retard > RATTRAPAGE_HEBDO_MAX_MS) {
      this.ecrireEtat({
        ...etat,
        ...(suivant ? { prochainPassage: suivant } : {}),
        dernierPassage: new Date(arme).toISOString(),
      });
      this.logger.info("memory.consolidation.multi.saut", {
        raison:
          `passage manqué de ${Math.round(retard / 3_600_000)} h (maximum rattrapable ` +
          `${RATTRAPAGE_HEBDO_MAX_MS / 3_600_000} h) : sauté, le prochain passage est réarmé`,
        prochain: suivant,
      });
      return;
    }
    if (this.verrouActif(etat)) {
      this.logger.info("memory.consolidation.multi.saut", {
        raison: "une séquence de consolidation est déjà en cours (verrou `enCours`)",
      });
      return;
    }
    const ordre = this.ordreSequence(etat.dernierBotConsolide);
    if (ordre.length === 0) {
      // Aucun bot à consolider (aucune capacité, ou aucun store) : on ARME quand
      // même le passage suivant, sinon le calendrier ne redémarrerait jamais.
      this.ecrireEtat({
        ...etat,
        ...(suivant ? { prochainPassage: suivant } : {}),
        dernierPassage: new Date(arme).toISOString(),
      });
      this.logger.info("memory.consolidation.multi.aucun_bot", {
        raison: "aucun bot ne consolide (capacités vides ou consolidation éteinte)",
      });
      return;
    }
    const sequence: SequenceConsolidation = {
      demarree: new Date(this.now()).toISOString(),
      ordre,
      faits: [],
    };
    this.logger.info("memory.consolidation.multi.debut", {
      bots: ordre.length,
      ordre: ordre.join(","),
      depart: ordre[0] ?? null,
    });
    this.demarrer(
      {
        ...etat,
        ...(suivant ? { prochainPassage: suivant } : {}),
        dernierPassage: new Date(arme).toISOString(),
      },
      sequence,
    );
    await Promise.resolve();
  }

  // --- La séquence ---------------------------------------------------------

  /** Démarre (ou reprend) la séquence : une seule à la fois, jamais en parallèle. */
  private demarrer(etat: EtatConsolidationBots, sequence?: SequenceConsolidation): void {
    this.enCours = true;
    this.ecrireEtat({
      ...etat,
      ...(sequence ? { sequence } : {}),
      enCours: true,
      enCoursDepuis: new Date(this.now()).toISOString(),
    });
    this.derniereSequence = this.executerSequence()
      .catch((error: unknown) => {
        this.logger.warn("memory.consolidation.multi.failed", { error: messageOf(error) });
      })
      .finally(() => {
        this.enCours = false;
        const courant = this.lireEtat();
        // ⚠️ Une séquence INACHEVÉE reste persistée : c'est elle qui sera reprise.
        this.ecrireEtat({ ...courant, enCours: false });
      });
  }

  /**
   * Exécute les passes EN SÉRIE. ⚠️ `await` entre chaque bot : c'est la règle
   * « une passe à la fois ». Un ÉCHEC arrête la séquence (le modèle est
   * probablement indisponible) ; les bots déjà faits sont persistés, les autres
   * seront repris au tick suivant.
   *
   * ⚠️ La progression est tenue EN MÉMOIRE pendant la boucle ET persistée à
   * chaque bot : une écriture d'état qui échoue ne fait pas boucler sur le même
   * bot (la boucle avance sur sa copie, le disque garde la trace de ce qu'il a pu
   * écrire).
   */
  private async executerSequence(): Promise<void> {
    const depart = this.lireEtat();
    if (!depart.sequence) return;
    let sequence = depart.sequence;
    for (;;) {
      const prochain = sequence.ordre.find((id) => !sequence.faits.includes(id));
      if (prochain === undefined) {
        this.terminerSequence(sequence);
        return;
      }
      const passe = this.options.passeDe(prochain);
      if (!passe) {
        // Décision PAR BOT (capacités, réglage du bot, store) : on le DIT et on
        // avance — sinon la séquence ne finirait jamais.
        this.logger.info("memory.consolidation.multi.bot_saute", {
          bot: prochain,
          raison: "aucune passe disponible pour ce bot (capacités vides ou consolidation éteinte)",
        });
        sequence = this.noterFait(sequence, prochain);
        continue;
      }
      try {
        const rapport = await passe.executerPasse();
        this.logger.info("memory.consolidation.multi.bot", {
          bot: prochain,
          applique: rapport.applique,
          entrees_avant: rapport.entreesAvant,
          entrees_apres: rapport.entreesApres,
          operations: rapport.operations,
          refus: rapport.refus ?? null,
        });
        sequence = this.noterFait(sequence, prochain);
      } catch (error) {
        // ⚠️ Le bot est NOTÉ (jamais deux fois de suite le même) et la séquence
        // s'arrête ici : la reprise au tick suivant traitera les SUIVANTS.
        this.logger.warn("memory.consolidation.multi.echec", {
          bot: prochain,
          error: messageOf(error),
        });
        this.noterFait(sequence, prochain);
        return;
      }
    }
  }

  /**
   * Note un bot TRAITÉ (succès, saut ou échec), avance le curseur persisté et
   * rend la séquence à jour.
   */
  private noterFait(
    sequence: SequenceConsolidation,
    botId: string,
  ): SequenceConsolidation {
    const faits = sequence.faits.includes(botId)
      ? [...sequence.faits]
      : [...sequence.faits, botId];
    const suivante: SequenceConsolidation = { ...sequence, faits };
    const etat = this.lireEtat();
    this.ecrireEtat({
      ...etat,
      sequence: suivante,
      dernierBotConsolide: botId,
    });
    return suivante;
  }

  /** Fin de séquence : le curseur reste sur le dernier bot traité. */
  private terminerSequence(sequence: SequenceConsolidation): void {
    const etat = this.lireEtat();
    this.ecrireEtat({
      version: 2,
      ...(etat.prochainPassage !== undefined
        ? { prochainPassage: etat.prochainPassage }
        : {}),
      ...(etat.dernierPassage !== undefined ? { dernierPassage: etat.dernierPassage } : {}),
      ...(etat.dernierBotConsolide !== undefined
        ? { dernierBotConsolide: etat.dernierBotConsolide }
        : {}),
    });
    this.logger.info("memory.consolidation.multi.fin", {
      bots: sequence.faits.length,
      dernier: etat.dernierBotConsolide ?? null,
    });
  }

  /**
   * Ordre de la séquence : les candidats, en commençant APRÈS le dernier bot
   * consolidé (jamais deux fois de suite le même bot en tête).
   */
  private ordreSequence(dernierBotConsolide: string | undefined): string[] {
    const candidats = this.options
      .bots()
      .filter((bot) => bot.capacites.length > 0)
      .map((bot) => bot.id);
    if (candidats.length === 0) return [];
    const index = dernierBotConsolide === undefined ? -1 : candidats.indexOf(dernierBotConsolide);
    if (index < 0) return candidats;
    return [...candidats.slice(index + 1), ...candidats.slice(0, index + 1)];
  }

  // --- Calendrier et verrou ------------------------------------------------

  private prochain(
    calendrier: ReturnType<typeof parseCron>,
    fuseau: string,
    depuis: number,
  ): string | undefined {
    try {
      return new Date(prochainPassage(calendrier, depuis, fuseau)).toISOString();
    } catch (error) {
      this.logger.warn("memory.consolidation.cron.aucune_occurrence", {
        fuseau,
        error: messageOf(error),
      });
      return undefined;
    }
  }

  /** Verrou actif ? (mémoire OU persisté et non orphelin) */
  private verrouActif(etat: EtatConsolidationBots): boolean {
    if (this.enCours) return true;
    if (etat.enCours !== true) return false;
    const depuis = typeof etat.enCoursDepuis === "string" ? Date.parse(etat.enCoursDepuis) : NaN;
    if (!Number.isFinite(depuis)) return true;
    if (this.now() - depuis < VERROU_ORPHELIN_MS) return true;
    this.logger.warn("memory.consolidation.multi.verrou.orphelin", {
      en_cours_depuis: etat.enCoursDepuis,
    });
    return false;
  }

  // --- État persisté -------------------------------------------------------

  private lireEtat(): EtatConsolidationBots {
    if (!existsSync(this.statePath)) return { version: 2 };
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.statePath, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { version: 2 };
      }
      const record = parsed as Record<string, unknown>;
      return {
        version: 2,
        ...(typeof record.prochainPassage === "string"
          ? { prochainPassage: record.prochainPassage }
          : {}),
        ...(typeof record.dernierPassage === "string"
          ? { dernierPassage: record.dernierPassage }
          : {}),
        ...(typeof record.dernierBotConsolide === "string"
          ? { dernierBotConsolide: record.dernierBotConsolide }
          : {}),
        ...(estSequence(record.sequence) ? { sequence: record.sequence } : {}),
        ...(record.enCours === true ? { enCours: true } : {}),
        ...(typeof record.enCoursDepuis === "string"
          ? { enCoursDepuis: record.enCoursDepuis }
          : {}),
      };
    } catch (error) {
      this.logger.warn("memory.consolidation.multi.state.read_failed", {
        path: this.statePath,
        error: messageOf(error),
      });
      return { version: 2 };
    }
  }

  private ecrireEtat(etat: EtatConsolidationBots): void {
    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      const tmp = `${this.statePath}.tmp-${randomBytes(4).toString("hex")}`;
      writeFileSync(tmp, `${JSON.stringify(etat, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      renameSync(tmp, this.statePath);
    } catch (error) {
      this.logger.warn("memory.consolidation.multi.state.write_failed", {
        path: this.statePath,
        error: messageOf(error),
      });
    }
  }
}

/** Forme d'une séquence relue du disque (une entrée illisible est IGNORÉE). */
function estSequence(valeur: unknown): valeur is SequenceConsolidation {
  if (typeof valeur !== "object" || valeur === null || Array.isArray(valeur)) return false;
  const record = valeur as Record<string, unknown>;
  if (typeof record.demarree !== "string") return false;
  if (!Array.isArray(record.ordre) || !Array.isArray(record.faits)) return false;
  if (!record.ordre.every((id) => typeof id === "string")) return false;
  if (!record.faits.every((id) => typeof id === "string")) return false;
  return true;
}
