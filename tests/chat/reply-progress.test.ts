/**
 * PROGRESSION d'un run distant — module PUR (`src/chat/reply/progress.ts`).
 *
 * ⚠️ Ce que ce fichier verrouille, sans réseau, sans modèle et sans horloge réelle :
 *  - **un seul accusé par run**, jamais un par outil, et jamais d'accusé pour un
 *    outil absent de l'allowlist du run (`run_command` n'existe pas à distance) ;
 *  - l'accusé vient du MODÈLE quand son texte est ack-shaped, sinon du repli en
 *    rotation — et il ne dépasse JAMAIS `ACK_MAX_CHARS` ;
 *  - une **image** part DÈS sa production (une fois), et n'est pas réattachée ;
 *  - un **échec** donne UNE ligne déterministe par outil, jamais deux ;
 *  - un outil de plus de 90 s donne UN rappel, jamais deux ;
 *  - **trois résultats par run** au plus ; le reste est OMIS et la réponse finale
 *    le dit (`resume()`) ;
 *  - l'ORDRE des publications est celui des événements (chaîne sérialisée).
 *
 * ⚠️ Échoue sur le code d'origine : `src/chat/reply/progress.ts` n'existe pas.
 */

import { describe, expect, it } from "vitest";

import { ACK_MAX_CHARS, ACK_FALLBACK_TEXTS } from "../../src/pi/ack.js";
import {
  PROGRESS_IMAGE_TEXT,
  PROGRESS_LONG_TOOL_MS,
  PROGRESS_LONG_TOOL_TEXT,
  PROGRESS_MAX_RESULTS,
  PROGRESS_SUPPRESSED_TEXT,
  ReplyProgress,
  progressErrorText,
  type ProgressMessage,
} from "../../src/chat/index.js";

/** Journal de publication : ordre EXACT des messages partis. */
function journal() {
  const envoyes: ProgressMessage[] = [];
  return {
    envoyes,
    publier: async (message: ProgressMessage): Promise<void> => {
      envoyes.push(message);
    },
  };
}

const OUTILS_DISTANTS = ["generer_image", "lire_fichier", "envoyer_fichier"] as const;

function progress(
  publier: (message: ProgressMessage) => Promise<void>,
  options: { outils?: readonly string[]; maintenant?: () => number } = {},
) {
  return new ReplyProgress({
    publier,
    outils: options.outils ?? OUTILS_DISTANTS,
    ...(options.maintenant ? { maintenant: options.maintenant } : {}),
  });
}

