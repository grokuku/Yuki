/**
 * TRAMES DE TRANSFERT DE FICHIERS (miroir TS de `proto/types.go`) — parsing des
 * trames agent → Yuki et encodage des trames Yuki → agent.
 *
 * ⚠️ `proto.Version` reste à 1 : ces trames sont AJOUTÉES, jamais un bump de
 * version (qui ferait refuser TOUS les agents déployés). C'est la capacité
 * `files` du `hello` qui autorise leur émission.
 */

import { describe, expect, it } from "vitest";

import {
  AGENT_PROTO_VERSION,
  DEFAULT_FILE_CHUNK_BYTES,
  encodeFileGetFrame,
  encodeFilePutChunkFrame,
  encodeFilePutFrame,
  parseAgentFrame,
} from "../../src/agents/protocol.js";

describe("parseAgentFrame — trames de fichier (agent → Yuki)", () => {
  it("accepte un `file_chunk` complet", () => {
    const parsed = parseAgentFrame(
      JSON.stringify({
        type: "file_chunk",
        proto_version: 1,
        cmd_id: "c-1",
        seq: 2,
        offset: 384,
        data: Buffer.from("bonjour").toString("base64"),
        dernier: true,
        total: 389,
        sha256: "a".repeat(64),
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    if (parsed.frame.type !== "file_chunk") throw new Error("type attendu");
    expect(parsed.frame.cmdId).toBe("c-1");
    expect(parsed.frame.seq).toBe(2);
    expect(parsed.frame.offset).toBe(384);
    expect(Buffer.from(parsed.frame.data, "base64").toString("utf8")).toBe("bonjour");
    expect(parsed.frame.dernier).toBe(true);
    expect(parsed.frame.total).toBe(389);
    expect(parsed.frame.sha256).toBe("a".repeat(64));
  });

  it("accepte un `file_chunk` non final (sans total ni empreinte)", () => {
    const parsed = parseAgentFrame(
      JSON.stringify({
        type: "file_chunk",
        proto_version: 1,
        cmd_id: "c-2",
        seq: 0,
        offset: 0,
        data: "",
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.frame.type !== "file_chunk") return;
    expect(parsed.frame.dernier).toBe(false);
    expect(parsed.frame.total).toBeUndefined();
    expect(parsed.frame.sha256).toBeUndefined();
  });

  it("refuse un `file_chunk` sans `cmd_id`", () => {
    const parsed = parseAgentFrame(
      JSON.stringify({ type: "file_chunk", proto_version: 1, seq: 0, data: "" }),
    );
    expect(parsed.ok).toBe(false);
  });

  it("accepte un `file_result` de succès", () => {
    const parsed = parseAgentFrame(
      JSON.stringify({
        type: "file_result",
        proto_version: 1,
        cmd_id: "c-3",
        status: "ok",
        bytes: 42,
        sha256: "b".repeat(64),
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.frame.type !== "file_result") return;
    expect(parsed.frame.status).toBe("ok");
    expect(parsed.frame.bytes).toBe(42);
    expect(parsed.frame.sha256).toBe("b".repeat(64));
  });

  it("accepte un `file_result` de refus avec code et message", () => {
    const parsed = parseAgentFrame(
      JSON.stringify({
        type: "file_result",
        proto_version: 1,
        cmd_id: "c-4",
        status: "refused",
        code: "conflict",
        message: "existe déjà",
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.frame.type !== "file_result") return;
    expect(parsed.frame.status).toBe("refused");
    expect(parsed.frame.code).toBe("conflict");
    expect(parsed.frame.message).toBe("existe déjà");
  });
});

describe("encodage des trames (Yuki → agent)", () => {
  it("`file_get` porte proto_version et les bornes", () => {
    const frame = encodeFileGetFrame({
      cmdId: "c-1",
      path: "/tmp/x.bin",
      offset: 16,
      maxTotal: 1024,
      chunk: DEFAULT_FILE_CHUNK_BYTES,
    });
    expect(frame.type).toBe("file_get");
    expect(frame.proto_version).toBe(AGENT_PROTO_VERSION);
    expect(frame.path).toBe("/tmp/x.bin");
    expect(frame.offset).toBe(16);
    expect(frame.max_total).toBe(1024);
    expect(frame.chunk).toBe(DEFAULT_FILE_CHUNK_BYTES);
  });

  it("`file_put` porte taille, empreinte et `ecraser` seulement si demandé", () => {
    const without = encodeFilePutFrame({
      cmdId: "c-2",
      path: "/tmp/y.bin",
      bytes: 12,
      sha256: "c".repeat(64),
    });
    expect(without.ecraser).toBeUndefined();
    const withForce = encodeFilePutFrame({
      cmdId: "c-2",
      path: "/tmp/y.bin",
      bytes: 12,
      sha256: "c".repeat(64),
      ecraser: true,
    });
    expect(withForce.ecraser).toBe(true);
    expect(withForce.bytes).toBe(12);
    expect(withForce.sha256).toBe("c".repeat(64));
  });

  it("`file_put_chunk` n'ajoute l'empreinte que sur le dernier morceau", () => {
    const nonFinal = encodeFilePutChunkFrame({
      cmdId: "c-3",
      seq: 0,
      data: "AAAA",
      dernier: false,
    });
    expect(nonFinal.dernier).toBeUndefined();
    expect(nonFinal.sha256).toBeUndefined();
    const last = encodeFilePutChunkFrame({
      cmdId: "c-3",
      seq: 1,
      data: "BBBB",
      dernier: true,
      sha256: "d".repeat(64),
    });
    expect(last.dernier).toBe(true);
    expect(last.sha256).toBe("d".repeat(64));
  });

  it("la version du protocole reste 1 (aucun bump)", () => {
    expect(AGENT_PROTO_VERSION).toBe(1);
  });
});

describe("AgentHub.hasCapability(\"files\") — source de vérité de la négociation", () => {
  it("n'est vrai QUE si l'agent a déclaré `files` dans son hello", async () => {
    const { AgentHub } = await import("../../src/agents/connection.js");
    // Un hub sans connexion ne connaît AUCUNE capacité (jamais une supposition).
    const hub = new AgentHub({
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    expect(hub.hasCapability("agent-x", "files")).toBe(false);
    expect(hub.hasCapability("agent-x", "exec")).toBe(false);
  });
});
