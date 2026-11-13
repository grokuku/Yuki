/**
 * PLATEFORMES INDÉPENDANTES — un bot joignable sur PLUSIEURS plateformes À LA FOIS.
 *
 * ⚠️ RÉGRESSION CORRIGÉE ICI (2026-11-10) : `chat.mode` était un enum EXCLUSIF
 * (`local` | `mattermost` | `discord`) et pilotait la création des adaptateurs
 * comme le filtrage de la liste. Choisir « local » COUPAIT Mattermost ET Discord :
 * « avant je pouvais parler au bot en local ET sur mattermost ET sur discord,
 * maintenant ça me demande de choisir un des trois ».
 *
 * Ce que ce fichier prouve, sur les modules RÉELS (aucun service externe) :
 *  ① deux interrupteurs `on` + deux jetons ⇒ DEUX adaptateurs distants ;
 *  ② le LOCAL reste disponible dans TOUS les cas (aucun interrupteur ne le coupe,
 *    et la création d'une conversation locale n'est jamais refusée) ;
 *  ③ un seul interrupteur `on` ⇒ UN SEUL adaptateur (l'autre jeton est ignoré) ;
 *  ④ aucun interrupteur `on` ⇒ AUCUN adaptateur distant (le local seul) ;
 *  ⑤ un JETON posé n'active rien à lui seul (l'interrupteur est la seule intention) ;
 *  ⑥ l'interface n'offre plus de choix exclusif : deux interrupteurs, pas de menu.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AdaptateursChatBots,
  cleAdaptateur,
  type AdaptateurChatDemarrable,
} from "../../src/chat/adaptateurs-bots.js";
import {
  resoudreJetonsChatBots,
  type PlateformeChat,
  type ResolutionJetonsChat,
} from "../../src/chat/jetons-bot.js";
import { ChatService } from "../../src/chat/service.js";

const ROOT = process.cwd();

/** Journal muet (les décisions sont vérifiées, pas les traces). */
const logger = { info: () => undefined, warn: () => undefined };

/** Coffre simulé : nom de secret → valeur. */
function coffre(entrees: Record<string, string>): (nom: string) => string | undefined {
  return (nom) => entrees[nom];
}

/**
 * Résolution + adaptateurs, comme `main()` les construit : le coffre fournit les
 * jetons, `actifs` porte les interrupteurs, `creer` compte les constructions.
 */
function construire(options: {
  jetons: Record<string, string>;
  actifs: PlateformeChat[];
}): { resolution: ResolutionJetonsChat; adaptateurs: AdaptateursChatBots<AdaptateurChatDemarrable>; crees: string[] } {
  const crees: string[] = [];
  const actifs = new Set(options.actifs);
  const resolution = resoudreJetonsChatBots({
    bots: ["yuki"],
    lookup: coffre(options.jetons),
    active: (_botId, plateforme) => actifs.has(plateforme),
    logger,
  });
  const adaptateurs = new AdaptateursChatBots<AdaptateurChatDemarrable>({
    botDePile: "yuki",
    resolution,
    // ⚠️ Aucun adaptateur « existant » : tout ce qui est construit ici l'est par
    // la règle testée (une paire = un interrupteur + un jeton).
    creer: (jeton) => {
      crees.push(cleAdaptateur(jeton.botId, jeton.plateforme));
      return { connect: async () => undefined, disconnect: async () => undefined };
    },
    logger,
  });
  return { resolution, adaptateurs, crees };
}

describe("① deux plateformes activées ⇒ DEUX adaptateurs (le cas de la régression)", () => {
  it("mattermost=on + discord=on ⇒ deux paires, deux adaptateurs", () => {
    const { adaptateurs, crees } = construire({
      jetons: { YUKI_CHAT_YUKI__MATTERMOST: "mm-token", YUKI_CHAT_YUKI__DISCORD: "dc-token" },
      actifs: ["mattermost", "discord"],
    });
    expect(crees.sort()).toEqual(["yuki:discord", "yuki:mattermost"]);
    expect(adaptateurs.paires().length).toBe(2);
  });

  it("② le LOCAL n'est pas une paire : il n'a pas d'adaptateur, il est toujours là", () => {
    const service = new ChatService({
      // ⚠️ Même avec les DEUX plateformes actives, le local reste ouvert.
      mode: () => "mattermost",
      enabled: () => true,
    });
    expect(service.plateformesActives()).toEqual(["mattermost", "discord"]);
    // Le local n'est pas un adaptateur distant : il n'y a rien à activer/couper.
    expect(service.plateformesActives()).not.toContain("local");
    // Et la création d'une conversation locale n'est JAMAIS refusée.
    expect(service.creationRefusal()).toBeNull();
    expect(service.status().creation).toEqual({ autorisee: true });
  });

  it("② bis un mode legacy « local » ne coupe plus les plateformes activées", () => {
    const service = new ChatService({
      mode: () => "local",
      enabled: () => true,
    });
    // ⚠️ C'ÉTAIT LE BUG : `chat.mode = local` rendait les plateformes invisibles.
    expect(service.plateformesActives()).toEqual(["mattermost", "discord"]);
  });
});

