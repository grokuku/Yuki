/**
 * LOT 36 (L10) — UN JETON ET UN ADAPTATEUR DE PLATEFORME PAR BOT.
 *
 * ⚠️ Ces tests ÉCHOUENT sur le code d'origine : `src/chat/jetons-bot.ts` et
 * `src/chat/adaptateurs-bots.ts` n'existent pas. Le jeton est UNIQUE
 * (`YUKI_CHAT_MATTERMOST` / `YUKI_CHAT_DISCORD`) et le registre d'adaptateurs
 * est mono-instance : deux bots ne peuvent pas être connectés en même temps.
 *
 * Ce qui est verrouillé ici :
 *  ① deux bots ⇒ deux jetons DISTINCTS (`YUKI_CHAT_<BOT>__<PLATEFORME>`) ;
 *  ② le bot `yuki` accepte encore l'ancien nom (installations existantes) ;
 *  ③ MÊME jeton pour deux bots ⇒ refus qui NOMME les deux, et AUCUNE connexion ;
 *  ④ un bot `mattermost` et un bot `local` (sans jeton) coexistent : le second
 *    n'a simplement pas d'adaptateur ;
 *  ⑤ un adaptateur par (bot, plateforme), connecté/déconnecté PAR BOT ;
 *  ⑥ résolution du bot PAR LE JETON reçu (comme les webhooks de sources).
 *
 * ⚠️ Aucun vrai service externe n'est joint : les adaptateurs sont des FIXTURES.
 * Le branchement réel (Mattermost/Discord) est le même code, avec leurs clients.
 */

import { describe, expect, it, vi } from "vitest";

import {
  AdaptateursChatBots,
  cleAdaptateur,
  type AdaptateursChatLogger,
  type AdaptateurChatDemarrable,
} from "../../src/chat/adaptateurs-bots.js";
import {
  botDuJetonChat,
  messageJetonPartage,
  nomSecretChat,
  nomsSecretsChat,
  resoudreJetonsChatBots,
  type ResolutionJetonsChat,
} from "../../src/chat/jetons-bot.js";

function journalEspion(): AdaptateursChatLogger & { lignes: string[] } {
  const lignes: string[] = [];
  const noter = (message: string, fields?: Record<string, unknown>): void => {
    lignes.push(`${message}:${JSON.stringify(fields ?? {})}`);
  };
  return { lignes, info: noter, warn: noter };
}

/** Coffre FACTICE : noms → valeurs (aucune écriture disque). */
function coffre(entrees: Record<string, string>) {
  return (nom: string): string | undefined => entrees[nom];
}

/** Adaptateur FACTICE : note sa connexion, et peut échouer si demandé. */
function adaptateurFactice(
  botId: string,
  plateforme: string,
  journal: string[],
): AdaptateurChatDemarrable & { paire: string } {
  return {
    paire: cleAdaptateur(botId, plateforme as never),
    connect: async () => void journal.push(`connect:${botId}:${plateforme}`),
    disconnect: async () => void journal.push(`disconnect:${botId}:${plateforme}`),
  };
}

describe("① noms de jetons par bot", () => {
  it("`YUKI_CHAT_<BOT>__<PLATEFORME>`, en majuscules", () => {
    expect(nomSecretChat("yuki", "mattermost")).toBe("YUKI_CHAT_YUKI__MATTERMOST");
    expect(nomSecretChat("kohai", "discord")).toBe("YUKI_CHAT_KOHAI__DISCORD");
    expect(nomSecretChat("mon-bot", "mattermost")).toBe("YUKI_CHAT_MON_BOT__MATTERMOST");
  });

  it("le bot `yuki` accepte EN PLUS l'ancien nom ; les autres non", () => {
    expect(nomsSecretsChat("yuki", "mattermost")).toEqual([
      "YUKI_CHAT_YUKI__MATTERMOST",
      "YUKI_CHAT_MATTERMOST",
    ]);
    expect(nomsSecretsChat("kohai", "mattermost")).toEqual(["YUKI_CHAT_KOHAI__MATTERMOST"]);
  });

  it("deux bots ⇒ deux jetons DISTINCTS", () => {
    const resolution = resoudreJetonsChatBots({
      bots: ["yuki", "kohai"],
      lookup: coffre({
        YUKI_CHAT_YUKI__MATTERMOST: "jeton-yuki",
        YUKI_CHAT_KOHAI__MATTERMOST: "jeton-kohai",
      }),
      logger: journalEspion(),
    });

    expect(resolution.conflits).toEqual([]);
    expect(resolution.jetons.get("yuki")?.get("mattermost")?.nom).toBe(
      "YUKI_CHAT_YUKI__MATTERMOST",
    );
    expect(resolution.jetons.get("kohai")?.get("mattermost")?.nom).toBe(
      "YUKI_CHAT_KOHAI__MATTERMOST",
    );
  });

  it("un bot `mattermost` et un bot `local` (sans jeton) COEXISTENT", () => {
    const resolution = resoudreJetonsChatBots({
      bots: ["yuki", "kohai"],
      lookup: coffre({ YUKI_CHAT_YUKI__MATTERMOST: "jeton-yuki" }),
      logger: journalEspion(),
    });

    expect(resolution.jetons.get("yuki")?.has("mattermost")).toBe(true);
    // `kohai` n'a aucun jeton : il reste en local, sans adaptateur.
    expect(resolution.jetons.get("kohai")).toBeUndefined();
    expect(resolution.conflits).toEqual([]);
  });
});

