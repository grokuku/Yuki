/**
 * ÉVALUATEUR CRON — maison, **5 champs**, **zéro dépendance**.
 *
 * Format : `minute heure jour-du-mois mois jour-de-semaine`.
 *
 * Supporté (le message d'erreur le DIT toujours) :
 *  - `*` (joker), `a`, `a-b`, `a-b/n`, `*`/`n`, et les listes `a,b,c` ;
 *  - bornes : minute 0-59, heure 0-23, jour-du-mois 1-31, mois 1-12,
 *    jour-de-semaine 0-7 (0 et 7 = dimanche).
 *
 * REFUSÉ explicitement (aucun repli silencieux) : `L`, `#`, `?`, les raccourcis
 * `@…` (`@reboot`, `@daily`…), les noms de mois/jours (`JAN`, `MON`), les pas
 * seuls (`5/10`), les listes vides, les plages inversées.
 *
 * ## ⚠️ Deux pièges verrouillés ici
 *
 *  1. **Jour-du-mois ET jour-de-semaine ensemble ⇒ OR** (sémantique cron
 *     standard) : `0 0 1 * 1` tire le 1er du mois **et** chaque lundi. Dès que
 *     l'un des deux champs est un joker (`*` ou `*​/n`), c'est un ET.
 *
 *  2. **Fuseau PAR DÉCLENCHEUR** (`Europe/Paris` par défaut), évalué via `Intl`,
 *     **jamais le fuseau du process** (en conteneur c'est UTC : une expression
 *     `0 9 * * *` tirerait à 9 h UTC, soit 10 h ou 11 h à Paris).
 *
 * ## ⚠️ Changement d'heure (DST) : ni saut ni doublon
 *
 * On n'itère PAS sur des minutes UTC (ce qui doublerait les heures répétées du
 * retour à l'heure d'hiver). On itère sur des **minutes locales** :
 *  - une heure locale SUPPRIMÉE (passage à l'heure d'été) n'a aucun instant :
 *    elle est sautée, comme le fait cron (l'expression ne peut pas tirer une
 *    heure qui n'existe pas) ;
 *  - une heure locale RÉPÉTÉE (retour à l'heure d'hiver) est traitée UNE fois :
 *    `0 2 * * *` ne tire pas deux fois à 02:00 locale.
 *
 * Module PUR (aucun I/O, aucun SDK) : partagé par le store (validation), le
 * balayeur (`scheduler.ts`), l'API (aperçu du prochain passage) et l'UI.
 */

/** Nombre de champs attendus. */
export const CRON_FIELD_COUNT = 5;

/** ⚠️ Borne de recherche du prochain passage (années). */
export const CRON_MAX_LOOKAHEAD_YEARS = 5;

/** Codes d'erreur (l'API les renvoie tels quels, l'UI les affiche). */
export type CronErrorCode =
  | "expression_absente"
  | "nombre_de_champs"
  | "syntaxe_non_supportee"
  | "champ_vide"
  | "valeur_non_numerique"
  | "valeur_hors_bornes"
  | "plage_inversee"
  | "pas_invalide"
  | "fuseau_inconnu"
  | "aucune_occurrence";

/** Erreur d'expression cron — message TOUJOURS en français et actionnable. */
export class CronError extends Error {
  override readonly name = "CronError";
  constructor(
    readonly code: CronErrorCode,
    message: string,
    /** Champ fautif (`minute`, `heure`…) quand il est connu. */
    readonly champ?: string,
  ) {
    super(message);
  }
}

/** Rappel de syntaxe ajouté à CHAQUE refus : l'utilisateur sait quoi écrire. */
export const CRON_SYNTAX_HELP =
  "Syntaxe supportée : 5 champs « minute heure jour-du-mois mois jour-de-semaine », " +
  "chacun acceptant « * », « a », « a-b », « a-b/n », « * »/« n » ou une liste « a,b,c » " +
  "(minute 0-59, heure 0-23, jour-du-mois 1-31, mois 1-12, jour-de-semaine 0-7 avec " +
  "0 et 7 = dimanche).";

