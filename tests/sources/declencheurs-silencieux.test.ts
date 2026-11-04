/**
 * DÉCLENCHEURS SILENCIEUX (lot 26 — « sortie silencieuse »).
 *
 * ⚠️ Ces tests ÉCHOUENT sur le code d'origine : `visibilite`, le fil unique
 * « Déclencheurs », le journal et la pastille d'échecs n'existent pas avant ce
 * lot (voir la preuve dans `/tmp`, `git show HEAD:<f>`).
 *
 * Ce qui est verrouillé ici :
 *  - une réponse `RIEN` ⇒ AUCUNE publication, AUCUNE notification, AUCUNE bulle,
 *    et un événement `silence` dans le journal ;
 *  - une vraie réponse ⇒ publiée dans l'UNIQUE fil « Déclencheurs », et le
 *    contenu REÇU n'apparaît nulle part ;
 *  - le fil n'existe pas tant qu'aucun résultat n'a été produit ;
 *  - un fil supprimé est RECRÉÉ au résultat suivant (aucune sortie perdue) ;
 *  - `notifier: true` + silencieux ⇒ aucun Web Push ;
 *  - la pastille ne compte PLUS les réceptions, seulement les échecs et alertes.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SourcesInbox } from "../../src/sources/inbox.js";
import {
  DeclencheurJournal,
  MAX_JOURNAL_CONTENT_CHARS,
  type DeclencheurJournalRecord,
} from "../../src/sources/journal.js";
import {
  SourcesService,
  type SourcesHostEvent,
  type SourcesWaker,
} from "../../src/sources/service.js";
import { SourcesStore } from "../../src/sources/store.js";
import {
  DECLENCHEURS_SESSION_TITLE,
  SOURCE_RATE_LIMIT_PER_MINUTE,
  sourceTokenName,
} from "../../src/sources/types.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Double du host Pi : enregistre les envois, les renommages et les suppressions. */
class FakeWaker implements SourcesWaker {
  readonly sends: Array<{ sessionId: string; text: string; origin?: string }> = [];
  readonly renamed: Array<{ sessionId: string; titre: string }> = [];
  readonly deleted: string[] = [];
  readonly knownSessions = new Set<string>(["session-ouverte"]);
  newSessions = 0;
  private listeners = new Set<(event: SourcesHostEvent) => void>();
  private sessionId: string | undefined = "session-ouverte";
  /** Fil courant de chaque run : `runId → sessionId`. */
  private readonly runSessions = new Map<string, string>();

  currentSessionId(): string | undefined {
    return this.sessionId;
  }

  send(sessionId: string, text: string, opts?: { origin?: string }): { runId: string; sessionId: string } {
    const runId = `run-${this.sends.length + 1}`;
    this.sends.push({ sessionId, text, ...(opts?.origin ? { origin: opts.origin } : {}) });
    this.runSessions.set(runId, sessionId);
    return { runId, sessionId };
  }

