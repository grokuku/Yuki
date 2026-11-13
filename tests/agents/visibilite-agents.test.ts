/**
 * VISIBILITÉ DES AGENTS PAR BOT (lot 35g) — les agents sont GLOBAUX, chaque
 * agent porte la LISTE des bots autorisés à l'utiliser (`AgentRecord.bots`).
 *
 * Ce que ce fichier VERROUILLE :
 *
 *  ① **Lecture rétro-compatible** : un `agents.jsonl` SANS champ `bots` rejoue à
 *    `["yuki"]` — jamais `[]` (une liste vide couperait une installation en
 *    service) ;
 *  ② **`[]` = agent NEUTRALISÉ** : il reste LISTÉ (on garde sa trace) mais plus
 *    aucun bot ne le résout ni ne l'exécute ;
 *  ③ ⚠️ **LES TROIS POINTS DE FILTRAGE**, et pas seulement la liste :
 *    `AgentDirectoryService.list()`/`find()`, `AgentStore.resolve()`, et
 *    ⚠️ **`authorize()`** — c'est CE test qui prouve qu'un identifiant FORGÉ ne
 *    passe pas, même en contournant la liste ;
 *  ④ le refus est **`agent_not_allowed`** avec un message explicite (jamais
 *    « agent introuvable », qui ferait croire à une panne) ;
 *  ⑤ ⚠️ **le bot vient du RUN, jamais du client** : une valeur glissée dans la
 *    demande est IGNORÉE ;
 *  ⑥ ⚠️ **supprimer un bot le retire des listes SANS toucher aux agents** (le
 *    test central du lot), et un échec de nettoyage n'empêche PAS la suppression.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AgentDirectoryService,
  AgentExecutionService,
  AgentHub,
  AgentStore,
  ApprovalRegistry,
  AuditLog,
  maxSizeBytesFromMb,
} from "../../src/agents/index.js";
import type { ExecutionRequest } from "../../src/agents/index.js";
import { createLogger } from "../../src/observability/logger.js";
import { MAX_BOTS, supprimerBot } from "../../src/bots/admin.js";
import { BOT_YUKI, CAPACITES_BOT, type RegistreBots } from "../../src/bots/registry.js";

/** Bot EXPLICITE des constructions de store (aucun défaut implicite). */
const BOT_TEST = "yuki";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-agents-visibilite-"));
  dirs.push(dir);
  return dir;
}

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });

/** Hub FACTICE : enregistre ce qui PART réellement (aucune commande ne doit partir). */
class RecordingHub {
  readonly sent: Array<{ agentId: string; command: string }> = [];
  readonly online = new Set<string>();

  isOnline(agentId: string): boolean {
    return this.online.has(agentId);
  }

  hasCapability(): boolean {
    return true;
  }

  caps(): string[] {
    return [];
  }

  subscribe(): () => void {
    return () => undefined;
  }

  connect(agentId: string): void {
    this.online.add(agentId);
  }
}

interface Fixture {
  dir: string;
  store: AgentStore;
  hub: RecordingHub;
  execution: AgentExecutionService;
  directory: AgentDirectoryService;
}

function fixture(botCourant: string): Fixture {
  const dir = tempDir();
  const store = AgentStore.open({
    path: join(dir, "agents.jsonl"),
    defaults: { level: "destructive", privilege: "normal" },
    logger,
    botCourant: () => botCourant,
  });
  const audit = AuditLog.open({
    path: join(dir, "audit.jsonl"),
    maxSizeBytes: maxSizeBytesFromMb(1),
    retentionDays: 30,
    logger,
  });
  const hub = new RecordingHub();
  const approvals = new ApprovalRegistry({ logger });
  const execution = new AgentExecutionService({
    store,
    hub: hub as unknown as AgentHub,
    audit,
    approvals,
    logger,
    botCourant: () => botCourant,
  });
  const directory = new AgentDirectoryService({
    store,
    hub: hub as unknown as AgentHub,
    audit,
    botCourant: () => botCourant,
  });
  return { dir, store, hub, execution, directory };
}

