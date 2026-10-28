/**
 * ACCUSÉ DE RÉCEPTION — garde-fous STATIQUES du bloc et de son câblage.
 *
 * ⚠️ Ce que ce fichier verrouille (le rendu réel est mesuré en E2E, Chromium :
 * `_tools/e2e-ack.mjs`) :
 *  - l'accusé est la PREMIÈRE LIGNE DE LA RÉPONSE : il est posé DANS la bulle
 *    assistant, juste avant le corps markdown — jamais dans un bloc séparé
 *    au-dessus d'une bulle vide (défaut signalé par l'utilisateur) ;
 *  - il reste une ligne de STATUT (`role="status"`), rendue en NŒUD TEXTE
 *    (`textContent`) : aucun `innerHTML`, aucun style en ligne (CSP) ;
 *  - une bulle n'est JAMAIS vide : sans accusé ni contenu elle porte
 *    l'indicateur d'attente (`.message__pending`, muet) ;
 *  - la trame `ack` est traitée AVANT le curseur `seq` (trame de CONTRÔLE) et
 *    l'accusé PERSISTE avec le message (il n'est PAS purgé à la reconnexion).
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
    expect(source).toContain('export const ACK_CLASS = "ack-block"');
    expect(source).toContain('role", "status"');
    // Jamais la classe d'un message : on ne doit pas la confondre avec une réponse.
    expect(source).not.toContain("message--assistant");
    expect(source).not.toContain('classList.add("message');
  });

  it("n'injecte aucun balisage et aucun style en ligne (CSP)", () => {
    const code = codeOf(source);
    expect(code).not.toContain("innerHTML");
    expect(code).not.toContain("insertAdjacentHTML");
    expect(code).not.toContain("outerHTML");
    expect(code).not.toContain("style=");
    expect(code).toContain("textContent");
  });

  it("se place DANS la bulle, AVANT le corps (première ligne de la réponse)", () => {
    // Le point d'insertion est le corps de LA bulle, jamais le conteneur du fil.
    expect(source).toContain('message.querySelector(".message__body")');
    expect(source).toContain("message.insertBefore(element, slot)");
    expect(source).toContain("function ackElement");
    expect(source).toContain("function pending");
    expect(source).toContain("function settled");
    // L'ancienne signature (`before` dans le CONTENEUR) a disparu.
    expect(source).not.toContain("options.before");
    expect(source).not.toContain("container.insertBefore");
  });

  it("l'attente est MUETTE (aria-hidden, aucun texte)", () => {
    expect(source).toContain('export const PENDING_CLASS = "message__pending"');
    expect(source).toContain('el.setAttribute("aria-hidden", "true")');
  });

  it("ne purge PAS à la reconnexion (l'accusé fait partie du message)", () => {
    const app = ui("app.js");
    // La reconnexion ne doit plus effacer les accusés : ils sont persistés avec
    // le message et ramenés par le snapshot.
    const welcome = app.slice(app.indexOf('if (type === "welcome")'));
    const welcomeBody = welcome.slice(0, welcome.indexOf("if (type ===", 10));
    expect(welcomeBody).not.toContain("ackBlocks.reset()");
    // La reconstruction du fil, elle, repart d'un conteneur vide : l'unique
    // remise à zéro tolérée est celle d'`applyTranscript`.
    const resets = app.split("ackBlocks.reset();").length - 1;
    expect(resets).toBe(1);
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

  it("pose l'accusé DANS la bulle courante (aucun bloc séparé)", () => {
    expect(app).toContain("ackBlocks.show(currentAssistant, frame.text, frame.source)");
    // L'ancienne insertion « juste avant la bulle » a disparu.
    expect(app).not.toContain("ackBlocks.show(frame.text, { before:");
  });

  it("crée la bulle si l'accusé arrive avant elle (jamais de ligne hors bulle)", () => {
    const branch = app.slice(app.indexOf('if (type === "ack")'));
    const body = branch.slice(0, branch.indexOf("ackBlocks.show"));
    expect(body).toContain("if (!currentAssistant)");
    expect(body).toContain("appendAssistantMessage(null, pinned, Date.now())");
  });

  it("ignore les accusés d'une AUTRE conversation", () => {
    const branch = app.slice(app.indexOf('if (type === "ack")'));
    const guard = branch.slice(0, branch.indexOf("ackBlocks.show"));
    expect(guard).toContain("ackTarget !== sessionId");
    expect(guard).toContain("return");
  });

  it("affiche l'accusé PERSISTÉ du transcript dans SA PROPRE bulle (visible après rechargement)", () => {
    expect(app).toContain(
      'const ackText = typeof entry.ack === "string" ? entry.ack : null;',
    );
    expect(app).toContain("ackBlocks.show(ackBubble, ackText)");
    // ⚠️ L'accusé n'est JAMAIS recopié dans la bulle de réponse (aucun doublon).
    expect(app).not.toContain("ackBlocks.show(div, entry.ack)");
  });
});

describe("aucune bulle vide (attente et fin de run)", () => {
  const app = ui("app.js");

  it("la bulle du run porte l'attente dès le lancement", () => {
    const started = app.slice(app.indexOf('case "run_started"'));
    const body = started.slice(0, started.indexOf('case "delta"'));
    expect(body).toContain("ackBlocks.pending(currentAssistant)");
  });

  it("le premier mot de la réponse retire l'attente", () => {
    const delta = app.slice(app.indexOf('case "delta"'));
    const body = delta.slice(0, delta.indexOf('case "phase"'));
    expect(body).toContain("ackBlocks.settled(currentAssistant)");
  });

  it("la parenthèse technique « aucune réponse » est OMISE quand un accusé est affiché", () => {
    // L'accusé est un message à part : la note technique d'un tour muet ne
    // s'écrit que si AUCUN accusé n'a parlé.
    expect(app).toContain("const hasAck = ackBlocks.has(currentAssistant);");
    expect(app).toContain('frame.reason === "done" && !hasText && !hasAck');
    // Un ABANDON reste dit, même avec un accusé (issue distincte) — et il est dit
    // dans une bulle de TEXTE, jamais dans la bulle d'accusé.
    expect(app).toContain('frame.reason === "abort" && !hasText');
    expect(app).toContain("if (note !== null) {");
    expect(app).toContain("ensureContentBubble(pinned);");
    // Le remplacement du texte de la bulle ne peut donc jamais écraser l'accusé.
    expect(app).not.toContain("currentAssistant.textContent =");
  });

  it("une entrée de transcript sans contenu NI accusé n'est pas rendue", () => {
    expect(app).toContain('if (bodyText === "" && ackText === null) continue;');
  });
});

describe("styles de l'accusé et de l'attente", () => {
  const styles = ui("styles.css");

  it("l'accusé a le rendu d'un message ORDINAIRE (ni italique, ni gris, ni petit)", () => {
    expect(styles).toContain(".ack-block");
    expect(styles).toContain(".message__pending");
    // ⚠️ Défaut signalé : il avait l'air d'une annotation (italique, plus petit,
    // plus sourd). C'est un MESSAGE : il hérite du texte de la bulle.
    const rule = styles.slice(styles.indexOf(".ack-block {"));
    const body = rule.slice(0, rule.indexOf("}"));
    expect(body).not.toContain("italic");
    expect(body).toContain("font: inherit");
    expect(body).toContain("color: inherit");
    expect(body).not.toContain("--muted");
    // Plus de mise en page d'élément autonome (largeur/alignement dans le fil).
    expect(body).not.toContain("align-self");
    expect(body).not.toContain("max-width");
  });

  it("l'animation de l'attente respecte `prefers-reduced-motion`", () => {
    const pending = styles.slice(styles.indexOf(".message__pending {"));
    const reduced = pending.slice(pending.indexOf("prefers-reduced-motion"));
    expect(reduced).toContain("animation: none");
  });
});
