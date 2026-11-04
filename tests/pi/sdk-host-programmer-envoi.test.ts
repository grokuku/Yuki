/**
 * MODE LOCAL (web) et fil « Déclencheurs » — `programmer_envoi` est FOURNI au modèle.
 *
 * ⚠️ L'INCOHÉRENCE OBSERVÉE EN PRODUCTION (2026-11-04, captures du même moment) :
 *  - sur l'INTERFACE WEB (17:53-17:57), Yuki répond « je n'ai pas de minuteur, et je ne
 *    peux pas t'écrire dans trois heures de moi-même » — et propose des CONTOURNEMENTS
 *    (« pose un minuteur sur une de tes machines », « mets-en un sur ton téléphone ») ;
 *  - sur MATTERMOST à 18h00, l'image demandée EST postée à l'heure dite.
 * ⇒ l'outil fonctionnait dans un run de CANAL et manquait à la conversation LOCALE.
 *
 * ⚠️ CE QUE CE FICHIER VERROUILLE (et qui manquait) :
 *  ① le host LOCAL construit RÉELLEMENT l'outil (le port lui est passé, `src/index.ts`,
 *    et `createPiHost` le construit, `src/pi/sdk-host.ts`) — un tool construit mais
 *    absent de l'allowlist serait également invisible pour le modèle ;
 *  ② la cible par DÉFAUT d'un appel local est la conversation COURANTE (la session de
 *    l'appel), et non un canal : c'est le fil d'où la personne parle ;
 *  ③ l'envoi DÛ part dans cette conversation locale par `PiHost.publierMessage` — le
 *    chemin de `envoyer_message` en local, jamais `send()` (qui démarrerait un run) ;
 *  ④ le fil « Déclencheurs » (session LOCALE lui aussi) obtient la même capacité ;
 *  ⑤ le WORKER LOURD ne l'a pas (invariant « un seul rédacteur ») ;
 *  ⑥ AUCUNE consigne ne dit plus qu'elle « n'a pas de minuteur » (le mensonge du prompt).
 *
 * ⚠️ Le temps est INJECTÉ (`now`) : rien n'attend 30 secondes ni une heure.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EnvoisProgrammesService,
  EnvoisProgrammesStore,
} from "../../src/chat/envois/index.js";
import { TOOL_POLICY, toolAllowlist, toolAllowlistForChat } from "../../src/llm/tool-policy.js";
import type { PiEvent, PiLogger } from "../../src/pi/types.js";

type AnyTool = {
  name: string;
  description: string;
  execute: (...args: unknown[]) => Promise<{
    content: Array<{ type: string; text?: string }>;
    details?: unknown;
  }>;
};

const stub = vi.hoisted(() => ({
  appended: [] as Array<{ role?: unknown; content?: unknown }>,
  /** Outils custom REÇUS par le runtime local (ce que le SDK exposerait au modèle). */
  customTools: [] as Array<{ name?: string }>,
  /** Appels à `prompt()` : un run de modèle. Un envoi programmé ne doit en faire AUCUN. */
  prompts: [] as string[],
}));

vi.mock("../../src/pi/sdk/session-factory.js", () => ({
  createLightRuntime: async (options: { customTools?: Array<{ name?: string }> }) => {
    stub.customTools = options.customTools ?? [];
    const session = {
      sessionId: "session-reelle",
      subscribe: () => () => undefined,
      prompt: async (texte?: string) => {
        stub.prompts.push(texte ?? "");
        return undefined;
      },
      abort: async () => undefined,
      sessionManager: {
        getSessionId: () => "session-reelle",
        getSessionName: () => undefined,
        getSessionFile: () => undefined,
        getBranch: () => [],
        appendMessage: (message: { role?: unknown; content?: unknown }) => {
          stub.appended.push(message);
          return "entry-publiee";
        },
        appendCustomEntry: () => "entry-custom",
      },
    };
    return { session };
  },
}));

vi.mock("../../src/pi/sdk/model-runtime.js", () => ({
  getSharedModelRuntime: async () => ({}),
  resolveSdkModel: () => undefined,
  resolveSdkThinking: () => undefined,
}));

import { createSdkPiHost } from "../../src/pi/sdk-host.js";
import type { ScheduledSendRequest } from "../../src/pi/sdk/scheduled-send-tool.js";

const noopLogger: PiLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Instant de référence : 4 novembre 2026, 15 h 00 à Paris (= 14 h UTC). */
const T0 = Date.parse("2026-11-04T14:00:00Z");

const temps: string[] = [];

