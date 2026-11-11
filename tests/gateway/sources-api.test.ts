/**
 * API `/api/sources/**` — la route générique de réveil et la boîte
 * « Notifications ».
 *
 * ⚠️ SUR LE CODE D'ORIGINE (`git show HEAD:src/gateway/app.ts`), `POST
 * /api/sources/x/messages` répond **404** : aucune route n'existe. Ce test
 * l'établit d'abord (voir le describe « preuve d'échec initiale ») puis vérifie
 * le contrat complet une fois le module livré.
 *
 * Ce qui est verrouillé ici :
 *  - le chemin est reconnu, les AUTRES ne le sont pas ;
 *  - 401 sans jeton / avec le jeton d'une AUTRE source, 404 source inconnue ;
 *  - 413 (corps > 64 Kio) et 415 (Content-Type non JSON, multipart refusé) ;
 *  - 429 au-delà de 30 appels/minute pour la même source ;
 *  - idempotence : même `(source, id)` ⇒ 200 {duplicate:true}, aucun second tour ;
 *  - l'administration réutilise EXACTEMENT les gardes de `/api/config`
 *    (`X-Yuki-Config: 1` + `Origin`/`Host`), et le jeton n'est rendu qu'UNE fois ;
 *  - ⚠️ la LECTURE aussi est gardée : `GET /api/sources` et
 *    `GET /api/sources/inbox` refusent une requête SANS `X-Yuki-Config: 1`
 *    (403) — la boîte porte le contenu des messages de sources ;
 *  - la boîte : liste + compteur de non-lus, marquage lu, suppression, et
 *    `/ouvrir` qui ne crée qu'UNE conversation.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../../src/gateway/app.js";
import { handleSourcesRequest, isSourcesPath } from "../../src/gateway/routes/sources.js";
import type { GpuReport } from "../../src/types/gpu.js";
import type { Env } from "../../src/config/env.js";
import { SourcesInbox } from "../../src/sources/inbox.js";
import { DeclencheurJournal } from "../../src/sources/journal.js";
import { SourcesService, type SourcesHostEvent, type SourcesWaker } from "../../src/sources/service.js";
import { SourcesStore } from "../../src/sources/store.js";
import { sourceTokenName } from "../../src/sources/types.js";

const dirs: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

class FakeWaker implements SourcesWaker {
  readonly sends: Array<{ sessionId: string; text: string }> = [];
  private sessionId: string | undefined = "session-ouverte";

  currentSessionId(): string | undefined {
    return this.sessionId;
  }
  send(sessionId: string, text: string): { runId: string; sessionId: string } {
    this.sends.push({ sessionId, text });
    return { runId: `run-${this.sends.length}`, sessionId };
  }
  subscribeAll(_listener: (event: SourcesHostEvent) => void): () => void {
    return () => undefined;
  }
  async newSession(): Promise<{ sessionId: string }> {
    return { sessionId: "session-creee" };
  }
  async resume(file: string): Promise<{ sessionId: string }> {
    return { sessionId: file };
  }
  async sessionFileFor(id: string): Promise<string | undefined> {
    return id;
  }
  setCurrent(sessionId: string | undefined): void {
    this.sessionId = sessionId;
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

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

function makeRig() {
  const dir = mkdtempSync(join(tmpdir(), "yuki-sources-api-"));
  dirs.push(dir);
  const vault = new FakeVault();
  const waker = new FakeWaker();
  const store = new SourcesStore({ path: join(dir, "sources.json") });
  const inbox = new SourcesInbox({ path: join(dir, "sources-inbox.json") });
  const service = new SourcesService({
    store,
    inbox,
    logger,
    tokens: vault,
    waker,
    promptTotalChars: () => 4_000,
  });
  service.attach();
  store.create("news", { tour: "stocker" });
  vault.set(sourceTokenName("news"), "jeton-news");
  store.create("mail", { tour: "stocker" });
  vault.set(sourceTokenName("mail"), "jeton-mail");
  return { dir, vault, waker, store, inbox, service };
}

function request(
  service: SourcesService,
  input: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: string;
  },
) {
  return handleSourcesRequest({
    method: input.method,
    path: input.path,
    headers: input.headers ?? {},
    body: input.body ?? "",
    deps: { service, logger },
  });
}

describe("API sources — chemins", () => {
  it("reconnaît les chemins de l'API et rien d'autre", () => {
    expect(isSourcesPath("/api/sources")).toBe(true);
    expect(isSourcesPath("/api/sources/news/messages")).toBe(true);
    expect(isSourcesPath("/api/sources/inbox")).toBe(true);
    expect(isSourcesPath("/api/config")).toBe(false);
    expect(isSourcesPath("/api/sourcesfoo")).toBe(false);
  });
});

describe("API sources — preuve d'échec initiale (404 sur le code d'origine)", () => {
  it("montre que la route n'existait pas : l'application d'origine refuse (jamais 202)", async () => {
    // On construit l'application SANS dépendance `sources` : c'est exactement
    // l'état du code d'origine (le hook `sources` n'existait pas dans
    // `AppContext`). `POST /api/sources/x/messages` tombe alors dans le repli de
    // `app.ts` (`method_not_allowed`, 405) — ou 404 selon le chemin : dans TOUS
    // les cas, jamais un 202. Aucune route des sources n'existe.
    const server = createServer(
      createApp({
        env: { version: "test" } as Env,
        report: {} as GpuReport,
        gatePassed: true,
        startedAt: Date.now(),
        volumes: [],
      }),
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api/sources/x/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer x" },
      body: JSON.stringify({ id: "a1", texte: "coucou" }),
    });
    expect([404, 405]).toContain(response.status);
    expect(response.status).not.toBe(202);
  });
});

describe("API sources — paramètres de requête à travers le ROUTEUR (lot 35j)", () => {
  /**
   * ⚠️ POURQUOI CE TEST VIT ICI : le routeur normalise le chemin
   * (`normalizePath`, `src/gateway/app.ts`) — il en retire la CHAÎNE DE REQUÊTE.
   * Les routes des sources en dépendent pourtant entièrement (`?bot=<id>`,
   * `?expression=`, `?limite=`). Un test qui appelle `handleSourcesRequest`
   * directement ne voit pas ce défaut : il faut passer par `createApp`.
   */
  async function appAvecSources(): Promise<number> {
    const { service } = makeRig();
    const server = createServer(
      createApp({
        env: { version: "test" } as Env,
        report: {} as GpuReport,
        gatePassed: true,
        startedAt: Date.now(),
        volumes: [],
        sources: {
          service,
          logger,
          // Un seul bot connu : `?bot=inconnu` doit donc être REFUSÉ (404), et
          // `?bot=yuki` doit être SERVI (le nom du bot est rendu).
          bots: { lister: () => [{ id: "yuki", nom: "Yuki", actif: true }] },
          pourBot: () => ({ service }),
        },
      }),
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    return (server.address() as AddressInfo).port;
  }

  it("`?bot=<inconnu>` ⇒ 404 qui le nomme (le paramètre arrive jusqu'au gestionnaire)", async () => {
    const port = await appAvecSources();
    const response = await fetch(`http://127.0.0.1:${port}/api/sources?bot=inconnu`, {
      headers: { "x-yuki-config": "1" },
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { code?: string; bot?: string };
    expect(body.code).toBe("unknown_bot");
    expect(body.bot).toBe("inconnu");
  });

  it("`?bot=<connu>` ⇒ 200 et le bot est NOMMÉ dans la réponse", async () => {
    const port = await appAvecSources();
    const response = await fetch(`http://127.0.0.1:${port}/api/sources?bot=yuki`, {
      headers: { "x-yuki-config": "1" },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      bot?: { id: string; nom: string };
      bots?: Array<{ id: string }>;
    };
    expect(body.bot).toEqual({ id: "yuki", nom: "Yuki" });
    expect(body.bots?.map((bot) => bot.id)).toEqual(["yuki"]);
  });

  it("`?expression=` de l'aperçu cron N'EST PAS perdu en route", async () => {
    const port = await appAvecSources();
    const params = new URLSearchParams({ expression: "0 8 * * *", fuseau: "Europe/Paris" });
    const response = await fetch(`http://127.0.0.1:${port}/api/sources/apercu?${params}`, {
      headers: { "x-yuki-config": "1" },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { expression?: string; passages?: string[] };
    // Sans le paramètre, la route répond `expression_absente` (aucun passage).
    expect(body.expression).toBe("0 8 * * *");
    expect(body.passages?.length).toBeGreaterThan(0);
  });
});

describe("API sources — authentification et erreurs", () => {
  it("401 sans jeton", async () => {
    const { service } = makeRig();
    const response = await request(service, {
      method: "POST",
      path: "/api/sources/news/messages",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "m1", texte: "coucou" }),
    });
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: "invalid_token" });
  });

  it("401 avec le jeton d'UNE AUTRE source", async () => {
    const { service } = makeRig();
    const response = await request(service, {
      method: "POST",
      path: "/api/sources/news/messages",
      headers: { "content-type": "application/json", authorization: "Bearer jeton-mail" },
      body: JSON.stringify({ id: "m1", texte: "coucou" }),
    });
    expect(response.status).toBe(401);
  });

  it("404 source inconnue", async () => {
    const { service } = makeRig();
    const response = await request(service, {
      method: "POST",
      path: "/api/sources/fantome/messages",
      headers: { "content-type": "application/json", authorization: "Bearer jeton-news" },
      body: JSON.stringify({ id: "m1", texte: "coucou" }),
    });
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: "unknown_source" });
  });

  it("415 quand le corps n'est pas du JSON (le multipart est refusé en v1)", async () => {
    const { service } = makeRig();
    const response = await request(service, {
      method: "POST",
      path: "/api/sources/news/messages",
      headers: { "content-type": "multipart/form-data; boundary=x", authorization: "Bearer jeton-news" },
      body: "{}",
    });
    expect(response.status).toBe(415);
    expect(response.body).toMatchObject({ code: "unsupported_media_type" });
  });

  it("400 sur un corps invalide (id manquant, texte vide, tour inconnu)", async () => {
    const { service } = makeRig();
    const headers = { "content-type": "application/json", authorization: "Bearer jeton-news" };
    for (const body of [
      JSON.stringify({ texte: "sans identifiant" }),
      JSON.stringify({ id: "m1", texte: "   " }),
      JSON.stringify({ id: "m1", texte: "ok", tour: "exploser" }),
      "pas du json",
    ]) {
      const response = await request(service, { method: "POST", path: "/api/sources/news/messages", headers, body });
      expect(response.status, body).toBe(400);
    }
  });

  it("202 {stored} pour un message `stocker` et le contenu entre dans la boîte", async () => {
    const { service } = makeRig();
    const response = await request(service, {
      method: "POST",
      path: "/api/sources/news/messages",
      headers: { "content-type": "application/json", authorization: "Bearer jeton-news" },
      body: JSON.stringify({ id: "m1", texte: "Trois articles.", titre: "Matin" }),
    });
    expect(response.status).toBe(202);
    const body = response.body as { stored?: boolean; entree: { texte: string; etat: string } };
    expect(body.stored).toBe(true);
    expect(body.entree.texte).toBe("Trois articles.");
    expect(body.entree.etat).toBe("recu");
  });

  it("202 {started} pour un message `lancer` en conversation courante", async () => {
    const { service, store, waker } = makeRig();
    store.update("news", { tour: "lancer", destination: "courante" });
    const response = await request(service, {
      method: "POST",
      path: "/api/sources/news/messages",
      headers: { "content-type": "application/json", authorization: "Bearer jeton-news" },
      body: JSON.stringify({ id: "m1", texte: "urgent" }),
    });
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ started: true });
    expect(waker.sends).toHaveLength(1);
  });

  it("202 {stored, raison} quand le modèle est indisponible (LLM_UNAVAILABLE)", async () => {
    const { service, store, waker } = makeRig();
    store.update("news", { tour: "lancer", destination: "courante" });
    (waker as unknown as { send: () => never }).send = () => {
      throw Object.assign(new Error("pas de modèle"), { code: "LLM_UNAVAILABLE" });
    };
    const response = await request(service, {
      method: "POST",
      path: "/api/sources/news/messages",
      headers: { "content-type": "application/json", authorization: "Bearer jeton-news" },
      body: JSON.stringify({ id: "m1", texte: "urgent" }),
    });
    expect(response.status).toBe(202);
    const body = response.body as { stored: boolean; raison: string };
    expect(body.stored).toBe(true);
    expect(body.raison).toContain("Aucun modèle n'est configuré pour le rôle chat");
  });

  it("200 + duplicate:true au renvoi du même (source, id), sans second tour", async () => {
    const { service, store, waker } = makeRig();
    store.update("news", { tour: "lancer", destination: "courante" });
    const headers = { "content-type": "application/json", authorization: "Bearer jeton-news" };
    const first = await request(service, {
      method: "POST",
      path: "/api/sources/news/messages",
      headers,
      body: JSON.stringify({ id: "m1", texte: "urgent" }),
    });
    expect(first.status).toBe(202);
    const second = await request(service, {
      method: "POST",
      path: "/api/sources/news/messages",
      headers,
      body: JSON.stringify({ id: "m1", texte: "urgent" }),
    });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ duplicate: true });
    expect(waker.sends).toHaveLength(1);
  });

  it("429 au-delà de 30 appels par minute pour la même source", async () => {
    const { service } = makeRig();
    const headers = { "content-type": "application/json", authorization: "Bearer jeton-news" };
    let last = 0;
    for (let index = 0; index < 31; index += 1) {
      const response = await request(service, {
        method: "POST",
        path: "/api/sources/news/messages",
        headers,
        body: JSON.stringify({ id: `m${index}`, texte: "x" }),
      });
      last = response.status;
    }
    expect(last).toBe(429);
    // Une autre source garde son propre quota.
    const other = await request(service, {
      method: "POST",
      path: "/api/sources/mail/messages",
      headers: { "content-type": "application/json", authorization: "Bearer jeton-mail" },
      body: JSON.stringify({ id: "m0", texte: "x" }),
    });
    expect(other.status).toBe(202);
  });
});