describe("accusé — verrou 1/run et forme", () => {
  it("publie l'accusé du MODÈLE quand le texte est court et sur une ligne", async () => {
    const trace = journal();
    const p = progress(trace.publier);
    p.demarrerOutil({ tool: "generer_image", ackCandidat: "  Deux secondes.  " });
    await p.attendre();

    expect(trace.envoyes).toEqual([{ text: "Deux secondes." }]);
    expect(p.ackPublie).toEqual({ text: "Deux secondes.", tool: "generer_image", source: "modele" });
    expect(p.ackSource).toBe("modele");
  });

  it("n'accuse qu'UNE fois, même si plusieurs outils d'action longue démarrent", async () => {
    const trace = journal();
    const p = progress(trace.publier);
    p.demarrerOutil({ tool: "generer_image", ackCandidat: "C'est parti." });
    p.demarrerOutil({ tool: "generer_image", ackCandidat: "Je relance." });
    p.demarrerOutil({ tool: "run_command", ackCandidat: "Je transmets." });
    await p.attendre();

    expect(trace.envoyes).toHaveLength(1);
    expect(trace.envoyes[0]).toEqual({ text: "C'est parti." });
  });

  it("un outil HORS allowlist ne déclenche AUCUN accusé (le distant n'a pas `run_command`)", async () => {
    const trace = journal();
    const p = progress(trace.publier);
    p.demarrerOutil({ tool: "run_command" });
    await p.attendre();

    expect(trace.envoyes).toEqual([]);
    expect(p.ackPublie).toBeUndefined();
  });

  it("un texte de modèle TROP LONG est du CONTENU : aucun accusé n'est publié (ni modèle, ni repli)", async () => {
    const trace = journal();
    const p = progress(trace.publier);
    p.demarrerOutil({ tool: "generer_image", ackCandidat: "a ".repeat(ACK_MAX_CHARS) });
    await p.attendre();

    // ⚠️ Le texte reste dans la RÉPONSE (il est déjà du contenu) : y ajouter une ligne
    // de statut ferait deux publications pour la même phrase.
    expect(trace.envoyes).toEqual([]);
    expect(p.ackPublie).toBeUndefined();
  });

  it("un texte de modèle MULTILIGNE est du CONTENU, pas un accusé", async () => {
    const trace = journal();
    const p = progress(trace.publier);
    p.demarrerOutil({ tool: "generer_image", ackCandidat: "Deux secondes.\nJe lance ça." });
    await p.attendre();

    expect(trace.envoyes).toEqual([]);
  });

  it("le repli ne parle que sur un SILENCE réel, et TOURNE quand la rotation est partagée (deux runs, deux phrases)", async () => {
    const compteur = { index: 0 };
    const tourner = (): number => {
      const index = compteur.index;
      compteur.index += 1;
      return index;
    };
    const premier = journal();
    const second = journal();
    const a = new ReplyProgress({
      publier: premier.publier,
      // ⚠️ Le distant n'a pas `run_command` : c'est le câblage réel qui réduit la liste.
      outils: [...OUTILS_DISTANTS],
      indexRepli: tourner,
    });
    const b = new ReplyProgress({
      publier: second.publier,
      outils: [...OUTILS_DISTANTS],
      indexRepli: tourner,
    });
    a.demarrerOutil({ tool: "generer_image" });
    b.demarrerOutil({ tool: "generer_image" });
    await a.attendre();
    await b.attendre();

    expect(second.envoyes[0]?.text).not.toBe(premier.envoyes[0]?.text);
    // Les deux sont bien des phrases de la TABLE (aucun ack du modèle ici : il est muet).
    for (const trace of [premier, second]) {
      expect(ACK_FALLBACK_TEXTS.generer_image).toContain(trace.envoyes[0]?.text ?? "");
    }
    expect(a.ackSource).toBe("repli");
    expect(b.ackSource).toBe("repli");
  });
});

describe("fichier produit — publié à l'arrivée, jamais réattaché", () => {
  it("part IMMÉDIATEMENT, une seule fois, et sort de `fichiersRestants`", async () => {
    const trace = journal();
    const p = progress(trace.publier);
    p.publierFichier("f-1");
    p.publierFichier("f-1");
    await p.attendre();

    expect(trace.envoyes).toEqual([{ text: PROGRESS_IMAGE_TEXT, fichiers: ["f-1"] }]);
    // ⚠️ Déjà posté ⇒ la réponse finale ne le réattache pas (il apparaîtrait deux fois).
    expect(p.fichiersRestants(["f-1"])).toEqual([]);
    expect(p.fichiersRestants(["f-1", "f-2"])).toEqual(["f-2"]);
  });
});

describe("échec d'outil — une ligne, déterministe", () => {
  it("publie UNE ligne par outil, même si l'échec est signalé deux fois", async () => {
    const trace = journal();
    const p = progress(trace.publier);
    p.terminerOutil({ tool: "generer_image", isError: true });
    p.terminerOutil({ tool: "generer_image", isError: true });
    await p.attendre();

    expect(trace.envoyes).toEqual([{ text: progressErrorText("generer_image") }]);
    expect(progressErrorText("generer_image")).toContain("generer_image");
  });

  it("un succès ne publie aucune ligne d'échec", async () => {
    const trace = journal();
    const p = progress(trace.publier);
    p.terminerOutil({ tool: "generer_image" });
    await p.attendre();
    expect(trace.envoyes).toEqual([]);
  });
});

