/**
 * LOT 35i — MÉMOIRE PAR BOT : ISOLATION ET CHEMIN DE CONSTRUCTION UNIQUE.
 *
 * ⚠️ Ces tests ÉCHOUENT sur le code d'origine : `src/memory/stores-bot.ts`
 * n'existait pas (`git show HEAD:src/memory/index.ts`), et `src/index.ts`
 * ouvrait `MemoryStore` / `MemoryIndex` directement sur `env.memoryStorePath`.
 *
 * Ce qui est prouvé :
 *  ① une mémoire écrite pour `yuki` est INVISIBLE pour un autre bot (fichiers
 *    distincts, store vide, index muet) — c'est le test central du lot ;
 *  ② les stores naissent de `pathsForBot` : leurs chemins sont SOUS la racine du
 *    bot (`<state>/bots/<id>/`), y compris les sessions (`<pi>/agent/sessions/<id>`) ;
 *  ③ la résolution est REFUSÉE pour un identifiant qui n'est pas un nom de
 *    dossier sûr ;
 *  ④ `pathsForBot` attend l'`Env` d'INSTANCE : le résoudre deux fois n'empile
 *    pas les dossiers (garde de `envPourBot`) ;
 *  ⑤ GARDE DE SOURCE : aucun module hors `src/memory/stores-bot.ts` n'ouvre un
 *    `MemoryStore`/`MemoryIndex` (sinon un chemin non résolu par bot rentrerait
 *    par la porte de service).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadEnv, type Env } from "../../src/config/env.js";
import { cheminsBot, pathsForBot } from "../../src/bots/paths.js";
import {
  FabriqueMemoireBots,
  StoresMemoireError,
  envPourBot,
  ouvrirStoresMemoireBot,
  type StoresMemoireBot,
} from "../../src/memory/index.js";

const racines: string[] = [];
const ouverts: StoresMemoireBot[] = [];

afterEach(() => {
  for (const stores of ouverts.splice(0)) stores.fermer();
  for (const racine of racines.splice(0)) rmSync(racine, { recursive: true, force: true });
});

const journal = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

interface Banc {
  racine: string;
  state: string;
  sessions: string;
  env: Env;
}

function banc(): Banc {
  const racine = mkdtempSync(join(tmpdir(), "yuki-memoire-bots-"));
  racines.push(racine);
  const state = join(racine, "state");
  const sessions = join(racine, "pi", "agent", "sessions");
  mkdirSync(state, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  const env = loadEnv({
    YUKI_MOUNT_STATE: state,
    YUKI_MOUNT_PI_AGENT: join(racine, "pi"),
    YUKI_LOG_LEVEL: "error",
  });
  return { racine, state, sessions, env };
}

/** Ouvre les stores d'un bot par le CHEMIN UNIQUE du produit. */
function ouvrir(b: Banc, botId: string, mode: "mono" | "multi" = "multi"): StoresMemoireBot {
  const stores = ouvrirStoresMemoireBot({
    env: envPourBot({ envInstance: b.env, botId, mode, processEnv: {} }),
    botId,
    logger: journal,
  });
  ouverts.push(stores);
  return stores;
}

describe("① isolation — la mémoire d'un bot n'est pas celle d'un autre", () => {
  it("une mémoire écrite pour `yuki` est INVISIBLE pour `kohai`", () => {
    const b = banc();
    const yuki = ouvrir(b, "yuki");
    const kohai = ouvrir(b, "kohai");

    // Deux fichiers DIFFÉRENTS, chacun sous la racine de son bot.
    expect(yuki.fichier).toBe(join(b.state, "bots", "yuki", "memory.jsonl"));
    expect(kohai.fichier).toBe(join(b.state, "bots", "kohai", "memory.jsonl"));
    expect(yuki.fichier).not.toBe(kohai.fichier);

    const ajout = yuki.store.add({
      text: "L'utilisateur préfère les réponses courtes et le fuseau Europe/Paris.",
      source: "conversation:test",
      cat: "preference",
    });
    expect(ajout.created).toBe(true);
    expect(yuki.store.size).toBe(1);

    // ⚠️ Le cœur du lot : AUCUN accès croisé, ni par le store, ni par le disque.
    expect(kohai.store.size).toBe(0);
    expect(kohai.store.entries).toEqual([]);
    expect(kohai.index.search("réponses courtes", 5)).toEqual([]);
    expect(readFileSync(kohai.fichier, "utf8")).not.toContain("Europe/Paris");
    expect(existsSync(join(b.state, "bots", "kohai"))).toBe(true);

    // Réouverture de `kohai` depuis le disque : toujours rien.
    const relecture = ouvrir(b, "kohai");
    expect(relecture.store.size).toBe(0);

    // L'index de `yuki`, lui, retrouve bien SON souvenir (l'index est DÉRIVÉ :
    // il se reconstruit depuis le journal de CE bot, et de lui seul).
    yuki.index.rebuild(yuki.store.entries);
    expect(yuki.index.search("Europe/Paris", 5).length).toBe(1);
    expect(kohai.index.search("Europe/Paris", 5)).toEqual([]);
  });

  it("les SESSIONS Pi sont par bot (`<pi>/agent/sessions/<id>`), pas partagées", () => {
    const b = banc();
    const yuki = ouvrir(b, "yuki");
    const kohai = ouvrir(b, "kohai");
    expect(yuki.env.piSessionsDir).toBe(join(b.sessions, "yuki"));
    expect(kohai.env.piSessionsDir).toBe(join(b.sessions, "kohai"));
    expect(cheminsBot(b.env, "yuki").sessions).toBe(join(b.sessions, "yuki"));
  });
});

