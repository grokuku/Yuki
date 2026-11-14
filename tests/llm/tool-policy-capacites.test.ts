/**
 * CAPACITÉS D'UN BOT (lot 35h) — TABLE DE VÉRITÉ EXHAUSTIVE.
 *
 * ⚠️ Ce fichier remplace `tool-policy-profil.test.ts` (lot 35f) : le CONCEPT de
 * profil a disparu (décision utilisateur du 2026-11-10 : « je ne veux pas de
 * profil préconfigurés »). Les gardes sont RÉÉCRITES, pas supprimées : ce qui
 * était vérifié outil par outil l'est encore, mais capacité par capacité.
 *
 * ⚠️ Ce qu'il prouve :
 *  ① les 12 capacités forment une PARTITION des 33 outils custom + 4 builtins ;
 *    ⚠️ GARDE MODIFIÉE (2026-11-14) : 29 → 33, les quatre outils des CONSIGNES
 *    DURABLES (`memoriser_consigne`, `ajouter_fait`, `lister_consignes`,
 *    `oublier_consigne`) rejoignent la capacité `memoire`.
 *  ② ⚠️ UN BOT NEUF (`capacites: []`) A UNE ALLOWLIST VIDE — aucun builtin, aucun
 *    outil custom, pour les DEUX rôles ; c'est le test central du lot ;
 *  ③ chaque capacité ouvre EXACTEMENT la liste annoncée ;
 *  ④ la règle est une INTERSECTION : une capacité ne rouvre jamais ce que le
 *    câblage a fermé (`chat.remoteAgents = desactive` ⇒ `delegate` absent) ;
 *  ⑤ non-régression : `capacites` ABSENT = aucun filtrage, et la liste complète
 *    des capacités redonne l'allowlist d'aujourd'hui, outil par outil.
 */

import { describe, expect, it } from "vitest";

import {
  OUTILS_DES_CAPACITES,
  REMOTE_TOOL_GROUP_OF,
  filtrerSelonCapacites,
  toolAllowlist,
  toolAllowlistForChat,
  type BuiltinToolName,
  type CustomToolName,
  type ToolAllowlistOptions,
} from "../../src/llm/index.js";
import { CAPACITES_BOT, type CapaciteBot } from "../../src/bots/registry.js";

/**
 * UNIVERS des outils custom : les clés de la table des groupes distants. Le type
 * de cette table (`Record<CustomToolName, RemoteToolGroup>`) rend la liste
 * EXHAUSTIVE : un outil ajouté sans y figurer ne compile plus.
 */
const TOUS_LES_OUTILS_CUSTOM = Object.keys(REMOTE_TOOL_GROUP_OF) as CustomToolName[];

const BUILTINS: readonly BuiltinToolName[] = ["read", "ls", "grep", "find"];

/**
 * Options qui ACTIVENT TOUT ce que la politique du rôle sait activer.
 * ⚠️ Volontairement PLUS PERMISSIF que le câblage réel : c'est ce qui permet de
 * montrer qu'une capacité absente retire, même quand tout est ouvert.
 */
const TOUT_ACTIVE: ToolAllowlistOptions = {
  delegationEnabled: true,
  executionEnabled: true,
  screenshotsEnabled: true,
  directoryEnabled: true,
  secretsEnabled: true,
  secretRequestsEnabled: true,
  heritageEnabled: true,
  conversationArchiveEnabled: true,
  librarianEnabled: true,
  librarianCaptureEnabled: true,
  filesEnabled: true,
  messagesEnabled: true,
  envoisProgrammesEnabled: true,
  planifierTacheEnabled: true,
  fileTransferEnabled: true,
  fileListEnabled: true,
  fileReadEnabled: true,
  imagesEnabled: true,
};

const TOUTES = [...CAPACITES_BOT];

/** Outils (custom + builtins) ouverts par un jeu de capacités, triés. */
function outilsOuverts(capacites: readonly CapaciteBot[]): string[] {
  const union = new Set<string>();
  for (const capacite of capacites) {
    const entree = OUTILS_DES_CAPACITES[capacite];
    for (const outil of entree.builtins) union.add(outil);
    for (const outil of entree.custom) union.add(outil);
  }
  return [...union].sort();
}

// ── Vérité TERRAIN, écrite À LA MAIN (jamais recalculée depuis le code testé) ──

