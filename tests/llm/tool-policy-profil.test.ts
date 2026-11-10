/**
 * PROFILS DE CAPACITÉS RÉELS (lot 35f) — TABLE DE VÉRITÉ EXHAUSTIVE.
 *
 * ⚠️ Ce fichier est le CŒUR du lot : il vérifie, pour CHAQUE profil et CHAQUE
 * outil, si l'outil est autorisé ou non. Pas un échantillon : l'UNIVERS est
 * exhaustif par construction (`Object.keys(REMOTE_TOOL_GROUP_OF)`, dont le type
 * est `Record<CustomToolName, …>` — un outil custom non classé ne compile pas).
 *
 * ⚠️ Sur l'origine (avant ce lot), `profil` n'était qu'une ÉTIQUETTE : les clés
 * `profil` et `filtrerSelonProfil` n'existaient pas ⇒ ce fichier échoue
 * (échec d'import, puis échec des assertions). C'est la preuve demandée.
 */

import { describe, expect, it } from "vitest";

import {
  PROFIL_OUTILS,
  REMOTE_TOOL_GROUP_OF,
  filtrerSelonProfil,
  toolAllowlist,
  toolAllowlistForChat,
  type BuiltinToolName,
  type CustomToolName,
  type ToolAllowlistOptions,
} from "../../src/llm/index.js";
import { PROFILS_BOT, type ProfilBot } from "../../src/bots/registry.js";

/**
 * UNIVERS des outils custom : les clés de la table des groupes distants. Le type
 * de cette table (`Record<CustomToolName, RemoteToolGroup>`) rend la liste
 * EXHAUSTIVE : un outil ajouté sans y figurer ne compile plus.
 */
const TOUS_LES_OUTILS_CUSTOM = Object.keys(REMOTE_TOOL_GROUP_OF) as CustomToolName[];

const BUILTINS: readonly BuiltinToolName[] = ["read", "ls", "grep", "find"];

/**
 * Options qui ACTIVENT TOUT ce que la politique du rôle léger sait activer.
 * ⚠️ Volontairement PLUS PERMISSIF que le câblage réel : c'est ce qui permet de
 * montrer que le profil retire, même quand tout est ouvert.
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

/** Table LUE : l'ensemble autorisé par un profil, trié (jamais dérivé du code testé). */
function autorisesPar(profil: ProfilBot): string[] {
  return filtrerSelonProfil(TOUS_LES_OUTILS_CUSTOM, profil).sort();
}

// ── Vérité TERRAIN, écrite À LA MAIN (jamais recalculée depuis le code testé) ──

/** Profil `lecture` : converse, fichiers de la conversation, libraire, images. */
const AUTORISES_LECTURE: readonly CustomToolName[] = [
  "envoyer_message",
  "envoyer_fichier",
  "lister_fichiers",
  "lire_fichier",
  "publier_dans_canal",
  "recherche_libraire",
  "liste_libraire",
  "lire_libraire",
  "lire_page_web",
  "capture_libraire",
  "generer_image",
  "consulter_workflow",
];

/** Profil `accueil` : la conversation et ses fichiers, rien de plus. */
const AUTORISES_ACCUEIL: readonly CustomToolName[] = [
  "envoyer_message",
  "envoyer_fichier",
  "lister_fichiers",
  "lire_fichier",
  "publier_dans_canal",
];

/**
 * Outils RETIRÉS aux deux profils restreints, et la raison (une seule ligne par
 * famille — la justification longue est dans `PROFIL_OUTILS`).
 */
const RETIRES_AUX_DEUX: readonly CustomToolName[] = [
  // Actions sur une machine appairée (approbation humaine incluse).
  "run_command",
  "capturer_ecran",
  "recuperer_fichier",
  "deposer_fichier",
  // Annuaire des agents : il n'a de sens que pour déléguer.
  "lister_agents",
  "etat_agent",
  // Coffre : moyen d'exécuter (`${NOM}` dans une commande).
  "lister_secrets",
  "demander_secret",
  // Délégation = l'action déléguée par un détour.
  "delegate",
  "job_status",
  "cancel_job",
  "steer_job",
  // Archivage = écriture d'historique de fond, pas une consultation.
  "archive_vie_anterieure",
  "chercher_conversations_archivees",
  "archive_libraire",
  // Actes de RÉDACTEUR DE FOND (« un seul rédacteur »).
  "programmer_envoi",
  "planifier_tache",
];

