/**
 * RÉSILIENCE DU TEMPS RÉEL — « le bot passe en ABSENT après quelques heures et ne revient
 * JAMAIS » (signalé le 2026-11-18).
 *
 * Ce que ce fichier prouve, et qui manquait :
 *  ① une socket FERMÉE par le serveur est ROUVERTE automatiquement (test central) ;
 *  ② une socket MUETTE (half-open : aucun `close`, aucun message) est DÉTECTÉE par
 *     inactivité, puis rouverte — horloge simulée, aucun réseau ;
 *  ③ le backoff AUGMENTE, PLAFONNE EN DÉLAI, et n'abandonne JAMAIS (20ᵉ tentative encore
 *     programmée) — c'était la cause du « jamais revenu » : `maxAttempts` = 20 arrêtait
 *     toute reconnexion ;
 *  ④ la GIGUE est appliquée (deux bots ne retentent pas au même instant) ;
 *  ⑤ après une reprise, l'adaptateur RELANCE la synchronisation du miroir (les messages
 *     publiés pendant la panne ne sont arrivés par aucune socket) ;
 *  ⑥ une déconnexion VOLONTAIRE n'entraîne AUCUNE reconnexion ;
 *  ⑦ Discord : battement périodique émis, `heartbeat_ack` manquant ⇒ reconnexion ;
 *  ⑧ une réponse `FAIL …` du serveur NE FERME PAS la socket (garde du lot « indicateur de
 *     frappe » conservée) ;
 *  ⑨ l'état EXPOSE « Reconnexion en cours (essai N) » et le motif de la coupure.
 *
 * ⚠️ Aucun réseau sortant : les sockets sont des DOUBLURES pilotées par le test, sauf ⑤
 * qui utilise le serveur fixture Mattermost (coupure réelle d'une vraie socket).
 *
 * ⚠️ Échoue sur le code d'origine : `src/chat/reconnexion.ts` n'existe pas, `status()`
 * n'expose ni `reconnexion` ni `derniereCoupure`, et les deux sockets s'arrêtaient après
 * `maxAttempts` essais.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { MattermostChatAdapter } from "../../src/chat/mattermost/adapter.js";
import { MattermostSocket } from "../../src/chat/mattermost/ws.js";
import { DiscordChatAdapter } from "../../src/chat/discord/adapter.js";
import { DiscordSocket } from "../../src/chat/discord/ws.js";
import {
  PHRASE_SERVEUR_INJOIGNABLE,
  RELANCE_DELAI_MAX_MS,
  SEUIL_ESSAIS_DUREE,
  SuiviConnexion,
  classifierMotif,
  delaiRelance,
  formatDuree,
  libelleReconnexion,
} from "../../src/chat/reconnexion.js";
import { createLogger } from "../../src/observability/logger.js";
import {
  MM_TOKEN,
  openMmMirror,
  startMmFixture,
  waitFor,
} from "./mm-reply-fixture.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Ecouteur = (...args: unknown[]) => void;

/**
 * DOUBLURE de WebSocket : le test PILOTE les événements (aucun réseau, aucune horloge
 * réelle). Elle expose aussi `ping`, pour vérifier la sonde de vie Mattermost.
 */
class FauxSocket {
  readonly frames: string[] = [];
  pings = 0;
  private readonly ecouteurs = new Map<string, Ecouteur[]>();

  on(event: string, listener: Ecouteur): this {
    const liste = this.ecouteurs.get(event) ?? [];
    liste.push(listener);
    this.ecouteurs.set(event, liste);
    return this;
  }

  send(data: string): void {
    this.frames.push(data);
  }

  ping(): void {
    this.pings += 1;
  }

  close(): void {
    // Rien : le test décide s'il y a un `close`.
  }

  terminate(): void {
    // Rien.
  }

  removeAllListeners(): void {
    this.ecouteurs.clear();
  }

  emettre(event: string, ...args: unknown[]): void {
    for (const ecouteur of [...(this.ecouteurs.get(event) ?? [])]) ecouteur(...args);
  }

  /** Réponse d'authentification Mattermost (`{"status":"OK","seq_reply":1}`). */
  authentifierMattermost(): void {
    this.emettre("message", JSON.stringify({ status: "OK", seq_reply: 1 }));
  }
}

/** Fabrique de doublures : garde la LISTE des sockets créées (une par tentative). */
function fabriqueSockets() {
  const sockets: FauxSocket[] = [];
  return {
    sockets,
    create: (): FauxSocket => {
      const socket = new FauxSocket();
      sockets.push(socket);
      return socket;
    },
  };
}

// ─── ①②③④⑥⑧ Mattermost ─────────────────────────────────────────────────────

