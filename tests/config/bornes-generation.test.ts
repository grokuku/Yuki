/**
 * CHAÎNE DES DÉLAIS autour d'une génération d'image — vérifiée de bout en bout.
 *
 * ⚠️ LE PIÈGE QUE CE FICHIER FERME (2026-11-03) : relever le plafond de la
 * génération ne sert à RIEN si une borne plus COURTE existe en amont. Le
 * parcours d'un appel est :
 *
 *   run de canal (si `generer_image` est inline) → job lourd (si `delegate`)
 *     → chien de garde d'OUTIL → client ComfyUI (plafond de sécurité)
 *
 * Table de l'ORDRE ATTENDU (du plus court au plus long, DÉFAUTS) :
 *
 *   | délai                                    | défaut      | rôle                       |
 *   |------------------------------------------|-------------|----------------------------|
 *   | `DEFAULT_COMFY_REQUEST_TIMEOUT_MS`       |      20 000 | une requête HTTP            |
 *   | `DEFAULT_COMFY_JOB_GRACE_MS`             |      30 000 | travail DISPARU de la file  |
 *   | `DEFAULT_COMFY_POLL_INTERVAL_MS`         |       1 000 | intervalle de surveillance  |
 *   | `CHAT_REPLY_TIMEOUT_MS`                  |      90 000 | rédaction d'une réponse     |
 *   | `delegation.idleTimeoutMs`               |     120 000 | SUSPENDU pendant un outil   |
 *   | `images.timeoutMs`                       |   3 600 000 | PLAFOND de la génération    |
 *   | `toolWatchdogMs` (dérivé)                |   3 660 000 | un outil qui ne rend pas    |
 *   | borne du tour de canal (dérivée)         |   3 690 000 | 90 s + plafond              |
 *   | `delegation.totalTimeoutMs`              |   4 500 000 | génération + rapport        |
 *
 * ⚠️ Échoue sur le code d'origine : le défaut de `images.timeoutMs` y valait
 * 900 000 (15 min), `toolWatchdogMs` n'était PAS dérivé du plafond (relever l'un
 * sans l'autre était possible), et `delegation.totalTimeoutMs` valait 1 800 000
 * — donc MOINS que 1 h de génération + la rédaction.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadEnv } from "../../src/config/env.js";
import { ConfigRuntime, createConfigRuntime } from "../../src/config/runtime.js";
import { CONFIG_SCHEMA, descriptorOf } from "../../src/config/schema.js";
import { ConfigStore } from "../../src/config/store.js";
import { handleConfigRequest } from "../../src/gateway/routes/config.js";
import { CHAT_REPLY_TIMEOUT_MS } from "../../src/chat/reply/prompt.js";
import {
  DEFAULT_TOOL_WATCHDOG_MS,
  TOOL_WATCHDOG_MARGIN_MS,
  resolveToolWatchdogMs,
} from "../../src/pi/index.js";
import {
  LONG_RUNNING_TOOLS,
  channelTurnTimeoutMs,
  humanToolDuration,
  longRunningTool,
} from "../../src/llm/tool-policy.js";
import {
  DEFAULT_COMFY_GENERATION_TIMEOUT_MS,
  DEFAULT_COMFY_JOB_GRACE_MS,
  DEFAULT_COMFY_POLL_INTERVAL_MS,
  DEFAULT_COMFY_REQUEST_TIMEOUT_MS,
} from "../../src/comfy/index.js";
import { createLogger } from "../../src/observability/logger.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Défaut déclaré au SCHÉMA (source unique de vérité côté serveur). */
function defautDefaut(path: string): number {
  const descriptor = descriptorOf(path);
  if (!descriptor) throw new Error(`chemin inconnu : ${path}`);
  expect(typeof descriptor.default).toBe("number");
  return descriptor.default as number;
}

const PLAFOND = defautDefaut("images.timeoutMs");
const TOTAL_JOB = defautDefaut("delegation.totalTimeoutMs");

