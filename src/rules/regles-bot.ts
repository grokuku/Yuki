/**
 * RÈGLES D'UN BOT — RÉSOLUTION DE LA SOURCE (`fichier du bot → fichier d'instance → rien`).
 *
 * ⚠️ RÉGRESSION CORRIGÉE (2026-11-14) : le bot de la PILE lisait le store
 * d'INSTANCE (`<state>/rules.md`), alors que la migration multi-bot (lot 35a) a
 * DÉPLACÉ ce fichier vers `<state>/bots/<id>/rules.md` (`src/bots/paths.ts:114`,
 * `src/bots/migrate.ts`). Conséquence : les règles du bot de la pile n'étaient
 * **jamais** injectées — seuls les bots secondaires lisaient leur fichier.
 *
 * La résolution est donc la MÊME que celle de la personnalité
 * (`src/bots/personnalite-bot.ts`) : les DEUX emplacements sont candidats, du plus
 * SPÉCIFIQUE au plus GÉNÉRAL, et **aucun `botId` n'est traité à part** :
 *  ① `<state>/bots/<id>/rules.md` — le fichier DU BOT (emplacement actuel) ;
 *  ② `<state>/rules.md` — le fichier HISTORIQUE de l'instance (ancien emplacement
 *     mono-bot), que la migration a pu déplacer… ou pas (surcharge de déploiement
 *     hors volume, migration partielle, restauration de sauvegarde).
 *
 * ⚠️ LECTURE SEULE : ce module ne déplace et n'écrase JAMAIS ②. Il le LIT.
 *
 * ⚠️ Le port rendu relit les fichiers À CHAQUE TOUR (comme le `RulesStore` qu'il
 * remplace) : une règle modifiée s'applique à chaud, sans redémarrage.
 *
 * Aucun import SDK/typebox.
 */

import { readFileSync } from "node:fs";
import { resolve as resoudreChemin } from "node:path";

import { clampRulesText } from "./rules.js";
import type { RulesDocument, RulesPort } from "./types.js";

/** Portée d'un fichier candidat (voir l'ordre de priorité dans l'en-tête). */
export type PorteeFichierRegles = "bot" | "instance";

/** Un fichier candidat, désigné par son CHEMIN (la lecture est faite à chaque tour). */
export interface CandidatFichierRegles {
  /** `bot` = fichier du bot ; `instance` = fichier historique de l'instance. */
  readonly portee: PorteeFichierRegles;
  /** Chemin réel du fichier (diagnostic, journal, interface). */
  readonly chemin: string;
}

/** Provenance d'un texte de règles retenu. */
export type ProvenanceRegles = PorteeFichierRegles | "aucune";

/** Résultat d'une résolution : UN texte, jamais une concaténation. */
export interface ReglesBot {
  /** Texte retenu (vide ⇒ rien n'est injecté : aucun en-tête orphelin). */
  readonly texte: string;
  /** Fichier qui a servi, ou `null` si aucun candidat ne dit rien. */
  readonly fichier: CandidatFichierRegles | null;
  /** D'où vient ce texte (`aucune` ⇒ aucun fichier rempli). */
  readonly provenance: ProvenanceRegles;
}

