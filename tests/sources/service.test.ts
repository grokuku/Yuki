/**
 * `SourcesService` — CŒUR du chantier : réception authentifiée, idempotence,
 * limite de débit, drain GROUPÉ vers le modèle, réponse attachée à l'entrée,
 * ouverture d'une conversation sur DEMANDE seulement.
 *
 * ⚠️ Module INEXISTANT sur le code d'origine : l'import échoue ⇒ ces tests
 * échouent sur le code d'origine (preuve exigée par la consigne).
 *
 * Le host Pi est un DOUBLE : il compte les `send` et permet de rejouer les
 * événements `delta` / `run_finished` exactement comme le vrai host les émet.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SourcesInbox } from "../../src/sources/inbox.js";
import {
  SourceApiError,
  SourcesService,
  describeWakeFailure,
  tokensMatch,
  type SourcesHostEvent,
  type SourcesWaker,
} from "../../src/sources/service.js";
import { SourcesStore } from "../../src/sources/store.js";
import { sourceTokenName } from "../../src/sources/types.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Double du host Pi : compte les envois et rejoue les événements. */
class FakeWaker implements SourcesWaker {
  readonly sends: Array<{ sessionId: string; text: string; origin?: string }> = [];
  private listeners = new Set<(event: SourcesHostEvent) => void>();
  private sessionId: string | undefined = "session-ouverte";
  /**
   * Conversations EXISTANTES (liste du host). Sert à la vérification « ce fil
   * existe-t-il encore ? » (④) et au sélecteur de destination.
   */
  readonly knownSessions = new Set<string>(["session-ouverte"]);
  /** Fait échouer le prochain `send` (PI_NOT_READY / LLM_UNAVAILABLE). */
  failWith: { code: string } | undefined;
  newSessions = 0;
  resumed: string[] = [];

  currentSessionId(): string | undefined {
    return this.sessionId;
  }

  send(sessionId: string, text: string, opts?: { origin?: string }): { runId: string; sessionId: string } {
    if (this.failWith) {
      const error = Object.assign(new Error(`échec simulé ${this.failWith.code}`), {
        code: this.failWith.code,
      });
      throw error;
    }
    const runId = `run-${this.sends.length + 1}`;
    this.sends.push({ sessionId, text, ...(opts?.origin ? { origin: opts.origin } : {}) });
    return { runId, sessionId };
  }

