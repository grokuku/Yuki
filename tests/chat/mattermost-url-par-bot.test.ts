/**
 * ADRESSE DU SERVEUR MATTERMOST PAR BOT (`chat.mattermost.url`).
 *
 * ⚠️ DÉFAUT SIGNALÉ (2026-11-13) : « c'est malin, il y a pas d'option pour
 * rentrer l'adresse du serveur mattermost XD ». Mattermost est AUTO-HÉBERGÉ —
 * chaque installation a sa propre adresse — et il n'existait AUCUN champ pour
 * la saisir : l'URL venait d'UNE valeur globale (`ChatMirrorStore.baseUrl()`,
 * `<state>/chat-mirror.json`) écrite par la seule route d'instance. Deux bots
 * ne pouvaient donc pas viser deux serveurs, et le panneau « Plateformes »
 * d'un bot n'exposait même pas le champ.
 *
 * Ce que ce fichier prouve :
 *  ① la clé existe, portée `bot`, défaut VIDE (aucune URL inventée), et elle
 *    accepte l'effacement ;
 *  ② le champ est rendu dans Plateformes → Mattermost, avec libellé et aide,
 *    et il écrit chez CE bot (`PUT /api/bots/<id>/config`) ;
 *  ③ une URL invalide est REFUSÉE côté SERVEUR (`invalid_url`) : un PUT direct
 *    ne passe pas, `type="url"` du navigateur ne suffit pas ;
 *  ④ une URL valide est acceptée et RELUE depuis l'overlay du bot, sans toucher
 *    à celui d'un autre bot ;
 *  ⑤ l'adaptateur utilise l'URL DU BOT (l'ANCIEN paramètre reste le défaut) ;
 *  ⑥ URL vide ⇒ « non configurée » : un FAIT affichable, pas une erreur.
 *
 * ⚠️ Échoue sur le code d'origine : `chat.mattermost.url` n'existe pas dans le
 * schéma (`unknown_field`), `src/chat/mattermost/url-bot.ts` n'existe pas, et
 * `public/ui/chat-panel.js` n'a aucun champ `chat-bot-mattermost-url`.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { creerConfigsBots } from "../../src/config/bots.js";
import { loadEnv } from "../../src/config/env.js";
import { ConfigValidationError } from "../../src/config/runtime.js";
import { CONFIG_PATHS, CONFIG_SCHEMA, validateField } from "../../src/config/schema.js";
import { MattermostClient } from "../../src/chat/mattermost/client.js";
import {
  resoudreUrlMattermost,
  urlMattermostConfiguree,
} from "../../src/chat/mattermost/url-bot.js";

const racines: string[] = [];

afterEach(() => {
  for (const racine of racines.splice(0)) rmSync(racine, { recursive: true, force: true });
});

const lire = (chemin: string): string =>
  readFileSync(join(process.cwd(), chemin), "utf8");

/** Deux bots `actif` (donc deux overlays distincts) + le bot de la pile. */
function configsDeBots() {
  const racine = mkdtempSync(join(tmpdir(), "yuki-mm-url-"));
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
  return creerConfigsBots({
    env,
    bots: ["yuki", "granolaf"],
    pile: "yuki",
    promptDefaults: { light: "prompt livré léger", heavy: "prompt livré lourd" },
  });
}

describe("① la clé existe, portée `bot`, défaut VIDE", () => {
  it("`chat.mattermost.url` : texte, vide admis, validée comme URL http(s), hot", () => {
    const descriptor = CONFIG_SCHEMA["chat.mattermost.url"];
    expect(descriptor, "clé absente du schéma").toBeDefined();
    expect(descriptor?.scope).toBe("bot");
    expect(descriptor?.type).toBe("string");
    // ⚠️ Aucune URL inventée : vide est le défaut.
    expect(descriptor?.default).toBe("");
    expect(descriptor?.allowEmpty).toBe(true);
    expect(descriptor?.httpUrl).toBe(true);
    expect(descriptor?.apply).toBe("hot");
    // ⚠️ Une clé de BOT n'accepte pas d'environnement (garde de compilation).
    expect(descriptor?.env).toBeUndefined();
    expect(CONFIG_PATHS).toContain("chat.mattermost.url");
  });

  it("accepte le vide et une URL http(s) complète", () => {
    expect(validateField("chat.mattermost.url", "")).toEqual({ ok: true, value: "" });
    for (const url of ["https://mattermost.exemple.fr", "http://mm.local:8065"]) {
      expect(validateField("chat.mattermost.url", url)).toEqual({ ok: true, value: url });
    }
  });

  it("REFUSE ce qui n'est pas une URL http(s) complète (code `invalid_url`)", () => {
    for (const brute of [
      "pas une url",
      "ftp://mattermost.exemple.fr",
      "mattermost.exemple.fr",
      "https://",
    ]) {
      const verdict = validateField("chat.mattermost.url", brute);
      expect(verdict.ok, brute).toBe(false);
      if (verdict.ok) continue;
      expect(verdict.code, brute).toBe("invalid_url");
      expect(verdict.message, brute).toContain("http://");
    }
  });
});

