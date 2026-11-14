import { directoryTree } from "../../src/adapters/directory.ts";
import type { RoutingModel } from "../../src/core/model.ts";
import { loadModel, type Problem } from "../../src/load/index.ts";
import { fixtureCopy, fixtureDir, type Overrides } from "./fixtures.ts";

export const CONFIG = ".github/lanes.yml";

export function loadFixture(fixture: string, overrides?: Overrides) {
  const dir = overrides === undefined ? fixtureDir(fixture) : fixtureCopy(fixture, overrides);
  return loadModel(directoryTree(dir), CONFIG);
}

export async function modelOf(fixture: string, overrides?: Overrides): Promise<RoutingModel> {
  const loaded = await loadFixture(fixture, overrides);
  if (!loaded.ok) throw new Error(`expected ${fixture} to load, got ${JSON.stringify(loaded.error)}`);
  return loaded.value;
}

export async function problemsOf(fixture: string, overrides?: Overrides): Promise<readonly Problem[]> {
  const loaded = await loadFixture(fixture, overrides);
  if (loaded.ok) throw new Error(`expected ${fixture} to fail to load`);
  return loaded.error;
}

export function configProblems(yaml: string): Promise<readonly Problem[]> {
  return problemsOf("acme", { [CONFIG]: yaml });
}

/** The part of a problem a user navigates by: the data path and the source position. */
export function located(problems: readonly Problem[]) {
  return problems.map(({ where, at }) => ({ where, at }));
}
