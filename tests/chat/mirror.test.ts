/**
 * MIROIR — identifiants de conversation et projection en transcript
 * (lot 18, lot 1).
 *
 * Ce que ce fichier verrouille :
 *  - l'identifiant Yuki d'un canal est PRÉFIXÉ (`mm-…`, `dc-…`) : c'est le seul
 *    signe qui distingue un miroir d'une session Pi (il déclenche les refus
 *    d'écriture) ;
 *  - le PARENT (`threadRootId`) et l'AUTEUR survivent à la projection : les fils
 *    dépliables et les participants d'un canal dépendent de ces deux champs ;
 *  - un message supprimé ou modifié le DIT (jamais une disparition silencieuse).
 *
 * ⚠️ Échoue sur le code d'origine : `src/chat/mirror.ts` n'existe pas.
 */

import { describe, expect, it } from "vitest";

import {
  emptyChatMirror,
  isMirrorConversationId,
  mirrorConversationId,
  mirrorPlatformOf,
  mirrorTranscript,
  remoteMessageToTranscript,
  type RemoteMessage,
} from "../../src/chat/index.js";

const message: RemoteMessage = {
  remoteId: "post-1",
  conversationId: "mm-canal-1",
  threadRootId: "post-0",
  author: { id: "u1", nom: "Camille", estBot: false },
  role: "user",
  text: "Bonjour",
  sentAt: "2026-10-30T10:00:00.000Z",
};

describe("identifiants de conversation miroir", () => {
  it("préfixe par plateforme et sait relire le préfixe", () => {
    expect(mirrorConversationId("mattermost", "abc")).toBe("mm-abc");
    expect(mirrorConversationId("discord", "42")).toBe("dc-42");
    expect(mirrorPlatformOf("mm-abc")).toBe("mattermost");
    expect(mirrorPlatformOf("dc-42")).toBe("discord");
    expect(mirrorPlatformOf("sess-1")).toBeNull();
  });

  it("reconnaît un miroir, jamais une session Pi (même vide ou absente)", () => {
    expect(isMirrorConversationId("mm-canal")).toBe(true);
    expect(isMirrorConversationId("dc-1")).toBe(true);
    expect(isMirrorConversationId("1f9b-session-pi")).toBe(false);
    expect(isMirrorConversationId("")).toBe(false);
    expect(isMirrorConversationId(undefined)).toBe(false);
    expect(isMirrorConversationId(null)).toBe(false);
  });
});

describe("projection d'un message distant en transcript", () => {
  it("conserve l'AUTEUR et le PARENT (fils dépliables, participants distincts)", () => {
    const entry = remoteMessageToTranscript(message);
    expect(entry.role).toBe("user");
    expect(entry.text).toBe("Bonjour");
    expect(entry.author).toEqual({ id: "u1", nom: "Camille", estBot: false });
    expect(entry.threadRootId).toBe("post-0");
    expect(entry.id).toBe("post-1");
    expect(entry.timestamp).toBe(Date.parse("2026-10-30T10:00:00.000Z"));
  });

  it("un message racine n'a PAS de parent (et n'en invente pas)", () => {
    const entry = remoteMessageToTranscript({ ...message, threadRootId: undefined });
    expect(entry.threadRootId).toBeUndefined();
  });

  it("dit qu'un message a été MODIFIÉ ou SUPPRIMÉ au lieu de le taire", () => {
    const edited = remoteMessageToTranscript({
      ...message,
      editedAt: "2026-10-30T10:05:00.000Z",
    });
    expect(edited.text).toBe("Bonjour (modifié)");
    const deleted = remoteMessageToTranscript({ ...message, deleted: true });
    expect(deleted.text).toContain("message supprimé");
  });

  it("n'affiche AUCUNE heure si la date est inexploitable (jamais une date inventée)", () => {
    const entry = remoteMessageToTranscript({ ...message, sentAt: "pas une date" });
    expect(entry.timestamp).toBeUndefined();
  });

  it("le miroir du lot 1 est VIDE (aucune synchronisation livrée)", () => {
    const mirror = emptyChatMirror();
    expect(mirror.conversations()).toEqual([]);
    expect(mirror.messages("mm-canal-1")).toEqual([]);
    expect(mirrorTranscript(mirror, "mm-canal-1")).toEqual([]);
  });
});
