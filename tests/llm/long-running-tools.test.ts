/**
 * OUTILS LONGS — déclaration MESURÉE et refus de l'appel INLINE dans un CANAL.
 *
 * ⚠️ LE DÉFAUT QUE CE FICHIER VERROUILLE (2026-11-02) : un run de canal est borné
 * par `CHAT_REPLY_TIMEOUT_MS` (90 s, `src/chat/reply/prompt.ts:72`) alors que
 * `generer_image` peut prendre `images.timeoutMs` (180 s,
 * `src/config/schema.ts:899-905`). L'appel inline était donc coupé EN PLEIN VOL,
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
  REMOTE_SAFE_TOOLS,
  TOOL_POLICY,
  longRunningTool,
  longToolInlineRefusal,
  toolAllowlist,
  toolAllowlistForChat,
} from "../../src/llm/tool-policy.js";
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
  { name: "generer_image", seconds: 180 },
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
      { chatMode: "mattermost", remoteAgents: true },
    );
    const perimetre = new Set<string>([...REMOTE_SAFE_TOOLS, ...politiqueActifs]);
    const atteignables = [...perimetre].filter((nom) => longRunningTool(nom) !== undefined);
    // `generer_image` (180 s) et `capture_libraire` (30 s) : les deux seuls outils
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

  it("le refus est ACTIONNABLE : borne, raison et `delegate`", () => {
    const message = longToolInlineRefusal("generer_image");
    expect(message).toContain("generer_image");
    expect(message).toContain("180 s");
    expect(message).toContain("delegate");
    // Un outil non long n'a aucun refus.
    expect(longToolInlineRefusal("lire_fichier")).toBeUndefined();
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
    expect(texte).toContain("180 s");
    expect(texte).toContain("delegate");
    expect((resultat.details as { status?: string }).status).toBe("refused");
  });

  it("sans délégation en canal (DÉFAUT `chat.remoteAgents = desactive`) : le refus le DIT", async () => {
    const marque = { appels: 0 };
    const outils = buildRemoteRunTools({
      conversationId: "mm-canal-1",
      images: imagePort(marque),
    }) as unknown as Executable[];
    const generer = outils.find((tool) => tool.name === "generer_image")!;
    const resultat = await generer.execute("appel-5", { scene: "un chat" }, undefined, undefined, CTX);
    const texte = resultat.content.map((bloc) => bloc.text ?? "").join("");
    expect(marque.appels).toBe(0);
    // ⚠️ Ordonner `delegate` alors qu'il n'existe pas serait un mensonge.
    expect(texte).toContain("chat.remoteAgents");
    expect(texte).not.toContain("Relance-la avec `delegate`");
    expect((resultat.details as { delegate_tool?: string }).delegate_tool).toBeUndefined();
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
