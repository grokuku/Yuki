/**
 * DÉCOUPAGE DE L'ACCÈS DISTANT — deux réglages, deux familles d'outils
 * (demande utilisateur du 2026-11-02 : « est-ce que je peux différencier l'accès
 * aux agents de l'accès aux outils ? »).
 *
 * ⚠️ LE DÉFAUT QUE CE FICHIER FERME : un seul interrupteur (`chat.remoteAgents`)
 * décidait de TOUT. L'utilisateur a voulu « images oui, agents non » et la réponse
 * a dû être « impossible ». Désormais :
 *  - `chat.remoteAgents` ⇒ les MACHINES (délégation, annuaire, coffre) ;
 *  - `chat.remoteTools`  ⇒ l'IMAGE, le LIBRAIRE, les ARCHIVES (rien qui touche une
 *    machine) ;
 *  - le SOCLE (`lister_fichiers`, `lire_fichier`, `publier_dans_canal`,
 *    `envoyer_fichier`) reste ouvert sans aucun réglage ;
 *  - les outils à APPROBATION restent fermés dans tous les cas.
 *
 * Ce que ce fichier verrouille :
 *  ① le CLASSEMENT est total (aucun outil orphelin, aucun outil dans deux groupes) ;
 *  ② les quatre combinaisons produisent les outils attendus, en politique COMME en
 *    définitions réellement construites ;
 *  ③ aucun outil à approbation, quelle que soit la combinaison (garde) ;
 *  ④ « agents non + outils oui » laisse `generer_image` s'exécuter INLINE, avec la
 *    borne du tour relevée (correctif du 2026-11-02, jamais un refus sans voie) ;
 *  ⑤ `GET /api/chat/status` expose LES DEUX valeurs (`distant.agents`,
 *    `distant.outils`), et le schéma refuse toute autre valeur.
 *
 * ⚠️ Échoue sur le code d'origine : `chat.remoteTools` n'existe ni dans le schéma,
 * ni dans la politique (`toolAllowlistForChat` n'acceptait que `remoteAgents`), ni
 * dans le statut — « agents non + outils oui » y était donc inexprimable.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { ChatService } from "../../src/chat/index.js";
import { CONFIG_SCHEMA, validateField } from "../../src/config/schema.js";
import { readConfigEnvOverrides } from "../../src/config/env.js";
import { handleChatRequest } from "../../src/gateway/routes/chat.js";
import {
  APPROVAL_REQUIRED_TOOLS,
  REMOTE_AGENTS_TOOLS,
  REMOTE_ALWAYS_TOOLS,
  REMOTE_NEVER_TOOLS,
  REMOTE_TOOL_GROUP_OF,
  REMOTE_TOOLS,
  TOOL_POLICY,
  remoteToolGroup,
  toolAllowlistForChat,
} from "../../src/llm/tool-policy.js";
import { createRemoteRunTools } from "../../src/pi/index.js";

const CANAL = "mm-canal-1";

/** Options du rôle léger, TOUTES câblées (comme le host local en production). */
const OPTIONS_TOUT = {
  delegationEnabled: true,
  directoryEnabled: true,
  secretsEnabled: true,
  heritageEnabled: true,
  conversationArchiveEnabled: true,
  librarianEnabled: true,
  librarianCaptureEnabled: true,
  filesEnabled: true,
  filesListEnabled: true,
  imagesEnabled: true,
} as const;

const CTX = {
  sessionManager: { getSessionId: () => "session-ephemere-du-run" },
} as unknown as ExtensionContext;

type Executable = {
  name: string;
  execute: (...args: unknown[]) => Promise<{
    content: Array<{ text?: string }>;
    details?: unknown;
  }>;
};

/** Générateur SIMULÉ : une image, aucun réseau, aucun disque. */
function portImage(marque: { appels: number }) {
  return {
    async generate(): Promise<never> {
      marque.appels += 1;
      return {
        record: {
          id: "img-1",
          file: "/tmp/img-1.png",
          mimeType: "image/png",
          ext: "png",
          bytes: 3,
          imageSrc: "/images/img-1.png",
          createdAt: "2026-11-02T10:00:00.000Z",
          expiresAt: "2026-12-02T10:00:00.000Z",
          promptId: "prompt-1",
        },
        bytes: new Uint8Array([1, 2, 3]),
        promptId: "prompt-1",
        workflowName: "manga",
        elapsedMs: 5,
        outputLabeled: true,
        labels: [],
      } as never;
    },
    workflows: {
      candidates: () => [{ name: "manga", description: "Manga", isDefault: true }],
      documentationOf: () => "",
    },
  };
}

