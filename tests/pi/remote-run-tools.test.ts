/**
 * OUTILS d'un run DISTANT sous `chat.remoteAgents = actives` (2026-11-02).
 *
 * ⚠️ LE DÉFAUT QUE CE FICHIER VERROUILLE : la politique distante autorisait ~19
 * outils, `buildRemoteRunTools` n'en construisait que 5 (`generer_image`,
 * `consulter_workflow`, `lister_fichiers`, `lire_fichier` + les builtins du SDK).
 * `delegate`, `lister_agents`, `lister_secrets`, le libraire, l'archive et
 * `envoyer_fichier` étaient donc **autorisés mais absents** : le réglage
 * `chat.remoteAgents = actives` ne voulait dire presque rien.
 *
 * Ce que ce fichier prouve, sans modèle ni réseau (outils exécutés directement) :
 *  1. chaque outil attendu est CONSTRUIT sous `actives` (test qui les nomme un
 *     par un) ;
 *  2. sous `desactive`, AUCUN d'eux n'est construit — ni dans l'allowlist, ni dans
 *     les définitions (non-régression de la sécurité) ;
 *  3. aucun outil à approbation n'est instanciable ni autorisé (garde) ;
 *  4. `lister_secrets` ne rend que des NOMS (jamais une valeur, test sentinelle) ;
 *  5. une délégation lancée depuis un canal est rattachée à CE canal, et
 *     `job_status` ne voit pas les jobs d'un autre canal ;
 *  6. `envoyer_fichier` travaille sur la conversation du CANAL et signale le
 *     fichier envoyé (pour publication) ;
 *  7. le journal `chat.remote.tools.unimplemented` ne cite PLUS les builtins
 *     (`read`, `ls`, `grep`, `find`), fournis par le SDK.
 *
 * ⚠️ Échoue sur le code d'origine : `buildRemoteRunTools` n'acceptait que
 * `images`/`files`/`vision`/`onFileProduced` ⇒ ces outils n'existaient pas dans un
 * run distant, et le journal citait les builtins.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import type { AgentDirectoryPort } from "../../src/agents/directory.js";
import type { DelegateRequest, DelegateServicePort } from "../../src/delegation/ports.js";
import type { FilesReadPort, FilesSendPort, WireFile } from "../../src/files/index.js";
import type { ConversationArchivePort } from "../../src/memory/conversation-archive.js";
import type { HeritagePort } from "../../src/memory/heritage.js";
import type { SecretDirectoryPort } from "../../src/secrets/directory.js";
import { APPROVAL_REQUIRED_TOOLS } from "../../src/llm/tool-policy.js";
import type { ToolAllowlistOptions } from "../../src/llm/tool-policy.js";
import {
  assertNoApprovalToolDefinition,
  createRemoteRunTools,
  type RemoteRunLibrarianPorts,
  type RemoteRunToolPorts,
} from "../../src/pi/index.js";
import { buildRemoteRunTools } from "../../src/pi/sdk/remote-run-tools.js";
import { CHAT_REPLY_SYSTEM_PROMPT } from "../../src/chat/reply/prompt.js";

const CANAL = "mm-canal-1";

/** Options de politique du léger, TOUT activé (comme le host local en production). */
const LIGHT_OPTIONS: ToolAllowlistOptions = {
  delegationEnabled: true,
  directoryEnabled: true,
  secretsEnabled: true,
  secretRequestsEnabled: true,
  heritageEnabled: true,
  conversationArchiveEnabled: true,
  librarianEnabled: true,
  librarianCaptureEnabled: true,
  filesEnabled: true,
  imagesEnabled: true,
};

/** Outils attendus sous `actives`, nommés UN PAR UN (exigence du lot). */
const ATTENDUS_SOUS_ACTIVES = [
  // Agents
  "lister_agents",
  "etat_agent",
  "delegate",
  "job_status",
  "cancel_job",
  "steer_job",
  // Secrets (NOMS seulement)
  "lister_secrets",
  // Fichiers
  "envoyer_fichier",
  // Archive
  "archive_vie_anterieure",
  "chercher_conversations_archivees",
  // Libraire
  "recherche_libraire",
  "liste_libraire",
  "lire_libraire",
  "archive_libraire",
  "capture_libraire",
] as const;

const OUTILS_DESACTIVE = [
  ...ATTENDUS_SOUS_ACTIVES,
  "read",
  "ls",
  "grep",
  "find",
] as const;

// ── Doubles des ports (aucune I/O) ─────────────────────────────────────────