const ATTENDUS: Readonly<Record<CapaciteBot, readonly string[]>> = {
  fichiers: ["deposer_fichier", "lire_fichier", "lister_fichiers", "recuperer_fichier"],
  envoi: ["envoyer_fichier", "envoyer_message", "publier_dans_canal"],
  libraire: [
    "archive_libraire",
    "capture_libraire",
    "liste_libraire",
    "lire_libraire",
    "recherche_libraire",
  ],
  web: ["lire_page_web"],
  images: ["consulter_workflow", "generer_image"],
  agents: ["etat_agent", "lister_agents"],
  execution: ["capturer_ecran", "run_command"],
  delegation: ["cancel_job", "delegate", "job_status", "steer_job"],
  secrets: ["demander_secret", "lister_secrets"],
  programmation: ["planifier_tache", "programmer_envoi"],
  memoire: [
    "archive_vie_anterieure",
    "ajouter_fait",
    "chercher_conversations_archivees",
    "lister_consignes",
    "memoriser_consigne",
    "oublier_consigne",
  ],
  builtins: ["find", "grep", "ls", "read"],
};

describe("35h ① — l'univers des outils est exhaustif et PARTITIONNÉ", () => {
  it("la table de groupes couvre EXACTEMENT les outils custom (33)", () => {
    expect(TOUS_LES_OUTILS_CUSTOM).toHaveLength(33);
    expect(new Set(TOUS_LES_OUTILS_CUSTOM).size).toBe(TOUS_LES_OUTILS_CUSTOM.length);
  });

  it("chaque capacité du registre est DÉCRITE dans la table", () => {
    expect(Object.keys(OUTILS_DES_CAPACITES).sort()).toEqual([...CAPACITES_BOT].sort());
  });

  it("chaque outil custom appartient à UNE SEULE capacité (partition)", () => {
    for (const outil of TOUS_LES_OUTILS_CUSTOM) {
      const porteurs = CAPACITES_BOT.filter((capacite) =>
        OUTILS_DES_CAPACITES[capacite].custom.includes(outil),
      );
      expect(porteurs, outil).toHaveLength(1);
    }
    // Aucune capacité ne déclare un outil hors de l'univers connu.
    for (const capacite of CAPACITES_BOT) {
      for (const outil of OUTILS_DES_CAPACITES[capacite].custom) {
        expect(TOUS_LES_OUTILS_CUSTOM, `${capacite} / ${outil}`).toContain(outil);
      }
    }
  });

  it("les builtins ne sont ouverts QUE par la capacité `builtins`", () => {
    for (const capacite of CAPACITES_BOT) {
      const attendus = capacite === "builtins" ? [...BUILTINS].sort() : [];
      expect([...OUTILS_DES_CAPACITES[capacite].builtins].sort(), capacite).toEqual(attendus);
    }
  });

  it("la table écrite à la main couvre les 12 capacités et les 33 outils", () => {
    expect(Object.keys(ATTENDUS).sort()).toEqual([...CAPACITES_BOT].sort());
    const total = Object.values(ATTENDUS).reduce((somme, liste) => somme + liste.length, 0);
    expect(total).toBe(TOUS_LES_OUTILS_CUSTOM.length + BUILTINS.length);
  });
});

