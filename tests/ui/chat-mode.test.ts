/**
 * Sélecteur de MODE DE DISCUSSION (lot 18, lot 1) — CÔTÉ INTERFACE.
 *
 * Ce que ce fichier prouve :
 *  - les trois modes demandés existent (Local · Mattermost · Discord) et le
 *    badge porte ●/◐/○ avec la RAISON EXACTE en `title` ;
 *  - le refus de création vient du SERVEUR (`creation.autorisee === false`) :
 *    l'interface ne décide pas, elle relaie ;
 *  - les TROIS chemins de clic (barre latérale, menu téléphone, bouton de l'état
 *    vide) passent par le MÊME garde-fou : `{ type: "new" }` n'est envoyé qu'à un
 *    seul endroit dans `app.js` ;
 *  - l'état du mode est PERSISTÉ CÔTÉ SERVEUR (`PUT /api/bots/<id>/config`),
 *    jamais en `localStorage` ;
 *  - CSP inchangée : aucun `innerHTML`, aucune ressource externe.
 *
 * ⚠️ Échoue sur le code d'origine : `public/ui/chat-mode.js` n'existe pas.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CHAT_BADGES,
  CHAT_MODE_OPTIONS,
  CHEMIN_DISCORD,
  CHEMIN_MATTERMOST,
  badgeFor,
  chatModeLabel,
  creationRefusal,
  modeNotice,
  saveChatMode,
} from "../../public/ui/chat-mode.js";

const read = (name: string): string =>
  readFileSync(join(process.cwd(), "public", "ui", name), "utf8");

/** Corps de `GET /api/chat/status` en mode distant. */
function remoteStatus(mode: string, etat = "off", raison = "Raison exacte.") {
  return {
    mode,
    plateforme: { etat, raison },
    creation: { autorisee: false, raison: "La création est désactivée." },
    distant: { agents: "desactive", memoire: "desactive" },
  };
}

describe("les TROIS modes demandés", () => {
  it("Local · Mattermost · Discord, dans cet ordre", () => {
    expect(CHAT_MODE_OPTIONS.map((option) => option.mode)).toEqual([
      "local",
      "mattermost",
      "discord",
    ]);
    expect(CHAT_MODE_OPTIONS.map((option) => option.label)).toEqual([
      "Local",
      "Mattermost",
      "Discord",
    ]);
    expect(chatModeLabel("mattermost")).toBe("Mattermost");
  });
});

describe("badge d'état — ● / ◐ / ○ et la raison en `title`", () => {
  it("connecté, connexion, non configuré", () => {
    expect(CHAT_BADGES.on.glyph).toBe("●");
    expect(CHAT_BADGES.connexion.glyph).toBe("◐");
    expect(CHAT_BADGES.off.glyph).toBe("○");
    expect(badgeFor({ plateforme: { etat: "on" } }).glyph).toBe("●");
    expect(badgeFor({ plateforme: { etat: "connexion" } }).glyph).toBe("◐");
    expect(badgeFor({ plateforme: { etat: "off" } }).glyph).toBe("○");
  });

  it("le `title` porte la raison EXACTE du serveur (jamais « erreur »)", () => {
    const badge = badgeFor(remoteStatus("discord", "off", "Discord n'est pas configuré."));
    // ⚠️ Le `title` est la raison du SERVEUR, recopiée telle quelle : aucune reformulation
    // côté interface (elle afficherait sinon un motif qui n'existe plus au lot 21).
    expect(badge.title).toBe("Discord n'est pas configuré.");
    expect(badge.glyph).toBe("○");
  });

  it("un état inconnu n'invente pas une connexion", () => {
    expect(badgeFor(undefined).etat).toBe("off");
    expect(badgeFor({ plateforme: { etat: "peut-être" } }).glyph).toBe("○");
  });
});