function makeRuntime(processEnv: NodeJS.ProcessEnv = {}): ConfigRuntime {
  const root = mkdtempSync(join(tmpdir(), "yuki-bornes-"));
  tempDirs.push(root);
  const storePath = join(root, "state", "config.json");
  const env = loadEnv({
    YUKI_MOUNT_STATE: join(root, "state"),
    YUKI_CONFIG_STORE_PATH: storePath,
    YUKI_PI_SYSTEM_PROMPT: join(root, "light.md"),
    YUKI_PI_HEAVY_SYSTEM_PROMPT: join(root, "heavy.md"),
  });
  return createConfigRuntime({
    env,
    store: new ConfigStore(storePath),
    processEnv: { ...processEnv },
    promptDefaults: { light: "prompt léger", heavy: "prompt lourd" },
  });
}

const WRITE_HEADERS = { "x-yuki-config": "1" };

describe("plafond de génération : 1 heure par défaut", () => {
  it("le défaut vaut 3 600 000 ms (1 h) et le client ComfyUI suit ce défaut", () => {
    expect(PLAFOND).toBe(3_600_000);
    // ⚠️ Le repli du CLIENT doit être la même valeur : deux défauts divergents
    // donneraient deux comportements selon qui interroge ComfyUI.
    expect(DEFAULT_COMFY_GENERATION_TIMEOUT_MS).toBe(PLAFOND);
    expect(defautDefaut("images.timeoutMs")).toBe(DEFAULT_COMFY_GENERATION_TIMEOUT_MS);
  });

  it("le `max` DÉPASSE le défaut : on peut régler plus haut qu'une heure", () => {
    const descriptor = descriptorOf("images.timeoutMs");
    expect(descriptor).toBeDefined();
    const min = descriptor?.min ?? 0;
    const max = descriptor?.max ?? Number.NEGATIVE_INFINITY;
    expect(PLAFOND).toBeGreaterThanOrEqual(min);
    // ⚠️ GARDE : un défaut ÉGAL au maximum interdirait de relever le plafond, et
    // un défaut AU-DESSUS du maximum serait refusé au premier redémarrage.
    expect(max).toBeGreaterThan(PLAFOND);
    // 2 h : la place d'un workflow VIDÉO lourd, sans attente déraisonnable.
    expect(max).toBeGreaterThanOrEqual(7_200_000);
  });

  it("la variable d'environnement documentée est YUKI_IMAGES_TIMEOUT_MS et elle est suivie", () => {
    expect(descriptorOf("images.timeoutMs")?.env).toBe("YUKI_IMAGES_TIMEOUT_MS");
    const runtime = makeRuntime({ YUKI_IMAGES_TIMEOUT_MS: "5400000" });
    expect(runtime.getNumber("images.timeoutMs")).toBe(5_400_000);
  });
});