describe("API sources — corps trop gros (413)", () => {
  it("un corps de plus de 64 Kio est refusé AVANT toute écriture", async () => {
    // On passe par le VRAI serveur HTTP : c'est la lecture bornée de `app.ts` qui
    // doit refuser (413), pas un contrôle du service.
    const rig = makeRig();
    const server = createServer(
      createApp({
        env: { version: "test" } as Env,
        report: {} as GpuReport,
        gatePassed: true,
        startedAt: Date.now(),
        volumes: [],
        sources: { service: rig.service, logger },
      }),
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api/sources/news/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer jeton-news" },
      body: JSON.stringify({ id: "m1", texte: "x".repeat(70 * 1024) }),
    });
    expect(response.status).toBe(413);
    const body = (await response.json()) as { code: string; message: string };
    expect(body.code).toBe("body_too_large");
    expect(body.message).toContain("64 Kio");
    expect(rig.inbox.size).toBe(0);
  });
});

describe("API sources — administration (mêmes gardes que /api/config)", () => {
  const GUARD = { "x-yuki-config": "1", "content-type": "application/json" };

  it("POST sans en-tête X-Yuki-Config ⇒ 403, avec ⇒ 201", async () => {
    const { service } = makeRig();
    const refused = await request(service, {
      method: "POST",
      path: "/api/sources",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nom: "veille" }),
    });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: "missing_config_header" });

    const created = await request(service, {
      method: "POST",
      path: "/api/sources",
      headers: GUARD,
      body: JSON.stringify({ nom: "veille", consigne: "si rien d'anormal, ne dis rien" }),
    });
    expect(created.status).toBe(201);
    // ⚠️ Une source NEUVE n'a AUCUNE destination (`aucune`) : elle ne démarre rien
    // tant que l'utilisateur n'a pas choisi un fil dans `/config`.
    // ⚠️ v2 : sans `visibilite` explicite et sans réglage du modèle v1, la source
    // est SILENCIEUSE (et ne notifie donc jamais).
    expect(created.body).toMatchObject({
      source: {
        nom: "veille",
        visibilite: "silencieux",
        declencheur: { type: "webhook" },
        tour: "stocker",
        destination: "aucune",
        notifier: false,
        preAutorisations: [],
      },
    });
  });

  it("refuse une origine étrangère (403 bad_origin)", async () => {
    const { service } = makeRig();
    const refused = await request(service, {
      method: "PATCH",
      path: "/api/sources/news",
      headers: { ...GUARD, origin: "http://attaquant.example", host: "yuki.local" },
      body: JSON.stringify({ notifier: false }),
    });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: "bad_origin" });
  });

  it("⚠️ GET est GARDÉ lui aussi (liste sans en-tête ⇒ 403), PATCH/DELETE aussi", async () => {
    const { service } = makeRig();
    // La liste porte les CONSIGNES et les DESTINATIONS de chaque programme branché :
    // une page tierce ne doit pas pouvoir la lire.
    const refusedList = await request(service, { method: "GET", path: "/api/sources" });
    expect(refusedList.status).toBe(403);
    expect(refusedList.body).toMatchObject({ code: "missing_config_header" });

    const list = await request(service, {
      method: "GET",
      path: "/api/sources",
      headers: { "x-yuki-config": "1" },
    });
    expect(list.status).toBe(200);
    const body = list.body as { sources: Array<{ nom: string; jetonDefini: boolean }> };
    expect(body.sources.map((source) => source.nom).sort()).toEqual(["mail", "news"]);
    expect(body.sources.every((source) => source.jetonDefini)).toBe(true);

    const patched = await request(service, {
      method: "PATCH",
      path: "/api/sources/news",
      headers: GUARD,
      body: JSON.stringify({ notifier: false }),
    });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ source: { notifier: false } });

    const removed = await request(service, { method: "DELETE", path: "/api/sources/mail", headers: GUARD });
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ removed: true });
  });

  it("POST /jeton rend le jeton UNE fois et ne le réaffiche jamais", async () => {
    const { service, vault } = makeRig();
    const first = await request(service, {
      method: "POST",
      path: "/api/sources/news/jeton",
      headers: GUARD,
    });
    expect(first.status).toBe(200);
    const token = (first.body as { jeton: string }).jeton;
    expect(token.length).toBeGreaterThan(20);
    expect(vault.lookup(sourceTokenName("news"))).toBe(token);
    expect((first.body as { message: string }).message).toContain("ne sera plus jamais affiché");

    // La LISTE ne contient que le booléen, jamais la valeur.
    const list = await request(service, {
      method: "GET",
      path: "/api/sources",
      headers: { "x-yuki-config": "1" },
    });
    expect(JSON.stringify(list.body)).not.toContain(token);
  });
});

