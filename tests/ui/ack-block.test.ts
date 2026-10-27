/**
 * ACCUSÉ DE RÉCEPTION — garde-fous STATIQUES du bloc et de son câblage.
 *
 * ⚠️ Ce que ce fichier verrouille (le rendu réel est mesuré en E2E, Chromium) :
 *  - le bloc est une ligne de STATUT (`role="status"`), pas une bulle de réponse ;
 *  - il est rendu en NŒUD TEXTE (`textContent`) : aucun `innerHTML`, aucun style
 *    en ligne (CSP `style-src 'self'`) ;
 *  - il se place JUSTE AVANT la bulle assistant encore vide du run, donc
 *    AU-DESSUS de la réponse et de l'image qui suivent ;
 *  - la trame `ack` est traitée AVANT le curseur `seq` (c'est une trame de
 *    CONTRÔLE : elle ne doit jamais être prise pour un doublon) et le bloc est
 *    purgé à chaque reconstruction du fil.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ui = (name: string): string =>
  readFileSync(join(process.cwd(), "public", "ui", name), "utf8");

/** Source SANS commentaires : on verrouille le CODE, pas la prose des garde-fous. */
function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("bloc d'accusé de réception", () => {
  const source = ui("ack-block.js");

  it("est une ligne de STATUT, pas un message", () => {
    expect(source).toContain('el.className = "ack-block"');
    expect(source).toContain('role", "status"');
    // Jamais la classe d'un message : on ne doit pas la confondre avec une réponse.
    expect(source).not.toContain("message--assistant");
    expect(source).not.toContain("classList.add(\"message");
  });

  it("n'injecte aucun balisage et aucun style en ligne (CSP)", () => {
    const code = codeOf(source);
    expect(code).not.toContain("innerHTML");
    expect(code).not.toContain("insertAdjacentHTML");
    expect(code).not.toContain("outerHTML");
    expect(code).not.toContain("style=");
    expect(code).toContain("textContent");
  });

  it("se place AVANT la bulle du run (au-dessus de la réponse) sans déplacer l'existant", () => {
    expect(source).toContain("options.before");
    expect(source).toContain("container.insertBefore(el, before)");
    // Aucune suppression / ré-insertion d'un élément existant.
    expect(source).not.toContain(".before(");
  });

  it("se purge à la reconstruction du fil et après reconnexion", () => {
    expect(source).toContain("function reset()");
    expect(source).toContain(".ack-block");
    const app = ui("app.js");
    const resets = app.split("ackBlocks.reset();").length - 1;
    // `applyTranscript` ET la reconnexion (`welcome`) purgent les blocs éphémères.
    expect(resets).toBeGreaterThanOrEqual(2);
  });
});

describe("câblage de la trame `ack` dans app.js", () => {
  const app = ui("app.js");

  it("est traité AVANT le curseur `seq` (trame de CONTRÔLE)", () => {
    const ackBranch = app.indexOf('if (type === "ack")');
    // ⚠️ Le garde de DOUBLON du flux principal (`handleFrame`) : la branche `ack`
    // doit vivre AVANT lui, dans la zone des trames de contrôle.
    const seqGuard = app.indexOf("if (frame.seq <= lastSeq) return;");
    expect(ackBranch).toBeGreaterThan(-1);
    expect(seqGuard).toBeGreaterThan(-1);
    // La branche `ack` vit dans la zone des trames de contrôle, avant tout
    // traitement de `seq` (elle ne doit jamais être vue comme un doublon).
    expect(ackBranch).toBeLessThan(seqGuard);
  });

  it("passe la bulle courante comme point d'insertion (accusé AU-DESSUS)", () => {
    expect(app).toContain("ackBlocks.show(frame.text, { before: currentAssistant })");
  });

  it("ignore les accusés d'une AUTRE conversation", () => {
    const branch = app.slice(app.indexOf('if (type === "ack")'));
    const guard = branch.slice(0, branch.indexOf("ackBlocks.show"));
    expect(guard).toContain("ackTarget !== sessionId");
    expect(guard).toContain("return");
  });
});
