import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadEnv } from "../../src/config/env.js";
import { inspectMountPoints, mountPoints } from "../../src/config/paths.js";
import { createServer, startServer } from "../../src/gateway/server.js";
import { detectGpus } from "../../src/gpu/detect.js";
import { runGate } from "../../src/gpu/gate.js";
import { loadCompatManifest, loadProfiles } from "../../src/gpu/profiles.js";
import { createLogger } from "../../src/observability/logger.js";

const profiles = loadProfiles();
const manifest = loadCompatManifest();
const env = loadEnv({ YUKI_GPU_FIXTURE: "tests/fixtures/gpu/rtx4070-12g.txt", YUKI_LOG_LEVEL: "error" });
const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
const detection = detectGpus({
  command: env.gpuCmd,
  fixture: env.gpuFixture,
  commandFromEnv: env.gpuCmdFromEnv,
  cwd: process.cwd(),
});
const gate = runGate(
  {
    config: { compatMode: "strict" as const, profile: null, minDriver: 580 },
    profiles,
    manifest,
    detection,
  },
  logger,
);

const server = createServer({
  env,
  report: gate.report,
  gatePassed: gate.passed,
  startedAt: Date.now(),
  volumes: inspectMountPoints(mountPoints(env)),
});

let baseUrl = "";

beforeAll(async () => {
  const address = await startServer(server, "127.0.0.1", 0);
  baseUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
});