describe("outil long — un rappel UNIQUE, publié PENDANT l'outil", () => {
  it("le rappel part AVANT la fin de l'outil (jamais après le travail)", async () => {
    // ⚠️ Défaut mesuré le 2026-11-02 13:38 : un message de progression publié À LA
    // FIN de l'action ne sert à rien. Le rappel est donc ARMÉ au démarrage.
    const trace = journal();
    const p = new ReplyProgress({
      publier: trace.publier,
      outils: OUTILS_DISTANTS,
      // Seuil abaissé : le test ne dure pas 90 s, mais la règle est la même.
      seuilRappelMs: 30,
    });
    let outilTermine = false;
    p.demarrerOutil({ tool: "lire_fichier" });
    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(outilTermine).toBe(false);
    // Le rappel est DÉJÀ parti alors que l'outil n'est pas terminé.
    expect(trace.envoyes.map((m) => m.text)).toContain(PROGRESS_LONG_TOOL_TEXT);
    p.terminerOutil({ tool: "lire_fichier" });
    outilTermine = true;
    await p.attendre();
    // …et il ne repart PAS à la fin (un seul par run).
    expect(trace.envoyes.filter((m) => m.text === PROGRESS_LONG_TOOL_TEXT)).toHaveLength(1);
  });

  it("un outil qui se termine AVANT le seuil ne déclenche AUCUN rappel", async () => {
    const trace = journal();
    const p = new ReplyProgress({
      publier: trace.publier,
      outils: OUTILS_DISTANTS,
      seuilRappelMs: 60_000,
    });
    p.demarrerOutil({ tool: "lire_fichier" });
    p.terminerOutil({ tool: "lire_fichier" });
    await p.attendre();
    // Le minuteur est DÉSARMÉ à la fin de l'outil : attendre ne produit rien.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await p.attendre();
    expect(trace.envoyes).toEqual([]);
  });

  it("le seuil par défaut est bien celui du run de canal (90 s)", () => {
    expect(PROGRESS_LONG_TOOL_MS).toBe(90_000);
  });
});

describe("publications — UNE seule en vol, et l'accusé passe devant la FILE", () => {
  it("jamais deux `send` simultanés, et l'accusé double la file sans doubler l'envoi en cours", async () => {
    // ⚠️ Défaut de production (2026-11-02) : « toujours deux messages qui arrivent en
    // même temps ». Deux `send` concurrents perdent l'ORDRE et l'ESPACEMENT ; l'accusé,
    // lui, doit passer DEVANT une publication qui attend (sinon il arrive après
    // l'action qu'il annonce) — mais JAMAIS devant un envoi déjà commencé.
    const journal: Array<{ cle: string; debut: number; fin: number }> = [];
    let enVol = 0;
    let maxEnVol = 0;
    const p = new ReplyProgress({
      publier: async (message) => {
        enVol += 1;
        maxEnVol = Math.max(maxEnVol, enVol);
        const debut = Date.now();
        // Une image (téléversement) est bien plus lente qu'une ligne de texte.
        await new Promise((resolve) => setTimeout(resolve, message.fichiers ? 120 : 20));
        const cle = message.fichiers !== undefined ? String(message.fichiers[0]) : message.text;
        journal.push({ cle, debut, fin: Date.now() });
        enVol -= 1;
      },
      outils: [...OUTILS_DISTANTS, "delegate"],
    });
    p.publierFichier("f-1"); // part tout de suite, LONG
    p.publierFichier("f-2"); // attend son tour
    // Le téléversement de f-1 est RÉELLEMENT en vol (sinon f-1 serait encore en file).
    await new Promise((resolve) => setTimeout(resolve, 20));
    // L'outil long démarre pendant ce téléversement : l'accusé arrive APRÈS f-2 dans
    // la file, et doit pourtant partir AVANT lui.
    p.demarrerOutil({ tool: "delegate", ackCandidat: "C'est parti." });

    await p.attendre();
    // ① Aucun chevauchement : au plus UNE publication en vol à la fois.
    expect(maxEnVol).toBe(1);
    // ② Ordre strict garanti (exclusivité) : f-1 en vol, puis l'accusé prioritaire,
    //    puis f-2 qui attendait.
    expect(journal.map((entree) => entree.cle)).toEqual(["f-1", "C'est parti.", "f-2"]);
    // ③ Les intervalles ne se recouvrent jamais (mesure directe).
    for (let index = 1; index < journal.length; index += 1) {
      expect(journal[index]!.debut).toBeGreaterThanOrEqual(journal[index - 1]!.fin);
    }
  });

  it("`attendre()` couvre AUSSI l'accusé immédiat (jamais orphelin à la clôture)", async () => {
    let parti = false;
    const p = new ReplyProgress({
      publier: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        parti = true;
      },
      outils: [...OUTILS_DISTANTS, "delegate"],
    });
    p.demarrerOutil({ tool: "delegate", ackCandidat: "Deux secondes." });
    // ⚠️ Sans cette attente, `cloturer()` suivrait immédiatement et la réponse finale
    // pourrait partir avant l'accusé.
    expect(parti).toBe(false);
    await p.attendre();
    expect(parti).toBe(true);
  });
});

