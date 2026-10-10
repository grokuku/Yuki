/**
 * Criterion 6 : la réflexion (`thinking`) n'est jamais assimilable à une réponse
 * ni écrite dans le transcript (contenu seul).
 */

import { describe, expect, it } from "vitest";

import {
  channelForAssistantEvent,
  contentTextFromMessage,
  metricsFromCustomEntry,
  RUN_METRICS_CUSTOM_TYPE,
  sanitizeErrorText,
  transcriptFromEntries,
  unstreamedContentSuffix,
} from "../../src/pi/events.js";
import { APPROVAL_RESULT_HEADER } from "../../src/agents/approval-report.js";
import { SYNTHETIC_USER_PREFIXES } from "../../src/pi/synthetic.js";

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

describe("pi.events — restauration du transcript depuis une session", () => {
  const userEntry = (text: string): unknown => ({
    type: "message",
    id: "u",
    parentId: null,
    timestamp: "2024-12-03T14:00:01.000Z",
    message: { role: "user", content: text },
  });
  const assistantEntry = (content: unknown): unknown => ({
    type: "message",
    id: "a",
    parentId: "u",
    timestamp: "2024-12-03T14:00:02.000Z",
    message: { role: "assistant", content },
  });

  it("ne conserve que user/assistant, en contenu seul et dans l'ordre", () => {
    const entries = [
      userEntry("Bonjour"),
      assistantEntry([
        { type: "thinking", thinking: "raisonnement secret" },
        { type: "text", text: "Salut !" },
      ]),
      userEntry("Ça va ?"),
      assistantEntry([{ type: "text", text: "Très bien." }]),
    ];
    const transcript = transcriptFromEntries(entries);
    expect(transcript).toEqual([
      { role: "user", text: "Bonjour" },
      { role: "assistant", text: "Salut !" },
      { role: "user", text: "Ça va ?" },
      { role: "assistant", text: "Très bien." },
    ]);
    expect(JSON.stringify(transcript)).not.toContain("raisonnement secret");
  });

  it("ignore les entrées non-message et les rôles hors transcript", () => {
    const entries = [
      { type: "session", version: 3, id: "h" },
      { type: "model_change", id: "m", provider: "p", modelId: "x" },
      { type: "compaction", id: "c", summary: "résumé", tokensBefore: 10 },
      userEntry("seul message retenu"),
      {
        type: "message",
        id: "t",
        parentId: "u",
        message: {
          role: "toolResult",
          toolCallId: "x",
          toolName: "read",
          content: [{ type: "text", text: "sortie outil" }],
          isError: false,
        },
      },
      {
        type: "message",
        id: "b",
        parentId: "t",
        message: { role: "bashExecution", command: "ls", output: "a\nb" },
      },
    ];
    expect(transcriptFromEntries(entries)).toEqual([
      { role: "user", text: "seul message retenu" },
    ]);
  });

  it("ignore une entrée sans texte (jamais de bulle muette)", () => {
    const entries = [
      assistantEntry([]),
      assistantEntry([{ type: "thinking", thinking: "seulement du raisonnement" }]),
      assistantEntry([{ type: "toolCall", id: "t", name: "read", arguments: {} }]),
      userEntry(""),
      assistantEntry([{ type: "text", text: "réelle réponse" }]),
    ];
    expect(transcriptFromEntries(entries)).toEqual([
      { role: "assistant", text: "réelle réponse" },
    ]);
  });

  it("filtre les prompts utilisateur synthétiques (report de job)", () => {
    const entries = [
      userEntry("vraie question"),
      assistantEntry([{ type: "text", text: "vraie réponse" }]),
      userEntry("[RÉSULTAT DE TÂCHE EN ARRIÈRE-PLAN]\njob_id: abc"),
      assistantEntry([{ type: "text", text: "Résumé du job." }]),
    ];
    const transcript = transcriptFromEntries(entries, {
      syntheticUserPrefixes: ["[RÉSULTAT DE TÂCHE EN ARRIÈRE-PLAN]"],
    });
    // Le prompt synthétique est masqué ; sa réponse reste (comme en direct).
    expect(transcript).toEqual([
      { role: "user", text: "vraie question" },
      { role: "assistant", text: "vraie réponse" },
      { role: "assistant", text: "Résumé du job." },
    ]);
  });

  it("masque le RÉSULTAT d'une commande validée (prompt synthétique) via les préfixes partagés", () => {
    const entries = [
      userEntry("vraie question"),
      assistantEntry([{ type: "text", text: "vraie réponse" }]),
      userEntry(`${APPROVAL_RESULT_HEADER}\napproval_id: apr-1\nSORTIE-SECRETE`),
      assistantEntry([{ type: "text", text: "Compris." }]),
    ];
    const transcript = transcriptFromEntries(entries, {
      syntheticUserPrefixes: SYNTHETIC_USER_PREFIXES,
    });
    // Le rapport (et donc la sortie brute) n'entre JAMAIS dans le transcript.
    expect(transcript).toEqual([
      { role: "user", text: "vraie question" },
      { role: "assistant", text: "vraie réponse" },
      { role: "assistant", text: "Compris." },
    ]);
    expect(JSON.stringify(transcript)).not.toContain("SORTIE-SECRETE");
  });

  it("est un mapping PUR (même entrée ⇒ même sortie, aucun doublon)", () => {
    const entries = [
      userEntry("un"),
      assistantEntry([{ type: "text", text: "deux" }]),
    ];
    const first = transcriptFromEntries(entries);
    const second = transcriptFromEntries(entries);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  it("tolère des entrées malformées sans lever", () => {
    const entries = [null, 42, "texte", {}, { type: "message" }, userEntry("ok")];
    expect(transcriptFromEntries(entries)).toEqual([{ role: "user", text: "ok" }]);
  });

  it("masque le préfixe d'horodatage et remonte le timestamp du message", () => {
    const entries = [
      {
        type: "message",
        id: "u",
        parentId: null,
        message: {
          role: "user",
          content:
            "[horodatage] 2026-10-07 15:39 (heure locale) Bonjour",
          timestamp: 1_700_000_000_000,
        },
      },
    ];
    expect(transcriptFromEntries(entries)).toEqual([
      { role: "user", text: "Bonjour", timestamp: 1_700_000_000_000 },
    ]);
  });

  it("un ancien message SANS timestamp : pas d'heure, pas d'erreur", () => {
    const entries = [
      { type: "message", id: "u", message: { role: "user", content: "vieux" } },
      { type: "message", id: "a", message: { role: "assistant", content: "ok" } },
      // Timestamp illisible / sentinelle 0 : ignoré aussi (aucune heure).
      {
        type: "message",
        id: "b",
        message: { role: "user", content: "zéro", timestamp: 0 },
      },
      {
        type: "message",
        id: "c",
        message: { role: "assistant", content: "nan", timestamp: Number.NaN },
      },
    ];
    expect(transcriptFromEntries(entries)).toEqual([
      { role: "user", text: "vieux" },
      { role: "assistant", text: "ok" },
      { role: "user", text: "zéro" },
      { role: "assistant", text: "nan" },
    ]);
  });
});

describe("pi.events — statistiques d'exécution persistées (run_metrics)", () => {
  const assistantEntry = (id: string, text: string): unknown => ({
    type: "message",
    id,
    parentId: null,
    timestamp: "2024-12-03T14:00:02.000Z",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
  const metricsEntry = (
    id: string,
    parentId: unknown,
    data: unknown,
    customType: string = RUN_METRICS_CUSTOM_TYPE,
  ): unknown => ({ type: "custom", id, parentId, customType, data });

  it("corrèle par `parentId` et restitue les TROIS valeurs (ttftMs/totalMs/tokensOut)", () => {
    const entries = [
      assistantEntry("a1", "Première réponse"),
      metricsEntry("m1", "a1", {
        ttftMs: 842,
        totalMs: 3120,
        tokensOut: 412,
      }),
    ];
    expect(transcriptFromEntries(entries)).toEqual([
      {
        role: "assistant",
        text: "Première réponse",
        metrics: { ttftMs: 842, totalMs: 3120, tokensOut: 412 },
      },
    ]);
  });

  it("un ancien message SANS entrée de métriques reste SANS pied (aucune ligne)", () => {
    const entries = [assistantEntry("a1", "Réponse sans stats")];
    expect(transcriptFromEntries(entries)).toEqual([
      {
        role: "assistant",
        text: "Réponse sans stats",
      },
    ]);
  });

  it("IGNORE une entrée de métriques ORPHELINE (parentId sans message assistant)", () => {
    const entries = [
      assistantEntry("a1", "Réponse"),
      metricsEntry("m1", "inconnu", { totalMs: 10 }),
      metricsEntry("m2", null, { totalMs: 20 }),
    ];
    const transcript = transcriptFromEntries(entries);
    expect(transcript).toHaveLength(1);
    expect(transcript[0].metrics).toBeUndefined();
  });

  it("n'attache JAMAIS de métriques à un message UTILISATEUR", () => {
    const entries = [
      {
        type: "message",
        id: "u1",
        parentId: null,
        message: { role: "user", content: "question" },
      },
      metricsEntry("m1", "u1", { totalMs: 10 }),
    ];
    expect(transcriptFromEntries(entries)).toEqual([
      { role: "user", text: "question" },
    ]);
    expect(JSON.stringify(transcriptFromEntries(entries))).not.toContain("totalMs");
  });

  it("un autre `customType` est ignoré (aucun pied)", () => {
    const entries = [
      assistantEntry("a1", "Réponse"),
      metricsEntry("m1", "a1", { totalMs: 10 }, "autre.extension"),
    ];
    expect(transcriptFromEntries(entries)[0].metrics).toBeUndefined();
  });

  it("n'expose QUE les trois NOMBRES : tout texte du `data` est ignoré (pas de fuite)", () => {
    const entries = [
      assistantEntry("a1", "Réponse"),
      metricsEntry("m1", "a1", {
        ttftMs: 5,
        totalMs: 9,
        tokensOut: 3,
        // ⚠️ Contenu de prompt synthétique glissé de force : il ne doit JAMAIS
        // ressortir ni dans le transcript ni dans les métriques.
        prompt: "[RÉSULTAT DE TÂCHE EN ARRIÈRE-PLAN] SORTIE-SECRÈTE",
        text: "SORTIE-SECRÈTE",
      }),
    ];
    const transcript = transcriptFromEntries(entries);
    expect(transcript[0].metrics).toEqual({ ttftMs: 5, totalMs: 9, tokensOut: 3 });
    expect(JSON.stringify(transcript)).not.toContain("SORTIE-SECRÈTE");
    expect(JSON.stringify(transcript)).not.toContain("ARRIÈRE-PLAN");
  });

  it("ignore des données malformées (totalMs requis, valeurs non finies)", () => {
    expect(metricsFromCustomEntry({ type: "custom", customType: RUN_METRICS_CUSTOM_TYPE, data: {} })).toBeUndefined();
    expect(
      metricsFromCustomEntry({
        type: "custom",
        customType: RUN_METRICS_CUSTOM_TYPE,
        data: { totalMs: Number.NaN },
      }),
    ).toBeUndefined();
    expect(
      metricsFromCustomEntry({
        type: "custom",
        customType: RUN_METRICS_CUSTOM_TYPE,
        data: { totalMs: 12, ttftMs: "8", tokensOut: null },
      }),
    ).toEqual({ totalMs: 12 });
    expect(metricsFromCustomEntry(null)).toBeUndefined();
  });

  it("reste un mapping PUR (même entrée ⇒ même sortie)", () => {
    const entries = [
      assistantEntry("a1", "Réponse"),
      metricsEntry("m1", "a1", { totalMs: 42 }),
    ];
    const first = transcriptFromEntries(entries);
    const second = transcriptFromEntries(entries);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });
});

describe("pi.events — rattrapage du contenu non streamé", () => {
  it("content vide → aucun delta", () => {
    expect(unstreamedContentSuffix("", "")).toBe("");
    expect(unstreamedContentSuffix("déjà là", "")).toBe("");
  });

  it("streamed vide → tout le contenu (fournisseur sans text_delta)", () => {
    expect(unstreamedContentSuffix("", "Réponse complète.")).toBe(
      "Réponse complète.",
    );
  });

  it("streamed préfixe → uniquement le suffixe manquant (pas de doublon)", () => {
    expect(unstreamedContentSuffix("Bon", "Bonjour")).toBe("jour");
    expect(unstreamedContentSuffix("Bonjour", "Bonjour")).toBe("");
  });

  it("divergence → rien (le transcript reste la source de vérité)", () => {
    expect(unstreamedContentSuffix("Bonjour", "Bonsoir")).toBe("");
  });
});