describe("API sources — boîte « Notifications »", () => {
  const GUARD = { "x-yuki-config": "1" };
  async function seed(service: SourcesService): Promise<string> {
    const response = await request(service, {
      method: "POST",
      path: "/api/sources/news/messages",
      headers: { "content-type": "application/json", authorization: "Bearer jeton-news" },
      body: JSON.stringify({ id: "m1", texte: "Trois articles.", titre: "Matin" }),
    });
    return (response.body as { entree: { id: string } }).entree.id;
  }

  it("⚠️ toute la boîte (LECTURE comprise) exige le garde-fou d'écriture (403)", async () => {
    const { service } = makeRig();
    const id = await seed(service);
    for (const [method, path] of [
      ["GET", "/api/sources/inbox"],
      ["POST", `/api/sources/inbox/${id}/lu`],
      ["POST", "/api/sources/inbox/lu"],
      ["POST", `/api/sources/inbox/${id}/ouvrir`],
      ["DELETE", `/api/sources/inbox/${id}`],
    ] as const) {
      const refused = await request(service, { method, path });
      expect(refused.status, `${method} ${path}`).toBe(403);
      expect(refused.body).toMatchObject({ code: "missing_config_header" });
    }
    // Avec l'en-tête, la lecture rend la boîte.
    const read = await request(service, {
      method: "GET",
      path: "/api/sources/inbox",
      headers: { "x-yuki-config": "1" },
    });
    expect(read.status).toBe(200);
  });

  it("GET /api/sources/inbox rend les entrées, le compteur et la limite", async () => {
    const { service } = makeRig();
    await seed(service);
    const response = await request(service, {
      method: "GET",
      path: "/api/sources/inbox",
      headers: { "x-yuki-config": "1" },
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      // ⚠️ `nonLus` ne compte QUE les échecs et alertes : une réception vaut 0.
      nonLus: 0,
      limite: 200,
      entries: [{ source: "news", titre: "Matin", etat: "recu", lu: false }],
    });
  });

  it("POST …/<id>/lu marque une entrée lue (compteur décrémenté)", async () => {
    const { service } = makeRig();
    const id = await seed(service);
    const response = await request(service, {
      method: "POST",
      path: `/api/sources/inbox/${id}/lu`,
      headers: GUARD,
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ nonLus: 0, entree: { lu: true } });
  });

  it("DELETE …/<id> supprime l'entrée, et 404 au-delà", async () => {
    const { service } = makeRig();
    const id = await seed(service);
    const removed = await request(service, {
      method: "DELETE",
      path: `/api/sources/inbox/${id}`,
      headers: GUARD,
    });
    expect(removed.status).toBe(200);
    const again = await request(service, {
      method: "DELETE",
      path: `/api/sources/inbox/${id}`,
      headers: GUARD,
    });
    expect(again.status).toBe(404);
  });

  it("⚠️ AUCUN fil créé tant que `/ouvrir` n'est pas appelé, puis UNE seule conversation", async () => {
    const { service, waker } = makeRig();
    const id = await seed(service);
    // Avant le clic : aucun envoi, aucune session créée, aucun fil.
    expect(waker.sends).toEqual([]);

    const first = await request(service, {
      method: "POST",
      path: `/api/sources/inbox/${id}/ouvrir`,
      headers: GUARD,
    });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ sessionId: "session-creee", created: true });
    const second = await request(service, {
      method: "POST",
      path: `/api/sources/inbox/${id}/ouvrir`,
      headers: GUARD,
    });
    expect(second.body).toMatchObject({ sessionId: "session-creee", created: false });
    // Un seul envoi par clic, jamais deux conversations.
    expect(waker.sends).toHaveLength(2);
    expect(waker.sends[0].sessionId).toBe("session-creee");
    expect(waker.sends[1].sessionId).toBe("session-creee");
  });
});

