/**
 * ROUTES des FICHIERS — dépôt (`POST /api/files`), liste, suppression et SERVICE
 * same-origin (`/fichiers/<id>.<ext>`).
 *
 * Prouve : l'aller-retour dépôt → service à l'identique, le REFUS explicite
 * au-delà du plafond (413 + message qui dit le plafond), le
 * `Content-Disposition` correct (téléchargement pour tout ce qui n'est pas une
 * image), l'anti-traversée, l'extension qui doit correspondre à la fiche, et la
 * CSP INCHANGÉE (aucun élargissement : `img-src 'self' data:` suffit).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  handleFilesApiRequest,
  handleFilesServeRequest,
  handleFilesUpload,
  isFilesApiPath,
  isFilesServePath,
} from "../../src/gateway/routes/files.js";
import { STATIC_SECURITY_HEADERS } from "../../src/gateway/routes/static.js";
import { FilesService } from "../../src/files/service.js";
import { FilesStore } from "../../src/files/store.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDeps(options: { maxBytes?: number; retentionDays?: number; now?: () => number } = {}): {
  deps: { service: FilesService };
  store: FilesStore;
} {
  const dir = mkdtempSync(join(tmpdir(), "yuki-files-api-"));
  dirs.push(dir);
  const store = new FilesStore({
    dir,
    ...(options.maxBytes !== undefined ? { maxBytes: () => options.maxBytes as number } : {}),
    ...(options.retentionDays !== undefined
      ? { retentionDays: () => options.retentionDays as number }
      : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  store.ensureLayout();
  const service = new FilesService({ store });
  return { deps: { service }, store };
}

async function* body(text: string): AsyncGenerator<Uint8Array> {
  yield new Uint8Array(Buffer.from(text, "utf8"));
}

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("dépôt d'un fichier (POST /api/files)", () => {
  it("accepte un texte, renvoie la vue (sans contenu) et un chemin same-origin", async () => {
    const { deps } = makeDeps();
    const response = await handleFilesUpload({
      headers: { "x-yuki-filename": encodeURIComponent("notes.txt"), "content-type": "text/plain" },
      stream: body("bonjour"),
      deps,
    });
    expect(response.status).toBe(201);
    const file = (response.body as { file: Record<string, unknown> }).file;
    expect(file.name).toBe("notes.txt");
    expect(file.kind).toBe("text");
    expect(file.readable).toBe(true);
    expect(file.url).toBe(`/fichiers/${String(file.id)}.txt`);
    // ⚠️ Aucun contenu dans la réponse HTTP du dépôt.
    expect(JSON.stringify(response.body)).not.toContain("bonjour");
  });

  it("refuse SANS nom (jamais un fichier anonyme)", async () => {
    const { deps } = makeDeps();
    const response = await handleFilesUpload({
      headers: { "content-type": "text/plain" },
      stream: body("x"),
      deps,
    });
    expect(response.status).toBe(400);
    expect((response.body as { code: string }).code).toBe("missing_filename");
  });

  it("REFUS explicite au-delà du plafond : 413, message qui DIT le plafond", async () => {
    const { deps, store } = makeDeps({ maxBytes: 4 });
    const response = await handleFilesUpload({
      headers: { "x-yuki-filename": "gros.txt", "content-type": "text/plain" },
      stream: body("0123456789"),
      deps,
    });
    expect(response.status).toBe(413);
    const payload = response.body as { code: string; message: string; limitBytes: number };
    expect(payload.code).toBe("too_large");
    expect(payload.limitBytes).toBe(4);
    expect(payload.message).toContain("refusé");
    expect(payload.message).toContain("/config");
    // Rien n'a été conservé (ni octets, ni analyse, ni métadonnées).
    expect(store.list()).toEqual([]);
  });
});

describe("service same-origin (/fichiers/<id>.<ext>)", () => {
  it("sert les octets à l'identique avec un TÉLÉCHARGEMENT et les en-têtes sûrs", async () => {
    const { deps, store } = makeDeps();
    const stored = await store.saveBytes(new Uint8Array(Buffer.from("contenu")), {
      name: "../notes.txt",
      mimeType: "text/plain",
      origin: "user",
    });
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    const response = handleFilesServeRequest({
      method: "GET",
      path: `/fichiers/${stored.record.id}.txt`,
      deps,
    });
    expect(response.status).toBe(200);
    expect(Buffer.isBuffer(response.body) && (response.body as Buffer).toString("utf8")).toBe(
      "contenu",
    );
    // Tout ce qui n'est PAS une image est téléchargé, jamais interprété.
    expect(response.headers["content-type"]).toBe("application/octet-stream");
    expect(response.headers["content-disposition"]).toContain("attachment");
    expect(response.headers["content-disposition"]).toContain("notes.txt");
    expect(response.headers["content-disposition"]).toContain("filename*=UTF-8''");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    // ⚠️ CSP INCHANGÉE : aucun élargissement pour les fichiers.
    expect(response.headers["content-security-policy"]).toBe(
      STATIC_SECURITY_HEADERS["content-security-policy"],
    );
    expect(response.headers["content-security-policy"]).toContain("img-src 'self' data:");
  });

  it("sert une image en `image/*` (affichable par `img-src 'self'`)", async () => {
    const { deps, store } = makeDeps();
    const stored = await store.saveBytes(new Uint8Array(PNG), {
      name: "photo.png",
      mimeType: "image/png",
      origin: "user",
    });
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    const response = handleFilesServeRequest({
      method: "GET",
      path: `/fichiers/${stored.record.id}.png`,
      deps,
    });
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.headers["content-disposition"]).toContain("inline");
  });

  it("404 : identifiant inconnu, extension qui ne correspond pas, traversée, méthode", async () => {
    const { deps, store } = makeDeps();
    const stored = await store.saveBytes(new Uint8Array(Buffer.from("x")), {
      name: "f.txt",
      mimeType: "text/plain",
      origin: "user",
    });
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    const id = stored.record.id;

    expect(
      handleFilesServeRequest({ method: "GET", path: `/fichiers/${"a".repeat(32)}.txt`, deps }).status,
    ).toBe(404);
    // L'extension du chemin doit correspondre à la fiche (sinon on servirait un
    // contenu sous un autre type).
    expect(handleFilesServeRequest({ method: "GET", path: `/fichiers/${id}.png`, deps }).status).toBe(
      404,
    );
    expect(
      handleFilesServeRequest({ method: "GET", path: "/fichiers/..%2Fsecret.txt", deps }).status,
    ).toBe(404);
    expect(handleFilesServeRequest({ method: "POST", path: `/fichiers/${id}.txt`, deps }).status).toBe(
      405,
    );
    expect(isFilesServePath("/fichiers/x.txt")).toBe(true);
    expect(isFilesServePath("/api/files")).toBe(false);
  });
});

describe("API de gestion (liste, suppression)", () => {
  it("liste les fichiers d'UNE conversation (métadonnées seules)", async () => {
    const { deps, store } = makeDeps();
    const stored = await store.saveBytes(new Uint8Array(Buffer.from("abc")), {
      name: "a.txt",
      mimeType: "text/plain",
      origin: "user",
      sessionId: "sess-1",
    });
    expect(stored.ok).toBe(true);
    const response = handleFilesApiRequest({
      method: "GET",
      path: "/api/files?session=sess-1",
      headers: {},
      deps,
    });
    expect(response.status).toBe(200);
    const payload = response.body as { files: Array<{ name: string }>; count: number };
    expect(payload.count).toBe(1);
    expect(payload.files[0]?.name).toBe("a.txt");
    expect(JSON.stringify(response.body)).not.toContain("abc");
    // Une session inconnue ne renvoie rien (jamais les fichiers des autres).
    const other = handleFilesApiRequest({
      method: "GET",
      path: "/api/files?session=sess-2",
      headers: {},
      deps,
    });
    expect((other.body as { count: number }).count).toBe(0);
  });

  it("supprime sur demande, puis répond 404 (idempotent, jamais un faux succès)", async () => {
    const { deps, store } = makeDeps();
    const stored = await store.saveBytes(new Uint8Array(Buffer.from("abc")), {
      name: "a.txt",
      mimeType: "text/plain",
      origin: "user",
    });
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    const first = handleFilesApiRequest({
      method: "DELETE",
      path: `/api/files/${stored.record.id}`,
      headers: {},
      deps,
    });
    expect(first.status).toBe(200);
    expect(store.readBytes(stored.record.id)).toBeNull();
    expect(store.readAnalysis(stored.record.id)).toBeNull();
    const second = handleFilesApiRequest({
      method: "DELETE",
      path: `/api/files/${stored.record.id}`,
      headers: {},
      deps,
    });
    expect(second.status).toBe(404);
    expect(isFilesApiPath("/api/files")).toBe(true);
    expect(isFilesApiPath("/api/files/abc")).toBe(true);
    expect(isFilesApiPath("/api/filestore")).toBe(false);
  });
});

describe("rattachement à un message (service)", () => {
  it("produit les marqueurs du message et un bloc BORNÉ pour le modèle", async () => {
    // ⚠️ Horloge STRICTEMENT croissante : deux dépôts faits dans la MÊME
    // milliseconde n'ont AUCUN ordre chronologique (le stockage départage alors
    // par identifiant, ce qui est déterministe mais arbitraire). L'ordre affirmé
    // plus bas est l'ordre de CRÉATION : il faut donc des dates distinctes, sinon
    // la prémisse de l'assertion n'existe pas (elle passait par chance).
    let clock = Date.parse("2026-01-01T00:00:00.000Z");
    const { store } = makeDeps({ maxBytes: 10_000, now: () => (clock += 1) });
    const long = await store.saveBytes(new Uint8Array(Buffer.from("z".repeat(500))), {
      name: "long.txt",
      mimeType: "text/plain",
      origin: "user",
    });
    const pdf = await store.saveBytes(new Uint8Array(Buffer.from("%PDF-1.7")), {
      name: "doc.pdf",
      mimeType: "application/pdf",
      origin: "user",
    });
    expect(long.ok && pdf.ok).toBe(true);
    if (!long.ok || !pdf.ok) return;

    const service = new FilesService({
      store,
      promptChars: () => 50,
      promptTotalChars: () => 60,
    });
    const outcome = service.attach("sess-1", [long.record.id, pdf.record.id]);
    expect(outcome.files).toHaveLength(2);
    expect(outcome.markers).toHaveLength(2);
    expect(outcome.markers[0]).toContain("[fichier]");
    expect(outcome.block).toContain('caracteres_transmis="50"');
    expect(outcome.block).toContain('lu="non"');
    // Le fichier est désormais rattaché à la conversation (liste + envoi par Yuki).
    // ⚠️ Ordre CHRONOLOGIQUE garanti par le stockage (dates distinctes ci-dessus).
    expect(service.listForSession("sess-1").map((file) => file.name)).toEqual([
      "long.txt",
      "doc.pdf",
    ]);
    // Un identifiant inconnu n'est jamais joint en silence.
    expect(service.attach("sess-1", ["f".repeat(32)]).missing).toEqual(["f".repeat(32)]);
  });

  it("applique la borne du nombre de fichiers PAR message", async () => {
    const { store } = makeDeps({ maxBytes: 10_000 });
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const stored = await store.saveBytes(new Uint8Array(Buffer.from(`f${index}`)), {
        name: `f${index}.txt`,
        mimeType: "text/plain",
        origin: "user",
      });
      if (stored.ok) ids.push(stored.record.id);
    }
    const service = new FilesService({ store, maxAttachments: () => 2 });
    const outcome = service.attach("sess-1", ids);
    expect(outcome.files).toHaveLength(2);
    expect(outcome.missing).toEqual([ids[2]]);
  });

  it("Yuki ne peut envoyer qu'un fichier de SA conversation (aucune fuite)", async () => {
    const { store } = makeDeps();
    const stored = await store.saveBytes(new Uint8Array(Buffer.from("secret")), {
      name: "prive.txt",
      mimeType: "text/plain",
      origin: "user",
      sessionId: "sess-autre",
    });
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    const service = new FilesService({ store });
    const sent: string[] = [];
    service.subscribeSent((view) => sent.push(view.name));
    // Mauvais fil : refus (et rien n'est diffusé).
    expect(service.send("sess-1", "prive.txt")).toBeNull();
    expect(service.send("sess-1", stored.record.id)).toBeNull();
    expect(sent).toEqual([]);
    // Bon fil : envoi, diffusion, et le fichier reste téléchargeable.
    const view = service.send("sess-autre", "PRIVE.TXT");
    expect(view?.name).toBe("prive.txt");
    expect(sent).toEqual(["prive.txt"]);
  });
});