/** Journal minimal (le vrai logger d'observabilité en est un sur-ensemble). */
export interface LoggerReglesBot {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

/** Document VIDE (aucun fichier rempli) — jamais une exception. */
const DOCUMENT_VIDE: RulesDocument = {
  text: "",
  chars: 0,
  truncated: false,
  exists: false,
};

/**
 * Lit un fichier de règles sans jamais lever : absent ou illisible ⇒ document
 * VIDE (un document illisible ne doit jamais faire échouer un tour). La borne
 * de caractères est celle du domaine (`RULES_MAX_CHARS`).
 */
export function lireDocumentRegles(chemin: string): RulesDocument {
  if (chemin.trim() === "") return DOCUMENT_VIDE;
  try {
    const brut = readFileSync(chemin, "utf8");
    const borne = clampRulesText(brut);
    return {
      text: borne.text,
      chars: borne.chars,
      truncated: borne.truncated,
      exists: true,
    };
  } catch {
    return DOCUMENT_VIDE;
  }
}

/**
 * Liste des candidats, SANS doublon : quand le fichier du bot ET le fichier
 * d'instance sont le MÊME fichier (mode mono-bot, ou surcharge de déploiement),
 * il n'est lu qu'une fois — et désigné par sa portée la plus SPÉCIFIQUE.
 */
export function candidatsRegles(
  ...listes: readonly (CandidatFichierRegles | undefined)[]
): CandidatFichierRegles[] {
  const vus = new Set<string>();
  const candidats: CandidatFichierRegles[] = [];
  for (const candidat of listes) {
    if (candidat === undefined) continue;
    if (candidat.chemin.trim() === "") continue;
    const cle = resoudreChemin(candidat.chemin);
    if (vus.has(cle)) continue;
    vus.add(cle);
    candidats.push(candidat);
  }
  return candidats;
}

/**
 * Résout les règles d'un bot à partir de ses documents DÉJÀ LUS (testable sans
 * disque, comme `personnaliteEffective`).
 *
 * Le PREMIER candidat dont le texte n'est pas vide gagne : l'ordre de la liste
 * porte la priorité (`bot` puis `instance`).
 */
export function reglesEffectives(
  documents: readonly { readonly candidat: CandidatFichierRegles; readonly document: RulesDocument }[],
): ReglesBot {
  const retenu = documents.find((entree) => entree.document.text.trim() !== "");
  if (retenu === undefined) return { texte: "", fichier: null, provenance: "aucune" };
  return {
    texte: retenu.document.text,
    fichier: retenu.candidat,
    provenance: retenu.candidat.portee,
  };
}

export interface OptionsReglesBot {
  /** Bot concerné (journalisation, diagnostic). */
  readonly botId: string;
  /**
   * Fichiers candidats, du PLUS SPÉCIFIQUE au plus GÉNÉRAL
   * (`[{ portee: "bot" }, { portee: "instance" }]`). Le premier non vide gagne.
   */
  readonly fichiers: readonly CandidatFichierRegles[];
  readonly logger?: LoggerReglesBot;
}

/** Port de lecture des règles d'un bot, avec sa provenance courante. */
export interface PortReglesBot extends RulesPort {
  /** Provenance de la DERNIÈRE lecture (`aucune` ⇒ rien n'est injecté). */
  provenance(): ProvenanceRegles;
  /** Chemin du fichier de la DERNIÈRE lecture (`null` si aucun ne dit rien). */
  chemin(): string | null;
}

/**
 * Construit le port de LECTURE des règles d'un bot — celui que consomme
 * l'extension SDK (`src/pi/sdk/rules-extension.ts`).
 *
 * ⚠️ La lecture est FRAÎCHE à chaque appel (mise à jour à chaud) et ne lève
 * jamais. Le journal ne parle QUE lorsque la provenance change : des règles lues
 * à chaque tour ne doivent pas produire une ligne par tour.
 */
export function portReglesBot(options: OptionsReglesBot): PortReglesBot {
  const candidats = candidatsRegles(...options.fichiers);
  let derniere: ProvenanceRegles | null = null;
  let courant: ReglesBot = { texte: "", fichier: null, provenance: "aucune" };

  const signaler = (resolution: ReglesBot): void => {
    const logger = options.logger;
    if (logger === undefined) return;
    if (derniere === resolution.provenance) return;
    derniere = resolution.provenance;
    if (resolution.provenance === "aucune") {
      logger.info("rules.absentes", {
        bot: options.botId,
        fichiersLus: candidats.length,
        consequence:
          "aucun fichier de règles rempli : aucune règle commune n'est injectée dans le prompt",
        action:
          "rédigez les règles communes dans Configuration → « Règles communes » (elles priment sur la personnalité et sur les consignes du bot)",
      });
      return;
    }
    logger.info("rules.injectees", {
      bot: options.botId,
      portee: resolution.provenance,
      fichier: resolution.fichier?.chemin ?? "",
      chars: Array.from(resolution.texte).length,
    });
  };

  return {
    read(): RulesDocument {
      const documents = candidats.map((candidat) => ({
        candidat,
        document: lireDocumentRegles(candidat.chemin),
      }));
      const resolution = reglesEffectives(documents);
      courant = resolution;
      signaler(resolution);
      if (resolution.fichier === null) return DOCUMENT_VIDE;
      // Le document du candidat RETENU (comparaison par chemin : la résolution
      // rend le candidat lui-même, aucun contenu n'est réinventé).
      const cheminRetenu = resoudreChemin(resolution.fichier.chemin);
      const retenu = documents.find(
        (entree) => resoudreChemin(entree.candidat.chemin) === cheminRetenu,
      );
      return retenu?.document ?? DOCUMENT_VIDE;
    },
    provenance(): ProvenanceRegles {
      return courant.provenance;
    },
    chemin(): string | null {
      return courant.fichier?.chemin ?? null;
    },
  };
}

/**
 * Port de LECTURE des règles d'UN bot, à partir de SES DEUX chemins.
 *
 * ⚠️ C'est le constructeur PARTAGÉ : le host du bot de la PILE (`src/index.ts`) et
 * celui de chaque bot secondaire (`src/bots/hosts.ts`) l'appellent — donc la
 * résolution ne peut pas diverger entre eux (c'est précisément la divergence qui
 * faisait que les règles du bot de la pile n'étaient jamais injectées).
 */
export function portReglesDuBot(options: OptionsPortReglesDuBot): PortReglesBot {
  return portReglesBot({
    botId: options.botId,
    fichiers: candidatsRegles(
      { portee: "bot", chemin: options.cheminBot },
      options.cheminInstance !== undefined
        ? { portee: "instance", chemin: options.cheminInstance }
        : undefined,
    ),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  });
}

/** Chemins des DEUX candidats d'un bot (voir `portReglesDuBot`). */
export interface OptionsPortReglesDuBot {
  /** Bot concerné (journalisation, diagnostic). */
  readonly botId: string;
  /** Fichier DU BOT (`<state>/bots/<id>/rules.md`). */
  readonly cheminBot: string;
  /** Fichier HISTORIQUE de l'instance (`<state>/rules.md`), s'il existe. */
  readonly cheminInstance?: string;
  readonly logger?: LoggerReglesBot;
}
