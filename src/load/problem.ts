import type { NonEmpty } from "../result.ts";

/** One thing wrong with the config or the workspace, with enough position to fix it. */
export interface Problem {
  /** Relative to the routed root. */
  readonly file: string;
  /** One-based. Null when the problem is about the whole file. */
  readonly at: { readonly line: number; readonly column: number } | null;
  /** A data path such as `lanes.unit.pakages` or `paths[2].via`. */
  readonly where: string | null;
  readonly message: string;
}

export function fileProblem(file: string, message: string): Problem {
  return { file, at: null, where: null, message };
}

/** The Action fails the step with this text and the CLI prints it, so both show the same thing. */
export function formatProblems(problems: NonEmpty<Problem>): string {
  return [...problems]
    .sort(
      (a, b) =>
        compareText(a.file, b.file) ||
        (a.at?.line ?? 0) - (b.at?.line ?? 0) ||
        (a.at?.column ?? 0) - (b.at?.column ?? 0),
    )
    .map(({ file, at, where, message }) => {
      const location = at === null ? file : `${file}:${String(at.line)}:${String(at.column)}`;
      return where === null ? `${location}  ${message}` : `${location}  ${where}  ${message}`;
    })
    .join("\n");
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