  subscribeAll(listener: (event: SourcesHostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async newSession(): Promise<{ sessionId: string }> {
    this.newSessions += 1;
    const id = `session-creee-${this.newSessions}`;
    this.sessionId = id;
    this.knownSessions.add(id);
    return { sessionId: id };
  }

  async listSessions(): Promise<Array<{ sessionId: string; title: string }>> {
    return [...this.knownSessions].map((sessionId) => ({ sessionId, title: sessionId }));
  }

  async renameSession(id: string, title: string): Promise<void> {
    this.renamed.push({ sessionId: id, titre: title });
  }

  async resume(file: string): Promise<{ sessionId: string }> {
    this.knownSessions.add(file);
    this.sessionId = file;
    return { sessionId: file };
  }

  async sessionFileFor(id: string): Promise<string | undefined> {
    return id;
  }

  async deleteSession(id: string): Promise<void> {
    this.deleted.push(id);
    this.knownSessions.delete(id);
  }

  /** Simule l'utilisateur qui supprime une conversation. */
  forgetSession(id: string): void {
    this.knownSessions.delete(id);
    if (this.sessionId === id) this.sessionId = undefined;
  }

  /** Rejoue la réponse complète d'un run (deltas `content` puis `run_finished`). */
  reply(runIndex: number, text: string, reason = "done"): void {
    const runId = `run-${runIndex}`;
    const sessionId = this.runSessions.get(runId) ?? "session-inconnue";
    for (const chunk of text.split(" ")) {
      this.emit({ type: "delta", sessionId, runId, channel: "content", text: `${chunk} ` });
    }
    this.emit({ type: "run_finished", sessionId, runId, reason });
  }

  emit(event: SourcesHostEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

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
  store: SourcesStore;
  inbox: SourcesInbox;
  journal: DeclencheurJournal;
  journalPath: string;
  notifications: Array<{ source: string; titre: string }>;
  push: (nom: string, body: Record<string, unknown>) => Promise<Awaited<ReturnType<SourcesService["receive"]>>>;
  events: () => DeclencheurJournalRecord[];
}

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "yuki-declencheurs-"));
  dirs.push(dir);
  const store = new SourcesStore({ path: join(dir, "sources.json") });
  const inbox = new SourcesInbox({ path: join(dir, "sources-inbox.json") });
  const journalPath = join(dir, "declencheurs-journal.jsonl");
  const journal = DeclencheurJournal.open({ path: journalPath });
  const waker = new FakeWaker();
  const vault = new FakeVault();
  const notifications: Array<{ source: string; titre: string }> = [];
  const logger = { info: () => {}, warn: () => {}, error: () => {} };
  const service = new SourcesService({
    store,
    inbox,
    journal,
    logger,
    tokens: vault,
    waker,
    promptTotalChars: () => 4_000,
    notify: (event) => notifications.push({ source: event.source, titre: event.titre }),
  });
  service.attach();

  return {
    service,
    waker,
    store,
    inbox,
    journal,
    journalPath,
    notifications,
    push: (nom, body) => service.receive(nom, vault.lookup(sourceTokenName(nom)) ?? "", body),
    events: () => journal.recent(50),
  };
}

/** Déclare un déclencheur SILENCIEUX (le défaut du modèle v2). */
function declareSilencieux(h: Harness, nom: string, settings: Record<string, unknown> = {}): void {
  h.store.create(nom, { visibilite: "silencieux", ...settings } as never);
  (h.service as unknown as { tokens?: FakeVault }).tokens?.set(sourceTokenName(nom), `jeton-${nom}`);
}

