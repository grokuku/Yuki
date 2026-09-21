/**
 * Nettoyage « non parlé » du texte TTS (Lot 8).
 *
 * Vérifie la suppression des emojis (simples, modificateurs de peau, séquences
 * ZWJ, drapeaux, sélecteurs de variation), des symboles décoratifs et des
 * caractères invisibles, la normalisation des espaces, le traitement des
 * séquences **coupées entre deux deltas**, et la **préservation** des accents,
 * chiffres, unités et de la ponctuation (dont celle de fin de phrase, dont le
 * segmenteur dépend).
 */

import { describe, expect, it } from "vitest";

import { SpeechSanitizer } from "../../src/tts/sanitize.js";

/** Nettrie un flux fourni en un ou plusieurs fragments. */
function sanitize(fragments: string[]): string {
  const sanitizer = new SpeechSanitizer();
  let out = "";
  for (const fragment of fragments) out += sanitizer.push(fragment);
  return out + sanitizer.flush();
}

const EMOJI = "😀😃😄";
const FAMILY = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}";

describe("SpeechSanitizer — emojis et pictogrammes", () => {
  it("supprime des emojis simples (BMP et hors BMP)", () => {
    expect(sanitize(["Bonjour 😊 le monde."])).toBe("Bonjour le monde.");
    expect(sanitize(["🎉 🚀 🐱 !"])).toBe(" !");
    expect(sanitize(["☺ texte"])).toBe(" texte");
  });

  it("supprime les modificateurs de peau", () => {
    expect(sanitize(["Salut 👍🏽 !"])).toBe("Salut !");
    expect(sanitize(["👋🏻 👋🏿"])).toBe(" ");
  });

  it("supprime les séquences ZWJ (familles, métiers)", () => {
    expect(sanitize([`Famille ${FAMILY} ici`])).toBe("Famille ici");
    expect(sanitize(["\u{1F469}\u200D\u{1F4BB}"])).toBe("");
    expect(sanitize(["\u{1F9D1}\u200D\u{1F33E}"])).toBe("");
  });

  it("supprime les drapeaux (indicateurs régionaux et séquence à tags)", () => {
    expect(sanitize(["Drapeau \u{1F1EB}\u{1F1F7} !"])).toBe("Drapeau !");
    expect(sanitize(["\u{1F1FA}\u{1F1F8}\u{1F1EA}\u{1F1FA}"])).toBe("");
    // 🏴 + tags « gbsct » (drapeau Écosse).
    expect(sanitize(["\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}"])).toBe(
      "",
    );
  });

  it("supprime les sélecteurs de variation (❤️, ☺️) et les keycaps", () => {
    expect(sanitize(["Un cœur ❤️ et une étoile ⭐ !"])).toBe(
      "Un cœur et une étoile !",
    );
    expect(sanitize(["1️⃣ et ✌️"])).toBe("1 et ");
  });
});

describe("SpeechSanitizer — symboles décoratifs", () => {
  it("supprime flèches, coches, puces, étoiles, cœurs et formes", () => {
    expect(sanitize(["A → B ← C"])).toBe("A B C");
    expect(sanitize(["fini ✓ fait ✔"])).toBe("fini fait ");
    expect(sanitize(["• item ‣ autre"])).toBe(" item autre");
    expect(sanitize(["★ ☆ ♥ ♦ ● ▲ ◆ ☑"])).toBe(" ");
    expect(sanitize(["⚠ attention"])).toBe(" attention");
  });

  it("n'altère pas les opérateurs mathématiques ni les devises", () => {
    expect(sanitize(["2 ± 1 × 3 ÷ 4 ≤ 5 ≥ 6"])).toBe("2 ± 1 × 3 ÷ 4 ≤ 5 ≥ 6");
    expect(sanitize(["10 € / 5 $ ≈ 2 $"])).toBe("10 € / 5 $ ≈ 2 $");
  });
});

describe("SpeechSanitizer — caractères invisibles / contrôle", () => {
  it("supprime ZWSP, ZWJ, ZWNJ, BOM et trait d'union conditionnel", () => {
    expect(sanitize(["a\u200bb\u200dc\u200ed\u200fe"])).toBe("abcde");
    expect(sanitize(["\ufeffdébut"])).toBe("début");
    expect(sanitize(["co\u00adopération"])).toBe("coopération");
    expect(sanitize(["mot\u2060collé"])).toBe("motcollé");
  });

  it("supprime les caractères de contrôle (hors tabulation et saut de ligne)", () => {
    expect(sanitize(["a\u0000b\u0007c\u007fd"])).toBe("abcd");
    expect(sanitize(["ligne1\nligne2"])).toBe("ligne1\nligne2");
  });
});

