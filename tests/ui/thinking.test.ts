/**
 * Bloc de RÉFLEXION du modèle (canal `thinking`) — garde-fous STATIQUES de la
 * source (`public/ui/thinking.js`, `public/ui/app.js`) et du routage SERVEUR
 * (`src/gateway/ws/server.ts`).
 *
 * Le comportement INTERACTIF (apparition DANS le fil AVANT la réponse, replié
 * par défaut, dépliage au clic, silence TTS, éphémérité) est prouvé en E2E
 * (`_tools/e2e-activity.mjs`, Chromium headless + CDP).
 *
 * ⚠️ La réflexion est ÉPHÉMÈRE : elle transite par une trame de CONTRÔLE (jamais
 * bufferisée), donc ni dans le transcript, ni dans un snapshot, ni dans le rejeu.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const read = (...segments: string[]): string =>
  readFileSync(join(process.cwd(), ...segments), "utf8");

describe("garde-fous STATIQUES de thinking.js (CSP + accessibilité)", () => {
  const source = read("public", "ui", "thinking.js");

  it("construit le DOM sans injection HTML ni style en ligne (CSP stricte)", () => {
    expect(source).not.toContain("innerHTML");
    expect(source).not.toContain("style=");
    expect(source).toContain("createElement");
  });

  it("repli = VRAI bouton avec `aria-expanded`, replié par défaut", () => {
    expect(source).toContain('type: "button"');
    expect(source).toContain('"aria-expanded": "false"');
    expect(source).toContain("setExpanded(record, false)");
  });

  it("le bloc est inséré AVANT la réponse du tour (place chronologique)", () => {
    expect(source).toContain("insertBefore(root, anchor)");
  });

  it("le bloc n'est créé qu'au PREMIER fragment de réflexion", () => {
    // Un run sans `thinking` n'affiche rien : le bloc est construit à la demande.
    expect(source).toMatch(/if \(!record\) record = build\(runId, anchor\);/);
  });
});

describe("garde-fous STATIQUES de app.js (réflexion = contrôle éphémère)", () => {
  const app = read("public", "ui", "app.js");

  it("traite la réflexion AVANT le curseur `seq` (trame de contrôle)", () => {
    expect(app).toMatch(
      /type === "delta" && frame\.channel === "thinking"[\s\S]{0,400}thinkingBlocks\.append\(/,
    );
  });

  it("ne dessine PAS le bloc d'un fil NON focalisé (aucun mélange de fils)", () => {
    expect(app).toMatch(
      /frame\.channel === "thinking"[\s\S]{0,400}thinkingTarget !== sessionId\) return;/,
    );
  });

  it("purge les blocs de réflexion au snapshot/rejeu/reconnexion (éphémérité)", () => {
    expect(app).toContain("thinkingBlocks.reset()");
  });
});

describe("garde-fous STATIQUES de server.ts (jamais bufferisée, jamais prononcée)", () => {
  const server = read("src", "gateway", "ws", "server.ts");

  it("déroute la réflexion AVANT `streams.append` (hors rejeu/snapshot)", () => {
    const idx = server.indexOf('event.type === "delta" && event.channel === "thinking"');
    expect(idx).toBeGreaterThan(-1);
    const around = server.slice(idx, idx + 240);
    expect(around).toContain("broadcastControl(");
    // Le `return` coupe AVANT `streams.append(...)` (déroute en amont).
    expect(around).toContain("return;");
  });

  it("le TTS ne reçoit QUE le canal `content`", () => {
    expect(server).toMatch(
      /case "delta":\s*\n\s*if \(event\.channel === "content"\)/,
    );
  });
});