describe("② le champ est rendu dans Plateformes → Mattermost", () => {
  const panneau = lire(join("public", "ui", "chat-panel.js"));

  it("un champ d'adresse existe, avec son libellé et son aide", () => {
    expect(panneau).toContain('id: "chat-bot-mattermost-url"');
    expect(panneau).toContain('for: "chat-bot-mattermost-url"');
    expect(panneau).toContain("Adresse du serveur Mattermost");
    // ⚠️ L'aide donne un EXEMPLE et la règle « sans barre finale ».
    expect(panneau).toContain("https://mattermost.exemple.fr — sans barre finale");
    expect(panneau).toContain("auto-hébergé");
  });

  it("il écrit et relit la clé de CE bot (`chat.mattermost.url`)", () => {
    expect(panneau).toContain('"chat.mattermost.url": adresse');
    expect(panneau).toContain('champs["chat.mattermost.url"]');
    // ⚠️ Écriture chez le bot affiché, jamais sur une route d'instance.
    expect(panneau).toContain("request(chemin,");
  });

  it("le panneau ne prétend plus que l'URL n'a pas de champ par bot", () => {
    expect(panneau).not.toContain("aucune route ne l'expose pour un autre bot");
  });
});

describe("③ URL invalide ⇒ refus côté SERVEUR (PUT de config du bot)", () => {
  it("le runtime refuse `invalid_url` et n'écrit RIEN", () => {
    const configs = configsDeBots();
    const granolaf = configs.get("granolaf");
    expect(granolaf).toBeDefined();
    let refus: ConfigValidationError | undefined;
    try {
      granolaf?.update({ "chat.mattermost.url": "pas une url" });
    } catch (error) {
      refus = error as ConfigValidationError;
    }
    expect(refus).toBeInstanceOf(ConfigValidationError);
    expect(refus?.fields.map((champ) => champ.path)).toEqual(["chat.mattermost.url"]);
    expect(refus?.fields[0]?.code).toBe("invalid_url");
    // ⚠️ Aucune écriture partielle : la valeur reste le défaut.
    expect(granolaf?.getString("chat.mattermost.url")).toBe("");
  });
});

describe("④ URL valide ⇒ acceptée et relue depuis l'overlay du bot", () => {
  it("la valeur vit dans l'overlay de CE bot, pas dans celui d'un autre", () => {
    const configs = configsDeBots();
    configs.get("granolaf")?.update({ "chat.mattermost.url": "https://mm-granolaf.exemple.fr" });
    expect(configs.get("granolaf")?.getString("chat.mattermost.url")).toBe(
      "https://mm-granolaf.exemple.fr",
    );
    // ⚠️ Le bot de la pile n'a pas bougé : deux bots, DEUX serveurs.
    expect(configs.get("yuki")?.getString("chat.mattermost.url")).toBe("");
    expect(configs.get("yuki")?.originOf("chat.mattermost.url")).toBe("default");
  });

  it("l'effacement est accepté (adresse retirée = état non configuré)", () => {
    const configs = configsDeBots();
    const granolaf = configs.get("granolaf");
    granolaf?.update({ "chat.mattermost.url": "https://mm-granolaf.exemple.fr" });
    granolaf?.update({ "chat.mattermost.url": "" });
    expect(granolaf?.getString("chat.mattermost.url")).toBe("");
  });
});

