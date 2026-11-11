/**
 * LOT 35j — DÉCLENCHEURS, ENVOIS ET PRÉ-AUTORISATIONS **PAR BOT**.
 *
 * ⚠️ Ces tests ÉCHOUENT sur le code d'origine : `src/sources/par-bot.ts`
 * n'existe pas (`nomSecretSource`, `SourcesParBot`, `portPreAutorisations`…
 * import introuvable) et `SourcesService` n'accepte pas `secretNames` — le nom du
 * secret désignait la source SANS dire à quel bot elle appartenait.
 *
 * Ce qui est VERROUILLÉ ici :
 *  ① le JETON décide : celui du bot A ne réveille JAMAIS une source du bot B
 *    (deux bots peuvent déclarer le même nom `news` sans se réveiller l'un
 *    l'autre) ;
 *  ② l'ancien format `YUKI_SOURCE_<NOM>` reste résolu — POUR `yuki` seulement
 *    (les webhooks déjà distribués continuent de fonctionner, et un jeton
 *    historique ne peut pas réveiller un autre bot) ;
 *  ③ bot INACTIF ⇒ refus 403 qui NOMME le bot (jamais un silence) ;
 *  ④ nom inconnu CHEZ CE BOT ⇒ 404 qui NOMME le bot ;
 *  ⑤ un bot SANS capacité pertinente (`workerLourdAutorise`) ne figure pas dans
 *    les cibles du balayeur : ses sources ne tirent pas ;
 *  ⑥ aucune consommation CROISÉE de pré-autorisation (le bot vient du run, jamais
 *    d'une demande) et la portée agent est filtrée par `AgentRecord.bots` ;
 *  ⑦ le nom de secret est UNIQUE PAR BOT (`YUKI_SOURCE_<BOT>__<NOM>`).
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadEnv, type Env } from "../../src/config/env.js";
import { agentAutorisePourBot } from "../../src/agents/types.js";
import { PreAutorisationStore } from "../../src/agents/preautorisations.js";
import { cheminsBot, pathsForBot } from "../../src/bots/paths.js";
import { CAPACITES_BOT, type BotRecord, type RegistreBots } from "../../src/bots/registry.js";
import { handleSourcesRequest } from "../../src/gateway/routes/sources.js";
import { SourcesInbox } from "../../src/sources/inbox.js";
import { DeclencheurJournal } from "../../src/sources/journal.js";
import {
  SEPARATEUR_SECRET_BOT,
  SourcesParBot,
  SourcesParBotError,
  filtreAgentVisible,
  nomSecretSource,
  nomsSecretsSource,
  portPreAutorisations,
  type ModeBots,
  type PileSourcesBot,
} from "../../src/sources/par-bot.js";
import { SourceApiError, SourcesService, type SourcesTokenVault } from "../../src/sources/service.js";
import { SourcesStore } from "../../src/sources/store.js";

const racines: string[] = [];

afterEach(() => {
  for (const racine of racines.splice(0)) rmSync(racine, { recursive: true, force: true });
});

// ── Doubles ────────────────────────────────────────────────────────────────

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** Coffre en mémoire (aucun chiffrement : ce n'est pas ce qui est testé ici). */
class FakeVault implements SourcesTokenVault {
  readonly entries = new Map<string, string>();
  isConfigured(): boolean {
    return true;
  }
  lookup(name: string): string | undefined {
    return this.entries.get(name);
  }
  has(name: string): boolean {
    return this.entries.has(name);
  }
  set(name: string, value: string): unknown {
    this.entries.set(name, value);
    return { name };
  }
  delete(name: string): boolean {
    return this.entries.delete(name);
  }
}

function bot(id: string, actif: boolean, capacites: BotRecord["capacites"]): BotRecord {
  return {
    id,
    nom: id,
    capacites,
    actif,
    ordre: 0,
    creeLe: "2026-11-10T00:00:00.000Z",
    plateformes: {},
  };
}

/** Annuaire d'agents minimal (seul `bots` compte pour la visibilité par bot). */
class FakeAnnuaire {
  readonly records = new Map<string, { bots: string[] }>();
  get(agentId: string): { bots: string[] } | undefined {
    return this.records.get(agentId);
  }
}

