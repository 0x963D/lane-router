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

/** The workflow run behind a check suite. */
export interface FakeWorkflowRun {
  readonly path: string;
  readonly event: string;
  readonly branch: string | null;
  readonly headSha: string;
}

/** The workflow that the Action runs in under `runAction`, unless a test sets GITHUB_WORKFLOW_REF. */
export const RUNNING_WORKFLOW = ".github/workflows/ci.yml";

/**
 * By default a run comes from the github-actions app, for the commit it is listed on, in a check
 * suite of its own whose workflow run is a push to main from RUNNING_WORKFLOW: a run that proves.
 */
export interface FakeCheckRun {
  readonly name: string;
  readonly status?: string;
  readonly conclusion?: string | null;
  readonly app?: string | null;
  readonly headSha?: string;
  /** Runs that name the same suite share it, and its workflow run comes from the first of them. */
  readonly suite?: number;
  /** Null for a suite that no workflow run created. */
  readonly workflow?: Partial<FakeWorkflowRun> | null;
}

let lastSuite = 0;

export function checkRuns(github: FakeGitHub, sha: string, runs: readonly FakeCheckRun[]): void {
  const suites = new Set<number>();
  const listed = runs.map((run) => {
    const suite = run.suite ?? 1_000 + ++lastSuite;
    if (!suites.has(suite)) {
      suites.add(suite);
      const workflow =
        run.workflow === null
          ? null
          : { path: RUNNING_WORKFLOW, event: "push", branch: "main", headSha: sha, ...run.workflow };
      const workflowRuns =
        workflow === null
          ? []
          : [{ path: workflow.path, event: workflow.event, head_branch: workflow.branch, head_sha: workflow.headSha }];
      github.on(`/actions/runs?check_suite_id=${String(suite)}`, {
        body: { total_count: workflowRuns.length, workflow_runs: workflowRuns },
      });
    }
    return {
      name: run.name,
      status: run.status ?? "completed",
      conclusion: run.conclusion === undefined ? "success" : run.conclusion,
      head_sha: run.headSha ?? sha,
      app: run.app === null ? null : { slug: run.app ?? "github-actions" },
      check_suite: { id: suite },
    };
  });
  github.on(`/commits/${sha}/check-runs?filter=latest&per_page=100&page=1`, {
    body: { total_count: listed.length, check_runs: listed },
  });
}