describe("UI statique servie par le gateway", () => {
  it("GET / sert index.html avec des en-têtes sûrs", async () => {
    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    const body = await response.text();
    expect(body).toContain("<title>Yuki</title>");
    expect(body).toContain("/ui/app.js");
    // Lien vers la configuration (aller) — le retour est testé sur /config.
    expect(body).toContain('href="/config"');
  });

  it("GET /ui/app.js et /ui/styles.css servent les assets", async () => {
    const app = await fetch(`${baseUrl}/ui/app.js`);
    expect(app.status).toBe(200);
    expect(app.headers.get("content-type")).toContain("javascript");

    const css = await fetch(`${baseUrl}/ui/styles.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
  });

  it("GET /config sert la page de configuration avec des en-têtes sûrs", async () => {
    const response = await fetch(`${baseUrl}/config`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    const body = await response.text();
    expect(body).toContain("Configuration");
    expect(body).toContain("/ui/config.js");
    // Retour explicite vers la discussion (demande utilisateur).
    expect(body).toContain("Retour à la discussion");
    expect(body).toMatch(/href="\/"[^>]*>[^<]*Retour à la discussion/);
    // Bouton de redémarrage présent, sans dépendance à la politique Docker.
    expect(body).toContain('id="restart"');
    expect(body).toContain("redémarre en interne");
    expect(body).toContain("le conteneur reste en place");
  });

  it("la CSP de /config autorise ce dont la page a besoin, sans unsafe-inline", async () => {
    const response = await fetch(`${baseUrl}/config`);
    const csp = response.headers.get("content-security-policy") ?? "";
    // Aucune directive réellement utilisée par la page ne doit manquer.
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("img-src 'self'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
    // La page n'utilise NI script NI style inline : pas besoin d'échappatoire.
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("GET /ui/config.js et /ui/config.css servent les assets de configuration", async () => {
    const js = await fetch(`${baseUrl}/ui/config.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");
    // Le script sait demander le redémarrage et sondre `/health/live` au retour.
    const jsBody = await js.text();
    expect(jsBody).toContain("/api/admin/restart");
    expect(jsBody).toContain("/health/live");

    const css = await fetch(`${baseUrl}/ui/config.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
  });

  it("organise /config en 5 onglets accessibles (tablist ↔ tabpanels appariés)", async () => {
    const body = await (await fetch(`${baseUrl}/config`)).text();

    // Barre d'onglets accessible.
    expect(body).toContain('role="tablist"');
    expect(body).toMatch(/role="tablist"[^>]*aria-label="/);

    // Les 5 libellés d'onglets validés, dans l'ordre, portés par des role="tab".
    const tabLabels = [...body.matchAll(/<button[^>]*role="tab"[^>]*>\s*([^<]+)/g)].map((m) => m[1].trim());
    expect(tabLabels).toEqual(["Modèles", "Conversation", "Voix", "Système", "Maintenance"]);

    // Appariement : chaque role="tab" (id + aria-controls + aria-selected +
    // tabindex) référence un role="tabpanel" qui le référence en retour
    // (aria-labelledby).
    const tabTags = [...body.matchAll(/<button[^>]*role="tab"[^>]*>/g)].map((m) => m[0]);
    const panelTags = [...body.matchAll(/<section[^>]*role="tabpanel"[^>]*>/g)].map((m) => m[0]);
    expect(tabTags.length).toBe(5);
    expect(panelTags.length).toBe(5);
    for (const tag of tabTags) {
      const id = tag.match(/id="([^"]+)"/)?.[1];
      const controls = tag.match(/aria-controls="([^"]+)"/)?.[1];
      expect(id, tag).toBeTruthy();
      expect(controls, tag).toBeTruthy();
      expect(tag).toContain('aria-selected=');
      expect(tag).toMatch(/tabindex="(-1|0)"/);
      const panel = panelTags.find((p) => p.includes(`id="${controls}"`));
      expect(panel, `panneau ${controls}`).toBeTruthy();
      expect(panel).toContain(`aria-labelledby="${id}"`);
      expect(panel).toContain('tabindex="0"');
    }

    // Rendu EAGER : les conteneurs de groupes des 5 onglets existent dans le
    // markup (les lignes sont construites côté JS au chargement).
    for (const id of ["group-modeles", "group-conversation", "group-voix", "group-systeme"]) {
      expect(body).toContain(`id="${id}"`);
    }

    // Un SEUL enregistrement global, dans une barre persistante (sticky), avec
    // un indicateur « modifications non enregistrées ».
    expect(body.match(/id="save"/g)?.length).toBe(1);
    expect(body).toContain("config-actions--sticky");
    expect(body).toContain('id="save-dirty"');
    expect(body).toContain("Modifications non enregistrées");

    // Les ids historiques restent présents (tests/E2E s'y appuient).
    for (const id of ["groups", "voices-root", "applied", "restart", "availability", "global-error"]) {
      expect(body).toContain(`id="${id}"`);
    }

    // CSP : toujours aucun style inline dans le markup des onglets.
    expect(body).not.toMatch(/\sstyle=/);
  });

  it("HEAD / répond sans corps", async () => {
    const response = await fetch(`${baseUrl}/`, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  it("refuse la traversée de répertoire", async () => {
    // `%2e%2e` n'est pas normalisé par URL : la route doit refuser.
    const response = await fetch(`${baseUrl}/ui/%2e%2e/%2e%2e/package.json`);
    expect(response.status).toBe(404);
  });

  it("rejette les méthodes non GET/HEAD", async () => {
    const response = await fetch(`${baseUrl}/`, { method: "POST" });
    expect(response.status).toBe(405);
  });
});

describe("Thème à deux axes (famille × mode) — assets et markup", () => {
  it("sert /ui/themes.css, /ui/theme.js et la brique modale vendorisée, CSP inchangée", async () => {
    for (const path of ["/ui/themes.css", "/ui/theme.js", "/ui/vendor/holaf/holaf-modal.css"]) {
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("content-type"), path).toContain(path.endsWith(".css") ? "text/css" : "javascript");
      // La CSP des assets statiques est identique à celle des pages.
      expect(response.headers.get("content-security-policy"), path).toContain("style-src 'self'");
      expect(response.headers.get("content-security-policy"), path).not.toContain("unsafe-inline");
    }
  });

  it("pose le thème par défaut en dur dans le markup des deux pages (anti-flash)", async () => {
    for (const path of ["/", "/config"]) {
      const body = await (await fetch(`${baseUrl}${path}`)).text();
      // Premier paint correct sans script inline (CSP script-src 'self') :
      // data-theme est écrit dans la balise <html> elle-même.
      expect(body, path).toMatch(/<html lang="fr" data-theme="indigo-dark">/);
    }
  });

  it("propose les 5 familles, sans option « Système », sur les deux pages", async () => {
    for (const path of ["/", "/config"]) {
      const body = await (await fetch(`${baseUrl}${path}`)).text();
      // Le select devient le sélecteur de FAMILLE (id + name explicites).
      expect(body, path).toContain('id="theme-family" name="theme-family"');
      for (const slug of ["indigo", "midnight", "slate", "emerald", "amber"]) {
        expect(body, path).toContain(`<option value="${slug}">`);
      }
      // Plus de mode « Système » DANS LE SÉLECTEUR DE THÈME — le mot est
      // désormais un ONGLET légitime de /config : on isole le <select>.
      const familySelect = body.match(/<select[^>]*id="theme-family"[\s\S]*?<\/select>/)?.[0] ?? "";
      expect(familySelect, path).not.toContain("Système");
      expect(body, path).not.toContain('id="theme-select"');
      // Le bouton garde son id et expose son état de bascule.
      expect(body, path).toContain('id="theme-toggle"');
      expect(body, path).toMatch(/id="theme-toggle"[^>]*aria-pressed="true"/);
    }
  });

  it("themes.css décrit exactement les 10 presets <famille>-<mode>", async () => {
    const css = await (await fetch(`${baseUrl}/ui/themes.css`)).text();
    const names = [
      "indigo-light", "indigo-dark",
      "midnight-light", "midnight-dark",
      "slate-light", "slate-dark",
      "emerald-light", "emerald-dark",
      "amber-light", "amber-dark",
    ];
    for (const name of names) {
      expect(css).toContain(`:root[data-theme="${name}"]`);
    }
    // Plus aucun nom de l'ancien modèle plat comme sélecteur.
    for (const legacy of ["dark", "light", "midnight", "slate"]) {
      expect(css).not.toContain(`:root[data-theme="${legacy}"]`);
    }
    // Le mode « système » n'existe plus : aucun @media prefers-color-scheme.
    expect(css).not.toContain("prefers-color-scheme");
    // Chaque preset pose son color-scheme (contrôles natifs cohérents).
    expect(css.match(/color-scheme: (light|dark);/g)?.length).toBe(10);
  });

  it("theme.js ne suit plus l'OS et migre les anciennes valeurs sur la même clé", async () => {
    const js = await (await fetch(`${baseUrl}/ui/theme.js`)).text();
    // Suppression du suivi système.
    expect(js).not.toContain("matchMedia");
    expect(js).not.toContain("prefers-color-scheme");
    // Même clé de stockage + migration silencieuse des anciens noms plats.
    expect(js).toContain('"yuki-theme"');
    expect(js).toContain('["dark", "indigo-dark"]');
    expect(js).toContain('["light", "indigo-light"]');
    expect(js).toContain('["midnight", "midnight-dark"]');
    expect(js).toContain('["slate", "slate-dark"]');
    // Le défaut est aligné sur le markup.
    expect(js).toContain('DEFAULT_PRESET = "indigo-dark"');
  });

  it("la copie vendorisée d'HolafModal est bien la 0.5.0 (catalogue 2 axes)", async () => {
    const manifest = await (await fetch(`${baseUrl}/ui/vendor/holaf/holaf-manifest.json`)).json();
    expect(manifest).toEqual({ fetch: "0.2.0", modal: "0.5.0" });
    const css = await (await fetch(`${baseUrl}/ui/vendor/holaf/holaf-modal.css`)).text();
    // Le CSS externe de la brique (extrait de getCss()) est bien servi.
    expect(css).toContain(".holaf-modal-overlay");
  });
});

describe("UI TTS (Lot C) — assets, contrôle topbar et panneau des voix", () => {
  it("sert les modules ES audio/voix", async () => {
    for (const path of [
      "/ui/tts-frames.js",
      "/ui/tts-player.js",
      "/ui/tts-preference.js",
      "/ui/voices-panel.js",
    ]) {
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("content-type"), path).toContain("javascript");
      expect(response.headers.get("content-security-policy"), path).not.toContain(
        "unsafe-inline",
      );
    }
  });

  it("pose le contrôle voix dans la topbar (aria pressé, aucun style inline)", async () => {
    const body = await (await fetch(`${baseUrl}/`)).text();
    expect(body).toContain('id="tts-toggle"');
    expect(body).toMatch(/id="tts-toggle"[^>]*aria-pressed=/);
    expect(body).toContain('id="tts-status"');
    // CSP : pas de balise <audio> ni de style inline dans le markup.
    expect(body).not.toMatch(/<audio\b/);
    expect(body).not.toMatch(/\sstyle=/);
  });

  it("app.js reçoit les trames binaires et les décode (binaryType arraybuffer)", async () => {
    const js = await (await fetch(`${baseUrl}/ui/app.js`)).text();
    expect(js).toContain('socket.binaryType = "arraybuffer"');
    expect(js).toContain("decodeTtsFrame");
    expect(js).toContain("createTtsPlayer");
    // Aucune balise audio (la lecture passe par Web Audio).
    expect(js).not.toMatch(/new Audio\(|<audio/);
  });

  it("monte le panneau des voix sur /config (racine + appel /api/voices)", async () => {
    const body = await (await fetch(`${baseUrl}/config`)).text();
    expect(body).toContain('id="voices-root"');
    const js = await (await fetch(`${baseUrl}/ui/config.js`)).text();
    expect(js).toContain("initVoicesPanel");
    const panel = await (await fetch(`${baseUrl}/ui/voices-panel.js`)).text();
    expect(panel).toContain("/api/voices");
    expect(panel).toContain("/api/voices/clone");
    // Aucune `window.confirm` : confirmations par HolafModal.
    expect(panel).not.toContain("window.confirm");
  });
});

describe("Assistant de mise en route du TTS (Lot 8)", () => {
  it("sert les assets de l'assistant et les référence depuis /config", async () => {
    const js = await fetch(`${baseUrl}/ui/tts-assistant.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");
    expect(js.headers.get("content-security-policy")).not.toContain("unsafe-inline");

    const css = await fetch(`${baseUrl}/ui/tts-assistant.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");

    const body = await (await fetch(`${baseUrl}/config`)).text();
    // Conteneur de montage (composant autonome monté par id) + feuille de style.
    expect(body).toContain('id="tts-assistant-root"');
    expect(body).toContain("/ui/tts-assistant.css");
    // La structure d'onglets et les ids existants restent intacts.
    expect(body).toContain('id="voices-root"');
    expect(body).toContain('id="panel-voix"');
    // CSP : toujours aucun style inline dans le markup.
    expect(body).not.toMatch(/\sstyle=/);
  });

  it("config.js monte l'assistant (id) et lui délègue le redémarrage existant", async () => {
    const js = await (await fetch(`${baseUrl}/ui/config.js`)).text();
    expect(js).toContain("initTtsAssistant");
    expect(js).toContain('getElementById("tts-assistant-root")');
    // Le redémarrage reste centralisé côté config.js (logique existante).
    expect(js).toContain("requestGatewayRestart");
  });

  it("l'assistant ne parle au moteur QUE via les routes du gateway", async () => {
    const js = await (await fetch(`${baseUrl}/ui/tts-assistant.js`)).text();
    for (const route of [
      "/api/tts/status",
      "/api/tts/models",
      "/api/tts/test",
      "/api/tts/engine-config",
      "/api/tts/engine-config/revert",
      "/api/tts/capabilities",
    ]) {
      expect(js).toContain(route);
    }
    expect(js).toContain("/api/config");
    // Aucun accès direct au moteur (port 8081) ni au socket Docker.
    expect(js).not.toContain("8081");
    expect(js).not.toContain("docker.sock");
    // Aucune `window.confirm` (HolafModal) ni `innerHTML` (XSS/CSP).
    expect(js).not.toContain("window.confirm");
    expect(js).not.toContain("innerHTML");
    // La lecture audio reste Web Audio (jamais de balise <audio> créée).
    expect(js).not.toContain("new Audio(");
    expect(js).not.toMatch(/createElement\(["']audio/);
  });
});

describe("Configuration du moteur — éditeur structuré (Lot 9)", () => {
  it("sert la logique pure et l'importe depuis l'assistant", async () => {
    const patch = await fetch(`${baseUrl}/ui/engine-config-patch.js`);
    expect(patch.status).toBe(200);
    expect(patch.headers.get("content-type")).toContain("javascript");
    expect(patch.headers.get("content-security-policy")).not.toContain("unsafe-inline");

    const assistant = await (await fetch(`${baseUrl}/ui/tts-assistant.js`)).text();
    expect(assistant).toContain('from "./engine-config-patch.js"');
    // Le navigateur n'envoie JAMAIS le fichier complet : on envoie un patch.
    expect(assistant).toContain("buildEnginePatch");
    expect(assistant).toContain('fetchApi.put("/api/tts/engine-config"');
  });

  it("le bloc manuel ne prétend plus deux actions ni un dossier en lecture seule", async () => {
    const js = await (await fetch(`${baseUrl}/ui/tts-assistant.js`)).text();
    expect(js).not.toContain("Deux actions ne peuvent PAS");
    expect(js).not.toContain("LECTURE SEULE pour le conteneur");
    // L'honnêteté sur l'étape suivante (téléchargement) est explicite.
    expect(js).toMatch(/étapes suivante|étape suivante/);
    expect(js).toContain("Annuler la dernière modification");
    expect(js).toContain("Configuration du moteur");
  });

  it("aucun style inline dans l'assistant enrichi (CSP stricte)", async () => {
    const css = await (await fetch(`${baseUrl}/ui/tts-assistant.css`)).text();
    // Les classes du nouvel éditeur sont bien servies par la feuille dédiée.
    for (const cls of [
      ".tts-engine-config__input",
      ".tts-engine-config__model",
      ".tts-engine-config__badge--warn",
    ]) {
      expect(css).toContain(cls);
    }
    const assistant = await (await fetch(`${baseUrl}/ui/tts-assistant.js`)).text();
    // Aucun style inline posé depuis le JS (le seul CSS vit dans la feuille servie).
    expect(assistant).not.toContain(".style.");
    expect(assistant).not.toContain('setAttribute("style"');
  });
});
