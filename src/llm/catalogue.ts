/**
 * CATALOGUE de fournisseurs et de modèles (lot A, 2026-11-19) — données PURES.
 *
 * Deux collections persistées dans la configuration d'INSTANCE :
 *
 *  - `llm.fournisseurs` : `{ id, nom, baseUrl, api }` — un fournisseur
 *    compatible API OpenAI ;
 *  - `llm.modeles` : `{ id, nom, fournisseurId, contexte, vision, thinking }` —
 *    un modèle, toujours rattaché à UN fournisseur (`fournisseurId`).
 *
 * ⚠️ LA CLÉ D'API N'EST PAS DANS LE TABLEAU — et c'est DÉLIBÉRÉ. Le contenu de
 * `llm.fournisseurs` est une valeur de configuration ordinaire : elle est servie
 * TELLE QUELLE par `GET /api/config` (l'interface en a besoin pour éditer la
 * liste). Y mettre la clé la publierait en clair à chaque lecture de la page.
 * Chaque fournisseur porte donc sa clé dans un chemin SECRET dédié
 * (`llm.fournisseur.<id>.apiKey`), qui suit exactement la mécanique des clés
 * existantes (`llm.<rôle>.apiKey`) : masqué dans l'API (`configured` +
 * `masked`), effacé par `null`, reflété dans `process.env` par `bridgeSecrets`.
 *
 * ⚠️ PORTÉE `instance` : un fournisseur et un modèle appartiennent à
 * l'INSTALLATION, pas à un bot (la capacité de voir les images est une propriété
 * du MODÈLE). Les SURCHARGES par bot (`llm.bot.<rôle>`) ne dupliquent jamais le
 * catalogue : elles ne portent qu'un `modeleId`.
 *
 * ⚠️ DEPUIS LE LOT B (2026-11-19) CE CATALOGUE EST LA SOURCE DE L'EXÉCUTION :
 * `models.json` en est construit (`src/llm/execution.ts`), et chaque rôle
 * (`light` / `heavy` / `vision`) ne référence qu'un `modeleId` :
 * `llm.defaut.<rôle>` pour l'installation, `llm.bot.<rôle>` pour un bot. Le
 * fournisseur (adresse, dialecte, clé) et les propriétés du modèle (fenêtre de
 * contexte, VISION, RÉFLEXION) sont DÉRIVÉS du catalogue — jamais du rôle.
 *
 * Aucun import SDK/typebox, aucune dépendance à `node:fs` : ce module est
 * testable seul et réutilisable par le runtime de configuration.
 */

import {
  HEAVY_MODEL,
  LIGHT_MODEL,
  VISION_MODEL,
  type ThinkingLevelName,
} from "./models.js";

/** Dialectes d'API acceptés pour un fournisseur (un seul aujourd'hui). */
export const API_FOURNISSEUR = ["openai-completions"] as const;

/** Fournisseur de LLM tel que persisté dans `llm.fournisseurs`. */
export interface FournisseurLlm {
  readonly id: string;
  readonly nom: string;
  readonly baseUrl: string;
  /** Dialecte (`openai-completions`). */
  readonly api: string;
}

/** Modèle tel que persisté dans `llm.modeles`. */
export interface ModeleLlm {
  readonly id: string;
  readonly nom: string;
  readonly fournisseurId: string;
  /** Fenêtre de contexte, en jetons (entier > 0). */
  readonly contexte: number;
  /** Le modèle reçoit les images (DÉCLARATION, jamais une mesure). */
  readonly vision: boolean;
  /** Niveau de réflexion du modèle (propriété du MODÈLE, plus du rôle). */
  readonly thinking: ThinkingLevelName;
}

/**
 * Préfixe des chemins de clé d'API d'un fournisseur du catalogue.
 *
 * ⚠️ Distinct de `llm.provider.<id>.apiKey` (catalogue historique du commit
 * externe `134a313`) : deux catalogues cohabitent le temps du lot A, et leurs
 * clés ne doivent JAMAIS se confondre (une clé écrite pour l'un ne doit pas
 * apparaître « configurée » pour l'autre).
 */
const PREFIXE_CLE = "llm.fournisseur.";

/** Motif d'un chemin de clé de fournisseur ; capture l'identifiant. */
const MOTIF_CLE = /^llm\.fournisseur\.([a-z0-9][a-z0-9-]{0,63})\.apiKey$/;

/** Identifiant d'un fournisseur extrait d'un chemin de clé (sinon `undefined`). */
export function idCleFournisseur(path: string): string | undefined {
  return MOTIF_CLE.exec(path)?.[1];
}

/** Chemin de la clé d'API d'un fournisseur du catalogue. */
export function cheminCleFournisseur(id: string): string {
  return `${PREFIXE_CLE}${id}.apiKey`;
}

