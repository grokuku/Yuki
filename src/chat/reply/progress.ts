/**
 * PROGRESSION PUBLIÉE d'un run distant — module **PUR** (aucune E/S, aucun SDK).
 *
 * ⚠️ CE QUE CE MODULE FERME : la sortie d'un run distant n'était qu'UN SEUL texte, à
 * la fin (`src/chat/reply/generate.ts`), et l'écrivain n'écoutait que `text_delta`/
 * `message_end` : la personne qui écrivait dans le canal voyait donc le silence
 * complet pendant la génération d'une image, puis un message. Aucun accusé, aucune
 * image intermédiaire, aucune ligne d'échec.
 *
 * ⚠️ QUI ÉCRIT L'ACCUSÉ : LE MODÈLE, comme en mode local. Le premier texte du tour,
 * quand il est `ackShapedText` (`src/pi/ack.ts`, une ligne, ≤ `ACK_MAX_CHARS`) et qu'une
 * action longue démarre, part TEL QUEL. La table `ackFallbackText` ne parle qu'en REPLI,
 * sur un silence RÉEL du modèle — et en ROTATION par conversation, jamais la même phrase
 * (c'était le reproche : un accusé de table fixe est « totalement inhumain »).
 *
 * ⚠️ CE MODULE NE FAIT AUCUNE E/S : il décide *quoi* publier et *quand*, jamais
 * *comment*. L'appelant fournit `publier`, qui parle à la plateforme (et qui ancre
 * déjà le message au bon fil). C'est ce qui rend les règles ci-dessous testables
 * sans réseau, sans modèle et sans horloge réelle.
 *
 * TROIS BORNES ANTI-SPAM, et rien de plus :
 *  1. **un seul accusé par run** (`ack`), jamais un par outil ;
 *  2. **trois résultats par run** (`PROGRESS_MAX_RESULTS`) — au-delà, la ligne est
 *     OMISE et la réponse finale le dit (`resume()`), plutôt que de noyer le canal ;
 *  3. **un seul rappel de longueur** par run (`PROGRESS_LONG_TOOL_MS`).
 *
 * ⚠️ Un FICHIER produit (image générée) n'est jamais omis par le plafond : c'est le
 * livrable lui-même, le jeter reviendrait à perdre la réponse à la demande. Il est
 * publié UNE fois (dédupliqué) et il compte dans le plafond des lignes de texte.
 *
 * ⚠️ ORDRE ET EXCLUSIVITÉ : les publications sont SÉRIALISÉES par une file vidée
 * UNE PAR UNE. L'ordre des événements (accusé → image → réponse) est donc l'ordre
 * d'arrivée sur la plateforme, et JAMAIS deux `send` ne sont en vol en même temps
 * (défaut mesuré le 2026-11-02 : « deux messages qui arrivent en même temps »).
 *
 * ⚠️ UNE PRIORITÉ, PAS UNE EXCEPTION : l'accusé double la FILE d'attente (`prioritaire`)
 * parce qu'il n'a de valeur que s'il arrive pendant l'action — derrière une image déjà
 * en attente, il perdrait son seul intérêt. Il ne double JAMAIS l'envoi en cours :
 * l'exclusivité est absolue.
 */

import {
  ACK_MAX_CHARS,
  ACK_RULE_MAX_CHARS,
  ackFallbackText,
  ackShapedText,
  isAckTool,
} from "../../pi/ack.js";

/**
 * Forme COMPARABLE d'un texte : minuscules, sans accents ni ponctuation.
 *
 * ⚠️ Sert UNIQUEMENT à reconnaître l'accusé déjà publié (« C'est parti ! » vs
 * « c'est parti. »). Elle ne sert jamais à réécrire ce qui est publié.
 */
