/**
 * RÉCURRENCES + GESTION DES TÂCHES PAR LE MODÈLE (2026-11-22).
 *
 * ⚠️ TROIS DEMANDES UTILISATEUR, DANS SES MOTS :
 *   « - ajoute des tâches récurrentes » ;
 *   « - fait en sorte que le LLM puisse modifier/supprimer des tâches ».
 *
 * ⚠️ CE QUE CES TESTS PROUVENT :
 *  ① `planifier_tache(recurrence: …)` crée un DÉCLENCHEUR DURABLE (`planning` + cron +
 *    fuseau) — le MÉCANISME EXISTANT, pas un second ordonnanceur — et il SE DÉCLENCHE
 *    réellement (horloge simulée, aucune attente) ;
 *  ② le quota des 20 déclencheurs durables s'applique, avec un refus NOMMÉ ;
 *  ③ `lister_taches` / `modifier_tache` / `supprimer_tache` ne voient QUE les tâches du
 *    bot demandeur : un id d'un AUTRE bot est un refus nommé, jamais une action ;
 *  ④ `modifier_tache` d'une récurrence INVALIDE le compteur de passages et recalcule le
 *    prochain passage ;
 *  ⑤ une étape de CHAÎNE n'est ni modifiée ni supprimée par le modèle ;
 *  ⑥ aucune description d'outil, aucun prompt livré, aucune UI ne promet plus un
 *    « horizon 30 jours » (garde statique : la limite a été retirée le même jour).
 *
 * ⚠️ Ils ÉCHOUENT tous sur l'origine : `recurrence`, `lister_taches`, `modifier_tache` et
 * `supprimer_tache` n'existaient pas.
 */

import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createPlanifierTacheTools } from "../../src/pi/sdk/planifier-tache-tool.js";
import { SourcesInbox } from "../../src/sources/inbox.js";
import { DeclencheurJournal, type DeclencheurJournalRecord } from "../../src/sources/journal.js";
import { SourcesParBotError, type SourcesParBot } from "../../src/sources/par-bot.js";
import { portPlanificationPourBot } from "../../src/sources/ports-bot.js";
import { DeclencheurBalayeur } from "../../src/sources/scheduler.js";
import {
  ORIGINE_HORLOGE,
  SourcesService,
  type SourcesHostEvent,
  type SourcesWaker,
} from "../../src/sources/service.js";
import { SourcesStore } from "../../src/sources/store.js";
import { MAX_SOURCES } from "../../src/sources/types.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-recurrences-"));
  dirs.push(dir);
  return dir;
}

/** 4 novembre 2026, 17 h 00 à Paris (= 16 h UTC). */
const T0 = Date.parse("2026-11-04T16:00:00Z");

// ── Doubles ────────────────────────────────────────────────────────────────

class FakeWaker implements SourcesWaker {
  readonly sends: Array<{ sessionId: string; text: string }> = [];
  readonly knownSessions = new Set<string>(["session-du-bot"]);
  newSessions = 0;
  private readonly listeners = new Set<(event: SourcesHostEvent) => void>();
  private sessionId: string | undefined = "session-du-bot";

  currentSessionId(): string | undefined {
    return this.sessionId;
  }

  send(sessionId: string, text: string): { runId: string; sessionId: string } {
    this.sends.push({ sessionId, text });
    return { runId: `run-${this.sends.length}`, sessionId };
  }

