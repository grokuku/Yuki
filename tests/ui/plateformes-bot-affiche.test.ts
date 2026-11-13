/**
 * LOT 43 — LE BANDEAU DES PLATEFORMES PARLE DU BOT AFFICHÉ, PAS DE CELUI DE LA PILE.
 *
 * ⚠️ DÉFAUT SIGNALÉ (3 captures) : sur la conversation du bot `granolaf`, la barre
 * latérale affichait
 *   « Plateformes — Discord est ACTIVÉ mais aucun jeton n'est enregistré :
 *     aucune connexion ne sera ouverte (/bots?b=yuki → Plateformes → …) »
 * alors que la page `/bots?b=granolaf` répondait, elle,
 *   « Un jeton est enregistré pour ce bot sous « YUKI_CHAT_GRANOLAF__DISCORD » ».
 * Deux mensonges d'un coup : un fait FAUX (« aucun jeton ») et un renvoi vers un
 * AUTRE bot (`yuki`).
 *
 * Cause : l'encart et les interrupteurs lisaient `GET /api/chat/status`, route
 * d'INSTANCE qui décrit le bot de la PILE. L'état affiché est maintenant celui du
 * bot AFFICHÉ (interrupteur de SA config, jeton de SON nom au coffre), et l'état
 * de connexion — que le serveur n'expose que pour le bot de la pile — est dit
 * INCONNU au lieu d'être inventé.
 *
 * Ce que ce fichier prouve :
 *  ① bot affiché AVEC jeton ⇒ « jeton enregistré », jamais « aucun jeton » ;
 *  ② le chemin de remédiation porte `/bots?b=<bot affiché>` (aucun `yuki` gravé) ;
 *  ③ bot affiché SANS jeton ⇒ « aucun jeton » (le cas honnête reste dit) ;
 *  ④ coffre illisible ⇒ « état du jeton INCONNU », jamais « aucun jeton » ;
 *  ⑤ l'état de connexion n'est dit en direct QUE pour le bot de la pile ;
 *  ⑥ l'interrupteur écrit chez le bot AFFICHÉ (`PUT /api/bots/<id>/config`) ;
 *  ⑦ le LOCAL reste listé et jamais transformé en choix exclusif.
 *
 * ⚠️ Échoue sur le code d'origine : `plateformes-bot.js` n'existe pas, et
 * `plateformesAvertissements` ne pouvait pas dire « jeton enregistré ».
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  PLATEFORME_OPTIONS,
  badgeFor,
  cheminPlateforme,
  plateformesActives,
  plateformesAvertissements,
  platformsNotice,
  savePlatformEnabled,
} from "../../public/ui/chat-mode.js";
import {
  fetchEtatPlateformes,
  etatPlateformesDepuisFaits,
} from "../../public/ui/plateformes-bot.js";

const read = (name: string): string =>
  readFileSync(join(process.cwd(), "public", "ui", name), "utf8");

/** Champ de configuration, à la forme de `GET /api/bots/<id>/config`. */
function champ(valeur: string) {
  return { value: valeur, scope: "bot" };
}

/** Coffre tel que le renvoie `GET /api/secrets` (noms seuls, jamais de valeur). */
const NOMS_GRANOLAF = ["YUKI_CHAT_GRANOLAF__DISCORD"];

/** Forme de l'état par bot (les modules d'interface sont du JS non typé). */
interface VuePlateforme {
  active: boolean;
  jetonEnregistre: boolean | null;
  plateforme: { etat: string; raison: string };
}
interface EtatPlateformes {
  bot: string;
  botDuRun: string | null;
  connexionConnue: boolean;
  plateformes: Record<string, boolean>;
  mattermost: VuePlateforme;
  discord: VuePlateforme;
  erreur?: string;
}