afterEach(() => {
  stub.appended.length = 0;
  stub.customTools = [];
  stub.prompts.length = 0;
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-programmer-envoi-local-"));
  temps.push(dir);
  return dir;
}

/** Host local réel : seul le runtime (SDK) est doublé, la façade ne l'est pas. */
function makeHost(port?: { programmer: (request: ScheduledSendRequest) => Promise<unknown> }) {
  const dir = tmpDir();
  return createSdkPiHost({
    agentDir: join(dir, "agent"),
    cwd: join(dir, "workspace"),
    home: join(dir, "home"),
    sessionsDir: join(dir, "sessions"),
    systemPrompt: "prompt système de test",
    logger: noopLogger,
    ...(port !== undefined
      ? {
          envoisProgrammes: {
            programmer: port.programmer as never,
          },
        }
      : {}),
  });
}

/** Contexte d'outil minimal : la conversation vient de `getSessionId()`. */
function contexteLocal(sessionId = "session-reelle") {
  return { sessionManager: { getSessionId: () => sessionId } };
}

function texteOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((part) => part.text ?? "").join("\n");
}

describe("① câblage de PRODUCTION — le host LOCAL reçoit réellement le port", () => {
  // ⚠️ POURQUOI CE GARDE-FOU STATIQUE : les tests ci-dessous fournissent le port à
  // `createSdkPiHost` — ils prouvent donc que le host SAIT construire l'outil, pas que
  // la PRODUCTION le lui donne. Or c'est exactement le trou qui a produit la panne :
  // « le port n'est pas passé à `sdk-host.ts` ». `src/index.ts` n'est pas instanciable
  // dans un test unitaire (volumes, réseau, port GPU) : on verrouille donc le CÂBLAGE
  // dans la source, comme `tests/memory/write-model.test.ts` le fait déjà.
  const index = readFileSync(join(process.cwd(), "src", "index.ts"), "utf8");
  const sdkHost = readFileSync(join(process.cwd(), "src", "pi", "sdk-host.ts"), "utf8");

  /** Bloc d'options de l'appel `createPiHost({ … })` (équilibrage d'accolades). */
  function optionsDuHostLocal(): string {
    const appel = index.indexOf("createPiHost({");
    expect(appel, "appel `createPiHost` introuvable dans `src/index.ts`").toBeGreaterThan(-1);
    const debut = index.indexOf("{", appel);
    let profondeur = 0;
    for (let i = debut; i < index.length; i += 1) {
      const c = index[i];
      if (c === "{") profondeur += 1;
      if (c === "}") {
        profondeur -= 1;
        if (profondeur === 0) return index.slice(debut, i + 1);
      }
    }
    throw new Error("bloc d'options de `createPiHost` non refermé");
  }

  it("le host de la conversation LOCALE reçoit `envoisProgrammes`", () => {
    expect(optionsDuHostLocal()).toContain("envoisProgrammes: portEnvoisProgrammes");
  });

  it("`createSdkPiHost` CONSTRUIT l'outil quand le port est fourni", () => {
    expect(sdkHost).toContain("createScheduledSendTools(options.envoisProgrammes");
  });

  it("④ le fil « Déclencheurs » et les runs de déclencheur sont le MÊME host local", () => {
    // `sourcesService` reçoit le host comme WAKER : la session du fil « Déclencheurs »
    // (`newSession`) et le tour d'un déclencheur (`send`) sont des sessions LOCALES de
    // CE host — donc la MÊME liste d'outils, sans seconde liste à maintenir.
    expect(index).toContain("sourcesService.setWaker(host)");
  });

  it("la politique LOCALE du léger l'active (`envoisProgrammesEnabled`)", () => {
    // Sans cette option, `toolAllowlistForChat("light", …, { chatMode: "local" })`
    // n'inclurait pas `programmer_envoi` : un outil CONSTRUIT mais absent de
    // l'allowlist est invisible pour le modèle (le SDK filtre les `customTools`).
    expect(index).toContain("envoisProgrammesEnabled: true");
  });
});

