/**
 * DEUX BOTS ⇒ DEUX SERVEURS MATTERMOST DIFFÉRENTS, **EN MÊME TEMPS**.
 *
 * ⚠️ EXIGENCE UTILISATEUR (2026-11-13) : « oui, il faut pouvoir mettre un serveur
 * mattermost différent par bot ». Mattermost est auto-hébergé : chaque bot peut
 * viser SA propre instance. Le risque de ce lot est le bug de famille de la
 * journée — *toute écriture/lecture qui vise « le bot courant » au lieu du **bot
 * demandé** fait converger deux bots sur le même serveur*.
 *
 * Ce que ce fichier prouve, sur le CÂBLAGE RÉEL (`cablageMattermostBot`, celui
 * que `src/index.ts` passe aux adaptateurs) :
 *  ① deux bots, deux adresses, les DEUX adaptateurs reçoivent la leur — assertion
 *    sur ce que l'adaptateur APPELLE (URL + en-tête `Authorization`), pas
 *    seulement sur la configuration relue ;
 *  ② l'ancien paramètre (`chat-mirror.json` → `baseUrl`) d'un bot ne touche PAS le
 *    miroir d'un autre : chaque bot a SON miroir (fichier distinct) ;
 *  ③ le jeton va avec l'URL du MÊME bot (nom propre du bot d'abord, ancien nom
 *    d'instance seulement pour `yuki`) : un jeton de A sur le serveur de B serait
 *    un échec d'authentification silencieux ;
 *  ④ URL absente des deux côtés ⇒ état « non configurée » (aucune exception au
 *    démarrage, aucune URL devinée) ;
 *  ⑤ gardes de source : aucun adaptateur ne reçoit une URL résolue une seule fois
 *    au démarrage, et l'écriture d'URL vise le câblage du bot demandé.
 *
 * ⚠️ Échoue sur le code d'origine : `cablageMattermostBot` n'existe pas
 * (`src/chat/mattermost/url-bot.ts` ne connaît que `resoudreUrlMattermost`),
 * l'adaptateur du bot de la pile lisait le jeton sous le nom d'instance en dur
 * (`YUKI_CHAT_MATTERMOST`), et la condition de connexion au démarrage ignorait
 * `chat.mattermost.url` (elle ne regardait que `chatMirror.baseUrl()`).
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MattermostChatAdapter } from "../../src/chat/mattermost/adapter.js";
import type { MattermostApiError } from "../../src/chat/mattermost/client.js";
import { cablageMattermostBot, type CablageMattermostBot } from "../../src/chat/mattermost/url-bot.js";
import { jetonChatDeBot, nomSecretChat } from "../../src/chat/jetons-bot.js";
import { ChatMirrorStore } from "../../src/chat/mirror/store.js";
import { creerConfigsBots } from "../../src/config/bots.js";
import { loadEnv } from "../../src/config/env.js";
import type { ConfigRuntime } from "../../src/config/runtime.js";

const racines: string[] = [];

afterEach(() => {
  for (const racine of racines.splice(0)) rmSync(racine, { recursive: true, force: true });
});

const lire = (chemin: string): string => readFileSync(join(process.cwd(), chemin), "utf8");

/** Une requête HTTP observée (URL appelée + en-tête d'authentification). */
interface Requete {
  url: string;
  authorization: string;
}

/** Deux bots (`yuki` = pile, `granolaf`), deux configs, deux miroirs, un coffre. */
interface Banc {
  configs: Map<string, ConfigRuntime>;
  miroirDe(botId: string): ChatMirrorStore;
  coffre: Map<string, string>;
  lookup(nom: string): string | undefined;
  /** Le câblage du bot DEMANDÉ — exactement ce que `src/index.ts` construit. */
  cablageDe(botId: string): CablageMattermostBot;
}

/**
 * Banc d'essai.
 *
 * ⚠️ Les DEUX miroirs sont des `ChatMirrorStore` RÉELS, ouverts sur des chemins
 * distincts (`<state>/bots/<id>/chat-mirror.json`, comme `canauxBots.miroirDe` en
 * production) : c'est cette séparation qui empêche une écriture d'URL d'en
 * déplacer un autre bot.
 */