describe("Mattermost — la socket fermée est ROUVERTE (test central)", () => {
  it("un `close` du serveur programme une reconnexion, puis la connexion revient", async () => {
    vi.useFakeTimers();
    const fabrique = fabriqueSockets();
    const socket = new MattermostSocket({
      baseUrl: () => "http://127.0.0.1:1",
      token: () => "jeton-de-test",
      onEvent: () => undefined,
      createSocket: fabrique.create,
      random: () => 0,
      baseDelayMs: 100,
      maxDelayMs: 400,
      jitterMs: 0,
      battementMs: 60_000,
      inactiviteMs: 120_000,
    });
    cleanups.push(() => socket.stop());

    await socket.start();
    expect(fabrique.sockets).toHaveLength(1);
    fabrique.sockets[0]?.emettre("open");
    fabrique.sockets[0]?.authentifierMattermost();
    expect(socket.status().connecte).toBe(true);

    // ⚠️ Le serveur ferme (redémarrage, proxy, NAT) : AUCUN code ne doit arrêter la boucle.
    fabrique.sockets[0]?.emettre("close", 1006, "");
    const apresCoupure = socket.status();
    expect(apresCoupure.connecte).toBe(false);
    expect(apresCoupure.abandonne).toBe(false);
    // ⑨ l'état DIT qu'une reconnexion est en cours, et POURQUOI.
    expect(apresCoupure.reconnexion?.essai).toBe(1);
    expect(String(apresCoupure.reconnexion?.motif)).toContain("code 1006");
    expect(String(apresCoupure.derniereCoupure)).toContain("code 1006");
    expect(libelleReconnexion(apresCoupure.reconnexion!)).toContain(
      "Reconnexion en cours (essai 1",
    );

    await vi.advanceTimersByTimeAsync(apresCoupure.reconnexion!.dansMs);
    expect(fabrique.sockets).toHaveLength(2);
    fabrique.sockets[1]?.emettre("open");
    fabrique.sockets[1]?.authentifierMattermost();
    expect(socket.status().connecte).toBe(true);
    expect(socket.status().reconnexion).toBeUndefined();
    // ⚠️ Ré-AUTHENTIFICATION réelle : la trame d'authentification est repartie.
    expect(fabrique.sockets[1]?.frames[0]).toContain("authentication_challenge");
  });
});

describe("Mattermost — la socket MUETTE est détectée par inactivité", () => {
  it("aucune trame ⇒ sonde de vie puis reconnexion (horloge simulée)", async () => {
    vi.useFakeTimers();
    const fabrique = fabriqueSockets();
    const socket = new MattermostSocket({
      baseUrl: () => "http://127.0.0.1:1",
      token: () => "jeton-de-test",
      onEvent: () => undefined,
      createSocket: fabrique.create,
      random: () => 0,
      baseDelayMs: 50,
      jitterMs: 0,
      battementMs: 1_000,
      inactiviteMs: 2_000,
    });
    cleanups.push(() => socket.stop());

    await socket.start();
    fabrique.sockets[0]?.emettre("open");
    fabrique.sockets[0]?.authentifierMattermost();
    expect(socket.status().connecte).toBe(true);

    // ⚠️ Half-open : ni `close` ni message. On avance l'horloge SANS rien émettre.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fabrique.sockets[0]?.pings).toBeGreaterThanOrEqual(1);
    expect(socket.status().connecte).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    const muette = socket.status();
    expect(muette.connecte).toBe(false);
    expect(String(muette.reconnexion?.motif)).toContain("Aucune trame");

    await vi.advanceTimersByTimeAsync(muette.reconnexion!.dansMs);
    expect(fabrique.sockets).toHaveLength(2);
  });

  it("un trafic régulier n'est JAMAIS pris pour une socket morte", async () => {
    vi.useFakeTimers();
    const fabrique = fabriqueSockets();
    const socket = new MattermostSocket({
      baseUrl: () => "http://127.0.0.1:1",
      token: () => "jeton-de-test",
      onEvent: () => undefined,
      createSocket: fabrique.create,
      random: () => 0,
      battementMs: 1_000,
      inactiviteMs: 2_000,
    });
    cleanups.push(() => socket.stop());

    await socket.start();
    fabrique.sockets[0]?.emettre("open");
    fabrique.sockets[0]?.authentifierMattermost();

    // Une trame de `typing` (ignorée comme message) reste une PREUVE DE VIE.
    for (let tick = 0; tick < 6; tick += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      fabrique.sockets[0]?.emettre("message", JSON.stringify({ event: "typing", seq: tick }));
    }
    expect(socket.status().connecte).toBe(true);
    expect(fabrique.sockets).toHaveLength(1);
  });
});

