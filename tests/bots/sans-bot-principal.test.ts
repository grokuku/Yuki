/**
 * LOT 45 — « YUKI DOIT ÊTRE SUPPRIMABLE COMME N'IMPORTE QUEL BOT ».
 *
 * ⚠️ EXIGENCE UTILISATEUR (2026-11-13 19:03), citation exacte :
 * « en fait j'aimerais que l'on ait plus cette notion de bot principal. C'est pas
 * impossible qu'un jour je supprime Yuki et ne garde que les autres. »
 *
 * Ce que ce fichier verrouille :
 *  ① UNE SEULE règle de résolution du bot courant : bot DEMANDÉ s'il existe →
 *    sinon PREMIER par `ordre` (puis `id`) → sinon erreur explicite. Aucun
 *    identifiant privilégié, aucune valeur par défaut en dur ;
 *  ② `preparerMultiBot` N'ÉLIT PLUS de « principal » : le bot du run est le
 *    premier à démarrer, et `yuki` n'a aucun statut ;
 *  ③ SUPPRIMER `yuki` fonctionne : elle n'est pas recréée, les autres bots
 *    tournent, le bot courant devient le premier par `ordre` ;
 *  ④ les GARDES DE DÉMARRAGE ET DE SUPPRESSION restent (`dernier_bot_actif`,
 *    `last_bot`, `MIGRATION_*`, `REGISTRE_INVALIDE`) ;
 *  ⑤ aucune occurrence de `?? BOT_YUKI` / `?? "yuki"` ne subsiste dans `src/`, et
 *    `BOT_YUKI` n'est plus employée que par la migration et la compatibilité des
 *    noms de secrets.
 *
 * ⚠️ Échoue sur le code d'origine :
 *  - `resoudreBotCourant` / `BotCourantError` n'existent pas (`src/bots/courant.ts`) ;
 *  - `botActif` y privilégie TOUJOURS `yuki` (même éteinte) ;
 *  - `preparerMultiBot` y rend un `principal` élu par identité, et deux
 *    avertissements nomment `yuki` ;
 *  - `preparerMultiBot` y rend `bot: null` en mode mono-bot.
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AdminBotError, definirActif, supprimerBot } from "../../src/bots/admin.js";
import {
  BotCourantError,
  botActif,
  botsParOrdre,
  cheminRegistreBots,
  ecrireRegistreBots,
  lireRegistreBots,
  preparerMultiBot,
  resoudreBotCourant,
  resoudreDemarrageBots,
  type BotRecord,
  type RegistreBots,
} from "../../src/bots/index.js";
import { loadEnv, type Env } from "../../src/config/env.js";

const racines: string[] = [];

afterEach(() => {
  for (const racine of racines.splice(0)) rmSync(racine, { recursive: true, force: true });
});

function bot(id: string, ordre: number, actif = true): BotRecord {
  return {
    id,
    nom: id,
    capacites: [],
    actif,
    ordre,
    creeLe: "2026-01-01T00:00:00.000Z",
    plateformes: {},
  };
}

function registre(bots: BotRecord[]): RegistreBots {
  return { schemaVersion: 1, bots, echanges: {} };
}

interface Fixture {
  racine: string;
  state: string;
  env: Env;
}

/** Volumes vides (aucun chemin d'origine) + `bots.json` écrit à la main. */
function fixture(bots: BotRecord[]): Fixture {
  const racine = mkdtempSync(join(tmpdir(), "yuki-sans-principal-"));
  racines.push(racine);
  const state = join(racine, "state");
  mkdirSync(state, { recursive: true });
  mkdirSync(join(racine, "pi", "agent", "sessions"), { recursive: true });
  const env = loadEnv({
    YUKI_MOUNT_STATE: state,
    YUKI_MOUNT_PI_AGENT: join(racine, "pi"),
    YUKI_CONFIG_STORE_PATH: join(state, "config.json"),
    YUKI_LOG_LEVEL: "error",
  });
  ecrireRegistreBots(cheminRegistreBots(state), registre(bots));
  return { racine, state, env };
}