function banc(): Banc {
  const racine = mkdtempSync(join(tmpdir(), "yuki-mm-deux-"));
  racines.push(racine);
  const state = join(racine, "state");
  mkdirSync(state, { recursive: true });
  const env = loadEnv({
    YUKI_MOUNT_STATE: state,
    YUKI_CONFIG_STORE_PATH: join(state, "config.json"),
    YUKI_PI_SYSTEM_PROMPT: join(racine, "light.md"),
    YUKI_PI_HEAVY_SYSTEM_PROMPT: join(racine, "heavy.md"),
    YUKI_LOG_LEVEL: "error",
  });
  const configs = creerConfigsBots({
    env,
    bots: ["yuki", "granolaf"],
    pile: "yuki",
    promptDefaults: { light: "prompt livré léger", heavy: "prompt livré lourd" },
  });
  const miroirs = new Map<string, ChatMirrorStore>();
  const miroirDe = (botId: string): ChatMirrorStore => {
    const connu = miroirs.get(botId);
    if (connu) return connu;
    const miroir = ChatMirrorStore.open({
      indexPath: join(state, "bots", botId, "chat-mirror.json"),
      messagesDir: join(state, "bots", botId, "chat-mirror"),
    });
    miroirs.set(botId, miroir);
    return miroir;
  };
  const coffre = new Map<string, string>();
  const lookup = (nom: string): string | undefined => coffre.get(nom);
  const cablageDe = (botId: string): CablageMattermostBot =>
    cablageMattermostBot({
      botId,
      urlDuBot: () => configDe(configs, botId).getString("chat.mattermost.url"),
      miroir: miroirDe(botId),
      lookup,
    });
  return { configs, miroirDe, coffre, lookup, cablageDe };
}

function configDe(configs: Map<string, ConfigRuntime>, botId: string): ConfigRuntime {
  const config = configs.get(botId);
  if (!config) throw new Error(`configuration absente pour « ${botId} »`);
  return config;
}

