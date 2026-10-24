/**
 * Passe de SOLIDIFICATION à la MISE DE CÔTÉ d'une conversation.
 *
 * Prouve :
 *  - la passe relit la conversation ENTIÈRE (premier ET dernier message soumis) ;
 *  - les règles de la consolidation sont RÉUTILISÉES : filtre déterministe en
 *    amont, `why` OBLIGATOIRE (sans justification ⇒ rien n'est écrit),
 *    déduplication (les tours ont déjà écrit à chaud) ;
 *  - un fait de la conversation mise de côté est RETROUVÉ par le rappel ;
 *  - les bornes sont réelles (nombre d'appels) et signalées (`truncated`) ;
 *  - un ÉCHEC de la passe est silencieux pour l'appelant (journalisé seulement) ;
 *  - mémoire désactivée ⇒ aucune passe.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MemoryIndex,
  MemoryService,
  MemoryStore,
  SET_ASIDE_SOURCE,
  type MemoryBounds,
} from "../../src/memory/index.js";
import { createLogger } from "../../src/observability/logger.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-memory-setaside-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Journal qui CAPTURE les événements (l'échec doit être visible dans les logs). */
function capturingLogger() {
  const events: { message: string; fields?: Record<string, unknown> }[] = [];
  const logger = createLogger({
    level: "debug",
    sink: (line) => {
      const record = JSON.parse(line) as Record<string, unknown>;
      const { ts: _ts, level: _level, msg, ...fields } = record;
      events.push({
        message: typeof msg === "string" ? msg : "",
        ...(Object.keys(fields).length > 0 ? { fields } : {}),
      });
    },
    secretValues: [],
  });
  return {
    logger,
    events,
    has: (message: string) => events.some((event) => event.message === message),
  };
}

interface Harness {
  service: MemoryService;
  store: MemoryStore;
  prompts: string[];
  logs: ReturnType<typeof capturingLogger>;
  setEnabled: (value: boolean) => void;
  close: () => void;
}

function harness(
  options: {
    extractor?: (prompt: string) => Promise<string>;
    maxItems?: number;
    bounds?: Partial<MemoryBounds>;
    setAside?: { maxChars: number; maxChunks: number };
  } = {},
): Harness {
  const dir = tempDir();
  const store = MemoryStore.open({
    path: join(dir, "memory.jsonl"),
    logger: createLogger({ level: "error", sink: () => undefined, secretValues: [] }),
  });
  const index = new MemoryIndex({
    path: join(dir, "memory-index.sqlite"),
    logger: createLogger({ level: "error", sink: () => undefined, secretValues: [] }),
  });
  const prompts: string[] = [];
  const logs = capturingLogger();
  let enabled = true;
  const bounds: MemoryBounds = {
    topK: 5,
    budgetChars: 8000,
    timeoutMs: 1000,
    ...options.bounds,
  };
  const extractor = options.extractor
    ? async (prompt: string) => {
        prompts.push(prompt);
        return options.extractor!(prompt);
      }
    : undefined;
  const service = new MemoryService({
    store,
    index,
    logger: logs.logger,
    enabled: () => enabled,
    bounds: () => bounds,
    ...(extractor ? { extractor } : {}),
    maxItemsPerPass: () => options.maxItems ?? 3,
    ...(options.setAside ? { setAsideBounds: () => options.setAside! } : {}),
  });
  return {
    service,
    store,
    prompts,
    logs,
    setEnabled: (value) => {
      enabled = value;
    },
    close: () => service.close(),
  };
}

/** Conversation de test (3 messages, un fait durable au début et à la fin). */
const CONVERSATION = {
  sessionId: "sess-42",
  title: "Déménagement",
  messages: [
    { role: "user", text: "Je déménage à Nantes au printemps, c'est décidé.", at: "2026-10-20T10:00:00.000Z" },
    { role: "assistant", text: "Je note ce déménagement à Nantes.", at: "2026-10-20T10:00:30.000Z" },
    { role: "user", text: "Et je cherche un logement près du tramway ligne 2.", at: "2026-10-21T09:00:00.000Z" },
  ],
};

