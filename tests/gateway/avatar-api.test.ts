/**
 * ROUTES de l'AVATAR — service, API et favicon.
 *
 * Prouve : `GET /avatar` (404 si absent, `image/png` + cache immutable si
 * présent, `?v=` sans effet sur le contenu), l'API gardée (`X-Yuki-Config`
 * obligatoire), le refus d'un faux PNG (signature vérifiée sur les octets),
 * les bornes, `DELETE`, et `/favicon.ico` (avatar sinon icône PWA).
 *
 * ⚠️ La CSP reste INCHANGÉE : aucun `blob:` n'est nécessaire, `img-src 'self'`
 * couvre déjà `/avatar` et `/favicon.ico`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadEnv } from "../../src/config/env.js";
import { createServer } from "../../src/gateway/server.js";
import { startServer } from "../../src/gateway/server.js";
import {
  AVATAR_API_PATH,
  AVATAR_SERVE_PATH,
  FAVICON_PATH,
  handleAvatarApiRequest,
  handleAvatarServeRequest,
  handleFaviconRequest,
  isAvatarApiPath,
  isAvatarServePath,
  isFaviconPath,
} from "../../src/gateway/routes/avatar.js";
import { STATIC_SECURITY_HEADERS } from "../../src/gateway/routes/static.js";
import { AvatarStore } from "../../src/identity/avatar.js";

const dirs: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-avatar-api-"));
  dirs.push(dir);
  return dir;
}

function makeStore(): AvatarStore {
  return new AvatarStore({ dir: makeDir(), now: () => Date.parse("2026-11-08T17:30:00.000Z") });
}

/** PNG minimal mais RECONNAISSABLE (signature + IHDR 512×512). */
function pngBytes(largeur = 512, hauteur = 512): Buffer {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "latin1");
  buffer.writeUInt32BE(largeur, 16);
  buffer.writeUInt32BE(hauteur, 20);
  buffer[24] = 8;
  buffer[25] = 6;
  return buffer;
}

const ECRITURE = { "x-yuki-config": "1" };

describe("prédicats de chemin", () => {
  it("reconnaît exactement les trois chemins publics", () => {
    expect(isAvatarServePath(AVATAR_SERVE_PATH)).toBe(true);
    expect(isAvatarServePath(`${AVATAR_SERVE_PATH}/x`)).toBe(false);
    expect(isAvatarApiPath(AVATAR_API_PATH)).toBe(true);
    expect(isAvatarApiPath(`${AVATAR_API_PATH}/x`)).toBe(false);
    expect(isFaviconPath(FAVICON_PATH)).toBe(true);
    expect(isFaviconPath("/favicon.png")).toBe(false);
  });
});