describe("création désactivée — décision du SERVEUR, relayée", () => {
  it("en mode local, aucune raison : la création est permise", () => {
    expect(
      creationRefusal({
        mode: "local",
        plateforme: { etat: "on" },
        creation: { autorisee: true },
      }),
    ).toBeNull();
  });

  it("en mode distant, la raison EXACTE du serveur est rendue", () => {
    expect(creationRefusal(remoteStatus("mattermost"))).toBe("La création est désactivée.");
    // État inconnu (serveur illisible) : on ne prétend pas que c'est permis ?
    // Non : sans réponse du serveur, on n'a pas de refus ⇒ rien à bloquer ici,
    // et le serveur refusera de toute façon (`creation_desactivee`).
    expect(creationRefusal(null)).toBeNull();
  });

  it("état vide / bandeau par mode : Mattermost n'a aucun canal, Discord n'est pas configuré", () => {
    // ⚠️ La décision exige maintenant l'état de la LISTE : ici « liste reçue et vide ».
    const listeVide = { nombre: 0, connue: true };
    const mattermostConnecte = remoteStatus("mattermost", "on", "Mode Mattermost connecté.");
    expect(modeNotice(mattermostConnecte, listeVide)).toMatchObject({ kind: "vide" });
    expect(modeNotice(mattermostConnecte, listeVide)?.titre).toContain("Aucun canal synchronisé");
    // ⚠️ Lot 21 : Discord est LIVRÉ. Le bandeau « ne fait rien pour l'instant » serait
    // faux ; l'état vide DIT quoi faire (jeton + intent MESSAGE_CONTENT).
    const discordConnecte = remoteStatus("discord", "on", "Mode Discord connecté.");
    expect(modeNotice(discordConnecte, listeVide)).toMatchObject({ kind: "vide" });
    expect(modeNotice(discordConnecte, listeVide)?.titre).toContain("Aucun salon synchronisé");
    expect(modeNotice(discordConnecte, listeVide)?.detail).toContain("MESSAGE_CONTENT");
    // Mode local : AUCUN état vide ajouté (comportement strictement inchangé).
    expect(modeNotice({ mode: "local", creation: { autorisee: true } }, listeVide)).toBeNull();
  });
});

/**
 * L'ENCART DE LA BARRE NE DOIT JAMAIS CONTREDIRE LA LISTE.
 *
 * ⚠️ DÉFAUT DE PRODUCTION (capture du 2026-11-02 20:55) : en mode Mattermost, la
 * barre latérale affichait EN MÊME TEMPS « Aucun canal synchronisé. Renseignez
 * l'URL du serveur… » et CINQ canaux (Yuki's Home, 📷 - Imagerie, 🚀 - Spatioport,
 * Table 1, 🐾 - General). L'encart était décidé sur le seul `status.mode`, avant
 * l'arrivée de la liste, et jamais recalculé.
 */
