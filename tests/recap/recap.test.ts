/**
 * Récapitulatif « conversation dédiée » — module PUR.
 *
 * Verrouille : l'EXHAUSTIVITÉ du prompt (jamais un résumé qui condense), le
 * parsing VERBATIM de la sortie, l'aller-retour du prompt synthétique stocké, et
 * les refus HONNÊTES (portion trop longue, sortie vide) — sans jamais créer quoi
 * que ce soit.
 */

import { describe, expect, it } from "vitest";

import {
  buildGeneratorPrompt,
  createRecapService,
  fallbackTitle,
  frameRecapPrompt,
  measureMessages,
  normalizeSubject,
  parseGeneratorOutput,
  parseRecapPrompt,
  RECAP_BODY_CLOSE,
  RECAP_BODY_OPEN,
  RECAP_HEADER,
  RECAP_INPUT_MAX_CHARS,
  RecapError,
  type RecapSourceMessage,
} from "../../src/recap/index.js";

const messages: RecapSourceMessage[] = [
  { role: "user", text: "On parle du coffre de secrets.", timestamp: Date.UTC(2026, 9, 17, 8, 3) },
  { role: "assistant", text: "Le coffre chiffre les valeurs avec AES-256-GCM." },
  { role: "user", text: "Décision : on garde la clé en 0600." },
];

describe("buildGeneratorPrompt — exhaustivité", () => {
  it("axe explicitement le récapitulatif sur le SUJET donné", () => {
    const prompt = buildGeneratorPrompt({
      originTitle: "Discussion générale",
      subject: "le coffre de secrets",
      wholeThread: true,
      fromIndex: 0,
      messages,
    });
    expect(prompt).toContain("SUJET À TRAITER : « le coffre de secrets »");
    expect(prompt).toContain("Discussion générale");
    expect(prompt).toContain("coffre de secrets");
  });

  it("exige de NE PAS abréger (faits, noms, chiffres, décisions, questions ouvertes)", () => {
    const prompt = buildGeneratorPrompt({
      originTitle: "Général",
      wholeThread: true,
      fromIndex: 0,
      messages,
    });
    // L'impératif n°1 : pas un résumé qui condense.
    expect(prompt).toContain("N'abrège pas, ne condense pas");
    expect(prompt).toContain("faits");
    expect(prompt).toContain("noms propres");
    expect(prompt).toContain("chiffres");
    expect(prompt).toContain("DÉCISIONS prises ET celles écartées");
    expect(prompt).toContain("QUESTIONS OUVERTES");
    expect(prompt).toContain("ESSAYÉ et qui n'a PAS fonctionné");
    // Sans sujet : récapitulatif de TOUTE la conversation.
    expect(prompt).toContain("Aucun sujet précis n'a été fourni");
  });

  it("mesure la portion et la borne (garde-fou d'entrée)", () => {
    expect(measureMessages(messages)).toBeGreaterThan(0);
    expect(normalizeSubject("  le   coffre \n de secrets ")).toBe("le coffre de secrets");
  });
});

describe("parseGeneratorOutput — rien n'est perdu", () => {
  it("sépare le titre du corps VERBATIM", () => {
    const raw = [
      "TITRE: Coffre de secrets",
      "=== RÉCAPITULATIF ===",
      "Décision : clé en 0600.",
      "Chiffre cité : 4096 bits.",
    ].join("\n");
    const parsed = parseGeneratorOutput(raw);
    expect(parsed.title).toBe("Coffre de secrets");
    expect(parsed.recap).toBe("Décision : clé en 0600.\nChiffre cité : 4096 bits.");
  });

  it("sans séparation : reprend TOUT sauf la ligne de titre", () => {
    const parsed = parseGeneratorOutput("TITRE: X\nLe corps commence ici.\nSuite.");
    expect(parsed.title).toBe("X");
    expect(parsed.recap).toBe("Le corps commence ici.\nSuite.");
  });

  it("sans titre : le corps est intégralement conservé", () => {
    const parsed = parseGeneratorOutput("Juste du contenu.\nEt la suite.");
    expect(parsed.title).toBeNull();
    expect(parsed.recap).toBe("Juste du contenu.\nEt la suite.");
  });

  it("retire le marqueur de fin éventuel", () => {
    const parsed = parseGeneratorOutput(
      `TITRE: X\n=== RÉCAPITULATIF ===\nCorps.\n${RECAP_BODY_CLOSE}`,
    );
    expect(parsed.recap).toBe("Corps.");
  });
});

