/**
 * Store des RÉACTIONS — persistance À PART, corrélation STABLE, régularités.
 *
 * Ce que ce fichier prouve :
 *  - une réaction est rattachée à `(sessionId, entryId)` — l'identifiant
 *    d'ENTRÉE DE SESSION du message, celui des `yuki.run_metrics` (`parentId`) :
 *    aucun identifiant parallèle n'est inventé ;
 *  - elle SURVIT au rechargement (réouverture du journal) et le changement /
 *    retrait fonctionne ;
 *  - une réaction ISOLÉE ne produit AUCUNE régularité (donc aucun souvenir) ;
 *    la même réaction sur N messages distincts en produit une, aux multiples du
 *    seuil ;
 *  - une ligne de journal illisible n'empêche jamais le démarrage.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ReactionStore } from "../../src/reactions/store.js";
import { REACTIONS, REACTION_REGULARITY_MIN } from "../../src/reactions/types.js";

const dirs: string[] = [];

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-reactions-"));
  dirs.push(dir);
  return join(dir, "reactions.jsonl");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ReactionStore — corrélation et persistance", () => {
  it("rattache une réaction au MESSAGE (session + entryId) et la relit après réouverture", () => {
    const path = tempFile();
    const store = ReactionStore.open({ path });
    expect(store.set("s1", "e-1", "trop-long")).toBeNull();

    expect(store.get("s1", "e-1")).toBe("trop-long");
    // Une AUTRE conversation ne voit rien (jamais de fuite entre fils).
    expect(store.get("s2", "e-1")).toBeUndefined();

    // RECHARGEMENT : le journal est la source de vérité.
    const reopened = ReactionStore.open({ path });
    expect(reopened.get("s1", "e-1")).toBe("trop-long");
    expect([...reopened.forSession("s1").entries()]).toEqual([["e-1", "trop-long"]]);
  });

  it("change de réaction (une seule par message) puis la retire", () => {
    const store = ReactionStore.open({ path: tempFile() });
    store.set("s1", "e-1", "trop-long");
    store.set("s1", "e-1", "utile");

    expect(store.size).toBe(1);
    expect(store.get("s1", "e-1")).toBe("utile");

    expect(store.clear("s1", "e-1")).toBe(true);
    expect(store.get("s1", "e-1")).toBeUndefined();
    expect(store.forSession("s1").size).toBe(0);
    // Retrait idempotent : un second retrait ne casse rien.
    expect(store.clear("s1", "e-1")).toBe(false);
  });

  it("refuse un identifiant de réaction inconnu (aucun état fantôme)", () => {
    const store = ReactionStore.open({ path: tempFile() });
    expect(store.set("s1", "e-1", "pas-une-reaction")).toBeNull();
    expect(store.size).toBe(0);
  });

  it("ne journalise JAMAIS de texte : uniquement session, message et réaction", () => {
    const path = tempFile();
    const store = ReactionStore.open({ path });
    store.set("s1", "e-1", "faux");
    const journal = readFileSync(path, "utf8");
    expect(journal).toContain('"t":"set"');
    expect(journal).toContain('"entryId":"e-1"');
    expect(journal).not.toContain("text");
  });

  it("tolère une ligne illisible (une réaction perdue ne casse pas le démarrage)", () => {
    const path = tempFile();
    writeFileSync(
      path,
      `${JSON.stringify({ v: 1, t: "set", sessionId: "s1", entryId: "e-1", reaction: "utile", at: "2026-01-01T00:00:00.000Z" })}\n` +
        "pas du json\n" +
        `${JSON.stringify({ v: 1, t: "set", sessionId: "s1", entryId: "e-2", reaction: "inconnue", at: "2026-01-01T00:00:00.000Z" })}\n`,
      "utf8",
    );
    const store = ReactionStore.open({ path });
    expect(store.size).toBe(1);
    expect(store.get("s1", "e-1")).toBe("utile");
  });
});

describe("ReactionStore — récentes et bornes du prompt", () => {
  it("borne par conversation AVANT la fenêtre (une autre ne la vide pas)", () => {
    const store = ReactionStore.open({ path: tempFile() });
    store.set("s1", "e-1", "utile");
    // Une autre conversation, très active, ne doit pas évincer s1.
    for (let index = 0; index < 12; index += 1) {
      store.set("s2", `x-${index}`, "faux");
    }
    expect(store.recentFor("s1", 8).map((view) => view.entryId)).toEqual(["e-1"]);
    expect(store.recentFor("s2", 3)).toHaveLength(3);
  });

  it("renvoie les N dernières, une par message, de la plus ancienne à la plus récente", () => {
    const store = ReactionStore.open({ path: tempFile() });
    store.set("s1", "e-1", "utile");
    store.set("s1", "e-2", "faux");
    store.set("s1", "e-3", "fatigue");
    // Changer une réaction la replace en tête de récence.
    store.set("s1", "e-1", "trop-long");

    const recent = store.recent(2);
    expect(recent.map((view) => view.entryId)).toEqual(["e-3", "e-1"]);
    expect(store.recent(10).map((view) => view.entryId)).toEqual(["e-2", "e-3", "e-1"]);
    // `recentFor` filtre par conversation (l'extension SDK lit par session).
    expect(store.recentFor("s1", 10)).toHaveLength(3);
    expect(store.recentFor("autre", 10)).toHaveLength(0);
  });
});

describe("ReactionStore — une réaction ISOLÉE n'est pas un souvenir", () => {
  it("ne déclenche AUCUNE régularité avant le seuil", () => {
    const store = ReactionStore.open({ path: tempFile() });
    const seen: number[] = [];
    for (let index = 1; index < REACTION_REGULARITY_MIN; index += 1) {
      const regularity = store.set("s1", `e-${index}`, "trop-long");
      expect(regularity).toBeNull();
      seen.push(index);
    }
    expect(seen).toHaveLength(REACTION_REGULARITY_MIN - 1);
  });

  it("déclenche UNE régularité au seuil, puis aux MULTIPLES du seuil seulement", () => {
    const store = ReactionStore.open({ path: tempFile() });
    const counts: number[] = [];
    for (let index = 1; index <= REACTION_REGULARITY_MIN * 2; index += 1) {
      const regularity = store.set("s1", `e-${index}`, "trop-long");
      if (regularity) counts.push(regularity.count);
    }
    expect(counts).toEqual([REACTION_REGULARITY_MIN, REACTION_REGULARITY_MIN * 2]);
  });

  it("ne compte qu'UNE fois par message (changer d'avis ne gonfle pas le compte)", () => {
    const store = ReactionStore.open({ path: tempFile() });
    store.set("s1", "e-1", "faux");
    store.set("s1", "e-1", "utile");
    store.set("s1", "e-1", "faux");
    expect(store.regularityOf("faux")).toBeNull();
    expect(store.regularityOf("utile")).toBeNull();
  });

  it("des réactions de registres DIFFÉRENTS ne se cumulent pas", () => {
    const store = ReactionStore.open({ path: tempFile() });
    store.set("s1", "e-1", "trop-long");
    store.set("s1", "e-2", "trop-long");
    store.set("s1", "e-3", "fatigue");
    expect(store.regularityOf("trop-long")).toBeNull();
    expect(store.regularityOf("fatigue")).toBeNull();
  });
});

describe("ReactionStore — catalogue", () => {
  it("expose trois registres et des identifiants uniques", () => {
    const ids = REACTIONS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(REACTIONS.map((item) => item.group))).toEqual(
      new Set(["judgement", "emotion", "mood"]),
    );
  });
});