describe("② MÊME jeton pour deux bots ⇒ refus nommant les deux", () => {
  it("détecte le conflit sur la VALEUR, même sous deux noms différents", () => {
    const log = journalEspion();
    const resolution = resoudreJetonsChatBots({
      bots: ["yuki", "kohai"],
      lookup: coffre({
        YUKI_CHAT_YUKI__DISCORD: "jeton-partage",
        YUKI_CHAT_KOHAI__DISCORD: "jeton-partage",
      }),
      logger: log,
    });

    expect(resolution.conflits).toHaveLength(1);
    const conflit = resolution.conflits[0]!;
    expect(conflit.plateforme).toBe("discord");
    expect([...conflit.bots]).toEqual(["yuki", "kohai"]);
    expect(conflit.raison).toContain("yuki");
    expect(conflit.raison).toContain("kohai");
    // AUCUN des deux ne se connecte (choisir serait arbitraire).
    expect(resolution.jetons.size).toBe(0);
    expect(log.lignes.some((ligne) => ligne.startsWith("chat.jetons.conflit"))).toBe(true);
  });

  it("le message de refus NOMME les deux jetons attendus", () => {
    const message = messageJetonPartage("mattermost", ["yuki", "kohai"]);
    expect(message).toContain("YUKI_CHAT_YUKI__MATTERMOST");
    expect(message).toContain("YUKI_CHAT_KOHAI__MATTERMOST");
    expect(message).toContain("DEUX FOIS");
  });

  it("un jeton HISTORIQUE partagé est un conflit aussi (yuki + kohai)", () => {
    const resolution = resoudreJetonsChatBots({
      bots: ["yuki", "kohai"],
      lookup: coffre({
        // `yuki` résout d'abord son nom propre, absent ⇒ l'historique.
        YUKI_CHAT_MATTERMOST: "jeton-historique",
        YUKI_CHAT_KOHAI__MATTERMOST: "jeton-historique",
      }),
      logger: journalEspion(),
    });
    expect(resolution.conflits).toHaveLength(1);
    expect(resolution.jetons.size).toBe(0);
  });
});

