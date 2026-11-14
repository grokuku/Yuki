/**
 * ÉTAT DES PLATEFORMES D'UN BOT — CE QUE L'INTERFACE DIT DOIT ÊTRE VRAI.
 *
 * ⚠️ DÉFAUT CORRIGÉ (bug du 2026-11-14) : un bot ACTIVÉ mais ABSENT (aucune
 * connexion WebSocket, donc « hors ligne » dans Mattermost) restait indescriptible
 * pour tout bot autre que celui de la pile — l'interface affichait « état inconnu »
 * et l'utilisateur n'avait d'autre recours que de redémarrer pour comprendre.
 *
 * Ce que ce fichier prouve :
 *  ① l'état de connexion renvoyé par le serveur (`plateformes`) est UTILISÉ, plus
 *     « inconnu » ;
 *  ② un échec de connexion (jeton refusé, URL injoignable) devient VISIBLE, avec
 *     sa raison — pas seulement dans le journal ;
 *  ③ « connecté sans aucun canal » est DIT, jamais une liste vide muette ;
 *  ④ « hors ligne » ≠ « désactivée » : deux phrases différentes, jamais un badge
 *     « à chaud » mensonger.
 *
 * Échoue sur le code d'origine : `plateformes` n'était pas exposé par bot (donc
 * `connexionConnue: false` et raison « état non exposé »), et
 * `texteConnexionPlateforme` n'existait pas.
 */

import { describe, expect, it } from "vitest";

import { platformsNotice } from "../../public/ui/chat-mode.js";
import { texteConnexionPlateforme } from "../../public/ui/chat-panel.js";
import { etatPlateformesDepuisFaits } from "../../public/ui/plateformes-bot.js";

/** Vue large : ces modules d'interface ne sont pas typés, on ne mime pas leurs types. */
type Vue = {
  connexionConnue: boolean;
  plateformes: Record<string, boolean>;
  mattermost: { plateforme: { etat: string; raison: string } };
  discord: { plateforme: { etat: string; raison: string } };
};

/** État serveur d'un bot, tel que `GET /api/bots/<id>/config` le renvoie (lot 48). */
function serveur(options: {
  active?: boolean;
  jetonEnregistre?: boolean;
  adaptateur?: boolean;
  etat?: string;
  raison?: string;
  canaux?: number;
}): Record<string, object> {
  return {
    mattermost: {
      active: options.active ?? true,
      jetonEnregistre: options.jetonEnregistre ?? true,
      adaptateur: options.adaptateur ?? true,
      etat: options.etat ?? "off",
      ...(options.raison !== undefined ? { raison: options.raison } : {}),
      canaux: options.canaux ?? 0,
    },
    discord: {
      active: false,
      jetonEnregistre: false,
      adaptateur: false,
      etat: "off",
      canaux: 0,
    },
  };
}

describe("① l'état de connexion du bot DEMANDÉ est utilisé", () => {
  it("un bot non-pile n'est plus « état inconnu »", () => {
    const etat = etatPlateformesDepuisFaits({
      botId: "granolaf",
      botDuRun: "yuki",
      etatServeur: serveur({ etat: "on", canaux: 3 }),
    }) as Vue;
    expect(etat.connexionConnue).toBe(true);
    expect(etat.plateformes.mattermost).toBe(true);
    expect(etat.mattermost.plateforme.etat).toBe("on");
    expect(etat.mattermost.plateforme.raison).toBe("");
  });

  it("sans état serveur, on n'affirme RIEN (jamais un « connecté » inventé)", () => {
    const etat = etatPlateformesDepuisFaits({
      botId: "granolaf",
      botDuRun: "yuki",
      champs: { "chat.mattermost.enabled": { value: "on" } },
      noms: ["YUKI_CHAT_GRANOLAF__MATTERMOST"],
    }) as Vue;
    expect(etat.connexionConnue).toBe(false);
    expect(etat.mattermost.plateforme.etat).toBe("inconnu");
  });
});

describe("② un échec de connexion est VISIBLE, avec sa raison", () => {
  it("le bot absent est annoncé HORS LIGNE et le motif est repris", () => {
    const raison = "Le jeton du bot est refusé (401).";
    const etat = etatPlateformesDepuisFaits({
      botId: "granolaf",
      botDuRun: "yuki",
      etatServeur: serveur({ etat: "off", raison }),
    }) as Vue;
    const avis = platformsNotice(etat, { nombre: 0, connue: true }, { botId: "granolaf" }) as {
      kind: string;
      titre: string;
      detail: string;
    } | null;
    expect(avis).not.toBeNull();
    expect(avis?.kind).toBe("echec");
    expect(`${avis?.titre} ${avis?.detail}`).toContain("401");
  });
});

describe("③ « connecté sans aucun canal » est DIT, jamais muet", () => {
  it("la phrase nomme l'absence de canal et la vérification à faire", () => {
    const texte = texteConnexionPlateforme("mattermost", {
      active: true,
      jetonEnregistre: true,
      adaptateur: true,
      etat: "on",
      canaux: 0,
    });
    expect(texte).toContain("AUCUN canal");
    expect(texte).toContain("Resynchroniser");
  });

  it("une connexion avec des canaux les COMPTE", () => {
    const texte = texteConnexionPlateforme("mattermost", {
      active: true,
      jetonEnregistre: true,
      adaptateur: true,
      etat: "on",
      canaux: 2,
    });
    expect(texte).toContain("2 canal");
  });
});

describe("④ « hors ligne » ≠ « désactivée »", () => {
  it("l'interrupteur éteint n'est PAS présenté comme une panne", () => {
    const texte = texteConnexionPlateforme("mattermost", {
      active: false,
      jetonEnregistre: true,
      adaptateur: false,
      etat: "off",
      canaux: 0,
    });
    expect(texte).toContain("DÉSACTIVÉE");
    expect(texte).not.toContain("HORS LIGNE");
  });

  it("activée mais sans connexion ⇒ HORS LIGNE, avec la raison quand elle existe", () => {
    const texte = texteConnexionPlateforme("mattermost", {
      active: true,
      jetonEnregistre: true,
      adaptateur: false,
      etat: "off",
      raison: "L'URL du serveur Mattermost n'est pas renseignée.",
      canaux: 0,
    });
    expect(texte).toContain("HORS LIGNE");
    expect(texte).toContain("URL du serveur");
  });

  it("aucun état exposé ⇒ on le DIT (pas de faux « connecté »)", () => {
    expect(texteConnexionPlateforme("discord", null)).toContain("inconnu");
  });
});
