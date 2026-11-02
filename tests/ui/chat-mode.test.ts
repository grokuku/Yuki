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
 *  - l'état du mode est PERSISTÉ CÔTÉ SERVEUR (`PUT /api/config`), jamais en
 *    `localStorage` ;
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
    expect(modeNotice(remoteStatus("mattermost"))).toMatchObject({ kind: "vide" });
    expect(modeNotice(remoteStatus("mattermost"))?.titre).toContain("Aucun canal synchronisé");
    // ⚠️ Lot 21 : Discord est LIVRÉ. Le bandeau « ne fait rien pour l'instant » serait
    // faux ; l'état vide DIT quoi faire (jeton + intent MESSAGE_CONTENT).
    expect(modeNotice(remoteStatus("discord"))).toMatchObject({ kind: "vide" });
    expect(modeNotice(remoteStatus("discord"))?.titre).toContain("Aucun salon synchronisé");
    expect(modeNotice(remoteStatus("discord"))?.detail).toContain("MESSAGE_CONTENT");
    // Mode local : AUCUN état vide ajouté (comportement strictement inchangé).
    expect(modeNotice({ mode: "local", creation: { autorisee: true } })).toBeNull();
  });
});

describe("persistance CÔTÉ SERVEUR", () => {
  it("écrit `chat.mode` par `PUT /api/config` (en-tête X-Yuki-Config) puis relit l'état", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === "/api/config") {
        return { ok: true, status: 200, json: async () => ({ applied: { hot: ["chat.mode"] } }) };
      }
      return { ok: true, status: 200, json: async () => remoteStatus("mattermost") };
    };
    const status = await saveChatMode("mattermost", fetchImpl);
    expect(status.mode).toBe("mattermost");

    const write = calls.find((call) => call.url === "/api/config");
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