  subscribeAll(listener: (event: SourcesHostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async newSession(): Promise<{ sessionId: string }> {
    this.newSessions += 1;
    return { sessionId: `session-creee-${this.newSessions}` };
  }

  async listSessions(): Promise<Array<{ sessionId: string; title: string }>> {
    return [...this.knownSessions].map((sessionId) => ({ sessionId, title: sessionId }));
  }

  async resume(file: string): Promise<{ sessionId: string }> {
    return { sessionId: file };
  }

  async sessionFileFor(id: string): Promise<string | undefined> {
    return this.knownSessions.has(id) ? id : undefined;
  }
}

class FakeJobs {
  readonly demandes: Array<{ task: string; lightSessionId: string }> = [];

  async delegate(request: { task: string; lightSessionId: string }): Promise<{
    status: string;
    job_id: string;
  }> {
    this.demandes.push({ task: request.task, lightSessionId: request.lightSessionId });
    return { status: "dispatched", job_id: `job-${this.demandes.length}` };
  }

  cancelJob(jobId: string): { status: string; job_id: string } {
    return { status: "cancelled", job_id: jobId };
  }
}

class FakePublication {
  readonly publies: Array<{ sessionId: string; texte: string }> = [];

  async publier(sessionId: string, texte: string): Promise<void> {
    this.publies.push({ sessionId, texte });
  }
}

interface PileBot {
  store: SourcesStore;
  service: SourcesService;
  waker: FakeWaker;
  jobs: FakeJobs;
  publication: FakePublication;
  journal: DeclencheurJournal;
  balayeur: DeclencheurBalayeur;
  avancer: (ms: number) => void;
  maintenant: () => number;
  evenements: () => DeclencheurJournalRecord[];
}

/** Une PILE complète par bot (son `sources.json`, son journal, son service). */
function pileBot(botId: string): PileBot {
  const dir = tmpDir();
  const store = new SourcesStore({ path: join(dir, `${botId}-sources.json`), now: () => maintenant });
  const inbox = new SourcesInbox({ path: join(dir, `${botId}-inbox.json`), now: () => maintenant });
  const journal = DeclencheurJournal.open({ path: join(dir, `${botId}-journal.jsonl`) });
  const waker = new FakeWaker();
  const jobs = new FakeJobs();
  const publication = new FakePublication();
  const logger = { info: () => {}, warn: () => {}, error: () => {} };
  const service = new SourcesService({
    store,
    inbox,
    journal,
    logger,
    waker,
    jobs,
    publication,
    promptTotalChars: () => 4_000,
    now: () => maintenant,
  });
  service.attach();
  const balayeur = new DeclencheurBalayeur({
    store,
    journal,
    logger,
    now: () => maintenant,
    run: (nom, opts) =>
      service.declencher(nom, {
        origine: ORIGINE_HORLOGE,
        ...(opts.planifie !== undefined ? { planifie: opts.planifie } : {}),
        plafondMs: opts.plafondMs,
        signal: opts.signal,
        ...(opts.desarmementPrealable === true ? { desarmementPrealable: true } : {}),
      }),
  });
  return {
    store,
    service,
    waker,
    jobs,
    publication,
    journal,
    balayeur,
    avancer: (ms) => {
      maintenant += ms;
    },
    maintenant: () => maintenant,
    evenements: () => journal.recent(100),
  };
}

let maintenant = T0;

type AnyTool = {
  name: string;
  description: string;
  execute: (...args: unknown[]) => Promise<{
    content: Array<{ type: string; text?: string }>;
    details?: unknown;
  }>;
};

/** Les QUATRE outils, construits par le PORT RÉEL par bot (`ports-bot.ts`). */
function outilsDuBot(piles: Record<string, PileBot>, botId: string, session: string): AnyTool[] {
  const parBot = {
    pourBot: (id: string) => {
      const pile = piles[id];
      if (pile === undefined) {
        throw new SourcesParBotError("bot_inconnu", `Bot inconnu : « ${id} ».`);
      }
      return { service: pile.service };
    },
  } as unknown as SourcesParBot;
  const port = portPlanificationPourBot(parBot, botId);
  return createPlanifierTacheTools(port, {
    conversation: () => ({ session }),
  }) as unknown as AnyTool[];
}

function outil(tools: AnyTool[], nom: string): AnyTool {
  const trouve = tools.find((tool) => tool.name === nom);
  if (trouve === undefined) throw new Error(`outil « ${nom} » non construit`);
  return trouve;
}

function texte(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((part) => part.text ?? "").join("\n");
}

async function souffler(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  maintenant = T0;
});

// ── ① RÉCURRENCE créée par le modèle ────────────────────────────────────────

describe("② le modèle crée une RÉCURRENCE — un déclencheur durable, pas un second mécanisme", () => {
  it("⚠️ « tous les jours à 8 h » ⇒ un déclencheur `planning` avec le cron attendu", async () => {
    const pile = pileBot("yuki");
    const tools = outilsDuBot({ yuki: pile }, "yuki", "session-du-bot");
    const result = await outil(tools, "planifier_tache").execute("call", {
      recurrence: { type: "tous_les_jours", heure: "08:00" },
      instruction: "résume le journal",
      nom: "Résumé du matin",
    });
    expect(texte(result)).toContain("Récurrence");
    expect(texte(result)).toContain("tous les jours à 08:00");

    const record = pile.store.list()[0];
    expect(record).toBeDefined();
    expect(record?.declencheur).toEqual({
      type: "planning",
      expression: "0 8 * * *",
      fuseau: "Europe/Paris",
    });
    // ⚠️ MARQUEUR de tâche du modèle : c'est lui qui borne les trois outils de gestion.
    expect(record?.origineTache).toBe("modele");
    expect(record?.perso).toBe(true);
    expect(record?.consigne).toBe("résume le journal");
    expect(record?.libelle).toBe("Résumé du matin");
    // ⚠️ MÊME quota que l'interface : une récurrence est un DÉCLENCHEUR DURABLE.
    expect(pile.store.sourcesDurables).toBe(1);
    expect(pile.store.tachesPonctuelles).toBe(0);
  });

  it("⚠️ la récurrence SE DÉCLENCHE réellement (horloge simulée) et publie dans la conversation demandeuse", async () => {
    const pile = pileBot("yuki");
    const tools = outilsDuBot({ yuki: pile }, "yuki", "session-du-bot");
    await outil(tools, "planifier_tache").execute("call", {
      recurrence: { type: "tous_les_jours", heure: "08:00" },
      instruction: "résume le journal",
      nom: "Résumé du matin",
    });
    const nom = pile.store.list()[0]?.nom as string;

    // Armer (le balayeur calcule le prochain passage, aucun tir).
    await pile.balayeur.tick();
    expect(pile.jobs.demandes).toHaveLength(0);
    expect(pile.store.get(nom)?.prochainPassage).toBe("2026-11-05T07:00:00.000Z");

    // 5 novembre, 8 h 00 à Paris : le passage est dû.
    pile.avancer(Date.parse("2026-11-05T07:00:01Z") - T0);
    await pile.balayeur.tick();
    expect(pile.jobs.demandes).toHaveLength(1);
    // ⚠️ Le worker reçoit l'INSTRUCTION (pas un texte figé) …
    expect(pile.jobs.demandes[0]?.task).toContain("résume le journal");
    // … et la CIBLE est la conversation demandeuse (pas le fil « Déclencheurs »).
    expect(pile.jobs.demandes[0]?.lightSessionId).toBe("session-du-bot");

    // Le résultat est publié LÀ où la demande a été faite.
    await pile.service.recevoirResultat({
      id: "job-1",
      status: "completed",
      result: { text: "Journal : rien d'urgent." },
    });
    await souffler();
    expect(pile.publication.publies).toEqual([
      { sessionId: "session-du-bot", texte: "Journal : rien d'urgent." },
    ]);
    // Et la récurrence reste ARMÉE pour le lendemain (ce n'est pas une ponctuelle).
    expect(pile.store.get(nom)?.actif).not.toBe(false);
    expect(pile.store.get(nom)?.occurrencesFaites).toBe(1);
  });

  it("les QUATRE formes sont acceptées, et `quand` + `recurrence` est REFUSÉ", async () => {
    const pile = pileBot("yuki");
    const tools = outilsDuBot({ yuki: pile }, "yuki", "session-du-bot");
    const planifier = outil(tools, "planifier_tache");
    for (const recurrence of [
      { type: "tous_les_jours", heure: "08:00" },
      { type: "chaque_semaine", jour: "lundi", heure: "09:00" },
      { type: "toutes_les_heures", heures: 6 },
      { type: "tous_les_mois", jourDuMois: 1, heure: "10:00" },
    ]) {
      const ok = await planifier.execute("call", { recurrence, instruction: "fais un truc" });
      expect(texte(ok)).toContain("Récurrence");
    }
    const expressions = pile.store.list().map((record) => {
      const declencheur = record.declencheur;
      return declencheur.type === "planning" ? declencheur.expression : "?";
    });
    expect(expressions).toEqual(["0 8 * * *", "0 9 * * 1", "0 0,6,12,18 * * *", "0 10 1 * *"]);

    const melange = await planifier.execute("call", {
      quand: "demain à 8 h",
      recurrence: { type: "tous_les_jours", heure: "08:00" },
      instruction: "fais un truc",
    });
    expect(texte(melange)).toContain("EXCLUSIFS");
    expect(pile.store.list()).toHaveLength(4);
  });

  it("⚠️ la 21ᵉ source durable est REFUSÉE en le disant (borne de l'interface, pas une nouvelle)", async () => {
    const pile = pileBot("yuki");
    const tools = outilsDuBot({ yuki: pile }, "yuki", "session-du-bot");
    for (let index = 0; index < MAX_SOURCES; index += 1) {
      const ok = await outil(tools, "planifier_tache").execute("call", {
        recurrence: { type: "tous_les_jours", heure: "08:00" },
        instruction: `tâche ${index}`,
      });
      expect(texte(ok)).toContain("Récurrence");
    }
    const refus = await outil(tools, "planifier_tache").execute("call", {
      recurrence: { type: "tous_les_jours", heure: "08:00" },
      instruction: "une de trop",
    });
    const message = texte(refus);
    expect(message).toContain(String(MAX_SOURCES));
    expect(message).toMatch(/maximal|maximum/u);
    expect(pile.store.list()).toHaveLength(MAX_SOURCES);
  });
});

// ── ③ GESTION : lister / modifier / supprimer ───────────────────────────────

describe("③ lister_taches / modifier_tache / supprimer_tache — le périmètre du BOT", () => {
  async function semer(pile: PileBot, nom = "Résumé du matin"): Promise<string> {
    const tools = outilsDuBot({ yuki: pile }, "yuki", "session-du-bot");
    await outil(tools, "planifier_tache").execute("call", {
      recurrence: { type: "tous_les_jours", heure: "08:00" },
      instruction: "résume le journal",
      nom,
    });
    return pile.store.list()[0]?.nom as string;
  }

  it("⚠️ `lister_taches` ne rend QUE les tâches de SON bot (jamais celles d'un autre)", async () => {
    const pileA = pileBot("yuki");
    const pileB = pileBot("grolaf");
    const nomA = await semer(pileA);
    const nomB = await semer(pileB, "Résumé du soir");
    // ⚠️ Deux fichiers DIFFÉRENTS (`state/bots/<id>/sources.json`) : même mécanisme,
    // aucun partage.
    expect(nomA).not.toBe(nomB);

    const piles = { yuki: pileA, grolaf: pileB };
    const listeA = await outil(outilsDuBot(piles, "yuki", "session-du-bot"), "lister_taches").execute(
      "call",
      {},
    );
    const listeB = await outil(
      outilsDuBot(piles, "grolaf", "session-du-bot"),
      "lister_taches",
    ).execute("call", {});

    // Chaque bot ne voit QUE la sienne : un seul enregistrement, dans son `sources.json`.
    expect(texte(listeA)).toContain("1 tâche(s)");
    expect(texte(listeB)).toContain("1 tâche(s)");
    expect(pileA.store.list()).toHaveLength(1);
    expect(pileB.store.list()).toHaveLength(1);
    expect(pileA.store.get(nomA)?.consigne).toBe(pileB.store.get(nomB)?.consigne);
  });

  it("⚠️ `supprimer_tache` et `modifier_tache` d'une tâche d'un AUTRE bot sont REFUSÉS", async () => {
    const pileA = pileBot("yuki");
    const pileB = pileBot("grolaf");
    const nomA = await semer(pileA);
    await semer(pileB, "Résumé du soir");
    const piles = { yuki: pileA, grolaf: pileB };
    const toolsB = outilsDuBot(piles, "grolaf", "session-du-bot");

    const suppression = await outil(toolsB, "supprimer_tache").execute("call", { id: nomA });
    expect(texte(suppression)).toContain("aucune tâche");
    expect(texte(suppression)).toContain(nomA);
    // ⚠️ La tâche de A est INTACTE : aucun repli sur le `sources.json` d'un autre bot.
    expect(pileA.store.get(nomA)?.declencheur).toBeDefined();

    const modification = await outil(toolsB, "modifier_tache").execute("call", {
      id: nomA,
      instruction: "détournée",
    });
    expect(texte(modification)).toContain("aucune tâche");
    expect(pileA.store.get(nomA)?.consigne).toBe("résume le journal");
  });

  it("un id INCONNU est un refus NOMMÉ (jamais un « c'est fait »)", async () => {
    const pile = pileBot("yuki");
    const tools = outilsDuBot({ yuki: pile }, "yuki", "session-du-bot");
    for (const nom of ["supprimer_tache", "modifier_tache"]) {
      const result = await outil(tools, nom).execute("call", {
        id: "tache-qui-nexiste-pas",
        instruction: "peu importe",
      });
      const message = texte(result);
      expect(message).toContain("tache-qui-nexiste-pas");
      expect(message).toContain("lister_taches");
      expect(message.startsWith("Rien n'a été fait")).toBe(true);
    }
  });

  it("⚠️ `modifier_tache` d'une récurrence INVALIDE le compteur et recalcule le prochain passage", async () => {
    const pile = pileBot("yuki");
    const nom = await semer(pile);
    // Le compteur a déjà des passages (chemin RÉEL : `incrementerOccurrence`), et un
    // prochain passage armé.
    for (let tour = 0; tour < 4; tour += 1) pile.store.incrementerOccurrence(nom);
    pile.store.markPlanification(nom, { prochainPassage: "2026-11-05T07:00:00.000Z" });
    expect(pile.store.get(nom)?.occurrencesFaites).toBe(4);

    const tools = outilsDuBot({ yuki: pile }, "yuki", "session-du-bot");
    const result = await outil(tools, "modifier_tache").execute("call", {
      id: nom,
      recurrence: { type: "chaque_semaine", jour: "mardi", heure: "18:30" },
      instruction: "résume la semaine",
    });
    const message = texte(result);
    expect(message).toContain("modifiée");
    expect(message).toContain("compteur");

    const apres = pile.store.get(nom);
    // ⚠️ Le compteur décrit l'ANCIEN programme : il est effacé.
    expect(apres?.occurrencesFaites).toBeUndefined();
    // ⚠️ Le prochain passage est RECALCULÉ par le balayeur depuis le nouveau cron.
    expect(apres?.prochainPassage).toBeUndefined();
    expect(apres?.declencheur).toEqual({
      type: "planning",
      expression: "30 18 * * 2",
      fuseau: "Europe/Paris",
    });
    expect(apres?.consigne).toBe("résume la semaine");

    await pile.balayeur.tick();
    // 4 novembre 2026 est un mercredi ⇒ prochain mardi 18 h 30 (17 h 30 UTC).
    expect(pile.store.get(nom)?.prochainPassage).toBe("2026-11-10T17:30:00.000Z");
  });

  it("`modifier_tache` d'une PONCTUELLE change la date, et refuse « quand » sur une récurrence", async () => {
    const pile = pileBot("yuki");
    const tools = outilsDuBot({ yuki: pile }, "yuki", "session-du-bot");
    await outil(tools, "planifier_tache").execute("call", {
      quand: "demain à 9 h",
      instruction: "vérifie le disque",
      nom: "Vérif disque",
    });
    const nom = pile.store.list()[0]?.nom as string;
    const modifie = await outil(tools, "modifier_tache").execute("call", {
      id: nom,
      quand: "dans 2 heures",
    });
    expect(texte(modifie)).toContain("modifiée");
    expect(pile.store.get(nom)?.declencheur).toEqual({
      type: "ponctuel",
      a: "2026-11-04T18:00:00.000Z",
      fuseau: "Europe/Paris",
    });

    // Une récurrence ne se déplace pas avec un instant unique : le refus le dit.
    await outil(tools, "planifier_tache").execute("call", {
      recurrence: { type: "tous_les_jours", heure: "08:00" },
      instruction: "résume",
    });
    const recurrente = pile.store
      .list()
      .find((record) => record.declencheur.type === "planning")?.nom as string;
    const refus = await outil(tools, "modifier_tache").execute("call", {
      id: recurrente,
      quand: "dans 3 heures",
    });
    expect(texte(refus)).toContain("RÉCURRENCE");
    expect(texte(refus)).toContain("recurrence");
  });

  it("`supprimer_tache` supprime VRAIMENT, et le journal du bot le garde", async () => {
    const pile = pileBot("yuki");
    const nom = await semer(pile);
    const tools = outilsDuBot({ yuki: pile }, "yuki", "session-du-bot");
    const result = await outil(tools, "supprimer_tache").execute("call", { id: nom });
    expect(texte(result)).toContain("supprimée définitivement");
    expect(pile.store.get(nom)).toBeUndefined();
    expect(pile.store.list()).toHaveLength(0);
    // ⚠️ Une suppression laisse une trace : `tache_supprimee` dans le journal DU BOT.
    expect(pile.evenements().some((evenement) => evenement.event === "tache_supprimee")).toBe(
      true,
    );
  });

  it("⚠️ une ÉTAPE de CHAÎNE n'est jamais supprimée ni modifiée par le modèle", () => {
    const dir = tmpDir();
    const store = new SourcesStore({ path: join(dir, "sources.json") });
    const [etape] = store.createChaine({
      id: "chaine-1",
      etapes: [
        {
          libelle: "Veille",
          consigne: "surveille",
          declencheur: { type: "planning", expression: "0 8 * * *", fuseau: "Europe/Paris" },
        },
        {
          libelle: "Rapport",
          consigne: "rapporte",
          declencheur: { type: "planning", expression: "0 9 * * *", fuseau: "Europe/Paris" },
        },
      ],
    });
    // ⚠️ Même en marquant l'étape comme tâche du modèle, la règle tient : une chaîne se
    // supprime EN ENTIER (sinon les étapes suivantes resteraient orphelines).
    store.update(etape?.nom as string, { origineTache: "modele" });
    const service = new SourcesService({
      store,
      inbox: new SourcesInbox({ path: join(dir, "inbox.json") }),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      promptTotalChars: () => 4_000,
    });
    const suppression = service.supprimerTache(etape?.nom as string);
    expect(suppression.ok).toBe(false);
    if (!suppression.ok) {
      expect(suppression.raison).toContain("ÉTAPE de chaîne");
      expect(suppression.raison).toContain("Configuration → Déclencheurs");
    }
    const modification = service.modifierTache({ id: etape?.nom as string, instruction: "x" });
    expect(modification.ok).toBe(false);
    // ⚠️ Rien n'a bougé : les deux étapes sont toujours là.
    expect(store.list()).toHaveLength(2);
  });
});

// ── ⑥ Gardes STATIQUES : plus aucune promesse d'horizon ─────────────────────

describe("⑥ gardes statiques — aucun « horizon 30 jours » ne subsiste", () => {
  const outils = () => {
    const pile = pileBot("yuki");
    return outilsDuBot({ yuki: pile }, "yuki", "session-du-bot");
  };

  it("aucune DESCRIPTION d'outil ne mentionne « 30 jours » ni « horizon »", () => {
    for (const tool of outils()) {
      expect(tool.description).not.toMatch(/30\s*jours/iu);
      expect(tool.description).not.toMatch(/horizon/iu);
    }
    // Et la description DIT la récurrence (sinon le modèle ne l'utiliserait jamais).
    expect(outil(outils(), "planifier_tache").description).toContain("recurrence");
  });

  it("le PROMPT SYSTÈME livré ne parle plus d'horizon de 30 jours", () => {
    const prompt = readFileSync(join(process.cwd(), "config/pi/system-prompt.md"), "utf8");
    expect(prompt).not.toMatch(/30\s*jours/i);
    expect(prompt).not.toMatch(/horizon/i);
    // ⚠️ Et il annonce les nouveaux outils (sinon le modèle ne les chercherait pas).
    for (const nom of ["lister_taches", "modifier_tache", "supprimer_tache"]) {
      expect(prompt).toContain(nom);
    }
  });

  it("l'UI des envois programmés n'affiche plus « horizon 30 jours »", () => {
    for (const fichier of ["public/ui/declencheurs-vue.js", "public/ui/sources-panel.js"]) {
      const source = readFileSync(join(process.cwd(), fichier), "utf8");
      expect(source).not.toMatch(/horizon\s*\d+\s*jours/i);
      expect(source).not.toContain("horizonJours");
    }
  });
});
