/**
 * Route /version : version applicative, Node et versions verrouillées.
 */

export interface VersionDeps {
  version: string;
  profile: string;
}

export interface RouteResponse {
  status: number;
  body: unknown;
}

/** Versions verrouillées (audit du 16/09/2026). Voir docs/versions.md. */
export const LOCKED_VERSIONS = {
  nodeImage: "node:24.21.0-bookworm-slim",
  node: "24.21.0",
  typescript: "5.9.3",
  vitest: "5.0.1",
  tsx: "4.23.13",
  typesNode: "24.13.5",
} as const;

export function versionInfo(deps: VersionDeps): RouteResponse {
  return {
    status: 200,
    body: {
      name: "yuki",
      version: deps.version,
      node: process.version,
      profile: deps.profile,
      locked: LOCKED_VERSIONS,
    },
  };
}
