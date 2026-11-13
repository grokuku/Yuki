/**
 * LOT 36 (L5) — LES CANAUX D'UN BOT, ET « UN CANAL = UN BOT ».
 *
 * ⚠️ Ces tests ÉCHOUENT sur le code d'origine : `src/chat/canaux-bot.ts` n'existe
 * pas, il n'y a donc AUCUN moyen de tenir un miroir par bot ni de refuser un
 * canal déjà possédé — `canaux()` du port de publication lisait le miroir de
 * l'INSTANCE pour tous les bots (`src/index.ts`).
 *
 * Ce qui est verrouillé ici :
 *  ① un bot ne voit JAMAIS le miroir d'un autre (test central) ;
 *  ② un canal d'un autre bot, même présent dans son miroir, n'est pas proposé ;
 *  ③ un bot sans miroir ne propose RIEN (jamais les canaux de l'instance) ;
 *  ④ la revendication est persistée, atomique et relue au démarrage (0600) ;
 *  ⑤ le refus NOMME le propriétaire, et n'écrit rien ;
 *  ⑥ le port de publication refuse AVANT d'envoyer (aucun appel réseau) ;
 *  ⑦ la fabrique de miroirs n'est appelée qu'UNE fois par bot.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CanauxBots,
  FICHIER_PROPRIETAIRES_CANAUX,
  ProprietairesCanaux,
  cheminProprietairesCanaux,
  messageCanalAutreBot,
  type CanauxBotLogger,
  type ConversationMiroir,
  type MiroirCanaux,
} from "../../src/chat/canaux-bot.js";
import { createChannelPostPort } from "../../src/chat/reply/channel-post.js";

const racines: string[] = [];

afterEach(() => {
  for (const racine of racines.splice(0)) rmSync(racine, { recursive: true, force: true });
});

function racine(): string {
  const dossier = mkdtempSync(join(tmpdir(), "yuki-canaux-bot-"));
  racines.push(dossier);
  return dossier;
}

/** Journal de test : retient les lignes (aucune écriture disque). */
function journalEspion(): CanauxBotLogger & { lignes: string[] } {
  const lignes: string[] = [];
  return {
    lignes,
    info: (message) => lignes.push(message),
    warn: (message) => lignes.push(message),
  };
}

function miroir(conversations: readonly ConversationMiroir[]): MiroirCanaux {
  return { conversations: () => conversations };
}

const MM_A: ConversationMiroir = { id: "mm-a", title: "L'Imagerie", platform: "mattermost" };
const DC_C: ConversationMiroir = { id: "dc-c", title: "Salon", platform: "discord" };

describe("CanauxBots — un bot ne voit que SON miroir", () => {
  it("deux bots ⇒ deux listes disjointes (central)", () => {
    const canaux = new CanauxBots({
      botDuRun: "yuki",
      miroir: (botId) => (botId === "yuki" ? miroir([MM_A]) : miroir([DC_C])),
      proprietaires: ProprietairesCanaux.enMemoire(),
    });

    expect(canaux.canaux("yuki").map((canal) => canal.conversationId)).toEqual(["mm-a"]);
    expect(canaux.canaux("kohai").map((canal) => canal.conversationId)).toEqual(["dc-c"]);
  });

  it("un canal d'un AUTRE bot n'est jamais proposé, même présent dans le miroir", () => {
    const log = journalEspion();
    const proprietaires = ProprietairesCanaux.enMemoire({ "mm-a": "yuki" }, { logger: log });
    const canaux = new CanauxBots({
      botDuRun: "yuki",
      // Les DEUX miroirs prétendent voir `mm-a` (adaptateur mal configuré, copie).
      miroir: () => miroir([MM_A, DC_C]),
      proprietaires,
      logger: log,
    });

    expect(canaux.canaux("kohai").map((canal) => canal.conversationId)).toEqual(["dc-c"]);
    expect(log.lignes).toContain("chat.canal.autre_bot_ignore");
  });

  it("un bot SANS miroir ne propose RIEN (jamais ceux de l'instance)", () => {
    const canaux = new CanauxBots({
      botDuRun: "yuki",
      miroir: (botId) => (botId === "yuki" ? miroir([MM_A]) : undefined),
      proprietaires: ProprietairesCanaux.enMemoire(),
    });

    expect(canaux.canaux("fantome")).toEqual([]);
    expect(canaux.miroirDe("fantome")).toBeUndefined();
  });

  it("la fabrique de miroirs n'est appelée qu'UNE fois par bot", () => {
    const fabrique = vi.fn(() => miroir([MM_A]));
    const canaux = new CanauxBots({
      botDuRun: "yuki",
      miroir: fabrique,
      proprietaires: ProprietairesCanaux.enMemoire(),
    });

    canaux.canaux("kohai");
    canaux.canaux("kohai");
    canaux.miroirDe("kohai");

    expect(fabrique).toHaveBeenCalledTimes(1);
    expect(canaux.miroirsConstruits()).toEqual(["kohai"]);
  });
});