interface FieldBounds {
  readonly nom: string;
  readonly min: number;
  readonly max: number;
}

const BORNES: readonly FieldBounds[] = [
  { nom: "minute", min: 0, max: 59 },
  { nom: "heure", min: 0, max: 23 },
  { nom: "jour-du-mois", min: 1, max: 31 },
  { nom: "mois", min: 1, max: 12 },
  { nom: "jour-de-semaine", min: 0, max: 7 },
];

/** Un champ analysé : ensemble de valeurs + « était-ce un joker ? ». */
export interface CronField {
  /** Texte d'origine du champ (normalisé : sans espaces superflus). */
  readonly texte: string;
  /** Valeurs acceptées (triées, sans doublon). */
  readonly valeurs: readonly number[];
  /** Ensemble prêt pour les tests d'appartenance. */
  readonly ensemble: ReadonlySet<number>;
  /**
   * ⚠️ Vrai si le champ COMMENCE par `*` (`*` ou `*​/n`) : c'est la définition
   * cron de « non restreint », qui décide du OR jour-du-mois/jour-de-semaine.
   */
  readonly joker: boolean;
}

/** Expression cron analysée. */
export interface CronExpression {
  /** Texte source normalisé (`*\/5 * * * *`). */
  readonly source: string;
  readonly minute: CronField;
  readonly heure: CronField;
  readonly jourDuMois: CronField;
  readonly mois: CronField;
  readonly jourDeSemaine: CronField;
}

/** Refus explicites : motif reconnu ⇒ message qui dit ce qui n'est PAS supporté. */
const REFUS: ReadonlyArray<{ motif: RegExp; message: string }> = [
  {
    motif: /(^|[,\s])L(?![A-Za-z])/,
    message:
      "« L » (dernier jour du mois) n'est pas supporté : indiquez un jour précis " +
      "(ex. « 28 ») ou une plage.",
  },
  {
    motif: /#/,
    message:
      "« # » (nième jour de semaine du mois, ex. « 5#3 ») n'est pas supporté : " +
      "utilisez le jour-de-semaine seul (ex. « 5 »).",
  },
  {
    motif: /\?/,
    message:
      "« ? » (joker de Quartz) n'est pas supporté : utilisez « * ».",
  },
  {
    motif: /^\s*@/,
    message:
      "les raccourcis « @… » (ex. « @reboot », « @daily ») ne sont pas supportés : " +
      "écrivez les 5 champs (ex. « 0 9 * * * »).",
  },
  {
    motif: /[A-Za-z]/,
    message:
      "les noms de mois ou de jours (ex. « JAN », « MON ») ne sont pas supportés : " +
      "utilisez des nombres (1-12, 0-7).",
  },
];

function champErreur(
  code: CronErrorCode,
  message: string,
  champ?: string,
): CronError {
  return new CronError(code, `${message} ${CRON_SYNTAX_HELP}`, champ);
}

/**
 * Analyse UN champ. ⚠️ Tout ce qui n'est pas explicitement supporté est REFUSÉ
 * (aucune interprétation devinée).
 */
