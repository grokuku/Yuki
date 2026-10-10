/**
 * Serveur HTTP de test — MOCK du libraire de Pi-Web.
 *
 * ⚠️ Aucun test ne dépend d'une vraie instance : ce serveur local reproduit les
 * routes du contrat d'API (`/status`, `/search`, `/library`, `/doc/:name`,
 * `/archive`) et enregistre chaque requête (méthode, URL, en-têtes, corps) pour
 * prouver ce qui est RÉELLEMENT envoyé (en-têtes d'authentification notamment).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  /** Chemin + query, sans l'hôte (ex. `/api/librarian/doc/react?version=18`). */
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface MockResponse {
  status: number;
  /** Corps JSON sérialisé. */
  body?: unknown;
  /** Corps brut (prioritaire sur `body`). */
  raw?: string;
  /** Corps BINAIRE (prioritaire sur `raw` et `body`) — pour les images. */
  bytes?: Uint8Array;
  /** Type MIME de la réponse (défaut JSON). */
  contentType?: string;
  /** En-têtes supplémentaires (ex. `retry-after`). */
  headers?: Record<string, string>;
  /** Délai avant réponse (ms) — pour tester le délai dépassé. */
  delayMs?: number;
}

export type MockResponder = (
  request: RecordedRequest,
) => MockResponse | Promise<MockResponse>;

export interface MockLibrarian {
  baseUrl: string;
  requests: RecordedRequest[];
  setResponder(responder: MockResponder): void;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, response: MockResponse): void {
  const payload = response.bytes
    ? Buffer.from(response.bytes)
    : Buffer.from(response.raw ?? JSON.stringify(response.body ?? {}), "utf8");
  res.writeHead(response.status, {
    "content-type": response.contentType ?? "application/json; charset=utf-8",
    "content-length": String(payload.byteLength),
    ...(response.headers ?? {}),
  });
  res.end(payload);
}

/** Démarre un faux libraire sur un port éphémère. */
export async function startMockLibrarian(
  responder: MockResponder = () => ({ status: 200, body: {} }),
): Promise<MockLibrarian> {
  let current: MockResponder = responder;
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const body = await readBody(req);
      const recorded: RecordedRequest = {
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers: req.headers,
        body,
      };
      requests.push(recorded);
      const response = await current(recorded);
      if (response.delayMs && response.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, response.delayMs));
      }
      send(res, response);
    })().catch(() => {
      send(res, { status: 500, body: { error: "mock_failure" } });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    setResponder: (next) => {
      current = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