interface Harnais {
  envInstance: Env;
  vault: FakeVault;
  annuaire: FakeAnnuaire;
  parBot: SourcesParBot;
  /** Pile telle que la fabrique l'a construite (jamais deux fois le même bot). */
  pile: (botId: string) => PileSourcesBot;
  /** Crée une source chez un bot, avec SON jeton (nom PROPRE AU BOT). */
  declare: (botId: string, nom: string, jeton: string) => void;
}

/**
 * Construit `SourcesParBot` comme le fait `src/index.ts` : une seule fabrique,
 * un `Env` résolu par bot (`pathsForBot`), et le nom de secret PAR BOT.
 */
function harnais(options: { bots: BotRecord[]; mode?: ModeBots } = { bots: [] }): Harnais {
  const racine = mkdtempSync(join(tmpdir(), "yuki-par-bot-"));
  racines.push(racine);
  const state = join(racine, "state");
  const envInstance = loadEnv({
    YUKI_MOUNT_STATE: state,
    YUKI_MOUNT_PI_AGENT: join(racine, "pi"),
    YUKI_LOG_LEVEL: "error",
  });
  const registre: RegistreBots = {
    schemaVersion: 1,
    majLe: "2026-11-10T00:00:00.000Z",
    botActif: options.bots.find((entree) => entree.actif)?.id ?? "yuki",
    bots: options.bots,
    echanges: {},
  } as RegistreBots;
  const vault = new FakeVault();
  const annuaire = new FakeAnnuaire();
  const mode = options.mode ?? "multi";
  const parBot = new SourcesParBot({
    envInstance,
    mode,
    registre: () => registre,
    coffre: vault,
    logger,
  });
  parBot.setOuvrir((input) => {
    const envBot = pathsForBot(input.env, input.botId).env;
    const store = new SourcesStore({ path: envBot.sourcesStorePath, logger });
    const inbox = new SourcesInbox({ path: envBot.sourcesInboxPath, logger });
    const journal = DeclencheurJournal.open({ path: envBot.declencheursJournalPath, logger });
    const preAutorisations = new PreAutorisationStore({
      path: envBot.preAutorisationsPath,
      logger,
      journal,
      botId: input.botId,
      agentAutorise: filtreAgentVisible(annuaire, input.botId, agentAutorisePourBot),
    });
    const service = new SourcesService({
      store,
      inbox,
      journal,
      logger,
      tokens: vault,
      secretNames: (nom) => nomsSecretsSource(input.botId, nom),
      promptTotalChars: () => 4_000,
    });
    return {
      botId: input.botId,
      env: envBot,
      store,
      inbox,
      journal,
      preAutorisations,
      service,
      fermer: () => service.detach(),
    };
  });
  return {
    envInstance,
    vault,
    annuaire,
    parBot,
    pile: (botId) => parBot.pourBot(botId),
    declare: (botId, nom, jeton) => {
      parBot.pourBot(botId).service.create(nom, { tour: "stocker" });
      vault.set(nomSecretSource(botId, nom), jeton);
    },
  };
}

/** Message minimal accepté par `validateMessage`. */
function message(id: string): unknown {
  return { id, texte: `contenu ${id}` };
}

/** Réponse d'une route des sources, sans HTTP (appel direct du handler). */
function route(
  parBot: SourcesParBot,
  input: { method: string; path: string; headers?: Record<string, string>; body?: string },
) {
  return handleSourcesRequest({
    method: input.method,
    path: input.path,
    headers: input.headers ?? {},
    body: input.body ?? "",
    deps: {
      service: parBot.pourBot(parBot.bots()[0]!.id).service,
      logger,
      reception: parBot,
      pourBot: (botId: string) => parBot.depsPourBot(botId),
      bots: { lister: () => parBot.bots() },
    },
  });
}

const BOTS: BotRecord[] = [
  bot("yuki", true, [...CAPACITES_BOT]),
  bot("second", true, [...CAPACITES_BOT]),
];

// ── ⑦ Le nom de secret dit À QUEL BOT appartient le jeton ──────────────────

