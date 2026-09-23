/**
 * Tests unitaires — logique PURE de l'UI de TÉLÉCHARGEMENT des modèles
 * (`public/ui/tts-assistant.js`, Lot 9 étape 3).
 *
 * Aucun DOM, aucun réseau. Vérifie le mapping état → libellé/badge, la
 * progression (octets → %), la décision d'action selon `installed`/`declared`,
 * le mapping des erreurs serveur → message affiché et l'arrêt du poll dès que
 * plus rien n'est actif.
 */

import { describe, expect, it } from "vitest";

import {
  DOWNLOAD_TERMINAL_STATUSES,
  TTS_DOWNLOAD_POLL_MS,
  catalogAction,
  describeCatalogEntry,
  describeDownloadError,
  describeDownloadStatus,
  describeNotIncluded,
  downloadProgress,
  isDownloadTerminal,
  shouldPollDownloads,
} from "../../public/ui/tts-assistant.js";

/* ─── Statut → libellé ──────────────────────────────────────────────────── */

describe("describeDownloadStatus — les 7 états, jamais « réussi » sans preuve", () => {
  it("mappe chaque statut du backend vers un libellé français", () => {
    expect(describeDownloadStatus("queued").label).toBe("En attente");
    expect(describeDownloadStatus("downloading").label).toBe("Téléchargement…");
    expect(describeDownloadStatus("verifying").label).toBe("Vérification…");
    expect(describeDownloadStatus("done").label).toBe("Téléchargé");
    expect(describeDownloadStatus("failed").label).toBe("Échec");
    expect(describeDownloadStatus("cancelled").label).toBe("Annulé");
    expect(describeDownloadStatus("interrupted").label).toBe("Interrompu");
  });

  it("interrupted n'est JAMAIS présenté comme un succès (tonalité erreur)", () => {
    const view = describeDownloadStatus("interrupted");
    expect(view.tone).toBe("error");
    expect(view.label).not.toMatch(/téléchargé/i);
    expect(view.terminal).toBe(true);
  });

  it("seul `done` est en tonalité « ok »", () => {
    const oks = ["queued", "downloading", "verifying", "failed", "cancelled", "interrupted"]
      .map((status) => describeDownloadStatus(status).tone);
    expect(oks).not.toContain("ok");
    expect(describeDownloadStatus("done").tone).toBe("ok");
  });

  it("un statut inconnu reste terminal et neutre (jamais un succès)", () => {
    const view = describeDownloadStatus("mystère");
    expect(view.key).toBe("unknown");
    expect(view.terminal).toBe(true);
    expect(view.tone).toBe("muted");
  });
});

describe("isDownloadTerminal — miroir du backend", () => {
  it("liste exactement done/failed/cancelled/interrupted", () => {
    expect([...DOWNLOAD_TERMINAL_STATUSES].sort()).toEqual(
      ["cancelled", "done", "failed", "interrupted"].sort(),
    );
    for (const status of ["queued", "downloading", "verifying"]) {
      expect(isDownloadTerminal(status), status).toBe(false);
    }
    for (const status of DOWNLOAD_TERMINAL_STATUSES) {
      expect(isDownloadTerminal(status), status).toBe(true);
    }
  });
});

/* ─── Progression octets → pourcentage ──────────────────────────────────── */

describe("downloadProgress — octets → pourcentage, jamais inventé", () => {
  it("calcule un pourcentage entier borné pour un total connu", () => {
    const view = downloadProgress({ bytesDownloaded: 512, totalBytes: 2048 });
    expect(view.determinate).toBe(true);
    expect(view.percent).toBe(25);
    expect(view.percentText).toBe("25 %");
    expect(view.bytesText).toBe("512 o / 2.0 Ko");
  });

  it("borne à 100 % même si les octets dépassent (jamais > 100)", () => {
    expect(downloadProgress({ bytesDownloaded: 5000, totalBytes: 1000 }).percent).toBe(100);
  });

  it("barre INDÉTERMINÉE sans total (aucun pourcentage)", () => {
    const view = downloadProgress({ bytesDownloaded: 1024, totalBytes: null });
    expect(view.determinate).toBe(false);
    expect(view.percent).toBeNull();
    expect(view.percentText).toBeNull();
    expect(view.bytesText).toBe("1.0 Ko");
  });

  it("total nul/absent et octets nuls → « 0 o », indéterminé", () => {
    expect(downloadProgress({ bytesDownloaded: 0, totalBytes: 0 }).bytesText).toBe("0 o");
    expect(downloadProgress(null).determinate).toBe(false);
    expect(downloadProgress(undefined).bytesText).toBe("0 o");
  });
});

/* ─── Entrée de catalogue → badge + action ──────────────────────────────── */

const ENTRY = {
  id: "chatterbox",
  label: "Chatterbox Multilingue",
  variant: "Q8_0",
  license: "MIT",
  licenseAllowed: true,
  expectedBytes: 2_088_393_668,
};

