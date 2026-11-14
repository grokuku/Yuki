/**
 * CONSIGNES DURABLES D'UN BOT — stockage Markdown, LISIBLE ET ÉDITABLE À LA MAIN.
 *
 * Décision utilisateur (2026-11-14) : « si je dis à un bot "ne fais plus jamais
 * ça", je veux qu'il puisse enregistrer l'instruction quelque part (pas dans la
 * mémoire standard sinon ça ne sera pas forcément injecté) ». Deux listes :
 *
 *  - **Consignes** — des instructions IMPÉRATIVES (« ne refais plus jamais ça ») ;
 *  - **Faits** — des informations DÉCLARATIVES (« mon NAS est à 10.0.0.5 »).
 *
 * ⚠️ CE N'EST PAS LA MÉMOIRE : la mémoire est *recherchée* (rappel pertinent au
 * tour), les consignes et les faits sont **toujours** injectés. Deux natures,
 * deux fichiers de vie — les mélanger rendrait les consignes intermittentes.
 *
 * ⚠️ POURQUOI DU MARKDOWN, PAS DU JSON : l'utilisateur veut une ZONE D'ÉDITION
 * qu'il peut lire et corriger ; **supprimer une ligne doit suffire**. Un JSON
 * qu'on casse en éditant à la main serait un piège.
 *
 * Format (une section par nature, puces `- `) :
 *
 *     # Consignes durables
 *
 *     ## Consignes
 *
 *     - Ne refais plus jamais ça.
 *
 *     ## Faits
 *
 *     - Mon NAS est à 10.0.0.5.
 *
 * ⚠️ PARSING ROBUSTE : seules les lignes `- ` (ou `* ` / `+ `) d'une section
 * reconnue sont des entrées ; TOUT LE RESTE est ignoré sans casser (titres
 * libres, commentaires, sections inconnues). Fichier absent ou illisible ⇒
 * listes VIDES, jamais une erreur : un fichier manquant ne doit pas faire
 * échouer un tour.
 *
 * ⚠️ ÉCRITURE ATOMIQUE (0600) et JAMAIS de perte du contenu humain : quand le
 * bot ajoute une entrée, seul le contenu des DEUX sections connues est réécrit ;
 * tout le reste du fichier (titres, notes, sections inconnues) est conservé tel
 * quel.
 *
 * Aucun import SDK/typebox : données pures, testable sans SDK.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Nombre maximal de CONSIGNES (au-delà : refus EXPLICITE, jamais une troncature). */
export const MAX_CONSIGNES = 50;
/** Nombre maximal de FAITS (même règle). */
export const MAX_FAITS = 50;
/** Longueur maximale d'UNE entrée (caractères). */
export const MAX_ENTREE_CHARS = 500;
/**
 * Plafond GLOBAL injecté dans le prompt, consignes + faits réunis. Au-delà, on
 * tronque **en le disant dans le prompt** (jamais en silence).
 */
export const MAX_INJECTION_CHARS = 8_000;

/** Titre de la section des consignes (tel qu'écrit dans le fichier). */
export const TITRE_CONSIGNES = "Consignes";
/** Titre de la section des faits (tel qu'écrit dans le fichier). */
export const TITRE_FAITS = "Faits";
/** En-tête du fichier créé (le fichier existant, lui, n'est jamais réécrit en entier). */
export const ENTETE_FICHIER = "# Consignes durables";

/** Nature d'une entrée : consigne impérative ou fait déclaratif. */
export type NatureEntree = "consigne" | "fait";

/** Les deux listes d'un bot (listes VIDES si le fichier est absent). */
export interface ConsignesDocument {
  readonly consignes: readonly string[];
  readonly faits: readonly string[];
}

/** Document vide (aucun fichier) — jamais `null`. */
export const DOCUMENT_CONSIGNES_VIDE: ConsignesDocument = { consignes: [], faits: [] };

