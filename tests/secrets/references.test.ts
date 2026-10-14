/**
 * Références de secrets dans une commande — module PUR.
 *
 * Vérifie la SYNTAXE de référence (`${NOM}` ou `$NOM`, préfixe réservé
 * `YUKI_SECRET_`) et le fait que le texte de la commande n'est JAMAIS modifié.
 */

import { describe, expect, it } from "vitest";

import {
  extractSecretReferences,
  isSecretReferenceName,
  isValidSecretName,
  resolveSecretReferences,
  SECRET_NAME_PREFIX,
} from "../../src/secrets/references.js";

describe("references — extraction", () => {
  it("extrait les références ${NOM} et $NOM dans l'ordre, sans doublon", () => {
    expect(
      extractSecretReferences("ssh ${YUKI_SECRET_NAS} $YUKI_SECRET_KEY ${YUKI_SECRET_NAS}"),
    ).toEqual(["YUKI_SECRET_NAS", "YUKI_SECRET_KEY"]);
  });

  it("ignore les variables shell ordinaires (PATH, HOME, $1, $?)", () => {
    expect(extractSecretReferences("echo $PATH $HOME $1 $? $@ ${USER}")).toEqual([]);
  });

  it("ne reconnaît une référence que par le préfixe RÉSERVÉ", () => {
    expect(isSecretReferenceName("YUKI_SECRET_A")).toBe(true);
    expect(isSecretReferenceName("MY_SECRET")).toBe(false);
    expect(extractSecretReferences("echo $MY_SECRET")).toEqual([]);
  });
});

describe("references — validation d'un nom", () => {
  it("exige le préfixe réservé et un identifiant shell", () => {
    expect(isValidSecretName(`${SECRET_NAME_PREFIX}NAS`)).toBe(true);
    expect(isValidSecretName("YUKI_SECRET_")).toBe(false);
    expect(isValidSecretName("YUKI_SECRET_A-B")).toBe(false); // tiret interdit
    expect(isValidSecretName("SECRET_X")).toBe(false);
  });
});

describe("references — résolution (le texte reste INTACT)", () => {
  it("renvoie l'environnement des secrets TROUVÉS, sans toucher à la commande", () => {
    const command = "curl -H \"Authorization: Bearer ${YUKI_SECRET_TOKEN}\" https://x";
    const vault: Record<string, string> = { YUKI_SECRET_TOKEN: "s3cr3t-token" };
    const res = resolveSecretReferences(command, (name) => vault[name]);
    expect(res.found).toEqual(["YUKI_SECRET_TOKEN"]);
    expect(res.missing).toEqual([]);
    expect(res.env).toEqual({ YUKI_SECRET_TOKEN: "s3cr3t-token" });
    // ⚠️ La commande n'a PAS été modifiée : elle porte toujours la référence.
    expect(command).toContain("${YUKI_SECRET_TOKEN}");
  });

  it("signale les références ABSENTES (cas awaiting_secret)", () => {
    const res = resolveSecretReferences("ssh ${YUKI_SECRET_INCONNU}", () => undefined);
    expect(res.found).toEqual([]);
    expect(res.missing).toEqual(["YUKI_SECRET_INCONNU"]);
    expect(res.env).toEqual({});
  });

  it("mélange trouvés et manquants", () => {
    const res = resolveSecretReferences("a ${YUKI_SECRET_A} b ${YUKI_SECRET_B}", (n) =>
      n === "YUKI_SECRET_A" ? "valeur-a" : undefined,
    );
    expect(res.found).toEqual(["YUKI_SECRET_A"]);
    expect(res.missing).toEqual(["YUKI_SECRET_B"]);
    expect(res.env).toEqual({ YUKI_SECRET_A: "valeur-a" });
  });
});
