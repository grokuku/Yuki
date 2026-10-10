/**
 * SAN du certificat SERVEUR du port machines (Lot 4, correctif SAN).
 *
 * ⚠️ **Pourquoi ce module existe.** Le certificat serveur de Yuki était émis
 * avec un SAN figé (`localhost` + `127.0.0.1`, plus `agents.bindHost` s'il était
 * une adresse concrète). Un agent qui se connecte à Yuki par une AUTRE adresse
 * de la machine — l'IP LAN, cas réel : `x509: certificate is valid for
 * 127.0.0.1, not 10.10.0.5` — échouait la poignée de main TLS, en boucle, sans
 * configuration possible. Le SAN couvre désormais :
 *
 *   - la boucle locale `localhost` / `127.0.0.1` / `::1` (toujours) ;
 *   - `agents.bindHost` s'il est une adresse concrète (jamais `0.0.0.0`/`::`) ;
 *   - `agents.serverName` : adresse(s) ou nom(s) **déclarés par l'opérateur**
 *     (voir plus bas), séparés par des virgules.
 *
 * ⚠️ **Aucune inscription automatique d'adresse locale.** Yuki tourne souvent
 * dans un conteneur : `os.networkInterfaces()` ne renverrait alors que les
 * interfaces DU CONTENEUR (`172.17.x.x`…), **jamais** l'IP de l'hôte (`10.10.0.5`)
 * que les agents utilisent réellement. L'adresse vient donc **de la
 * configuration** (`agents.serverName`), jamais d'une supposition de Yuki.
 * `localIpAddresses` / `uncoveredLocalAddresses` ne servent qu'à **avertir**
 * l'opérateur d'une adresse locale absente du SAN (diagnostic au démarrage) —
 * élargir le SAN reste une **décision de sécurité** de l'opérateur.
 *
 * ⚠️ **La vérification n'est PAS affaiblie.** Ce module enrichit le SAN ; il ne
 * touche ni à la vérification du nom d'hôte côté agent (Go `crypto/tls`,
 * `ServerName` renseigné) ni au pinning du CA.
 *
 * ⚠️ **Compromis `agents.serverName`.** Le schéma de configuration
 * (`src/config/schema.ts`) n'accepte que `string | int | enum` — **aucun
 * tableau**. Plusieurs valeurs (un nom DNS *et* une IP, par ex.) se déclarent
 * donc dans une **chaîne unique, valeurs séparées par des virgules**. Une IP
 * littérale va dans `IPAddress`, un nom va dans `DNSName`.
 */

import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

import { parseIpBytes } from "./x509.js";

/** Noms et adresses du `subjectAltName` du certificat serveur. */
export interface ServerCertificateNames {
  dnsNames: string[];
  ipAddresses: string[];
}

/** Boucle locale : TOUJOURS présente dans le SAN serveur. */
export const LOOPBACK_DNS_NAMES = ["localhost"] as const;
export const LOOPBACK_IP_ADDRESSES = ["127.0.0.1", "::1"] as const;

/** Nom DNS acceptable comme SAN (labels alphanumériques + `-` + `.`). */
const DNS_NAME_RE = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