/** Motif d'un refus (le code est stable, le message est destiné à l'utilisateur). */
export type CodeRefusConsignes =
  | "texte_vide"
  | "entree_trop_longue"
  | "limite_consignes_atteinte"
  | "limite_faits_atteinte"
  | "doublon"
  | "correspondance_introuvable"
  | "correspondance_ambigue";

/** Refus EXPLICITE : le bot doit pouvoir le dire à l'utilisateur. */
export interface RefusConsignes {
  readonly ok: false;
  readonly refus: CodeRefusConsignes;
  /** Phrase française, actionnable (elle dit quoi faire). */
  readonly message: string;
  /** Document courant (inchangé) : l'appelant peut toujours afficher les listes. */
  readonly document: ConsignesDocument;
}

/** Ajout accepté (ou déjà présent : la déduplication n'est pas une erreur). */
export interface AjoutConsigne {
  readonly ok: true;
  /** `true` ⇒ l'entrée était DÉJÀ là (aucune écriture). */
  readonly dejaPresent: boolean;
  readonly nature: NatureEntree;
  readonly document: ConsignesDocument;
}

/** Retrait accepté. */
export interface RetraitConsigne {
  readonly ok: true;
  readonly nature: NatureEntree;
  /** Entrée réellement retirée (texte tel qu'il était enregistré). */
  readonly retiree: string;
  readonly document: ConsignesDocument;
}

export type ResultatAjoutConsigne = AjoutConsigne | RefusConsignes;
export type ResultatRetraitConsigne = RetraitConsigne | RefusConsignes;

/** Section telle qu'elle figure dans le fichier (titre + lignes). */
interface SectionFichier {
  /** Titre BRUT de la section reconnue, ou `null` pour le préambule. */
  readonly titre: string | null;
  /** Lignes de la section, EN-TÊTE EXCLU. */
  readonly lignes: string[];
}

