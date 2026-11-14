/**
 * CONSIGNES DURABLES — STOCKAGE Markdown (`<state>/bots/<id>/consignes.md`).
 *
 * Ce que ce fichier VERROUILLE :
 *  ① fichier ABSENT ⇒ listes vides, jamais une erreur ;
 *  ② parsing ROBUSTE : seules les puces des sections `## Consignes` / `## Faits`
 *    comptent, tout le reste (titres libres, notes, sections inconnues) est
 *    ignoré sans casser ;
 *  ③ écriture ATOMIQUE, permissions 0600 ;
 *  ④ bornes 50 / 50 / 500 caractères, refus EXPLICITE (jamais une troncature) ;
 *  ⑤ déduplication (une consigne identique n'est pas ajoutée deux fois) ;
 *  ⑥ `oublier` refuse une correspondance AMBIGUË ;
 *  ⑦ le contenu humain (titres, notes hors listes) est CONSERVÉ à l'écriture ;
 *  ⑧ un port écrit dans SON fichier, jamais dans celui d'un autre bot.
 *
 * ⚠️ ÉCHOUE SUR LE CODE D'ORIGINE : `src/consignes/**` n'existe pas (l'import
 * échoue) et `YUKI_CONSIGNES_PATH` / `Env.consignesPath` non plus.
 */

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_CONSIGNES,
  MAX_ENTREE_CHARS,
  MAX_FAITS,
  ajouterEntree,
  analyserConsignes,
  portConsignes,
} from "../../src/consignes/index.js";

const racines: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-consignes-"));
  racines.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of racines.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function loggerFactice(): {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  lignes: { message: string; fields: Record<string, unknown> }[];
} {
  const lignes: { message: string; fields: Record<string, unknown> }[] = [];
  return {
    lignes,
    info: (message, fields = {}) => lignes.push({ message, fields }),
    warn: (message, fields = {}) => lignes.push({ message, fields }),
  };
}

const EXEMPLE = `# Consignes durables

## Consignes

- Ne refais plus jamais ça.

## Faits

- Mon NAS est à 10.0.0.5.
`;

describe("① fichier absent ou illisible ⇒ listes VIDES (jamais une erreur)", () => {
  it("un port sur un fichier inexistant rend deux listes vides", () => {
    const chemin = join(tempDir(), "bots", "yuki", "consignes.md");
    const port = portConsignes({ botId: "yuki", chemin });
    expect(port.lire()).toEqual({ consignes: [], faits: [] });
    expect(existsSync(chemin)).toBe(false);
  });

  it("un contenu vide ou du bruit ne produit aucune entrée", () => {
    expect(analyserConsignes("")).toEqual({ consignes: [], faits: [] });
    expect(analyserConsignes("du texte\nsans aucune puce\n")).toEqual({
      consignes: [],
      faits: [],
    });
  });
});

describe("② parsing ROBUSTE du Markdown", () => {
  it("lit les puces des deux sections, dans l'ordre du fichier", () => {
    expect(analyserConsignes(EXEMPLE)).toEqual({
      consignes: ["Ne refais plus jamais ça."],
      faits: ["Mon NAS est à 10.0.0.5."],
    });
  });

  it("ignore le préambule, les notes et les sections inconnues sans casser", () => {
    const texte = [
      "# Consignes durables",
      "",
      "> note de l'utilisateur : ce fichier m'appartient",
      "",
      "## Consignes",
      "",
      "- Réponds toujours en français.",
      "",
      "## Autre chose",
      "",
      "- ceci n'est PAS une consigne",
      "",
      "## Faits",
      "",
      "* le serveur est dans le garage",
      "- le NAS est à 10.0.0.5",
    ].join("\n");
    expect(analyserConsignes(texte)).toEqual({
      consignes: ["Réponds toujours en français."],
      faits: ["le serveur est dans le garage", "le NAS est à 10.0.0.5"],
    });
  });

  it("accepte les titres en minuscules (édition à la main)", () => {
    const texte = "## consignes\n\n- sois bref\n\n## faits\n\n- j'habite à Lyon\n";
    expect(analyserConsignes(texte)).toEqual({
      consignes: ["sois bref"],
      faits: ["j'habite à Lyon"],
    });
  });
});