describe("③ adaptateurs par bot — connectés et arrêtés PAR BOT", () => {
  function banc(options: { avecPileExistante?: boolean } = {}) {
    const journal: string[] = [];
    const log = journalEspion();
    const creer = vi.fn((jeton: { botId: string; plateforme: string }) =>
      adaptateurFactice(jeton.botId, jeton.plateforme, journal),
    );
    const resolution: ResolutionJetonsChat = resoudreJetonsChatBots({
      bots: ["yuki", "kohai", "muet"],
      lookup: coffre({
        YUKI_CHAT_YUKI__MATTERMOST: "jeton-yuki",
        YUKI_CHAT_KOHAI__MATTERMOST: "jeton-kohai",
        YUKI_CHAT_KOHAI__DISCORD: "jeton-kohai-discord",
      }),
      logger: log,
    });
    const existants = new Map<string, AdaptateurChatDemarrable>();
    if (options.avecPileExistante === true) {
      existants.set(
        cleAdaptateur("yuki", "mattermost"),
        adaptateurFactice("yuki", "mattermost", journal),
      );
    }
    const adaptateurs = new AdaptateursChatBots({
      botDePile: "yuki",
      resolution,
      ...(existants.size > 0 ? { existants } : {}),
      creer,
      logger: log,
    });
    return { adaptateurs, journal, creer, log };
  }

  it("un adaptateur par (bot, plateforme) ; le bot sans jeton n'en a AUCUN", () => {
    const b = banc();
    expect(b.adaptateurs.pour("kohai", "mattermost")).toBeDefined();
    expect(b.adaptateurs.pour("kohai", "discord")).toBeDefined();
    expect(b.adaptateurs.pour("muet", "mattermost")).toBeUndefined();
    expect(b.adaptateurs.paires()).toHaveLength(3);
  });

  it("l'adaptateur du bot de la PILE est celui d'avant (identité)", () => {
    const journal: string[] = [];
    const log = journalEspion();
    const resolution = resoudreJetonsChatBots({
      bots: ["yuki"],
      lookup: coffre({ YUKI_CHAT_YUKI__MATTERMOST: "jeton-yuki" }),
      logger: log,
    });
    const existant = adaptateurFactice("yuki", "mattermost", journal);
    const creer = vi.fn(() => adaptateurFactice("yuki", "mattermost", journal));

    const adaptateurs = new AdaptateursChatBots({
      botDePile: "yuki",
      resolution,
      existants: new Map([[cleAdaptateur("yuki", "mattermost"), existant]]),
      creer,
      logger: log,
    });

    expect(adaptateurs.pour("yuki", "mattermost")).toBe(existant);
    expect(creer).not.toHaveBeenCalled();
  });

  it("connecterTout ne connecte chaque paire qu'UNE fois, sauf la pile si demandé", async () => {
    const b = banc();
    await b.adaptateurs.connecterTout({ sansPile: true });
    expect(b.journal.filter((ligne) => ligne.startsWith("connect:"))).toEqual([
      "connect:kohai:mattermost",
      "connect:kohai:discord",
    ]);
    // Deuxième passage : rien de neuf pour `kohai` (déjà connecté).
    const second = await b.adaptateurs.connecterBot("kohai");
    expect(second.connectes).toEqual([]);
  });

  it("deconnecterBot(kohai) ne touche PAS le bot principal", async () => {
    const b = banc();
    await b.adaptateurs.connecterTout();
    await b.adaptateurs.deconnecterBot("kohai");

    expect(b.adaptateurs.estConnecte("kohai", "mattermost")).toBe(false);
    expect(b.adaptateurs.estConnecte("yuki", "mattermost")).toBe(true);
    expect(await b.adaptateurs.deconnecterBot("yuki")).toBe(false);
  });

  it("un échec de connexion d'un bot n'empêche PAS les autres", async () => {
    const journal: string[] = [];
    const log = journalEspion();
    const resolution = resoudreJetonsChatBots({
      bots: ["kohai", "autre"],
      lookup: coffre({
        YUKI_CHAT_KOHAI__MATTERMOST: "j1",
        YUKI_CHAT_AUTRE__MATTERMOST: "j2",
      }),
      logger: log,
    });
    const adaptateurs = new AdaptateursChatBots({
      botDePile: "yuki",
      resolution,
      creer: (jeton) =>
        jeton.botId === "kohai"
          ? {
              connect: async () => {
                throw new Error("réseau indisponible");
              },
              disconnect: async () => undefined,
            }
          : adaptateurFactice(jeton.botId, jeton.plateforme, journal),
      logger: log,
    });

    const bilan = await adaptateurs.connecterTout();

    expect(bilan.echecs).toHaveLength(1);
    expect(bilan.connectes).toEqual([cleAdaptateur("autre", "mattermost")]);
    expect(log.lignes.some((ligne) => ligne.startsWith("chat.adaptateur.connect_failed"))).toBe(
      true,
    );
  });
});

describe("④ résolution du bot PAR LE JETON reçu", () => {
  const lookup = coffre({
    YUKI_CHAT_YUKI__MATTERMOST: "jeton-yuki",
    YUKI_CHAT_KOHAI__MATTERMOST: "jeton-kohai",
  });
  const resolution = resoudreJetonsChatBots({
    bots: ["yuki", "kohai"],
    lookup,
    logger: journalEspion(),
  });

  it("le jeton reçu désigne SON bot", () => {
    expect(botDuJetonChat({ resolution, plateforme: "mattermost", valeur: "jeton-kohai", lookup })).toBe(
      "kohai",
    );
    expect(botDuJetonChat({ resolution, plateforme: "mattermost", valeur: "jeton-yuki", lookup })).toBe(
      "yuki",
    );
  });

  it("un jeton inconnu, vide ou d'une autre plateforme ne désigne PERSONNE", () => {
    expect(botDuJetonChat({ resolution, plateforme: "mattermost", valeur: "inconnu", lookup })).toBeUndefined();
    expect(botDuJetonChat({ resolution, plateforme: "mattermost", valeur: "  ", lookup })).toBeUndefined();
    expect(botDuJetonChat({ resolution, plateforme: "mattermost", valeur: undefined, lookup })).toBeUndefined();
    expect(botDuJetonChat({ resolution, plateforme: "discord", valeur: "jeton-yuki", lookup })).toBeUndefined();
  });

  it("un bot en CONFLIT ne revendique aucun jeton", () => {
    const conflit = resoudreJetonsChatBots({
      bots: ["yuki", "kohai"],
      lookup: coffre({
        YUKI_CHAT_YUKI__MATTERMOST: "meme",
        YUKI_CHAT_KOHAI__MATTERMOST: "meme",
      }),
      logger: journalEspion(),
    });
    expect(
      botDuJetonChat({ resolution: conflit, plateforme: "mattermost", valeur: "meme", lookup }),
    ).toBeUndefined();
  });
});
