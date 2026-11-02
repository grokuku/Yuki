/**
 * JARGON INTERNE — aucun texte destiné à un CANAL ne parle de plomberie.
 *
 * ⚠️ DÉFAUT DE PRODUCTION (capture Mattermost, 2026-11-02 15:38-15:44), verbatim :
 * « la génération directe depuis ce canal a été refusée par **le système** (elle dépasse
 * **la borne d'un tour**) ». Cette phrase n'existe NULLE PART dans le code : le modèle
 * avait RECOPIÉ le message de refus de l'outil (`longToolInlineRefusal`) et l'avait
 * reformulé pour la personne du canal. Un utilisateur n'a rien à lire de la mécanique
 * interne — ni « borne », ni « tour », ni « système », ni « timeout », ni « worker »,
 * ni « délégation ».
 *
 * Ce que ce fichier verrouille :
 *  1. aucun texte ÉMIS PAR LE CODE (refus d'outil, ligne de progression, accusé de
 *     repli) ne contient ce vocabulaire : s'il est recopié, il reste lisible ;
 *  2. la CONSIGNE d'accusé (`ackRuleFor`) et le PROMPT SYSTÈME du canal (`CHAT_REPLY_SYSTEM_PROMPT`)
 *     n'apprennent pas ces mots au modèle et interdisent explicitement d'en parler ;
 *  3. le prompt du canal dit quoi dire à la place (ce qu'on fait, combien de temps).
 *
 * ⚠️ Échoue sur le code d'origine : `longToolInlineRefusal` disait « Un tour dans un
 * CANAL est borné », « La délégation s'active dans… », la consigne d'accusé citait
 * `images.timeoutMs`, et le prompt du canal parlait de « worker (outil de délégation) ».
 */

import { describe, expect, it } from "vitest";

import { CHAT_REPLY_SYSTEM_PROMPT } from "../../src/chat/reply/prompt.js";
import {
  PROGRESS_IMAGE_TEXT,
  PROGRESS_LONG_TOOL_TEXT,
  PROGRESS_SUPPRESSED_TEXT,
  progressErrorText,
} from "../../src/chat/reply/progress.js";
import { LONG_RUNNING_TOOLS, longToolInlineRefusal } from "../../src/llm/tool-policy.js";
import { ACK_FALLBACK_TEXTS, ACK_RULE, ackRuleFor } from "../../src/pi/ack.js";

/**
 * Vocabulaire de PLOMBERIE qui ne doit jamais apparaître à l'écran.
 *
 * ⚠️ Bornes de mot : « retour », « autour » ou « séjour » ne sont pas visés ; on
 * cherche le MOT « tour ».
 */
const INTERDITS: ReadonlyArray<{ mot: string; motif: RegExp }> = [
  { mot: "borne", motif: /\bornes?\b/iu },
  { mot: "tour", motif: /\btours?\b/iu },
  { mot: "système", motif: /\bsyst[èe]mes?\b/iu },
  { mot: "timeout", motif: /time[_-]?outs?/iu },
  { mot: "worker", motif: /\bworkers?\b/iu },
  { mot: "délégation", motif: /\bd[ée]l[ée]gations?\b/iu },
];

/** Tous les textes que le CODE émet vers un canal (ou que le modèle recopie). */
function textesEmis(): Array<{ origine: string; texte: string }> {
  const textes: Array<{ origine: string; texte: string }> = [
    { origine: "PROGRESS_IMAGE_TEXT", texte: PROGRESS_IMAGE_TEXT },
    { origine: "PROGRESS_LONG_TOOL_TEXT", texte: PROGRESS_LONG_TOOL_TEXT },
    { origine: "PROGRESS_SUPPRESSED_TEXT", texte: PROGRESS_SUPPRESSED_TEXT },
    { origine: "progressErrorText(delegate)", texte: progressErrorText("delegate") },
    { origine: "progressErrorText(generer_image)", texte: progressErrorText("generer_image") },
    { origine: "CHAT_REPLY_SYSTEM_PROMPT", texte: CHAT_REPLY_SYSTEM_PROMPT },
    { origine: "ACK_RULE", texte: ACK_RULE },
    { origine: "ackRuleFor(ALLOWLIST_CANAL)", texte: ackRuleFor(["generer_image", "delegate"]) },
  ];
  for (const [outil, variantes] of Object.entries(ACK_FALLBACK_TEXTS)) {
    for (const variante of variantes) textes.push({ origine: `ackFallback(${outil})`, texte: variante });
  }
  for (const outil of LONG_RUNNING_TOOLS) {
    const refus = longToolInlineRefusal(outil.name);
    if (refus !== undefined) textes.push({ origine: `refus(${outil.name})`, texte: refus });
  }
  return textes;
}

describe("jargon interne — aucun texte visible ne parle de plomberie", () => {
  it("aucun refus, aucune ligne de progression, aucun accusé ne contient borne/tour/système/timeout/worker/délégation", () => {
    const fautes: string[] = [];
    for (const { origine, texte } of textesEmis()) {
      for (const { mot, motif } of INTERDITS) {
        if (motif.test(texte)) fautes.push(`${origine} contient « ${mot} » : ${texte}`);
      }
    }
    // ⚠️ Le message nomme la SOURCE de la fuite (fichier + texte) pour être corrigeable
    // sans relire tout le dépôt.
    expect(fautes).toEqual([]);
  });

  it("le refus d'outil long dit au MODÈLE quoi faire (delegate) ET quoi DIRE à la personne", () => {
    const refus = longToolInlineRefusal("generer_image");
    expect(refus).toBeDefined();
    // Actionnable pour le modèle : il doit pouvoir agir sans deviner.
    expect(refus).toContain("delegate");
    // Et humain pour la personne, même si le modèle le recopie.
    expect(refus?.toLowerCase()).toContain("à la personne");
    expect(refus).toContain("longue");
  });

  it("le prompt du canal interdit explicitement d'expliquer la mécanique interne", () => {
    // ⚠️ Il ne cite pas les mots eux-mêmes (sinon il les APPREND au modèle) : il décrit
    // la catégorie et le remplacement attendu.
    expect(CHAT_REPLY_SYSTEM_PROMPT).toContain("mécanique");
    expect(CHAT_REPLY_SYSTEM_PROMPT).toContain("détails");
    expect(CHAT_REPLY_SYSTEM_PROMPT).toContain("combien de");
    expect(CHAT_REPLY_SYSTEM_PROMPT).toContain("temps");
  });

  it("la consigne d'accusé exige UNE SEULE ligne (le modèle en écrivait deux)", () => {
    expect(ACK_RULE).toContain("UNE SEULE LIGNE");
    expect(ACK_RULE).toContain("JAMAIS DEUX");
    // Et la consigne de la version « canal » (allowlist réduite) porte la même règle.
    expect(ackRuleFor(["delegate"])).toContain("UNE SEULE LIGNE");
  });
});