describe("Déclencheur silencieux — la réponse `RIEN` ne publie RIEN", () => {
  it("aucune publication, aucune notification, aucune bulle ; journal `silence`", async () => {
    const h = harness();
    declareSilencieux(h, "veille");

    const delivery = await h.push("veille", { id: "m1", texte: "3 articles ce matin" });
    // Un tour a bien démarré (dans un fil candidat), mais AUCUNE entrée de boîte.
    expect(delivery.outcome).toBe("started");
    expect(h.inbox.size).toBe(0);
    expect(h.notifications).toEqual([]);
    expect(h.waker.sends).toHaveLength(1);
    // ⚠️ Origine SYNTHÉTIQUE : le contenu reçu ne produit aucune bulle.
    expect(h.waker.sends[0].origin).toBe("source");
    // Le bloc porte le rappel de silence.
    expect(h.waker.sends[0].text).toContain("RIEN");

    h.waker.reply(1, "RIEN");

    // Rien n'est publié : aucun fil « Déclencheurs » mémorisé…
    expect(h.store.getDeclencheursSession()).toBeUndefined();
    // …et il n'a même pas été renommé (aucun fil vide ne doit apparaître).
    expect(h.waker.renamed).toEqual([]);
    // Le fil candidat est SUPPRIMÉ (il n'a servi qu'à faire tourner le modèle).
    expect(h.waker.deleted).toEqual(["session-creee-1"]);
    expect(h.waker.knownSessions.has("session-creee-1")).toBe(false);
    // Aucune notification, aucune entrée : le contenu reçu n'existe QUE au journal.
    expect(h.notifications).toEqual([]);
    expect(h.inbox.size).toBe(0);
    const events = h.events().map((event) => event.event);
    expect(events).toContain("recu");
    expect(events).toContain("silence");
    expect(events).not.toContain("publie");
  });

  it("normalise la réponse : « `rien.` » et « Rien ! » comptent aussi comme silence", async () => {
    const h = harness();
    declareSilencieux(h, "veille");
    await h.push("veille", { id: "m1", texte: "rien à signaler" });
    h.waker.reply(1, "`Rien.`");
    expect(h.store.getDeclencheursSession()).toBeUndefined();
    expect(h.events().some((event) => event.event === "silence")).toBe(true);
  });

  it("un tour échoué journalise `echec` et ne publie rien", async () => {
    const h = harness();
    declareSilencieux(h, "veille");
    await h.push("veille", { id: "m1", texte: "x" });
    h.waker.reply(1, "", "error");
    expect(h.store.getDeclencheursSession()).toBeUndefined();
    const echec = h.events().find((event) => event.event === "echec");
    expect(echec?.raison).toBeTruthy();
  });
});

describe("Déclencheur silencieux — un RÉSULTAT est publié dans le fil « Déclencheurs »", () => {
  it("le fil est créé et nommé au premier résultat, le contenu reçu reste invisible", async () => {
    const h = harness();
    declareSilencieux(h, "veille");

    await h.push("veille", { id: "m1", texte: "3 articles ce matin", titre: "Matin" });
    h.waker.reply(1, "Alerte : la CI est rouge.");

    // Le fil UNIQUE est mémorisé et nommé.
    expect(h.store.getDeclencheursSession()).toBe("session-creee-1");
    expect(h.waker.renamed).toEqual([
      { sessionId: "session-creee-1", titre: DECLENCHEURS_SESSION_TITLE },
    ]);
    // Le résultat est journalisé (événement `publie`), borné.
    const publie = h.events().find((event) => event.event === "publie");
    expect(publie?.texte).toContain("CI est rouge");
    expect(publie?.sessionId).toBe("session-creee-1");
    // ⚠️ Le contenu REÇU n'apparaît ni dans la boîte, ni en notification.
    expect(h.inbox.size).toBe(0);
    expect(h.notifications).toEqual([]);
  });

  it("le fil n'existe pas tant qu'aucun résultat n'a été produit", async () => {
    const h = harness();
    declareSilencieux(h, "veille");
    expect(h.store.getDeclencheursSession()).toBeUndefined();
    await h.push("veille", { id: "m1", texte: "x" });
    // Pendant le tour, le fil n'est PAS encore « Déclencheurs ».
    expect(h.store.getDeclencheursSession()).toBeUndefined();
    h.waker.reply(1, "RIEN");
    expect(h.store.getDeclencheursSession()).toBeUndefined();
    expect(h.waker.renamed).toEqual([]);
  });

  it("un fil supprimé par l'utilisateur est RECRÉÉ au résultat suivant", async () => {
    const h = harness();
    declareSilencieux(h, "veille");

    await h.push("veille", { id: "m1", texte: "premier" });
    h.waker.reply(1, "Résultat 1");
    const premier = h.store.getDeclencheursSession();
    expect(premier).toBe("session-creee-1");

    // L'utilisateur supprime le fil.
    h.waker.forgetSession(premier as string);

    await h.push("veille", { id: "m2", texte: "second" });
    h.waker.reply(2, "Résultat 2");

    const second = h.store.getDeclencheursSession();
    expect(second).toBeDefined();
    expect(second).not.toBe(premier);
    expect(h.waker.renamed.at(-1)).toEqual({
      sessionId: second,
      titre: DECLENCHEURS_SESSION_TITLE,
    });
    // Aucune sortie perdue : le second résultat est journalisé.
    const publies = h.events().filter((event) => event.event === "publie");
    expect(publies).toHaveLength(2);
  });

  it("les messages suivants réutilisent le MÊME fil (un seul fil partagé)", async () => {
    const h = harness();
    declareSilencieux(h, "veille");
    await h.push("veille", { id: "m1", texte: "premier" });
    h.waker.reply(1, "Résultat 1");
    await h.push("veille", { id: "m2", texte: "second" });
    expect(h.waker.sends[1].sessionId).toBe("session-creee-1");
    // Pas de second renommage : le fil est déjà « Déclencheurs ».
    expect(h.waker.renamed).toHaveLength(1);
  });
});

