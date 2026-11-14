import { changedFiles, incomplete, type ChangedFiles, type Range } from "../core/change.ts";
import type { LaneName } from "../core/ids.ts";
import type { Lane } from "../core/model.ts";
import type { LastGreen } from "../core/plan.ts";
import type { NoProofCause } from "../core/route.ts";
import {
  allValid,
  array,
  decode,
  formatDataPath,
  INVALID,
  integer,
  isValid,
  nonEmptyString,
  nullable,
  object,
  optional,
  parseJson,
  string,
  type Decoder,
  type Issue,
} from "../decode.ts";
import { err, mapNonEmpty, ok, type NonEmpty, type Result } from "../result.ts";

/* Every GitHub-specific fact lives here. Wire shapes are decoded here and never leave this file. */

const COMPARE_LIMIT = 300;
const PAGE = 100;
const IGNORE = { unknownKeys: "ignore" } as const;

export type GitHubEvent =
  | { readonly kind: "pull_request"; readonly base: string; readonly head: string; readonly changedFiles: number }
  /** `before` is null for the first push of a branch, which GitHub sends as an all-zero SHA. */
  | {
      readonly kind: "push";
      /** The full ref the push moved to `after`, such as refs/heads/main or refs/tags/v1. */
      readonly ref: string | null;
      readonly before: string | null;
      readonly after: string;
      readonly defaultBranch: string | null;
    }
  | { readonly kind: "other"; readonly name: string };

const sha = (key: string): Decoder<string> => object((field) => field(key, nonEmptyString), IGNORE);

const pullRequestEvent = object(
  (field) =>
    field(
      "pull_request",
      object((pull) => {
        const base = pull("base", sha("sha"));
        const head = pull("head", sha("sha"));
        const changedFiles = pull("changed_files", integer(0));
        return isValid(base) && isValid(head) && isValid(changedFiles)
          ? { kind: "pull_request" as const, base, head, changedFiles }
          : INVALID;
      }, IGNORE),
    ),
  IGNORE,
);

const pushEvent = object((field) => {
  const ref = field("ref", optional(nonEmptyString));
  const before = field("before", nonEmptyString);
  const after = field("after", nonEmptyString);
  const repository = field(
    "repository",
    optional(object((repo) => repo("default_branch", optional(nonEmptyString)), IGNORE)),
  );
  if (!isValid(ref) || !isValid(before) || !isValid(after) || !isValid(repository)) return INVALID;
  return {
    kind: "push" as const,
    ref: ref ?? null,
    before: /^0+$/.test(before) ? null : before,
    after,
    defaultBranch: repository ?? null,
  };
}, IGNORE);

const EVENT_DECODERS = new Map<string, Decoder<GitHubEvent>>([
  ["pull_request", pullRequestEvent],
  ["pull_request_target", pullRequestEvent],
  ["push", pushEvent],
]);

export function readEvent(name: string, payload: unknown): Result<GitHubEvent, NonEmpty<string>> {
  const decoder = EVENT_DECODERS.get(name);
  if (decoder === undefined) return ok({ kind: "other", name });
  const decoded = decode(decoder, payload);
  return decoded.ok
    ? decoded
    : err(mapNonEmpty(decoded.error, (issue) => `the ${name} event payload ${describe(issue)}`));
}

const compareResponse = object((field) => {
  const mergeBase = field("merge_base_commit", sha("sha"));
  const files = field(
    "files",
    array(
      object((file) => {
        const path = file("filename", nonEmptyString);
        const previousPath = file("previous_filename", optional(string));
        return isValid(path) && isValid(previousPath) ? { path, previousPath: previousPath ?? null } : INVALID;
      }, IGNORE),
    ),
  );
  return isValid(mergeBase) && isValid(files) ? { mergeBase, files } : INVALID;
}, IGNORE);

const commitsResponse = array(
  object((field) => {
    const sha = field("sha", nonEmptyString);
    const parents = field("parents", array(object((parent) => parent("sha", nonEmptyString), IGNORE)));
    return isValid(sha) && isValid(parents) ? { sha, firstParent: parents[0] ?? null } : INVALID;
  }, IGNORE),
);

const checkRunsResponse = object((field) => {
  const total = field("total_count", integer(0));
  const runs = field(
    "check_runs",
    array(
      object((run) => {
        const fields = {
          name: run("name", string),
          status: run("status", string),
          conclusion: run("conclusion", nullable(string)),
          headSha: run("head_sha", string),
          app: run("app", nullable(object((app) => app("slug", optional(string)), IGNORE))),
          suite: run("check_suite", nullable(object((suite) => suite("id", integer(0)), IGNORE))),
        };
        return allValid(fields) ? { ...fields, app: fields.app ?? null } : INVALID;
      }, IGNORE),
    ),
  );
  return isValid(total) && isValid(runs) ? { total, runs } : INVALID;
}, IGNORE);

