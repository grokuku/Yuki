/**
 * ROUTES DES BOTS et REFUS CROISÉS (lot 35b, sous-lot 1b-3).
 *
 * Ce que ce fichier verrouille :
 *  - `GET /api/bots` ne liste que les bots du registre (et `yuki` seul en mode
 *    mono-bot historique) ;
 *  - `PUT /api/config` REFUSE une clé propre à un bot (`bot_scoped_field`) et
 *    `PUT /api/bots/<id>/config` REFUSE une clé d'instance
 *    (`instance_scoped_field`) — aucun des deux n'écrit quoi que ce soit ;
 *  - une clé MIXTE s'écrit des DEUX côtés (`portee: "instance"` vs
 *    `portee: "bot"`) et les deux côtés sont réellement relus ;
 *  - un bot INCONNU répond 404 en le NOMMANT ;
 *  - ⚠️ GARDE DU LOT 30 : `chat.mode` écrit par le module de l'interface
 *    (`public/ui/chat-mode.js`) fonctionne toujours ;
 *  - l'overlay d'un bot NON actif est écrit sur disque sans toucher à l'état du
 *    bot actif.
 *
 * ⚠️ Échoue sur le code d'origine : `/api/bots` et `/api/bots/<id>/config`
 * n'existent pas (404) et `PUT /api/config` accepte encore les clés de bot.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadEnv } from "../../src/config/env.js";
import { ConfigStore } from "../../src/config/store.js";
import { createConfigRuntime } from "../../src/config/runtime.js";
import { handleConfigRequest } from "../../src/gateway/routes/config.js";
import { CAPACITES_BOT, type RegistreBots } from "../../src/bots/registry.js";
import { createLogger } from "../../src/observability/logger.js";
// ⚠️ Le VRAI module de l'interface (garde du lot 30, adaptée le 2026-11-10) :
// c'est lui qui écrit les INTERRUPTEURS de plateforme, et il doit viser la route
// du bot actif. ⚠️ Ce n'est plus `chat.mode` (choix exclusif retiré : il coupait
// les plateformes non choisies) mais `chat.<plateforme>.enabled`.
import { savePlatformEnabled } from "../../public/ui/chat-mode.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const WRITE_HEADERS = { "x-yuki-config": "1", "content-type": "application/json" };

interface Banc {
  root: string;
  runtime: ReturnType<typeof createConfigRuntime>;
  deps: Parameters<typeof handleConfigRequest>[0]["deps"];
  env: ReturnType<typeof loadEnv>;
}

/** Registre à deux bots : `yuki` (actif) et `kohai` (inactif). */
function registreDeuxBots(): RegistreBots {
  return {
    schemaVersion: 1,
    bots: [
      {
        id: "yuki",
        nom: "Yuki",
        // Bot HISTORIQUE : toutes les capacités (état d'un bot hérité).
        capacites: [...CAPACITES_BOT],
        actif: true,
        ordre: 0,
        creeLe: "2026-01-01T00:00:00.000Z",
        plateformes: {},
      },
      {
        id: "kohai",
        nom: "Kohai",
        // Bot CRÉÉ depuis l'interface : aucune capacité, il ne peut que répondre.
        capacites: [],
        actif: false,
        ordre: 1,
        creeLe: "2026-01-01T00:00:00.000Z",
        plateformes: {},
      },
    ],
    echanges: {},
  };
}

function banc(options: { registre?: RegistreBots | null } = {}): Banc {
  const root = mkdtempSync(join(tmpdir(), "yuki-bots-api-"));
  tempDirs.push(root);
  const env = loadEnv({
    YUKI_LOG_LEVEL: "error",
    YUKI_MOUNT_STATE: join(root, "state"),
    YUKI_CONFIG_STORE_PATH: join(root, "state", "config.json"),
  });
  const runtime = createConfigRuntime({
    env,
    store: new ConfigStore(env.configStorePath),
    processEnv: {},
    promptDefaults: { light: "P", heavy: "H" },
  });
  const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
  const deps = {
    runtime,
    logger,
    bots: { registre: options.registre ?? null },
  } as Banc["deps"];
  return { root, runtime, deps, env };
}

