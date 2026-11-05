/**
 * ENVOIS PROGRAMMÉS (lot 28) — Yuki publie plus tard.
 *
 * ⚠️ LA DEMANDE, TELLE QU'ELLE EST ARRIVÉE EN PRODUCTION (Mattermost,
 * 2026-11-04 15:54) : « j'aimerais que tu fasses une image… et que tu la postes à
 * 16h10 dans l'Imagerie. Tu penses pouvoir y arriver ? » — et la réponse de Yuki :
 * « je ne peux pas la programmer pour 16h10 : je n'ai pas de minuteur, une
 * publication part au moment où je la fais ».
 *
 * ⚠️ C'ÉTAIT VRAI POUR ELLE ET FAUX POUR LE SYSTÈME : le planificateur existe depuis
 * le lot 2 (`src/sources/scheduler.ts`, balayeur 30 s, état persisté). Il manquait
 * l'OUTIL. Ce fichier verrouille ce que « programmer un envoi » doit garantir :
 *
 *  ① un envoi programmé PART À L'HEURE DUE, dans la bonne conversation ;
 *  ② il part avec ses FICHIERS (requête capturée : `file_ids`/multipart) ;
 *  ③ ⚠️ AUCUN MODÈLE N'EST APPELÉ à l'heure dite (le texte est FIGÉ) — le host n'est
 *    sollicité que par `publierMessage`, jamais par `send` (qui démarrerait un run) ;
 *  ④ il SURVIT à un redémarrage (store relu depuis le disque) ;
 *  ⑤ il est ANNULABLE, et un envoi annulé ne part pas ;
 *  ⑥ les BORNES sont des refus EXPLICITES (date passée, texte vide, horizon, plafond) ;
 *  ⑦ une cible DISPARUE est un échec JOURNALISÉ (aucune perte silencieuse) ;
 *  ⑧ ⚠️ le WORKER LOURD n'a pas l'outil (invariant « un seul rédacteur ») ;
 *  ⑨ c'est le BALAYEUR EXISTANT qui les exécute (aucun second `setInterval`).
 *
 * ⚠️ Le temps est INJECTÉ partout (`now`) : rien n'attend 30 secondes ni une heure.
 */

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DELAI_MIN_MS,
  EnvoisProgrammesService,
  EnvoisProgrammesStore,
  HORIZON_MAX_MS,
  MAX_ENVOIS_EN_ATTENTE,
  RATTRAPAGE_MAX_ENVOI_MS,
  analyserQuand,
  formaterInstantEnvoi,
} from "../../src/chat/envois/index.js";
import { createChannelPostPort } from "../../src/chat/reply/channel-post.js";
import { createLogger } from "../../src/observability/logger.js";
import { DeclencheurBalayeur } from "../../src/sources/scheduler.js";
import { DeclencheurJournal } from "../../src/sources/journal.js";
import { createScheduledSendTools, type ScheduledSendPort } from "../../src/pi/sdk/scheduled-send-tool.js";
import { TOOL_POLICY, remoteToolGroup, toolAllowlist } from "../../src/llm/tool-policy.js";
import { validateSourceName } from "../../src/sources/store.js";
import type { SourceRecord } from "../../src/sources/types.js";

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-envois-"));
  dirs.push(dir);
  return dir;
}

/** Instant de référence des tests : 4 novembre 2026, 15 h 00 à Paris (= 14 h UTC). */
const T0 = Date.parse("2026-11-04T14:00:00Z");

/** Canaux SUIVIS (miroir) du rig : « L'Imagerie » + un canal Discord. */
const CANAUX = [
  { conversationId: "mm-imagerie", titre: "L'Imagerie", plateforme: "mattermost" },
  { conversationId: "mm-general", titre: "Général", plateforme: "mattermost" },
  { conversationId: "dc-salons", titre: "salons", plateforme: "discord" },
];

/** Le journal reçoit tout : c'est lui qui prouve qu'aucune perte n'est silencieuse. */
function makeJournal(dir: string) {
  return DeclencheurJournal.open({ path: join(dir, "declencheurs-journal.jsonl") });
}