const GUARD_V2 = { "x-yuki-config": "1", "content-type": "application/json" };

describe("API sources — modèle v2 (visibilité) et journal des déclencheurs", () => {
  it("PATCH `visibilite` bascule la sortie et force notifier=false en silencieux", async () => {
    const { service } = makeRig();
    const silent = await request(service, {
      method: "PATCH",
      path: "/api/sources/news",
      headers: GUARD_V2,
      body: JSON.stringify({ visibilite: "silencieux", notifier: true }),
    });
    expect(silent.status).toBe(200);
    expect(silent.body).toMatchObject({ source: { visibilite: "silencieux", notifier: false } });

    const visible = await request(service, {
      method: "PATCH",
      path: "/api/sources/news",
      headers: GUARD_V2,
      body: JSON.stringify({ visibilite: "visible", notifier: true }),
    });
    expect(visible.status).toBe(200);
    expect(visible.body).toMatchObject({ source: { visibilite: "visible", notifier: true } });
  });

  it("refuse une visibilité inconnue (400 explicite, aucun repli muet)", async () => {
    const { service } = makeRig();
    const response = await request(service, {
      method: "PATCH",
      path: "/api/sources/news",
      headers: GUARD_V2,
      body: JSON.stringify({ visibilite: "peut-etre" }),
    });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: "invalid_visibilite" });
  });

  it("accepte encore `conversation` comme ALIAS de `destination` (programmes du lot 17)", async () => {
    const { service } = makeRig();
    const response = await request(service, {
      method: "PATCH",
      path: "/api/sources/news",
      headers: GUARD_V2,
      body: JSON.stringify({ conversation: "nouvelle" }),
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ source: { destination: "nouvelle" } });
  });

  it("GET /api/sources/journal est GARDÉ et rend les événements (jamais en conversation)", async () => {
    const { dir, service } = makeRig();
    const journalPath = join(dir, "declencheurs-journal.jsonl");
    const journal = DeclencheurJournal.open({ path: journalPath });
    journal.append({ event: "recu", source: "news", texte: "contenu reçu", octets: 12 });
    journal.append({ event: "silence", source: "news" });

    const anonymous = await handleSourcesRequest({
      method: "GET",
      path: "/api/sources/journal",
      headers: {},
      body: "",
      deps: { service, logger },
    });
    expect(anonymous.status).toBe(403);

    const response = await handleSourcesRequest({
      method: "GET",
      path: "/api/sources/journal?limite=5",
      headers: { "x-yuki-config": "1" },
      body: "",
      deps: { service, logger, journal },
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ limite: 5 });
    const evenements = (response.body as { evenements: Array<{ event: string }> }).evenements;
    // Les plus récents d'abord.
    expect(evenements.map((event) => event.event)).toEqual(["silence", "recu"]);
  });
});