/**
 * Outils retirés à `accueil` EN PLUS des précédents : il n'a NI bibliothèque
 * documentaire NI images (consultation et illustration ne sont pas son rôle).
 */
const RETIRES_ACCUEIL: readonly CustomToolName[] = [
  ...RETIRES_AUX_DEUX,
  "recherche_libraire",
  "liste_libraire",
  "lire_libraire",
  "lire_page_web",
  "capture_libraire",
  "generer_image",
  "consulter_workflow",
];

describe("35f ① — l'univers des outils est exhaustif", () => {
  it("la table de groupes couvre EXACTEMENT les outils custom (29)", () => {
    expect(TOUS_LES_OUTILS_CUSTOM).toHaveLength(29);
    // Garde de cohérence : aucun doublon (une clé = un outil).
    expect(new Set(TOUS_LES_OUTILS_CUSTOM).size).toBe(TOUS_LES_OUTILS_CUSTOM.length);
  });

  it("chaque profil est DÉCRIT (`complet` = aucune restriction)", () => {
    for (const profil of PROFILS_BOT) {
      if (profil === "complet") {
        expect(PROFIL_OUTILS[profil]).toBeNull();
        continue;
      }
      const table = PROFIL_OUTILS[profil];
      expect(table).not.toBeNull();
      // ⚠️ AUCUN builtin : `read`/`ls`/`grep`/`find` ouvrent le volume de travail.
      expect(table?.builtins).toEqual([]);
    }
  });
});

describe("35f ② — table de vérité EXHAUSTIVE profil × outil custom", () => {
  it("`complet` n'enlève RIEN : les 29 outils passent", () => {
    expect(autorisesPar("complet")).toEqual([...TOUS_LES_OUTILS_CUSTOM].sort());
  });

  it("`lecture` autorise exactement les 12 outils du tableau, et retire les 17 autres", () => {
    expect(autorisesPar("lecture")).toEqual([...AUTORISES_LECTURE].sort());
  });

  it("`accueil` autorise exactement les 5 outils du tableau, et retire les 24 autres", () => {
    expect(autorisesPar("accueil")).toEqual([...AUTORISES_ACCUEIL].sort());
  });

  it("outil par outil : chaque outil est autorisé ou refusé, pour chaque profil", () => {
    const attendus: Record<ProfilBot, ReadonlySet<string>> = {
      complet: new Set(TOUS_LES_OUTILS_CUSTOM),
      lecture: new Set(AUTORISES_LECTURE),
      accueil: new Set(AUTORISES_ACCUEIL),
    };
    for (const profil of PROFILS_BOT) {
      for (const outil of TOUS_LES_OUTILS_CUSTOM) {
        const garde = filtrerSelonProfil([outil], profil);
        const attendu = attendus[profil].has(outil);
        expect(garde, `${profil} × ${outil}`).toEqual(attendu ? [outil] : []);
      }
    }
  });

  it("les outils RETIRÉS aux deux profils sont les mêmes, et sont disjoints des autorisés", () => {
    const autorisesLecture = new Set<string>(AUTORISES_LECTURE);
    const autorisesAccueil = new Set<string>(AUTORISES_ACCUEIL);
    for (const outil of RETIRES_AUX_DEUX) {
      expect(autorisesLecture.has(outil), `lecture ne doit pas avoir ${outil}`).toBe(false);
      expect(autorisesAccueil.has(outil), `accueil ne doit pas avoir ${outil}`).toBe(false);
    }
    // Le profil `accueil` en retire DAVANTAGE (libraire + images).
    for (const outil of RETIRES_ACCUEIL) {
      expect(autorisesAccueil.has(outil), `accueil ne doit pas avoir ${outil}`).toBe(false);
    }
    // Union autorisés ∪ retirés = univers (aucun outil oublié).
    expect([...new Set([...AUTORISES_LECTURE, ...RETIRES_AUX_DEUX])].sort()).toEqual(
      [...TOUS_LES_OUTILS_CUSTOM].sort(),
    );
    expect([...new Set([...AUTORISES_ACCUEIL, ...RETIRES_ACCUEIL])].sort()).toEqual(
      [...TOUS_LES_OUTILS_CUSTOM].sort(),
    );
  });

  it("chaque profil restreint a EXACTEMENT la liste de retraits annoncée", () => {
    const retiresLecture = TOUS_LES_OUTILS_CUSTOM.filter(
      (outil) => !AUTORISES_LECTURE.includes(outil),
    ).sort();
    expect(retiresLecture).toEqual([...RETIRES_AUX_DEUX].sort());
    const retiresAccueil = TOUS_LES_OUTILS_CUSTOM.filter(
      (outil) => !AUTORISES_ACCUEIL.includes(outil),
    ).sort();
    expect(retiresAccueil).toEqual([...RETIRES_ACCUEIL].sort());
  });
});

