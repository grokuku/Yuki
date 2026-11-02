/**
 * RÈGLE DE DÉLÉGATION dans un run de CANAL (lot 23) — et son ABSENCE sous
 * `chat.remoteAgents = desactive`.
 *
 * ⚠️ LE DÉFAUT QUE CE FICHIER VERROUILLE (2026-11-02) : la règle « faire ou
 * déléguer ? » n'existait QUE dans le host LOCAL
 * (`createDelegationExtensionFactory`, `src/pi/sdk-host.ts:2033`). L'écrivain
 * d'un run de canal ne passait aucune `extensionFactories` : le modèle du canal
 * ignorait qu'il pouvait déléguer, faisait le travail long INLINE, et le tour
 * était coupé à `CHAT_REPLY_TIMEOUT_MS` (90 s) sans message.
 *
 * Ce que ce fichier prouve :
 *  1. sous `actives`, les extensions du run portent la RÈGLE (`DELEGATION_RULE`) et
 *     la liste des jobs DU CANAL (`job_id` utilisable) ;
 *  2. la lecture des jobs interroge la CONVERSATION, jamais l'identifiant de la
 *     session éphémère du run ;
 *  3. sous `desactive`, il n'y a AUCUNE règle de DÉLÉGATION (pas d'outil `delegate`,
 *     donc pas de règle qui ordonnerait un outil absent) — mais la CONSIGNE D'ACCUSÉ,
 *     elle, reste : `generer_image` est autorisé dans ce canal, donc l'accusé y a un
 *     déclencheur (décision utilisateur 2026-11-02 : l'accusé est écrit par le modèle) ;
 *  4. le DÉFAUT de `chat.remoteAgents` reste `desactive` — la délégation en canal
 *     est donc impossible par défaut, et c'est un choix documenté.
 *
 * ⚠️ Échoue sur le code d'origine : `RemoteRunTools` n'avait aucune
 * `extensionFactories`, et le prompt d'un run de canal ne contenait pas la règle.
 */

import { describe, expect, it } from "vitest";

import type { DelegateServicePort } from "../../src/delegation/ports.js";
import { CONFIG_SCHEMA } from "../../src/config/schema.js";
import { createRemoteRunTools } from "../../src/pi/index.js";
import { DELEGATION_RULE, PENDING_JOBS_TAG } from "../../src/pi/sdk/delegation-extension.js";

const CANAL = "mm-canal-1";

type Handler = (event: unknown, ctx: unknown) => unknown;

/** Port de délégation : le canal possède UN job en cours, un autre canal un autre. */
function delegationPort(): DelegateServicePort {
  return {
    delegate: async () => ({ status: "dispatched", job_id: "job-1", note: "lancé" }) as never,
    jobStatus: () => undefined,
    cancelJob: async (jobId: string) => ({ status: "cancelled", job_id: jobId }) as never,
    steerJob: async (jobId: string) => ({ status: "steered", job_id: jobId }) as never,
    hasPendingWork: () => false,
    pendingJobs: (sessionId: string) =>
      sessionId === CANAL
        ? [{ jobId: "job-du-canal", task: "générer une bannière", status: "running" }]
        : [{ jobId: "job-d-ailleurs", task: "tâche d'un autre canal", status: "running" }],
  } as unknown as DelegateServicePort;
}

/** Exécute les fabriques d'extension et capture leurs gestionnaires d'événements. */
function capturer(
  factories: readonly unknown[],
): Map<string, Handler[]> {
  const handlers = new Map<string, Handler[]>();
  for (const entree of factories as ReadonlyArray<
    { factory?: unknown } | ((pi: unknown) => void)
  >) {
    const run = typeof entree === "function" ? entree : entree.factory;
    (run as (pi: unknown) => void)({
      on: (name: string, handler: Handler) => {
        const liste = handlers.get(name) ?? [];
        liste.push(handler);
        handlers.set(name, liste);
      },
    });
  }
  return handlers;
}

/**
 * Le prompt système du tour, après passage de TOUTES les extensions du run.
 *
 * ⚠️ Elles se CHAÎNENT (chacune reprend le `systemPrompt` rendu par la précédente) :
 * un run de canal porte à la fois la règle de délégation et la consigne d'accusé.
 */
