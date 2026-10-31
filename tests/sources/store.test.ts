/**
 * `SourcesStore` — registre des SOURCES (volume `state`, `sources.json`).
 *
 * ⚠️ Ce module n'existait PAS avant ce chantier : la PREMIÈRE assertion de ce
 * fichier (`import`) échoue sur le code d'origine (module introuvable), comme
 * l'exige la consigne « le test doit échouer sur le code d'origine ».
 *
 * Ce qui est verrouillé ici :
 *  - le fichier est DÉDIÉ (jamais `config.json`) et écrit en 0600 ;
 *  - le NOM est validé (forme, noms réservés) ;
 *  - le plafond de 20 sources est un REFUS explicite ;
 *  - ⚠️ le JETON n'est JAMAIS dans le fichier (seulement sa date de création) ;
 *  - ⚠️ la DESTINATION par défaut est `aucune` : une source neuve ne démarre rien
 *    tant que l'utilisateur n'a pas choisi où ses messages arrivent ;
 *  - une destination peut être un MODE ou l'identifiant d'une conversation
 *    EXISTANTE (choisie par l'utilisateur), jamais un texte libre.
 */

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SourcesStore, validateConversation } from "../../src/sources/store.js";
import { MAX_SOURCES, sourceTokenName } from "../../src/sources/types.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeStore(now?: () => number): { store: SourcesStore; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "yuki-sources-store-"));
  dirs.push(dir);
  const path = join(dir, "sources.json");
  return { store: new SourcesStore({ path, ...(now ? { now } : {}) }), path };
}

describe("SourcesStore — création et persistance", () => {
  it("crée une source avec des réglages par défaut SÛRS (stocker, aucune destination)", () => {
    const { store } = makeStore();
    const source = store.create("agregateur");
    expect(source.nom).toBe("agregateur");
    // Par défaut : on n'interrompt PAS Yuki (aucun tour non demandé)…
    expect(source.tour).toBe("stocker");
    // …et surtout : AUCUNE destination. Une source neuve n'écrit nulle part tant
    // que l'utilisateur n'a pas choisi un fil (règle « C »).
    expect(source.conversation).toBe("aucune");
    expect(source.notifier).toBe(true);
    expect(source.consigne).toBe("");
  });

  it("persiste sur disque en 0600 et relit à l'identique", () => {
    const { store, path } = makeStore();
    store.create("veille", { consigne: "si rien d'anormal, ne dis rien", tour: "lancer" });
    // Le fichier est PRIVÉ (0600) : il décrit qui peut réveiller Yuki.
    expect(statSync(path).mode & 0o777).toBe(0o600);

    const reloaded = new SourcesStore({ path });
    const [source] = reloaded.list();
    expect(source.nom).toBe("veille");
    expect(source.consigne).toBe("si rien d'anormal, ne dis rien");
    expect(source.tour).toBe("lancer");
  });

  it("le fichier ne contient JAMAIS de jeton (seulement la date de création)", () => {
    const { store, path } = makeStore();
    store.create("mail");
    store.markTokenCreated("mail");
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain(sourceTokenName("mail"));
    expect(raw).not.toContain("YUKI_SOURCE_");
    expect(raw).toContain("jetonCree");
    // Le nom du secret, lui, est DÉRIVÉ (aucune valeur stockée ici).
    expect(sourceTokenName("mail")).toBe("YUKI_SOURCE_MAIL");
    expect(sourceTokenName("veille-news")).toBe("YUKI_SOURCE_VEILLE_NEWS");
  });
});