describe("encart de la barre — UNE SEULE vérité affichée à la fois", () => {
  const MATTERMOST_CINQ_CANAUX = {
    mode: "mattermost",
    plateforme: { etat: "on", raison: "Mode Mattermost : connecté." },
    creation: { autorisee: false, raison: "La création est désactivée." },
  };

  it("liste NON VIDE ⇒ AUCUN encart (le défaut de production)", () => {
    // ⚠️ Échoue sur l'origine : `modeNotice` ignorait la liste et rendait « vide ».
    expect(modeNotice(MATTERMOST_CINQ_CANAUX, { nombre: 5, connue: true })).toBeNull();
    // Même avec une raison d'échec : la liste reste la vérité affichée.
    expect(
      modeNotice(
        { ...MATTERMOST_CINQ_CANAUX, plateforme: { etat: "connexion", raison: "401." } },
        { nombre: 5, connue: true },
      ),
    ).toBeNull();
    expect(
      modeNotice({ mode: "discord", plateforme: { etat: "on" } }, { nombre: 2, connue: true }),
    ).toBeNull();
  });

  it("liste VIDE + synchro réussie ⇒ encart d'état vide, avec le chemin EXACT", () => {
    const avis = modeNotice(MATTERMOST_CINQ_CANAUX, { nombre: 0, connue: true });
    expect(avis).toMatchObject({ kind: "vide" });
    expect(avis?.titre).toBe("Aucun canal synchronisé.");
    // ⚠️ Les MOTS de l'interface : onglet « Conversation », SECTION
    // « Discussions — Mattermost » (jamais « Discussions » seul).
    expect(avis?.detail).toContain("/config → Conversation → « Discussions — Mattermost »");
    // ⚠️ Jamais la SECTION SEULE (« Discussions »), qui n'existe pas dans l'UI.
    expect(avis?.detail).not.toContain("« Discussions »");
    // Et le chemin Discord, lui, nomme la section Discord.
    const salons = modeNotice(
      { mode: "discord", plateforme: { etat: "on" }, creation: { autorisee: false, raison: "x" } },
      { nombre: 0, connue: true },
    );
    expect(salons?.detail).toContain("/config → Conversation → « Discussions — Discord »");
    expect(salons?.detail).not.toContain("« Discussions »");
    // Et le MODE LOCAL n'ajoute toujours rien (comportement inchangé).
    expect(modeNotice({ mode: "local" }, { nombre: 0, connue: true })).toBeNull();
  });

  it("le chemin est celui de l'UI RÉELLE (onglet « Conversation », sections nommées)", () => {
    expect(CHEMIN_MATTERMOST).toBe("/config → Conversation → « Discussions — Mattermost »");
    expect(CHEMIN_DISCORD).toBe("/config → Conversation → « Discussions — Discord »");
    // Les deux sections existent VRAIMENT sous ces noms (`public/ui/chat-panel.js`).
    const panneau = read("chat-panel.js");
    expect(panneau).toContain('titre: "Discussions — Mattermost"');
    expect(panneau).toContain('titre: "Discussions — Discord"');
    // Une SEULE source de vérité : le sélecteur de mode cite le même chemin.
    expect(CHAT_MODE_OPTIONS[1].title).toContain(CHEMIN_MATTERMOST);
    expect(CHAT_MODE_OPTIONS[2].title).toContain(CHEMIN_DISCORD);
    // Le bouton d'état vide du fil renvoie les mots exacts de l'UI (`app.js`).
    expect(read("app.js")).toContain("Aucune conversation dans ce mode");
  });

  it("échec de synchronisation ⇒ message DISTINCT, jamais « aucun canal »", () => {
    // ① Plateforme non configurée : la raison du SERVEUR est recopiée telle quelle.
    const nonConfigure = modeNotice(
      {
        mode: "mattermost",
        plateforme: {
          etat: "off",
          raison:
            "Mattermost n'est pas configuré : renseignez l'URL du serveur et le jeton du bot " +
            "dans /config → Conversation → « Discussions — Mattermost ».",
        },
        creation: { autorisee: false, raison: "La création est désactivée." },
      },
      { nombre: 0, connue: true },
    );
    expect(nonConfigure).toMatchObject({ kind: "echec" });
    expect(nonConfigure?.titre).toBe("Synchronisation des canaux impossible.");
    expect(nonConfigure?.titre).not.toContain("Aucun canal");
    expect(nonConfigure?.detail).toContain("Mattermost n'est pas configuré");

    // ② Jeton refusé / URL injoignable : la raison dit QUOI, et le chemin est ajouté
    //    (la raison technique, elle, ne connaît pas la page de réglage).
    const jetonRefuse = modeNotice(
      {
        mode: "mattermost",
        plateforme: { etat: "connexion", raison: "Connexion temps réel refusée (401 Unauthorized)." },
        creation: { autorisee: false, raison: "La création est désactivée." },
      },
      { nombre: 0, connue: true },
    );
    expect(jetonRefuse).toMatchObject({ kind: "echec" });
    expect(jetonRefuse?.titre).toBe("Synchronisation des canaux interrompue.");
    expect(jetonRefuse?.detail).toContain("401 Unauthorized");
    expect(jetonRefuse?.detail).toContain(CHEMIN_MATTERMOST);
    expect(jetonRefuse?.titre).not.toBe(nonConfigure?.titre);
  });

  it("pendant le CHARGEMENT ⇒ aucun encart contradictoire (discret, sans « Aucun »)", () => {
    // Liste pas encore reçue (aucune trame `sessions`) : on n'affirme rien.
    const avis = modeNotice(MATTERMOST_CINQ_CANAUX, { nombre: 0, connue: false });
    expect(avis).toMatchObject({ kind: "chargement" });
    expect(avis?.titre).not.toContain("Aucun");
    // Statut du mode pas encore reçu : rien du tout (ni vide, ni échec inventé).
    expect(modeNotice(null, { nombre: 0, connue: false })).toBeNull();
    expect(modeNotice(null, { nombre: 0, connue: true })).toBeNull();
    // Connexion EN COURS sans raison d'échec : l'import peut encore remplir la liste,
    // donc on n'annonce pas « aucun canal » (ce serait une conclusion prématurée).
    const enCours = modeNotice(
      { mode: "mattermost", plateforme: { etat: "connexion" }, creation: { autorisee: false, raison: "x" } },
      { nombre: 0, connue: true },
    );
    expect(enCours).toMatchObject({ kind: "chargement" });
    // Contexte absent (appel historique) : on ne prétend pas que la liste est vide.
    expect(modeNotice(MATTERMOST_CINQ_CANAUX)).toMatchObject({ kind: "chargement" });
  });

  it("la barre RECALCULE l'encart à chaque source (statut ET liste)", () => {
    const panel = read("sessions-panel.js");
    // Une seule décision, nourrie par la liste RÉELLEMENT rendue.
    expect(panel).toContain("modeNotice(chatStatus, { nombre: sessions.length, connue: listeConnue })");
    // La liste reçue est marquée comme telle, puis l'encart est recalculé après
    // le rendu (défaut d'origine : rendu avant la liste, jamais retiré).
    expect(panel).toContain("listeConnue = true");
    expect(panel.match(/applyNotice\(\);/g)?.length).toBeGreaterThanOrEqual(2);
    // L'état de l'encart suit UNE seule variable.
    expect(panel).toContain('notice.hidden = titre === ""');
    // Le style « chargement » est DISCRET (feuille servie, CSP inchangée).
    expect(read("styles.css")).toContain('.sidebar__notice[data-kind="chargement"]');
  });
});