function promptDuTour(handlers: Map<string, Handler[]>): string | undefined {
  const liste = handlers.get("before_agent_start") ?? [];
  if (liste.length === 0) return undefined;
  // ⚠️ Contexte de la SESSION ÉPHÉMÈRE du run : elle ne désigne aucun fil, donc
  // c'est bien la CONVERSATION qui doit être interrogée pour les jobs.
  const ctx = { sessionManager: { getSessionId: () => "session-ephemere-du-run" } };
  let systemPrompt = "PROMPT DE BASE";
  for (const handler of liste) {
    const resultat = handler({ prompt: "Bonjour", systemPrompt }, ctx) as
      | { systemPrompt?: string }
      | undefined;
    if (resultat?.systemPrompt !== undefined) systemPrompt = resultat.systemPrompt;
  }
  return systemPrompt;
}

describe("règle de délégation — run de CANAL", () => {
  it("sous `actives` : la RÈGLE et les jobs DU CANAL entrent dans le prompt du tour", () => {
    const run = createRemoteRunTools({
      conversationId: CANAL,
      chatMode: "mattermost",
      remoteAgents: true,
      remoteTools: false,
      lightOptions: () => ({ delegationEnabled: true }),
      delegation: delegationPort(),
      logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    });

    expect(run.extensionFactories).toBeDefined();
    const prompt = promptDuTour(capturer(run.extensionFactories ?? []));
    expect(prompt).toBeDefined();
    expect(prompt).toContain("PROMPT DE BASE");
    // ① La règle « faire ou déléguer ? » est là.
    expect(prompt).toContain(DELEGATION_RULE);
    // ③ La consigne d'ACCUSÉ est là aussi, et cite `delegate` (outil réellement présent).
    expect(prompt).toContain("Accusé de réception d'une action longue");
    expect(prompt).toContain("`delegate`");
    // ⚠️ Un run de CANAL n'a jamais `run_command` : la consigne ne doit pas le citer.
    expect(prompt).not.toContain("`run_command`");
    // ② Les jobs de CE canal, avec leur identifiant utilisable par `steer_job`.
    expect(prompt).toContain(`<${PENDING_JOBS_TAG}>`);
    expect(prompt).toContain("job-du-canal");
    expect(prompt).toContain("générer une bannière");
    // ⚠️ Jamais les jobs d'un AUTRE canal.
    expect(prompt).not.toContain("job-d-ailleurs");
  });

  it("sous `desactive` : AUCUNE règle de délégation, mais la consigne d'ACCUSÉ demeure", () => {
    const run = createRemoteRunTools({
      conversationId: CANAL,
      chatMode: "mattermost",
      remoteAgents: false,
      // ⚠️ OUTILS ouverts : c'est le groupe qui porte `generer_image`, donc le
      // déclencheur de l'accusé. Avec les deux réglages fermés il n'y aurait
      // aucune action longue, donc aucune consigne à tester ici.
      remoteTools: true,
      // ⚠️ `imagesEnabled` : c'est le PORT qui rend `generer_image` disponible dans le
      // groupe `outils` (le réglage ouvre la permission, l'option dit si le port existe).
      lightOptions: () => ({ delegationEnabled: true, imagesEnabled: true }),
      delegation: delegationPort(),
    });
    // Et `delegate` n'est pas non plus dans la politique : la règle serait inapplicable.
    expect(run.tools).not.toContain("delegate");

    const prompt = promptDuTour(capturer(run.extensionFactories ?? []));
    expect(prompt).toBeDefined();
    expect(prompt).not.toContain(DELEGATION_RULE);
    // ⚠️ L'accusé, en revanche, GARDE un déclencheur ici (`generer_image`, groupe
    // `outils`) : la consigne est donc présente, et paramétrée par CE run.
    expect(prompt).toContain("Accusé de réception d'une action longue");
    expect(prompt).toContain("`generer_image`");
    expect(prompt).not.toContain("`run_command`");
  });

  it("le DÉFAUT de `chat.remoteAgents` reste `desactive` (délégation en canal impossible par défaut)", () => {
    const schema = CONFIG_SCHEMA["chat.remoteAgents"];
    expect(schema).toBeDefined();
    expect(schema?.default).toBe("desactive");
  });
});