/** Tous les ports câblés, comme `src/index.ts` les fournit (aucune I/O). */
function tousLesPorts(marque: { appels: number }) {
  const fichiers = {
    listForSession: () => [],
    send: () => undefined,
    read: () => undefined,
  } as never;
  return {
    conversationId: CANAL,
    images: portImage(marque),
    files: fichiers,
    filesSend: fichiers,
    agents: { list: () => [], status: () => undefined } as never,
    secrets: { isConfigured: () => true, list: () => [] } as never,
    delegation: {
      delegate: async () => ({ status: "dispatched", job_id: "job-1" }),
      jobStatus: () => undefined,
      cancelJob: async (id: string) => ({ status: "cancelled", job_id: id }),
      steerJob: async (id: string) => ({ status: "steered", job_id: id }),
      hasPendingWork: () => false,
      pendingJobs: () => [],
    } as never,
    heritage: { info: () => undefined, list: () => [], read: () => undefined } as never,
    conversationArchive: {
      archiveConversation: () => ({ status: "archived" }),
      search: () => [],
      info: () => ({ conversations: 0, messages: 0 }),
    } as never,
    librarian: {
      client: {} as never,
      archive: {} as never,
      screenshot: {} as never,
      shots: {} as never,
      captureEnabled: () => true,
    },
  };
}

function runDistant(
  remoteAgents: boolean,
  remoteTools: boolean,
  marque: { appels: number } = { appels: 0 },
) {
  const run = createRemoteRunTools({
    ...tousLesPorts(marque),
    chatMode: "mattermost",
    remoteAgents,
    remoteTools,
    lightOptions: () => OPTIONS_TOUT,
  });
  const definitions = run.customTools as ReadonlyArray<{ name?: string }>;
  return {
    tools: [...run.tools],
    noms: definitions.map((tool) => String(tool.name)),
    definitions: run.customTools as ReadonlyArray<Executable>,
    budgetMs: run.inlineLongToolBudgetMs ?? 0,
  };
}

// ─── ① Le classement est TOTAL ──────────────────────────────────────────────

describe("① classement des outils distants — aucun orphelin, aucun doublon", () => {
  it("chaque outil custom déclaré par la politique appartient à UN groupe", () => {
    // ⚠️ La source de vérité est `TOOL_POLICY` : un outil ajouté à une catégorie
    // doit être classé, sinon il serait silencieusement absent (ou présent) dans
    // les runs distants sans qu'aucun test ne le voie.
    const declares = new Set<string>();
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
        entry.messages,
        entry.envoisProgrammes,
        entry.planifierTaches,
        entry.fileTransfer,
        entry.fileList,
        entry.fileRead,
        entry.images,
      ]) {
        for (const nom of liste) declares.add(nom);
      }
    }
    // `publier_dans_canal` n'appartient à AUCUN rôle (capacité de run de canal).
    declares.add("publier_dans_canal");

    expect(declares.size).toBeGreaterThan(20);
    for (const nom of declares) {
      expect(remoteToolGroup(nom), `outil non classé : ${nom}`).toBeDefined();
    }
    // Et réciproquement : la table ne classe rien d'inconnu de la politique.
    for (const nom of Object.keys(REMOTE_TOOL_GROUP_OF)) {
      expect(declares, `classé mais inconnu de TOOL_POLICY : ${nom}`).toContain(nom);
    }
  });

  it("les quatre groupes forment une PARTITION (ni recouvrement, ni trou)", () => {
    const groupes = [REMOTE_AGENTS_TOOLS, REMOTE_TOOLS, REMOTE_ALWAYS_TOOLS, REMOTE_NEVER_TOOLS];
    const vus = new Set<string>();
    for (const groupe of groupes) {
      expect(groupe.length).toBeGreaterThan(0);
      for (const nom of groupe) {
        expect(vus.has(nom), `outil dans deux groupes : ${nom}`).toBe(false);
        vus.add(nom);
      }
    }
    expect(vus.size).toBe(Object.keys(REMOTE_TOOL_GROUP_OF).length);
  });

  it("le groupe `jamais` EST la liste des outils à approbation (aucun oubli)", () => {
    expect([...REMOTE_NEVER_TOOLS].sort()).toEqual([...APPROVAL_REQUIRED_TOOLS].sort());
  });

  it("les builtins ne sont pas classés (ce ne sont pas des outils custom)", () => {
    for (const builtin of ["read", "ls", "grep", "find"]) {
      expect(remoteToolGroup(builtin)).toBeUndefined();
    }
  });

  it("`lister_secrets` est dans le groupe `agents` (décision justifiée)", () => {
    // NOMS seulement, jamais une valeur — mais son unique usage est de référencer
    // `${NOM}` dans une commande DÉLÉGUÉE : il suit donc `chat.remoteAgents`.
    expect(remoteToolGroup("lister_secrets")).toBe("agents");
    expect(remoteToolGroup("demander_secret")).toBe("jamais");
  });

  it("`envoyer_fichier` est dans `toujours` (vérifié : rien hors de la conversation)", () => {
    expect(remoteToolGroup("envoyer_fichier")).toBe("toujours");
    for (const socle of ["lister_fichiers", "lire_fichier", "publier_dans_canal"]) {
      expect(remoteToolGroup(socle)).toBe("toujours");
    }
  });
});