/** État du bot AFFICHÉ `granolaf` : Discord activé, SON jeton est au coffre. */
function etatGranolaf(): EtatPlateformes {
  return etatPlateformesDepuisFaits({
    botId: "granolaf",
    botDuRun: "yuki",
    champs: {
      "chat.mattermost.enabled": champ("off"),
      "chat.discord.enabled": champ("on"),
    },
    noms: NOMS_GRANOLAF,
    coffreConfigure: true,
  }) as unknown as EtatPlateformes;
}

describe("① bot affiché AVEC jeton ⇒ « jeton enregistré » (jamais « aucun jeton »)", () => {
  it("l'état vient de l'interrupteur et du jeton de CE bot", () => {
    const etat = etatGranolaf();
    expect(etat.bot).toBe("granolaf");
    expect(plateformesActives(etat)).toEqual(["discord"]);
    expect(etat.discord.jetonEnregistre).toBe(true);
    expect(etat.mattermost.jetonEnregistre).toBe(false);

    const phrases = plateformesAvertissements(etat, { botId: etat.bot }).join(" ");
    expect(phrases).toContain("son jeton est enregistré");
    // ⚠️ LE MENSONGE SIGNALÉ : cette phrase ne doit plus apparaître pour un bot
    // dont le jeton existe.
    expect(phrases).not.toContain("aucun jeton n'est enregistré");
    expect(phrases).not.toContain("aucune connexion ne sera ouverte");
  });

  it("le bandeau ne dit jamais « aucun canal » pour un bot qu'on ne peut pas observer", () => {
    const avis = platformsNotice(etatGranolaf(), { nombre: 0, connue: true }, {
      botId: "granolaf",
    });
    expect(avis).toMatchObject({ kind: "inconnu" });
    expect(avis?.titre).toContain("état inconnu");
    expect(avis?.titre).not.toContain("Aucun");
    expect(avis?.detail).toContain("granolaf");
  });
});

describe("② le lien de remédiation porte le bot AFFICHÉ", () => {
  it("chemin, avertissement et encart citent `/bots?b=granolaf`", () => {
    expect(cheminPlateforme("discord", "granolaf")).toBe(
      "/bots?b=granolaf → Plateformes → « Discussions — Discord »",
    );
    const etat = etatGranolaf();
    const phrases = plateformesAvertissements(etat, { botId: "granolaf" }).join(" ");
    expect(phrases).toContain("/bots?b=granolaf → Plateformes → « Discussions — Discord »");
    expect(phrases).not.toContain("b=yuki");

    const avis = platformsNotice(etat, { nombre: 0, connue: true }, { botId: "granolaf" });
    expect(avis?.detail).toContain("/bots?b=granolaf → Plateformes → « Discussions — Discord »");
    expect(avis?.detail).not.toContain("b=yuki");
  });

  it("aucun `yuki` gravé dans les textes de plateforme des DEUX modules", () => {
    for (const fichier of ["chat-mode.js", "plateformes-bot.js", "sessions-panel.js"]) {
      expect(read(fichier)).not.toContain("b=yuki");
    }
    // Les info-bulles sont calculées pour le bot affiché, pas gravées.
    expect(PLATEFORME_OPTIONS.some((option) => "title" in option)).toBe(false);
  });
});

