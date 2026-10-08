/**
 * SAN du certificat serveur (Lot 4, correctif SAN) : la boucle locale est
 * TOUJOURS présente ; `agents.bindHost` concret et chaque valeur de
 * `agents.serverName` (séparée par des virgules) s'y ajoutent — une IP littérale
 * dans `IPAddress`, un nom dans `DNSName`.
 *
 * ⚠️ **AUCUNE détection automatique d'adresse locale** : Yuki tourne dans un
 * conteneur, `os.networkInterfaces()` ne verrait que les interfaces DU CONTENEUR
 * (`172.17.x.x`…), jamais l'IP de l'hôte. L'adresse vient de la configuration —
 * c'est précisément le bug `x509: certificate is valid for 127.0.0.1, not
 * 10.10.0.5` que ce module corrige.
 */

import { describe, expect, it } from "vitest";

import {
  LOOPBACK_DNS_NAMES,
  LOOPBACK_IP_ADDRESSES,
  serverCertificateNames,
  splitServerNames,
} from "../../src/agents/index.js";

describe("serverCertificateNames", () => {
  it("inclut toujours la boucle locale (localhost, 127.0.0.1, ::1)", () => {
    const names = serverCertificateNames();
    expect(names.dnsNames).toContain("localhost");
    expect(names.ipAddresses).toContain("127.0.0.1");
    expect(names.ipAddresses).toContain("::1");
    expect(LOOPBACK_DNS_NAMES).toContain("localhost");
    expect(LOOPBACK_IP_ADDRESSES).toContain("::1");
  });

  it("une IP déclarée va dans IPAddress (jamais dans DNSName)", () => {
    const names = serverCertificateNames({
      bindHost: "0.0.0.0",
      serverName: "10.10.0.5",
    });
    expect(names.ipAddresses).toContain("10.10.0.5");
    expect(names.dnsNames).not.toContain("10.10.0.5");
    // Toujours la boucle locale.
    expect(names.dnsNames).toContain("localhost");
    expect(names.ipAddresses).toContain("127.0.0.1");
  });

  it("un nom déclaré va dans DNSName (jamais dans IPAddress)", () => {
    const names = serverCertificateNames({
      bindHost: "0.0.0.0",
      serverName: "Yuki.LAN",
    });
    // Casse normalisée (minuscules) et nom conservé.
    expect(names.dnsNames).toContain("yuki.lan");
    expect(names.ipAddresses).not.toContain("yuki.lan");
  });

  it("`agents.serverName` : plusieurs valeurs séparées par des virgules", () => {
    const names = serverCertificateNames({
      bindHost: "0.0.0.0",
      serverName: " 10.10.0.5 , yuki.lan ,  , fdaa::7 ",
    });
    // Espaces retirés, jetons vides ignorés.
    expect(names.ipAddresses).toContain("10.10.0.5");
    expect(names.ipAddresses).toContain("fdaa::7");
    expect(names.dnsNames).toContain("yuki.lan");
    expect(names.dnsNames).toContain("localhost");
  });

  it("ignore les valeurs invalides (caractères interdits, jokers)", () => {
    const names = serverCertificateNames({
      serverName: "valide.lan, pas valide, *.wild, ''",
    });
    expect(names.dnsNames).toContain("valide.lan");
    expect(names.dnsNames).not.toContain("pas valide");
    expect(names.dnsNames).not.toContain("*.wild");
  });

  it("`bindHost` concret ajouté, `0.0.0.0` et `::` ignorés (jamais en DNS)", () => {
    const v4 = serverCertificateNames({ bindHost: "10.10.0.9" });
    expect(v4.ipAddresses).toContain("10.10.0.9");

    const v6 = serverCertificateNames({ bindHost: "fdaa::9" });
    expect(v6.ipAddresses).toContain("fdaa::9");

    const hostname = serverCertificateNames({ bindHost: "yuki.lan" });
    expect(hostname.dnsNames).toContain("yuki.lan");

    // ⚠️ Un hôte « n'importe quelle interface » ne doit JAMAIS finir dans le SAN,
    // ni en IP ni (surtout) comme faux nom DNS.
    for (const wildcard of ["0.0.0.0", "::"]) {
      const names = serverCertificateNames({ bindHost: wildcard });
      expect(names.ipAddresses).not.toContain(wildcard);
      expect(names.dnsNames).not.toContain(wildcard);
      expect(names.dnsNames).toEqual(["localhost"]);
    }
  });

  it("déduplique les adresses (écritures IPv6 équivalentes)", () => {
    const names = serverCertificateNames({
      serverName: "2001:0db8::1, 2001:db8::1, 10.10.0.5, 10.10.0.5",
    });
    expect(names.ipAddresses.filter((ip) => ip === "10.10.0.5")).toHaveLength(1);
    expect(names.ipAddresses.filter((ip) => ip.includes("db8"))).toHaveLength(1);
  });

  it("`splitServerNames` : épure espaces et jetons vides", () => {
    expect(splitServerNames(undefined)).toEqual([]);
    expect(splitServerNames("")).toEqual([]);
    expect(splitServerNames(" a , b ,, ")).toEqual(["a", "b"]);
  });
});
