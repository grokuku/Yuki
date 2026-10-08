/**
 * Rechargement À CHAUD du certificat SERVEUR du port machines (Lot 4, correctif
 * SAN).
 *
 * Modifier `agents.serverName` depuis /config doit pouvoir prendre effet SANS
 * redémarrer le gateway. On régénère le certificat serveur si le SAN en place ne
 * couvre plus l'ensemble attendu, puis on recharge le contexte TLS du serveur
 * `node:https` (`server.setSecureContext`) : les **nouvelles** connexions
 * présentent aussitôt le nouveau certificat, les connexions déjà ouvertes le
 * conservent (les agents se reconnectent en boucle, donc basculent vite).
 *
 * ⚠️ **La clé du CA n'est jamais touchée** (`CertificateAuthority` ne réécrit que
 * `agents-server.crt` / `agents-server.key`) : les agents déjà appairés — qui ont
 * épinglé le CA — n'ont RIEN à refaire.
 *
 * ⚠️ **Aucune vérification n'est affaiblie** : c'est le certificat qui change,
 * pas le contrôle du nom d'hôte côté agent.
 */

import type { Server as HttpsServer } from "node:https";

import type { CertificateAuthority } from "./ca.js";
import {
  serverCertificateNames,
  type ServerCertificateNames,
} from "./server-names.js";

/** Journaliseur minimal (compatible `CaLogger` / logger du gateway). */
export interface CertReloadLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/**
 * Vue minimale du runtime de configuration : évite un import circulaire tout en
 * restant le VRAI contrat utilisé (`ConfigRuntime`).
 */
export interface ServerNameConfigReader {
  getString(path: string): string;
  subscribe(listener: () => void): () => void;
}

/** Signature stable d'un ensemble de SAN (détecte un changement de nom). */
export function sanSignatureOf(names: ServerCertificateNames): string {
  return `${names.dnsNames.join(",")}|${names.ipAddresses.join(",")}`;
}

export interface ServerCertificateReloadOptions {
  /** Serveur `node:https` du port machines, déjà créé (pas nécessairement écoute). */
  server: HttpsServer;
  /** Hôte d'écoute RÉEL (celui de `startAgentsServer`), figé au démarrage. */
  bindHost: string;
  ca: CertificateAuthority;
  config: ServerNameConfigReader;
  logger: CertReloadLogger;
}

/**
 * S'abonne au runtime de configuration et recharge le certificat serveur quand
 * l'ensemble des SAN attendus change. Renvoie la fonction de désabonnement
 * (à appeler à l'arrêt).
 */
export function installServerCertificateReload(
  options: ServerCertificateReloadOptions,
): () => void {
  const { server, bindHost, ca, config, logger } = options;
  const namesOf = (): ServerCertificateNames =>
    serverCertificateNames({
      bindHost,
      serverName: config.getString("agents.serverName"),
    });
  let lastSignature = sanSignatureOf(namesOf());

  return config.subscribe(() => {
    const names = namesOf();
    const signature = sanSignatureOf(names);
    if (signature === lastSignature) return;
    try {
      const cert = ca.ensureServerCertificate(names);
      server.setSecureContext({
        ca: ca.certificatePem,
        cert: cert.certPem,
        key: cert.keyPem,
      });
      lastSignature = signature;
      logger.info("agents.server_cert.reloaded", {
        dns_names: names.dnsNames.join(","),
        ip_addresses: names.ipAddresses.join(","),
      });
    } catch (error) {
      // Le listener ne doit JAMAIS casser l'écriture de configuration : on
      // journalise et on laisse le certificat précédent en place.
      logger.error("agents.server_cert.reload_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