/** Enregistre un agent au niveau « pas de validation » et le met en ligne. */
function agent(
  f: Fixture,
  agentId: string,
  bots: string[],
  level: "never" | "destructive" = "never",
): void {
  f.store.markSeen(agentId);
  f.store.setLevel(agentId, level);
  f.store.setBots(agentId, bots);
  f.hub.connect(agentId);
}

describe("visibilité des agents — le champ `bots` (lot 35g)", () => {
  it("rejoue un journal SANS champ `bots` à [\"yuki\"] (jamais [])", () => {
    const dir = tempDir();
    const path = join(dir, "agents.jsonl");
    // Journal ANTÉRIEUR au champ : une seule ligne `upsert`, sans `bots`.
    writeFileSync(
      path,
      `${JSON.stringify({
        seq: 1,
        ts: "2026-11-01T10:00:00.000Z",
        eventId: "e1",
        agentId: "ancien",
        kind: "upsert",
        patch: { name: "nuc00" },
      })}\n`,
      "utf8",
    );
    const store = AgentStore.open({
      path,
      botCourant: () => BOT_TEST,
    defaults: { level: "destructive", privilege: "normal" },
      logger,
    });
    const record = store.get("ancien");
    expect(record?.bots).toEqual([BOT_YUKI]);
    // ⚠️ Pas `[]` : l'agent reste joignable par le bot historique.
    expect(store.resolve("ancien")?.agentId).toBe("ancien");
  });

  it("crée un agent avec [\"yuki\"] par défaut et persiste la liste demandée", () => {
    const f = fixture(BOT_YUKI);
    f.store.markSeen("a1");
    expect(f.store.get("a1")?.bots).toEqual([BOT_YUKI]);
    f.store.setBots("a1", ["kohai", "senpai"]);
    expect(f.store.get("a1")?.bots).toEqual(["kohai", "senpai"]);
    // Le journal garde la trace de la modification (relecture identique).
    const reopened = AgentStore.open({
      path: join(f.dir, "agents.jsonl"),
      defaults: { level: "destructive", privilege: "normal" },
      logger,
      botCourant: () => "senpai",
    });
    expect(reopened.get("a1")?.bots).toEqual(["kohai", "senpai"]);
  });

  it("refuse plus de MAX_BOTS bots autorisés (message qui nomme la borne)", () => {
    const f = fixture(BOT_YUKI);
    f.store.markSeen("a1");
    const trop = Array.from({ length: MAX_BOTS + 1 }, (_, index) => `bot${index}`);
    expect(() => f.store.setBots("a1", trop)).toThrowError(new RegExp(String(MAX_BOTS)));
    // Un identifiant de bot invalide est refusé aussi (jamais `../`).
    expect(() => f.store.setBots("a1", ["../evasion"])).toThrowError(/invalide/i);
  });
});

describe("visibilité des agents — `[]` neutralise mais conserve la trace", () => {
  it("liste l'agent neutralisé côté ADMINISTRATION, ne le résout plus côté bot", () => {
    const f = fixture(BOT_YUKI);
    agent(f, "a1", []);
    // Traçabilité : il est TOUJOURS dans le store (donc dans /config).
    expect(f.store.list().map((record) => record.agentId)).toEqual(["a1"]);
    // Injoignable : ni résolution, ni annuaire, ni exécution.
    expect(f.store.resolve("a1")).toBeUndefined();
    expect(f.directory.list()).toEqual([]);
    expect(f.directory.find("a1")).toBeUndefined();
  });
});

