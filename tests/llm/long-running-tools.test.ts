/**
 * OUTILS LONGS — déclaration MESURÉE et refus de l'appel INLINE dans un CANAL.
 *
 * ⚠️ LE DÉFAUT QUE CE FICHIER VERROUILLE (2026-11-02) : un run de canal est borné
 * par `CHAT_REPLY_TIMEOUT_MS` (90 s, `src/chat/reply/prompt.ts:72`) alors que
 * `generer_image` peut prendre `images.timeoutMs` (1 h,
 * `src/config/schema.ts:960-969`). L'appel inline était donc coupé EN PLEIN VOL,
 * sans message : la personne du canal attendait une image qui n'arriverait
 * jamais. Le modèle ne pouvait pas le savoir (le prompt ne dit rien de la borne).
 *
 * Ce que ce fichier prouve :
 *  1. `LONG_RUNNING_TOOLS` contient EXACTEMENT les outils attendus, avec leur
 *     borne mesurée et sa source (`fichier:ligne`) — une entrée ajoutée ou retirée
 *     sans mise à jour casse ce test ;
 *  2. `longToolInlineRefusal` nomme la borne et `delegate` (message actionnable) ;
 *  3. dans un run de CANAL, un outil long REFUSE — le port n'est pas appelé ;
 *  4. en mode LOCAL (mêmes outils, construits autrement), il n'y a AUCUN refus
 *     (non-régression : le local n'a pas de borne de tour).
 *
 * ⚠️ Échoue sur le code d'origine : `LONG_RUNNING_TOOLS` et
 * `longToolInlineRefusal` n'existent pas, et `buildRemoteRunTools` n'appliquait
 * aucun refus.
 */

import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import type { GeneratedImage } from "../../src/comfy/index.js";
import {
  APPROVAL_REQUIRED_TOOLS,
  LONG_RUNNING_TOOLS,
  REMOTE_AGENTS_SETTING_PATH,
  REMOTE_SAFE_TOOLS,
  TOOL_POLICY,
  channelTurnTimeoutMs,
  longRunningTool,
  longToolInlineRefusal,
  toolAllowlist,
  toolAllowlistForChat,
} from "../../src/llm/tool-policy.js";
import { CHAT_REPLY_TIMEOUT_MS } from "../../src/chat/reply/prompt.js";
import { createRemoteRunTools } from "../../src/pi/chat-run.js";
import { guardLongToolsInChannel } from "../../src/pi/sdk/long-tool-guard.js";
import { createImageTools } from "../../src/pi/sdk/image-tools.js";
import { buildRemoteRunTools } from "../../src/pi/sdk/remote-run-tools.js";

/** PNG 1×1 valide (aucune I/O). */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** Ensemble ATTENDU, borne par borne (garde : toute entrée en plus ou en moins casse). */
const ATTENDUS: ReadonlyArray<{ name: string; seconds: number }> = [
  // 3 600 s = PLAFOND de sécurité de `images.timeoutMs` (1 h) : l'attente suit
  // l'état du serveur ComfyUI, ce plafond n'est que le filet de dernier recours
  // (cas rarissime d'un travail orphelin : un blocage, pas une lenteur).
  { name: "generer_image", seconds: 3_600 },
  { name: "run_command", seconds: 60 },
  { name: "recuperer_fichier", seconds: 120 },
  { name: "deposer_fichier", seconds: 120 },
  { name: "capturer_ecran", seconds: 30 },
  { name: "capture_libraire", seconds: 30 },
];

const CTX = { sessionManager: { getSessionId: () => "session-ephemere" } } as unknown as ExtensionContext;

type Resultat = { content: Array<{ type: string; text?: string }>; details?: unknown };
type Executable = {
  name: string;
  execute: (...args: unknown[]) => Promise<Resultat>;
};