describe("① UNE SEULE règle de résolution du bot courant", () => {
  it("le bot DEMANDÉ gagne quand il existe", () => {
    const r = registre([bot("yuki", 0), bot("kohai", 1)]);
    expect(resoudreBotCourant(r, "kohai").id).toBe("kohai");
    expect(resoudreBotCourant(r, "  yuki  ").id).toBe("yuki");
  });

  it("⚠️ SANS demande ⇒ PREMIER par `ordre`, JAMAIS `yuki`", () => {
    // ⚠️ Échoue sur l'origine : `botActif` y privilégie `yuki` quel que soit son
    // `ordre`.
    const r = registre([bot("yuki", 5), bot("alpha", 1), bot("kohai", 3)]);
    expect(resoudreBotCourant(r).id).toBe("alpha");
    expect(botActif(r)?.id).toBe("alpha");
    expect(botsParOrdre(r).map((entree) => entree.id)).toEqual(["alpha", "kohai", "yuki"]);
  });

  it("égalité de `ordre` ⇒ `id` (deux redémarrages ne peuvent pas élire deux bots)", () => {
    const r = registre([bot("omega", 2), bot("alpha", 2)]);
    expect(resoudreBotCourant(r).id).toBe("alpha");
  });

  it("un bot DEMANDÉ mais INCONNU ⇒ premier par `ordre` (règle ②), jamais `yuki`", () => {
    const r = registre([bot("kohai", 0), bot("nova", 1)]);
    // ⚠️ Demande d'un bot SUPPRIMÉ (favori partagé, URL ancienne) : la résolution
    // applique la règle ② — le premier par `ordre` — et n'invente AUCUN
    // identifiant. Les ÉCRITURES, elles, refusent un bot inconnu en le nommant
    // (`404 bot_not_found`) : elles ne résolvent pas un « bot courant ».
    expect(resoudreBotCourant(r, "yuki").id).toBe("kohai");
  });

  it("registre VIDE ⇒ erreur explicite « aucun bot »", () => {
    let erreur: unknown;
    try {
      resoudreBotCourant(registre([]));
    } catch (error) {
      erreur = error;
    }
    expect(erreur).toBeInstanceOf(BotCourantError);
    expect((erreur as BotCourantError).code).toBe("aucun_bot");
    expect((erreur as BotCourantError).message).toContain("Aucun bot");
    expect(botActif(registre([]))).toBeNull();
  });

  it("mode mono-bot (`null`) ⇒ le bot HISTORIQUE, résolu par la même fonction", () => {
    // ⚠️ Il n'y a pas de registre : l'identité de cette disposition est le bot
    // historique, et c'est la SEULE valeur non issue du registre.
    expect(resoudreBotCourant(null).id).toBe("yuki");
    expect(resoudreBotCourant(null).capacites.length).toBeGreaterThan(0);
  });
});