describe("describeCatalogEntry — badge « à télécharger » / « téléchargé » / « déclaré »", () => {
  it("ni installé ni déclaré → « À télécharger » (neutre)", () => {
    const view = describeCatalogEntry({ ...ENTRY, installed: false, declared: false });
    expect(view.stateKey).toBe("missing");
    expect(view.badgeLabel).toBe("À télécharger");
    expect(view.tone).toBe("muted");
    expect(view.sizeText).toMatch(/Go/);
    expect(view.license).toBe("MIT");
  });

  it("installé mais non déclaré → « Téléchargé » (avertissement)", () => {
    const view = describeCatalogEntry({ ...ENTRY, installed: true, declared: false });
    expect(view.stateKey).toBe("installed");
    expect(view.badgeLabel).toBe("Téléchargé");
    expect(view.tone).toBe("warn");
  });

  it("déclaré → « Déclaré » (succès)", () => {
    const view = describeCatalogEntry({ ...ENTRY, installed: true, declared: true });
    expect(view.stateKey).toBe("declared");
    expect(view.badgeLabel).toBe("Déclaré");
    expect(view.tone).toBe("ok");
  });

  it("une tâche non terminale rend l'entrée « active »", () => {
    const view = describeCatalogEntry({
      ...ENTRY,
      installed: false,
      declared: false,
      download: { status: "downloading" },
    });
    expect(view.active).toBe(true);
    expect(describeCatalogEntry({ ...ENTRY, download: { status: "done" } }).active).toBe(false);
    expect(describeCatalogEntry({ ...ENTRY, download: { status: "interrupted" } }).active).toBe(false);
  });

  it("entrée absente/indéfinie → valeurs neutres, jamais d'exception", () => {
    expect(describeCatalogEntry(null).badgeLabel).toBe("À télécharger");
    expect(describeCatalogEntry({}).label).toBe("?");
  });
});

describe("catalogAction — télécharger → déclarer → activer", () => {
  const view = (overrides: Record<string, unknown>) => describeCatalogEntry({ ...ENTRY, ...overrides });

  it("non installé → « Télécharger »", () => {
    const action = catalogAction(view({ installed: false, declared: false }), {});
    expect(action.kind).toBe("download");
    expect(action.label).toBe("Télécharger");
    expect(action.disabled).toBe(false);
  });

  it("installé non déclaré → « Déclarer ce modèle »", () => {
    const action = catalogAction(view({ installed: true, declared: false }), {});
    expect(action.kind).toBe("declare");
    expect(action.label).toBe("Déclarer ce modèle");
  });

  it("déclaré → « Choisir comme moteur » (activer)", () => {
    const action = catalogAction(view({ installed: true, declared: true }), {});
    expect(action.kind).toBe("activate");
    expect(action.label).toBe("Choisir comme moteur");
  });

  it("tâche active → « Annuler » (jamais un second téléchargement)", () => {
    const action = catalogAction(view({ download: { status: "downloading" } }), {
      activeId: "chatterbox",
    });
    expect(action.kind).toBe("cancel");
    expect(action.label).toBe("Annuler");
  });

  it("un AUTRE téléchargement en cours désactive « Télécharger »", () => {
    const action = catalogAction(view({ installed: false, declared: false }), {
      activeId: "kokoro",
    });
    expect(action.kind).toBe("download");
    expect(action.disabled).toBe(true);
    expect(action.reason).toMatch(/déjà en cours/i);
  });

  it("tâche échouée/interrompue non installée → « Réessayer »", () => {
    for (const status of ["failed", "interrupted", "cancelled"]) {
      const action = catalogAction(
        view({ installed: false, declared: false, download: { status } }),
        {},
      );
      expect(action.kind, status).toBe("download");
      expect(action.label, status).toBe("Réessayer");
    }
  });

  it("éditeur indisponible → « Déclarer » désactivé avec la raison", () => {
    const action = catalogAction(view({ installed: true, declared: false }), {
      engineConfigAvailable: false,
    });
    expect(action.kind).toBe("declare");
    expect(action.disabled).toBe(true);
    expect(action.reason).toMatch(/configuration du moteur/i);
  });

  it("licence hors politique → téléchargement refusé (défense, sans cause inventée)", () => {
    const action = catalogAction(view({ installed: false, licenseAllowed: false }), {});
    expect(action.kind).toBe("download");
    expect(action.disabled).toBe(true);
    expect(action.reason).toMatch(/licence/i);
  });
});

/* ─── Modèles écartés ───────────────────────────────────────────────────── */

describe("describeNotIncluded — transparence, jamais masqué", () => {
  it("conserve la raison et le détail du serveur", () => {
    const view = describeNotIncluded({
      id: "sanotts",
      label: "sanoTTS Nano",
      license: "GPL-3.0",
      reason: "license_out_of_policy",
      detail: "Licence GPL-3.0 hors politique MIT/Apache-2.0.",
    });
    expect(view.label).toBe("sanoTTS Nano");
    expect(view.license).toBe("GPL-3.0");
    expect(view.reason).toBe("license_out_of_policy");
    expect(view.detail).toMatch(/GPL-3.0/);
  });

  it("entrée incomplète → libellé de repli, jamais vide", () => {
    expect(describeNotIncluded({}).label).toBe("?");
    expect(describeNotIncluded(null).detail.length).toBeGreaterThan(0);
  });
});