/** Générateur simulé : il rend une image sans réseau ni disque. */
function imagePort(marque: { appels: number }) {
  return {
    async generate(): Promise<GeneratedImage> {
      marque.appels += 1;
      return {
        record: {
          id: "img-1",
          file: "/tmp/img-1.png",
          mimeType: "image/png",
          ext: "png",
          bytes: PNG.length,
          imageSrc: "/images/img-1.png",
          createdAt: "2026-11-02T10:00:00.000Z",
          expiresAt: "2026-12-02T10:00:00.000Z",
          promptId: "prompt-1",
        },
        bytes: PNG,
        promptId: "prompt-1",
        workflowName: "manga",
        elapsedMs: 5,
        outputLabeled: true,
        labels: [],
      };
    },
    workflows: {
      candidates: () => [{ name: "manga", description: "Manga", isDefault: true }],
      documentationOf: () => "",
    },
  };
}

describe("LONG_RUNNING_TOOLS — déclaration mesurée", () => {
  it("contient EXACTEMENT les outils attendus, avec leur borne", () => {
    expect(LONG_RUNNING_TOOLS.map((tool) => ({ name: tool.name, seconds: tool.seconds }))).toEqual(
      ATTENDUS.map((tool) => ({ ...tool })),
    );
  });

  it("chaque entrée cite la SOURCE de sa borne (`fichier:ligne`)", () => {
    for (const tool of LONG_RUNNING_TOOLS) {
      expect(tool.source).toMatch(/^src\/[a-z/.-]+\.ts:\d+/);
      expect(tool.seconds).toBeGreaterThan(0);
    }
  });

  it("chaque entrée est un outil RÉELLEMENT construit par la politique", () => {
    const connus = new Set<string>();
    for (const entry of Object.values(TOOL_POLICY)) {
      for (const liste of [
        entry.custom,
        entry.execution,
        entry.screenshots,
        entry.directory,
        entry.secrets,
        entry.secretRequests,
        entry.heritage,
        entry.conversationArchive,
        entry.librarian,
        entry.librarianCapture,
        entry.files,
        entry.fileTransfer,
        entry.fileList,
        entry.fileRead,
        entry.images,
      ]) {
        for (const nom of liste) connus.add(nom);
      }
    }
    for (const tool of LONG_RUNNING_TOOLS) {
      // ⚠️ Un nom mal orthographié ne refuserait RIEN : la garde resterait muette.
      expect(connus.has(tool.name)).toBe(true);
    }
  });

  it("les outils longs ATTEIGNABLES dans un canal sont bien couverts", () => {
    // ⚠️ Périmètre RÉEL d'un run de canal : `REMOTE_SAFE_TOOLS` quand les agents
    // sont désactivés, la politique COMPLÈTE du léger quand ils sont activés.
    // On prend l'union, pour que l'assertion tienne quel que soit le réglage.
    const politiqueActifs = toolAllowlistForChat(
      "light",
      { imagesEnabled: true, librarianEnabled: true, librarianCaptureEnabled: true },
      { chatMode: "mattermost", remoteAgents: true, remoteTools: true },
    );
    const perimetre = new Set<string>([...REMOTE_SAFE_TOOLS, ...politiqueActifs]);
    const atteignables = [...perimetre].filter((nom) => longRunningTool(nom) !== undefined);
    // `generer_image` (1 h) et `capture_libraire` (30 s) : les deux seuls outils
    // longs atteignables depuis un canal. Aucun ne doit échapper au refus.
    expect(atteignables.sort()).toEqual(["capture_libraire", "generer_image"]);
    // Et ils le sont VRAIMENT : les deux passent par le garde-fou.
    for (const nom of atteignables) expect(longToolInlineRefusal(nom)).toContain("delegate");
  });

  it("aucun outil long n'ajoute un outil à approbation (liste de refus inchangée)", () => {
    // ⚠️ `run_command`/`capturer_ecran`/transferts sont déjà à approbation et déjà
    // longs : la liste des outils LONGS ne doit pas élargir celle des approbations.
    const longsSansApprobation = LONG_RUNNING_TOOLS.map((tool) => tool.name).filter(
      (nom) => !APPROVAL_REQUIRED_TOOLS.includes(nom),
    );
    expect(longsSansApprobation.sort()).toEqual([
      "capture_libraire",
      "generer_image",
    ]);
  });

  it("le refus est ACTIONNABLE : borne, raison, `delegate` et chemin d'activation", () => {
    const message = longToolInlineRefusal("generer_image");
    expect(message).toContain("generer_image");
    // ⚠️ Durée LISIBLE : un canal ne doit pas lire « 3600 s ».
    expect(message).toContain("1 heure");
    expect(message).toContain("delegate");
    // ⚠️ Dire « la délégation est désactivée » sans dire OÙ l'activer ne suffit pas.
    expect(message).toContain(REMOTE_AGENTS_SETTING_PATH);
    // Un outil non long n'a aucun refus.
    expect(longToolInlineRefusal("lire_fichier")).toBeUndefined();
  });

  it("SANS délégation, il n'y a AUCUN refus : on ne retire pas une capacité sans alternative", () => {
    // ⚠️ Régression de production (2026-11-02) : sous le défaut
    // `chat.remoteAgents = desactive`, refuser `generer_image` revenait à supprimer
    // la génération d'image en canal (« avant, une génération courte passait »).
    expect(longToolInlineRefusal("generer_image", { delegationAvailable: false })).toBeUndefined();
    expect(longToolInlineRefusal("run_command", { delegationAvailable: false })).toBeUndefined();
  });

  it("la borne du tour est RELEVÉE quand un outil long est autorisé inline", () => {
    // `CHAT_REPLY_TIMEOUT_MS` (90 s) < `images.timeoutMs` (1 h) : sans levée, la
    // génération serait coupée en plein vol.
    expect(
      channelTurnTimeoutMs({
        tools: ["generer_image", "consulter_workflow"],
        delegationAvailable: false,
        baseMs: CHAT_REPLY_TIMEOUT_MS,
      }),
    ).toBe(3_600_000);
    // Base plus grande ⇒ elle gagne (jamais une borne plus courte qu'avant).
    expect(
      channelTurnTimeoutMs({
        tools: ["generer_image"],
        delegationAvailable: false,
        baseMs: 4_000_000,
      }),
    ).toBe(4_000_000);
    // Base plus PETITE que la durée déclarée de l'outil ⇒ c'est l'outil qui
    // commande (sinon la génération serait coupée en plein vol).
    expect(
      channelTurnTimeoutMs({ tools: ["generer_image"], delegationAvailable: false, baseMs: 270_000 }),
    ).toBe(3_600_000);
    // Délégation disponible ⇒ rien n'est autorisé inline ⇒ base inchangée.
    expect(
      channelTurnTimeoutMs({ tools: ["generer_image"], delegationAvailable: true, baseMs: 90_000 }),
    ).toBe(90_000);
  });
});