async function appel(
  b: Banc,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const response = await handleConfigRequest({
    method,
    path,
    headers: { ...WRITE_HEADERS },
    body: body === undefined ? "" : JSON.stringify(body),
    deps: b.deps,
  });
  return { status: response.status, body: response.body };
}

describe("① `GET /api/bots`", () => {
  it("ne liste que `yuki` en mode mono-bot historique (aucun registre)", async () => {
    const b = banc({ registre: null });
    const { status, body } = await appel(b, "GET", "/api/bots");
    expect(status).toBe(200);
    expect(body.bots).toEqual([
      {
        id: "yuki",
        nom: "Yuki",
        // Mono-bot historique : le bot porte le produit entier ⇒ toutes.
        capacites: [...CAPACITES_BOT],
        actif: true,
        ordre: 0,
      },
    ]);
  });

  it("liste le registre, trié par `ordre`, avec `id`/`nom`/`capacites`/`actif`/`ordre`", async () => {
    const b = banc({ registre: registreDeuxBots() });
    const { status, body } = await appel(b, "GET", "/api/bots");
    expect(status).toBe(200);
    expect(body.bots.map((bot: { id: string }) => bot.id)).toEqual(["yuki", "kohai"]);
    expect(body.bots[1]).toEqual({
      id: "kohai",
      nom: "Kohai",
      // ⚠️ `capacites: []` est RENVOYÉ tel quel : c'est ce qui fait afficher
      // toutes les cases décochées dans l'onglet « Général ».
      capacites: [],
      actif: false,
      ordre: 1,
    });
  });

  it("⚠️ ne porte NI `refuses` NI `plafond` : plus aucun bot n'est écarté", async () => {
    // ⚠️ RÉÉCRIT (n'était « porte `refuses` : les bots `actif` écartés par le
    // plafond sont NOMMÉS ») : depuis la décision utilisateur du 2026-11-13, tous
    // les bots `actif` démarrent — il n'y a donc plus rien à écarter, et un bot
    // qui ne tourne pas porte une VRAIE erreur (`execution.erreur`).
    const b = banc({ registre: registreDeuxBots() });
    const { status, body } = await appel(b, "GET", "/api/bots");
    expect(status).toBe(200);
    expect(body.refuses).toBeUndefined();
    expect(body.plafond).toBeUndefined();
    // La réponse garde ce qu'elle doit dire vrai : le principal et les boucles.
    expect(body.principal).toBe(b.deps.runtime.botId);
    expect(body.echanges).toEqual({});
  });
});

describe("② refus croisés — rien n'est écrit", () => {
  it("`PUT /api/config` refuse une clé de BOT (`bot_scoped_field`)", async () => {
    const b = banc({ registre: registreDeuxBots() });
    const { status, body } = await appel(b, "PUT", "/api/config", { "chat.mode": "discord" });
    expect(status).toBe(400);
    expect(body.error).toBe("bot_scoped_field");
    expect(body.code).toBe("bot_scoped_field");
    expect(body.fields).toEqual([
      expect.objectContaining({ path: "chat.mode", code: "bot_scoped_field" }),
    ]);
    // ⚠️ Rien n'a été écrit : ni le store commun, ni l'overlay.
    expect(b.runtime.getString("chat.mode")).toBe("local");
    expect(b.runtime.snapshot().fields["chat.mode"]).toMatchObject({ origin: "default" });
  });

  it("`PUT /api/bots/yuki/config` refuse une clé d'INSTANCE (`instance_scoped_field`)", async () => {
    const b = banc({ registre: registreDeuxBots() });
    const { status, body } = await appel(b, "PUT", "/api/bots/yuki/config", {
      "llm.light.model": "autre-modele",
    });
    expect(status).toBe(400);
    expect(body.error).toBe("instance_scoped_field");
    expect(body.fields).toEqual([
      expect.objectContaining({ path: "llm.light.model", code: "instance_scoped_field" }),
    ]);
    expect(b.runtime.getString("llm.light.model")).not.toBe("autre-modele");
  });

  it("les gardes d'écriture s'appliquent AUSSI à la route du bot", async () => {
    const b = banc({ registre: registreDeuxBots() });
    const response = await handleConfigRequest({
      method: "PUT",
      path: "/api/bots/yuki/config",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ "tts.voice": "flocon" }),
      deps: b.deps,
    });
    expect(response.status).toBe(403);
  });
});

