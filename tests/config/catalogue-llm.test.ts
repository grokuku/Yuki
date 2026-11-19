/**
 * CATALOGUE DE FOURNISSEURS ET DE MODÈLES — lot A (2026-11-19).
 *
 * Ce que ce fichier verrouille :
 *  ① les deux collections existent dans le SCHÉMA : `type: "liste"`, portée
 *    `instance`, défaut VIDE, éléments TYPÉS (validation stricte) — plus le
 *    drapeau de reprise `llm.catalogueMigre` ;
 *  ② la REPRISE depuis les réglages historiques : fournisseurs DÉDOUBLONNÉS
 *    (même adresse + même API = un seul), modèles créés pour léger/lourd/vision,
 *    AUCUNE perte (les clés historiques ne bougent pas) ;
 *  ③ elle est IDEMPOTENTE et ne rejoue JAMAIS sur un catalogue déjà rempli ;
 *  ④ le CRUD fournisseur / modèle et ses refus nommés (URL invalide, nom vide,
 *    identifiant en double, fournisseur inconnu, contexte non entier),
 *    y compris la SUPPRESSION d'un fournisseur encore utilisé ;
 *  ⑤ la clé d'un fournisseur n'est JAMAIS relue en clair (même garantie que
 *    `llm.light.apiKey`) ;
 *  ⑥ `models.json` est INCHANGÉ : le catalogue n'est pas encore branché sur
 *    l'exécution (c'est le lot B) ;
 *  ⑦ le RENDU de l'interface (garde statique sur `public/ui/`) : liste vide +
 *    bouton d'ajout, puis « Modifier » / « Supprimer » par ligne, via
 *    `HolafModal` — et AUCUN appel réseau vers un fournisseur.
 *
 * ⚠️ ÉCHOUE SUR LE CODE D'ORIGINE : ni `llm.fournisseurs` / `llm.modeles` /
 * `llm.catalogueMigre` (champs inconnus), ni `src/llm/catalogue.ts`, ni
 * `public/ui/catalogue-llm.js` n'existent — la reprise et le catalogue sont
 * absents.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadEnv } from "../../src/config/env.js";
import {
  ConfigValidationError,
  createConfigRuntime,
  type ConfigRuntime,
} from "../../src/config/runtime.js";
import { CONFIG_SCHEMA, descriptorOf, validateField } from "../../src/config/schema.js";
import { ConfigStore } from "../../src/config/store.js";
import {
  ecartsCatalogue,
  migrerCatalogue,
  planifierReprise,
  sourcesHereditees,
  type FournisseurLlm,
  type ModeleLlm,
} from "../../src/llm/catalogue.js";
import { buildModelsConfig } from "../../src/llm/models.js";
import { llmRouting } from "../../src/llm/routing.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeRuntime(initial?: Record<string, string>): {
  runtime: ConfigRuntime;
  storePath: string;
} {
  const root = mkdtempSync(join(tmpdir(), "yuki-catalogue-"));
  tempDirs.push(root);
  const storePath = join(root, "state", "config.json");
  const store = new ConfigStore(storePath);
  if (initial !== undefined) store.write(initial);
  const env = loadEnv({
    YUKI_MOUNT_STATE: join(root, "state"),
    YUKI_CONFIG_STORE_PATH: storePath,
    YUKI_PI_SYSTEM_PROMPT: join(root, "light.md"),
    YUKI_PI_HEAVY_SYSTEM_PROMPT: join(root, "heavy.md"),
  });
  const runtime = createConfigRuntime({
    env,
    store,
    processEnv: {},
    promptDefaults: { light: "prompt léger", heavy: "prompt lourd" },
  });
  return { runtime, storePath };
}

/** Réglages historiques d'une installation déjà configurée. */
const HERITAGE = {
  "llm.light.baseUrl": "https://ollama.com/v1",
  "llm.light.model": "gemma4:31b",
  "llm.light.thinking": "off",
  "llm.light.vision": "oui",
  "llm.light.apiKey": "sk-light-123456789",
  "llm.heavy.baseUrl": "https://ollama.com/v1",
  "llm.heavy.model": "deepseek-v4.1-flash",
  "llm.heavy.thinking": "high",
  "llm.heavy.vision": "non",
  "llm.heavy.apiKey": "sk-heavy-987654321",
  "llm.vision.baseUrl": "https://vision.exemple.fr/v1",
  "llm.vision.model": "qwen-vl",
  "llm.vision.thinking": "off",
  "llm.vision.apiKey": "sk-vision-abcdef",
} as const;