describe("chiens de garde : aucune borne plus courte ne coupe la génération", () => {
  it("`toolWatchdogMs` RÉELLEMENT appliqué est AU-DESSUS du plafond de génération", () => {
    // ⚠️ GARDE : si quelqu'un relève `images.timeoutMs` sans le chien de garde (ou
    // l'inverse), la génération serait tuée AVANT son propre plafond.
    expect(resolveToolWatchdogMs(PLAFOND)).toBeGreaterThan(PLAFOND);
    expect(resolveToolWatchdogMs(PLAFOND)).toBe(PLAFOND + TOOL_WATCHDOG_MARGIN_MS);
    // 3 600 000 + 60 000 = 3 660 000 ms.
    expect(resolveToolWatchdogMs(PLAFOND)).toBe(3_660_000);
    // Le plancher (16 min) ne sert QUE de repli sans fournisseur : il couvre
    // `MAX_COMMAND_TIMEOUT_MS` (900 s) + la marge d'attente de 30 s.
    expect(DEFAULT_TOOL_WATCHDOG_MS).toBe(960_000);
  });

  it("le chien de garde suit le plafond, même RELEVÉ (2 h)", () => {
    const releve = 7_200_000;
    expect(resolveToolWatchdogMs(releve)).toBe(releve + TOOL_WATCHDOG_MARGIN_MS);
    expect(resolveToolWatchdogMs(releve)).toBeGreaterThan(releve);
  });

  it("`delegation.totalTimeoutMs` couvre génération + rédaction + publication", () => {
    // 75 min : 15 min de marge au-delà du plafond de 1 h pour la rédaction et la
    // publication du rapport. Un job coupé ici le serait par une limite PLUS
    // LARGE que la génération, donc sans explication possible.
    expect(TOTAL_JOB).toBe(4_500_000);
    expect(TOTAL_JOB).toBeGreaterThan(PLAFOND + 600_000);
    expect(TOTAL_JOB - PLAFOND).toBeGreaterThanOrEqual(900_000);
  });

  it("`delegation.idleTimeoutMs` est SUSPENDU pendant un outil (vérifié dans le worker)", () => {
    // ⚠️ Vérifié par `tests/pi/heavy-worker-tool-watchdog.test.ts` (« un OUTIL EN
    // COURS n'est pas de l'inactivité ») : une inactivité de 100 ms n'abat pas une
    // commande de 400 ms. On ne fait donc PAS dépendre la génération de cette
    // valeur, et elle peut rester courte (120 s) — c'est la SUSPENSION qui protège,
    // pas sa durée.
    expect(defautDefaut("delegation.idleTimeoutMs")).toBe(120_000);
    expect(defautDefaut("delegation.idleTimeoutMs")).toBeLessThan(PLAFOND);
  });

  it("la borne du run de CANAL dépasse le plafond (dérivation, pas constante)", () => {
    // Même calcul que le câblage (`src/index.ts`) : rédaction + une génération,
    // relevée au moins jusqu'au plancher des outils longs.
    const borneTour = (plafond: number): number =>
      Math.max(
        CHAT_REPLY_TIMEOUT_MS + plafond,
        channelTurnTimeoutMs({
          tools: ["generer_image", "consulter_workflow"],
          delegationAvailable: false,
          baseMs: 0,
        }),
      );
    // Défaut : 90 s + 1 h ⇒ 61 min 30 s (les deux termes des outils longs valent
    // 1 h : c'est bien la génération qui commande).
    expect(borneTour(PLAFOND)).toBe(CHAT_REPLY_TIMEOUT_MS + 3_600_000);
    expect(borneTour(PLAFOND)).toBeGreaterThan(PLAFOND);
    // ⚠️ GARDE : une borne de tour PLUS COURTE que le plafond couperait la
    // génération en plein vol, sans que le plafond ne soit jamais atteint.
    expect(borneTour(PLAFOND)).toBeGreaterThan(resolveToolWatchdogMs(PLAFOND));
    // Plafond relevé : la borne suit (aucune constante figée).
    expect(borneTour(7_200_000)).toBe(CHAT_REPLY_TIMEOUT_MS + 7_200_000);
  });

  it("l'ordre des BORNES est croissant (requête < grâce < rédaction < plafond < chien < canal < job)", () => {
    const borneCanal = CHAT_REPLY_TIMEOUT_MS + PLAFOND;
    const bornes = [
      DEFAULT_COMFY_REQUEST_TIMEOUT_MS,
      DEFAULT_COMFY_JOB_GRACE_MS,
      CHAT_REPLY_TIMEOUT_MS,
      PLAFOND,
      resolveToolWatchdogMs(PLAFOND),
      borneCanal,
      TOTAL_JOB,
    ];
    for (let index = 1; index < bornes.length; index += 1) {
      expect(bornes[index]).toBeGreaterThan(bornes[index - 1] as number);
    }
    // ⚠️ La SONDE (intervalle de surveillance) n'est pas une borne : elle doit
    // rester très petite devant la grâce, sinon la fenêtre de 30 s serait
    // dépassée de plusieurs intervalles avant d'être constatée.
    expect(DEFAULT_COMFY_POLL_INTERVAL_MS).toBeLessThan(DEFAULT_COMFY_JOB_GRACE_MS / 10);
    // La grâce doit rester TRÈS en dessous du plafond : c'est elle qui détecte
    // un travail fantôme, pas le plafond.
    expect(DEFAULT_COMFY_JOB_GRACE_MS).toBeLessThan(PLAFOND / 10);
  });
});

