/**
 * LOT 35i — CONSOLIDATION HEBDOMADAIRE × N BOTS, **ORDONNANCÉE**.
 *
 * ⚠️ Ces tests ÉCHOUENT sur le code d'origine : `src/memory/consolidation-multi.ts`
 * n'existait pas (`git show HEAD:src/memory/index.ts`) et le port `passeHebdo`
 * n'appelait QUE la passe du bot actif.
 *
 * Ce qui est prouvé :
 *  ① UNE SEULE passe à la fois (jamais deux bots en vol) ;
 *  ② CURSEUR PERSISTÉ : le prochain cycle commence APRÈS le dernier bot
 *    consolidé, et le fichier d'état le porte sur le disque ;
 *  ③ REPRISE après échec au tick suivant, sans refaire les bots déjà faits ;
 *  ④ jamais deux fois de suite le même bot ;
 *  ⑤ un bot aux CAPACITÉS VIDES est sauté (aucun appel au modèle) ;
 *  ⑥ les réglages de planification restent d'INSTANCE (un seul calendrier) :
 *    désactivée ⇒ aucune passe ; hors échéance ⇒ aucune passe ; rattrapage.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ConsolidationBots,
  FICHIER_ETAT_CONSOLIDATION_BOTS,
  type BotConsolidable,
  type RapportConsolidation,
} from "../../src/memory/index.js";

const dossiers: string[] = [];

afterEach(() => {
  for (const dossier of dossiers.splice(0)) rmSync(dossier, { recursive: true, force: true });
});

interface Journal {
  infos: Array<{ message: string; fields?: Record<string, unknown> }>;
  warns: Array<{ message: string; fields?: Record<string, unknown> }>;
}

function journal(): Journal & {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  debug(message: string, fields?: Record<string, unknown>): void;
} {
  const infos: Journal["infos"] = [];
  const warns: Journal["warns"] = [];
  return {
    infos,
    warns,
    info: (message, fields) => {
      infos.push({ message, ...(fields ? { fields } : {}) });
    },
    warn: (message, fields) => {
      warns.push({ message, ...(fields ? { fields } : {}) });
    },
    error: () => undefined,
    debug: () => undefined,
  };
}

function dossier(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-consolidation-bots-"));
  dossiers.push(dir);
  return dir;
}

/** Rapport minimal : l'ordonnanceur ne lit que quelques champs. */
function rapportVide(): RapportConsolidation {
  return {
    at: "2026-11-10T00:00:00.000Z",
    dureeMs: 1,
    fuseau: "Europe/Paris",
    cron: "0 3 * * 0",
    mesure: {
      entrees: 0,
      caracteres: 0,
      octetsFichier: 0,
      tokensEstimes: 0,
      hypothese: "test",
      contexteModele: 0,
      margeSortie: 0,
      promptFixe: 0,
      budgetTokens: 0,
      budgetCaracteres: 0,
      lots: 1,
      pourcentContexte: 0,
      nonExaminees: 0,
      plafondEntrees: 0,
    },
    entrees: 0,
    caracteres: 0,
    tokensEstimes: 0,
    contexteModele: 0,
    budgetTokens: 0,
    lots: 1,
    pourcentContexte: 0,
    nonExaminees: 0,
    entreesAvant: 0,
    entreesApres: 0,
    operations: 0,
    parOperation: {
      garder: 0,
      fusionner: 0,
      corriger: 0,
      supprimer: 0,
      signaler: 0,
    },
    suppressions: 0,
    signalements: 0,
    applique: false,
  };
}

interface Banc {
  statePath: string;
  journal: ReturnType<typeof journal>;
  bot: (id: string, capacites?: readonly string[]) => BotConsolidable;
  /** Bots vus par l'ordonnanceur (relus à chaque décision). */
  bots: BotConsolidable[];
  /** Appels RÉELLEMENT démarrés, dans l'ordre. */
  appels: string[];
  /** Nombre maximal de passes SIMULTANÉES observées. */
  enVol: number;
  maxEnVol: number;
  service: (options?: {
    enabled?: boolean;
    echec?: (botId: string) => boolean;
    passeIndisponible?: (botId: string) => boolean;
    now?: () => number;
    avant?: (botId: string) => Promise<void>;
  }) => ConsolidationBots;
}

