/**
 * ROUTES D'ADMINISTRATION DES BOTS (lot 35e) — `POST` / `DELETE` / compteurs.
 *
 * Ce que ce fichier verrouille :
 *  - `POST /api/bots` crée le dossier, l'entrée du registre et l'overlay, exige
 *    l'en-tête `X-Yuki-Config: 1`, refuse un slug invalide, un slug en double
 *    et le 7ᵉ bot (`409 max_bots` nommant la limite) ;
 *  - `GET /api/bots` reflète IMMÉDIATEMENT la création (registre en mémoire
 *    remplacé, pas seulement le fichier) ;
 *  - `DELETE /api/bots/<id>` DÉPLACE le dossier dans `bots-supprimes/`, refuse
 *    le dernier bot (`409 last_bot`) et rend le bot suivant quand le bot actif
 *    disparaît (`rechargementRequis`) ;
 *  - `GET /api/bots/<id>/donnees` rend les compteurs réels et la rétention ;
 *  - un CLONE par la route copie l'identité + les capacités par défaut, jamais
 *    `chat-mirror`/préautorisations/envois/sessions.
 *
 * ⚠️ Échoue sur le code d'origine : `POST /api/bots` et `DELETE /api/bots/<id>`
 * n'existent pas (405 / 404).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MAX_BOTS, SOUS_DOSSIER_SUPPRIMES } from "../../src/bots/admin.js";
import { CAPACITES_BOT, type BotRecord, type RegistreBots } from "../../src/bots/registry.js";
import { loadEnv } from "../../src/config/env.js";
import { ConfigStore } from "../../src/config/store.js";
import { createConfigRuntime } from "../../src/config/runtime.js";
import { handleConfigRequest } from "../../src/gateway/routes/config.js";
import { createLogger } from "../../src/observability/logger.js";

const racines: string[] = [];

afterEach(() => {
  for (const racine of racines.splice(0)) rmSync(racine, { recursive: true, force: true });
});

const ECRITURE = { "x-yuki-config": "1", "content-type": "application/json" };

interface Banc {
  stateDir: string;
  deps: Parameters<typeof handleConfigRequest>[0]["deps"];
}

function bot(id: string, ordre: number, actif = false): BotRecord {
  return {
    id,
    nom: id === "yuki" ? "Yuki" : id,
    // Bot du registre : liste normalisée (un bot hérité a toutes les capacités).
    capacites: [...CAPACITES_BOT],
    actif,
    ordre,
    creeLe: "2026-01-01T00:00:00.000Z",
    plateformes: {},
  };
}

function banc(bots: BotRecord[] = [bot("yuki", 0, true)]): Banc {
  const racine = mkdtempSync(join(tmpdir(), "yuki-bots-admin-api-"));
  racines.push(racine);
  const stateDir = join(racine, "state");
  mkdirSync(join(stateDir, "bots"), { recursive: true });
  const env = loadEnv({
    YUKI_LOG_LEVEL: "error",
    YUKI_MOUNT_STATE: stateDir,
    YUKI_CONFIG_STORE_PATH: join(stateDir, "config.json"),
  });
  const runtime = createConfigRuntime({
    env,
    store: new ConfigStore(env.configStorePath),
    processEnv: {},
    promptDefaults: { light: "P", heavy: "H" },
  });
  const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
  const registre: RegistreBots = { schemaVersion: 1, bots, echanges: {} };
  const deps = {
    runtime,
    logger,
    bots: { registre, stateDir },
  } as Banc["deps"];
  return { stateDir, deps };
}

async function appel(
  b: Banc,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = ECRITURE,
): Promise<{ status: number; body: any }> {
  const response = await handleConfigRequest({
    method,
    path,
    headers,
    body: body === undefined ? "" : JSON.stringify(body),
    deps: b.deps,
  });
  return { status: response.status, body: response.body };
}

/** Dépose un fichier (et ses dossiers) dans un dossier de bot. */
function deposer(stateDir: string, id: string, relatif: string, contenu = "x"): void {
  const chemin = join(stateDir, "bots", id, relatif);
  mkdirSync(join(chemin, ".."), { recursive: true });
  writeFileSync(chemin, contenu);
}

