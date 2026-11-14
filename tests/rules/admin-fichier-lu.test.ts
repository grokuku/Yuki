/**
 * ÉDITION DES RÈGLES COMMUNES — l'interface écrit LE FICHIER QU'ELLE LIT (lot 48).
 *
 * ⚠️ PANNE SILENCIEUSE CORRIGÉE : `PUT /api/self/rules` écrivait dans
 * `<state>/rules.md` (fichier d'instance) alors que l'injection lit d'abord
 * `<state>/bots/<id>/rules.md` (emplacement ACTUEL après la migration multi-bot).
 * L'enregistrement répondait 200… et le prompt ne changeait pas.
 *
 * Ce qui est VERROUILLÉ :
 *  ① la cible de l'écriture est celle de la LECTURE (fichier du bot s'il contient
 *    des règles, sinon fichier d'instance) ;
 *  ② GET dit `path` + `source` : l'interface peut afficher le fichier réellement
 *    lu et écrit ;
 *  ③ l'historique (20 versions) et le retour arrière portent sur CE fichier ;
 *  ④ les garde-fous d'écriture de `/api/config` restent appliqués.
 *
 * ⚠️ Ces tests ÉCHOUENT sur le code d'origine : le store écrit était
 * `RulesStore(<state>/rules.md)` quel que soit le fichier lu.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  handleRulesRequest,
  type RulesApiDeps,
} from "../../src/gateway/routes/rules.js";
import { createLogger } from "../../src/observability/logger.js";
import { ReglesAdminEffectives } from "../../src/rules/index.js";

const racines: string[] = [];

afterEach(() => {
  for (const dir of racines.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const ECRITURE = { "x-yuki-config": "1", "content-type": "application/json" };

function instance(): { state: string; rulesBot: string; rulesInstance: string } {
  const state = mkdtempSync(join(tmpdir(), "yuki-regles-admin-"));
  racines.push(state);
  mkdirSync(join(state, "bots", "yuki"), { recursive: true });
  return {
    state,
    rulesBot: join(state, "bots", "yuki", "rules.md"),
    rulesInstance: join(state, "rules.md"),
  };
}

function admin(chemins: { rulesBot: string; rulesInstance: string }): ReglesAdminEffectives {
  const logger = createLogger({ level: "error", sink: () => undefined, secretValues: [] });
  return new ReglesAdminEffectives({
    instancePath: chemins.rulesInstance,
    cheminBot: chemins.rulesBot,
    logger,
    secretValues: [],
  });
}

function deps(store: ReglesAdminEffectives): RulesApiDeps {
  return {
    store,
    logger: createLogger({ level: "error", sink: () => undefined, secretValues: [] }),
  };
}

describe("① la cible de l'écriture est le fichier LU", () => {
  it("règles dans le fichier DU BOT ⇒ l'écriture y va (et pas dans l'instance)", () => {
    const b = instance();
    writeFileSync(b.rulesBot, "Ancienne règle du bot.", "utf8");
    const store = admin(b);
    expect(store.emplacement()).toEqual({ chemin: b.rulesBot, portee: "bot", existe: true });

    store.write("Nouvelle règle du bot.", "user");

    expect(readFileSync(b.rulesBot, "utf8")).toBe("Nouvelle règle du bot.");
    expect(existsSync(b.rulesInstance)).toBe(false);
    expect(store.read().text).toBe("Nouvelle règle du bot.");
  });

  it("règles dans le fichier d'INSTANCE ⇒ l'écriture y va", () => {
    const b = instance();
    writeFileSync(b.rulesInstance, "Règle historique.", "utf8");
    const store = admin(b);
    expect(store.emplacement().portee).toBe("instance");

    store.write("Règle historique modifiée.", "user");

    expect(readFileSync(b.rulesInstance, "utf8")).toBe("Règle historique modifiée.");
    expect(existsSync(b.rulesBot)).toBe(false);
  });

  it("aucun fichier rempli ⇒ le fichier d'instance (PARTAGÉ) est créé et relu", () => {
    const b = instance();
    const store = admin(b);
    expect(store.emplacement()).toEqual({
      chemin: b.rulesInstance,
      portee: "instance",
      existe: false,
    });

    store.write("Règles communes.", "user");

    expect(readFileSync(b.rulesInstance, "utf8")).toBe("Règles communes.");
    // Et l'injection, elle, lit bien ce fichier (second candidat).
    expect(store.read().text).toBe("Règles communes.");
  });

  it("fichier du bot EXISTANT mais vide ⇒ c'est lui qui est rempli (déjà lu)", () => {
    const b = instance();
    writeFileSync(b.rulesBot, "", "utf8");
    const store = admin(b);
    const cible = store.emplacement();
    expect(cible.chemin).toBe(b.rulesBot);
    expect(cible.existe).toBe(true);

    store.write("Première règle.", "user");

    expect(readFileSync(b.rulesBot, "utf8")).toBe("Première règle.");
    expect(store.read().text).toBe("Première règle.");
  });
});

describe("② GET/PUT `/api/self/rules` — la zone d'édition fonctionne", () => {
  it("GET dit le fichier lu et sa provenance", () => {
    const b = instance();
    writeFileSync(b.rulesBot, "Règle du bot.", "utf8");
    const reponse = handleRulesRequest({
      method: "GET",
      path: "/api/self/rules",
      headers: {},
      body: "",
      deps: deps(admin(b)),
    });

    expect(reponse.status).toBe(200);
    const body = reponse.body as { text: string; path?: string; source?: string };
    expect(body.text).toBe("Règle du bot.");
    expect(body.path).toBe(b.rulesBot);
    expect(body.source).toBe("bot");
  });

  it("PUT sans en-tête de garde est REFUSÉ (aucune écriture)", () => {
    const b = instance();
    const reponse = handleRulesRequest({
      method: "PUT",
      path: "/api/self/rules",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Intrusion." }),
      deps: deps(admin(b)),
    });

    expect(reponse.status).toBe(403);
    expect(existsSync(b.rulesInstance)).toBe(false);
    expect(existsSync(b.rulesBot)).toBe(false);
  });

  it("PUT écrit le fichier LU et le renvoie relu", () => {
    const b = instance();
    writeFileSync(b.rulesBot, "Avant.", "utf8");
    const store = admin(b);
    const reponse = handleRulesRequest({
      method: "PUT",
      path: "/api/self/rules",
      headers: ECRITURE,
      body: JSON.stringify({ text: "Après." }),
      deps: deps(store),
    });

    expect(reponse.status).toBe(200);
    const body = reponse.body as { text: string; path?: string };
    expect(body.text).toBe("Après.");
    expect(body.path).toBe(b.rulesBot);
    expect(readFileSync(b.rulesBot, "utf8")).toBe("Après.");
  });
});

describe("③ historique (20 versions) et retour arrière sur le fichier LU", () => {
  it("chaque écriture est versionnée, et `revert` restaure la précédente", () => {
    const b = instance();
    writeFileSync(b.rulesBot, "v1", "utf8");
    const store = admin(b);

    store.write("v2", "user");
    store.write("v3", "user");
    const historique = store.history(20).map((entree) => entree.text);
    expect(historique).toContain("v2");
    expect(historique).toContain("v3");

    const retour = store.revert("user");
    expect(retour?.text).toBe("v2");
    expect(readFileSync(b.rulesBot, "utf8")).toBe("v2");
    expect(store.read().text).toBe("v2");
  });

  it("la borne du domaine s'applique aux écritures (8 000 caractères, signalé)", () => {
    const b = instance();
    const store = admin(b);
    const resultat = store.write("a".repeat(8_500), "user");
    expect(resultat.truncated).toBe(true);
    expect(resultat.chars).toBe(8_000);
  });
});