/**
 * MOTEUR HORLOGE (lot 26, lot 2) — création d'un déclencheur `planning` et
 * APERÇU du prochain passage.
 *
 * ⚠️ Ces tests ÉCHOUENT sur le code d'origine : `declencheur.type = "planning"`
 * n'existait pas (`git show HEAD:src/sources/types.ts`) et la route
 * `/api/sources/apercu` n'existait pas (404).
 */
describe("API sources — déclencheur planifié (moteur horloge)", () => {
  const GARDE = { "x-yuki-config": "1", "content-type": "application/json" };

  it("crée un déclencheur `planning` et PERSISTE son prochain passage", async () => {
    const rig = makeRig();
    const response = await request(rig.service, {
      method: "POST",
      path: "/api/sources",
      headers: GARDE,
      body: JSON.stringify({
        nom: "matin",
        declencheur: { type: "planning", expression: "0 9 * * 1-5", fuseau: "Europe/Paris" },
      }),
    });
    expect(response.status).toBe(201);
    const source = (response.body as { source: Record<string, unknown> }).source;
    expect(source["declencheur"]).toEqual({
      type: "planning",
      expression: "0 9 * * 1-5",
      fuseau: "Europe/Paris",
    });
    // ⚠️ Le prochain passage est calculé et PERSISTÉ (reprise après redémarrage).
    expect(typeof source["prochainPassage"]).toBe("string");
    expect(rig.store.get("matin")?.prochainPassage).toBe(source["prochainPassage"]);
    expect(source["actif"]).toBe(true);
    expect(source["plafondMs"]).toBe(10 * 60 * 1000);
    expect(source["maxToursParJour"]).toBe(200);
  });

  it("REFUSE une expression invalide avec la raison (aucun repli silencieux)", async () => {
    const rig = makeRig();
    const response = await request(rig.service, {
      method: "POST",
      path: "/api/sources",
      headers: GARDE,
      body: JSON.stringify({
        nom: "interdit",
        declencheur: { type: "planning", expression: "0 0 L * *", fuseau: "Europe/Paris" },
      }),
    });
    expect(response.status).toBe(400);
    const body = response.body as { message?: string; code?: string };
    expect(body.code).toBe("invalid_expression");
    expect(body.message).toContain("« L » (dernier jour du mois) n'est pas supporté");
    // Aucune source n'a été créée.
    expect(rig.store.has("interdit")).toBe(false);
  });

  it("REFUSE un fuseau inconnu", async () => {
    const rig = makeRig();
    const response = await request(rig.service, {
      method: "POST",
      path: "/api/sources",
      headers: GARDE,
      body: JSON.stringify({
        nom: "fuseau",
        declencheur: { type: "planning", expression: "0 9 * * *", fuseau: "Mars/Olympus" },
      }),
    });
    expect(response.status).toBe(400);
    expect((response.body as { code?: string }).code).toBe("invalid_fuseau");
  });

  it("l'APERÇU rend les prochains passages, et la raison d'une expression impossible", async () => {
    const rig = makeRig();
    const garde = await request(rig.service, {
      method: "GET",
      path: "/api/sources/apercu?expression=0+9+*+*+*&fuseau=Europe/Paris",
      headers: {},
    });
    // ⚠️ Lecture GARDÉE : l'aperçu révèle une expression de déclencheur.
    expect(garde.status).toBe(403);

    const ok = await request(rig.service, {
      method: "GET",
      path: `/api/sources/apercu?expression=${encodeURIComponent("0 9 * * *")}&fuseau=Europe/Paris&combien=2&depuis=2026-06-01T00:00:00Z`,
      headers: { "x-yuki-config": "1" },
    });
    expect(ok.status).toBe(200);
    const body = ok.body as { passages: string[]; fuseau: string; raison?: string };
    expect(body.fuseau).toBe("Europe/Paris");
    expect(body.passages).toEqual([
      "2026-06-01T07:00:00.000Z",
      "2026-06-02T07:00:00.000Z",
    ]);

    const impossible = await request(rig.service, {
      method: "GET",
      path: `/api/sources/apercu?expression=${encodeURIComponent("0 0 31 2 *")}&fuseau=Europe/Paris`,
      headers: { "x-yuki-config": "1" },
    });
    expect(impossible.status).toBe(200);
    const ko = impossible.body as { passages: string[]; raison?: string; code?: string };
    expect(ko.passages).toEqual([]);
    expect(ko.code).toBe("aucune_occurrence");
    expect(ko.raison).toContain("Aucune occurrence");
  });

  it("PATCH accepte `actif`, `chevauchement`, `rattrapage` et le plafond borné", async () => {
    const rig = makeRig();
    rig.store.create("planifie", {
      declencheur: { type: "planning", expression: "0 9 * * *", fuseau: "Europe/Paris" },
    } as never);
    const response = await request(rig.service, {
      method: "PATCH",
      path: "/api/sources/planifie",
      headers: GARDE,
      body: JSON.stringify({
        chevauchement: "remplacer",
        rattrapage: "sauter",
        plafondMs: 900_000,
        maxToursParJour: 12,
        actif: false,
      }),
    });
    expect(response.status).toBe(200);
    const source = (response.body as { source: Record<string, unknown> }).source;
    expect(source["chevauchement"]).toBe("remplacer");
    expect(source["rattrapage"]).toBe("sauter");
    expect(source["plafondMs"]).toBe(900_000);
    expect(source["maxToursParJour"]).toBe(12);
    expect(source["actif"]).toBe(false);
    expect(source["etat"]).toBe("suspendu");
  });
});

