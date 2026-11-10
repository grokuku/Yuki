/**
 * VISIBILITÉ DES AGENTS — interface (lot 35g).
 *
 * Ce que ce fichier VERROUILLE :
 *  ① l'onglet « Agents » de /config rend UNE CASE PAR BOT, alimentée par
 *    `GET /api/bots` (`listerBots`) — jamais une liste codée en dur ;
 *  ② un agent NEUTRALISÉ (aucun bot coché) est VISIBLE comme tel (badge +
 *    phrase), pas un état muet ;
 *  ③ la barre latérale des agents applique la MÊME règle de visibilité que le
 *    serveur (`agentsVisiblesPourBot`), et le dit quand tout est filtré ;
 *  ④ garde-fous d'interface : aucun `innerHTML`, aucun `.style.`, `HolafModal`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { agentsVisiblesPourBot } from "../../public/ui/sidebar-agents.js";

const panneau = readFileSync(join(process.cwd(), "public", "ui", "agents-panel.js"), "utf8");
const sidebar = readFileSync(join(process.cwd(), "public", "ui", "sidebar-agents.js"), "utf8");
const css = readFileSync(join(process.cwd(), "public", "ui", "config.css"), "utf8");

describe("onglet Agents — cases « bots autorisés »", () => {
  it("charge la liste des bots depuis GET /api/bots (jamais en dur)", () => {
    expect(panneau).toContain('from \'./bots-api.js\'');
    expect(panneau).toContain("listerBots(");
    expect(panneau).toContain("state.bots");
  });

  it("rend une case à cocher par bot, dans un fieldset nommé", () => {
    expect(panneau).toContain("agent-bots");
    expect(panneau).toContain('type: "checkbox"');
    expect(panneau).toContain("Bots autorisés à utiliser cet agent");
    // La case reflète la liste SERVEUR (source de vérité).
    expect(panneau).toContain("autorises.includes(bot.id)");
  });

  it("enregistre la liste par PATCH /api/agents/<id> (champ `bots`)", () => {
    expect(panneau).toContain("{ bots: wanted }");
    expect(panneau).toContain("HolafFetch.patch");
  });

  it("signale VISIBLEMENT un agent neutralisé (badge + phrase)", () => {
    expect(panneau).toContain("Neutralisé");
    expect(panneau).toContain("NEUTRALISÉ");
    expect(panneau).toContain("neutralise(agent)");
  });

  it("respecte la CSP : aucun innerHTML, aucun .style.", () => {
    expect(panneau).not.toContain("innerHTML");
    expect(panneau).not.toContain(".style.");
    expect(sidebar).not.toContain("innerHTML");
    // Seule la POSITION du menu flottant utilise le CSSOM (position: fixed).
    expect(sidebar).not.toContain(".style.background");
  });

  it("déclare le style des cases dans config.css (pas d'attribut style en ligne)", () => {
    expect(css).toContain(".agent-bots");
    expect(css).toContain(".agent-bots__input");
  });
});

describe("barre latérale — visibilité filtrée", () => {
  it("garde un agent dont la liste `bots` contient le bot courant", () => {
    const agents = [
      { agentId: "a1", bots: ["yuki"] },
      { agentId: "a2", bots: ["kohai"] },
      { agentId: "a3", bots: ["yuki", "kohai"] },
    ];
    expect(agentsVisiblesPourBot(agents, "yuki").map((a) => a.agentId)).toEqual(["a1", "a3"]);
    expect(agentsVisiblesPourBot(agents, "kohai").map((a) => a.agentId)).toEqual(["a2", "a3"]);
  });

  it("cache un agent NEUTRALISÉ (liste vide) pour tous les bots", () => {
    const agents = [{ agentId: "a1", bots: [] }];
    expect(agentsVisiblesPourBot(agents, "yuki")).toEqual([]);
    expect(agentsVisiblesPourBot(agents, "kohai")).toEqual([]);
  });

  it("ne cache JAMAIS un agent dont la trame ne porte pas `bots` (serveur ancien)", () => {
    const agents = [{ agentId: "a1" }];
    expect(agentsVisiblesPourBot(agents, "yuki").map((a) => a.agentId)).toEqual(["a1"]);
    // Sans bot connu, aucun filtrage (comportement d'avant).
    expect(agentsVisiblesPourBot(agents, undefined).map((a) => a.agentId)).toEqual(["a1"]);
  });

  it("dit la VRAIE raison quand tout est filtré (jamais « aucun agent appairé »)", () => {
    expect(sidebar).toContain("Aucun agent autorisé pour ce bot.");
    expect(sidebar).toContain("agentsVisiblesPourBot");
  });
});