interface Rig {
  dir: string;
  store: EnvoisProgrammesStore;
  service: EnvoisProgrammesService;
  /** Ce que la publication a RÉELLEMENT reçu (destinataires + fichiers). */
  publies: Array<{ cible: unknown; texte: string; fichierIds?: readonly string[] }>;
  journal: DeclencheurJournal;
  /** Horloge pilotée par le test. */
  horloge: { at: number };
}

/**
 * Rig complet : store persisté, service, journal, et une publication qui passe par le
 * VRAI port de publication (`createChannelPostPort` → `envoyer`), jamais par un
 * doublon de la logique de bornes.
 */
function makeRig(
  options: {
    /** Fichiers du store des fichiers (résolution serveur). */
    fichiers?: Record<string, { sessionId?: string; name: string; bytes: number }>;
    /** Panne simulée de l'envoi (cible disparue, réseau…). */
    panne?: string;
  } = {},
): Rig {
  const dir = tmpDir();
  const horloge = { at: T0 };
  const store = EnvoisProgrammesStore.open({ path: join(dir, "envois-programmes.json"), now: () => horloge.at });
  const journal = makeJournal(dir);
  const publies: Rig["publies"] = [];
  const service = new EnvoisProgrammesService({
    store,
    journal,
    canaux: () => CANAUX,
    fichier: (id) => options.fichiers?.[id] ?? null,
    maxFichierBytes: () => 10_000_000,
    publier: async ({ cible, texte, fichierIds }) => {
      // ⚠️ MÊME PORT que `publier_dans_canal` : bornes de plateforme, résolution du
      // canal dans le miroir, contrôle des fichiers. Un canal absent ⇒ refus.
      if (cible.type !== "canal") {
        publies.push({ cible, texte, ...(fichierIds !== undefined ? { fichierIds } : {}) });
        return;
      }
      const port = createChannelPostPort({
        plateforme: cible.plateforme,
        canaux: () => CANAUX,
        envoyer: async (input) => {
          if (options.panne !== undefined) throw new Error(options.panne);
          publies.push({
            cible: { conversationId: input.conversationId },
            texte: input.texte,
            ...(input.fichierIds !== undefined ? { fichierIds: input.fichierIds } : {}),
          });
        },
        fichier: (id) => options.fichiers?.[id] ?? null,
        maxFichierBytes: () => 10_000_000,
        logger,
      });
      const issue = await port.publier({
        canal: cible.conversationId,
        texte,
        ...(fichierIds !== undefined ? { fichierIds } : {}),
      });
      if (!issue.ok) throw new Error(issue.raison);
    },
    logger,
    now: () => horloge.at,
  });
  return { dir, store, service, publies, journal, horloge };
}

type AnyTool = {
  name: string;
  description: string;
  execute: (...args: unknown[]) => Promise<{
    content: Array<{ type: string; text?: string }>;
    details?: unknown;
  }>;
};

/** Outil réel, port réel : on appelle EXACTEMENT ce que le modèle appellerait. */
function toolOf(service: EnvoisProgrammesService, conversation: { canal?: string; session?: string }) {
  const port: ScheduledSendPort = {
    programmer: async (request) => service.programmer(request),
  };
  const [tool] = createScheduledSendTools(port, { conversation: () => conversation }) as unknown as AnyTool[];
  if (!tool) throw new Error("aucun outil `programmer_envoi` construit");
  return tool;
}

function texteOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((part) => part.text ?? "").join("\n");
}

