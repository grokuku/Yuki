/**
 * Harnais de test du transport WS : serveur HTTP + WsTransport + FakePiHost +
 * client `ws`, sans SDK ni modèle.
 */

import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { WebSocket } from "ws";

import { createWsTransport } from "../../../src/gateway/ws/server.js";
import type { ServerFrame } from "../../../src/gateway/ws/protocol.js";
import type { Transport } from "../../../src/gateway/ws/transport.js";
import type { TtsPipelineDeps } from "../../../src/tts/index.js";
import { createLogger } from "../../../src/observability/logger.js";
import { FakePiHost, type FakePiHostOptions } from "../../pi/host-double.js";

export interface HarnessOptions extends FakePiHostOptions {
  replayBufferSize?: number;
  replayBufferBytes?: number;
  serverVersion?: string;
  tts?: TtsPipelineDeps;
}

export interface Harness {
  host: FakePiHost;
  transport: Transport;
  server: Server;
  url: string;
  close(): Promise<void>;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
  const host = new FakePiHost({ sessionId: "sess-1", ...options });
  await host.start();
  const transport = createWsTransport({
    host,
    logger,
    serverVersion: options.serverVersion ?? "test-0.1.0",
    replayBufferSize: options.replayBufferSize ?? 1000,
    replayBufferBytes: options.replayBufferBytes ?? 1_000_000,
    ...(options.tts ? { tts: options.tts } : {}),
  });
  const server = createHttpServer((_req, res) => {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  transport.attach(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    host,
    transport,
    server,
    url: `ws://127.0.0.1:${address.port}/ws`,
    async close() {
      await transport.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
      await host.stop();
    },
  };
}

export class TestClient {
  readonly frames: ServerFrame[] = [];
  /** Trames binaires reçues (Lot 7) — non décodées ici. */
  readonly binaryFrames: Buffer[] = [];
  private readonly waiters: Array<{
    predicate: (frame: ServerFrame) => boolean;
    resolve: (frame: ServerFrame) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        this.binaryFrames.push(
          Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data),
        );
        return;
      }
      let frame: ServerFrame;
      try {
        frame = JSON.parse(data.toString("utf8")) as ServerFrame;
      } catch {
        return;
      }
      this.frames.push(frame);
      for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
        const waiter = this.waiters[i];
        if (waiter && waiter.predicate(frame)) {
          clearTimeout(waiter.timer);
          this.waiters.splice(i, 1);
          waiter.resolve(frame);
        }
      }
    });
  }

  static connect(url: string): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.once("open", () => resolve(new TestClient(ws)));
      ws.once("error", reject);
    });
  }

  send(payload: unknown): void {
    this.ws.send(JSON.stringify(payload));
  }

  sendRaw(payload: string | Buffer, binary = false): void {
    this.ws.send(payload, { binary });
  }

  waitFor<T extends ServerFrame["type"]>(
    type: T,
    timeoutMs?: number,
  ): Promise<Extract<ServerFrame, { type: T }>>;
  waitFor(
    predicate: (frame: ServerFrame) => boolean,
    timeoutMs?: number,
  ): Promise<ServerFrame>;
  waitFor(
    typeOrPredicate: ServerFrame["type"] | ((frame: ServerFrame) => boolean),
    timeoutMs = 3000,
  ): Promise<ServerFrame> {
    const predicate =
      typeof typeOrPredicate === "function"
        ? typeOrPredicate
        : (frame: ServerFrame) => frame.type === typeOrPredicate;
    const existing = this.frames.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise<ServerFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((w) => w.timer === timer);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("timeout en attendant une trame"));
      }, timeoutMs);
      this.waiters.push({ predicate, resolve, reject, timer });
    });
  }

  framesAfter(seq: number): ServerFrame[] {
    return this.frames.filter((frame) => frame.seq > seq);
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      this.ws.once("close", () => resolve());
      this.ws.close();
    });
  }
}