describe("② `preparerMultiBot` n'élit plus de « principal »", () => {
  it("aucun champ `principal`, et le bot du run = PREMIER à démarrer", () => {
    const f = fixture([bot("kohai", 0), bot("yuki", 1)]);
    const preparation = preparerMultiBot(f.env, { processEnv: {} });
    expect("principal" in preparation).toBe(false);
    // ⚠️ Échoue sur l'origine : `principal` = `yuki` (privilégiée), et `bot`
    // valait `yuki` parce qu'elle était « le principal ».
    expect(preparation.bot.id).toBe("kohai");
    expect(preparation.aDemarrer.map((entree) => entree.id)).toEqual(["kohai", "yuki"]);
    expect(preparation.avertissements).toEqual([]);
  });

  it("⚠️ `yuki` ÉTEINTE ⇒ AUCUN avertissement spécial (elle n'est plus une identité)", () => {
    const f = fixture([bot("yuki", 0, false), bot("kohai", 1)]);
    const preparation = preparerMultiBot(f.env, { processEnv: {} });
    // ⚠️ Échoue sur l'origine : un avertissement annonçait « Le bot PRINCIPAL est
    // « yuki » mais il est ÉTEINT ».
    expect(preparation.bot.id).toBe("kohai");
    expect(preparation.avertissements.join(" ")).not.toContain("PRINCIPAL");
    expect(preparation.avertissements).toEqual([]);
  });

  it("aucun comportement spécial pour UN identifiant : deux registres symétriques", () => {
    // ⚠️ Le MÊME registre, avec `yuki` et `kohai` échangés, doit produire la même
    // FORME de résultat (mêmes champs, même absence d'avertissement, chemins du
    // premier bot). Aucun identifiant n'est traité différemment.
    const avecYuki = preparerMultiBot(fixture([bot("yuki", 0), bot("kohai", 1)]).env, {
      processEnv: {},
    });
    const sansYuki = preparerMultiBot(fixture([bot("kohai", 0), bot("yuki", 1)]).env, {
      processEnv: {},
    });
    expect(Object.keys(avecYuki).sort()).toEqual(Object.keys(sansYuki).sort());
    expect(avecYuki.bot.id).toBe("yuki");
    expect(sansYuki.bot.id).toBe("kohai");
    expect(avecYuki.avertissements).toEqual(sansYuki.avertissements);
    expect(avecYuki.mode).toBe(sansYuki.mode);
  });

  it("mono-bot (`bots.json` absent + migration désactivée) ⇒ bot du run NON nul", () => {
    // ⚠️ Échoue sur l'origine : `bot` y valait `null`, ce qui forçait chaque
    // appelant à un repli `?? BOT_YUKI`.
    const racine = mkdtempSync(join(tmpdir(), "yuki-sans-principal-mono-"));
    racines.push(racine);
    mkdirSync(join(racine, "state"), { recursive: true });
    mkdirSync(join(racine, "pi", "agent", "sessions"), { recursive: true });
    const env = loadEnv({
      YUKI_MOUNT_STATE: join(racine, "state"),
      YUKI_MOUNT_PI_AGENT: join(racine, "pi"),
      YUKI_CONFIG_STORE_PATH: join(racine, "state", "config.json"),
      YUKI_LOG_LEVEL: "error",
    });
    const preparation = preparerMultiBot(env, {
      processEnv: {},
      migrationAutomatique: false,
    });
    expect(preparation.mode).toBe("mono");
    expect(preparation.bot.id).toBe("yuki");
    expect(preparation.registre).toBeNull();
    expect(preparation.aDemarrer).toEqual([]);
  });
});

