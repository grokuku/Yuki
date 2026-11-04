/**
 * LOT 26 / 3 — ce que la PAGE DE GESTION lit côté serveur.
 *
 * ⚠️ Ces tests ÉCHOUENT sur le code d'origine :
 *  - `jetonsCumules` et `desactiveLe` n'existent pas dans `SourceRecord`
 *    (`git show HEAD:src/sources/types.ts`) ;
 *  - `DeclencheurJournal.recent` n'accepte AUCUN filtre et l'événement
 *    `preautorisation` n'existe pas (`git show HEAD:src/sources/journal.ts`) ;
 *  - `GET /api/sources/journal` n'accepte ni `type` ni `source`, et la liste des
 *    sources ne porte aucun `dernierEvenement`
 *    (`git show HEAD:src/gateway/routes/sources.ts`).
 *
 * Ce qui est verrouillé :
 *  - le cumul des JETONS d'un déclencheur (jamais une estimation) ;
 *  - la DATE de mise en veille, effacée à la réactivation ;
 *  - le filtre du journal appliqué AVANT la borne (sinon « aucun échec » ment) ;
 *  - le filtre de route : type, source, type INCONNU → 400 explicite ;
 *  - le `dernierEvenement` par source (colonne « dernier résultat »).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { handleSourcesRequest } from "../../src/gateway/routes/sources.js";
import { DeclencheurJournal } from "../../src/sources/journal.js";
import { SourcesInbox } from "../../src/sources/inbox.js";
import { SourcesService, type SourcesHostEvent, type SourcesWaker } from "../../src/sources/service.js";
import { SourcesStore } from "../../src/sources/store.js";

const dirs: string[] = [];
const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const GARDE = { "x-yuki-config": "1" };

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-declencheurs-gestion-"));
  dirs.push(dir);
  return dir;
}

/** Waker minimal : ces tests ne déclenchent aucun tour de conversation. */
class WakerSilencieux implements SourcesWaker {
  currentSessionId(): string | undefined {
    return "session-1";
  }
  send(_sessionId: string, _text: string): { runId: string; sessionId: string } {
    return { runId: "run-1", sessionId: "session-1" };
  }
  subscribeAll(_listener: (event: SourcesHostEvent) => void): () => void {
    return () => undefined;
  }
  async newSession(): Promise<{ sessionId: string }> {
    return { sessionId: "session-1" };
  }
  async resume(file: string): Promise<{ sessionId: string }> {
    return { sessionId: file };
  }
}

function makeStore(now?: () => number) {
  const dir = makeDir();
  const path = join(dir, "sources.json");
  return { store: new SourcesStore({ path, ...(now ? { now } : {}) }), path };
}

function makeRig() {
  const dir = makeDir();
  const store = new SourcesStore({ path: join(dir, "sources.json") });
  const inbox = new SourcesInbox({ path: join(dir, "sources-inbox.json") });
  const service = new SourcesService({
    store,
    inbox,
    logger,
    waker: new WakerSilencieux(),
    promptTotalChars: () => 4_000,
  });
  store.create("veille", { consigne: "" });
  store.create("mail", { consigne: "" });
  const journal = DeclencheurJournal.open({ path: join(dir, "declencheurs-journal.jsonl") });
  return { dir, store, service, journal };
}

describe("store — mise en veille DATÉE (page de gestion)", () => {
  it("note la date de mise en veille et l'EFFACE à la réactivation", () => {
    const { store } = makeStore(() => Date.parse("2026-03-10T12:00:00.000Z"));
    store.create("veille", { consigne: "" });
    const eteint = store.setActif("veille", false, "DÉSACTIVER demandé par le modèle");
    expect(eteint?.actif).toBe(false);
    expect(eteint?.etat).toBe("suspendu");
    expect(eteint?.desactiveLe).toBe("2026-03-10T12:00:00.000Z");
    expect(eteint?.raisonInactive).toBe("DÉSACTIVER demandé par le modèle");

    const rallume = store.setActif("veille", true);
    expect(rallume?.actif).toBe(true);
    expect(rallume?.desactiveLe).toBeUndefined();
    expect(rallume?.raisonInactive).toBeUndefined();
  });

  it("survit à un REDÉMARRAGE (la date est persistée dans sources.json)", () => {
    const { store, path } = makeStore(() => Date.parse("2026-03-10T12:00:00.000Z"));
    store.create("veille", { consigne: "" });
    store.setActif("veille", false, "plafond");
    const relu = new SourcesStore({ path });
    const [source] = relu.list();
    expect(source.desactiveLe).toBe("2026-03-10T12:00:00.000Z");
    expect(source.raisonInactive).toBe("plafond");
  });
});

describe("store — jetons CUMULÉS par déclencheur", () => {
  it("cumule `usage` tour après tour (jamais une estimation)", () => {
    const { store } = makeStore();
    store.create("veille", { consigne: "" });
    // Aucun tour n'a encore rien rapporté : le compteur reste ABSENT.
    expect(store.get("veille")?.jetonsCumules).toBeUndefined();

    store.cumulerJetons("veille", { input: 1_000, output: 200 });
    expect(store.get("veille")?.jetonsCumules).toEqual({ entree: 1_000, sortie: 200 });

    store.cumulerJetons("veille", { input: 500, output: 100 });
    expect(store.get("veille")?.jetonsCumules).toEqual({ entree: 1_500, sortie: 300 });

    // Un job sans `usage` ne change RIEN (aucun zéro inventé).
    store.cumulerJetons("veille", undefined);
    expect(store.get("veille")?.jetonsCumules).toEqual({ entree: 1_500, sortie: 300 });
  });
});