describe("⑤ l'adaptateur utilise l'URL DU BOT (l'ANCIEN paramètre reste le défaut)", () => {
  it("la clé par bot PRIME sur l'URL historique du miroir", () => {
    expect(
      resoudreUrlMattermost(
        () => "https://mm-du-bot.exemple.fr",
        () => "https://mm-globale.exemple.fr",
      ),
    ).toBe("https://mm-du-bot.exemple.fr");
  });

  it("sans clé par bot : l'ANCIEN paramètre (`chat-mirror.json` → `baseUrl`) sert de défaut", () => {
    expect(
      resoudreUrlMattermost(
        () => "   ",
        () => "https://mm-historique.exemple.fr",
      ),
    ).toBe("https://mm-historique.exemple.fr");
  });

  it("les deux vides ⇒ `\"\"` (état non configuré, jamais une URL devinée)", () => {
    expect(resoudreUrlMattermost(() => "", () => "")).toBe("");
    expect(urlMattermostConfiguree("")).toBe(false);
    expect(urlMattermostConfiguree("https://mm.exemple.fr")).toBe(true);
  });

  it("le client REST appelle l'hôte DU BOT, pas l'hôte global", async () => {
    const appels: string[] = [];
    const client = new MattermostClient({
      baseUrl: () =>
        resoudreUrlMattermost(
          () => "https://mm-du-bot.exemple.fr",
          () => "https://mm-globale.exemple.fr",
        ),
      token: () => "jeton-de-test",
      fetchImpl: (async (input: string | URL | Request) => {
        appels.push(String(input));
        return new Response(JSON.stringify({ id: "u1", username: "bot" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });
    await client.me();
    expect(appels).toHaveLength(1);
    expect(appels[0]).toContain("https://mm-du-bot.exemple.fr/api/v4/");
    expect(appels[0]).not.toContain("mm-globale");
  });

  it("aucun adaptateur n'est câblé sur l'URL globale seule (garde de source)", () => {
    const source = lire(join("src", "index.ts"));
    expect(source).not.toContain("baseUrl: () => chatMirror.baseUrl()");
    expect(source).not.toContain("baseUrl: () => miroir.baseUrl()");
    // ⚠️ GARDE RÉVISÉE (lot 46) : la précédence ne s'appelle plus
    // `resoudreUrlMattermost` DANS `index.ts`, elle s'appelle `cablageMattermostBot`
    // (`url-bot.ts`) — même règle, PLUS le jeton du même bot. L'intention est
    // inchangée : aucun adaptateur ne lit une URL « globale », et le câblage par
    // bot est le seul chemin.
    expect(source).toContain("cablageMattermostBot");
    expect(source).toContain("baseUrl: () => cablage.url()");
  });

  /**
   * ⚠️ GARDE DE NON-RÉGRESSION (recadrage utilisateur du 2026-11-13 : « c'est
   * quand même dommage de ne pas s'être basé sur l'ancien paramètre mattermost
   * qui marchait très bien ») : l'ANCIEN chemin d'écriture reste INTACT — la route
   * d'instance et le champ « URL du serveur » de `/config` continuent d'écrire
   * `chat-mirror.json` → `baseUrl`. Une instance déjà configurée se connecte donc
   * sans rien ressaisir, et la clé par bot ne fait que la SURCHARGER.
   */
  it("l'ANCIEN paramètre reste écrit par la route d'instance (aucune migration)", () => {
    const source = lire(join("src", "index.ts"));
    // ⚠️ GARDE RÉVISÉE (lot 46) : l'écriture passe par le MÊME câblage que la
    // lecture (celui du bot demandé), au lieu d'appeler `chatMirror.setBaseUrl`
    // « à côté » — la cible reste le miroir du bot de la pile, donc l'intention
    // est inchangée : une instance déjà configurée n'a rien à ressaisir.
    expect(source).toContain(
      "saveBaseUrl: (url) => cablageMattermostPile.enregistrerUrlHistorique(url)",
    );
    const panneauInstance = lire(join("public", "ui", "chat-panel.js"));
    // Le champ de `/config → Conversation` n'a pas bougé : même route, même corps.
    expect(panneauInstance).toContain('request("/api/chat/mattermost"');
    expect(panneauInstance).toContain('body: JSON.stringify({ baseUrl: urlInput.value.trim() })');
  });
});

describe("⑥ URL vide ⇒ « non configurée », jamais une erreur", () => {
  it("le panneau distingue les deux états sans lever", () => {
    const panneau = lire(join("public", "ui", "chat-panel.js"));
    // ⚠️ Effacer l'adresse propre d'un bot n'est pas une erreur : il reprend
    // l'adresse commune (l'ancien paramètre), qui reste écrite par /config.
    expect(panneau).toContain("Adresse effacée : ce bot reprend l'adresse commune (celle de ");
    expect(panneau).toContain("Vide = pas d'adresse ");
    // ⚠️ L'état « non configuré » est AFFICHÉ, jamais transformé en erreur.
    expect(panneau).toContain("NON CONFIGURÉE pour ce bot");
  });

  it("le client, lui, refuse explicitement d'appeler sans adresse (pas de silence)", () => {
    const client = new MattermostClient({
      baseUrl: () => resoudreUrlMattermost(() => "", () => ""),
      token: () => "jeton-de-test",
    });
    expect(client.isConfigured()).toBe(false);
  });
});