describe("③④ backoff : plafonné en délai, jamais en nombre d'essais", () => {
  it("les délais augmentent, plafonnent, et la 20ᵉ tentative est ENCORE programmée", async () => {
    vi.useFakeTimers();
    const delais: number[] = [];
    const tentatives: number[] = [];
    const socket = new MattermostSocket({
      baseUrl: () => "http://127.0.0.1:1",
      token: () => "jeton-de-test",
      onEvent: () => undefined,
      createSocket: () => {
        throw new Error("réseau injoignable");
      },
      random: () => 0,
      baseDelayMs: 1_000,
      maxDelayMs: 4_000,
      jitterMs: 0,
      onStateChange: (status) => {
        if (status.reconnexion !== undefined) {
          delais.push(status.reconnexion.dansMs);
          tentatives.push(status.reconnexion.essai);
        }
      },
    });
    cleanups.push(() => socket.stop());

    await socket.start();
    for (let essai = 0; essai < 25; essai += 1) {
      const reconnexion = socket.status().reconnexion;
      expect(reconnexion, `essai ${essai + 1} programmé`).toBeDefined();
      await vi.advanceTimersByTimeAsync(reconnexion!.dansMs);
    }

    // ③ les trois premiers délais doublent, puis PLAFONNENT à `maxDelayMs`.
    expect(delais.slice(0, 6)).toEqual([1_000, 2_000, 4_000, 4_000, 4_000, 4_000]);
    // ⚠️ Le compteur monte bien au-delà de l'ancien `maxAttempts` (20).
    expect(tentatives[tentatives.length - 1]).toBeGreaterThan(20);
    expect(socket.status().abandonne).toBe(false);
    expect(socket.status().reconnexion).toBeDefined();
  });

  it("④ la GIGUE sépare deux bots qui retentent (jamais la même milliseconde)", () => {
    const a = delaiRelance({ essai: 0, baseDelayMs: 1_000, jitterMs: 250, random: () => 0 });
    const b = delaiRelance({ essai: 0, baseDelayMs: 1_000, jitterMs: 250, random: () => 1 });
    expect(a).toBe(1_000);
    expect(b).toBe(1_250);
    // Le plafond porte sur la CROISSANCE : un essai très élevé ne dépasse pas plafond + gigue.
    const tresLoin = delaiRelance({
      essai: 200,
      baseDelayMs: 1_000,
      maxDelayMs: RELANCE_DELAI_MAX_MS,
      jitterMs: 250,
      random: () => 0,
    });
    expect(tresLoin).toBe(RELANCE_DELAI_MAX_MS);
  });
});

describe("⑥ une déconnexion VOLONTAIRE ne se reconnecte pas", () => {
  it("`stop()` annule la reconnexion, même une fois une coupure survenue", async () => {
    vi.useFakeTimers();
    const fabrique = fabriqueSockets();
    const socket = new MattermostSocket({
      baseUrl: () => "http://127.0.0.1:1",
      token: () => "jeton-de-test",
      onEvent: () => undefined,
      createSocket: fabrique.create,
      random: () => 0,
      baseDelayMs: 100,
      jitterMs: 0,
      battementMs: 60_000,
      inactiviteMs: 120_000,
    });
    cleanups.push(() => socket.stop());

    await socket.start();
    fabrique.sockets[0]?.emettre("open");
    fabrique.sockets[0]?.authentifierMattermost();
    fabrique.sockets[0]?.emettre("close", 1006, "");
    expect(socket.status().reconnexion).toBeDefined();

    // ⚠️ Bouton Stop / plateforme désactivée / `rafraichirBot` : arrêt VOULU.
    await socket.stop();
    expect(socket.status().reconnexion).toBeUndefined();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fabrique.sockets).toHaveLength(1);
    expect(socket.status().abandonne).toBe(false);
  });

  it("`stop()` pendant l'attente du prochain essai n'ouvre AUCUNE socket", async () => {
    vi.useFakeTimers();
    const fabrique = fabriqueSockets();
    const socket = new MattermostSocket({
      baseUrl: () => "http://127.0.0.1:1",
      token: () => "jeton-de-test",
      onEvent: () => undefined,
      createSocket: fabrique.create,
      random: () => 0,
      baseDelayMs: 1_000,
      jitterMs: 0,
      battementMs: 60_000,
      inactiviteMs: 120_000,
    });
    cleanups.push(() => socket.stop());

    await socket.start();
    fabrique.sockets[0]?.emettre("open");
    fabrique.sockets[0]?.authentifierMattermost();
    fabrique.sockets[0]?.emettre("close", 1001, "serveur arrêté");
    await socket.stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fabrique.sockets).toHaveLength(1);
  });
});