describe("③ SUPPRIMER `yuki` ⇒ l'instance tourne avec les autres", () => {
  /** Supprime `yuki` d'un registre à trois bots (elle est le bot du run). */
  function supprimerYuki(f: Fixture): { ids: string[]; actifs: string[] } {
    const avant = lireRegistreBots(cheminRegistreBots(f.state));
    expect(avant).not.toBeNull();
    const resultat = supprimerBot({
      stateDir: f.state,
      registre: avant as RegistreBots,
      botId: "yuki",
      piSessionsDir: join(f.racine, "pi", "agent", "sessions"),
    });
    // ⚠️ Le bot du run (`yuki`) part : le premier RESTANT est promu actif, sans
    // quoi le démarrage suivant refuserait (`AUCUN_BOT_ACTIF`).
    expect(resultat.botActifSuivant).toBe("kohai");
    const apres = lireRegistreBots(cheminRegistreBots(f.state)) as RegistreBots;
    return {
      ids: apres.bots.map((entree) => entree.id),
      actifs: apres.bots.filter((entree) => entree.actif).map((entree) => entree.id),
    };
  }

  it("⚠️ LE TEST CENTRAL : registre sans `yuki` ⇒ démarrage NORMAL, autres bots servis", () => {
    const f = fixture([bot("yuki", 0), bot("kohai", 1), bot("nova", 2)]);
    const { ids, actifs } = supprimerYuki(f);
    // 1. Elle n'est PAS recréée et ne laisse aucun fantôme.
    expect(ids).toEqual(["kohai", "nova"]);
    expect(actifs).toContain("kohai");

    // 2. Le démarrage passe (aucun refus `AUCUN_BOT_ACTIF`).
    const preparation = preparerMultiBot(f.env, { processEnv: {} });
    expect(preparation.mode).toBe("multi");
    expect(preparation.registre?.bots.map((entree) => entree.id)).toEqual([
      "kohai",
      "nova",
    ]);
    // 3. Les bots RESTANTS tournent tous.
    expect(preparation.aDemarrer.map((entree) => entree.id)).toEqual(["kohai", "nova"]);
    // 4. Le bot courant est le PREMIER par `ordre` — l'UI bascule dessus.
    expect(preparation.bot.id).toBe("kohai");
    expect(resoudreBotCourant(preparation.registre).id).toBe("kohai");
    // 5. Ses chemins sont les siens (aucun repli vers le dossier de `yuki`).
    expect(preparation.env.piSessionsDir).toBe(join(f.racine, "pi", "agent", "sessions", "kohai"));
    // 6. Et plus aucun avertissement ne parle d'elle.
    expect(preparation.avertissements).toEqual([]);
  });

  it("une URL qui demande encore `yuki` (favori partagé) affiche le premier bot", () => {
    const f = fixture([bot("yuki", 0), bot("kohai", 1)]);
    supprimerYuki(f);
    const apres = lireRegistreBots(cheminRegistreBots(f.state));
    // ⚠️ L'URL ancienne ne produit pas un écran mort — ET ne ressuscite pas
    // `yuki` : elle retombe sur le premier bot du registre (règle ②).
    expect(resoudreBotCourant(apres, "yuki").id).toBe("kohai");
    expect(resoudreBotCourant(apres).id).toBe("kohai");
  });

  it("`yuki` SEULE reste insupprimable (`409 last_bot` — garde CONSERVÉE)", () => {
    const f = fixture([bot("yuki", 0)]);
    const registreSeul = lireRegistreBots(cheminRegistreBots(f.state)) as RegistreBots;
    let erreur: unknown;
    try {
      supprimerBot({ stateDir: f.state, registre: registreSeul, botId: "yuki" });
    } catch (error) {
      erreur = error;
    }
    expect(erreur).toBeInstanceOf(AdminBotError);
    expect((erreur as AdminBotError).code).toBe("dernier_bot");
    expect((erreur as AdminBotError).status).toBe(409);
    // Rien n'a bougé : le registre est intact.
    expect((lireRegistreBots(cheminRegistreBots(f.state)) as RegistreBots).bots).toHaveLength(1);
  });

  it("éteindre le DERNIER bot actif reste refusé (`409 dernier_bot_actif`)", () => {
    const f = fixture([bot("kohai", 0), bot("nova", 1, false)]);
    const r = lireRegistreBots(cheminRegistreBots(f.state)) as RegistreBots;
    let erreur: unknown;
    try {
      definirActif({ stateDir: f.state, registre: r, botId: "kohai", actif: false });
    } catch (error) {
      erreur = error;
    }
    expect(erreur).toBeInstanceOf(AdminBotError);
    expect((erreur as AdminBotError).code).toBe("dernier_bot_actif");
  });

  it("registre SANS `yuki` ⇒ `botActif` et le démarrage ne l'inventent pas", () => {
    const r = registre([bot("kohai", 0), bot("nova", 1)]);
    expect(botActif(r)?.id).toBe("kohai");
    const resolution = resoudreDemarrageBots(r);
    expect(resolution.botCourant?.id).toBe("kohai");
    expect(resolution.aDemarrer.map((entree) => entree.id)).toEqual(["kohai", "nova"]);
  });
});

// --- ④ et ⑤ : gardes STRUCTURELLES sur le code source ---------------------

const SRC = join(process.cwd(), "src");

function fichiersSource(dossier: string = SRC): string[] {
  const sortie: string[] = [];
  for (const entree of readdirSync(dossier)) {
    const chemin = join(dossier, entree);
    if (statSync(chemin).isDirectory()) sortie.push(...fichiersSource(chemin));
    else if (chemin.endsWith(".ts")) sortie.push(chemin);
  }
  return sortie;
}

