/**
 * POLITIQUE « IMAGE CONSOMMÉE UNE FOIS » — test unitaire de `limitContextImages`.
 *
 * ⚠️ Ce que ce fichier verrouille, et pourquoi il existe :
 *
 * 1. **Le tour qui PORTE l'image la voit.** Une image fraîche (pièce jointe du
 *    message en cours, ou résultat de `lire_fichier`) part TOUJOURS : la vision
 *    reste active, on ne « corrige » rien en la désactivant.
 * 2. **Les tours suivants ne la re-transmettent PLUS.** C'est le incident réel du
 *    2026-11-01 : le SDK re-sérialise tout l'historique à chaque requête, donc une
 *    image rendue au tour 3 repartait aux tours 4, 5, 6… jusqu'au
 *    `500 « request entity too large »` alors que le contexte TEXTE était petit
 *    (« redescendu à 23 k » après compactage).
 * 3. **Le plafond de la requête est respecté** même DANS un seul tour (une boucle
 *    d'outils qui lit trois images ne peut pas envoyer trois fois 700 Ko).
 * 4. **L'historique n'est jamais modifié** : on ne renvoie qu'une COPIE — le
 *    message d'origine garde son bloc image (le JSONL et l'UI restent complets).
 */

import { describe, expect, it } from "vitest";

import {
  limitContextImages,
  REMOVED_IMAGE_TEXT,
} from "../../src/pi/sdk/context-images.js";

const BUDGET = 1_500_000;

/** Bloc image de `size` octets base64 (contenu volontairement trivial). */
function image(size: number): { type: "image"; data: string; mimeType: string } {
  return { type: "image", data: "A".repeat(size), mimeType: "image/jpeg" };
}

function user(text: string, ...extra: unknown[]): { role: "user"; content: unknown[] } {
  return { role: "user", content: [{ type: "text", text }, ...extra] };
}

function toolResult(name: string, ...extra: unknown[]): {
  role: "toolResult";
  content: unknown[];
} {
  return {
    role: "toolResult",
    content: [{ type: "text", text: `Image « ${name} » : elle t'est jointe.` }, ...extra],
  };
}

function countImages(messages: Array<{ content: unknown }>): number {
  let total = 0;
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content as Array<{ type?: string }>) {
      if (block.type === "image") total += 1;
    }
  }
  return total;
}

function imageBytes(messages: Array<{ content: unknown }>): number {
  let total = 0;
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content as Array<{ type?: string; data?: string }>) {
      if (block.type === "image" && typeof block.data === "string") total += block.data.length;
    }
  }
  return total;
}

