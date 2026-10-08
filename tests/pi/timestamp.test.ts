/**
 * Repère temporel des messages (module pur `src/pi/timestamp.ts`).
 *
 * Vérifie le FORMAT EXACT (identique à Pi-Web), le FUSEAU (le piège : un
 * conteneur en UTC), le masquage à l'affichage et la robustesse (fuseau
 * invalide, texte sans préfixe).
 */

import { describe, expect, it } from "vitest";

import {
  buildStoredUserText,
  buildTimestampPrefix,
  formatCompactDateTime,
  resolveTimeZone,
  stripTimestampPrefix,
  TIMESTAMP_PREFIX_RE,
} from "../../src/pi/timestamp.js";

describe("pi.timestamp — format exact du préfixe", () => {
  it("produit `[horodatage] YYYY-MM-DD HH:mm (heure locale)`", () => {
    const date = new Date("2026-10-08T15:39:00.000Z");
    expect(buildTimestampPrefix(date, "UTC")).toBe(
      "[horodatage] 2026-10-08 15:39 (heure locale)",
    );
  });

  it("respecte le fuseau DEMANDÉ (browser) et non l'UTC du conteneur", () => {
    const date = new Date("2026-10-08T15:39:00.000Z");
    // Le conteneur est en UTC : 15:39. Pour un utilisateur à Paris : 17:39.
    expect(formatCompactDateTime(date, "UTC")).toBe("2026-10-08 15:39");
    expect(formatCompactDateTime(date, "Europe/Paris")).toBe("2026-10-08 17:39");
    expect(buildTimestampPrefix(date, "Europe/Paris")).toBe(
      "[horodatage] 2026-10-08 17:39 (heure locale)",
    );
  });

  it("gère minuit en `00:xx` (jamais « 24:xx »)", () => {
    expect(formatCompactDateTime(new Date("2026-10-08T00:05:00Z"), "UTC")).toBe(
      "2026-10-08 00:05",
    );
    expect(
      formatCompactDateTime(new Date("2026-10-07T22:05:00Z"), "Europe/Paris"),
    ).toBe("2026-10-08 00:05");
  });

  it("replie sur le fuseau du process si le fuseau demandé est invalide", () => {
    const date = new Date("2026-10-08T15:39:00.000Z");
    expect(resolveTimeZone("Mars/Olympus")).toBeUndefined();
    expect(resolveTimeZone("  Europe/Paris  ")).toBe("Europe/Paris");
    expect(() => formatCompactDateTime(date, "Mars/Olympus")).not.toThrow();
    expect(buildTimestampPrefix(date, "Mars/Olympus")).toBe(
      buildTimestampPrefix(date),
    );
  });
});

describe("pi.timestamp — pose et masquage", () => {
  it("horodate un message utilisateur (stockage) et laisse un synthétique intact", () => {
    const at = new Date("2026-10-08T15:39:00.000Z");
    expect(buildStoredUserText("Bonjour", { at, timeZone: "UTC" })).toBe(
      "[horodatage] 2026-10-08 15:39 (heure locale) Bonjour",
    );
    expect(
      buildStoredUserText("[RÉSULTAT DE TÂCHE EN ARRIÈRE-PLAN]\ncorps", {
        at,
        timeZone: "UTC",
        synthetic: true,
      }),
    ).toBe("[RÉSULTAT DE TÂCHE EN ARRIÈRE-PLAN]\ncorps");
  });

  it("retire le préfixe (affichage) et tolère un texte sans préfixe", () => {
    expect(
      stripTimestampPrefix(
        "[horodatage] 2026-10-08 15:39 (heure locale) Bonjour",
      ),
    ).toBe("Bonjour");
    // Message d'avant l'horodatage : inchangé.
    expect(stripTimestampPrefix("Bonjour")).toBe("Bonjour");
    // Un texte qui CONTIENT « horodatage » mais pas en tête n'est pas touché.
    expect(stripTimestampPrefix("Voir [horodatage] plus loin")).toBe(
      "Voir [horodatage] plus loin",
    );
  });

  it("le motif ne reconnaît que le préfixe ANCRÉ en tête", () => {
    expect(TIMESTAMP_PREFIX_RE.test("[horodatage] 2026-10-08 15:39 (heure locale) x")).toBe(
      true,
    );
    expect(TIMESTAMP_PREFIX_RE.test("[horodatage] 2026-10-08 (heure locale) x")).toBe(
      false,
    );
  });
});