describe("refus de l'appel INLINE dans un run de CANAL", () => {
  it("le CANAL refuse `generer_image` : le générateur n'est PAS appelé", async () => {
    const marque = { appels: 0 };
    const outils = buildRemoteRunTools({
      conversationId: "mm-canal-1",
      images: imagePort(marque),
      // ⚠️ Délégation PRÉSENTE (sous `chat.remoteAgents = actives`) : le refus peut
      // donc renvoyer vers `delegate` sans mentir.
      delegation: {
        delegate: async () => ({ status: "dispatched", job_id: "job-1", note: "lancé" }),
        jobStatus: () => undefined,
        cancelJob: async (id: string) => ({ status: "cancelled", job_id: id }),
        steerJob: async (id: string) => ({ status: "steered", job_id: id }),
        hasPendingWork: () => false,
        pendingJobs: () => [],
      } as never,
    }) as unknown as Executable[];
    const generer = outils.find((tool) => tool.name === "generer_image");
    expect(generer).toBeDefined();

    const resultat = await generer!.execute("appel-1", { scene: "un chat" }, undefined, undefined, CTX);
    expect(marque.appels).toBe(0);
    const texte = resultat.content.map((bloc) => bloc.text ?? "").join("");
    expect(texte).toContain("1 heure");
    expect(texte).toContain("delegate");
    // ⚠️ Le chemin EXACT de configuration est nommé (libellé de l'interface).
    expect(texte).toContain(REMOTE_AGENTS_SETTING_PATH);
    expect(texte).toContain("Configuration → Conversation → Agents distants");
    expect((resultat.details as { status?: string }).status).toBe("refused");
  });

  it("sans délégation en canal (DÉFAUT `chat.remoteAgents = desactive`) : l'appel INLINE est AUTORISÉ", async () => {
    const marque = { appels: 0 };
    const outils = buildRemoteRunTools({
      conversationId: "mm-canal-1",
      images: imagePort(marque),
    }) as unknown as Executable[];
    const generer = outils.find((tool) => tool.name === "generer_image")!;
    const resultat = await generer.execute("appel-5", { scene: "un chat" }, undefined, undefined, CTX);
    const texte = resultat.content.map((bloc) => bloc.text ?? "").join("");
    // ⚠️ Le générateur a RÉELLEMENT tourné : c'est la capacité qui revient.
    expect(marque.appels).toBe(1);
    // ⚠️ Ordonner `delegate` alors qu'il n'existe pas serait un mensonge : aucun refus.
    expect(texte).not.toContain("delegate");
    expect(texte).not.toContain("Rien n'a été lancé");
    expect((resultat.details as { status?: string }).status).not.toBe("refused");
    // Et le tour doit pouvoir durer au moins la borne déclarée de l'outil.
    const run = createRemoteRunTools({
      conversationId: "mm-canal-1",
      chatMode: "mattermost",
      remoteAgents: false,
      // ⚠️ « agents non + outils oui » : c'est CETTE combinaison que le correctif
      // protège (l'image s'exécute inline faute de `delegate`).
      remoteTools: true,
      lightOptions: () => ({ imagesEnabled: true }),
      images: imagePort({ appels: 0 }),
    });
    expect(run.inlineLongToolBudgetMs).toBeGreaterThanOrEqual(3_600_000);
  });

  it("le refus ne touche QUE les outils longs : `consulter_workflow` reste appelable", async () => {
    const marque = { appels: 0 };
    const outils = buildRemoteRunTools({
      conversationId: "mm-canal-1",
      images: imagePort(marque),
    }) as unknown as Executable[];
    const consulter = outils.find((tool) => tool.name === "consulter_workflow");
    expect(consulter).toBeDefined();
    const resultat = await consulter!.execute(
      "appel-2",
      { style: "manga" },
      undefined,
      undefined,
      CTX,
    );
    const texte = resultat.content.map((bloc) => bloc.text ?? "").join("");
    // Aucun refus : la documentation du workflow est rendue (gratuite, locale).
    expect(texte).not.toContain("delegate");
    expect((resultat.details as { status?: string }).status).not.toBe("refused");
    expect(texte.length).toBeGreaterThan(0);
  });

  it("le garde-fou est générique : un outil long ajouté à la liste est refusé partout", async () => {
    const outils = guardLongToolsInChannel([
      {
        name: "capture_libraire",
        label: "Capture",
        description: "capture",
        parameters: {} as never,
        execute: async () => ({ content: [{ type: "text" as const, text: "JAMAIS" }], details: {} }),
      } as unknown as ToolDefinition,
    ]) as unknown as Executable[];
    const resultat = await outils[0]!.execute("appel-3", {}, undefined, undefined, CTX);
    const texte = resultat.content.map((bloc) => bloc.text ?? "").join("");
    expect(texte).toContain("30 s");
    expect(texte).toContain("delegate");
    expect(texte).not.toContain("JAMAIS");
  });

  it("MODE LOCAL : le même outil n'est PAS refusé (non-régression)", async () => {
    const marque = { appels: 0 };
    // Le host local construit ses outils SANS passer par `buildRemoteRunTools` :
    // c'est exactement ce que fait ce test (aucun garde-fou de canal).
    const outils = createImageTools(imagePort(marque)) as unknown as Executable[];
    const generer = outils.find((tool) => tool.name === "generer_image");
    expect(generer).toBeDefined();
    const resultat = await generer!.execute("appel-4", { scene: "un chat" }, undefined, undefined, CTX);
    const texte = resultat.content.map((bloc) => bloc.text ?? "").join("");
    expect(marque.appels).toBe(1);
    expect(texte).not.toContain("delegate");
    expect(toolAllowlist("light", { imagesEnabled: true })).toContain("generer_image");
  });
});