describe("la durée DÉCLARÉE de `generer_image` dit la vérité", () => {
  it("l'outil long déclare 3 600 s (1 h, plafond réel), et non l'ancienne valeur de 900 s", () => {
    const outil = longRunningTool("generer_image");
    expect(outil).toBeDefined();
    expect(outil?.seconds).toBe(3_600);
    // ⚠️ La durée déclarée ne peut pas dépasser le plafond réel : le refus dit
    // « trop long pour un canal » et sous-estimerait le coût sinon.
    expect((outil?.seconds ?? 0) * 1_000).toBeLessThanOrEqual(PLAFOND);
    // La source citée est un vrai `fichier:ligne` du schéma (jamais une estimation).
    expect(outil?.source).toContain("src/config/schema.ts:");
    expect(outil?.source).toContain("3_600_000");
  });

  it("la durée annoncée à une personne est LISIBLE (« 1 heure », pas « 3600 s »)", () => {
    // ⚠️ C'est cette chaîne que le modèle recopie dans le canal.
    expect(humanToolDuration(3_600)).toBe("1 heure");
    expect(humanToolDuration(7_200)).toBe("2 heures");
    expect(humanToolDuration(900)).toBe("15 minutes");
    expect(humanToolDuration(120)).toBe("2 minutes");
    // Les durées courtes gardent leur unité naturelle.
    expect(humanToolDuration(30)).toBe("30 s");
    expect(humanToolDuration(60)).toBe("60 s");
  });

  it("`LONG_RUNNING_TOOLS` ne déclare aucune durée supérieure au plafond du client", () => {
    for (const outil of LONG_RUNNING_TOOLS) {
      // `run_command` est borné par `MAX_COMMAND_TIMEOUT_MS` (900 s), pas par le
      // plafond de la génération : aucune des deux ne ment sur sa borne.
      expect(outil.seconds * 1_000).toBeLessThanOrEqual(PLAFOND);
    }
  });
});

describe("le réglage est exposé dans /config et s'applique À CHAUD", () => {
  it("`GET /api/config` renvoie `images.timeoutMs` avec sa valeur et l'étiquette « à chaud »", async () => {
    const runtime = makeRuntime();
    const response = await handleConfigRequest({
      method: "GET",
      path: "/api/config",
      headers: {},
      body: "",
      deps: {
        runtime,
        logger: createLogger({ level: "error", sink: () => {}, secretValues: [] }),
      },
    });
    expect(response.status).toBe(200);
    const body = response.body as {
      fields: Record<string, { value?: unknown; origin?: string; apply?: string }>;
    };
    expect(body.fields["images.timeoutMs"]).toMatchObject({
      value: 3_600_000,
      origin: "default",
      apply: "hot",
    });
    // Le champ reste dans le schéma (aucune régression d'exposition).
    expect(CONFIG_SCHEMA["images.timeoutMs"]).toBeDefined();
  });

  it("`PUT /api/config` prend une valeur RELEVÉE (90 min) et l'applique sans redémarrage", async () => {
    const runtime = makeRuntime();
    const response = await handleConfigRequest({
      method: "PUT",
      path: "/api/config",
      headers: WRITE_HEADERS,
      body: JSON.stringify({ "images.timeoutMs": 5_400_000 }),
      deps: {
        runtime,
        logger: createLogger({ level: "error", sink: () => {}, secretValues: [] }),
      },
    });
    expect(response.status).toBe(200);
    const body = response.body as { applied: { hot: string[]; restart: string[] } };
    // ⚠️ « À chaud » : le client ComfyUI relit la valeur à chaque génération.
    expect(body.applied.hot).toContain("images.timeoutMs");
    expect(runtime.getNumber("images.timeoutMs")).toBe(5_400_000);
  });

  it("une valeur hors bornes est REFUSÉE (pas de génération sans plafond)", async () => {
    const runtime = makeRuntime();
    const response = await handleConfigRequest({
      method: "PUT",
      path: "/api/config",
      headers: WRITE_HEADERS,
      body: JSON.stringify({ "images.timeoutMs": 7_300_000 }),
      deps: {
        runtime,
        logger: createLogger({ level: "error", sink: () => {}, secretValues: [] }),
      },
    });
    expect(response.status).toBe(400);
    // La valeur refusée n'a rien changé.
    expect(runtime.getNumber("images.timeoutMs")).toBe(3_600_000);
  });
});