describe("① `POST /api/bots`", () => {
  it("crée le dossier, l'entrée du registre et l'overlay, puis la liste le montre", async () => {
    const b = banc();
    const creation = await appel(b, "POST", "/api/bots", { nom: "Kohai" });
    expect(creation.status).toBe(201);
    // ⚠️ CRÉATION SIMPLE : le slug est DÉRIVÉ, les capacités sont VIDES, et aucun
    // `profil` n'est renvoyé.
    expect(creation.body.bot).toEqual({
      id: "kohai",
      nom: "Kohai",
      capacites: [],
      actif: false,
      ordre: 1,
    });
    expect(creation.body.bot).not.toHaveProperty("profil");
    // Dossier + overlay explicite.
    expect(existsSync(join(b.stateDir, "bots", "kohai", "config.overlay.json"))).toBe(true);
    // ⚠️ Le registre EN MÉMOIRE suit (sinon `GET /api/bots` ignorerait le bot).
    const liste = await appel(b, "GET", "/api/bots");
    expect(liste.body.bots.map((entree: { id: string }) => entree.id)).toEqual(["yuki", "kohai"]);
    // Et le FICHIER aussi.
    const ecrit = JSON.parse(readFileSync(join(b.stateDir, "bots.json"), "utf8")) as RegistreBots;
    expect(ecrit.bots.map((entree) => entree.id)).toEqual(["yuki", "kohai"]);
  });

  it("exige `X-Yuki-Config: 1` (403) et ne crée RIEN", async () => {
    const b = banc();
    const refus = await appel(b, "POST", "/api/bots", { nom: "Kohai" }, {
      "content-type": "application/json",
    });
    expect(refus.status).toBe(403);
    expect(existsSync(join(b.stateDir, "bots", "kohai"))).toBe(false);
  });

  it("DÉRIVE le slug du nom : un nom déjà pris reçoit un slug suffixé (pas de 409)", async () => {
    const b = banc();
    // ⚠️ Deux bots peuvent porter le même NOM : seul le slug est unique.
    const creation = await appel(b, "POST", "/api/bots", { nom: "Yuki" });
    expect(creation.status).toBe(201);
    expect(creation.body.bot.id).toBe("yuki-2");
    expect(creation.body.bot.nom).toBe("Yuki");
    // Un nom vide est REFUSÉ (400), et rien n'est créé.
    const vide = await appel(b, "POST", "/api/bots", { nom: "   " });
    expect(vide.status).toBe(400);
    expect(vide.body.code).toBe("nom_invalide");
    // ⚠️ Un `slug` dans le corps est IGNORÉ (le champ n'existe plus côté serveur).
    const ignore = await appel(b, "POST", "/api/bots", { nom: "Nova", slug: "autre" });
    expect(ignore.status).toBe(201);
    expect(ignore.body.bot.id).toBe("nova");
  });

  it(`refuse le 7ᵉ bot : 409 max_bots en NOMMANT la limite (${MAX_BOTS})`, async () => {
    const bots = Array.from({ length: MAX_BOTS }, (_, index) => bot(`bot${index}`, index));
    const b = banc(bots);
    const refus = await appel(b, "POST", "/api/bots", { nom: "Trop" });
    expect(refus.status).toBe(409);
    expect(refus.body.code).toBe("max_bots");
    expect(String(refus.body.message)).toContain(String(MAX_BOTS));
    expect(existsSync(join(b.stateDir, "bots", "trop"))).toBe(false);
  });

  it("CLONE : identité + capacités par défaut, NI mémoire NI déclencheurs", async () => {
    const b = banc();
    deposer(b.stateDir, "yuki", "personality.md", "# Yuki\n");
    deposer(b.stateDir, "yuki", "rules.md", "- règle\n");
    deposer(b.stateDir, "yuki", "avatar/avatar.png", "png");
    deposer(b.stateDir, "yuki", "config.overlay.json", '{ "tts.voice": "flocon" }\n');
    deposer(b.stateDir, "yuki", "memory.jsonl", '{"texte":"souvenir"}\n');
    deposer(b.stateDir, "yuki", "sources.json", '{"schemaVersion":2,"sources":[]}');
    deposer(b.stateDir, "yuki", "chat-mirror.json", "{}");
    deposer(b.stateDir, "yuki", "chat-mirror/canal/c.json", "{}");
    deposer(b.stateDir, "yuki", "preautorisations.json", "{}");
    deposer(b.stateDir, "yuki", "envois-programmes.json", "{}");

    const creation = await appel(b, "POST", "/api/bots", { nom: "Clone", cloneDe: "yuki" });
    expect(creation.status).toBe(201);
    const clone = join(b.stateDir, "bots", "clone");
    expect(readFileSync(join(clone, "personality.md"), "utf8")).toBe("# Yuki\n");
    expect(readFileSync(join(clone, "config.overlay.json"), "utf8")).toContain("flocon");
    // Décochés par défaut.
    expect(existsSync(join(clone, "memory.jsonl"))).toBe(false);
    expect(existsSync(join(clone, "sources.json"))).toBe(false);
    // ⚠️ JAMAIS copiés.
    expect(existsSync(join(clone, "chat-mirror.json"))).toBe(false);
    expect(existsSync(join(clone, "chat-mirror"))).toBe(false);
    expect(existsSync(join(clone, "preautorisations.json"))).toBe(false);
    expect(existsSync(join(clone, "envois-programmes.json"))).toBe(false);
  });

  it("refuse la création quand le registre n'existe pas (mode mono-bot)", async () => {
    const b = banc();
    b.deps.bots!.registre = null;
    const refus = await appel(b, "POST", "/api/bots", { nom: "Kohai" });
    expect(refus.status).toBe(409);
    expect(refus.body.code).toBe("registre_absent");
  });
});

