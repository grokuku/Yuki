/**
 * OUTILS DES CONSIGNES DURABLES (`memoriser_consigne`, `ajouter_fait`,
 * `lister_consignes`, `oublier_consigne`) + CAPACITÉ `memoire`.
 *
 * Ce que ce fichier VERROUILLE :
 *  ① les quatre outils existent, avec une phrase dans `PHRASES_OUTILS` et une
 *    place dans `OUTILS_DES_CAPACITES` (capacité `memoire`) ;
 *  ② la capacité `memoire` est REQUISE : sans elle, les outils n'arrivent pas
 *    dans l'allowlist finale ; avec elle, ils y sont ;
 *  ③ les refus sont EXPLICITES (51ᵉ consigne, entrée trop longue, doublon,
 *    correspondance ambiguë) — le bot peut le dire à l'utilisateur ;
 *  ④ `lister_consignes` rend les deux listes et leurs compteurs ;
 *  ⑤ les outils écrivent dans LE fichier du port (donc du bot), jamais ailleurs.
 *
 * ⚠️ ÉCHOUE SUR LE CODE D'ORIGINE : les quatre outils n'existent pas, ils ne
 * figurent ni dans `PHRASES_OUTILS` ni dans `OUTILS_DES_CAPACITES`.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_CONSIGNES,
  MAX_ENTREE_CHARS,
  portConsignes,
  type PortConsignes,
} from "../../src/consignes/index.js";
import { OUTILS_DES_CAPACITES, filtrerSelonCapacites } from "../../src/llm/index.js";
import { PHRASES_OUTILS, phraseOutil } from "../../src/llm/prompt-systeme.js";
import { toolAllowlist } from "../../src/llm/tool-policy.js";
import { createConsignesTools } from "../../src/pi/sdk/consignes-tools.js";

const racines: string[] = [];

afterEach(() => {
  for (const dir of racines.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function portTemporaire(): PortConsignes {
  const racine = mkdtempSync(join(tmpdir(), "yuki-consignes-outils-"));
  racines.push(racine);
  return portConsignes({ botId: "yuki", chemin: join(racine, "bots", "yuki", "consignes.md") });
}

type Outil = ReturnType<typeof createConsignesTools>[number];

async function appeler(outil: Outil, params: Record<string, unknown> = {}): Promise<string> {
  const fn = outil.execute as unknown as (
    id: string,
    params: unknown,
    signal: undefined,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<{ content: Array<{ text?: string }>; details: unknown }>;
  const resultat = await fn("call", params, undefined, undefined, {});
  return resultat.content.map((part) => part.text ?? "").join("\n");
}

function outil(tools: Outil[], nom: string): Outil {
  const trouve = tools.find((entree) => entree.name === nom);
  if (!trouve) throw new Error(`outil ${nom} absent`);
  return trouve;
}

describe("① les quatre outils sont décrits et classés", () => {
  it("les noms exposés sont exactement les quatre attendus", () => {
    const tools = createConsignesTools(portTemporaire());
    expect(tools.map((entree) => entree.name)).toEqual([
      "memoriser_consigne",
      "ajouter_fait",
      "lister_consignes",
      "oublier_consigne",
    ]);
  });

  it("chacun a une phrase dédiée (jamais la phrase de repli)", () => {
    for (const nom of [
      "memoriser_consigne",
      "ajouter_fait",
      "lister_consignes",
      "oublier_consigne",
    ]) {
      expect(PHRASES_OUTILS[nom], nom).toBeTruthy();
      expect(phraseOutil(nom), nom).not.toContain("pas encore enregistrée");
    }
  });

  it("ils appartiennent à la capacité `memoire`, et à elle SEULE", () => {
    const porteurs = Object.entries(OUTILS_DES_CAPACITES)
      .filter(([, entree]) => entree.custom.includes("memoriser_consigne"))
      .map(([capacite]) => capacite);
    expect(porteurs).toEqual(["memoire"]);
    for (const nom of ["ajouter_fait", "lister_consignes", "oublier_consigne"]) {
      expect(OUTILS_DES_CAPACITES.memoire.custom, nom).toContain(nom);
    }
  });
});

describe("② la capacité `memoire` est REQUISE", () => {
  const options = { consignesEnabled: true };
  const light = toolAllowlist("light", options);

  it("sans capacité `memoire`, les outils sont RETIRÉS de l'allowlist", () => {
    const sans = filtrerSelonCapacites(light, ["builtins", "fichiers"]);
    for (const nom of ["memoriser_consigne", "ajouter_fait", "lister_consignes", "oublier_consigne"]) {
      expect(sans, nom).not.toContain(nom);
    }
  });

  it("avec la capacité `memoire`, ils sont présents", () => {
    const avec = filtrerSelonCapacites(light, ["memoire"]);
    for (const nom of ["memoriser_consigne", "ajouter_fait", "lister_consignes", "oublier_consigne"]) {
      expect(avec, nom).toContain(nom);
    }
  });

  it("sans port (option absente), ils ne sont pas ouverts du tout", () => {
    const sansPort = toolAllowlist("light", {});
    expect(sansPort).not.toContain("memoriser_consigne");
  });
});

describe("③ refus EXPLICITES rendus au modèle", () => {
  it(`la ${MAX_CONSIGNES + 1}ᵉ consigne est refusée avec un message actionnable`, async () => {
    const port = portTemporaire();
    for (let index = 0; index < MAX_CONSIGNES; index += 1) port.ajouter("consigne", `c${index}`);
    const texte = await appeler(outil(createConsignesTools(port), "memoriser_consigne"), {
      texte: "une consigne de trop",
    });
    expect(texte).toContain("Refusé");
    expect(texte).toContain("Trop de consignes");
    expect(texte.toLowerCase()).toContain("supprimez");
  });

  it("une entrée de plus de 500 caractères est refusée (aucune troncature)", async () => {
    const texte = await appeler(outil(createConsignesTools(portTemporaire()), "ajouter_fait"), {
      texte: "y".repeat(MAX_ENTREE_CHARS + 10),
    });
    expect(texte).toContain("Refusé");
    expect(texte).toContain("trop longue");
  });

  it("un doublon n'est pas ajouté et le dit", async () => {
    const port = portTemporaire();
    const tools = createConsignesTools(port);
    await appeler(outil(tools, "memoriser_consigne"), { texte: "Ne refais plus jamais ça." });
    const second = await appeler(outil(tools, "memoriser_consigne"), {
      texte: "ne refais plus jamais ça.",
    });
    expect(second).toContain("DÉJÀ enregistrée");
    expect(port.lire().consignes).toHaveLength(1);
  });

  it("`oublier_consigne` REFUSE une correspondance ambiguë", async () => {
    const port = portTemporaire();
    const tools = createConsignesTools(port);
    await appeler(outil(tools, "memoriser_consigne"), { texte: "Réponds en anglais" });
    await appeler(outil(tools, "memoriser_consigne"), { texte: "Réponds en anglais le matin" });
    const refus = await appeler(outil(tools, "oublier_consigne"), { texte: "anglais" });
    expect(refus).toContain("Refusé");
    expect(refus).toContain("2 entrées");
    expect(port.lire().consignes).toHaveLength(2);
  });
});

describe("④ `lister_consignes` rend les deux listes et les compteurs", () => {
  it("affiche consignes ET faits, avec les bornes", async () => {
    const port = portTemporaire();
    port.ajouter("consigne", "Ne refais plus jamais ça.");
    port.ajouter("fait", "Mon NAS est à 10.0.0.5.");
    const texte = await appeler(outil(createConsignesTools(port), "lister_consignes"));
    expect(texte).toContain("Consignes : 1 /");
    expect(texte).toContain("Faits : 1 /");
    expect(texte).toContain("Ne refais plus jamais ça.");
    expect(texte).toContain("Mon NAS est à 10.0.0.5.");
  });

  it("listes vides : le dit franchement (aucun titre orphelin)", async () => {
    const texte = await appeler(outil(createConsignesTools(portTemporaire()), "lister_consignes"));
    expect(texte).toContain("Consignes : (aucune)");
    expect(texte).toContain("Faits : (aucune)");
  });
});

describe("⑤ écriture dans LE fichier du port (donc du bot)", () => {
  it("la consigne atterrit dans le fichier du port, et nulle part ailleurs", async () => {
    const racine = mkdtempSync(join(tmpdir(), "yuki-consignes-outils-"));
    racines.push(racine);
    const chemin = join(racine, "bots", "kohai", "consignes.md");
    const port = portConsignes({ botId: "kohai", chemin });
    await appeler(outil(createConsignesTools(port), "memoriser_consigne"), {
      texte: "Ne refais plus jamais ça.",
    });
    expect(readFileSync(chemin, "utf8")).toContain("Ne refais plus jamais ça.");
  });
});