function parseField(texte: string, bornes: FieldBounds): CronField {
  const brut = texte.trim();
  if (brut === "") {
    throw champErreur("champ_vide", `Champ « ${bornes.nom} » vide.`, bornes.nom);
  }
  const joker = brut.startsWith("*");
  const valeurs = new Set<number>();

  for (const item of brut.split(",")) {
    const morceau = item.trim();
    if (morceau === "") {
      throw champErreur(
        "champ_vide",
        `Champ « ${bornes.nom} » : élément vide dans la liste « ${brut} ».`,
        bornes.nom,
      );
    }
    // Découpage `base/pas` — un pas seul (« 5/10 ») n'est pas supporté.
    const [base, pas, ...reste] = morceau.split("/");
    if (reste.length > 0 || (pas !== undefined && pas.trim() === "")) {
      throw champErreur(
        "pas_invalide",
        `Champ « ${bornes.nom} » : pas invalide dans « ${morceau} ».`,
        bornes.nom,
      );
    }
    let pasValeur = 1;
    if (pas !== undefined) {
      if (!/^\d+$/.test(pas.trim())) {
        throw champErreur(
          "pas_invalide",
          `Champ « ${bornes.nom} » : le pas de « ${morceau} » doit être un entier positif.`,
          bornes.nom,
        );
      }
      pasValeur = Number.parseInt(pas.trim(), 10);
      if (pasValeur <= 0) {
        throw champErreur(
          "pas_invalide",
          `Champ « ${bornes.nom} » : le pas de « ${morceau} » doit être supérieur à 0.`,
          bornes.nom,
        );
      }
    }
    const baseTexte = base.trim();
    let debut: number;
    let fin: number;
    if (baseTexte === "*") {
      debut = bornes.min;
      fin = bornes.max;
    } else if (baseTexte.includes("-")) {
      const [a, b, ...trop] = baseTexte.split("-");
      if (trop.length > 0 || a.trim() === "" || b.trim() === "") {
        throw champErreur(
          "valeur_non_numerique",
          `Champ « ${bornes.nom} » : plage incomplète dans « ${morceau} ».`,
          bornes.nom,
        );
      }
      debut = nombreDe(a, bornes);
      fin = nombreDe(b, bornes);
      if (fin < debut) {
        throw champErreur(
          "plage_inversee",
          `Champ « ${bornes.nom} » : plage inversée « ${baseTexte} » (la fin précède le début).`,
          bornes.nom,
        );
      }
    } else {
      debut = nombreDe(baseTexte, bornes);
      // Un pas sans plage n'a pas de sens : « 5/10 » n'est pas standard.
      if (pas !== undefined) {
        throw champErreur(
          "pas_invalide",
          `Champ « ${bornes.nom} » : « ${morceau} » n'a pas de plage ; écrivez ` +
            `« ${baseTexte}-${bornes.max}/${pasValeur} » ou « */${pasValeur} ».`,
          bornes.nom,
        );
      }
      fin = debut;
    }
    for (let valeur = debut; valeur <= fin; valeur += pasValeur) {
      // 7 = dimanche, comme 0 : on ramène dans l'ensemble canonique.
      valeurs.add(normaliserValeur(valeur, bornes));
    }
    // Un pas plus grand que la plage ne doit jamais produire un ensemble VIDE.
    if (valeurs.size === 0) {
      throw champErreur(
        "pas_invalide",
        `Champ « ${bornes.nom} » : « ${morceau} » ne sélectionne aucune valeur.`,
        bornes.nom,
      );
    }
  }

  const triees = [...valeurs].sort((a, b) => a - b);
  return { texte: brut, valeurs: triees, ensemble: new Set(triees), joker };
}

function nombreDe(texte: string, bornes: FieldBounds): number {
  const brut = texte.trim();
  if (!/^\d+$/.test(brut)) {
    throw champErreur(
      "valeur_non_numerique",
      `Champ « ${bornes.nom} » : « ${brut} » n'est pas un nombre.`,
      bornes.nom,
    );
  }
  const valeur = Number.parseInt(brut, 10);
  if (valeur < bornes.min || valeur > bornes.max) {
    throw champErreur(
      "valeur_hors_bornes",
      `Champ « ${bornes.nom} » : ${valeur} est hors bornes (${bornes.min}-${bornes.max}).`,
      bornes.nom,
    );
  }
  return valeur;
}

/** 7 (dimanche selon cron) devient 0 : un seul ensemble canonique. */
function normaliserValeur(valeur: number, bornes: FieldBounds): number {
  if (bornes.nom === "jour-de-semaine" && valeur === 7) return 0;
  return valeur;
}

/**
 * Analyse une expression cron. ⚠️ Lève `CronError` avec un message qui dit ce
 * qui EST supporté (jamais un « invalide » sec).
 */