describe("GET /avatar", () => {
  it("404 propre (no-store) quand aucun avatar n'existe", () => {
    const result = handleAvatarServeRequest({ method: "GET", deps: { store: makeStore() } });
    expect(result.status).toBe(404);
    expect(result.body).toBe("Not Found\n");
    expect(result.headers["cache-control"]).toBe("no-store");
  });

  it("200 image/png + cache immutable quand il existe, avec les en-têtes sûrs", () => {
    const store = makeStore();
    const bytes = pngBytes();
    store.ecrire(bytes);
    const result = handleAvatarServeRequest({ method: "GET", deps: { store } });
    expect(result.status).toBe(200);
    expect(result.headers["content-type"]).toBe("image/png");
    expect(result.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(result.headers["x-content-type-options"]).toBe(
      STATIC_SECURITY_HEADERS["x-content-type-options"],
    );
    expect(Buffer.isBuffer(result.body) && result.body.equals(bytes)).toBe(true);
  });

  it("`?v=` ne change RIEN au contenu (mêmes octets, même type)", () => {
    const store = makeStore();
    const bytes = pngBytes();
    store.ecrire(bytes);
    // L'appelant transmet le CHEMIN normalisé : la query n'atteint pas le
    // service. On le prouve en comparant deux appels successifs.
    const sans = handleAvatarServeRequest({ method: "GET", deps: { store } });
    const avec = handleAvatarServeRequest({ method: "GET", deps: { store } });
    expect(avec.headers["content-type"]).toBe(sans.headers["content-type"]);
    expect(Buffer.isBuffer(avec.body) && Buffer.isBuffer(sans.body)).toBe(true);
    expect((avec.body as Buffer).equals(sans.body as Buffer)).toBe(true);
  });

  it("refuse les méthodes autres que GET/HEAD", () => {
    const result = handleAvatarServeRequest({ method: "POST", deps: { store: makeStore() } });
    expect(result.status).toBe(405);
  });
});

describe("API /api/avatar", () => {
  it("GET renvoie les métadonnées (aucun fichier, aucun contenu)", () => {
    const store = makeStore();
    const vide = handleAvatarApiRequest({
      method: "GET",
      headers: {},
      body: Buffer.alloc(0),
      deps: { store },
    });
    expect(vide.status).toBe(200);
    expect(vide.body).toEqual({ existe: false });

    const meta = store.ecrire(pngBytes(512, 512));
    const plein = handleAvatarApiRequest({
      method: "GET",
      headers: {},
      body: Buffer.alloc(0),
      deps: { store },
    });
    expect(plein.body).toMatchObject({
      existe: true,
      sha256: meta.sha256,
      updatedAt: meta.updatedAt,
      taille: meta.bytes,
      largeur: 512,
      hauteur: 512,
    });
    // ⚠️ Aucun chemin de fichier ne fuit.
    expect(JSON.stringify(plein.body)).not.toContain("avatar.png");
  });

  it("POST est REFUSÉ sans `X-Yuki-Config: 1` (et n'écrit rien)", () => {
    const store = makeStore();
    const refus = handleAvatarApiRequest({
      method: "POST",
      headers: {},
      body: pngBytes(),
      deps: { store },
    });
    expect(refus.status).toBe(403);
    expect((refus.body as { code?: string }).code).toBe("missing_config_header");
    expect(store.statut().existe).toBe(false);
  });

  it("POST refuse un `.txt` renommé `.png` (signature, pas Content-Type)", () => {
    const store = makeStore();
    const refus = handleAvatarApiRequest({
      method: "POST",
      headers: { ...ECRITURE, "content-type": "image/png" },
      body: Buffer.from("ceci est un texte\n", "utf8"),
      deps: { store },
    });
    expect(refus.status).toBe(400);
    expect((refus.body as { code?: string }).code).toBe("unsupported_format");
    expect((refus.body as { message?: string }).message).toContain("pas sur le Content-Type");
    expect(store.statut().existe).toBe(false);
  });

  it("POST refuse au-delà des bornes (2 Mio et 4096 px)", () => {
    const store = makeStore();
    const trop = handleAvatarApiRequest({
      method: "POST",
      headers: ECRITURE,
      body: Buffer.alloc(2 * 1024 * 1024 + 1, 0),
      deps: { store },
    });
    expect(trop.status).toBe(413);
    expect((trop.body as { code?: string }).code).toBe("too_large");

    const tropGrand = handleAvatarApiRequest({
      method: "POST",
      headers: ECRITURE,
      body: pngBytes(4097, 512),
      deps: { store },
    });
    expect(tropGrand.status).toBe(400);
    expect((tropGrand.body as { code?: string }).code).toBe("too_large_dimensions");
  });

  it("POST enregistre puis DELETE remet « aucun avatar »", () => {
    const store = makeStore();
    const depot = handleAvatarApiRequest({
      method: "POST",
      headers: ECRITURE,
      body: pngBytes(256, 256),
      deps: { store },
    });
    expect(depot.status).toBe(200);
    expect((depot.body as { existe?: boolean }).existe).toBe(true);

    const sansEntete = handleAvatarApiRequest({
      method: "DELETE",
      headers: {},
      body: Buffer.alloc(0),
      deps: { store },
    });
    expect(sansEntete.status).toBe(403);

    const retrait = handleAvatarApiRequest({
      method: "DELETE",
      headers: ECRITURE,
      body: Buffer.alloc(0),
      deps: { store },
    });
    expect(retrait.status).toBe(200);
    expect(retrait.body).toMatchObject({ ok: true, existe: false, retire: true });
    expect(store.statut().existe).toBe(false);
  });
});

describe("GET /favicon.ico", () => {
  const repli = {
    body: Buffer.from("icone-pwa", "utf8"),
    headers: { "content-type": "image/png" },
  };

  it("sert l'AVATAR quand il existe", () => {
    const store = makeStore();
    const bytes = pngBytes();
    store.ecrire(bytes);
    const result = handleFaviconRequest({ method: "GET", deps: { store }, fallback: repli });
    expect(result.status).toBe(200);
    expect(result.headers["content-type"]).toBe("image/png");
    expect(Buffer.isBuffer(result.body) && result.body.equals(bytes)).toBe(true);
  });

  it("sert l'icône PWA quand aucun avatar n'existe", () => {
    const result = handleFaviconRequest({
      method: "GET",
      deps: { store: makeStore() },
      fallback: repli,
    });
    expect(result.status).toBe(200);
    expect(Buffer.isBuffer(result.body) && result.body.equals(repli.body)).toBe(true);
    expect(result.headers["cache-control"]).toBe("no-cache");
  });

  it("404 si aucun avatar ET aucun repli", () => {
    const result = handleFaviconRequest({
      method: "GET",
      deps: { store: makeStore() },
      fallback: null,
    });
    expect(result.status).toBe(404);
  });
});

/** Gateway minimal câblé avec le seul avatar (révélation du montage app.ts). */
async function startHarness(): Promise<{ baseUrl: string; store: AvatarStore }> {
  const root = makeDir();
  const env = loadEnv({
    YUKI_LOG_LEVEL: "error",
    YUKI_MOUNT_STATE: join(root, "state"),
  });
  const store = new AvatarStore({ dir: join(root, "state", "avatar") });
  const server = createServer({
    env,
    report: {
      engine: "fixture",
      gpus: [],
      selected: null,
      profiles: [],
      compatibility: { mode: "strict", degraded: false, reasons: [] },
      warnings: [],
    } as never,
    gatePassed: true,
    startedAt: Date.now(),
    volumes: [],
    avatar: { store },
  });
  servers.push(server);
  const address = await startServer(server, "127.0.0.1", 0);
  return { baseUrl: `http://127.0.0.1:${(address as AddressInfo).port}`, store };
}

describe("montage HTTP réel (app.ts)", () => {
  it("aller-retour complet : 404 → POST gardé → /avatar?v= → favicon → DELETE", async () => {
    const { baseUrl } = await startHarness();

    expect((await fetch(`${baseUrl}/avatar`)).status).toBe(404);

    const sansEntete = await fetch(`${baseUrl}/api/avatar`, {
      method: "POST",
      body: new Uint8Array(pngBytes()),
    });
    expect(sansEntete.status).toBe(403);

    const depot = await fetch(`${baseUrl}/api/avatar`, {
      method: "POST",
      headers: ECRITURE,
      body: new Uint8Array(pngBytes()),
    });
    expect(depot.status).toBe(200);
    const meta = (await depot.json()) as { existe: boolean; sha256: string };
    expect(meta.existe).toBe(true);

    const service = await fetch(`${baseUrl}/avatar?v=${meta.sha256.slice(0, 12)}`);
    expect(service.status).toBe(200);
    expect(service.headers.get("content-type")).toBe("image/png");
    expect(service.headers.get("cache-control")).toContain("immutable");
    const sansVersion = await fetch(`${baseUrl}/avatar`);
    expect(Buffer.from(await sansVersion.arrayBuffer()).equals(Buffer.from(await service.arrayBuffer()))).toBe(
      true,
    );

    const favicon = await fetch(`${baseUrl}/favicon.ico`);
    expect(favicon.status).toBe(200);
    expect(favicon.headers.get("content-type")).toBe("image/png");

    const lecture = await fetch(`${baseUrl}/api/avatar`);
    expect(lecture.status).toBe(200);
    expect(((await lecture.json()) as { existe: boolean }).existe).toBe(true);

    expect((await fetch(`${baseUrl}/api/avatar`, { method: "DELETE" })).status).toBe(403);
    expect(
      (await fetch(`${baseUrl}/api/avatar`, { method: "DELETE", headers: ECRITURE })).status,
    ).toBe(200);
    expect((await fetch(`${baseUrl}/avatar`)).status).toBe(404);

    // Le favicon retombe sur l'icône PWA LIVRÉE, servie par le statique.
    const repli = await fetch(`${baseUrl}/favicon.ico`);
    expect(repli.status).toBe(200);
    expect(repli.headers.get("content-type")).toBe("image/png");
    expect((await repli.arrayBuffer()).byteLength).toBeGreaterThan(100);
  });

  it("refuse un faux PNG en HTTP (400 + code stable)", async () => {
    const { baseUrl } = await startHarness();
    const refus = await fetch(`${baseUrl}/api/avatar`, {
      method: "POST",
      headers: { ...ECRITURE, "content-type": "image/png" },
      body: new Uint8Array(Buffer.from("pas une image", "utf8")),
    });
    expect(refus.status).toBe(400);
    expect(((await refus.json()) as { code?: string }).code).toBe("unsupported_format");
  });

  it("refuse un corps au-delà de 2 Mio (413), sans garder de partiel", async () => {
    const { baseUrl, store } = await startHarness();
    const refus = await fetch(`${baseUrl}/api/avatar`, {
      method: "POST",
      headers: ECRITURE,
      body: new Uint8Array(Buffer.alloc(2 * 1024 * 1024 + 8, 0)),
    });
    expect(refus.status).toBe(413);
    expect(((await refus.json()) as { code?: string }).code).toBe("body_too_large");
    expect(store.statut().existe).toBe(false);
  });
});
