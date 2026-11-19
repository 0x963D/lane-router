import { changedFiles, incomplete, type ChangedFiles, type Range } from "../core/change.ts";
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
  const status = field("status", literal(...COMPARE_STATUSES));
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
  return isValid(status) && isValid(mergeBase) && isValid(files) ? { status, mergeBase, files } : INVALID;
}, IGNORE);

export interface GitHubRepo {
  /**
   * The files changed from the merge base of `range.base` and `range.head`, which the list carries,
   * from the compare endpoint. Resolves incomplete when there is no base, when the listing reaches
   * the 300-file cap, or when it differs from `expectedCount`. In push mode it also resolves
   * incomplete unless head extends base. Rejects on any HTTP or decoding failure.
   */
  compare(
    range: Range,
    options: {
      readonly mode: Mode;
      readonly mergeCheckout?: boolean;
      readonly expectedCount: number | null;
      readonly under: string;
    },
  ): Promise<ChangedFiles>;
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

  return {
    compare: async (range, { mode, mergeCheckout, expectedCount, under }) => {
      if (range.base === null) return incomplete({ kind: "no-base" });
      const path = `/compare/${encodeURIComponent(range.base)}...${encodeURIComponent(range.head)}`;
      const { status, mergeBase, files: listed } = await get(path, compareResponse);
      const files = changedFiles(listed, { under, mergeBase });
      const extendsBase = (status === "ahead" || status === "identical") && mergeBase === range.base;
      if (mergeCheckout && !extendsBase) throw new Error("the pull request merge commit does not extend its base");
      if (mode === "push" && !extendsBase) {
        return incomplete({ kind: "not-fast-forward", status, mergeBase }, files.paths);
      }
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