describe("② `DELETE /api/bots/<id>`", () => {
  it("DÉPLACE le dossier dans bots-supprimes/<slug>-<date>/ (fichiers intacts)", async () => {
    const b = banc([bot("yuki", 0, true), bot("kohai", 1)]);
    deposer(b.stateDir, "kohai", "memory.jsonl", '{"texte":"souvenir"}\n');
    const suppression = await appel(b, "DELETE", "/api/bots/kohai");
    expect(suppression.status).toBe(200);
    expect(suppression.body.archive).toMatch(
      new RegExp(`${SOUS_DOSSIER_SUPPRIMES}/kohai-\\d{8}-\\d{4}$`),
    );
    // Dossier d'origine parti, archive présente et INTACTE.
    expect(existsSync(join(b.stateDir, "bots", "kohai"))).toBe(false);
    expect(readFileSync(join(suppression.body.archive, "memory.jsonl"), "utf8")).toContain(
      "souvenir",
    );
    // Liste à jour + rétention annoncée.
    expect(suppression.body.bots.map((entree: { id: string }) => entree.id)).toEqual(["yuki"]);
    expect(suppression.body.retentionJours).toBe(90);
    expect(suppression.body.rechargementRequis).toBe(false);
  });

  it("refuse le DERNIER bot (`409 last_bot`) sans rien déplacer", async () => {
    const b = banc();
    deposer(b.stateDir, "yuki", "memory.jsonl", "x\n");
    const refus = await appel(b, "DELETE", "/api/bots/yuki");
    expect(refus.status).toBe(409);
    expect(refus.body.code).toBe("dernier_bot");
    expect(existsSync(join(b.stateDir, "bots", "yuki", "memory.jsonl"))).toBe(true);
  });

  it("bot ACTIF supprimé ⇒ bascule sur le suivant + redémarrage requis", async () => {
    const b = banc([bot("yuki", 0, true), bot("kohai", 1)]);
    deposer(b.stateDir, "yuki", "memory.jsonl", "x\n");
    const suppression = await appel(b, "DELETE", "/api/bots/yuki");
    expect(suppression.status).toBe(200);
    expect(suppression.body.botActifSuivant).toBe("kohai");
    expect(suppression.body.rechargementRequis).toBe(true);
    expect(suppression.body.bots[0]).toMatchObject({ id: "kohai", actif: true });
  });

  it("exige `X-Yuki-Config: 1` et répond 404 pour un bot inconnu", async () => {
    const b = banc([bot("yuki", 0, true), bot("kohai", 1)]);
    const sansEntete = await appel(b, "DELETE", "/api/bots/kohai", undefined, {
      "content-type": "application/json",
    });
    expect(sansEntete.status).toBe(403);
    const inconnu = await appel(b, "DELETE", "/api/bots/fantome");
    expect(inconnu.status).toBe(404);
    expect(inconnu.body.code).toBe("bot_not_found");
  });
});

