import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { onTestFinished } from "vitest";

export const REPOSITORY = "acme/mono";

/** `text` is sent as is, for a body that is not JSON. */
export type FakeResponse =
  { readonly status?: number; readonly body: unknown } | { readonly status?: number; readonly text: string };

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
    response.end("text" in route ? route.text : JSON.stringify(route.body));
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

/** `mergeBase` defaults to `base`, as when head descends from base. */
export function compare(
  github: FakeGitHub,
  base: string,
  head: string,
  files: readonly (string | CompareFile)[],
  options: { readonly mergeBase?: string } = {},
): void {
  github.on(`/compare/${base}...${head}`, {
    body: {
      status: "ahead",
      merge_base_commit: { sha: options.mergeBase ?? base },
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
