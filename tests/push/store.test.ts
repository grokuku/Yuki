/**
 * Store des abonnements push : enregistrement/remplacement par appareil,
 * dédoublonnage par endpoint, retrait, et nettoyage des abonnements MORTS.
 */

import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PushSubscriptionStore } from "../../src/push/store.js";

function open() {
  const dir = mkdtempSync(join(tmpdir(), "yuki-push-store-"));
  const path = join(dir, "push-subscriptions.json");
  return { store: new PushSubscriptionStore({ path }), path };
}

const sub = (overrides: Partial<Parameters<PushSubscriptionStore["upsert"]>[0]> = {}) => ({
  deviceId: "dev-abcdef",
  endpoint: "https://push.example/ep-1",
  p256dh: "AAA",
  auth: "BBB",
  ...overrides,
});

describe("PushSubscriptionStore", () => {
  it("enregistre un appareil et persiste en 0600", () => {
    const { store, path } = open();
    store.upsert(sub());
    expect(store.size).toBe(1);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    expect(raw.subscriptions[0].deviceId).toBe("dev-abcdef");
  });

  it("REMPLACE l'abonnement du même appareil (updatedAt/createdAt préservés)", () => {
    const { store } = open();
    const first = store.upsert(sub());
    const second = store.upsert(
      sub({ endpoint: "https://push.example/ep-2", p256dh: "CCC" }),
    );
    expect(store.size).toBe(1);
    expect(second.endpoint).toBe("https://push.example/ep-2");
    expect(second.createdAt).toBe(first.createdAt);
  });

  it("dédoublonne par ENDPOINT (un endpoint n'est enregistré qu'une fois)", () => {
    const { store } = open();
    store.upsert(sub({ deviceId: "dev-1", endpoint: "https://push.example/same" }));
    store.upsert(sub({ deviceId: "dev-2", endpoint: "https://push.example/same" }));
    expect(store.size).toBe(1);
  });

  it("retire un appareil (et le dit)", () => {
    const { store } = open();
    store.upsert(sub());
    expect(store.remove("dev-abcdef")).toBe(true);
    expect(store.remove("dev-abcdef")).toBe(false);
    expect(store.size).toBe(0);
  });

  it("retire un abonnement MORT par son endpoint (réponse 404/410)", () => {
    const { store } = open();
    store.upsert(sub({ deviceId: "dev-1", endpoint: "https://push.example/dead" }));
    expect(store.removeByEndpoint("https://push.example/dead")).toBe("dev-1");
    expect(store.removeByEndpoint("https://push.example/dead")).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it("relit les abonnements d'un fichier existant", () => {
    const { store, path } = open();
    store.upsert(sub());
    const reopened = new PushSubscriptionStore({ path });
    expect(reopened.size).toBe(1);
    expect(reopened.get("dev-abcdef")?.endpoint).toBe("https://push.example/ep-1");
  });

  it("ignore un fichier corrompu (repart vide, jamais un crash)", () => {
    const { store, path } = open();
    store.upsert(sub());
    writeFileSync(path, "pas du json");
    const reopened = new PushSubscriptionStore({ path });
    expect(reopened.size).toBe(0);
  });
});