describe("⑧ une réponse d'erreur ne ferme PAS la socket (garde conservée)", () => {
  it("un `FAIL` reçu APRÈS l'authentification laisse la connexion vivante", async () => {
    vi.useFakeTimers();
    const fabrique = fabriqueSockets();
    const socket = new MattermostSocket({
      baseUrl: () => "http://127.0.0.1:1",
      token: () => "jeton-de-test",
      onEvent: () => undefined,
      createSocket: fabrique.create,
      random: () => 0,
      battementMs: 60_000,
      inactiviteMs: 120_000,
    });
    cleanups.push(() => socket.stop());

    await socket.start();
    fabrique.sockets[0]?.emettre("open");
    fabrique.sockets[0]?.authentifierMattermost();

    // ⚠️ Certains serveurs répondent `FAIL seq_reply:1` à toute action inconnue
    // (`user_typing`) : cela ne doit JAMAIS passer pour un jeton refusé.
    fabrique.sockets[0]?.emettre(
      "message",
      JSON.stringify({ status: "FAIL", seq_reply: 1, error: { id: "refus" } }),
    );
    expect(socket.status().connecte).toBe(true);
    expect(socket.status().abandonne).toBe(false);
    expect(socket.status().reconnexion).toBeUndefined();
    expect(socket.status().derniereCoupure).toBeUndefined();
  });
});

// ─── ⑤ reprise ⇒ synchronisation du miroir ──────────────────────────────────

describe("⑤ après reconnexion, le miroir est resynchronisé", () => {
  it("une coupure réelle suivie d'une reprise relance la synchronisation", async () => {
    const fixture = await startMmFixture(cleanups);
    const miroir = openMmMirror(cleanups);
    const logger = createLogger({ level: "error", sink: () => {}, secretValues: [MM_TOKEN] });
    const adaptateur = new MattermostChatAdapter({
      baseUrl: () => fixture.baseUrl,
      token: () => MM_TOKEN,
      store: miroir,
      logger,
      // ⚠️ Cadence de sonde courte : le test ne doit pas attendre 90 s d'inactivité.
      battementMs: 1_000,
      inactiviteMs: 2_000,
    });
    cleanups.push(async () => {
      await adaptateur.disconnect().catch(() => undefined);
    });

    await adaptateur.connect();
    await waitFor(() => adaptateur.status().etat === "on", "la connexion temps réel");
    let resynchronisations = 0;
    const original = adaptateur.resynchroniser.bind(adaptateur);
    vi.spyOn(adaptateur, "resynchroniser").mockImplementation(async () => {
      resynchronisations += 1;
      return original();
    });

    fixture.couperConnexions();

    // ⚠️ C'est le cœur du correctif : la socket revient SEULE, et la synchronisation du
    // miroir repart (les messages publiés pendant la coupure ne sont arrivés nulle part).
    await waitFor(() => adaptateur.status().etat === "on", "la reprise automatique");
    await waitFor(() => resynchronisations >= 1, "la resynchronisation du miroir", 10_000);
    expect(resynchronisations).toBeGreaterThanOrEqual(1);
  });

  it("⑨ `status()` expose « Reconnexion en cours (essai N) » et le motif", async () => {
    // Serveur injoignable : la connexion échoue, la reconnexion est programmée.
    const miroir = openMmMirror(cleanups);
    const adaptateur = new MattermostChatAdapter({
      baseUrl: () => "http://127.0.0.1:1",
      token: () => MM_TOKEN,
      store: miroir,
      pollIntervalMs: 0,
    });
    cleanups.push(async () => {
      await adaptateur.disconnect().catch(() => undefined);
    });
    await adaptateur.connect();
    await waitFor(
      () => (adaptateur.status().raison ?? "").includes("Reconnexion en cours (essai"),
      "la reconnexion programmée",
      5_000,
    );
    expect(adaptateur.status().raison ?? "").toContain("Reconnexion en cours (essai");
    expect(adaptateur.status().etat).toBe("connexion");
  });
});

// ─── ⑦⑨ Discord ─────────────────────────────────────────────────────────────