describe("« un canal = un bot »", () => {
  it("la première publication d'un bot revendique le canal, la seconde est refusée", () => {
    const log = journalEspion();
    const canaux = new CanauxBots({
      botDuRun: "yuki",
      miroir: () => miroir([MM_A]),
      proprietaires: ProprietairesCanaux.enMemoire({}, { logger: log }),
      logger: log,
    });

    expect(canaux.revendiquerEtAutoriser("yuki", "mm-a")).toEqual({ ok: true });
    const refus = canaux.revendiquerEtAutoriser("kohai", "mm-a");
    expect(refus.ok).toBe(false);
    if (refus.ok) return;
    expect(refus.raison).toContain("yuki");
    expect(refus.raison).toContain("mm-a");
    expect(log.lignes).toContain("chat.canal.refuse");
  });

  it("le refus NOMME le propriétaire et le canal (lisibilité)", () => {
    expect(messageCanalAutreBot("mm-a", "kohai", "Général")).toContain("kohai");
    expect(messageCanalAutreBot("mm-a", "kohai", "Général")).toContain("Général");
    expect(messageCanalAutreBot("mm-a", "kohai")).toContain("mm-a");
  });

  it("autoriser() ne réclame RIEN (contrôle en lecture seule)", () => {
    const proprietaires = ProprietairesCanaux.enMemoire();
    const canaux = new CanauxBots({
      botDuRun: "yuki",
      miroir: () => miroir([MM_A]),
      proprietaires,
    });

    expect(canaux.autoriser("yuki", "mm-a")).toEqual({ ok: true });
    expect(proprietaires.proprietaire("mm-a")).toBeUndefined();
  });

  it("rejouer la revendication du MÊME bot ne réécrit rien", () => {
    const log = journalEspion();
    const proprietaires = ProprietairesCanaux.enMemoire({}, { logger: log });
    expect(proprietaires.revendiquer("mm-a", "yuki")).toEqual({ ok: true, nouveau: true });
    expect(proprietaires.revendiquer("mm-a", "yuki")).toEqual({ ok: true, nouveau: false });
    expect(log.lignes.filter((ligne) => ligne === "chat.canal.proprietaire")).toHaveLength(1);
  });

  it("liberer() rend le canal à tous, et le dit", () => {
    const proprietaires = ProprietairesCanaux.enMemoire({ "mm-a": "yuki" });
    expect(proprietaires.canauxDe("yuki")).toEqual(["mm-a"]);
    expect(proprietaires.liberer("mm-a")).toBe(true);
    expect(proprietaires.liberer("mm-a")).toBe(false);
    expect(proprietaires.proprietaire("mm-a")).toBeUndefined();
  });

  it("oublier() le miroir d'un bot ne lui retire PAS ses canaux", () => {
    const proprietaires = ProprietairesCanaux.enMemoire({ "dc-c": "kohai" });
    const canaux = new CanauxBots({
      botDuRun: "yuki",
      miroir: () => miroir([DC_C]),
      proprietaires,
    });
    canaux.canaux("kohai");
    expect(canaux.oublier("kohai")).toBe(true);
    expect(canaux.miroirsConstruits()).toEqual([]);
    expect(proprietaires.canauxDe("kohai")).toEqual(["dc-c"]);
    // Le bot de la PILE garde son miroir : c'est celui de `main()`.
    expect(canaux.oublier("yuki")).toBe(false);
  });
});