describe("35h ② — chaque capacité ouvre EXACTEMENT ce qu'elle annonce", () => {
  it("outil par outil : autorisé par sa capacité, refusé par toutes les autres", () => {
    for (const capacite of CAPACITES_BOT) {
      expect(outilsOuverts([capacite]), capacite).toEqual([...ATTENDUS[capacite]].sort());
    }
  });

  it("`agents` n'ouvre QUE `lister_agents` et `etat_agent`", () => {
    const outils = filtrerSelonCapacites(TOUS_LES_OUTILS_CUSTOM, ["agents"]);
    expect([...outils].sort()).toEqual(["etat_agent", "lister_agents"]);
    // Aucun outil d'ACTION sur une machine n'entre par cette porte.
    expect(outils).not.toContain("run_command");
    expect(outils).not.toContain("capturer_ecran");
  });

  it("`execution` ouvre `run_command` et `capturer_ecran` (et rien d'autre)", () => {
    expect(filtrerSelonCapacites(TOUS_LES_OUTILS_CUSTOM, ["execution"]).sort()).toEqual([
      "capturer_ecran",
      "run_command",
    ]);
    // Côté worker LOURD (qui les porte réellement), `run_command` apparaît.
    expect(toolAllowlist("heavy", { ...TOUT_ACTIVE, capacites: ["execution"] })).toContain(
      "run_command",
    );
    expect(toolAllowlist("heavy", { ...TOUT_ACTIVE, capacites: ["execution"] })).not.toContain(
      "read",
    );
  });

  it("`builtins` est la SEULE porte des builtins (aucun par défaut)", () => {
    const sansBuiltins = toolAllowlist("light", {
      ...TOUT_ACTIVE,
      capacites: TOUTES.filter((capacite) => capacite !== "builtins"),
    });
    for (const builtin of BUILTINS) expect(sansBuiltins).not.toContain(builtin);
    const avec = toolAllowlist("light", { ...TOUT_ACTIVE, capacites: ["builtins"] });
    expect([...avec].sort()).toEqual([...BUILTINS].sort());
  });
});

describe("35h ② — UN BOT NEUF NE PEUT RIEN FAIRE (test central)", () => {
  it("`capacites: []` ⇒ allowlist VIDE pour le rôle léger (aucun builtin, aucun custom)", () => {
    const outils = toolAllowlist("light", { ...TOUT_ACTIVE, capacites: [] });
    expect(outils).toEqual([]);
  });

  it("`capacites: []` ⇒ allowlist VIDE pour le rôle lourd aussi", () => {
    expect(toolAllowlist("heavy", { ...TOUT_ACTIVE, capacites: [] })).toEqual([]);
  });

  it("`capacites: []` ⇒ allowlist VIDE dans un run de CANAL (socle `toujours` compris)", () => {
    // ⚠️ `toolAllowlistForChat` pousse le socle `toujours` APRÈS les options du
    // rôle : sans l'intersection finale, `envoyer_message`, `programmer_envoi` et
    // `planifier_tache` passeraient malgré `[]`.
    const outils = toolAllowlistForChat("light", { ...TOUT_ACTIVE, capacites: [] }, {
      chatMode: "mattermost",
      remoteAgents: true,
      remoteTools: true,
    });
    expect(outils).toEqual([]);
  });

  it("le filtre direct rend [] quel que soit l'outil proposé", () => {
    for (const outil of [...TOUS_LES_OUTILS_CUSTOM, ...BUILTINS]) {
      expect(filtrerSelonCapacites([outil], []), outil).toEqual([]);
    }
  });
});

describe("35h ④ — la règle est une INTERSECTION (jamais un remplacement)", () => {
  it("`delegation` + `chat.remoteAgents = desactive` ⇒ `delegate` reste ABSENT", () => {
    const outils = toolAllowlistForChat("light", { ...TOUT_ACTIVE, capacites: ["delegation"] }, {
      chatMode: "mattermost",
      remoteAgents: false,
      remoteTools: true,
    });
    expect(outils).not.toContain("delegate");
    expect(outils).not.toContain("job_status");
    expect(outils).not.toContain("cancel_job");
    expect(outils).not.toContain("steer_job");
  });

  it("`delegation` + `chat.remoteAgents = actives` ⇒ `delegate` présent (même capacité)", () => {
    const outils = toolAllowlistForChat("light", { ...TOUT_ACTIVE, capacites: ["delegation"] }, {
      chatMode: "mattermost",
      remoteAgents: true,
      remoteTools: false,
    });
    expect([...outils].sort()).toEqual(
      ["cancel_job", "delegate", "job_status", "steer_job"].sort(),
    );
  });

  it("`web` + `chat.remoteTools = desactive` ⇒ `lire_page_web` ABSENT", () => {
    const outils = toolAllowlistForChat("light", { ...TOUT_ACTIVE, capacites: ["web"] }, {
      chatMode: "discord",
      remoteAgents: true,
      remoteTools: false,
    });
    expect(outils).toEqual([]);
  });

  it("`programmation` ne réouvre pas le socle `toujours` dans le désordre : il l'autorise", () => {
    const sans = toolAllowlistForChat("light", { ...TOUT_ACTIVE, capacites: [] }, {
      chatMode: "mattermost",
      remoteAgents: false,
      remoteTools: false,
    });
    expect(sans).not.toContain("programmer_envoi");
    const avec = toolAllowlistForChat(
      "light",
      { ...TOUT_ACTIVE, capacites: ["programmation"] },
      { chatMode: "mattermost", remoteAgents: false, remoteTools: false },
    );
    expect([...avec].sort()).toEqual(["planifier_tache", "programmer_envoi"]);
  });

  it("aucune capacité n'AJOUTE d'outil : finale(capacités) ⊆ finale(tout)", () => {
    const tout = new Set(toolAllowlist("light", { ...TOUT_ACTIVE, capacites: TOUTES }));
    for (const capacite of CAPACITES_BOT) {
      for (const outil of toolAllowlist("light", { ...TOUT_ACTIVE, capacites: [capacite] })) {
        expect(tout.has(outil), `${capacite} ajoute ${outil}`).toBe(true);
      }
    }
  });
});

