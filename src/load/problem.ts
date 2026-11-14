import type { TextPosition } from "../decode.ts";
import type { NonEmpty } from "../result.ts";

export interface Problem {
  /** Relative to the routed root. */
  readonly file: string;
  /** Null when no source position is known, as for a whole file. */
  readonly at: TextPosition | null;
  /** A data path such as `lanes.unit.packages[0]` or `paths[2].via`. */
  readonly where: string | null;
  readonly message: string;
}

export function fileProblem(file: string, message: string): Problem {
  return { file, at: null, where: null, message };
}

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
