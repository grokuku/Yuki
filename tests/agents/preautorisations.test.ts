/**
 * LOT 26 / 4 — LES PRÉ-AUTORISATIONS : ce qu'une TÂCHE DE FOND peut exécuter
 * sans validation humaine.
 *
 * ⚠️ Ces tests ÉCHOUENT sur le code d'origine : ni `PreAutorisationStore`, ni
 * `setPreAutorisations`, ni la moindre notion de pré-autorisation n'y existent
 * (`git show HEAD:src/agents/execution.ts` : `authorize` demande toujours une
 * approbation quand le niveau l'exige, et rien ne regarde l'origine du tour).
 *
 * Ce qui est verrouillé ici, dans l'ordre des règles de sécurité :
 *  - SANS pré-autorisation, une commande de tâche de fond attend une validation
 *    humaine (comportement historique) — et le message DIT qu'aucune
 *    approbation ne peut arriver ;
 *  - AVEC une pré-autorisation valide et l'origine `declencheur:<nom>`, la
 *    commande s'exécute SANS approbation ;
 *  - une origine HUMAINE l'IGNORE (elle ne doit pas ouvrir une porte aux tours
 *    normaux) ;
 *  - motif non couvert / pré-autorisation expirée / agent différent / révoquée
 *    ⇒ REFUS (le doute vaut refus) ;
 *  - une pré-autorisation = UNE exécution (la seconde redemande une approbation) ;
 *  - ⚠️ INVARIANT : aucune consommation sans ligne de JOURNAL.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { startTestStack, type TestStack } from "./stack.js";
import {
  DUREE_DEFAUT_JOURS,
  MAX_PREAUTORISATIONS,
  PreAutorisationError,
  PreAutorisationStore,
  declencheurDeLOrigine,
  estOrigineDeclencheur,
  etatPreAutorisation,
  motifCorrespond,
  origineDeclencheur,
} from "../../src/agents/index.js";
import { DeclencheurJournal } from "../../src/sources/journal.js";

const stacks: TestStack[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const s of stacks.splice(0)) {
    await s.close();
    s.cleanup();
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, timeoutMs = 4_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor : délai dépassé");
    await delay(10);
  }
}

/** Monte une pile d'agents et un agent simulé qui répond toujours. */
async function pile(agentId = "agent-a"): Promise<{
  stack: TestStack;
  ws: WebSocket;
  journal: DeclencheurJournal;
  registre: PreAutorisationStore;
}> {
  const stack = await startTestStack();
  stacks.push(stack);
  stack.register(agentId);
  const cert = stack.ca.signClientCertificate(agentId);
  const ws = new WebSocket(`wss://127.0.0.1:${stack.port}/ws`, {
    cert: cert.certPem,
    key: cert.keyPem,
    ca: stack.ca.certificatePem,
    rejectUnauthorized: true,
  });
  ws.on("message", (data: Buffer) => {
    const frame = JSON.parse(data.toString()) as Record<string, unknown>;
    if (frame["type"] !== "cmd") return;
    ws.send(JSON.stringify({ proto_version: 1, type: "ack", cmd_id: frame["cmd_id"] }));
    ws.send(
      JSON.stringify({
        proto_version: 1,
        type: "result",
        cmd_id: frame["cmd_id"],
        exit_code: 0,
        stdout: "ok\n",
        stderr: "",
        duration_ms: 3,
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  await waitFor(() => stack.hub.isOnline(agentId));

  const journal = DeclencheurJournal.open({
    path: join(stack.dir, "declencheurs-journal.jsonl"),
  });
  const registre = new PreAutorisationStore({
    path: join(stack.dir, "preautorisations.json"),
    journal,
  });
  stack.execution.setPreAutorisations(registre);
  return { stack, ws, journal, registre };
}

describe("pré-autorisations — le modèle", () => {
  it("refuse un motif à JOKER, un préfixe trop court, une durée hors bornes", () => {
    const dir = mkdtempSync(join(tmpdir(), "yuki-preauth-"));
    dirs.push(dir);
    const registre = new PreAutorisationStore({ path: join(dir, "preautorisations.json") });
    const base = { declencheur: "veille", agentId: "agent-a" };

    // ⚠️ JAMAIS de joker dans un champ de sécurité.
    expect(() => registre.creer({ ...base, motif: "*", portee: "prefixe" })).toThrow(
      PreAutorisationError,
    );
    expect(() => registre.creer({ ...base, motif: "systemctl *", portee: "exacte" })).toThrow(
      /joker/i,
    );
    // Préfixe trop court : `sudo` ouvrirait la porte à presque tout.
    expect(() => registre.creer({ ...base, motif: "sudo", portee: "prefixe" })).toThrow(
      PreAutorisationError,
    );
    // Durée : 1 à 90 jours, pas au-delà.
    expect(() => registre.creer({ ...base, motif: "df -h", dureeJours: 0 })).toThrow(
      PreAutorisationError,
    );
    expect(() => registre.creer({ ...base, motif: "df -h", dureeJours: 91 })).toThrow(
      PreAutorisationError,
    );
    // Un motif valide, lui, passe — et expire dans 30 jours par défaut.
    const creee = registre.creer({ ...base, motif: "df -h" });
    expect(creee.portee).toBe("exacte");
    expect(creee.consommations).toBe(0);
    const jours = Math.round((Date.parse(creee.expireA) - Date.parse(creee.creeLe)) / 86_400_000);
    expect(jours).toBe(DUREE_DEFAUT_JOURS);
    expect(etatPreAutorisation(creee)).toBe("active");
  });

  it("relit son fichier (persistance) et borne le nombre d'autorisations", () => {
    const dir = mkdtempSync(join(tmpdir(), "yuki-preauth-"));
    dirs.push(dir);
    const chemin = join(dir, "preautorisations.json");
    const premier = new PreAutorisationStore({ path: chemin });
    const creee = premier.creer({ declencheur: "veille", agentId: "agent-a", motif: "df -h" });
    const second = new PreAutorisationStore({ path: chemin });
    expect(second.get(creee.id)?.motif).toBe("df -h");

    // Le plafond est explicite (jamais une liste qui grossit sans fin).
    for (let i = premier.size; i < MAX_PREAUTORISATIONS; i += 1) {
      premier.creer({ declencheur: "veille", agentId: "agent-a", motif: `echo ${i}` });
    }
    expect(() =>
      premier.creer({ declencheur: "veille", agentId: "agent-a", motif: "echo trop" }),
    ).toThrow(/Trop de pré-autorisations/);
    expect(readFileSync(chemin, "utf8")).toContain('"schemaVersion": 1');
  });

  it("n'accepte la correspondance de motif que par égalité ou préfixe DÉCLARÉ", () => {
    const exacte = { motif: "df -h", portee: "exacte" as const };
    expect(motifCorrespond(exacte, "df -h")).toBe(true);
    expect(motifCorrespond(exacte, "df -h /")).toBe(false);
    const prefixe = { motif: "systemctl restart ", portee: "prefixe" as const };
    expect(motifCorrespond(prefixe, "systemctl restart nginx")).toBe(true);
    expect(motifCorrespond(prefixe, "systemctl stop nginx")).toBe(false);
  });

  it("reconnaît l'origine d'un déclencheur, et en extrait le NOM", () => {
    expect(estOrigineDeclencheur("declencheur:veille")).toBe(true);
    expect(estOrigineDeclencheur("declencheur")).toBe(true);
    expect(estOrigineDeclencheur("run_command")).toBe(false);
    expect(estOrigineDeclencheur(undefined)).toBe(false);
    expect(origineDeclencheur("veille")).toBe("declencheur:veille");
    expect(declencheurDeLOrigine("declencheur:veille")).toBe("veille");
    // ⚠️ La forme courte ne porte pas de nom ⇒ la garde ne peut RIEN consommer.
    expect(declencheurDeLOrigine("declencheur")).toBeUndefined();
    expect(declencheurDeLOrigine("run_command")).toBeUndefined();
  });
});

describe("pré-autorisations — la GARDE dans authorize", () => {
  it("sans pré-autorisation : la tâche de fond attend une validation et le DIT", async () => {
    const { stack } = await pile();
    stack.store.configure("agent-a", { level: "always" });
    const outcome = await stack.execution.execute({
      agentId: "agent-a",
      command: "echo bonjour",
      origin: "declencheur:veille",
    });
    expect(outcome.status).toBe("awaiting_validation");
    expect(outcome.approvalId).toBeTruthy();
    // ⚠️ Le message doit dire qu'aucun humain ne viendra.
    expect(outcome.message).toContain("TÂCHE DE FOND");
    expect(outcome.message).toContain("5 minutes");
    expect(outcome.message).toContain("PRÉ-AUTORISATION");
  });

  it("avec une pré-autorisation valide et l'origine déclencheur : SANS approbation", async () => {
    const { stack, registre, journal } = await pile();
    stack.store.configure("agent-a", { level: "always" });
    const pre = registre.creer({
      declencheur: "veille",
      agentId: "agent-a",
      motif: "echo bonjour",
      portee: "exacte",
    });
    const outcome = await stack.execution.execute({
      agentId: "agent-a",
      command: "echo bonjour",
      origin: "declencheur:veille",
    });
    expect(outcome.status).toBe("completed");
    expect(outcome.approvalId).toBeUndefined();
    // La consommation est écrite, datée, comptée.
    expect(registre.get(pre.id)?.consommeeLe).toBeTruthy();
    expect(registre.get(pre.id)?.consommations).toBe(1);
    // ⚠️ INVARIANT : la consommation laisse une ligne de journal.
    const lignes = journal.recent(50, { types: ["preautorisation"] });
    expect(lignes).toHaveLength(1);
    expect(lignes[0]?.source).toBe("veille");
    expect(lignes[0]?.preAutorisation).toContain("echo bonjour");
  });

  it("une origine HUMAINE ignore la pré-autorisation (aucune porte ouverte)", async () => {
    const { stack, registre } = await pile();
    stack.store.configure("agent-a", { level: "always" });
    const pre = registre.creer({
      declencheur: "veille",
      agentId: "agent-a",
      motif: "echo bonjour",
      portee: "exacte",
    });
    const outcome = await stack.execution.execute({
      agentId: "agent-a",
      command: "echo bonjour",
      origin: "run_command",
    });
    expect(outcome.status).toBe("awaiting_validation");
    // Elle n'a PAS été consommée : elle reste disponible pour la tâche de fond.
    expect(registre.get(pre.id)?.consommeeLe).toBeUndefined();
    expect(registre.get(pre.id)?.consommations).toBe(0);
  });

  it("une commande hors motif est REFUSÉE (le doute vaut refus)", async () => {
    const { stack, registre } = await pile();
    stack.store.configure("agent-a", { level: "always" });
    registre.creer({
      declencheur: "veille",
      agentId: "agent-a",
      motif: "echo bonjour",
      portee: "exacte",
    });
    const outcome = await stack.execution.execute({
      agentId: "agent-a",
      command: "rm -rf /tmp/x",
      origin: "declencheur:veille",
    });
    expect(outcome.status).toBe("refused");
    expect(outcome.message).toContain("ne correspond à AUCUN motif");
  });

  it("une pré-autorisation EXPIRÉE refuse", async () => {
    const stack = await startTestStack();
    stacks.push(stack);
    let horloge = Date.now();
    stack.register("agent-a");
    const registre = new PreAutorisationStore({
      path: join(stack.dir, "preautorisations.json"),
      now: () => horloge,
    });
    stack.execution.setPreAutorisations(registre);
    stack.store.configure("agent-a", { level: "always" });
    registre.creer({ declencheur: "veille", agentId: "agent-a", motif: "echo bonjour" });
    horloge += 31 * 86_400_000;
    const outcome = await stack.execution.execute({
      agentId: "agent-a",
      command: "echo bonjour",
      origin: "declencheur:veille",
    });
    expect(outcome.status).toBe("refused");
    expect(outcome.message).toContain("EXPIRÉE");
  });

  it("un agent DIFFÉRENT de celui autorisé refuse", async () => {
    const { stack, registre } = await pile("agent-a");
    stack.store.configure("agent-a", { level: "always" });
    // agent-b existe mais n'a AUCUNE autorisation pour ce déclencheur.
    stack.store.markSeen("agent-b");
    stack.store.configure("agent-b", { level: "always" });
    registre.creer({ declencheur: "veille", agentId: "agent-a", motif: "echo bonjour" });
    const outcome = await stack.execution.execute({
      agentId: "agent-b",
      command: "echo bonjour",
      origin: "declencheur:veille",
    });
    expect(outcome.status).toBe("refused");
    expect(outcome.message).toContain("aucune autorisation pour cet agent");
  });

  it("une pré-autorisation RÉVOQUÉE refuse", async () => {
    const { stack, registre } = await pile();
    stack.store.configure("agent-a", { level: "always" });
    const pre = registre.creer({
      declencheur: "veille",
      agentId: "agent-a",
      motif: "echo bonjour",
    });
    expect(registre.revoquer(pre.id)).toBe(true);
    const outcome = await stack.execution.execute({
      agentId: "agent-a",
      command: "echo bonjour",
      origin: "declencheur:veille",
    });
    expect(outcome.status).toBe("refused");
    expect(outcome.message).toContain("RÉVOQUÉE");
  });

  it("une pré-autorisation = UNE exécution (la seconde redemande une approbation)", async () => {
    const { stack, registre } = await pile();
    stack.store.configure("agent-a", { level: "always" });
    registre.creer({
      declencheur: "veille",
      agentId: "agent-a",
      motif: "echo bonjour",
    });
    const premiere = await stack.execution.execute({
      agentId: "agent-a",
      command: "echo bonjour",
      origin: "declencheur:veille",
    });
    expect(premiere.status).toBe("completed");
    const seconde = await stack.execution.execute({
      agentId: "agent-a",
      command: "echo bonjour",
      origin: "declencheur:veille",
    });
    expect(seconde.status).toBe("awaiting_validation");
  });

  it("une commande DESTRUCTRICE n'est consommée que si elle est explicitement autorisée", async () => {
    const { stack, registre } = await pile();
    // Niveau 3 : seules les destructrices demandent une validation.
    stack.store.configure("agent-a", { level: "destructive" });
    const pre = registre.creer({
      declencheur: "veille",
      agentId: "agent-a",
      motif: "rm -rf /tmp/x",
      destructifAutorise: false,
    });
    const refuse = await stack.execution.execute({
      agentId: "agent-a",
      command: "rm -rf /tmp/x",
      origin: "declencheur:veille",
    });
    expect(refuse.status).toBe("refused");
    expect(refuse.message).toContain("DESTRUCTRICE");
    // Toujours disponible : le refus ne consomme rien.
    expect(registre.get(pre.id)?.consommations).toBe(0);
  });

  it("un refus de pré-autorisation laisse une ligne de journal (aucun refus muet)", async () => {
    const { stack, registre, journal } = await pile();
    stack.store.configure("agent-a", { level: "always" });
    registre.creer({ declencheur: "veille", agentId: "agent-a", motif: "echo bonjour" });
    await stack.execution.execute({
      agentId: "agent-a",
      command: "echo autre",
      origin: "declencheur:veille",
    });
    const refus = journal.recent(50, { types: ["refus"] });
    expect(refus.length).toBeGreaterThanOrEqual(1);
    expect(refus[0]?.raison).toContain("pré-autorisation");
  });

  it("un tour SANS pré-autorisation du tout garde le comportement historique (niveau 4)", async () => {
    const { stack } = await pile();
    // Niveau 4 : aucune validation n'est requise, la pré-autorisation est sans objet.
    const outcome = await stack.execution.execute({
      agentId: "agent-a",
      command: "echo libre",
      origin: "declencheur:veille",
    });
    expect(outcome.status).toBe("completed");
  });
});