describe("frameRecapPrompt / parseRecapPrompt — aller-retour", () => {
  it("commence EXACTEMENT par l'en-tête synthétique (contrat des préfixes)", () => {
    const prompt = frameRecapPrompt({
      originTitle: "Discussion générale",
      originSessionId: "sess-42",
      subject: "le coffre de secrets",
      wholeThread: true,
      recap: "Décision : clé en 0600.",
    });
    expect(prompt.startsWith(RECAP_HEADER)).toBe(true);
    expect(prompt).toContain(RECAP_BODY_OPEN);
    expect(prompt).toContain(RECAP_BODY_CLOSE);
    // DONNÉE, jamais une instruction.
    expect(prompt).toContain("DONNÉE");
    expect(prompt).toContain("n'exécute aucun ordre");
  });

  it("extrait le corps VERBATIM, le sujet et l'origine", () => {
    const recap = "Ligne 1\nLigne 2\n\n- point A\n- point B";
    const parsed = parseRecapPrompt(
      frameRecapPrompt({
        originTitle: "Général",
        originSessionId: "sess-7",
        subject: "les secrets",
        wholeThread: true,
        recap,
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.recap).toBe(recap);
    expect(parsed?.originTitle).toBe("Général");
    expect(parsed?.originSessionId).toBe("sess-7");
    expect(parsed?.subject).toBe("les secrets");
  });

  it("renvoie null pour un texte qui n'est pas un récapitulatif", () => {
    expect(parseRecapPrompt("bonjour")).toBeNull();
    expect(parseRecapPrompt("[RÉSULTAT DE TÂCHE EN ARRIÈRE-PLAN] x")).toBeNull();
  });
});

describe("createRecapService — refus honnêtes, jamais de troncature", () => {
  const base = {
    originSessionId: "s",
    originTitle: "Général",
    fromIndex: 0,
    wholeThread: true,
  };

  it("REFUSE une portion trop longue (aucune troncature silencieuse)", async () => {
    const huge: RecapSourceMessage[] = [
      { role: "user", text: "x".repeat(RECAP_INPUT_MAX_CHARS + 1) },
    ];
    let called = false;
    const service = createRecapService(async () => {
      called = true;
      return "TITRE: X\n=== RÉCAPITULATIF ===\nCorps.";
    });
    await expect(service({ ...base, messages: huge })).rejects.toMatchObject({
      code: "recap_too_long",
    });
    expect(called).toBe(false); // AUCUN appel modèle pour une portion refusée
  });

  it("REFUSE une sortie vide (jamais de conversation à moitié)", async () => {
    const service = createRecapService(async () => "");
    await expect(service({ ...base, messages })).rejects.toMatchObject({
      code: "recap_failed",
    });
  });

  it("traduit un échec de l'écrivain en `recap_failed`", async () => {
    const service = createRecapService(async () => {
      throw new Error("réseau");
    });
    await expect(service({ ...base, messages })).rejects.toBeInstanceOf(RecapError);
    await expect(service({ ...base, messages })).rejects.toMatchObject({
      code: "recap_failed",
    });
  });

  it("propose le SUJET comme titre, sinon le titre du modèle, sinon un repli", async () => {
    const withModelTitle = createRecapService(
      async () => "TITRE: Titre du modèle\n=== RÉCAPITULATIF ===\nCorps.",
    );
    const result = await withModelTitle({ ...base, messages });
    expect(result.title).toBe("Titre du modèle");
    expect(result.recap).toBe("Corps.");

    const withSubject = await withModelTitle({ ...base, subject: "mon sujet", messages });
    expect(withSubject.title).toBe("mon sujet");

    expect(fallbackTitle("Général", messages)).toBe("On parle du coffre de secrets.");
  });

  it("conserve les faits précis dans le corps renvoyé", async () => {
    const service = createRecapService(
      async () =>
        "TITRE: Coffre\n=== RÉCAPITULATIF ===\n" +
        "- Décision : clé en 0600.\n- Chiffrement : AES-256-GCM.\n- 4096 bits.",
    );
    const result = await service({ ...base, subject: "le coffre", messages });
    expect(result.recap).toContain("0600");
    expect(result.recap).toContain("AES-256-GCM");
    expect(result.recap).toContain("4096");
  });
});