describe("nom de secret d'une source (lot 35j)", () => {
  it("est UNIQUE PAR BOT : deux bots peuvent déclarer le même nom sans collision", () => {
    expect(nomSecretSource("yuki", "news")).toBe(`YUKI_SOURCE_YUKI${SEPARATEUR_SECRET_BOT}NEWS`);
    expect(nomSecretSource("second", "news")).toBe(`YUKI_SOURCE_SECOND__NEWS`);
    expect(nomSecretSource("second", "news")).not.toBe(nomSecretSource("yuki", "news"));
    // Le séparateur est IMPOSSIBLE dans un slug de bot : aucun bot ne peut se
    // faire passer pour le propriétaire d'un autre.
    expect(SEPARATEUR_SECRET_BOT).toBe("__");
    // Les tirets suivent la convention historique (soulignés, majuscules).
    expect(nomSecretSource("second", "ma-news")).toBe("YUKI_SOURCE_SECOND__MA_NEWS");
  });

  it("accepte l'ANCIEN nom pour `yuki` seulement (webhooks déjà distribués)", () => {
    expect(nomsSecretsSource("yuki", "news")).toEqual([
      "YUKI_SOURCE_YUKI__NEWS",
      "YUKI_SOURCE_NEWS",
    ]);
    expect(nomsSecretsSource("second", "news")).toEqual(["YUKI_SOURCE_SECOND__NEWS"]);
  });

  it("un NOUVEAU jeton s'écrit toujours sous le nom PROPRE AU BOT", () => {
    const h = harnais({ bots: BOTS });
    h.pile("second").service.create("news", { tour: "stocker" });
    const jeton = h.parBot.pourBot("second").service.createToken("news");
    expect(h.vault.lookup("YUKI_SOURCE_SECOND__NEWS")).toBe(jeton);
    // ⚠️ Aucun secret HISTORIQUE n'est créé pour un autre bot : le jeton du bot
    // `second` ne peut donc jamais réveiller `yuki`.
    expect(h.vault.lookup("YUKI_SOURCE_NEWS")).toBeUndefined();
  });
});

// ── ① Le jeton décide, le nom ne décide plus ───────────────────────────────

describe("réception par le JETON (lot 35j)", () => {
  it("le jeton du bot A ne réveille JAMAIS la source du bot B (même nom)", async () => {
    const h = harnais({ bots: BOTS });
    h.declare("yuki", "news", "jeton-yuki");
    h.declare("second", "news", "jeton-second");

    expect(h.parBot.resoudreJeton("jeton-yuki")).toMatchObject({ botId: "yuki", nom: "news" });
    expect(h.parBot.resoudreJeton("jeton-second")).toMatchObject({ botId: "second", nom: "news" });

    // ⚠️ LE TEST CENTRAL : le même NOM, deux JETONS, deux bots.
    const livraison = await h.parBot.recevoir("news", "jeton-yuki", message("m1"));
    expect(livraison.outcome).toBe("stored");
    expect(h.pile("yuki").inbox.size).toBe(1);
    expect(h.pile("second").inbox.size).toBe(0);

    // Et l'inverse : le second bot travaille chez LUI, pas chez `yuki`.
    await h.parBot.recevoir("news", "jeton-second", message("m2"));
    expect(h.pile("yuki").inbox.size).toBe(1);
    expect(h.pile("second").inbox.size).toBe(1);
  });

  it("les fichiers touchés sont ceux du bot propriétaire (jamais ceux d'un autre)", async () => {
    const h = harnais({ bots: BOTS });
    h.declare("second", "news", "jeton-second");
    await h.parBot.recevoir("news", "jeton-second", message("m1"));

    const cheminsSecond = cheminsBot(h.envInstance, "second");
    expect(existsSync(join(cheminsSecond.racine, "sources-inbox.json"))).toBe(true);
    // ⚠️ La racine du bot `yuki` n'a reçu AUCUNE écriture de cette réception.
    expect(existsSync(join(cheminsBot(h.envInstance, "yuki").racine, "sources-inbox.json"))).toBe(
      false,
    );
    // Le contenu reçu est bien chez `second`, et seulement là.
    const brut = readFileSync(join(cheminsSecond.racine, "sources-inbox.json"), "utf8");
    expect(brut).toContain("contenu m1");
  });

  it("l'ANCIEN format `YUKI_SOURCE_<NOM>` est résolu pour `yuki`", async () => {
    const h = harnais({ bots: BOTS });
    h.pile("yuki").service.create("news", { tour: "stocker" });
    // Jeton distribué AVANT le lot 35j : il n'existe que sous l'ancien nom.
    h.vault.set("YUKI_SOURCE_NEWS", "jeton-historique");

    expect(h.parBot.resoudreJeton("jeton-historique")).toEqual({
      botId: "yuki",
      nom: "news",
      secret: "YUKI_SOURCE_NEWS",
    });
    const livraison = await h.parBot.recevoir("news", "jeton-historique", message("m1"));
    expect(livraison.outcome).toBe("stored");
  });

  it("un jeton HISTORIQUE ne peut pas réveiller un autre bot", () => {
    const h = harnais({ bots: BOTS });
    h.declare("second", "news", "jeton-second");
    h.vault.set("YUKI_SOURCE_NEWS", "jeton-historique");
    // `second` déclare `news` : un jeton historique (`YUKI_SOURCE_NEWS`) n'est PAS
    // un nom accepté pour lui — il ne résout donc aucun bot.
    expect(h.parBot.resoudreJeton("jeton-historique")).toBeUndefined();
  });
});