type CheckRun = Exclude<ReturnType<typeof checkRunsResponse>, typeof INVALID>["runs"][number];

const workflowRunsResponse = object(
  (field) =>
    field(
      "workflow_runs",
      array(
        object((run) => {
          const fields = {
            path: run("path", string),
            event: run("event", string),
            branch: run("head_branch", nullable(string)),
            headSha: run("head_sha", string),
          };
          return allValid(fields) ? fields : INVALID;
        }, IGNORE),
      ),
    ),
  IGNORE,
);

type WorkflowRun = Exclude<ReturnType<typeof workflowRunsResponse>, typeof INVALID>[number];

const matchingRefsResponse = array(object((ref) => ref("ref", string), IGNORE));

/**
 * What a check run must come from to prove a lane. Any GitHub App with `checks: write`, or any other
 * workflow, can create a passing check run with a lane's name, so the name alone proves nothing.
 */
export interface Trust {
  /** The slug of the app whose check runs can prove a lane. */
  readonly app: string;
  /** The branch whose push runs can prove a lane. Null when unknown, and then no commit proves one. */
  readonly branch: string | null;
  /** The workflow file running lane-router, which proves the lanes that name no workflow. */
  readonly workflow: string | null;
}

/** The workflow file in `owner/repo/<path>@<ref>`, the shape of GITHUB_WORKFLOW_REF. Null for anything else. */
export function runningWorkflow(workflowRef: string | undefined, repository: string): string | null {
  const prefix = `${repository}/`;
  if (workflowRef === undefined || repository === "" || !workflowRef.startsWith(prefix)) return null;
  return withoutRef(workflowRef.slice(prefix.length));
}

/** A ref can hold an `@` itself, so the path ends at the first YAML extension followed by one. */
function withoutRef(path: string): string {
  return /^(.+?\.ya?ml)@/.exec(path)?.[1] ?? path;
}

/**
 * Skipped, neutral, cancelled, unfinished and missing runs are not a pass, and neither are two
 * trusted runs that disagree. A run that is not trusted is not counted either way.
 */
function passed(trusted: readonly CheckRun[]): boolean {
  return trusted.length > 0 && trusted.every((run) => run.status === "completed" && run.conclusion === "success");
}

export interface GitHubRepo {
  /**
   * The files changed from the merge base of `range.base` and `range.head`, which the list carries,
   * from the compare endpoint. Resolves incomplete when there is no base, when the listing reaches
   * the 300-file cap, or when it differs from `expectedCount`. Rejects on any HTTP or decoding failure.
   */
  compare(
    range: Range,
    options: { readonly expectedCount: number | null; readonly under: string },
  ): Promise<ChangedFiles>;
  /**
   * Proofs are taken only when `ref` is `refs/heads/<trust.branch>` and no tag has the branch's name.
   * Then a check run proves lane L at commit S only when it comes from `trust.app` for S, and its
   * check suite belongs to a push run of L's workflow on `trust.branch` for S. The returned `proofs`
   * rejects on any API failure.
   */
  lastGreen(options: {
    readonly head: string;
    /** The ref the triggering push moved to `head`. Null when the triggering event did not push head. */
    readonly ref: string | null;
    readonly depth: number;
    readonly trust: Trust;
  }): LastGreen;
}