/** Normalise un texte pour COMPARER (casse, accents, espaces). */
export function normaliserEntree(texte: string): string {
  return texte
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

/** Titre normalisé d'une ligne de titre Markdown (`## Consignes` ⇒ `consignes`). */
function titreReconnu(ligne: string): "consignes" | "faits" | null {
  const match = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u.exec(ligne);
  if (match === null) return null;
  const titre = normaliserEntree(match[1]);
  if (titre === "consignes" || titre === "consigne") return "consignes";
  if (titre === "faits" || titre === "fait") return "faits";
  return null;
}

/** Ligne de puce ⇒ entrée (ou `null` si ce n'est pas une puce remplie). */
function entreeDeLigne(ligne: string): string | null {
  const match = /^\s*[-*+]\s+(.*)$/u.exec(ligne);
  if (match === null) return null;
  const texte = match[1].trim();
  return texte === "" ? null : texte;
}

/**
 * ANALYSE le fichier en sections. Les lignes de titre SONT conservées comme
 * bornes : c'est ce qui permet de réécrire une section sans toucher au reste.
 */
function decouperSections(texte: string): SectionFichier[] {
  const lignes = texte.split(/\r?\n/u);
  const sections: SectionFichier[] = [];
  let courante: { titre: string | null; lignes: string[] } = { titre: null, lignes: [] };
  for (const ligne of lignes) {
    const estTitre = /^\s{0,3}#{1,6}\s+/u.test(ligne);
    if (estTitre) {
      sections.push({ titre: courante.titre, lignes: courante.lignes });
      courante = { titre: ligne, lignes: [] };
      continue;
    }
    courante.lignes.push(ligne);
  }
  sections.push({ titre: courante.titre, lignes: courante.lignes });
  return sections;
}

/** Nature d'une section d'après son titre brut (`null` ⇒ section inconnue). */
function natureDeSection(titre: string | null): NatureEntree | null {
  if (titre === null) return null;
  const reconnu = titreReconnu(titre);
  if (reconnu === "consignes") return "consigne";
  if (reconnu === "faits") return "fait";
  return null;
}

/**
 * ANALYSE ROBUSTE d'un contenu Markdown : rend les deux listes, dans l'ordre du
 * fichier. Toute ligne qui n'est pas une puce d'une section reconnue est IGNORÉE
 * (aucune erreur, jamais).
 */
export function analyserConsignes(texte: string): ConsignesDocument {
  const consignes: string[] = [];
  const faits: string[] = [];
  for (const section of decouperSections(texte)) {
    const nature = natureDeSection(section.titre);
    if (nature === null) continue;
    const cible = nature === "consigne" ? consignes : faits;
    for (const ligne of section.lignes) {
      const entree = entreeDeLigne(ligne);
      if (entree !== null) cible.push(entree);
    }
  }
  return { consignes, faits };
}

/** Rendu Markdown canonique d'une liste de puces (pour créer un fichier neuf). */
function renduSection(titre: string, entrees: readonly string[]): string[] {
  return [titre, "", ...entrees.map((entree) => `- ${entree}`), ""];
}

/** Rendu Markdown COMPLET du document (création d'un fichier neuf). */
export function renduConsignes(document: ConsignesDocument): string {
  return [
    ENTETE_FICHIER,
    "",
    ...renduSection(`## ${TITRE_CONSIGNES}`, document.consignes),
    ...renduSection(`## ${TITRE_FAITS}`, document.faits),
  ].join("\n");
}

/**
 * RÉÉCRIT UNE SECTION en préservant tout le reste du fichier.
 *
 * ⚠️ Ce qui est conservé : le préambule, les sections d'un AUTRE titre, et — à
 * l'intérieur de la section réécrite — les lignes qui ne sont pas des puces
 * (notes humaines). Les puces, elles, sont remplacées par `entrees`.
 */
function remplacerSection(
  texte: string,
  cible: NatureEntree,
  entrees: readonly string[],
): string {
  const sections = decouperSections(texte);
  const titreVoulu = cible === "consigne" ? TITRE_CONSIGNES : TITRE_FAITS;
  let trouvee = false;
  const rendu: string[] = [];
  for (const section of sections) {
    if (section.titre === null) {
      rendu.push(...section.lignes);
      continue;
    }
    if (natureDeSection(section.titre) !== cible) {
      rendu.push(section.titre, ...section.lignes);
      continue;
    }
    trouvee = true;
    const notes = section.lignes.filter((ligne) => entreeDeLigne(ligne) === null);
    // ⚠️ On garde les notes humaines, mais les puces obsolètes disparaissent.
    const notesUtiles = notes.filter((ligne) => ligne.trim() !== "");
    rendu.push(
      section.titre,
      ...notesUtiles.map((ligne) => ligne),
      "",
      ...entrees.map((entree) => `- ${entree}`),
      "",
    );
  }
  if (!trouvee) {
    // Section absente : ajoutée à la fin (le fichier n'avait pas cette liste).
    if (rendu.length > 0 && rendu[rendu.length - 1].trim() !== "") rendu.push("");
    rendu.push(...renduSection(`## ${titreVoulu}`, entrees));
  }
  // Compacte les lignes vides consécutives introduites par la réécriture.
  const compacte: string[] = [];
  for (const ligne of rendu) {
    if (ligne.trim() === "" && compacte.length > 0 && compacte[compacte.length - 1].trim() === "") {
      continue;
    }
    compacte.push(ligne);
  }
  while (compacte.length > 0 && compacte[compacte.length - 1].trim() === "") compacte.pop();
  return `${compacte.join("\n")}\n`;
}

/** Bornes appliquées à une nature (une entrée par nature). */
function borneDe(nature: NatureEntree): { max: number; libelle: string } {
  return nature === "consigne"
    ? { max: MAX_CONSIGNES, libelle: "consignes" }
    : { max: MAX_FAITS, libelle: "faits" };
}

/** Liste d'une nature dans un document. */
export function listeDe(document: ConsignesDocument, nature: NatureEntree): readonly string[] {
  return nature === "consigne" ? document.consignes : document.faits;
}

/** Document avec une liste remplacée. */
function avecListe(
  document: ConsignesDocument,
  nature: NatureEntree,
  liste: readonly string[],
): ConsignesDocument {
  return nature === "consigne"
    ? { consignes: liste, faits: document.faits }
    : { consignes: document.consignes, faits: liste };
}

/**
 * AJOUT PUR (sans disque) : contrôle les bornes, DÉDUPLIQUE, puis calcule le
 * document suivant. Toute limite franchie rend un refus EXPLICITE — jamais une
 * troncature muette.
 */
export function ajouterEntree(
  document: ConsignesDocument,
  nature: NatureEntree,
  texte: string,
): ResultatAjoutConsigne {
  const entree = texte.replace(/\s+/gu, " ").trim();
  if (entree === "") {
    return {
      ok: false,
      refus: "texte_vide",
      message: "Rien à enregistrer : le texte est vide.",
      document,
    };
  }
  if (Array.from(entree).length > MAX_ENTREE_CHARS) {
    return {
      ok: false,
      refus: "entree_trop_longue",
      message:
        `Entrée trop longue (${Array.from(entree).length} caractères, maximum ` +
        `${MAX_ENTREE_CHARS}). Résumez-la en une phrase.`,
      document,
    };
  }
  const liste = listeDe(document, nature);
  const cle = normaliserEntree(entree);
  if (liste.some((existante) => normaliserEntree(existante) === cle)) {
    // ⚠️ Un doublon n'est PAS une erreur : l'instruction est déjà en vigueur.
    return { ok: true, dejaPresent: true, nature, document };
  }
  const borne = borneDe(nature);
  if (liste.length >= borne.max) {
    return {
      ok: false,
      refus: nature === "consigne" ? "limite_consignes_atteinte" : "limite_faits_atteinte",
      message:
        `Trop de ${borne.libelle} (${liste.length} / ${borne.max}) : je n'en ajoute pas ` +
        `davantage. Supprimez-en avec \`oublier_consigne\`, ou à la main dans le fichier.`,
      document,
    };
  }
  return {
    ok: true,
    dejaPresent: false,
    nature,
    document: avecListe(document, nature, [...liste, entree]),
  };
}

/**
 * RETRAIT PUR : la correspondance doit être UNIQUE — une entrée qui en
 * chevaucherait plusieurs rend un refus explicite (retirer la mauvaise consigne
 * serait pire que ne rien faire).
 */
export function retirerEntree(
  document: ConsignesDocument,
  nature: NatureEntree,
  texte: string,
): ResultatRetraitConsigne {
  const recherche = normaliserEntree(texte);
  if (recherche === "") {
    return {
      ok: false,
      refus: "texte_vide",
      message: "Précisez la consigne à supprimer.",
      document,
    };
  }
  // ⚠️ DEUX listes candidates : une consigne et un fait peuvent se ressembler ;
  // on cherche dans la nature demandée, puis dans l'autre si la première est vide
  // (le modèle n'a pas à deviner la nature pour oublier quelque chose).
  const natureCherchee: NatureEntree =
    listeDe(document, nature).length > 0 ? nature : nature === "consigne" ? "fait" : "consigne";
  const liste = listeDe(document, natureCherchee);
  const egalites = liste.filter((entree) => normaliserEntree(entree) === recherche);
  const candidates =
    egalites.length > 0
      ? egalites
      : liste.filter((entree) => normaliserEntree(entree).includes(recherche));
  if (candidates.length === 0) {
    return {
      ok: false,
      refus: "correspondance_introuvable",
      message:
        `Aucune entrée ne correspond à « ${texte} ». Utilisez \`lister_consignes\` ` +
        "pour voir les listes exactes.",
      document,
    };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      refus: "correspondance_ambigue",
      message:
        `${candidates.length} entrées correspondent à « ${texte} » : précisez laquelle ` +
        "supprimer (recopiez son texte entier).",
      document,
    };
  }
  const retiree = candidates[0];
  const suivante = liste.filter((entree) => entree !== retiree);
  return {
    ok: true,
    nature: natureCherchee,
    retiree,
    document: avecListe(document, natureCherchee, suivante),
  };
}