describe("③ écriture : atomique, 0600, contenu humain préservé", () => {
  it("crée le fichier (et son dossier) en 0600", () => {
    const chemin = join(tempDir(), "bots", "yuki", "consignes.md");
    const port = portConsignes({ botId: "yuki", chemin });
    const resultat = port.ajouter("consigne", "Ne refais plus jamais ça.");
    expect(resultat.ok).toBe(true);
    expect(existsSync(chemin)).toBe(true);
    const mode = statSync(chemin).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("CONSERVE les titres, notes et sections inconnues du fichier humain", () => {
    const chemin = join(tempDir(), "consignes.md");
    const humain = [
      "# Mes consignes",
      "",
      "> je relis ce fichier à la main",
      "",
      "## Consignes",
      "",
      "- Réponds en français.",
      "",
      "## Divers",
      "",
      "- garde cette ligne",
    ].join("\n");
    writeFileSync(chemin, humain, "utf8");
    const port = portConsignes({ botId: "yuki", chemin });
    const resultat = port.ajouter("consigne", "Ne refais plus jamais ça.");
    expect(resultat.ok).toBe(true);
    const apres = readFileSync(chemin, "utf8");
    expect(apres).toContain("> je relis ce fichier à la main");
    expect(apres).toContain("## Divers");
    expect(apres).toContain("garde cette ligne");
    expect(apres).toContain("- Réponds en français.");
    expect(apres).toContain("- Ne refais plus jamais ça.");
    // Aucun fichier temporaire ne traîne après l'écriture.
    expect(readdirTemporaires(chemin)).toEqual([]);
  });

  it("ajoute la section manquante sans toucher aux autres", () => {
    const chemin = join(tempDir(), "consignes.md");
    writeFileSync(chemin, "## Consignes\n\n- sois bref\n", "utf8");
    const port = portConsignes({ botId: "yuki", chemin });
    expect(port.ajouter("fait", "le NAS est à 10.0.0.5").ok).toBe(true);
    expect(analyserConsignes(readFileSync(chemin, "utf8"))).toEqual({
      consignes: ["sois bref"],
      faits: ["le NAS est à 10.0.0.5"],
    });
  });
});

describe("④ bornes : refus EXPLICITE au-delà", () => {
  it(`la ${MAX_CONSIGNES + 1}ᵉ consigne est REFUSÉE, avec un message actionnable`, () => {
    const chemin = join(tempDir(), "consignes.md");
    const port = portConsignes({ botId: "yuki", chemin });
    for (let index = 0; index < MAX_CONSIGNES; index += 1) {
      expect(port.ajouter("consigne", `consigne ${index}`).ok).toBe(true);
    }
    const refus = port.ajouter("consigne", "consigne de trop");
    expect(refus.ok).toBe(false);
    if (refus.ok) throw new Error("le refus était attendu");
    expect(refus.refus).toBe("limite_consignes_atteinte");
    expect(refus.message).toContain("Trop de consignes");
    expect(refus.message).toContain(`${MAX_CONSIGNES}`);
    expect(refus.message.toLowerCase()).toContain("supprimez");
    // Aucune troncature : la liste enregistrée n'a pas bougé.
    expect(port.lire().consignes).toHaveLength(MAX_CONSIGNES);
  });

  it(`la ${MAX_FAITS + 1}ᵉ fait est REFUSÉ, avec un message actionnable`, () => {
    const chemin = join(tempDir(), "consignes.md");
    const port = portConsignes({ botId: "yuki", chemin });
    for (let index = 0; index < MAX_FAITS; index += 1) {
      expect(port.ajouter("fait", `fait ${index}`).ok).toBe(true);
    }
    const refus = port.ajouter("fait", "fait de trop");
    expect(refus.ok).toBe(false);
    if (refus.ok) throw new Error("le refus était attendu");
    expect(refus.refus).toBe("limite_faits_atteinte");
    expect(refus.message).toContain("Trop de faits");
  });

  it(`une entrée de plus de ${MAX_ENTREE_CHARS} caractères est REFUSÉE`, () => {
    const chemin = join(tempDir(), "consignes.md");
    const port = portConsignes({ botId: "yuki", chemin });
    const refus = port.ajouter("consigne", "x".repeat(MAX_ENTREE_CHARS + 1));
    expect(refus.ok).toBe(false);
    if (refus.ok) throw new Error("le refus était attendu");
    expect(refus.refus).toBe("entree_trop_longue");
    expect(refus.message).toContain(`${MAX_ENTREE_CHARS}`);
  });

  it("une entrée vide est refusée (aucun texte inventé)", () => {
    const resultat = ajouterEntree({ consignes: [], faits: [] }, "consigne", "   ");
    expect(resultat.ok).toBe(false);
    if (resultat.ok) throw new Error("le refus était attendu");
    expect(resultat.refus).toBe("texte_vide");
  });
});

describe("⑤ déduplication", () => {
  it("une consigne identique (casse/espaces) n'est pas ajoutée deux fois", () => {
    const chemin = join(tempDir(), "consignes.md");
    const port = portConsignes({ botId: "yuki", chemin });
    expect(port.ajouter("consigne", "Ne refais plus jamais ça.").ok).toBe(true);
    const doublon = port.ajouter("consigne", "  ne refais   plus jamais ça.  ");
    expect(doublon.ok).toBe(true);
    if (!doublon.ok) throw new Error("un doublon n'est pas une erreur");
    expect(doublon.dejaPresent).toBe(true);
    expect(port.lire().consignes).toHaveLength(1);
  });
});

describe("⑥ oublier : refus si la correspondance est AMBIGUË", () => {
  it("deux entrées qui correspondent ⇒ refus explicite, rien n'est supprimé", () => {
    const chemin = join(tempDir(), "consignes.md");
    const port = portConsignes({ botId: "yuki", chemin });
    port.ajouter("consigne", "Réponds en anglais");
    port.ajouter("consigne", "Réponds en anglais le matin");
    const refus = port.retirer("consigne", "anglais");
    expect(refus.ok).toBe(false);
    if (refus.ok) throw new Error("le refus était attendu");
    expect(refus.refus).toBe("correspondance_ambigue");
    expect(refus.message).toContain("2 entrées");
    expect(port.lire().consignes).toHaveLength(2);
  });

  it("une correspondance UNIQUE supprime exactement une entrée", () => {
    const chemin = join(tempDir(), "consignes.md");
    const port = portConsignes({ botId: "yuki", chemin });
    port.ajouter("consigne", "Réponds en anglais");
    port.ajouter("consigne", "Réponds en français");
    const resultat = port.retirer("consigne", "Réponds en anglais");
    expect(resultat.ok).toBe(true);
    if (!resultat.ok) throw new Error("le retrait était attendu");
    expect(resultat.retiree).toBe("Réponds en anglais");
    expect(port.lire().consignes).toEqual(["Réponds en français"]);
  });

  it("un texte absent ⇒ refus `correspondance_introuvable`", () => {
    const chemin = join(tempDir(), "consignes.md");
    const port = portConsignes({ botId: "yuki", chemin });
    const refus = port.retirer("consigne", "jamais enregistrée");
    expect(refus.ok).toBe(false);
    if (refus.ok) throw new Error("le refus était attendu");
    expect(refus.refus).toBe("correspondance_introuvable");
  });
});

describe("⑦/⑧ un port par bot : il écrit dans SON fichier", () => {
  it("deux ports (deux chemins) ne partagent RIEN", () => {
    const racine = tempDir();
    const cheminYuki = join(racine, "bots", "yuki", "consignes.md");
    const cheminKohai = join(racine, "bots", "kohai", "consignes.md");
    const yuki = portConsignes({ botId: "yuki", chemin: cheminYuki });
    const kohai = portConsignes({ botId: "kohai", chemin: cheminKohai });
    yuki.ajouter("consigne", "consigne de yuki");
    expect(kohai.lire()).toEqual({ consignes: [], faits: [] });
    expect(readFileSync(cheminYuki, "utf8")).toContain("consigne de yuki");
    expect(existsSync(cheminKohai)).toBe(false);
  });

  it("journalise l'écriture SANS le texte intégral (bot, nature, taille)", () => {
    const chemin = join(tempDir(), "consignes.md");
    const logger = loggerFactice();
    const port = portConsignes({ botId: "yuki", chemin, logger });
    port.ajouter("consigne", "un secret très personnel ne doit pas finir au journal");
    const ecritures = logger.lignes.filter((ligne) => ligne.message === "consignes.ecriture");
    expect(ecritures).toHaveLength(1);
    expect(ecritures[0].fields).toMatchObject({ bot: "yuki", nature: "consigne", action: "ajout" });
    expect(JSON.stringify(ecritures[0])).not.toContain("un secret très personnel");
  });
});

/** Fichiers temporaires laissés par l'écriture atomique (doit être vide). */
function readdirTemporaires(chemin: string): string[] {
  return readdirSync(join(chemin, "..")).filter((nom) => nom.endsWith(".tmp"));
}