describe("③ bot affiché SANS jeton ⇒ « aucun jeton » (le cas honnête reste dit)", () => {
  it("Discord activé, aucun jeton de CE bot au coffre", () => {
    const etat = etatPlateformesDepuisFaits({
      botId: "logora",
      botDuRun: "yuki",
      champs: { "chat.discord.enabled": champ("on") },
      noms: NOMS_GRANOLAF,
      coffreConfigure: true,
    }) as unknown as EtatPlateformes;
    expect(etat.discord.jetonEnregistre).toBe(false);
    const phrases = plateformesAvertissements(etat, { botId: "logora" }).join(" ");
    expect(phrases).toContain("aucun jeton n'est enregistré");
    expect(phrases).toContain("/bots?b=logora");
    // Le jeton d'un AUTRE bot ne compte pas pour celui-ci.
    expect(phrases).not.toContain("YUKI_CHAT_GRANOLAF__DISCORD");
  });

  it("un jeton posé avec l'interrupteur éteint est dit tel quel", () => {
    const etat = etatPlateformesDepuisFaits({
      botId: "granolaf",
      botDuRun: "yuki",
      champs: { "chat.discord.enabled": champ("off") },
      noms: NOMS_GRANOLAF,
      coffreConfigure: true,
    }) as unknown as EtatPlateformes;
    expect(plateformesActives(etat)).toEqual([]);
    const phrases = plateformesAvertissements(etat, { botId: "granolaf" }).join(" ");
    expect(phrases).toContain("jeton posé, plateforme DÉSACTIVÉE");
  });
});

describe("④ coffre illisible ⇒ jeton INCONNU, jamais « aucun jeton »", () => {
  it("la lecture ratée ne produit pas une affirmation fausse", () => {
    const etat = etatPlateformesDepuisFaits({
      botId: "granolaf",
      botDuRun: "yuki",
      champs: { "chat.discord.enabled": champ("on") },
      noms: null,
      coffreConfigure: false,
    }) as unknown as EtatPlateformes;
    expect(etat.discord.jetonEnregistre).toBeNull();
    const phrases = plateformesAvertissements(etat, { botId: "granolaf" }).join(" ");
    expect(phrases).toContain("INCONNU");
    expect(phrases).not.toContain("aucun jeton n'est enregistré");
  });
});

describe("⑤ l'état de connexion n'est en direct que pour le bot de la pile", () => {
  it("bot de la pile : l'état du serveur est repris tel quel", () => {
    const etat = etatPlateformesDepuisFaits({
      botId: "yuki",
      botDuRun: "yuki",
      statutPile: {
        plateformes: { mattermost: false, discord: true },
        discord: {
          jetonEnregistre: true,
          plateforme: { etat: "on", raison: "Discord : connecté." },
        },
      },
    }) as unknown as EtatPlateformes;
    expect(etat.connexionConnue).toBe(true);
    expect(plateformesActives(etat)).toEqual(["discord"]);
    expect(badgeFor(etat.discord)).toMatchObject({ etat: "on", title: "Discord : connecté." });
  });

  it("autre bot : connexion INCONNUE (badge « ? », jamais « non configuré »)", () => {
    const etat = etatGranolaf();
    expect(etat.connexionConnue).toBe(false);
    expect(etat.discord.plateforme.etat).toBe("inconnu");
    expect(badgeFor(etat.discord)).toMatchObject({ etat: "inconnu", glyph: "?" });
  });
});