describe("envois programmés — interprétation de `quand` (lot 28)", () => {
  it("accepte un DÉLAI RELATIF (la forme la plus robuste pour un modèle)", () => {
    expect(analyserQuand("dans 30 min", T0)).toEqual({ ok: true, at: T0 + 30 * 60_000, forme: "relatif" });
    expect(analyserQuand("dans 2h", T0)).toEqual({ ok: true, at: T0 + 2 * 3_600_000, forme: "relatif" });
    expect(analyserQuand("dans 90 s", T0)).toEqual({ ok: true, at: T0 + 90_000, forme: "relatif" });
    expect(analyserQuand("dans 3 jours", T0)).toEqual({ ok: true, at: T0 + 3 * 86_400_000, forme: "relatif" });
  });

  it("accepte une ISO AVEC décalage (aucune ambiguïté) et une heure seule", () => {
    const iso = analyserQuand("2026-11-04T16:10:00+01:00", T0);
    expect(iso).toEqual({ ok: true, at: Date.parse("2026-11-04T15:10:00Z"), forme: "iso" });
    // « 16:10 » = heure de Yuki (Europe/Paris, UTC+1 le 4 novembre) ⇒ 15:10 UTC.
    const heure = analyserQuand("16:10", T0);
    expect(heure).toEqual({ ok: true, at: Date.parse("2026-11-04T15:10:00Z"), forme: "heure" });
  });

  it("⚠️ n'utilise JAMAIS le fuseau du processus (conteneur en UTC)", () => {
    // Le piège documenté dans `src/sources/cron.ts:21-22`. Si on retombait sur
    // `Date.parse("2026-11-04T16:10")` littéral, l'instant serait 16:10 UTC = 17:10
    // à Paris : le message partirait une heure trop tard.
    const nue = analyserQuand("2026-11-04T16:10", T0);
    expect(nue.ok).toBe(true);
    if (nue.ok) {
      expect(new Date(nue.at).toISOString()).toBe("2026-11-04T15:10:00.000Z");
    }
  });

  it("refuse une forme incompréhensible en NOMMANT les formes acceptées", () => {
    const issue = analyserQuand("ce soir", T0);
    expect(issue.ok).toBe(false);
    if (!issue.ok) {
      expect(issue.raison).toContain("dans 30 min");
      expect(issue.raison).toContain("16:10");
    }
  });

  it("refuse une heure qui n'existe pas, et une unité inconnue", () => {
    expect(analyserQuand("25:99", T0).ok).toBe(false);
    expect(analyserQuand("0 0 31 2 *", T0).ok).toBe(false);
    const unite = analyserQuand("dans 4 quinzaines", T0);
    expect(unite.ok).toBe(false);
    if (!unite.ok) {
      expect(unite.raison).toContain("quinzaines");
      expect(unite.raison).toContain("Utilise s (secondes)");
    }
  });

  it("l'instant rendu est TOUJOURS formaté avec son fuseau", () => {
    expect(formaterInstantEnvoi(Date.parse("2026-11-04T15:10:00Z"))).toContain("16:10");
    expect(formaterInstantEnvoi(Date.parse("2026-11-04T15:10:00Z"))).toContain("Europe/Paris");
  });
});