/** `fetch` espion : rend une identité Mattermost valide, sans réseau. */
function espion(): { fetchImpl: typeof fetch; requetes: Requete[] } {
  const requetes: Requete[] = [];
  const fetchImpl = (async (entree: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof entree === "string" ? entree : entree instanceof URL ? entree.toString() : entree.url;
    const entetes = new Headers(init?.headers);
    requetes.push({ url, authorization: entetes.get("authorization") ?? "" });
    return new Response(JSON.stringify({ id: "u1", username: "bot" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, requetes };
}

/**
 * L'adaptateur REÇOIT le câblage de SON bot (`baseUrl`/`token` sont exactement les
 * accesseurs de production) : rien d'autre ne décide de l'URL.
 */
function adaptateurDe(
  cablage: CablageMattermostBot,
  options: { miroir: ChatMirrorStore; fetchImpl: typeof fetch; token?: () => string | undefined },
): MattermostChatAdapter {
  return new MattermostChatAdapter({
    baseUrl: () => cablage.url(),
    token: options.token ?? (() => cablage.jeton()),
    store: options.miroir,
    fetchImpl: options.fetchImpl,
    // Aucune attente réelle : le débit est piloté par `now`, figé à 0.
    now: () => 0,
    sleep: async () => undefined,
  });
}

describe("① deux bots, deux serveurs — les DEUX adaptateurs reçoivent la leur", () => {
  it("bot A → mm-a, bot B → mm-b, les deux requêtes partent EN MÊME TEMPS", async () => {
    const { configs, cablageDe, miroirDe, coffre } = banc();
    configDe(configs, "yuki").update({ "chat.mattermost.url": "https://mm-a.exemple.fr" });
    configDe(configs, "granolaf").update({ "chat.mattermost.url": "https://mm-b.exemple.fr" });
    coffre.set(nomSecretChat("yuki", "mattermost"), "jeton-a");
    coffre.set(nomSecretChat("granolaf", "mattermost"), "jeton-b");

    const a = cablageDe("yuki");
    const b = cablageDe("granolaf");
    // ⚠️ Les deux valeurs sont vraies SIMULTANÉMENT : aucune n'écrase l'autre.
    expect([a.url(), b.url()]).toEqual([
      "https://mm-a.exemple.fr",
      "https://mm-b.exemple.fr",
    ]);

    // ⚠️ Assertion sur ce que chaque ADAPTATEUR appelle (et avec quel jeton).
    const espionA = espion();
    const espionB = espion();
    const adaptateurA = adaptateurDe(a, { miroir: miroirDe("yuki"), fetchImpl: espionA.fetchImpl });
    const adaptateurB = adaptateurDe(b, {
      miroir: miroirDe("granolaf"),
      fetchImpl: espionB.fetchImpl,
    });
    await Promise.all([adaptateurA.rest.me(), adaptateurB.rest.me()]);

    expect(espionA.requetes).toHaveLength(1);
    expect(espionB.requetes).toHaveLength(1);
    const [requeteA] = espionA.requetes;
    const [requeteB] = espionB.requetes;
    expect(requeteA?.url).toBe("https://mm-a.exemple.fr/api/v4/users/me");
    expect(requeteB?.url).toBe("https://mm-b.exemple.fr/api/v4/users/me");
    // Aucune contamination croisée.
    expect(requeteA?.url).not.toContain("mm-b");
    expect(requeteB?.url).not.toContain("mm-a");
    // ③ Le jeton qui part avec l'URL est celui du MÊME bot.
    expect(requeteA?.authorization).toBe("Bearer jeton-a");
    expect(requeteB?.authorization).toBe("Bearer jeton-b");
  });
});

describe("② l'ancien `baseUrl` d'un bot ne touche PAS le miroir d'un autre", () => {
  it("écrire l'URL historique de A laisse le miroir de B intact", () => {
    const { cablageDe, miroirDe } = banc();
    const a = cablageDe("yuki");
    const b = cablageDe("granolaf");

    a.enregistrerUrlHistorique("https://mm-ancien-a.exemple.fr");

    expect(miroirDe("yuki").baseUrl()).toBe("https://mm-ancien-a.exemple.fr");
    // ⚠️ Le miroir de l'AUTRE bot n'a pas bougé — et c'est un fichier distinct.
    expect(miroirDe("granolaf").baseUrl()).toBe("");
    expect(b.url()).toBe("");
    expect(miroirDe("yuki").indexPath).not.toBe(miroirDe("granolaf").indexPath);
  });

  it("le repli est CELUI DU BOT : A sans clé propre prend l'URL de SON miroir", () => {
    const { configs, cablageDe } = banc();
    configDe(configs, "granolaf").update({ "chat.mattermost.url": "https://mm-b.exemple.fr" });
    const a = cablageDe("yuki");
    const b = cablageDe("granolaf");
    a.enregistrerUrlHistorique("https://mm-ancien-a.exemple.fr");

    // A : pas de clé par bot ⇒ sa propre URL historique, jamais celle de B.
    expect(a.url()).toBe("https://mm-ancien-a.exemple.fr");
    // B : sa clé par bot PRIME sur son miroir (vide) — et sur celui de A.
    expect(b.url()).toBe("https://mm-b.exemple.fr");
  });
});

describe("③ le jeton va avec l'URL du MÊME bot", () => {
  it("le nom PROPRE du bot prime sur l'ancien nom d'instance", () => {
    const { cablageDe, coffre } = banc();
    coffre.set("YUKI_CHAT_MATTERMOST", "jeton-historique");
    coffre.set(nomSecretChat("yuki", "mattermost"), "jeton-propre");

    // `yuki` accepte les deux noms : le sien gagne, l'historique reste un repli.
    expect(cablageDe("yuki").jeton()).toBe("jeton-propre");
    coffre.delete(nomSecretChat("yuki", "mattermost"));
    expect(cablageDe("yuki").jeton()).toBe("jeton-historique");
  });

  it("un AUTRE bot ne prend JAMAIS l'ancien nom d'instance (ce jeton n'est pas le sien)", () => {
    const { cablageDe, coffre } = banc();
    coffre.set("YUKI_CHAT_MATTERMOST", "jeton-de-yuki");
    coffre.set(nomSecretChat("granolaf", "mattermost"), "jeton-de-granolaf");

    expect(cablageDe("granolaf").jeton()).toBe("jeton-de-granolaf");
    // Sans son propre jeton, granolaf n'a RIEN : il ne retombe pas sur celui de yuki.
    coffre.delete(nomSecretChat("granolaf", "mattermost"));
    expect(cablageDe("granolaf").jeton()).toBeUndefined();
    expect(
      jetonChatDeBot((nom) => coffre.get(nom), "granolaf", "mattermost"),
    ).toBeUndefined();
    // …alors que `yuki`, lui, le résout toujours.
    expect(jetonChatDeBot((nom) => coffre.get(nom), "yuki", "mattermost")).toBe(
      "jeton-de-yuki",
    );
  });

  it("un bot sans jeton n'est pas « configuré » (aucune connexion silencieuse)", () => {
    const { cablageDe, miroirDe } = banc();
    const cablage = cablageDe("yuki");
    const adaptateur = adaptateurDe(cablage, {
      miroir: miroirDe("yuki"),
      fetchImpl: espion().fetchImpl,
    });
    cablage.enregistrerUrlHistorique("https://mm-a.exemple.fr");
    expect(adaptateur.rest.isConfigured()).toBe(false);
    expect(adaptateur.status().etat).toBe("off");
  });
});

describe("④ URL absente des DEUX côtés ⇒ état « non configurée », jamais une exception", () => {
  it("le câblage rend `\"\"` et `configuree() === false`", () => {
    const { cablageDe } = banc();
    const cablage = cablageDe("yuki");
    expect(cablage.url()).toBe("");
    expect(cablage.configuree()).toBe(false);
  });

  it("l'adaptateur se construit et s'interroge sans lever", async () => {
    const { cablageDe, miroirDe } = banc();
    const adaptateur = adaptateurDe(cablageDe("yuki"), {
      miroir: miroirDe("yuki"),
      fetchImpl: espion().fetchImpl,
      token: () => "jeton-a",
    });
    // ⚠️ « Non configuré » est un ÉTAT affichable, pas un démarrage en erreur.
    expect(() => adaptateur.status()).not.toThrow();
    expect(adaptateur.status().etat).toBe("off");
    expect(adaptateur.rest.isConfigured()).toBe(false);
    // L'appel, lui, DIT pourquoi (code `not_configured`) au lieu de partir à l'aveugle.
    await expect(adaptateur.rest.me()).rejects.toMatchObject({
      code: "not_configured",
    } satisfies Partial<MattermostApiError>);
  });
});

describe("⑤ gardes de source : le câblage vient du BOT DEMANDÉ", () => {
  const source = lire(join("src", "index.ts"));

  it("deux câblages (pile + fabrique par bot), chacun sur SON bot", () => {
    expect((source.match(/cablageMattermostBot\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
    // La fabrique reçoit le bot du JETON résolu, jamais « le bot courant ».
    expect(source).toContain("botId: jeton.botId");
    expect(source).toContain("botId: botDuRun");
    expect(source).toContain("baseUrl: () => cablage.url()");
    expect(source).toContain("token: () => cablage.jeton()");
  });

  it("l'URL n'est plus jamais lue seule sur le miroir « courant »", () => {
    expect(source).not.toContain("baseUrl: () => urlMattermost(");
    expect(source).not.toContain("baseUrl: () => miroir.baseUrl()");
    expect(source).not.toContain("baseUrl: () => chatMirror.baseUrl()");
  });

  it("l'écriture d'URL vise le câblage du bot demandé", () => {
    expect(source).toContain(
      "saveBaseUrl: (url) => cablageMattermostPile.enregistrerUrlHistorique(url)",
    );
  });

  it("aucune lecture de jeton sous un nom d'instance en dur", () => {
    expect(source).not.toContain("secretStore?.lookup(MATTERMOST_TOKEN_SECRET_NAME)");
    expect(source).not.toContain("secretStore?.lookup(DISCORD_TOKEN_SECRET_NAME)");
  });

  it("la connexion au démarrage regarde l'URL EFFECTIVE du bot", () => {
    expect(source).toContain("cablageMattermostPile.configuree()");
  });
});