describe("journal — filtre appliqué AVANT la borne", () => {
  it("rend les N derniers ÉCHECS, pas les échecs des N dernières lignes", () => {
    const dir = makeDir();
    const journal = DeclencheurJournal.open({ path: join(dir, "journal.jsonl") });
    journal.append({ event: "echec", source: "veille", raison: "premier échec" });
    // Beaucoup de bruit après l'échec : sans filtre appliqué avant la borne, il
    // disparaîtrait de la fenêtre et la page afficherait « aucun échec ».
    for (let index = 0; index < 12; index += 1) {
      journal.append({ event: "recu", source: "veille", texte: `message ${index}` });
    }
    expect(journal.recent(3).map((record) => record.event)).toEqual(["recu", "recu", "recu"]);
    const echecs = journal.recent(3, { types: ["echec"] });
    expect(echecs).toHaveLength(1);
    expect(echecs[0].raison).toBe("premier échec");
  });

  it("filtre par SOURCE", () => {
    const dir = makeDir();
    const journal = DeclencheurJournal.open({ path: join(dir, "journal.jsonl") });
    journal.append({ event: "publie", source: "veille", texte: "résultat" });
    journal.append({ event: "silence", source: "mail" });
    const veille = journal.recent(10, { source: "veille" });
    expect(veille).toHaveLength(1);
    expect(veille[0].event).toBe("publie");
  });

  it("écrit et relit l'événement `preautorisation` du lot 4 (outil consommé)", () => {
    const dir = makeDir();
    const journal = DeclencheurJournal.open({ path: join(dir, "journal.jsonl") });
    journal.append({
      event: "preautorisation",
      source: "veille",
      preAutorisation: "lire_page_web",
      raison: "consommée par le tour de fond",
    });
    const [record] = journal.recent(5, { types: ["preautorisation"] });
    expect(record.event).toBe("preautorisation");
    expect(record.preAutorisation).toBe("lire_page_web");
  });
});

describe("route du journal — filtres et BORNE", () => {
  it("accepte `type` et `source`, et rend les types connus", async () => {
    const { service, journal } = makeRig();
    journal.append({ event: "echec", source: "veille", raison: "boum" });
    journal.append({ event: "recu", source: "mail", texte: "coucou" });
    const response = await handleSourcesRequest({
      method: "GET",
      path: "/api/sources/journal?type=echec&source=veille&limite=10",
      headers: GARDE,
      body: "",
      deps: { service, logger, journal },
    });
    expect(response.status).toBe(200);
    const body = response.body as {
      evenements: Array<{ event: string; source: string }>;
      limite: number;
      types: string[];
      filtre: { types?: string[]; source?: string };
    };
    expect(body.limite).toBe(10);
    expect(body.evenements.map((evenement) => evenement.event)).toEqual(["echec"]);
    expect(body.types).toContain("preautorisation");
    expect(body.filtre).toEqual({ types: ["echec"], source: "veille" });
  });

  it("⚠️ refuse un type INCONNU (400) : un filtre muet ferait croire à un journal vide", async () => {
    const { service, journal } = makeRig();
    const response = await handleSourcesRequest({
      method: "GET",
      path: "/api/sources/journal?type=nimportequoi",
      headers: GARDE,
      body: "",
      deps: { service, logger, journal },
    });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: "invalid_journal_type" });
  });

  it("BORNE la limite demandée à 200 (jamais tout le fichier)", async () => {
    const { service, journal } = makeRig();
    const response = await handleSourcesRequest({
      method: "GET",
      path: "/api/sources/journal?limite=100000",
      headers: GARDE,
      body: "",
      deps: { service, logger, journal },
    });
    expect(response.status).toBe(200);
    expect((response.body as { limite: number }).limite).toBe(200);
  });
});

describe("GET /api/sources — dernier événement de journal par source", () => {
  it("porte `dernierEvenement` (colonne « dernier résultat »)", async () => {
    const { service, journal } = makeRig();
    journal.append({ event: "recu", source: "veille", texte: "premier" });
    journal.append({
      event: "publie",
      source: "veille",
      texte: "  Résultat\n  publié  ",
    });
    journal.append({ event: "echec", source: "mail", raison: "modèle absent" });

    const response = await handleSourcesRequest({
      method: "GET",
      path: "/api/sources",
      headers: GARDE,
      body: "",
      deps: { service, logger, journal },
    });
    expect(response.status).toBe(200);
    const sources = (
      response.body as {
        sources: Array<{
          nom: string;
          dernierEvenement?: { event: string; ts: string; resume?: string; raison?: string };
        }>;
      }
    ).sources;
    const veille = sources.find((source) => source.nom === "veille");
    // Le PLUS RÉCENT gagne, et le contenu est réduit à un résumé d'une ligne.
    expect(veille?.dernierEvenement?.event).toBe("publie");
    expect(veille?.dernierEvenement?.resume).toBe("Résultat publié");
    const mail = sources.find((source) => source.nom === "mail");
    expect(mail?.dernierEvenement?.event).toBe("echec");
    expect(mail?.dernierEvenement?.raison).toBe("modèle absent");
  });

  it("reste lisible SANS journal (mode dégradé, aucun champ inventé)", async () => {
    const { service } = makeRig();
    const response = await handleSourcesRequest({
      method: "GET",
      path: "/api/sources",
      headers: GARDE,
      body: "",
      deps: { service, logger },
    });
    expect(response.status).toBe(200);
    const sources = (response.body as { sources: Array<Record<string, unknown>> }).sources;
    expect(sources).toHaveLength(2);
    for (const source of sources) expect(source.dernierEvenement).toBeUndefined();
  });
});
