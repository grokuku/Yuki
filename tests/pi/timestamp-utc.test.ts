/**
 * HORODATAGES EN UTC, QUEL QUE SOIT LE FUSEAU DU PROCESS (⚠️ le piège mesuré).
 *
 * ⚠️ POURQUOI UN PROCESSUS SÉPARÉ : Node fige son fuseau au PREMIER usage de
 * `Date`/`Intl` ; écrire `process.env.TZ` au milieu d'un test n'a aucun effet. On
 * lance donc un vrai `node --import tsx` avec `TZ=Asia/Tokyo` et on lit ce qu'il
 * produit. C'est la seule preuve honnête de l'indépendance.
 *
 * ⚠️ ÉCHEC SUR L'ORIGINE (mesuré) : l'ancien code ne passait pas `timeZone` quand
 * l'appelant n'en fournissait pas — il retombait sur le fuseau du process. Sous
 * `TZ=Asia/Tokyo`, un message de 10:46 UTC s'affichait « 19:46 » et le fil de canal
 * « [02/11 19:46] », alors que Mattermost (UTC) affichait « 10:46 ».
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Instant de référence : 2026-11-02 10:46 UTC (« 11:46 » à Paris, « 19:46 » à Tokyo). */
const SCRIPT = `
const { buildStoredUserText } = await import(${JSON.stringify(`${ROOT}src/pi/timestamp.ts`)});
const { buildReplyPrompt } = await import(${JSON.stringify(`${ROOT}src/chat/reply/prompt.ts`)});
const ui = await import(${JSON.stringify(`${ROOT}public/ui/horodatage.js`)});

const at = new Date("2026-11-02T10:46:00.000Z");
const message = {
  remoteId: "m2",
  conversationId: "mm-c1",
  platform: "mattermost",
  channelId: "c1",
  author: { id: "u1", nom: "Ada" },
  text: "Et la fiche ?",
  sentAt: at.toISOString(),
};
const precedent = { ...message, remoteId: "m1", text: "Tu as lu la fiche ?", sentAt: "2026-11-02T09:00:00.000Z" };

process.stdout.write(
  JSON.stringify({
    // Fuseau du PROCESS, tel que Node le voit réellement (preuve que TZ a bien pris).
    fuseauProcess: Intl.DateTimeFormat().resolvedOptions().timeZone,
    heureProcess: new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" }).format(at),
    prefixeStocke: buildStoredUserText("Bonjour", { at }),
    prompt: buildReplyPrompt({ channelTitle: "veille", transcript: [precedent], message, now: at }),
    uiHeure: ui.formatHourFr(at),
    uiDateHeure: ui.formatDateTimeFr(at),
    uiJour: ui.formatDayFr(at),
  }),
);
`;

interface ChildResult {
  fuseauProcess: string;
  heureProcess: string;
  prefixeStocke: string;
  prompt: string;
  uiHeure: string;
  uiDateHeure: string;
  uiJour: string;
}

function runUnder(timeZone: string): ChildResult {
  const out = execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", SCRIPT],
    {
      cwd: ROOT,
      env: { ...process.env, TZ: timeZone },
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  return JSON.parse(out) as ChildResult;
}

describe("horodatages — indépendants du fuseau du PROCESS", () => {
  for (const tz of ["Asia/Tokyo", "America/New_York"]) {
    it(`préfixe stocké et prompt de canal en UTC avec TZ=${tz}`, () => {
      const result = runUnder(tz);
      // Le fuseau du process a bien CHANGÉ : sans cela, le test ne prouverait rien.
      expect(result.fuseauProcess).toBe(tz);
      expect(result.heureProcess).not.toBe("10:46");

      // ① Préfixe STOCKÉ du message utilisateur : UTC, suffixé.
      expect(result.prefixeStocke).toBe(
        "[horodatage] 2026-11-02 10:46 (UTC) Bonjour",
      );

      // ② Prompt du fil de canal : heure courante ET lignes du fil en UTC.
      expect(result.prompt).toContain(
        "Heure courante : [horodatage] 2026-11-02 10:46 (UTC)",
      );
      expect(result.prompt).toContain("[02/11 09:00] Ada : Tu as lu la fiche ?");
      expect(result.prompt).not.toContain("19:46");
      expect(result.prompt).not.toContain("18:46");
    });
  }

  it("l'interface rend les mêmes instants en UTC (pas le fuseau du système)", () => {
    const result = runUnder("Asia/Tokyo");
    expect(result.fuseauProcess).toBe("Asia/Tokyo");
    // Le miroir navigateur ne consulte JAMAIS le fuseau du système.
    expect(result.uiHeure).toBe("10:46 UTC");
    expect(result.uiDateHeure).toBe("02/11/2026 10:46 UTC");
    expect(result.uiJour).toBe("lundi 2 novembre 2026");
  });
});