const FOURNISSEUR_LOCAL: FournisseurLlm = {
  id: "local",
  nom: "Local",
  baseUrl: "https://local.exemple.fr/v1",
  api: "openai-completions",
};

const MODELE_ALPHA: ModeleLlm = {
  id: "alpha",
  nom: "chat",
  fournisseurId: "local",
  contexte: 131072,
  vision: true,
  thinking: "off",
};

describe("① le schéma : deux collections typées, portée instance, défaut vide", () => {
  it("déclare `llm.fournisseurs` et `llm.modeles` en `liste`, instance, défaut vide", () => {
    for (const chemin of ["llm.fournisseurs", "llm.modeles"]) {
      const descriptor = CONFIG_SCHEMA[chemin];
      expect(descriptor, chemin).toBeDefined();
      expect(descriptor?.type, chemin).toBe("liste");
      expect(descriptor?.scope, chemin).toBe("instance");
      expect(descriptor?.default, chemin).toBe("");
      expect(descriptor?.items?.length, chemin).toBeGreaterThan(0);
    }
    const { runtime } = makeRuntime();
    expect(runtime.get("llm.fournisseurs")).toBe("");
    expect(runtime.get("llm.modeles")).toBe("");
    expect(runtime.getString("llm.catalogueMigre")).toBe("non");
  });

  it("refuse une valeur qui ne respecte pas la forme déclarée", () => {
    const refus = (chemin: string, valeur: unknown): string => {
      const result = validateField(chemin, valeur);
      return result.ok ? "" : result.code;
    };
    // Nom vide, URL invalide, dialecte inconnu, identifiant malformé.
    expect(refus("llm.fournisseurs", [{ id: "local", nom: "", baseUrl: "https://a.fr", api: "openai-completions" }])).toBe("empty_value");
    expect(refus("llm.fournisseurs", [{ id: "local", nom: "Local", baseUrl: "ollama.com", api: "openai-completions" }])).toBe("invalid_url");
    expect(refus("llm.fournisseurs", [{ id: "local", nom: "Local", baseUrl: "https://a.fr", api: "anthropic" }])).toBe("invalid_enum");
    expect(refus("llm.fournisseurs", [{ id: "Local!", nom: "Local", baseUrl: "https://a.fr", api: "openai-completions" }])).toBe("invalid_id");
    // Propriété NON DÉCLARÉE : refusée (sinon elle serait stockée sans validation).
    expect(refus("llm.fournisseurs", [{ id: "local", nom: "Local", baseUrl: "https://a.fr", api: "openai-completions", apiKey: "x" }])).toBe("unknown_item_field");
    // Identifiants en double.
    expect(refus("llm.fournisseurs", [
      { id: "local", nom: "Local", baseUrl: "https://a.fr", api: "openai-completions" },
      { id: "local", nom: "Autre", baseUrl: "https://b.fr", api: "openai-completions" },
    ])).toBe("duplicate_id");
    // Contexte non entier, puis nul.
    expect(refus("llm.modeles", [{ id: "a", nom: "chat", fournisseurId: "local", contexte: "beaucoup", thinking: "off" }])).toBe("invalid_int");
    expect(refus("llm.modeles", [{ id: "a", nom: "chat", fournisseurId: "local", contexte: 0, thinking: "off" }])).toBe("below_min");
    // Forme canonique : un vrai tableau est accepté et normalisé en JSON.
    const ok = validateField("llm.modeles", [
      { id: "a", nom: "chat", fournisseurId: "local", contexte: 4096, thinking: "off" },
    ]);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(JSON.parse(String(ok.value))).toEqual([
      { id: "a", nom: "chat", fournisseurId: "local", contexte: 4096, vision: false, thinking: "off" },
    ]);
  });

  it("le chemin de clé d'un fournisseur est SECRET (comme `llm.light.apiKey`)", () => {
    expect(descriptorOf("llm.fournisseur.local.apiKey")).toMatchObject({
      type: "string",
      scope: "instance",
      secret: true,
    });
    // Un identifiant malformé n'ouvre AUCUN chemin dynamique.
    expect(descriptorOf("llm.fournisseur.Local!.apiKey")).toBeUndefined();
  });
});