describe("35f ② — table de vérité EXHAUSTIVE profil × builtin", () => {
  it("`complet` garde les quatre builtins, `lecture` et `accueil` AUCUN", () => {
    for (const builtin of BUILTINS) {
      expect(filtrerSelonProfil([builtin], "complet")).toEqual([builtin]);
      expect(filtrerSelonProfil([builtin], "lecture")).toEqual([]);
      expect(filtrerSelonProfil([builtin], "accueil")).toEqual([]);
    }
  });

  it("l'allowlist FINALE du rôle léger ne contient un builtin que pour `complet`", () => {
    for (const builtin of BUILTINS) {
      expect(toolAllowlist("light", { ...TOUT_ACTIVE, profil: "complet" })).toContain(builtin);
      expect(toolAllowlist("light", { ...TOUT_ACTIVE, profil: "lecture" })).not.toContain(builtin);
      expect(toolAllowlist("light", { ...TOUT_ACTIVE, profil: "accueil" })).not.toContain(builtin);
    }
  });
});

describe("35f ① — la règle est une INTERSECTION (jamais un remplacement)", () => {
  it("allowlist finale `lecture` = les 12 autorisés ∩ ce que le rôle sait porter", () => {
    // ⚠️ TROIS outils autorisés par le PROFIL ne sont pas portés par le RÔLE léger :
    //  - `publier_dans_canal` n'est pas un droit de rôle (runs de canal seulement) ;
    //  - `lister_fichiers`/`lire_fichier` ne sont pas au léger LOCAL
    //    (`TOOL_POLICY.light.fileList/fileRead: []`) : il reçoit le contenu dans son
    //    message. C'est exactement l'INTERSECTION : le profil autorise, le rôle décide.
    const nonPortesParLeRole = new Set(["publier_dans_canal", "lister_fichiers", "lire_fichier"]);
    const attendu = AUTORISES_LECTURE.filter((outil) => !nonPortesParLeRole.has(outil)).sort();
    expect(toolAllowlist("light", { ...TOUT_ACTIVE, profil: "lecture" }).sort()).toEqual(attendu);
  });

  it("allowlist finale `accueil` = 4 outils (le socle de conversation)", () => {
    expect(toolAllowlist("light", { ...TOUT_ACTIVE, profil: "accueil" }).sort()).toEqual([
      "envoyer_fichier",
      "envoyer_message",
    ]);
  });

  it("AUCUN profil n'AJOUTE d'outil : finale(profil) ⊆ finale(complet)", () => {
    const complet = new Set(toolAllowlist("light", { ...TOUT_ACTIVE, profil: "complet" }));
    for (const profil of PROFILS_BOT) {
      for (const outil of toolAllowlist("light", { ...TOUT_ACTIVE, profil })) {
        expect(complet.has(outil), `${profil} ajoute ${outil}`).toBe(true);
      }
    }
  });

  it("`chat.remoteAgents = desactive` + profil `complet` ⇒ `delegate` ABSENT", () => {
    // ⚠️ LA preuve que le profil n'ouvre rien : c'est le CÂBLAGE qui ferme, et le
    // profil `complet` ne rouvre évidemment pas ce que le réglage a fermé.
    const outils = toolAllowlistForChat("light", { ...TOUT_ACTIVE, profil: "complet" }, {
      chatMode: "mattermost",
      remoteAgents: false,
      remoteTools: true,
    });
    expect(outils).not.toContain("delegate");
    expect(outils).not.toContain("job_status");
    expect(outils).not.toContain("lister_agents");
    // …mais le groupe `outils` reste ouvert (réglage indépendant).
    expect(outils).toContain("generer_image");
    expect(outils).toContain("recherche_libraire");
  });
});

