/**
 * JOURNAL des déclencheurs silencieux (`declencheurs-journal.jsonl`).
 *
 * ⚠️ Ce journal est la SEULE trace d'un déclencheur silencieux : il ne s'affiche
 * jamais dans l'interface de conversation. Il doit donc être borné et purgé.
 *
 * Ce qui est verrouillé ici :
 *  - format JSONL append-only, mode 0600 ;
 *  - ⚠️ contenu BORNÉ à 8 000 caractères (troncature DITE) ;
 *  - ⚠️ purge à 30 jours, réécriture atomique, lignes illisibles CONSERVÉES ;
 *  - les quatre événements `recu` / `silence` / `publie` / `echec` ;
 *  - `recent()` rend les plus récents d'abord et ne relit que la fin du fichier.
 *
 * ⚠️ Ces tests échouent sur le code d'origine : le module n'existe pas (l'import
 * casse).
 */

import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DeclencheurJournal,
  JOURNAL_RETENTION_DAYS,
  MAX_JOURNAL_CONTENT_CHARS,
  boundJournalContent,
} from "../../src/sources/journal.js";

const dirs: string[] = [];
const JOUR_MS = 86_400_000;

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeJournal(now?: () => number): { journal: DeclencheurJournal; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "yuki-declencheurs-journal-"));
  dirs.push(dir);
  const path = join(dir, "declencheurs-journal.jsonl");
  return { journal: DeclencheurJournal.open({ path, ...(now ? { now } : {}) }), path };
}

describe("DeclencheurJournal — bornes et événements", () => {
  it("écrit une ligne JSONL par événement, en 0600", () => {
    const { journal, path } = makeJournal();
    journal.append({ event: "recu", source: "veille", texte: "3 articles", octets: 10 });
    journal.append({ event: "silence", source: "veille" });
    journal.append({ event: "publie", source: "ci", texte: "la CI est rouge", sessionId: "s-1" });
    journal.append({ event: "echec", source: "mail", raison: "PI_NOT_READY" });

    expect(statSync(path).mode & 0o777).toBe(0o600);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(4);
    const events = lines.map((line) => (JSON.parse(line) as { event: string }).event);
    expect(events).toEqual(["recu", "silence", "publie", "echec"]);

    // `recent()` rend les plus récents D'ABORD.
    expect(journal.recent(2).map((record) => record.event)).toEqual(["echec", "publie"]);
  });

  it("borne le contenu à 8 000 caractères et DIT la troncature", () => {
    const { journal } = makeJournal();
    const texte = "é".repeat(MAX_JOURNAL_CONTENT_CHARS + 1_000);
    const record = journal.append({ event: "recu", source: "veille", texte });
    expect(MAX_JOURNAL_CONTENT_CHARS).toBe(8_000);
    expect(record.texte?.length).toBe(MAX_JOURNAL_CONTENT_CHARS);
    expect(record.tronque).toBe(true);
    // Un contenu plus court passe intact.
    expect(boundJournalContent("court")).toEqual({ texte: "court" });
  });

  it("purge les lignes plus vieilles que 30 jours et garde les récentes", () => {
    const start = Date.parse("2026-11-04T12:00:00.000Z");
    let now = start;
    const { journal, path } = makeJournal(() => now);

    // Une ligne de 40 jours (périmée) écrite à la main : la purge doit la retirer.
    const vieille = new Date(start - 40 * JOUR_MS).toISOString();
    appendFileSync(
      path,
      `${JSON.stringify({ ts: vieille, event: "recu", source: "vieux", texte: "x" })}\n`,
      "utf8",
    );
    journal.append({ event: "recu", source: "recent", texte: "y" });
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2);

    // Une heure plus tard, la purge automatique s'applique.
    now = start + 3_600_001;
    const dropped = journal.purge();
    expect(dropped).toBe(1);
    expect(JOURNAL_RETENTION_DAYS).toBe(30);
    const restant = journal.recent(10);
    expect(restant.map((record) => record.source)).toEqual(["recent"]);
  });

  it("CONSERVE une ligne illisible (on ne détruit pas ce qu'on ne comprend pas)", () => {
    const start = Date.parse("2026-11-04T12:00:00.000Z");
    const { journal, path } = makeJournal(() => start);
    appendFileSync(path, "ceci n'est pas du JSON\n", "utf8");
    journal.append({ event: "silence", source: "veille" });
    expect(journal.purge()).toBe(0);
    expect(readFileSync(path, "utf8")).toContain("ceci n'est pas du JSON");
  });

  it("ne crée rien à la lecture quand le fichier n'existe pas", () => {
    const dir = mkdtempSync(join(tmpdir(), "yuki-declencheurs-journal-"));
    dirs.push(dir);
    const path = join(dir, "absent.jsonl");
    const journal = DeclencheurJournal.open({ path });
    expect(journal.recent(5)).toEqual([]);
    expect(existsSync(path)).toBe(false);
  });
});