describe("③ clé MIXTE — les DEUX côtés, et les deux sont relus", () => {
  it("`tts.enabled` s'écrit côté INSTANCE puis côté BOT, et la conjonction les lit", async () => {
    const b = banc({ registre: registreDeuxBots() });

    // Côté INSTANCE, par l'écran d'instance.
    const instance = await appel(b, "PUT", "/api/config", { "tts.enabled": "on" });
    expect(instance.status).toBe(200);
    const commun = JSON.parse(readFileSync(b.env.configStorePath, "utf8")) as {
      values?: Record<string, unknown>;
    };
    expect(commun.values?.["tts.enabled"]).toBe("on");

    // Côté BOT, par l'écran du bot.
    const bot = await appel(b, "PUT", "/api/bots/yuki/config", { "tts.enabled": "off" });
    expect(bot.status).toBe(200);
    const overlay = JSON.parse(readFileSync(b.runtime.overlayPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(overlay["tts.enabled"]).toBe("off");

    // ⚠️ Les DEUX côtés sont conservés (aucun écrasement croisé) et la fusion
    // `et` les combine : instance `on` + bot `off` ⇒ `off`.
    expect(b.runtime.getString("tts.enabled")).toBe("off");
    const relu = await appel(b, "GET", "/api/bots/yuki/config");
    expect(relu.status).toBe(200);
    expect(relu.body.fields["tts.enabled"]).toMatchObject({ value: "off", scope: "mixte" });
    // Le côté instance reste intact.
    expect(commun.values?.["tts.enabled"]).toBe("on");
  });
});

describe("④ bot inconnu", () => {
  it("répond 404 en NOMMANT l'identifiant, en lecture comme en écriture", async () => {
    const b = banc({ registre: registreDeuxBots() });
    const lecture = await appel(b, "GET", "/api/bots/fantome/config");
    expect(lecture.status).toBe(404);
    expect(lecture.body.code).toBe("bot_not_found");
    expect(lecture.body.botId).toBe("fantome");
    expect(String(lecture.body.message)).toContain("fantome");

    const ecriture = await appel(b, "PUT", "/api/bots/fantome/config", { "tts.voice": "x" });
    expect(ecriture.status).toBe(404);
    expect(ecriture.body.message).toContain("fantome");
  });
});

describe("⑤ garde du LOT 30 — l'interrupteur de plateforme écrit toujours", () => {
  it("`savePlatformEnabled` passe par la route du bot actif et le serveur l'accepte", async () => {
    const b = banc({ registre: registreDeuxBots() });
    const urls: string[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      urls.push(url);
      const method = (init?.method ?? "GET").toUpperCase();
      // `GET /api/chat/status` appartient à la route des discussions (hors
      // sujet ici) : on répond un état minimal, comme le ferait le gateway.
      if (url === "/api/chat/status") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            mode: "discord",
            plateforme: { etat: "on", raison: "Mode Discord : connecté." },
            creation: { autorisee: false, raison: "La création est désactivée." },
          }),
        };
      }
      const response = await handleConfigRequest({
        method,
        path: url,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: method === "GET" || method === "HEAD" ? "" : String(init?.body ?? ""),
        deps: b.deps,
      });
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        json: async () => response.body,
      };
    };

    const status = await savePlatformEnabled("discord", true, fetchImpl as never);
    expect(status.mode).toBe("discord");
    // Aucune écriture sur `/api/config` : il l'aurait refusée.
    expect(urls).toContain("/api/bots/yuki/config");
    expect(urls).toContain("/api/chat/status");
    // ⚠️ La valeur est bien PERSISTÉE côté serveur (overlay du bot actif).
    const overlay = JSON.parse(readFileSync(b.runtime.overlayPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(overlay["chat.discord.enabled"]).toBe("on");
  });
});

