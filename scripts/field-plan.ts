import assert from "node:assert/strict";
import { JSONParser } from "@streamparser/json";

export async function readFieldPlan(stdout: AsyncIterable<Uint8Array>) {
  let base: string | null | undefined;
  let head: string | undefined;
  let incomplete: { kind: string } | null | undefined;
  const fallbacks = new Set<string>();
  let lanes = 0;
  let skipped = 0;
  let bytes = 0;
  let problem: { error: unknown } | undefined;
  const parser = new JSONParser({
    keepStack: false,
    paths: ["$.base", "$.head", "$.incomplete", "$.lanes.*.decision", "$.paths.*.placements.*"],
  });
  parser.onValue = ({ key, value, stack }) => {
    if (stack.length === 1) {
      if (key === "base") {
        assert.ok(value === null || typeof value === "string", "invalid base");
        base = value;
      }
      if (key === "head") {
        assert.ok(typeof value === "string", "invalid head");
        head = value;
      }
      if (key === "incomplete") {
        if (value === null) incomplete = null;
        else {
          assert.ok(isObject(value) && typeof value.kind === "string", "invalid incomplete cause");
          incomplete = { ...value, kind: value.kind };
        }
      }
    } else if (key === "decision") {
      assert.ok(value === "run" || value === "skip", "invalid lane decision");
      lanes++;
      if (value === "skip") skipped++;
    } else if (isObject(value)) {
      if (value.kind === "built-in") {
        assert.ok(typeof value.input === "string", "invalid built-in placement");
        fallbacks.add(`built-in/${value.input}`);
      } else if (value.kind === "unmatched") {
        fallbacks.add("unmatched");
      }
    }
  };
  for await (const chunk of stdout) {
    bytes += chunk.length;
    // Drain the child's output even after bad JSON so its exit status is available.
    if (problem !== undefined) continue;
    try {
      parser.write(chunk);
    } catch (error) {
      problem = { error };
    }
  }
  if (problem !== undefined) throw problem.error;
  if (!parser.isEnded) parser.end();
  assert.ok(base !== undefined && head !== undefined && incomplete !== undefined, "incomplete plan header");
  assert.ok(lanes > 0, "no lane decisions");
  if (incomplete !== null) {
    fallbacks.clear();
    fallbacks.add(`incomplete/${incomplete.kind}`);
  }
  if (fallbacks.size > 0) assert.equal(skipped, 0, "a lane skipped in a fail-closed plan");
  return { base, head, incomplete, lanes, skipped, bytes, fallbacks: [...fallbacks].sort() };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