/** Journal minimal (le vrai logger d'observabilité en est un sur-ensemble). */
export interface LoggerConsignes {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

/**
 * Port des consignes d'UN bot : lecture FRAÎCHE (relue à chaque tour) et
 * écritures atomiques.
 *
 * ⚠️ Un port par bot, construit avec LE chemin du bot : il n'y a aucun
 * `if (botId === …)`, et le port ne peut pas écrire dans le fichier d'un autre
 * (le chemin est capturé à la construction).
 */
export interface PortConsignes {
  /** Document courant (fichier relu ; absent ⇒ listes vides). */
  lire(): ConsignesDocument;
  ajouter(nature: NatureEntree, texte: string): ResultatAjoutConsigne;
  retirer(nature: NatureEntree, texte: string): ResultatRetraitConsigne;
  /** Remplace UNE liste (édition humaine de la zone) ; les autres sections sont préservées. */
  remplacer(nature: NatureEntree, entrees: readonly string[]): ResultatRemplacement;
  /** Chemin réel du fichier (diagnostic, interface). */
  chemin(): string;
}

/** Remplacement accepté : le document résultant est rendu pour l'affichage. */
export interface RemplacementConsignes {
  readonly ok: true;
  readonly nature: NatureEntree;
  readonly document: ConsignesDocument;
}
export type ResultatRemplacement = RemplacementConsignes | RefusConsignes;

/** Écriture ATOMIQUE, permissions 0600, jamais un fichier à moitié écrit. */
export function ecrireTexteAtomique(chemin: string, texte: string): void {
  const dossier = dirname(chemin);
  mkdirSync(dossier, { recursive: true, mode: 0o700 });
  const temporaire = join(dossier, `.${process.pid}-${Date.now()}-consignes.tmp`);
  try {
    writeFileSync(temporaire, texte, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaire, chemin);
    // ⚠️ `rename` conserve le mode du fichier temporaire ; on le réaffirme pour
    // qu'un fichier préexistant plus permissif ne garde pas ses permissions.
    chmodSync(chemin, 0o600);
  } catch (error) {
    try {
      unlinkSync(temporaire);
    } catch {
      // Le temporaire n'existe peut-être pas : rien à nettoyer.
    }
    throw error;
  }
}

export interface OptionsPortConsignes {
  /** Bot PROPRIÉTAIRE (journalisation seulement — le chemin porte la propriété). */
  readonly botId: string;
  /** Fichier `<state>/bots/<id>/consignes.md` de CE bot. */
  readonly chemin: string;
  readonly logger?: LoggerConsignes;
}

/**
 * Construit le port des consignes d'un bot.
 *
 * ⚠️ La lecture est FRAÎCHE à chaque appel (mise à jour à chaud) et ne lève
 * JAMAIS : un fichier illisible rend des listes vides, jamais une exception au
 * milieu d'un tour. ⚠️ Les écritures, elles, peuvent lever (disque plein) :
 * c'est l'appelant (outil/route) qui transforme l'échec en message explicite.
 */
export function portConsignes(options: OptionsPortConsignes): PortConsignes {
  const chemin = options.chemin;

  const lireTexte = (): string => {
    if (chemin.trim() === "") return "";
    try {
      return readFileSync(chemin, "utf8");
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code !== "ENOENT") {
        // ⚠️ Un fichier ILLISIBLE est signalé une fois (pas à chaque tour) — on
        // ne peut pas le distinguer d'un fichier absent, et le tour continue.
        options.logger?.warn("consignes.illisible", {
          bot: options.botId,
          fichier: chemin,
          error: error instanceof Error ? error.message : String(error),
          consequence: "consignes et faits ignorés pour ce tour",
        });
      }
      return "";
    }
  };