describe("② reprise depuis les réglages historiques", () => {
  it("crée les fournisseurs DÉDOUBLONNÉS et les trois modèles, sans rien supprimer", () => {
    const { runtime, storePath } = makeRuntime({ ...HERITAGE });
    const journal: Array<{ evenement: string; donnees: Record<string, unknown> }> = [];
    migrerCatalogue(runtime, (evenement, donnees) => journal.push({ evenement, donnees }));

    const fournisseurs = runtime.fournisseurs();
    const modeles = runtime.modeles();
    // Léger et lourd partagent la MÊME adresse + la MÊME API ⇒ UN fournisseur.
    expect(fournisseurs.map((fournisseur) => fournisseur.baseUrl)).toEqual([
      "https://ollama.com/v1",
      "https://vision.exemple.fr/v1",
    ]);
    expect(fournisseurs[0]?.id).toBe("ollama-com");
    // Trois modèles, un par rôle historique.
    expect(modeles.map((modele) => modele.nom)).toEqual([
      "gemma4:31b",
      "deepseek-v4.1-flash",
      "qwen-vl",
    ]);
    expect(modeles[0]).toMatchObject({
      fournisseurId: fournisseurs[0]?.id,
      vision: true,
      thinking: "off",
      contexte: 131_072,
    });
    // ⚠️ Le LOURD a déclaré `vision: non` : la déclaration est reprise telle quelle.
    expect(modeles[1]?.vision).toBe(false);
    expect(modeles[1]?.thinking).toBe("high");
    // Le modèle de vision dédié rejoint SON fournisseur et voit les images.
    expect(modeles[2]).toMatchObject({ fournisseurId: fournisseurs[1]?.id, vision: true });

    // ⚠️ « Le premier qui porte la clé la garde » : léger avant lourd.
    expect(runtime.getString("llm.fournisseur.ollama-com.apiKey")).toBe("sk-light-123456789");
    expect(runtime.getString("llm.fournisseur.vision-exemple-fr.apiKey")).toBe("sk-vision-abcdef");

    // La reprise est JOURNALISÉE, nommée.
    expect(journal).toHaveLength(1);
    expect(journal[0]?.evenement).toBe("llm.migration.fournisseurs");
    expect(journal[0]?.donnees).toMatchObject({ fournisseurs: 2, modeles: 3 });

    // ⚠️ GARDE RÉVISÉE (lot B) : les clés historiques sont RETIRÉES du SCHÉMA.
    // La reprise les a LUES (valeurs de fournisseur, de modèle ET de clé) puis
    // réécrit le store, qui ne les contient plus. Rien n'est perdu : tout est dans
    // le catalogue et dans les chemins secrets `llm.fournisseur.<id>.apiKey`.
    const store = JSON.parse(readFileSync(storePath, "utf8")) as { values: Record<string, unknown> };
    expect(store.values["llm.light.apiKey"]).toBeUndefined();
    expect(store.values["llm.light.model"]).toBeUndefined();
    expect(runtime.getString("llm.fournisseur.ollama-com.apiKey")).toBe("sk-light-123456789");
    expect(store.values["llm.catalogueMigre"]).toBe("oui");
    // ⚠️ POINT CRITIQUE : les DÉFAUTS de rôle sont posés dans le MÊME appel — sans
    // eux, tous les bots perdraient leur modèle à la bascule sur le catalogue.
    expect(runtime.getString("llm.defaut.light")).toBe(modeles[0]?.id);
    expect(runtime.getString("llm.defaut.heavy")).toBe(modeles[1]?.id);
    expect(runtime.getString("llm.defaut.vision")).toBe(modeles[2]?.id);
  });

  it("est IDEMPOTENTE : deux passages donnent exactement les mêmes lignes", () => {
    const { runtime, storePath } = makeRuntime({ ...HERITAGE });
    migrerCatalogue(runtime, () => {});
    const apresUn = readFileSync(storePath, "utf8");
    migrerCatalogue(runtime, () => {});
    expect(readFileSync(storePath, "utf8")).toBe(apresUn);
    expect(runtime.modeles()).toHaveLength(3);
  });

  it("ne touche JAMAIS un catalogue déjà rempli (la liste de l'utilisateur est sa vérité)", () => {
    const { runtime } = makeRuntime({
      ...HERITAGE,
      "llm.fournisseurs": JSON.stringify([FOURNISSEUR_LOCAL]),
      "llm.modeles": JSON.stringify([MODELE_ALPHA]),
    });
    const journal: string[] = [];
    migrerCatalogue(runtime, (evenement) => journal.push(evenement));
    expect(runtime.fournisseurs()).toEqual([FOURNISSEUR_LOCAL]);
    expect(runtime.modeles()).toEqual([MODELE_ALPHA]);
    // Aucune reprise journalisée ; le drapeau est posé pour ne pas rejouer plus tard.
    expect(journal).toEqual([]);
    expect(runtime.getString("llm.catalogueMigre")).toBe("oui");
  });

  it("ne repeuple pas un catalogue que l'utilisateur a VIDÉ volontairement", () => {
    const { runtime } = makeRuntime({ ...HERITAGE, "llm.catalogueMigre": "oui" });
    migrerCatalogue(runtime, () => {});
    expect(runtime.fournisseurs()).toEqual([]);
    expect(runtime.modeles()).toEqual([]);
  });

  it("fonction PURE : même entrée ⇒ même plan (aucun identifiant aléatoire)", () => {
    const { runtime } = makeRuntime({ ...HERITAGE });
    const sources = sourcesHereditees(runtime);
    const premier = planifierReprise(sources, false, [], []);
    const second = planifierReprise(sources, false, [], []);
    expect(premier).toEqual(second);
    expect(premier.action).toBe("migrer");
    // Adresse vide (aucun modèle de vision configuré) ⇒ aucun fournisseur fantôme.
    const sansVision = planifierReprise(
      { ...sources, vision: { ...sources.vision, baseUrl: "", modele: "" } },
      false,
      [],
      [],
    );
    expect(sansVision.fournisseurs).toHaveLength(1);
    expect(sansVision.modeles).toHaveLength(2);
  });
});