  subscribeAll(listener: (event: SourcesHostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async newSession(): Promise<{ sessionId: string }> {
    this.newSessions += 1;
    this.sessionId = `session-creee-${this.newSessions}`;
    this.knownSessions.add(this.sessionId);
    return { sessionId: this.sessionId };
  }

  async listSessions(): Promise<Array<{ sessionId: string; title: string }>> {
    return [...this.knownSessions].map((sessionId) => ({ sessionId, title: sessionId }));
  }

  /** Simule un fil DISPARU (supprimé ou mis de côté ailleurs). */
  forgetSession(sessionId: string): void {
    this.knownSessions.delete(sessionId);
    if (this.sessionId === sessionId) this.sessionId = undefined;
  }

  async renameSession(): Promise<void> {
    // Le titre n'a aucune importance pour ces tests.
  }

  async resume(sessionFile: string): Promise<{ sessionId: string }> {
    this.resumed.push(sessionFile);
    this.knownSessions.add(sessionFile);
    // Comme le vrai host : reprendre un fil le FOCALISE.
    this.sessionId = sessionFile;
    return { sessionId: sessionFile };
  }

  async sessionFileFor(id: string): Promise<string | undefined> {
    // Une conversation connue a un fichier ; la valeur EST l'identifiant ici.
    return id;
  }

  emit(event: SourcesHostEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  /** Simule la réponse complète d'un run (deltas puis `run_finished`). */
  reply(runIndex: number, text: string, reason = "done"): void {
    const runId = `run-${runIndex}`;
    const sessionId = "session-ouverte";
    for (const chunk of text.split(" ")) {
      this.emit({ type: "delta", sessionId, runId, channel: "content", text: `${chunk} ` });
    }
    this.emit({ type: "run_finished", sessionId, runId, reason });
  }

  setCurrent(sessionId: string | undefined): void {
    this.sessionId = sessionId;
  }
}

/** Coffre en mémoire (le vrai exige une clé maître). */
class FakeVault {
  readonly entries = new Map<string, string>();
  isConfigured(): boolean {
    return true;
  }
  lookup(name: string): string | undefined {
    return this.entries.get(name);
  }
  has(name: string): boolean {
    return this.entries.has(name);
  }
  set(name: string, value: string): unknown {
    this.entries.set(name, value);
    return { name };
  }
  delete(name: string): boolean {
    return this.entries.delete(name);
  }
}

interface Harness {
  service: SourcesService;
  waker: FakeWaker;
  vault: FakeVault;
  store: SourcesStore;
  inbox: SourcesInbox;
  logs: Array<{ message: string; fields?: Record<string, unknown> }>;
  /** Message complet : crée la source, son jeton, puis pousse un message. */
  push: (
    nom: string,
    body: Record<string, unknown>,
    token?: string,
  ) => Promise<Awaited<ReturnType<SourcesService["receive"]>>>;
}

function harness(options: { now?: () => number; promptTotalChars?: number } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "yuki-sources-service-"));
  dirs.push(dir);
  const store = new SourcesStore({ path: join(dir, "sources.json") });
  const inbox = new SourcesInbox({ path: join(dir, "sources-inbox.json") });
  const waker = new FakeWaker();
  const vault = new FakeVault();
  const logs: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  const logger = {
    info: (message: string, fields?: Record<string, unknown>) => logs.push({ message, ...(fields ? { fields } : {}) }),
    warn: (message: string, fields?: Record<string, unknown>) => logs.push({ message, ...(fields ? { fields } : {}) }),
    error: (message: string, fields?: Record<string, unknown>) => logs.push({ message, ...(fields ? { fields } : {}) }),
  };
  const service = new SourcesService({
    store,
    inbox,
    logger,
    tokens: vault,
    waker,
    promptTotalChars: () => options.promptTotalChars ?? 4_000,
    ...(options.now ? { now: options.now } : {}),
  });
  service.attach();

  const push: Harness["push"] = (nom, body, token) => {
    const secret = token ?? vault.lookup(sourceTokenName(nom)) ?? "";
    return service.receive(nom, secret, body);
  };

  return { service, waker, vault, store, inbox, logs, push };
}

/** Crée la source + son jeton (comme le ferait l'interface `/config`). */
function declare(h: Harness, nom: string, settings: Record<string, unknown> = {}): void {
  h.store.create(nom, settings as never);
  // Chaque source a SON jeton (jamais le même d'une source à l'autre).
  h.vault.set(sourceTokenName(nom), `jeton-secret-${nom}`);
}

describe("SourcesService — authentification par jeton de source", () => {
  it("refuse sans jeton (401) et avec le jeton d'UNE AUTRE source (401)", async () => {
    const h = harness();
    declare(h, "news");
    declare(h, "mail");

    await expect(
      h.service.receive("news", "", { id: "a1", texte: "coucou" }),
    ).rejects.toMatchObject({ status: 401, code: "invalid_token" });

    const autreJeton = h.vault.lookup(sourceTokenName("mail")) as string;
    await expect(
      h.service.receive("news", autreJeton, { id: "a2", texte: "coucou" }),
    ).rejects.toMatchObject({ status: 401, code: "invalid_token" });

    // Aucune entrée n'a été créée par une tentative refusée.
    expect(h.inbox.size).toBe(0);
  });

  it("refuse une source inconnue avec 404 (même avec un jeton valide ailleurs)", async () => {
    const h = harness();
    declare(h, "news");
    const jeton = h.vault.lookup(sourceTokenName("news")) as string;
    await expect(
      h.service.receive("fantome", jeton, { id: "a1", texte: "coucou" }),
    ).rejects.toMatchObject({ status: 404, code: "unknown_source" });
  });

  it("la comparaison de jetons est à TEMPS CONSTANT (tokensMatch)", () => {
    expect(tokensMatch("abc", "abc")).toBe(true);
    expect(tokensMatch("abc", "abd")).toBe(false);
    // Longueurs différentes : aucun court-circuit, même résultat sûr.
    expect(tokensMatch("abc", "abcdef")).toBe(false);
    expect(tokensMatch(undefined, "abc")).toBe(false);
    expect(tokensMatch("", "")).toBe(false);
  });

  it("un message valide est accepté et laisse une entrée NON LUE", async () => {
    const h = harness();
    declare(h, "news", { tour: "stocker" });
    const delivery = await h.push("news", { id: "m1", texte: "Trois articles ce matin.", titre: "Matin" });
    expect(delivery.outcome).toBe("stored");
    expect(delivery.entree?.lu).toBe(false);
    expect(delivery.entree?.etat).toBe("recu");
    expect(delivery.entree?.titre).toBe("Matin");
    expect(h.inbox.unreadCount()).
toBe(1);
    // `stocker` ne déclenche AUCUN tour.
    expect(h.waker.sends).toEqual([]);
  });
});

describe("SourcesService — idempotence (source, id)", () => {
  it("un renvoi du même identifiant rend `duplicate` SANS second tour", async () => {
    const h = harness();
    declare(h, "news", { tour: "lancer", conversation: "courante" });
    const first = await h.push("news", { id: "m1", texte: "bonjour" });
    expect(first.outcome).toBe("started");
    expect(h.waker.sends).toHaveLength(1);

    const second = await h.push("news", { id: "m1", texte: "bonjour" });
    expect(second.outcome).toBe("duplicate");
    expect(second.entree?.id).toBe(first.entree?.id);
    // ⚠️ AUCUN second tour.
    expect(h.waker.sends).toHaveLength(1);
    expect(h.inbox.size).toBe(1);
  });
});

describe("SourcesService — limite de débit (30/min/source)", () => {
  it("le 31e appel de la même source est refusé en 429 avec un délai", async () => {
    let now = Date.parse("2026-05-01T08:00:00.000Z");
    const h = harness({ now: () => now });
    declare(h, "news", { tour: "stocker" });
    for (let index = 0; index < 30; index += 1) {
      await h.push("news", { id: `m${index}`, texte: "x" });
      now += 100;
    }
    await expect(h.push("news", { id: "m30", texte: "x" })).rejects.toMatchObject({
      status: 429,
      code: "rate_limited",
    });
    // Une AUTRE source n'est pas pénalisée.
    declare(h, "mail", { tour: "stocker" });
    await expect(h.push("mail", { id: "m0", texte: "x" })).resolves.toBeDefined();
  });
});

describe("SourcesService — drain GROUPÉ et réponse attachée", () => {
  it("trois entrées en attente ⇒ UN SEUL bloc dans le tour suivant", async () => {
    const h = harness();
    declare(h, "news", { tour: "stocker" });
    await h.push("news", { id: "m1", texte: "premier-article" });
    await h.push("news", { id: "m2", texte: "deuxieme-article" });
    await h.push("news", { id: "m3", texte: "troisieme-article" });
    expect(h.waker.sends).toEqual([]);

    // Le host demande le drain au DÉBUT du tour suivant (un seul run).
    const block = h.service.takePending("run-1");
    expect(block).toBeDefined();
    const text = block as string;
    // UN SEUL bloc (une seule fermeture), et les TROIS entrées dedans.
    expect(text.startsWith("<sources>")).toBe(true);
    expect(text.split("</sources>").length - 1).toBe(1);
    expect(text).toContain("premier-article");
    expect(text).toContain("deuxieme-article");
    expect(text).toContain("troisieme-article");
    // Le drain ne reprend pas ce qui a déjà été remis.
    expect(h.service.takePending("run-2")).toBeUndefined();
  });

  it("la réponse du tour est attachée aux entrées drainées (`traite` + `reponse`)", async () => {
    const h = harness();
    declare(h, "news", { tour: "stocker" });
    await h.push("news", { id: "m1", texte: "premier" });
    await h.push("news", { id: "m2", texte: "second" });
    expect(h.service.takePending("run-1")).toBeDefined();
    // Le host émet la réponse de ce run.
    h.waker.emit({ type: "delta", sessionId: "s", runId: "run-1", channel: "thinking", text: "IGNORÉ" });
    h.waker.reply(1, "Rien d'anormal ce matin.", "done");
    const entries = h.inbox.list();
    expect(entries.every((entry) => entry.etat === "traite")).toBe(true);
    expect(entries.every((entry) => entry.reponse === "Rien d'anormal ce matin.")).toBe(true);
    // ⚠️ La réponse n'est PAS une bulle : elle vit dans l'entrée.
    expect(h.logs.map((log) => log.message)).toContain("sources.run.finished");
  });

  it("un tour en ÉCHEC marque l'entrée `echec` (contenu conservé, aucune relance auto)", async () => {
    const h = harness();
    declare(h, "news", { tour: "stocker" });
    await h.push("news", { id: "m1", texte: "premier" });
    h.service.takePending("run-1");
    h.waker.emit({
      type: "run_finished",
      sessionId: "s",
      runId: "run-1",
      reason: "error",
      errorMessage: "Le fournisseur a renvoyé 429.",
    });
    const [entry] = h.inbox.list();
    expect(entry.etat).toBe("echec");
    // ⚠️ AUCUNE perte : le contenu est intact et la raison est dite.
    expect(entry.texte).toBe("premier");
    expect(entry.raison).toContain("Le tour a échoué : Le fournisseur a renvoyé 429.");
    expect(entry.raison).toContain("aucune relance automatique");
    // Pas de boucle : la même entrée n'est pas réexpédiée au tour suivant.
    expect(entry.enAttente).toBe(false);
    expect(h.service.takePending("run-2")).toBeUndefined();
  });
});

describe("SourcesService — tour `lancer`", () => {
  it("démarre UN tour dans la conversation courante", async () => {
    const h = harness();
    declare(h, "news", { tour: "lancer", conversation: "courante" });
    const delivery = await h.push("news", { id: "m1", texte: "urgent" });
    expect(delivery.outcome).toBe("started");
    expect(delivery.raison).toBeUndefined();
    expect(h.waker.sends).toHaveLength(1);
    expect(h.waker.sends[0].origin).toBe("source");
    expect(h.waker.sends[0].sessionId).toBe("session-ouverte");
    expect(h.waker.sends[0].text).toContain("<contenu>urgent</contenu>");
  });

  it("LLM_UNAVAILABLE ⇒ l'entrée est STOCKÉE avec la raison exacte", async () => {
    const h = harness();
    declare(h, "news", { tour: "lancer", conversation: "courante" });
    h.waker.failWith = { code: "LLM_UNAVAILABLE" };
    const delivery = await h.push("news", { id: "m1", texte: "urgent" });
    expect(delivery.outcome).toBe("stored");
    expect(delivery.raison).toContain("Aucun modèle n'est configuré pour le rôle chat");
    expect(delivery.entree?.enAttente).toBe(true);
    // La raison est PERSISTÉE dans l'entrée, en français (le CODE brut reste
    // dans les journaux, pas dans l'interface).
    const raison = h.inbox.get(delivery.entree?.id as string)?.raison ?? "";
    expect(raison).toContain("Aucun modèle");
    expect(raison).not.toContain("LLM_UNAVAILABLE");
    // Elle sera donc transmise au début du prochain tour.
    expect(h.service.takePending("run-1")).toBeDefined();
  });

  it("PI_NOT_READY ⇒ stocké aussi, avec la raison exacte", async () => {
    const h = harness();
    declare(h, "news", { tour: "lancer", conversation: "courante" });
    h.waker.failWith = { code: "PI_NOT_READY" };
    const delivery = await h.push("news", { id: "m1", texte: "urgent" });
    expect(delivery.outcome).toBe("stored");
    expect(delivery.raison).toContain("host Pi non démarré");
    expect(describeWakeFailure(Object.assign(new Error("x"), { code: "PI_NOT_READY" }))).toContain(
      "host Pi non démarré",
    );
  });

  it("aucune conversation ouverte ⇒ stocké avec la raison (aucun fil créé)", async () => {
    const h = harness();
    declare(h, "news", { tour: "lancer", conversation: "courante" });
    h.waker.setCurrent(undefined);
    const delivery = await h.push("news", { id: "m1", texte: "urgent" });
    expect(delivery.outcome).toBe("stored");
    expect(delivery.raison).toContain("Aucune conversation n'est ouverte");
    expect(h.waker.newSessions).toBe(0);
  });

  it("⚠️ `nouvelle` CRÉE un fil de source par message, VISIBLE dans la liste, et lance", async () => {
    const h = harness();
    declare(h, "news", { tour: "lancer", conversation: "nouvelle" });

    const first = await h.push("news", { id: "m1", texte: "urgent" });
    expect(first.outcome).toBe("started");
    expect(h.waker.newSessions).toBe(1);
    expect(h.waker.sends).toHaveLength(1);
    // ⚠️ Le fil créé est un fil NORMAL : il est LISTÉ (aucun fil caché).
    const created = h.waker.sends[0].sessionId;
    expect(h.waker.knownSessions.has(created)).toBe(true);
    // Le mode `nouvelle` ne mémorise PAS le fil : le message suivant en crée un autre.
    expect(h.store.get("news")?.sessionId).toBeUndefined();
    await h.push("news", { id: "m2", texte: "encore" });
    expect(h.waker.newSessions).toBe(2);
    expect(h.waker.sends[1].sessionId).not.toBe(created);
  });

  it("`source` sans fil dédié CRÉE le fil de la source (visible) et lance dedans", async () => {
    const h = harness();
    declare(h, "news", { tour: "lancer", conversation: "source" });
    const delivery = await h.push("news", { id: "m1", texte: "urgent" });
    expect(delivery.outcome).toBe("started");
    expect(h.waker.newSessions).toBe(1);
    const sessionId = h.store.get("news")?.sessionId;
    expect(sessionId).toBe("session-creee-1");
    // Le fil est MÉMORISÉ (mode `source`) et VISIBLE dans la liste du host.
    expect(h.waker.knownSessions.has(sessionId as string)).toBe(true);
    expect(h.waker.sends[0].sessionId).toBe(sessionId);
    // Le message suivant réutilise CE fil (aucun second fil).
    await h.push("news", { id: "m2", texte: "encore" });
    expect(h.waker.newSessions).toBe(1);
    expect(h.waker.sends[1].sessionId).toBe(sessionId);
  });
});

describe("SourcesService — destination configurée (règles « C » et « A »)", () => {
  it("⚠️ une source sans destination configurée ne crée AUCUN fil et dit quoi faire", async () => {
    const h = harness();
    // `aucune` est l'état d'une source neuve : rien n'a encore été choisi.
    declare(h, "news", { tour: "lancer" });
    const delivery = await h.push("news", { id: "m1", texte: "urgent" });
    // Le message n'est PAS perdu : il attend, avec une raison ACTIONNABLE.
    expect(delivery.outcome).toBe("stored");
    expect(delivery.raison).toContain("n'a pas de destination configurée");
    expect(delivery.raison).toContain("Paramètres → Sources");
    expect(delivery.entree?.enAttente).toBe(true);
    // ⚠️ AUCUN fil créé, AUCUN tour lancé.
    expect(h.waker.newSessions).toBe(0);
    expect(h.waker.sends).toEqual([]);
    // …et l'ENTRÉE de la boîte le dit (pas seulement la réponse HTTP).
    const raison = h.inbox.get(delivery.entree?.id as string)?.raison ?? "";
    expect(raison).toContain("destination configurée");
  });

  it("le FIL DÉSIGNÉ dans la configuration reçoit le tour (jamais le client)", async () => {
    const h = harness();
    declare(h, "news", { tour: "lancer", conversation: "session-42" });
    h.waker.knownSessions.add("session-42");
    const delivery = await h.push("news", { id: "m1", texte: "urgent" });
    expect(delivery.outcome).toBe("started");
    expect(h.waker.sends[0].sessionId).toBe("session-42");
    // Aucun fil créé : la destination existait déjà.
    expect(h.waker.newSessions).toBe(0);
  });

  it("un client extérieur ne peut PAS désigner un fil (400 explicite)", async () => {
    const h = harness();
    declare(h, "news", { tour: "lancer", conversation: "session-42" });
    await expect(
      h.push("news", { id: "m9", texte: "x", conversation: "session-42" }),
    ).rejects.toMatchObject({ status: 400, code: "invalid_conversation" });
    // La tentative refusée n'a créé ni entrée ni tour.
    expect(h.inbox.size).toBe(0);
    expect(h.waker.sends).toEqual([]);
  });

  it("⚠️ le FOCUS de l'utilisateur est RESTAURÉ après la création du fil", async () => {
    const h = harness();
    declare(h, "news", { tour: "lancer", conversation: "source" });
    h.waker.setCurrent("session-ouverte");
    await h.push("news", { id: "m1", texte: "urgent" });
    // `newSession` a créé le fil de la source…
    expect(h.waker.newSessions).toBe(1);
    // …mais l'utilisateur est revenu dans SA conversation (motif `:1527-1537`).
    expect(h.waker.resumed).toContain("session-ouverte");
    expect(h.waker.currentSessionId()).toBe("session-ouverte");
  });
});

describe("SourcesService — ④ le fil visé a disparu ailleurs", () => {
  it("un fil DÉSIGNÉ disparu ⇒ bascule en « nouvelle conversation », motif LISIBLE", async () => {
    const h = harness();
    declare(h, "news", { tour: "lancer", conversation: "session-42" });
    h.waker.forgetSession("session-42");

    const delivery = await h.push("news", { id: "m1", texte: "urgent" });
    // La source a BASCULÉ (persisté) : plus aucune écriture dans le vide.
    expect(h.store.get("news")?.conversation).toBe("nouvelle");
    // Le message n'a pas échoué en silence : il est parti dans un fil NEUF.
    expect(delivery.outcome).toBe("started");
    expect(h.waker.newSessions).toBe(1);
    // …et l'entrée DIT ce qui s'est passé (note conservée même après succès).
    const entry = h.inbox.get(delivery.entree?.id as string);
    expect(entry?.note).toContain("n'existe plus");
    expect(entry?.note).toContain("nouvelle conversation");
  });

  it("un fil DÉDIÉ disparu ⇒ oublié, nouveau fil VISIBLE, motif dans l'entrée", async () => {
    const h = harness();
    declare(h, "news", { tour: "lancer", conversation: "source" });
    await h.push("news", { id: "m1", texte: "premier" });
    const first = h.store.get("news")?.sessionId as string;
    // Le fil est supprimé AILLEURS (autre onglet, autre instance…).
    h.waker.forgetSession(first);

    const delivery = await h.push("news", { id: "m2", texte: "second" });
    expect(delivery.outcome).toBe("started");
    const second = h.store.get("news")?.sessionId as string;
    expect(second).not.toBe(first);
    expect(h.waker.knownSessions.has(second)).toBe(true);
    expect(h.inbox.get(delivery.entree?.id as string)?.note).toContain("n'existe plus");
  });

  it("aucun échec muet : si le host ne sait rien, on n'invente pas de bascule", async () => {
    const h = harness();
    declare(h, "news", { tour: "lancer", conversation: "courante" });
    // Un host qui ne sait NI lister NI retrouver un fichier ne peut pas conclure.
    const blind: SourcesWaker = {
      currentSessionId: () => h.waker.currentSessionId(),
      send: (sessionId, text, opts) => h.waker.send(sessionId, text, opts),
      subscribeAll: (listener) => h.waker.subscribeAll(listener),
      newSession: () => h.waker.newSession(),
      resume: (file) => h.waker.resume(file),
    };
    h.service.setWaker(blind);
    const delivery = await h.push("news", { id: "m1", texte: "urgent" });
    expect(delivery.outcome).toBe("started");
    expect(h.store.get("news")?.conversation).toBe("courante");
  });
});

describe("SourcesService — ③ suppression d'un fil qui reçoit des sources", () => {
  it("liste les sources du fil, puis les RÉAFFECTE (aucune suppression)", async () => {
    const h = harness();
    declare(h, "designee", { tour: "stocker", conversation: "session-42" });
    declare(h, "dediee", { tour: "stocker", conversation: "source" });
    h.store.setSession("dediee", "session-42");
    declare(h, "ailleurs", { tour: "stocker", conversation: "session-99" });

    expect(h.service.sourcesForSession("session-42").sort()).toEqual(["dediee", "designee"]);

    const noms = h.service.detachSession("session-42");
    expect([...noms].sort()).toEqual(["dediee", "designee"]);
    // ⚠️ Les sources EXISTENT toujours, réaffectées, jamais supprimées.
    expect(h.service.get("designee")?.conversation).toBe("nouvelle");
    expect(h.service.get("dediee")?.conversation).toBe("nouvelle");
    // …et la boîte le DIT (une entrée d'alerte par source concernée).
    const alertes = h.inbox.list().filter((entry) => entry.etat === "alerte");
    expect(alertes).toHaveLength(2);
    expect(alertes.map((entry) => entry.source).sort()).toEqual(["dediee", "designee"]);
    for (const alerte of alertes) {
      expect(alerte.texte).toContain("n'a PAS été supprimée");
      expect(alerte.lu).toBe(false);
      // ⚠️ Un avis n'est JAMAIS remis au modèle (aucun drain possible).
      expect(alerte.enAttente).toBe(false);
    }
    expect(h.service.takePending("run-1")).toBeUndefined();
  });
});

describe("SourcesService — ① sélecteur « Envoyer dans : » de /config", () => {
  it("propose les conversations existantes (nom + date), jamais un fil vide", async () => {
    const h = harness();
    h.waker.knownSessions.add("session-b");
    const list = await h.service.conversationList();
    const ids = list.map((entry) => entry.id);
    expect(ids).toContain("session-ouverte");
    expect(ids).toContain("session-b");
    expect(list.every((entry) => entry.titre !== "")).toBe(true);
  });

  it("rend une liste VIDE (sans lever) quand aucun host n'est branché", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yuki-sources-nolist-"));
    dirs.push(dir);
    const service = new SourcesService({
      store: new SourcesStore({ path: join(dir, "sources.json") }),
      inbox: new SourcesInbox({ path: join(dir, "inbox.json") }),
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      promptTotalChars: () => 4_000,
    });
    await expect(service.conversationList()).resolves.toEqual([]);
  });
});