describe("mode LOCAL — `programmer_envoi` est dans les outils du modèle", () => {
  it("① le runtime local REÇOIT l'outil (sinon il est invisible, quel que soit le prompt)", async () => {
    const demandes: ScheduledSendRequest[] = [];
    const host = makeHost({
      programmer: async (request) => {
        demandes.push(request);
        return {
          ok: true,
          quandLisible: "4 novembre 2026 à 15:10 (Europe/Paris)",
          cibleLisible: "cette conversation",
          tronque: false,
          enAttente: 1,
        };
      },
    });
    await host.start();

    const tool = (stub.customTools as AnyTool[]).find(
      (candidate) => candidate.name === "programmer_envoi",
    );
    expect(tool, "le runtime local doit recevoir `programmer_envoi`").toBeDefined();

    await host.stop();
  });

  it("② ⚠️ la cible par DÉFAUT est la conversation COURANTE (aucun canal imposé)", async () => {
    const demandes: ScheduledSendRequest[] = [];
    const host = makeHost({
      programmer: async (request) => {
        demandes.push(request);
        return {
          ok: true,
          quandLisible: "4 novembre 2026 à 15:10 (Europe/Paris)",
          cibleLisible: "cette conversation",
          tronque: false,
          enAttente: 1,
        };
      },
    });
    await host.start();
    const tool = (stub.customTools as AnyTool[]).find(
      (candidate) => candidate.name === "programmer_envoi",
    ) as AnyTool;

    const result = await tool.execute(
      "appel-1",
      { quand: "dans 10 min", texte: "C'EST L'HEURE DE RENTRER À LA MAISON" },
      undefined,
      undefined,
      contexteLocal(),
    );

    // La conversation courante est la SESSION de l'appel — et `canal` reste absent
    // (sinon le service croirait à un run de canal et exigerait un canal suivi).
    expect(demandes).toHaveLength(1);
    expect(demandes[0]?.conversation).toEqual({ session: "session-reelle" });
    expect(demandes[0]?.canal).toBeUndefined();
    expect(texteOf(result)).toContain("Envoi programmé");
    // L'heure EFFECTIVE est rendue au modèle : il peut la répéter sans l'inventer.
    expect(texteOf(result)).toContain("15:10");

    await host.stop();
  });

  it("④ le fil « Déclencheurs » (session locale) obtient la MÊME capacité, par appel", async () => {
    const demandes: ScheduledSendRequest[] = [];
    const host = makeHost({
      programmer: async (request) => {
        demandes.push(request);
        return {
          ok: true,
          quandLisible: "4 novembre 2026 à 15:10 (Europe/Paris)",
          cibleLisible: "conversation 0123abcd…",
          tronque: false,
          enAttente: 1,
        };
      },
    });
    await host.start();
    const tool = (stub.customTools as AnyTool[]).find(
      (candidate) => candidate.name === "programmer_envoi",
    ) as AnyTool;

    // ⚠️ Le host est PARTAGÉ : les outils ne sont construits qu'UNE fois pour toutes les
    // conversations. La session visée doit donc être relue à CHAQUE appel — sans quoi un
    // envoi demandé dans « Déclencheurs » partirait dans une autre conversation.
    await tool.execute(
      "appel-1",
      { quand: "dans 10 min", texte: "depuis le fil Déclencheurs" },
      undefined,
      undefined,
      contexteLocal("session-declencheurs"),
    );
    expect(demandes[0]?.conversation).toEqual({ session: "session-declencheurs" });

    await host.stop();
  });
});