describe("④ CRUD fournisseur et modèle (validation serveur)", () => {
  it("ajoute, modifie et supprime un fournisseur", () => {
    const { runtime } = makeRuntime();
    runtime.update({ "llm.fournisseurs": JSON.stringify([FOURNISSEUR_LOCAL]) });
    expect(runtime.fournisseurs()).toEqual([FOURNISSEUR_LOCAL]);

    const modifie = { ...FOURNISSEUR_LOCAL, nom: "Local renommé" };
    runtime.update({ "llm.fournisseurs": JSON.stringify([modifie]) });
    expect(runtime.fournisseurs()[0]?.nom).toBe("Local renommé");

    runtime.update({ "llm.fournisseurs": JSON.stringify([]) });
    expect(runtime.fournisseurs()).toEqual([]);
  });

  it("refuse une URL invalide et un nom vide (même par PUT direct)", () => {
    const { runtime } = makeRuntime();
    expect(() =>
      runtime.update({
        "llm.fournisseurs": JSON.stringify([{ ...FOURNISSEUR_LOCAL, baseUrl: "local" }]),
      }),
    ).toThrow(ConfigValidationError);
    expect(() =>
      runtime.update({ "llm.fournisseurs": JSON.stringify([{ ...FOURNISSEUR_LOCAL, nom: "  " }]) }),
    ).toThrow(ConfigValidationError);
    expect(runtime.fournisseurs()).toEqual([]);
  });

  it("ajoute, modifie et supprime un modèle", () => {
    const { runtime } = makeRuntime();
    runtime.update({
      "llm.fournisseurs": JSON.stringify([FOURNISSEUR_LOCAL]),
      "llm.modeles": JSON.stringify([MODELE_ALPHA]),
    });
    expect(runtime.modeles()).toEqual([MODELE_ALPHA]);

    const modifie = { ...MODELE_ALPHA, contexte: 32_768, vision: false, thinking: "high" };
    runtime.update({ "llm.modeles": JSON.stringify([modifie]) });
    expect(runtime.modeles()[0]).toEqual(modifie);

    runtime.update({ "llm.modeles": JSON.stringify([]) });
    expect(runtime.modeles()).toEqual([]);
  });

  it("refuse un `fournisseurId` inexistant et un contexte non entier", () => {
    const { runtime } = makeRuntime();
    runtime.update({ "llm.fournisseurs": JSON.stringify([FOURNISSEUR_LOCAL]) });
    // Le refus est NOMMÉ jusque dans les erreurs de champ (pas un « invalide » sec).
    let refus: unknown = null;
    try {
      runtime.update({
        "llm.modeles": JSON.stringify([{ ...MODELE_ALPHA, fournisseurId: "fantome" }]),
      });
    } catch (error) {
      refus = error;
    }
    expect(refus).toBeInstanceOf(ConfigValidationError);
    expect(JSON.stringify((refus as ConfigValidationError).fields)).toContain(
      "fournisseur « fantome » inconnu",
    );
    expect(() =>
      runtime.update({ "llm.modeles": JSON.stringify([{ ...MODELE_ALPHA, contexte: 1.5 }]) }),
    ).toThrow(ConfigValidationError);
    expect(runtime.modeles()).toEqual([]);
  });

  it("REFUSE de supprimer un fournisseur encore utilisé (refus nommé, pas de cascade)", () => {
    const { runtime } = makeRuntime();
    runtime.update({
      "llm.fournisseurs": JSON.stringify([FOURNISSEUR_LOCAL]),
      "llm.modeles": JSON.stringify([MODELE_ALPHA]),
    });
    let message = "";
    try {
      runtime.update({ "llm.fournisseurs": JSON.stringify([]) });
    } catch (error) {
      message = error instanceof Error ? JSON.stringify(error) : String(error);
    }
    expect(message).toContain("provider_in_use");
    expect(message).toContain("Local");
    expect(message).toContain("1 modèle(s)");
    // Le fournisseur est TOUJOURS là : le refus n'a rien écrit.
    expect(runtime.fournisseurs()).toEqual([FOURNISSEUR_LOCAL]);

    // Une fois les modèles supprimés (ou déplacés), la suppression passe.
    runtime.update({ "llm.modeles": JSON.stringify([]) });
    runtime.update({ "llm.fournisseurs": JSON.stringify([]) });
    expect(runtime.fournisseurs()).toEqual([]);
  });

  it("la suppression d'un fournisseur emporte sa clé (plus de clé orpheline)", () => {
    const { runtime, storePath } = makeRuntime();
    runtime.update({
      "llm.fournisseurs": JSON.stringify([FOURNISSEUR_LOCAL]),
      "llm.fournisseur.local.apiKey": "sk-local-abcdef",
    });
    expect(runtime.getString("llm.fournisseur.local.apiKey")).toBe("sk-local-abcdef");
    runtime.update({ "llm.fournisseurs": JSON.stringify([]) });
    const store = JSON.parse(readFileSync(storePath, "utf8")) as { values: Record<string, unknown> };
    expect(store.values["llm.fournisseur.local.apiKey"]).toBeUndefined();
  });

  it("refuse une clé saisie pour un fournisseur qui n'existe pas", () => {
    const { runtime } = makeRuntime();
    expect(() => runtime.update({ "llm.fournisseur.inconnu.apiKey": "sk-x-123456" })).toThrow(
      ConfigValidationError,
    );
  });

  it("`ecartsCatalogue` distingue un fournisseur RETIRÉ d'un fournisseur inconnu", () => {
    const retire = ecartsCatalogue(
      { fournisseurs: [FOURNISSEUR_LOCAL] },
      { fournisseurs: [], modeles: [MODELE_ALPHA] },
    );
    expect(retire.map((ecart) => ecart.code)).toEqual(["provider_in_use"]);
    const inconnu = ecartsCatalogue(
      { fournisseurs: [] },
      { fournisseurs: [], modeles: [MODELE_ALPHA] },
    );
    expect(inconnu.map((ecart) => ecart.code)).toEqual(["unknown_provider"]);
  });
});