describe("SpeechSanitizer — normalisation des espaces", () => {
  it("normalise les espaces insécables et fines en espace, puis les écrase", () => {
    expect(sanitize(["1\u00a0000\u202f000"])).toBe("1 000 000");
    expect(sanitize(["espaces   multiples\t\tet   tabs"])).toBe(
      "espaces multiples et tabs",
    );
    expect(sanitize(["a\u2009b\u200ac"])).toBe("a b c");
    expect(sanitize(["ligne \n  suivante"])).toBe("ligne \n suivante");
  });
});

describe("SpeechSanitizer — préservation impérative", () => {
  it("conserve accents, chiffres, unités et ponctuation française", () => {
    const text = "Le café coûte 3,14 € et il fait 20 °C (100 % sûr) : « Bien !»";
    expect(sanitize([text])).toBe(text);
  });

  it("conserve toute la ponctuation de fin de phrase et les tirets", () => {
    const text = "Un. Deux ! Trois ? Quatre… Cinq — six – sept";
    expect(sanitize([text])).toBe(text);
    expect(sanitize(["“citation” et l’apostrophe d’ici"])).toBe(
      "“citation” et l’apostrophe d’ici",
    );
  });

  it("ne perd aucun mot : la suppression d'un emoji insère un espace si collé", () => {
    expect(sanitize(["Bonjour😊Ensuite"])).toBe("Bonjour Ensuite");
    expect(sanitize(["a→b"])).toBe("a b");
    expect(sanitize(["Bonjour 😊 Ensuite"])).toBe("Bonjour Ensuite");
    expect(sanitize(["texte😊"])).toBe("texte");
    expect(sanitize(["😊texte"])).toBe("texte");
  });
});

describe("SpeechSanitizer — cas à cheval (incrémental)", () => {
  it("ne laisse jamais passer un demi-emoji (surrogate coupé)", () => {
    const full = "😊";
    const high = full.slice(0, 1);
    const low = full.slice(1);
    expect(sanitize(["Bonjour " + high, low + " monde."])).toBe("Bonjour monde.");
    // Un demi-surrogate isolé en fin de flux est ignoré, le texte voisin reste.
    expect(sanitize(["Salut " + high])).toBe("Salut ");
  });

  it("gère une séquence ZWJ coupée entre deux fragments", () => {
    expect(sanitize(["\u{1F468}\u200D", "\u{1F469}\u200D\u{1F467}"])).toBe("");
    expect(sanitize(["Famille \u{1F468}\u200D", "\u{1F469} !"])).toBe("Famille !");
  });

  it("gère un modificateur de peau coupé entre deux fragments", () => {
    expect(sanitize(["\u{1F44D}", "\u{1F3FD}"])).toBe("");
  });

  it("supprime un surrogate mal formé sans perdre le texte voisin", () => {
    expect(sanitize(["a\uD83Db"])).toBe("ab"); // high suivi d'un non-low
    expect(sanitize(["\uDE0Atexte"])).toBe("texte"); // low orphelin
  });

  it("résout un emoji coupé au milieu d'une phrase sans perdre la ponctuation", () => {
    const out = sanitize(["Attention ", "😊", " ! Ça continue."]);
    expect(out).toBe("Attention ! Ça continue.");
  });
});

describe("SpeechSanitizer — robustesse", () => {
  it("supprime un texte 100 % emoji", () => {
    expect(sanitize([EMOJI])).toBe("");
    expect(sanitize(["😀", "😃", "😄"])).toBe("");
  });

  it("est idempotent", () => {
    const inputs = [
      "Bonjour 😊 le monde !",
      "a\u200bb\u00adc",
      "Un. Deux ! 🎉 Trois ?",
      "1\u00a0000 € et 20 °C",
    ];
    for (const input of inputs) {
      const once = sanitize([input]);
      expect(sanitize([once])).toBe(once);
    }
  });

  it("purge son état au reset", () => {
    const sanitizer = new SpeechSanitizer();
    sanitizer.push("Bonjour \uD83D"); // demi-emoji retenu
    sanitizer.reset();
    expect(sanitizer.flush()).toBe("");
  });

  it("un fragment vide ne produit rien", () => {
    const sanitizer = new SpeechSanitizer();
    expect(sanitizer.push("")).toBe("");
  });

  it("traite un texte long sans explosion de coût", () => {
    const unit = "Phrase 😊 de test avec des accents éàç et 3,14 € ! ";
    const long = unit.repeat(2_000); // ≈ 96 000 caractères
    const start = Date.now();
    const out = sanitize([long]);
    const elapsed = Date.now() - start;
    expect(out).not.toContain("😊");
    expect(out).toContain("éàç");
    expect(out).toContain("3,14 €");
    // Aucune regex : le coût est linéaire. Borne très large (anti-régression).
    expect(elapsed).toBeLessThan(1_000);
  });
});