  const journaliser = (
    nature: NatureEntree,
    action: "ajout" | "retrait" | "remplacement",
    document: ConsignesDocument,
    dejaPresent = false,
  ): void => {
    // ⚠️ On journalise la NATURE et la TAILLE, jamais le texte de l'entrée : une
    // consigne peut contenir une information privée.
    options.logger?.info("consignes.ecriture", {
      bot: options.botId,
      action,
      nature,
      deja_present: dejaPresent,
      consignes: document.consignes.length,
      faits: document.faits.length,
      chars: Array.from(renduConsignes(document)).length,
    });
  };

  return {
    lire(): ConsignesDocument {
      return analyserConsignes(lireTexte());
    },
    ajouter(nature: NatureEntree, texte: string): ResultatAjoutConsigne {
      const texteFichier = lireTexte();
      const document = analyserConsignes(texteFichier);
      const resultat = ajouterEntree(document, nature, texte);
      if (!resultat.ok || resultat.dejaPresent) return resultat;
      const suivant = remplacerSection(
        texteFichier.trim() === "" ? renduConsignes(resultat.document) : texteFichier,
        nature,
        listeDe(resultat.document, nature),
      );
      ecrireTexteAtomique(chemin, suivant);
      const relu = analyserConsignes(suivant);
      journaliser(nature, "ajout", relu);
      return { ...resultat, document: relu };
    },
    retirer(nature: NatureEntree, texte: string): ResultatRetraitConsigne {
      const texteFichier = lireTexte();
      const document = analyserConsignes(texteFichier);
      const resultat = retirerEntree(document, nature, texte);
      if (!resultat.ok) return resultat;
      const suivant = remplacerSection(
        texteFichier.trim() === "" ? renduConsignes(resultat.document) : texteFichier,
        resultat.nature,
        listeDe(resultat.document, resultat.nature),
      );
      ecrireTexteAtomique(chemin, suivant);
      const relu = analyserConsignes(suivant);
      journaliser(resultat.nature, "retrait", relu);
      return { ...resultat, document: relu };
    },
    remplacer(nature: NatureEntree, entrees: readonly string[]): ResultatRemplacement {
      const texteFichier = lireTexte();
      const document = analyserConsignes(texteFichier);
      const borne = borneDe(nature);
      const propres: string[] = [];
      for (const brute of entrees) {
        const entree = brute.replace(/\s+/gu, " ").trim();
        if (entree === "") continue;
        if (Array.from(entree).length > MAX_ENTREE_CHARS) {
          return {
            ok: false,
            refus: "entree_trop_longue",
            message:
              `Entrée trop longue (${Array.from(entree).length} caractères, maximum ` +
              `${MAX_ENTREE_CHARS}) : « ${entree.slice(0, 60)}… ».`,
            document,
          };
        }
        if (propres.some((existante) => normaliserEntree(existante) === normaliserEntree(entree))) {
          continue;
        }
        propres.push(entree);
      }
      if (propres.length > borne.max) {
        return {
          ok: false,
          refus: nature === "consigne" ? "limite_consignes_atteinte" : "limite_faits_atteinte",
          message: `Trop de ${borne.libelle} (${propres.length} / ${borne.max}) : réduisez la liste.`,
          document,
        };
      }
      const suivant = remplacerSection(
        texteFichier.trim() === "" ? renduConsignes(avecListe(document, nature, propres)) : texteFichier,
        nature,
        propres,
      );
      ecrireTexteAtomique(chemin, suivant);
      const relu = analyserConsignes(suivant);
      journaliser(nature, "remplacement", relu);
      return { ok: true, nature, document: relu };
    },
    chemin(): string {
      return chemin;
    },
  };
}