describe("⑤ la clé d'un fournisseur n'est jamais relue en clair", () => {
  it("le snapshot porte `configured` + `masked`, jamais la valeur", () => {
    const { runtime } = makeRuntime();
    runtime.update({
      "llm.fournisseurs": JSON.stringify([FOURNISSEUR_LOCAL]),
      "llm.fournisseur.local.apiKey": "sk-local-abcdef123456",
    });
    const snapshot = runtime.snapshot();
    const champ = snapshot.fields["llm.fournisseur.local.apiKey"];
    expect(champ).toMatchObject({ configured: true, scope: "instance" });
    expect(JSON.stringify(snapshot)).not.toContain("sk-local-abcdef123456");
    // Masquée mais lisible par l'utilisateur (« Clé configurée (sk-l…456) »).
    expect(JSON.stringify(champ)).toContain("•");
    // Et la clé est retirée des journaux (redaction du logger).
    expect(runtime.secretValues()).toContain("sk-local-abcdef123456");
  });

  it("`null` efface la clé (bouton « Effacer »)", () => {
    const { runtime } = makeRuntime();
    runtime.update({
      "llm.fournisseurs": JSON.stringify([FOURNISSEUR_LOCAL]),
      "llm.fournisseur.local.apiKey": "sk-local-abcdef123456",
    });
    runtime.update({ "llm.fournisseur.local.apiKey": null });
    expect(runtime.getString("llm.fournisseur.local.apiKey")).toBe("");
    expect(runtime.snapshot().fields["llm.fournisseur.local.apiKey"]).toMatchObject({
      configured: false,
      masked: null,
    });
  });
});

