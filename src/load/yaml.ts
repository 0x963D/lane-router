import { isMap, isNode, isScalar, LineCounter, parseDocument } from "yaml";
import { formatDataPath, type DataPath, type Issue } from "../decode.ts";
import { err, isNonEmpty, ok, type NonEmpty, type Result } from "../result.ts";
import type { Problem } from "./problem.ts";

export interface YamlFile {
  readonly value: unknown;
  readonly locate: (issue: Issue) => Problem;
}

export function parseYaml(file: string, source: string): Result<YamlFile, NonEmpty<Problem>> {
  const lineCounter = new LineCounter();
  const document = parseDocument(source, { lineCounter, prettyErrors: false });
  const position = (offset: number): Problem["at"] => {
    const { line, col } = lineCounter.linePos(offset);
    return { line, column: col };
  };
  // The library's messages quote the source, which a pull request controls, so only the error code is kept.
  const syntax = document.errors.map((error): Problem => ({
    file,
    at: position(error.pos[0]),
    where: null,
    message: `is not valid YAML: ${error.code.toLowerCase().replaceAll("_", " ")}`,
  }));
  if (isNonEmpty(syntax)) return err(syntax);

  const nodeAt = (path: DataPath): unknown => (path.length === 0 ? document.contents : document.getIn(path, true));
  const valueOffset = (path: DataPath): number | undefined => {
    for (let depth = path.length; depth >= 0; depth--) {
      const node = nodeAt(path.slice(0, depth));
      if (isNode(node) && node.range) return node.range[0];
    }
    return undefined;
  };
  const keyOffset = (path: DataPath): number | undefined => {
    const parent = nodeAt(path.slice(0, -1));
    const key = path.at(-1);
    const pair = isMap(parent) ? parent.items.find((item) => isScalar(item.key) && item.key.value === key) : undefined;
    return isNode(pair?.key) && pair.key.range ? pair.key.range[0] : valueOffset(path.slice(0, -1));
  };

  let value: unknown;
  try {
    value = document.toJS();
  } catch {
    return err([{ file, at: null, where: null, message: "is not valid YAML: an alias cannot be expanded" }]);
  }
  return ok({
    value,
    locate: (issue) => {
      const offset = issue.on === "key" ? keyOffset(issue.path) : valueOffset(issue.path);
      return {
        file,
        at: offset === undefined ? null : position(offset),
        where: issue.path.length === 0 ? null : formatDataPath(issue.path),
        message: issue.message,
      };
    },
  });
}
