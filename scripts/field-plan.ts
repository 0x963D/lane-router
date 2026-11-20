import assert from "node:assert/strict";
import { JSONParser } from "@streamparser/json";

export async function readFieldPlan(stdout: AsyncIterable<Uint8Array>) {
  let base: string | null | undefined;
  let head: string | undefined;
  let incomplete: { kind: string } | null | undefined;
  const fallbacks = new Set<string>();
  const entries = new Map<number, { lane?: string; decision?: "run" | "skip" }>();
  let bytes = 0;
  let problem: { error: unknown } | undefined;
  const parser = new JSONParser({
    keepStack: false,
    paths: ["$.base", "$.head", "$.incomplete", "$.lanes.*.lane", "$.lanes.*.decision", "$.paths.*.placements.*"],
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
    } else if (key === "lane" || key === "decision") {
      const index = stack.at(-1)?.key;
      assert.ok(typeof index === "number", "invalid lane index");
      const entry = entries.get(index) ?? {};
      if (key === "lane") {
        assert.ok(typeof value === "string" && value !== "", "invalid lane name");
        entry.lane = value;
      } else {
        assert.ok(value === "run" || value === "skip", "invalid lane decision");
        entry.decision = value;
      }
      entries.set(index, entry);
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
  const verdicts = [...entries.values()].map(({ lane, decision }) => {
    assert.ok(lane !== undefined && decision !== undefined, "incomplete lane decision");
    return { lane, decision };
  });
  const lanes = verdicts.length;
  const skipped = verdicts.filter(({ decision }) => decision === "skip").length;
  assert.ok(lanes > 0, "no lane decisions");
  assert.equal(new Set(verdicts.map(({ lane }) => lane)).size, lanes, "duplicate lane name");
  if (incomplete !== null) {
    fallbacks.clear();
    fallbacks.add(`incomplete/${incomplete.kind}`);
  }
  if (fallbacks.size > 0) assert.equal(skipped, 0, "a lane skipped in a fail-closed plan");
  return { base, head, incomplete, lanes, skipped, verdicts, bytes, fallbacks: [...fallbacks].sort() };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