describe("mode LOCAL — programmation et publication DANS la conversation locale", () => {
  it("③ l'envoi part à l'heure due dans le fil local, sans AUCUN run de modèle", async () => {
    const dir = tmpDir();
    const horloge = { at: T0 };
    const store = EnvoisProgrammesStore.open({
      path: join(dir, "envois-programmes.json"),
      now: () => horloge.at,
    });

    // ⚠️ La publication passe par `PiHost.publierMessage` — le chemin exact de
    // `envoyer_message` en local et du résultat d'un déclencheur : même persistance
    // (`appendMessage`), mêmes trames, même ordre. Aucune file parallèle.
    const hostRef: { host?: Awaited<ReturnType<typeof makeHost>> } = {};
    const service = new EnvoisProgrammesService({
      store,
      canaux: () => [],
      publier: async ({ cible, texte }) => {
        if (cible.type !== "local") throw new Error("cible inattendue : la conversation locale");
        const host = hostRef.host;
        if (!host || typeof host.publierMessage !== "function") {
          throw new Error("Ce host ne sait pas publier dans une conversation sans tour de modèle.");
        }
        await host.publierMessage(cible.sessionId, texte);
      },
      logger: { info: () => undefined, warn: () => undefined },
      now: () => horloge.at,
    });

    const host = makeHost({
      programmer: async (request) => service.programmer(request),
    });
    hostRef.host = host;

    const events: PiEvent[] = [];
    host.subscribeAll((event) => events.push(event));
    await host.start();
    const sessionId = host.currentSessionId() as string;

    const tool = (stub.customTools as AnyTool[]).find(
      (candidate) => candidate.name === "programmer_envoi",
    ) as AnyTool;
    const programmation = await tool.execute(
      "appel-1",
      { quand: "dans 10 min", texte: "C'EST L'HEURE DE RENTRER À LA MAISON" },
      undefined,
      undefined,
      contexteLocal(sessionId),
    );
    expect(texteOf(programmation)).toContain("Envoi programmé");
    // La cible ANNONCÉE est lisible : « cette conversation », jamais un identifiant de
    // session brut — sinon le modèle ne peut pas confirmer la destination.
    expect(texteOf(programmation)).toContain("cette conversation");
    // Rien n'est encore parti : la programmation n'est PAS une publication.
    expect(stub.appended).toHaveLength(0);
    // La cible PERSISTÉE est locale, et c'est la session de l'appel.
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.cible).toEqual({ type: "local", sessionId });

    // ⏱️ L'heure due arrive (horloge injectée) : le balayeur exécute les dus.
    horloge.at = T0 + 10 * 60_000;
    expect(await service.executerDus(horloge.at)).toBe(1);

    // ① le message est PERSISTÉ dans le JSONL de la conversation locale ;
    expect(stub.appended).toHaveLength(1);
    expect(stub.appended[0]?.role).toBe("assistant");
    expect(JSON.stringify(stub.appended[0]?.content)).toContain(
      "C'EST L'HEURE DE RENTRER À LA MAISON",
    );
    // ② il est dans le TRANSCRIPT (donc affiché comme une réponse, rechargement compris) ;
    const etat = host.getState(sessionId);
    expect(etat?.transcript.filter((entry) => entry.role === "assistant").at(-1)?.text).toBe(
      "C'EST L'HEURE DE RENTRER À LA MAISON",
    );
    // ③ annoncé par les trames habituelles ;
    const types = events.map((event) => event.type);
    expect(types).toContain("run_started");
    expect(types).toContain("delta");
    expect(types).toContain("run_finished");
    // ④ ⚠️ AUCUN run de modèle : le texte est FIGÉ (`prompt()` n'est jamais appelé).
    expect(stub.prompts).toHaveLength(0);

    await host.stop();
  });

  it("un refus du port est DIT au modèle, et rien n'est promis", async () => {
    const host = makeHost({
      programmer: async () => ({
        ok: false,
        raison: "Rien n'a été programmé : il faut au moins 30 secondes d'avance.",
      }),
    });
    await host.start();
    const tool = (stub.customTools as AnyTool[]).find(
      (candidate) => candidate.name === "programmer_envoi",
    ) as AnyTool;

    const result = await tool.execute(
      "appel-1",
      { quand: "dans 1 s", texte: "trop tard" },
      undefined,
      undefined,
      contexteLocal(),
    );
    expect(texteOf(result)).toContain("au moins 30 secondes");
    expect(texteOf(result)).not.toContain("Envoi programmé");

    await host.stop();
  });
});

describe("mode LOCAL — politique d'outils et invariant « un seul rédacteur »", () => {
  it("la politique LOCALE du léger porte `programmer_envoi` (comme `envoyer_message`)", () => {
    // ⚠️ En mode `local`, `toolAllowlistForChat` rend la politique du rôle : c'est elle
    // qui décide que le fil local peut programmer un envoi. Un outil construit mais
    // absent de cette liste serait invisible pour le modèle — donc le mensonge du
    // prompt (« je n'ai pas de minuteur ») serait, pour lui, la vérité.
    const options = { messagesEnabled: true, envoisProgrammesEnabled: true };
    const local = toolAllowlistForChat("light", options, {
      chatMode: "local",
      remoteAgents: false,
      remoteTools: false,
    });
    expect(local).toContain("programmer_envoi");
    expect(local).toContain("envoyer_message");

    // Un run de CANAL l'a aussi, sans dépendre des deux réglages d'accès distant.
    const canal = toolAllowlistForChat("light", options, {
      chatMode: "mattermost",
      remoteAgents: false,
      remoteTools: false,
    });
    expect(canal).toContain("programmer_envoi");
  });

  it("⑤ ⚠️ le WORKER LOURD ne l'a PAS, même si on l'active", () => {
    expect(TOOL_POLICY.heavy.envoisProgrammes).toEqual([]);
    expect(toolAllowlist("heavy", { envoisProgrammesEnabled: true })).not.toContain(
      "programmer_envoi",
    );
  });
});

