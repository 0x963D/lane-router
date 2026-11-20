import { changedFiles, incomplete, type ChangedFiles, type ChangeSource, type Range } from "../core/change.ts";
import type { Mode } from "../core/plan.ts";
import {
  array,
  decode,
  formatDataPath,
  INVALID,
  integer,
  isValid,
  literal,
  nonEmptyString,
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
const COMPARE_STATUSES = ["ahead", "identical", "behind", "diverged"] as const;
const IGNORE = { unknownKeys: "ignore" } as const;

export type GitHubEvent =
  | { readonly kind: "pull_request"; readonly base: string; readonly head: string; readonly changedFiles: number }
  /** `before` is null for the first push of a branch, which GitHub sends as an all-zero SHA. */
  | { readonly kind: "push"; readonly before: string | null; readonly after: string }
  | { readonly kind: "merge_group"; readonly base: string; readonly head: string }
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
  const before = field("before", optional(nonEmptyString));
  const after = field("after", nonEmptyString);
  if (!isValid(before) || !isValid(after)) return INVALID;
  return { kind: "push" as const, before: before === undefined || /^0+$/.test(before) ? null : before, after };
}, IGNORE);

const mergeGroupEvent = object(
  (field) =>
    field(
      "merge_group",
      object((group) => {
        const base = group("base_sha", nonEmptyString);
        const head = group("head_sha", nonEmptyString);
        return isValid(base) && isValid(head) ? { kind: "merge_group" as const, base, head } : INVALID;
      }, IGNORE),
    ),
  IGNORE,
);

const EVENT_DECODERS = new Map<string, Decoder<GitHubEvent>>([
  ["pull_request", pullRequestEvent],
  ["pull_request_target", pullRequestEvent],
  ["push", pushEvent],
  ["merge_group", mergeGroupEvent],
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
  const status = field("status", literal(...COMPARE_STATUSES));
  const baseCommit = field("base_commit", optional(sha("sha")));
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
  return isValid(status) && isValid(baseCommit) && isValid(mergeBase) && isValid(files)
    ? { status, baseCommit, mergeBase, files }
    : INVALID;
}, IGNORE);

export interface GitHubRepo {
  /**
   * The files changed from the merge base of `range.base` and `range.head`, which the list carries,
   * from the compare endpoint. Resolves incomplete when there is no base, when the listing reaches
   * the 300-file cap without a verified local diff, or when it differs from `expectedCount`. In push mode it also resolves
   * incomplete unless head extends base. When `requireBaseAncestor` is set, it rejects unless head
   * extends base. Rejects on any HTTP or decoding failure.
   */
  compare(
    range: Range,
    options: {
      readonly mode: Mode;
      readonly requireBaseAncestor: boolean;
      readonly expectedCount: number | null;
      readonly resolveBase: (ref: string) => Promise<string | undefined>;
      readonly under: string;
      readonly localChanges: ChangeSource;
    },
  ): Promise<ChangedFiles>;
}

export function githubRepo(options: {
  readonly apiUrl: string;
  readonly repository: string;
  readonly token: string;
}): GitHubRepo {
  const request = async (base: string, head: string) => {
    const path = `/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
    const response = await fetch(`${options.apiUrl}/repos/${options.repository}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "lane-router",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(options.token === "" ? {} : { Authorization: `Bearer ${options.token}` }),
      },
    });
    if (!response.ok) {
      const status = `${String(response.status)} ${response.statusText}`.trim();
      const error = new Error(
        `GET ${path} returned ${status}, so check that both revisions are available to the compare API or supply files`,
      );
      if (response.status === 404) return { kind: "not-found" as const, error };
      throw error;
    }
    const body = parseJson(await response.text());
    if (!body.ok) throw new Error(`GET ${path} returned a body that is not valid JSON`);
    const decoded = decode(compareResponse, body.value);
    if (!decoded.ok) {
      throw new Error(`GET ${path} returned a body lane-router cannot read: ${describe(decoded.error[0])}`);
    }
    return { kind: "listed" as const, ...decoded.value };
  };

  return {
    compare: async (range, { mode, requireBaseAncestor, expectedCount, resolveBase, under, localChanges }) => {
      if (range.base === null) return incomplete({ kind: "no-base" });
      const checkAncestry = requireBaseAncestor || mode === "push";
      let base = range.base;
      let reply = await request(base, range.head);
      if (!fullSha(base) && (reply.kind === "not-found" || (checkAncestry && !fullSha(reply.baseCommit ?? "")))) {
        const localBase = await resolveBase(base);
        if (localBase !== undefined) {
          base = localBase;
          reply = await request(base, range.head);
        }
      }
      if (reply.kind === "not-found") throw reply.error;
      const { status, mergeBase, baseCommit, files: listed } = reply;
      const files = changedFiles(listed, { under, mergeBase });
      const resolvedBase = fullSha(base) ? base : baseCommit;
      if (checkAncestry) {
        if (resolvedBase === undefined || !fullSha(resolvedBase)) {
          throw new Error("the compare response did not resolve the base to a full SHA, so supply the full base SHA");
        }
        if ((status !== "ahead" && status !== "identical") || mergeBase !== resolvedBase.toLowerCase()) {
          if (requireBaseAncestor) {
            throw new Error(
              "the checkout does not extend its compare base, so use an ancestor of the checkout or supply files",
            );
          }
          return incomplete({ kind: "not-fast-forward", status, mergeBase }, files.paths);
        }
      }
      if (listed.length >= COMPARE_LIMIT) {
        if (
          listed.length === COMPARE_LIMIT &&
          files.kind === "complete" &&
          resolvedBase !== undefined &&
          fullSha(resolvedBase) &&
          fullSha(range.head) &&
          fullSha(mergeBase) &&
          (expectedCount === null || expectedCount >= COMPARE_LIMIT) &&
          new Set(listed.map(({ path }) => path)).size === listed.length
        ) {
          const local = await localChanges({ base: resolvedBase, head: range.head }).catch(() => undefined);
          if (local?.kind === "incomplete" && local.cause.kind === "invalid-path") return local;
          if (
            local?.kind === "complete" &&
            local.mergeBase === mergeBase &&
            local.paths.length >= COMPARE_LIMIT &&
            (expectedCount === null || local.paths.length === expectedCount)
          ) {
            const available = new Set(local.paths);
            if (files.paths.every((path) => available.has(path))) return local;
          }
        }
        return incomplete({ kind: "truncated", listed: listed.length, limit: COMPARE_LIMIT }, files.paths);
      }
      if (expectedCount !== null && listed.length !== expectedCount) {
        return incomplete({ kind: "count-mismatch", listed: listed.length, expected: expectedCount }, files.paths);
      }
      return files;
    },
  };
}

function fullSha(revision: string): boolean {
  return /^[0-9a-f]{40}$/i.test(revision);
}

function describe({ path, message }: Issue): string {
  return path.length === 0 ? message : `${formatDataPath(path)} ${message}`;
}
