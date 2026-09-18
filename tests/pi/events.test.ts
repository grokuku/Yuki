/**
 * Criterion 6 : la réflexion (`thinking`) n'est jamais assimilable à une réponse
 * ni écrite dans le transcript (contenu seul).
 */

import { describe, expect, it } from "vitest";

import {
  channelForAssistantEvent,
  contentTextFromMessage,
  sanitizeErrorText,
} from "../../src/pi/events.js";

describe("pi.events — contenu vs thinking", () => {
  it("classe les deltas en content/thinking", () => {
    expect(channelForAssistantEvent({ type: "text_delta", delta: "a" })).toBe(
      "content",
    );
    expect(
      channelForAssistantEvent({ type: "thinking_delta", delta: "a" }),
    ).toBe("thinking");
    expect(channelForAssistantEvent({ type: "toolcall_delta" })).toBeNull();
  });

  it("contentTextFromMessage exclut les blocs thinking", () => {
    const text = contentTextFromMessage({
      content: [
        { type: "thinking", thinking: "raisonnement secret" },
        { type: "text", text: "Réponse visible." },
      ],
    });
    expect(text).toBe("Réponse visible.");
    expect(text).not.toContain("raisonnement secret");
  });

  it("sanitizeErrorText masque les clés et jetons des erreurs provider", () => {
    expect(
      sanitizeErrorText("401 Unauthorized: Authorization: Bearer abcdef0123456789"),
    ).not.toContain("abcdef0123456789");
    expect(sanitizeErrorText('{"api_key":"sk-verysecret123456"}')).not.toContain(
      "sk-verysecret123456",
    );
    expect(
      sanitizeErrorText("token=AAAABBBBCCCCDDDDEEEEFFFF0000111122223333"),
    ).not.toContain("AAAABBBBCCCCDDDDEEEEFFFF0000111122223333");
  });
});