describe("⑥ les consignes ne disent plus qu'elle n'a pas de minuteur", () => {
  const racine = new URL("../../", import.meta.url).pathname;

  /**
   * Fichiers de consigne lus par le modèle : le prompt du léger (mode LOCAL et canal,
   * `prompts.light`) et l'injection de canal (`src/chat/reply/prompt.ts`).
   */
  function consignes(): Array<{ file: string; texte: string }> {
    // ⚠️ Le prompt du LÉGER seulement : `system-prompt-heavy.md` est celui du WORKER
    // LOURD, qui n'a pas l'outil (invariant « un seul rédacteur ») — il ne doit donc
    // surtout pas le nommer. Un test plus bas le vérifie.
    return [
      {
        file: "config/pi/system-prompt.md",
        texte: readFileSync(join(racine, "config/pi/system-prompt.md"), "utf8"),
      },
      {
        file: "src/chat/reply/prompt.ts",
        texte: readFileSync(join(racine, "src/chat/reply/prompt.ts"), "utf8"),
      },
    ];
  }

  /**
   * Texte LISSÉ : les tableaux de chaînes de `prompt.ts` sont recollés et les retours
   * à la ligne (markdown) remplacés par des espaces, pour raisonner en PHRASES.
   */
  function phrases(texte: string): string[] {
    const lisse = texte
      .replace(/"\s*,\s*\n\s*"/gu, " ")
      .replace(/[«»]/gu, " ")
      .replace(/\s+/gu, " ");
    return lisse.split(/(?<=[.!?])\s+/u);
  }

  it("⚠️ chaque phrase qui parle de « minuteur » est une INTERDICTION, jamais une affirmation", () => {
    // Le piège combattu : une consigne qui laisse croire à l'incapacité (« tu n'as pas
    // de minuteur ») l'emporte sur l'outil réellement présent — le modèle préfère
    // l'ordre le plus ancien, et il propose des contournements (« mets un minuteur sur
    // ton téléphone »). Toute phrase qui parle de minuteur doit donc porter le
    // garde-fou (interdiction, ou mise en garde contre un contournement).
    const garde = /(jamais|aucun|n'invente|ne dis|ne promets|n'as pas à dire|inutile)/iu;
    for (const { file, texte } of consignes()) {
      for (const phrase of phrases(texte)) {
        if (!/minuteur/iu.test(phrase)) continue;
        expect(
          garde.test(phrase),
          `${file} : phrase SANS interdiction autour de « minuteur » → « ${phrase.trim()} »`,
        ).toBe(true);
      }
    }
  });

  it("⚠️ le RAPPEL (« rappelle-moi dans 3 h ») est rattaché à `programmer_envoi`", () => {
    // ⚠️ LA FORMULATION DE PRODUCTION (2026-11-04, interface WEB) : « je ne peux pas
    // programmer de rappel, point final ». Le mot « rappel » n'apparaissait dans AUCUNE
    // consigne : le modèle n'avait donc aucun lien entre « rappelle-moi » et l'outil,
    // alors que c'est exactement la même capacité (texte figé + heure dite).
    for (const { file, texte } of consignes()) {
      expect(texte, `${file} doit nommer l'outil`).toContain("programmer_envoi");
      expect(texte, `${file} doit rattacher le RAPPEL à l'outil`).toMatch(/rappelle|RAPPEL/iu);
    }
  });

  it("⚠️ la consigne LOCAL (config/pi) demande l'heure EFFECTIVE et interdit les contournements", () => {
    const prompt = readFileSync(join(racine, "config/pi/system-prompt.md"), "utf8");
    expect(prompt).toContain("programmer_envoi");
    expect(prompt).toMatch(/heure\s+\*\*effective\*\*/u);
    // Les contournements (« mets un minuteur sur ton téléphone », « pose un rappel sur
    // une de tes machines ») sont explicitement écartés : ils sont inutiles.
    expect(prompt).toMatch(/contournement/iu);
  });

  it("⑤ le prompt du WORKER LOURD ne propose pas de programmer un envoi", () => {
    const lourd = readFileSync(join(racine, "config/pi/system-prompt-heavy.md"), "utf8");
    expect(lourd).not.toContain("programmer_envoi");
  });

  it("la description de l'outil nomme le RAPPEL et interdit les contournements", () => {
    const host = makeHost({
      programmer: async () => ({
        ok: true,
        quandLisible: "4 novembre 2026 à 15:10 (Europe/Paris)",
        cibleLisible: "cette conversation",
        tronque: false,
        enAttente: 1,
      }),
    });
    return host.start().then(async () => {
      const tool = (stub.customTools as AnyTool[]).find(
        (candidate) => candidate.name === "programmer_envoi",
      ) as AnyTool;
      expect(tool.description).toMatch(/RAPPEL/iu);
      expect(tool.description).toContain("contournement");
      expect(tool.description).toContain("n'invente JAMAIS un minuteur");
      await host.stop();
    });
  });
});
