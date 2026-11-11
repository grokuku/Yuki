/**
 * LOT 36 (L6) — UN SERVICE D'EXÉCUTION D'AGENTS PAR BOT.
 *
 * ⚠️ Ces tests ÉCHOUENT sur le code d'origine : `src/agents/executions-bots.ts`
 * n'existe pas, et `main()` construit UN seul `AgentExecutionService` dont le
 * `botCourant` est une CONSTANTE figée au démarrage — en multi-bot, la
 * visibilité d'un second bot serait celle du principal.
 *
 * Ce qui est verrouillé ici :
 *  ① TEST CENTRAL : deux bots, UN agent partagé ⇒ la commande du bot NON
 *    autorisé est refusée (`agent_not_allowed`) et celle du bot autorisé passe ;
 *  ② le contrôle reste PAR COMMANDE (pas au choix du service) : le même service
 *    refuse, puis accepte, deux commandes différentes pour deux agents ;
 *  ③ un service par bot, le principal réutilisé tel quel (non-régression) ;
 *  ④ les branchements tardifs (`setWaker`, `setPreAutorisations`) touchent TOUS
 *    les bots — sinon un bot secondaire n'aurait jamais de réveil ;
 *  ⑤ `botDuRun` : absent = bot de la pile (mono-bot inchangé).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentExecutionService,
  AgentHub,
  AgentStore,
  ApprovalRegistry,
  AuditLog,
  ExecutionsAgentsBots,
  botDuRun,
  maxSizeBytesFromMb,
  type ExecutionsBotsLogger,
} from "../../src/agents/index.js";
import type { OutboundCommand, ResultFrame } from "../../src/agents/protocol.js";
import { createLogger } from "../../src/observability/logger.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-exec-bots-"));
  dirs.push(dir);
  return dir;
}

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });

/** Journal de test (aucune écriture disque). */
function journalEspion(): ExecutionsBotsLogger & { lignes: string[] } {
  const lignes: string[] = [];
  return {
    lignes,
    info: (message) => lignes.push(message),
    warn: (message) => lignes.push(message),
  };
}

/** Hub FACTICE : enregistre ce qui PART réellement. */
class RecordingHub {
  readonly sent: Array<{ agentId: string; cmd: OutboundCommand }> = [];
  private readonly online = new Set<string>();
  private readonly listeners = new Set<() => void>();

  isOnline(agentId: string): boolean {
    return this.online.has(agentId);
  }

  hasCapability(): boolean {
    return true;
  }

  caps(): string[] {
    return [];
  }

