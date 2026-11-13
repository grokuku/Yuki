/**
 * Service de DISCUSSION (lot 18, lot 1).
 *
 * Ce que ce fichier verrouille :
 *  - les INTERRUPTEURS de plateforme (`chat.<plateforme>.enabled`) sont LUS à
 *    chaque appel : 0, 1 ou 2 plateformes actives, INDÉPENDAMMENT ;
 *  - ⚠️ le LOCAL n'est jamais coupé : la CRÉATION d'une conversation locale
 *    n'est plus refusée (l'ancien refus `CREATION_REFUSALS` est retiré avec le
 *    mode exclusif) ;
 *  - le statut ne porte NI secret NI URL, seulement un état et une raison ;
 *  - `chat.remoteAgents` est LU (défaut `desactive`) : c'est un réglage, pas une
 *    constante cachée ; `chat.remoteMemory` a été RETIRÉ (aucun consommateur).
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

/**
 * Service construit sur des INTERRUPTEURS pilotables (aucun fichier, aucune config).
 *
 * ⚠️ `mode` reste une valeur de compatibilité ; ce qui décide, c'est `actifs`.
 */
function serviceWith(
  mode: string,
  actifs: readonly ("mattermost" | "discord")[] = [],
  extra: Partial<ChatServiceOptions> = {},
) {
  let current = mode;
  let allumes = new Set(actifs);
  const service = new ChatService({
    mode: () => current,
    enabled: (plateforme) => allumes.has(plateforme),
    ...extra,
  });
  return {
    service,
    setMode(next: string) {
      current = next;
    },
    setActifs(next: readonly ("mattermost" | "discord")[]) {
      allumes = new Set(next);
    },
  };
}

describe("interrupteurs de plateforme — lus à chaud, jamais devinés", () => {
  it("aucune plateforme activée ⇒ le LOCAL seul, et la création est permise", () => {
    const { service } = serviceWith("local");
    expect(service.mode()).toBe("local");
    expect(service.plateformesActives()).toEqual([]);
    expect(service.isRemote()).toBe(false);
    expect(service.creationRefusal()).toBeNull();
    expect(service.status().creation).toEqual({ autorisee: true });
    expect(service.status().plateformes).toEqual({ mattermost: false, discord: false });
    // Sans plateforme activée, l'état décrit le LOCAL — ce n'est pas une panne.
    expect(service.status().plateforme.etat).toBe("on");
  });

  it("un mode inconnu retombe sur `local` (aucune exception dans une route)", () => {
    const { service } = serviceWith("irc");
    expect(service.mode()).toBe("local");
    expect(service.adapter()).not.toBeNull();
  });

  it("le statut SUIT les interrupteurs sans redémarrage (apply: hot)", () => {
    const { service, setActifs } = serviceWith("local");
    setActifs(["mattermost"]);
    expect(service.plateformesActives()).toEqual(["mattermost"]);
    // ⚠️ Mattermost est LIVRÉ mais son fournisseur d'adaptateur est enregistré au
    // démarrage du serveur : ici, aucun n'est câblé, donc l'état est `off` et le motif
    // DIT QUOI FAIRE (URL + jeton dans /config → Conversation).
    expect(service.platformStatus("mattermost").etat).toBe("off");
    expect(service.platformStatus("mattermost").raison).toContain("/config → Conversation");
    // ⚠️ LES DEUX peuvent être allumées EN MÊME TEMPS (c'était la régression).
    setActifs(["mattermost", "discord"]);
    expect(service.status().plateformes).toEqual({ mattermost: true, discord: true });
    expect(service.platformStatus("discord").raison).toContain("/config → Conversation");
  });
});

describe("le LOCAL n'est jamais coupé par une plateforme activée", () => {
  it("deux plateformes actives ⇒ création locale TOUJOURS permise", () => {
    const { service } = serviceWith("mattermost", ["mattermost", "discord"]);
    // ⚠️ C'ÉTAIT LA RÉGRESSION : dès qu'un mode distant était choisi, la création
    // locale et la liste locale disparaissaient.
    expect(service.creationRefusal()).toBeNull();
    expect(service.status().creation).toEqual({ autorisee: true });
    expect(service.isRemote()).toBe(false);
  });

  it("un `chat.mode` distant ne change rien à la disponibilité du local", () => {
    // La clé existe encore (compatibilité) mais ne décide plus de rien.
    const { service } = serviceWith("discord", []);
    expect(service.mode()).toBe("discord");
    expect(service.plateformesActives()).toEqual([]);
    expect(service.creationRefusal()).toBeNull();
  });
});

describe("capacités distantes — DEUX réglages lus, défaut SÉCURISÉ", () => {
  it("agents ET outils sont DÉSACTIVÉS par défaut, et la mémoire n'est plus une clé", () => {
    const { service } = serviceWith("mattermost");
    expect(service.remoteAgents()).toBe("desactive");
    expect(service.remoteTools()).toBe("desactive");
    // ⚠️ LES DEUX valeurs sont exposées par le statut : l'interface ne devine rien.
    expect(service.status().distant).toEqual({ agents: "desactive", outils: "desactive" });
    // ⚠️ `memoire` a disparu avec `chat.remoteMemory` : un champ d'état qui afficherait
    // « désactivée » sans que rien ne puisse l'activer serait un mensonge de plus.
    expect("memoire" in service.status().distant).toBe(false);
  });

  it("les deux réglages sont réellement LUS, et INDÉPENDANTS", () => {
    // « agents non + outils oui » : la configuration que l'utilisateur demandait
    // (génération d'image dans un canal, aucune délégation).
    const outilsSeuls = serviceWith("mattermost", ["mattermost"], { remoteTools: () => "actives" }).service;
    expect(outilsSeuls.status().distant).toEqual({ agents: "desactive", outils: "actives" });
    const agentsSeuls = serviceWith("mattermost", ["mattermost"], { remoteAgents: () => "actives" }).service;
    expect(agentsSeuls.status().distant).toEqual({ agents: "actives", outils: "desactive" });
    const lesDeux = serviceWith("mattermost", ["mattermost"], {
      remoteAgents: () => "actives",
      remoteTools: () => "actives",
    }).service;
    expect(lesDeux.status().distant).toEqual({ agents: "actives", outils: "actives" });
  });

  it("une valeur inattendue retombe sur `desactive` (jamais une activation par accident)", () => {
    const { service } = serviceWith("mattermost", ["mattermost"], {
      remoteAgents: () => "oui",
      remoteTools: () => "ACTIVES",
    });
    expect(service.remoteAgents()).toBe("desactive");
    expect(service.remoteTools()).toBe("desactive");
  });
});

describe("miroir — lecture seule, vide au lot 1", () => {
  it("aucune conversation distillée quand le miroir est vide", () => {
    const { service } = serviceWith("mattermost", ["mattermost"]);
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
    const service = new ChatService({
      mode: () => "mattermost",
      enabled: (plateforme) => plateforme === "mattermost",
      mirror,
    });
    expect(service.conversation("mm-b")?.title).toBe("Canal B");
    expect(service.status().plateforme.dernierContact).toBe("2026-10-31T09:00:00.000Z");
  });
});