describe("persistance CÔTÉ SERVEUR", () => {
  it("écrit `chat.mode` sur la route du BOT ACTIF puis relit l'état", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === "/api/bots") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            bots: [
              { id: "yuki", nom: "Yuki", profil: "complet", actif: true, ordre: 0 },
            ],
          }),
        };
      }
      if (url === "/api/bots/yuki/config") {
        return { ok: true, status: 200, json: async () => ({ applied: { hot: ["chat.mode"] } }) };
      }
      return { ok: true, status: 200, json: async () => remoteStatus("mattermost") };
    };
    const status = await saveChatMode("mattermost", fetchImpl);
    expect(status.mode).toBe("mattermost");

    // ⚠️ `chat.mode` est un réglage PROPRE AU BOT : `PUT /api/config` le refuse
    // (`bot_scoped_field`). L'unique écriture vise donc la route du bot actif.
    expect(calls.some((call) => call.url === "/api/config")).toBe(false);
    const write = calls.find((call) => call.url === "/api/bots/yuki/config");
    expect(write?.init?.method).toBe("PUT");
    expect((write?.init?.headers as Record<string, string>)["x-yuki-config"]).toBe("1");
    expect(JSON.parse(String(write?.init?.body))).toEqual({ "chat.mode": "mattermost" });
    // La LECTURE aussi est gardée par le même en-tête.
    const readCall = calls.find((call) => call.url === "/api/chat/status");
    expect((readCall?.init?.headers as Record<string, string>)["x-yuki-config"]).toBe("1");
  });

  it("l'interface n'écrit jamais le mode dans `localStorage`", () => {
    const source = read("chat-mode.js");
    expect(source).not.toContain("localStorage");
    // Aucun appel direct à une plateforme distante : tout passe par le gateway.
    expect(source).not.toMatch(/https?:\/\//);
  });
});

describe("garde-fous de la source — CSP et chemins de clic", () => {
  it("construit le DOM sans injection HTML directe (sélecteur et panneau)", () => {
    expect(read("chat-mode.js")).not.toContain("innerHTML");
    expect(read("sessions-panel.js")).not.toContain("innerHTML");
    expect(read("chat-mode.js")).toContain("createElement");
  });

  it("les TROIS chemins de clic passent par `requestNew()` (un seul `{ type: \"new\" }`)", () => {
    const app = read("app.js");
    // Un SEUL envoi de `new` dans tout `app.js` : celui du garde-fou.
    expect(app.match(/type: "new"/g)?.length).toBe(1);
    // Les trois APPELS (barre latérale, menu téléphone, bouton de l'état vide) :
    // la définition, la mention en commentaire, puis trois appels.
    expect(app.match(/^\s*requestNew\(\);$/gm)?.length).toBe(3);
  });

  it("le panneau DÉSACTIVE « + Nouvelle conversation » avec la raison du serveur", () => {
    const panel = read("sessions-panel.js");
    expect(panel).toContain("setChatMode");
    expect(panel).toContain("newBtn.disabled");
    expect(panel).toContain("creationRefusal");
  });

  it("le sélecteur est monté dans l'EN-TÊTE, avant « + Nouvelle conversation »", () => {
    const panel = read("sessions-panel.js");
    expect(panel).toContain("inner.append(top, modeSlot, newBtn, notice, list)");
  });

  it("les styles du sélecteur sont dans la feuille servie (CSP : aucun style en ligne)", () => {
    const css = read("styles.css");
    expect(css).toContain(".chat-mode__btn--active");
    expect(css).toContain(".chat-mode__badge[data-etat=\"on\"]");
    expect(css).toContain(".sidebar__notice");
    expect(read("chat-mode.js")).not.toContain("style.");
  });
});
