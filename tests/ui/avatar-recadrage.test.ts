/**
 * RECADRAGE de l'avatar — géométrie PURE (aucun DOM, aucun canvas).
 *
 * Prouve les trois propriétés qui font la différence entre un recadrage
 * « à peu près » et un recadrage juste :
 *   ① le zoom est BORNÉ (`ZOOM_MIN`…`ZOOM_MAX`) et garde le point sous le
 *      curseur immobile ;
 *   ② le déplacement est BORNÉ : l'image couvre TOUJOURS le cercle (aucun coin
 *      vide ne peut apparaître, quel que soit l'enchaînement de gestes) ;
 *   ③ `recadrer` décrit exactement le carré source du cercle et `dessiner`
 *      produit un carré de `TAILLE_SORTIE` (512) avec ces pixels-là.
 */

import { describe, expect, it } from "vitest";

import {
  DIAMETRE_APERCU,
  TAILLE_SORTIE,
  ZOOM_MAX,
  ZOOM_MIN,
  bornes,
  creerEtat,
  deplacer,
  dessiner,
  echelleAbsolue,
  recentrer,
  recadrer,
  zoomer,
} from "../../public/ui/avatar-recadrage.js";

/** Coordonnées SOURCE sous un point du cercle (px depuis le centre de l'image). */
function sourceSousPoint(
  etat: { largeurImage: number; hauteurImage: number; diametre: number; echelle: number; x: number; y: number },
  point: { x: number; y: number },
) {
  const echelle = echelleAbsolue(etat) as number;
  return {
    x: etat.largeurImage / 2 + (point.x - etat.x) / echelle,
    y: etat.hauteurImage / 2 + (point.y - etat.y) / echelle,
  };
}

describe("état initial et échelle « couvre »", () => {
  it("part au zoom minimal, image centrée, et couvre exactement le petit côté", () => {
    const etat = creerEtat({ largeurImage: 1000, hauteurImage: 500, diametre: 200 });
    expect(etat.echelle).toBe(ZOOM_MIN);
    expect(etat.x).toBe(0);
    expect(etat.y).toBe(0);
    // 500 px de haut rendus à 200 px de diamètre : l'image couvre le cercle.
    expect(echelleAbsolue(etat)).toBeCloseTo(0.4, 10);
  });

  it("refuse des dimensions absurdes (jamais un état inutilisable)", () => {
    expect(() => creerEtat({ largeurImage: 0, hauteurImage: 100 })).toThrow(RangeError);
    expect(() => creerEtat({ largeurImage: 100, hauteurImage: -1 })).toThrow(RangeError);
  });
});

describe("zoom borné", () => {
  const etat = creerEtat({ largeurImage: 1000, hauteurImage: 500, diametre: 200 });

  it("ne descend jamais sous le « couvre » (aucun coin vide)", () => {
    const reduit = zoomer(etat, 0.2) as typeof etat;
    expect(reduit.echelle).toBe(ZOOM_MIN);
    expect(reduit.x).toBe(0);
    expect(reduit.y).toBe(0);
  });

  it("ne dépasse jamais le zoom maximal", () => {
    const agrandi = zoomer(etat, 1_000) as typeof etat;
    expect(agrandi.echelle).toBe(ZOOM_MAX);
  });

  it("garde immobile le point sous le curseur (zoom ancré)", () => {
    const point = { x: 60, y: -20 };
    const avant = sourceSousPoint(etat, point);
    const apresEtat = zoomer(etat, 1.8, point) as typeof etat;
    const apres = sourceSousPoint(apresEtat, point);
    expect(apres.x).toBeCloseTo(avant.x, 6);
    expect(apres.y).toBeCloseTo(avant.y, 6);
    expect(apresEtat.echelle).toBeCloseTo(1.8, 10);
  });

  it("l'ancre par défaut est le centre du cercle", () => {
    const centre = zoomer(etat, 1.5) as typeof etat;
    expect(centre.x).toBeCloseTo(0, 10);
    expect(centre.y).toBeCloseTo(0, 10);
  });
});