describe("Déclencheur silencieux — notifications et pastille", () => {
  it("`notifier: true` + silencieux ⇒ aucun Web Push (et le réglage est forcé à false)", async () => {
    const h = harness();
    declareSilencieux(h, "veille", { notifier: true });
    expect(h.store.get("veille")?.notifier).toBe(false);

    // Le message porte lui aussi `notifier: true` : il ne doit RIEN déclencher.
    await h.push("veille", { id: "m1", texte: "x", notifier: true });
    h.waker.reply(1, "Résultat");
    expect(h.notifications).toEqual([]);
  });

  it("la pastille ne compte plus les réceptions, seulement les échecs et alertes", async () => {
    const h = harness();
    // Une source VISIBLE qui stocke : elle crée une entrée `recu`.
    h.store.create("visible", { visibilite: "visible", tour: "stocker", destination: "aucune" } as never);
    (h.service as unknown as { tokens?: FakeVault }).tokens?.set(
      sourceTokenName("visible"),
      "jeton-visible",
    );
    await h.push("visible", { id: "v1", texte: "news" });
    expect(h.inbox.size).toBe(1);
    // ⚠️ Une réception NE fait PAS monter la pastille.
    expect(h.service.inboxView().nonLus).toBe(0);

    const entry = h.inbox.list()[0];
    h.inbox.update(entry.id, { etat: "echec", raison: "tour échoué" });
    expect(h.service.inboxView().nonLus).toBe(1);

    // Une ALERTE compte aussi ; un déclencheur silencieux n'ajoute jamais rien.
    declareSilencieux(h, "veille");
    await h.push("veille", { id: "m1", texte: "x" });
    h.inbox.add({ source: "veille", texte: "avis", titre: "Alerte", octets: 4, enAttente: false, etat: "alerte" });
    expect(h.service.inboxView().nonLus).toBe(2);
  });

  it("l'idempotence `(source, id)` vaut aussi en silencieux (aucun second tour)", async () => {
    const h = harness();
    declareSilencieux(h, "veille");
    await h.push("veille", { id: "m1", texte: "x" });
    const second = await h.push("veille", { id: "m1", texte: "x" });
    expect(second.outcome).toBe("duplicate");
    expect(h.waker.sends).toHaveLength(1);
  });

  it("journalise `recu` avec la taille réelle et le contenu BORNÉ", async () => {
    const h = harness();
    declareSilencieux(h, "veille");
    const texte = "a".repeat(MAX_JOURNAL_CONTENT_CHARS + 500);
    await h.push("veille", { id: "m1", texte });
    const recu = h.events().find((event) => event.event === "recu");
    expect(recu?.octets).toBe(Buffer.byteLength(texte, "utf8"));
    expect(recu?.texte?.length).toBe(MAX_JOURNAL_CONTENT_CHARS);
    expect(recu?.tronque).toBe(true);
    // La limite de débit reste celle des sources (aucune régression).
    expect(SOURCE_RATE_LIMIT_PER_MINUTE).toBeGreaterThan(0);
  });
});