describe("limitContextImages — une image vue ne repart pas au tour suivant", () => {
  it("garde l'image du tour EN COURS et retire celle du tour PRÉCÉDENT", () => {
    const messages = [
      user("regarde", image(700_000)),
      { role: "assistant", content: [{ type: "text", text: "Je vois." }] },
      user("et maintenant ?"),
    ];

    const { messages: sent, stats } = limitContextImages(messages, { budgetBytes: BUDGET });

    // L'image du tour 1 a disparu…
    expect(countImages(sent)).toBe(0);
    expect(stats.dropped).toBe(1);
    expect(stats.stale).toBe(1);
    expect(stats.overflow).toBe(0);
    // …et sa place est TENUE par un texte qui dit la vérité ET comment la revoir.
    const firstContent = sent[0]?.content as Array<{ type: string; text?: string }>;
    expect(firstContent.some((block) => block.text === REMOVED_IMAGE_TEXT)).toBe(true);
    expect(REMOVED_IMAGE_TEXT).toContain("lire_fichier");
  });

  it("garde l'image FRAÎCHE rendue par un outil dans le tour en cours (vision active)", () => {
    const messages = [
      user("lis cette capture"),
      { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "lire_fichier" }] },
      toolResult("capture.png", image(700_000)),
    ];

    const { messages: sent, stats } = limitContextImages(messages, { budgetBytes: BUDGET });

    expect(countImages(sent)).toBe(1);
    expect(stats.kept).toBe(1);
    expect(stats.dropped).toBe(0);
  });

  it("borne une BOUCLE d'outils : la plus ANCIENNE image du tour cède la place", () => {
    const messages = [
      user("lis les trois captures"),
      { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "lire_fichier" }] },
      toolResult("a.png", image(700_000)),
      { role: "assistant", content: [{ type: "toolCall", id: "t2", name: "lire_fichier" }] },
      toolResult("b.png", image(700_000)),
      { role: "assistant", content: [{ type: "toolCall", id: "t3", name: "lire_fichier" }] },
      toolResult("c.png", image(700_000)),
    ];

    const { messages: sent, stats } = limitContextImages(messages, { budgetBytes: BUDGET });

    // 3 × 700 000 > 1 500 000 ⇒ deux images tiennent, la troisième (la plus
    // ancienne) est retirée. C'est la PLUS FRAÎCHE qui survit.
    expect(countImages(sent)).toBe(2);
    expect(imageBytes(sent)).toBeLessThanOrEqual(BUDGET);
    expect(stats.dropped).toBe(1);
    expect(stats.overflow).toBe(1);
    // Le texte du résultat d'outil reste : l'identifiant du fichier est conservé,
    // donc « relis-la » est réellement exécutable.
    const second = sent[2]?.content as Array<{ type: string; text?: string }>;
    expect(second[0]).toMatchObject({ type: "text" });
    expect(second.some((block) => block.text === REMOVED_IMAGE_TEXT)).toBe(true);
  });

  it("ne modifie JAMAIS les messages reçus (historique et UI intacts)", () => {
    const messages = [user("regarde", image(700_000)), user("et maintenant ?")];
    const before = JSON.stringify(messages);

    const { messages: sent } = limitContextImages(messages, { budgetBytes: BUDGET });

    expect(JSON.stringify(messages)).toBe(before);
    expect(sent).not.toBe(messages);
    expect(countImages(messages as Array<{ content: unknown }>)).toBe(1);
    expect(countImages(sent)).toBe(0);
  });

  it("budget 0 (ou non fini) ⇒ aucune borne, comportement d'origine", () => {
    const messages = [user("regarde", image(700_000)), user("et maintenant ?")];
    for (const budgetBytes of [0, -1, Number.NaN]) {
      const { messages: sent, stats } = limitContextImages(messages, { budgetBytes });
      expect(countImages(sent)).toBe(1);
      expect(stats).toMatchObject({ dropped: 0, kept: 0 });
    }
  });

  it("un contexte sans image est rendu TEL QUEL (aucune allocation)", () => {
    const messages = [user("bonjour"), { role: "assistant", content: [{ type: "text", text: "Salut." }] }];
    const { messages: sent, stats } = limitContextImages(messages, { budgetBytes: BUDGET });
    expect(sent).toEqual(messages);
    expect(sent[0]).toBe(messages[0]);
    expect(stats.dropped).toBe(0);
  });

  it("une image qui dépasse À ELLE SEULE le budget est retirée (le plafond est DUR)", () => {
    const messages = [user("regarde", image(2_000_000))];
    const { messages: sent, stats } = limitContextImages(messages, { budgetBytes: BUDGET });
    // ⚠️ Priorité au PLAFOND : un corps refusé (`500 request entity too large`)
    // bloque TOUT, alors qu'une image retirée laisse le modèle répondre en le
    // disant (le bloc texte explique comment la revoir). La RÉDUCTION, elle, est
    // le travail de `files/vision.ts` — en amont, jamais ici.
    expect(countImages(sent)).toBe(0);
    expect(stats.overflow).toBe(1);
    expect(stats.stale).toBe(0);
    expect(stats.droppedBytes).toBe(2_000_000);
  });
});
