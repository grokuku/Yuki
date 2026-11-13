/**
 * LOT 43 — « HORS LIGNE » : L'ADAPTATEUR DOIT ÊTRE CONSTRUIT POUR LE BOT AFFICHÉ.
 *
 * ⚠️ CONTEXTE (capture utilisateur) : `granolaf` apparaît **hors ligne** dans
 * l'application Discord, alors que son jeton `YUKI_CHAT_GRANOLAF__DISCORD` est au
 * coffre et que `chat.discord.enabled = on` pour lui. Le bandeau de la barre
 * latérale se contredisait (« jeton enregistré » ici, « aucun jeton » là) : cet
 * écart d'interface est corrigé côté page (`plateformes-bot-affiche.test.ts`).
 *
 * Reste LA question qui décide de la connexion réelle : `main()` construit-il un
 * adaptateur Discord pour un bot AUTRE que celui de la pile ? Ce fichier le
 * prouve sur les modules RÉELS (aucun service externe) :
 *  ① `resoudreJetonsChatBots` résout le jeton d'un bot SECONDAIRE ;
 *  ② `AdaptateursChatBots` CONSTRUIT son adaptateur et le connecte ;
 *  ③ le nom du secret est exactement celui que le panneau écrit
 *     (`YUKI_CHAT_GRANOLAF__DISCORD` : casse, `__`, majuscules) ;
 *  ④ ⚠️ RÉÉCRIT : il n'y a PLUS de « bot `actif` refusé par le plafond » (décision
 *     utilisateur du 2026-11-13 : « retire le plafond »). Trois bots actifs ⇒ TROIS
 *     démarrages, donc trois adaptateurs : être « hors ligne » ne peut plus venir
 *     que d'un échec de connexion, jamais d'une limite d'installation ;
 *  ⑤ un échec de connexion n'est jamais silencieux : il est journalisé par paire
 *     et remonté dans le bilan.
 *
 * ⚠️ Échoue sur le code d'origine : `nomSecretChatBot`/`nomSecretChat` ne sont pas
 * comparés ici, et le bilan des connexions n'était pas consommé au démarrage.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AdaptateursChatBots,
  cleAdaptateur,
  type AdaptateurChatDemarrable,
} from "../../src/chat/adaptateurs-bots.js";
import { nomSecretChat, resoudreJetonsChatBots } from "../../src/chat/jetons-bot.js";
import { nomSecretChatBot } from "../../public/ui/jetons-chat-bot.js";
import { resoudreDemarrageBots } from "../../src/bots/actifs.js";

/** Journal qui GARDE les traces : on vérifie que l'échec est dit, pas tu. */
function journal() {
  const lignes: { niveau: string; evenement: string; details?: unknown }[] = [];
  return {
    lignes,
    info: (evenement: string, details?: unknown) =>
      void lignes.push({ niveau: "info", evenement, details }),
    warn: (evenement: string, details?: unknown) =>
      void lignes.push({ niveau: "warn", evenement, details }),
  };
}

/** Coffre simulé : nom de secret → valeur. */
const coffre =
  (entrees: Record<string, string>) =>
  (nom: string): string | undefined =>
    entrees[nom];

/** Résolution + adaptateurs, comme `main()` les construit pour ses bots. */
function construireBots(options: {
  bots: string[];
  botDePile: string;
  jetons: Record<string, string>;
  actifs: { botId: string; plateforme: string }[];
  connecte?: (cle: string) => void;
}) {
  const crees: string[] = [];
  const logger = journal();
  const resolution = resoudreJetonsChatBots({
    bots: options.bots,
    lookup: coffre(options.jetons),
    active: (botId, plateforme) =>
      options.actifs.some(
        (paire) => paire.botId === botId && paire.plateforme === plateforme,
      ),
    logger,
  });
  const adaptateurs = new AdaptateursChatBots<AdaptateurChatDemarrable & { jeton?: string }>({
    botDePile: options.botDePile,
    resolution,
    creer: (jeton) => {
      const cle = cleAdaptateur(jeton.botId, jeton.plateforme);
      crees.push(cle);
      return {
        jeton: jeton.nom,
        connect: async () => {
          options.connecte?.(cle);
        },
        disconnect: async () => undefined,
      };
    },
    logger,
  });
  return { resolution, adaptateurs, crees, logger };
}