describe("Discord — battements et ACK", () => {
  it("le battement est PÉRIODIQUE et l'ACK reçu maintient la connexion", async () => {
    vi.useFakeTimers();
    const fabrique = fabriqueSockets();
    const socket = new DiscordSocket({
      token: () => "jeton-de-test",
      onEvent: () => undefined,
      createSocket: fabrique.create,
      random: () => 0,
      helloTimeoutMs: 60_000,
    });
    cleanups.push(() => socket.stop());

    await socket.start();
    fabrique.sockets[0]?.emettre("open");
    fabrique.sockets[0]?.emettre(
      "message",
      JSON.stringify({ op: 10, d: { heartbeat_interval: 1_000 } }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(fabrique.sockets[0]?.frames.some((trame) => trame.includes('"op":1'))).toBe(true);

    // ACK présent ⇒ la connexion reste saine, et les battements continuent.
    for (let battement = 0; battement < 3; battement += 1) {
      fabrique.sockets[0]?.emettre("message", JSON.stringify({ op: 11 }));
      await vi.advanceTimersByTimeAsync(1_000);
    }
    const battements = fabrique.sockets[0]?.frames.filter((trame) => trame.includes('"op":1'));
    expect(battements?.length).toBeGreaterThanOrEqual(3);
    expect(fabrique.sockets).toHaveLength(1);
    expect(socket.status().reconnexion).toBeUndefined();
  });

  it("`heartbeat_ack` MANQUANT ⇒ reconnexion (socket zombifiée)", async () => {
    vi.useFakeTimers();
    const fabrique = fabriqueSockets();
    const socket = new DiscordSocket({
      token: () => "jeton-de-test",
      onEvent: () => undefined,
      createSocket: fabrique.create,
      random: () => 0,
      baseDelayMs: 50,
      jitterMs: 0,
      helloTimeoutMs: 60_000,
    });
    cleanups.push(() => socket.stop());

    await socket.start();
    fabrique.sockets[0]?.emettre("open");
    fabrique.sockets[0]?.emettre(
      "message",
      JSON.stringify({ op: 10, d: { heartbeat_interval: 1_000 } }),
    );
    await vi.advanceTimersByTimeAsync(0);
    // ⚠️ Aucun ACK : le battement SUIVANT conclut que la connexion est morte.
    await vi.advanceTimersByTimeAsync(1_000);
    const zombie = socket.status();
    expect(String(zombie.reconnexion?.motif)).toContain("acquitté");
    expect(libelleReconnexion(zombie.reconnexion!)).toContain("Reconnexion en cours (essai 1");

    await vi.advanceTimersByTimeAsync(zombie.reconnexion!.dansMs);
    expect(fabrique.sockets).toHaveLength(2);
  });

  it("un `HELLO` absent est détecté (socket ouverte mais muette)", async () => {
    vi.useFakeTimers();
    const fabrique = fabriqueSockets();
    const socket = new DiscordSocket({
      token: () => "jeton-de-test",
      onEvent: () => undefined,
      createSocket: fabrique.create,
      random: () => 0,
      baseDelayMs: 50,
      jitterMs: 0,
      helloTimeoutMs: 1_000,
    });
    cleanups.push(() => socket.stop());

    await socket.start();
    fabrique.sockets[0]?.emettre("open");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(String(socket.status().reconnexion?.motif)).toContain("HELLO");
    await vi.advanceTimersByTimeAsync(socket.status().reconnexion!.dansMs);
    expect(fabrique.sockets).toHaveLength(2);
  });

  it("20ᵉ tentative : la reconnexion est ENCORE programmée (aucun abandon)", async () => {
    vi.useFakeTimers();
    const socket = new DiscordSocket({
      token: () => "jeton-de-test",
      onEvent: () => undefined,
      createSocket: () => {
        throw new Error("passerelle injoignable");
      },
      random: () => 0,
      baseDelayMs: 1_000,
      maxDelayMs: 4_000,
      jitterMs: 0,
      helloTimeoutMs: 60_000,
    });
    cleanups.push(() => socket.stop());

    await socket.start();
    for (let essai = 0; essai < 25; essai += 1) {
      const reconnexion = socket.status().reconnexion;
      expect(reconnexion, `essai ${essai + 1} programmé`).toBeDefined();
      await vi.advanceTimersByTimeAsync(reconnexion!.dansMs);
    }
    expect(socket.status().tentatives).toBeGreaterThan(20);
    expect(socket.status().abandonne).toBe(false);
  });

  it("⑥ un arrêt volontaire ne se reconnecte pas (même après une coupure)", async () => {
    vi.useFakeTimers();
    const fabrique = fabriqueSockets();
    const socket = new DiscordSocket({
      token: () => "jeton-de-test",
      onEvent: () => undefined,
      createSocket: fabrique.create,
      random: () => 0,
      baseDelayMs: 100,
      jitterMs: 0,
      helloTimeoutMs: 60_000,
    });
    cleanups.push(() => socket.stop());

    await socket.start();
    fabrique.sockets[0]?.emettre("open");
    fabrique.sockets[0]?.emettre(
      "message",
      JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }),
    );
    fabrique.sockets[0]?.emettre("close", 1006, "");
    expect(socket.status().reconnexion).toBeDefined();
    await socket.stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fabrique.sockets).toHaveLength(1);
    expect(socket.status().reconnexion).toBeUndefined();
  });

  it("un jeton refusé reste un ARRÊT NET (aucune boucle)", async () => {
    vi.useFakeTimers();
    const fabrique = fabriqueSockets();
    const socket = new DiscordSocket({
      token: () => "jeton-de-test",
      onEvent: () => undefined,
      createSocket: fabrique.create,
      random: () => 0,
      baseDelayMs: 100,
      jitterMs: 0,
      helloTimeoutMs: 60_000,
    });
    cleanups.push(() => socket.stop());

    await socket.start();
    fabrique.sockets[0]?.emettre("open");
    fabrique.sockets[0]?.emettre("close", 4004, "Authentication failed");
    expect(socket.status().abandonne).toBe(true);
    expect(socket.status().reconnexion).toBeUndefined();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fabrique.sockets).toHaveLength(1);
  });

  it("l'adaptateur Discord relaie lui aussi la reprise vers le miroir", async () => {
    vi.useFakeTimers();
    const fabrique = fabriqueSockets();
    const miroir = openMmMirror(cleanups);
    const adaptateur = new DiscordChatAdapter({
      token: () => "jeton-de-test",
      store: miroir,
      apiBase: "http://127.0.0.1:1",
      createSocket: fabrique.create,
      random: () => 0,
      helloTimeoutMs: 60_000,
    });
    cleanups.push(async () => {
      await adaptateur.disconnect().catch(() => undefined);
    });
    let resynchronisations = 0;
    vi.spyOn(adaptateur, "resynchroniser").mockImplementation(async () => {
      resynchronisations += 1;
    });

    // ⚠️ `connect()` interroge l'API REST (injoignable ici) : on la laisse échouer, ce qui
    // compte est la boucle du TEMPS RÉEL.
    await adaptateur.connect().catch(() => undefined);
    const socket = fabrique.sockets[0];
    expect(socket).toBeDefined();
    socket?.emettre("open");
    socket?.emettre("message", JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }));
    await vi.advanceTimersByTimeAsync(0);
    socket?.emettre(
      "message",
      JSON.stringify({ op: 0, s: 1, t: "READY", d: { session_id: "s1", user: { id: "1" } } }),
    );
    // ⚠️ L'état reste `connexion` : la synchronisation REST, elle, n'a jamais démarré
    // (API injoignable dans ce test). Ce qui compte ici est la boucle du TEMPS RÉEL.
    expect(adaptateur.status().raison ?? "").not.toContain("Reconnexion en cours");
    // Coupure, puis reprise ⇒ resynchronisation du miroir.
    socket?.emettre("close", 1006, "");
    // Délai de base du backoff (1 s) avant la nouvelle tentative.
    await vi.advanceTimersByTimeAsync(2_000);
    const reprise = fabrique.sockets[1];
    expect(reprise).toBeDefined();
    reprise?.emettre("open");
    reprise?.emettre("message", JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }));
    await vi.advanceTimersByTimeAsync(0);
    reprise?.emettre("message", JSON.stringify({ op: 11 }));
    reprise?.emettre(
      "message",
      JSON.stringify({ op: 0, s: 1, t: "READY", d: { session_id: "s2", user: { id: "1" } } }),
    );
    // Fenêtre de coalescence de la resynchronisation.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(resynchronisations).toBeGreaterThanOrEqual(1);
  });
});

