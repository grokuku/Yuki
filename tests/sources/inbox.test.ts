/**
 * `SourcesInbox` — boîte « Notifications » (volume `state`, `sources-inbox.json`).
 *
 * ⚠️ Module INEXISTANT sur le code d'origine (l'import échoue) : la preuve
 * d'échec initial est donc immédiate.
 *
 * Ce qui est verrouillé ici :
 *  - les messages de sources ne sont PAS des bulles : ils vivent dans cette boîte ;
 *  - la boîte est BORNÉE (200) et le dépassement est un REFUS explicite — aucune
 *    entrée existante n'est écrasée ;
 *  - le compteur de non-lus et le marquage « lu » ;
 *  - la réponse de Yuki est attachée à la MÊME entrée ;
 *  - l'idempotence `(source, id)` survit à un redémarrage (7 jours).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { InboxFullError, SourcesInbox } from "../../src/sources/inbox.js";
import { MAX_INBOX_ENTRIES } from "../../src/sources/types.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeInbox(options: { now?: () => number; maxEntries?: number } = {}): {
  inbox: SourcesInbox;
  path: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "yuki-sources-inbox-"));
  dirs.push(dir);
  const path = join(dir, "sources-inbox.json");
  return {
    inbox: new SourcesInbox({
      path,
      ...(options.now ? { now: options.now } : {}),
      ...(options.maxEntries ? { maxEntries: options.maxEntries } : {}),
    }),
    path,
  };
}

function add(inbox: SourcesInbox, texte: string, extra: { source?: string; id?: string } = {}) {
  return inbox.add({
    source: extra.source ?? "news",
    texte,
    titre: "Titre",
    octets: Buffer.byteLength(texte, "utf8"),
    enAttente: true,
    ...(extra.id ? { sourceId: extra.id } : {}),
  });
}

describe("SourcesInbox — entrées, états et non-lus", () => {
  it("les entrées arrivent en TÊTE (la plus récente d'abord) et sont non lues", () => {
    const { inbox } = makeInbox();
    add(inbox, "premier");
    add(inbox, "deuxième");
    const entries = inbox.list();
    expect(entries.map((entry) => entry.texte)).toEqual(["deuxième", "premier"]);
    expect(entries[0].etat).toBe("recu");
    expect(entries[0].lu).toBe(false);
    expect(inbox.unreadCount()).toBe(2);
  });

  it("marque une entrée lue (compteur) et refuse un identifiant inconnu sans lever", () => {
    const { inbox } = makeInbox();
    const entry = add(inbox, "coucou");
    expect(inbox.markRead(entry.id)?.lu).toBe(true);
    expect(inbox.unreadCount()).toBe(0);
    expect(inbox.markRead("inconnue")).toBeUndefined();
  });

  it("attache la RÉPONSE de Yuki à la même entrée et passe l'état à « traite »", () => {
    const { inbox } = makeInbox();
    const entry = add(inbox, "résume les news");
    const updated = inbox.update(entry.id, { etat: "traite", reponse: "Rien d'anormal ce matin." });
    expect(updated?.etat).toBe("traite");
    expect(updated?.reponse).toBe("Rien d'anormal ce matin.");
    // La réponse survit au rechargement (même fichier, même entrée).
    const reloaded = new SourcesInbox({ path: inbox.path });
    expect(reloaded.get(entry.id)?.reponse).toBe("Rien d'anormal ce matin.");
  });

  it("tronque une réponse démesurée en le DISANT (jamais silencieusement)", () => {
    const { inbox } = makeInbox();
    const entry = add(inbox, "x");
    inbox.update(entry.id, { reponse: "a".repeat(9_000) });
    const stored = inbox.get(entry.id)?.reponse ?? "";
    expect(stored.length).toBeLessThan(9_000);
    expect(stored).toContain("réponse tronquée");
  });
});

describe("SourcesInbox — borne de 200 entrées (refus explicite)", () => {
  it("refuse la 201e entrée avec `InboxFullError`, sans écraser les 200 premières", () => {
    const { inbox } = makeInbox({ maxEntries: MAX_INBOX_ENTRIES });
    expect(inbox.limit).toBe(MAX_INBOX_ENTRIES);
    for (let index = 0; index < MAX_INBOX_ENTRIES; index += 1) add(inbox, `message-${index}`);
    expect(inbox.size).toBe(MAX_INBOX_ENTRIES);
    expect(() => add(inbox, "un-de-trop")).toThrow(InboxFullError);
    // ⚠️ AUCUNE perte muette : la plus ancienne est toujours là.
    expect(inbox.list().some((entry) => entry.texte === "message-0")).toBe(true);
    expect(inbox.size).toBe(MAX_INBOX_ENTRIES);
  });

  it("le message de refus dit quoi faire (aucune perte, rien d'écrasé)", () => {
    const { inbox } = makeInbox({ maxEntries: 1 });
    add(inbox, "seul");
    expect(() => add(inbox, "trop")).toThrow(/boîte de notifications est pleine \(1 entrées\)/);
    expect(() => add(inbox, "trop")).toThrow(/aucun message n'a été perdu/);
  });

  it("supprimer une entrée libère une place (choix explicite de l'utilisateur)", () => {
    const { inbox } = makeInbox({ maxEntries: 1 });
    const entry = add(inbox, "seul");
    expect(inbox.remove(entry.id)?.texte).toBe("seul");
    expect(inbox.remove(entry.id)).toBeUndefined();
    expect(() => add(inbox, "nouveau")).not.toThrow();
  });
});

describe("SourcesInbox — drain groupé et idempotence", () => {
  it("`pending()` ne rend que les entrées en attente, du plus ancien au plus récent", () => {
    const { inbox } = makeInbox({ now: () => Date.parse("2026-02-01T10:00:00.000Z") });
    const first = add(inbox, "un");
    const second = add(inbox, "deux");
    expect(inbox.pending().map((entry) => entry.id)).toEqual([first.id, second.id]);
    inbox.markDelivered([first.id, second.id]);
    expect(inbox.pending()).toEqual([]);
    // Une entrée DÉJÀ traitée n'est jamais reprise.
    expect(inbox.list().every((entry) => entry.enAttente === false)).toBe(true);
  });

  it("mémorise `(source, id)` et purge au-delà de 7 jours", () => {
    // Horloge RELATIVE à l'instant réel : la fenêtre d'idempotence est comparée
    // à l'heure de l'instance, une date figée dans le passé serait déjà purgée.
    let now = Date.now();
    const { inbox, path } = makeInbox({ now: () => now });
    add(inbox, "un", { id: "msg-1" });
    inbox.markSeen("news", "msg-1");
    expect(inbox.hasSeen("news", "msg-1")).toBe(true);
    // Une AUTRE source avec le même identifiant n'est pas un doublon.
    expect(inbox.hasSeen("mail", "msg-1")).toBe(false);
    // Survit au redémarrage.
    expect(new SourcesInbox({ path, now: () => now }).hasSeen("news", "msg-1")).toBe(true);
    // Après 7 jours + 1 minute, la clé est purgée (aucun contenu conservé).
    now += 7 * 24 * 60 * 60 * 1000 + 60_000;
    expect(new SourcesInbox({ path, now: () => now }).hasSeen("news", "msg-1")).toBe(false);
  });
});