function banc(bots: BotConsolidable[]): Banc {
  const dir = dossier();
  const b: Banc = {
    statePath: join(dir, FICHIER_ETAT_CONSOLIDATION_BOTS),
    journal: journal(),
    bot: (id, capacites = ["memoire"]) => ({ id, capacites }),
    bots,
    appels: [],
    enVol: 0,
    maxEnVol: 0,
    service: (options = {}) =>
      new ConsolidationBots({
        bots: () => b.bots,
        passeDe: (botId) => {
          if (options.passeIndisponible?.(botId)) return undefined;
          return {
            executerPasse: async (): Promise<RapportConsolidation> => {
              b.appels.push(botId);
              b.enVol += 1;
              b.maxEnVol = Math.max(b.maxEnVol, b.enVol);
              try {
                if (options.avant) await options.avant(botId);
                await Promise.resolve();
                if (options.echec?.(botId)) throw new Error(`panne de ${botId}`);
                return rapportVide();
              } finally {
                b.enVol -= 1;
              }
            },
          };
        },
        statePath: b.statePath,
        settings: () => ({
          enabled: options.enabled ?? true,
          cron: "0 3 * * 0",
          fuseau: "Europe/Paris",
        }),
        logger: b.journal,
        ...(options.now ? { now: options.now } : {}),
      }),
  };
  return b;
}

/** Écrit l'état persisté (armement dû, curseur éventuel). */
function ecrireEtat(
  statePath: string,
  etat: {
    prochainPassage?: string;
    dernierBotConsolide?: string;
    sequence?: { demarree: string; ordre: string[]; faits: string[] };
    enCours?: boolean;
    enCoursDepuis?: string;
  },
): void {
  writeFileSync(statePath, `${JSON.stringify({ version: 2, ...etat }, null, 2)}\n`, "utf8");
}

function lireEtat(statePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
}

const MAINTENANT = Date.parse("2026-11-10T12:00:00.000Z");
const DU = new Date(MAINTENANT - 60_000).toISOString();

describe("① une seule passe à la fois", () => {
  it("les passes des bots sont SÉRIELLES (jamais deux en vol)", async () => {
    const b = banc([banc_bot("yuki"), banc_bot("kohai"), banc_bot("nova")]);
    ecrireEtat(b.statePath, { prochainPassage: DU });
    const service = b.service({
      avant: async () => {
        await new Promise((suite) => setTimeout(suite, 5));
      },
    });
    await service.executerSiDu(MAINTENANT);
    await service.drain();
    expect(b.appels).toEqual(["yuki", "kohai", "nova"]);
    expect(b.maxEnVol).toBe(1);
  });

  it("un tick PENDANT la séquence ne démarre pas une seconde séquence", async () => {
    const b = banc([banc_bot("yuki"), banc_bot("kohai")]);
    ecrireEtat(b.statePath, { prochainPassage: DU });
    let liberer = (): void => undefined;
    const barriere = new Promise<void>((suite) => {
      liberer = () => suite();
    });
    const service = b.service({ avant: () => barriere });
    await service.executerSiDu(MAINTENANT);
    // Plusieurs ticks pendant que la 1re passe est bloquée.
    await service.executerSiDu(MAINTENANT + 1_000);
    await service.executerSiDu(MAINTENANT + 2_000);
    expect(b.appels).toEqual(["yuki"]);
    expect(b.maxEnVol).toBe(1);
    liberer();
    await service.drain();
    expect(b.appels).toEqual(["yuki", "kohai"]);
  });
});

