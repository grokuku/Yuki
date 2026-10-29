/**
 * GARDE-FOU STATIQUE — le COLLAGE dans le champ de saisie (`app.js`).
 *
 * ⚠️ Ce que ce test protège (l'erreur est facile et SILENCIEUSE) :
 *  - si `preventDefault()` passe AVANT le test « aucun fichier », le collage de
 *    TEXTE et le collage `text/html` d'un tableur sont cassés (le champ ne reçoit
 *    plus rien) ;
 *  - si le collage se dote de son propre envoi (un `fetch` à part), la liste
 *    d'attente, les refus explicites et la mémoire des fichiers connus divergent
 *    du sélecteur et du glisser-déposer.
 *
 * Le comportement RÉEL (Ctrl+V d'une image, puce d'attente, carte dans le fil,
 * non-régression du texte) est prouvé par `_tools/e2e-files.mjs`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(join(process.cwd(), "public", "ui", "app.js"), "utf8");

/** Corps de la fonction `onPaste` (du nom jusqu'à l'accolade de fermeture). */
function pasteHandlerBody() {
  const start = SOURCE.indexOf("function onPaste(");
  expect(start, "aucun gestionnaire `onPaste`").toBeGreaterThan(-1);
  const end = SOURCE.indexOf("\n}", start);
  expect(end, "corps de `onPaste` introuvable").toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

/** Corps de `addFiles` (le SEUL chemin d'envoi des pièces jointes). */
function addFilesBody() {
  const start = SOURCE.indexOf("async function addFiles(");
  expect(start, "aucune fonction `addFiles`").toBeGreaterThan(-1);
  const end = SOURCE.indexOf("\n}", start);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

describe("collage : câblage dans app.js", () => {
  it("écoute `paste` sur le champ de saisie", () => {
    expect(SOURCE).toContain('els.input.addEventListener("paste", onPaste)');
  });

  it("lit les fichiers du presse-papiers et les confie à `addFiles`", () => {
    const body = pasteHandlerBody();
    expect(body).toContain("filesFromClipboard(event.clipboardData");
    expect(body).toContain("addFiles(files)");
  });

  it("⚠️ rend la main SANS fichier AVANT `preventDefault` (le texte colle encore)", () => {
    const body = pasteHandlerBody();
    const guard = body.indexOf("if (files.length === 0) return;");
    const prevent = body.indexOf("preventDefault()");
    expect(guard, "garde « aucun fichier » absente").toBeGreaterThan(-1);
    expect(prevent, "aucun `preventDefault` (une image collée serait ignorée)").toBeGreaterThan(-1);
    expect(prevent, "`preventDefault` AVANT la garde : le collage de texte serait cassé").toBeGreaterThan(
      guard,
    );
  });

  it("aucun SECOND chemin d'envoi : ni `fetch` ni `XMLHttpRequest` dans le collage", () => {
    const body = pasteHandlerBody();
    expect(body).not.toContain("fetch(");
    expect(body).not.toContain("XMLHttpRequest");
    // Le seul envoi reste `addFiles` → `uploadFile` → `POST /api/files`.
    expect(addFilesBody()).toContain("uploadFile(file)");
    expect(SOURCE.split('fetch("/api/files"').length - 1).toBe(1);
  });

  it("le commentaire du collage DIT la vérité sur le téléphone", () => {
    const body = SOURCE.slice(
      SOURCE.indexOf("─── COLLAGE"),
      SOURCE.indexOf("function onPaste("),
    );
    expect(body).toContain("TÉLÉPHONE");
    expect(body).toMatch(/trombone/i);
  });
});
