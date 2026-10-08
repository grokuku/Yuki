/**
 * Intégration — administration des conversations (hôte SDK RÉEL, hors ligne).
 *
 * Couvre : liste enrichie et PLAFONNÉE (titre prêt à l'emploi, extrait),
 * renommage natif (doublon REFUSÉ, titre vide ⇒ repli), mise de côté
 * (déplacement horodaté, récupérable, retirée de la liste) et
 * `sessionFileFor`. Aucun modèle, aucun réseau : on ne fait jamais aboutir un
 * prompt.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import { createPiHost, type PiHost } from "../../src/pi/host.js";
import { createLogger } from "../../src/observability/logger.js";

interface World {
  root: string;
  agentDir: string;
  home: string;
  cwd: string;
  sessionsDir: string;
}

const tempRoots: string[] = [];
const hosts: PiHost[] = [];

function emptyWorld(): World {
  const root = mkdtempSync(join(tmpdir(), "yuki-sessions-"));
  tempRoots.push(root);
  const world: World = {
    root,
    agentDir: join(root, "agent"),
    home: join(root, "home"),
    cwd: join(root, "workspace"),
    sessionsDir: join(root, "agent", "sessions"),
  };
  for (const dir of [world.agentDir, world.home, world.cwd, world.sessionsDir]) {
    mkdirSync(dir, { recursive: true });
  }
  return world;
}

function seedSession(world: World, user: string, assistant: string): { id: string; file: string } {
  const manager = SessionManager.create(world.cwd, world.sessionsDir);
  manager.appendMessage({ role: "user", content: user, timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: assistant }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const file = manager.getSessionFile();
  if (!file) throw new Error("session non persistée");
  return { id: manager.getSessionId(), file };
}

async function startRealHost(world: World): Promise<PiHost> {
  const systemPrompt = readFileSync("config/pi/system-prompt.md", "utf8");
  const logger = createLogger({ level: "error", sink: () => undefined, secretValues: [] });
  const host = createPiHost({
    agentDir: world.agentDir,
    cwd: world.cwd,
    home: world.home,
    sessionsDir: world.sessionsDir,
    systemPrompt,
    settingsSeedPath: "config/pi/settings.json",
    logger,
  });
  hosts.push(host);
  await host.start();
  return host;
}

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("administration des conversations (hôte réel)", () => {
  it("liste les sessions ENRICHIES (titre prêt à l'emploi, extrait, compteur)", async () => {
    const world = emptyWorld();
    const a = seedSession(world, "Résumé du lundi matin", "Réponse A");
    const host = await startRealHost(world);

    const list = await host.listSessions();
    const info = list.find((s) => s.sessionId === a.id);
    expect(info).toBeDefined();
    expect(info?.title).toBe("Résumé du lundi matin");
    expect(info?.name).toBeUndefined();
    expect(info?.firstMessage).toContain("Résumé du lundi matin");
    expect(info?.messageCount).toBe(2);
    expect(info?.updatedAt).toBeTruthy();
    expect(info?.sessionFile).toBe(a.file);
  });

  it("plafonne la liste aux 50 conversations les plus récentes", async () => {
    const world = emptyWorld();
    for (let i = 0; i < 55; i += 1) {
      seedSession(world, `Conversation ${i}`, `Réponse ${i}`);
    }
    const host = await startRealHost(world);
    const list = await host.listSessions();
    expect(list.length).toBe(50);
  });

  it("renomme via le titre natif, REFUSE un doublon, et replit un titre vide", async () => {
    const world = emptyWorld();
    const a = seedSession(world, "Premier message A", "Réponse A");
    const b = seedSession(world, "Titre occupé B", "Réponse B");
    const host = await startRealHost(world);

    // Renommage normal.
    await host.renameSession(a.id, "Mon titre à moi");
    let list = await host.listSessions();
    expect(list.find((s) => s.sessionId === a.id)?.title).toBe("Mon titre à moi");
    // Le fichier n'a PAS été déplacé (l'id EST dans le nom du fichier).
    expect(existsSync(a.file)).toBe(true);
    expect(readFileSync(a.file, "utf8")).toContain("Mon titre à moi");

    // Doublon : refusé avec un message honnête.
    await expect(host.renameSession(a.id, "Titre occupé B")).rejects.toThrow(/déjà utilisé/i);
    // Insensible à la casse / aux espaces.
    await expect(host.renameSession(a.id, "  titre occupé b  ")).rejects.toThrow(/déjà utilisé/i);
    list = await host.listSessions();
    expect(list.find((s) => s.sessionId === a.id)?.title).toBe("Mon titre à moi");

    // Titre VIDE : efface le nom natif → repli sur les premiers mots.
    await host.renameSession(a.id, "   ");
    list = await host.listSessions();
    expect(list.find((s) => s.sessionId === a.id)?.title).toBe("Premier message A");

    // Le doublon reste refusé quand la cible est B elle-même (auto-renommage OK).
    await host.renameSession(b.id, "Titre occupé B");
    list = await host.listSessions();
    expect(list.find((s) => s.sessionId === b.id)?.title).toBe("Titre occupé B");
  });

  it("met de côté une conversation NON ouverte : fichier horodaté, retirée, récupérable", async () => {
    const world = emptyWorld();
    const a = seedSession(world, "Fil A", "Réponse A");
    const b = seedSession(world, "Fil B", "Réponse B");
    const host = await startRealHost(world);

    const current = host.currentSessionId();
    const other = current === a.id ? b : a;
    const otherFile = other.file;

    await host.setAsideSession(other.id);

    // Retirée de la liste, l'autre reste.
    const list = await host.listSessions();
    expect(list.some((s) => s.sessionId === other.id)).toBe(false);
    expect(list.some((s) => s.sessionId === current)).toBe(true);
    // Déplacée (plus à son ancien emplacement), rangée dans un dossier horodaté.
    expect(existsSync(otherFile)).toBe(false);
    const asideDir = join(world.sessionsDir, "conversations-supprimees");
    const stamps = readdirSync(asideDir);
    expect(stamps.length).toBe(1);
    const moved = readdirSync(join(asideDir, stamps[0] ?? ""));
    expect(moved.some((name) => name.endsWith(".jsonl"))).toBe(true);
  });

  it("sessionFileFor résout la session courante et une session persistée", async () => {
    const world = emptyWorld();
    const a = seedSession(world, "Fil A", "Réponse A");
    const host = await startRealHost(world);
    expect(await host.sessionFileFor(a.id)).toBe(a.file);
    const current = host.currentSessionId();
    if (current) {
      const file = await host.sessionFileFor(current);
      expect(typeof file).toBe("string");
    }
    expect(await host.sessionFileFor("inconnue")).toBeUndefined();
  });
});