describe("② les stores naissent de `pathsForBot` (aucun chemin en dur)", () => {
  it("TOUS les chemins mémoire sont SOUS la racine du bot", () => {
    const b = banc();
    const stores = ouvrir(b, "kohai");
    const attendu = pathsForBot(b.env, "kohai", { processEnv: {} });
    const racine = join(b.state, "bots", "kohai");
    for (const cle of [
      "memoryStorePath",
      "memoryIndexPath",
      "memoryConsolidationDir",
      "memoryConsolidationStatePath",
      "heritageDir",
      "conversationArchiveDir",
      "conversationArchiveIndexPath",
    ] as const) {
      const chemin = stores.env[cle];
      expect(chemin, cle).toBe(attendu.env[cle]);
      expect(chemin.startsWith(`${racine}/`), `${cle} hors de la racine du bot`).toBe(true);
    }
    // Le dossier du bot est bien CRÉÉ par l'ouverture (jamais un dossier partagé).
    expect(existsSync(racine)).toBe(true);
  });

  it("un identifiant qui n'est pas un nom de dossier sûr est REFUSÉ", () => {
    const b = banc();
    for (const mauvais of ["../yuki", "Yuki", "you ki", ""]) {
      expect(() =>
        envPourBot({ envInstance: b.env, botId: mauvais, mode: "multi", processEnv: {} }),
      ).toThrowError(StoresMemoireError);
    }
    // Aucun dossier de bot n'a été créé : la résolution refuse AVANT d'écrire.
    expect(readdirSync(b.state)).toEqual([]);
  });

  it("`pathsForBot` attend l'env d'INSTANCE : le résoudre deux fois n'empile pas les dossiers", () => {
    const b = banc();
    // `envPourBot` est IDEMPOTENT : il repart toujours de l'env d'instance.
    const une = envPourBot({ envInstance: b.env, botId: "yuki", mode: "multi", processEnv: {} });
    const deux = envPourBot({ envInstance: b.env, botId: "yuki", mode: "multi", processEnv: {} });
    expect(deux.piSessionsDir).toBe(une.piSessionsDir);
    expect(une.piSessionsDir).toBe(join(b.sessions, "yuki"));
  });

  it("mode mono-bot historique : les chemins HISTORIQUES sont conservés tels quels", () => {
    const b = banc();
    const stores = ouvrir(b, "yuki", "mono");
    expect(stores.fichier).toBe(join(b.state, "memory.jsonl"));
    expect(stores.env.piSessionsDir).toBe(join(b.sessions));
  });
});

describe("③ fabrique — un seul jeu de stores par bot", () => {
  it("deux appels rendent le MÊME store (un seul rédacteur par `memory.jsonl`)", () => {
    const b = banc();
    const fabrique = new FabriqueMemoireBots({
      envInstance: b.env,
      mode: "multi",
      logger: journal,
      processEnv: {},
    });
    const premier = fabrique.storesDe("yuki");
    const second = fabrique.storesDe("yuki");
    expect(second).toBe(premier);
    expect(fabrique.botsOuverts).toEqual(["yuki"]);

    fabrique.storesDe("kohai");
    expect(fabrique.botsOuverts.sort()).toEqual(["kohai", "yuki"]);
    fabrique.fermerTout();
    expect(fabrique.botsOuverts).toEqual([]);
  });
});

describe("⑤ garde de source — aucun store mémoire hors du chemin résolu", () => {
  it("`MemoryStore.open` / `new MemoryIndex` n'existent QUE dans `src/memory/stores-bot.ts`", () => {
    const fichiers = fichiersSource(join(process.cwd(), "src"));
    const interdits = fichiers.filter((fichier) => {
      if (fichier.endsWith(join("src", "memory", "stores-bot.ts"))) return false;
      // Les CLASSES elles-mêmes (définition + tests internes) sont légitimes.
      if (fichier.endsWith(join("src", "memory", "store.ts"))) return false;
      if (fichier.endsWith(join("src", "memory", "index-db.ts"))) return false;
      const texte = readFileSync(fichier, "utf8");
      return /MemoryStore\.open\(|new MemoryIndex\(/.test(texte);
    });
    expect(interdits.map((fichier) => relative(process.cwd(), fichier))).toEqual([]);
  });

  it("`src/index.ts` ouvre la mémoire par la fabrique, jamais sur un chemin d'env", () => {
    const source = readFileSync(join(process.cwd(), "src", "index.ts"), "utf8");
    expect(source).toContain("ouvrirStoresMemoireBot({");
    expect(source).not.toContain("MemoryStore.open(");
    expect(source).not.toContain("new MemoryIndex(");
    // ⚠️ Tous les chemins de la mémoire passent par `storesMemoire.env`, c'est-à-dire
    // par l'`Env` RÉSOLU du bot : aucune lecture directe de l'env brut.
    for (const cle of [
      "memoryStorePath",
      "memoryIndexPath",
      "memoryConsolidationDir",
      "memoryConsolidationStatePath",
      "heritageDir",
      "conversationArchiveDir",
      "conversationArchiveIndexPath",
    ]) {
      // `storesMemoire.env.<cle>` est ACCEPTÉ (c'est l'env résolu du bot) ; `env.<cle>`
      // tout court, non.
      const direct = new RegExp(`(?<![\\w.])env\\.${cle}\\b`);
      expect(direct.test(source), `env.${cle} lu directement`).toBe(false);
    }
  });
});

/** Liste récursive des fichiers `.ts` d'un dossier. */
function fichiersSource(dir: string): string[] {
  const sortie: string[] = [];
  for (const entree of readdirSync(dir, { withFileTypes: true })) {
    const complet = join(dir, entree.name);
    if (entree.isDirectory()) {
      sortie.push(...fichiersSource(complet));
      continue;
    }
    if (entree.name.endsWith(".ts")) sortie.push(complet);
  }
  return sortie;
}