const JOURNAL_FICHIER: WireFile = {
  id: "0123456789abcdef0123456789abcdef",
  name: "notes.txt",
  kind: "text",
  mimeType: "text/plain",
  bytes: 12,
  readable: true,
  url: "/fichiers/0123456789abcdef0123456789abcdef.txt",
  createdAt: "2026-11-02T10:00:00.000Z",
  expiresAt: "2026-12-02T10:00:00.000Z",
};

/** Secret sentinelle : une VALEUR ne doit JAMAIS apparaître dans un résultat. */
const VALEUR_SENTINELLE = "s3cr3t-a-ne-jamais-rendre";

function secretPort(): SecretDirectoryPort {
  return {
    isConfigured: () => true,
    list: () =>
      [
        {
          name: "YUKI_SECRET_GITHUB",
          label: "jeton GitHub",
          updatedAt: "2026-11-01T09:00:00.000Z",
          // ⚠️ Champ AJOUTÉ exprès : si l'outil rendait l'entrée entière
          // (`JSON.stringify`), cette valeur fuiterait dans le contexte du modèle.
          value: VALEUR_SENTINELLE,
        },
      ] as unknown as ReturnType<SecretDirectoryPort["list"]>,
  };
}

function directoryPort(): AgentDirectoryPort {
  return {
    list: () =>
      [
        {
          agentId: "agent-1",
          name: "station",
          online: true,
          level: "never",
          privilege: "normal",
          lastSeen: "2026-11-02T09:00:00.000Z",
          caps: ["exec"],
          sensitive: false,
          locked: false,
        },
      ] as unknown as ReturnType<AgentDirectoryPort["list"]>,
    find: () => undefined,
    history: () => [],
  };
}

function filesPort(marque: { envoyes: WireFile[] }): FilesSendPort & FilesReadPort {
  const send = vi.fn((sessionId: string, reference: string) => {
    if (sessionId !== CANAL) return null;
    return reference === JOURNAL_FICHIER.name || reference === JOURNAL_FICHIER.id
      ? JOURNAL_FICHIER
      : null;
  });
  marque.envoyes = marque.envoyes ?? [];
  return {
    listForSession: (sessionId: string) => (sessionId === CANAL ? [JOURNAL_FICHIER] : []),
    send,
    get: () => null,
    readBytes: () => null,
    prepareImages: async () => ({ images: [], notes: [], refused: [] }) as never,
  } as unknown as FilesSendPort & FilesReadPort;
}

function delegationPort(
  journal: { demandes: Array<{ lightSessionId: string; task: string }> },
): DelegateServicePort {
  return {
    delegate: async (request: DelegateRequest) => {
      journal.demandes.push({ lightSessionId: request.lightSessionId, task: request.task });
      return { status: "dispatched", job_id: "job-1", note: "lancé" };
    },
    jobStatus: (jobId: string) =>
      jobId === "job-du-canal"
        ? ({
            id: jobId,
            lightSessionId: CANAL,
            status: "completed",
            task: "tâche du canal",
            result: { text: "fait" },
            notified: false,
            createdAt: "2026-11-02T10:00:00.000Z",
          } as never)
        : jobId === "job-d-ailleurs"
          ? ({
              id: jobId,
              lightSessionId: "mm-autre-canal",
              status: "completed",
              task: "tâche d'un autre canal",
              result: { text: "confidentiel" },
              notified: false,
              createdAt: "2026-11-02T10:00:00.000Z",
            } as never)
          : undefined,
    cancelJob: async (jobId: string) => ({ status: "cancelled", job_id: jobId }) as never,
    steerJob: async (jobId: string, text: string) =>
      ({ status: "steered", job_id: jobId, delivery: "injected", text }) as never,
    hasPendingWork: () => false,
    pendingJobs: () => [],
  } as unknown as DelegateServicePort;
}

function heritagePort(): HeritagePort {
  return {
    info: () => ({ entries: 0, provenance: "Yuki-old", period: "2024" }) as never,
    list: () => [],
    read: () => undefined,
  };
}

function archivePort(): ConversationArchivePort {
  return {
    archiveConversation: () => ({ status: "archived" }) as never,
    search: () => [],
    info: () => ({ conversations: 0, messages: 0 }) as never,
  };
}

function librarianPorts(): RemoteRunLibrarianPorts {
  // Les outils ne sont pas EXÉCUTÉS ici : on vérifie leur présence. Les ports
  // réels (`LibrarianClient`, services) ne sont donc pas nécessaires.
  return {
    client: {} as never,
    archive: {} as never,
    screenshot: {} as never,
    shots: {} as never,
    captureEnabled: () => true,
  };
}