describe("SourcesService — « Continuer dans une conversation » (seul créateur de fil)", () => {
  it("crée UNE conversation au premier clic, la RÉUTILISE au second", async () => {
    const h = harness();
    declare(h, "news", { tour: "stocker" });
    const delivery = await h.push("news", { id: "m1", texte: "à résumer", titre: "Matin" });
    const id = delivery.entree?.id as string;

    const first = await h.service.openConversation(id);
    expect(first.created).toBe(true);
    expect(first.sessionId).toBe("session-creee-1");
    expect(h.waker.newSessions).toBe(1);
    expect(h.store.get("news")?.sessionId).toBe("session-creee-1");
    expect(first.entree.conversationOuverte).toBe(true);
    expect(first.entree.lu).toBe(true);

    // Second clic : AUCUNE nouvelle conversation.
    const second = await h.service.openConversation(id);
    expect(second.created).toBe(false);
    expect(second.sessionId).toBe("session-creee-1");
    expect(h.waker.newSessions).toBe(1);
  });

  it("refuse une entrée inconnue (404) et une source disparue (404)", async () => {
    const h = harness();
    declare(h, "news", { tour: "stocker" });
    const delivery = await h.push("news", { id: "m1", texte: "x" });
    await expect(h.service.openConversation("inconnue")).rejects.toMatchObject({
      status: 404,
      code: "unknown_entry",
    });
    h.store.remove("news");
    await expect(
      h.service.openConversation(delivery.entree?.id as string),
    ).rejects.toMatchObject({ status: 404, code: "unknown_source" });
  });
});

