/**
 * Schéma de configuration — champs `chat.*` (lot 18).
 *
 * Ce que ce fichier verrouille :
 *  - `chat.mode` est un ENUM `local | mattermost | discord`, défaut `local`,
 *    `apply: hot` (le mode est relu à chaque appel, aucun redémarrage) ;
 *  - `chat.remoteAgents` existe, avec le défaut SÉCURISÉ `desactive` (exigence
 *    utilisateur) et reste RÉVERSIBLE ;
 *  - `chat.remoteMemory` n'existe PLUS (retiré : il n'avait aucun consommateur) ;
 *  - aucune valeur hors énumération n'est acceptée, et un booléen est refusé
 *    (`FieldType` n'en connaît pas).
 *
 * ⚠️ Échoue sur le code d'origine : `chat.mode` n'existe pas dans la table.
 */

import { describe, expect, it } from "vitest";

import { CONFIG_SCHEMA, validateField, type FieldDescriptor } from "../../src/config/schema.js";
import { readConfigEnvOverrides } from "../../src/config/env.js";

describe("chat.mode", () => {
  it("est un enum `local | mattermost | discord`, défaut `local`, apply hot", () => {
    const descriptor = CONFIG_SCHEMA["chat.mode"] as FieldDescriptor | undefined;
    expect(descriptor).toBeDefined();
    expect(descriptor?.type).toBe("enum");
    expect(descriptor?.enum).toEqual(["local", "mattermost", "discord"]);
    expect(descriptor?.default).toBe("local");
    expect(descriptor?.apply).toBe("hot");
  });

  it("accepte les trois modes et REFUSE le reste (booléen compris)", () => {
    for (const value of ["local", "mattermost", "discord"]) {
      expect(validateField("chat.mode", value)).toEqual({ ok: true, value });
    }
    expect(validateField("chat.mode", "irc").ok).toBe(false);
    expect(validateField("chat.mode", true).ok).toBe(false);
    expect(validateField("chat.mode", "").ok).toBe(false);
  });

  it("se surcharge par l'environnement (`YUKI_CHAT_MODE`)", () => {
    const overrides = readConfigEnvOverrides({ YUKI_CHAT_MODE: "mattermost" });
    expect(overrides["chat.mode"]).toBe("mattermost");
  });
});

describe("capacités distantes — désactivées par défaut", () => {
  it("`chat.remoteAgents` : enum `desactive|actives`, défaut `desactive`, hot", () => {
    const descriptor = CONFIG_SCHEMA["chat.remoteAgents"] as FieldDescriptor | undefined;
    expect(descriptor?.type).toBe("enum");
    expect(descriptor?.enum).toEqual(["desactive", "actives"]);
    expect(descriptor?.default).toBe("desactive");
    expect(descriptor?.apply).toBe("hot");
    expect(validateField("chat.remoteAgents", "actives")).toEqual({
      ok: true,
      value: "actives",
    });
    expect(validateField("chat.remoteAgents", true).ok).toBe(false);
  });

  it("`chat.remoteMemory` N'EXISTE PLUS : un réglage sans consommateur est un mensonge", () => {
    // ⚠️ Avant D6, ce champ existait et n'était lu que pour l'AFFICHAGE : aucun code ne
    // s'en servait. On ne garde pas un interrupteur qui ne fait rien — il reviendra avec
    // son consommateur, le jour où la mémoire distante sera branchée.
    expect(CONFIG_SCHEMA["chat.remoteMemory"]).toBeUndefined();
    expect(validateField("chat.remoteMemory", "actives").ok).toBe(false);
  });
});