describe("35f ④ — ce qui reste possible à un bot restreint", () => {
  it("en CANAL, `lecture` + `remoteTools = actives` garde EXACTEMENT le tableau du profil", () => {
    const outils = toolAllowlistForChat("light", { ...TOUT_ACTIVE, profil: "lecture" }, {
      chatMode: "mattermost",
      remoteAgents: true,
      remoteTools: true,
    });
    // ⚠️ Le socle `toujours` est poussé par `toolAllowlistForChat` : il fait partie
    // du profil `lecture`, donc il apparaît ici (12 = les 12 autorisés).
    expect([...outils].sort()).toEqual([...AUTORISES_LECTURE].sort());
    // Rien de plus : ni agent, ni coffre, ni commande, ni rédaction de fond.
    for (const interdit of RETIRES_AUX_DEUX) {
      expect(outils, `lecture ne doit pas avoir ${interdit}`).not.toContain(interdit);
    }
  });

  it("en CANAL, `accueil` + `remoteAgents/remoteTools = desactives` garde le socle de conversation", () => {
    const outils = toolAllowlistForChat("light", { ...TOUT_ACTIVE, profil: "accueil" }, {
      chatMode: "discord",
      remoteAgents: false,
      remoteTools: false,
    });
    expect([...outils].sort()).toEqual([...AUTORISES_ACCUEIL].sort());
  });

  it("le socle `toujours` du canal est FILTRÉ par le profil (programmation et tâche retirées)", () => {
    // ⚠️ `programmer_envoi` et `planifier_tache` font partie du socle `toujours` :
    // sans l'intersection faite APRÈS ce socle, les deux passeraient.
    const complet = toolAllowlistForChat("light", { ...TOUT_ACTIVE, profil: "complet" }, {
      chatMode: "mattermost",
      remoteAgents: false,
      remoteTools: false,
    });
    expect(complet).toContain("programmer_envoi");
    expect(complet).toContain("planifier_tache");
    for (const profil of ["lecture", "accueil"] as const) {
      const outils = toolAllowlistForChat("light", { ...TOUT_ACTIVE, profil }, {
        chatMode: "mattermost",
        remoteAgents: false,
        remoteTools: false,
      });
      expect(outils, profil).not.toContain("programmer_envoi");
      expect(outils, profil).not.toContain("planifier_tache");
    }
  });

  it("`lecture` n'a NI libraire d'archivage NI archive de vie antérieure", () => {
    const outils = toolAllowlist("light", { ...TOUT_ACTIVE, profil: "lecture" });
    expect(outils).toContain("recherche_libraire");
    expect(outils).not.toContain("archive_libraire");
    expect(outils).not.toContain("archive_vie_anterieure");
    expect(outils).not.toContain("chercher_conversations_archivees");
  });
});

describe("35f — non-régression : `complet` = comportement d'aujourd'hui", () => {
  it("`toolAllowlist` : sans profil = avec profil `complet` (élément pour élément)", () => {
    for (const role of ["light", "heavy"] as const) {
      expect(toolAllowlist(role, TOUT_ACTIVE)).toEqual(
        toolAllowlist(role, { ...TOUT_ACTIVE, profil: "complet" }),
      );
      expect(toolAllowlist(role, {})).toEqual(toolAllowlist(role, { profil: "complet" }));
    }
  });

  it("`toolAllowlistForChat` : local et canal, tous réglages, identiques", () => {
    const cas = [
      { chatMode: "local" as const, remoteAgents: false, remoteTools: false },
      { chatMode: "mattermost" as const, remoteAgents: false, remoteTools: false },
      { chatMode: "mattermost" as const, remoteAgents: true, remoteTools: false },
      { chatMode: "mattermost" as const, remoteAgents: false, remoteTools: true },
      { chatMode: "discord" as const, remoteAgents: true, remoteTools: true },
    ];
    for (const chat of cas) {
      expect(toolAllowlistForChat("light", TOUT_ACTIVE, chat)).toEqual(
        toolAllowlistForChat("light", { ...TOUT_ACTIVE, profil: "complet" }, chat),
      );
    }
  });

  it("le profil ABSENT (mono-bot historique) vaut `complet`", () => {
    expect(filtrerSelonProfil(TOUS_LES_OUTILS_CUSTOM, undefined)).toEqual(TOUS_LES_OUTILS_CUSTOM);
  });
});

describe("35f — provenances et valeurs inconnues", () => {
  it("une valeur de profil INCONNUE ne rouvre rien (fail-closed)", () => {
    // ⚠️ Une valeur venue d'un client ne peut pas arriver jusqu'ici (le registre
    // REFUSE un profil hors `PROFILS_BOT`, `src/bots/registry.ts:298-302`). Si elle
    // arrivait, on refuse TOUT plutôt que d'ouvrir les pouvoirs d'un bot restreint.
    const inconnu = "administrateur" as unknown as ProfilBot;
    expect(filtrerSelonProfil(TOUS_LES_OUTILS_CUSTOM, inconnu)).toEqual([]);
  });
});