describe("envois programmés — programmation et exécution", () => {
  it("① un envoi PART À L'HEURE DUE, dans la conversation demandée", async () => {
    const rig = makeRig();
    const tool = toolOf(rig.service, { canal: "mm-general" });

    const result = await tool.execute("call-1", {
      quand: "dans 70 min",
      texte: "Voici l'image promise.",
      canal: "L'Imagerie",
    });
    const texte = texteOf(result);
    expect(texte).toContain("Envoi programmé");
    // L'heure EFFECTIVE est rendue au modèle, fuseau compris : il peut la répéter.
    expect(texte).toContain("16:10");
    expect(texte).toContain("L'Imagerie");
    // Aucune exécution prématurée.
    expect(rig.publies).toHaveLength(0);

    // Le balayeur ne fait rien 1 min trop tôt…
    rig.horloge.at = T0 + 60_000;
    expect(await rig.service.executerDus(rig.horloge.at)).toBe(0);
    expect(rig.publies).toHaveLength(0);

    // … et publie à l'heure dite, dans LE BON canal.
    rig.horloge.at = T0 + 70 * 60_000;
    expect(await rig.service.executerDus(rig.horloge.at)).toBe(1);
    expect(rig.publies).toEqual([
      { cible: { conversationId: "mm-imagerie" }, texte: "Voici l'image promise." },
    ]);
    expect(rig.store.list()[0]?.etat).toBe("envoye");
  });

  it("② un envoi AVEC FICHIERS les publie (identifiants transmis au port d'envoi)", async () => {
    const rig = makeRig({
      fichiers: { "0123456789abcdef": { sessionId: "mm-general", name: "image.png", bytes: 4_096 } },
    });
    const tool = toolOf(rig.service, { canal: "mm-general" });

    const result = await tool.execute("call-2", {
      quand: "dans 5 min",
      texte: "L'image du jour.",
      canal: "L'Imagerie",
      fichier_ids: ["0123456789abcdef"],
    });
    expect(texteOf(result)).toContain("Envoi programmé");

    rig.horloge.at = T0 + 5 * 60_000;
    expect(await rig.service.executerDus(rig.horloge.at)).toBe(1);
    // ⚠️ Requête capturée : le canal cible ET les fichiers. L'adaptateur en fait des
    // `file_ids` (Mattermost) ou un multipart (Discord) — couvert par
    // `tests/chat/mattermost-files.test.ts`.
    expect(rig.publies[0]?.cible).toEqual({ conversationId: "mm-imagerie" });
    expect(rig.publies[0]?.fichierIds).toEqual(["0123456789abcdef"]);
  });

  it("③ ⚠️ AUCUN MODÈLE n'est appelé à l'heure dite (le texte est FIGÉ)", async () => {
    // Le seul chemin de publication d'une cible LOCALE est `publierMessage` — celui de
    // `envoyer_message` en local (`src/pi/sdk-host.ts:2489`). `send()` (qui DÉMARRE un
    // run de modèle) n'est jamais appelé : c'est ça, « aucun run ».
    const appels: string[] = [];
    const host = {
      publierMessage: async (_sessionId: string, texte: string) => {
        appels.push(`publierMessage:${texte}`);
      },
      send: () => {
        appels.push("send");
        throw new Error("un envoi programmé ne doit JAMAIS démarrer un run");
      },
    };
    const dir = tmpDir();
    const horloge = { at: T0 };
    const store = EnvoisProgrammesStore.open({ path: join(dir, "envois.json"), now: () => horloge.at });
    const service = new EnvoisProgrammesService({
      store,
      canaux: () => CANAUX,
      publier: async ({ cible, texte }) => {
        if (cible.type !== "local") throw new Error("cible inattendue");
        await host.publierMessage(cible.sessionId, texte);
      },
      logger,
      now: () => horloge.at,
    });
    const tool = toolOf(service, { session: "session-locale-1" });
    const result = await tool.execute("call-3", { quand: "dans 2 min", texte: "Message figé." });
    expect(texteOf(result)).toContain("aucun modèle ne sera appelé");

    horloge.at = T0 + 2 * 60_000;
    expect(await service.executerDus(horloge.at)).toBe(1);
    expect(appels).toEqual(["publierMessage:Message figé."]);
  });

  it("④ l'envoi SURVIT à un redémarrage (store relu depuis le disque, mode 0600)", async () => {
    const rig = makeRig();
    const tool = toolOf(rig.service, { canal: "mm-general" });
    await tool.execute("call-4", { quand: "dans 10 min", texte: "Après redémarrage." });

    const chemin = join(rig.dir, "envois-programmes.json");
    expect(statSync(chemin).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(chemin, "utf8")).envois).toHaveLength(1);

    // REDÉMARRAGE : nouveau store sur le MÊME fichier, nouvel horodatage.
    const horloge = { at: T0 + 10 * 60_000 };
    const store = EnvoisProgrammesStore.open({ path: chemin, now: () => horloge.at });
    expect(store.list()).toHaveLength(1);
    const publies: string[] = [];
    const service = new EnvoisProgrammesService({
      store,
      canaux: () => CANAUX,
      publier: async ({ texte }) => {
        publies.push(texte);
      },
      logger,
      now: () => horloge.at,
    });
    expect(await service.executerDus(horloge.at)).toBe(1);
    expect(publies).toEqual(["Après redémarrage."]);
  });

  it("⑤ un envoi ANNULÉ ne part pas, et l'annulation est journalisée", async () => {
    const rig = makeRig();
    const tool = toolOf(rig.service, { canal: "mm-general" });
    await tool.execute("call-5", { quand: "dans 20 min", texte: "À annuler." });
    const id = rig.store.list()[0]?.id as string;

    const annulation = rig.service.annuler(id);
    expect(annulation.ok).toBe(true);
    expect(rig.store.list()[0]?.etat).toBe("annule");

    rig.horloge.at = T0 + 20 * 60_000;
    expect(await rig.service.executerDus(rig.horloge.at)).toBe(0);
    expect(rig.publies).toHaveLength(0);

    const evenements = rig.journal.recent(20).map((evenement) => evenement.event);
    expect(evenements).toContain("envoi_programme");
    expect(evenements).toContain("envoi_annule");
    // Un envoi DÉJÀ parti ne peut plus être annulé : le refus le dit.
    expect(rig.service.annuler(id).ok).toBe(false);
  });

  it("⑦ une cible DISPARUE est un échec EXPLICITE et JOURNALISÉ (aucune perte muette)", async () => {
    const rig = makeRig({ panne: "Ce canal n'est pas suivi par Yuki." });
    const tool = toolOf(rig.service, { canal: "mm-general" });
    await tool.execute("call-7", { quand: "dans 3 min", texte: "Vers un canal quitté." });

    rig.horloge.at = T0 + 3 * 60_000;
    expect(await rig.service.executerDus(rig.horloge.at)).toBe(0);
    const envoi = rig.store.list()[0];
    expect(envoi?.etat).toBe("echoue");
    expect(envoi?.raison).toContain("canal n'est pas suivi");
    const echec = rig.journal.recent(10).find((evenement) => evenement.event === "envoi_echec");
    expect(echec?.raison).toContain("canal n'est pas suivi");
  });

  it("⑦bis un canal retiré du miroir est refusé DÈS la programmation (message actionnable)", async () => {
    const rig = makeRig();
    const tool = toolOf(rig.service, { canal: "mm-general" });
    const result = await tool.execute("call-7b", { quand: "dans 3 min", texte: "x", canal: "Nulle part" });
    const texte = texteOf(result);
    expect(texte).toContain("Rien n'a été programmé");
    expect(texte).toContain("Canaux réellement disponibles");
    expect(rig.store.list()).toHaveLength(0);
  });

  it("⚠️ REPRISE : un envoi manqué de moins d'1 h est publié au redémarrage, au-delà il ÉCHOUE", async () => {
    const rig = makeRig();
    const tool = toolOf(rig.service, { canal: "mm-general" });
    // 2 h 40 plus tard : à T0+3 h, il n'a que 20 min de retard (< 1 h) ⇒ rattrapé.
    await tool.execute("call-r1", { quand: "dans 160 min", texte: "Raté de 20 min." });
    await tool.execute("call-r2", { quand: "dans 6 min", texte: "Raté de 3 h." });

    const chemin = join(rig.dir, "envois-programmes.json");
    // Le serveur était arrêté : on revient 3 h plus tard.
    const horloge = { at: T0 + 3 * 3_600_000 };
    const store = EnvoisProgrammesStore.open({ path: chemin, now: () => horloge.at });
    const publies: string[] = [];
    const service = new EnvoisProgrammesService({
      store,
      canaux: () => CANAUX,
      publier: async ({ texte }) => {
        publies.push(texte);
      },
      logger,
      now: () => horloge.at,
    });
    expect(await service.executerDus(horloge.at)).toBe(1);
    // ⚠️ Décision : moins d'UNE HEURE de retard ⇒ publié ; au-delà ⇒ échoué avec une
    // raison (même seuil que le rattrapage des déclencheurs, `RATTRAPAGE_MAX_MS`).
    expect(publies).toEqual(["Raté de 20 min."]);
    const echoue = store.list().find((envoi) => envoi.texte === "Raté de 3 h.");
    expect(echoue?.etat).toBe("echoue");
    expect(echoue?.raison).toContain("rattrapage maximal");
    expect(RATTRAPAGE_MAX_ENVOI_MS).toBe(3_600_000);
  });

  it("⚠️ REPRISE : un envoi resté « en cours » (arrêt brutal) n'est JAMAIS rejoué", async () => {
    const rig = makeRig();
    const tool = toolOf(rig.service, { canal: "mm-general" });
    await tool.execute("call-c1", { quand: "dans 2 min", texte: "Peut-être déjà parti." });
    const id = rig.store.list()[0]?.id as string;
    // État laissé par un arrêt PENDANT la publication.
    rig.store.marquer(id, "en_cours");

    const chemin = join(rig.dir, "envois-programmes.json");
    const horloge = { at: T0 + 3 * 60_000 };
    const store = EnvoisProgrammesStore.open({ path: chemin, now: () => horloge.at });
    const publies: string[] = [];
    const service = new EnvoisProgrammesService({
      store,
      canaux: () => CANAUX,
      publier: async ({ texte }) => {
        publies.push(texte);
      },
      logger,
      now: () => horloge.at,
    });
    await service.executerDus(horloge.at);
    // Un doublon serait pire qu'un manque : il n'est pas rejoué, et c'est DIT.
    expect(publies).toEqual([]);
    expect(store.list()[0]?.etat).toBe("echoue");
    expect(store.list()[0]?.raison).toContain("PAS rejoué");
  });
});