describe("⑥ bot NON actif — overlay séparé, état du bot actif intact", () => {
  it("écrit l'overlay de `kohai` sans changer la valeur effective de `yuki`", async () => {
    const b = banc({ registre: registreDeuxBots() });
    const avant = b.runtime.getString("tts.voice");
    const ecriture = await appel(b, "PUT", "/api/bots/kohai/config", {
      "tts.voice": "voix-de-kohai",
    });
    expect(ecriture.status).toBe(200);
    expect(ecriture.body.bot).toEqual({ id: "kohai" });
    expect(ecriture.body.fields["tts.voice"]).toMatchObject({ value: "voix-de-kohai" });

    const fichier = join(b.root, "state", "bots", "kohai", "config.overlay.json");
    const overlay = JSON.parse(readFileSync(fichier, "utf8")) as Record<string, unknown>;
    expect(overlay["tts.voice"]).toBe("voix-de-kohai");
    // Le bot actif n'a pas bougé.
    expect(b.runtime.getString("tts.voice")).toBe(avant);

    const relu = await appel(b, "GET", "/api/bots/kohai/config");
    expect(relu.body.fields["tts.voice"]).toMatchObject({ value: "voix-de-kohai" });
  });
});

/**
 * ⚠️ LOT 35i — ONGLET « MÉMOIRE » DE LA PAGE BOT : les 8 clés `bot` du schéma
 * (mémoire durable) doivent s'ENREGISTRER par la route du bot, dans l'overlay de
 * CE bot. ⚠️ L'interrupteur `memory.consolidation.enabled` n'en fait plus partie :
 * il est d'INSTANCE (classement validé) et la route du bot le REFUSE.
 *
 * Sur le code d'origine, deux des huit clés (`memory.setAside.*`) n'étaient
 * proposées par AUCUN onglet : elles n'étaient réglables nulle part.
 */
describe("⑦ onglet « Mémoire » d'un bot — les 8 clés `bot` s'enregistrent", () => {
  const CLES_MEMOIRE_BOT = [
    "memory.enabled",
    "memory.recall.topK",
    "memory.recall.budgetChars",
    "memory.recall.timeoutMs",
    "memory.extract.maxItems",
    "memory.extract.timeoutMs",
    "memory.setAside.maxChars",
    "memory.setAside.maxChunks",
  ] as const;

  it("les 8 clés sont `bot` au schéma et s'écrivent dans l'overlay du bot", async () => {
    const b = banc({ registre: registreDeuxBots() });
    const patch: Record<string, unknown> = {
      "memory.enabled": "off",
      "memory.recall.topK": 7,
      "memory.recall.budgetChars": 1234,
      "memory.recall.timeoutMs": 800,
      "memory.extract.maxItems": 5,
      "memory.extract.timeoutMs": 45000,
      "memory.setAside.maxChars": 30000,
      "memory.setAside.maxChunks": 3,
    };
    const ecriture = await appel(b, "PUT", "/api/bots/yuki/config", patch);
    expect(ecriture.status).toBe(200);
    for (const cle of CLES_MEMOIRE_BOT) {
      expect(ecriture.body.fields[cle], cle).toMatchObject({ scope: "bot" });
      expect(ecriture.body.fields[cle].value, cle).toBe(patch[cle]);
    }
    const overlay = JSON.parse(readFileSync(b.runtime.overlayPath, "utf8")) as Record<
      string,
      unknown
    >;
    for (const cle of CLES_MEMOIRE_BOT) expect(overlay[cle], cle).toBe(patch[cle]);
  });

  it("l'interrupteur de consolidation est d'INSTANCE : refusé par la route du bot", async () => {
    // ⚠️ CLASSEMENT VALIDÉ : `memory.consolidation.enabled` est passée de `mixte`
    // à `instance`. La route du bot le REFUSE (`instance_scoped_field`) au lieu de
    // l'écrire dans l'overlay — sinon la valeur ne serait plus jamais lue.
    const b = banc({ registre: registreDeuxBots() });
    const bot = await appel(b, "PUT", "/api/bots/yuki/config", {
      "memory.consolidation.enabled": "off",
    });
    expect(bot.status).toBe(400);
    expect(JSON.stringify(bot.body)).toContain("instance_scoped_field");
    // La route d'instance, elle, l'écrit et la valeur est RELUE.
    const instance = await appel(b, "PUT", "/api/config", {
      "memory.consolidation.enabled": "off",
    });
    expect(instance.status).toBe(200);
    expect(instance.body.fields["memory.consolidation.enabled"]).toMatchObject({
      scope: "instance",
      value: "off",
    });
    expect(b.runtime.getString("memory.consolidation.enabled")).toBe("off");
  });
});