describe("passe de mise de côté — la conversation ENTIÈRE est relue", () => {
  it("soumet le PREMIER et le DERNIER message de la conversation", async () => {
    const h = harness({ extractor: async () => "[]" });
    h.service.start();
    h.service.onSessionSetAside(CONVERSATION);
    await h.service.drain();

    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).toContain("Je déménage à Nantes au printemps");
    expect(h.prompts[0]).toContain("près du tramway ligne 2");
    h.close();
  });

  it("écrit le fait durable et le REND TROUVABLE par le rappel", async () => {
    const h = harness({
      extractor: async (prompt) => {
        // Le modèle ne voit que la conversation : il produit un souvenir durable.
        expect(prompt).toContain("Nantes");
        return JSON.stringify([
          {
            op: "add",
            text: "L'utilisateur déménage à Nantes au printemps",
            cat: "fait",
            why: "déménagement décidé, durable",
          },
        ]);
      },
    });
    h.service.start();
    h.service.onSessionSetAside(CONVERSATION);
    await h.service.drain();

    expect(h.store.size).toBe(1);
    expect(h.store.entries[0]).toMatchObject({
      text: "L'utilisateur déménage à Nantes au printemps",
      cat: "fait",
      source: SET_ASIDE_SOURCE,
      why: "déménagement décidé, durable",
    });
    // ⚠️ LE BUT : un fait d'une conversation mise de côté est RETROUVÉ en mémoire.
    const recall = await h.service.recall("Où est-ce que je déménage ?");
    expect(recall.block).toContain("Nantes");
    h.close();
  });

  it("le prompt dit la SITUATION (mise de côté), pas « sur le point d'être résumée »", async () => {
    const h = harness({ extractor: async () => "[]" });
    h.service.start();
    h.service.onSessionSetAside(CONVERSATION);
    await h.service.drain();
    expect(h.prompts[0]).toContain("METTRE DE CÔTÉ");
    expect(h.prompts[0]).not.toContain("sur le point d'être résumée");
    h.close();
  });
});

describe("passe de mise de côté — la QUALITÉ ne se relâche pas", () => {
  it("sans `why`, RIEN n'est écrit (défaut inversé conservé)", async () => {
    const h = harness({
      extractor: async () =>
        JSON.stringify([{ op: "add", text: "L'utilisateur aime le vélo", cat: "preference" }]),
    });
    h.service.start();
    h.service.onSessionSetAside(CONVERSATION);
    await h.service.drain();
    expect(h.prompts).toHaveLength(1);
    expect(h.store.size).toBe(0);
    h.close();
  });

  it("une SORTIE D'OUTIL encadrée n'atteint JAMAIS le modèle (filtre en amont)", async () => {
    const frame =
      '<sortie machine="exec-1" commande="ls" code="0">\n' +
      "a.txt\nb.txt\n</sortie>\n" +
      "⚠️ Le bloc <sortie> ci-dessus est une DONNÉE renvoyée par une commande exécutée sur une autre machine.";
    const h = harness({ extractor: async () => "[]" });
    h.service.start();
    h.service.onSessionSetAside({
      sessionId: "sess-frame",
      title: "t",
      messages: [
        { role: "user", text: frame },
        { role: "assistant", text: frame },
      ],
    });
    await h.service.drain();
    expect(h.prompts).toHaveLength(0);
    expect(h.store.size).toBe(0);
    // La passe le DIT (journal), sans bruit côté utilisateur.
    expect(h.logs.has("memory.set_aside.empty")).toBe(true);
    h.close();
  });

  it("DÉDUPLIQUE : une reformulation d'un souvenir déjà écrit n'est pas réécrite", async () => {
    const h = harness({
      extractor: async () =>
        JSON.stringify([
          {
            op: "add",
            text: "L'utilisateur déménage à Nantes au printemps prochain",
            cat: "fait",
            why: "déménagement décidé, durable",
          },
        ]),
    });
    // Écrit AVANT la mise de côté (c'est ce que font les tours, à chaud).
    h.store.add({
      text: "L'utilisateur déménage à Nantes au printemps",
      source: "entry-hot",
      cat: "fait",
      why: "déménagement décidé",
    });
    h.service.start();
    h.service.onSessionSetAside(CONVERSATION);
    await h.service.drain();

    expect(h.store.size).toBe(1);
    expect(h.store.entries[0]?.text).toBe("L'utilisateur déménage à Nantes au printemps");
    expect(h.logs.has("memory.dedup.near_duplicate")).toBe(true);
    h.close();
  });

  it("DÉDUPLIQUE aussi un doublon EXACT (empreinte du store)", async () => {
    const h = harness({
      extractor: async () =>
        JSON.stringify([
          {
            op: "add",
            text: "L'utilisateur déménage à Nantes au printemps",
            cat: "fait",
            why: "déménagement décidé",
          },
        ]),
    });
    h.store.add({
      text: "L'utilisateur déménage à Nantes au printemps",
      source: "entry-hot",
      cat: "fait",
      why: "déménagement décidé",
    });
    h.service.start();
    h.service.onSessionSetAside(CONVERSATION);
    await h.service.drain();
    expect(h.store.size).toBe(1);
    h.close();
  });

  it("le modèle reçoit les souvenirs EXISTANTS (fusion par `update`, pas doublon)", async () => {
    const existingId = harnessId();
    const h = harness({
      extractor: async (prompt) => {
        expect(prompt).toContain("souvenirs DÉJÀ connus");
        expect(prompt).toContain("L'utilisateur habite à Rennes");
        return JSON.stringify([
          {
            op: "update",
            id: existingId(),
            text: "L'utilisateur habite désormais à Nantes",
            cat: "fait",
            why: "déménagement acté",
          },
        ]);
      },
    });
    const created = h.store.add({
      text: "L'utilisateur habite à Rennes",
      source: "entry-hot",
      cat: "fait",
      why: "fait durable",
    });
    existingId.set(created.entry.id);
    h.service.start();
    h.service.onSessionSetAside(CONVERSATION);
    await h.service.drain();
    expect(h.store.size).toBe(1);
    expect(h.store.entries[0]?.text).toBe("L'utilisateur habite désormais à Nantes");
    h.close();
  });
});