  get(): undefined {
    return undefined;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onlineIds(): string[] {
    return [...this.online];
  }

  connect(agentId: string): void {
    this.online.add(agentId);
    for (const listener of this.listeners) listener();
  }

  async sendCommand(agentId: string, cmd: OutboundCommand): Promise<ResultFrame> {
    this.sent.push({ agentId, cmd });
    return {
      cmdId: cmd.cmdId,
      exitCode: 0,
      stdout: "ok\n",
      stderr: "",
      durationMs: 1,
      truncated: false,
      timedOut: false,
      stdoutTrunc: false,
      stderrTrunc: false,
    } as unknown as ResultFrame;
  }
}

interface Banc {
  store: AgentStore;
  hub: RecordingHub;
  executions: ExecutionsAgentsBots<AgentExecutionService>;
}

/** Deux bots (`yuki`, `kohai`) sur le MÊME store / hub / audit (TLS partagé). */
function banc(bots: readonly string[] = ["kohai"]): Banc {
  const dir = tempDir();
  const store = AgentStore.open({
    path: join(dir, "agents.jsonl"),
    defaults: { level: "never", privilege: "normal" },
    logger,
  });
  const audit = AuditLog.open({
    path: join(dir, "audit.jsonl"),
    maxSizeBytes: maxSizeBytesFromMb(1),
    retentionDays: 30,
    logger,
  });
  const hub = new RecordingHub();
  const executions = new ExecutionsAgentsBots<AgentExecutionService>({
    botDePile: "yuki",
    bots,
    // ⚠️ C'est CE paramètre qui décide de la visibilité, et il est PAR BOT.
    creer: (botId) =>
      new AgentExecutionService({
        store,
        hub: hub as unknown as AgentHub,
        audit,
        approvals: new ApprovalRegistry({ logger }),
        logger,
        botCourant: () => botId,
      }),
    logger: journalEspion(),
  });
  return { store, hub, executions };
}

/** Enregistre un agent et le rend « en ligne » (sinon refus hors ligne). */
function agentEnLigne(banc: Banc, agentId: string, bots?: string[]): void {
  banc.store.markSeen(agentId);
  banc.store.setLevel(agentId, "never");
  if (bots !== undefined) banc.store.configure(agentId, { bots });
  banc.hub.connect(agentId);
}

describe("ExecutionsAgentsBots — un service par bot", () => {
  it("le principal est le service du bot de la pile, et il est rendu par identité", () => {
    const b = banc();
    expect(b.executions.pour("yuki")).toBe(b.executions.principal);
    expect(b.executions.ids()).toEqual(["yuki", "kohai"]);
    expect(b.executions.taille).toBe(2);
  });

  it("un bot non démarré n'a AUCUN service (aucun repli silencieux)", () => {
    const b = banc();
    expect(b.executions.pour("fantome")).toBeUndefined();
  });

  it("un identifiant répété n'est construit qu'une fois", () => {
    const creer = vi.fn(() => ({}));
    new ExecutionsAgentsBots({ botDePile: "yuki", bots: ["yuki", "kohai"], creer, logger: journalEspion() });
    expect(creer.mock.calls).toEqual([["yuki"], ["kohai"]]);
  });
});

describe("L6 — TEST CENTRAL : agent partagé, contrôle PAR COMMANDE", () => {
  it("la commande du bot NON autorisé est refusée, celle du bot autorisé passe", async () => {
    const b = banc();
    // Agent autorisé pour `yuki` seulement.
    agentEnLigne(b, "partage", ["yuki"]);

    const refus = await b.executions.pour("kohai")!.execute({
      agentId: "partage",
      command: "uptime",
    });
    expect(refus.status).toBe("refused");
    if (refus.status !== "refused") return;
    expect(refus.code).toBe("agent_not_allowed");
    // Aucune commande n'est partie chez l'agent.
    expect(b.hub.sent).toHaveLength(0);

    const accepte = await b.executions.pour("yuki")!.execute({
      agentId: "partage",
      command: "uptime",
    });
    expect(accepte.status).toBe("completed");
    expect(b.hub.sent).toHaveLength(1);
  });

  it("le MÊME service refuse puis accepte selon l'AGENT (contrôle par commande)", async () => {
    const b = banc();
    agentEnLigne(b, "reserve", ["yuki"]);
    agentEnLigne(b, "libre", ["yuki", "kohai"]);

    const kohai = b.executions.pour("kohai")!;
    const refuse = await kohai.execute({ agentId: "reserve", command: "uptime" });
    const accepte = await kohai.execute({ agentId: "libre", command: "uptime" });

    expect(refuse.status).toBe("refused");
    expect(accepte.status).toBe("completed");
    // Une SEULE commande transmise : celle de l'agent autorisé.
    expect(b.hub.sent.map((envoi) => envoi.agentId)).toEqual(["libre"]);
  });

  it("un agent autorisé pour les DEUX bots passe depuis les deux services", async () => {
    const b = banc();
    agentEnLigne(b, "partage", ["yuki", "kohai"]);

    const depuisYuki = await b.executions.pour("yuki")!.execute({
      agentId: "partage",
      command: "uptime",
    });
    const depuisKohai = await b.executions.pour("kohai")!.execute({
      agentId: "partage",
      command: "uptime",
    });

    expect(depuisYuki.status).toBe("completed");
    expect(depuisKohai.status).toBe("completed");
    expect(b.hub.sent).toHaveLength(2);
  });
});

describe("branchements tardifs — TOUS les bots", () => {
  it("pourChacun touche chaque service avec SON identifiant de bot", () => {
    const vus: string[] = [];
    const b = banc(["kohai", "autre"]);
    b.executions.pourChacun((execution, botId) => {
      vus.push(`${botId}:${execution === b.executions.principal ? "principal" : "autre"}`);
    });
    expect(vus).toEqual(["yuki:principal", "kohai:autre", "autre:autre"]);
  });

  it("le réveil de modèle est posé sur CHAQUE bot (aucun bot muet)", () => {
    const b = banc();
    const appels: string[] = [];
    const waker = { send: (sessionId: string) => appels.push(sessionId) };
    b.executions.pourChacun((execution, botId) => {
      execution.setWaker(waker);
      appels.push(`pose:${botId}`);
    });
    expect(appels).toEqual(["pose:yuki", "pose:kohai"]);
  });
});

describe("botDuRun", () => {
  it("absent ou vide ⇒ bot de la pile (mono-bot inchangé)", () => {
    expect(botDuRun(undefined, "yuki")).toBe("yuki");
    expect(botDuRun("   ", "yuki")).toBe("yuki");
  });

  it("nommé ⇒ ce bot, nettoyé", () => {
    expect(botDuRun(" kohai ", "yuki")).toBe("kohai");
  });
});