describe("clôture — RIEN ne part après la réponse finale", () => {
  it("une publication tentée après `cloturer()` est refusée (jamais un accusé tardif)", async () => {
    const trace = journal();
    const p = progress(trace.publier);
    p.demarrerOutil({ tool: "generer_image", ackCandidat: "C'est parti." });
    await p.attendre();
    expect(trace.envoyes).toHaveLength(1);
    // ⚠️ La réponse finale est sur le point de partir : le run est clos.
    p.cloturer();
    // Un événement d'outil arrivé trop tard (nouvel appel, fichier produit) ne
    // publie PLUS RIEN : un ack après la réponse n'est plus un ack.
    p.demarrerOutil({ tool: "generer_image" });
    p.publierFichier("f".repeat(32));
    p.terminerOutil({ tool: "generer_image", isError: true });
    await p.attendre();
    expect(trace.envoyes).toHaveLength(1);
  });

  it("`cloturer()` ANNULE un rappel encore armé", async () => {
    const trace = journal();
    const p = new ReplyProgress({
      publier: trace.publier,
      outils: OUTILS_DISTANTS,
      seuilRappelMs: 20,
    });
    p.demarrerOutil({ tool: "lire_fichier" });
    p.cloturer();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await p.attendre();
    expect(trace.envoyes).toEqual([]);
  });
});

describe("plafond de résultats — 3 par run, le reste est dit", () => {
  it("au-delà de trois lignes, la ligne est omise et `resume()` l'annonce", async () => {
    const trace = journal();
    const p = progress(trace.publier);
    for (const outil of ["a", "b", "c", "d", "e"]) {
      p.terminerOutil({ tool: outil, isError: true });
    }
    await p.attendre();

    expect(trace.envoyes).toHaveLength(PROGRESS_MAX_RESULTS);
    expect(p.resultatsPublies).toBe(PROGRESS_MAX_RESULTS);
    expect(p.resultatsOmis).toBe(2);
    expect(p.resume()).toBe(PROGRESS_SUPPRESSED_TEXT);
  });

  it("sous le plafond, `resume()` ne rajoute RIEN (aucun bruit)", async () => {
    const trace = journal();
    const p = progress(trace.publier);
    p.terminerOutil({ tool: "a", isError: true });
    await p.attendre();
    expect(p.resume()).toBeUndefined();
  });
});

