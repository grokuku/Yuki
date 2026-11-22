/**
 * QUOTAS DE L'ONGLET « DÉCLENCHEURS » — visibles AVANT le refus (2026-11-22).
 *
 * ⚠️ LE DÉFAUT CORRIGÉ, ET IL EST DOUBLE :
 *  ① la page n'affichait AUCUN quota de tâches ponctuelles : on découvrait la borne de 20
 *    en recevant un refus (le même défaut que l'horizon de 30 jours, retiré le même
 *    jour — une limite qu'on n'apprend qu'en échouant) ;
 *  ② le refus promettait qu'une place se libère « quand la tâche s'exécute », ce qui
 *    n'arrivait jamais (aucune purge).
 *
 * ⚠️ CE FICHIER VERROUILLE la partie VISIBLE : les règles d'affichage sont des fonctions
 * PURES (`declencheurs-vue.js`), la route rend les bornes du SERVEUR (jamais une
 * constante recopiée dans la page), et la page affiche le compteur en permanence.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  texteCompteDurables,
  texteCompteTaches,
} from "../../public/ui/declencheurs-vue.js";
import { handleSourcesRequest } from "../../src/gateway/routes/sources.js";
import { MAX_SOURCES, MAX_TACHES_PONCTUELLES } from "../../src/sources/types.js";

const PUBLIC = join(process.cwd(), "public", "ui");

function fichier(nom: string): string {
  return readFileSync(join(PUBLIC, nom), "utf8");
}

const BORNES = {
  maximumTachesPonctuelles: MAX_TACHES_PONCTUELLES,
  maximumSources: MAX_SOURCES,
  retentionTachesTermineesJours: 7,
};

const SOURCES = [
  { nom: "resume", declencheur: { type: "ponctuel" }, actif: true },
  { nom: "verif", declencheur: { type: "ponctuel" }, actif: false },
  { nom: "veille", declencheur: { type: "planning" }, actif: true },
];

const logger = { info: () => {}, warn: () => {}, error: () => {} };

describe("compteur des tâches ponctuelles — le quota AVANT le refus", () => {
  it("affiche « N sur 20 » et le nombre de tâches TERMINÉES (donc supprimables)", () => {
    const texte = texteCompteTaches(SOURCES, BORNES);
    expect(texte).toContain(`${MAX_TACHES_PONCTUELLES}`);
    expect(texte).toContain("2 sur 20 tâches ponctuelles");
    expect(texte).toContain("1 à venir");
    expect(texte).toContain("1 terminée(s)");
    // ⚠️ La rétention est DITE : sans elle, « terminée » laisse croire que la place est
    // perdue à jamais.
    expect(texte).toContain("supprimées après 7 jours");
    expect(texte).toContain("libère une place");
  });

  it("reste lisible sans bornes connues (jamais une case vide ni « undefined »)", () => {
    expect(texteCompteTaches(SOURCES, {})).toContain("2 tâche(s) ponctuelle(s)");
    expect(texteCompteTaches(undefined, {})).toContain("0");
    expect(texteCompteTaches(SOURCES, {})).not.toContain("undefined");
    // Aucune rétention connue ⇒ aucune promesse de purge n'est affichée.
    expect(texteCompteTaches([{ declencheur: { type: "ponctuel" }, actif: false }], {})).not.toContain(
      "après",
    );
  });

  it("le compteur des DÉCLENCHEURS DURABLES suit la même règle (20)", () => {
    const texte = texteCompteDurables(SOURCES, BORNES);
    expect(texte).toBe("1 sur 20 déclencheurs durables");
    expect(texteCompteDurables(SOURCES, {})).toBe("1 déclencheur(s) durable(s)");
  });

  it("la PAGE affiche le compteur et lit les bornes du SERVEUR", () => {
    const panneau = fichier("sources-panel.js");
    expect(panneau).toContain("texteCompteTaches");
    expect(panneau).toContain("texteCompteDurables");
    // ⚠️ Les bornes viennent de la réponse (`bornes`), jamais d'une constante recopiée.
    expect(panneau).toContain("state.bornes");
    expect(panneau).toContain("data?.bornes");
    // Le compteur est rendu AVANT les sections (donc avant tout refus possible).
    const debutSections = panneau.indexOf("function renderSections()");
    const compteur = panneau.indexOf("texteCompteTaches(state.sources, state.bornes)");
    expect(debutSections).toBeGreaterThan(0);
    expect(compteur).toBeGreaterThan(debutSections);
  });

  it("le journal expose la PURGE dans les filtres (une disparition s'explique)", () => {
    const vue = fichier("declencheurs-vue.js");
    expect(vue).toContain('["purge"');
    expect(vue).toContain('["tache_modifiee"');
    expect(vue).toContain('["tache_supprimee"');
  });

  it("la route `GET /api/sources` rend les BORNES (tâches ponctuelles, durables, rétention)", async () => {
    const reponse = await handleSourcesRequest({
      method: "GET",
      path: "/api/sources",
      headers: { "x-yuki-config": "1" },
      body: "",
      deps: {
        service: {
          list: () => [],
          conversationList: async () => [],
        } as never,
        logger,
      },
    });
    expect(reponse.status).toBe(200);
    const corps = reponse.body as {
      bornes?: {
        maximumTachesPonctuelles?: number;
        maximumSources?: number;
        retentionTachesTermineesJours?: number;
      };
    };
    expect(corps.bornes?.maximumTachesPonctuelles).toBe(MAX_TACHES_PONCTUELLES);
    expect(corps.bornes?.maximumSources).toBe(MAX_SOURCES);
    // ⚠️ 7 jours, la rétention déjà utilisée par les envois terminés et les
    // déclencheurs temporaires éteints : aucun réglage nouveau.
    expect(corps.bornes?.retentionTachesTermineesJours).toBe(7);
  });
});