describe("visibilité des agents — les TROIS points de filtrage", () => {
  it("① list()/find() ne montrent pas un agent non autorisé pour ce bot", () => {
    const f = fixture("kohai");
    agent(f, "a1", ["yuki"]);
    f.store.markSeen("a2");
    f.store.setBots("a2", ["kohai"]);
    expect(f.directory.list().map((summary) => summary.agentId)).toEqual(["a2"]);
    expect(f.directory.find("a1")).toBeUndefined();
    expect(f.store.resolve("a1")).toBeUndefined();
  });

  it("② resolve() refuse un identifiant forgé (l'agent existe, il est caché)", () => {
    const f = fixture("kohai");
    agent(f, "a1", ["yuki"]);
    // Résolution BRUTE : l'agent existe bien (preuve qu'il n'est pas « inconnu »).
    expect(f.store.resolveBrut("a1")?.agentId).toBe("a1");
    // Résolution PUBLIQUE : filtrée par le bot du run.
    expect(f.store.resolve("a1")).toBeUndefined();
    expect(f.store.resolve("nuc00")).toBeUndefined();
  });

  it("③ ⚠️ authorize() refuse un identifiant forgé : agent_not_allowed, rien ne part", async () => {
    const f = fixture("kohai");
    agent(f, "a1", ["yuki"]);
    const outcome = await f.execution.execute({
      agentId: "a1",
      command: "touch /tmp/pwned",
      origin: "tour_humain",
    });
    expect(outcome.status).toBe("refused");
    expect(outcome.code).toBe("agent_not_allowed");
    // ⚠️ Message EXPLICITE : ce n'est pas une panne, c'est la visibilité.
    expect(outcome.message).toContain("n'est pas autorisé pour ce bot");
    expect(outcome.message).not.toContain("Agent inconnu");
    // ⚠️ Preuve qu'AUCUNE commande n'est transmise à la machine.
    expect(f.hub.sent).toEqual([]);
  });

  it("③ bis authorizeTransfer() refuse aussi (même garde-fou que les commandes)", () => {
    const f = fixture("kohai");
    agent(f, "a1", ["yuki"]);
    const decision = f.execution.authorizeTransfer("a1", "files/recuperer", {
      origin: "recuperer_fichier",
    });
    expect(decision.kind).toBe("refuse");
    if (decision.kind !== "refuse") throw new Error("refus attendu");
    expect(decision.code).toBe("agent_not_allowed");
    expect(decision.message).toContain("n'est pas autorisé pour ce bot");
  });

  it("laisse passer un agent autorisé (aucune régression)", async () => {
    const f = fixture("kohai");
    agent(f, "a1", ["yuki", "kohai"]);
    expect(f.store.resolve("a1")?.agentId).toBe("a1");
    expect(f.directory.list().map((summary) => summary.agentId)).toEqual(["a1"]);
    const decision = f.execution.authorizeTransfer("a1", "files/recuperer", {
      origin: "recuperer_fichier",
    });
    expect(decision.kind).toBe("proceed");
  });
});

describe("visibilité des agents — le bot vient du RUN, jamais du client", () => {
  it("ignore une valeur `bot` glissée dans la demande d'exécution", async () => {
    const f = fixture("kohai");
    agent(f, "a1", ["yuki"]);
    const forgee = {
      agentId: "a1",
      command: "id",
      origin: "tour_humain",
      // ⚠️ Champ inventé par un appelant : il ne doit RIEN changer.
      bot: "yuki",
      botId: "yuki",
      botCourant: "yuki",
    } as unknown as ExecutionRequest;
    const outcome = await f.execution.execute(forgee);
    expect(outcome.status).toBe("refused");
    expect(outcome.code).toBe("agent_not_allowed");
    expect(f.hub.sent).toEqual([]);
  });

  it("le même agent est visible depuis SON bot (preuve que seul le bot change)", () => {
    const f = fixture("yuki");
    agent(f, "a1", ["yuki"]);
    expect(f.store.resolve("a1")?.agentId).toBe("a1");
    expect(f.directory.find("a1")?.agentId).toBe("a1");
  });
});

