/**
 * UN SEUL ENVOI EN VOL PAR CONVERSATION — ordre garanti dans un canal.
 *
 * ⚠️ LE DÉFAUT QUE CE FICHIER VERROUILLE (production, 2026-11-02) : deux rédactions
 * simultanées (`REPLY_MAX_CONCURRENT` = 2, voulu) publiaient EN PARALLÈLE dans le même
 * canal. Deux `POST` en vol ⇒ ordre non garanti et, côté lecture, « deux messages qui
 * arrivent collés ». Le tour de Yuki peut publier trois choses (accusé, image, réponse) :
 * elles sortaient d'une file PAR RUN (`ReplyProgress`), mais rien ne les protégeait d'un
 * autre tour du MÊME canal.
 *
 * Ce que ce fichier prouve :
 *  1. deux envois d'une MÊME conversation ne se chevauchent jamais ;
 *  2. deux conversations DIFFÉRENTES restent parallèles (aucun verrou global) ;
 *  3. un envoi en ÉCHEC ne bloque pas la conversation (l'erreur remonte à SON appelant) ;
 *  4. la RÉPONSE FINALE est ordonnée derrière les messages intermédiaires (jamais
 *     d'accusé qui arrive après la réponse).
 *
 * ⚠️ Échoue sur le code d'origine : aucun adaptateur ne sérialisait les envois, et
 * `ConversationSendQueue` n'existait pas.
 */

import { describe, expect, it } from "vitest";

import { ConversationSendQueue } from "../../src/chat/index.js";

const CANAL = "mm-canal-1";
const AUTRE = "mm-canal-2";

interface Trace {
  nom: string;
  debut: number;
  fin?: number;
}

/** Tâche LENTE qui mesure son intervalle [début, fin]. */
function tacheLente(traces: Trace[], nom: string, echec = false) {
  return async (): Promise<string> => {
    const trace: Trace = { nom, debut: Date.now() };
    traces.push(trace);
    await new Promise((resolve) => setTimeout(resolve, 15));
    trace.fin = Date.now();
    if (echec) throw new Error(`envoi ${nom} refusé`);
    return nom;
  };
}

const attendre = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 80));

describe("file d'envoi par conversation", () => {
  it("deux envois du MÊME canal ne se chevauchent jamais", async () => {
    const file = new ConversationSendQueue();
    const traces: Trace[] = [];

    const premier = file.run(CANAL, tacheLente(traces, "accusé"));
    const second = file.run(CANAL, tacheLente(traces, "réponse"));
    await Promise.all([premier, second]);

    expect(traces.map((trace) => trace.nom)).toEqual(["accusé", "réponse"]);
    // ⚠️ Aucun recouvrement : le second commence APRÈS la fin du premier.
    expect(traces[1]!.debut).toBeGreaterThanOrEqual(traces[0]!.fin as number);
  });

  it("deux CANAUX différents restent parallèles (aucun verrou global)", async () => {
    const file = new ConversationSendQueue();
    const traces: Trace[] = [];

    await Promise.all([
      file.run(CANAL, tacheLente(traces, "canal-1")),
      file.run(AUTRE, tacheLente(traces, "canal-2")),
    ]);

    const [premier, second] = traces;
    // Les deux intervalles SE RECOUVRENT : la sérialisation est par conversation.
    expect(second!.debut).toBeLessThan(premier!.fin as number);
  });

  it("un envoi en échec ne bloque pas la conversation, et l'erreur reste VISIBLE", async () => {
    const file = new ConversationSendQueue();
    const traces: Trace[] = [];

    const echec = file.run(CANAL, tacheLente(traces, "refusé", true));
    const suivant = file.run(CANAL, tacheLente(traces, "suivant"));

    // ⚠️ L'erreur remonte à SON appelant (un échec d'envoi reste un échec visible).
    await expect(echec).rejects.toThrow("envoi refusé");
    await expect(suivant).resolves.toBe("suivant");
    expect(traces.map((trace) => trace.nom)).toEqual(["refusé", "suivant"]);
  });

  it("la RÉPONSE FINALE est ordonnée derrière les messages intermédiaires", async () => {
    const file = new ConversationSendQueue();
    const ordre: string[] = [];

    // Un tour : accusé (lancé sans attente), image, puis réponse finale attendue.
    void file.run(CANAL, async () => {
      ordre.push("accusé");
    });
    void file.run(CANAL, async () => {
      ordre.push("image");
    });
    await file.run(CANAL, async () => {
      ordre.push("réponse");
    });
    await attendre();

    expect(ordre).toEqual(["accusé", "image", "réponse"]);
  });
});
