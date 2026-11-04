/**
 * MIGRATION `sources.json` **v1 → v2** (lot 26).
 *
 * ⚠️ C'est le point le plus DANGEREUX du lot : le fichier vit sur le volume
 * `state` de PRODUCTION. Une migration fausse = les déclencheurs de l'utilisateur
 * PERDUS.
 *
 * Ce qui est verrouillé ici :
 *  - un fichier v1 réaliste (3 sources, dont une en `notifier: true`) est converti
 *    en **3 enregistrements** conservés, tous en `visibilite: "visible"` (on ne
 *    change pas le comportement existant sans le dire) et `notifier` conservé ;
 *  - la sauvegarde `sources.json.v1.bak` est écrite AVANT, et n'est jamais écrasée ;
 *  - un enregistrement INEXPLOITABLE est conservé verbatim (`invalides`) + journalisé ;
 *  - un fichier déjà en v2 n'est **pas réécrit** (idempotence, octet pour octet).
 *
 * ⚠️ Ces tests échouent sur le code d'origine : `schemaVersion` y vaut 1 et un
 * fichier v1 y est relu sans `visibilite` ni sauvegarde.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SOURCES_STORE_BACKUP_SUFFIX,
  SOURCES_STORE_SCHEMA_VERSION,
  SourcesStore,
} from "../../src/sources/store.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(): { path: string; backup: string; warnings: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "yuki-sources-migration-"));
  dirs.push(dir);
  const path = join(dir, "sources.json");
  return { path, backup: `${path}${SOURCES_STORE_BACKUP_SUFFIX}`, warnings: [] };
}

/** `sources.json` v1 RÉALISTE : trois sources du lot 17. */
const FICHIER_V1 = {
  schemaVersion: 1,
  sources: [
    {
      nom: "veille-matinale",
      consigne: "si rien d'anormal, ne dis rien",
      conversation: "session-ouverte",
      tour: "lancer",
      notifier: true,
      cree: "2026-10-01T07:00:00.000Z",
      maj: "2026-10-02T07:00:00.000Z",
      dernierAppel: "2026-10-02T06:59:00.000Z",
    },
    {
      nom: "mail",
      consigne: "",
      conversation: "source",
      tour: "stocker",
      notifier: false,
      sessionId: "session-dediee",
      cree: "2026-10-03T08:00:00.000Z",
      maj: "2026-10-03T08:00:00.000Z",
    },
    {
      nom: "ci",
      consigne: "ne me préviens que si c'est rouge",
      conversation: "nouvelle",
      tour: "lancer",
      notifier: true,
      cree: "2026-10-04T09:00:00.000Z",
      maj: "2026-10-04T09:00:00.000Z",
    },
  ],
};

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

