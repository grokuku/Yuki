/**
 * RÈGLE DE RÉTENTION PARTAGÉE (`src/files/retention.ts`).
 *
 * ⚠️ Pièces jointes, images générées et captures du libraire obéissent à CETTE
 * règle unique : c'est ce qui garantit qu'un seul réglage
 * (`files.retentionDays`) et une seule sémantique d'expiration s'appliquent
 * partout. Les bornes testées ici sont celles qui rendent la purge RÉELLE.
 */

import { describe, expect, it } from "vitest";

import {
  DAY_MS,
  MIN_RETENTION_DAYS,
  expiresAtIso,
  isExpired,
  retentionDays,
} from "../../src/files/retention.js";

describe("durée de rétention", () => {
  it("ne descend JAMAIS sous un jour (0 ou négatif ne veut pas dire « toujours »)", () => {
    expect(retentionDays(0)).toBe(MIN_RETENTION_DAYS);
    expect(retentionDays(-5)).toBe(MIN_RETENTION_DAYS);
    expect(retentionDays(Number.NaN)).toBe(MIN_RETENTION_DAYS);
    expect(retentionDays(7.9)).toBe(7);
    expect(retentionDays(30)).toBe(30);
  });
});

describe("instant d'expiration", () => {
  it("ajoute exactement la durée demandée, à partir de l'instant du dépôt", () => {
    const at = Date.UTC(2026, 0, 1, 12, 0, 0);
    expect(expiresAtIso(at, 30)).toBe(new Date(at + 30 * DAY_MS).toISOString());
    // Un dépôt « il y a 29 jours » n'est PAS expiré ; 31 jours l'est.
    expect(isExpired(expiresAtIso(at, 30), at + 29 * DAY_MS)).toBe(false);
    expect(isExpired(expiresAtIso(at, 30), at + 31 * DAY_MS)).toBe(true);
  });
});

describe("verdict d'expiration", () => {
  it("expire À l'instant pile (borne inclusive)", () => {
    const expires = new Date(Date.UTC(2026, 1, 1)).toISOString();
    const boundary = Date.parse(expires);
    expect(isExpired(expires, boundary - 1)).toBe(false);
    expect(isExpired(expires, boundary)).toBe(true);
    expect(isExpired(expires, boundary + 1)).toBe(true);
  });

  it("traite une date ABSENTE ou ILLISIBLE comme expirée (on ne garde pas l'indatable)", () => {
    expect(isExpired(undefined, Date.now())).toBe(true);
    expect(isExpired("", Date.now())).toBe(true);
    expect(isExpired("pas une date", Date.now())).toBe(true);
  });
});