describe("envois programmés — bornes (refus explicites)", () => {
  const cas: Array<[string, Record<string, unknown>, string]> = [
    ["texte vide", { quand: "dans 5 min", texte: "   " }, "le message est vide"],
    ["date passée", { quand: "2026-11-04T09:00:00+01:00", texte: "trop tard" }, "déjà passée"],
    ["délai minimal", { quand: "dans 1 s", texte: "trop tôt" }, "au moins 30 secondes"],
    [
      "horizon dépassé",
      { quand: `dans ${Math.round(HORIZON_MAX_MS / 86_400_000) + 1} jours`, texte: "trop loin" },
      "horizon maximal",
    ],
  ];

  for (const [nom, params, attendu] of cas) {
    it(`refuse ${nom}`, async () => {
      const rig = makeRig();
      const tool = toolOf(rig.service, { canal: "mm-general" });
      const result = await tool.execute("call", params);
      const texte = texteOf(result);
      expect(texte).toContain("Rien n'a été programmé");
      expect(texte).toContain(attendu);
      expect(rig.store.list()).toHaveLength(0);
    });
  }

  it(`refuse au-delà de ${MAX_ENVOIS_EN_ATTENTE} envois en attente (plafond nommé)`, async () => {
    const rig = makeRig();
    const tool = toolOf(rig.service, { canal: "mm-general" });
    for (let index = 0; index < MAX_ENVOIS_EN_ATTENTE; index += 1) {
      const result = await tool.execute(`call-${index}`, {
        quand: "dans 30 min",
        texte: `message ${index}`,
      });
      expect(texteOf(result)).toContain("Envoi programmé");
    }
    const refus = await tool.execute("call-trop", { quand: "dans 30 min", texte: "de trop" });
    expect(texteOf(refus)).toContain("Rien n'a été programmé");
    expect(texteOf(refus)).toContain(String(MAX_ENVOIS_EN_ATTENTE));
    expect(rig.store.list()).toHaveLength(MAX_ENVOIS_EN_ATTENTE);
    // ⚠️ Un envoi PARTI libère la place : le plafond ne porte que sur l'ATTENTE.
    rig.horloge.at = T0 + 30 * 60_000;
    await rig.service.executerDus(rig.horloge.at);
    const apres = await tool.execute("call-apres", { quand: "dans 30 min", texte: "ça repasse" });
    expect(texteOf(apres)).toContain("Envoi programmé");
  });

  it("refuse des pièces jointes vers une conversation LOCALE (aucun envoi de fichier local)", async () => {
    const rig = makeRig({
      fichiers: { abcdef0123456789: { sessionId: "session-locale", name: "a.png", bytes: 10 } },
    });
    const tool = toolOf(rig.service, { session: "session-locale" });
    const result = await tool.execute("call", {
      quand: "dans 5 min",
      texte: "avec fichier",
      fichier_ids: ["abcdef0123456789"],
    });
    expect(texteOf(result)).toContain("les pièces jointes ne partent que dans un CANAL");
    expect(rig.store.list()).toHaveLength(0);
  });

  it("refuse un fichier d'une AUTRE conversation (même validation que publier_dans_canal)", async () => {
    const rig = makeRig({
      fichiers: { "ffffffffffffffff": { sessionId: "mm-ailleurs", name: "fuite.png", bytes: 10 } },
    });
    const tool = toolOf(rig.service, { canal: "mm-general" });
    const result = await tool.execute("call", {
      quand: "dans 5 min",
      texte: "avec fichier",
      canal: "L'Imagerie",
      fichier_ids: ["ffffffffffffffff"],
    });
    // ⚠️ Le refus vient de la validation PARTAGÉE avec `publier_dans_canal` : même
    // phrase, donc la personne ne lit pas deux versions de la même règle.
    expect(texteOf(result)).toContain("n'appartient pas à cette conversation");
    expect(rig.store.list()).toHaveLength(0);
  });

  it("applique la BORNE de la plateforme dès la programmation (troncature DITE)", async () => {
    const rig = makeRig();
    const tool = toolOf(rig.service, { canal: "dc-salons" });
    const long = "a".repeat(5_000);
    const result = await tool.execute("call", { quand: "dans 5 min", texte: long, canal: "salons" });
    const texte = texteOf(result);
    expect(texte).toContain("TRONQUÉ");
    // Ce qui est stocké est exactement ce qui partira (Discord : 2 000 caractères).
    expect(rig.store.list()[0]?.texte.length).toBeLessThan(2_100);
  });
});

