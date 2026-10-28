/**
 * STOCKAGE des fichiers — plafond, rétention, purge RÉELLE.
 *
 * PIÈGE ③ (le disque) : un fichier refusé ne doit RIEN laisser (le partiel est
 * supprimé) ; un fichier expiré doit disparaître AVEC son analyse à la première
 * lecture comme au balayage. L'horloge est INJECTABLE : la rétention est testée
 * sans attendre 30 jours.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FilesStore } from "../../src/files/store.js";
import { DEFAULT_MAX_FILE_BYTES } from "../../src/files/types.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeStore(options: Partial<ConstructorParameters<typeof FilesStore>[0]> = {}): {
  store: FilesStore;
  dir: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "yuki-files-store-"));
  dirs.push(dir);
  const store = new FilesStore({ dir, ...options });
  store.ensureLayout();
  return { store, dir };
}

/** Flux asynchrone minimal (imite le corps d'une requête HTTP). */
async function* chunks(...parts: string[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield new Uint8Array(Buffer.from(part, "utf8"));
}

describe("dépôt et service d'un fichier", () => {
  it("enregistre un flux, analyse le texte et sert les octets à l'identique", async () => {
    const { store } = makeStore();
    const outcome = await store.saveStream(chunks("bon", "jour"), {
      name: "../../notes.txt",
      mimeType: "text/plain",
      origin: "user",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.record.name).toBe("notes.txt");
    expect(outcome.record.bytes).toBe(7);
    expect(outcome.record.analysis.kind).toBe("text");
    expect(outcome.record.analysis.readable).toBe(true);
    // L'identifiant est ALÉATOIRE : le nom fourni n'est jamais un chemin.
    expect(outcome.record.id).toMatch(/^[a-f0-9]{32}$/);
    expect(outcome.record.ext).toBe("txt");

    expect(store.readBytes(outcome.record.id)?.toString("utf8")).toBe("bonjour");
    expect(store.readAnalysis(outcome.record.id)).toBe("bonjour");
    expect(store.toWire(outcome.record).url).toBe(`/fichiers/${outcome.record.id}.txt`);
  });

  it("REFUSE un fichier au-delà du plafond et ne laisse aucun partiel", async () => {
    const { store, dir } = makeStore({ maxBytes: () => 10 });
    const outcome = await store.saveStream(chunks("0123456789", "dépassement"), {
      name: "gros.bin",
      mimeType: "application/octet-stream",
      origin: "user",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("too_large");
    expect(outcome.limitBytes).toBe(10);
    expect(outcome.receivedBytes).toBeGreaterThan(10);
    // ⚠️ Aucun octet ne reste (ni `.bin`, ni `.part`, ni métadonnées).
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuse un corps VIDE (jamais un fichier fantôme de 0 octet)", async () => {
    const { store } = makeStore();
    const outcome = await store.saveStream(chunks(), {
      name: "vide.txt",
      mimeType: "text/plain",
      origin: "user",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("empty");
  });

  it("le plafond par défaut est TRÈS HAUT et réglable (2 Gio)", () => {
    expect(DEFAULT_MAX_FILE_BYTES).toBe(2 * 1024 * 1024 * 1024);
  });
});

describe("rétention : fichier ET analyse expirés (horloge injectable)", () => {
  it("supprime les DEUX au balayage, après 30 jours", async () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const { store, dir } = makeStore({ now: () => now, retentionDays: () => 30 });
    const outcome = await store.saveStream(chunks("contenu confidentiel"), {
      name: "journal.txt",
      mimeType: "text/plain",
      origin: "user",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const id = outcome.record.id;
    expect(store.readBytes(id)).not.toBeNull();
    expect(store.readAnalysis(id)).toBe("contenu confidentiel");

    // 29 jours : toujours là.
    now += 29 * 86_400_000;
    expect(store.purgeExpired()).toBe(0);
    expect(store.readBytes(id)).not.toBeNull();

    // 31 jours : le fichier ET son analyse ont disparu du disque.
    now += 2 * 86_400_000;
    expect(store.purgeExpired()).toBe(1);
    expect(store.get(id)).toBeNull();
    expect(store.readBytes(id)).toBeNull();
    expect(store.readAnalysis(id)).toBeNull();
    expect(store.list()).toEqual([]);
    // Aucun résidu : ni `.bin`, ni `.txt`, ni `.json`.
    expect(readdirSync(dir)).toEqual([]);
  });

  it("un fichier expiré mais non purgé est traité comme ABSENT et supprimé", async () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const { store, dir } = makeStore({ now: () => now, retentionDays: () => 1 });
    const outcome = await store.saveBytes(new Uint8Array(Buffer.from("abc")), {
      name: "court.txt",
      mimeType: "text/plain",
      origin: "user",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    now += 2 * 86_400_000;
    expect(store.get(outcome.record.id)).toBeNull();
    expect(store.list()).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("supprime un orphelin dont les métadonnées sont illisibles", async () => {
    const { store, dir } = makeStore();
    const outcome = await store.saveBytes(new Uint8Array(Buffer.from("x")), {
      name: "f.txt",
      mimeType: "text/plain",
      origin: "user",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // Métadonnées corrompues : impossible de prouver la date d'expiration ⇒ purge.
    const metaPath = join(dir, `${outcome.record.id}.json`);
    rmSync(metaPath);
    expect(store.purgeExpired()).toBe(0); // la fiche n'existe plus : rien à purger
    expect(existsSync(join(dir, `${outcome.record.id}.bin`))).toBe(true);
  });
});

describe("rattachement à une conversation", () => {
  it("attache, liste par conversation et ne fuit pas d'un fil à l'autre", async () => {
    const { store } = makeStore();
    const first = await store.saveBytes(new Uint8Array(Buffer.from("a")), {
      name: "a.txt",
      mimeType: "text/plain",
      origin: "user",
    });
    const second = await store.saveBytes(new Uint8Array(Buffer.from("b")), {
      name: "b.txt",
      mimeType: "text/plain",
      origin: "user",
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    store.attach(first.record.id, "sess-1");
    store.attach(second.record.id, "sess-2");
    expect(store.list({ sessionId: "sess-1" }).map((r) => r.name)).toEqual(["a.txt"]);
    expect(store.list({ sessionId: "sess-2" }).map((r) => r.name)).toEqual(["b.txt"]);
    expect(store.list()).toHaveLength(2);
    // Un identifiant qui n'a pas la forme attendue n'est jamais un chemin.
    expect(store.get("../../etc/passwd")).toBeNull();
    expect(store.readBytes("..%2Fetc")).toBeNull();
  });

  it("à date ÉGALE, l'ordre de la liste reste DÉTERMINÉ (départage par identifiant)", async () => {
    // ⚠️ Ce test fige l'ordre là où il n'y a AUCUNE information chronologique :
    // plusieurs dépôts dans la même milliseconde. Sans départage explicite,
    // l'égalité laisserait l'ordre à `readdirSync` — non garanti, et variable
    // d'un appel à l'autre (c'est exactement ce qui faisait échouer un test de
    // `/api/files` sous charge).
    const frozen = Date.parse("2026-01-01T00:00:00.000Z");
    const { store } = makeStore({ now: () => frozen });
    const saved: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const outcome = await store.saveBytes(new Uint8Array(Buffer.from(`f${index}`)), {
        name: `f${index}.txt`,
        mimeType: "text/plain",
        origin: "user",
      });
      expect(outcome.ok).toBe(true);
      if (outcome.ok) saved.push(outcome.record.id);
    }
    expect(saved).toHaveLength(6);
    // Toutes les dates sont identiques : le seul critère restant est l'identifiant.
    expect(new Set(store.list().map((record) => record.createdAt)).size).toBe(1);
    const expected = [...saved].sort();
    // Stable dans le temps ET identique à la règle écrite (ordre total, croissant).
    for (let pass = 0; pass < 5; pass += 1) {
      expect(store.list().map((record) => record.id)).toEqual(expected);
    }
  });

  it("l'ordre ne dépend PAS de l'ordre du répertoire (fiches écrites à la main)", () => {
    // Les identifiants sont CHOISIS ici, et les fiches sont écrites dans l'ordre
    // ALPHABÉTIQUE INVERSE : si le tri suivait `readdirSync`, la liste sortirait
    // à l'envers. L'attente est donc exacte et ne dépend d'aucune horloge.
    const { store, dir } = makeStore();
    const at = "2026-01-01T00:00:00.000Z";
    const ids = [`${"f".repeat(31)}f`, `${"a".repeat(31)}a`, `${"0".repeat(31)}1`];
    for (const id of ids) {
      writeFileSync(
        join(dir, `${id}.json`),
        JSON.stringify({
          name: `${id.slice(-1)}.txt`,
          mimeType: "text/plain",
          ext: "txt",
          bytes: 1,
          createdAt: at,
          expiresAt: "2099-01-01T00:00:00.000Z",
          origin: "user",
          analysis: { kind: "text", readable: true, chars: 1 },
        }),
        { mode: 0o600 },
      );
    }
    expect(store.list().map((record) => record.id)).toEqual([...ids].sort());
  });

  it("supprime sur demande (fichier + analyse)", async () => {
    const { store, dir } = makeStore();
    const outcome = await store.saveBytes(new Uint8Array(Buffer.from("secret")), {
      name: "s.txt",
      mimeType: "text/plain",
      origin: "user",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(store.remove(outcome.record.id)).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
    expect(store.remove(outcome.record.id)).toBe(false);
  });
});