/** Découpe `agents.serverName` : valeurs séparées par des virgules, épurées. */
export function splitServerNames(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

/** Retire une zone de portée (`fe80::1%eth0`) et d'éventuels crochets `[::1]`. */
function stripIpDecoration(value: string): string {
  let out = value.trim();
  if (out.startsWith("[") && out.endsWith("]")) out = out.slice(1, -1);
  const percent = out.indexOf("%");
  return percent >= 0 ? out.slice(0, percent) : out;
}

/**
 * `true` si l'adresse est représentable dans un SAN : IP valide, et ni
 * `0.0.0.0` ni `::` (adresses de « n'importe quelle interface »).
 */
function isUsableIp(value: string): boolean {
  const bytes = parseIpBytes(value);
  if (!bytes) return false;
  if (bytes.length === 4 && bytes.equals(Buffer.from([0, 0, 0, 0]))) return false;
  if (bytes.length === 16 && bytes.equals(Buffer.alloc(16))) return false;
  return true;
}

/** `true` si la valeur est une adresse IP (v4/v6) bien formée, même `0.0.0.0`. */
function looksLikeIp(value: string): boolean {
  return parseIpBytes(value) !== null;
}

/** Clé de déduplication d'une IP (octets normalisés, insensible à l'écriture). */
function ipKey(value: string): string {
  return parseIpBytes(value)?.toString("hex") ?? value.toLowerCase();
}

/**
 * Construit l'ensemble des SAN du certificat serveur à partir de la
 * configuration. `bindHost` et `serverName` proviennent des champs homonymes
 * (`agents.bindHost`, `agents.serverName`).
 */
export function serverCertificateNames(
  options: { bindHost?: string; serverName?: string } = {},
): ServerCertificateNames {
  const dnsNames: string[] = [];
  const ipAddresses: string[] = [];
  const seenDns = new Set<string>();
  const seenIp = new Set<string>();

  const addDns = (value: string): void => {
    const name = value.trim().toLowerCase();
    if (name.length === 0 || !DNS_NAME_RE.test(name)) return;
    if (seenDns.has(name)) return;
    seenDns.add(name);
    dnsNames.push(name);
  };

  const addIp = (value: string): void => {
    const ip = stripIpDecoration(value);
    if (!isUsableIp(ip)) return;
    const key = ipKey(ip);
    if (seenIp.has(key)) return;
    seenIp.add(key);
    ipAddresses.push(ip);
  };

  /**
   * Route une valeur déclarée vers le bon SAN : `IPAddress` si c'est une IP
   * (même malformée comme `0.0.0.0`, qu'on IGNORE alors), `DNSName` sinon.
   */
  const addDeclared = (value: string): void => {
    const item = stripIpDecoration(value);
    if (item.length === 0) return;
    if (looksLikeIp(item)) addIp(item);
    else addDns(item);
  };

  // 1. Boucle locale (toujours, utile pour les tests locaux et `localhost`).
  for (const name of LOOPBACK_DNS_NAMES) addDns(name);
  for (const ip of LOOPBACK_IP_ADDRESSES) addIp(ip);

  // 2. `agents.bindHost` s'il est concret (`0.0.0.0` et `::` sont ignorés).
  addDeclared(options.bindHost ?? "");

  // 3. `agents.serverName` : adresses/noms déclarés, séparés par des virgules.
  for (const token of splitServerNames(options.serverName)) addDeclared(token);

  return { dnsNames, ipAddresses };
}

/** `true` si l'adresse appartient à la boucle locale (`127.0.0.0/8`, `::1`). */
function isLoopbackIp(value: string): boolean {
  const bytes = parseIpBytes(value);
  if (!bytes) return false;
  if (bytes.length === 4) return bytes[0] === 127;
  if (bytes.length === 16) {
    return bytes.subarray(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
  }
  return false;
}

/**
 * Adresses IP des interfaces LOCALES de la machine (diagnostic), hors boucle
 * locale et adresses « n'importe quelle interface ». ⚠️ Dans un conteneur, ce
 * sont les interfaces DU CONTENEUR — d'où un simple **avertissement**, jamais une
 * inscription automatique dans le SAN. Testable via un `interfaces` injecté.
 */
export function localIpAddresses(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const infos of Object.values(interfaces)) {
    for (const info of infos ?? []) {
      // `family` est `IPv4`/`IPv6` (chaîne) en Node moderne ; on tolère aussi
      // la forme numérique historique (4/6) pour rester robuste.
      const rawFamily = info.family as unknown;
      const family =
        rawFamily === 4 ? "IPv4" : rawFamily === 6 ? "IPv6" : String(rawFamily);
      if (family !== "IPv4" && family !== "IPv6") continue;
      const ip = stripIpDecoration(info.address);
      if (!isUsableIp(ip) || isLoopbackIp(ip)) continue;
      const key = ipKey(ip);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ip);
    }
  }
  return out;
}

/**
 * Adresses locales NON couvertes par le SAN. ⚠️ **Diagnostic uniquement** :
 * elles ne sont **jamais** ajoutées automatiquement (élargir le SAN est une
 * décision de sécurité) — l'appelant **avertit** l'opérateur avec le geste à faire.
 */
export function uncoveredLocalAddresses(
  names: ServerCertificateNames,
  localAddresses: readonly string[] = localIpAddresses(),
): string[] {
  const covered = new Set(names.ipAddresses.map((ip) => ipKey(ip)));
  return localAddresses.filter((ip) => !covered.has(ipKey(ip)));
}
