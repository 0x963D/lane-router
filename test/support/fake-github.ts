import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { onTestFinished } from "vitest";

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

export interface FakeCommit {
  readonly sha: string;
  readonly parents: readonly string[];
}

/**
 * Lists `commits` as reachable from `head`, newest first, 100 to a page, the way the commits endpoint
 * does. Every commit starts with no check runs.
 */
export function history(github: FakeGitHub, head: string, commits: readonly FakeCommit[]): void {
  for (let page = 0; page * 100 <= commits.length; page++) {
    const body = commits.slice(page * 100, page * 100 + 100).map(({ sha, parents }) => ({
      sha,
      parents: parents.map((parent) => ({ sha: parent })),
    }));
    github.on(`/commits?sha=${head}&per_page=100&page=${String(page + 1)}`, { body });
  }
  for (const { sha } of commits) checkRuns(github, sha, []);
}

export interface FakeCheckRun {
  readonly name: string;
  readonly status?: string;
  readonly conclusion?: string | null;
}

export function checkRuns(github: FakeGitHub, sha: string, runs: readonly FakeCheckRun[]): void {
  github.on(`/commits/${sha}/check-runs?filter=latest&per_page=100&page=1`, {
    body: {
      total_count: runs.length,
      check_runs: runs.map(({ name, status = "completed", conclusion = "success" }) => ({ name, status, conclusion })),
    },
  });
}