describe("envois programmés — invariant « un seul rédacteur »", () => {
  it("⑧ ⚠️ le WORKER LOURD n'a PAS `programmer_envoi`", () => {
    expect(TOOL_POLICY.heavy.envoisProgrammes).toEqual([]);
    // Même en demandant explicitement l'activation, la politique du rôle lourd refuse.
    expect(toolAllowlist("heavy", { envoisProgrammesEnabled: true })).not.toContain("programmer_envoi");
    expect(TOOL_POLICY.light.envoisProgrammes).toEqual(["programmer_envoi"]);
    expect(toolAllowlist("light", { envoisProgrammesEnabled: true })).toContain("programmer_envoi");
  });

  it("est classé dans le groupe `toujours` (aucun réglage d'accès distant)", () => {
    expect(remoteToolGroup("programmer_envoi")).toBe("toujours");
    // ⚠️ Et il n'exige AUCUNE approbation : programmer un message ne touche à rien.
    expect(toolAllowlist("light", { envoisProgrammesEnabled: true })).toContain("programmer_envoi");
  });
});

describe("envois programmés — c'est le BALAYEUR EXISTANT qui les exécute", () => {
  const record: SourceRecord = {
    nom: "news",
    consigne: "",
    visibilite: "silencieux",
    destination: "conversation",
    tour: "stocker",
    notifier: false,
    actif: true,
    preAutorisations: [],
    cree: new Date(T0).toISOString(),
    maj: new Date(T0).toISOString(),
    declencheur: { type: "webhook" },
    chevauchement: "sauter",
    rattrapage: "rattraper",
  };

  it("⑨ aucun SECOND `setInterval` : un seul, et il exécute les envois dus", async () => {
    const rig = makeRig();
    const tool = toolOf(rig.service, { canal: "mm-general" });
    await tool.execute("call-b1", { quand: "dans 2 min", texte: "Depuis le balayeur." });

    const intervalles: number[] = [];
    let maintenant = T0;
    let tic: (() => void) | undefined;
    const balayeur = new DeclencheurBalayeur({
      store: {
        list: () => [record],
        get: () => record,
        markPlanification: () => record,
        setActif: () => record,
        incrementerTour: () => 1,
        // Le port du balayeur compte aussi les passages tirés (lot 32) : ce double ne
        // s'en sert pas, mais il doit satisfaire le contrat.
        incrementerOccurrence: () => 1,
      },
      // Le run des déclencheurs n'est jamais appelé ici (aucun planning).
      run: async () => ({ outcome: "failed", raison: "sans objet" }) as never,
      logger,
      journal: rig.journal,
      envoisProgrammes: { executerDus: (at) => rig.service.executerDus(at) },
      now: () => maintenant,
      setInterval: (_callback, delayMs) => {
        intervalles.push(delayMs);
        tic = _callback;
        return "handle";
      },
      clearInterval: () => undefined,
      setTimeout: () => "timeout",
      clearTimeout: () => undefined,
    });
    balayeur.start();
    expect(intervalles).toEqual([30_000]);
    // Le balayage IMMÉDIAT de `start()` a lieu à T0 : rien n'est encore dû.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(rig.publies).toHaveLength(0);

    maintenant = T0 + 2 * 60_000;
    tic?.();
    // Le tick est asynchrone : on laisse la boucle d'événements le terminer.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(rig.publies.map((entree) => entree.texte)).toEqual(["Depuis le balayeur."]);
    balayeur.stop();
    // ⚠️ UN SEUL intervalle pour TOUT le processus, même avec le lot 28.
    expect(intervalles).toHaveLength(1);
  });

  it("un envoi en échec n'empêche pas le balayeur de continuer", async () => {
    const rig = makeRig();
    const tool = toolOf(rig.service, { canal: "mm-general" });
    await tool.execute("call-b2", { quand: "dans 1 min", texte: "Va échouer." });
    let appels = 0;
    const balayeur = new DeclencheurBalayeur({
      store: {
        list: () => [record],
        get: () => record,
        markPlanification: () => record,
        setActif: () => record,
        incrementerTour: () => 1,
        // Le port du balayeur compte aussi les passages tirés (lot 32) : ce double ne
        // s'en sert pas, mais il doit satisfaire le contrat.
        incrementerOccurrence: () => 1,
      },
      run: async () => ({ outcome: "failed" }) as never,
      logger,
      envoisProgrammes: {
        executerDus: async () => {
          appels += 1;
          throw new Error("panne de publication");
        },
      },
      now: () => T0 + 60_000,
      setInterval: () => "handle",
      clearInterval: () => undefined,
    });
    await expect(balayeur.tick()).resolves.toBeUndefined();
    expect(appels).toBe(1);
  });
});