/**
 * Fichiers AUTORISÉS à nommer `BOT_YUKI`, et pourquoi :
 *  - `src/bots/registry.ts` : la constante elle-même ;
 *  - `src/bots/migrate.ts` : la MIGRATION du lot 35a (l'ancien dossier mono-bot) ;
 *  - `src/bots/registry.ts` (`creerRegistreInitial`) : le registre de la migration ;
 *  - `src/bots/courant.ts` : le bot HISTORIQUE du mode mono-bot ;
 *  - `src/bots/index.ts` : le dossier d'ORIGINE des sessions (migration) ;
 *  - `src/sources/par-bot.ts`, `src/chat/jetons-bot.ts` : anciens noms de SECRETS
 *    acceptés en plus des noms par bot (compatibilité 35j) ;
 *  - `src/config/overlay.ts` : le commentaire de verrou de `BOT_ID_DEFAUT`.
 */
const FICHIERS_HISTORIQUE = new Set([
  "src/bots/registry.ts",
  "src/bots/migrate.ts",
  "src/bots/courant.ts",
  "src/bots/index.ts",
  "src/sources/par-bot.ts",
  "src/chat/jetons-bot.ts",
  "src/config/overlay.ts",
]);

describe("④ aucune valeur « yuki » par défaut dans le code source", () => {
  it("⚠️ AUCUN `?? BOT_YUKI` ni `?? \"yuki\"` dans `src/`", () => {
    // ⚠️ Seule exception NOMMÉE : la MIGRATION du lot 35a. `creerRegistreInitial`
    // et `migrerVersMultiBot` reçoivent `options.botId` du dossier HISTORIQUE
    // (« yuki ») : c'est la seule disposition où cet identifiant a un sens, et
    // elle ne s'exécute qu'une fois, à la création de `bots.json`.
    const MIGRATION = new Set(["src/bots/migrate.ts", "src/bots/registry.ts"]);
    const coupables: string[] = [];
    for (const chemin of fichiersSource()) {
      const relatif = chemin.replace(`${SRC}/`, "src/");
      if (MIGRATION.has(relatif)) continue;
      const texte = readFileSync(chemin, "utf8");
      texte.split("\n").forEach((ligne, index) => {
        if (/\?\?\s*BOT_YUKI\b/.test(ligne) || /\?\?\s*"yuki"/.test(ligne)) {
          coupables.push(`${relatif}:${index + 1}`);
        }
      });
    }
    // ⚠️ Échoue sur l'origine : 32 replis `?? BOT_YUKI` y recréaient Yuki (ou
    // pointaient dans son ancien dossier) dès qu'elle avait été supprimée.
    expect(coupables).toEqual([]);
  });

  it("⚠️ `BOT_YUKI` n'est employée que par la MIGRATION et les noms de secrets", () => {
    const coupables: string[] = [];
    for (const chemin of fichiersSource()) {
      const relatif = chemin.replace(`${SRC}/`, "src/");
      if (FICHIERS_HISTORIQUE.has(relatif)) continue;
      if (readFileSync(chemin, "utf8").includes("BOT_YUKI")) coupables.push(relatif);
    }
    expect(coupables).toEqual([]);
  });

  it("plus aucun `botPrincipal` / `principal` ÉLU dans le démarrage ni le transport", () => {
    const index = readFileSync(join(SRC, "index.ts"), "utf8");
    const bots = readFileSync(join(SRC, "bots", "index.ts"), "utf8");
    const actifs = readFileSync(join(SRC, "bots", "actifs.ts"), "utf8");
    // ⚠️ Échoue sur l'origine : `bots.principal`, `demarrage.principal` et un
    // avertissement « Le bot PRINCIPAL … » y existaient.
    expect(index).not.toContain("bots.principal");
    expect(bots).not.toContain("demarrage.principal");
    expect(actifs).not.toContain("principal: botActif");
    expect(actifs).not.toContain("readonly principal");
    // La règle de résolution vit dans UN SEUL module.
    const courant = readFileSync(join(SRC, "bots", "courant.ts"), "utf8");
    expect(courant).toContain("export function resoudreBotCourant");
    expect(actifs).toContain("botCourant: aDemarrer[0] ?? null");
  });
});