describe("migration sources.json v1 → v2", () => {
  it("convertit les 3 sources en VISIBLE, conserve notifier et écrit la sauvegarde", () => {
    const { path, backup } = workspace();
    writeJson(path, FICHIER_V1);
    const original = readFileSync(path, "utf8");

    const store = new SourcesStore({ path });

    // ⚠️ AUCUN enregistrement perdu : trois sources.
    expect(store.size).toBe(3);
    const noms = store.list().map((record) => record.nom);
    expect(noms).toEqual(["veille-matinale", "mail", "ci"]);

    for (const record of store.list()) {
      // ⚠️ On ne change PAS le comportement existant sans le dire : tout v1 est visible.
      expect(record.visibilite).toBe("visible");
      expect(record.declencheur).toEqual({ type: "webhook" });
      expect(record.preAutorisations).toEqual([]);
    }
    const veille = store.get("veille-matinale");
    expect(veille?.notifier).toBe(true);
    expect(veille?.destination).toBe("session-ouverte");
    expect(veille?.tour).toBe("lancer");
    expect(veille?.consigne).toBe("si rien d'anormal, ne dis rien");
    // Les champs du lot 17 qu'on ne modélise pas sont CONSERVÉS.
    expect(veille?.dernierAppel).toBe("2026-10-02T06:59:00.000Z");
    expect(store.get("mail")?.sessionId).toBe("session-dediee");
    expect(store.get("mail")?.notifier).toBe(false);

    // La sauvegarde contient le fichier d'ORIGINE, à l'octet près.
    expect(existsSync(backup)).toBe(true);
    expect(readFileSync(backup, "utf8")).toBe(original);
    expect(statSync(backup).mode & 0o777).toBe(0o600);

    // Le fichier réécrit est en v2.
    const written = JSON.parse(readFileSync(path, "utf8")) as {
      schemaVersion: number;
      sources: Array<Record<string, unknown>>;
    };
    expect(written.schemaVersion).toBe(SOURCES_STORE_SCHEMA_VERSION);
    expect(written.sources).toHaveLength(3);
    expect(written.sources[0].visibilite).toBe("visible");
    // L'ancien nom de champ n'est plus écrit.
    expect(written.sources[0].conversation).toBeUndefined();
  });

  it("ne réécrit JAMAIS un fichier déjà en v2 (idempotence, octet pour octet)", () => {
    const { path, backup } = workspace();
    writeJson(path, FICHIER_V1);
    // Première lecture : migration + sauvegarde.
    new SourcesStore({ path });
    const migrated = readFileSync(path, "utf8");
    const backupContent = readFileSync(backup, "utf8");

    // Deuxième lecture : le fichier ne doit PAS bouger.
    const second = new SourcesStore({ path });
    expect(readFileSync(path, "utf8")).toBe(migrated);
    expect(readFileSync(backup, "utf8")).toBe(backupContent);
    expect(second.size).toBe(3);
    expect(second.get("ci")?.visibilite).toBe("visible");
  });

  it("conserve VERBATIM un enregistrement inexploitable et le journalise", () => {
    const { path } = workspace();
    const messages: string[] = [];
    const warn = (message: string) => messages.push(message);
    writeJson(path, {
      schemaVersion: 1,
      sources: [
        ...FICHIER_V1.sources,
        // Sans `nom` : inexploitable, mais il ne doit JAMAIS être jeté.
        { conversation: "courante", tour: "stocker", cree: "2026-10-05T10:00:00.000Z" },
        // Nom hors forme : conservé quand même (c'est à l'utilisateur de corriger).
        { nom: "Nom Bizarre", conversation: "aucune", tour: "stocker", notifier: true },
      ],
    });

    const store = new SourcesStore({ path, logger: { warn } });
    expect(store.size).toBe(4);
    expect(store.get("Nom Bizarre")?.visibilite).toBe("visible");
    // ⚠️ L'enregistrement sans nom est écrit VERBATIM sous `invalides`.
    const written = JSON.parse(readFileSync(path, "utf8")) as {
      invalides?: Array<Record<string, unknown>>;
    };
    expect(written.invalides).toHaveLength(1);
    expect(written.invalides?.[0]).toMatchObject({ conversation: "courante", tour: "stocker" });
    // …et il est journalisé.
    expect(messages).toContain("sources.store.migrate.entry_without_name");
    expect(messages).toContain("sources.store.migrate.entry_name_unexpected");
    expect(messages).toContain("sources.store.migrated");
  });

  it("ne réécrit pas la sauvegarde si elle existe déjà", () => {
    const { path, backup } = workspace();
    writeJson(path, FICHIER_V1);
    // Sauvegarde antérieure (par exemple un fichier v1 d'un autre état) : on n'y touche plus.
    writeFileSync(backup, "sauvegarde-ancienne\n", { mode: 0o600 });
    new SourcesStore({ path });
    expect(readFileSync(backup, "utf8")).toBe("sauvegarde-ancienne\n");
  });

  it("un fichier v1 aux champs vides reçoit les défauts SÛRS, jamais `courante`", () => {
    const { path } = workspace();
    writeJson(path, {
      schemaVersion: 1,
      sources: [{ nom: "ancien", cree: "2026-09-01T00:00:00.000Z", maj: "2026-09-01T00:00:00.000Z" }],
    });
    const store = new SourcesStore({ path });
    const record = store.get("ancien");
    // Une destination inconnue ne doit jamais devenir « la conversation ouverte ».
    expect(record?.destination).toBe("aucune");
    expect(record?.tour).toBe("stocker");
    // Aucun réglage v1 ⇒ pas de comportement historique à préserver ⇒ silencieux.
    expect(record?.visibilite).toBe("silencieux");
    expect(record?.notifier).toBe(false);
  });

  it("persiste le fil « Déclencheurs » partagé et le relit", () => {
    const { path } = workspace();
    writeJson(path, FICHIER_V1);
    const store = new SourcesStore({ path });
    expect(store.getDeclencheursSession()).toBeUndefined();
    store.setDeclencheursSession("session-declencheurs");
    const reread = new SourcesStore({ path });
    expect(reread.getDeclencheursSession()).toBe("session-declencheurs");
    // Et on peut l'oublier (fil supprimé).
    reread.setDeclencheursSession(undefined);
    expect(new SourcesStore({ path }).getDeclencheursSession()).toBeUndefined();
  });
});
