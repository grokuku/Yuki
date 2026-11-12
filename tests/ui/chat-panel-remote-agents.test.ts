/**
 * RÉGLAGE « Agents distants » — le chemin que cite le message de refus existe
 * VRAIMENT dans l'interface.
 *
 * ⚠️ GARDE RÉÉCRITE, PAS SUPPRIMÉE (classement validé des réglages) : ce fichier
 * verrouillait les deux contrôles dessinés PAR LE PANNEAU `chat-panel.js` de la page
 * Bot (`#chat-remote-agents`, « Valeur inconnue », écriture `PUT /api/bots/<id>/config`).
 * `chat.remoteAgents` et `chat.remoteTools` sont devenus des clés d'INSTANCE : leurs
 * contrôles ont MIGRÉ dans le catalogue de la page Instance
 * (`config-fields.js`, groupe `acces-distant`, onglet « Agents »). Les assertions
 * qui décrivaient l'ancien emplacement sont donc REMPLACÉES par celles du nouveau,
 * avec le même objet :
 *
 *  ① le message de refus d'un outil long
 *    (`REMOTE_AGENTS_SETTING_PATH`, `src/llm/tool-policy.ts`) nomme un chemin qui
 *    DÉSIGNE un onglet et un libellé RÉELS — jamais un onglet inexistant ;
 *  ② le panneau de la page Bot n'écrit plus ces deux clés (il n'en reste qu'UN
 *    contrôle, celui de la page Instance) ;
 *  ③ l'onglet qui porte les contrôles existe sur la page Instance, et la page Bot
 *    n'en garde qu'un RENVOI (on ne cherche pas un réglage disparu) ;
 *  ④ CSP INCHANGÉE : ni le panneau ni le catalogue n'utilisent `innerHTML` ni
 *    d'attribut `style` — le contrôle est construit par `document.createElement`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ALL_FIELDS, LABELS, GROUPS } from "../../public/ui/config-fields.js";
import {
  ANCRES_PROFONDES,
  idsOnglets,
  ongletDuHash,
} from "../../public/ui/config-pages.js";
import { CONFIG_SCHEMA } from "../../src/config/schema.js";
import { REMOTE_AGENTS_SETTING_PATH } from "../../src/llm/tool-policy.js";

const lire = (nom: string): string =>
  readFileSync(join(process.cwd(), "public", "ui", nom), "utf8");

/** Groupe du catalogue qui porte les deux interrupteurs d'accès distant. */
const GROUPE = GROUPS.find((entree) => entree.id === "acces-distant");

describe("① le chemin cité par le refus désigne un contrôle RÉEL", () => {
  it("« Configuration → Agents → Agents distants » : onglet et libellé existent", () => {
    // ⚠️ L'onglet nommé est un onglet de la page INSTANCE (les clés le sont aussi).
    expect(idsOnglets("instance")).toContain("agents");
    // ⚠️ Le libellé est celui du champ du catalogue, à la lettre près : renommer
    // l'un sans l'autre rendrait le refus inutilisable.
    expect(REMOTE_AGENTS_SETTING_PATH).toBe(
      `Configuration → Agents → ${LABELS.get("chat.remoteAgents")}`,
    );
    expect(LABELS.get("chat.remoteAgents")).toBe("Agents distants");
    // Et les deux défauts de production corrigés ne reviennent pas.
    expect(REMOTE_AGENTS_SETTING_PATH).not.toContain("Discussions");
    expect(REMOTE_AGENTS_SETTING_PATH).not.toContain("Conversation");
    expect(REMOTE_AGENTS_SETTING_PATH).not.toContain("page du bot");
  });

  it("aucun fichier de `src/` ne renvoie vers un onglet « Discussions »", () => {
    const coupables: string[] = [];
    const parcourir = (dossier: string): void => {
      for (const entree of readdirSync(join(process.cwd(), dossier), { withFileTypes: true })) {
        const chemin = `${dossier}/${entree.name}`;
        if (entree.isDirectory()) {
          parcourir(chemin);
          continue;
        }
        if (!chemin.endsWith(".ts")) continue;
        const source = readFileSync(join(process.cwd(), chemin), "utf8");
        // `Conversation` est toléré HORS chemin d'interface (commentaires) : on ne
        // cherche que les chemins qui promettent un onglet.
        if (/(Configuration|Page)\s*→\s*Discussions/u.test(source)) coupables.push(chemin);
      }
    };
    parcourir("src");
    expect(coupables).toEqual([]);
  });
});