/** Tous les ports, comme les câble `src/index.ts` sous `actives`. */
function tousLesPorts(
  marques: {
    envoyes?: WireFile[];
    demandes?: Array<{ lightSessionId: string; task: string }>;
  } = {},
): RemoteRunToolPorts {
  return {
    conversationId: CANAL,
    files: filesPort({ envoyes: marques.envoyes ?? [] }),
    filesSend: filesPort({ envoyes: marques.envoyes ?? [] }),
    agents: directoryPort(),
    secrets: secretPort(),
    delegation: delegationPort({ demandes: marques.demandes ?? [] }),
    heritage: heritagePort(),
    conversationArchive: archivePort(),
    librarian: librarianPorts(),
    onFileSent: (file) => marques.envoyes?.push(file),
  };
}

function contextFor(sessionId: string): ExtensionContext {
  return { sessionManager: { getSessionId: () => sessionId } } as unknown as ExtensionContext;
}

/** Noms des définitions construites (l'ordre n'importe pas). */
const noms = (tools: ReadonlyArray<{ name?: string }>): string[] =>
  tools.map((tool) => String(tool.name)).sort();

describe("run distant — les outils de `actives` sont RÉELLEMENT construits", () => {
  it("chaque outil attendu existe, nommé un par un", () => {
    const tools = buildRemoteRunTools(tousLesPorts());
    const presents = noms(tools as ReadonlyArray<{ name?: string }>);
    for (const attendu of ATTENDUS_SOUS_ACTIVES) {
      expect(presents, `outil manquant : ${attendu}`).toContain(attendu);
    }
  });

  it("`createRemoteRunTools` les expose aussi, sans aucun outil à approbation", () => {
    const run = createRemoteRunTools({
      ...tousLesPorts(),
      conversationId: CANAL,
      chatMode: "mattermost",
      remoteAgents: true,
      lightOptions: () => LIGHT_OPTIONS,
    });
    const presents = noms(run.customTools as ReadonlyArray<{ name?: string }>);
    for (const attendu of ATTENDUS_SOUS_ACTIVES) expect(presents).toContain(attendu);
    // ⚠️ PARITÉ politique ↔ implémentation : aucune définition ne déborde de
    // l'allowlist (le SDK ne registre que les outils autorisés).
    for (const nom of presents) expect(run.tools).toContain(nom);
    // ⚠️ GARDE : ni dans la liste, ni dans les définitions.
    for (const interdit of APPROVAL_REQUIRED_TOOLS) {
      expect(run.tools).not.toContain(interdit);
      expect(presents).not.toContain(interdit);
    }
    expect(approvalDans(run.tools)).toEqual([]);
    expect(approvalDans(presents)).toEqual([]);
  });

  it("sous `desactive`, AUCUN de ces outils n'est construit (sécurité)", () => {
    const run = createRemoteRunTools({
      ...tousLesPorts(),
      conversationId: CANAL,
      chatMode: "mattermost",
      remoteAgents: false,
      lightOptions: () => LIGHT_OPTIONS,
    });
    const presents = noms(run.customTools as ReadonlyArray<{ name?: string }>);
    for (const interdit of OUTILS_DESACTIVE) {
      expect(run.tools, `allowlist ne doit pas contenir ${interdit}`).not.toContain(interdit);
      expect(presents, `définition ne doit pas contenir ${interdit}`).not.toContain(interdit);
    }
    // Ce qui reste : la LECTURE de fichiers, et rien d'autre (aucun port d'image
    // n'est fourni ici ; les outils d'image sont couverts par
    // `tests/chat/mattermost-image-chain.test.ts`).
    expect(presents).toEqual(["lire_fichier", "lister_fichiers"].sort());
  });

  it("un port ABSENT retire ses outils (et l'écart est journalisé sans les builtins)", () => {
    const logs: Array<{ message: string; fields?: Record<string, unknown> }> = [];
    const run = createRemoteRunTools({
      conversationId: CANAL,
      chatMode: "mattermost",
      remoteAgents: true,
      lightOptions: () => LIGHT_OPTIONS,
      files: filesPort({ envoyes: [] }),
      logger: {
        info: (message: string, fields?: Record<string, unknown>) =>
          logs.push({ message, ...(fields ? { fields } : {}) }),
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      } as never,
    });
    const presents = noms(run.customTools as ReadonlyArray<{ name?: string }>);
    expect(presents).not.toContain("delegate");
    expect(presents).not.toContain("lister_secrets");
    const ecart = logs.find((entry) => entry.message === "chat.remote.tools.unimplemented");
    expect(ecart).toBeDefined();
    const cites = (ecart?.fields?.tools ?? []) as string[];
    // ⚠️ ④ : les BUILTINS existent (fournis par le SDK) — les citer était FAUX.
    for (const builtin of ["read", "ls", "grep", "find"]) expect(cites).not.toContain(builtin);
    expect(cites).toContain("delegate");
  });
});