/**
 * Nom de la variable d'environnement qui reflète la clé d'un fournisseur.
 *
 * ⚠️ C'est CETTE variable que référence `models.json` (`apiKey: "$…_API_KEY"`) :
 * une clé n'est donc jamais écrite dans un fichier dérivé, seulement reflétée
 * dans `process.env` par `ConfigRuntime.bridgeSecrets`.
 */
export function nomEnvCleFournisseur(id: string): string {
  return `YUKI_LLM_FOURNISSEUR_${id.toUpperCase().replace(/-/g, "_")}_API_KEY`;
}

/** Valeur brute d'une collection (chaîne JSON du store) → tableau d'objets. */
function objets(brut: string | undefined): Array<Record<string, unknown>> {
  if (typeof brut !== "string" || brut.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(brut);
  } catch {
    // Un store corrompu ne doit JAMAIS empêcher le démarrage : on lit « vide ».
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item),
  );
}

function texte(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Fournisseurs d'une valeur brute (`llm.fournisseurs`). Lecture TOLÉRANTE. */
export function lireFournisseurs(brut: string | undefined): FournisseurLlm[] {
  return objets(brut)
    .map((item) => ({
      id: texte(item.id),
      nom: texte(item.nom),
      baseUrl: texte(item.baseUrl),
      api: texte(item.api),
    }))
    .filter((fournisseur) => fournisseur.id !== "");
}

/** Modèles d'une valeur brute (`llm.modeles`). Lecture TOLÉRANTE. */
export function lireModeles(brut: string | undefined): ModeleLlm[] {
  return objets(brut)
    .map((item) => ({
      id: texte(item.id),
      nom: texte(item.nom),
      fournisseurId: texte(item.fournisseurId),
      contexte: typeof item.contexte === "number" ? item.contexte : Number.parseInt(texte(item.contexte), 10),
      vision: item.vision === true,
      thinking: texte(item.thinking) as ThinkingLevelName,
    }))
    .filter((modele) => modele.id !== "");
}

/** Minuscules, accents retirés, tout ce qui n'est pas alphanumérique → `-`. */
function slug(texteBrut: string): string {
  const base = texteBrut
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return base;
}

/**
 * Identifiant STABLE dérivé d'un libellé, unique parmi `pris`.
 *
 * ⚠️ Jamais l'index du tableau : un identifiant qui bouge quand on réordonne ou
 * supprime une ligne casserait toutes les références (`fournisseurId`).
 * Collision ⇒ suffixe `-2`, `-3`… (déterministe, donc idempotent).
 */
export function identifiantDepuis(libelle: string, pris: ReadonlySet<string>, repli = "element"): string {
  const base = slug(libelle) || repli;
  if (!pris.has(base)) return base;
  for (let suffixe = 2; ; suffixe += 1) {
    const candidat = `${base.slice(0, 60)}-${suffixe}`;
    if (!pris.has(candidat)) return candidat;
  }
}

/** Nom lisible d'un fournisseur déduit de son adresse (`ollama.com`). */
function nomDepuisUrl(baseUrl: string): string {
  try {
    const hote = new URL(baseUrl).hostname;
    return hote !== "" ? hote : baseUrl;
  } catch {
    return baseUrl;
  }
}

/** Adresse normalisée pour la DÉDUPLICATION (sans barre finale ni espaces). */
function adresseNormalisee(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

/** Ce dont un rôle HISTORIQUE (`llm.<rôle>.*`) dispose aujourd'hui. */
export interface HerediteRole {
  readonly baseUrl: string;
  readonly api: string;
  readonly apiKey: string;
  readonly modele: string;
  readonly thinking: ThinkingLevelName;
  /** Déclaration de vision du rôle (`llm.<rôle>.vision === "oui"`). */
  readonly vision: boolean;
  /** Fenêtre de contexte que l'exécution déclare aujourd'hui pour ce rôle. */
  readonly contexte: number;
}

/** Les trois rôles historiques, dans l'ordre de reprise. */
export const ROLES_HERITES = ["light", "heavy", "vision"] as const;
export type RoleHerite = (typeof ROLES_HERITES)[number];

/** Ce que la reprise doit FAIRE — jamais autre chose. */
export type ActionReprise = "rien" | "drapeau" | "migrer";

export interface PlanReprise {
  readonly action: ActionReprise;
  readonly fournisseurs: readonly FournisseurLlm[];
  readonly modeles: readonly ModeleLlm[];
  /** Clés d'API à écrire, par chemin (`llm.fournisseur.<id>.apiKey`). */
  readonly cles: Readonly<Record<string, string>>;
  /**
   * Modèle PAR DÉFAUT de chaque rôle dans le catalogue repris.
   *
   * ⚠️ POINT CRITIQUE DU LOT B : sans ces valeurs, la bascule sur le catalogue
   * laisserait tous les bots SANS modèle (un rôle sans défaut est un mode
   * dégradé, pas un défaut). Un rôle sans équivalent exploitable est ABSENT du
   * mapping.
   */
  readonly defauts: Readonly<Partial<Record<RoleHerite, string>>>;
}

const PLAN_VIDE: PlanReprise = {
  action: "rien",
  fournisseurs: [],
  modeles: [],
  cles: {},
  defauts: {},
};

/**
 * REPRISE ADDITIVE du catalogue depuis les réglages historiques.
 *
 * Règles (décisions utilisateur du 2026-11-19) :
 *  - elle ne s'exécute qu'UNE fois (`llm.catalogueMigre`) : un catalogue que
 *    l'utilisateur a VIDÉ volontairement ne doit pas se repeupler tout seul ;
 *  - un catalogue DÉJÀ rempli n'est JAMAIS touché (sa liste est sa vérité) —
 *    on pose seulement le drapeau, pour ne pas rejouer la reprise plus tard ;
 *  - DÉDOUBLONNAGE par fournisseur : même `baseUrl` + même `api` ⇒ un seul
 *    fournisseur ; la PREMIÈRE clé rencontrée est conservée (on n'écrase jamais
 *    une clé par une autre) ;
 *  - DÉDOUBLONNAGE par modèle : même fournisseur + même nom ⇒ une seule ligne
 *    (deux rôles qui utilisent le même modèle ne créent pas deux entrées) ;
 *  - un fournisseur n'est créé QUE s'il porte au moins un modèle (une adresse de
 *    vision vide ne fabrique pas un fournisseur fantôme) ;
 *  - le MODÈLE PAR DÉFAUT de chaque rôle est repris (`PlanReprise.defauts`) :
 *    c'est ce qui empêche tous les bots de perdre leur modèle à la bascule.
 *
 * Fonction PURE : deux appels avec les mêmes entrées rendent le même plan.
 */
export function planifierReprise(
  sources: Readonly<Record<RoleHerite, HerediteRole>>,
  dejaMigre: boolean,
  fournisseurs: readonly FournisseurLlm[],
  modeles: readonly ModeleLlm[],
): PlanReprise {
  if (dejaMigre) return PLAN_VIDE;
  // Catalogue déjà rempli : la liste de l'utilisateur est sa vérité.
  if (fournisseurs.length > 0 || modeles.length > 0) return { ...PLAN_VIDE, action: "drapeau" };

  const parAdresse = new Map<string, FournisseurLlm>();
  /** Modèles déjà créés, par `fournisseurId|nom` (dédoublonnage inter-rôles). */
  const parModele = new Map<string, ModeleLlm>();
  const idsFournisseurs = new Set<string>();
  const idsModeles = new Set<string>();
  const cles: Record<string, string> = {};
  const defauts: Partial<Record<RoleHerite, string>> = {};
  const crees: ModeleLlm[] = [];

  for (const role of ROLES_HERITES) {
    const source = sources[role];
    const baseUrl = adresseNormalisee(source.baseUrl);
    const modele = source.modele.trim();
    // Pas d'adresse OU pas de modèle ⇒ ce rôle ne décrit rien d'exploitable.
    if (baseUrl === "" || modele === "") continue;
    const api = source.api.trim() === "" ? API_FOURNISSEUR[0] : source.api.trim();
    const cleAdresse = `${baseUrl}|${api}`;
    let fournisseur = parAdresse.get(cleAdresse);
    if (fournisseur === undefined) {
      fournisseur = {
        id: identifiantDepuis(nomDepuisUrl(baseUrl), idsFournisseurs, "fournisseur"),
        nom: nomDepuisUrl(baseUrl),
        baseUrl,
        api,
      };
      idsFournisseurs.add(fournisseur.id);
      parAdresse.set(cleAdresse, fournisseur);
    }
    // ⚠️ « Le premier qui porte la clé la garde » : une clé déjà posée pour ce
    // fournisseur n'est jamais remplacée par celle d'un autre rôle.
    const cle = source.apiKey.trim();
    if (cle !== "" && !(cheminCleFournisseur(fournisseur.id) in cles)) {
      cles[cheminCleFournisseur(fournisseur.id)] = cle;
    }
    const cleModele = `${fournisseur.id}|${modele}`;
    const existant = parModele.get(cleModele);
    if (existant !== undefined) {
      // Même fournisseur + même modèle : une seule entrée, les deux rôles y
      // pointent (aucun doublon dans `llm.modeles`).
      defauts[role] = existant.id;
      continue;
    }
    const cree: ModeleLlm = {
      id: identifiantDepuis(modele, idsModeles, "modele"),
      nom: modele,
      fournisseurId: fournisseur.id,
      contexte: Number.isInteger(source.contexte) && source.contexte > 0 ? source.contexte : 1,
      vision: source.vision,
      thinking: source.thinking,
    };
    idsModeles.add(cree.id);
    parModele.set(cleModele, cree);
    crees.push(cree);
    defauts[role] = cree.id;
  }

  if (crees.length === 0) return { ...PLAN_VIDE, action: "drapeau" };
  return {
    action: "migrer",
    fournisseurs: [...parAdresse.values()],
    modeles: crees,
    cles,
    defauts,
  };
}

/** Modèles rattachés à un fournisseur (dans l'ordre du catalogue). */
export function modelesDuFournisseur(
  modeles: readonly ModeleLlm[],
  fournisseurId: string,
): ModeleLlm[] {
  return modeles.filter((modele) => modele.fournisseurId === fournisseurId);
}

/** Écart de cohérence, au format des erreurs de champ du runtime. */
export interface EcartCatalogue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

/**
 * INCOHÉRENCES du catalogue — refus NOMMÉS côté serveur.
 *
 * Deux invariants seulement, et ils suffisent :
 *  ① tout modèle pointe un fournisseur EXISTANT ;
 *  ② supprimer un fournisseur encore UTILISÉ est REFUSÉ (le message dit combien
 *    de modèles, et lesquels) — pas de suppression en cascade silencieuse : elle
 *    retirerait des modèles que l'utilisateur n'a pas demandé de supprimer.
 *
 * `avant` sert à DISTINGUER les deux cas : un fournisseur qui vient d'être retiré
 * alors que des modèles le référencent n'est pas « inconnu », il est « utilisé ».
 */
export function ecartsCatalogue(
  avant: { readonly fournisseurs: readonly FournisseurLlm[] },
  apres: {
    readonly fournisseurs: readonly FournisseurLlm[];
    readonly modeles: readonly ModeleLlm[];
  },
): EcartCatalogue[] {
  const connus = new Set(apres.fournisseurs.map((fournisseur) => fournisseur.id));
  const retires = new Map(
    avant.fournisseurs
      .filter((fournisseur) => !connus.has(fournisseur.id))
      .map((fournisseur) => [fournisseur.id, fournisseur]),
  );
  const ecarts: EcartCatalogue[] = [];
  const orphelins = new Map<string, ModeleLlm[]>();
  for (const modele of apres.modeles) {
    if (connus.has(modele.fournisseurId)) continue;
    const retire = retires.get(modele.fournisseurId);
    if (retire === undefined) {
      ecarts.push({
        path: "llm.modeles",
        code: "unknown_provider",
        message: `Modèle « ${modele.nom} » : fournisseur « ${modele.fournisseurId} » inconnu.`,
      });
      continue;
    }
    const liste = orphelins.get(retire.id) ?? [];
    liste.push(modele);
    orphelins.set(retire.id, liste);
  }
  for (const [id, modeles] of orphelins) {
    const fournisseur = retires.get(id) as FournisseurLlm;
    const noms = modeles.map((modele) => modele.nom).join(", ");
    ecarts.push({
      path: "llm.fournisseurs",
      code: "provider_in_use",
      message:
        `Fournisseur « ${fournisseur.nom} » utilisé par ${modeles.length} modèle(s) ` +
        `(${noms}) : supprimez d'abord ces modèles.`,
    });
  }
  return ecarts;
}

/**
 * Rôles d'exécution qui DÉSIGNENT ce modèle (comparaison sur le `modeleId`).
 *
 * Sert à SIGNALER (jamais à bloquer) : supprimer un modèle référencé par un rôle
 * reste permis — le rôle passe alors en MODE DÉGRADÉ EXPLICITE (« modèle
 * introuvable », journalisé) jusqu'à ce qu'un autre modèle soit choisi.
 */
export function rolesQuiUtilisent(
  modele: ModeleLlm,
  selections: Readonly<Record<RoleHerite, string>>,
): RoleHerite[] {
  return ROLES_HERITES.filter((role) => selections[role].trim() === modele.id);
}

/** Libellé français d'un rôle, pour les messages d'interface. */
export function libelleRole(role: RoleHerite): string {
  if (role === "light") return "léger";
  if (role === "heavy") return "lourd";
  return "vision";
}

/**
 * Variables d'environnement HISTORIQUES des réglages par rôle.
 *
 * ⚠️ Elles ne sont plus des surcharges du schéma (les clés sont RETIRÉES) : elles
 * ne servent plus qu'à la REPRISE au démarrage. Sans cette lecture, un déploiement
 * réglé par `YUKI_LLM_LIGHT_MODEL` perdrait son modèle à la bascule.
 */
export const ENV_HISTORIQUES: Readonly<Record<string, string>> = {
  "llm.light.api": "YUKI_LLM_LIGHT_API",
  "llm.light.baseUrl": "YUKI_LLM_LIGHT_BASE_URL",
  "llm.light.apiKey": "YUKI_LLM_LIGHT_API_KEY",
  "llm.light.model": "YUKI_LLM_LIGHT_MODEL",
  "llm.light.thinking": "YUKI_LLM_LIGHT_THINKING",
  "llm.heavy.api": "YUKI_LLM_HEAVY_API",
  "llm.heavy.baseUrl": "YUKI_LLM_HEAVY_BASE_URL",
  "llm.heavy.apiKey": "YUKI_LLM_HEAVY_API_KEY",
  "llm.heavy.model": "YUKI_LLM_HEAVY_MODEL",
  "llm.heavy.thinking": "YUKI_LLM_HEAVY_THINKING",
  "llm.vision.baseUrl": "YUKI_LLM_VISION_BASE_URL",
  "llm.vision.apiKey": "YUKI_LLM_VISION_API_KEY",
  "llm.vision.model": "YUKI_LLM_VISION_MODEL",
  "llm.vision.thinking": "YUKI_LLM_VISION_THINKING",
};

/** Alias DÉPRÉCIÉS des mêmes variables (lecture seule, reprise uniquement). */
export const ENV_HISTORIQUES_ALIAS: Readonly<Record<string, readonly string[]>> = {
  "llm.light.apiKey": ["YUKI_LLM_DISCUSSION_API_KEY"],
  "llm.heavy.apiKey": ["YUKI_LLM_TRAVAIL_API_KEY"],
};

/**
 * Lecteur de configuration minimal (aucun couplage au runtime complet).
 *
 * ⚠️ `historique` est la SEULE voie d'accès aux valeurs des clés RETIRÉES du
 * schéma (elles ne sont plus dans les valeurs validées du runtime). Sans elle, la
 * reprise du lot A et la reprise des défauts du lot B liraient du vide — et tous
 * les bots perdraient leur modèle.
 */
export interface LecteurConfig {
  getString(path: string): string;
  /** Valeur brute d'une clé retirée du schéma (store ou variable historique). */
  historique?(path: string): string | undefined;
}

/**
 * Valeur d'un réglage HISTORIQUE : store brut, puis variable d'environnement, puis
 * DÉFAUT DU CODE.
 *
 * ⚠️ Le défaut du code n'est pas un détail : les clés par rôle et leurs valeurs par
 * défaut (`gemma4:31b`, `deepseek-v4.1-flash`) ont été retirées du schéma en même
 * temps. Sans ce repli, une INSTALLATION NEUVE n'aurait AUCUN catalogue, donc
 * aucun modèle — la conversation ne pourrait pas démarrer tant que l'utilisateur
 * n'aurait pas tout saisi à la main.
 */
function valeurHeritee(config: LecteurConfig, path: string, defaut: string): string {
  const brute = config.historique?.(path);
  if (typeof brute === "string") return brute;
  const effective = config.getString(path);
  return effective.trim() === "" ? defaut : effective;
}

/**
 * Valeurs PAR DÉFAUT du code pour les rôles historiques (point de départ d'une
 * installation neuve) — mêmes données que les gabarits de `src/llm/models.ts`.
 */
export const HERITAGE_DEFAUT: Readonly<Record<RoleHerite, HerediteRole>> = {
  light: {
    baseUrl: "https://ollama.com/v1",
    api: "openai-completions",
    apiKey: "",
    modele: "gemma4:31b",
    thinking: "off",
    vision: true,
    contexte: 131_072,
  },
  heavy: {
    baseUrl: "https://ollama.com/v1",
    api: "openai-completions",
    apiKey: "",
    modele: "deepseek-v4.1-flash",
    thinking: "high",
    vision: true,
    contexte: 131_072,
  },
  // ⚠️ Le rôle vision n'a AUCUN défaut : un modèle de vision inventé ferait
  // échouer la première image décrite. « Aucun repli » est l'état normal.
  vision: {
    baseUrl: "",
    api: "openai-completions",
    apiKey: "",
    modele: "",
    thinking: "off",
    vision: true,
    contexte: 131_072,
  },
};

/**
 * Ce que les réglages historiques déclarent AUJOURD'HUI, rôle par rôle.
 *
 * ⚠️ `contexte` vient des spécifications de modèle de `src/llm/models.ts` : c'est
 * la fenêtre que l'exécution déclare réellement pour ce rôle (le lot A n'en
 * invente pas une autre). `vision` est la DÉCLARATION du rôle
 * (`llm.<rôle>.vision === "oui"`) ; le modèle de vision DÉDIÉ voit les images
 * par définition (`true`).
 */
export function sourcesHereditees(
  config: LecteurConfig,
): Record<RoleHerite, HerediteRole> {
  return {
    light: {
      baseUrl: valeurHeritee(config, "llm.light.baseUrl", HERITAGE_DEFAUT.light.baseUrl),
      api: valeurHeritee(config, "llm.light.api", HERITAGE_DEFAUT.light.api),
      apiKey: valeurHeritee(config, "llm.light.apiKey", ""),
      modele: valeurHeritee(config, "llm.light.model", HERITAGE_DEFAUT.light.modele),
      thinking: valeurHeritee(config, "llm.light.thinking", HERITAGE_DEFAUT.light.thinking) as ThinkingLevelName,
      vision: valeurHeritee(config, "llm.light.vision", "oui") === "oui",
      contexte: LIGHT_MODEL.contextWindow,
    },
    heavy: {
      baseUrl: valeurHeritee(config, "llm.heavy.baseUrl", HERITAGE_DEFAUT.heavy.baseUrl),
      api: valeurHeritee(config, "llm.heavy.api", HERITAGE_DEFAUT.heavy.api),
      apiKey: valeurHeritee(config, "llm.heavy.apiKey", ""),
      modele: valeurHeritee(config, "llm.heavy.model", HERITAGE_DEFAUT.heavy.modele),
      thinking: valeurHeritee(config, "llm.heavy.thinking", HERITAGE_DEFAUT.heavy.thinking) as ThinkingLevelName,
      vision: valeurHeritee(config, "llm.heavy.vision", "oui") === "oui",
      contexte: HEAVY_MODEL.contextWindow,
    },
    vision: {
      // ⚠️ Aucun défaut : le repli n'existe QUE si l'utilisateur a nommé un modèle.
      baseUrl: valeurHeritee(config, "llm.vision.baseUrl", ""),
      // ⚠️ Pas de clé `llm.vision.api` : le fournisseur du repli est compatible
      // OpenAI par construction.
      api: API_FOURNISSEUR[0],
      apiKey: valeurHeritee(config, "llm.vision.apiKey", ""),
      modele: valeurHeritee(config, "llm.vision.model", ""),
      thinking: valeurHeritee(config, "llm.vision.thinking", "off") as ThinkingLevelName,
      vision: true,
      contexte: VISION_MODEL.contextWindow,
    },
  };
}

/** Portée de configuration minimale suffisante pour appliquer la reprise. */
export interface PorteeCatalogue extends LecteurConfig {
  update(patch: Record<string, unknown>): unknown;
}

/** Journalisation de la reprise (clé d'événement + données). */
export type JournalCatalogue = (
  evenement: string,
  donnees: Record<string, unknown>,
) => void;

/**
 * REPRISE DU CATALOGUE au démarrage (lot A) — ADDITIVE, UNE SEULE FOIS.
 *
 * Ne lève JAMAIS : une reprise qui échoue (volume `state` en lecture seule,
 * store corrompu) ne doit pas empêcher le gateway de démarrer — et surtout pas
 * empêcher l'utilisateur d'ouvrir `/config` pour corriger. L'échec est journalisé.
 *
 * ⚠️ POINT CRITIQUE (lot B) : la reprise écrit AUSSI `llm.defaut.<rôle>` pour
 * chaque rôle repris. Sans ces défauts, basculer `models.json` sur le catalogue
 * laisserait tous les bots sans modèle (régression totale) — les défauts sont
 * donc posés dans le MÊME appel que les listes.
 */
export function migrerCatalogue(
  config: PorteeCatalogue,
  journal: JournalCatalogue,
): PlanReprise {
  const plan = planifierReprise(
    sourcesHereditees(config),
    config.getString("llm.catalogueMigre") === "oui",
    lireFournisseurs(config.getString("llm.fournisseurs")),
    lireModeles(config.getString("llm.modeles")),
  );
  if (plan.action === "rien") return plan;
  try {
    if (plan.action === "drapeau") {
      // Catalogue déjà rempli (ou rien d'exploitable à reprendre) : AUCUNE liste
      // n'est réécrite, on empêche seulement une reprise ultérieure.
      config.update({ "llm.catalogueMigre": "oui" });
      return plan;
    }
    const defauts: Record<string, unknown> = {};
    for (const role of ROLES_HERITES) {
      const modeleId = plan.defauts[role];
      if (typeof modeleId === "string" && modeleId !== "") {
        defauts[cheminDefaut(role)] = modeleId;
      }
    }
    config.update({
      "llm.fournisseurs": JSON.stringify(plan.fournisseurs),
      "llm.modeles": JSON.stringify(plan.modeles),
      "llm.catalogueMigre": "oui",
      ...plan.cles,
      // ⚠️ APRÈS les listes : les défauts référencent des identifiants qui
      // viennent d'être créés (la validation croisée les exige connus).
      ...defauts,
    });
    journal("llm.migration.fournisseurs", {
      fournisseurs: plan.fournisseurs.length,
      modeles: plan.modeles.length,
      noms: plan.fournisseurs.map((fournisseur) => fournisseur.nom),
    });
  } catch (error) {
    journal("llm.migration.fournisseurs.echec", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return plan;
}

// ───────────────────────────────────────────────────────────────────────────
// SÉLECTIONS DE RÔLE (lot B) : défauts d'instance + surcharges par bot
// ───────────────────────────────────────────────────────────────────────────

/** Chemin de la clé du modèle par DÉFAUT d'un rôle (`instance`). */
export function cheminDefaut(role: RoleHerite): string {
  return `llm.defaut.${role}`;
}

/** Chemin de la SURCHARGE d'un rôle pour un bot (`bot`). */
export function cheminSurchargeBot(role: RoleHerite): string {
  return `llm.bot.${role}`;
}

/** Sélection d'un rôle : `modeleId` du catalogue (`""` = rien de réglé). */
export type SelectionsRoles = Readonly<Record<RoleHerite, string>>;

/** Sélection VIDE (aucun rôle ne référence de modèle). */
export const SELECTIONS_VIDES: SelectionsRoles = { light: "", heavy: "", vision: "" };

function selections(config: LecteurConfig, prefixe: "llm.defaut" | "llm.bot"): SelectionsRoles {
  return {
    light: config.getString(`${prefixe}.light`).trim(),
    heavy: config.getString(`${prefixe}.heavy`).trim(),
    vision: config.getString(`${prefixe}.vision`).trim(),
  };
}

/** Modèles par DÉFAUT de l'installation (`llm.defaut.*`, portée instance). */
export function defautsInstance(config: LecteurConfig): SelectionsRoles {
  return selections(config, "llm.defaut");
}

/** Surcharges d'un BOT (`llm.bot.*`, portée bot — l'overlay du bot est déjà lu). */
export function surchargesBot(config: LecteurConfig): SelectionsRoles {
  return selections(config, "llm.bot");
}

/** Modèle du catalogue par identifiant (`undefined` s'il n'existe plus). */
export function modeleParId(
  modeles: readonly ModeleLlm[],
  id: string,
): ModeleLlm | undefined {
  if (id.trim() === "") return undefined;
  return modeles.find((modele) => modele.id === id.trim());
}

/** Fournisseur du catalogue par identifiant. */
export function fournisseurParId(
  fournisseurs: readonly FournisseurLlm[],
  id: string,
): FournisseurLlm | undefined {
  return fournisseurs.find((fournisseur) => fournisseur.id === id);
}

/**
 * REPRISE DES DÉFAUTS depuis les réglages historiques (lot B) — le filet de
 * sécurité qui empêche TOUS les bots de perdre leur modèle.
 *
 * Cas visé : une installation où le lot A a déjà rempli le catalogue
 * (`llm.catalogueMigre = "oui"`) mais où `llm.defaut.*` n'existe pas encore (le
 * lot A ne l'écrivait pas). Les rôles d'exécution étaient réglés par
 * `llm.light.model` / `llm.heavy.model` / `llm.vision.model` : ces valeurs sont
 * reportées sur le `modeleId` correspondant du catalogue.
 *
 * Règles :
 *  - un défaut DÉJÀ renseigné n'est JAMAIS écrasé (le choix de l'utilisateur
 *    prime) ;
 *  - un rôle dont le modèle historique n'a pas d'équivalent dans le catalogue
 *    n'est PAS inventé : il reste vide (mode dégradé explicite) et c'est DIT
 *    (`llm.role.defaut_non_repris`) ;
 *  - l'avertissement `llm.anciennes_cles_ignorees` liste les chemins historiques
 *    encore porteurs d'une valeur, une fois la reprise faite ;
 *  - ne lève JAMAIS : un volume en lecture seule ne doit pas empêcher de
 *    démarrer (l'utilisateur pourrait ne plus ouvrir `/config` pour corriger).
 */
export function reprendreDefautsDepuisRoles(
  config: PorteeCatalogue,
  journal: JournalCatalogue,
): Readonly<Partial<Record<RoleHerite, string>>> {
  const modeles = lireModeles(config.getString("llm.modeles"));
  // ⚠️ Catalogue ENCORE VIDE (premier démarrage) : c'est `migrerCatalogue` qui va
  // le remplir ET poser les défauts. Rien à reprendre ici, et surtout rien à
  // signaler (une installation neuve n'a aucun réglage historique à regretter).
  if (modeles.length === 0) return {};
  const heritage = sourcesHereditees(config);
  const reprise: Partial<Record<RoleHerite, string>> = {};
  const manquants: Array<{ role: RoleHerite; modele: string }> = [];
  for (const role of ROLES_HERITES) {
    if (config.getString(cheminDefaut(role)).trim() !== "") continue;
    const nom = heritage[role].modele.trim();
    if (nom === "") continue;
    const modele =
      modeles.find((candidat) => candidat.nom.trim() === nom) ??
      modeles.find((candidat) => candidat.id === nom);
    if (modele === undefined) {
      manquants.push({ role, modele: nom });
      continue;
    }
    reprise[role] = modele.id;
  }

  // ⚠️ AVERTISSEMENT calculé AVANT l'écriture : réécrire le store retire les clés
  // retirées du schéma (elles n'y survivent pas), donc les nommer après coup
  // reviendrait à ne rien dire.
  const anciennes = cheminsHistoriquesRenseignes(config);

  const patch: Record<string, unknown> = {};
  for (const [role, modeleId] of Object.entries(reprise)) {
    patch[cheminDefaut(role as RoleHerite)] = modeleId;
  }
  if (Object.keys(patch).length > 0) {
    try {
      config.update(patch);
    } catch (error) {
      journal("llm.defauts.reprise.echec", {
        error: error instanceof Error ? error.message : String(error),
      });
      return {};
    }
  }

  if (anciennes.length > 0) {
    journal("llm.anciennes_cles_ignorees", {
      cles: anciennes,
      remplace: "catalogue llm.fournisseurs + llm.modeles (llm.defaut.* / llm.bot.*)",
      defauts_repris: reprise,
    });
  }
  for (const manquant of manquants) {
    journal("llm.role.defaut_non_repris", { role: manquant.role, modele: manquant.modele });
  }
  return reprise;
}

/**
 * Chemins historiques qui portent ENCORE une valeur PERSISTÉE (store ou variable
 * d'environnement) — pour l'avertissement `llm.anciennes_cles_ignorees`.
 *
 * ⚠️ On ne compte PAS les défauts du code (`HERITAGE_DEFAUT`) : ils ne sont pas un
 * réglage de l'utilisateur, et les annoncer « ignorés » ferait du bruit sur une
 * installation neuve.
 */
export function cheminsHistoriquesRenseignes(config: LecteurConfig): string[] {
  const chemins: string[] = [];
  for (const role of ROLES_HERITES) {
    for (const champ of ["api", "baseUrl", "model", "thinking", "vision", "apiKey"]) {
      const path = `llm.${role}.${champ}`;
      const brute = config.historique?.(path);
      const renseignee = brute !== undefined
        ? brute.trim() !== ""
        : config.getString(path).trim() !== "";
      if (renseignee) chemins.push(path);
    }
  }
  return chemins;
}

/**
 * CATALOGUE depuis un `models.json` HISTORIQUE (import unique du premier
 * démarrage, quand le store est vide et qu'un fichier existe sur le volume).
 *
 * ⚠️ « Au mieux », et DIT : ce fichier ne dit pas quel modèle sert à quel rôle
 * (il ne connaît que des PROVIDERS). Les trois providers historiques
 * (`llm-light`, `llm-heavy`, `llm-vision`) donnent le rôle ; tout autre provider
 * est repris comme fournisseur du catalogue sans rôle par défaut. La RÉFLEXION
 * n'y est pas exprimée simplement (`reasoning` + `thinkingLevelMap`) : `high` si
 * le modèle raisonne, `off` sinon — c'est un point de départ, pas une vérité.
 *
 * Rend `undefined` quand il n'y a rien d'exploitable (jamais d'exception).
 */
export function catalogueDepuisModelsJson(parsed: unknown): {
  fournisseurs: FournisseurLlm[];
  modeles: ModeleLlm[];
  defauts: Partial<Record<RoleHerite, string>>;
} | undefined {
  const providers = (parsed as { providers?: unknown } | null)?.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return undefined;
  const fournisseurs: FournisseurLlm[] = [];
  const modeles: ModeleLlm[] = [];
  const defauts: Partial<Record<RoleHerite, string>> = {};
  const rolesHistoriques: Record<string, RoleHerite> = {
    "llm-light": "light",
    "llm-heavy": "heavy",
    "llm-vision": "vision",
  };
  const idsFournisseurs = new Set<string>();
  const idsModeles = new Set<string>();
  for (const [brut, valeur] of Object.entries(providers as Record<string, unknown>)) {
    if (!valeur || typeof valeur !== "object") continue;
    const record = valeur as Record<string, unknown>;
    const baseUrl = texte(record.baseUrl);
    if (baseUrl === "") continue;
    const id = identifiantDepuis(brut, idsFournisseurs, "fournisseur");
    idsFournisseurs.add(id);
    fournisseurs.push({
      id,
      nom: texte(record.name) === "" ? nomDepuisUrl(baseUrl) : texte(record.name),
      baseUrl,
      api: texte(record.api) === "" ? API_FOURNISSEUR[0] : texte(record.api),
    });
    const liste = Array.isArray(record.models) ? record.models : [];
    for (const entree of liste) {
      if (!entree || typeof entree !== "object") continue;
      const modele = entree as Record<string, unknown>;
      const nom = texte(modele.id);
      if (nom === "") continue;
      const idModele = identifiantDepuis(nom, idsModeles, "modele");
      idsModeles.add(idModele);
      const contexte = typeof modele.contextWindow === "number" ? modele.contextWindow : 1;
      modeles.push({
        id: idModele,
        nom,
        fournisseurId: id,
        contexte: contexte > 0 ? contexte : 1,
        vision: Array.isArray(modele.input) && modele.input.includes("image"),
        thinking: modele.reasoning === true ? "high" : "off",
      });
      const role = rolesHistoriques[brut];
      if (role !== undefined && defauts[role] === undefined) defauts[role] = idModele;
    }
  }
  if (modeles.length === 0) return undefined;
  return { fournisseurs, modeles, defauts };
}