describe("⑥ lecture et écriture visent le bot AFFICHÉ", () => {
  it("`fetchEtatPlateformes` lit SA config et le coffre, jamais `/api/chat/status`", async () => {
    const urls: string[] = [];
    const fetchImpl = async (url: string) => {
      urls.push(url);
      if (url === "/api/bots") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            bots: [
              { id: "yuki", nom: "Yuki", capacites: [], actif: true, ordre: 0 },
              { id: "granolaf", nom: "Granolaf", capacites: [], actif: true, ordre: 1 },
            ],
            principal: "yuki",
          }),
        };
      }
      if (url === "/api/bots/granolaf/config") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ fields: { "chat.discord.enabled": champ("on") } }),
        };
      }
      if (url === "/api/secrets") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            configured: true,
            entries: NOMS_GRANOLAF.map((name) => ({ name })),
          }),
        };
      }
      throw new Error(`URL inattendue : ${url}`);
    };

    const etat = (await fetchEtatPlateformes("granolaf", {
      fetchImpl: fetchImpl as never,
    })) as unknown as EtatPlateformes;
    expect(etat.bot).toBe("granolaf");
    expect(plateformesActives(etat)).toEqual(["discord"]);
    expect(etat.discord.jetonEnregistre).toBe(true);
    expect(etat.erreur).toBe("");
    // ⚠️ La route d'INSTANCE ne décrit pas ce bot : elle n'est pas appelée.
    expect(urls).not.toContain("/api/chat/status");
    expect(urls).toContain("/api/bots/granolaf/config");
  });

  it("l'interrupteur écrit sur `/api/bots/<bot affiché>/config`, pas sur `yuki`", async () => {
    const ecritures: Array<{ url: string; body: string }> = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      if (url === "/api/chat/status") {
        return { ok: true, status: 200, json: async () => ({ plateformes: {} }) };
      }
      ecritures.push({ url, body: String(init?.body ?? "") });
      return { ok: true, status: 200, json: async () => ({ fields: {} }) };
    };

    await savePlatformEnabled("discord", true, {
      botId: "granolaf",
      fetchImpl: fetchImpl as never,
    });
    expect(ecritures).toHaveLength(1);
    expect(ecritures[0]?.url).toBe("/api/bots/granolaf/config");
    expect(JSON.parse(ecritures[0]?.body ?? "{}")).toEqual({ "chat.discord.enabled": "on" });
  });

  it("la barre latérale passe l'état du bot affiché à l'ENCART (les interrupteurs sont partis)", () => {
    // ⚠️ GARDE CHANGÉE (2026-11-13) : les interrupteurs de plateforme ont été
    // RETIRÉS de la barre latérale (jamais demandés : « pourquoi il y a des boutons
    // on/off à cet endroit ? »). L'état du bot affiché reste lu — pour l'encart, qui
    // DIT pourquoi une liste est vide — et le bot affiché est joint aux réglages
    // d'un canal (`botId`, écriture dans SON miroir).
    const panel = read("sessions-panel.js");
    expect(panel).toContain("setEtatPlateformes");
    expect(panel).not.toContain("selector.update(etatPlateformes)");
    const app = read("app.js");
    expect(app).toContain("fetchEtatPlateformes(botAffiche(), { statutPile: status })");
    expect(app).toContain("botId: () => botAffiche()");
  });
});

describe("⑦ le LOCAL reste accessible (aucun choix exclusif)", () => {
  it("le local n'est pas une plateforme : il n'a ni interrupteur ni avis d'extinction", () => {
    expect(PLATEFORME_OPTIONS.map((option) => option.plateforme)).toEqual([
      "mattermost",
      "discord",
    ]);
    const etat = etatGranolaf();
    expect(plateformesActives(etat)).not.toContain("local");
    // Aucun texte de plateforme ne prétend que le local est coupé.
    const textes = [
      ...plateformesAvertissements(etat, { botId: "granolaf" }),
      platformsNotice(etat, { nombre: 0, connue: true }, { botId: "granolaf" })?.detail ?? "",
    ].join(" ");
    expect(textes).not.toContain("local est");
    // La liste des conversations n'est pas filtrée par plateforme : les
    // interrupteurs ne décident QUE de l'ajout d'une plateforme distante (le
    // panneau `update` reçoit toutes les conversations du bot affiché).
    const panel = read("sessions-panel.js");
    // Toutes les conversations reçues sont rendues, sans filtre par plateforme.
    expect(panel).toContain("sessions = Array.isArray(nextSessions) ? nextSessions : [];");
    expect(panel).not.toContain("filter((entree) => entree.plateforme");
  });

  it("la barre garde sa liste et son encart même quand l'état des plateformes est inconnu", () => {
    const panel = read("sessions-panel.js");
    // `etatPlateformes` valant `null`, rien n'est affirmé — mais rien n'est masqué.
    expect(panel).toContain("etatPlateformes = etat && typeof etat === \"object\" ? etat : null");
    expect(panel).toContain("notice.hidden = titres.length === 0");
  });
});