describe("déplacement borné — le cercle est TOUJOURS couvert", () => {
  it("clampe au bord : la marge est exactement ce qui dépasse du cercle", () => {
    const etat = creerEtat({ largeurImage: 1000, hauteurImage: 500, diametre: 200 });
    const limite = bornes(etat) as { minX: number; maxX: number; minY: number; maxY: number };
    expect(limite.maxX).toBeCloseTo(100, 10); // (400 - 200) / 2
    expect(limite.maxY).toBeCloseTo(0, 10); // l'image fait exactement 200 px de haut
    const pousse = deplacer(etat, 10_000, 10_000) as typeof etat;
    expect(pousse.x).toBeCloseTo(limite.maxX, 10);
    expect(pousse.y).toBeCloseTo(limite.maxY, 10);
  });

  it("après N gestes quelconques, le rectangle source reste DANS l'image", () => {
    let etat = creerEtat({ largeurImage: 1_280, hauteurImage: 720, diametre: 240 });
    const gestes = [
      () => (etat = zoomer(etat, 2.4, { x: 90, y: -70 })),
      () => (etat = deplacer(etat, 5_000, -5_000)),
      () => (etat = zoomer(etat, 0.1)),
      () => (etat = deplacer(etat, -300, 120)),
      () => (etat = zoomer(etat, 1.1, { x: -80, y: 80 })),
      () => (etat = deplacer(etat, 1_000, 1_000)),
    ];
    for (const geste of gestes) {
      geste();
      const rectangle = recadrer(etat) as {
        sx: number;
        sy: number;
        sw: number;
        sh: number;
      };
      expect(rectangle.sx).toBeGreaterThanOrEqual(-1e-9);
      expect(rectangle.sy).toBeGreaterThanOrEqual(-1e-9);
      expect(rectangle.sx + rectangle.sw).toBeLessThanOrEqual(etat.largeurImage + 1e-9);
      expect(rectangle.sy + rectangle.sh).toBeLessThanOrEqual(etat.hauteurImage + 1e-9);
    }
  });

  it("recentrer ramène au zoom « couvre » et au centre", () => {
    const etat = creerEtat({ largeurImage: 1000, hauteurImage: 500, diametre: 200 });
    const modifie = deplacer(zoomer(etat, 2), 50, 0) as typeof etat;
    const centre = recentrer(modifie) as typeof etat;
    expect(centre.echelle).toBe(ZOOM_MIN);
    expect(centre.x).toBe(0);
    expect(centre.y).toBe(0);
  });
});

describe("sortie 512×512 et pixels source justes", () => {
  it("la sortie est un CARRÉ de 512 px (constante unique)", () => {
    expect(TAILLE_SORTIE).toBe(512);
    const etat = creerEtat({ largeurImage: 1000, hauteurImage: 1000, diametre: 200 });
    const rectangle = recadrer(etat) as { taille: number; sw: number; sh: number };
    expect(rectangle.taille).toBe(512);
    expect(rectangle.sw).toBeCloseTo(rectangle.sh, 10);
  });

  it("au zoom 1, l'image carrée entière est retenue (source = toute l'image)", () => {
    const etat = creerEtat({ largeurImage: 1000, hauteurImage: 1000, diametre: 200 });
    const rectangle = recadrer(etat) as { sx: number; sy: number; sw: number; sh: number };
    expect(rectangle.sx).toBeCloseTo(0, 10);
    expect(rectangle.sy).toBeCloseTo(0, 10);
    expect(rectangle.sw).toBeCloseTo(1000, 10);
    expect(rectangle.sh).toBeCloseTo(1000, 10);
  });

  it("au zoom 2, le carré CENTRAL de 500 px est découpé (les bons pixels source)", () => {
    const etat = zoomer(creerEtat({ largeurImage: 1000, hauteurImage: 1000, diametre: 200 }), 2) as {
      largeurImage: number;
      hauteurImage: number;
      diametre: number;
      echelle: number;
      x: number;
      y: number;
    };
    const rectangle = recadrer(etat) as { sx: number; sy: number; sw: number; sh: number };
    expect(rectangle.sw).toBeCloseTo(500, 10);
    expect(rectangle.sh).toBeCloseTo(500, 10);
    expect(rectangle.sx).toBeCloseTo(250, 10);
    expect(rectangle.sy).toBeCloseTo(250, 10);
  });

  it("décaler l'image vers la DROITE fait voir la GAUCHE de la source", () => {
    const base = zoomer(creerEtat({ largeurImage: 1000, hauteurImage: 1000, diametre: 200 }), 2) as {
      largeurImage: number;
      hauteurImage: number;
      diametre: number;
      echelle: number;
      x: number;
      y: number;
    };
    const decale = deplacer(base, 100, -100) as typeof base;
    const rectangle = recadrer(decale) as { sx: number; sy: number; sw: number; sh: number };
    expect(rectangle.sx).toBeCloseTo(0, 10); // bord gauche de la source
    expect(rectangle.sy).toBeCloseTo(500, 10); // bas de la source (image montée)
  });

  it("dessiner applique ce rectangle dans un carré de 512 (aucune autre transformation)", () => {
    const etat = zoomer(creerEtat({ largeurImage: 1000, hauteurImage: 1000, diametre: 200 }), 2) as {
      largeurImage: number;
      hauteurImage: number;
      diametre: number;
      echelle: number;
      x: number;
      y: number;
    };
    const appels: unknown[][] = [];
    const fauxContexte = {
      drawImage: (...args: unknown[]) => {
        appels.push(args);
      },
    };
    const image = { marqueur: "image-source" };
    dessiner(fauxContexte as never, image as never, etat as never, TAILLE_SORTIE);
    expect(appels).toHaveLength(1);
    const [source, sx, sy, sw, sh, dx, dy, dw, dh] = appels[0] as unknown[];
    expect(source).toBe(image);
    expect([sx, sy, sw, sh]).toEqual([250, 250, 500, 500]);
    expect([dx, dy]).toEqual([0, 0]);
    expect([dw, dh]).toEqual([TAILLE_SORTIE, TAILLE_SORTIE]);
  });

  it("le diamètre d'aperçu par défaut est celui de l'UI (240 px)", () => {
    expect(DIAMETRE_APERCU).toBe(240);
  });
});