/* ─── Erreurs serveur → message affiché ─────────────────────────────────── */

describe("describeDownloadError — le message EXACT du serveur, jamais une cause inventée", () => {
  it("503 models_dir_unwritable : reprend le message du serveur (EROFS = lecture seule)", () => {
    const serverMessage =
      "Le dossier des modèles n'est pas inscriptible par le gateway : le volume « models » " +
      "(chemin « /models/downloads/chatterbox ») est monté en LECTURE SEULE. Détail brut : EROFS.";
    const view = describeDownloadError({ status: 503, code: "models_dir_unwritable", message: serverMessage });
    expect(view.message).toBe(serverMessage);
    expect(view.message).toContain("EROFS");
    expect(view.retry).toBe(true);
  });

  it("507 insufficient_disk_space : reprend le message (tailles) et propose Réessayer", () => {
    const view = describeDownloadError({
      status: 507,
      code: "insufficient_disk_space",
      message: "Espace disque insuffisant : 2.1 Go requis (+ 64.0 Mo de marge), 10 o disponibles.",
    });
    expect(view.message).toContain("Espace disque insuffisant");
    expect(view.retry).toBe(true);
  });

  it("409 download_in_progress : message du serveur, PAS de bouton Réessayer", () => {
    const view = describeDownloadError({
      status: 409,
      code: "download_in_progress",
      message: "Un téléchargement est déjà en cours ou en attente pour « chatterbox ».",
    });
    expect(view.message).toContain("déjà en cours");
    expect(view.retry).toBe(false);
  });

  it("502 catalog_resolve_failed : message serveur + Réessayer", () => {
    const view = describeDownloadError({
      status: 502,
      code: "catalog_resolve_failed",
      message: "Résolution du paquet « chatterbox » impossible : filet coupé.",
    });
    expect(view.message).toContain("filet coupé");
    expect(view.retry).toBe(true);
  });

  it("400 unknown_catalog_id : repli honnête (aucune cause serveur inventée), pas de Réessayer", () => {
    const view = describeDownloadError({ status: 400, code: "unknown_catalog_id" });
    expect(view.message).toMatch(/inconnu du catalogue/i);
    expect(view.code).toBe("unknown_catalog_id");
    expect(view.retry).toBe(false);
  });

  it("lit le code et le message depuis `error.data` (HolafFetchError)", () => {
    const view = describeDownloadError({
      status: 503,
      data: { code: "models_dir_unwritable", message: "Montage en lecture seule (EROFS)." },
    });
    expect(view.message).toBe("Montage en lecture seule (EROFS).");
  });

  it("erreur réseau (statut 0) : message réseau, Réessayer", () => {
    const view = describeDownloadError({ status: 0 });
    expect(view.message).toMatch(/injoignable/i);
    expect(view.retry).toBe(true);
  });
});

/* ─── Arrêt du poll quand plus rien n'est actif ─────────────────────────── */

describe("shouldPollDownloads — sondage UNIQUEMENT tant qu'un transfert est vivant", () => {
  it("sonde si `active` est renseigné", () => {
    expect(shouldPollDownloads({ active: "chatterbox", tasks: [] })).toBe(true);
  });

  it("sonde si une tâche `queued` existe (file d'attente)", () => {
    expect(shouldPollDownloads({ active: null, tasks: [{ status: "queued" }] })).toBe(true);
  });

  it("sonde pour downloading/verifying", () => {
    for (const status of ["downloading", "verifying"]) {
      expect(shouldPollDownloads({ active: null, tasks: [{ status }] }), status).toBe(true);
    }
  });

  it("ARRÊTE le poll dès que toutes les tâches sont terminales", () => {
    expect(
      shouldPollDownloads({
        active: null,
        tasks: [
          { status: "done" },
          { status: "failed" },
          { status: "interrupted" },
          { status: "cancelled" },
        ],
      }),
    ).toBe(false);
    expect(shouldPollDownloads({ active: null, tasks: [] })).toBe(false);
    expect(shouldPollDownloads({ active: "", tasks: [] })).toBe(false);
  });

  it("rapport absent → pas de poll", () => {
    expect(shouldPollDownloads(null)).toBe(false);
    expect(shouldPollDownloads(undefined)).toBe(false);
  });

  it("intervalle de poll raisonnable (~1 s), jamais une requête longue", () => {
    expect(TTS_DOWNLOAD_POLL_MS).toBeGreaterThanOrEqual(500);
    expect(TTS_DOWNLOAD_POLL_MS).toBeLessThanOrEqual(2000);
  });
});
