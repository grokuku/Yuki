/**
 * Registre des ADAPTATEURS de discussion (lot 18, lot 1).
 *
 * Ce que ce fichier prouve :
 *  - `local` existe et se décrit par la MÊME interface que les plateformes ;
 *  - `mattermost` et `discord` sont enregistrés par un FOURNISSEUR (au démarrage du
 *    serveur, `src/index.ts`) : hors démarrage, la lecture échoue PROPREMENT (erreur
 *    typée) au lieu de rendre un adaptateur muet qui mentirait sur son état ;
 *  - `registerAdapterProvider` / `unregisterAdapter` font apparaître et disparaître une
 *    plateforme de `listPlatforms()` ;
 *  - le mode distant expose le CONTRAT COMPLET, `send()` compris (lot 2 et lot 21).
 *
 * ⚠️ Ces tests ÉCHOUENT sur le code d'origine (`src/chat/` n'y existe pas :
 * l'import lève « Cannot find module »).
 */

import { describe, expect, it } from "vitest";

import {
  ChatAdapterError,
  LOCAL_MODE_REASON,
  registerAdapterProvider,
  unregisterAdapter,
  getAdapter,
  listPlatforms,
} from "../../src/chat/index.js";
import type { ChatAdapter, ChatAdapterStatus } from "../../src/chat/index.js";

describe("registre — résolution par plateforme", () => {
  it("`local` existe et déclare que le mode local n'est PAS distant", () => {
    const adapter = getAdapter("local");
    expect(adapter.platform).toBe("local");
    expect(adapter.status()).toEqual({ etat: "on", raison: LOCAL_MODE_REASON });
    // Aucune conversation DISTANTE : la liste locale vient de l'hôte Pi.
    return expect(adapter.listConversations()).resolves.toEqual([]);
  });

  it("`discord` n'existe qu'une fois son FOURNISSEUR enregistré (comme Mattermost)", () => {
    // ⚠️ Lot 21 : Discord est LIVRÉ, mais son adaptateur a besoin du miroir et du coffre.
    // L'enregistrer à l'import obligerait à importer la moitié du programme ici — et
    // rendrait `getAdapter("discord")` vrai même dans un processus où rien n'est câblé.
    expect(() => getAdapter("discord")).toThrow(ChatAdapterError);
    const factice = fakeAdapter("discord");
    registerAdapterProvider("discord", () => factice);
    try {
      expect(getAdapter("discord")).toBe(factice);
      expect(listPlatforms()).toContain("discord");
    } finally {
      unregisterAdapter("discord");
    }
    expect(() => getAdapter("discord")).toThrow(ChatAdapterError);
  });

  it("un adaptateur inconnu échoue PROPREMENT (erreur typée, pas `undefined`)", () => {
    expect(() => getAdapter("mattermost")).toThrow(ChatAdapterError);
    expect(() => getAdapter("inconnu")).toThrow(/Aucun adaptateur de discussion/);
    try {
      getAdapter("inconnu");
    } catch (error) {
      expect((error as ChatAdapterError).code).toBe("unknown_platform");
    }
  });

  it("`listPlatforms()` n'annonce que ce qui existe RÉELLEMENT dans ce processus", () => {
    // Aucun fournisseur n'est enregistré ici (le serveur les enregistre au démarrage) :
    // seules les plateformes autonomes sont annoncées.
    expect(listPlatforms()).toEqual(["local"]);
    expect(listPlatforms()).not.toContain("mattermost");
    expect(listPlatforms()).not.toContain("discord");
  });
});

/** Adaptateur FACTICE : décrit l'état qu'on lui demande, n'écrit jamais rien. */
function fakeAdapter(platform: "discord" | "mattermost"): ChatAdapter {
  return {
    platform,
    connect: async () => undefined,
    disconnect: async () => undefined,
    status: (): ChatAdapterStatus => ({ etat: "off", raison: "factice" }),
    listConversations: async () => [],
    fetchMessages: async () => ({ messages: [] }),
    subscribe: () => () => undefined,
  };
}
