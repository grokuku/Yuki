/**
 * Registre des ADAPTATEURS de discussion (lot 18, lot 1).
 *
 * Ce que ce fichier prouve :
 *  - `local` existe et se décrit par la MÊME interface que les plateformes ;
 *  - `discord` est un STUB qui DIT qu'il n'est pas configuré (raison exacte) ;
 *  - `mattermost` n'a AUCUN adaptateur à ce lot (aucun client) — et la lecture
 *    échoue PROPREMENT (erreur typée), jamais un `undefined` silencieux ;
 *  - `listPlatforms()` ne annonce que ce qui existe réellement.
 *
 * ⚠️ Ces tests ÉCHOUENT sur le code d'origine (`src/chat/` n'y existe pas :
 * l'import lève « Cannot find module »).
 */

import { describe, expect, it } from "vitest";

import {
  ChatAdapterError,
  DISCORD_NOT_CONFIGURED_REASON,
  LOCAL_MODE_REASON,
  getAdapter,
  listPlatforms,
} from "../../src/chat/index.js";

describe("registre — résolution par plateforme", () => {
  it("`local` existe et déclare que le mode local n'est PAS distant", () => {
    const adapter = getAdapter("local");
    expect(adapter.platform).toBe("local");
    expect(adapter.status()).toEqual({ etat: "on", raison: LOCAL_MODE_REASON });
    // Aucune conversation DISTANTE : la liste locale vient de l'hôte Pi.
    return expect(adapter.listConversations()).resolves.toEqual([]);
  });

  it("`discord` renvoie le stub avec une raison EXACTE", () => {
    const adapter = getAdapter("discord");
    expect(adapter.platform).toBe("discord");
    expect(adapter.status()).toEqual({
      etat: "off",
      raison: "Discord n'est pas encore configuré.",
    });
    expect(DISCORD_NOT_CONFIGURED_REASON).toBe("Discord n'est pas encore configuré.");
  });

  it("le stub Discord n'écrit jamais rien (aucun `send`)", () => {
    const adapter = getAdapter("discord");
    expect(adapter.send).toBeUndefined();
    // Les lectures rendent VIDE sans lever : l'interface affiche son bandeau.
    return Promise.all([
      expect(adapter.listConversations()).resolves.toEqual([]),
      expect(adapter.fetchMessages("dc-1")).resolves.toEqual({ messages: [] }),
    ]);
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

  it("`listPlatforms()` n'annonce que ce qui existe (Mattermost absent au lot 1)", () => {
    expect(listPlatforms()).toEqual(["local", "discord"]);
    expect(listPlatforms()).not.toContain("mattermost");
  });
});