export function parseCron(expression: unknown): CronExpression {
  if (typeof expression !== "string") {
    throw new CronError(
      "expression_absente",
      `Expression cron requise (texte de 5 champs). ${CRON_SYNTAX_HELP}`,
    );
  }
  const normalisee = expression.trim().replace(/\s+/g, " ");
  if (normalisee === "") {
    throw new CronError(
      "expression_absente",
      `Expression cron vide. ${CRON_SYNTAX_HELP}`,
    );
  }
  for (const refus of REFUS) {
    if (refus.motif.test(normalisee)) {
      throw new CronError(
        "syntaxe_non_supportee",
        `Expression cron invalide : ${refus.message} ${CRON_SYNTAX_HELP}`,
      );
    }
  }
  const champs = normalisee.split(" ");
  if (champs.length !== CRON_FIELD_COUNT) {
    throw new CronError(
      "nombre_de_champs",
      `Expression cron invalide : ${champs.length} champ(s) au lieu de 5 ` +
        `(« ${normalisee} »). ${CRON_SYNTAX_HELP}`,
    );
  }
  return {
    source: normalisee,
    minute: parseField(champs[0], BORNES[0]),
    heure: parseField(champs[1], BORNES[1]),
    jourDuMois: parseField(champs[2], BORNES[2]),
    mois: parseField(champs[3], BORNES[3]),
    jourDeSemaine: parseField(champs[4], BORNES[4]),
  };
}

/** Vrai si l'expression est analysable (aucune exception levée). */
export function isCronExpression(value: unknown): boolean {
  try {
    parseCron(value);
    return true;
  } catch {
    return false;
  }
}

// ── Fuseaux horaires ────────────────────────────────────────────────────────

const formateurs = new Map<string, Intl.DateTimeFormat>();

