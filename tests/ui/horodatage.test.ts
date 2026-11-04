/**
 * Horodatages de l'INTERFACE — `public/ui/horodatage.js`, miroir navigateur de
 * `src/pi/timestamp.ts`.
 *
 * Trois exigences :
 *  1. le fuseau par défaut est **UTC** (jamais celui du navigateur) ;
 *  2. le miroir rend EXACTEMENT les mêmes chaînes que le module serveur (mêmes
 *     instants, mêmes fuseaux) — c'est ce qui interdit la dérive des deux copies ;
 *  3. `timeZone` est fourni **explicitement** à CHAQUE `Intl.DateTimeFormat` : sans
 *     lui, l'implémentation retombe sur le fuseau du système (le piège mesuré).
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  currentTimeZone,
  DEFAULT_TIME_ZONE,
  dayKeyOf,
  effectiveTimeZone,
  formatDateTimeFr,
  formatDayFr,
  formatDayMonthHourFr,
  formatHourFr,
  formatMonthDayFr,
  isValidTimeZone,
  setTimeZone,
} from "../../public/ui/horodatage.js";
import {
  buildTimestampPrefix,
  dayKeyOf as dayKeyOfServeur,
  formatDateTimeFr as formatDateTimeFrServeur,
  formatDayFr as formatDayFrServeur,
  formatHourFr as formatHourFrServeur,
} from "../../src/pi/timestamp.js";

afterEach(() => {
  // Le fuseau est un état de MODULE : on le remet au défaut entre deux tests.
  setTimeZone(DEFAULT_TIME_ZONE);
});

describe("horodatage UI — fuseau par défaut", () => {
  it("rend l'UTC sans configuration, suffixé", () => {
    const date = new Date("2026-11-02T10:46:00.000Z");
    expect(DEFAULT_TIME_ZONE).toBe("UTC");
    expect(currentTimeZone()).toBe("UTC");
    expect(formatHourFr(date)).toBe("10:46 UTC");
    expect(formatDateTimeFr(date)).toBe("02/11/2026 10:46 UTC");
    expect(formatDayMonthHourFr(date)).toBe("02/11 10:46 UTC");
    expect(formatDayFr(date)).toBe("lundi 2 novembre 2026");
    expect(formatMonthDayFr(date)).toBe("2 nov.");
  });

  it("suit le fuseau RÉGLÉ (changement à chaud) sans rechargement", () => {
    const date = new Date("2026-11-02T10:46:00.000Z");
    expect(setTimeZone("Europe/Paris")).toBe("Europe/Paris");
    expect(currentTimeZone()).toBe("Europe/Paris");
    expect(formatHourFr(date)).toBe("11:46 Europe/Paris");
    expect(formatDateTimeFr(date)).toBe("02/11/2026 11:46 Europe/Paris");
    // Le jour d'un instant dépend du fuseau (23:30 UTC = lendemain à Paris).
    expect(dayKeyOf(new Date("2026-11-02T23:30:00.000Z"))).toBe("2026-11-03");
  });

  it("un fuseau inconnu ou vide retombe sur UTC (jamais une exception à l'écran)", () => {
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("Europe/Paris")).toBe(true);
    expect(effectiveTimeZone("Mars/Olympus")).toBe("UTC");
    expect(effectiveTimeZone(undefined)).toBe("UTC");
    expect(setTimeZone("Mars/Olympus")).toBe("UTC");
    expect(currentTimeZone()).toBe("UTC");
  });
});

describe("horodatage UI — miroir EXACT du module serveur", () => {
  const instants = [
    "2026-01-01T00:00:00.000Z",
    "2026-03-29T00:30:00.000Z", // bascule heure d'été en Europe
    "2026-10-25T00:30:00.000Z", // retour à l'heure d'hiver
    "2026-11-02T10:46:00.000Z",
    "2026-11-02T23:30:00.000Z",
    "2026-12-31T23:59:59.000Z",
  ];
  const zones = ["UTC", "Europe/Paris", "America/New_York", "Asia/Tokyo"];

  it("mêmes chaînes que `src/pi/timestamp.ts` (heures, dates, jours, clés)", () => {
    for (const iso of instants) {
      const date = new Date(iso);
      for (const zone of zones) {
        // Le miroir est piloté par l'état de module ; le serveur reçoit le fuseau
        // en argument : les deux doivent produire la MÊME chaîne.
        setTimeZone(zone);
        expect(formatHourFr(date), `heure ${iso} ${zone}`).toBe(
          formatHourFrServeur(date, zone),
        );
        expect(formatDateTimeFr(date), `date ${iso} ${zone}`).toBe(
          formatDateTimeFrServeur(date, zone),
        );
        expect(formatDayFr(date), `jour ${iso} ${zone}`).toBe(
          formatDayFrServeur(date, zone),
        );
        expect(dayKeyOf(date), `clé ${iso} ${zone}`).toBe(
          dayKeyOfServeur(date, zone),
        );
      }
    }
  });

  it("le préfixe de prompt du serveur n'est jamais ambigu", () => {
    expect(buildTimestampPrefix(new Date("2026-11-02T10:46:00.000Z"))).toBe(
      "[horodatage] 2026-11-02 10:46 (UTC)",
    );
  });
});

describe("horodatage UI — `timeZone` EXPLICITE à chaque appel", () => {
  it("aucun `Intl.DateTimeFormat` n'est construit sans `timeZone`", () => {
    // ⚠️ Sans `timeZone`, l'implémentation prend le fuseau du SYSTÈME : c'est
    // exactement ce qui faisait diverger l'interface de Mattermost (UTC).
    const reel = Intl.DateTimeFormat;
    const sansFuseau: unknown[] = [];
    class Espion extends reel {
      constructor(locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
        if (options?.timeZone === undefined) sansFuseau.push(options);
        super(locales, options);
      }
    }
    const globalScope = globalThis as { Intl: typeof Intl };
    const sauvegarde = globalScope.Intl;
    const date = new Date("2026-11-02T10:46:00.000Z");
    try {
      globalScope.Intl = {
        ...sauvegarde,
        DateTimeFormat: Espion as unknown as typeof Intl.DateTimeFormat,
      };
      setTimeZone("Europe/Paris");
      formatHourFr(date);
      formatDateTimeFr(date);
      formatDayMonthHourFr(date);
      formatDayFr(date);
      formatMonthDayFr(date);
      dayKeyOf(date);
      setTimeZone(DEFAULT_TIME_ZONE);
      formatHourFr(date);
    } finally {
      globalScope.Intl = sauvegarde;
    }
    expect(sansFuseau).toEqual([]);
  });
});
