/**
 * Service de notifications : déclencheurs, décision, envoi, nettoyage des
 * abonnements morts, et non-double-notification des rapports de tâche.
 *
 * Le transport réel vers un service de push n'est PAS exercé ici (il faudrait
 * un navigateur abonné) : on injecte `send` et on vérifie le COMPORTEMENT.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ApprovalGatewayPort, ApprovalViewEvent } from "../../src/agents/execution.js";
import type { PiEvent, PiHost } from "../../src/pi/index.js";
import { createLogger } from "../../src/observability/logger.js";
import { buildNotification, createPushService } from "../../src/push/service.js";
import { PushSubscriptionStore } from "../../src/push/store.js";
import type { NotificationPayload, PushSendOutcome } from "../../src/push/types.js";

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });

function makeStore(withSub = true) {
  const dir = mkdtempSync(join(tmpdir(), "yuki-push-svc-"));
  const store = new PushSubscriptionStore({ path: join(dir, "subs.json") });
  if (withSub) {
    store.upsert({
      deviceId: "dev-1",
      endpoint: "https://push.example/ep-1",
      p256dh: "AAA",
      auth: "BBB",
    });
  }
  return store;
}

function service(options: {
  store?: PushSubscriptionStore;
  enabled?: boolean;
  presence?: () => Array<{ sessionId: string | null; visible: boolean; focused: boolean }>;
  send?: (sub: unknown, payload: NotificationPayload) => Promise<PushSendOutcome>;
}) {
  return createPushService({
    store: options.store ?? makeStore(),
    publicKey: "PUBLIC-KEY",
    logger,
    enabled: () => options.enabled ?? true,
    presence: options.presence ?? (() => []),
    send:
      options.send ??
      (async () => ({ status: "sent", statusCode: 201 }) as PushSendOutcome),
  });
}

describe("buildNotification", () => {
  it("validation : titre explicite et commande dans le corps", () => {
    const payload = buildNotification({ kind: "approval", sessionId: "s1", detail: "rm -rf /tmp/x" });
    expect(payload.title).toBe("Validation en attente");
    expect(payload.body).toContain("rm -rf /tmp/x");
    expect(payload.data).toEqual({ kind: "approval", sessionId: "s1", url: "/?session=s1" });
    expect(payload.tag).toBe("yuki-approval-s1");
  });

  it("tâche de fond et réponse prête : contenus génériques, URL ciblée", () => {
    expect(buildNotification({ kind: "job_report", sessionId: "s2" }).body).toContain("tâche de fond");
    const done = buildNotification({ kind: "run_finished", sessionId: "s3" });
    expect(done.title).toBe("Réponse prête");
    expect(done.data.url).toBe("/?session=s3");
  });

  it("sans conversation : URL racine", () => {
    expect(buildNotification({ kind: "run_finished" }).data.url).toBe("/");
  });

  it("tronque un détail trop long (lisibilité)", () => {
    const payload = buildNotification({ kind: "approval", sessionId: "s", detail: "x".repeat(500) });
    expect(payload.body.length).toBeLessThanOrEqual(200);
    expect(payload.body.endsWith("…")).toBe(true);
  });
});

describe("PushService.notify", () => {
  it("ne fait RIEN si le service est désactivé", async () => {
    const send = vi.fn(async (_sub: unknown, _payload: NotificationPayload): Promise<PushSendOutcome> => ({ status: "sent", statusCode: 201 }));
    const svc = service({ enabled: false, send });
    const result = await svc.notify({ kind: "approval", sessionId: "s1" });
    expect(result.skipped).toBe("disabled");
    expect(send).not.toHaveBeenCalled();
  });

  it("ne fait RIEN sans appareil abonné", async () => {
    const send = vi.fn(async (_sub: unknown, _payload: NotificationPayload): Promise<PushSendOutcome> => ({ status: "sent", statusCode: 201 }));
    const svc = service({ store: makeStore(false), send });
    const result = await svc.notify({ kind: "approval", sessionId: "s1" });
    expect(result.skipped).toBe("no_subscriptions");
    expect(send).not.toHaveBeenCalled();
  });

  it("SUPPRIME quand l'utilisateur regarde déjà (décision anti-spam)", async () => {
    const send = vi.fn(async (_sub: unknown, _payload: NotificationPayload): Promise<PushSendOutcome> => ({ status: "sent", statusCode: 201 }));
    const svc = service({
      send,
      presence: () => [{ sessionId: "s1", visible: true, focused: true }],
    });
    const result = await svc.notify({ kind: "run_finished", sessionId: "s1" });
    expect(result.skipped).toBe("watching");
    expect(send).not.toHaveBeenCalled();
  });

  it("envoie à chaque appareil abonné", async () => {
    const store = makeStore();
    store.upsert({ deviceId: "dev-2", endpoint: "https://push.example/ep-2", p256dh: "AAA", auth: "BBB" });
    const send = vi.fn(async (_sub: unknown, _payload: NotificationPayload): Promise<PushSendOutcome> => ({ status: "sent", statusCode: 201 }));
    const svc = service({ store, send });
    const result = await svc.notify({ kind: "job_report", sessionId: "s1" });
    expect(send).toHaveBeenCalledTimes(2);
    expect(result.sent).toBe(true);
    expect(result.sentCount).toBe(2);
  });

  it("RETIRE un abonnement MORT (404/410) au lieu de boucler dessus", async () => {
    const store = makeStore();
    const svc = service({
      store,
      send: async (subscription: unknown) => {
        const endpoint = (subscription as { endpoint: string }).endpoint;
        if (endpoint.endsWith("ep-1")) return { status: "gone", statusCode: 410 };
        return { status: "sent", statusCode: 201 };
      },
    });
    const result = await svc.notify({ kind: "approval", sessionId: "s1" });
    expect(result.removedCount).toBe(1);
    expect(store.size).toBe(0);
  });

  it("CONSERVE l'abonnement sur échec réseau (ce n'est pas un abonnement mort)", async () => {
    const store = makeStore();
    const svc = service({
      store,
      send: async () => ({ status: "error", error: "ECONNREFUSED" }),
    });
    const result = await svc.notify({ kind: "approval", sessionId: "s1" });
    expect(result.failedCount).toBe(1);
    expect(store.size).toBe(1);
    expect(result.sent).toBe(false);
  });
});

/* ─── Déclencheurs réels (faux hôte Pi + faux registre d'approbations) ──── */
function fakeHost() {
  const listeners = new Set<(event: PiEvent) => void>();
  const host = {
    subscribeAll(listener: (event: PiEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event: PiEvent) {
      for (const listener of [...listeners]) listener(event);
    },
  };
  return host as unknown as PiHost & { emit(event: PiEvent): void };
}

function fakeApprovals() {
  const listeners = new Set<(event: ApprovalViewEvent) => void>();
  const port = {
    subscribeApprovals(listener: (event: ApprovalViewEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    pendingApprovals: () => [],
    decideApproval: async () => ({ ok: false, code: "x", message: "x" }),
    emit(event: ApprovalViewEvent) {
      for (const listener of [...listeners]) listener(event);
    },
  };
  return port as unknown as ApprovalGatewayPort & { emit(event: ApprovalViewEvent): void };
}

describe("PushService.bind — déclencheurs", () => {
  it("notifie sur fin de tâche de fond, validation en attente et réponse prête", async () => {
    const store = makeStore();
    const send = vi.fn(async (_sub: unknown, _payload: NotificationPayload): Promise<PushSendOutcome> => ({ status: "sent", statusCode: 201 }));
    const svc = service({ store, send });
    const host = fakeHost();
    const approvals = fakeApprovals();
    svc.bind({ host, approvals });

    host.emit({ type: "job_report", sessionId: "s1", jobId: "j1" } as PiEvent);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    approvals.emit({
      kind: "requested",
      approval: { id: "a1", agentId: "ag", command: "ls", sessionId: "s1" },
    } as unknown as ApprovalViewEvent);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect((send.mock.calls[1][1] as NotificationPayload).title).toBe("Validation en attente");

    host.emit({ type: "run_finished", sessionId: "s2", runId: "r9", reason: "done" } as PiEvent);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    expect((send.mock.calls[2][1] as NotificationPayload).title).toBe("Réponse prête");
  });

  it("NE notifie PAS deux fois : le run de rapport qui suit un job_report est ignoré", async () => {
    const store = makeStore();
    const send = vi.fn(async (_sub: unknown, _payload: NotificationPayload): Promise<PushSendOutcome> => ({ status: "sent", statusCode: 201 }));
    const svc = service({ store, send });
    const host = fakeHost();
    svc.bind({ host });

    host.emit({ type: "run_started", sessionId: "s1", runId: "r1", origin: "job_report" } as PiEvent);
    host.emit({ type: "job_report", sessionId: "s1", jobId: "j1" } as PiEvent);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    host.emit({ type: "run_finished", sessionId: "s1", runId: "r1", reason: "done" } as PiEvent);
    // Laisse une chance à une seconde notification (qui ne doit PAS venir).
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("ignore une annulation volontaire (l'utilisateur est devant)", async () => {
    const store = makeStore();
    const send = vi.fn(async (_sub: unknown, _payload: NotificationPayload): Promise<PushSendOutcome> => ({ status: "sent", statusCode: 201 }));
    const svc = service({ store, send });
    const host = fakeHost();
    svc.bind({ host });
    host.emit({ type: "run_finished", sessionId: "s1", runId: "r1", reason: "abort" } as PiEvent);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(send).not.toHaveBeenCalled();
  });

  it("unbind() coupe les déclencheurs", async () => {
    const send = vi.fn(async (_sub: unknown, _payload: NotificationPayload): Promise<PushSendOutcome> => ({ status: "sent", statusCode: 201 }));
    const svc = service({ send });
    const host = fakeHost();
    const off = svc.bind({ host });
    off();
    host.emit({ type: "job_report", sessionId: "s1", jobId: "j1" } as PiEvent);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(send).not.toHaveBeenCalled();
  });
});