describe("③④⑤ un interrupteur, pas un jeton", () => {
  it("③ un seul activé ⇒ un seul adaptateur, l'autre jeton est IGNORÉ", () => {
    const { adaptateurs, crees, resolution } = construire({
      jetons: { YUKI_CHAT_YUKI__MATTERMOST: "mm-token", YUKI_CHAT_YUKI__DISCORD: "dc-token" },
      actifs: ["discord"],
    });
    expect(crees).toEqual(["yuki:discord"]);
    expect(adaptateurs.paires().map((p) => p.plateforme)).toEqual(["discord"]);
    // Le jeton Mattermost existe toujours au coffre, mais il n'a pas été résolu.
    expect(resolution.jetons.get("yuki")?.has("mattermost")).toBe(false);
  });

  it("④ aucun activé ⇒ AUCUN adaptateur distant (le local seul)", () => {
    const { adaptateurs, crees } = construire({
      jetons: { YUKI_CHAT_YUKI__MATTERMOST: "mm-token", YUKI_CHAT_YUKI__DISCORD: "dc-token" },
      actifs: [],
    });
    expect(crees).toEqual([]);
    expect(adaptateurs.paires()).toEqual([]);
  });

  it("⑤ un jeton posé n'active pas la plateforme à lui seul", () => {
    const resolution = resoudreJetonsChatBots({
      bots: ["yuki"],
      lookup: coffre({ YUKI_CHAT_YUKI__DISCORD: "dc-token" }),
      // Interrupteur éteint : le jeton ne doit RIEN ouvrir.
      active: () => false,
      logger,
    });
    expect(resolution.jetons.size).toBe(0);
    expect(resolution.conflits).toEqual([]);
  });

  it("⑤ bis deux plateformes `on` SANS jeton ⇒ aucune connexion (mais la règle est dite)", () => {
    const { crees } = construire({ jetons: {}, actifs: ["mattermost", "discord"] });
    expect(crees).toEqual([]);
  });
});

describe("⑥ l'interface ne propose plus de choix exclusif", () => {
  const lire = (chemin: string): string => readFileSync(join(ROOT, chemin), "utf8");

  it("le panneau d'un bot n'écrit plus `chat.mode` (le menu exclusif est retiré)", () => {
    const source = lire("public/ui/chat-panel.js");
    // Plus aucun `<select>` de plateforme, plus aucune écriture de `chat.mode`.
    expect(source).not.toContain('"chat.mode":');
    expect(source).not.toContain("chat-bot-mode");
    // Les DEUX interrupteurs sont écrits, chacun sur SA clé.
    expect(source).toContain("chat.${plateforme}.enabled");
  });

  it("la barre latérale ne monte AUCUN interrupteur (retirés le 2026-11-13)", () => {
    // ⚠️ GARDE CHANGÉE : les interrupteurs existaient (`initPlatformToggles`) et ont
    // été RETIRÉS de la barre latérale à la demande de l'utilisateur. L'activation
    // d'une plateforme se règle dans `/bots → Plateformes`, pas dans la navigation.
    const source = lire("public/ui/chat-mode.js");
    expect(source).not.toContain("export function initPlatformToggles");
    expect(lire("public/ui/sessions-panel.js")).not.toContain("initPlatformToggles");
    expect(source).not.toContain("initChatModeSelector");
    // Aucun mode exclusif : la liste des choix n'existe plus.
    expect(source).not.toContain("CHAT_MODE_OPTIONS");
    // Le local n'est pas un choix de plateforme.
    expect(source).not.toContain('plateforme: "local"');
    // L'écriture est celle de l'interrupteur.
    expect(source).toContain("chat.${plateforme}.enabled");
  });

  it("le panneau du bot affiche le LOCAL comme toujours disponible", () => {
    const source = lire("public/ui/chat-panel.js");
    expect(source).toContain("n'est pas une option");
  });
});