export function githubRepo(options: {
  readonly apiUrl: string;
  readonly repository: string;
  readonly token: string;
}): GitHubRepo {
  const get = async <T>(path: string, decoder: Decoder<T>): Promise<T> => {
    const response = await fetch(`${options.apiUrl}/repos/${options.repository}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "lane-router",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(options.token === "" ? {} : { Authorization: `Bearer ${options.token}` }),
      },
    });
    if (!response.ok) throw new Error(`GET ${path} returned ${String(response.status)} ${response.statusText}`.trim());
    const body = parseJson(await response.text());
    if (!body.ok) throw new Error(`GET ${path} returned a body that is not valid JSON`);
    const decoded = decode(decoder, body.value);
    if (!decoded.ok)
      throw new Error(`GET ${path} returned a body lane-router cannot read: ${describe(decoded.error[0])}`);
    return decoded.value;
  };

  const checkRuns = async (commit: string): Promise<readonly CheckRun[]> => {
    const runs: CheckRun[] = [];
    for (let page = 1; ; page++) {
      const body = await get(
        `/commits/${commit}/check-runs?filter=latest&per_page=${String(PAGE)}&page=${String(page)}`,
        checkRunsResponse,
      );
      runs.push(...body.runs);
      if (body.runs.length < PAGE || runs.length >= body.total) return runs;
    }
  };

  /**
   * Newest first, head excluded. The commit list also holds merged commits, so the first-parent chain
   * can span pages. The walk reads at most `depth` pages, and stopping early is safe: a lane left
   * without a proof runs.
   */
  const firstParents = async function* (head: string, depth: number): AsyncGenerator<string> {
    const parentOf = new Map<string, string | null>();
    let page = 1;
    let more = true;
    let cursor = head;
    for (let step = 0; step < depth; step++) {
      while (!parentOf.has(cursor) && more && page <= depth) {
        const commits = await get(
          `/commits?sha=${encodeURIComponent(head)}&per_page=${String(PAGE)}&page=${String(page)}`,
          commitsResponse,
        );
        for (const { sha, firstParent } of commits) parentOf.set(sha, firstParent);
        more = commits.length === PAGE;
        page += 1;
      }
      const parent = parentOf.get(cursor);
      if (parent === undefined || parent === null) return;
      yield parent;
      cursor = parent;
    }
  };

  const workflowRuns = new Map<number, Promise<readonly WorkflowRun[]>>();
  const workflowRunsOf = (suite: number): Promise<readonly WorkflowRun[]> => {
    const cached =
      workflowRuns.get(suite) ?? get(`/actions/runs?check_suite_id=${String(suite)}`, workflowRunsResponse);
    workflowRuns.set(suite, cached);
    return cached;
  };

  const isTrusted = async (
    run: CheckRun,
    proof: { readonly commit: string; readonly workflow: string; readonly branch: string; readonly app: string },
  ): Promise<boolean> => {
    if (run.app !== proof.app || run.headSha !== proof.commit || run.suite === null) return false;
    const [only, ...more] = await workflowRunsOf(run.suite);
    return (
      only !== undefined &&
      more.length === 0 &&
      withoutRef(only.path) === proof.workflow &&
      only.event === "push" &&
      only.branch === proof.branch &&
      only.headSha === proof.commit
    );
  };

  const tagExists = async (name: string): Promise<boolean> => {
    const refs = await get(`/git/matching-refs/tags/${encodeURIComponent(name)}`, matchingRefsResponse);
    return refs.includes(`refs/tags/${name}`);
  };

  return {
    lastGreen: ({ head, ref, depth, trust }) => ({
      proofs: async (lanes) => {
        const { branch } = trust;
        if (branch === null) return () => err({ kind: "unknown-branch" });
        if (ref !== `refs/heads/${branch}`) return () => err({ kind: "not-proof-branch-push", branch });
        if (await tagExists(branch)) return () => err({ kind: "branch-shares-tag-name", branch });
        const workflowOf = (lane: Lane): string | null => lane.workflow ?? trust.workflow;
        const provable = lanes.flatMap((lane) => {
          const workflow = workflowOf(lane);
          return workflow === null ? [] : [{ lane, workflow }];
        });
        if (provable.length === 0) return () => err({ kind: "unknown-workflow" });
        const found = new Map<LaneName, string>();
        for await (const commit of firstParents(head, depth)) {
          const runs = await checkRuns(commit);
          for (const { lane, workflow } of provable) {
            if (found.has(lane.name)) continue;
            const proof = { commit, workflow, branch, app: trust.app };
            const named = runs.filter((run) => run.name === lane.check);
            const trusted = await Promise.all(named.map(async (run) => ((await isTrusted(run, proof)) ? [run] : [])));
            if (passed(trusted.flat())) found.set(lane.name, commit);
          }
          if (found.size === provable.length) break;
        }
        return (lane) => {
          const commit = found.get(lane.name);
          if (commit !== undefined) return ok(commit);
          const cause: NoProofCause =
            workflowOf(lane) === null ? { kind: "unknown-workflow" } : { kind: "none-within-depth", depth };
          return err(cause);
        };
      },
    }),
    compare: async (range, { expectedCount, under }) => {
      if (range.base === null) return incomplete({ kind: "no-base" });
      const { mergeBase, files: listed } = await get(
        `/compare/${encodeURIComponent(range.base)}...${encodeURIComponent(range.head)}`,
        compareResponse,
      );
      const files = changedFiles(listed, { under, mergeBase });
      if (listed.length >= COMPARE_LIMIT) {
        return incomplete({ kind: "truncated", listed: listed.length, limit: COMPARE_LIMIT }, files.paths);
      }
      if (expectedCount !== null && listed.length !== expectedCount) {
        return incomplete({ kind: "count-mismatch", listed: listed.length, expected: expectedCount }, files.paths);
      }
      return files;
    },
  };
}

function describe({ path, message }: Issue): string {
  return path.length === 0 ? message : `${formatDataPath(path)} ${message}`;
}