describe("ProprietairesCanaux — persistance", () => {
  it("écrit un fichier 0600 et le RELIT au démarrage", () => {
    const stateDir = racine();
    const path = cheminProprietairesCanaux(stateDir);
    expect(path.endsWith(FICHIER_PROPRIETAIRES_CANAUX)).toBe(true);

    const premier = ProprietairesCanaux.open({ path });
    expect(premier.revendiquer("mm-a", "yuki")).toEqual({ ok: true, nouveau: true });
    expect(statSync(path).mode & 0o777).toBe(0o600);

    const second = ProprietairesCanaux.open({ path });
    expect(second.proprietaire("mm-a")).toBe("yuki");
    expect(second.revendiquer("mm-a", "kohai").ok).toBe(false);
  });

  it("un fichier ILLISIBLE ne bloque pas : vide + avertissement", () => {
    const stateDir = racine();
    const path = cheminProprietairesCanaux(stateDir);
    writeFileSync(path, "{ pas du json", "utf8");
    const log = journalEspion();
    const store = ProprietairesCanaux.open({ path, logger: log });

    expect(store.tout()).toEqual({});
    expect(log.lignes).toContain("chat.canaux.proprietaires.illisible");
  });

  it("une entrée non textuelle est ignorée (jamais un bot nommé par un objet)", () => {
    const stateDir = racine();
    const path = cheminProprietairesCanaux(stateDir);
    writeFileSync(
      path,
      JSON.stringify({ version: 1, canaux: { "mm-a": "yuki", "mm-b": 42, "mm-c": "" } }),
      "utf8",
    );
    const store = ProprietairesCanaux.open({ path });
    expect(store.tout()).toEqual({ "mm-a": "yuki" });
    expect(JSON.parse(readFileSync(path, "utf8")).canaux["mm-b"]).toBe(42);
  });
});

describe("port de publication — appartenance AVANT envoi", () => {
  function port(autoriser?: (conversationId: string) => { ok: true } | { ok: false; raison: string }) {
    const envoyer = vi.fn(async () => undefined);
    const port = createChannelPostPort({
      plateforme: "mattermost",
      canaux: () => [{ conversationId: "mm-a", titre: "L'Imagerie", plateforme: "mattermost" }],
      envoyer,
      ...(autoriser !== undefined ? { autoriser } : {}),
    });
    return { port, envoyer };
  }

  it("un canal d'un autre bot ⇒ refus qui le nomme, AUCUN envoi", async () => {
    const { port: canalPort, envoyer } = port((id) => ({
      ok: false,
      raison: messageCanalAutreBot(id, "kohai"),
    }));

    const issue = await canalPort.publier({ canal: "L'Imagerie", texte: "bonjour" });

    expect(issue.ok).toBe(false);
    if (issue.ok) return;
    expect(issue.raison).toContain("kohai");
    expect(envoyer).not.toHaveBeenCalled();
  });

  it("sans refus, la publication passe (non-régression du port)", async () => {
    const { port: canalPort, envoyer } = port();

    const issue = await canalPort.publier({ canal: "L'Imagerie", texte: "bonjour" });

    expect(issue.ok).toBe(true);
    expect(envoyer).toHaveBeenCalledTimes(1);
  });
});

describe("câblage de main() (garde statique — main() n'est jamais exécuté par les tests)", () => {
  const source = readFileSync(new URL("../../src/index.ts", import.meta.url), "utf8");

  it("le port de publication lit le miroir DU BOT, jamais celui de l'instance", () => {
    // ⚠️ `canaux: () => canauxBots?.canaux(botId)` : c'est la correction de la
    // fuite de L5 (le miroir de l'instance servait tous les bots).
    expect(source).toContain("canaux: () => canauxBots?.canaux(botId) ?? []");
    // Aucune fermeture de publication ne relit plus le miroir de l'instance.
    expect(source).not.toContain(
      "canaux: () =>\n        chatMirror.conversations()",
    );
  });

  it("la publication passe par l'appartenance AVANT l'envoi", () => {
    expect(source).toContain(
      "autoriser: (cible) =>\n        canauxBots?.revendiquerEtAutoriser(botId, cible) ?? { ok: true }",
    );
  });

  it("un envoi programmé est publié par le host DU BOT", () => {
    expect(source).toContain("const hostDuBot = (botId: string): PiHost | undefined =>");
    expect(source).toContain("publier: (input) => publierEnvoiProgramme(input, botId)");
    // Le host d'un bot secondaire n'a AUCUN repli vers le principal.
    expect(source).toContain("botId === botDuRun ? host : hostsBots?.pourDemarre(botId)");
  });

  it("chaque bot ouvre SON miroir ; celui de la pile est réutilisé", () => {
    expect(source).toContain("canauxBots = new CanauxBots({");
    expect(source).toContain("indexPath: envBot.chatMirrorPath");
    expect(source).toContain("if (botId === botDuRun) return chatMirror;");
  });
});