describe("① un bot SECONDAIRE dont le jeton existe et la plateforme est activée", () => {
  it("l'adaptateur Discord de `granolaf` EST construit (et son jeton est le sien)", () => {
    const { adaptateurs, crees, resolution } = construireBots({
      bots: ["yuki", "granolaf"],
      botDePile: "yuki",
      jetons: { YUKI_CHAT_GRANOLAF__DISCORD: "dc-granolaf" },
      actifs: [{ botId: "granolaf", plateforme: "discord" }],
    });

    // ① le jeton du bot secondaire est résolu...
    expect(resolution.jetons.get("granolaf")?.get("discord")?.nom).toBe(
      "YUKI_CHAT_GRANOLAF__DISCORD",
    );
    // ② ... et son adaptateur est CONSTRUIT (sans lui, le bot reste hors ligne).
    expect(crees).toEqual(["granolaf:discord"]);
    expect(adaptateurs.pour("granolaf", "discord")).toBeDefined();
    // Le bot de la pile n'a rien : son jeton n'existe pas.
    expect(adaptateurs.pour("yuki", "discord")).toBeUndefined();
  });

  it("la connexion est réellement TENTÉE pour ce bot (pas seulement construite)", async () => {
    const connectes: string[] = [];
    const { adaptateurs } = construireBots({
      bots: ["yuki", "granolaf"],
      botDePile: "yuki",
      jetons: { YUKI_CHAT_GRANOLAF__DISCORD: "dc-granolaf" },
      actifs: [{ botId: "granolaf", plateforme: "discord" }],
      connecte: (cle) => void connectes.push(cle),
    });

    const bilan = await adaptateurs.connecterTout({ sansPile: true });
    expect(connectes).toEqual(["granolaf:discord"]);
    expect(bilan.connectes).toEqual(["granolaf:discord"]);
    expect(adaptateurs.estConnecte("granolaf", "discord")).toBe(true);
  });

  it("③ le nom du secret est EXACTEMENT celui que le panneau écrit", () => {
    expect(nomSecretChat("granolaf", "discord")).toBe("YUKI_CHAT_GRANOLAF__DISCORD");
    expect(nomSecretChatBot("granolaf", "discord")).toBe(nomSecretChat("granolaf", "discord"));
    // Un slug à tirets : la règle est la même des deux côtés.
    expect(nomSecretChatBot("granolaf-bis", "mattermost")).toBe(
      nomSecretChat("granolaf-bis", "mattermost"),
    );
  });

  it("un bot dont la plateforme est ÉTEINTE n'a aucun adaptateur (le local reste)", () => {
    const { adaptateurs, crees } = construireBots({
      bots: ["yuki", "granolaf"],
      botDePile: "yuki",
      jetons: { YUKI_CHAT_GRANOLAF__DISCORD: "dc-granolaf" },
      actifs: [],
    });
    expect(crees).toEqual([]);
    expect(adaptateurs.pour("granolaf", "discord")).toBeUndefined();
  });
});

describe("④ ⚠️ plus de plafond : TOUS les bots actifs ont leur adaptateur", () => {
  it("trois bots actifs ⇒ trois démarrages, donc l'adaptateur de `granolaf` existe", () => {
    // ⚠️ RÉÉCRIT (n'était « le bot écarté n'a pas d'adaptateur, le refus est
    // nommé ») : sans plafond, plus aucun bot `actif` n'est écarté — donc plus
    // aucun « hors ligne » qui ne vienne pas d'une vraie erreur de connexion.
    const registre = {
      bot: "yuki",
      bots: [
        { id: "yuki", nom: "Yuki", capacites: [], actif: true, ordre: 0 },
        { id: "grolaf", nom: "Grolaf", capacites: [], actif: true, ordre: 1 },
        { id: "granolaf", nom: "Granolaf", capacites: [], actif: true, ordre: 2 },
      ],
    } as unknown as Parameters<typeof resoudreDemarrageBots>[0];
    const demarrage = resoudreDemarrageBots(registre);

    expect(demarrage.aDemarrer.map((bot) => bot.id)).toEqual(["yuki", "grolaf", "granolaf"]);
    const { crees } = construireBots({
      bots: demarrage.aDemarrer.map((bot) => bot.id),
      botDePile: "yuki",
      jetons: { YUKI_CHAT_GRANOLAF__DISCORD: "dc-granolaf" },
      actifs: [{ botId: "granolaf", plateforme: "discord" }],
    });
    // Le jeton de `granolaf` est bien résolu et son adaptateur construit.
    expect(crees).toEqual(["granolaf:discord"]);
  });
});

describe("⑤ un échec de connexion n'est jamais silencieux", () => {
  it("il est journalisé par paire et remonté dans le bilan", async () => {
    const logger = journal();
    const resolution = resoudreJetonsChatBots({
      bots: ["yuki", "granolaf"],
      lookup: coffre({ YUKI_CHAT_GRANOLAF__DISCORD: "dc-granolaf" }),
      active: (botId) => botId === "granolaf",
      logger,
    });
    const adaptateurs = new AdaptateursChatBots<AdaptateurChatDemarrable>({
      botDePile: "yuki",
      resolution,
      creer: () => ({
        connect: async () => {
          throw new Error("401 Unauthorized");
        },
        disconnect: async () => undefined,
      }),
      logger,
    });

    const bilan = await adaptateurs.connecterTout({ sansPile: true });
    expect(bilan.echecs).toEqual([{ cle: "granolaf:discord", error: "401 Unauthorized" }]);
    const trace = logger.lignes.find((ligne) => ligne.evenement === "chat.adaptateur.connect_failed");
    expect(trace?.niveau).toBe("warn");
    expect(JSON.stringify(trace?.details)).toContain("401 Unauthorized");
  });

  it("le DÉMARRAGE consomme le bilan (un démarrage à moitié raté ne passe pas inaperçu)", () => {
    const source = readFileSync(join(process.cwd(), "src", "index.ts"), "utf8");
    // ⚠️ GARDE : le bilan de `connecterTout` ne doit plus être jeté.
    expect(source).toContain("chat.adaptateurs.echecs");
    expect(source).toContain("bilanChat");
  });
});