describe("② le panneau de la page Bot n'écrit plus ces deux clés", () => {
  it("aucune section « agents/outils distants » n'est construite par `chat-panel.js`", () => {
    const source = lire("chat-panel.js");
    expect(source).not.toContain('cle: "chat.remoteAgents"');
    expect(source).not.toContain('cle: "chat.remoteTools"');
    // ⚠️ Il ne monte plus de `<select>` d'accès distant (un seul contrôle par clé).
    expect(source).not.toContain("renderRemoteSwitch");
    // Le panneau des PLATEFORMES, lui, reste (c'est le réglage du bot : `chat.mode`).
    expect(source).toContain("initChatPanel");
    expect(source).toContain("chat-panel__");
  });

  it("chaque clé n'a qu'UN contrôle, et il est rendu par le catalogue", () => {
    for (const cle of ["chat.remoteAgents", "chat.remoteTools"]) {
      // ⚠️ Clés d'INSTANCE au schéma : la route du bot les refuse.
      expect(CONFIG_SCHEMA[cle]?.scope, cle).toBe("instance");
      const champs = ALL_FIELDS.filter((field) => field.path === cle);
      expect(champs.length, cle).toBe(1);
      expect(champs[0]?.kind).toBe("select");
      expect(champs[0]?.helper ?? "").toContain("⚠️");
    }
    // ⚠️ `chat.mode` reste une clé de BOT, écrite par le sélecteur de mode.
    expect(CONFIG_SCHEMA["chat.mode"]?.scope).toBe("bot");
    expect(lire("chat-mode.js")).toContain("chat.mode");
  });
});

describe("③ les ancres tombent sur le bon onglet, et la page Bot renvoie", () => {
  it("`#chat-remote-agents` / `#chat-remote-tools` ouvrent « Agents » sur l'Instance", () => {
    const ancres = new Map(ANCRES_PROFONDES.instance);
    expect(ancres.get("chat-remote-agents")).toBe("agents");
    expect(ancres.get("chat-remote-tools")).toBe("agents");
    expect(ongletDuHash("instance", "#chat-remote-agents")).toBe("agents");
    expect(ongletDuHash("instance", "#chat-remote-tools")).toBe("agents");
    // ⚠️ Sur la page Bot ces ancres n'ont plus de cible : elles ne doivent plus y
    // figurer, sinon on ouvrirait un onglet pour rien.
    expect(new Map(ANCRES_PROFONDES.bot).has("chat-remote-agents")).toBe(false);
    expect(ongletDuHash("bot", "#chat-remote-agents")).toBe(null);
  });

  it("la page Bot garde un RENVOI vers l'onglet qui les porte", () => {
    expect(GROUPE?.tabs).toEqual({ instance: "agents" });
    expect(GROUPE?.renvoi?.instance?.lien).toEqual({
      href: "/bots#plateformes",
      libelle: "Bot · Plateformes",
    });
    // L'onglet visé existe vraiment sur la page Bot.
    expect(idsOnglets("bot")).toContain("plateformes");
  });

  it("les deux contrôles sont CÔTÉ À CÔTÉ et indépendants (deux clés, deux champs)", () => {
    const chemins = (GROUPE?.fields ?? []).map((field) => field.path);
    expect(chemins).toEqual(["chat.remoteAgents", "chat.remoteTools"]);
    // Deux libellés DISTINCTS : l'un ne peut pas passer pour l'autre.
    expect(LABELS.get("chat.remoteAgents")).not.toBe(LABELS.get("chat.remoteTools"));
    // L'aide de chacun dit ce qu'il ouvre, et ce qu'il n'ouvre PAS.
    const aideAgents = String(
      (GROUPE?.fields ?? []).find((field) => field.path === "chat.remoteAgents")?.helper,
    );
    const aideOutils = String(
      (GROUPE?.fields ?? []).find((field) => field.path === "chat.remoteTools")?.helper,
    );
    expect(aideAgents).toContain("MACHINES");
    expect(aideAgents).toContain("DÉLÉGUER");
    expect(aideAgents).toContain("GÉNÉRATION D'IMAGE");
    expect(aideOutils).toContain("génération d'image");
    expect(aideOutils).toContain("libraire");
    expect(aideOutils).toContain("archive");
    expect(aideOutils).toContain("sans ouvrir la délégation");
    expect(aideOutils).toContain("approbation");
  });
});

describe("④ CSP inchangée : aucun `innerHTML`, aucun `style.`", () => {
  it("ni le panneau ni le catalogue ne fabriquent de markup", () => {
    for (const fichier of ["chat-panel.js", "config-fields.js", "config.js"]) {
      // ⚠️ On ne cherche pas le MOT dans les commentaires (ils expliquent justement
      // la règle) mais tout usage : affectation `innerHTML =` et style en ligne.
      const source = lire(fichier);
      expect(source, fichier).not.toMatch(/innerHTML\s*=/u);
      expect(source, fichier).not.toMatch(/\.style\./u);
      expect(source, fichier).not.toMatch(/\.setAttribute\(\s*["']style["']/u);
    }
  });
});