/** Outils d'une liste qui exigent une approbation (aucun attendu). */
function approvalDans(liste: readonly string[]): string[] {
  return liste.filter((nom) => APPROVAL_REQUIRED_TOOLS.includes(nom));
}

describe("run distant — sécurité des outils instanciés", () => {
  it("aucune définition à approbation ne peut être construite (garde)", () => {
    // Aucun port ne peut en fabriquer : la garde reste utile si un port mal câblé
    // en glissait une.
    expect(() => assertNoApprovalToolDefinition([{ name: "run_command" }])).toThrow(
      /approbation humaine/,
    );
    expect(() =>
      assertNoApprovalToolDefinition([{ name: "generer_image" }, { name: "lister_agents" }]),
    ).not.toThrow();
    const tools = buildRemoteRunTools(tousLesPorts()) as ReadonlyArray<{ name?: string }>;
    expect(approvalDans(noms(tools))).toEqual([]);
  });

  it("`lister_secrets` ne rend que des NOMS, jamais une valeur (sentinelle)", async () => {
    const tools = buildRemoteRunTools(tousLesPorts()) as ReadonlyArray<{
      name?: string;
      execute: (...args: unknown[]) => Promise<{ content: Array<{ text?: string }> }>;
    }>;
    const outil = tools.find((tool) => tool.name === "lister_secrets");
    expect(outil).toBeDefined();
    const resultat = await outil!.execute("appel-1", {}, undefined, undefined, contextFor("s"));
    const texte = resultat.content.map((part) => part.text ?? "").join("\n");
    expect(texte).toContain("YUKI_SECRET_GITHUB");
    expect(texte).not.toContain(VALEUR_SENTINELLE);
  });

  it("une délégation depuis un canal est rattachée à CE canal", async () => {
    const demandes: Array<{ lightSessionId: string; task: string }> = [];
    const tools = buildRemoteRunTools(tousLesPorts({ demandes })) as ReadonlyArray<{
      name?: string;
      execute: (...args: unknown[]) => Promise<{ content: Array<{ text?: string }> }>;
    }>;
    const deleguer = tools.find((tool) => tool.name === "delegate");
    expect(deleguer).toBeDefined();
    // La session de l'outil est ÉPHÉMÈRE : c'est bien le canal qui doit gagner.
    await deleguer!.execute(
      "appel-2",
      { task: "compte les fichiers" },
      undefined,
      undefined,
      contextFor("session-ephemere-du-run"),
    );
    expect(demandes).toHaveLength(1);
    expect(demandes[0]?.lightSessionId).toBe(CANAL);
  });

  it("`job_status` ne voit pas le job d'un AUTRE canal (cloisonnement)", async () => {
    const tools = buildRemoteRunTools(tousLesPorts()) as ReadonlyArray<{
      name?: string;
      execute: (...args: unknown[]) => Promise<{ content: Array<{ text?: string }> }>;
    }>;
    const etat = tools.find((tool) => tool.name === "job_status")!;
    const duCanal = await etat.execute("a", { job_id: "job-du-canal" }, undefined, undefined, contextFor("s"));
    expect(JSON.parse(duCanal.content[0]!.text!)).toMatchObject({ status: "completed" });
    const ailleurs = await etat.execute("b", { job_id: "job-d-ailleurs" }, undefined, undefined, contextFor("s"));
    expect(JSON.parse(ailleurs.content[0]!.text!)).toMatchObject({ status: "not_found" });
  });

  it("`envoyer_fichier` travaille sur le canal et signale le fichier publié", async () => {
    const envoyes: WireFile[] = [];
    const tools = buildRemoteRunTools(tousLesPorts({ envoyes })) as ReadonlyArray<{
      name?: string;
      execute: (...args: unknown[]) => Promise<{ content: Array<{ text?: string }> }>;
    }>;
    const envoyer = tools.find((tool) => tool.name === "envoyer_fichier")!;
    const resultat = await envoyer.execute(
      "a",
      { fichier: JOURNAL_FICHIER.name },
      undefined,
      undefined,
      contextFor("session-ephemere-du-run"),
    );
    expect(resultat.content[0]!.text).toContain("Fichier envoyé");
    // ⚠️ Le rappel est ce qui permet de PUBLIER le fichier dans le canal.
    expect(envoyes.map((file) => file.id)).toEqual([JOURNAL_FICHIER.id]);
  });
});

describe("prompt système d'un run distant", () => {
  it("reste celui du rédacteur de canal (aucune régression)", () => {
    expect(CHAT_REPLY_SYSTEM_PROMPT).toContain("canal");
  });
});