describe("②bis `PATCH /api/bots/<id>` — nom et capacités (lot 35h)", () => {
  it("enregistre les CAPACITÉS cochées et les renvoie dans la liste", async () => {
    const b = banc([bot("yuki", 0, true), { ...bot("kohai", 1), capacites: [] }]);
    const reponse = await appel(b, "PATCH", "/api/bots/kohai", {
      capacites: ["agents", "execution"],
    });
    expect(reponse.status).toBe(200);
    expect(reponse.body.bot).toEqual({
      id: "kohai",
      nom: "kohai",
      capacites: ["agents", "execution"],
      actif: false,
      ordre: 1,
    });
    // ⚠️ Le bot n'est PAS le bot actif : aucun redémarrage nécessaire.
    expect(reponse.body.rechargementRequis).toBe(false);
    // Le FICHIER porte les capacités (source = disque), et la liste suit.
    const ecrit = JSON.parse(readFileSync(join(b.stateDir, "bots.json"), "utf8")) as RegistreBots;
    expect(ecrit.bots.find((entree) => entree.id === "kohai")?.capacites).toEqual([
      "agents",
      "execution",
    ]);
    const liste = await appel(b, "GET", "/api/bots");
    expect(liste.body.bots[1].capacites).toEqual(["agents", "execution"]);
  });

  it("changer les capacités du bot ACTIF annonce un REDÉMARRAGE requis", async () => {
    const b = banc([bot("yuki", 0, true), bot("kohai", 1)]);
    const reponse = await appel(b, "PATCH", "/api/bots/yuki", { capacites: [] });
    expect(reponse.status).toBe(200);
    // ⚠️ Le gateway en cours a lu les capacités de `yuki` à son démarrage : le
    // dire, plutôt que de laisser croire à une application immédiate.
    expect(reponse.body.rechargementRequis).toBe(true);
  });

  it("`nom` et `capacites` dans le même appel : les deux sont écrits", async () => {
    const b = banc([bot("yuki", 0, true), bot("kohai", 1)]);
    const reponse = await appel(b, "PATCH", "/api/bots/kohai", {
      nom: "  Nébula  ",
      capacites: ["envoi"],
    });
    expect(reponse.status).toBe(200);
    expect(reponse.body.bot.nom).toBe("Nébula");
    expect(reponse.body.bot.capacites).toEqual(["envoi"]);
    // ⚠️ Le slug ne bouge JAMAIS.
    expect(reponse.body.bot.id).toBe("kohai");
  });

  it("une CAPACITÉ INCONNUE est refusée (400) et n'écrit RIEN", async () => {
    const b = banc([bot("yuki", 0, true), { ...bot("kohai", 1), capacites: ["envoi"] }]);
    const refus = await appel(b, "PATCH", "/api/bots/kohai", { capacites: ["tout"] });
    expect(refus.status).toBe(400);
    expect(refus.body.code).toBe("capacite_inconnue");
    expect(String(refus.body.message)).toContain("tout");
    const liste = await appel(b, "GET", "/api/bots");
    expect(liste.body.bots[1].capacites).toEqual(["envoi"]);
  });

  it("exige `X-Yuki-Config: 1`, refuse un corps non-objet et un bot inconnu", async () => {
    const b = banc([bot("yuki", 0, true), bot("kohai", 1)]);
    const sansEntete = await appel(b, "PATCH", "/api/bots/kohai", { capacites: [] }, {
      "content-type": "application/json",
    });
    expect(sansEntete.status).toBe(403);
    const liste = await appel(b, "PATCH", "/api/bots/kohai", []);
    expect(liste.status).toBe(400);
    const inconnu = await appel(b, "PATCH", "/api/bots/fantome", { capacites: [] });
    expect(inconnu.status).toBe(404);
    expect(inconnu.body.code).toBe("bot_not_found");
  });

  it("`PATCH` sans champ : rien ne change (patch, pas remplacement)", async () => {
    const b = banc([bot("yuki", 0, true), { ...bot("kohai", 1), capacites: ["images"] }]);
    const reponse = await appel(b, "PATCH", "/api/bots/kohai", {});
    expect(reponse.status).toBe(200);
    expect(reponse.body.bot.capacites).toEqual(["images"]);
    expect(reponse.body.bot.nom).toBe("kohai");
  });
});

describe("③ `GET /api/bots/<id>/donnees`", () => {
  it("rend les compteurs réels et la rétention de 90 jours", async () => {
    const b = banc();
    deposer(b.stateDir, "yuki", "memory.jsonl", '{"a":1}\n{"b":2}\n');
    deposer(b.stateDir, "yuki", "sources.json", '{"schemaVersion":2,"sources":[{},{}]}');
    deposer(b.stateDir, "yuki", "conversations-archive/c1.json", "{}");
    const reponse = await appel(b, "GET", "/api/bots/yuki/donnees");
    expect(reponse.status).toBe(200);
    expect(reponse.body.compteurs).toMatchObject({
      conversations: 1,
      souvenirs: 2,
      declencheurs: 2,
    });
    expect(reponse.body.compteurs.octets).toBeGreaterThan(0);
    expect(reponse.body.retentionJours).toBe(90);
  });

  it("bot inconnu ⇒ 404 qui le nomme", async () => {
    const b = banc();
    const reponse = await appel(b, "GET", "/api/bots/fantome/donnees");
    expect(reponse.status).toBe(404);
    expect(reponse.body.botId).toBe("fantome");
  });
});