describe("⑥ `models.json` vient du CATALOGUE (plus des rôles)", () => {
  it("écrire le catalogue réécrit le fichier : fournisseurs, modèles et clés du catalogue", () => {
    const { runtime } = makeRuntime({ ...HERITAGE });
    migrerCatalogue(runtime, () => {});
    runtime.update({
      "llm.fournisseurs": JSON.stringify([FOURNISSEUR_LOCAL]),
      "llm.modeles": JSON.stringify([MODELE_ALPHA]),
      "llm.defaut.light": "alpha",
      "llm.defaut.heavy": "alpha",
    });
    const routage = llmRouting(runtime);
    // ⚠️ Les providers `llm-light` / `llm-heavy` / `llm-vision` N'EXISTENT PLUS :
    // le fichier reflète le CATALOGUE (un provider par fournisseur déclaré).
    expect(Object.keys(routage.file.providers)).toEqual(["local"]);
    expect(routage.file.providers["local"]?.models.map((modele) => modele.id)).toEqual(["chat"]);
    expect(routage.models.light.reference).toBe("local/chat");
    expect(routage.effective.light.vision).toBe(true);
    // Le fichier par DÉFAUT du code (gabarit historique) reste indépendant : il ne
    // dépend d'aucune configuration, il n'est plus la source de l'exécution.
    expect(buildModelsConfig()).toBeDefined();
  });
});

const lire = (nom: string): string => readFileSync(join("public", "ui", nom), "utf8");

describe("⑦ rendu de l'interface (garde statique sur public/ui/)", () => {
  it("liste vide annoncée + boutons d'ajout, puis « Modifier » / « Supprimer » par ligne", () => {
    const source = lire("catalogue-llm.js");
    // Les deux collections sont lues ET écrites.
    expect(source).toContain("llm.fournisseurs");
    expect(source).toContain("llm.modeles");
    // Liste vide : un message clair, pas une page blanche.
    expect(source).toContain("Aucun fournisseur");
    expect(source).toContain("Aucun modèle");
    // Les quatre gestes demandés.
    expect(source).toContain("Ajouter un fournisseur");
    expect(source).toContain("Ajouter un modèle");
    expect(source).toContain('"Modifier"');
    expect(source).toContain('"Supprimer"');
    // Modale de la brique (jamais la confirmation native), et refus nommé.
    expect(source).toContain("HolafModal.open(");
    expect(source).toContain("HolafModal.confirm(");
    expect(source).toContain("utilisé par");
    // ⚠️ AUCUN appel réseau vers un fournisseur dans ce lot.
    expect(source).not.toContain("fetch(");
    expect(source).not.toContain("/models");
  });

  it("l'onglet « Catalogue » monte le module sur la page Instance seulement", () => {
    const config = lire("config.js");
    expect(config).toContain("initCatalogueLlm({");
    expect(config).toContain('containers.get("catalogue")');
    const html = readFileSync(join("public", "ui", "config.html"), "utf8");
    expect(html).toContain('id="panel-catalogue"');
    expect(html).toContain('id="group-catalogue"');
  });
});
