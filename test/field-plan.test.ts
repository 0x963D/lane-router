import { describe, expect, it } from "vitest";
import { readFieldPlan } from "../scripts/field-plan.ts";

async function* splitBytes(text: string, size: number): AsyncGenerator<Uint8Array> {
  const bytes = Buffer.from(text);
  for (let offset = 0; offset < bytes.length; offset += size) {
    await Promise.resolve();
    yield bytes.subarray(offset, offset + size);
  }
}

const header = { base: "base", head: "head", incomplete: null };

describe("replay JSON reader", () => {
  it("counts lanes and collects fallback reasons from a fragmented stream", async () => {
    const text = JSON.stringify({
      ...header,
      lanes: [
        { lane: "api", decision: "run", because: [{ decision: "skip", path: "é/🧪.ts" }] },
        { lane: "web", decision: "run" },
      ],
      paths: [
        { path: "é/🧪.ts", placements: [{ kind: "unmatched" }] },
        { path: "package-lock.json", placements: [{ kind: "built-in", input: "lockfile" }, { kind: "unmatched" }] },
      ],
    });
    expect(await readFieldPlan(splitBytes(text, 1))).toEqual({
      ...header,
      lanes: 2,
      skipped: 0,
      verdicts: [
        { lane: "api", decision: "run" },
        { lane: "web", decision: "run" },
      ],
      bytes: Buffer.byteLength(text),
      fallbacks: ["built-in/lockfile", "unmatched"],
    });
  });

  it("reads decisions across a large stream without using nested reason fields", async () => {
    const text = JSON.stringify({
      ...header,
      lanes: [
        { lane: "api", decision: "run", because: Array.from({ length: 8_192 }, () => ({ detail: "x".repeat(512) })) },
        { decision: "skip", lane: "web" },
      ],
      paths: [],
    });
    expect(await readFieldPlan(splitBytes(text, 16_384))).toMatchObject({
      lanes: 2,
      skipped: 1,
      verdicts: [
        { lane: "api", decision: "run" },
        { lane: "web", decision: "skip" },
      ],
      bytes: Buffer.byteLength(text),
      fallbacks: [],
    });
  });

  it("uses the incomplete cause in place of informational placements", async () => {
    const incomplete = { kind: "error", message: "Changes could not be read." };
    const text = JSON.stringify({
      ...header,
      incomplete,
      lanes: [{ lane: "api", decision: "run" }],
      paths: [{ placements: [{ kind: "unmatched" }] }],
    });
    expect(await readFieldPlan(splitBytes(text, 7))).toMatchObject({
      incomplete,
      fallbacks: ["incomplete/error"],
    });
  });

  it("rejects truncated output and any skip in a fail-closed plan", async () => {
    const text = JSON.stringify({
      ...header,
      lanes: [{ lane: "api", decision: "skip" }],
      paths: [{ placements: [{ kind: "unmatched" }] }],
    });
    await expect(readFieldPlan(splitBytes(text.slice(0, -1), 9))).rejects.toThrow();
    await expect(readFieldPlan(splitBytes(text, 9))).rejects.toThrow("a lane skipped in a fail-closed plan");
  });
});