describe("SourcesService — notification de l'appareil (`notifier`)", () => {
  it("notifie quand la source le demande, sans recopier le contenu", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yuki-sources-notify-"));
    dirs.push(dir);
    const store = new SourcesStore({ path: join(dir, "sources.json") });
    const inbox = new SourcesInbox({ path: join(dir, "sources-inbox.json") });
    const vault = new FakeVault();
    const waker = new FakeWaker();
    const notified: Array<{ source: string; titre: string }> = [];
    const service = new SourcesService({
      store,
      inbox,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      tokens: vault,
      waker,
      promptTotalChars: () => 4_000,
      notify: (event) => notified.push({ source: event.source, titre: event.titre }),
    });
    service.attach();
    store.create("mail", { tour: "stocker", notifier: true });
    vault.set(sourceTokenName("mail"), "jeton-mail");

    await service.receive("mail", "jeton-mail", {
      id: "n1",
      texte: "CONTENU-JAMAIS-NOTIFIE",
      titre: "Nouveau message",
    });
    expect(notified).toHaveLength(1);
    expect(notified[0].source).toBe("mail");
    expect(notified[0].titre).toBe("Nouveau message");
    expect(JSON.stringify(notified)).not.toContain("CONTENU-JAMAIS-NOTIFIE");

    // `notifier: false` ⇒ aucune notification.
    store.update("mail", { notifier: false });
    await service.receive("mail", "jeton-mail", { id: "n2", texte: "autre" });
    expect(notified).toHaveLength(1);
  });
});