function normaliserPourAccuse(texte: string): string {
  return texte
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

/**
 * Verbe d'ENGAGEMENT en tête de ligne, sous forme COMPARABLE (minuscules, sans accents).
 *
 * ⚠️ C'est la seule chose qui distingue une phrase d'attente (« Je prends ça en
 * charge. ») d'une ligne de CONTENU (« C'est en route sur la PI5 : apt update… »).
 * Une ligne de contenu n'est JAMAIS retirée — voir `ressembleAUnAccuse`.
 */
const DEBUT_ACCUSE =
  /^(?:ok|d accord|tres bien|compris|bien recu|deux secondes|une seconde|un instant|un moment|c est parti|c est en route|ca arrive|ca vient|j y vais|on y va|je|j |on s en occupe)\b/u;

/**
 * Cette ligne est-elle une phrase d'ATTENTE (donc déjà dite, ou redondante) ?
 *
 * ⚠️ Trois garde-fous pour ne JAMAIS manger du contenu légitime :
 *  1. la ligne doit tenir sur une seule ligne et dans `ACK_RULE_MAX_CHARS` (la longueur
 *     CONSEILLÉE d'un accusé, plus stricte que la borne de reconnaissance) ;
 *  2. elle ne doit rien ANNONCER de précis : ni deux-points (une énumération), ni
 *     chiffre, ni identifiant entre accents graves — dans ce cas c'est du contenu ;
 *  3. elle doit commencer par un verbe d'engagement (`DEBUT_ACCUSE`).
 *
 * Un `undefined` de `ackShapedText` (texte long ou multiligne) suffit à écarter la ligne.
 */
function ressembleAUnAccuse(ligne: string): boolean {
  const texte = ligne.trim();
  if (ackShapedText(texte) === undefined) return false;
  if ([...texte].length > ACK_RULE_MAX_CHARS) return false;
  if (texte.includes(":") || texte.includes("`") || /[0-9]/u.test(texte)) return false;
  const comparable = normaliserPourAccuse(texte);
  if (comparable === "") return false;
  return DEBUT_ACCUSE.test(`${comparable} `);
}

/**
 * Retire `ack` du DÉBUT de `texte` quand il en est le préfixe (casse et ponctuation
 * près), et rend le RESTE — `undefined` quand `texte` ne commence pas par l'accusé.
 *
 * ⚠️ On avance caractère par caractère dans le texte ORIGINAL : la forme comparable
 * sert de repère, la coupe se fait sur les caractères réellement reçus (aucune
 * réécriture des mots du modèle).
 */
function retirerPrefixe(texte: string, ack: string): string | undefined {
  const cible = normaliserPourAccuse(ack);
  if (cible === "") return undefined;
  let accumule = "";
  let coupe = -1;
  for (let index = 0; index < texte.length; index += 1) {
    accumule += texte[index] ?? "";
    const comparable = normaliserPourAccuse(accumule);
    if (comparable === cible) {
      coupe = index + 1;
      break;
    }
    if (!cible.startsWith(comparable)) return undefined;
  }
  if (coupe === -1) return undefined;
  // La ponctuation/les blancs qui suivent l'accusé (« C'est parti, » « C'est parti : »)
  // n'appartiennent pas au reste : on les retire avec lui.
  return texte.slice(coupe).replace(/^[\s.,;:!?…—–-]+/u, "").trim();
}

/** Résultats MAXIMUM publiés pour un run (au-delà : agrégés dans la réponse finale). */
export const PROGRESS_MAX_RESULTS = 3;

/** Durée (ms) au-delà de laquelle un outil encore en cours mérite un rappel UNIQUE. */
export const PROGRESS_LONG_TOOL_MS = 90_000;

/** Légende d'une image publiée dès sa production. */
export const PROGRESS_IMAGE_TEXT = "Voici l'image.";

/** Rappel UNIQUE pour une action qui dure (jamais une estimation : un fait). */
export const PROGRESS_LONG_TOOL_TEXT =
  "Ça prend quelques minutes : je continue, le résultat arrivera ici.";

/** Ce que la réponse finale ajoute quand des lignes intermédiaires ont été omises. */
export const PROGRESS_SUPPRESSED_TEXT =
  "(d'autres résultats intermédiaires ont été omis pour ne pas noyer le canal.)";

/**
 * Ligne d'ÉCHEC d'un outil — DÉTERMINISTE (même cause ⇒ même phrase).
 *
 * ⚠️ Elle est publiée UNE SEULE fois par outil (`echecs`) et ne promet rien : elle
 * dit ce qui n'a pas marché et que le tour continue. Sans elle, un échec d'outil
 * laissait la personne attendre un résultat qui ne viendrait jamais.
 */
export function progressErrorText(tool: string): string {
  return `L'action « ${tool} » a échoué : je continue sans elle.`;
}

/** Ce que la progression publie (forme minimale, indépendante de la plateforme). */
export interface ProgressMessage {
  text: string;
  fichiers?: readonly string[];
}

/**
 * ORIGINE d'un accusé publié.
 *
 * ⚠️ `modele` = le texte du modèle (cas NORMAL, ses mots et son ton) ; `repli` = la
 * table de `ackFallbackText` (`src/pi/ack.ts`), qui ne parle que si le modèle n'a
 * RIEN écrit avant l'action. C'est ce qui est journalisé — jamais le texte.
 */
export type AckSource = "modele" | "repli";

/** Journal minimal accepté par la progression (aucune dépendance à l'observabilité). */
export interface ProgressLogger {
  info?(message: string, fields?: Record<string, unknown>): void;
  warn?(message: string, fields?: Record<string, unknown>): void;
}

/** Nature d'une publication intermédiaire (journal seulement). */
type PublicationContext = { outil: string; role: "ack" | "rappel" | "fichier" | "resultat" };

/** Publication d'un message intermédiaire (déjà ancrée au fil par l'appelant). */
export type ProgressPublisher = (message: ProgressMessage) => Promise<void>;

export interface ReplyProgressOptions {
  /** Publication effective (l'adaptateur de la plateforme). */
  publier: ProgressPublisher;
  /**
   * ALLOWLIST du run (`run.tools()`).
   *
   * ⚠️ Elle décide des DÉCLENCHEURS : un run distant qui n'a pas `run_command`
   * n'invente pas d'accusé pour une commande. Un outil absent de cette liste ne
   * publie jamais rien, même si `isAckTool` le reconnaît.
   */
  outils: readonly string[];
  /** Horloge injectable (tests : le rappel de longueur se vérifie sans attendre). */
  maintenant?: () => number;
  /**
   * Seuil (ms) au-delà duquel un outil ENCORE EN COURS mérite un rappel unique.
   *
   * ⚠️ C'est un DÉLAI RÉEL, armé au démarrage de l'outil : le rappel doit partir
   * PENDANT l'action. Publier ce rappel à la FIN de l'outil (comportement
   * précédent) revenait à dire « ça prend quelques minutes » une fois que c'était
   * fini — même défaut de timing que l'accusé tardif (signalé le 2026-11-02).
   * Défaut `PROGRESS_LONG_TOOL_MS` ; les tests l'abaissent.
   */
  seuilRappelMs?: number;
  /** Position de ROTATION du repli (défaut : compteur interne au run). */
  indexRepli?: () => number;
  logger?: ProgressLogger;
}

/**
 * Machine à états d'un run : elle ne connaît que des ÉVÉNEMENTS (outil démarré,
 * outil fini, fichier produit) et rend des publications ordonnées.
 */
export class ReplyProgress {
  private readonly publier: ProgressPublisher;
  private readonly outils: ReadonlySet<string>;
  private readonly maintenant: () => number;
  private readonly seuilRappelMs: number;
  /** Rappels ARMÉS par outil en cours (annulés à sa fin : jamais deux). */
  private readonly rappels = new Map<string, ReturnType<typeof setTimeout>>();
  /** Run CLOS : plus aucune publication intermédiaire (jamais après la réponse). */
  private clos = false;
  private readonly indexRepliOptionnel: (() => number) | undefined;
  private readonly logger: ReplyProgressOptions["logger"];
  /** L'accusé déjà publié (verrou 1/run). */
  private ack: { text: string; tool: string; source: AckSource } | undefined;
  /** Lignes de résultat publiées (plafond `PROGRESS_MAX_RESULTS`). */
  private resultats = 0;
  /** Lignes de résultat OMISES faute de place (dites dans la réponse finale). */
  private omis = 0;
  /** Le rappel de longueur est-il déjà parti (verrou 1/run) ? */
  private rappelEnvoye = false;
  /** Outils dont l'échec a DÉJÀ été annoncé (une ligne par outil, jamais deux). */
  private readonly echecs = new Set<string>();
  /** Fichiers DÉJÀ publiés (jamais réattachés à la réponse finale). */
  private readonly fichiersPublies: string[] = [];
  /** Début du dernier appel de chaque outil (mesure de durée, pas d'estimation). */
  private readonly debuts = new Map<string, number>();
  /** Rotation du repli : incrémentée à chaque accusé de repli. */
  private replis = 0;
  /**
   * FILE des publications en attente + chaîne qui les vide UNE PAR UNE.
   *
   * ⚠️ UNE SEULE PUBLICATION EN VOL À LA FOIS, jamais deux : deux `send` simultanés
   * pour un même run perdent l'ORDRE et l'ESPACEMENT à l'arrivée (défaut de production
   * du 2026-11-02 : « toujours deux messages qui arrivent en même temps »). La chaîne
   * est donc une section EXCLUSIVE, pas un simple `.then`.
   *
   * ⚠️ Mais l'accusé passe DEVANT les autres tâches (`prioritaire`) : il n'a de valeur
   * que s'il arrive pendant l'action. Il double la file d'ATTENTE, jamais l'envoi en
   * cours — l'exclusivité reste absolue.
   */
  private chaine: Promise<void> = Promise.resolve();
  /** Tâches en attente d'envoi (l'accusé s'y glisse en tête). */
  private readonly enAttente: Array<{ tache: () => Promise<void>; contexte: PublicationContext }> = [];

  constructor(options: ReplyProgressOptions) {
    this.publier = options.publier;
    this.outils = new Set(options.outils);
    this.maintenant = options.maintenant ?? Date.now;
    this.seuilRappelMs = Math.max(1, Math.trunc(options.seuilRappelMs ?? PROGRESS_LONG_TOOL_MS));
    this.indexRepliOptionnel = options.indexRepli;
    this.logger = options.logger;
  }

  /** L'accusé publié (ou `undefined`) — sert à retirer sa ligne du texte final. */
  get ackPublie(): { text: string; tool: string; source: AckSource } | undefined {
    return this.ack;
  }

  /** ORIGINE de l'accusé publié (`modele`/`repli`), `undefined` si aucun (mesure). */
  get ackSource(): AckSource | undefined {
    return this.ack?.source;
  }

  /** Nombre de lignes de résultat publiées (mesure). */
  get resultatsPublies(): number {
    return this.resultats;
  }

  /** Nombre de lignes omises par le plafond (mesure). */
  get resultatsOmis(): number {
    return this.omis;
  }

  /**
   * Un outil vient de DÉMARRER : c'est le seul moment où un accusé peut partir.
   *
   * ⚠️ ORDRE DE DÉCISION — LE MODÈLE D'ABORD, LA TABLE EN REPLI :
   *  1. le modèle a écrit une phrase d'accusé (une ligne, ≤ `ACK_MAX_CHARS`) ⇒ c'est
   *     SON texte qui part, tel quel — ses mots, son ton ;
   *  2. le modèle a écrit du texte qui N'EST PAS un accusé (trop long, plusieurs
   *     lignes) ⇒ ce texte est une RÉPONSE : aucun accusé ne s'y ajoute ;
   *  3. le modèle est resté MUET (il a appelé l'outil directement) ⇒ `ackFallbackText`,
   *     en ROTATION par conversation (jamais toujours la même phrase).
   */
  demarrerOutil(event: { tool: string; ackCandidat?: string }): void {
    if (this.clos) return;
    this.debuts.set(event.tool, this.maintenant());
    this.armerRappel(event.tool);
    if (this.ack !== undefined) return;
    if (!this.outils.has(event.tool) || !isAckTool(event.tool)) return;
    const candidat = (event.ackCandidat ?? "").trim();
    const duModele = ackShapedText(candidat);
    let texte: string | undefined;
    let source: AckSource;
    if (duModele !== undefined) {
      texte = duModele;
      source = "modele";
    } else if (candidat !== "") {
      // ⚠️ TEXTE ≠ ACCUSÉ. Le repli ne parle PAS ici : sinon le canal recevrait la
      // réponse ET une ligne de statut pour la même phrase (double publication).
      // Règle identique au host local (`maybeAcknowledge`, `src/pi/sdk-host.ts:700`).
      return;
    } else {
      texte = ackFallbackText(event.tool, this.prochainRepli());
      source = "repli";
    }
    // ⚠️ Borne DURE : ni le modèle ni le repli ne publient une ligne plus longue que
    // `ACK_MAX_CHARS` (au-delà, ce n'est plus un accusé, c'est une réponse).
    if (texte === undefined || [...texte].length > ACK_MAX_CHARS) return;
    this.ack = { text: texte, tool: event.tool, source };
    // ⚠️ MESURE DE PRODUCTION : la SOURCE, jamais le texte (un accusé n'est pas un
    // journal). Si `repli` domine, c'est la consigne du prompt qu'il faut renforcer.
    this.logger?.info?.("chat.progress.ack", { tool: event.tool, source });
    // ⚠️ L'ACCUSÉ PASSE DEVANT : il double la FILE d'attente (pas l'envoi en cours —
    // l'exclusivité reste absolue) pour partir au démarrage de l'outil, pas après une
    // image ou une ligne de résultat déjà en attente.
    this.enfiler(() => this.publier({ text: texte }), { outil: event.tool, role: "ack" }, true);
  }

  /** Un outil vient de se TERMINER : rappel désarmé, puis échec (une fois). */
  terminerOutil(event: { tool: string; isError?: boolean }): void {
    this.desarmerRappel(event.tool);
    this.debuts.delete(event.tool);
    if (event.isError !== true) return;
    if (this.echecs.has(event.tool)) return;
    this.echecs.add(event.tool);
    this.resultatTexte(progressErrorText(event.tool), event.tool);
  }

  /**
   * CLÔT le run : après cet appel, plus AUCUNE publication intermédiaire.
   *
   * ⚠️ Appelé par le générateur APRÈS `attendre()` et AVANT de rendre le texte
   * (`src/chat/reply/generate.ts`) : c'est ce qui rend structurellement impossible
   * un accusé (ou un rappel) qui arriverait APRÈS la réponse finale. Un rappel
   * encore armé est ANNULÉ.
   */
  cloturer(): void {
    this.clos = true;
    for (const timer of this.rappels.values()) clearTimeout(timer);
    this.rappels.clear();
  }

  /**
   * Un FICHIER vient d'être produit : il part IMMÉDIATEMENT, une seule fois.
   *
   * ⚠️ C'est ce qui remplace le réattachement à la réponse finale : l'image
   * arrive quand elle existe, pas à la fin d'un tour qui peut durer trois minutes.
   */
  publierFichier(fileId: string, texte: string = PROGRESS_IMAGE_TEXT): void {
    if (fileId.trim() === "" || this.fichiersPublies.includes(fileId)) return;
    this.fichiersPublies.push(fileId);
    // Le fichier est le LIVRABLE : il n'est jamais omis par le plafond, mais il
    // consomme une place de résultat (le plafond borne bien les messages du run).
    this.resultats += 1;
    this.enfiler(() => this.publier({ text: texte, fichiers: [fileId] }), {
      outil: "fichier",
      role: "fichier",
    });
  }

  /**
   * Attend que TOUTES les publications intermédiaires soient parties.
   *
   * ⚠️ DEUX chemins : la chaîne sérialisée (image, résultat, rappel) ET les envois
   * immédiats (l'accusé). N'attendre que la chaîne laisserait l'accusé en vol alors
   * que le run est clos — donc un accusé qui arrive APRÈS la réponse.
   */
  async attendre(): Promise<void> {
    await this.chaine;
  }

  /**
   * Retire du texte FINAL l'accusé déjà publié.
   *
   * ⚠️ DEUX FORMES, dans cet ordre :
   *  1. **LIGNE ENTIÈRE** — la première ligne non vide est exactement l'accusé
   *     (« Deux secondes.\n\nVoilà l'image. ») ;
   *  2. **PRÉFIXE** — le texte COMMENCE par l'accusé puis continue sur la même ligne
   *     (« C'est parti, avec ta fiche sous les yeux… »). Défaut de production du
   *     2026-11-02 : l'égalité stricte seule ne retirait rien, et le canal recevait
   *     l'accusé DEUX fois.
   *
   * ⚠️ La comparaison ignore la CASSE et la PONCTUATION (« C'est parti ! » vs
   * « c'est parti. ») : c'est le MÊME texte pour qui le lit. On ne retire jamais autre
   * chose que ce préfixe, et le reste est publié VERBATIM.
   *
   * ⚠️ Reste VIDE ⇒ on rend la chaîne vide : l'appelant ne publie alors AUCUNE réponse
   * (sinon le canal recevrait une bulle vide, ou l'accusé une seconde fois).
   *
   * ⚠️ PLUSIEURS LIGNES D'ACCUSÉ (production, 2026-11-02 15:50 : une seule bulle portait
   * « Je prends ça en charge. » PUIS « Je lance la mise à jour. ») : le modèle en écrit
   * parfois deux. Une seule est PUBLIÉE (la première, verrou 1/run) ; les suivantes sont
   * retirées du texte final, jamais publiées — sans quoi la personne relit l'attente
   * qu'elle vient de recevoir.
   */
  retirerAck(texte: string): string {
    const ack = this.ack;
    if (ack === undefined) return texte;
    const lignes = texte.split(/\r?\n/u);
    /** Première ligne NON VIDE (les blancs de tête ne comptent pas). */
    const premiereUtile = (): number => lignes.findIndex((ligne) => ligne.trim() !== "");
    let index = premiereUtile();
    if (index === -1) return texte;

    const ligne = lignes[index] ?? "";
    /** Une ligne de tête appartenait-elle à l'accusé ? (garde-fou du ③ ci-dessous) */
    let retie = false;
    // ① La première ligne EST l'accusé : on la retire, elle seule.
    if (normaliserPourAccuse(ligne) === normaliserPourAccuse(ack.text)) {
      lignes.splice(index, 1);
      retie = true;
    } else {
      // ② Le texte COMMENCE par l'accusé (même ligne, puis la suite) : on retire le
      //    préfixe et on publie le reste. `undefined` ⇒ la première ligne n'est pas
      //    l'accusé, c'est le CORPS : on n'y touche pas, et ③ reste désarmé.
      const reste = retirerPrefixe(ligne, ack.text);
      if (reste !== undefined) {
        if (reste === "") lignes.splice(index, 1);
        else lignes[index] = reste;
        retie = true;
      }
    }

    // ③ LIGNES D'ACCUSÉ SUIVANTES : on les retire TANT QU'il reste un corps derrière.
    //    ⚠️ Deux garde-fous, chacun pour une raison mesurable :
    //     - `retie` : on ne nettoie la suite que si le texte REPRENAIT l'accusé. Sans ce
    //       verrou, une réponse qui commence par une phrase d'action légitime
    //       (« Je pense que c'est une bonne idée. ») la perdrait ;
    //     - `corps` : une réponse dont TOUTES les lignes sont des attentes garde la
    //       dernière — sinon elle deviendrait muette.
    while (retie) {
      const debut = premiereUtile();
      if (debut === -1) break;
      if (!ressembleAUnAccuse(lignes[debut] ?? "")) break;
      const corps = lignes
        .slice(debut + 1)
        .some((suite) => suite.trim() !== "" && !ressembleAUnAccuse(suite));
      if (!corps) break;
      lignes.splice(debut, 1);
    }
    return lignes.join("\n").trim();
  }

  /** Fichiers à joindre à la réponse finale : ceux qui ne sont PAS déjà partis. */
  fichiersRestants(ids: readonly string[]): string[] {
    const out: string[] = [];
    for (const id of ids) {
      if (this.fichiersPublies.includes(id)) continue;
      if (out.includes(id)) continue;
      out.push(id);
    }
    return out;
  }

  /**
   * Ligne à AJOUTER à la réponse finale quand des résultats ont été omis.
   * `undefined` quand tout a été dit (aucun bruit ajouté).
   */
  resume(): string | undefined {
    return this.omis > 0 ? PROGRESS_SUPPRESSED_TEXT : undefined;
  }

  /** Publie une LIGNE DE RÉSULTAT, dans la limite du plafond (sinon : omise + dite). */
  private resultatTexte(texte: string, outil: string): void {
    if (this.resultats >= PROGRESS_MAX_RESULTS) {
      this.omis += 1;
      return;
    }
    this.resultats += 1;
    this.enfiler(() => this.publier({ text: texte }), { outil, role: "resultat" });
  }

  /** Position de rotation du repli : injectée (partagée) ou interne au run. */
  private prochainRepli(): number {
    if (this.indexRepliOptionnel) return this.indexRepliOptionnel();
    const index = this.replis;
    this.replis += 1;
    return index;
  }

  /**
   * Armé au DÉMARRAGE de l'outil : le rappel part PENDANT l'action, pas à sa fin.
   *
   * ⚠️ Un seul rappel par run (`rappelEnvoye`) et un seul minuteur par outil :
   * deux outils longs simultanés ne produisent pas deux lignes.
   */
  private armerRappel(tool: string): void {
    if (this.clos || this.rappelEnvoye) return;
    const timer = setTimeout(() => {
      this.rappels.delete(tool);
      if (this.clos || this.rappelEnvoye) return;
      this.rappelEnvoye = true;
      this.enfiler(() => this.publier({ text: PROGRESS_LONG_TOOL_TEXT }), {
        outil: tool,
        role: "rappel",
      });
    }, this.seuilRappelMs);
    timer.unref?.();
    this.rappels.set(tool, timer);
  }

  /** L'outil est fini : son rappel éventuel ne partira pas (ou a déjà été dédupliqué). */
  private desarmerRappel(tool: string): void {
    const timer = this.rappels.get(tool);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.rappels.delete(tool);
  }

  /**
   * Met une publication en file (prioritaire ou non) et relance le vidage.
   *
   * ⚠️ Elle ne REJETTE jamais : une publication intermédiaire refusée est journalisée,
   * la réponse finale part quand même. Le vidage est SÉRIEL : une tâche n'est appelée
   * qu'après la fin complète de la précédente (aucun `send` simultané).
   */
  private enfiler(
    tache: () => Promise<void>,
    contexte: PublicationContext,
    prioritaire = false,
  ): void {
    // ⚠️ Après la clôture, rien ne part : une ligne intermédiaire qui arriverait
    // après la réponse finale serait au mieux inutile, au pire un doublon.
    if (this.clos) {
      this.logger?.warn?.("chat.progress.publish_after_close", { ...contexte });
      return;
    }
    if (prioritaire) this.enAttente.unshift({ tache, contexte });
    else this.enAttente.push({ tache, contexte });
    this.chaine = this.chaine.then(() => this.vider());
  }

  /** Vide la file UNE PAR UNE jusqu'à épuisement (section exclusive). */
  private async vider(): Promise<void> {
    for (;;) {
      const suivant = this.enAttente.shift();
      if (suivant === undefined) return;
      try {
        // ⚠️ `await` : la tâche suivante ne démarre qu'APRÈS la fin de celle-ci.
        await suivant.tache();
      } catch (error) {
        this.logger?.warn?.("chat.progress.publish_failed", {
          ...suivant.contexte,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