// ── ③ ④ Refus EXPLICITES ───────────────────────────────────────────────────

describe("refus explicites (lot 35j)", () => {
  it("bot INACTIF ⇒ 403 qui NOMME le bot", async () => {
    const h = harnais({
      bots: [bot("yuki", true, [...CAPACITES_BOT]), bot("veille", false, [...CAPACITES_BOT])],
    });
    h.declare("veille", "news", "jeton-veille");

    const erreur = await h.parBot
      .recevoir("news", "jeton-veille", message("m1"))
      .then(() => undefined)
      .catch((error: unknown) => error);
    expect(erreur).toBeInstanceOf(SourceApiError);
    const api = erreur as SourceApiError;
    expect(api.status).toBe(403);
    expect(api.code).toBe("bot_inactif");
    expect(api.message).toContain("veille");
    expect(api.extra).toMatchObject({ bot: "veille" });
  });

  it("nom inconnu CHEZ CE BOT ⇒ 404 qui NOMME le bot", async () => {
    const h = harnais({ bots: BOTS });
    h.declare("second", "news", "jeton-second");

    const erreur = await h.parBot
      .recevoir("fantome", "jeton-second", message("m1"))
      .then(() => undefined)
      .catch((error: unknown) => error);
    const api = erreur as SourceApiError;
    expect(api.status).toBe(404);
    expect(api.code).toBe("unknown_source");
    expect(api.message).toContain("second");
    expect(api.extra).toMatchObject({ bot: "second" });
  });

  it("le nom d'une AUTRE source du MÊME bot ⇒ 404 (le jeton ne la réveille pas)", async () => {
    const h = harnais({ bots: BOTS });
    h.declare("second", "news", "jeton-second");
    h.declare("second", "mail", "jeton-mail-2");

    const erreur = await h.parBot
      .recevoir("mail", "jeton-second", message("m1"))
      .then(() => undefined)
      .catch((error: unknown) => error);
    const api = erreur as SourceApiError;
    expect(api.status).toBe(404);
    // ⚠️ Le message nomme le bot et la source DEMANDÉE — jamais la source du jeton.
    expect(api.message).toContain("second");
    expect(api.message).toContain("mail");
    expect(api.message).not.toContain("news");
  });

  it("jeton inconnu ⇒ 401 (aucun bot nommé : on ne révèle pas l'annuaire)", async () => {
    const h = harnais({ bots: BOTS });
    h.declare("second", "news", "jeton-second");

    const erreur = await h.parBot
      .recevoir("news", "jeton-invente", message("m1"))
      .then(() => undefined)
      .catch((error: unknown) => error);
    const api = erreur as SourceApiError;
    expect(api.status).toBe(401);
    expect(api.code).toBe("invalid_token");
    expect(api.extra ?? {}).not.toMatchObject({ bot: expect.anything() });
  });

  it("le bot nommé est VALIDÉ par la route (`?bot=` inconnu ⇒ 404 qui le nomme)", async () => {
    const h = harnais({ bots: BOTS });
    const reponse = await route(h.parBot, {
      method: "GET",
      path: "/api/sources?bot=inconnu",
      headers: { "x-yuki-config": "1" },
    });
    expect(reponse.status).toBe(404);
    expect(reponse.body).toMatchObject({ code: "unknown_bot", bot: "inconnu" });
    expect(JSON.stringify(reponse.body)).toContain("inconnu");
  });

  it("pile non construite ⇒ 503 explicite (jamais un repli sur le bot actif)", async () => {
    const h = harnais({ bots: BOTS });
    const reponse = await handleSourcesRequest({
      method: "GET",
      path: "/api/sources?bot=second",
      headers: { "x-yuki-config": "1" },
      body: "",
      deps: {
        service: h.pile("yuki").service,
        logger,
        bots: { lister: () => h.parBot.bots() },
        pourBot: () => {
          throw new SourcesParBotError(
            "bot_non_construit",
            "Les sources du bot « second » ne sont pas encore construites.",
          );
        },
      },
    });
    expect(reponse.status).toBe(503);
    expect(reponse.body).toMatchObject({ code: "bot_non_construit" });
    expect(JSON.stringify(reponse.body)).toContain("second");
  });

  it("`?bot=<id>` sert bien les sources DE CE BOT (et le dit dans la réponse)", async () => {
    const h = harnais({ bots: BOTS });
    h.declare("yuki", "news", "jeton-yuki");
    h.declare("second", "mail", "jeton-second");

    const yuki = await route(h.parBot, {
      method: "GET",
      path: "/api/sources?bot=yuki",
      headers: { "x-yuki-config": "1" },
    });
    const second = await route(h.parBot, {
      method: "GET",
      path: "/api/sources?bot=second",
      headers: { "x-yuki-config": "1" },
    });
    expect(
      (yuki.body as { sources: Array<{ nom: string }> }).sources.map((vue) => vue.nom),
    ).toEqual(["news"]);
    expect(
      (second.body as { sources: Array<{ nom: string }> }).sources.map((vue) => vue.nom),
    ).toEqual(["mail"]);
    expect((second.body as { bot: { id: string } }).bot.id).toBe("second");
    expect((second.body as { bots: Array<{ id: string }> }).bots.map((b) => b.id)).toEqual([
      "yuki",
      "second",
    ]);
  });
});

