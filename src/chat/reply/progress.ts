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
 * ⚠️ ORDRE : les publications sont SÉRIALISÉES par une chaîne de promesses. L'ordre
 * des événements (accusé → image → réponse) est donc l'ordre d'arrivée sur la
 * plateforme, sans qu'aucun appelant n'ait à attendre.
 */

import { ACK_MAX_CHARS, ackFallbackText, ackShapedText, isAckTool } from "../../pi/ack.js";

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
  /** Chaîne SÉRIALISÉE des publications : elle garantit l'ordre d'arrivée. */
  private chaine: Promise<void> = Promise.resolve();

  constructor(options: ReplyProgressOptions) {
    this.publier = options.publier;
    this.outils = new Set(options.outils);
    this.maintenant = options.maintenant ?? Date.now;
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
    this.debuts.set(event.tool, this.maintenant());
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
    this.enfiler(() => this.publier({ text: texte }), { outil: event.tool, role: "ack" });
  }

  /** Un outil vient de se TERMINER : rappel de longueur (une fois) puis échec (une fois). */
  terminerOutil(event: { tool: string; isError?: boolean }): void {
    const debut = this.debuts.get(event.tool);
    this.debuts.delete(event.tool);
    const duree = debut === undefined ? 0 : this.maintenant() - debut;
    if (!this.rappelEnvoye && duree >= PROGRESS_LONG_TOOL_MS) {
      this.rappelEnvoye = true;
      this.enfiler(() => this.publier({ text: PROGRESS_LONG_TOOL_TEXT }), {
        outil: event.tool,
        role: "rappel",
      });
    }
    if (event.isError !== true) return;
    if (this.echecs.has(event.tool)) return;
    this.echecs.add(event.tool);
    this.resultatTexte(progressErrorText(event.tool), event.tool);
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

  /** Attend que TOUTES les publications intermédiaires soient parties. */
  async attendre(): Promise<void> {
    await this.chaine;
  }

  /**
   * Retire du texte FINAL la ligne d'accusé déjà publiée.
   *
   * ⚠️ Comparaison STRICTE de la première ligne non vide (jamais « ça a l'air
   * court ») : l'accusé est un texte connu, on retire exactement celui-là. Un texte
   * différent garde sa place — c'est une réponse, pas un doublon.
   */
  retirerAck(texte: string): string {
    const ack = this.ack;
    if (ack === undefined) return texte;
    const lignes = texte.split(/\r?\n/u);
    const index = lignes.findIndex((ligne) => ligne.trim() !== "");
    if (index === -1) return texte;
    if (lignes[index]?.trim() !== ack.text.trim()) return texte;
    lignes.splice(index, 1);
    // La suppression laisse au plus UNE ligne vide de tête : on la retire aussi.
    if (index < lignes.length && lignes[index]?.trim() === "") lignes.splice(index, 1);
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
   * Ajoute une publication à la chaîne. ⚠️ Elle ne REJETTE jamais : une publication
   * intermédiaire refusée est journalisée, la réponse finale part quand même.
   */
  private enfiler(
    tache: () => Promise<void>,
    contexte: { outil: string; role: "ack" | "rappel" | "fichier" | "resultat" },
  ): void {
    this.chaine = this.chaine.then(tache).catch((error: unknown) => {
      this.logger?.warn?.("chat.progress.publish_failed", {
        ...contexte,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}
