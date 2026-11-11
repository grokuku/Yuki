/**
 * LOT 36 (L9) — ARRÊT CIBLÉ D'UN BOT : idempotent, isolé, complet.
 *
 * ⚠️ Ces tests ÉCHOUENT sur le code d'origine : `src/bots/arret.ts` n'existe pas
 * et `main()` n'a qu'un arrêt GLOBAL (`beforeClose`) — aucun moyen d'arrêter UN
 * bot sans toucher aux autres.
 *
 * Ce qui est verrouillé ici :
 *  ① l'ORDRE des étapes (run → sources → host → mémoire → pile → tts → plateforme) ;
 *  ② IDEMPOTENT : déjà arrêté ⇒ aucune étape appelée ;
 *  ③ ISOLÉ : seules les étapes du bot demandé sont appelées (aucune étape d'un
 *    autre bot, aucun arrêt global) ;
 *  ④ un échec n'interrompt PAS les étapes suivantes, et le bilan le NOMME.
 */

import { describe, expect, it, vi } from "vitest";

import {
  ETAPES_ARRET,
  arreterBotProprement,
  type ArretBotLogger,
  type EtapesArretBot,
} from "../../src/bots/arret.js";

function journalEspion(): ArretBotLogger & { lignes: string[] } {
  const lignes: string[] = [];
  const noter = (message: string): void => {
    lignes.push(message);
  };
  return { lignes, info: noter, warn: noter };
}

/** Étapes espionnes : chacune note son nom dans l'ordre d'exécution. */
function etapesEspionnees(appels: string[], options: { echec?: string } = {}): EtapesArretBot {
  const etape = (nom: string) => async (): Promise<void> => {
    appels.push(nom);
    if (options.echec === nom) throw new Error(`${nom} cassé`);
  };
  return {
    run: etape("run"),
    sources: etape("sources"),
    host: etape("host"),
    memory: etape("memory"),
    pile: etape("pile"),
    tts: etape("tts"),
    plateforme: etape("plateforme"),
  };
}

describe("arreterBotProprement", () => {
  it("exécute les étapes dans l'ORDRE de fermeture sûre", async () => {
    const appels: string[] = [];
    const bilan = await arreterBotProprement({
      botId: "kohai",
      etapes: etapesEspionnees(appels),
      logger: journalEspion(),
    });

    expect(appels).toEqual([...ETAPES_ARRET]);
    expect(bilan.ok).toBe(true);
    expect(bilan.etapes).toEqual([...ETAPES_ARRET]);
    expect(bilan.dejaArrete).toBe(false);
  });

  it("déjà arrêté ⇒ AUCUNE étape appelée (idempotent)", async () => {
    const appels: string[] = [];
    const log = journalEspion();
    const bilan = await arreterBotProprement({
      botId: "kohai",
      dejaArrete: true,
      etapes: etapesEspionnees(appels),
      logger: log,
    });

    expect(appels).toEqual([]);
    expect(bilan).toEqual({ botId: "kohai", dejaArrete: true, etapes: [], echecs: [], ok: true });
    expect(log.lignes).toContain("bots.arret.deja_arrete");
  });

  it("ne touche QUE le bot demandé (aucune étape d'un autre bot)", async () => {
    const parBot = new Map<string, string[]>();
    const etapesPour = (botId: string): EtapesArretBot => {
      const appels: string[] = [];
      parBot.set(botId, appels);
      return etapesEspionnees(appels);
    };

    await arreterBotProprement({ botId: "kohai", etapes: etapesPour("kohai") });

    expect(parBot.get("kohai")).toEqual([...ETAPES_ARRET]);
    expect(parBot.size).toBe(1);
  });

  it("un échec n'interrompt PAS les étapes suivantes, et le bilan le NOMME", async () => {
    const appels: string[] = [];
    const log = journalEspion();
    const bilan = await arreterBotProprement({
      botId: "kohai",
      etapes: etapesEspionnees(appels, { echec: "host" }),
      logger: log,
    });

    // Le host a échoué, mais mémoire/pile/tts/plateforme ont été tentées.
    expect(appels).toEqual([...ETAPES_ARRET]);
    expect(bilan.ok).toBe(false);
    expect(bilan.echecs).toEqual([{ etape: "host", error: "host cassé" }]);
    expect(bilan.etapes).not.toContain("host");
    expect(log.lignes).toContain("bots.arret.etape_echouee");
    expect(log.lignes).toContain("bots.arret.incomplet");
  });

  it("une étape absente n'est pas comptée comme exécutée", async () => {
    const appels: string[] = [];
    const bilan = await arreterBotProprement({
      botId: "yuki",
      etapes: { host: async () => void appels.push("host") },
    });

    expect(appels).toEqual(["host"]);
    expect(bilan.etapes).toEqual(["host"]);
    expect(bilan.ok).toBe(true);
  });
});

describe("arret — aucune écriture implicite", () => {
  it("les étapes ne sont PAS appelées deux fois sur un double arrêt", async () => {
    const appels: string[] = [];
    const etapes = etapesEspionnees(appels);
    await arreterBotProprement({ botId: "kohai", etapes });
    const second = await arreterBotProprement({ botId: "kohai", dejaArrete: true, etapes });
    expect(appels).toHaveLength(ETAPES_ARRET.length);
    expect(second.dejaArrete).toBe(true);
  });

  it("une étape qui LÈVE n'écrit pas dans le bilan des étapes faites", async () => {
    const faites = vi.fn(async () => undefined);
    const bilan = await arreterBotProprement({
      botId: "kohai",
      etapes: {
        run: faites,
        host: () => {
          throw new Error("boom");
        },
      },
    });
    expect(faites).toHaveBeenCalledTimes(1);
    expect(bilan.etapes).toEqual(["run"]);
    expect(bilan.echecs.map((echec) => echec.etape)).toEqual(["host"]);
  });
});