// ── ⑤ Le balayeur ne voit que les bots capables de travailler ──────────────

describe("cibles du balayeur (lot 35j)", () => {
  it("un bot INACTIF ou SANS capacité pertinente ne balaye pas ses sources", () => {
    const h = harnais({
      bots: [
        bot("yuki", true, [...CAPACITES_BOT]),
        bot("leger", true, []),
        bot("veille", false, [...CAPACITES_BOT]),
      ],
    });
    // Une source PLANIFIÉE chez chacun : si le bot était balayé, elle tirerait.
    h.pile("yuki").service.create("cron-yuki", {
      declencheur: {
        type: "planning",
        expression: "0 8 * * *",
        fuseau: "Europe/Paris",
      },
    } as never);
    h.pile("leger").service.create("cron-leger", {
      declencheur: {
        type: "planning",
        expression: "0 8 * * *",
        fuseau: "Europe/Paris",
      },
    } as never);
    h.pile("veille").service.create("cron-veille", {
      declencheur: {
        type: "planning",
        expression: "0 8 * * *",
        fuseau: "Europe/Paris",
      },
    } as never);

    expect(h.parBot.ciblesBalayage().map((cible) => cible.botId)).toEqual(["yuki"]);
  });

  it("chaque cible porte SON store et SON service (jamais ceux de l'instance)", () => {
    const h = harnais({ bots: BOTS });
    const cibles = h.parBot.ciblesBalayage();
    expect(cibles.map((cible) => cible.botId)).toEqual(["yuki", "second"]);
    expect(cibles[0]!.store).toBe(h.pile("yuki").store);
    expect(cibles[1]!.store).toBe(h.pile("second").store);
    expect(cibles[0]!.store).not.toBe(cibles[1]!.store);
  });

  it("un identifiant INCONNU n'ouvre aucun dossier (`bot_inconnu`)", () => {
    const h = harnais({ bots: BOTS });
    expect(() => h.parBot.pourBot("inexistant")).toThrow(/Bot inconnu/);
    expect(() => h.parBot.pourBot("inexistant")).toThrow(/inexistant/);
  });
});