/**
 * LOTS 32 et 33 — fin de récurrence réglable et chaînes d'étapes ATOMIQUES.
 *
 * ⚠️ Ces tests ÉCHOUENT sur le code d'origine : la route `/api/sources/chaines`
 * n'existe pas (404 sur le nom de source « chaines »), et `settingsFrom` ne transmet ni
 * `occurrencesMax` ni `jusquAu` (le store les validait sans qu'on pût les régler).
 */
describe("API sources — fin de récurrence (lot 32) et chaînes (lot 33)", () => {
  const GARDE = { "x-yuki-config": "1", "content-type": "application/json" };

  it("PATCH règle `occurrencesMax` et `jusquAu`, et une CHAÎNE VIDE les retire", async () => {
    const rig = makeRig();
    rig.store.create("planifie", {
      declencheur: { type: "planning", expression: "0 9 * * *", fuseau: "Europe/Paris" },
    } as never);
    const pose = await request(rig.service, {
      method: "PATCH",
      path: "/api/sources/planifie",
      headers: GARDE,
      body: JSON.stringify({ occurrencesMax: 14, jusquAu: "2026-11-19T23:00:00Z" }),
    });
    expect(pose.status).toBe(200);
    const source = (pose.body as { source: Record<string, unknown> }).source;
    expect(source["occurrencesMax"]).toBe(14);
    expect(source["jusquAu"]).toBe("2026-11-19T23:00:00.000Z");

    const retire = await request(rig.service, {
      method: "PATCH",
      path: "/api/sources/planifie",
      headers: GARDE,
      body: JSON.stringify({ occurrencesMax: "", jusquAu: "" }),
    });
    expect(retire.status).toBe(200);
    const apres = (retire.body as { source: Record<string, unknown> }).source;
    expect(apres["occurrencesMax"]).toBeUndefined();
    expect(apres["jusquAu"]).toBeUndefined();
  });

  it("POST /api/sources/chaines crée les étapes DANS L'ORDRE et les expose", async () => {
    const rig = makeRig();
    const response = await request(rig.service, {
      method: "POST",
      path: "/api/sources/chaines",
      headers: GARDE,
      body: JSON.stringify({
        libelle: "Veille quotidienne",
        etapes: [
          {
            libelle: "Collecte",
            consigne: "Collecte",
            declencheur: { type: "planning", expression: "0 7 * * *", fuseau: "Europe/Paris" },
          },
          {
            libelle: "Analyse",
            consigne: "Analyse",
            declencheur: { type: "planning", expression: "0 8 * * *", fuseau: "Europe/Paris" },
          },
        ],
      }),
    });
    expect(response.status).toBe(201);
    const body = response.body as { chaineId: string; etapes: Array<{ nom: string }> };
    expect(body.etapes.map((etape) => etape.nom)).toEqual(["collecte", "analyse"]);
    // La liste les expose avec leur appartenance (l'UI en fait une carte).
    const liste = await request(rig.service, {
      method: "GET",
      path: "/api/sources",
      headers: { "x-yuki-config": "1" },
    });
    const sources = (liste.body as { sources: Array<Record<string, unknown>> }).sources;
    const collecte = sources.find((source) => source["nom"] === "collecte") as
      | Record<string, unknown>
      | undefined;
    expect(collecte?.["chaine"]).toEqual({ id: body.chaineId, etape: 1 });
    const analyse = sources.find((source) => source["nom"] === "analyse") as
      | Record<string, unknown>
      | undefined;
    expect(analyse?.["chaine"]).toEqual({
      id: body.chaineId,
      etape: 2,
      apres: "collecte",
    });
  });

  it("⚠️ place insuffisante ⇒ 429 et AUCUNE étape créée (atomique)", async () => {
    const rig = makeRig();
    // Le harnais déclare déjà deux sources : on complète jusqu'à UNE place libre.
    let rang = 0;
    while (rig.store.sourcesDurables < 19) {
      rig.store.create(`dur-${rang}`, {});
      rang += 1;
    }
    const avant = rig.store.size;
    const response = await request(rig.service, {
      method: "POST",
      path: "/api/sources/chaines",
      headers: GARDE,
      body: JSON.stringify({
        etapes: [
          { libelle: "Un", consigne: "x", declencheur: { type: "planning", expression: "0 7 * * *", fuseau: "Europe/Paris" } },
          { libelle: "Deux", consigne: "y", declencheur: { type: "planning", expression: "0 8 * * *", fuseau: "Europe/Paris" } },
        ],
      }),
    });
    expect(response.status).toBe(429);
    const body = response.body as { error: string; placesRestantes: number; demandees: number };
    expect(body.error).toBe("chaines_full");
    expect(body.placesRestantes).toBe(1);
    expect(body.demandees).toBe(2);
    expect(rig.store.size).toBe(avant);
  });

  it("la route des chaînes est GARDÉE comme le reste de l'administration", async () => {
    const rig = makeRig();
    const response = await request(rig.service, {
      method: "POST",
      path: "/api/sources/chaines",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ etapes: [] }),
    });
    expect(response.status).toBe(403);
  });
});
