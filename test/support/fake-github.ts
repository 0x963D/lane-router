import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { onTestFinished } from "vitest";

/* A local stand-in for the GitHub REST API, reached by the real Action through GITHUB_API_URL. */

export const REPOSITORY = "acme/mono";

export interface FakeResponse {
  readonly status?: number;
  readonly body: unknown;
}

export interface FakeGitHub {
  readonly url: string;
  /** Every request path with its query string, in the order received. */
  readonly requests: string[];
  /** Answers a request for this path and query, relative to `/repos/acme/mono`. */
  on(path: string, response: FakeResponse): void;
}

export async function fakeGitHub(): Promise<FakeGitHub> {
  const routes = new Map<string, FakeResponse>();
  const requests: string[] = [];
  const server: Server = createServer((request, response) => {
    const path = request.url ?? "";
    requests.push(path);
    const route = routes.get(path) ?? { status: 404, body: { message: "Not Found" } };
    response.writeHead(route.status ?? 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(route.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => close(server));
  const address: AddressInfo | string | null = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    requests,
    on: (path, route) => routes.set(`/repos/${REPOSITORY}${path}`, route),
  };
}

export interface CompareFile {
  readonly filename: string;
  readonly previous_filename?: string;
  readonly status?: string;
}

export function compare(
  github: FakeGitHub,
  base: string,
  head: string,
  files: readonly (string | CompareFile)[],
): void {
  github.on(`/compare/${base}...${head}`, {
    body: {
      status: "ahead",
      files: files.map((file) => (typeof file === "string" ? { filename: file, status: "modified" } : file)),
    },
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