describe("suppression d'un bot — les agents RESTENT, la liste est nettoyée", () => {
  function registre(): RegistreBots {
    return {
      schemaVersion: 1,
      bots: [
        // ⚠️ `capacites` (lot 35h) : le registre n'a plus de `profil`. Ces bots
        // sont hérités ⇒ toutes les capacités.
        { id: "yuki", nom: "Yuki", capacites: [...CAPACITES_BOT], actif: true, ordre: 0, creeLe: "2026-01-01T00:00:00.000Z", plateformes: {} },
        { id: "kohai", nom: "Kohai", capacites: [...CAPACITES_BOT], actif: false, ordre: 1, creeLe: "2026-01-01T00:00:00.000Z", plateformes: {} },
      ],
      echanges: {},
    };
  }

  it("⚠️ retire le bot des listes, les agents restent configurés (test central)", () => {
    const f = fixture(BOT_YUKI);
    agent(f, "a1", ["yuki", "kohai"]);
    agent(f, "a2", ["kohai"]);
    agent(f, "a3", ["yuki"]);

    const journaux: Array<{ message: string; fields?: Record<string, unknown> }> = [];
    const stateDir = tempDir();
    const resultat = supprimerBot({
      stateDir,
      registre: registre(),
      botId: "kohai",
      logger: {
        info: (message, fields) => journaux.push({ message, ...(fields ? { fields } : {}) }),
        warn: (message, fields) => journaux.push({ message, ...(fields ? { fields } : {}) }),
      },
      retirerDesListesDAgents: (botId) => f.store.retirerBotDesListes(botId).length,
    });

    // Le bot a bien disparu du registre…
    expect(resultat.registre.bots.map((bot) => bot.id)).toEqual(["yuki"]);
    // …et AUCUN agent n'a été supprimé : ils sont tous encore là.
    expect(f.store.list().map((record) => record.agentId).sort()).toEqual(["a1", "a2", "a3"]);
    // Les listes sont nettoyées ; `a2` n'ayant plus aucun bot, il est NEUTRALISÉ.
    expect(f.store.get("a1")?.bots).toEqual(["yuki"]);
    expect(f.store.get("a2")?.bots).toEqual([]);
    expect(f.store.get("a3")?.bots).toEqual(["yuki"]);
    // Journal : le nombre d'agents modifiés est DIT.
    const detachement = journaux.find((entree) => entree.message === "bot.agents.detached");
    expect(detachement).toBeDefined();
    expect(detachement?.fields?.["agents"]).toBe(2);
    expect(detachement?.fields?.["bot"]).toBe("kohai");
    // La modification survit à une relecture du journal.
    const reopened = AgentStore.open({
      path: join(f.dir, "agents.jsonl"),
      botCourant: () => BOT_TEST,
    defaults: { level: "destructive", privilege: "normal" },
      logger,
    });
    expect(reopened.get("a2")?.bots).toEqual([]);
  });

  it("un ÉCHEC du nettoyage n'empêche PAS la suppression (et il est journalisé)", () => {
    const journaux: Array<{ message: string; fields?: Record<string, unknown> }> = [];
    const stateDir = tempDir();
    const resultat = supprimerBot({
      stateDir,
      registre: registre(),
      botId: "kohai",
      logger: {
        info: (message, fields) => journaux.push({ message, ...(fields ? { fields } : {}) }),
        warn: (message, fields) => journaux.push({ message, ...(fields ? { fields } : {}) }),
      },
      retirerDesListesDAgents: () => {
        throw new Error("journal d'agents illisible");
      },
    });
    // ⚠️ La suppression ABOUTIT quand même : le bot n'est plus dans le registre.
    expect(resultat.registre.bots.map((bot) => bot.id)).toEqual(["yuki"]);
    const echec = journaux.find((entree) => entree.message === "bot.agents.detach_failed");
    expect(echec).toBeDefined();
    expect(String(echec?.fields?.["error"])).toContain("illisible");
    expect(journaux.some((entree) => entree.message === "bot.agents.detached")).toBe(false);
  });

  it("réécrit le journal d'agents (aucune liste ne garde l'identifiant supprimé)", () => {
    const f = fixture(BOT_YUKI);
    agent(f, "a1", ["yuki", "kohai"]);
    f.store.retirerBotDesListes("kohai");
    const contenu = readFileSync(join(f.dir, "agents.jsonl"), "utf8");
    const lignes = contenu.split("\n").filter((ligne) => ligne.trim() !== "");
    const dernier = JSON.parse(lignes[lignes.length - 1] as string) as {
      patch?: { bots?: string[] };
    };
    expect(dernier.patch?.bots).toEqual(["yuki"]);
  });
});