// ─── ⑨ suivi des transitions (une seule resynchronisation par reprise) ───────

describe("⑨ SuiviConnexion distingue première connexion et reprise", () => {
  it("ne signale qu'UNE reprise par perte, jamais à chaque notification", () => {
    const suivi = new SuiviConnexion();
    expect(suivi.observer(false)).toBe("stable");
    expect(suivi.observer(true)).toBe("premiere");
    expect(suivi.observer(true)).toBe("stable");
    expect(suivi.observer(false)).toBe("perte");
    expect(suivi.observer(false)).toBe("stable");
    expect(suivi.observer(true)).toBe("reprise");
    expect(suivi.observer(true)).toBe("stable");
  });
});

// ─── ⓪ FINITION : une panne de plusieurs heures ─────────────────────────────
//
// ⚠️ Cas RÉEL (confirmé le 2026-11-18) : le serveur Mattermost est ÉTEINT chaque nuit.
// La reconnexion tourne alors des heures (~480 essais au plafond de 60 s pour 8 h) : le
// libellé doit dire DEPUIS COMBIEN DE TEMPS, et le motif doit distinguer un serveur
// simplement éteint (cas NORMAL) d'un jeton refusé (ANOMALIE à corriger).

/** Journal FACTICE : capture nom + champs + niveau, sans écrire sur la sortie. */
function journalFactice() {
  const evenements: Array<{ message: string; champs: Record<string, unknown> }> = [];
  const pousser =
    (niveau: string) =>
    (message: string, champs?: Record<string, unknown>): void => {
      evenements.push({ message, champs: { ...(champs ?? {}), niveau } });
    };
  return {
    evenements,
    noms: (): string[] => evenements.map((evenement) => evenement.message),
    niveauDe: (nom: string): unknown =>
      evenements.find((evenement) => evenement.message === nom)?.champs.niveau,
    logger: { debug: pousser("debug"), info: pousser("info"), warn: pousser("warn") },
  };
}