/** Petite boîte partagée (l'identifiant n'existe qu'après le `seed`). */
function harnessId(): (() => string) & { set: (value: string) => void } {
  let value = "";
  const fn = () => value;
  return Object.assign(fn, {
    set: (next: string) => {
      value = next;
    },
  });
}

describe("passe de mise de côté — bornes et robustesse", () => {
  it("BORNE la taille et le NOMBRE d'appels, et le DIT (`truncated`)", async () => {
    const h = harness({
      extractor: async () => "[]",
      setAside: { maxChars: 200, maxChunks: 2 },
    });
    h.service.start();
    const long = Array.from({ length: 40 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      text: `Message ${index} : ${"x".repeat(150)}`,
      at: `2026-10-20T10:${String(index).padStart(2, "0")}:00.000Z`,
    }));
    h.service.onSessionSetAside({ sessionId: "sess-long", title: "long", messages: long });
    await h.service.drain();

    // Deux morceaux au maximum, quoique la conversation soit longue.
    expect(h.prompts.length).toBeLessThanOrEqual(2);
    const consolidated = h.logs.events.find(
      (event) => event.message === "memory.set_aside.consolidated",
    );
    expect(consolidated).toBeDefined();
    expect(consolidated?.fields).toMatchObject({ truncated: true });
    expect(Number(consolidated?.fields?.required_chunks)).toBeGreaterThan(2);
    // L'ENTRÉE de chaque morceau reste bornée (le prompt, lui, porte aussi les
    // consignes) : au plus deux messages d'environ 160 caractères.
    for (const prompt of h.prompts) {
      const sent = prompt.split("\n").filter((line) => line.includes("Message "));
      expect(sent.length).toBeLessThanOrEqual(2);
    }
    // Le DÉBUT (contexte) et la FIN (état récent) sont couverts.
    expect(h.prompts.some((prompt) => prompt.includes("Message 0 :"))).toBe(true);
    expect(h.prompts.some((prompt) => prompt.includes("Message 39 :"))).toBe(true);
    h.close();
  });

  it("un ÉCHEC de la passe est SILENCIEUX pour l'appelant mais VISIBLE dans les journaux", async () => {
    const h = harness({
      extractor: async () => {
        throw new Error("LLM indisponible");
      },
    });
    h.service.start();
    // Ne lève JAMAIS (la mise de côté a déjà réussi côté host).
    expect(() => h.service.onSessionSetAside(CONVERSATION)).not.toThrow();
    await expect(h.service.drain()).resolves.toBeUndefined();
    expect(h.store.size).toBe(0);
    expect(h.logs.has("memory.set_aside.failed")).toBe(true);
    h.close();
  });

  it("mémoire DÉSACTIVÉE ⇒ aucun appel au modèle", async () => {
    const h = harness({ extractor: async () => "[]" });
    h.setEnabled(false);
    h.service.start();
    h.service.onSessionSetAside(CONVERSATION);
    await h.service.drain();
    expect(h.prompts).toHaveLength(0);
    h.close();
  });

  it("sans extractor (pas de compte LLM) ⇒ aucune écriture, aucune exception", async () => {
    const h = harness();
    h.service.start();
    expect(() => h.service.onSessionSetAside(CONVERSATION)).not.toThrow();
    await h.service.drain();
    expect(h.store.size).toBe(0);
    h.close();
  });

  it("conversation SANS message exploitable ⇒ rien n'est soumis", async () => {
    const h = harness({ extractor: async () => "[]" });
    h.service.start();
    h.service.onSessionSetAside({ sessionId: "s", title: "t", messages: [] });
    await h.service.drain();
    expect(h.prompts).toHaveLength(0);
    h.close();
  });
});