describe("SourcesService — journal d'audit (aucun contenu)", () => {
  it("journalise source + identifiant + état, jamais le contenu ni le jeton", async () => {
    const h = harness();
    declare(h, "news", { tour: "lancer", conversation: "courante" });
    await h.push("news", { id: "m1", texte: "CONTENU-CONFIDENTIEL-42" });
    const serialized = JSON.stringify(h.logs);
    expect(serialized).not.toContain("CONTENU-CONFIDENTIEL-42");
    expect(serialized).not.toContain("jeton-secret-news");
    expect(h.logs.map((log) => log.message)).toContain("sources.message.started");
  });

  it("une tentative non autorisée est journalisée sans le jeton fourni", async () => {
    const h = harness();
    declare(h, "news");
    await expect(
      h.service.receive("news", "mauvais-jeton-1234", { id: "m1", texte: "x" }),
    ).rejects.toBeInstanceOf(SourceApiError);
    const serialized = JSON.stringify(h.logs);
    expect(serialized).not.toContain("mauvais-jeton-1234");
    expect(h.logs.map((log) => log.message)).toContain("sources.message.unauthorized");
  });
});

describe("SourcesService — gestion et jetons", () => {
  it("le jeton n'est rendu qu'à la création et n'est jamais relu par la liste", () => {
    const h = harness();
    h.store.create("news");
    const token = h.service.createToken("news");
    expect(token.length).toBeGreaterThan(20);
    expect(h.vault.lookup(sourceTokenName("news"))).toBe(token);
    const [view] = h.service.list();
    expect(view.jetonDefini).toBe(true);
    expect(JSON.stringify(view)).not.toContain(token);
    expect(h.store.get("news")?.jetonCree).toBeDefined();
  });

  it("refuse de créer un jeton sans coffre disponible (503 explicite)", () => {
    const dir = mkdtempSync(join(tmpdir(), "yuki-sources-novault-"));
    dirs.push(dir);
    const store = new SourcesStore({ path: join(dir, "sources.json") });
    store.create("news");
    const service = new SourcesService({
      store,
      inbox: new SourcesInbox({ path: join(dir, "inbox.json") }),
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      promptTotalChars: () => 4_000,
    });
    expect(() => service.createToken("news")).toThrow(/Coffre de secrets indisponible/);
  });

  it("supprimer une source retire aussi son jeton du coffre", () => {
    const h = harness();
    declare(h, "news");
    expect(h.service.remove("news")).toBe(true);
    expect(h.vault.has(sourceTokenName("news"))).toBe(false);
    expect(h.service.remove("news")).toBe(false);
  });
});