describe("⓪ finition — une panne de plusieurs heures ne dit plus « essai 480 »", () => {
  it("① passé le seuil, le libellé affiche une DURÉE (et garde « essai N » au début)", () => {
    const huitHeuresDouze = ((8 * 60) + 12) * 60_000;
    // Le cas exact du problème : 500 essais, 8 h 12 min de panne.
    expect(
      libelleReconnexion({
        essai: 500,
        motif: PHRASE_SERVEUR_INJOIGNABLE,
        dansMs: RELANCE_DELAI_MAX_MS,
        depuisMs: huitHeuresDouze,
      }),
    ).toBe("Reconnexion en cours depuis 8 h 12 min — le serveur est peut-être arrêté");

    // Les PREMIÈRES tentatives gardent « essai N » : c'est lisible et ça montre le progrès.
    const debut = libelleReconnexion({
      essai: 1,
      motif: PHRASE_SERVEUR_INJOIGNABLE,
      dansMs: 1_000,
      depuisMs: 500,
    });
    expect(debut).toContain("essai 1");
    expect(debut).not.toContain("depuis");

    // Le seuil est FRANC : 9 essais ⇒ « essai 9 » ; 10 essais ⇒ durée.
    expect(
      libelleReconnexion({
        essai: SEUIL_ESSAIS_DUREE - 1,
        motif: "cause quelconque.",
        dansMs: 60_000,
        depuisMs: 900_000,
      }),
    ).toContain(`essai ${SEUIL_ESSAIS_DUREE - 1}`);
    expect(
      libelleReconnexion({
        essai: SEUIL_ESSAIS_DUREE,
        motif: "cause quelconque.",
        dansMs: 60_000,
        depuisMs: 900_000,
      }),
    ).toContain("depuis 15 min");

    // Durées lisibles, deux unités au plus.
    expect(formatDuree(12_000)).toBe("12 s");
    expect(formatDuree(45 * 60_000)).toBe("45 min");
    expect(formatDuree(huitHeuresDouze)).toBe("8 h 12 min");
    expect(formatDuree(8 * 3_600_000)).toBe("8 h");
    expect(formatDuree(27 * 3_600_000)).toBe("1 j 3 h");
  });

  it("③ le plafond reste 60 s : on ne martèle pas un serveur éteint, on n'abandonne pas", () => {
    expect(RELANCE_DELAI_MAX_MS).toBe(60_000);
    // Un essai très lointain ne dépasse jamais le plafond de croissance.
    expect(delaiRelance({ essai: 480, jitterMs: 0, random: () => 0 })).toBe(60_000);
    // Et le plafond n'est jamais atteint vers le bas : même après 8 h, 1 essai/min.
    expect(delaiRelance({ essai: 0, jitterMs: 0, random: () => 0 })).toBe(1_000);
  });

  it("② 500 essais (serveur éteint) ⇒ DURÉE affichée ET reconnexion toujours programmée", async () => {
    vi.useFakeTimers();
    const journal = journalFactice();
    const socket = new MattermostSocket({
      baseUrl: () => "http://127.0.0.1:1",
      token: () => "jeton-de-test",
      onEvent: () => undefined,
      // Le serveur est ÉTEINT : la connexion est refusée, la boucle doit attendre patiemment.
      createSocket: () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:8065");
      },
      random: () => 0,
      jitterMs: 0,
      logger: journal.logger,
    });
    cleanups.push(() => socket.stop());

    await socket.start();
    for (let essai = 1; essai <= 500; essai += 1) {
      const reconnexion = socket.status().reconnexion;
      expect(reconnexion, `essai ${essai} programmé`).toBeDefined();
      expect(reconnexion!.dansMs).toBeLessThanOrEqual(RELANCE_DELAI_MAX_MS);
      if (essai > SEUIL_ESSAIS_DUREE) expect(reconnexion!.dansMs).toBe(RELANCE_DELAI_MAX_MS);
      await vi.advanceTimersByTimeAsync(reconnexion!.dansMs);
    }

    const apres = socket.status();
    // ⚠️ La garantie « JAMAIS d'abandon » reste tenue après 500 échecs.
    expect(apres.abandonne).toBe(false);
    expect(apres.reconnexion).toBeDefined();
    expect(apres.reconnexion!.essai).toBe(501);
    expect(apres.reconnexion!.depuisMs).toBeGreaterThan(8 * 3_600_000);

    const libelle = libelleReconnexion(apres.reconnexion!);
    expect(libelle).not.toContain("essai 501");
    expect(libelle).toContain("Reconnexion en cours depuis");
    expect(libelle).toContain("le serveur est peut-être arrêté");
    // Le motif ne fait PAS porter la panne au bot, et le journal est UNIQUE (pas un par essai).
    expect(libelle).not.toContain("jeton");
    expect(
      journal.noms().filter((nom) => nom === "chat.mattermost.ws.serveur_injoignable"),
    ).toHaveLength(1);
    expect(journal.niveauDe("chat.mattermost.ws.serveur_injoignable")).toBe("info");
  });

  it("② Discord : passé le seuil, l'état dit aussi une DURÉE", async () => {
    vi.useFakeTimers();
    const socket = new DiscordSocket({
      token: () => "jeton-de-test",
      onEvent: () => undefined,
      createSocket: () => {
        throw new Error("getaddrinfo ENOTFOUND gateway.discord.gg");
      },
      random: () => 0,
      jitterMs: 0,
      helloTimeoutMs: 60_000,
    });
    cleanups.push(() => socket.stop());

    await socket.start();
    for (let essai = 1; essai <= 12; essai += 1) {
      const reconnexion = socket.status().reconnexion;
      expect(reconnexion, `essai ${essai} programmé`).toBeDefined();
      await vi.advanceTimersByTimeAsync(reconnexion!.dansMs);
    }
    const apres = socket.status().reconnexion!;
    expect(apres.essai).toBeGreaterThanOrEqual(SEUIL_ESSAIS_DUREE);
    expect(socket.status().abandonne).toBe(false);
    expect(libelleReconnexion(apres)).toContain("Reconnexion en cours depuis");
    expect(libelleReconnexion(apres)).toContain("le serveur est peut-être arrêté");
  });

  it("② « serveur injoignable » ≠ « authentification refusée » : deux textes, deux journaux", async () => {
    vi.useFakeTimers();

    // A. Serveur ÉTEINT : cas NORMAL, aucune alerte (niveau `info`).
    const journalServeur = journalFactice();
    const serveurEteint = new MattermostSocket({
      baseUrl: () => "http://127.0.0.1:1",
      token: () => "jeton-de-test",
      onEvent: () => undefined,
      createSocket: () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:8065");
      },
      random: () => 0,
      jitterMs: 0,
      baseDelayMs: 60_000,
      logger: journalServeur.logger,
    });
    cleanups.push(() => serveurEteint.stop());
    await serveurEteint.start();

    const reconnexionServeur = serveurEteint.status().reconnexion!;
    expect(reconnexionServeur).toBeDefined();
    const texteServeur = libelleReconnexion(reconnexionServeur);
    expect(texteServeur).toContain("injoignable");
    expect(texteServeur).not.toContain("jeton");
    expect(classifierMotif(texteServeur)).toBe("serveur_injoignable");
    expect(journalServeur.noms()).toContain("chat.mattermost.ws.serveur_injoignable");
    expect(journalServeur.noms()).not.toContain("chat.mattermost.ws.authentification_refusee");
    expect(journalServeur.niveauDe("chat.mattermost.ws.serveur_injoignable")).toBe("info");

    // B. Jeton MORT : dit CLAIREMENT (niveau `warn`), jamais confondu avec un serveur éteint.
    const journalJeton = journalFactice();
    const fabrique = fabriqueSockets();
    const jetonMort = new MattermostSocket({
      baseUrl: () => "http://127.0.0.1:1",
      token: () => "jeton-de-test",
      onEvent: () => undefined,
      createSocket: fabrique.create,
      random: () => 0,
      jitterMs: 0,
      logger: journalJeton.logger,
    });
    cleanups.push(() => jetonMort.stop());
    await jetonMort.start();
    fabrique.sockets[0]?.emettre("open");
    fabrique.sockets[0]?.emettre(
      "message",
      JSON.stringify({ status: "FAIL", seq_reply: 1, error: { id: "denied" } }),
    );

    const etatJeton = jetonMort.status();
    const texteJeton = String(etatJeton.derniereErreur ?? "");
    // ⚠️ On ne boucle pas en silence sur un jeton invalide : c'est dit, et la boucle s'arrête.
    expect(etatJeton.abandonne).toBe(true);
    expect(etatJeton.reconnexion).toBeUndefined();
    expect(texteJeton).toContain("authentification");
    expect(texteJeton).toContain("jeton");
    expect(texteJeton).not.toContain("injoignable");
    expect(classifierMotif(texteJeton)).toBe("authentification_refusee");
    expect(journalJeton.noms()).toContain("chat.mattermost.ws.authentification_refusee");
    expect(journalJeton.noms()).not.toContain("chat.mattermost.ws.serveur_injoignable");
    expect(journalJeton.niveauDe("chat.mattermost.ws.authentification_refusee")).toBe("warn");

    // Les deux causes ne se confondent JAMAIS.
    expect(texteServeur).not.toBe(texteJeton);
    expect(classifierMotif(texteServeur)).not.toBe(classifierMotif(texteJeton));
    // Les motifs légitimes ne sont pas « classés » à tort.
    expect(classifierMotif("Le serveur Mattermost a fermé la connexion temps réel (code 1006).")).toBe(
      "autre",
    );
    expect(
      classifierMotif(
        "Discord a refusé l'intent privilégié MESSAGE_CONTENT (fermeture 4014) : reconnexion SANS cet intent.",
      ),
    ).toBe("autre");
  });
});
