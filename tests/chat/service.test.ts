/**
 * Service de DISCUSSION (lot 18, lot 1).
 *
 * Ce que ce fichier verrouille :
 *  - le mode est LU à chaque appel (`apply: hot`), replié sur `local` si la
 *    valeur n'est pas un mode connu (jamais une exception dans une route) ;
 *  - le statut ne porte NI secret NI URL, seulement un état et une raison ;
 *  - en mode distant, la CRÉATION est refusée avec un motif lisible — le même
 *    que celui opposé au transport ;
 *  - `chat.remoteAgents` / `chat.remoteMemory` sont LUS (défaut `desactive`) :
 *    ce sont des réglages, pas des constantes cachées.
 *
 * ⚠️ Échoue sur le code d'origine : `src/chat/` n'y existe pas.
 */

import { describe, expect, it } from "vitest";

import {
  ChatService,
  type ChatMirror,
  type ChatServiceOptions,
  type RemoteConversation,
} from "../../src/chat/index.js";

/** Service construit sur un mode PILOTABLE (aucun fichier, aucune config). */
function serviceWith(mode: string, extra: Partial<ChatServiceOptions> = {}) {
  let current = mode;
  const service = new ChatService({ mode: () => current, ...extra });
  return {
    service,
    setMode(next: string) {
      current = next;
    },
  };
}

describe("mode de discussion — lu à chaud, jamais deviné", () => {
  it("le mode par défaut du service est `local` et la création y est permise", () => {
    const { service } = serviceWith("local");
    expect(service.mode()).toBe("local");
    expect(service.isRemote()).toBe(false);
    expect(service.creationRefusal()).toBeNull();
    expect(service.status().creation).toEqual({ autorisee: true });
  });

  it("un mode inconnu retombe sur `local` (aucune exception dans une route)", () => {
    const { service } = serviceWith("irc");
    expect(service.mode()).toBe("local");
    expect(service.adapter()).not.toBeNull();
  });

  it("le statut SUIT le mode sans redémarrage (apply: hot)", () => {
    const { service, setMode } = serviceWith("local");
    expect(service.status().plateforme.etat).toBe("on");
    setMode("mattermost");
    const status = service.status();
    expect(status.mode).toBe("mattermost");
    // ⚠️ Depuis le lot 2, Mattermost est LIVRÉ mais son fournisseur d'adaptateur est
    // enregistré au démarrage du serveur : ici, aucun n'est câblé, donc l'état est `off`
    // et le motif DIT QUOI FAIRE (URL + jeton dans /config → Discussions).
    expect(status.plateforme.etat).toBe("off");
    expect(status.plateforme.raison).toContain("/config → Discussions");
    setMode("discord");
    expect(service.status().plateforme).toMatchObject({
      etat: "off",
      raison: "Discord n'est pas encore configuré.",
    });
  });
});

describe("mode distant — création refusée avec un motif lisible", () => {
  it("Mattermost : refus explicite (la liste vient des canaux synchronisés)", () => {
    const { service } = serviceWith("mattermost");
    const refusal = service.creationRefusal();
    expect(refusal).toContain("création d'une conversation locale est désactivée");
    expect(service.status().creation).toEqual({ autorisee: false, raison: refusal });
    expect(service.isRemote()).toBe(true);
  });

  it("Discord : refus explicite (« pas encore configuré »)", () => {
    const { service } = serviceWith("discord");
    expect(service.creationRefusal()).toContain("Discord n'est pas encore configuré");
    expect(service.status().creation.autorisee).toBe(false);
  });
});

describe("capacités distantes — réglages lus, défaut SÉCURISÉ", () => {
  it("agents et mémoire sont DÉSACTIVÉS par défaut", () => {
    const { service } = serviceWith("mattermost");
    expect(service.remoteAgents()).toBe("desactive");
    expect(service.remoteMemory()).toBe("desactive");
    expect(service.status().distant).toEqual({ agents: "desactive", memoire: "desactive" });
  });

  it("les deux réglages sont réellement LUS (ce ne sont pas des constantes)", () => {
    const { service } = serviceWith("mattermost", {
      remoteAgents: () => "actives",
      remoteMemory: () => "actives",
    });
    expect(service.status().distant).toEqual({ agents: "actives", memoire: "actives" });
  });

  it("une valeur inattendue retombe sur `desactive` (jamais une activation par accident)", () => {
    const { service } = serviceWith("mattermost", { remoteAgents: () => "oui" });
    expect(service.remoteAgents()).toBe("desactive");
  });
});

describe("miroir — lecture seule, vide au lot 1", () => {
  it("aucune conversation distillée quand le miroir est vide", () => {
    const { service } = serviceWith("mattermost");
    expect(service.conversations()).toEqual([]);
    expect(service.conversation("mm-canal")).toBeNull();
    expect(service.status().plateforme.dernierContact).toBeUndefined();
  });

  it("un miroir fourni est exposé tel quel, `dernierContact` = activité la plus récente", () => {
    const conversations: RemoteConversation[] = [
      {
        id: "mm-a",
        platform: "mattermost",
        remoteId: "a",
        title: "Canal A",
        updatedAt: "2026-10-30T09:00:00.000Z",
        messageCount: 3,
        readOnly: true,
        canRun: true,
      },
      {
        id: "mm-b",
        platform: "mattermost",
        remoteId: "b",
        title: "Canal B",
        updatedAt: "2026-10-31T09:00:00.000Z",
        messageCount: 1,
        readOnly: true,
        canRun: true,
      },
    ];
    const mirror: ChatMirror = { conversations: () => conversations, messages: () => [] };
    const service = new ChatService({ mode: () => "mattermost", mirror });
    expect(service.conversation("mm-b")?.title).toBe("Canal B");
    expect(service.status().plateforme.dernierContact).toBe("2026-10-31T09:00:00.000Z");
  });
});
