/**
 * LOT 26 / 4 — API des PRÉ-AUTORISATIONS (`/api/sources/preautorisations`).
 *
 * ⚠️ Ces tests ÉCHOUENT sur le code d'origine : la route n'existe pas
 * (`git show HEAD:src/gateway/routes/sources.ts` ne connaît ni
 * `preAutorisations` ni `preautorisations`), et `GET /api/sources` n'y renvoie
 * aucune autorisation active.
 *
 * Ce qui est verrouillé ici :
 *  - toutes les routes sont GARDÉES (`X-Yuki-Config: 1` + `Origin`/`Host`) ;
 *  - un déclencheur INCONNU, un agent INCONNU et un motif à JOKER sont refusés
 *    avec un code stable et un message en français ;
 *  - la création est persistée et apparaît dans `GET /api/sources` de la source
 *    concernée (colonne « pré-autorisations actives ») ;
 *  - la révocation passe l'état à `revoquee` et reste listée (aucune disparition
 *    silencieuse).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PreAutorisationStore } from "../../src/agents/index.js";
import {
  handleSourcesRequest,
  type SourcesApiDeps,
} from "../../src/gateway/routes/sources.js";
import { SourcesInbox } from "../../src/sources/inbox.js";
import { SourcesService } from "../../src/sources/service.js";
import { SourcesStore } from "../../src/sources/store.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const GUARD = { "x-yuki-config": "1" };

function rig(): { deps: SourcesApiDeps; registre: PreAutorisationStore } {
  const dir = mkdtempSync(join(tmpdir(), "yuki-preauth-api-"));
  dirs.push(dir);
  const store = new SourcesStore({ path: join(dir, "sources.json") });
  const inbox = new SourcesInbox({ path: join(dir, "sources-inbox.json") });
  const service = new SourcesService({
    store,
    inbox,
    logger,
    promptTotalChars: () => 4_000,
  });
  service.attach();
  store.create("veille", {});
  const registre = new PreAutorisationStore({ path: join(dir, "preautorisations.json") });
  const deps: SourcesApiDeps = {
    service,
    logger,
    preAutorisations: registre,
    agents: {
      list: () => [
        { agentId: "agent-a", name: "nuc00", level: "always", revoked: false },
        { agentId: "agent-b", name: "vieux", level: "always", revoked: true },
      ],
    },
  };
  return { deps, registre };
}

function call(
  deps: SourcesApiDeps,
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: unknown } = {},
) {
  return handleSourcesRequest({
    method,
    path,
    headers: options.headers ?? {},
    body: options.body === undefined ? "" : JSON.stringify(options.body),
    deps,
  });
}

describe("API pré-autorisations — la garde", () => {
  it("refuse toute requête sans l'en-tête de configuration (403, lecture comprise)", async () => {
    const { deps } = rig();
    const lecture = await call(deps, "GET", "/api/sources/preautorisations");
    expect(lecture.status).toBe(403);
    const ecriture = await call(deps, "POST", "/api/sources/preautorisations", {
      body: { declencheur: "veille", agentId: "agent-a", motif: "df -h" },
    });
    expect(ecriture.status).toBe(403);
  });
});

describe("API pré-autorisations — catalogue et création", () => {
  it("sert le CATALOGUE des motifs et les machines proposables", async () => {
    const { deps } = rig();
    const response = await call(deps, "GET", "/api/sources/preautorisations", {
      headers: GUARD,
    });
    expect(response.status).toBe(200);
    const body = response.body as Record<string, unknown>;
    expect(Array.isArray(body["preAutorisations"])).toBe(true);
    const motifs = body["motifs"] as Array<Record<string, unknown>>;
    expect(motifs.length).toBeGreaterThan(0);
    // ⚠️ Aucun motif proposé ne contient de joker.
    for (const motif of motifs) {
      expect(String(motif["motif"])).not.toContain("*");
      expect(["exacte", "prefixe"]).toContain(motif["portee"]);
    }
    const agents = body["agents"] as Array<Record<string, unknown>>;
    expect(agents.map((agent) => agent["agentId"])).toEqual(["agent-a", "agent-b"]);
    expect(body["dureeDefautJours"]).toBe(30);
    expect(body["dureeMaxJours"]).toBe(90);
  });

  it("refuse un déclencheur inconnu, un agent inconnu ou révoqué, un motif à joker", async () => {
    const { deps } = rig();
    const inconnu = await call(deps, "POST", "/api/sources/preautorisations", {
      headers: GUARD,
      body: { declencheur: "fantome", agentId: "agent-a", motif: "df -h" },
    });
    expect(inconnu.status).toBe(400);
    expect((inconnu.body as Record<string, unknown>)["code"]).toBe("unknown_source");

    const agentInconnu = await call(deps, "POST", "/api/sources/preautorisations", {
      headers: GUARD,
      body: { declencheur: "veille", agentId: "agent-z", motif: "df -h" },
    });
    expect(agentInconnu.status).toBe(400);
    expect((agentInconnu.body as Record<string, unknown>)["code"]).toBe("unknown_agent");

    const revoque = await call(deps, "POST", "/api/sources/preautorisations", {
      headers: GUARD,
      body: { declencheur: "veille", agentId: "agent-b", motif: "df -h" },
    });
    expect(revoque.status).toBe(400);
    expect((revoque.body as Record<string, unknown>)["code"]).toBe("revoked_agent");

    const joker = await call(deps, "POST", "/api/sources/preautorisations", {
      headers: GUARD,
      body: { declencheur: "veille", agentId: "agent-a", motif: "systemctl *", portee: "exacte" },
    });
    expect(joker.status).toBe(400);
    expect((joker.body as Record<string, unknown>)["code"]).toBe("invalid_motif");
    expect(String((joker.body as Record<string, unknown>)["message"])).toContain("joker");
  });

  it("crée une autorisation bornée (30 jours, une exécution) et l'expose", async () => {
    const { deps, registre } = rig();
    const creation = await call(deps, "POST", "/api/sources/preautorisations", {
      headers: GUARD,
      body: {
        declencheur: "veille",
        agentId: "agent-a",
        motif: "df -h",
        portee: "exacte",
        dureeJours: 30,
      },
    });
    expect(creation.status).toBe(201);
    const pre = (creation.body as Record<string, unknown>)["preAutorisation"] as Record<
      string,
      unknown
    >;
    expect(pre["motif"]).toBe("df -h");
    expect(pre["etat"]).toBe("active");
    expect(pre["consommations"]).toBe(0);
    expect(pre["agentNom"]).toBe("nuc00");
    expect(registre.size).toBe(1);

    // ⚠️ La colonne « pré-autorisations actives » de la page vient de LÀ.
    const liste = await call(deps, "GET", "/api/sources", { headers: GUARD });
    expect(liste.status).toBe(200);
    const sources = (liste.body as Record<string, unknown>)["sources"] as Array<
      Record<string, unknown>
    >;
    const veille = sources.find((source) => source["nom"] === "veille");
    expect(veille?.["preAutorisations"]).toEqual(["df -h (agent agent-a)"]);
  });

  it("révoque : l'état devient « revoquee » et la ligne RESTE listée", async () => {
    const { deps } = rig();
    const creation = await call(deps, "POST", "/api/sources/preautorisations", {
      headers: GUARD,
      body: { declencheur: "veille", agentId: "agent-a", motif: "df -h" },
    });
    const id = String(
      ((creation.body as Record<string, unknown>)["preAutorisation"] as Record<string, unknown>)[
        "id"
      ],
    );
    const revocation = await call(
      deps,
      "DELETE",
      `/api/sources/preautorisations/${encodeURIComponent(id)}`,
      { headers: GUARD },
    );
    expect(revocation.status).toBe(200);
    expect((revocation.body as Record<string, unknown>)["revoked"]).toBe(true);

    const liste = await call(deps, "GET", "/api/sources/preautorisations", { headers: GUARD });
    const items = (liste.body as Record<string, unknown>)["preAutorisations"] as Array<
      Record<string, unknown>
    >;
    expect(items).toHaveLength(1);
    expect(items[0]?.["etat"]).toBe("revoquee");
    expect(items[0]?.["revoqueeRaison"]).toContain("page de gestion");

    // Une révocation inconnue est un 404 explicite (jamais un silence).
    const inconnue = await call(deps, "DELETE", "/api/sources/preautorisations/pre_absent", {
      headers: GUARD,
    });
    expect(inconnue.status).toBe(404);
  });
});