// ─── ② Les quatre combinaisons, en politique ET en définitions ──────────────

describe("② deux réglages, quatre combinaisons", () => {
  it("agents NON + outils OUI ⇒ `generer_image` OUI, `delegate` NON", () => {
    const politique = toolAllowlistForChat("light", OPTIONS_TOUT, {
      chatMode: "mattermost",
      remoteAgents: false,
      remoteTools: true,
    });
    expect(politique).toContain("generer_image");
    expect(politique).not.toContain("delegate");

    const run = runDistant(false, true);
    expect(run.tools).toContain("generer_image");
    expect(run.tools).not.toContain("delegate");
    expect(run.noms).toContain("generer_image");
    expect(run.noms).not.toContain("delegate");
  });

  it("agents OUI + outils NON ⇒ `delegate` OUI, `generer_image` NON", () => {
    const politique = toolAllowlistForChat("light", OPTIONS_TOUT, {
      chatMode: "mattermost",
      remoteAgents: true,
      remoteTools: false,
    });
    expect(politique).toContain("delegate");
    expect(politique).not.toContain("generer_image");

    const run = runDistant(true, false);
    expect(run.tools).toContain("delegate");
    expect(run.tools).not.toContain("generer_image");
    expect(run.noms).toContain("delegate");
    // ⚠️ Le port d'image est fourni : c'est bien le RÉGLAGE qui ferme l'outil, pas
    // l'absence de port. La définition ne doit pas exister pour autant.
    expect(run.noms).not.toContain("generer_image");
  });

  it("les DEUX NON (le défaut) ⇒ ni l'un ni l'autre, mais le SOCLE reste", () => {
    const politique = toolAllowlistForChat("light", OPTIONS_TOUT, {
      chatMode: "mattermost",
      remoteAgents: false,
      remoteTools: false,
    });
    for (const interdit of ["generer_image", "consulter_workflow", "delegate", "recherche_libraire"]) {
      expect(politique, interdit).not.toContain(interdit);
    }
    expect([...politique].sort()).toEqual([...REMOTE_ALWAYS_TOOLS].sort());

    const run = runDistant(false, false);
    for (const interdit of ["generer_image", "delegate"]) expect(run.tools).not.toContain(interdit);
    expect(run.noms).not.toContain("generer_image");
    expect(run.noms).not.toContain("delegate");
  });

  it("les DEUX OUI ⇒ les deux familles ensemble", () => {
    const politique = toolAllowlistForChat("light", OPTIONS_TOUT, {
      chatMode: "mattermost",
      remoteAgents: true,
      remoteTools: true,
    });
    expect(politique).toEqual(expect.arrayContaining(["delegate", "generer_image"]));

    const run = runDistant(true, true);
    expect(run.tools).toEqual(
      expect.arrayContaining([
        "delegate",
        "job_status",
        "lister_agents",
        "generer_image",
        "consulter_workflow",
        "recherche_libraire",
        "archive_vie_anterieure",
        "chercher_conversations_archivees",
      ]),
    );
    // ⚠️ PARITÉ politique ↔ définitions : aucune définition ne déborde la liste.
    for (const nom of run.noms) expect(run.tools, nom).toContain(nom);
  });
});

// ─── ③ Aucun outil à approbation, quelle que soit la combinaison ────────────

describe("③ aucun outil à approbation (garde)", () => {
  it("ni dans la politique, ni dans les définitions des quatre combinaisons", () => {
    for (const remoteAgents of [true, false]) {
      for (const remoteTools of [true, false]) {
        for (const chatMode of ["mattermost", "discord"] as const) {
          const politique = toolAllowlistForChat("light", OPTIONS_TOUT, {
            chatMode,
            remoteAgents,
            remoteTools,
          });
          for (const interdit of APPROVAL_REQUIRED_TOOLS) {
            expect(politique, `${interdit} (${remoteAgents}/${remoteTools})`).not.toContain(interdit);
          }
        }
        const run = runDistant(remoteAgents, remoteTools);
        for (const interdit of APPROVAL_REQUIRED_TOOLS) {
          expect(run.tools, interdit).not.toContain(interdit);
          expect(run.noms, interdit).not.toContain(interdit);
        }
      }
    }
  });
});