function formateurDe(fuseau: string): Intl.DateTimeFormat {
  const cache = formateurs.get(fuseau);
  if (cache) return cache;
  // `hourCycle: "h23"` évite le « 24:00 » de certaines locales (piège classique).
  const formateur = new Intl.DateTimeFormat("en-US", {
    timeZone: fuseau,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  formateurs.set(fuseau, formateur);
  return formateur;
}

/**
 * Valide un fuseau horaire (nom IANA). ⚠️ Refus explicite : un fuseau inconnu
 * ferait silencieusement retomber `Intl` sur le fuseau du process.
 */
export function validateFuseau(fuseau: unknown, defaut = "Europe/Paris"): string {
  const valeur = typeof fuseau === "string" ? fuseau.trim() : "";
  const retenu = valeur === "" ? defaut : valeur;
  try {
    formateurDe(retenu).format(new Date(0));
  } catch {
    throw new CronError(
      "fuseau_inconnu",
      `Fuseau horaire inconnu : « ${retenu} ». Indiquez un nom IANA ` +
        "(ex. « Europe/Paris », « Europe/Brussels », « UTC »).",
    );
  }
  return retenu;
}

/** Décomposition d'un instant dans un fuseau (heure LOCALE). */
export interface PartiesLocales {
  annee: number;
  mois: number;
  jour: number;
  heure: number;
  minute: number;
  seconde: number;
}

/** Décompose un instant (ms) en heure locale du fuseau donné. */
export function partiesLocales(instant: number, fuseau: string): PartiesLocales {
  const parts = formateurDe(fuseau).formatToParts(new Date(instant));
  const valeurs = new Map<string, number>();
  for (const part of parts) {
    if (part.type === "literal" || part.type === "dayPeriod") continue;
    const nombre = Number.parseInt(part.value, 10);
    if (Number.isFinite(nombre)) valeurs.set(part.type, nombre);
  }
  return {
    annee: valeurs.get("year") ?? 1970,
    mois: valeurs.get("month") ?? 1,
    jour: valeurs.get("day") ?? 1,
    heure: valeurs.get("hour") ?? 0,
    minute: valeurs.get("minute") ?? 0,
    seconde: valeurs.get("second") ?? 0,
  };
}

/** Décalage (ms) du fuseau à cet instant : heure locale − UTC. */
function decalageMs(instant: number, fuseau: string): number {
  const p = partiesLocales(instant, fuseau);
  const commeUtc = Date.UTC(p.annee, p.mois - 1, p.jour, p.heure, p.minute, p.seconde);
  return commeUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * Instants (ms) correspondant à une heure LOCALE donnée.
 *
 *  - 0 élément : l'heure n'existe pas ce jour-là (passage à l'heure d'été) ;
 *  - 2 éléments : l'heure est répétée (retour à l'heure d'hiver), du plus tôt
 *    au plus tard.
 */
export function instantsDeLHeureLocale(
  annee: number,
  mois: number,
  jour: number,
  heure: number,
  minute: number,
  fuseau: string,
): number[] {
  const demande = Date.UTC(annee, mois - 1, jour, heure, minute, 0);
  // Le décalage peut changer dans la fenêtre : on sonde autour de l'heure visée.
  const decalages = new Set<number>();
  for (const deltaHeures of [-3, -2, -1, 0, 1, 2, 3]) {
    decalages.add(decalageMs(demande + deltaHeures * 3_600_000, fuseau));
  }
  const instants = new Set<number>();
  for (const decalage of decalages) {
    const candidat = demande - decalage;
    const p = partiesLocales(candidat, fuseau);
    if (
      p.annee === annee &&
      p.mois === mois &&
      p.jour === jour &&
      p.heure === heure &&
      p.minute === minute
    ) {
      instants.add(candidat);
    }
  }
  return [...instants].sort((a, b) => a - b);
}

/** Jour de la semaine (0 = dimanche) d'une date CALENDAIRE locale. */
function jourSemaineDe(annee: number, mois: number, jour: number): number {
  return new Date(Date.UTC(annee, mois - 1, jour)).getUTCDay();
}

/**
 * ⚠️ PIÈGE CLASSIQUE : jour-du-mois ET jour-de-semaine ensemble ⇒ **OR**.
 * Dès que l'un des deux champs est un joker, c'est un ET.
 */
export function jourCorrespond(
  expression: CronExpression,
  annee: number,
  mois: number,
  jour: number,
): boolean {
  const domOk = expression.jourDuMois.ensemble.has(jour);
  const dowOk = expression.jourDeSemaine.ensemble.has(jourSemaineDe(annee, mois, jour));
  const lesDeuxRestreints = !expression.jourDuMois.joker && !expression.jourDeSemaine.joker;
  return lesDeuxRestreints ? domOk || dowOk : domOk && dowOk;
}

/** Vrai si l'instant correspond à l'expression (heure locale du fuseau). */
export function correspond(expression: CronExpression, instant: number, fuseau: string): boolean {
  // Une occurrence cron tombe sur une MINUTE PLEINE : une seconde non nulle (ou
  // des millisecondes) ne correspond pas, même à la bonne minute.
  if (Math.floor(instant / 60_000) * 60_000 !== instant) return false;
  const p = partiesLocales(instant, fuseau);
  return (
    expression.minute.ensemble.has(p.minute) &&
    expression.heure.ensemble.has(p.heure) &&
    expression.mois.ensemble.has(p.mois) &&
    jourCorrespond(expression, p.annee, p.mois, p.jour)
  );
}

export interface ProchainPassageOptions {
  /** Borne de recherche en années (défaut `CRON_MAX_LOOKAHEAD_YEARS`). */
  bornesAnnees?: number;
}

/**
 * Prochain instant qui correspond à l'expression, **strictement après** `apres`.
 *
 * ⚠️ Échec EXPLICITE (`CronError` `aucune_occurrence`) quand aucune occurrence
 * n'existe dans la borne : `0 0 31 2 *` (31 février) n'existe jamais.
 */
export function prochainPassage(
  expression: CronExpression,
  apres: number,
  fuseau: string,
  options: ProchainPassageOptions = {},
): number {
  const bornesAnnees = Math.max(1, Math.trunc(options.bornesAnnees ?? CRON_MAX_LOOKAHEAD_YEARS));
  const depart = partiesLocales(apres, fuseau);
  // On cherche STRICTEMENT après : la minute locale de `apres` est déjà passée.
  const premiereMinute = depart.minute + 1;
  const wallApres = Date.UTC(
    depart.annee,
    depart.mois - 1,
    depart.jour,
    depart.heure,
    premiereMinute,
  );
  const heures = expression.heure.valeurs;
  const minutes = expression.minute.valeurs;
  const limite = wallApres + bornesAnnees * 366 * 86_400_000;

  for (let curseur = jourLocalDe(wallApres); curseur <= limite; curseur += 86_400_000) {
    const d = new Date(curseur);
    const annee = d.getUTCFullYear();
    const mois = d.getUTCMonth() + 1;
    const jour = d.getUTCDate();
    if (!expression.mois.ensemble.has(mois)) continue;
    if (!jourCorrespond(expression, annee, mois, jour)) continue;
    for (const heure of heures) {
      for (const minute of minutes) {
        const wall = Date.UTC(annee, mois - 1, jour, heure, minute);
        if (wall < wallApres) continue;
        for (const instant of instantsDeLHeureLocale(annee, mois, jour, heure, minute, fuseau)) {
          if (instant > apres) return instant;
        }
      }
    }
  }
  throw new CronError(
    "aucune_occurrence",
    `Aucune occurrence dans les ${bornesAnnees} prochaines années pour ` +
      `« ${expression.source} » (ex. « 0 0 31 2 * » n'existe jamais : le 31 février). ` +
      "Vérifiez le jour-du-mois et le mois.",
  );
}

/** Minuit UTC du JOUR LOCAL contenant `wall` (curseur de recherche). */
function jourLocalDe(wall: number): number {
  const d = new Date(wall);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Résultat d'un calcul d'aperçu (jamais d'exception : l'API/UI l'affiche). */
export interface ApercuResultat {
  /** Fuseau retenu (validé). */
  fuseau?: string;
  /** Expression normalisée, quand elle est analysable. */
  expression?: string;
  /** Prochains passages (ISO, ordre chronologique). */
  passages: string[];
  /** Raison exacte de l'absence de passage (français). */
  raison?: string;
  /** Code d'erreur (`CronError.code`) le cas échéant. */
  code?: CronErrorCode;
}

/**
 * Aperçu lisible du prochain passage — **le garde-fou de l'UI** : une expression
 * fausse se voit tout de suite, avec la raison.
 */
export function apercuCron(
  expression: unknown,
  fuseau: unknown,
  depuis: number,
  combien = 3,
): ApercuResultat {
  const nombre = Math.min(10, Math.max(1, Math.trunc(combien)));
  let fuseauValide: string;
  try {
    fuseauValide = validateFuseau(fuseau);
  } catch (error) {
    const cron = error as CronError;
    return { passages: [], raison: cron.message, code: cron.code };
  }
  let analysée: CronExpression;
  try {
    analysée = parseCron(expression);
  } catch (error) {
    const cron = error as CronError;
    return { fuseau: fuseauValide, passages: [], raison: cron.message, code: cron.code };
  }
  const passages: string[] = [];
  let curseur = depuis;
  try {
    for (let index = 0; index < nombre; index += 1) {
      const suivant = prochainPassage(analysée, curseur, fuseauValide);
      passages.push(new Date(suivant).toISOString());
      curseur = suivant;
    }
  } catch (error) {
    const cron = error as CronError;
    return {
      fuseau: fuseauValide,
      expression: analysée.source,
      passages,
      raison: cron.message,
      code: cron.code,
    };
  }
  return { fuseau: fuseauValide, expression: analysée.source, passages };
}

/**
 * Clé du JOUR LOCAL (`AAAA-MM-JJ`) — sert au compteur `maxToursParJour` : il doit
 * basculer à minuit LOCAL du déclencheur, pas à minuit UTC.
 */
export function jourLocal(instant: number, fuseau: string): string {
  const p = partiesLocales(instant, fuseau);
  return `${String(p.annee).padStart(4, "0")}-${String(p.mois).padStart(2, "0")}-${String(
    p.jour,
  ).padStart(2, "0")}`;
}