describe("envois programmés — bornes exposées et description de l'outil", () => {
  it("⚠️ « envois » est un nom de source RÉSERVÉ (collision avec l'API des envois)", () => {
    // Sans cela, `DELETE /api/sources/envois` répondrait à la route d'ANNULATION au lieu
    // de supprimer une source nommée « envois » — et `GET /api/sources/envois` renverrait
    // la liste des envois au lieu de la source.
    expect(() => validateSourceName("envois")).toThrow(/réservé par l'API/u);
    expect(() => validateSourceName("inbox")).toThrow(/réservé par l'API/u);
    expect(validateSourceName("envois-du-jour")).toBe("envois-du-jour");
  });

  it("la description DIT que le texte est figé et qu'aucun modèle n'est appelé", () => {
    const rig = makeRig();
    const tool = toolOf(rig.service, { canal: "mm-general" });
    expect(tool.description).toContain("FIGÉ");
    expect(tool.description).toContain("aucun modèle ne sera appelé");
    expect(tool.description).toContain("n'invente JAMAIS un minuteur");
  });

  it("le délai minimal et l'horizon exportés sont ceux annoncés à l'outil", () => {
    expect(DELAI_MIN_MS).toBe(30_000);
    expect(HORIZON_MAX_MS).toBe(30 * 86_400_000);
  });
});
