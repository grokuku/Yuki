/**
 * MENUS DE MODÈLES PAR RÔLE (lot B, 2026-11-19) — RÈGLES PURES.
 *
 * ⚠️ Ce fichier verrouille ce qui ne se voit pas dans une capture d'écran :
 *  - la liste de VISION ne propose QUE les modèles qui voient les images ;
 *  - la ligne « effectif : … » dit la VÉRITÉ (défaut appliqué, surcharge, modèle
 *    introuvable, ou rien de réglé) — sans elle, un défaut d'instance s'applique
 *    sans qu'on le sache ;
 *  - le libellé d'un modèle porte TOUJOURS son fournisseur (deux fournisseurs
 *    peuvent exposer le même nom de modèle).
 *
 * ⚠️ Ces règles sont testées SANS navigateur (`public/ui/llm-choix.js` n'importe
 * que `modeles-aide.js`) : une régression de formulation ne doit pas dépendre
 * d'un rendu réel pour être vue.
 */

import { describe, expect, it } from "vitest";

import {
  libelleModele,
  ligneEffective,
  modelesProposes,
} from "../../public/ui/llm-choix.js";

interface ModeleChoix {
  id: string;
  nom: string;
  fournisseurId: string;
  vision: boolean;
  thinking: string;
}

const FOURNISSEURS = [
  { id: "ollama-com", nom: "ollama.com" },
  { id: "local", nom: "Local" },
];
const MODELES: ModeleChoix[] = [
  { id: "gemma4-31b", nom: "gemma4:31b", fournisseurId: "ollama-com", vision: true, thinking: "off" },
  { id: "deepseek", nom: "deepseek-v4.1-flash", fournisseurId: "ollama-com", vision: false, thinking: "high" },
  { id: "qwen-vl", nom: "qwen-vl", fournisseurId: "local", vision: true, thinking: "off" },
];

const LEGER = { id: "light", visionSeulement: false };
const LOURD = { id: "heavy", visionSeulement: false };
const VISION = { id: "vision", visionSeulement: true };

describe("① la liste de VISION ne propose que les modèles qui voient les images", () => {
  it("filtre sur `vision === true` (le modèle aveugle est exclu)", () => {
    expect(modelesProposes(MODELES, VISION).map((modele: ModeleChoix) => modele.id)).toEqual([
      "gemma4-31b",
      "qwen-vl",
    ]);
    // ⚠️ Un modèle incapable de décrire une image ne doit JAMAIS être proposé
    // comme repli : il échouerait au premier envoi.
    expect(
      modelesProposes(MODELES, VISION).some((modele: ModeleChoix) => modele.vision !== true),
    ).toBe(false);
  });

  it("les rôles de conversation, eux, proposent TOUT le catalogue", () => {
    expect(modelesProposes(MODELES, LEGER)).toHaveLength(3);
    expect(modelesProposes(MODELES, LOURD)).toHaveLength(3);
  });
});

describe("② la ligne « effectif » dit ce qui est RÉELLEMENT utilisé", () => {
  it("bot sans surcharge : le défaut s'applique et c'est DIT", () => {
    expect(
      ligneEffective({
        modeleId: "gemma4-31b",
        surcharge: "",
        bot: true,
        modeles: MODELES,
        fournisseurs: FOURNISSEURS,
      }),
    ).toBe("effectif : gemma4:31b · ollama.com (défaut de l'instance)");
  });

  it("bot avec surcharge : la mention de défaut disparaît", () => {
    expect(
      ligneEffective({
        modeleId: "qwen-vl",
        surcharge: "qwen-vl",
        bot: true,
        modeles: MODELES,
        fournisseurs: FOURNISSEURS,
      }),
    ).toBe("effectif : qwen-vl · Local");
  });

  it("page d'instance : le défaut est le choix, sans mention d'héritage", () => {
    expect(
      ligneEffective({
        modeleId: "deepseek",
        surcharge: "deepseek",
        bot: false,
        modeles: MODELES,
        fournisseurs: FOURNISSEURS,
      }),
    ).toBe("effectif : deepseek-v4.1-flash · ollama.com");
  });

  it("sélection cassée : « modèle introuvable », jamais un modèle inventé", () => {
    expect(
      ligneEffective({
        modeleId: "supprime",
        surcharge: "supprime",
        bot: true,
        modeles: MODELES,
        fournisseurs: FOURNISSEURS,
      }),
    ).toBe("effectif : modèle introuvable (« supprime ») — choisissez un modèle du catalogue.");
  });

  it("rien de réglé : DEUX textes distincts selon la page", () => {
    const commun = { modeleId: "", surcharge: "", modeles: MODELES, fournisseurs: FOURNISSEURS };
    expect(ligneEffective({ ...commun, bot: true })).toContain("ce bot ne peut pas travailler");
    expect(ligneEffective({ ...commun, bot: false })).toContain("chaque bot doit choisir son modèle");
  });
});

describe("③ le libellé d'un modèle porte son FOURNISSEUR", () => {
  it("nom · fournisseur, et `null` pour un identifiant inconnu", () => {
    expect(libelleModele(MODELES, FOURNISSEURS, "qwen-vl")).toBe("qwen-vl · Local");
    expect(libelleModele(MODELES, FOURNISSEURS, "gemma4-31b")).toBe("gemma4:31b · ollama.com");
    expect(libelleModele(MODELES, FOURNISSEURS, "inconnu")).toBe(null);
  });
});
