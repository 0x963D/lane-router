import { describe, expect, it } from "vitest";
import { INPUT_NAMES } from "../src/action.ts";
import { FIXED_OUTPUTS } from "../src/core/ids.ts";
import { actionYml } from "./support/action.ts";

describe("action.yml", () => {
  it("declares exactly the inputs the Action reads", () => {
    expect(Object.keys(actionYml().inputs)).toEqual([...INPUT_NAMES]);
  });

  it("declares exactly the fixed outputs the Action writes", () => {
    expect(Object.keys(actionYml().outputs)).toEqual([...FIXED_OUTPUTS]);
  });

  it("runs the committed bundle on node24", () => {
    expect(actionYml().runs).toEqual({ using: "node24", main: "dist/index.js" });
  });
});
