import { changedFiles, incomplete, type ChangedFiles, type Range } from "../core/change.ts";
import {
  array,
  decode,
  formatDataPath,
  INVALID,
  integer,
  isValid,
  nonEmptyString,
  object,
  optional,
  string,
  type Decoder,
  type Issue,
} from "../decode.ts";
import { err, mapNonEmpty, ok, type NonEmpty, type Result } from "../result.ts";

/*
 * The GitHub REST API over built-in fetch, and the event payload. Every GitHub-specific fact lives
 * here: the 300-file cap on compare and the all-zero `before` of a new branch. Wire shapes are
 * decoded here and never leave this file.
 */

const COMPARE_LIMIT = 300;
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
  const before = field("before", nonEmptyString);
  const after = field("after", nonEmptyString);
  if (!isValid(before) || !isValid(after)) return INVALID;
  return { kind: "push" as const, before: /^0+$/.test(before) ? null : before, after };
}, IGNORE);

const EVENT_DECODERS = new Map<string, Decoder<GitHubEvent>>([
  ["pull_request", pullRequestEvent],
  ["pull_request_target", pullRequestEvent],
  ["push", pushEvent],
]);

/** `pull_request` and `pull_request_target` are both pull requests. Any other event is `other`. */
export function readEvent(name: string, payload: unknown): Result<GitHubEvent, NonEmpty<string>> {
  const decoder = EVENT_DECODERS.get(name);
  if (decoder === undefined) return ok({ kind: "other", name });
  const decoded = decode(decoder, payload);
  return decoded.ok
    ? decoded
    : err(mapNonEmpty(decoded.error, (issue) => `the ${name} event payload ${describe(issue)}`));
}

const compareResponse = object(
  (field) =>
    field(
      "files",
      array(
        object((file) => {
          const path = file("filename", nonEmptyString);
          const previousPath = file("previous_filename", optional(string));
          return isValid(path) && isValid(previousPath) ? { path, previousPath: previousPath ?? null } : INVALID;
        }, IGNORE),
      ),
    ),
  IGNORE,
);

export interface GitHubRepo {
  /**
   * The files changed between `range.base` and `range.head`, from the compare endpoint. Resolves
   * incomplete when there is no base, when the listing reaches the 300-file cap, or when it differs
   * from `expectedCount`. Rejects on any HTTP or decoding failure.
   */
  compare(
    range: Range,
    options: { readonly expectedCount: number | null; readonly under: string },
  ): Promise<ChangedFiles>;
}

/** `apiUrl` comes from GITHUB_API_URL, which is also how the tests point the Action at a local fake. */
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
    const body: unknown = await response.json();
    const decoded = decode(decoder, body);
    if (!decoded.ok)
      throw new Error(`GET ${path} returned a body lane-router cannot read: ${describe(decoded.error[0])}`);
    return decoded.value;
  };

  return {
    compare: async (range, { expectedCount, under }) => {
      if (range.base === null) return incomplete({ kind: "no-base" });
      const listed = await get(
        `/compare/${encodeURIComponent(range.base)}...${encodeURIComponent(range.head)}`,
        compareResponse,
      );
      const files = changedFiles(listed, under);
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