describe("② curseur persisté", () => {
  it("la séquence complète laisse le curseur sur le dernier bot, SUR LE DISQUE", async () => {
    const b = banc([banc_bot("yuki"), banc_bot("kohai"), banc_bot("nova")]);
    ecrireEtat(b.statePath, { prochainPassage: DU });
    const service = b.service();
    await service.executerSiDu(MAINTENANT);
    await service.drain();
    expect(b.appels).toEqual(["yuki", "kohai", "nova"]);
    const etat = lireEtat(b.statePath);
    expect(etat.dernierBotConsolide).toBe("nova");
    // Séquence terminée : plus rien à reprendre, verrou relâché.
    expect(etat.sequence).toBe(undefined);
    expect(etat.enCours).toBe(false);
    // Le prochain passage est ARMÉ (un seul calendrier, celui de l'instance).
    expect(typeof etat.prochainPassage).toBe("string");
    expect(String(etat.prochainPassage)).toBe("2026-11-15T02:00:00.000Z");
  });

  it("le cycle suivant commence APRÈS le dernier bot consolidé (jamais le même en tête)", async () => {
    const b = banc([banc_bot("yuki"), banc_bot("kohai"), banc_bot("nova")]);
    ecrireEtat(b.statePath, { prochainPassage: DU, dernierBotConsolide: "yuki" });
    const service = b.service();
    await service.executerSiDu(MAINTENANT);
    await service.drain();
    expect(b.appels).toEqual(["kohai", "nova", "yuki"]);
  });
});

describe("③④ reprise après échec, jamais deux fois le même bot", () => {
  it("un échec arrête la séquence ; le tick suivant reprend aux bots SUIVANTS", async () => {
    const b = banc([banc_bot("yuki"), banc_bot("kohai"), banc_bot("nova")]);
    ecrireEtat(b.statePath, { prochainPassage: DU });
    const enEchec = new Set(["kohai"]);
    const service = b.service({ echec: (botId) => enEchec.has(botId) });
    await service.executerSiDu(MAINTENANT);
    await service.drain();
    // `kohai` échoue ⇒ `nova` n'est PAS lancé dans la même séquence.
    expect(b.appels).toEqual(["yuki", "kohai"]);
    const apresEchec = lireEtat(b.statePath);
    expect(apresEchec.dernierBotConsolide).toBe("kohai");
    expect(apresEchec.sequence).toMatchObject({ faits: ["yuki", "kohai"] });
    expect(
      b.journal.warns.some((entree) => entree.message === "memory.consolidation.multi.echec"),
    ).toBe(true);

    // ⚠️ REPRISE au tick SUIVANT, sans attendre le prochain rendez-vous :
    // `yuki` et `kohai` ne sont pas rejoués (jamais deux fois le même bot).
    enEchec.clear();
    b.appels.length = 0;
    await service.executerSiDu(MAINTENANT + 30_000);
    await service.drain();
    expect(b.appels).toEqual(["nova"]);
    const fin = lireEtat(b.statePath);
    expect(fin.dernierBotConsolide).toBe("nova");
    expect(fin.sequence).toBe(undefined);
  });

  it("une séquence interrompue par un redémarrage est REPRISE depuis le disque", async () => {
    const b = banc([banc_bot("yuki"), banc_bot("kohai"), banc_bot("nova")]);
    // Verrou PERSISTÉ encore FRAIS : un autre processus peut travailler, on
    // n'écrit rien (le verrou orphelin a son propre délai, `VERROU_ORPHELIN_MS`).
    ecrireEtat(b.statePath, {
      dernierBotConsolide: "yuki",
      sequence: {
        demarree: new Date(MAINTENANT - 60_000).toISOString(),
        ordre: ["yuki", "kohai", "nova"],
        faits: ["yuki"],
      },
      enCours: true,
      enCoursDepuis: new Date(MAINTENANT - 60_000).toISOString(),
    });
    const service = b.service({ now: () => MAINTENANT });
    // Le calendrier n'est PAS dû : seule la reprise pourrait déclencher des passes.
    await service.executerSiDu(MAINTENANT);
    await service.drain();
    expect(b.appels).toEqual([]);

    // Verrou ORPHELIN (processus tué il y a plus de 6 h) : la séquence reprend
    // aux bots qui ne sont pas faits, SANS refaire `yuki`.
    ecrireEtat(b.statePath, {
      dernierBotConsolide: "yuki",
      sequence: {
        demarree: new Date(MAINTENANT - 7 * 3_600_000).toISOString(),
        ordre: ["yuki", "kohai", "nova"],
        faits: ["yuki"],
      },
      enCours: true,
      enCoursDepuis: new Date(MAINTENANT - 7 * 3_600_000).toISOString(),
    });
    await service.executerSiDu(MAINTENANT);
    await service.drain();
    expect(b.appels).toEqual(["kohai", "nova"]);
    expect(lireEtat(b.statePath).sequence).toBe(undefined);
    expect(
      b.journal.warns.some(
        (entree) => entree.message === "memory.consolidation.multi.verrou.orphelin",
      ),
    ).toBe(true);
  });
});