// ── ⑥ Pré-autorisations : aucune consommation croisée ──────────────────────

describe("pré-autorisations par bot (lot 35j)", () => {
  it("consommer pour le bot A ne touche JAMAIS le registre du bot B", () => {
    const h = harnais({ bots: BOTS });
    const pileA = h.pile("yuki");
    const pileB = h.pile("second");

    const pre = pileA.preAutorisations.creer({
      declencheur: "news",
      agentId: "agent-1",
      motif: "systemctl status ",
      portee: "prefixe",
    });
    expect(pileB.preAutorisations.get(pre.id)).toBeUndefined();

    // ⚠️ Le bot vient du RUN (`botDuRun`), jamais d'une demande client.
    const portA = portPreAutorisations(h.parBot, () => "yuki");
    const issue = portA.consommer({
      declencheur: "news",
      commande: "systemctl status nginx",
      agentId: "agent-1",
      destructif: false,
    });
    expect(issue.kind).toBe("consommee");

    // Le registre de B n'a rien consommé : il n'a même aucune entrée.
    expect(pileB.preAutorisations.list()).toEqual([]);
    expect(
      pileB.preAutorisations.consommer({
        declencheur: "news",
        commande: "systemctl status nginx",
        agentId: "agent-1",
        destructif: false,
      }),
    ).toMatchObject({ kind: "aucune" });
  });

  it("le registre de chaque bot vit dans SON fichier (`bots/<id>/preautorisations.json`)", () => {
    const h = harnais({ bots: BOTS });
    h.pile("second").preAutorisations.creer({
      declencheur: "news",
      agentId: "agent-2",
      motif: "systemctl status ",
      portee: "prefixe",
    });
    // Écrit en JSON dans le fichier du bot (aucun accès au fichier de `yuki`).
    const fichierSecond = join(cheminsBot(h.envInstance, "second").racine, "preautorisations.json");
    const fichierYuki = join(cheminsBot(h.envInstance, "yuki").racine, "preautorisations.json");
    expect(existsSync(fichierSecond)).toBe(true);
    expect(readFileSync(fichierSecond, "utf8")).toContain("news");
    expect(existsSync(fichierYuki)).toBe(false);
  });

  it("portée AGENT filtrée par `AgentRecord.bots` : un agent invisible ne consomme pas", () => {
    const h = harnais({ bots: BOTS });
    // `agent-1` est visible de `yuki` seulement ; `agent-2` de `second` seulement.
    h.annuaire.records.set("agent-1", { bots: ["yuki"] });
    h.annuaire.records.set("agent-2", { bots: ["second"] });

    const pileA = h.pile("yuki");
    pileA.preAutorisations.creer({
      declencheur: "news",
      agentId: "agent-2",
      motif: "systemctl status ",
      portee: "prefixe",
    });

    const issue = pileA.preAutorisations.consommer({
      declencheur: "news",
      commande: "systemctl status nginx",
      agentId: "agent-2",
      destructif: false,
    });
    expect(issue.kind).toBe("refus");
    expect(issue.kind === "refus" ? issue.raison : "").toContain("yuki");
    expect(issue.kind === "refus" ? issue.raison : "").toContain("agent-2");
    // Rien n'a été exécuté : l'autorisation est toujours active.
    expect(pileA.preAutorisations.activesPour("news")).toHaveLength(1);

    // L'agent VISIBLE par ce bot consomme normalement.
    pileA.preAutorisations.creer({
      declencheur: "news",
      agentId: "agent-1",
      motif: "systemctl status ",
      portee: "prefixe",
    });
    expect(
      pileA.preAutorisations.consommer({
        declencheur: "news",
        commande: "systemctl status nginx",
        agentId: "agent-1",
        destructif: false,
      }),
    ).toMatchObject({ kind: "consommee" });
  });

  it("`filtreAgentVisible` ne filtre PAS un agent ABSENT de l'annuaire (installation existante)", () => {
    const annuaire = new FakeAnnuaire();
    annuaire.records.set("connu", { bots: ["second"] });
    const filtre = filtreAgentVisible(annuaire, "yuki", agentAutorisePourBot);
    expect(filtre("connu")).toBe(false);
    expect(filtre("disparu")).toBe(true);
  });
});