// ─── ④ « agents non + outils oui » ⇒ l'inline N'EST PAS refusé ─────────────

describe("④ `generer_image` inline quand `delegate` est absent", () => {
  it("l'appel s'exécute (aucun refus) et la borne du tour est relevée", async () => {
    const marque = { appels: 0 };
    const run = runDistant(false, true, marque);
    const generer = run.definitions.find((tool) => tool.name === "generer_image");
    expect(generer).toBeDefined();

    const resultat = await generer!.execute(
      "appel-1",
      { scene: "un chat roux sur un clavier" },
      undefined,
      undefined,
      CTX,
    );
    // ⚠️ Le générateur a RÉELLEMENT tourné : sans délégation, refuser supprimerait
    // la capacité (régression de production du 2026-11-02).
    expect(marque.appels).toBe(1);
    const texte = resultat.content.map((bloc) => bloc.text ?? "").join("");
    expect(texte).not.toContain("Rien n'a été lancé");
    expect(texte).not.toContain("delegate");
    expect((resultat.details as { status?: string } | undefined)?.status).not.toBe("refused");
    // ⚠️ `images.timeoutMs` = 180 s : la borne du tour doit couvrir la génération,
    // sinon elle serait coupée en plein vol.
    expect(run.budgetMs).toBeGreaterThanOrEqual(180_000);
  });

  it("avec `delegate` (agents oui), l'inline est REFUSÉ et renvoie vers la délégation", async () => {
    const marque = { appels: 0 };
    const run = runDistant(true, true, marque);
    const generer = run.definitions.find((tool) => tool.name === "generer_image")!;
    const resultat = await generer.execute(
      "appel-2",
      { scene: "un chat" },
      undefined,
      undefined,
      CTX,
    );
    expect(marque.appels).toBe(0);
    expect((resultat.details as { status?: string } | undefined)?.status).toBe("refused");
    // Aucune borne supplémentaire : plus rien de long n'est autorisé inline.
    expect(run.budgetMs).toBe(0);
  });
});

// ─── ⑤ Statut exposé et schéma ──────────────────────────────────────────────

describe("⑤ `GET /api/chat/status` expose LES DEUX valeurs", () => {
  const statut = async (agents: string, outils: string) => {
    const service = new ChatService({
      mode: () => "mattermost",
      remoteAgents: () => agents,
      remoteTools: () => outils,
    });
    const reponse = await handleChatRequest({
      method: "GET",
      path: "/api/chat/status",
      headers: { "x-yuki-config": "1" } as never,
      deps: { service },
    });
    return reponse as {
      status: number;
      body: { distant?: { agents?: string; outils?: string } };
    };
  };

  it("rend les deux champs, indépendamment l'un de l'autre", async () => {
    expect((await statut("desactive", "actives")).body.distant).toEqual({
      agents: "desactive",
      outils: "actives",
    });
    expect((await statut("actives", "desactive")).body.distant).toEqual({
      agents: "actives",
      outils: "desactive",
    });
    expect((await statut("desactive", "desactive")).body.distant).toEqual({
      agents: "desactive",
      outils: "desactive",
    });
  });
});

describe("⑤ schéma — `chat.remoteTools`", () => {
  it("enum `desactive|actives`, défaut `desactive`, hot, surchargeable par l'environnement", () => {
    const descriptor = CONFIG_SCHEMA["chat.remoteTools"];
    expect(descriptor).toBeDefined();
    expect(descriptor?.type).toBe("enum");
    expect(descriptor?.enum).toEqual(["desactive", "actives"]);
    expect(descriptor?.default).toBe("desactive");
    expect(descriptor?.apply).toBe("hot");
    expect(descriptor?.env).toBe("YUKI_CHAT_REMOTE_TOOLS");
    expect(validateField("chat.remoteTools", "actives")).toEqual({ ok: true, value: "actives" });
    expect(validateField("chat.remoteTools", true).ok).toBe(false);
    expect(readConfigEnvOverrides({ YUKI_CHAT_REMOTE_TOOLS: "actives" })["chat.remoteTools"]).toBe(
      "actives",
    );
  });

  it("les DEUX réglages restent indépendants dans le schéma", () => {
    // ⚠️ Un seul champ qui porterait les deux décisions rendrait « images oui,
    // agents non » inexprimable — c'est exactement le défaut signalé.
    expect(CONFIG_SCHEMA["chat.remoteAgents"]).toBeDefined();
    expect(CONFIG_SCHEMA["chat.remoteTools"]).toBeDefined();
  });
});