describe("⑤ un bot aux capacités VIDES ne consolide pas", () => {
  it("sauté sans aucun appel au modèle", async () => {
    const b = banc([
      { id: "yuki", capacites: [] },
      { id: "kohai", capacites: ["memoire"] },
    ]);
    ecrireEtat(b.statePath, { prochainPassage: DU });
    const service = b.service();
    await service.executerSiDu(MAINTENANT);
    await service.drain();
    expect(b.appels).toEqual(["kohai"]);
    expect(lireEtat(b.statePath).dernierBotConsolide).toBe("kohai");
  });

  it("tous les bots sans capacité ⇒ aucun appel, le passage suivant est ARMÉ", async () => {
    const b = banc([{ id: "yuki", capacites: [] }]);
    ecrireEtat(b.statePath, { prochainPassage: DU });
    const service = b.service();
    await service.executerSiDu(MAINTENANT);
    await service.drain();
    expect(b.appels).toEqual([]);
    expect(typeof lireEtat(b.statePath).prochainPassage).toBe("string");
    expect(
      b.journal.infos.some((entree) => entree.message === "memory.consolidation.multi.aucun_bot"),
    ).toBe(true);
  });

  it("un bot sans passe disponible (consolidation éteinte POUR LUI) est sauté et DIT", async () => {
    const b = banc([banc_bot("yuki"), banc_bot("kohai")]);
    ecrireEtat(b.statePath, { prochainPassage: DU });
    const service = b.service({ passeIndisponible: (botId) => botId === "kohai" });
    await service.executerSiDu(MAINTENANT);
    await service.drain();
    expect(b.appels).toEqual(["yuki"]);
    const saut = b.journal.infos.find(
      (entree) => entree.message === "memory.consolidation.multi.bot_saute",
    );
    expect(saut?.fields?.bot).toBe("kohai");
    // La séquence se termine : plus rien à reprendre.
    expect(lireEtat(b.statePath).sequence).toBe(undefined);
  });
});

describe("⑥ réglages d'INSTANCE : un seul calendrier", () => {
  it("désactivée ⇒ aucune passe, même à l'échéance", async () => {
    const b = banc([banc_bot("yuki"), banc_bot("kohai")]);
    ecrireEtat(b.statePath, { prochainPassage: DU });
    const service = b.service({ enabled: false });
    await service.executerSiDu(MAINTENANT);
    await service.drain();
    expect(b.appels).toEqual([]);
  });

  it("hors échéance ⇒ aucune passe ; à l'échéance ⇒ passages dans l'ordre du registre", async () => {
    const b = banc([banc_bot("yuki"), banc_bot("kohai")]);
    const service = b.service();
    // Premier tick : rien n'est armé, on arme seulement.
    await service.executerSiDu(MAINTENANT);
    await service.drain();
    expect(b.appels).toEqual([]);
    const arme = lireEtat(b.statePath).prochainPassage;
    expect(arme).toBe("2026-11-15T02:00:00.000Z");

    // Avant l'échéance : toujours rien.
    await service.executerSiDu(Date.parse(String(arme)) - 1_000);
    await service.drain();
    expect(b.appels).toEqual([]);

    // À l'échéance : les deux bots.
    await service.executerSiDu(Date.parse(String(arme)));
    await service.drain();
    expect(b.appels).toEqual(["yuki", "kohai"]);
  });

  it("un retard de plus de 24 h est SAUTÉ et journalisé (jamais une passe surprise)", async () => {
    const b = banc([banc_bot("yuki")]);
    ecrireEtat(b.statePath, {
      prochainPassage: new Date(MAINTENANT - 30 * 3_600_000).toISOString(),
    });
    const service = b.service();
    await service.executerSiDu(MAINTENANT);
    await service.drain();
    expect(b.appels).toEqual([]);
    const saut = b.journal.infos.find(
      (entree) => entree.message === "memory.consolidation.multi.saut",
    );
    expect(String(saut?.fields?.raison)).toContain("sauté");
  });
});

/** Petit raccourci lisible dans les tableaux de bots. */
function banc_bot(id: string): BotConsolidable {
  return { id, capacites: ["memoire"] };
}
