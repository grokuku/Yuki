/**
 * LOT 26 / 4 — LA PARTIE « PRÉ-AUTORISATIONS » DE LA PAGE DE GESTION.
 *
 * ⚠️ Ces tests portent sur les RÈGLES (`public/ui/preautorisations-vue.js`) et
 * sur le MARKUP du panneau, pas sur un rendu : ils ÉCHOUENT sur le code
 * d'origine, où ni le module ni la section n'existent
 * (`git show HEAD:public/ui/sources-panel.js` ne connaît aucune
 * pré-autorisation, et `preautorisations-vue.js` n'existe pas).
 *
 * Ce qui est verrouillé ici :
 *  - ⚠️ la phrase de RISQUE : elle dit QUELLES commandes, sur QUELLE machine, et
 *    surtout SANS VALIDATION ;
 *  - le motif à JOKER est refusé côté page (le serveur le refuse aussi) ;
 *  - le COMPTEUR de consommations et l'ÉCHÉANCE se lisent sans ambiguïté ;
 *  - le formulaire propose une LISTE de motifs (catalogue serveur) + une saisie
 *    personnalisée EXPLICITE, et il est bâti sans `innerHTML` ;
 *  - la révocation passe par `HolafModal` (jamais `window.confirm`).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DUREE_DEFAUT_JOURS,
  DUREE_MAX_JOURS,
  compterParEtat,
  erreurMotif,
  expirationDepuis,
  expirationProche,
  libelleEtat,
  phraseRisque,
  preAutorisationsDuDeclencheur,
  resumerPreAutorisation,
  texteCompteEtats,
  texteConsommations,
  texteCouverture,
  texteEcheance,
} from "../../public/ui/preautorisations-vue.js";

const UI = join(process.cwd(), "public", "ui");
const lire = (nom: string): string => readFileSync(join(UI, nom), "utf8");

const PANNEAU = lire("sources-panel.js");
const VUE = lire("preautorisations-vue.js");
const CONFIG_CSS = lire("config.css");

function pre(extra: Record<string, unknown> = {}) {
  return {
    id: "pre_1",
    declencheur: "veille",
    agentId: "agent-a",
    agentNom: "nuc00",
    motif: "df -h",
    portee: "exacte",
    destructifAutorise: false,
    expireA: new Date(Date.now() + 20 * 86_400_000).toISOString(),
    creeLe: new Date().toISOString(),
    consommations: 0,
    etat: "active",
    ...extra,
  };
}

describe("pré-autorisations — la phrase de RISQUE", () => {
  it("dit QUELLES commandes, sur QUELLE machine, et SANS validation", () => {
    const texte = phraseRisque({
      declencheur: "veille",
      agentNom: "nuc00",
      motif: "systemctl restart ",
      portee: "prefixe",
      destructifAutorise: false,
      expireA: "2030-01-01T00:00:00.000Z",
    });
    expect(texte).toContain("« veille »");
    expect(texte).toContain("TOUTES les commandes commençant par « systemctl restart »");
    expect(texte).toContain("« nuc00 »");
    expect(texte).toContain("SANS VALIDATION");
    expect(texte).toContain("sur cette machine");
    // Une autorisation ne vaut qu'UNE exécution, et se révoque.
    expect(texte).toContain("Une seule exécution");
    expect(texte).toContain("Révocable");
    // Le caractère destructeur est dit explicitement dans les deux sens.
    expect(texte).toContain("destructrices resteront refusées");
    expect(
      phraseRisque({
        declencheur: "veille",
        agentNom: "nuc00",
        motif: "apt-get -y upgrade",
        portee: "exacte",
        destructifAutorise: true,
      }),
    ).toContain("Y COMPRIS les commandes classées DESTRUCTRICES");
  });

  it("avertit quand RIEN n'est encore choisi (jamais une phrase rassurante à tort)", () => {
    const texte = phraseRisque({} as never);
    expect(texte).toContain("déclencheur non choisi");
    expect(texte).toContain("machine non choisie");
    expect(texte).toContain("PAS ENCORE CHOISIES");
  });
});

describe("pré-autorisations — garde-fous de SAISIE", () => {
  it("refuse un joker, un motif vide et un préfixe trop court", () => {
    expect(erreurMotif("*", "prefixe")).toContain("joker");
    expect(erreurMotif("systemctl *", "exacte")).toContain("joker");
    expect(erreurMotif("   ", "exacte")).toContain("Renseignez");
    expect(erreurMotif("sudo", "prefixe")).toContain("trop court");
    expect(erreurMotif("sudo", "exacte")).toBe("");
    expect(erreurMotif("systemctl restart ", "prefixe")).toBe("");
  });
});

describe("pré-autorisations — état, compteur, échéance", () => {
  it("affiche le COMPTEUR de consommations et l'échéance", () => {
    expect(texteConsommations(pre())).toContain("0 consommation");
    const utilisee = pre({ consommations: 1, consommeeLe: "2026-01-02T03:04:05.000Z" });
    expect(texteConsommations(utilisee)).toContain("1 consommation");
    expect(texteConsommations(utilisee)).toContain("utilisée le");
    expect(texteEcheance(pre({ etat: "revoquee" }))).toContain("révoquée");
    expect(libelleEtat("expiree")).toBe("expirée");
    expect(libelleEtat("inconnu")).toBe("inconnu");
  });

  it("décrit la couverture et résume une ligne", () => {
    expect(texteCouverture(pre())).toBe("df -h (commande exacte)");
    expect(texteCouverture(pre({ portee: "prefixe", motif: "rsync -a " }))).toBe(
      "rsync -a … (préfixe déclaré)",
    );
    const resume = resumerPreAutorisation(pre());
    expect(resume).toContain("veille → nuc00");
    expect(resume).toContain("active");
  });

  it("signale une expiration PROCHE, et seulement pour une autorisation active", () => {
    const maintenant = Date.parse("2026-01-01T00:00:00.000Z");
    expect(
      expirationProche(pre({ expireA: "2026-01-03T00:00:00.000Z" }), maintenant),
    ).toBe(true);
    expect(
      expirationProche(pre({ expireA: "2026-03-01T00:00:00.000Z" }), maintenant),
    ).toBe(false);
    expect(
      expirationProche(pre({ etat: "consommee", expireA: "2026-01-02T00:00:00.000Z" }), maintenant),
    ).toBe(false);
  });

  it("compte par état (bandeau) et filtre par déclencheur", () => {
    const liste = [
      pre(),
      pre({ id: "pre_2", etat: "consommee", consommations: 1 }),
      pre({ id: "pre_3", declencheur: "autre", etat: "active" }),
    ];
    expect(compterParEtat(liste)).toEqual({
      active: 2,
      consommee: 1,
      expiree: 0,
      revoquee: 0,
    });
    expect(texteCompteEtats(liste)).toContain("3 pré-autorisation(s)");
    expect(texteCompteEtats([])).toContain("aucune pré-autorisation");
    // ⚠️ Seules les ACTIVES sont rendues (une consommée ne l'est plus).
    expect(preAutorisationsDuDeclencheur(liste, "veille").map((item) => item.id)).toEqual([
      "pre_1",
    ]);
  });

  it("calcule l'échéance d'aperçu (bornée à 90 jours)", () => {
    const maintenant = Date.parse("2026-01-01T00:00:00.000Z");
    const defaut = Date.parse(expirationDepuis(undefined, maintenant));
    expect(Math.round((defaut - maintenant) / 86_400_000)).toBe(DUREE_DEFAUT_JOURS);
    const borne = Date.parse(expirationDepuis(1000, maintenant));
    expect(Math.round((borne - maintenant) / 86_400_000)).toBe(DUREE_MAX_JOURS);
  });
});

describe("pré-autorisations — le PANNEAU et son CSS", () => {
  it("le module ne touche jamais au DOM (règles pures)", () => {
    expect(VUE).not.toContain("document.");
    expect(VUE).not.toContain("innerHTML");
  });

  it("la section existe dans l'onglet Déclencheurs, avec un catalogue SERVEUR", () => {
    // Ancre dédiée (lien direct possible) et section dans le panneau des sources.
    expect(PANNEAU).toContain("preauth-section");
    expect(PANNEAU).toContain("Pré-autorisations");
    // ⚠️ La liste des motifs vient du SERVEUR : aucune copie locale qui dérive.
    expect(PANNEAU).toContain("/api/sources/preautorisations");
    expect(PANNEAU).toContain("state.motifs");
    expect(PANNEAU).toContain("MOTIF_PERSONNALISE");
    // Révocation : HolafModal, jamais window.confirm.
    expect(PANNEAU).toContain("HolafModal.confirm");
    expect(PANNEAU).not.toContain("window.confirm");
    // Pas d'affectation d'HTML dans ce panneau (CSP stricte, texte seul).
    expect(PANNEAU).not.toContain(".innerHTML");
    expect(PANNEAU).not.toContain("insertAdjacentHTML");
  });

  it("le CSS de la phrase de risque et du tableau existe", () => {
    expect(CONFIG_CSS).toContain(".preauth-risque");
    expect(CONFIG_CSS).toContain(".preauth-table");
  });
});