describe("ordre et retrait de l'accusé", () => {
  it("les publications partent dans l'ORDRE des événements (accusé puis image)", async () => {
    const trace = journal();
    const p = progress(trace.publier);
    p.demarrerOutil({ tool: "generer_image", ackCandidat: "Je m'en occupe." });
    p.publierFichier("f-1");
    p.terminerOutil({ tool: "generer_image", isError: true });
    await p.attendre();

    expect(trace.envoyes.map((m) => m.text)).toEqual([
      "Je m'en occupe.",
      PROGRESS_IMAGE_TEXT,
      progressErrorText("generer_image"),
    ]);
  });

  it("retire la ligne d'accusé du texte final, et SEULEMENT elle", async () => {
    const p = progress(journal().publier);
    p.demarrerOutil({ tool: "generer_image", ackCandidat: "Deux secondes." });
    await p.attendre();

    expect(p.retirerAck("Deux secondes.\n\nVoilà l'image.")).toBe("Voilà l'image.");
    // Texte différent ⇒ intact (c'est une réponse, pas un doublon).
    expect(p.retirerAck("Voilà l'image.")).toBe("Voilà l'image.");
    // Le tour ne disait QUE l'accusé.
    expect(p.retirerAck("Deux secondes.")).toBe("");
  });

  it("sans accusé publié, le texte final est INCHANGÉ", () => {
    const p = progress(journal().publier);
    expect(p.retirerAck("Deux secondes.\n\nVoilà.")).toBe("Deux secondes.\n\nVoilà.");
  });

  it("retire TOUTES les lignes d'accusé de tête (le modèle en écrit parfois deux)", async () => {
    // ⚠️ Production, 2026-11-02 15:50 : une seule bulle portait deux attentes.
    const p = progress(journal().publier, { outils: [...OUTILS_DISTANTS, "delegate"] });
    p.demarrerOutil({ tool: "delegate", ackCandidat: "Je prends ça en charge." });
    await p.attendre();

    expect(
      p.retirerAck(
        [
          "Je prends ça en charge.",
          "Je lance la mise à jour.",
          "C'est en route sur la PI5, par délégation : apt update puis montée de version complète.",
        ].join("\n"),
      ),
    ).toBe("C'est en route sur la PI5, par délégation : apt update puis montée de version complète.");
  });

  it("ne mange JAMAIS une ligne de contenu qui suit immédiatement l'accusé", async () => {
    const p = progress(journal().publier, { outils: [...OUTILS_DISTANTS, "delegate"] });
    p.demarrerOutil({ tool: "delegate", ackCandidat: "Deux secondes." });
    await p.attendre();

    // « Voilà l'image. » n'est pas une phrase d'attente : elle reste.
    expect(p.retirerAck("Deux secondes.\nVoilà l'image.")).toBe("Voilà l'image.");
    // Une ligne qui ANNONCE du détail (deux-points, chiffre) n'est pas un accusé.
    expect(p.retirerAck("Deux secondes.\nJ'ai trouvé 3 fichiers dans la conversation.")).toBe(
      "J'ai trouvé 3 fichiers dans la conversation.",
    );
  });

  it("un tour fait UNIQUEMENT d'attentes garde la dernière (jamais une réponse vide par excès de zèle)", async () => {
    const p = progress(journal().publier, { outils: [...OUTILS_DISTANTS, "delegate"] });
    p.demarrerOutil({ tool: "delegate", ackCandidat: "Je m'en occupe." });
    await p.attendre();

    // L'accusé publié est retiré ; la seconde attente reste, faute de corps derrière.
    expect(p.retirerAck("Je m'en occupe.\nJe lance la mise à jour.")).toBe("Je lance la mise à jour.");
  });

  it("une publication qui échoue n'interrompt pas la suite", async () => {
    const recus: string[] = [];
    const p = new ReplyProgress({
      publier: async (message) => {
        if (message.text === PROGRESS_IMAGE_TEXT) throw new Error("réseau");
        recus.push(message.text);
      },
      outils: ["generer_image"],
    });
    p.publierFichier("f-1");
    p.demarrerOutil({ tool: "generer_image", ackCandidat: "Ok." });
    await p.attendre();

    expect(recus).toEqual(["Ok."]);
  });
});

describe("journal — la SOURCE de l'accusé, jamais son texte", () => {
  it("journalise `modele` puis `repli`, sans recopier le texte de l'accusé", async () => {
    const lignes: Array<{ message: string; champs?: Record<string, unknown> }> = [];
    const logger = {
      info: (message: string, fields?: Record<string, unknown>): void => {
        lignes.push({ message, ...(fields !== undefined ? { champs: fields } : {}) });
      },
    };
    const a = new ReplyProgress({
      publier: async () => undefined,
      outils: [...OUTILS_DISTANTS],
      logger,
    });
    a.demarrerOutil({ tool: "generer_image", ackCandidat: "J'arrive, patron." });
    const b = new ReplyProgress({
      publier: async () => undefined,
      outils: [...OUTILS_DISTANTS],
      logger,
    });
    b.demarrerOutil({ tool: "generer_image" });
    await a.attendre();
    await b.attendre();

    // ⚠️ UNE ligne par accusé, avec son ORIGINE : c'est la mesure du taux de repli
    // en production (si `repli` domine, c'est la consigne du prompt qu'il faut durcir).
    expect(lignes.map((ligne) => ligne.message)).toEqual(["chat.progress.ack", "chat.progress.ack"]);
    expect(lignes[0]?.champs).toEqual({ tool: "generer_image", source: "modele" });
    expect(lignes[1]?.champs).toEqual({ tool: "generer_image", source: "repli" });
    // ⚠️ Le TEXTE de l'accusé n'est jamais journalisé (un accusé n'est pas un journal).
    expect(JSON.stringify(lignes)).not.toContain("J'arrive, patron.");
  });
});