describe("35h ⑤ — non-régression : un bot hérité garde TOUT", () => {
  it("`capacites` ABSENT = aucun filtrage, à l'identique (les deux rôles)", () => {
    for (const role of ["light", "heavy"] as const) {
      expect(toolAllowlist(role, TOUT_ACTIVE)).toEqual(
        toolAllowlist(role, { ...TOUT_ACTIVE, capacites: undefined }),
      );
      expect(toolAllowlist(role, {})).toEqual(toolAllowlist(role, { capacites: undefined }));
    }
  });

  it("TOUTES les capacités redonnent EXACTEMENT l'allowlist d'aujourd'hui, outil par outil", () => {
    // ⚠️ C'est la garde de non-régression du bot existant : la liste complète des
    // capacités doit couvrir CHAQUE outil que la politique du rôle sait ouvrir.
    for (const role of ["light", "heavy"] as const) {
      const sans = toolAllowlist(role, TOUT_ACTIVE);
      const avec = toolAllowlist(role, { ...TOUT_ACTIVE, capacites: TOUTES });
      expect(avec, role).toEqual(sans);
      for (const outil of sans) expect(avec, `${role} / ${outil}`).toContain(outil);
    }
  });

  it("`toolAllowlistForChat` : local et canal, tous réglages, identiques avec TOUTES", () => {
    const cas = [
      { chatMode: "local" as const, remoteAgents: false, remoteTools: false },
      { chatMode: "mattermost" as const, remoteAgents: false, remoteTools: false },
      { chatMode: "mattermost" as const, remoteAgents: true, remoteTools: false },
      { chatMode: "mattermost" as const, remoteAgents: false, remoteTools: true },
      { chatMode: "discord" as const, remoteAgents: true, remoteTools: true },
    ];
    for (const chat of cas) {
      expect(toolAllowlistForChat("light", { ...TOUT_ACTIVE, capacites: TOUTES }, chat)).toEqual(
        toolAllowlistForChat("light", TOUT_ACTIVE, chat),
      );
    }
  });

  it("`filtrerSelonCapacites(…, undefined)` rend la liste reçue, à l'identique", () => {
    expect(filtrerSelonCapacites(TOUS_LES_OUTILS_CUSTOM, undefined)).toEqual(
      TOUS_LES_OUTILS_CUSTOM,
    );
  });
});

describe("35h — valeurs inconnues : rien ne s'ouvre", () => {
  it("une capacité INCONNUE n'ouvre RIEN (fail-closed)", () => {
    // ⚠️ Le registre REFUSE une capacité inconnue à l'écriture
    // (`src/bots/registry.ts`) : cette valeur ne peut donc pas venir d'un fichier
    // valide. Si elle arrivait quand même, elle n'ouvre aucun outil.
    const inconnue = "administrateur" as unknown as CapaciteBot;
    expect(filtrerSelonCapacites(TOUS_LES_OUTILS_CUSTOM, [inconnue])).toEqual([]);
    expect(toolAllowlist("light", { ...TOUT_ACTIVE, capacites: [inconnue] })).toEqual([]);
  });

  it("un jeu vide + une capacité inconnue reste vide", () => {
    expect(
      toolAllowlist("light", {
        ...TOUT_ACTIVE,
        capacites: ["inconnue" as unknown as CapaciteBot],
      }),
    ).toEqual([]);
  });
});
