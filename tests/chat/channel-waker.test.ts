/**
 * RÉVEIL d'un job terminé quand sa conversation est un CANAL (2026-11-02).
 *
 * ⚠️ LE DÉFAUT QUE CE FICHIER VERROUILLE : le seul réveil branché en production
 * était le HOST PI (`delegation.setWaker(host)`, `src/index.ts`), qui REFUSE une
 * session qu'il n'a pas ouverte (« Session inconnue. », `src/pi/sdk-host.ts:2295`).
 * Une conversation de canal n'est PAS une session Pi. Un `delegate` lancé depuis
 * Mattermost produisait donc un job dont le résultat n'arrivait **nulle part** :
 * la personne dans le canal attendait indéfiniment.
 *
 * Ce que ce fichier prouve :
 *  1. une conversation LOCALE garde le réveil historique, à l'identique ;
 *  2. un CANAL reçoit une réponse PUBLIÉE (résumée), et le host n'est pas appelé ;
 *  3. si le résumé échoue, une phrase HONNÊTE est publiée (avec l'identifiant du
 *     job, pour que « où en est le job X » ait une réponse) ;
 *  4. si la publication échoue elle-même, l'échec est JOURNALISÉ (jamais avalé en
 *     silence) et aucun rejet non traité n'est produit ;
 *  5. le texte publié est BORNÉ.
 *
 * ⚠️ Échoue sur le code d'origine : `createChannelAwareWaker` n'existe pas, et
 * rien ne publiait le rapport d'un job dans un canal.
 */

import { describe, expect, it, vi } from "vitest";

import {
  CHANNEL_REPORT_MAX_CHARS,
  createChannelAwareWaker,
  reportFallbackText,
} from "../../src/chat/reply/channel-waker.js";
import type { LightWaker } from "../../src/delegation/ports.js";

const CANAL = "mm-canal-1";
const RAPPORT = "[RÉSULTAT DE TÂCHE EN ARRIÈRE-PLAN]\nstatut: completed\ntâche: compter";

/** Réveil historique factice : rend un identifiant de run quand il est appelé. */
function fallbackPort(): LightWaker & { appels: unknown[][] } {
  const appels: unknown[][] = [];
  return {
    appels,
    send(sessionId: string, text: string, opts?: { origin?: string; jobId?: string }) {
      appels.push([sessionId, text, opts]);
      return { runId: "run-1" };
    },
  };
}

/** Laisse tourner la publication (elle est lancée sans `await` par le waker). */
const unTour = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("réveil des jobs — canal distant", () => {
  it("conversation LOCALE : le réveil historique est utilisé à l'identique", () => {
    const fallback = fallbackPort();
    const post = vi.fn(async () => undefined);
    const waker = createChannelAwareWaker({
      fallback,
      summarize: async () => "résumé",
      post,
    });
    const handle = waker.send("session-pi-locale", RAPPORT, { origin: "job_report", jobId: "job-1" });
    expect(handle).toEqual({ runId: "run-1" });
    expect(fallback.appels).toEqual([
      ["session-pi-locale", RAPPORT, { origin: "job_report", jobId: "job-1" }],
    ]);
    expect(post).not.toHaveBeenCalled();
  });

  it("CANAL : le rapport est résumé puis PUBLIÉ dans le canal", async () => {
    const fallback = fallbackPort();
    const publies: Array<{ conversationId: string; text: string }> = [];
    const waker = createChannelAwareWaker({
      fallback,
      summarize: async (report) => {
        expect(report).toBe(RAPPORT);
        return "  La tâche est terminée : 42 fichiers.  ";
      },
      post: async (conversationId, text) => {
        publies.push({ conversationId, text });
      },
    });
    waker.send(CANAL, RAPPORT, { origin: "job_report", jobId: "job-1" });
    await unTour();
    // ⚠️ Aucun run Pi n'est ouvert pour un canal.
    expect(fallback.appels).toEqual([]);
    expect(publies).toEqual([
      { conversationId: CANAL, text: "La tâche est terminée : 42 fichiers." },
    ]);
  });

  it("résumé en échec : une phrase HONNÊTE est publiée, avec l'identifiant du job", async () => {
    const publies: string[] = [];
    const waker = createChannelAwareWaker({
      fallback: fallbackPort(),
      summarize: async () => {
        throw new Error("modèle indisponible");
      },
      post: async (_conversationId, text) => {
        publies.push(text);
      },
    });
    waker.send(CANAL, RAPPORT, { origin: "job_report", jobId: "job-42" });
    await unTour();
    expect(publies).toHaveLength(1);
    expect(publies[0]).toBe(reportFallbackText("job-42"));
    expect(publies[0]).toContain("job-42");
    expect(publies[0]).toContain("pas pu en rédiger le résumé");
  });

  it("publication impossible : l'échec est JOURNALISÉ (jamais silencieux)", async () => {
    const warns: Array<{ message: string; fields?: Record<string, unknown> }> = [];
    const waker = createChannelAwareWaker({
      fallback: fallbackPort(),
      summarize: async () => "résumé",
      post: async () => {
        throw new Error("canal supprimé");
      },
      logger: {
        info: () => undefined,
        warn: (message, fields) => warns.push({ message, ...(fields ? { fields } : {}) }),
      },
    });
    waker.send(CANAL, RAPPORT, { origin: "job_report", jobId: "job-7" });
    await unTour();
    const echec = warns.find((entry) => entry.message === "chat.job_report.failed");
    expect(echec).toBeDefined();
    expect(echec?.fields?.job_id).toBe("job-7");
  });

  it("le texte publié est BORNÉ (jamais un puits non limité dans un canal)", async () => {
    const publies: string[] = [];
    const waker = createChannelAwareWaker({
      fallback: fallbackPort(),
      summarize: async () => "x".repeat(CHANNEL_REPORT_MAX_CHARS * 2),
      post: async (_conversationId, text) => {
        publies.push(text);
      },
    });
    waker.send(CANAL, RAPPORT, { origin: "job_report", jobId: "job-8" });
    await unTour();
    expect(publies[0]!.length).toBeLessThanOrEqual(CHANNEL_REPORT_MAX_CHARS + 32);
    expect(publies[0]).toContain("[…tronqué]");
  });
});
