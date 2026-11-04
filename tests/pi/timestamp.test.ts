/**
 * Repère temporel des messages (module pur `src/pi/timestamp.ts`) — POINT DE
 * VÉRITÉ du formatage des dates et heures.
 *
 * Vérifie le FORMAT EXACT, le FUSEAU (⚠️ le piège : un conteneur peut être en UTC
 * **ou non**, donc jamais de dépendance au fuseau du process), le SUFFIXE
 * obligatoire, le masquage à l'affichage et la robustesse (fuseau invalide, texte
 * sans préfixe, messages stockés AVANT l'UTC).
 *
 * ⚠️ L'indépendance vis-à-vis du fuseau du process (`TZ`) est prouvée dans
 * `tests/pi/timestamp-utc.test.ts` : elle exige un PROCESSUS séparé (Node fige
 * son fuseau au premier usage, un `process.env.TZ` en cours de test est ignoré).
 */

import { describe, expect, it } from "vitest";

import {
  buildStoredUserText,
  buildTimestampPrefix,
  DEFAULT_TIME_ZONE,
  dayKeyOf,
  effectiveTimeZone,
  formatCompactDateTime,
  formatDateTimeFr,
  formatDayFr,
  formatHourFr,
  resolveTimeZone,
  stripTimestampPrefix,
  TIMESTAMP_PREFIX_RE,
} from "../../src/pi/timestamp.js";

describe("pi.timestamp — format exact du préfixe", () => {
  it("produit `[horodatage] YYYY-MM-DD HH:mm (UTC)` par défaut", () => {
    const date = new Date("2026-10-08T15:39:00.000Z");
    expect(DEFAULT_TIME_ZONE).toBe("UTC");
    expect(buildTimestampPrefix(date)).toBe(
      "[horodatage] 2026-10-08 15:39 (UTC)",
    );
  });

  it("honore un fuseau DEMANDÉ et le nomme dans le suffixe", () => {
    const date = new Date("2026-10-08T15:39:00.000Z");
    expect(formatCompactDateTime(date, "UTC")).toBe("2026-10-08 15:39");
    expect(formatCompactDateTime(date, "Europe/Paris")).toBe("2026-10-08 17:39");
    expect(buildTimestampPrefix(date, "Europe/Paris")).toBe(
      "[horodatage] 2026-10-08 17:39 (Europe/Paris)",
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

  it("replie sur UTC (jamais sur le fuseau du process) si le fuseau est invalide", () => {
    const date = new Date("2026-10-08T15:39:00.000Z");
    expect(resolveTimeZone("Mars/Olympus")).toBeUndefined();
    expect(resolveTimeZone("  Europe/Paris  ")).toBe("Europe/Paris");
    expect(effectiveTimeZone("Mars/Olympus")).toBe("UTC");
    expect(effectiveTimeZone(undefined)).toBe("UTC");
    expect(() => formatCompactDateTime(date, "Mars/Olympus")).not.toThrow();
    expect(buildTimestampPrefix(date, "Mars/Olympus")).toBe(
      "[horodatage] 2026-10-08 15:39 (UTC)",
    );
  });
});

describe("pi.timestamp — affichages (interface, journal, rapports)", () => {
  const date = new Date("2026-10-08T15:39:00.000Z");

  it("`formatDateTimeFr` porte TOUJOURS le fuseau", () => {
    expect(formatDateTimeFr(date)).toBe("08/10/2026 15:39 UTC");
    expect(formatDateTimeFr(date, "Europe/Paris")).toBe(
      "08/10/2026 17:39 Europe/Paris",
    );
  });

  it("`formatHourFr` (métadonnée de message) porte le fuseau", () => {
    expect(formatHourFr(date)).toBe("15:39 UTC");
    expect(formatHourFr(date, "Europe/Paris")).toBe("17:39 Europe/Paris");
  });

  it("`formatDayFr` donne un jour français dans le fuseau effectif", () => {
    expect(formatDayFr(date)).toBe("jeudi 8 octobre 2026");
    // 23:30 UTC = le lendemain à Paris : le séparateur de jour suit le fuseau.
    expect(dayKeyOf(new Date("2026-10-08T23:30:00Z"))).toBe("2026-10-08");
    expect(dayKeyOf(new Date("2026-10-08T23:30:00Z"), "Europe/Paris")).toBe(
      "2026-10-09",
    );
  });
});

describe("pi.timestamp — pose et masquage", () => {
  it("horodate un message utilisateur (stockage) et laisse un synthétique intact", () => {
    const at = new Date("2026-10-08T15:39:00.000Z");
    expect(buildStoredUserText("Bonjour", { at })).toBe(
      "[horodatage] 2026-10-08 15:39 (UTC) Bonjour",
    );
    expect(
      buildStoredUserText("[RÉSULTAT DE TÂCHE EN ARRIÈRE-PLAN]\ncorps", {
        at,
        synthetic: true,
      }),
    ).toBe("[RÉSULTAT DE TÂCHE EN ARRIÈRE-PLAN]\ncorps");
  });

  it("retire le préfixe (affichage) et tolère un texte sans préfixe", () => {
    expect(
      stripTimestampPrefix("[horodatage] 2026-10-08 15:39 (UTC) Bonjour"),
    ).toBe("Bonjour");
    // ⚠️ Messages STOCKÉS AVANT l'UTC : toujours reconnus (aucune migration).
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
    expect(TIMESTAMP_PREFIX_RE.test("[horodatage] 2026-10-08 15:39 (UTC) x")).toBe(
      true,
    );
    expect(
      TIMESTAMP_PREFIX_RE.test("[horodatage] 2026-10-08 15:39 (heure locale) x"),
    ).toBe(true);
    // Pas d'heure ⇒ pas un préfixe d'horodatage.
    expect(TIMESTAMP_PREFIX_RE.test("[horodatage] 2026-10-08 (UTC) x")).toBe(false);
    expect(
      TIMESTAMP_PREFIX_RE.test("[horodatage] 2026-10-08 (heure locale) x"),
    ).toBe(false);
  });
});