describe("SourcesStore — validation", () => {
  it("refuse un nom invalide (forme) avec un message en français", () => {
    const { store } = makeStore();
    expect(() => store.create("Agrégateur")).toThrow(/Nom de source invalide/);
    expect(() => store.create("")).toThrow(/Nom de source invalide/);
    expect(() => store.create("x".repeat(33))).toThrow(/Nom de source invalide/);
  });

  it("refuse le nom réservé « inbox » (route de la boîte de notifications)", () => {
    const { store } = makeStore();
    expect(() => store.create("inbox")).toThrow(/réservé/);
  });

  it("refuse un doublon au lieu d'écraser silencieusement", () => {
    const { store } = makeStore();
    store.create("news");
    expect(() => store.create("news")).toThrow(/existe déjà/);
  });

  it("refuse plus de 20 sources (refus explicite, aucune perte)", () => {
    const { store } = makeStore();
    for (let index = 0; index < MAX_SOURCES; index += 1) store.create(`s${index}`);
    expect(() => store.create("un-de-trop")).toThrow(/nombre maximal de sources/);
    expect(store.size).toBe(MAX_SOURCES);
  });

  it("refuse une consigne trop longue en citant la longueur réelle", () => {
    const { store } = makeStore();
    expect(() => store.create("news", { consigne: "a".repeat(2_001) })).toThrow(
      /Consigne trop longue : 2001 caractères, maximum 2000/,
    );
  });

  it("accepte une destination MODE ou l'identifiant d'une conversation, refuse le reste", () => {
    // Les modes.
    for (const mode of ["aucune", "source", "nouvelle", "courante"]) {
      expect(validateConversation(mode)).toBe(mode);
    }
    // L'identifiant d'une conversation EXISTANTE (choisi dans `/config`).
    expect(validateConversation("01J8ZQ4K3M7X2ABCDEF")).toBe("01J8ZQ4K3M7X2ABCDEF");
    // Un texte libre, un chemin, une valeur vide : REFUSÉS (jamais un repli muet).
    for (const invalid of ["", "un fil sympa", "../etc/passwd", "a/b", 42, null]) {
      expect(() => validateConversation(invalid)).toThrow(/Destination invalide/);
    }
    const { store } = makeStore();
    expect(() => store.create("news", { conversation: "a b" })).toThrow(/Destination invalide/);
    expect(store.create("veille", { conversation: "session-42" }).conversation).toBe("session-42");
  });

  it("changer de destination OUBLIE le fil dédié mémorisé (aucun héritage silencieux)", () => {
    const { store } = makeStore();
    store.create("news", { conversation: "source" });
    store.setSession("news", "fil-dedie");
    expect(store.get("news")?.sessionId).toBe("fil-dedie");
    // La destination change : l'ancienne ne doit pas continuer de recevoir.
    const updated = store.update("news", { conversation: "session-autre" });
    expect(updated.conversation).toBe("session-autre");
    expect(updated.sessionId).toBeUndefined();
  });

  it("PATCH partiel : un champ absent n'est pas modifié, un champ invalide est REFUSÉ", () => {
    const { store } = makeStore();
    store.create("news", { tour: "lancer", conversation: "courante" });
    const updated = store.update("news", { notifier: false });
    expect(updated.tour).toBe("lancer");
    expect(updated.notifier).toBe(false);
    expect(() =>
      store.update("news", { tour: "exploser" as unknown as "lancer" }),
    ).toThrow(/Tour invalide/);
    expect(() => store.update("inconnue", { notifier: true })).toThrow(/Source inconnue/);
  });
});

describe("SourcesStore — mémoire de la conversation dédiée", () => {
  it("mémorise puis retire la conversation dédiée (créée seulement sur demande)", () => {
    const { store } = makeStore();
    store.create("news");
    expect(store.get("news")?.sessionId).toBeUndefined();
    store.setSession("news", "session-1");
    expect(store.get("news")?.sessionId).toBe("session-1");
    store.setSession("news", undefined);
    expect(store.get("news")?.sessionId).toBeUndefined();
  });

  it("retrouve les sources qui postent dans un fil (modale de suppression)", () => {
    const { store } = makeStore();
    store.create("designee", { conversation: "session-42" });
    store.create("dediee", { conversation: "source" });
    store.setSession("dediee", "session-42");
    store.create("ailleurs", { conversation: "session-99" });
    expect(store.forSession("session-42").map((r) => r.nom).sort()).toEqual([
      "dediee",
      "designee",
    ]);
    expect(store.forSession("session-inconnue")).toEqual([]);
  });

  it("⚠️ la suppression d'un fil RÉAFFECTE ses sources (jamais supprimées)", () => {
    const { store } = makeStore();
    store.create("designee", { conversation: "session-42" });
    store.create("dediee", { conversation: "source" });
    store.setSession("dediee", "session-42");
    const affected = store.detachSession("session-42");
    expect(affected.map((r) => r.nom).sort()).toEqual(["dediee", "designee"]);
    // Les sources EXISTENT toujours, en « nouvelle conversation à chaque fois ».
    for (const nom of ["dediee", "designee"]) {
      expect(store.get(nom)?.conversation).toBe("nouvelle");
      expect(store.get(nom)?.sessionId).toBeUndefined();
    }
    // Un second appel est un no-op (idempotent).
    expect(store.detachSession("session-42")).toEqual([]);
  });

  it("note le dernier appel sans jamais y mettre un contenu", () => {
    const { store, path } = makeStore(() => Date.parse("2026-01-02T03:04:05.000Z"));
    store.create("news");
    store.markCall("news");
    expect(store.get("news")?.dernierAppel).toBe("2026-01-02T03:04:05.000Z");
    expect(readFileSync(path, "utf8")).not.toContain("texte");
  });
});
