/**
 * LOT 40 — UN ANNUAIRE D'AGENTS PAR BOT (`lister_agents`/`etat_agent`).
 *
 * ⚠️ Ce test ÉCHOUE sur le code d'origine : `src/agents/directories-bots.ts`
 * n'existe pas, et `main()` ne construisait qu'UN annuaire dont `botCourant`
 * était figé sur le bot de la PILE. Un run de `kohai` listait donc, via
 * `lister_agents`, les machines autorisées pour `yuki` — que `kohai` n'a pas le
 * droit d'utiliser.
 *
 * Ce qui est verrouillé ici :
 *  ① deux bots, un agent autorisé pour l'un seulement ⇒ `pour(bot).list()` ne
 *    cite jamais l'agent de l'autre ;
 *  ② `pour()` ne rend JAMAIS l'annuaire d'un autre bot : un bot inconnu du
 *    démarrage obtient le SIEN (créé à la demande), jamais un repli sur le
 *    principal ;
 *  ③ un seul annuaire par bot (le principal est réutilisé tel quel) ;
 *  ④ non-régression : identifiant absent ⇒ annuaire du bot de la pile.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AgentDirectoryService,
  AgentHub,
  AgentStore,
  AuditLog,
  DirectoriesAgentsBots,
  maxSizeBytesFromMb,
} from "../../src/agents/index.js";
import { createLogger } from "../../src/observability/logger.js";

/** Bot EXPLICITE des constructions de store (aucun défaut implicite). */
const BOT_TEST = "yuki";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-annuaires-bots-"));
  dirs.push(dir);
  return dir;
}

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });

/** Hub minimal : aucun agent n'est en ligne (seule la VISIBILITÉ nous intéresse). */
class HubVide {
  isOnline(): boolean {
    return false;
  }
}

interface Fixture {
  store: AgentStore;
  annuaires: DirectoriesAgentsBots<AgentDirectoryService>;
}

function fixture(): Fixture {
  const dir = tempDir();
  const store = AgentStore.open({
    path: join(dir, "agents.jsonl"),
    botCourant: () => BOT_TEST,
    defaults: { level: "destructive", privilege: "normal" },
    logger,
  });
  const audit = AuditLog.open({
    path: join(dir, "audit.jsonl"),
    maxSizeBytes: maxSizeBytesFromMb(1),
    retentionDays: 30,
    logger,
  });
  const annuaires = new DirectoriesAgentsBots<AgentDirectoryService>({
    botDuRun: "yuki",
    bots: ["kohai"],
    creer: (botId) =>
      new AgentDirectoryService({
        store,
        hub: new HubVide() as unknown as AgentHub,
        audit,
        // ⚠️ C'est CETTE fermeture que le lot 40 rend PAR BOT.
        botCourant: () => botId,
      }),
    logger,
  });
  return { store, annuaires };
}

describe("LOT 40 — annuaire par bot", () => {
  it("un agent non autorisé pour le bot sélectionné n'est PAS dans sa liste", () => {
    const { store, annuaires } = fixture();
    store.markSeen("nuc-yuki");
    store.setBots("nuc-yuki", ["yuki"]);
    store.markSeen("nuc-kohai");
    store.setBots("nuc-kohai", ["kohai"]);

    expect(annuaires.pour("yuki").list().map((agent) => agent.agentId)).toEqual(["nuc-yuki"]);
    expect(annuaires.pour("kohai").list().map((agent) => agent.agentId)).toEqual(["nuc-kohai"]);
    // ⚠️ Un identifiant forgé ne trouve pas l'agent de l'autre bot non plus.
    expect(annuaires.pour("kohai").find("nuc-yuki")).toBeUndefined();
    expect(annuaires.pour("yuki").find("nuc-kohai")).toBeUndefined();
  });

  it("un bot inconnu du démarrage obtient le SIEN (jamais un repli sur le principal)", () => {
    const { store, annuaires } = fixture();
    store.markSeen("nuc-yuki");
    store.setBots("nuc-yuki", ["yuki"]);

    const tardif = annuaires.pour("nouveau-bot");
    expect(tardif.list()).toEqual([]);
    // …et un second appel rend le MÊME annuaire (un seul par bot).
    expect(annuaires.pour("nouveau-bot")).toBe(tardif);
    expect(annuaires.taille).toBe(3); // yuki (pile) + kohai + nouveau-bot
  });

  it("le principal est l'annuaire du bot de la pile, réutilisé tel quel", () => {
    const { annuaires } = fixture();
    expect(annuaires.duRun).toBe(annuaires.pour("yuki"));
    expect(annuaires.ids()).toEqual(["yuki", "kohai"]);
  });

  it("identifiant absent ou vide ⇒ annuaire du bot de la pile (mono-bot inchangé)", () => {
    const { annuaires } = fixture();
    expect(annuaires.pour("")).toBe(annuaires.duRun);
    expect(annuaires.pour("   ")).toBe(annuaires.duRun);
  });
});
