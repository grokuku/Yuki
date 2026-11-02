/**
 * `generer_image` — UNE SEULE génération par demande, jamais de relance spontanée.
 *
 * ⚠️ DÉFAUT DE PRODUCTION (2026-11-02) : une demande d'image en a produit DEUX. Aucun
 * retry système n'existe (un seul `port.generate`, `src/pi/sdk/image-tools.ts:538` ;
 * un seul `submit` puis une boucle de sondage côté ComfyUI,
 * `src/comfy/client.ts:552-573`) : c'est le MODÈLE qui relançait, et c'est NOUS qui
 * l'y invitions — la description de l'outil disait « juge-la et régénère si besoin »
 * (`:663`) et « tu ne l'as PAS vue […] puis relance » (`:669-676`). Comme la graine
 * change à chaque appel (`src/comfy/generator.ts:113`), la seconde image était
 * DIFFÉRENTE : un résultat que personne n'avait demandé.
 *
 * ⚠️ CONSIGNE UTILISATEUR (verbatim) : « juger l'image c'est bien, mais si elle voit un
 * défaut il faudrait énoncer ce défaut et proposer de refaire. » Le jugement sert à
 * INFORMER, jamais à décider.
 *
 * Ce que ce fichier verrouille :
 *  1. aucune invitation à régénérer dans la description ni dans le résultat (toute
 *     occurrence de « régénérer »/« relancer » est une INTERDICTION explicite) ;
 *  2. un appel de l'outil ⇒ UN seul `generate` (compteur) ;
 *  3. image non vue (vision déclarée absente, ou image trop lourde) ⇒ c'est DIT, et
 *     l'outil ne relance pas : il demande à l'utilisateur.
 *
 * ⚠️ Échoue sur le code d'origine : la description invitait à juger « et régénérer si
 * besoin », les deux messages d'image non vue finissaient par « puis relance » /
 * « régénère », et rien n'interdisait la relance.
 */

import { describe, expect, it } from "vitest";

import { type GeneratedImage } from "../../src/comfy/index.js";
import { createImageTools } from "../../src/pi/sdk/image-tools.js";

type Tool = ReturnType<typeof createImageTools>[number];
type ContentPart = { type: string; text?: string };

/** PNG 1×1 valide. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const CTX = { sessionManager: { getSessionId: () => "conv-1" } };

/** Racines des mots qui ne doivent apparaître QUE sous forme d'interdiction. */
const RACINES = /r[ée]g[ée]n[ée]r|relanc/iu;

/**
 * Vrai si le fragment INTERDIT la relance (et non s'il l'invite).
 *
 * ⚠️ On ne regarde QUE les mots qui PRÉCÈDENT le verbe : « régénérer si elle ne
 * convient pas » contient « ne » sans être une interdiction — c'est justement la
 * formulation du défaut d'origine.
 */
function estUneInterdiction(fragment: string): boolean {
  const index = fragment.search(RACINES);
  if (index === -1) return true;
  const avant = fragment.slice(Math.max(0, index - 25), index);
  return /jamais|\bne\b|\bpas\b|aucun|interdit/iu.test(avant);
}

/**
 * Toutes les occurrences de « régénérer »/« relancer » d'un texte sont-elles des
 * INTERDICTIONS ? Rend les fragments fautifs (vide = conforme).
 */
function invitations(texte: string): string[] {
  return texte
    .split(/[.\n]/u)
    .map((phrase) => phrase.trim())
    .filter((phrase) => RACINES.test(phrase) && !estUneInterdiction(phrase));
}

async function call(
  tool: Tool,
  params: Record<string, unknown>,
): Promise<{ content: ContentPart[]; text: string; details: Record<string, unknown> }> {
  const fn = tool.execute as unknown as (
    id: string,
    params: unknown,
    signal: undefined,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<{ content: ContentPart[]; details: Record<string, unknown> }>;
  const result = await fn("call", params, undefined, undefined, CTX);
  return {
    content: result.content,
    text: result.content.map((part) => part.text ?? "").join("\n"),
    details: result.details,
  };
}

/** Outil réel + compteur d'appels au générateur. */
function harness(options: { receivesImages?: () => boolean; bytes?: Uint8Array } = {}) {
  const calls: Array<{ scene: string }> = [];
  const image: GeneratedImage = {
    record: {
      id: "b".repeat(32),
      file: "/data/state/comfy/images/x.png",
      mimeType: "image/png",
      ext: "png",
      bytes: options.bytes?.byteLength ?? PNG.byteLength,
      imageSrc: `/images/${"b".repeat(32)}.png`,
      createdAt: new Date(0).toISOString(),
      expiresAt: new Date(0).toISOString(),
      promptId: "prompt-1",
      width: 1,
      height: 1,
    },
    bytes: options.bytes ?? PNG,
    promptId: "prompt-1",
    workflowName: "manga",
    elapsedMs: 12_500,
    outputLabeled: true,
    labels: ["YUKI_PROMPT"],
  };
  const tools = createImageTools({
    async generate(input) {
      calls.push({ scene: input.scene });
      return image;
    },
    workflows: {
      candidates: () => [{ name: "manga", description: "Manga", isDefault: true }],
      documentationOf: () => "",
    },
    ...(options.receivesImages ? { receivesImages: options.receivesImages } : {}),
  });
  return { tool: tools[0]!, calls };
}

describe("generer_image — aucune invitation à régénérer", () => {
  it("la description et le résumé de l'outil n'invitent jamais à relancer (seulement à PROPOSER)", () => {
    const { tool } = harness();
    const description = (tool as unknown as { description: string }).description;
    const snippet = (tool as unknown as { promptSnippet?: string }).promptSnippet ?? "";
    // ⚠️ Une occurrence n'est acceptée que si elle INTERDIT la relance.
    expect(invitations(description)).toEqual([]);
    expect(invitations(snippet)).toEqual([]);
    // Et l'interdiction est explicite (le modèle doit la lire, pas la deviner).
    expect(description).toMatch(/JAMAIS/iu);
  });

  it("un appel de l'outil n'appelle le générateur qu'UNE fois (aucun retry caché)", async () => {
    const { tool, calls } = harness();
    const result = await call(tool, { scene: "un phare au crépuscule" });

    expect(calls).toHaveLength(1);
    // Le résultat ne propose PAS de relancer : il demande de décrire et de proposer.
    expect(result.text).toContain("PROPOSE");
    expect(invitations(result.text)).toEqual([]);
  });

  it("modèle SANS vision : le DIT, demande s'il faut refaire, et NE relance pas", async () => {
    const { tool, calls } = harness({ receivesImages: () => false });
    const result = await call(tool, { scene: "un phare au crépuscule" });

    expect(result.text).toContain("déclaré SANS vision");
    expect(result.text).toContain("nouvelle génération");
    expect(result.text).toMatch(/ne relance PAS/iu);
    expect(calls).toHaveLength(1);
  });

  it("image trop lourde pour être vue : le DIT, demande s'il faut refaire, et NE relance pas", async () => {
    const { tool, calls } = harness({ bytes: new Uint8Array(2 * 1024 * 1024) });
    const result = await call(tool, { scene: "une scène" });

    expect(result.text).toContain("PAS vue");
    expect(result.text).toContain("nouvelle génération");
    expect(result.text).toMatch(/ne relance PAS/iu);
    expect(calls).toHaveLength(1);
  });
});
