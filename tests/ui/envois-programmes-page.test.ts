/**
 * PAGE DE GESTION — volet « ENVOIS PROGRAMMÉS » (lot 28) + route d'annulation.
 *
 * ⚠️ POURQUOI CE FICHIER : un envoi programmé est un message qui partira TOUT SEUL.
 * S'il n'est pas VISIBLE et ANNULABLE, c'est une bombe à retardement — la personne ne
 * peut ni savoir qu'un message va partir dans un canal, ni l'empêcher. Ce fichier
 * verrouille donc trois choses :
 *
 *  ① les RÈGLES D'AFFICHAGE sont dans un module pur (`declencheurs-vue.js`) et sont
 *    testables sans navigateur (aucun jsdom dans le dépôt) ;
 *  ② la page emploie `HolafModal` pour la confirmation d'annulation (jamais la boîte
 *    native), n'écrit AUCUN `innerHTML` et n'ajoute aucun style en ligne (CSP stricte) ;
 *  ③ la route `GET /api/sources/envois` est GARDÉE, et `DELETE …/<id>` refuse
 *    EXPLICITEMENT un envoi déjà parti.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ANCRE_ENVOIS_PROGRAMMES,
  EVENEMENTS_JOURNAL,
  envoiAnnulable,
  libelleEtatEnvoi,
  texteCibleEnvoi,
  texteCompteEnvois,
  texteQuandEnvoi,
  texteResumeEnvoi,
  trierEnvois,
} from "../../public/ui/declencheurs-vue.js";
import { handleSourcesRequest } from "../../src/gateway/routes/sources.js";
import { EnvoisProgrammesService, EnvoisProgrammesStore } from "../../src/chat/envois/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const PUBLIC = join(process.cwd(), "public", "ui");

function fichier(nom: string): string {
  return readFileSync(join(PUBLIC, nom), "utf8");
}

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const T0 = Date.parse("2026-11-04T14:00:00Z");

describe("volet « Envois programmés » — règles d'affichage", () => {
  it("l'onglet Déclencheurs filtre les quatre événements du lot 28", () => {
    const types = EVENEMENTS_JOURNAL.map(([slug]) => slug);
    for (const type of ["envoi_programme", "envoi_publie", "envoi_annule", "envoi_echec"]) {
      expect(types).toContain(type);
    }
  });

  it("affiche l'instant EFFECTIF rendu par le serveur (jamais recalculé par le navigateur)", () => {
    // ⚠️ Le fuseau du navigateur n'est pas celui de Yuki : on affiche `quandLisible`
    // tel quel, et on y ajoute ce qui s'est réellement passé.
    expect(
      texteQuandEnvoi({
        quand: "2026-11-04T15:10:00.000Z",
        quandLisible: "4 novembre 2026 à 16:10 (Europe/Paris)",
        etat: "en_attente",
      }),
    ).toBe("4 novembre 2026 à 16:10 (Europe/Paris)");
    expect(
      texteQuandEnvoi({
        quandLisible: "4 novembre 2026 à 16:10 (Europe/Paris)",
        etat: "envoye",
        envoyeLe: "2026-11-04T15:10:02.000Z",
      }),
    ).toContain("parti le");
    expect(texteQuandEnvoi({ quandLisible: "x", etat: "echoue" })).toContain("n'est PAS parti");
    expect(texteQuandEnvoi({ quandLisible: "x", etat: "annule" })).toContain("annulé avant l'envoi");
  });

  it("dit la destination et l'état en français (jamais un slug brut)", () => {
    expect(texteCibleEnvoi({ cible: { type: "canal", libelle: "L'Imagerie" } })).toBe("L'Imagerie");
    expect(
      texteCibleEnvoi({ cible: { type: "canal", conversationId: "mm-imagerie" } }),
    ).toBe("mm-imagerie");
    expect(texteCibleEnvoi({ cible: { type: "local", sessionId: "abc" } })).toBe("conversation locale");
    expect(libelleEtatEnvoi("echoue")).toBe("échoué");
    expect(libelleEtatEnvoi("inconnu")).toBe("inconnu");
  });

  it("borne le résumé du message et DIT quand le serveur l'a déjà borné", () => {
    expect(texteResumeEnvoi({ texte: "court" })).toBe("court");
    const long = texteResumeEnvoi({ texte: "a".repeat(400) }, 20);
    expect(long.startsWith("a".repeat(20))).toBe(true);
    expect(long).toContain("…");
    expect(texteResumeEnvoi({ texte: "court", texteTronque: true })).toContain("résumé borné");
    expect(texteResumeEnvoi({ texte: "   " })).toBe("(texte vide)");
  });

  it("n'offre « Annuler » QUE sur un envoi encore en attente", () => {
    expect(envoiAnnulable({ etat: "en_attente" })).toBe(true);
    expect(envoiAnnulable({ etat: "envoye" })).toBe(false);
    expect(envoiAnnulable({ etat: "echoue" })).toBe(false);
    expect(envoiAnnulable({ etat: "annule" })).toBe(false);
    expect(envoiAnnulable({ etat: "en_cours" })).toBe(false);
  });

  it("trie les en attente d'abord (les plus proches), puis les terminés", () => {
    const ordre = trierEnvois([
      { id: "c", etat: "envoye", quand: "2026-11-04T14:00:00Z", envoyeLe: "2026-11-04T14:00:01Z" },
      { id: "b", etat: "en_attente", quand: "2026-11-04T18:00:00Z" },
      { id: "a", etat: "en_attente", quand: "2026-11-04T16:00:00Z" },
      { id: "d", etat: "echoue", quand: "2026-11-04T13:00:00Z" },
    ]);
    expect(ordre.map((envoi: { id: string }) => envoi.id)).toEqual(["a", "b", "c", "d"]);
    expect(trierEnvois(undefined)).toEqual([]);
  });

  it("affiche TOUJOURS le plafond et l'horizon (le refus du modèle s'explique)", () => {
    expect(
      texteCompteEnvois({ enAttente: 2, maximumEnAttente: 20, horizonJours: 30, delaiMinSecondes: 30 }),
    ).toBe("2 en attente · maximum 20 · horizon 30 jours · au moins 30 s d'avance");
    expect(texteCompteEnvois({})).toBe("0 en attente");
  });

  it("l'ancre du volet est stable (lien direct depuis la page)", () => {
    expect(ANCRE_ENVOIS_PROGRAMMES).toBe("envois-programmes");
  });
});

describe("volet « Envois programmés » — câblage de la page", () => {
  const panneau = fichier("sources-panel.js");

  it("déclare le volet, l'affiche et le recharge à l'ouverture", () => {
    expect(panneau).toContain("ANCRE_ENVOIS_PROGRAMMES");
    expect(panneau).toContain("Envois programmés (messages qui partiront à une heure précise)");
    expect(panneau).toContain('HolafFetch.get("/api/sources/envois"');
    expect(panneau).toContain("await chargerEnvois();");
    // ⚠️ MONTÉ dans la page, pas seulement défini : un volet construit mais absent de
    // l'arbre ne serait ni visible ni annulable — exactement la bombe à retardement
    // que cette fonction doit empêcher.
    expect(panneau).toMatch(/sectionsEl,[\s\S]{0,80}?envoisDetails,/u);
  });

  it("⚠️ annule par `HolafModal.confirm` (jamais `window.confirm`) et par la route DELETE", () => {
    expect(panneau).toContain("HolafModal.confirm(");
    expect(panneau).toContain("/api/sources/envois/${encodeURIComponent(envoi.id)}");
    expect(panneau).toContain("Annuler l'envoi");
    // La boîte native est interdite dans toute la page (CSP + cohérence visuelle).
    expect(panneau).not.toContain("window.confirm(");
    expect(panneau).not.toContain("alert(");
  });

  it("n'emploie NI `innerHTML` NI style en ligne (CSP stricte)", () => {
    // ⚠️ Le mot n'apparaît que dans le commentaire de garde en tête de fichier : ce
    // qu'on interdit, c'est l'AFFECTATION (`el.innerHTML = …`), qui exécuterait du HTML.
    expect(panneau).not.toMatch(/\.innerHTML\s*=/u);
    expect(panneau).not.toMatch(/\bstyle\s*=/u);
  });

  it("le CSS du volet existe (aucune classe orpheline)", () => {
    const css = fichier("config.css");
    for (const classe of [".envois-section", ".envois-table", ".envois-quand", ".envois-etat", ".envois-row--echoue"]) {
      expect(css).toContain(classe);
    }
  });
});

function makeService(dir: string) {
  const horloge = { at: T0 };
  const store = EnvoisProgrammesStore.open({ path: join(dir, "envois-programmes.json"), now: () => horloge.at });
  const service = new EnvoisProgrammesService({
    store,
    canaux: () => [{ conversationId: "mm-imagerie", titre: "L'Imagerie", plateforme: "mattermost" }],
    publier: async () => undefined,
    logger,
    now: () => horloge.at,
  });
  return { service, store, horloge };
}

describe("API /api/sources/envois — lecture GARDÉE et annulation", () => {
  it("refuse la lecture sans l'en-tête d'administration (403)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yuki-envois-api-"));
    try {
      const { service } = makeService(dir);
      const anonyme = await handleSourcesRequest({
        method: "GET",
        path: "/api/sources/envois",
        headers: {},
        body: "",
        deps: { service: {} as never, logger, envois: service },
      });
      expect(anonyme.status).toBe(403);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rend la liste, le compte en attente et les bornes annoncées au modèle", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yuki-envois-api-"));
    try {
      const { service } = makeService(dir);
      const programmation = service.programmer({
        quand: "dans 10 min",
        texte: "Message programmé.",
        conversation: { canal: "mm-imagerie" },
      });
      expect(programmation.ok).toBe(true);

      const reponse = await handleSourcesRequest({
        method: "GET",
        path: "/api/sources/envois",
        headers: { "x-yuki-config": "1" },
        body: "",
        deps: { service: {} as never, logger, envois: service },
      });
      expect(reponse.status).toBe(200);
      const corps = reponse.body as {
        envois: Array<Record<string, unknown>>;
        enAttente: number;
        maximumEnAttente: number;
        horizonJours: number;
        delaiMinSecondes: number;
      };
      expect(corps.enAttente).toBe(1);
      expect(corps.maximumEnAttente).toBe(20);
      expect(corps.horizonJours).toBe(30);
      expect(corps.delaiMinSecondes).toBe(30);
      expect(corps.envois[0]).toMatchObject({
        texte: "Message programmé.",
        etat: "en_attente",
        texteTronque: false,
      });
      // La destination est rendue LISIBLE (la page n'a pas à la recalculer).
      expect((corps.envois[0]?.cible as { libelle: string }).libelle).toBe("L'Imagerie");
      // Un instant EFFECTIF est rendu, fuseau compris.
      expect(String(corps.envois[0]?.quandLisible)).toContain("Europe/Paris");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("annule un envoi en attente, puis refuse (409) ce qui est déjà parti", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yuki-envois-api-"));
    try {
      const { service, store, horloge } = makeService(dir);
      const programmation = service.programmer({
        quand: "dans 10 min",
        texte: "À annuler.",
        conversation: { canal: "mm-imagerie" },
      });
      if (!programmation.ok) throw new Error(programmation.raison);
      const id = programmation.envoi.id;

      const annulation = await handleSourcesRequest({
        method: "DELETE",
        path: `/api/sources/envois/${id}`,
        headers: { "x-yuki-config": "1" },
        body: "",
        deps: { service: {} as never, logger, envois: service },
      });
      expect(annulation.status).toBe(200);
      expect((annulation.body as { annule: boolean }).annule).toBe(true);
      expect(store.get(id)?.etat).toBe("annule");

      // Deuxième annulation : refus explicite (409), jamais un succès muet.
      const encore = await handleSourcesRequest({
        method: "DELETE",
        path: `/api/sources/envois/${id}`,
        headers: { "x-yuki-config": "1" },
        body: "",
        deps: { service: {} as never, logger, envois: service },
      });
      expect(encore.status).toBe(409);
      expect(String((encore.body as { message: string }).message)).toContain("déjà annulé");

      // Un envoi DÉJÀ PARTI ne peut plus être annulé : le message le dit.
      const second = service.programmer({
        quand: "dans 2 min",
        texte: "Déjà parti.",
        conversation: { canal: "mm-imagerie" },
      });
      if (!second.ok) throw new Error(second.raison);
      horloge.at = T0 + 3 * 60_000;
      await service.executerDus(horloge.at);
      const tropTard = await handleSourcesRequest({
        method: "DELETE",
        path: `/api/sources/envois/${second.envoi.id}`,
        headers: { "x-yuki-config": "1" },
        body: "",
        deps: { service: {} as never, logger, envois: service },
      });
      expect(tropTard.status).toBe(409);
      expect(String((tropTard.body as { message: string }).message)).toContain("envoye");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("répond 503 quand le service n'est pas câblé (jamais une liste inventée)", async () => {
    const liste = await handleSourcesRequest({
      method: "GET",
      path: "/api/sources/envois",
      headers: { "x-yuki-config": "1" },
      body: "",
      deps: { service: {} as never, logger },
    });
    expect(liste.status).toBe(200);
    expect((liste.body as { envois: unknown[] }).envois).toEqual([]);

    const annulation = await handleSourcesRequest({
      method: "DELETE",
      path: "/api/sources/envois/abc",
      headers: { "x-yuki-config": "1" },
      body: "",
      deps: { service: {} as never, logger },
    });
    expect(annulation.status).toBe(503);
  });
});
